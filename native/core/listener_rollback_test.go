package core

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/idy/nootify/native/core/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func probeListener(t *testing.T, address, token string, tc credentials.TransportCredentials) error {
	t.Helper()
	if tc == nil {
		tc = insecure.NewCredentials()
	}
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(tc))
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token, "nootify-node-id", "probe")
	_, err = pb.NewNotificationCoreClient(conn).Call(ctx, &pb.Command{Method: "status", ParamsJson: []byte(`{}`), VisitedNodes: []string{"probe"}})
	return err // A private-method Result confirms transport authentication.
}
func TestListenerConfigurationFailurePreservesLiveAndDurableState(t *testing.T) {
	for _, importing := range []bool{false, true} {
		for _, failure := range []string{"occupied-address", "invalid-tls"} {
			name := "configure/" + failure
			if importing {
				name = "import/" + failure
			}
			t.Run(name, func(t *testing.T) {
				c := testCore(t, nil)
				bot := &importTestBot{Bot: installFake(t, c, "retained")}
				installRoutingBot(c, "retained", bot)
				_, err := c.Ensure(context.Background(), "retained", Session{Adapter: "codex", SessionID: "keep"})
				must(t, err)
				address, token := testServer(t, c)
				stream, _, _ := authenticatedStreamClient(t, address, token, "rollback-peer")
				oldServer := c.server
				before := c.store.Snapshot()
				statePath := filepath.Join(c.store.dir, "state.json")
				fileBefore, err := os.ReadFile(statePath)
				must(t, err)
				r := before.Remote
				r.Token = "must-not-apply"
				if failure == "occupied-address" {
					occupied, err := net.Listen("tcp", "127.0.0.1:0")
					must(t, err)
					defer occupied.Close()
					r.Listen = occupied.Addr().String()
				} else {
					r.CertFile, r.KeyFile = filepath.Join(t.TempDir(), "missing-cert.pem"), filepath.Join(t.TempDir(), "missing-key.pem")
				}
				if importing {
					raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{}, Remote: r})
					must(t, err)
					err = c.ImportConfig(raw)
					if err == nil {
						t.Fatal("invalid listener import succeeded")
					}
				} else {
					raw, err := json.Marshal(r)
					must(t, err)
					_, err = c.ConfigureRemote(raw)
					if err == nil {
						t.Fatal("invalid listener reconfiguration succeeded")
					}
				}
				fileAfter, err := os.ReadFile(statePath)
				must(t, err)
				if !reflect.DeepEqual(before, c.store.Snapshot()) || !bytes.Equal(fileBefore, fileAfter) {
					t.Fatal("failed listener setup changed persisted config or bindings")
				}
				if c.server != oldServer || c.providers["retained"] != bot || bot.closes != 0 {
					t.Fatal("failed listener setup stopped previous live resources")
				}
				must(t, probeListener(t, address, token, nil))
				event := eventFor("other-owner", "after-failed-change")
				must(t, c.Ingest(context.Background(), event, ""))
				frame, err := stream.Recv()
				must(t, err)
				if frame.GetEvent().EventId != event.ID {
					t.Fatal("failed setup lost live subscription")
				}
				must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}}))
				await(t, func() bool { return len(c.store.Snapshot().Peers["rollback-peer"].Pending) == 0 })
			})
		}
	}
}

