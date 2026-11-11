package tailscale

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

const (
	maxRequestBytes  = 4096    // excluding the terminating newline
	maxResponseBytes = 1 << 20 // including the terminating newline
	maxRPCConcurrent = 16
	rpcTimeout       = 8 * time.Second
	maxRequestID     = 1<<53 - 1 // round-trips exactly through the Node parent
)

type request struct {
	ID       int64
	Method   string
	IP       string
	Address  string
	TunnelID string
	Port     int
	Target   string
}

type response struct {
	ID     int64  `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func failure(id int64, code string) response { return response{ID: id, Error: code} }

// Decode one complete JSON object. Unknown fields and duplicate keys are
// rejected so a malformed call cannot invoke an unintended auth operation.
func decodeRequest(line []byte) (request, string) {
	var req request
	decoder := json.NewDecoder(bytes.NewReader(line))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return req, "invalid_request"
	}
	seen := make(map[string]bool, 3)
	var id *int64
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return request{}, "invalid_request"
		}
		seen[name] = true
		switch name {
		case "id":
			err = decoder.Decode(&id)
		case "method":
			err = decoder.Decode(&req.Method)
		case "ip":
			err = decoder.Decode(&req.IP)
		case "address":
			err = decoder.Decode(&req.Address)
		case "tunnel_id":
			err = decoder.Decode(&req.TunnelID)
		case "port":
			err = decoder.Decode(&req.Port)
		case "target":
			err = decoder.Decode(&req.Target)
		default:
			return request{}, "invalid_request"
		}
		if err != nil {
			return request{}, "invalid_request"
		}
	}
	if _, err := decoder.Token(); err != nil {
		return request{}, "invalid_request"
	}
	if err := decoder.Decode(new(any)); err != io.EOF || id == nil || *id <= 0 || *id > maxRequestID || req.Method == "" {
		return request{}, "invalid_request"
	}
	req.ID = *id
	for field, method := range map[string]string{
		"ip": "whois", "address": "tunnel", "tunnel_id": "close_tunnel", "target": "publish",
	} {
		if seen[field] && req.Method != method {
			return req, "invalid_request"
		}
	}
	if seen["port"] && req.Method != "publish" && req.Method != "unpublish" {
		return req, "invalid_request"
	}
	return req, ""
}

type localClient interface {
	StatusWithoutPeers(context.Context) (*ipnstate.Status, error)
	StartLoginInteractive(context.Context) error
	Logout(context.Context) error
	WhoIs(context.Context, string) (*apitype.WhoIsResponse, error)
}

type selfStatus struct {
	DNSName      string
	TailscaleIPs []netip.Addr
	UserID       tailcfg.UserID
	HostName     string
}

type statusResult struct {
	BackendState     string
	Self             *selfStatus
	User             map[tailcfg.UserID]tailcfg.UserProfile
	AuthURL          string
	NootifyListening bool
}

func statusForParent(status *ipnstate.Status, listening bool) statusResult {
	result := statusResult{
		BackendState:     status.BackendState,
		AuthURL:          status.AuthURL,
		NootifyListening: listening,
		User:             make(map[tailcfg.UserID]tailcfg.UserProfile),
	}
	if self := status.Self; self != nil {
		result.Self = &selfStatus{
			DNSName: self.DNSName, TailscaleIPs: self.TailscaleIPs,
			UserID: self.UserID, HostName: self.HostName,
		}
		if user, ok := status.User[self.UserID]; ok {
			result.User[self.UserID] = user
		}
	}
	return result
}

type rpcDispatcher struct {
	client    localClient
	listening func() bool
	mutations chan struct{}
	transport *tcpTransport
}

func (d *rpcDispatcher) dispatch(ctx context.Context, req request) response {
	var result any
	var err error
	code := "unknown_method"
	switch req.Method {
	case "tunnel", "close_tunnel", "publish", "unpublish":
		if d.transport == nil {
			return failure(req.ID, "unavailable")
		}
		// Creation checks cancellation before handing ownership to the service.
		// Do not turn a successful allocation into a timeout with a hidden handle.
		return d.transport.dispatch(ctx, req)
	case "status":
		code = "status_failed"
		var status *ipnstate.Status
		status, err = d.client.StatusWithoutPeers(ctx)
		if err == nil && status != nil {
			result = statusForParent(status, d.listening())
		}
	case "login", "logout":
		// Auth mutations serialize, while status and peer checks remain usable.
		select {
		case d.mutations <- struct{}{}:
			defer func() { <-d.mutations }()
		case <-ctx.Done():
			return failure(req.ID, contextError(ctx.Err(), "canceled"))
		}
		if req.Method == "login" {
			code = "login_failed"
			err = d.client.StartLoginInteractive(ctx)
		} else {
			code = "logout_failed"
			err = d.client.Logout(ctx)
		}
		result = struct {
			OK bool `json:"ok"`
		}{true}
	case "whois":
		ip, parseErr := parseIP(req.IP)
		if parseErr != nil {
			return failure(req.ID, "invalid_ip")
		}
		code = "whois_failed"
		var identity *apitype.WhoIsResponse
		identity, err = d.client.WhoIs(ctx, ip.String())
		if errors.Is(err, local.ErrPeerNotFound) {
			code = "peer_not_found"
		}
		if err == nil && identity != nil && identity.Node != nil {
			// Tagged nodes belong to tags, not to the human in UserProfile.
			// Never let that profile admit a tagged device as its former owner.
			if identity.Node.IsTagged() {
				return failure(req.ID, "peer_not_found")
			}
			if identity.UserProfile != nil {
				result = identity
			}
		}
	default:
		return failure(req.ID, code)
	}
	if err != nil || result == nil {
		return failure(req.ID, contextError(err, code))
	}
	if ctx.Err() != nil {
		return failure(req.ID, contextError(ctx.Err(), code))
	}
	return response{ID: req.ID, Result: result}
}

func contextError(err error, fallback string) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		return fallback
	}
}

func encodeResponse(reply response) []byte {
	data, err := json.Marshal(reply)
	if err != nil {
		data, _ = json.Marshal(failure(reply.ID, "encoding_failed"))
	} else if len(data)+1 > maxResponseBytes {
		data, _ = json.Marshal(failure(reply.ID, "response_too_large"))
	}
	return append(data, '\n')
}

// Lifecycle frames share this writer with the RPC writer. Close deliberately
// does not take mu: cancellation must interrupt even a blocked stdout write.
type protocolOutput struct {
	io.WriteCloser
	mu sync.Mutex
}

func (o *protocolOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.WriteCloser.Write(data)
}

func (o *protocolOutput) emit(reply response) error {
	data := encodeResponse(reply)
	n, err := o.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	return err
}

// serveRPC owns its streams. Closing them on cancellation interrupts a blocked
// read or write, including when the parent dies without another request. There
// is one writer, at most maxRPCConcurrent handlers, and a bounded reply queue.
func serveRPC(parent context.Context, input io.ReadCloser, output io.WriteCloser, dispatch func(context.Context, request) response) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var workers sync.WaitGroup
	closedStreams := make(chan struct{})
	go func() {
		<-ctx.Done()
		input.Close()
		output.Close()
		close(closedStreams)
	}()

	var firstError error
	var errorOnce sync.Once
	fail := func(code string) {
		errorOnce.Do(func() { firstError = errors.New(code) })
		cancel()
	}
	responses := make(chan response, maxRPCConcurrent*2)
	emit := func(reply response) {
		select {
		case responses <- reply:
		case <-ctx.Done():
		default:
			fail("rpc_backpressure")
		}
	}
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case reply := <-responses:
				data := encodeResponse(reply)
				n, err := output.Write(data)
				if err != nil || n != len(data) {
					if ctx.Err() == nil {
						fail("rpc_output_failed")
					}
					return
				}
			}
		}
	}()
	slots := make(chan struct{}, maxRPCConcurrent)
	reader := bufio.NewReaderSize(input, maxRequestBytes+1)
	for ctx.Err() == nil {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			// Discard an overlong frame without accumulating it in memory.
			for errors.Is(err, bufio.ErrBufferFull) {
				_, err = reader.ReadSlice('\n')
			}
			emit(failure(0, "request_too_large"))
			continue
		}
		if err != nil {
			if err != io.EOF && ctx.Err() == nil {
				fail("rpc_input_failed")
			}
			// An unterminated final frame is never dispatched on EOF.
			break
		}
		req, code := decodeRequest(line[:len(line)-1])
		if code != "" {
			emit(failure(req.ID, code))
			continue
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() { <-slots }()
				callCtx, stop := context.WithTimeout(ctx, rpcTimeout)
				defer stop()
				emit(dispatch(callCtx, req))
			}()
		default:
			emit(failure(req.ID, "busy"))
		}
	}
	cancel()
	<-closedStreams
	workers.Wait()
	<-writerDone
	return firstError
}
