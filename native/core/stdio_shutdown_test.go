package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type observedStdioOutput struct {
	io.WriteCloser
	writes chan struct{}
}

func (w *observedStdioOutput) Write(p []byte) (int, error) {
	w.writes <- struct{}{}
	return w.WriteCloser.Write(p)
}

func waitStdioShutdown(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("stdio shutdown did not finish")
	}
}

func awaitStdioIO(t *testing.T, call func() error) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- call() }()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("stdio I/O did not finish")
		return nil
	}
}

func readStdioReady(t *testing.T, reader io.Reader) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		var response rpcResponse
		err := json.NewDecoder(reader).Decode(&response)
		result, _ := response.Result.(map[string]any)
		nodeID, _ := result["node_id"].(string)
		if err == nil && (response.ID != 0 || result["ready"] != true || nodeID == "" || response.Error != nil) {
			err = fmt.Errorf("invalid ready frame: %+v", response)
		}
		done <- err
	}()
	select {
	case err := <-done:
		must(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("ready frame did not arrive")
	}
}

func TestStdioShutdownInterruptsBlockedPipeOutput(t *testing.T) {
	for _, phase := range []string{"ready", "response"} {
		for _, stop := range []string{"eof", "cancel"} {
			t.Run(phase+"/"+stop, func(t *testing.T) {
				c := testCore(t, nil)
				ctx, cancel := context.WithCancel(context.Background())
				inReader, inWriter := io.Pipe()
				outReader, outWriter := io.Pipe()
				output := &observedStdioOutput{WriteCloser: outWriter, writes: make(chan struct{}, 4)}
				done := make(chan struct{})
				var serveErr error
				t.Cleanup(func() {
					cancel()
					_ = inWriter.Close()
					_ = inReader.Close()
					_ = outWriter.Close()
					_ = outReader.Close()
					waitStdioShutdown(t, done)
				})
				go func() {
					serveErr = serveStdio(ctx, c, inReader, output)
					_ = c.store.Close() // main releases its state lock after serveStdio.
					close(done)
				}()
				select {
				case <-output.writes:
				case <-time.After(3 * time.Second):
					t.Fatal("ready write did not start")
				}
				if phase == "response" {
					readStdioReady(t, outReader)
					must(t, awaitStdioIO(t, func() error {
						_, err := fmt.Fprintln(inWriter, `{"id":1,"method":"status"}`)
						return err
					}))
					select {
					case <-output.writes:
					case <-time.After(3 * time.Second):
						t.Fatal("response write did not start")
					}
				}
				if stop == "eof" {
					must(t, inWriter.Close())
				} else {
					cancel() // Keep stdin open; cancellation must interrupt its scanner.
				}
				waitStdioShutdown(t, done)
				if stop == "eof" {
					must(t, serveErr)
				} else if !errors.Is(serveErr, context.Canceled) {
					t.Fatalf("cancellation returned %v", serveErr)
				}
				select {
				case <-c.ctx.Done():
				default:
					t.Fatal("core was not closed")
				}
				if err := awaitStdioIO(t, func() error {
					_, err := outReader.Read(make([]byte, 1))
					return err
				}); err != io.EOF {
					t.Fatalf("output was not closed: %v", err)
				}
				if err := awaitStdioIO(t, func() error {
					_, err := inWriter.Write([]byte("\n"))
					return err
				}); err == nil {
					t.Fatal("input was not closed")
				}
				reopened, err := OpenStore(c.store.dir)
				must(t, err)
				must(t, reopened.Close())
			})
		}
	}
}

func TestStdioOutputCancellationWakesAllQueuedWriters(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	reader, writer := io.Pipe()
	output := &observedStdioOutput{WriteCloser: writer, writes: make(chan struct{}, 1)}
	write, run := newStdioOutput(ctx, output, cancel)
	workerDone := make(chan struct{})
	callersDone := make(chan struct{})
	t.Cleanup(func() {
		cancel(context.Canceled)
		_ = writer.Close()
		_ = reader.Close()
		waitStdioShutdown(t, workerDone)
		waitStdioShutdown(t, callersDone)
	})
	go func() { defer close(workerDone); run() }()
	const callers = 4 * stdioOutputBuffer
	results := make(chan error, callers)
	var started, finished sync.WaitGroup
	started.Add(callers)
	finished.Add(callers)
	for i := 0; i < callers; i++ {
		go func(id int) {
			defer finished.Done()
			started.Done()
			results <- write(rpcResponse{ID: int64(id)})
		}(i)
	}
	go func() { finished.Wait(); close(callersDone) }()
	started.Wait()
	select {
	case <-output.writes:
	case <-time.After(3 * time.Second):
		t.Fatal("writer did not block")
	}
	cancel(context.Canceled)
	must(t, writer.Close())
	waitStdioShutdown(t, workerDone)
	waitStdioShutdown(t, callersDone)
	for i := 0; i < callers; i++ {
		if err := <-results; !errors.Is(err, context.Canceled) {
			t.Fatalf("queued writer returned %v", err)
		}
	}
	if err := write("late event"); !errors.Is(err, context.Canceled) {
		t.Fatalf("write after shutdown returned %v", err)
	}
}

func TestStdioOutputFailureClosesInputAndCore(t *testing.T) {
	c := testCore(t, nil)
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	must(t, outReader.Close())
	done := make(chan struct{})
	var serveErr error
	t.Cleanup(func() {
		_ = inReader.Close()
		_ = inWriter.Close()
		_ = outWriter.Close()
		waitStdioShutdown(t, done)
	})
	go func() { serveErr = serveStdio(context.Background(), c, inReader, outWriter); close(done) }()
	waitStdioShutdown(t, done)
	if !errors.Is(serveErr, io.ErrClosedPipe) {
		t.Fatalf("output failure returned %v", serveErr)
	}
	if err := awaitStdioIO(t, func() error {
		_, err := inWriter.Write([]byte("\n"))
		return err
	}); err == nil {
		t.Fatal("output failure left scanner input open")
	}
	select {
	case <-c.ctx.Done():
	default:
		t.Fatal("output failure left core open")
	}
}

