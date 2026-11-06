# Nootify

A general-purpose local **TypeScript service host**, managed as a per-user macOS LaunchAgent. Session messaging, Feishu, Slack, and Telegram are separate modules. Other TypeScript tools use the exported typed HTTP client; future services implement the same module interface. This is not a standalone Lark-only daemon.

The HTTP listener binds to `127.0.0.1:9417`. Optional Tailscale access, enabled under **设置 · Tailscale**, exposes the Nootify node's Tailscale address on port 80 for the owner's other devices. Open either address for message-bridge logs, **encountered routing targets**, and the two GitHub pull-request queues. `/health` and the read-only `/ui/*` page data are available to permitted browsers; every `/v1/` control endpoint requires the per-user bearer token on both listeners. Host/origin checks prevent cross-site reads and DNS rebinding. The service routes input to existing Claude, Codex, or OpenCode clients rather than calling a model API directly.

Routing lookup is lazy: only a message with a concrete adapter and session ID resolves that adapter's inbox or connects to its backend. The routing page lists at most 1,000 targets actually encountered during this process lifetime, including missing/archived/unavailable results. PR subscription discovery separately reads session identities, explicit PR links, repository anchors, branches, and timestamps.

## Project website

The public landing page is prepared for [nootify.idy.dev](https://nootify.idy.dev/). Its static files live in `site/`, separate from the service dashboard in `public/`. The website has no access to the local service, account data, or credentials.

English/Chinese follows the browser by default; light/dark appearance follows the system. Header controls persist explicit choices when storage is available. The common idy.dev shell and locally hosted fonts with their licenses live in `site/shared/` and should stay identical to the other idy.dev sites. Montserrat is used for headings, Monda for body text, Lato for notes, and Phosphor for icons; Manrope remains a fallback. The penguin mark comes from `desktop/brand.svg`.

The latest stable GitHub Release supplies the actual Apple Silicon DMG URL, filename, size, and version. Preview-only repositories fall back to the newest published prerelease. Missing installers, rate limits, and network failures leave usable release-page links without claiming a fixed latest version. No API token is used.

Preview and test from the repository root:

```bash
python3 -m http.server 4173 --directory site
```

```bash
node --test test/website.test.cjs
```

The website workflow validates relevant pull requests and deploys `site/` only after a change reaches `main` (or a manual dispatch on `main`). First-time setup requires enabling GitHub Pages with GitHub Actions as the source, reserving the custom domain `nootify.idy.dev` in Pages, and adding a DNS CNAME from `nootify.idy.dev` to `idy.github.io`. After DNS and certificate issuance, enable HTTPS enforcement. The checked-in CNAME and workflow do not perform those account/DNS operations. Enable Pages before merging the first website PR so the deployment job can run. The idy.dev homepage links to this domain and should be published once the site is reachable.

## Build and test

Requires Node.js 22.13+ and npm; Codex metadata lookup uses the built-in `node:sqlite`. From the repository root:

```bash
npm ci
```

```bash
npm test
```

```bash
npm run check
```

## Tauri desktop application and system tray

The native **Nootify** app for Apple Silicon and macOS 13.5+ bundles the background service, its own Node.js runtime, and an independent Tailscale client built with tsnet. Its native window, web UI, and offline page follow the system's light or dark appearance, including changes while the app is open. It provides a menu-bar tray with **打开**, **退出**, service controls, and update controls. PR rows open GitHub in the default browser. Closing the window hides it; quitting the desktop app leaves the independent daemon running.

Download the DMG from [GitHub Releases](https://github.com/idy/nootify/releases/latest), drag Nootify to **Applications**, and open it. The first launch automatically installs and starts the background service; later launches connect to it or load its existing LaunchAgent if needed. A healthy service keeps its process and connection. The compact native macOS tray menu shows Open, connection status, Background Service, Software Updates, Settings, and Quit. Module status and start/restart/install recovery controls live under Background Service; they are recovery actions, not setup steps. The menu uses the system material and follows the macOS appearance.

The desktop app is single-instance. Opening it again restores and focuses the existing window, including when minimized or closed to the tray, without restarting the background service.

Automatic installation requires `~/Library/LaunchAgents/dev.idy.nootify.service.plist` to be absent and port 9417 to be free. It refuses installation from a read-only disk image. Keep the app in Applications: the job runs Node.js and `server.js` inside its bundle. An existing LaunchAgent is reused, and the tray never replaces its configuration.

When `~/.claude.json` exists, the installer selects its `mcpServers.lark` credentials. A file without a Lark server leaves Feishu disabled and the PR pages available until credentials are saved under **设置 · 飞书**. Credentials stay in their original file. The web page receives no native Tauri IPC capabilities: fixed navigation requests support the title row and the update bridge described under [Automatic updates](#automatic-updates-and-releases). Builds are ad-hoc signed and are not notarized; macOS may require allowing the first launch under System Settings > Privacy & Security.

### Build the desktop app

Requires stable Rust, Go 1.27.3 or the version pinned in `native/tailscale/go.mod`, Xcode command-line tools, and the npm dependencies above. The build helper finds Rust under `CARGO_HOME/bin` or `~/.cargo/bin`.

```bash
npm run desktop:dev
```

For a release build, supply `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment, then run:

```bash
npm run desktop:build
```

Before bundling, the build compiles TypeScript and stages the service, `public/`, and production dependencies in `src-tauri/resources/service/`. It downloads a pinned official Node.js runtime, checks its SHA-256 against both the pinned value and the release's `SHASUMS256.txt`, and stages it as the `binaries/node` sidecar. It also builds `native/tailscale` with the pinned Go dependencies as `binaries/nootify-tsnet`, checks the binary's version and system-library links, and includes dependency licenses in the service resources. `npm run desktop:stage` performs only staging. `cargo test` and `cargo clippy` work without staging; release builds require real staged resources. The Node runtime needs the JIT entitlement in `src-tauri/Entitlements.plist`.

Outputs under `src-tauri/target/release/bundle/` are `macos/Nootify.app`, the Apple Silicon DMG in `dmg/`, and `macos/Nootify.app.tar.gz` with its updater signature. Set `CARGO_TARGET_DIR` to reuse another target directory when needed.

### Automatic updates and releases

The app checks [the signed release manifest](https://github.com/idy/nootify/releases/latest/download/latest.json) about 30 seconds after launch, every six hours, and when **检查更新** is selected under the tray's **软件更新** submenu or in the window's title row. When a newer version exists, the tray submenu becomes **更新 vX.Y.Z** and offers **安装更新 vX.Y.Z**; every page also shows a compact **更新 vX.Y.Z** button in the title row. Downloading starts only when installation is selected. Installation verifies the update signature, replaces the app, restarts the background service if its LaunchAgent runs this app's Node.js, and relaunches the app. One fixed-width title-row button stays in place throughout the update: **更新 vX.Y.Z** becomes **下载中 42%**, then **安装中…** and **重启中…**; the tray submenu title also shows progress in place. There is no second line or separate progress bar. Unknown-size downloads show **下载中…**; checks, success, and retries use the same button, preserving its position and keyboard focus. Clicking the title-row status or the tray's **更新详情…** opens **设置 · 关于** for full version, download size, and error details; the tray keeps failures concise.

For a debug native smoke run against an isolated worktree service, set `NOOTIFY_SMOKE_UI_URL` to its `http://127.0.0.1:<port>/` origin and run the debug binary with `--smoke-test`. The override is accepted only in debug smoke mode, where service and update workers are disabled; the check exercises title-row update clicks, progress, narrow-window layout, and double-click zoom. Native tray checks also exercise update submenu insertion, progress and busy states, plus Settings and update-details navigation. Build with a separate Tauri identifier when another desktop instance is running. To capture the real menu, `NOOTIFY_SMOKE_TRAY_CAPTURE_MS` adds a debug-only pause of up to 30 seconds and prints the tray rectangle; `NOOTIFY_SMOKE_TRAY_THEME=light|dark` changes only that test process's appearance, and `NOOTIFY_SMOKE_TRAY_PROGRESS=1` displays simulated download progress. These capture options do not run service or updater workers.

The update worker runs in Rust. It pushes its state into the page as a `nootify-update` DOM event, replayed on every page load, and the page asks for a check or an install by navigating to `nootify://update/check` or `nootify://update/install`, which the window's navigation policy cancels. These are the only update requests; the page still has no IPC. A native initialization script also handles dragging and double-clicking empty title-row areas through the fixed `nootify://window/drag` and `nootify://window/zoom` requests, leaving buttons and links clickable. A plain browser receives neither the script nor update events, so it keeps its ordinary layout and **设置 · 关于** shows only the service version there.

CI runs TypeScript tests, resource staging, rustfmt, clippy, and Rust tests on macOS. To publish a release, update `package.json` and `src-tauri/Cargo.toml` to the same version, commit to `main`, then push a matching `vX.Y.Z` tag. The release workflow rejects a tag that differs from `package.json`. It publishes the DMG, updater bundle, signature, and `latest.json` using the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. A manually dispatched release must select a version tag too.

## Install from a source checkout

The packaged app installs its service automatically. For a checkout-based installation instead:

```bash
node dist/src/cli.js launchd-install --mcp-config ~/.claude.json
```

The installer creates `~/Library/LaunchAgents/dev.idy.nootify.service.plist` and loads it into the current user's GUI launchd domain. It uses an absolute Node executable and compiled server path, launches at login, and restarts on failure. No root privileges are needed. The checkout must remain at its installed path; build and reinstall after moving it.

Feishu credentials come from, in order: `LARK_APP_ID`/`LARK_APP_SECRET` when running directly, credentials saved under **设置 · 飞书**, or the explicitly selected `mcpServers.lark` MCP configuration. A launchd job does not inherit your interactive shell environment: use Settings or the MCP-config option for the installed service. Omitting Feishu configuration leaves that module disabled while the other services remain available.

The default private state directory is `~/.local/state/nootify/`. It contains the HTTP authentication token, registered sessions/bindings, Feishu credentials and the GitHub token saved in Settings, exported configuration files, and logs. The state directory is private, and credential-bearing files use mode `0600`. Session inbox tokens must be registered with the independent daemon; they are stored only in this private state, never in the repository, group messages, or logs. HTTP responses list public session information without socket credentials.

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

For that targeted lookup, Desktop account/profile directories are located under `~/Library/Application Support/Claude-3p/claude-code-sessions` and `Claude/claude-code-sessions`; runtime records come from `~/.claude/sessions` (honoring `CLAUDE_CONFIG_DIR`). These local formats may change in later releases. An unverifiable archive field produces `archive_unknown`. Live CLI sessions have no Desktop archive record; inactive CLI sessions are ignored.

## Codex and OpenCode

Each adapter resolves only the incoming ID:

| Adapter | Lookup and archive check | Input transport |
| --- | --- | --- |
| `claude-desktop`, `claude-code` | Targeted local record and live runtime lookup | Existing inbox socket |
| `codex` | Read-only indexed `WHERE id = ?` query in the latest `state_*.sqlite` under `CODEX_HOME` (default `~/.codex`); then `thread/read` for that ID | The existing app-server WebSocket: `turn/start` when idle, `turn/steer` for its latest active turn |
| `opencode` | `GET /session/:id` through the official SDK; check `time.archived` | `POST /session/:id/prompt_async` |

Codex never calls `thread/list`, `thread/start`, `thread/resume`, or `thread/unarchive`. A thread not loaded in the configured app-server is logged as offline. OpenCode never calls its session-list API or creates a session. `input_accepted` means the client accepted the input, not that generation completed. Interactive approval requests are not approved by the bridge.

Set the **existing** local backend address once, not one configuration per session:

```bash
node dist/src/cli.js backend-set --adapter codex --url ws://127.0.0.1:4500
```

```bash
node dist/src/cli.js backend-set --adapter opencode --url http://127.0.0.1:4096
```

The Codex port above is an example, not an automatically discovered Desktop endpoint. The app-server must own the target live thread and use the corresponding local `CODEX_HOME`. This tool does not start another Codex process to take over its history. OpenCode defaults to its documented `127.0.0.1:4096` address if none is configured. Add `--directory` when its server needs a project directory.

The CLI reads optional `CODEX_APP_SERVER_TOKEN` or `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` from its environment and stores them privately with the backend configuration. Direct daemon launches can also use `CODEX_APP_SERVER_URL` / `OPENCODE_SERVER_URL`; launchd does not inherit your shell environment, so use `backend-set` for an installed service. Endpoints are limited to loopback addresses and cannot be supplied by announcement text. No available local session or backend means an explicit ignore reason, never a fallback to Claude.

## Bind a Feishu group

```bash
node dist/src/cli.js lark-bind --chat-id oc_example --session-id local_example --sender-id ou_example --pin
```

The command preserves the group announcement and inserts a complete session declaration if missing. Existing conflicting declarations are never overwritten. Incoming text is routed by **the current group announcement**, not a cached chat-to-session mapping or pinned message. Local bindings establish trusted sender IDs; any group message from those users can be routed when its announcement names an eligible local session. An explicitly bound group still enforces its own sender. `LARK_ALLOWED_OPEN_IDS` can supply a comma-separated sender allowlist for a directly launched service.

The findable token is:

```text
agent-session:v1:<host_id>:<adapter>:<complete_session_id>
```

Both legacy and Docx announcements are supported, including tokens split across styled text runs. Valid adapters are `claude-desktop`, `claude-code`, `codex`, and `opencode`; pass `--adapter` to `lark-bind` when creating a declaration for a different client. Binding does not require that session to be preregistered. Existing announcements containing one complete `local_<uuid>`, `Codex thread <uuid>`, or `OpenCode session ses_…` also resolve the corresponding client. Missing or ambiguous declarations are logged and ignored. With `--metadata message --pin`, the tool additionally maintains a pinned message for convenience; the announcement remains authoritative. It never contains socket addresses or credentials.

Enable the bot's `im.message.receive_v1` event with persistent-connection delivery. Mention-only group permissions require mentioning the bot; ordinary user replies require the corresponding group-message permission. Routing requires `im:chat.announcement:read`; inserting declarations requires `im:chat.announcement:write_only`. Optional pinned messages require the message read/send/pin scopes. Missing permissions are reported; the service does not change app permissions or Claude's inbound controls.

Only configured senders' text messages are accepted. Bot messages are ignored. The queue deduplicates IDs for the current process lifetime; it is not a durable event queue. Socket writes are transport results, not acknowledgment that the model admitted or processed the message. Verify the marker in the original session for an end-to-end test. Peer messages cannot approve permission requests.

### Replying to the Feishu user

Forwarded messages identify the original Feishu user, chat, message, and target session. They explicitly ask the agent to reply to the original Feishu message when convenient, and include correctly quoted commands for an acknowledgment and a bot reply. Only message text is forwarded as user content; it is never inserted into the reply command's shell arguments.

```bash
node dist/src/cli.js lark-ack --message-id om_original
```

```bash
node dist/src/cli.js lark-reply --message-id om_original --text "I am here; I will follow up shortly."
```

For multiline replies use `--text-file <path>` or `--text-file -` to read stdin. The forwarded commands include the actual CLI path, private state directory, and service port so they work from another project. Credentials remain local and are not put in the prompt.

The bridge can reply only to known forwarded message IDs; callers cannot substitute another destination chat. Replies preserve the original topic when present, start with the session name, and deduplicate identical replies across retries/restarts. Acknowledgments send no chat message. The private state retains up to 2,000 delivery contexts. Older messages sent before this reply protocol are not silently replayed.

Delivery logs distinguish `socket_written`/`input_accepted` (**waiting for a session receipt**), `session_acknowledged` (an explicit acknowledgment callback), and `replied` (the Feishu API returned the reply ID). The acknowledgment is a cooperative callback from a trusted local client, not a cryptographic read receipt from the model runtime. Merely writing bytes is never treated as a confirmed response.

**Independent-daemon admission:** a launchd process is not a child of the target Claude session. Supplying the session token does not override an explicit process-ancestry verdict on macOS. Claude's inbound policy can therefore hold or refuse messages even after `socket_written`; this particularly affects sessions running with bypass permissions. Unattended delivery requires an inbound policy that explicitly accepts this source, such as an owner-configured `crossSessionInbound: "accept"` in an appropriate settings scope. This service never changes that setting or asserts a sender permission mode. The same policy limitation applies to messages sent through the generic TypeScript client.

Only one process should receive an application's Feishu WebSocket events: multiple clients divide deliveries rather than broadcasting them. This service supports several registered sessions on this machine, but does not yet coordinate several machines.

## Agents and notification channels

The **Agents** page lists Claude Code (`~/.claude/CLAUDE.md`, honoring `CLAUDE_CONFIG_DIR`), Codex (`~/.codex/AGENTS.md`, honoring `CODEX_HOME`) and OpenCode (`~/.config/opencode/AGENTS.md`, honoring `XDG_CONFIG_HOME`). Ticking an agent creates its configuration directory and prompt file if necessary, then appends instructions for the selected notification channel between `<!-- nootify:begin -->` and `<!-- nootify:end -->`; unticking removes that section. A missing directory is shown as unconfigured, rather than used to infer whether the agent is installed. Nothing outside the markers changes, symlinked prompt files are edited at their target, the previous file is copied to `agent-backups/` in the state directory (last ten per agent), and files with unbalanced markers are left alone. "Needs update" means the block differs from what this installation would write, for example after the app moved. Prompts can only be changed from this Mac; over Tailscale the page is read-only.

The section tells new conversations to use two commands, which find the calling session from the variables each client sets (`CLAUDE_CODE_HOST_SESSION_ID` for Claude Desktop, `CLAUDE_CODE_SESSION_ID` for the Claude Code CLI, `CODEX_THREAD_ID` for Codex). OpenCode does not export its session ID, so its section asks for `--session-id ses_…`.

```bash
node dist/src/cli.js thread-open --agent claude --session-name "Fix login"
```

```bash
node dist/src/cli.js thread-send --agent claude --text "Tests pass; opening the PR next"
```

`thread-open` reuses the session's group if Nootify knows one or finds one among the bot's groups whose name carries the session's short ID and whose announcement names the session; otherwise it creates `<task> · <client> · <short ID>`, invites the recipient, and writes the routing token to the announcement. `thread-send` posts `[session name] text`; use `--text-file -` for multi-line text. Replies in that group are routed back like any other bound group.

The recipient is the Feishu user who is invited to new groups and trusted as their sender. It is the open_id saved under **设置 · 飞书** or with the command below, else `LARK_NOTIFY_OPEN_ID`, else the single sender shared by existing bindings:

```bash
node dist/src/cli.js lark-recipient --open-id ou_example
```

Group creation needs the bot's chat-creation permission (`im:chat:create` or `im:chat`), adoption needs `im:chat:readonly`, and progress messages need `im:message:send_as_bot`. Codex runs commands in a sandbox: the CLI needs local network access to `127.0.0.1:9417`, so Codex may ask to run it outside the sandbox. The default channel is selected on the Agents page and initially remains Feishu. `thread-open` and `thread-send` accept `--channel feishu|slack|telegram` to override it. Changing the default makes existing injected prompts show “Needs update”; refresh them to use the selected provider. Existing Feishu bindings, commands and announcements remain supported.

### Slack

Create a Slack app, enable Socket Mode, and create an app-level token (`xapp-…`) with `connections:write`. Subscribe to the `message.channels` and `message.groups` bot events. Give the bot `chat:write`, `channels:read`, `groups:read`, and `users:read`, plus `channels:history` for `message.channels` and `groups:history` for `message.groups`; reinstall it in the workspace after changing scopes. Invite the bot to the intended public or private channel. Under **设置 · Slack**, save the bot token (`xoxb-…`), app-level token, channel ID (`C…` or `G…`), and the one trusted user's Slack member ID (`U…` or `W…`). Tokens are verified before saving and never returned by page APIs.

Each agent conversation creates one parent message in that channel. Progress and replies stay in its thread. Socket Mode receives events over an outbound WebSocket; no public callback server is required. Only plain text replies in locally bound threads from the configured human user are forwarded; bot messages, edits, unbound threads, and other users are ignored. A channel must be dedicated to users who may read the session's progress, since its members can see thread messages.

### Telegram

Create a bot with BotFather and a supergroup with Topics enabled. Add the bot as an administrator with permission to manage topics. Under **设置 · Telegram**, save its bot token, the supergroup's numeric chat ID (`-100…`), and the trusted human user's numeric ID. Configuration verifies the bot, group, permissions, and that no webhook is active; it never deletes an existing webhook. Run only one polling client for this bot.

Each agent conversation creates a forum topic. Progress and agent replies stay in that topic; only text from the configured user in a locally bound topic can enter a local session. Anonymous sender-chat messages, bots, edits, and unbound topics are ignored. Long polling uses outbound HTTPS, so no public callback server is needed. Initial startup skips queued historical updates rather than replaying stale commands; updates received while running are deduplicated in the durable ledger.

### Routing, receipts, and credentials

Slack and Telegram bindings include the verified workspace/bot identity, room, thread or topic, exact adapter/session, and trusted sender. Merely posting a session ID remotely cannot create a binding. Their delivery records use local UUIDs, so provider message IDs cannot collide. Forwarded messages include `chat-ack` and `chat-reply` commands bound to the original delivery; replies continue to work after restart, are deduplicated, and refuse a changed bot account or trusted user. Unknown or archived sessions remain unavailable; channel input cannot create or unarchive sessions.

Saved tokens stay in private `state.json` (0600). Blank secret inputs retain saved values, clearing a provider stops only that connection, and all channel settings are editable only on this Mac. Configuration exports include saved channel credentials and the selected default, but never session bindings or message-delivery history. No bot account, real group, or external message is created by the automated tests.

## Web UI

Open `http://127.0.0.1:9417`. The layout follows the system's light or dark appearance without reloading and has a navigation column grouped by **message bridge** (run logs, routing sessions, agents) and **GitHub** (pull requests to our repositories, pull requests we sent upstream, followed repositories), with **设置** and module and connection status at its foot. The desktop window combines native window controls, the brand, page breadcrumbs, software updates, and refresh in one 52px title row. Logs and PR queues use bordered lists of two-line rows; subscriptions use a compact table with expandable source sessions. Segmented filters show counts; search and `/` focus the page's search field. Toolbars and settings reflow according to the available working width: narrow toolbars put filters above a shared search/action row, and field save actions remain next to their inputs. On narrow browser screens, primary navigation scrolls beside a fixed Settings entry, with settings pages in their own contextual row and the active destination kept visible. The desktop window keeps its sidebar and native title-row alignment.

The application supports English and Simplified Chinese, following the system or browser language by default and falling back to English for unsupported languages. **Settings · General · Language** offers **Follow system**, **简体中文**, and **English**. Changes apply immediately, including page titles, accessible labels, status messages, dates, relative times, and number/list formatting, while preserving filters and unfinished form input. Browser preferences are stored locally on each device; unavailable storage does not prevent switching for the current page. The desktop app persists its preference in its own app configuration directory and shares it with the native tray, updater controls, and offline page. The public website keeps its separate language preference.

The web catalog lives in `src/ui-i18n.ts`: Chinese source messages act as typed keys, with English translations and named interpolation parameters. Static markup uses explicit `data-i18n` markers; session names, messages, PR titles, raw diagnostic details, and agent prompt previews remain in their original language. Native strings and language preference handling live in `src-tauri/src/language.rs`; `desktop/` contains the offline page translations. Add a catalog entry for new interface copy and preserve its placeholders in every language. The desktop injects `window.__NOOTIFY_LANGUAGE__` before page JavaScript and replays it through the `nootify-language` event. Trusted service and offline pages can request one of the three fixed `nootify://language/system`, `nootify://language/zh-CN`, or `nootify://language/en` navigations; the shell cancels navigation and applies the preference without granting page IPC permissions.

The operational UI uses local system fonts with a fixed role scale: 16px page headings, 14px primary content and field names, a 13px control/body baseline, and 12px metadata. Numeric counters and progress use tabular figures; code previews use the same local monospace family as IDs. Explanatory paragraphs have a constrained reading measure and more leading without changing the compact list line boxes.

Log rows expand in place for full IDs, reasons, and message text; logs can be paused and the filtered set exported as NDJSON. The routing-session page displays only targets encountered by incoming messages or explicit sends, with their last lookup time and result. Refreshing it performs no client lookups. These are historical observations, not a live inventory.

The page polls a read-only snapshot every two seconds and needs no control token. It accepts loopback hosts or the Nootify node's Tailscale address, and same-origin requests only. The control API remains bearer-authenticated. Logs persist in the private `events.ndjson` file, capped at 1,000 entries; a first launch imports available JSON entries from the prior stdout log. Events explicitly distinguish `received`, `socket_written`, `ignored` with a reason, and failures. For accepted senders, message previews are limited to 240 characters; unknown fields and credentials are not logged. A successful socket write is not proof of model processing.

## Settings

**Settings** at the foot of the navigation opens eight pages. Service settings can be read over Tailscale, but changes are accepted only from this Mac: credentials and imports decide who can reach local sessions. The interface language is a local display preference and can be changed on each device.

| Page | Purpose |
| --- | --- |
| General | Selects the local interface language, including over Tailscale |
| GitHub | Signs Nootify in to GitHub with the device flow, and signs it out |
| 飞书 | Feishu App ID, App Secret, and recipient |
| Slack | Bot token, app-level token, destination channel, and trusted user |
| Telegram | Bot token, forum supergroup, and trusted user |
| Tailscale | Enroll Nootify as its own device, connect/disconnect, sign out, and copy its port-80 address |
| 导入导出 | Export and import the configuration |
| 关于 | App and service versions, update checks, and installation |

**GitHub** signs in through Nootify's own OAuth App with GitHub's device flow: the page shows a one-time code and link, the service polls until it is authorized, and pull requests refresh. The GitHub CLI is not used, so signing in or out never affects the `gh` login on this Mac. The token goes in the private `state.json`; it never reaches a page, a log, or an export, and the code is never sent to the Tailscale listener. The scopes are `repo` and `read:org`: OAuth has no read-only scope for private repositories, but the service only sends read-only queries. A rejected or missing token shows as signed out, while other failures, such as no network, show as unconfirmed. Until someone signs in, the PR pages keep their last data and say so, and subscriptions still come from local sessions. Signing out forgets the token here; revoke it under [GitHub's application settings](https://github.com/settings/applications) if it may have leaked.

`GITHUB_CLIENT_ID` in `src/github-auth.ts` defaults to Nootify's OAuth App (`Ov23liMl1ElZD0hh84y1`), with Device Flow enabled. Leave token expiration disabled until refresh-token support is implemented. Client IDs are public and this flow uses no client secret. `NOOTIFY_GITHUB_CLIENT_ID` overrides it for a directly launched service.

**飞书** asks Feishu for a tenant token before saving, so a mistyped ID or secret cannot replace a working bot. Saved credentials go in the private `state.json` and the bot reconnects in place: queued messages finish on the old client first. Connected requires both application credentials and a ready WebSocket connection; incomplete credentials show as unconfigured. The active secret appears as a mask, including credentials from the MCP file or environment. The eye button reveals it through an explicit same-origin, loopback-only POST; ordinary page data, logs, and Tailscale clients never receive it. A blank field retains the active application's secret, and leaving the Feishu page masks it again. Clearing saved credentials returns to the MCP file, or disables Feishu without one. `LARK_APP_ID` and `LARK_APP_SECRET` take precedence for their process, so saving is refused while they are set.

**导入导出** writes `exports/nootify-config-<time>.json` in the state directory, mode `0600`, keeping the newest ten. The file has the active Feishu credentials and recipient, saved Slack/Telegram configurations and the default channel, the pulls configuration and follow choices, Codex and OpenCode connections, and which agents are enabled. **It contains plaintext secrets, so it is only ever written to disk** and the page receives its path, because the page has no bearer token. The GitHub sign-in is not included.

Importing validates the whole file and previews what it will change, without showing secrets, before anything is applied. An import replaces only the settings its file names: follow choices are replaced as a set, and agents listed in the file are enabled but none are disabled. Imported Feishu credentials are not checked against Feishu, so a Feishu-only import works offline; a failed connection shows on the page. Slack and Telegram configurations are verified against their providers before replacing a working connection. A newer file version is refused.

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

**设置 · Tailscale** enables an **independent Nootify device**, powered by the bundled official `tailscale.com/tsnet` library. No system Tailscale app, daemon, CLI, Serve configuration, administrator privileges, or host port-80 binding is required. The device is named `nootify` (Tailscale may assign a suffix to make the name unique). It has its own tailnet IP, MagicDNS name, account, and keys; an existing Tailscale installation on this Mac is untouched.

The node is **off by default**. Enable it or choose **启用并登录**, then follow the official browser authorization link. The link is visible only on the local settings page and opens only `https://login.tailscale.com/a/…`. Once authorized, Nootify appears as a separate device in the user's tailnet. Tailnet administrators may need to approve it. The embedded node listens on its own TCP port 80, so its address is `http://100.x.y.z/`, or its MagicDNS name, without a port suffix.

Turning the switch off takes only the Nootify node offline and closes active connections; it preserves enrollment for the next connection. **退出登录** logs out this device and disables it. Persistent keys are under the private `tailscale/` directory in Nootify's state directory, separate from system Tailscale. Neither keys nor the enabled setting are included in configuration exports/imports. The sidecar receives a restricted environment so ambient Tailscale auth keys, OAuth credentials, and control-server overrides cannot silently enroll it. It exclusively locks its persistent identity, reports safe startup causes through a private handshake, and exits on stdin EOF or service shutdown. Relative service state paths are resolved before launching it. An explicit login retry can renew an expired authorization link.

The embedded node forwards accepted connections to a private loopback backend using a bounded PROXY v1 prefix derived from the actual peer socket. Peer identity is resolved through this embedded node's LocalAPI, never through HTTP headers or system Tailscale. Host/origin checks accept only the Nootify device's own names and addresses. By default only devices owned by the same login are allowed; tagged devices and other users are rejected. `NOOTIFY_TAILNET_USERS` can specify allowed logins. Settings and agent edits remain local-only; control APIs still require the bearer token. Nootify's node exposes only its own port 80, not host preview servers or files on other ports. Managed agent instructions explicitly require a separately verified sharing endpoint for those resources. HTTP header/body deadlines remain active across the proxy boundary, transient status failures receive bounded retries without immediately disconnecting a healthy node, and repeated identical failures do not displace message history.

Source builds require the Go version pinned in `native/tailscale/go.mod`. `npm run tailscale:build` builds the sidecar without connecting or enrolling a device; desktop staging includes it and its dependency licenses. `NOOTIFY_TSNET_BIN` can point at a development/test helper, never a system Tailscale CLI.

## TypeScript client and module API

```typescript
import { NootifyClient } from './dist/src/client.js';

const client = new NootifyClient({ baseUrl: 'http://127.0.0.1:9417', token });
const encountered = await client.listSessions(); // Memory only; does not enumerate clients.
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
| `GET /ui/api/settings`, `GET /ui/api/settings/github` | Settings page data and the GitHub account; neither carries a secret |
| `POST /ui/api/settings/lark`, `POST /ui/api/settings/recipient` | Save `{"app_id", "app_secret"}`, clear with `{"clear": true}`, or set `{"open_id"}`; these and the actions below need the UI header and the loopback listener |
| `POST /ui/api/settings/lark/secret` | Reveal the active Feishu credentials only when the local eye button is clicked; response is never cached or available over Tailscale |
| `POST /ui/api/settings/slack`, `POST /ui/api/settings/telegram` | Verify and save bot credentials, destination and trusted user, or clear with `{"clear": true}`; local UI only |
| `POST /ui/api/settings/channel` | Set the default notification provider with `{"channel": "feishu" \| "slack" \| "telegram"}`; local UI only |
| `POST /ui/api/settings/github/login` | `{"action": "start" \| "cancel" \| "sign-out"}` for the device login |
| `GET /ui/api/settings/tailscale` | Connection, remote-access state and URL; login URLs are omitted over Tailscale |
| `POST /ui/api/settings/tailscale` | `{"action": "enable", "enabled": true}` or `{"action": "login" \| "cancel" \| "logout"}` for the independent node; local UI only |
| `POST /ui/api/settings/export`, `POST /ui/api/settings/reveal` | Write a configuration file and return its path; show it in Finder |
| `POST /ui/api/settings/import` | Preview `{"document"}`, or apply it with `"apply": true` |
| `GET /v1/agents`, `PUT /v1/agents/:agent` | The same for token-authenticated clients |
| `POST /v1/threads` | Find or create a session's group/thread/topic: `{"adapter", "session_id", "session_name", "channel"?}` |
| `POST /v1/threads/:session_id/messages` | Post `{"text", "adapter"?, "channel"?}` to that destination, prefixed with the session name |
| `POST /v1/chat/messages/:id/ack`, `POST /v1/chat/messages/:id/reply` | Acknowledge or reply to an original Slack/Telegram delivery by its local UUID |
| `GET /v1/lark/recipient`, `PUT /v1/lark/recipient` | Read or set the Feishu recipient's open_id |
| `GET /v1/sessions` | In-memory routing observations; never queries clients |
| `PUT /v1/backends/:adapter` | Configure an existing local Codex or OpenCode endpoint |
| `PUT /v1/sessions/:id` | Register/update an inbox from an authorized local client |
| `POST /v1/sessions/:id/messages` | Send attributed text to a registered inbox |
| `POST /v1/lark/messages/:id/ack` | Record the target session's acknowledgment |
| `POST /v1/lark/messages/:id/reply` | Send a bot reply to that original Feishu message |
| `GET /v1/lark/bindings` | List group-to-session bindings |
| `PUT /v1/lark/bindings/:chat_id` | Create/reuse a fixed binding message or announcement |

## Files

| File | Purpose |
| --- | --- |
| `src/server.ts` | Loopback and Tailscale HTTP listeners, authentication, lifecycle |
| `src/tailnet.ts` | Tailscale address discovery and peer identity checks |
| `src/tailscale.ts` | Independent Nootify node settings, enrollment, logout and lifecycle |
| `src/tsnet-client.ts` | Private bounded RPC to the bundled Tailscale sidecar |
| `native/tailscale/` | Embedded tsnet client, userspace port 80 and socket-derived peer forwarding |
| `src/tailnet-proxy.ts` | Private loopback backend and bounded PROXY v1 peer parsing |
| `src/github.ts`, `src/github-api.ts`, `src/github-model.ts` | Background GraphQL queries with the saved token, classification, sorting, follow choices, private cache |
| `src/conversations.ts` | Individual Claude, Codex and OpenCode sessions, repository anchors, and explicit PR associations |
| `src/types.ts` | Public request/response and module contracts |
| `src/client.ts` | Typed client for other TypeScript tools |
| `src/state.ts` | Private local session and binding persistence |
| `src/sessions.ts`, `src/local-sessions.ts` | Lazy dispatch, encountered targets, and targeted Claude lookup |
| `src/external-sessions.ts`, `src/codex-rpc.ts` | Targeted Codex/OpenCode lookup and client input transports |
| `src/events.ts`, `src/ui.ts`, `src/ui-app.ts`, `public/` | Persistent bounded logs and the read-only browser UI |
| `src/lark.ts`, `src/lark-metadata.ts` | Feishu WebSocket and binding metadata module |
| `src/launchd.ts`, `src/cli.ts` | LaunchAgent installation, acknowledgments, replies, and local control commands |
| `src/lark-replies.ts` | Forwarding context, receipt tracking, and deduplicated Feishu replies |
| `src/lark-threads.ts` | One Feishu group per agent session: lookup, adoption, creation, progress messages |
| `src/chat-transport.ts`, `src/chat-service.ts` | Channel contracts, account-qualified session bindings, receipts, reply deduplication, and channel-neutral thread routing |
| `src/slack.ts`, `src/telegram.ts` | Slack Socket Mode and Telegram forum-topic long polling, provider validation and plain-text transport |
| `src/agents.ts` | Marked notification-channel instructions in each agent's global prompt file |
| `src/settings.ts`, `src/github-auth.ts` | Settings pages' actions: Feishu credentials, configuration export and import, GitHub device login and sign-out |
| `src-tauri/`, `desktop/`, `scripts/desktop.mjs` | Native window, tray, offline view, and desktop build launcher |
| `scripts/stage-service.mjs` | Stage the service, dependencies, and both bundled runtimes |
| `scripts/build-tsnet.mjs` | Build and verify the independent Tailscale sidecar and collect dependency licenses |
| `src-tauri/src/update.rs` | GitHub Release checks and signature-verified updates from the tray and the page |
| `.github/workflows/` | macOS checks and version-tag-driven DMG/updater publication |
| `test/` | Disposable HTTP/socket/state and routing tests |

Official references: [Feishu Node SDK](https://github.com/larksuite/node-sdk), [message receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive), [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [Telegram Bot API](https://core.telegram.org/bots/api), and [Claude Code inbox sockets](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).
