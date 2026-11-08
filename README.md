# Nootify

Follow your coding agents from Feishu and send replies back to
the matching conversation on your computer. Nootify is a Windows and macOS tray
app that also keeps your GitHub pull requests in view. Connect a Feishu bot
directly or use another Nootify node as your notification provider.

[Website](https://nootify.idy.dev/) · [Download](https://github.com/idy/nootify/releases/latest) · [Setup guide](docs/guide.md#agents-and-notification-channels) · [Discord](https://discord.gg/JMJZ4mDcc4)

## What it does

- Gives each agent session its own notification destination, such as a Feishu group.
- Supports multiple named instances of two provider types: **Feishu bot** over
  WebSocket and **Remote Nootify** over authenticated gRPC.
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
The app includes its service, Node.js runtime, Go notification core, and embedded
Tailscale helper. Current macOS packages are ad-hoc signed and not notarized;
Windows installers are not code-signed.

## Get started

1. Open **Providers** and add a **Feishu bot** with its App ID, App Secret, and
   trusted recipient's `open_id`, or a **Remote Nootify** with its server address,
   token, and TLS settings. Enable the instance and choose your default provider.
2. On the **Agents** page, enable the clients you use. Codex Desktop connects
   automatically on macOS; configure an existing Codex app-server or OpenCode
   connection when needed.
3. Start a new agent conversation. It receives instructions to open its
   notification session and post progress; reply there to continue the conversation.

To serve other Nootify nodes, configure the listener under **Settings → Remote
access** (`远程接入`). The legacy personal-app QR setup remains linked from the
Feishu provider editor for migration.

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

Requires Node.js 22.13+, npm, and the Go versions pinned in `desktop/go.mod`,
`native/core/go.mod`, and `native/tailscale/go.mod`. From the repository root:

```sh
npm ci
npm run core:build
npm run check
npm test
npm run core:test
npm run desktop:test
```

The Go core owns provider connections, notification-session mappings, and durable
delivery/replay state. The Node service starts it through private stdio RPC and
retains the TypeScript UI, agent input adapters, local session discovery, GitHub
integration, and desktop lifecycle. Production Feishu ingestion uses WebSocket
events; it does not run the legacy history poller.

The desktop shell uses [MyGo](https://github.com/egoist/mygo) with the system
WebView. Desktop builds use Go and Node.js; Rust and Cargo are not required.
See [desktop builds](docs/guide.md#build-the-desktop-app).

| Path | Contents |
| --- | --- |
| `native/core/` | Go notification core: Feishu WebSocket, remote gRPC, sessions, and private durable JSON state |
| `src/provider-core.ts`, `src/providers.ts` | Private Node stdio bridge, provider control, and local agent delivery completion |
| `src/` | Local HTTP service, CLI, TypeScript UI, agent adapters, discovery, and GitHub integration |
| `native/tailscale/` | Embedded Tailscale identity, browser proxy, and core TCP tunnels/listeners |
| `public/` | Local application UI |
| `desktop/` | Go/MyGo desktop host, native tray, signed updater, and offline assets |
| `site/` | Public website |
| `test/` | Node integration and regression checks |

## Documentation

- [Setup and notification channels](docs/guide.md#agents-and-notification-channels)
- [Providers and remote nodes](docs/guide.md#providers-and-remote-nodes)
- [Provider core protocol](docs/provider-protocol.md)
- [Client connections and input transports](docs/guide.md#agent-input-transports)
- [Settings and troubleshooting](docs/guide.md#settings)
- [Tailscale remote access](docs/guide.md#tailscale-access)
- [TypeScript client and service API](docs/guide.md#typescript-client-and-module-api)
- [Website preview and deployment](docs/guide.md#project-website)
- [Builds, updates, and releases](docs/guide.md#mygo-desktop-application-and-system-tray)

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses;
see [third-party notices](docs/guide.md#license).
