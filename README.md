# Nootify

A general-purpose local **TypeScript service host**, managed as a per-user macOS LaunchAgent. Session messaging and Feishu are separate modules. Other TypeScript tools use the exported typed HTTP client; future services implement the same module interface. This is not a standalone Lark-only daemon.

The HTTP listener binds to `127.0.0.1:9417`, plus this computer's Tailscale IPv4 address on the same port for the owner's other devices. Open either address for message-bridge logs, **encountered routing targets**, and the two GitHub pull-request queues. `/health` and the read-only `/ui/*` page data are available to permitted browsers; every `/v1/` control endpoint requires the per-user bearer token on both listeners. Host/origin checks prevent cross-site reads and DNS rebinding. The service routes input to existing Claude, Codex, or OpenCode clients rather than calling a model API directly.

Lookup is lazy: startup and UI polling never enumerate client sessions or connect to a client backend. Only a message with a concrete adapter and session ID invokes that adapter's lookup. The page lists at most 1,000 targets actually encountered during this process lifetime, including missing/archived/unavailable results. It does not preload registrations or local history.

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

The native macOS **Nootify** app opens the existing web UI in a dark native window and provides a menu-bar tray. PR rows open GitHub in the default browser; the window itself cannot navigate elsewhere. The tray restores the window, reports daemon/module health, and can start or restart the already installed `dev.idy.nootify.service` launchd job. Closing the window hides it; quitting the desktop app leaves the independent daemon running. A single-instance guard focuses the existing app instead of creating another tray icon.

Build requirements are Rust, Xcode command-line tools, and the npm dependencies above. The build helper finds Rust under `CARGO_HOME/bin` or `~/.cargo/bin` without changing global settings.

```bash
npm run desktop:dev
```

```bash
npm run desktop:build
```

The macOS bundle is produced at `src-tauri/target/release/bundle/macos/Nootify.app`. Install the independent service first using the next section. The native app is a desktop front end for that service; it does not bundle a second Node process or copy credentials. If the service is unavailable, it shows a bundled offline page. The local web page receives no native Tauri IPC capabilities.

## Install the independent service

```bash
node dist/src/cli.js launchd-install --mcp-config ~/.claude.json
```

The installer creates `~/Library/LaunchAgents/dev.idy.nootify.service.plist` and loads it into the current user's GUI launchd domain. It uses an absolute Node executable and compiled server path, launches at login, and restarts on failure. No root privileges are needed. The checkout must remain at its installed path; build and reinstall after moving it.

Feishu credentials may come from the explicitly selected `mcpServers.lark` MCP configuration, or `LARK_APP_ID`/`LARK_APP_SECRET` when running directly. A launchd job does not inherit your interactive shell environment: use the MCP-config option for the installed service. Omitting Feishu configuration leaves that module disabled while the other services remain available.

The default private state directory is `~/.local/state/nootify/`. It contains the HTTP authentication token, registered sessions/bindings, and logs. The state directory is private, and credential-bearing files use mode `0600`. Session inbox tokens must be registered with the independent daemon; they are stored only in this private state, never in the repository, group messages, or logs. HTTP responses list public session information without socket credentials.

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

## Agents and Feishu updates

The **Agents** page lists Claude Code (`~/.claude/CLAUDE.md`, honoring `CLAUDE_CONFIG_DIR`), Codex (`~/.codex/AGENTS.md`, honoring `CODEX_HOME`) and OpenCode (`~/.config/opencode/AGENTS.md`, honoring `XDG_CONFIG_HOME`). Ticking an agent appends a short Feishu section to its global prompt file between `<!-- nootify:begin -->` and `<!-- nootify:end -->`; unticking removes it. Nothing outside the markers changes, symlinked prompt files are edited at their target, the previous file is copied to `agent-backups/` in the state directory (last ten per agent), and files with unbalanced markers are left alone. "Needs update" means the block differs from what this installation would write, for example after the app moved. Prompts can only be changed from this Mac; over Tailscale the page is read-only.

