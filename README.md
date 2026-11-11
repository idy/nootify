# Nootify

Follow your coding agents from Feishu and send replies back to
the matching conversation on your computer. Nootify is a Windows and macOS tray
app that also keeps your GitHub pull requests in view. Connect a Feishu bot
directly or use another Nootify node as your notification provider.

[Website](https://nootify.idy.dev/) · [Download](https://github.com/idy/nootify/releases/latest) · [Setup guide](docs/guide.md#agents-and-notification-channels) · [Discord](https://discord.gg/JMJZ4mDcc4)

## What it does

- Gives each agent session its own notification destination, such as a Feishu group.
- Supports multiple named channels over two provider types: **Feishu** over
  WebSocket and **Remote Nootify** over authenticated gRPC. Feishu channels use
  manually configured bots or personal apps authorized through QR registration.
- Discovers eligible existing conversations locally and backfills missing
  notification destinations.
- Routes replies to existing Claude Code, Codex, and OpenCode sessions, preserving
  the original message's return path across Nootify nodes.
- Supports plain text and rich text; explicit session acknowledgments add a
  receipt reaction in Feishu.
- Supports Trae and WorkBuddy through an inbox they check at work milestones;
  it cannot wake an idle or closed conversation in those clients.
- Shows pull requests from your projects and contributions, including review,
  CI, and merge-conflict status.
- Keeps routing state and credentials in a local background service.

## Install

Download the installer for your computer from [GitHub Releases](https://github.com/idy/nootify/releases/latest).

| Platform | Installation |
| --- | --- |
| macOS 13.5+, Apple Silicon | Open the DMG, drag Nootify into Applications, and launch it. |
| Windows 10/11, x64 | Run the `-setup.exe` installer for your user account. |

macOS users can also use the [Homebrew tap](https://github.com/idy/homebrew#install).
The app is one Go executable containing the service, CLI, MyGo desktop host,
notification core, and direct LAN HTTP access. TypeScript is used only for the
browser UI; the installed app needs no Node.js runtime. Current macOS packages are ad-hoc signed and not notarized;
Windows installers are not code-signed.

## Get started

1. Open **Channels** and choose **Feishu Bot** (enter App ID, App Secret, and
   trusted recipient's `open_id`), **Feishu personal app** (scan to authorize), or
   **Remote Nootify** (server address, token, and TLS settings). Personal-app
   authorization saves a separate channel without replacing existing channels.
   Enable the connection and choose your default channel.
2. On the **Agents** page, enable the clients you use. Codex Desktop connects
   automatically on macOS; configure an existing Codex app-server or OpenCode
   connection when needed.
3. Start a new agent conversation. It receives instructions to open its
   notification session and post progress; reply there to continue the conversation.

For browser access from another device, use the sidebar LAN link, normally
`http://<LAN-IPv4>:9417/`; see [LAN access](docs/guide.md#lan-access).

To serve other Nootify nodes, configure the listener under **Settings → Remote
access** (`远程接入`). Personal apps can be reconnected, reauthorized for the same App ID, and checked
for required permissions from their channel editor. The legacy settings route
remains available for older integrations.

Your computer, local service, and target session must remain available. A delivered
reply does not automatically approve a permission request.
See the [setup guide](docs/guide.md#agents-and-notification-channels) for bot
permissions and client connections.

## Community

Join the [Nootify channel in IDY Community](https://discord.gg/JMJZ4mDcc4) to ask
questions, share workflows, and suggest improvements. Use the community's
**ideas** and **bug-reports** forums with the **Nootify** tag to track feedback.
Reproducible bugs can also be filed as [GitHub issues](https://github.com/idy/nootify/issues).

## Development

Requires the Go toolchain pinned in root `go.mod`, plus Node.js and npm to compile
and test the browser UI. Node.js is a build tool only. From the repository root:

```sh
npm ci
npm run build
npm run check
npm test
go test ./...
```

Build the executable or open the development desktop:

```bash
go build -o build/nootify ./desktop
```

```bash
npm run desktop:dev
```

The same executable provides the native desktop, CLI commands, and `serve` mode.
For an isolated background service without installing a system job:

```bash
./build/nootify serve --state-dir .cache/development-state --port 9419
```

```bash
npm run test:integration
```

The Go backend directly calls the notification core. It owns HTTP authentication, SQLite state, agent input adapters,
session discovery, PR tracking, settings, CLI commands, and service management.
There are no Node or notification-core child processes. The MyGo
window owns its trusted asset/authorization handler in process; it never launches
a separate UI service. Closing the window hides it, and the independently managed
Go background job continues receiving notifications.

Integration tests use temporary private state, ephemeral listeners, and synthetic
network boundaries. They do not change system jobs or use production credentials.
Native smoke checks are separate.

For an isolated synthetic browser preview of the application UI:

```bash
npm run preview:ui
```

The fixture provides synthetic channels, sessions, logs, repositories, and
contacts. Preview edits are temporary; personal-app QR authorization is simulated
and never grants a real Feishu app. Real OAuth, provider connections, and filesystem
actions are unavailable. Use the local URL printed by the preview command.
The fixture is separate from the installed Go service; preview results do not
verify native asset embedding, authenticated transport, or desktop behavior.

The frontend uses [Magpie Design System v0.4.1](https://github.com/idy/magpie-design-system/tree/v0.4.1),
vendored in `public/vendor/magpie/` with its fonts, icons, and licenses. Resources
are served locally for offline use and strict CSP. `public/styles.css` owns
Nootify's route layouts and domain-specific list/dialog composition; shared
controls use the upstream `mds-*` classes. See [shared UI controls](docs/ui-components.md).

The Go core owns provider connections, notification-session mappings, and durable
delivery/replay state. Production Feishu ingestion uses WebSocket events, with
finite startup/reconnect history reconciliation rather than scheduled polling.

The desktop shell uses [MyGo](https://github.com/egoist/mygo) with the system
WebView. Rust and Cargo are not required.
See [desktop builds](docs/guide.md#build-the-desktop-app).

| Path | Contents |
| --- | --- |
| `internal/host/`, `internal/app/` | Unified Go HTTP service and CLI entry point |
| `internal/providers/`, `native/core/` | Direct notification dispatch, Feishu WebSocket, remote gRPC, durable delivery state |
| `internal/bridge/` | Agent transports, targeted lookup, prompt instructions, cooperative inboxes |
| `internal/storage/`, `internal/events/` | Compatible SQLite persistence and bounded private logs |
| `internal/pulls/`, `internal/settings/` | PR discovery/tracking, native OAuth/setup flows, configuration and contacts |
| `internal/webui/` | Trusted UI assets, owner proof and encrypted framing in Go |
| `internal/service/` | Owned LaunchAgent/Scheduled Task management and legacy installation migration |
| `src/` | Browser UI TypeScript and browser-only API declarations |
| `public/` | HTML/CSS and compiled assets embedded in the executable |
| `desktop/` | MyGo window, tray, updater, installer helper and offline assets |
| `site/` | Public website |
| `test/` | Browser/UI regression tests |

## Documentation

- [Setup and notification channels](docs/guide.md#agents-and-notification-channels)
- [Providers and remote nodes](docs/guide.md#providers-and-remote-nodes)
- [Provider core protocol](docs/provider-protocol.md)
- [Client connections and input transports](docs/guide.md#agent-input-transports)
- [Settings and troubleshooting](docs/guide.md#settings)
- [Shared UI controls](docs/ui-components.md)
- [LAN access](docs/guide.md#lan-access)
- [HTTP service API](docs/guide.md#http-service-api)
- [Website preview and deployment](docs/guide.md#project-website)
- [Builds, updates, and releases](docs/guide.md#mygo-desktop-application-and-system-tray)

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses;
see [third-party notices](docs/guide.md#license).
