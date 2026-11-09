# Nootify product context

Nootify is a Windows and macOS companion for local coding-agent conversations. A Go notification core manages multiple Feishu WebSocket and Remote Nootify gRPC providers, session bindings, and event routing. The per-user TypeScript service hosts the UI, existing local agent transports, and repository tracking. The desktop window and tray use the Go/MyGo host, including native menus, language preferences, signed updates, and service management. Notification-session creation does not create or unarchive native agent conversations.

## Audience and operating scene

The owner adds named providers on their computer: a Feishu bot and its trusted recipient, or a Remote Nootify connection. Other Nootify nodes can subscribe to this node's authenticated gRPC service. Each node tries the addressed local agent session first and broadcasts unmatched events independently to every downstream subscriber. Settings are an Operate surface: quick, familiar controls and an accurate explanation of connections, permissions, and routing matter more than visual expression.

## Provider and session model

An agent session is the business identity; groups and topics are provider implementation details. Providers implement idempotent session creation, metadata access, deletion, rich-text messaging, replies, and event subscription. A remote provider forwards the same operations without changing the originating session identity. Locally owned failures are distinct from unmatched events. Each downstream has independent acknowledgement and replay state. Provider mutation and remote access credentials are available only in the local UI.

Every page uses a content column capped at 960px and centered within the area to the right of the sidebar, including page titles, actions, logs, routing sessions, and settings. Providers is a card list with an upper-left Add action; an empty list retains a card with centered explanatory text. Agent checkbox rows have no hover background highlight. Adding opens a provider-type list in a dialog, then the chosen type's configuration; editing also uses the dialog. The message-bridge sidebar includes Providers alongside logs, routing sessions, and Agents. Repository navigation is grouped under Repos. Remote access settings configure the listener and show nodes connected to this Nootify. Feishu credentials belong to each provider instance.

## Existing commitments

Preserve the application’s penguin identity, compact neutral settings, blue action color, and system light/dark appearance. English typography uses Montserrat for navigation menus, their section labels and counts, and the brand; Lato for body text, controls, content headings, row titles, and metadata. Chinese keeps system-font fallbacks. Support Simplified Chinese and English. Configuration edits, secret reveal, and contact directories remain local to the computer; tailnet access does not grant those capabilities.

## Feishu recipient selection

Use a focused searchable dialog, not a full-width native multi-row select. Provider-returned avatars and the nickname plus default name lead; names already containing the alias are preserved without duplicate formatting. Missing or unavailable avatars use an initial fallback. The current recipient is identified clearly, and long open_ids remain secondary. Rows change a draft selection. Only the visible confirmation action persists it. Keep manual ID entry available.

Useful contacts should appear while the directory is still loading. Reuse existing row and avatar nodes, preserve the visible scroll anchor, and update selection without rebuilding the list. Cache completed results in private credential-scoped local storage: reuse fresh data for 15 minutes and show data up to 24 hours old while refreshing in the background. Bound requests and cancel pending work when the picker closes. A partial directory must remain usable and explain missing access.

On permission failure, show the provider’s specific scopes, an official application-console link, a locally generated QR, and retry. Do not imply that ordinary user scanning grants application permissions. Administrators may need to publish a version and obtain approval; contact visibility is a separate setting.

## Evidence and acceptance

Use clearly identified synthetic contacts for general previews. A read-only live profile check must be labeled separately and limited to the profile needed for verification. Aggregate live diagnostics report counts and timings rather than bulk contact identities or credentials.

Acceptance covers desktop and 375px layouts, both languages and appearances, search, keyboard operation, draft/confirm/cancel semantics, focus restoration, incremental results, valid QR destinations, permission retry, and local-only access. Regression evidence lives in `test/lark-directory.test.ts`, `test/lark-permissions.test.ts`, `test/lark-lifecycle.test.ts`, and `test/settings.test.ts`. The component’s design contract is `.impeccable/surfaces/feishu-recipient.md`.