The section tells new conversations to use two commands, which find the calling session from the variables each client sets (`CLAUDE_CODE_HOST_SESSION_ID` for Claude Desktop, `CLAUDE_CODE_SESSION_ID` for the Claude Code CLI, `CODEX_THREAD_ID` for Codex). OpenCode does not export its session ID, so its section asks for `--session-id ses_…`.

```bash
node dist/src/cli.js thread-open --agent claude --session-name "Fix login"
```

```bash
node dist/src/cli.js thread-send --agent claude --text "Tests pass; opening the PR next"
```

`thread-open` reuses the session's group if Nootify knows one or finds one among the bot's groups whose name carries the session's short ID and whose announcement names the session; otherwise it creates `<task> · <client> · <short ID>`, invites the recipient, and writes the routing token to the announcement. `thread-send` posts `[session name] text`; use `--text-file -` for multi-line text. Replies in that group are routed back like any other bound group.

The recipient is the Feishu user who is invited to new groups and trusted as their sender. It is the open_id saved with the command below, else `LARK_NOTIFY_OPEN_ID`, else the single sender shared by existing bindings:

```bash
node dist/src/cli.js lark-recipient --open-id ou_example
```

Group creation needs the bot's chat-creation permission (`im:chat:create` or `im:chat`), adoption needs `im:chat:readonly`, and progress messages need `im:message:send_as_bot`. Codex runs commands in a sandbox: the CLI needs local network access to `127.0.0.1:9417`, so Codex may ask to run it outside the sandbox. Feishu is the only channel today; the thread commands are channel-neutral so that Slack and others can be added behind them.

## Web UI

Open `http://127.0.0.1:9417`. The dark layout has a navigation column grouped by **message bridge** (run logs, routing sessions, agents) and **GitHub** (pull requests to our repositories, pull requests we sent upstream, followed repositories), with module and connection status at its foot. Each page uses one bordered list of two-line rows: the primary text, a dot-separated metadata line, and status on the right. Segmented filters show counts; search and `/` focus the page's search field. On narrow screens the navigation becomes a scrolling top bar.

Log rows expand in place for full IDs, reasons, and message text; logs can be paused and the filtered set exported as NDJSON. The routing-session page displays only targets encountered by incoming messages or explicit sends, with their last lookup time and result. Refreshing it performs no client lookups. These are historical observations, not a live inventory.

The page polls a read-only snapshot every two seconds and needs no control token. It accepts loopback hosts or this computer's Tailscale address, and same-origin requests only. The control API remains bearer-authenticated. Logs persist in the private `events.ndjson` file, capped at 1,000 entries; a first launch imports available JSON entries from the prior stdout log. Events explicitly distinguish `received`, `socket_written`, `ignored` with a reason, and failures. For accepted senders, message previews are limited to 240 characters; unknown fields and credentials are not logged. A successful socket write is not proof of model processing.

## GitHub pull requests

Two Open/Draft queues are queried live from GitHub through the authenticated `gh` CLI (read-only; nothing is created, commented on, or updated):

| Page | Contents |
| --- | --- |
| 我们仓库的 PR | PRs by anyone, to repositories owned by the signed-in account or its internal organizations, including repositories not cloned locally |
| 提交上游的 PR | Cross-repository PRs from our accounts or forks to external upstreams |

Both default to the **least recently updated first**; the sort toggle reverses it. "Needs follow-up" means failed CI, requested changes, a merge conflict, or a non-draft PR untouched for 14 days. Rows show the target `owner/repo#number`, author, relative update time, review decision, and CI/conflict state.

