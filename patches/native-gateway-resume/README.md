# Native gateway resume patch

The main branch currently runs the TypeScript gateway in `src/ui-gateway.ts`.
The locally installed single-binary Go v0.2.1 build instead uses an unpublished
native migration. `fix.patch` fixes its corresponding gateway without importing
that migration into the TypeScript tree. It is a source patch, not an installer;
merging this directory does not change an installed application.

## Baseline

The baseline is the native source snapshot used to build the installed v0.2.1
application on 2026-11-11. Because that migration is uncommitted, its file hashes,
not a main-branch commit, identify the applicable source:

```text
9759b59877d72cef2d363574e99f9ecf70237e348ac78ffbb6c02a466042c688  internal/webui/client.go
5bc9d99ab540530ee1bb4619ee8d3d2696d7f4f70a1252340cfaed78a6a72761  internal/webui/codec.go
7e251dc24b0525d9f0fa98dd696c9474b04934a800eaa0f7f456b465b8d5f325  internal/webui/gateway.go
6b20e814cd6fa08df8d3261cea7f8318e9501226ced8e4365253050310be1488  internal/webui/server.go
da8a70f5f0428ab68776eb8df4691f891e9c819f36f1c9b604693097cfb45f73  internal/webui/webui_test.go
```

Copy the native migration into a separate working directory before applying the
patch. From that directory, set `patch_file` to the absolute path to `fix.patch`
and run:

```bash
git apply --check "$patch_file"
```

```bash
git apply "$patch_file"
```

```bash
go test -race ./internal/webui -count=20 -timeout=90s
```

```bash
go vet ./internal/webui
```

```bash
go test ./internal/host ./internal/service ./internal/app -timeout=120s
```

The patch changes only `internal/webui/gateway.go`, the existing idle regression,
and a new `internal/webui/gateway_recovery_test.go`. Do not apply it to the
TypeScript main tree; the native source and its root `go.mod` must exist first.

## Behavior and validation

A failed GET before authenticated response headers causes at most one retry on
a newly verified daemon session. Concurrent requests reuse the replacement;
a late failure from an old session cannot invalidate it. POSTs are never replayed,
even when a mutation committed before its response was lost. Authenticated
business errors and started streams are never replayed. Request cancellation
and gateway shutdown stop recovery; an intentionally cancelled healthy request
does not retire its session. A gateway deadline instead retires the stalled
session without replaying the timed-out request; the next read establishes fresh
proof. Existing origin/Host checks and encrypted framing remain in place.

Validated on macOS arm64 with Go 1.27.3:

- Twenty race-enabled runs of the complete `internal/webui` package passed.
- `go vet ./internal/webui` passed.
- Native `internal/host`, `internal/service`, and `internal/app` tests passed.
- Applying the patch to a pristine baseline reproduced all three tested files
  byte-for-byte.
- A browser fixture using the real Go gateway and browser encryption transport
  discarded the daemon's sessions, then completed the very first read with 200.
  Repeating this with 24 simultaneous reads produced 24 successes sharing one
  new owner proof, with no failed browser requests or console errors.

Tests cover idle expiry, a real daemon HTTP server restart on the same port,
concurrent recovery, failed proof/failed retry, a mutation with a lost response,
expired POSTs, authenticated error statuses, partially received streams, request
cancellation, cancelled connection waiters, gateway shutdown during proof, and
gateway deadline expiry before headers and during a stream (without immediate
replay, with fresh proof on the next read).

The browser fixture uses synthetic credentials and does not run the installed
application. Installing a rebuilt native app is a separate step; no installation
is performed by this patch or its tests. Once the native migration lands, port
these changes into its tracked source and remove this temporary patch carrier.