func TestListenerSameAddressTokenChangeRevokesStreamsAndRetainsReplay(t *testing.T) {
	for _, importing := range []bool{false, true} {
		name := "configure"
		if importing {
			name = "import"
		}
		t.Run(name, func(t *testing.T) {
			c := testCore(t, nil)
			address, token := testServer(t, c)
			stream, _, _ := authenticatedStreamClient(t, address, token, "retained-peer")
			event := eventFor("other-owner", "unconfirmed-before-token-change")
			must(t, c.Ingest(context.Background(), event, ""))
			frame, err := stream.Recv()
			must(t, err)
			if frame.GetEvent().EventId != event.ID {
				t.Fatal("old stream did not receive queued event")
			}
			before := c.store.Snapshot()
			server := c.server
			r := before.Remote
			r.Token = "replacement-token"
			if importing {
				raw, err := json.Marshal(Backup{Version: 1, Providers: []ProviderConfig{}, Remote: r})
				must(t, err)
				must(t, c.ImportConfig(raw))
			} else {
				raw, err := json.Marshal(r)
				must(t, err)
				_, err = c.ConfigureRemote(raw)
				must(t, err)
			}
			if c.server != server || c.server.listener.Addr().String() != address {
				t.Fatal("same-address reload replaced live socket")
			}
			closed := make(chan error, 1)
			go func() { _, err := stream.Recv(); closed <- err }()
			select {
			case err := <-closed:
				if err == nil {
					t.Fatal("old-token stream remained authorized")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("old-token stream was not promptly revoked")
			}
			if status.Code(probeListener(t, address, token, nil)) != codes.Unauthenticated {
				t.Fatal("listener still accepts old token")
			}
			must(t, probeListener(t, address, r.Token, nil))
			_ = stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}})
			if !reflect.DeepEqual(before.Peers, c.store.Snapshot().Peers) {
				t.Fatal("token rotation or revoked confirmation changed durable pin/backlog")
			}
			reconnected, _, _ := authenticatedStreamClient(t, address, r.Token, "retained-peer")
			frame, err = reconnected.Recv()
			must(t, err)
			got, err := parseEvent(frame.GetEvent())
			must(t, err)
			if got.ID != event.ID || got.Message != event.Message || !reflect.DeepEqual(got.Session, event.Session) {
				t.Fatal("new-token reconnect changed queued identity")
			}
			must(t, reconnected.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Confirmation{Confirmation: &pb.Confirmation{EventId: event.ID}}}))
			await(t, func() bool { return len(c.store.Snapshot().Peers["retained-peer"].Pending) == 0 })
		})
	}
}
func TestListenerPreparedSocketClosesWhenPersistenceFails(t *testing.T) {
	c := testCore(t, nil)
	address, token := testServer(t, c)
	old := c.server
	before := c.store.Snapshot()
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	candidate := reserved.Addr().String()
	must(t, reserved.Close())
	r := before.Remote
	r.Listen = candidate
	raw, err := json.Marshal(r)
	must(t, err)
	c.store.mu.Lock()
	originalDir := c.store.dir
	c.store.dir = filepath.Join(originalDir, "does-not-exist")
	c.store.mu.Unlock()
	_, err = c.ConfigureRemote(raw)
	c.store.mu.Lock()
	c.store.dir = originalDir
	c.store.mu.Unlock()
	if err == nil {
		t.Fatal("failed persistence succeeded")
	}
	if c.server != old || !reflect.DeepEqual(before, c.store.Snapshot()) {
		t.Fatal("persistence failure replaced old listener or state")
	}
	must(t, probeListener(t, address, token, nil))
	available, err := net.Listen("tcp", candidate)
	must(t, err)
	must(t, available.Close())
}

func listenerCertificate(t *testing.T) (certPath, keyPath string, tc credentials.TransportCredentials) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "loopback-fixture"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	must(t, err)
	keyDER, err := x509.MarshalPKCS8PrivateKey(private)
	must(t, err)
	dir := t.TempDir()
	certPath, keyPath = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	must(t, os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600))
	must(t, os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600))
	roots := x509.NewCertPool()
	certificate, err := x509.ParseCertificate(der)
	must(t, err)
	roots.AddCert(certificate)
	return certPath, keyPath, credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: "127.0.0.1", RootCAs: roots})
}
func TestListenerSameAddressTLSReloadAndModeChangeRollback(t *testing.T) {
	c := testCore(t, nil)
	cert, key, tc := listenerCertificate(t)
	r := RemoteConfig{Enabled: true, Listen: "127.0.0.1:0", Token: "synthetic", CertFile: cert, KeyFile: key}
	raw, err := json.Marshal(r)
	must(t, err)
	_, err = c.ConfigureRemote(raw)
	must(t, err)
	server := c.server
	address := server.listener.Addr().String()
	must(t, probeListener(t, address, r.Token, tc))
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(tc))
	must(t, err)
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+r.Token, "nootify-node-id", "same-token-tls-peer")
	stream, err := pb.NewNotificationCoreClient(conn).Subscribe(ctx)
	must(t, err)
	private := fixturePeerKey("same-token-tls-peer")
	must(t, stream.Send(&pb.SubscriptionFrame{Body: &pb.SubscriptionFrame_Hello{Hello: &pb.Hello{NodeId: "same-token-tls-peer", PublicKey: private.Public().(ed25519.PublicKey)}}}))
	finishPeerProof(t, stream, "same-token-tls-peer", private)
	newCert, newKey, newTC := listenerCertificate(t)
	r.CertFile, r.KeyFile = newCert, newKey
	raw, err = json.Marshal(r)
	must(t, err)
	_, err = c.ConfigureRemote(raw)
	must(t, err)
	if c.server != server {
		t.Fatal("TLS certificate reload replaced socket")
	}
	must(t, probeListener(t, address, r.Token, newTC))
	must(t, c.Ingest(context.Background(), eventFor("elsewhere", "after-same-token-tls-reload"), ""))
	frame, err := stream.Recv()
	must(t, err)
	if frame.GetEvent().EventId != "after-same-token-tls-reload" {
		t.Fatal("same-token certificate reload closed existing subscription")
	}
	before := c.store.Snapshot()
	r.CertFile, r.KeyFile = "", ""
	// ConfigureRemote is a patch: omitted TLS fields deliberately retain their
	// previous values. Explicit empty fields request switching to plaintext.
	raw, err = json.Marshal(map[string]any{"enabled": r.Enabled, "listen": r.Listen, "token": r.Token, "tls_cert_file": "", "tls_key_file": ""})
	must(t, err)
	_, err = c.ConfigureRemote(raw)
	if publicError(err).Code != "conflict" || c.server != server || !reflect.DeepEqual(before, c.store.Snapshot()) {
		t.Fatal("same-address TLS mode change did not preserve previous config/listener")
	}
	must(t, probeListener(t, address, r.Token, newTC))
}
