---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/styles.css","src/ui-app.ts"]
---

# Nootify application

Mode: Operate. Scope: all application routes in `public/index.html`, shared controls in `public/styles.css`, and dynamically rendered content in `src/ui-app.ts`.

The user explicitly chose `idy/magpie-design-system` for this redesign. Preserve product behavior, the penguin identity, navigation groups, local-only configuration, Chinese/English, and automatic system appearance. Users operate Nootify alongside coding tools on their own computers in changing ambient light; follow their system theme. Build directly in code using the bundled Magpie v0.4.4 baseline, served locally with its fonts and licenses. The service checks stable latest from jsDelivr at startup and every six hours, validates complete releases under `STATE_DIR/ui-assets/magpie`, and prefers a cache only when newer than the bundle. Versioned same-origin stylesheets keep CSS imports and referenced fonts and icon masks on one release; updated stylesheets apply on the next page load, with a usable cache or bundled fallback offline. JavaScript helpers remain app-owned, and baseline syncing is explicit maintenance rather than part of normal builds.

## Direction contract

THESIS: Make every route part of the same Magpie application, with working information and actions immediately available. Keep the established tasks and centered 960px working column.

OWN-WORLD: Magpie's neutral canvas, sidebar and surfaces; blue primary actions; semantic status colors; Outfit display/actions and Source Sans 3 headings, body, and interface text, with system CJK fallbacks; 34px controls and 12px groups. Use actual upstream classes and tokens rather than copying their appearance.

STORY: Scan connection state, inspect logs or routing, manage providers and clients, then make explicit, reversible configuration changes. Status remains readable in words as well as color.

FIRST VIEWPORT: A persistent left navigation with connection status at its foot, compact title/action row, and a centered working column. Channels (通道) places a text Add button at the list’s upper left; list creation actions never occupy the titlebar. Connections occupy one compact list. Each entry groups its name/default badge, type and connection state with an accessible switch. Names, type, status, switches and actions stay on a single row, with local horizontal scrolling on narrow screens; the already-default action is hidden and Delete stays visually secondary. Agents likewise start as single-line checkbox/name/status rows; clicking the row expands its paths, instructions and update action independently of checkbox enablement. Expansion persists through refresh. App IDs and addresses remain in the editor. A short note below explains default routing. This replaces the oversized individual cards explicitly rejected by the user on 2026-11-10. Narrow browser windows reflow navigation horizontally.

FORM: User-pinned Magpie design system and existing application navigation; no concept roll is applicable. The user subsequently rejected the connection-card composition and requested a correction to this existing screen, while retaining the named design system. The new-work playbook excludes precisely scoped extensions from concept rolls; no seed was generated or claimed. Signature interaction: stable list and dialog state during live updates, with Magpie focus and control feedback. Motion uses the upstream short ease-out transitions and respects reduced motion. Seed reference: none (user-pinned).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Channel creation/editing and deletion use the unmodified upstream `mds-dialog` shell: 440px bounded width, 24px padding, upstream type/surface/border, and `mds-dialog-actions`. The user explicitly rejected the prior hybrid recipient-dialog wrapper; remove its 600px width, full-width settings-row separators, inset header, and separate footer surface. Forms compose standard Magpie inputs, switches and buttons vertically; application CSS only supplies field grouping, header icon alignment and functional QR sizing. Native dialog overflow handles tall forms. The unrelated contact-picker retains its own bounded-list layout.

Channel management provides three explicit choices: Feishu Bot, Feishu personal app, and Remote Nootify. Personal authorization belongs to one channel, with a focused QR view during the scan and no credential fields exposed. Existing personal channels provide reconnect, same-app reauthorization, and permission inspection. Recover previous authorization restores the original target and sanitized flow after a page refresh or lost start response; it never creates a new flow or repeats an uncertain save. Completion, cancellation races, failed or uncertain saves, expired codes, and read-only access retain honest states and reachable actions within the scrolling standard dialog. No live scan is simulated as a production authorization; preview fixtures are synthetic.

The application runs in one Go executable with embedded browser assets, a native MyGo desktop, CLI, and background service. Direct loopback browser pages allow local editing without an authorization link and remain editable after reload; actual socket-peer, Host/origin/fetch-site, and UI-header checks still apply. Direct private LAN access exposes read-only settings, with repository follow and PR refresh as the limited write exceptions. The desktop/CLI encrypted gateway is a separate access path. `npm run preview:ui` remains an isolated synthetic fixture, not evidence that native transport, asset embedding, or desktop integration has passed.

Acceptance: every route; populated and empty lists; provider choose/edit/cancel/save/delete; dropdown keyboard selection and dismissal; contact-picker draft behavior; 375px and desktop; light/dark; both languages; strict CSP and local-only authorization; served assets and desktop packaging. Preview data is explicitly synthetic. No decorative raster assets are introduced.
