# MyGo desktop architecture

This document describes the current unified Go/MyGo architecture after the desktop and backend migrations. Nootify uses `github.com/egoist/mygo` pinned to `v0.8.3`. One executable contains desktop, CLI, background HTTP service, agent adapters, and notification core; TypeScript is used only for the compiled browser UI. The Node-era runtime is retired; macOS retains small native upgrade bridges at its historical entry paths for older updaters.

## Layout and responsibilities

- `desktop/` is the desktop entry point in the root Go module (`github.com/idy/nootify`). Go embeds the offline HTML/CSS/JS/fonts. MyGo's operating-system webview loads either the application-owned offline view or the trusted UI gateway serving packaged assets. Both handlers run inside MyGo. The daemon at `http://127.0.0.1:9417/` is the gateway's authenticated backend. Native policy admits only the live owned gateway origin; authenticated encryption protects API reads/writes between browser, gateway and daemon. Direct LAN HTTP does not use that encryption.
- `desktop/main.go` and related Go files own MyGo windows, tray, single-instance activation, native menus, navigation restrictions, trusted document events, language preference, and service lifecycle. No generic privileged frontend bindings are exposed. Existing fixed `nootify://window/...`, `nootify://update/...`, `nootify://language/...` and offline service actions are validated and canceled by native policy. Log exports from a trusted document's own Blob URL retain MyGo's Downloads destination and unique filename handling; other downloads remain blocked.
- `desktop/` coordinates service lifecycle through `internal/service/`, which manages only the owned LaunchAgent/Windows task and preserves independent daemon lifetime after desktop quit. It must preserve existing ownership, occupied-port, environment isolation, read-only-volume and process-replacement protections.
- `desktop/internal/updater` owns release checks, signature verification, progress/state events, and installation/relaunch. It stays independent of MyGo APIs so it can be tested and used by a signing CLI without starting native UI.
- `desktop/cmd/sign-update` signs release artifacts in Go. Keys come from environment or private files, never logs or command-line secret values. Existing updater public key and signature/manifests remain compatible with installed Nootify clients.
- `desktop/icons/` and `desktop/Entitlements.plist` own the native assets and entitlements. No Node runtime or Node JIT entitlement is required.
- `build/nootify` is the locally built unified executable. `build/resources/service/` holds staged browser assets and dependency notices; no service scripts, production npm modules, or helper executables are staged. Build products are ignored.
- `build/desktop/<target-triple>/` contains distribution output: macOS `macos/Nootify.app`, `macos/Nootify.app.tar.gz`, `dmg/*.dmg`; Windows `nsis/*-x64-setup.exe`. Keeping the logical bundle layout permits the existing release collector and upgrade smoke checks to migrate without changing artifact semantics.

The host does not require the MyGo bundler: a Node build script may compile the pinned MyGo Go module and create the platform bundle directly. JSON/native build metadata must keep version authority in the root `package.json`. No Cargo or Rust is required to build, test, stage, package, or generate notices.

macOS DMGs use UDZO without a Spotlight index. Only `hdiutil create` resource-busy failures retry, at most three attempts with one- and two-second backoff and a two-minute command deadline per attempt. Each attempt writes a separate temporary image beside the destination. Signing must succeed before a same-volume rename publishes the final filename; a failed create/sign leaves an existing completed image unchanged. Permission, disk-space, spawn, signal and timeout failures are not retried.

## Installed layout and compatibility

Keep app identity `dev.idy.nootify`, app name Nootify, service port 9417, the existing private state directories, task/LaunchAgent identity, and existing routing/auth tokens.

Current macOS packages use `Nootify.app/Contents/MacOS/Nootify`; Windows packages use `Nootify.exe`. Both run their own `serve` mode for the background job. Historical Node-era packages contained a Node service and separate helper executables. Owned legacy LaunchAgents/tasks are migrated only after exact path/identity validation and process draining. Since 0.3.2, macOS packages retain the regular files required by the 0.2.1 updater: a small native `node` dispatcher, explicit unsupported-entry launchers for the retired helpers, and `cli.js`/`server.js` path markers. The dispatcher executes the canonical Go binary with the original argument boundaries and inherited streams. Legacy service commands preserve the Node-era registration during GUI handoff so rollback can restart the old app's service; the server entry runs Go `serve`, and a subsequent ordinary Start/Restart can migrate the registration. No Node/npm, notification-core, or VPN runtime is restored. Both old and current macOS clients use the signed updater without a manual replacement. Installation and uninstallation first check that the desktop executable can be replaced, before changing the service, payload, or registration. Upgrades then stop the owned service before replacing files; uninstall removes only that installation's owned task. Do not kill processes by image name or overwrite another installation's task.

The release manifest remains `latest.json` with `version`, `notes`, `pub_date`, and per-platform `url`/`signature` entries. Preserve minisign verification and the existing embedded public key so installed Tauri versions can upgrade to the MyGo package. The Go updater must also consume the same signed artifacts. Existing signing environment variable names may remain compatibility inputs; they must no longer require a Tauri/Rust binary.

