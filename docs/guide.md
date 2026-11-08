# Nootify guide

[Back to the project overview](../README.md). Commands and file paths in this guide are relative to the repository root.

Nootify runs a local **Node/TypeScript service host**, managed as a per-user macOS LaunchAgent or Windows Scheduled Task, and a private **Go notification core** (`native/core`, executable `nootify-core`). The core owns provider connections, notification-session mappings, message return routes, delivery records, and durable remote replay. Node starts it as a stdio child and retains the TypeScript UI, existing agent input adapters, local session discovery/backfill, GitHub tracking, and service/desktop integration; the Go/MyGo desktop host owns the native window, tray, menus, language preferences, service lifecycle, and updater. Production does not start `LarkPoller` or read Feishu message history on a schedule. Other TypeScript tools use the exported typed HTTP client, and additional service modules implement the same module interface.

There are two provider types, each supporting multiple named instances: **Feishu bot** (`feishu`) receives WebSocket events directly, and **Remote Nootify** (`remote`) connects to another node over authenticated gRPC. Providers expose agent sessions, metadata, deletion, sending, replying, and acknowledgments through a shared API. Platform groups and topics are provider details. See [Providers and remote nodes](#providers-and-remote-nodes) and the [core protocol](provider-protocol.md).

The HTTP listener binds to `127.0.0.1:9417`. Optional Tailscale access, enabled under **设置 · Tailscale**, exposes the Nootify node's Tailscale address on port 80 for the owner's other devices. Open either address for message-bridge logs, **encountered routing targets**, and the two GitHub pull-request queues. `/health` and the read-only `/ui/*` page data are available to permitted browsers; every `/v1/` control endpoint requires the per-user bearer token on both listeners. Host/origin checks prevent cross-site reads and DNS rebinding. The service routes input to existing Claude, Codex, or OpenCode clients and provides per-conversation notifications and cooperative reply inboxes for Trae and WorkBuddy. It does not call a model API directly.

Routing lookup is lazy: only a message with a concrete adapter and session ID resolves that adapter's inbox or connects to its backend. The routing page retains the latest 1,000 encountered targets in SQLite across service restarts, including missing/archived/unavailable results; previously active targets show as unconfirmed until checked again. PR subscription discovery separately reads session identities, explicit PR links, repository anchors, branches, and timestamps.

## Project website

The public landing page is prepared for [nootify.idy.dev](https://nootify.idy.dev/). Its static files live in `site/`, separate from the service dashboard in `public/`. The website has no access to the local service, account data, or credentials.

English/Chinese follows the browser by default; light/dark appearance follows the system. Header controls persist explicit choices when storage is available. The common idy.dev shell and locally hosted fonts with their licenses live in `site/shared/` and should stay identical to the other idy.dev sites. Montserrat is used for headings, Monda for body text, Lato for notes, and Phosphor for icons; Manrope remains a fallback. The penguin mark comes from `desktop/brand.svg`.

The latest stable GitHub Release supplies the installer URL, filename, size, and version. Windows visitors receive the x64 NSIS installer; other visitors receive the Apple Silicon DMG, with the other platform also linked explicitly. Preview-only repositories fall back to the newest published prerelease. Missing installers, rate limits, and network failures leave usable release-page links without claiming a fixed latest version. No API token is used.

Preview and test from the repository root:

```bash
python3 -m http.server 4173 --directory site
```

```bash
node --test test/website.test.cjs
```

The website workflow validates relevant pull requests and deploys `site/` only after a change reaches `main` (or a manual dispatch on `main`). First-time setup requires enabling GitHub Pages with GitHub Actions as the source, reserving the custom domain `nootify.idy.dev` in Pages, and adding a DNS CNAME from `nootify.idy.dev` to `idy.github.io`. After DNS and certificate issuance, enable HTTPS enforcement. The checked-in CNAME and workflow do not perform those account/DNS operations. Enable Pages before merging the first website PR so the deployment job can run. The idy.dev homepage links to this domain and should be published once the site is reachable.

## Build and test

Requires Node.js 22.13+, npm, and the Go versions pinned in `native/core/go.mod` and `native/tailscale/go.mod`. Node's local adapter/settings database and Codex metadata lookup use the built-in `node:sqlite`; the Go provider core uses its own private JSON store. From the repository root:

```bash
npm ci
npm run core:build
npm run check
npm test
npm run core:test
```

`core:build` builds the local `nootify-core` executable without connecting to a provider; `core:test` runs `go -C native/core test ./...`. `NOOTIFY_CORE_BIN` can select a development/test executable. The service looks beside its Node runtime first, then in the target-specific `build/binaries/` development location. Run `npm run build` to compile the Node service before using the `dist/src/` commands below.

`npm test` discovers test files without relying on shell glob expansion, sets a three-minute default test timeout, and writes `.cache/test-results.xml` in JUnit format. Windows runs test files serially to keep full-sync SQLite fixtures and native compiler children within the hosted runner's disk and CPU budget; concurrency inside individual tests is unchanged. CI uploads that report for each platform and limits the test step to ten minutes as a separate guard against cleanup hooks that never finish. SQLite fixtures close databases and backend sockets before temporary-directory removal; bounded subprocess regressions cover Windows file locks and failed cleanup.

### Headless integration tests

```bash
npm run test:integration
```

This command builds only the notification core and a test-binary upstream fixture, then runs two real TypeScript HTTP services with their real Go cores and the production CLI. The upstream mocks only the external bot boundary; routing, authenticated gRPC, session operations, stdio delivery completion, SQLite inboxes, acknowledgements and replies use production code.

Coverage includes independent broadcast to two downstream nodes, local ownership, source-event deduplication, full-reference reply return paths, metadata, process-restart replay, notification-session deletion, and EOF shutdown. The suite uses the cooperative Trae inbox transport and does not start an agent client.

No desktop window, tray, installer, browser, system background service, Feishu connection, or Tailscale enrollment is started. State and binaries live in a fresh private temporary directory; listeners use ephemeral numeric loopback ports. Runtime children receive a restricted environment, credentials are synthetic, and the runner removes owned processes/state on completion. Results are written to `.cache/headless-integration.xml`. CI runs an independent Ubuntu headless job and the same process suite on macOS/Windows before installer tests. Native GUI smoke remains a separate disposable-runner check.

## MyGo desktop application and system tray

The native **Nootify** app supports Apple Silicon with macOS 13.5+, and Windows 10/11 x64. Both distributions bundle the background service, their own Node.js runtime, the Go `nootify-core` executable, and an independent Tailscale client built with tsnet. Its native window, web UI, and offline page follow the system's light or dark appearance, including changes while the app is open. It provides a menu-bar tray with **打开**, **退出**, service controls, and update controls. PR rows open GitHub in the default browser. Closing the window hides it; quitting the desktop app leaves the independent daemon running.

Download an installer from [GitHub Releases](https://github.com/idy/nootify/releases/latest): on macOS, drag Nootify from the DMG to **Applications**; on Windows, run the x64 `-setup.exe` installer, which installs for the current user under `%LOCALAPPDATA%\Nootify` without administrator access. Windows uses the WebView2 runtime (the installer offers to install it if missing). The first launch automatically installs and starts the background service; later launches connect to it or start the existing platform job if needed. A healthy service keeps its process and connection. The compact native macOS tray menu shows Open, connection status, Background Service, Software Updates, Settings, and Quit. Module status and start/restart/install recovery controls live under Background Service; they are recovery actions, not setup steps. The menu uses the system material and follows the macOS appearance.

The desktop app is single-instance. Opening it again restores and focuses the existing window, including when minimized or closed to the tray, without restarting the background service.

Automatic installation requires port 9417 to be free. On macOS, `~/Library/LaunchAgents/dev.idy.nootify.service.plist` must be absent; read-only disk images are refused, so keep the app in Applications. On Windows, a login-triggered task named `Nootify.Service.<user-SID>` runs without elevation for the current user. It owns a hidden Node process and its Tailscale helper in a Windows Job Object, so stopping the task closes the complete service process tree. Existing jobs are reused; an unrelated task or another installation's task is never overwritten. Keep the application at its installed path.

Windows stop and replacement wait for the owned job's kernel process count to reach zero. The existing task host listens for Windows session-end notifications through a hidden window and attempts a bounded drain, publishing completion only after its job is empty; that receipt also permits recovery when local sign-out retains the terminal ID. A private receipt certifies that exact run after its job name disappears. Recovery also accepts a recorded change in the Windows boot sequence or explicit Windows confirmation that the original interactive terminal session no longer exists. All job members share that session, so completed sign-out permits the next sign-in to recover within the same boot. A missing job name, an empty Scheduler instance list, or a different logon token alone cannot certify shutdown. Present or reused session IDs, session zero, denied queries, and unavailable session information remain unverified. Hibernate preserves the session; Fast Startup may retain the boot sequence but can still recover through verified session deletion. If an abrupt host exit remains unverified, sign out and back in or choose Windows **Restart**; reopen Nootify or run `service-start` if an explicit Stop disabled the task. For legacy or unreadable identity metadata, restart Windows before deliberately removing or repairing only `windows-runtime.json` in the private state directory; retain `provider-core/`, `state.sqlite`, `auth-token`, and the other settings.

When `~/.claude.json` exists, the installer selects its `mcpServers.lark` credentials as a legacy migration source. The core imports available credentials and eligible group bindings once into the `legacy-feishu` provider; it does not overwrite a later provider edit or deletion. The original file stays intact. Without a provider, the PR pages remain available; add a connection on **Providers**. The MyGo webview disables generic privileged frontend bindings. Validated fixed navigation requests support the title row and the update bridge described under [Automatic updates](#automatic-updates-and-releases). Builds are ad-hoc signed and are not notarized; macOS may require allowing the first launch under System Settings > Privacy & Security.

### Build the desktop app

Requires the Go versions pinned in `desktop/go.mod`, `native/core/go.mod`, and `native/tailscale/go.mod`, plus Node.js and the npm dependencies above. The native host pins [MyGo v0.8.3](https://github.com/egoist/mygo/tree/v0.8.3) and builds with `CGO_ENABLED=0`. Rust, Cargo, and the Tauri CLI are not build dependencies. macOS packaging uses the system signing and disk-image tools. Windows packaging uses a pinned, verified NSIS compiler; the installed application uses the system WebView2 runtime. Build each installer on its target OS.

```bash
npm run desktop:dev
```

For a signed release build, supply `NOOTIFY_SIGNING_PRIVATE_KEY` and `NOOTIFY_SIGNING_PRIVATE_KEY_PASSWORD` in the environment, then run the command below. The existing `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` remain fallback inputs so CI can preserve its existing signing identity; signing is implemented in Go.

```bash
npm run desktop:build
```

Before bundling, the build compiles TypeScript and stages the service, `public/`, and production dependencies in `build/resources/service/`. It downloads a pinned official Node.js runtime, checks its SHA-256 against both the pinned value and the release's `SHASUMS256.txt`, and stages target-specific binaries under `build/binaries/`. It also builds `nootify-core` and `nootify-tsnet` with pinned Go dependencies, checks binary versions and system-library links, and includes dependency licenses in the service resources. The desktop host embeds the existing offline HTML/CSS/JS/fonts and uses MyGo's system webview. Installed runtime and service paths remain compatible with existing LaunchAgents and Windows tasks. Staging writes `third-party-notices.txt` from Go modules and production npm packages without Cargo. `npm run desktop:stage` performs staging; `npm run desktop:test` runs the desktop Go module tests. The Node runtime retains its JIT entitlement from `desktop/Entitlements.plist`.

Outputs under `build/desktop/<target-triple>/` are `macos/Nootify.app`, the Apple Silicon DMG in `dmg/`, and `macos/Nootify.app.tar.gz` with its updater signature on macOS; Windows produces an NSIS `*-x64-setup.exe` installer in `nsis/`, with an updater signature. `--target` selects the supported target triple. `--package-version <semver>` overrides the packaged version for isolated installer fixtures; production version authority remains the root `package.json`.

### Automatic updates and releases

The installed app checks [the signed release manifest](https://github.com/idy/nootify/releases/latest/download/latest.json) 15–45 seconds after launch, then every six hours with ±30 minutes of independently sampled jitter. Failed checks retry after 10–20 minutes, and deadlines include time spent asleep. Development builds check only on request. Select **检查更新** under the tray's **软件更新** submenu or **设置 · 关于** for an immediate check. When a newer version exists, **安装更新 vX.Y.Z** appears directly in the tray's top-level menu; every page also shows a compact **更新 vX.Y.Z** button in the title row. Routine checks and an up-to-date result leave the title row clear; About retains the latest status and manual check action. Downloading starts only when installation is selected. Installation verifies the update signature and replaces the app. On macOS, it restarts the background service if its LaunchAgent runs this app's Node.js, then relaunches the app. On Windows, the NSIS hook stops only this installation's task and waits for Node and its helpers to exit before replacing files; the updater relaunches the installed app, which starts the preserved task. A normal Windows uninstall removes the task while retaining private settings. One fixed-width title-row button stays in place throughout the update: **更新 vX.Y.Z** becomes **下载中 42%**, then **安装中…** and **重启中…**; the tray's top-level install action also shows progress in place and stays disabled while busy. There is no second line or separate progress bar. Unknown-size downloads show **下载中…**; interrupted downloads retain the update and its retry action. A failed background recheck also preserves an already found update. Clicking the title-row status or the tray's **更新详情…** opens **设置 · 关于** for full version, download size, and error details; the tray keeps failures concise.

For a native smoke run against an isolated worktree service, set `NOOTIFY_SMOKE_UI_URL` to its `http://127.0.0.1:<port>/` origin and launch the development binary with `--smoke-test`. Service and update workers are disabled in this mode. Development uses a separate application identity so the installed production app remains available. Verify native window and tray behavior with the actual MyGo application; the browser alone cannot prove native dragging, single-instance activation, close-to-tray, or installer handoff. Both the live service page and embedded offline page retain the fixed titlebar, update, and language bridges.

The update worker runs in Go under `desktop/internal/updater`, independently of the native UI thread. It pushes its state into the page as a `nootify-update` DOM event, replayed on every page load, and the page asks for a check or an install by navigating to `nootify://update/check` or `nootify://update/install`, which the window's navigation policy cancels. These are the only update requests; the page still has no IPC. A native initialization script also handles dragging and double-clicking empty title-row areas through the fixed `nootify://window/drag` and `nootify://window/zoom` requests, leaving buttons and links clickable. A plain browser receives neither the script nor update events, so it keeps its ordinary layout and **设置 · 关于** shows only the service version there.

CI runs TypeScript tests, resource staging, Go formatting/static checks, and Go tests for `desktop`, `native/core`, and `native/tailscale` on macOS and Windows. It builds the actual MyGo bundles. Windows additionally exercises named-pipe messaging, task ownership, process-tree shutdown, and private Tailscale state access. Its synthetic `0.0.0` baseline installer comes from the same sources using a package-version override. The runner silently installs it in a path with spaces, launches the installed desktop and daemon, checks single-instance and independent-service behavior, then upgrades to the current package with `/UPDATE /R`. Tests verify task/data retention, service restart, uninstall cleanup, and reinstallation. Artifacts contain the unsigned installer and allowlisted diagnostics, excluding tokens/settings. These disposable-runner checks do not cover SmartScreen, interactive installer clicks, or production signing credentials. To publish a release, update the root `package.json`, commit to `main`, then push a matching `vX.Y.Z` tag. The workflow rejects a mismatched tag. Platform builds produce macOS DMG/updater and Windows NSIS artifacts. Existing updater signing secrets remain compatible inputs for the Go signer, and the public key/signature format is preserved for installed clients. One finalization job validates both platforms and publishes all assets with one `latest.json`; publication is serialized and compares stable semantic versions before changing GitHub's latest designation. An unavailable or unrecognized latest-release response stops promotion. Windows installers are updater-signed but not Authenticode code-signed. A manually dispatched release must select a version tag.

## Install from a source checkout

The packaged app installs its service automatically. For a checkout-based installation instead:

```bash
node dist/src/cli.js launchd-install --mcp-config ~/.claude.json
```

On macOS, this creates `~/Library/LaunchAgents/dev.idy.nootify.service.plist` and loads it into the current user's GUI launchd domain. On either supported OS, the platform-neutral install command is:

```bash
node dist/src/cli.js service-install
```

Add `--mcp-config` with the explicit path to your `.claude.json` if needed. Windows installs `Nootify.Service.<user-SID>` using the current user's interactive logon token; it runs at login and restarts after failure without administrator access. `service-status`, `service-start`, `service-restart`, `service-stop`, and `service-uninstall` control only the owned Windows task. Running-instance discovery explicitly includes hidden tasks and matches the exact current-user task path; query failures remain errors. Stopping disables the Windows task and waits for its complete owned job to exit; `service-start` or reopening the desktop app re-enables it. `service-uninstall` leaves private settings intact. Use the launchctl commands below to control a macOS job. The checkout and its Node runtime must remain at their installed paths.

Configure named instances on **Providers**. The old single-bot credential sources remain available for migration and compatibility: `LARK_APP_ID`/`LARK_APP_SECRET` for a direct launch, saved legacy Feishu settings, then an explicitly selected `mcpServers.lark` MCP configuration. A launchd job does not inherit your interactive shell environment. Once imported, the provider's saved configuration is authoritative; changing an old credential source does not overwrite it on every startup. Other modules remain available without an enabled provider.

The default private state directory is `~/.local/state/nootify/` on macOS/Linux, or `%LOCALAPPDATA%\Nootify\state` on Windows. The Go core's authoritative state is **`provider-core/state.json`**: its stable node UUID, provider credentials and default, listener configuration/token, session mappings and deletion tombstones, message references/return routes, delivery outcomes, deduplication records, and independent peer queues/confirmations. A private lock prevents two cores from sharing the directory. Each update writes a `0600` temporary JSON file, syncs it, atomically replaces `state.json`, and syncs the directory on Unix before acknowledging the write. The directory uses `0700` on Unix. Bounded ledgers reject new admissions when full instead of evicting pending or uncertain work.

Node retains **`state.sqlite`** for local adapter registrations, routing observations, backends, cooperative inboxes, GitHub credentials, settings, and legacy data. Its incremental transactional saves use WAL and full synchronous commits; connections close after each operation, including one-shot installers. On Unix, the directory is mode `0700` and database/journal files use `0600`. Windows service installation and startup repair protected DACLs throughout the existing state tree, including files with explicit or protected permissive grants, to allow only the current user and SYSTEM. Redirected entries are rejected instead of traversed. The independent Tailscale client also applies protected DACLs and exclusive file locking.

Two separate one-time migrations preserve older installations. Node can first import the old root-level version-one `state.json` into SQLite, including unread inbox items and legacy receipts/cursors. Schema creation, rows, and its migration marker commit together; failure rolls back and leaves the source unchanged. SQLite migration 3 preserves the latest 1,000 routing observations; these are historical results and previously active sessions show as unconfirmed after restart. SQLite remains authoritative for Node state and never reimports a stale root-level backup after successful initialization. Independently, the Go core imports available legacy bot credentials and matching-app group bindings into `legacy-feishu`, preserves existing chat IDs and agent session IDs, and associates them with its stable node ID. An import marker and provider tombstones prevent a later startup from undoing edits or deletions. No credentials means no core import. Retained history cursors do not enable production message polling or promise recovery of messages missed during a platform WebSocket outage.

The service reserves its loopback listener before opening Node state; an occupied-port startup cannot initialize that migration. The source installer validates ownership and waits for the legacy process to finish its final writes and exit before starting the replacement. Keep both stores and the other private files when upgrading; a configuration export is not a conversation-state backup. A newer or corrupt store is reported rather than silently replaced from an old backup.

The separate `auth-token` file and its value are retained, so existing CLI clients continue to authenticate. Configuration exports, logs, directory caches, PR caches, and the independent Tailscale device keep their existing files and formats. Session inbox tokens must be registered with the independent daemon; they are stored only in private state, never in the repository, group messages, or logs. HTTP responses list public session information without socket credentials.

```bash
node dist/src/cli.js health
```

```bash
launchctl print gui/$(id -u)/dev.idy.nootify.service
```

To stop the installed job:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.idy.nootify.service.plist
```

## Register the current session

Run this from the target Claude session so the real `CLAUDE_CODE_MESSAGING_SOCKET` and optional `CLAUDE_CODE_MESSAGING_TOKEN` are available:

```bash
node dist/src/cli.js register --session-id local_example --session-name "My session"
```

Registration saves optional inbox credentials for use when the live runtime's socket matches. It does not trigger discovery or add an entry to the routing-history view. When a Claude message arrives, the resolver opens only the named Desktop session record and matches it against the small running-process registry. The full `local_...` ID is matched to `hostSessionId` and `cliSessionId`; unrelated session files are not opened. Archived, missing, offline, and unverifiable sessions are ignored, and stale saved socket paths are never used as a fallback.

For that targeted lookup, Desktop account/profile directories are located under `~/Library/Application Support/Claude-3p/claude-code-sessions` and `Claude/claude-code-sessions` on macOS, or `%APPDATA%\Claude-3p\claude-code-sessions` and `%APPDATA%\Claude\claude-code-sessions` on Windows. Runtime records come from `~/.claude/sessions` (honoring `CLAUDE_CONFIG_DIR`); Windows inboxes use the client's existing named pipe rather than Unix socket filesystem metadata. Before sending authentication or message frames, a native helper checks the connected pipe server's PID against the selected live runtime record and its process-token user SID against the current user. It retains that connection and process handle through the write and uses identification-only impersonation; a missing identity or mismatch fails closed. These local formats may change in later releases. An unverifiable archive field produces `archive_unknown`. Live CLI sessions have no Desktop archive record; inactive CLI sessions are ignored.

## Agent input transports

Each adapter resolves only the incoming ID:

| Adapter | Lookup and archive check | Input transport |
| --- | --- | --- |
| `claude-desktop`, `claude-code` | Targeted local record and live runtime lookup | Existing inbox socket |
| `codex` | Read-only indexed `WHERE id = ?` query in the latest `state_*.sqlite` under `CODEX_HOME` (default `~/.codex`); then resolve that ID through the configured app-server or the existing macOS Desktop owner | Configured app-server WebSocket, or Desktop's local IPC router when no backend URL is configured; accepted input is confirmed by its turn receipt |
| `opencode` | `GET /session/:id` through the official SDK; check `time.archived` | `POST /session/:id/prompt_async` |
| `trae`, `workbuddy` | Explicitly registered Nootify conversation ID; native availability/archive state is unknown | Private inbox read by that conversation's `thread-receive`; no automatic wake-up |

Codex never calls `thread/list`, `thread/start`, `thread/resume`, or `thread/unarchive`. A thread not loaded in the selected client is logged as offline. OpenCode never calls its session-list API or creates a session. `input_accepted` means the client accepted the input, not that generation completed. Interactive approval requests are not approved by the bridge.

On macOS, Codex Desktop needs no manual backend address. When no explicit Codex backend is configured, Nootify connects to `CODEX_HOME/ipc/ipc.sock`, verifies its OS-user ownership, discovers the owner of the requested thread and requires an already-resumed conversation. It forwards input through Desktop's versioned local IPC protocol, keeping the original app-server and native tools. The owner first attempts to steer its current turn; only its exact, pre-submission inactive-turn rejection permits starting a new turn. Timeouts, disconnects and invalid input receipts never trigger another submission. The adapter was checked against Codex Desktop's bundled CLI `0.166.0-alpha.5.1`; this IPC is private and can change between Desktop versions. Unsupported method versions fail without submitting input. Windows and standalone clients can use an existing app-server WebSocket.

To select an **existing** local backend explicitly, set its address once, not one configuration per session:

```bash
node dist/src/cli.js backend-set --adapter codex --url ws://127.0.0.1:4500
```

```bash
node dist/src/cli.js backend-set --adapter opencode --url http://127.0.0.1:4096
```

The Codex port above is an example, not an automatically discovered Desktop endpoint. The app-server must own the target live thread and use the corresponding local `CODEX_HOME`. This tool does not start another Codex process to take over its history. OpenCode defaults to its documented `127.0.0.1:4096` address if none is configured. Add `--directory` when its server needs a project directory.

The CLI reads optional `CODEX_APP_SERVER_TOKEN` or `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` from its environment and stores them privately with the backend configuration. Direct daemon launches can also use `CODEX_APP_SERVER_URL` / `OPENCODE_SERVER_URL`; launchd does not inherit your shell environment, so use `backend-set` for an installed service. Endpoints are limited to loopback addresses and cannot be supplied by announcement text. No available local session or backend means an explicit ignore reason, never a fallback to Claude.

## Providers and remote nodes

Open **Providers** under **Message bridge** to manage the card list of configured instances. The upper-left **Add** button opens a dialog listing the available provider types; choose a type to continue to its configuration form. Editing a card opens the same dialog with its saved configuration. Each instance has its own ID, name, configuration, connection status, enable/disable control, default selection, and delete action. There are exactly two types:

| Type | Configuration | Role |
| --- | --- | --- |
| Feishu bot (`feishu`) | App ID, App Secret, trusted recipient `open_id` | Receives Feishu WebSocket events and manages notification groups/messages |
| Remote Nootify (`remote`) | Server `host:port`, token, TLS switch, optional TLS server name | Calls another node's notification API and subscribes to its unmatched incoming events over gRPC |

Multiple instances of either type can be enabled together. The editor's Feishu recipient is a manual `open_id` field; it identifies the user invited to newly created groups and the trusted sender admitted by that provider. Existing secrets/tokens stay masked and a blank secret field preserves the saved value. Ordinary summaries show only whether a secret is set. A provider's type cannot be changed in place. Deleting a provider closes that instance; it does not delete an agent's original conversation or automatically move existing notification sessions to another provider.

An **Agent Session** has `{node_id, adapter, session_id, name?, metadata?}`. The core generates a stable node UUID and the bridge supplies it for local sessions. Routing uses the full identity, so equal session IDs on different nodes/adapters are distinct. `Ensure` (`session.ensure`) reuses the existing provider binding; a new session uses an explicit `--provider-id` or the default provider. Changing the default does not move existing sessions. A conflicting provider selection fails instead of silently rebinding. Metadata get/set and `DeleteSession` (`session.delete`) follow that same binding, including across remote nodes. Deletion removes notification resources and mappings, retains a tombstone against replay, and never deletes the native agent conversation. An explicit ensure retries unfinished cleanup before reactivating a deleted notification session. A disabled provider must be made available for cleanup; if the old provider has been removed, an explicit ensure/bind can select a replacement. Retired resource identities remain suppressed so late events from an abandoned destination cannot reach the reactivated session.

Configure an upstream server under **Settings → Remote access** (`远程接入`). This page controls this node's gRPC listener; a Remote Nootify provider controls an outgoing connection to another node. The listener is disabled by default and uses `127.0.0.1:9418` by default. The page offers enabled/listen controls, a generated or supplied token with an explicit local reveal action, TLS certificate/key file paths, and downstream peer rows showing node ID/name, connection time, pending count, and last acknowledgment. The certificate and key must both be readable by the service. Non-loopback listeners require TLS; plaintext listeners must use a numeric loopback address. Remote clients authenticate with the listener token, separately from the local HTTP control token. TLS clients verify the server against system trust and use the configured server name, or the address hostname if omitted.

For example, node A can own a Feishu bot while B and C each configure a Remote Nootify provider pointing to A. Each keeps its own session identity when requesting a notification destination through A. When a reply arrives, A delivers a locally owned session locally; otherwise it independently offers the unmatched event to every subscribed downstream. B can handle its own session while C retains and confirms its separate copy. A peer's acknowledgment never consumes another peer's event. A locally owned session that is missing, archived, offline, rejected, or fails delivery remains local; it is not reclassified as unmatched and broadcast elsewhere.

Each admitted event and per-peer pending queue is durable before confirmation. Previously subscribed disconnected peers retain their own pending events and replay them after reconnecting with the same node identity. Stable event IDs, full origin message references, visited-node information, and a hop limit suppress duplicate execution across multiple upstream routes and loops. Multiple feeds from the same Feishu app use the source app/message identity for deduplication. Each peer has a bounded delivery window and a durable cursor into the shared event ledger. When one peer fills its window, healthy peers continue receiving; the slow peer refills from its backlog as it confirms events, including after restart. Global ledger exhaustion rejects new admission rather than discarding admitted events. Ingestion confirmation, downstream confirmation, agent transport acceptance, and explicit session acknowledgment are separate stages. Restarting with an uncertain local agent submission records it as unconfirmed and does not automatically submit it again. Remote replay applies to events already admitted to Nootify; there is no implemented message-history backfill guarantee for a Feishu WebSocket outage.

Session operations and outgoing sends/replies are directed along their provider binding or stored return route. They are not broadcast commands. The embedded Tailscale helper can provide private TCP tunnels and publish the gRPC listener independently of its existing port-80 browser proxy; see [Tailscale access](#tailscale-access).

## Bind a Feishu group

Use `thread-open` to ensure the provider's notification destination instead of creating platform routing declarations by hand:

```bash
node dist/src/cli.js thread-open --agent claude --session-name "My session" --provider-id feishu-work
```

The Go Feishu provider creates a private group, invites its configured recipient, and stores the full Agent Session identity in provider metadata. New groups carry `nootify-session:v1:<base64url-session-json>` in their description; migrated bindings retain their existing group IDs. These identifiers contain no local inbox socket credentials. Agent adapters are `claude-desktop`, `claude-code`, `codex`, `opencode`, `trae`, and `workbuddy`. `--agent claude` detects the appropriate Claude adapter and complete session ID.

For direct Feishu setup, enable the bot capability, configure **long connection / WebSocket** event delivery, subscribe to the message-receive event (`im.message.receive_v1`), and publish the application's permissions. Ordinary group replies require the applicable group-message permission, such as `im:message.group_msg`; mention-only access does not cover every group reply. Group creation needs `im:chat:create` or `im:chat`, reading group metadata needs `im:chat:readonly`, updating group metadata needs the relevant chat update permission, and progress/replies need `im:message:send_as_bot`. Session deletion also requires permission to dissolve the group. Explicit acknowledgments require `im:message.reactions:write_only` or `im:message`. Nootify does not grant permissions or change the client's inbound controls. Production receives events through the Go SDK's WebSocket client; message-history read scopes do not turn on a fallback poller.

Legacy `lark-*` command names and old settings remain compatibility surfaces for existing installations. In particular, `lark-ack` and `lark-reply` can resolve a retained plain Feishu message ID when it is unambiguous. New integrations should use provider-aware session operations and full message references. The old hostname-based `agent-session:v1:…` announcement workflow is migration input, not the identity format of newly created core sessions.

### Replying to the original message

The core accepts content as `{text?: string, blocks?: ContentBlock[]}`. Supported block types include paragraph, text, link, and code, with nested children. Feishu text/posts are converted to this format; unsupported message types or post elements are rejected as a whole instead of silently losing content. Remote relays preserve structured content, while existing local agent adapters receive a text representation.

A message reference is `{origin_node_id, provider_id, message_id}`. Its origin and provider ID survive every relay unchanged. Forwarded input includes shell-quoted callback commands using an opaque base64url `--message-ref`; use that exact value so acknowledgments and replies follow the original return path:

```bash
node dist/src/cli.js message-ack --message-ref <reference-from-forwarded-message>
```

```bash
node dist/src/cli.js message-reply --message-ref <reference-from-forwarded-message> --text "I am here; I will follow up shortly."
```

For multiline replies use `--text-file <path>` or `--text-file -` to read stdin. The forwarded commands include the actual CLI path, private state directory, and service port so they work from another project. Credentials remain local and are not put in the prompt. User message text is not inserted into callback shell arguments. A bare `--message-id` through the legacy commands fails if multiple provider references match it.

An explicit session acknowledgment adds a `FINGERHEART` reaction to the source Feishu message through its return route, without sending a chat message. Agent delivery completion alone is not that callback. The core persists acknowledgment state; a reaction failure does not cause another agent submission. Sending/replying supports `request_id` deduplication in the API: reuse the same ID for the same operation, and never blindly retry an uncertain send with a new ID. By default the local reply endpoint derives a stable ID from the source reference and reply content, so an identical callback reply is deduplicated across retries/restarts. Progress sends without an explicit request ID retain a durable attempt identity while an identical send is pending, retryable, or unconfirmed. A retry cannot duplicate an uncertain submission, including after a restart. After a confirmed success, sending the same text again is a new operation. `thread-send --request-id <id>` lets callers explicitly reuse one attempt across retries. Remote RPCs have a 45-second timeout inside the core's 60-second command deadline; the stdio bridge waits 65 seconds and the HTTP client waits 75 seconds for the terminal response.

Delivery outcomes distinguish `socket_written`/`input_accepted` (**waiting for a session receipt**), cooperative `inbox_queued`, rejected/retryable/unconfirmed completion, and an explicit `session_acknowledged` callback. A downstream's durable confirmation is not a read receipt. Socket writes do not prove that the model admitted or processed the message; verify it in the original session for an end-to-end test. Peer messages cannot approve permission requests.

**Independent-daemon admission:** a launchd process is not a child of the target Claude session. Supplying the session token does not override an explicit process-ancestry verdict on macOS. Claude's inbound policy can therefore hold or refuse messages even after `socket_written`; this particularly affects sessions running with bypass permissions. Unattended delivery requires an inbound policy that explicitly accepts this source, such as an owner-configured `crossSessionInbound: "accept"` in an appropriate settings scope. This service never changes that setting or asserts a sender permission mode. The same policy limitation applies to messages sent through the generic TypeScript client.

## Agents and notification channels

The **Agents** page lists Claude Code (`~/.claude/CLAUDE.md`, honoring `CLAUDE_CONFIG_DIR`), Codex (`~/.codex/AGENTS.md`, honoring `CODEX_HOME`), OpenCode (`~/.config/opencode/AGENTS.md`, honoring `XDG_CONFIG_HOME`), Trae, and WorkBuddy. Trae manages both `~/.trae/user_rules/nootify.md` and `~/.trae-cn/user_rules/nootify.md` together, so either edition can be installed before or after enabling notifications. The Agents page shows both paths and reports partial/outdated configuration when only one is current. `NOOTIFY_TRAE_RULES_FILE` explicitly selects a single target instead. Newly created Trae files include `alwaysApply: true` frontmatter, which remains when the managed instructions are removed. WorkBuddy uses its documented CodeBuddy-compatible global instructions at `~/.codebuddy/CODEBUDDY.md`; `NOOTIFY_WORKBUDDY_RULES_FILE` overrides that path. These two overrides configure Nootify, not the agents themselves. See the official [Trae rules](https://docs.trae.ai/ide/rules), [Trae China rules](https://docs.trae.cn/ide_rules), and [WorkBuddy project configuration](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project) with its linked [directory reference](https://www.workbuddy.cn/docs/cli/codebuddy-dir).

Ticking an agent creates its configuration directory and prompt file if necessary, then appends provider-aware notification instructions between `<!-- nootify:begin -->` and `<!-- nootify:end -->`; unticking removes that section. A missing directory is shown as unconfigured, rather than used to infer whether the agent is installed. Nothing outside the markers changes, symlinked prompt files are edited at their target, the previous file is copied to `agent-backups/` in the state directory (last ten per agent), and files with unbalanced markers are left alone. "Needs update" means the block differs from what this installation would write, for example after the app moved. Prompts can only be changed from this computer; over Tailscale the page is read-only.

The section tells new conversations to use two commands, which find the calling session from the variables each client sets (`CLAUDE_CODE_HOST_SESSION_ID` for Claude Desktop, `CLAUDE_CODE_SESSION_ID` for the Claude Code CLI, `CODEX_THREAD_ID` for Codex). OpenCode does not export its session ID, so its section asks for `--session-id ses_…`.

Trae and WorkBuddy use a cooperative inbox because a supported API for injecting input into a selected existing desktop conversation has not been verified. Start a new conversation after enabling their rules. Run `thread-open --agent trae` or `thread-open --agent workbuddy` with `--session-name` once; Nootify allocates a unique conversation ID and registers its private inbox. Keep the returned `session_id` in that conversation and supply it explicitly on every later `thread-send`, `thread-receive`, and `thread-ack`. Retries of `thread-open` must reuse that ID; failures include it in the error text. IDs are never inferred from the project directory or another agent's environment. At milestones, before asking a question, and before finishing, the instructions ask the agent to run `thread-receive`, process the returned `message.text` using its original-channel receipt/reply commands, then run `thread-ack --message-id <message.id>` for each processed item. Reading does not consume messages, and pending messages survive daemon restarts in private state. Inbox mutations, persistence, and rollback share the state write queue, so a failed acknowledgment cannot be persisted by an overlapping save. Provider messages retain the forwarded full message reference and callback instructions in the inbox text, with their return route held by the core. Legacy inbox items with a Feishu source context retain that context independently of the old bounded history ledger; consuming the item releases that retention. Legacy source callbacks are regenerated on each read with the current service port and bundled CLI paths. Inboxes are limited to 100 pending messages per conversation and 1,000 overall; reads return at most 20 messages and 64,000 bytes. A full inbox rejects new delivery without dropping older input. A queued message is logged as waiting for the conversation to check, never as accepted native input. **This cannot wake an idle or closed conversation**, and it cannot verify the client's native archive state. No native agent session is created or resumed.

```bash
node dist/src/cli.js thread-open --agent claude --session-name "Fix login"
```

```bash
node dist/src/cli.js thread-send --agent claude --text "Tests pass; opening the PR next"
```

`thread-open` ensures the Agent Session's provider binding and reuses it on later calls. A new session uses the default provider unless `--provider-id <id>` is supplied; `thread-send` posts to that binding and accepts the same selector. Use `--text-file -` for multiline text. A remote provider forwards these operations to its upstream without replacing the originating node/session identity. Feishu group names and metadata are managed by the core, so new workflows do not depend on the legacy announcement/name format.

```bash
node dist/src/cli.js thread-open --agent claude --session-name "Fix login" --provider-id work-remote
node dist/src/cli.js thread-send --agent claude --provider-id work-remote --text "Tests pass"
node dist/src/cli.js thread-delete --agent claude --provider-id work-remote
```

`thread-delete` deletes the notification session through its provider, including a remote binding, and preserves a tombstone against replay. It does not delete the original conversation. Repeating deletion is safe; explicitly opening again can reactivate it once resource deletion completes.

The **Node local discovery loop** scans existing conversations at startup and once a minute and backfills missing notification destinations for agents enabled on the Agents page. It uses provider-aware ensure operations and the default provider. This scans local session metadata; it does not poll Feishu messages or copy transcripts. Manual commands continue to work independently of the automatic scan.

Claude Desktop and Codex require an explicitly non-archived metadata record; archived OpenCode sessions are skipped too. Standalone Claude CLI identities come from transcript filenames without reading conversation contents; legacy `agent-*.jsonl` sidechains and nested subagent transcripts are excluded. Trae and WorkBuddy use only their explicitly registered Nootify IDs. Disabled agents are not automatically enrolled. Failed or incomplete Desktop catalogs defer CLI enrollment until their identity maps can be recovered, while verified Desktop records remain eligible. Genuinely absent installations are allowed; non-directory ancestors and broken redirects are treated as incomplete catalogs. Account/profile symlinks and junctions skipped by delivery discovery also mark the catalog incomplete.

Scanning never starts or resumes a native session and does not synchronize its transcript. Delivery still requires the original session to be available. Set the Feishu recipient in each provider editor; `lark-recipient --open-id ou_example` remains a compatibility command for the legacy single-bot configuration. The optional `--channel feishu` argument remains accepted for existing scripts; provider selection uses `--provider-id`, not a new channel name. Codex runs commands in a sandbox: the CLI needs local network access to `127.0.0.1:9417`, so Codex may ask to run it outside the sandbox.

### Message admission and receipts

The Go Feishu provider admits identifiable human-authored text or supported rich posts only from its configured trusted recipient. Bot/application messages are excluded by sender type, independently of which computer sent them. Invalid session/content identities and unauthenticated remote events are rejected at ingress. A remote subscription carries admitted normalized events; its durable confirmation does not authorize a message to target a different session.

Use `message-ack --message-ref …` for an explicit session acknowledgment and `message-reply --message-ref …` for a reply along the original route. Legacy `lark-ack`/`lark-reply` remain compatible for unambiguous IDs. A Feishu acknowledgment uses a `FINGERHEART` reaction; it is a cooperative callback, not proof of model processing. An uncertain local delivery is never automatically resubmitted merely because a remote connection reconnects.

Node's legacy database and pending cooperative inboxes remain private local state. Retained old transport records/cursors are history rather than instructions to start retired connections or production history polling. New provider/remote configuration is exported separately from conversation and delivery state. Automated tests use synthetic provider responses and disposable local servers; they do not create real accounts, groups, or external messages.

## Web UI

Open `http://127.0.0.1:9417`. The layout follows the system's light or dark appearance without reloading and has a navigation column grouped by **Message bridge** (run logs, routing sessions, Agents, Providers) and **Repos** (pull requests to our repositories, pull requests we sent upstream, followed repositories), with **设置** and module and connection status at its foot. The desktop window combines native window controls, the brand, page breadcrumbs, software updates, and refresh in one 52px title row. Logs use bordered lists of single-line rows; PR queues retain two-line rows, and subscriptions use a compact table with expandable source sessions. Filters show counts; `/` focuses the page's search field. Logs, both PR queues, and subscriptions keep search and page actions in the title row, with a compact row of clickable text filters immediately above each list or table. Narrow title rows hide search inputs behind search icons; clicking the icon or pressing `/` opens a field below the title row. Escape or clicking outside closes it without clearing the query, and an active query highlights the icon. Sort uses an icon in narrow windows, and pause/export do the same when software update status is also visible. Settings actions wrap within their row, Feishu QR flows switch to one column by working width, and long import filenames wrap rather than clip. On narrow browser screens, primary navigation scrolls beside a fixed Settings entry, with settings pages in their own contextual row and the active destination kept visible. The desktop window keeps its sidebar and native title-row alignment.

The application supports English and Simplified Chinese, following the system or browser language by default and falling back to English for unsupported languages. **Settings · General · Language** offers **Follow system**, **简体中文**, and **English**. Changes apply immediately, including page titles, accessible labels, status messages, dates, relative times, and number/list formatting, while preserving filters and unfinished form input. Browser preferences are stored locally on each device; unavailable storage does not prevent switching for the current page. The desktop app persists its preference in its own app configuration directory and shares it with the native tray, updater controls, and offline page. The public website keeps its separate language preference.

The web catalog lives in `src/ui-i18n.ts`: Chinese source messages act as typed keys, with English translations and named interpolation parameters. Static markup uses explicit `data-i18n` markers; session names, messages, PR titles, raw diagnostic details, and agent prompt previews remain in their original language. Native strings and language preference handling live in `desktop/internal/language`; `desktop/` contains the offline page translations. Add a catalog entry for new interface copy and preserve its placeholders in every language. The desktop injects `window.__NOOTIFY_LANGUAGE__` before page JavaScript and replays it through the `nootify-language` event. Trusted service and offline pages can request one of the three fixed `nootify://language/system`, `nootify://language/zh-CN`, or `nootify://language/en` navigations; the shell cancels navigation and applies the preference without granting page IPC permissions.

The application follows the website's bundled English typography: Montserrat for headings and the brand, Monda for body text and controls, and Lato for small text, metadata, and log actions. Chinese retains the existing system-font fallback stack, and code/identifiers retain monospace. The service page and embedded startup page share `desktop/fonts.css` and the font files/OFL licenses under `desktop/fonts/`; staging copies them into service resources, so font rendering needs no external network. The fixed role scale remains 16px page headings, 14px primary content and field names, a 13px control/body baseline, and 12px metadata. Numeric counters and progress use tabular figures; code previews use the same local monospace family as IDs. Explanatory paragraphs have a constrained reading measure and more leading without changing the compact list line boxes.

Each collapsed log row stays on one line: a colored message-type label, the message subject as its title, and a consistently neutral action on the right. Message content supplies the subject when available; otherwise it falls back to the session topic or event description. Type colors distinguish user messages, session progress, session replies, and system events independently of delivery outcomes. Actions include Received, Forwarded, Queued, Acknowledged, Replied, Ignored, and Failed, all in the same color. There is no subtitle or second timestamp line; direction, session context, time, diagnostics, and full content remain available in expanded details. Type filters include all records with that label, including failed or ignored messages; the ignore and error filters provide additional action-based views. Outgoing progress (`thread_message`) is not classified as a reply, and forwarding does not imply a session receipt. Search includes translated event labels, source names, sessions, and identifiers, and filter counts follow the current query. Rows expand in place for full IDs, reasons, and message text; logs can be paused and the filtered set exported as NDJSON. The navigation count is the total retained log entries. The routing-session page displays only targets encountered by incoming messages or explicit sends, with their last lookup time and result. Refreshing it performs no client lookups. These are historical observations, not a live inventory.

The page polls a read-only snapshot every two seconds and needs no control token. It accepts loopback hosts or the Nootify node's Tailscale address, and same-origin requests only. The control API remains bearer-authenticated. Logs persist in the private `events.ndjson` file, capped at 1,000 entries; a first launch imports available JSON entries from the prior stdout log. Events explicitly distinguish `received`, `socket_written`, `ignored` with a reason, and failures. For accepted senders, message previews are limited to 240 characters; unknown fields and credentials are not logged. A successful socket write is not proof of model processing.

## Settings

**Settings** at the foot of the navigation opens six pages. Service settings can be read over Tailscale, but changes are accepted only from this computer: credentials and imports decide who can reach local sessions. The interface language is a local display preference and can be changed on each device.

| Page | Purpose |
| --- | --- |
| General | Selects the local interface language, including over Tailscale |
| GitHub | Signs Nootify in to GitHub with the device flow, and signs it out |
| Remote access (`远程接入`) | Configure this node's authenticated gRPC listener, token, TLS certificate/key paths, and inspect downstream peers |
| Tailscale | Enroll Nootify as its own device, connect/disconnect, sign out, and copy its port-80 address |
| 导入导出 | Export and import the configuration |
| 关于 | App and service versions, update checks, and installation |

**GitHub** signs in through Nootify's own OAuth App with GitHub's device flow: the page shows a one-time code and link, the service polls until it is authorized, and pull requests refresh. The GitHub CLI is not used, so signing in or out never affects the `gh` login on this computer. The token goes in the private `state.sqlite`; it never reaches a page, a log, or an export, and the code is never sent to the Tailscale listener. The scopes are `repo` and `read:org`: OAuth has no read-only scope for private repositories, but the service only sends read-only queries. A rejected or missing token shows as signed out, while other failures, such as no network, show as unconfirmed. Until someone signs in, the PR pages keep their last data and say so, and subscriptions still come from local sessions. Signing out forgets the token here; revoke it under [GitHub's application settings](https://github.com/settings/applications) if it may have leaked.

`GITHUB_CLIENT_ID` in `src/github-auth.ts` defaults to Nootify's OAuth App (`Ov23liMl1ElZD0hh84y1`), with Device Flow enabled. Leave token expiration disabled until refresh-token support is implemented. Client IDs are public and this flow uses no client secret. `NOOTIFY_GITHUB_CLIENT_ID` overrides it for a directly launched service.

**Remote access** replaces Feishu in the Settings navigation. It configures the listener used by downstream Nootify nodes, including its token and TLS files; **Providers** configures the outgoing instances. Both pages expose redacted status over permitted Tailscale browser access and accept changes only locally. Revealing the listener token requires an explicit local action; private-key contents are never returned. See [Providers and remote nodes](#providers-and-remote-nodes).

**Legacy Feishu setup** remains available at `#/settings/lark`, linked as **Personal app QR setup (compatibility)** from the Feishu provider editor. It preserves the old bot/personal-app form, QR authentication, recipient picker, and permission checks for migration. These are two setup methods for the `feishu` provider type, not additional provider types. New instance configuration belongs on **Providers**; the compatibility flow updates `legacy-feishu`. Changing the selected legacy form does not change its active connection until credentials are saved or QR authentication succeeds. Its saved connection type survives restarts and configuration export/import; older settings/files default to Feishu bot.

Personal app authentication uses Feishu's app-registration device flow directly; no `lark-cli` installation, shared Nootify bot, or personal-user OAuth login is required. It starts only after an explicit click. Scan and confirm in Feishu, and Nootify verifies the returned credentials, saves the compatibility settings privately, updates the legacy core provider, and uses the scanning user's app-specific `open_id` as the recipient when supplied. The QR, authorization link and registration progress are available only through same-origin loopback actions. Device codes and returned secrets are never included in ordinary page data or logs. Cancel stops registration polling without replacing the current connection; expiry, refusal and network failures have retry paths. Saving is a local commit and cannot be cancelled halfway through.

A saved app is reused on later launches. **Use existing personal app** exposes manual credential entry and a link to configuration import; it does not discover every app in a Feishu account. To share a bot across computers, configure one upstream Nootify to ingest its WebSocket events and connect the other nodes through Remote Nootify providers. Do not assume Feishu supplies an independent event copy to every direct WebSocket client using the same application. Core migration imports bindings matching the legacy app and preserves their original groups; changing a provider does not grant it access to another bot's groups. Moving configuration alone does not move node identity or conversation state.

Bot connectivity and permissions are separate. After QR setup, Nootify checks this app's own granted bot scopes and shows the missing group-announcement read/write, message-reaction write, and ordinary-group-message permissions, together with a locally generated developer-console QR and **Check permissions again**. The compatibility inspector still lists legacy announcement scopes; new core groups use provider metadata and WebSocket message events as described under [Bind a Feishu group](#bind-a-feishu-group). The default personal-agent template supports group creation, sending, and messages mentioning the bot, but may not cover ordinary group replies or every metadata operation. An app administrator must enable missing permissions, publish a version and obtain any required approval; scanning alone does not grant those permissions. A failed scope inspection is shown as unconfirmed, not as a successful permission check.

The **legacy manual setup** asks Feishu for a tenant token before saving; this validation belongs to the compatibility flow. It updates that provider without restarting unrelated modules. Legacy environment credentials take precedence within this flow, so saving there is refused while `LARK_APP_ID`/`LARK_APP_SECRET` are set. The active legacy secret appears as a mask; its eye button reveals it through an explicit same-origin, loopback-only POST. Ordinary page data, logs, and Tailscale clients never receive it, and leaving that page masks it again. Clearing compatibility credentials can fall back to the selected MCP file.

The **provider editor** saves each instance independently to the Go store. It validates required configuration and restarts that provider's connection; a saved form alone does not prove authentication, permissions, or WebSocket readiness. Check the instance's connected/reconnecting/failed status. Its secret/token fields are write-only, and leaving one blank on edit preserves the existing value. New instances do not inherit a global bot secret. Connection status is event/stream based, not the result of a successful history-poll pass.

The **legacy Feishu recipient picker** can accept an `open_id` or select one with **Choose from Feishu**. The new provider editor uses manual `open_id` entry; this directory picker applies to the compatibility setup. A compact searchable dialog shows real Feishu avatars and nickname plus default name, preserving provider names already formatted as an alias with a parenthesized name. Images load lazily from validated HTTPS Feishu image-CDN URLs; unavailable images fall back to initials. Nicknames are searchable, and the current recipient is pinned. Choosing a row is a draft; **Confirm selection** saves it and returns focus to the picker button. The directory streams useful batches over a local NDJSON response, with at most four provider requests in flight, so already loaded contacts can be searched and selected before traversal completes. Completed snapshots are cached in the private `lark-directory-cache.json` file (0600), scoped to the application and credential identity without storing the App Secret. Fresh snapshots are reused for 15 minutes; snapshots up to 24 hours old appear immediately while a fresh directory is read in the background. The cache survives page and service restarts. An explicit reload or permission retry bypasses freshness, and closing the dialog cancels its pending request. Existing contact rows and decoded avatars are reused across batches, searches, and selection changes; refreshing does not clear a usable list or move its visible scroll anchor. Enable `contact:contact.base:readonly` and `contact:user.base:readonly` and configure the app's contact access range in the Feishu developer console; user-group expansion additionally needs `contact:group:readonly`. Only fields permitted by Feishu are returned, so names can fall back to open_id. Inactive users are omitted when their status is available. Reads are bounded to 20 seconds, 100 API requests, and 5,000 users, with an explicit warning for partial results. Directory data stays in private local storage and is available only through the local UI, never the Tailscale listener; manual entry remains available if permissions or the network prevent listing users. Missing permissions retain the provider's scope details and an app-matching official console link. The dialog generates its QR code locally and offers retry after setup; partial lists stay usable while optional access is missing. The QR opens app permission settings, not an automatic user OAuth grant: an app administrator may need to publish a version and obtain approval, and contact visibility is configured separately.

**Import/export** (`导入导出`) writes `exports/nootify-config-<time>.json` in the state directory, mode `0600`, keeping the newest ten. The file includes **all provider instances and their credentials/tokens**, the default provider, remote listener configuration and token/TLS file paths, legacy Feishu settings when present, pulls configuration/follow choices, Codex/OpenCode connections, and enabled agents. **It contains plaintext secrets and is written only to a private file**; the page receives its path and a redacted summary rather than the document. The summary can show provider counts and public IDs, never secrets.

Exports do not include the node UUID, notification-session bindings/tombstones, message/delivery records, peer queues, native agent conversations, GitHub sign-in, or Tailscale identity/enabled state. TLS file paths are configuration; certificate/private-key contents are not copied. Importing on another computer therefore requires its own session enrollment and readable TLS files and does not adopt the old node's routing identity.

Importing validates the file and previews its changes without showing secrets before applying it. A provider configuration section replaces the provider set, default, and listener configuration as a unit; this can close removed instances and restart configured connections. Other settings are applied only when named in the file: follow choices replace the saved set, and agents listed are enabled without disabling others. Credential fields are not an online permission check; connection failures appear after application. Listener TLS paths must pass the core's local file validation. Older Feishu-only files remain migration/compatibility input, retired transport fields are ignored, and newer file versions are refused.

## GitHub pull requests

Two Open/Draft queues are queried live from GitHub's GraphQL API with the account signed in under **设置 · GitHub** (read-only; nothing is created, commented on, or updated):

| Page | Contents |
| --- | --- |
| 我们仓库的 PR | Open PRs in session-derived subscriptions whose destination belongs to our account or internal organizations |
| 提交上游的 PR | Session-linked external PRs, plus our outgoing contributions in the repositories used by those sessions |

Both default to the **least recently updated first**; the sort toggle reverses it. "Needs follow-up" means failed CI, requested changes, a merge conflict, or a non-draft PR untouched for 14 days. Each row starts with a repository label before the PR title; the number, author, relative update time, and source sessions sit below. Label colors are shared by both queues and saved in this browser, so filtering, sorting, and reloading keep a repository's color. Review and CI/conflict states remain on the right.

Refreshes run in the background every five minutes and from the page's refresh button. A request only starts or joins the running refresh and returns immediately; the page keeps showing the previous data and updates when it finishes. A failed refresh keeps the last good snapshot and says so. The snapshot is cached privately in `pulls-cache.json` in the state directory, so a restart shows the last data at once. Coverage limits (repository pagination and private or SSO visibility) are listed under the collapsed "data scope" details. Routine successful refreshes are not written to the run log; only changes in outcome are.

### Session-derived subscriptions

The **PR 订阅** page follows the relationship **session → linked PRs and repository → GitHub status**. Every candidate comes from a discovered session or a deliberate saved choice. A compact table aligns the follow checkbox, repository, source agents, subscription scope, session count, linked PR count, open PR count, and last activity. Clicking a repository expands its source sessions, including the full ID, branch, and explicit PR links, without changing its follow choice. Narrow screens stack the same fields into compact rows. PR rows show their source sessions too.

| Agent | Structured association data |
| --- | --- |
| Claude Desktop | `local_<id>.json` under the app's `claude-code-sessions/<account>/<profile>/`: `sessionId`, `cliSessionId`, `priorCliSessionIds`, `prs[]`, `cwd`, `originCwd`, `worktreePath`, and `gitAnchors[].gitRoot` |
| Claude Code CLI | Individual transcript IDs, working directories, branches, and standalone `pr-link` records under `~/.claude/projects` (honoring `CLAUDE_CONFIG_DIR`) |
| Codex | Individual thread IDs, titles, `cwd`, `git_branch`, and `git_origin_url` in the latest `state_*.sqlite` under `CODEX_HOME` |
| OpenCode | Individual IDs, titles, and directories in `opencode.db` or the older JSON metadata under `$XDG_DATA_HOME/opencode` |

Desktop host IDs are joined to current and previous CLI IDs rather than counted twice. Its persisted `prs[]` takes precedence over transcript history, including an empty array after unlinking. No PR subscriptions are inferred from URLs in message text. Existing explicit PR links remain associated when the session's current branch differs from the PR's branch. Matching head branches can supply a more specific source session for repository results when no explicit link is recorded.

A session's checkout repositories are resolved from its Git remotes. Those repositories receive repository-scoped PR queries. An explicit link to a PR in another repository adds **only that PR**, not all the PRs in that destination. GitHub's authenticated account and organizations classify the resulting subscriptions as internal/upstream; their global PR inventories do not create subscriptions. Exact linked Open PRs are retained regardless of author or whether they cross repositories.

Subscriptions discovered from sessions are selected by default. Unticking saves a choice in the private `repo-preferences.json`; selecting the automatic value again clears the override. A follow change updates the view immediately and starts a background query for the new targets. The version-3 cache contains only session-scoped results; earlier account-wide caches are rebuilt.

Configuration is re-read on each refresh, first found wins: `NOOTIFY_PULLS_CONFIG`, then `pulls.config.json` in the state directory. `authors`, `ownedOwners`, `upstreamOwners`, and `excludeRepositories` affect classification and exclusion; `maxUpstreamPages` bounds each repository query. Legacy scan/search/default-follow fields remain accepted as data but do not define subscriptions.

## Tailscale access

**设置 · Tailscale** enables an **independent Nootify device**, powered by the bundled official `tailscale.com/tsnet` library. No system Tailscale app, daemon, CLI, Serve configuration, administrator privileges, or host port-80 binding is required. The device is named `nootify` (Tailscale may assign a suffix to make the name unique). It has its own tailnet IP, MagicDNS name, account, and keys; an existing Tailscale installation on this computer is untouched.

The node is **off by default**. Enable it or choose **启用并登录**, then follow the official browser authorization link. The link is visible only on the local settings page and opens only `https://login.tailscale.com/a/…`. Once authorized, Nootify appears as a separate device in the user's tailnet. Tailnet administrators may need to approve it. The embedded node listens on its own TCP port 80, so its address is `http://100.x.y.z/`, or its MagicDNS name, without a port suffix.

Turning the switch off takes only the Nootify node offline and closes active connections; it preserves enrollment for the next connection. **退出登录** logs out this device and disables it. Persistent keys are under the private `tailscale/` directory in Nootify's state directory, separate from system Tailscale. Neither keys nor the enabled setting are included in configuration exports/imports. The sidecar receives a restricted environment so ambient Tailscale auth keys, OAuth credentials, and control-server overrides cannot silently enroll it. It exclusively locks its persistent identity, reports safe startup causes through a private handshake, and exits on stdin EOF or service shutdown. Relative service state paths are resolved before launching it. An explicit login retry can renew an expired authorization link.

The embedded node forwards accepted connections to a private loopback backend using a bounded PROXY v1 prefix derived from the actual peer socket. Peer identity is resolved through this embedded node's LocalAPI, never through HTTP headers or system Tailscale. Host/origin checks accept only the Nootify device's own names and addresses. By default only devices owned by the same login are allowed; tagged devices and other users are rejected. `NOOTIFY_TAILNET_USERS` can specify allowed logins. Settings and agent edits remain local-only; control APIs still require the bearer token. This browser proxy exposes Nootify on its own port 80; it does not expose host preview servers or files. Managed agent instructions explicitly require a separately verified sharing endpoint for those resources. HTTP header/body deadlines remain active across the proxy boundary, transient status failures receive bounded retries without immediately disconnecting a healthy node, and repeated identical failures do not displace message history.

When Remote access and the embedded device are enabled, the Node bridge can additionally publish the core's loopback-reachable gRPC listener on the Nootify device's corresponding TCP port. Remote providers targeting Tailscale IPs or `.ts.net` hosts use a private tunnel through this same embedded identity, without the operating system's Tailscale installation. These are raw TCP paths: they do not add the browser proxy's PROXY preamble to gRPC. The gRPC listener uses its own token/TLS policy, and tailnet reachability remains subject to the tailnet's network policy. Browser same-login checks are specific to the HTTP proxy. Disabling the integration or shutting down closes published listeners and tunnels. A private loopback listener transported through Tailscale can use plaintext gRPC inside that encrypted path; public host listeners still require TLS.

Source builds require the Go version pinned in `native/tailscale/go.mod`. `npm run tailscale:build` builds the sidecar without connecting or enrolling a device; desktop staging includes it and its dependency licenses. `NOOTIFY_TSNET_BIN` can point at a development/test helper, never a system Tailscale CLI.

## TypeScript client and module API

```typescript
import { NootifyClient } from './dist/src/client.js';

const client = new NootifyClient({ baseUrl: 'http://127.0.0.1:9417', token });
const encountered = await client.listSessions(); // Persisted observations; does not enumerate clients.
if (encountered.length) {
  await client.sendMessage(encountered[0].session_id, 'Status request from my local tool', encountered[0].adapter);
}
```

Read the bearer token from the private state file in your local application; never embed it in source or browser code. The exported declarations include request and response types. `/v1/services` lists the enabled modules. Each `ServiceModule` provides a name, route handler, lifecycle methods, and status, so adding another service does not change the HTTP/authentication host.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Host and module health, without credentials |
| `GET /v1/services` | Installed module names and statuses |
| `GET /` | Read-only web UI |
| `GET /ui/api/snapshot` | Recent sanitized logs, module health, encountered targets, PR counts, Tailscale address |
| `GET /ui/api/pulls` | Current PR snapshot for the page |
| `POST /ui/api/pulls/refresh` | Start or join a background PR refresh (`202`); needs the `X-Nootify-UI: 1` header |
| `POST /ui/api/repos` | Set a follow choice: `{"repository": "owner/name", "follow": true \| false \| null}`; needs the same header |
| `GET /v1/pulls`, `POST /v1/pulls/refresh` | The same PR snapshot and refresh for token-authenticated clients |
| `GET /v1/repos`, `PUT /v1/repos/:owner/:name` | Repository list and follow choices for token-authenticated clients |
| `GET /ui/api/agents`, `POST /ui/api/agents` | Agent prompt status and `{"agent", "enabled"}` changes; changes need the UI header and the loopback listener |
| `GET /ui/api/providers` | Core node ID, redacted provider instances/default/listener summary, and editable flag |
| `POST /ui/api/providers` | `{"action":"save","provider":{…}}`, `{"action":"delete","id":"…"}`, or `{"action":"default","id":"…"}`; UI header and loopback only |
| `GET /ui/api/settings/remote`, `POST /ui/api/settings/remote` | Read redacted listener/peer state or save enabled/listen/token/TLS file paths; changes need the UI header and loopback |
| `POST /ui/api/settings/remote/secret` | Reveal the listener token through an explicit local UI action; UI header and loopback only |
| `GET /ui/api/settings`, `GET /ui/api/settings/github` | Settings page data and the GitHub account; neither carries a secret |
| `POST /ui/api/settings/lark`, `POST /ui/api/settings/recipient` | Legacy Feishu setup: save `{"app_id", "app_secret"}`, clear with `{"clear": true}`, or set `{"open_id"}`; these and the actions below need the UI header and the loopback listener |
| `POST /ui/api/settings/lark/secret` | Reveal the active Feishu credentials only when the local eye button is clicked; response is never cached or available over Tailscale |
| `POST /ui/api/settings/lark/recipients` | Read a cached complete directory snapshot for the local recipient picker; requires the UI header and is unavailable over Tailscale |
| `POST /ui/api/settings/lark/recipients/stream` | Stream cached contacts immediately, then `progress`, `complete`, or structured `error` NDJSON events; `{"refresh": true}` bypasses the 15-minute freshness window. Local UI only; missing-access events include a verified official permission URL and local PNG QR |
| `POST /ui/api/settings/github/login` | `{"action": "start" \| "cancel" \| "sign-out"}` for the device login |
| `GET /ui/api/settings/tailscale` | Connection, remote-access state and URL; login URLs are omitted over Tailscale |
| `POST /ui/api/settings/tailscale` | `{"action": "enable", "enabled": true}` or `{"action": "login" \| "cancel" \| "logout"}` for the independent node; local UI only |
| `POST /ui/api/settings/export`, `POST /ui/api/settings/reveal` | Write a configuration file and return its path; show it in Finder |
| `POST /ui/api/settings/import` | Preview `{"document"}`, or apply it with `"apply": true` |
| `GET /v1/agents`, `PUT /v1/agents/:agent` | The same for token-authenticated clients |
| `GET /v1/providers`, `POST /v1/providers` | Read provider status or perform save/delete/default actions for authenticated control clients |
| `POST /v1/threads` | Ensure a session's provider binding: `{"adapter", "session_id", "session_name", "provider_id"?, "channel"?}` |
| `DELETE /v1/threads/:session_id` | Delete notification resources/mapping through `{"adapter", "provider_id"?}`; never deletes the native conversation |
| `GET /v1/threads/:session_id/metadata`, `PUT /v1/threads/:session_id/metadata` | Get/set provider session metadata; PUT takes `{"adapter", "provider_id"?, "metadata":{…}}` |
| `POST /v1/threads/:session_id/messages` | Send `{"text", "adapter"?, "provider_id"?, "request_id"?}` or structured `content` through the binding |
| `POST /v1/provider-messages/:message_ref/ack`, `POST /v1/provider-messages/:message_ref/reply` | Acknowledge or reply using an encoded full origin reference; replies take text/content and optional request ID |
| `POST /v1/sessions/:id/inbox` | Read pending Trae/WorkBuddy input with `{"adapter": "trae" \| "workbuddy"}`; token-authenticated, repeatable until acknowledged |
| `POST /v1/sessions/:id/inbox/:message_id/ack` | Remove one processed inbox item with the same adapter; separate from the original channel receipt |
| `GET /v1/lark/recipient`, `PUT /v1/lark/recipient` | Read or set the Feishu recipient's open_id |
| `GET /v1/sessions` | Latest 1,000 routing observations, restored from SQLite across restarts; never queries clients |
| `PUT /v1/backends/:adapter` | Configure an existing local Codex or OpenCode endpoint |
| `PUT /v1/sessions/:id` | Register/update an inbox from an authorized local client |
| `POST /v1/sessions/:id/messages` | Send attributed text to a registered inbox |
| `POST /v1/lark/messages/:id/ack` | Legacy acknowledgment by an unambiguous retained message ID |
| `POST /v1/lark/messages/:id/reply` | Legacy reply by an unambiguous retained message ID |
| `GET /v1/lark/bindings` | Compatibility view of Feishu group/session bindings |
| `PUT /v1/lark/bindings/:chat_id` | Compatibility binding of an existing Feishu group; new workflows use provider session ensure |

Provider and remote UI mutations require `X-Nootify-UI: 1`, same-origin checks, and the local loopback listener. Provider summaries expose App IDs, recipient IDs, addresses, TLS settings, and secret/token presence flags; they omit credential values. The stdio protocol is private to Node and the core. Remote gRPC callers can invoke session/message operations, not private provider configuration, exports, listener-secret reads, or local agent socket registration. See [provider-protocol.md](provider-protocol.md) for the RPC frames and durable routing contract.

## Files

| File | Purpose |
| --- | --- |
| `src/server.ts` | Node host: loopback/Tailscale HTTP, authentication, module and child-process lifecycle |
| `src/provider-core.ts` | Private concurrent NDJSON stdio bridge to `nootify-core` |
| `src/providers.ts` | Provider UI/control facade, migration, local discovery/backfill, agent delivery completion, and embedded-network coordination |
| `native/core/` | Go core: Feishu WebSocket, authenticated remote gRPC, Agent Sessions/content, durable JSON store and peer queues |
| `native/core/proto/core.proto` | Remote command/subscription frames and independent confirmations |
| `docs/provider-protocol.md` | Node/core/UI implementation contract |
| `src/tailnet.ts` | Tailscale address discovery and browser peer identity checks |
| `src/tailscale.ts` | Independent Nootify node settings, enrollment, logout and lifecycle |
| `src/tsnet-client.ts` | Private bounded RPC to the bundled Tailscale sidecar, including core tunnels/published TCP listeners |
| `native/tailscale/` | Embedded tsnet identity, userspace port-80 browser proxy, and raw core TCP forwarding |
| `src/tailnet-proxy.ts` | Private loopback backend and bounded PROXY v1 peer parsing |
| `src/github.ts`, `src/github-api.ts`, `src/github-model.ts` | Background GraphQL queries with the saved token, classification, sorting, follow choices, private cache |
| `src/conversations.ts` | Individual Claude, Codex and OpenCode sessions, repository anchors, and explicit PR associations |
| `src/types.ts` | Public request/response and module contracts |
| `src/client.ts` | Typed client for other TypeScript tools |
| `src/state.ts`, `src/state-database.ts` | Node SQLite adapter/settings/inbox state, retained legacy data, and one-time root-level JSON migration |
| `native/core/store.go`, `native/core/config.go` | Private `provider-core/state.json`, fsync/atomic replacement, provider/listener configuration, and one-time legacy binding/credential import |
| `src/sessions.ts`, `src/local-sessions.ts` | Lazy dispatch, encountered targets, and targeted Claude lookup |
| `src/external-sessions.ts`, `src/codex-rpc.ts`, `src/codex-desktop.ts` | Targeted Codex/OpenCode lookup, app-server input, and existing Codex Desktop owner routing |
| `src/events.ts`, `src/ui.ts`, `src/ui-app.ts`, `public/` | Persistent bounded logs and the read-only browser UI |
| `src/lark.ts`, `src/lark-polling.ts`, `src/lark-history-buffer.ts` | Legacy Feishu receiver/history implementation retained for compatibility/regressions; not started in production |
| `src/lark-metadata.ts` | Node Feishu API helpers and legacy credential resolution |
| `src/launchd.ts`, `src/service.ts`, `src/cli.ts` | Platform background service installation and control, acknowledgments, and replies |
| `windows/` | Per-user Scheduled Task, hidden Node/helper Job Object, and Windows lifecycle tests |
| `src/runtime-paths.ts`, `src/inbox.ts`, `src/shell.ts` | Platform state/session paths, Unix socket or named-pipe validation, and shell-safe agent instructions |
| `src/lark-replies.ts`, `src/lark-threads.ts` | Legacy Feishu reply/group helpers; production notification operations go through `src/providers.ts` and the Go core |
| `src/lark-directory.ts` | Bounded contact-scope traversal and safe recipient candidates for the local Feishu picker |
| `src/lark-directory-cache.ts`, `src/recipient-list.ts` | Private credential-scoped directory cache and stable contact/portrait DOM updates |
| `src/message-ingress.ts` | Legacy Node Feishu normalization/admission helpers; production ingress/content conversion lives in `native/core/feishu.go` |
| `src/agents.ts` | Marked notification-channel instructions in each agent's global prompt file |
| `src/polled-sessions.ts` | Private, bounded Trae/WorkBuddy inboxes, conversation registration, and explicit consumption acknowledgments |
| `src/forwarded-messages.ts` | Current-installation receipt/reply command rendering for live deliveries and retained inbox messages |
| `src/settings.ts`, `src/github-auth.ts` | Settings pages' actions: Feishu credentials, configuration export and import, GitHub device login and sign-out |
| `desktop/`, `scripts/desktop.mjs` | Go/MyGo native window, tray, offline view, and desktop build launcher |
| `scripts/stage-service.mjs` | Stage the service/UI/dependencies, Node runtime, both Go executables, and their licenses |
| `scripts/build-core.mjs` | Build/verify `nootify-core` and collect its Go dependency licenses |
| `scripts/third-party-notices.mjs`, `scripts/spdx-licenses/` | Collect desktop Go module and production npm license texts into staged `third-party-notices.txt` |
| `scripts/build-tsnet.mjs` | Build and verify the independent Tailscale sidecar and collect dependency licenses |
| `desktop/internal/updater`, `desktop/cmd/sign-update` | Go release checks, signature-verified installation, and compatible artifact signing |
| `.github/workflows/` | macOS/Windows checks and version-tag-driven DMG/NSIS/updater publication |
| `test/` | Disposable HTTP/socket/state and routing tests |

Official references: [Feishu Go SDK](https://github.com/larksuite/oapi-sdk-go), [Feishu Node SDK](https://github.com/larksuite/node-sdk) (legacy setup helpers), [message receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive), and [Claude Code inbox sockets](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).

## License

Nootify is available under the [MIT License](../LICENSE). Third-party components keep their own licenses. The website's fonts and Phosphor icon font ship with their license files in `site/shared/`. The application's Montserrat, Monda, and Lato files and OFL notices also ship in `desktop/fonts/`, shared by the embedded waiting page and the staged service UI. For the desktop app, `scripts/stage-service.mjs` places these in the service resources (`Nootify.app/Contents/Resources/service/` on macOS, or `service/` beside `Nootify.exe` on Windows):

- `third-party-notices.txt`, written by `scripts/third-party-notices.mjs`: the license texts of desktop Go dependencies and every production npm package in `node_modules/`. Dependency attribution comes from Go module metadata and package manifests without Cargo. Where a package has no bundled license file, staging uses its declared license from `scripts/spdx-licenses/`, verbatim copies of [SPDX License List](https://github.com/spdx/license-list-data) texts; missing required text fails staging.
- `node-LICENSE`: the Node.js runtime's license.
- `tailscale-licenses/`: the licenses of the Go modules in the embedded Tailscale client.
- `core-licenses/`: the licenses of the Go modules in `nootify-core`, including its Feishu SDK and gRPC dependencies.
