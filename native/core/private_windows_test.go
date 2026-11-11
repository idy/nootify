package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsStateReplacementRetriesOpenDestination(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "replacement"), filepath.Join(dir, "state.json")
	must(t, os.WriteFile(from, []byte("new state"), 0600))
	must(t, os.WriteFile(to, []byte("old state"), 0600))
	source, err := windows.UTF16PtrFromString(from)
	must(t, err)
	target, err := windows.UTF16PtrFromString(to)
	must(t, err)
	// Match libuv's readFile sharing flags: delete sharing does not make an
	// open destination replaceable by the legacy MoveFileEx API.
	reader, err := windows.CreateFile(target, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
	must(t, err)
	defer func() {
		if reader != windows.InvalidHandle {
			_ = windows.CloseHandle(reader)
		}
	}()
	attempts := 0
	must(t, retryStateReplacement(func() error {
		attempts++
		err := windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if attempts == 1 {
			if !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
				t.Fatalf("open destination did not reject replacement: %v", err)
			}
			// Release only after observing the real Win32 rejection, so this
			// exercises the retry without relying on scheduler timing.
			must(t, windows.CloseHandle(reader))
			reader = windows.InvalidHandle
		}
		return err
	}))
	if attempts != 2 {
		t.Fatalf("replacement attempts = %d, want 2", attempts)
	}
	data, err := os.ReadFile(to)
	must(t, err)
	if string(data) != "new state" {
		t.Fatal("replacement did not publish the new state")
	}
	if _, err := os.Stat(from); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement left its source: %v", err)
	}
}

func TestWindowsStateReplacementReturnsPersistentFailures(t *testing.T) {
	for _, cause := range []error{windows.ERROR_ACCESS_DENIED, windows.ERROR_SHARING_VIOLATION, windows.ERROR_DISK_FULL} {
		t.Run(cause.Error(), func(t *testing.T) {
			attempts := 0
			started := time.Now()
			err := retryStateReplacement(func() error { attempts++; return cause })
			if !errors.Is(err, cause) {
				t.Fatalf("lost replacement failure: %v", err)
			}
			if cause == windows.ERROR_DISK_FULL {
				if attempts != 1 {
					t.Fatal("retried a non-sharing failure")
				}
			} else if attempts < 2 || time.Since(started) < time.Second || time.Since(started) > 5*time.Second {
				t.Fatalf("sharing retries were not bounded: %d attempts in %s", attempts, time.Since(started))
			}
		})
	}
}

func TestWindowsDeliveryCompletionSurvivesStateReader(t *testing.T) {
	var deliveryID string
	dispatched := 0
	c := testCore(t, func(name string, data any) error {
		if name == "delivery" {
			deliveryID = data.(map[string]any)["delivery_id"].(string)
			dispatched++
		}
		return nil
	})
	event := eventFor(c.node(), "reader-overlap")
	event.Session.Adapter = "trae"
	must(t, c.Ingest(context.Background(), event, "upstream"))
	path := filepath.Join(c.store.dir, "state.json")
	name, err := windows.UTF16PtrFromString(path)
	must(t, err)
	reader, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
	must(t, err)
	defer func() {
		if reader != windows.InvalidHandle {
			_ = windows.CloseHandle(reader)
		}
	}()
	completed := make(chan error, 1)
	go func() { completed <- c.Complete(deliveryID, "delivered", "inbox_queued", "") }()
	select {
	case err := <-completed:
		t.Fatalf("completion returned before its state reader closed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	must(t, windows.CloseHandle(reader))
	reader = windows.InvalidHandle
	select {
	case err := <-completed:
		must(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("completion did not recover after the reader closed")
	}
	data, err := os.ReadFile(path)
	must(t, err)
	var persisted State
	must(t, json.Unmarshal(data, &persisted))
	delivery := persisted.Deliveries[deliveryID]
	if delivery.Status != "delivered" || delivery.Transport != "inbox_queued" || delivery.InboxQueuedAt == 0 {
		t.Fatalf("accepted input did not persist its completion: %+v", delivery)
	}
	if persisted.References[event.Message.key()].InboxState != "pending" {
		t.Fatal("completion lost the unread inbox reference")
	}
	must(t, c.Ingest(context.Background(), event, "upstream"))
	if dispatched != 1 || len(c.store.Snapshot().Deliveries) != 1 {
		t.Fatal("completion recovery caused duplicate adapter submission")
	}
}

func TestWindowsStateUsesProtectedUserACLAndStableLock(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	must(t, err)
	defer s.Close()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	must(t, err)
	for _, path := range []string{dir, filepath.Join(dir, "core.lock"), filepath.Join(dir, "state.json")} {
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		must(t, err)
		control, _, err := descriptor.Control()
		must(t, err)
		if control&windows.SE_DACL_PROTECTED == 0 {
			t.Fatalf("state ACL is not protected: %s", path)
		}
		// SDDL may abbreviate a well-known account SID (for example LA on
		// elevated CI runners). Inspect ACEs rather than the display spelling.
		dacl, _, err := descriptor.DACL()
		must(t, err)
		if dacl == nil || dacl.AceCount != 2 {
			t.Fatalf("expected exactly user and SYSTEM access: %s", path)
		}
		seenUser, seenSystem := false, false
		for i := uint32(0); i < uint32(dacl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			must(t, windows.GetAce(dacl, i, &ace))
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
				t.Fatalf("unexpected state access entry: %s", path)
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			switch {
			case sid.Equals(user.User.Sid):
				seenUser = true
			case sid.IsWellKnown(windows.WinLocalSystemSid):
				seenSystem = true
			default:
				t.Fatalf("state grants access to an unrelated SID: %s", sid.String())
			}
			required := windows.ACCESS_MASK(windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE | windows.DELETE)
			if ace.Mask&required != required {
				t.Fatalf("user/SYSTEM state access is incomplete: %s", path)
			}
		}
		if !seenUser || !seenSystem {
			t.Fatalf("state must grant access to both user and SYSTEM: %s", path)
		}
	}
	if second, err := OpenStore(dir); err == nil {
		second.Close()
		t.Fatal("Windows process lock did not exclude a second writer")
	}
}