## Direct LAN access

The Go HTTP service listens on all IPv4 interfaces at `0.0.0.0:9417` by default and exposes `access.lan_url` and, when present, `access.tailscale_url` for separate sidebar addresses. It accepts actual loopback/private LAN peers and Tailscale IPv4 peers in `100.64.0.0/10` when the connection's actual local socket address is also in that range. Host validation checks its own interface IPs or system hostname and service port, retaining origin/fetch-site checks. Network addresses are rediscovered on each snapshot without a restart. LAN/Tailscale UI access is read-only except repository follow choices and PR refresh. Local settings, mutations, secret reveal, and directory reads require an actual loopback peer. Bearer-authenticated `/v1/` APIs permit these LAN/Tailscale callers; `/v1/remote/` identity management stays loopback-only.

Remote Nootify connects directly over authenticated gRPC. Plaintext endpoints require numeric loopback or private LAN IPs and reject public peers; public endpoints require TLS. Direct LAN HTTP and plaintext gRPC are not encrypted by the desktop gateway. There is no embedded VPN client or tunnel layer. Retired embedded Tailscale identity files remain unused and untouched, and the operating system's Tailscale installation is unchanged. See [LAN access](guide.md#lan-access).

## Updater integration contract

Package `desktop/internal/updater` exports:

```go
type View struct {
    Phase string `json:"phase"`
    Current string `json:"current"`
    Version *string `json:"version"`
    Received uint64 `json:"received"`
    Total *uint64 `json:"total"`
    Error *string `json:"error"`
    CheckedAt *uint64 `json:"checked_at"`
}
type Options struct {
    Version string
    ManifestURL string
    PublicKey string
    Platform string // darwin-aarch64 or windows-x86_64-nsis
    Executable string
    BeforeInstall func(context.Context) error
    AfterInstall func() error
    BeforeRollback func() error
    ConfirmGUI bool // keep macOS original until FinishGUI confirms readiness
}
func New(options Options) *Manager
func (m *Manager) View() View
func (m *Manager) SetListener(func(View))
func (m *Manager) Check(context.Context) error
func (m *Manager) Install(context.Context) error
func (m *Manager) FinishGUI(context.Context, GUIRelaunchOptions) error
func (m *Manager) Run(context.Context)
```

`SetListener` publishes the existing `nootify-update` DOM event shape. Keep progress throttling, semantic phases, bounded check/download deadlines and clock-safe scheduled checks from the current updater. `BeforeInstall` runs only after signature verification and before replacement/installer launch. On Windows, launch the verified NSIS installer with compatible `/UPDATE /R` behavior and leave final lifecycle hooks responsible for stopping/restarting the owned service. On macOS, safely unpack, validate and replace this app with rollback protection. `AfterInstall` performs service-only work; it is not GUI readiness proof. On macOS, `ConfirmGUI` retains the original bundle and `FinishGUI` runs after the old event loop exits, supervises the Launch Services launch, and waits for authenticated window/tray readiness and commit before cleanup. A private one-use receipt binds expected app identity, version, executable/hash and pre-update stopped-service state. Proven launch/abort failure permits ownership-checked rollback and reopening the original; missing quiescence or identity proof retains both bundles. The result-free MyGo `App.Relaunch()` is not used as a success signal.

Signing CLI contract: `go run ./desktop/cmd/sign-update --file <artifact>` writes `<artifact>.sig` in the existing Tauri-compatible minisign representation. Accept `NOOTIFY_SIGNING_PRIVATE_KEY` / `NOOTIFY_SIGNING_PRIVATE_KEY_PASSWORD` and existing `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as fallback compatibility inputs; public keys are not regenerated. No production key is needed for unit tests, which use generated synthetic fixtures.

Updater implementation may add pure-Go dependencies. Dependencies are managed in the root `go.mod`/`go.sum`.

## Verification

Preserve all existing service and agent tests. Add Go tests for URL policy, language persistence, service ownership/environment, single-instance/close semantics where testable, update signatures and safe replacement, and release compatibility. Build and test macOS/Windows in CI, including the existing Windows install/upgrade/uninstall checks. Verify the actual MyGo desktop app locally with a separate development identity/isolated service so the installed production app and its credentials stay untouched. Browser preview verification covers the unchanged web UI and any native bridge changes; native window/tray/updater smoke checks cover behavior that a browser cannot exercise.

Portable DMG regressions inject native failures and check bounded retry, temporary-file cleanup, signing order and preservation of an existing output. The opt-in macOS check creates and signs a synthetic image, verifies its checksum/signature and reads image metadata without attaching it or launching a desktop/service:

```bash
NOOTIFY_TEST_NATIVE_DMG=1 node --test scripts/dmg.test.mjs
```
