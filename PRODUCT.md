# Nootify product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner of a Windows or macOS computer follows local coding-agent conversations, receives their progress in Feishu, and sends replies back to the addressed conversation.

## Product Purpose

Nootify connects existing local agent sessions to notification providers. Notification-session creation does not create, unarchive, or take over a native agent conversation. Nootify routes input to existing clients rather than calling a model API itself.

## Positioning

An agent session is the business identity. Platform groups and topics are private provider implementation details. Multiple named Feishu and Remote Nootify channels share the same session, metadata, sending, reply, acknowledgment, and deletion model. A message retains its original return route across Nootify nodes. Settings are an Operate surface: quick, familiar controls and an accurate explanation of connections, permissions, and routing matter more than visual expression.

## Operating Context

The application ships as one Go executable with background-service, CLI, and Go/MyGo desktop modes. The Go backend directly owns the HTTP API, agent transports, session discovery, settings, notification core, and direct LAN HTTP access. TypeScript is limited to the browser UI, which is compiled and embedded during the build; the installed application does not use a Node runtime or notification sidecars.

The desktop uses the system WebView on Windows and macOS. The browser UI shares its design language across those platforms, while the window, tray, menus, keyboard shortcuts, and updater use native platform behavior. Closing the window hides it; quitting the desktop leaves the independently managed Go background job running.

The everyday tray menu contains Open Nootify, one application status, Software Updates, Settings, and Quit Nootify. Available updates may add their direct install action. Background-service and module/start/restart/install controls do not belong in this everyday menu; automatic lifecycle handling and advanced CLI controls remain available.

## Capabilities and Constraints

### Provider and session model

The owner adds named channels on their computer: a Feishu Bot with manually supplied app credentials and trusted recipient, a Feishu personal app authorized through QR-based app registration, or a Remote Nootify connection. These are three setup choices over two provider types, `feishu` and `remote`. Personal apps exchange messages through their application bot; they are not personal user-token messaging sessions. Feishu credentials and the `bot` or `personal-app` connection subtype belong to each provider instance. Other Nootify nodes can subscribe through authenticated gRPC. Each node first tries the addressed local session and independently broadcasts unmatched events to subscribed downstreams.

Providers implement idempotent session creation, metadata access, deletion, rich-text messaging, replies, and event subscription. A remote provider forwards those operations without changing the originating session identity. Locally owned failures are distinct from unmatched events. Each downstream has independent acknowledgment and durable replay state.

Local adapters address existing Claude, Codex, and OpenCode sessions through their supported input transports. Trae and WorkBuddy use explicitly polled inboxes; those inboxes cannot wake an idle or closed conversation. A transport write is not proof that an agent processed a message, and receipt of a message does not approve a permission request.

### Local authority

Provider mutations, settings, agent-prompt edits, secret reveal, and contact directories require local access from an actual loopback peer. Direct local browser pages support editing without an owner authorization link, and reloading does not lock them. Host, Origin, Fetch Metadata, local socket-peer, and UI request-header checks remain enforced; local processes are trusted.

The HTTP service listens on all IPv4 interfaces (`0.0.0.0:9417` by default), accepts loopback and private LAN peers, and checks the Host against its own interface addresses or system hostname and service port. LAN browser access is read-only; bearer-authenticated `/v1/` APIs allow private LAN callers, with remote identity management restricted to loopback. Forwarded headers cannot grant local authority. Desktop/CLI gateway API traffic uses authenticated encryption; direct LAN HTTP is plaintext. Nootify does not manage a VPN device or alter the operating system's Tailscale installation.

### Application workflows

Every page uses a content column capped at 960px and centered within the area to the right of the sidebar, including page titles, actions, logs, routing sessions, and settings. The user-facing name is Channels in English and 通道 in Chinese; internal provider identifiers and API routes keep their existing names. The message-bridge sidebar includes Channels alongside Logs, Routed sessions, and Agents. Remote access settings configure the listener and show nodes connected to this Nootify.

All list Add actions belong at the upper left immediately above their list, using a text button rather than the titlebar. Channels uses one compact grouped list with single-line rows; an empty list retains centered explanatory text. Name/default badge, type, connection state, switch, and text actions share one line, with local horizontal scrolling on narrow screens. Already-default actions are hidden and Delete remains visually secondary. Connection IDs and addresses stay in the editor. Agents also use single-line rows by default. Clicking the row expands paths, status explanations, instruction content, and update actions; its separate checkbox only controls enablement. Expansion survives data refresh, and agent rows have no hover background highlight.