Refreshes run in the background every five minutes and from the page's refresh button. A request only starts or joins the running refresh and returns immediately; the page keeps showing the previous data and updates when it finishes. A failed refresh keeps the last good snapshot and says so. The snapshot is cached privately in `pulls-cache.json` in the state directory, so a restart shows the last data at once. Coverage limits (search caps, private or SSO visibility, scan depth) are listed under the collapsed "data scope" details. Routine successful refreshes are not written to the run log; only changes in outcome are.

### Followed repositories

The 关注的仓库 page lists every repository found in local agent conversations or in either queue, with a checkbox. Both PR pages show only followed repositories and say how many PRs are hidden. Each refresh reads conversation metadata only, never message text:

| Agent | Source |
| --- | --- |
| Claude | The `cwd` recorded at the top of the newest transcript in each `~/.claude/projects/*` folder (honoring `CLAUDE_CONFIG_DIR`); folders that keep only `memory/` are decoded back to their path |
| Codex | `cwd` and `git_origin_url` per thread in the latest `state_*.sqlite` under `CODEX_HOME` |
| OpenCode | `directory` per session in `opencode.db` (or the older JSON session files) under `$XDG_DATA_HOME/opencode` |

The GitHub remotes of those directories name the repositories; an `upstream` remote also adds that repository to the outgoing-PR scan, like the disk scan does. Without an explicit choice, a repository is followed when it appears in a conversation or has an open PR by our accounts. Ticking or unticking stores a choice in the private `repo-preferences.json`; choosing the automatic value again removes the choice. Set `"followDefault": "all"` in the pulls configuration to follow every repository by default instead.

Configuration is re-read on each refresh, first found wins: `NOOTIFY_PULLS_CONFIG`, then `pulls.config.json` in the state directory. Fields are `authors`, `ownedOwners`, `upstreamOwners`, `excludeRepositories`, `scanRoots`, and `followDefault`. Organization membership counts as internal unless the organization is listed in `upstreamOwners`. Set an absolute `GH_BIN` if `gh` is not in Homebrew or a standard location; the launchd job does not inherit your shell's `PATH`.

## Tailscale access

When Tailscale is running, the service also listens on this Mac's Tailscale IPv4 address, for example `http://100.x.y.z:9417/`. It follows the address if Tailscale restarts and logs when the listener starts or fails. The sidebar shows the address on the local page. MagicDNS names work too, if MagicDNS is enabled for the tailnet.

Every request on that listener must use this computer's Tailscale name or address as `Host`, and come from a device whose Tailscale identity is allowed. Identity comes from `tailscale whois` on the connecting address, not from request headers. By default only the login that owns this Mac is allowed; tagged devices and other users are rejected. Set `NOOTIFY_TAILNET_USERS` to a comma-separated list of logins to change that. Page data and the background PR refresh are available; control APIs still require the bearer token.

The macOS app binary is used as the CLI with `TAILSCALE_BE_CLI=1`, because launchd jobs have no terminal. Set `TAILSCALE_BIN` for another installation. Tailscale Serve is not used: with MagicDNS disabled, Serve can only be reached by host name, not by IP.

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
| `GET /v1/agents`, `PUT /v1/agents/:agent` | The same for token-authenticated clients |
| `POST /v1/threads` | Find or create a session's Feishu group: `{"adapter", "session_id", "session_name"}` |
| `POST /v1/threads/:session_id/messages` | Post `{"text"}` to that group, prefixed with the session name |
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
| `src/github.ts`, `src/github-api.ts`, `src/github-model.ts` | Background GitHub queries, classification, sorting, follow choices, private cache |
| `src/conversations.ts` | Working directories of local Claude, Codex and OpenCode conversations |
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
| `src/agents.ts` | Marked Feishu section in each agent's global prompt file |
| `src-tauri/`, `desktop/`, `scripts/desktop.mjs` | Native window, tray, offline view, and desktop build launcher |
| `test/` | Disposable HTTP/socket/state and routing tests |

Official references: [Feishu Node SDK](https://github.com/larksuite/node-sdk), [message receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive), and [Claude Code inbox sockets](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).
