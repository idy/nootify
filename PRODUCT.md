# Nootify product context

Nootify is a macOS companion for local coding-agent conversations. A per-user TypeScript service bridges Feishu, Slack, and Telegram messages to existing agent sessions and tracks GitHub pull requests. The desktop window and tray manage this service; the service does not create or unarchive agent sessions.

## Audience and operating scene

The owner configures notification channels and trusted recipients on their Mac, then follows agent progress and replies through messaging apps. Settings are an Operate surface: quick, familiar controls and an accurate explanation of connection, permissions, and routing matter more than visual expression.

## Existing commitments

Preserve the application’s penguin identity, local system typography, compact neutral settings, blue action color, and system light/dark appearance. Support Simplified Chinese and English. Configuration edits, secret reveal, and contact directories remain local to the Mac; tailnet access does not grant those capabilities.

## Feishu recipient selection

Use a focused searchable dialog, not a full-width native multi-row select. Provider-returned avatars and the nickname plus default name lead; names already containing the alias are preserved without duplicate formatting. Missing or unavailable avatars use an initial fallback. The current recipient is identified clearly, and long open_ids remain secondary. Rows change a draft selection. Only the visible confirmation action persists it. Keep manual ID entry available.

Useful contacts should appear while the directory is still loading. Cache completed results briefly, bound requests, and cancel pending work when the picker closes. A partial directory must remain usable and explain missing access.

On permission failure, show the provider’s specific scopes, an official application-console link, a locally generated QR, and retry. Do not imply that ordinary user scanning grants application permissions. Administrators may need to publish a version and obtain approval; contact visibility is a separate setting.

## Evidence and acceptance

Use clearly identified synthetic contacts for general previews. A read-only live profile check must be labeled separately and limited to the profile needed for verification. Aggregate live diagnostics report counts and timings rather than bulk contact identities or credentials.

Acceptance covers desktop and 375px layouts, both languages and appearances, search, keyboard operation, draft/confirm/cancel semantics, focus restoration, incremental results, valid QR destinations, permission retry, and local-only access. Regression evidence lives in `test/lark-directory.test.ts`, `test/lark-permissions.test.ts`, `test/lark-lifecycle.test.ts`, and `test/settings.test.ts`. The component’s design contract is `.impeccable/surfaces/feishu-recipient.md`.