Adding a channel opens a searchable provider-type list in a standard Magpie dialog, then the chosen type's configuration; editing uses the same standard dialog. Personal-app scans hide configuration fields and show the QR, official authorization link, expiry, status, and Cancel. Successful authorization saves a separate channel without replacing existing channels or silently switching the default. Existing personal channels offer reconnect, same-app reauthorization, and permission inspection. Recover previous authorization restores the original target and sanitized flow after a page refresh or lost start response; recovery never starts a replacement flow or resubmits a save. Saving refuses cancellation; completed and uncertain outcomes remain inspectable. Scanning does not automatically grant missing application permissions.

### Feishu recipient selection

Use a focused searchable dialog, not a full-width native multi-row select. Provider-returned avatars and the nickname plus default name lead; names already containing the alias are preserved without duplicate formatting. Missing or unavailable avatars use an initial fallback. The current recipient is identified clearly, and long open_ids remain secondary. Rows change a draft selection. Only the visible confirmation action persists it. Keep manual ID entry available.

Useful contacts appear while the directory is still loading. Reuse existing row and avatar nodes, preserve the visible scroll anchor, and update selection without rebuilding the list. Cache completed results in private credential-scoped local storage: reuse fresh data for 15 minutes and show data up to 24 hours old while refreshing in the background. Bound requests and cancel pending work when the picker closes. A partial directory remains usable and explains missing access.

On permission failure, show the provider's specific scopes, an official application-console link, a locally generated QR, and retry. Ordinary user scanning does not grant application permissions. Administrators may need to publish a version and obtain approval; contact visibility is a separate setting.

## Brand Commitments

Preserve the penguin identity, compact neutral settings, blue action color, and system light/dark appearance. The application bundles the user-selected `idy/magpie-design-system` v0.4.4 with its fonts, icons, licenses, and checked manifest. English typography follows Magpie's roles: Outfit for large titles and actions; Source Sans 3 for headings, body text, navigation, fields, list titles, and metadata. Chinese keeps system-font fallbacks. Support Simplified Chinese and English. Native menus retain platform typography and behavior. The detailed visual contract belongs in `DESIGN.md`.

The service checks stable latest from jsDelivr in the background at startup and every six hours. Only complete size/SHA256-validated releases enter `STATE_DIR/ui-assets/magpie`; a newer cached release is served locally, with versioned same-origin stylesheets that apply on the next page load. Offline operation retains a usable cache or the bundled fallback. JavaScript helpers stay app-owned. Refreshing the checked-in baseline is an explicit `npm run vendor:magpie` maintenance task; normal builds package the existing bundle. This behavior adds no user setting.

Web dropdowns use the existing authored controller with Magpie controls, keyboard selection, visible selected state, and no operating-system select popup. Channel chooser, editor, and deletion dialogs use the unmodified standard Magpie shell and actions; only the recipient picker retains its bounded-list composition and separate results scroller. Preserve the shared content-column alignment and compact rows.

## Evidence on Hand

The implemented Go runtime lives under `internal/` and `native/core/`; the native shell and tray live under `desktop/`. Browser UI source is in `src/`, with HTML/CSS and embedded assets in `public/`. The penguin mark is `desktop/brand.svg`.

Durable validation includes Go tests under `internal/host/`, `internal/bridge/`, `internal/providers/`, `internal/discovery/`, `internal/settings/`, `internal/webui/`, and `native/core/`; browser regressions are under `test/`. `desktop/smoke.go` exercises the actual native tray, language changes, window lifecycle, and update bridge. `integration/headless.test.mjs` exercises real Go CLI/HTTP/gRPC processes with a synthetic upstream bot.

`npm run preview:ui` is an isolated synthetic fixture for browser interaction and visual checks. It does not certify native asset embedding, authenticated transport, or desktop integration. Use clearly identified synthetic contacts for general previews. Label read-only live profile checks separately and limit them to the profile needed for verification. Aggregate live diagnostics report counts and timings rather than bulk contact identities or credentials. The recipient component's contract remains `.impeccable/surfaces/feishu-recipient.md`.

## Product Principles

- Address the existing conversation and preserve its identity and archive state.
- Preserve the original message return route, durable delivery evidence, and independent downstream progress.
- Distinguish transport acceptance, explicit acknowledgment, and actual replies.
- Keep privileged local changes with the verified owner of the computer.
- Keep everyday controls focused on user tasks rather than runtime implementation details.

## Accessibility & Inclusion

Retain keyboard operation, visible focus, explicit selection and confirmation, focus restoration, and reduced-motion behavior. Acceptance covers desktop and 375px browser layouts, both languages and appearances, incremental directory results, valid QR destinations, permission retry, and local-only access.
