# Nootify product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner of a Windows or macOS computer follows local coding-agent conversations, receives their progress in Feishu, and sends replies back to the addressed conversation. They also track pull requests associated with those conversations and repositories.

## Product Purpose

Nootify connects existing local agent sessions to notification providers and keeps their related GitHub pull requests in view. Notification-session creation does not create, unarchive, or take over a native agent conversation. Nootify routes input to existing clients rather than calling a model API itself.

## Positioning

An agent session is the business identity. Platform groups and topics are private provider implementation details. Multiple named Feishu and Remote Nootify providers share the same session, metadata, sending, reply, acknowledgment, and deletion model. A message retains its original return route across Nootify nodes.

## Operating Context

The application ships as one Go executable with background-service, CLI, and Go/MyGo desktop modes. The Go backend directly owns the HTTP API, agent transports, session discovery, repository tracking, settings, notification core, and direct LAN HTTP access. TypeScript is limited to the browser UI, which is compiled and embedded during the build; the installed application does not use a Node runtime or notification sidecars.

The desktop uses the system WebView on Windows and macOS. The browser UI shares its design language across those platforms, while the window, tray, menus, keyboard shortcuts, and updater use native platform behavior. Closing the window hides it; quitting the desktop leaves the independently managed Go background job running.

The everyday tray menu contains Open Nootify, one application status, Software Updates, Settings, and Quit Nootify. Available updates may add their direct install action. Background-service and module/start/restart/install controls do not belong in this everyday menu; automatic lifecycle handling and advanced CLI controls remain available.

## Capabilities and Constraints

### Provider and session model

The owner adds named providers on their computer: a Feishu bot with a trusted recipient, or a Remote Nootify connection. Feishu credentials belong to each provider instance. Other Nootify nodes can subscribe through authenticated gRPC. Each node first tries the addressed local session and independently broadcasts unmatched events to subscribed downstreams.

Providers implement idempotent session creation, metadata access, deletion, rich-text messaging, replies, and event subscription. A remote provider forwards those operations without changing the originating session identity. Locally owned failures are distinct from unmatched events. Each downstream has independent acknowledgment and durable replay state.

Local adapters address existing Claude, Codex, and OpenCode sessions through their supported input transports. Trae and WorkBuddy use explicitly polled inboxes; those inboxes cannot wake an idle or closed conversation. A transport write is not proof that an agent processed a message, and receipt of a message does not approve a permission request.

PR subscriptions come from structured session associations, repository anchors, explicit PR links, and saved follow choices. Message text and an account-wide repository inventory are not subscription evidence. Failed refreshes retain the previous snapshot and expose their outcome.

### Local authority

Provider mutations, settings, agent-prompt edits, secret reveal, and contact directories require local access from an actual loopback peer. The HTTP service listens on all IPv4 interfaces (`0.0.0.0:9417` by default), accepts loopback and private LAN peers, and checks the Host against its own interface addresses or system hostname and service port. Origin/fetch-site checks remain enforced. LAN browser access is read-only except repository follow choices and PR refresh; bearer-authenticated `/v1/` APIs allow private LAN callers, with remote identity management restricted to loopback. Desktop gateway API traffic uses authenticated encryption; direct LAN HTTP is plaintext. Nootify does not manage a VPN device or alter the operating system's Tailscale installation.

### Application workflows

The message-bridge navigation includes Logs, Routed sessions, Providers, and Agents. Repository navigation is grouped under Repos. Providers uses a card list with an upper-left Add action; an empty list keeps its explanatory card. Adding opens a provider-type chooser followed by its configuration dialog; editing uses the configuration dialog. Remote access settings configure the listener and show connected Nootify nodes.

### Feishu recipient selection

Use a focused searchable dialog, not a full-width native multi-row select. Provider-returned avatars and the nickname plus default name lead; names already containing the alias are preserved without duplicate formatting. Missing or unavailable avatars use an initial fallback. The current recipient is identified clearly, and long open_ids remain secondary. Rows change a draft selection. Only the visible confirmation action persists it. Keep manual ID entry available.

Useful contacts appear while the directory is still loading. Reuse existing row and avatar nodes, preserve the visible scroll anchor, and update selection without rebuilding the list. Cache completed results in private credential-scoped local storage: reuse fresh data for 15 minutes and show data up to 24 hours old while refreshing in the background. Bound requests and cancel pending work when the picker closes. A partial directory remains usable and explains missing access.

On permission failure, show the provider's specific scopes, an official application-console link, a locally generated QR, and retry. Ordinary user scanning does not grant application permissions. Administrators may need to publish a version and obtain approval; contact visibility is a separate setting.

## Brand Commitments

Preserve the penguin identity, compact neutral settings, blue action color, and system light/dark appearance. Support Simplified Chinese and English. Web navigation and the brand use Montserrat; web content uses Lato with the established system Chinese fallbacks. Native menus retain platform typography and behavior. The detailed visual contract belongs in `DESIGN.md`.

Web dropdowns use the existing authored component, with keyboard selection, visible selected state, and no operating-system select popup. Preserve the shared content-column alignment and the existing provider/dialog behavior rather than introducing a new visual world.

## Evidence on Hand

The implemented Go runtime lives under `internal/` and `native/core/`; the native shell and tray live under `desktop/`. Browser UI source is in `src/`, with HTML/CSS and embedded assets in `public/`. The penguin mark is `desktop/brand.svg`.

Durable validation includes Go tests under `internal/host/`, `internal/bridge/`, `internal/providers/`, `internal/pulls/`, `internal/settings/` and `native/core/`; browser regressions are under `test/`. `desktop/smoke.go` exercises the actual native tray, language changes, window lifecycle, and update bridge. `integration/headless.test.mjs` exercises real Go CLI/HTTP/gRPC processes with a synthetic upstream bot.

Use clearly identified synthetic contacts for general previews. Label read-only live profile checks separately and limit them to the profile needed for verification. Aggregate live diagnostics report counts and timings rather than bulk contact identities or credentials. The recipient component's contract remains `.impeccable/surfaces/feishu-recipient.md`.

## Product Principles

- Address the existing conversation and preserve its identity and archive state.
- Preserve the original message return route, durable delivery evidence, and independent downstream progress.
- Distinguish transport acceptance, explicit acknowledgment, and actual replies.
- Keep privileged local changes with the verified owner of the computer.
- Keep everyday controls focused on user tasks rather than runtime implementation details.

## Accessibility & Inclusion

Retain keyboard operation, visible focus, explicit selection and confirmation, focus restoration, and reduced-motion behavior. Acceptance covers desktop and 375px browser layouts, both languages and appearances, incremental directory results, valid QR destinations, permission retry, and local-only access.