func TestStdioBytesBufferOutputCompatibility(t *testing.T) {
	c := testCore(t, nil)
	reader, writer := io.Pipe()
	var output bytes.Buffer
	done := make(chan struct{})
	var serveErr error
	t.Cleanup(func() { _ = writer.Close(); _ = reader.Close(); waitStdioShutdown(t, done) })
	go func() { serveErr = serveStdio(context.Background(), c, reader, &output); close(done) }()
	must(t, awaitStdioIO(t, func() error {
		_, err := fmt.Fprintln(writer, `{"id":1,"method":"transport.configure","params":{"tailnet_enabled":true}}`)
		return err
	}))
	await(t, func() bool { return c.store.Snapshot().Tailnet })
	must(t, writer.Close())
	waitStdioShutdown(t, done)
	must(t, serveErr)
	// The encoder has exited, so reading the buffer is race-free.
	readStdioReady(t, &output)
}

type uninterruptibleStdioWriter struct{}

func (uninterruptibleStdioWriter) Write([]byte) (int, error) {
	panic("an arbitrary writer must be rejected before Write")
}

func TestStdioRejectsUninterruptibleOutput(t *testing.T) {
	c := testCore(t, nil)
	err := serveStdio(context.Background(), c, strings.NewReader(""), uninterruptibleStdioWriter{})
	if err == nil || !strings.Contains(err.Error(), "interruptible Close") {
		t.Fatalf("uninterruptible output was not rejected: %v", err)
	}
}

// This runs in a subprocess so inherited stdin/stdout start as real blocking
// descriptors, rather than the pollable files returned by os.Pipe in this test.
func TestStdioShutdownProcess(t *testing.T) {
	if os.Getenv("NOOTIFY_STDIO_SHUTDOWN_HELPER") == "" {
		return
	}
	err := func() error {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		store, err := OpenStore(os.Getenv("NOOTIFY_STDIO_SHUTDOWN_STATE"))
		if err != nil {
			return err
		}
		defer store.Close()
		core, err := NewCore(ctx, store, nil)
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "serving")
		err = serveStdio(ctx, core, os.Stdin, os.Stdout)
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	}()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestStdioShutdownInheritedStdoutReleasesState(t *testing.T) {
	for _, phase := range []string{"ready", "response"} {
		for _, stop := range []string{"eof", "sigterm"} {
			t.Run(phase+"/"+stop, func(t *testing.T) {
				if runtime.GOOS == "windows" && stop == "sigterm" {
					t.Skip("Windows does not deliver SIGTERM; cancellation is covered with io.Pipe")
				}
				dir := t.TempDir()
				if phase == "response" {
					store, err := OpenStore(dir)
					must(t, err)
					must(t, store.Update(func(d *State) error {
						d.Bindings["large"] = Binding{Session: Session{Metadata: map[string]any{"padding": strings.Repeat("x", 2<<20)}}}
						return nil
					}))
					must(t, store.Close())
				}
				outReader, outWriter, err := os.Pipe()
				must(t, err)
				t.Cleanup(func() { _ = outReader.Close(); _ = outWriter.Close() })
				if phase == "ready" {
					// Fill before inheritance makes this descriptor blocking.
					prefillStdioPipe(t, outReader, outWriter)
				}
				cmd := exec.Command(os.Args[0], "-test.run=^TestStdioShutdownProcess$")
				cmd.Env = append(os.Environ(), "NOOTIFY_STDIO_SHUTDOWN_HELPER=1", "NOOTIFY_STDIO_SHUTDOWN_STATE="+dir)
				cmd.Stdout = outWriter
				stdin, err := cmd.StdinPipe()
				must(t, err)
				stderr, err := cmd.StderrPipe()
				must(t, err)
				done := make(chan struct{})
				var processErr error
				t.Cleanup(func() {
					_ = stdin.Close()
					_ = outReader.Close()
					_ = outWriter.Close()
					_ = stderr.Close()
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
						waitStdioShutdown(t, done)
					}
				})
				must(t, cmd.Start())
				must(t, outWriter.Close())
				go func() { processErr = cmd.Wait(); close(done) }()
				serving := make(chan error, 1)
				go func() {
					line, err := bufio.NewReader(stderr).ReadString('\n')
					if err == nil && line != "serving\n" {
						err = fmt.Errorf("unexpected child startup: %q", line)
					}
					serving <- err
				}()
				select {
				case err := <-serving:
					must(t, err)
				case <-time.After(3 * time.Second):
					t.Fatal("child did not start serving")
				}
				if phase == "response" {
					readStdioReady(t, outReader)
					must(t, awaitStdioIO(t, func() error {
						_, err := fmt.Fprintln(stdin, `{"id":1,"method":"session.list"}`)
						return err
					}))
					started := make(chan error, 1)
					go func() { _, err := io.ReadFull(outReader, make([]byte, 1)); started <- err }()
					select {
					case err := <-started:
						must(t, err)
					case <-time.After(3 * time.Second):
						t.Fatal("large response did not start writing")
					}
				}
				if stop == "eof" {
					must(t, stdin.Close())
				} else {
					must(t, cmd.Process.Signal(syscall.SIGTERM))
				}
				waitStdioShutdown(t, done)
				must(t, processErr)
				reopened, err := OpenStore(dir)
				must(t, err)
				must(t, reopened.Close())
			})
		}
	}
}
