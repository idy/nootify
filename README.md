# Nootify

Follow your coding agents from Feishu, Slack, or Telegram, and send replies back to
the matching conversation on your computer. Nootify is a Windows and macOS tray
app that also keeps your GitHub pull requests in view.

[Website](https://nootify.idy.dev/) · [Download](https://github.com/idy/nootify/releases/latest) · [Setup guide](docs/guide.md#agents-and-notification-channels) · [Discord](https://discord.gg/JMJZ4mDcc4)

## What it does

- Gives each agent conversation its own Feishu group, Slack thread, or Telegram topic.
- Routes replies to existing Claude Code, Codex, and OpenCode sessions.
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
The app includes its service and Node.js runtime. Current macOS packages are
ad-hoc signed and not notarized; Windows installers are not code-signed.

## Get started

1. Open Nootify and configure your bot and trusted recipient under
   **Settings → Feishu, Slack, or Telegram**.
2. On the **Agents** page, choose the notification channel and enable the clients
   you use. Configure the existing Codex or OpenCode connection when needed.
3. Start a new agent conversation. It receives instructions to open its group,
   thread, or topic and post progress; reply there to continue the conversation.

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

Requires Node.js 22.13+ and npm. From the repository root:

```sh
npm ci
npm run check
npm test
```

Desktop builds also require Rust, the Go version pinned in
`native/tailscale/go.mod`, and the platform's native toolchain.
See [desktop builds](docs/guide.md#build-the-desktop-app).

| Path | Contents |
| --- | --- |
| `src/` | Local service, CLI, chat transports, and agent adapters |
| `public/` | Local application UI |
| `src-tauri/`, `desktop/`, `native/` | Desktop app and bundled runtimes |
| `site/` | Public website |
| `test/` | Automated checks |

## Documentation

- [Setup and notification channels](docs/guide.md#agents-and-notification-channels)
- [Client connections and input transports](docs/guide.md#agent-input-transports)
- [Settings and troubleshooting](docs/guide.md#settings)
- [Tailscale remote access](docs/guide.md#tailscale-access)
- [TypeScript client and service API](docs/guide.md#typescript-client-and-module-api)
- [Website preview and deployment](docs/guide.md#project-website)
- [Builds, updates, and releases](docs/guide.md#tauri-desktop-application-and-system-tray)

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses;
see [third-party notices](docs/guide.md#license).
