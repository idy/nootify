# MyGo desktop architecture

Nootify's desktop shell uses Go with `github.com/egoist/mygo` pinned to `v0.8.3`. The TypeScript service, UI, agent adapters, Go provider core, and embedded Tailscale identity remain. No release is published as part of this migration.

## Layout and responsibilities

- `desktop/` becomes the Go desktop module (`github.com/idy/nootify/desktop`), alongside the existing offline HTML/CSS/JS/fonts. Go embeds those assets and serves its offline view from an application-owned loopback listener. MyGo uses the operating-system webview to display the existing service at `http://127.0.0.1:9417/` or that offline view.
- `desktop/main.go` and related Go files own MyGo windows, tray, single-instance activation, native menus, navigation restrictions, trusted document events, language preference, and service lifecycle. No generic privileged frontend bindings are exposed. Existing fixed `nootify://window/...`, `nootify://update/...`, `nootify://language/...` and offline service actions are validated and canceled by native policy.
- `desktop/internal/service` manages only the existing owned LaunchAgent/Windows task through checked bundled CLI calls and preserves independent daemon lifetime after desktop quit. It must preserve existing ownership, occupied-port, environment isolation, read-only-volume and process-replacement protections.
- `desktop/internal/updater` owns release checks, signature verification, progress/state events, and installation/relaunch. It stays independent of MyGo APIs so it can be tested and used by a signing CLI without starting native UI.
- `desktop/cmd/sign-update` signs release artifacts in Go. Keys come from environment or private files, never logs or command-line secret values. Existing updater public key and signature/manifests remain compatible with installed Nootify clients.
- `desktop/icons/` and `desktop/Entitlements.plist` replace the old source asset locations. The Node JIT entitlement must remain attached to the bundled Node runtime.
- `build/binaries/` holds target-suffixed development executables (`node`, `nootify-core`, `nootify-tsnet`). `build/resources/service/` holds staged compiled TypeScript, assets, production modules and license notices. Both are ignored local build products.
- `build/desktop/<target-triple>/` contains distribution output: macOS `macos/Nootify.app`, `macos/Nootify.app.tar.gz`, `dmg/*.dmg`; Windows `nsis/*-x64-setup.exe`. Keeping the logical bundle layout permits the existing release collector and upgrade smoke checks to migrate without changing artifact semantics.

The host does not require the MyGo bundler: a Node build script may compile the pinned MyGo Go module and create the platform bundle directly. JSON/native build metadata must keep version authority in the root `package.json`. No Cargo or Rust is required to build, test, stage, package, or generate notices.

## Installed layout and compatibility

Keep app identity `dev.idy.nootify`, app name Nootify, service port 9417, the existing private state directories, task/LaunchAgent identity, and existing routing/auth tokens.

On macOS, executables remain `Nootify.app/Contents/MacOS/{Nootify,node,nootify-core,nootify-tsnet}` and the Node service remains `Contents/Resources/service/dist/src/{server,cli}.js`. Existing LaunchAgents pin these paths and must continue to work. On Windows, `Nootify.exe`, `node.exe`, `nootify-core.exe`, `nootify-tsnet.exe`, and `service/` retain their installed relative locations. Upgrades stop the owned service before replacing files; uninstall removes only that installation's owned task. Do not kill processes by image name or overwrite another installation's task.

The release manifest remains `latest.json` with `version`, `notes`, `pub_date`, and per-platform `url`/`signature` entries. Preserve minisign verification and the existing embedded public key so installed Tauri versions can upgrade to the MyGo package. The Go updater must also consume the same signed artifacts. Existing signing environment variable names may remain compatibility inputs; they must no longer require a Tauri/Rust binary.

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
}
func New(options Options) *Manager
func (m *Manager) View() View
func (m *Manager) SetListener(func(View))
func (m *Manager) Check(context.Context) error
func (m *Manager) Install(context.Context) error
func (m *Manager) Run(context.Context)
```

`SetListener` publishes the existing `nootify-update` DOM event shape. Keep progress throttling, semantic phases, bounded check/download deadlines and clock-safe scheduled checks from the current updater. `BeforeInstall` runs only after signature verification and before replacement/installer launch. On Windows, launch the verified NSIS installer with compatible `/UPDATE /R` behavior and leave final lifecycle hooks responsible for stopping/restarting the owned service. On macOS, safely unpack, validate and replace this app with rollback protection. `AfterInstall` lets the desktop exit/relaunch after a successful handoff.

Signing CLI contract: `go -C desktop run ./cmd/sign-update --file <artifact>` writes `<artifact>.sig` in the existing Tauri-compatible minisign representation. Accept `NOOTIFY_SIGNING_PRIVATE_KEY` / `NOOTIFY_SIGNING_PRIVATE_KEY_PASSWORD` and existing `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as fallback compatibility inputs; public keys are not regenerated. No production key is needed for unit tests, which use generated synthetic fixtures.

Updater implementation may add pure-Go dependencies. The desktop-module owner manages `desktop/go.mod`/`go.sum`; communicate dependency requirements instead of concurrent edits.

## Verification

Preserve all existing service and agent tests. Add Go tests for URL policy, language persistence, service ownership/environment, single-instance/close semantics where testable, update signatures and safe replacement, and release compatibility. Build and test macOS/Windows in CI, including the existing Windows install/upgrade/uninstall checks. Verify the actual MyGo desktop app locally with a separate development identity/isolated service so the installed production app and its credentials stay untouched. Browser preview verification covers the unchanged web UI and any native bridge changes; native window/tray/updater smoke checks cover behavior that a browser cannot exercise.
