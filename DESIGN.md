---
name: Nootify
description: Magpie controls and stable domain views for local agent messaging.
colors:
  canvas: "#f5f5f7"
  sidebar: "#ededf0"
  surface: "#fff"
  raised: "#e9e9ee"
  field: "#fff"
  code: "#f0f0f4"
  line: "#00000014"
  line-strong: "#85858f"
  ink: "#1c1c1e"
  ink-soft: "#4e4e56"
  ink-subtle: "#55555f"
  muted: "#62626c"
  faint: "#6c6c76"
  accent: "#2f62d5"
  accent-hover: "#2856c1"
  accent-ink: "#2459c4"
  on-accent: "#fff"
  good: "#167536"
  warn: "#855700"
  error: "#b42318"
  danger: "#c42b1c"
  hover: "#00000006"
  selected: "#0000000e"
  dark-canvas: "#1c1c1e"
  dark-sidebar: "#18181a"
  dark-surface: "#232326"
  dark-raised: "#2c2c30"
  dark-field: "#2a2a2e"
  dark-code: "#161618"
  dark-line: "#ffffff12"
  dark-line-strong: "#ffffff1f"
  dark-ink: "#ececf0"
  dark-ink-soft: "#c7c7cc"
  dark-ink-subtle: "#aeaeb2"
  dark-muted: "#9a9aa2"
  dark-faint: "#92929c"
  dark-accent-hover: "#366bdd"
  dark-accent-ink: "#8ab4ff"
  dark-good: "#30d158"
  dark-warn: "#f0c46b"
  dark-error: "#ff8a80"
  dark-hover: "#ffffff0a"
  dark-selected: "#ffffff14"
typography:
  title:
    fontFamily: "Montserrat, \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  heading:
    fontFamily: "Monda, \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Lato, \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  action:
    fontFamily: "Montserrat, \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  caption:
    fontFamily: "Lato, \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "0.75rem"
  code:
    fontFamily: "\"SF Mono\", \"SFMono-Regular\", \"Cascadia Mono\", Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.8125rem"
rounded:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
  tag: "5px"
spacing:
  compact: "8px"
  panel-inset: "16px"
  section-gap: "20px"
  gutter: "24px"
  mobile-gutter: "14px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "6px 16px"
    typography: "{typography.action}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    typography: "{typography.action}"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.ink-subtle}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    typography: "{typography.action}"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  group:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  channel-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  channel-row:
    padding: "4px 12px"
  tag:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.muted}"
    rounded: "{rounded.tag}"
    height: "18px"
    padding: "0 6px"
  recipient-person:
    rounded: "{rounded.md}"
    padding: "10px 12px"
---

# Design System: Nootify

## Overview

**Creative North Star: "Magpie application, local settings"**

Nootify uses the user-selected Magpie Design System v0.4.1 for its complete application. Quiet neutral surfaces, blue actions, compact controls, and the penguin identity support everyday operation alongside coding tools. Chinese and English share the same hierarchy and follow system light/dark appearance.

The unmodified upstream CSS, fonts, and icons in `public/vendor/magpie/` own the palette, type roles, standard component skins, focus treatments, and reduced motion. `public/styles.css` imports that system and owns Nootify's domain composition: navigation dimensions, live lists, grouped channels, recipient selection, and responsive dialogs. The frontmatter records the reused shipped tokens; upstream remains the implementation source of truth. Application adjustments stay outside the vendor directory.

**Key Characteristics:**

- Neutral groups with fine row separators.
- Distinct title, heading, action, and reading fonts.
- Stable live lists and explicit dialog confirmation.

Provenance: approved whole-application replacement, recorded from `public/index.html`, `public/styles.css`, the component diff in `src/ui-app.ts`, and Magpie v0.4.1 (commit `284dd0341351fb4bbeaf55ce1a6658397c7d5941`). The direction contract remains in `.impeccable/surfaces/public-index-html.md`; integration and controller mapping remain in `docs/ui-components.md`.

## Colors

### Primary

Magpie blue separates solid action fills (`accent`) from readable colored text and focus rings (`accent-ink`). The fill stays the same across appearances; the text blue lightens in dark mode. Green, amber, and red express labeled connection and delivery states. Danger fills use the separate danger token.

### Neutral

Canvas and sidebar frame surface-colored groups. Raised colors belong to standard secondary buttons; Nootify's legacy `--raised` alias instead maps to upstream `code` for detail areas and table headings. Fields, hairlines, stronger control borders, and ink/muted/faint text retain their upstream roles. Alpha hover and selection colors layer over the current surface. Frontmatter keys without a prefix describe light mode; `dark-` keys record changed values. Unchanged values apply in both. The root follows system appearance through upstream media queries.

**The Role Continuity Rule.** Use accent for actions and focus; keep success, warning, and error colors tied to labeled states in both appearances.

Repository tags retain a separate eight-color identity set with tinted backgrounds; these distinguish repositories, not review or CI status, and are not brand accents. Contact selection mixes accent text color (10%) with the panel; permission notices mix warning color (9%) with the panel.

## Typography

Locally bundled Montserrat supplies dialog titles, brand, navigation, breadcrumbs, and actions. All breadcrumb segments share the upstream body size (14px); the current page differs only by ink color and weight (600 versus 400), never by a larger title size. Monda supplies section headings. Channel names use bold Lato body text (14px/1.5), with type and labeled status beneath (13px/1.5). Lato supplies body text, fields, row names, notes, and captions. Each uses Magpie's system Chinese fallbacks. Monospace identifiers retain tabular figures and disabled ligatures.

The compact ramp is title (20px), heading (16px), body/navigation (14px), notes/actions/code (13px), and caption (12px), at the default root size. Titles are semibold, Monda headings regular, and action labels medium. Nootify row names use (14px/20px) medium; subtitles use (12px/17px), preventing mixed CJK/Latin line-box jumps. Metadata tags remain (11px). Recipient dialog titles reduce to (16px) below the local mobile breakpoint; channel dialog titles retain the upstream title size. Supporting hints are bounded at (75ch). There is no separate hero display scale.

**The Names First Rule.** Lead contact rows with human names; keep IDs and disambiguation subordinate and preserve already formatted aliases.

## Layout

Nootify composes a (224px) sidebar, (60px) title row, and a working column capped at (960px), centered within the area beside navigation. Titles, actions, banners, lists, and settings share its gutter. The base gutter is the upstream gutter token; it reduces to (20px) at (860px), then the application uses (14px) at (760px). Only native macOS window controls add brand clearance (96px left padding). The working view scrolls independently on desktop.

Grouped data rows use (64px) minimum height and (12px 16px) padding; log rows use (48px). Settings rows use (68px) minimum height and (14px 16px) padding. Channels share one bordered group with single-line rows (52px), using (4px 12px) padding. Five columns align name/default badge, type, connection status, switch and text actions. The switch label retains a (44px) minimum target. The list scrolls horizontally below its (720px) minimum data width; it never stacks channel metadata or actions into a second line. List Add actions are text buttons at the upper left above their list, not in the titlebar. Agents use (52px) headers with an independent checkbox, name, status and disclosure button; paths, explanations and update/instruction content are hidden until expanded. Adjacent settings groups retain (12px) gaps. Summaries and filter buttons sit outside bordered lists, which start with data rows. Agent checkbox rows have no background hover highlight.

Browser navigation becomes a sticky horizontal strip at (760px), with settings subnavigation below; native desktop retains its application composition. Workspace container queries at (640px) wrap fields/actions, stack QR instructions, and reflow PR titles. Shell queries at (880px) hide secondary title metadata; at (640px), search moves behind a labeled icon and opens below the title row. Repository tables begin reflowing at (1100px). Coarse pointers enlarge standard controls, navigation, filter buttons, popup options, and dialog buttons to at least (44px).

Channel chooser, editor, and delete confirmation use the unmodified upstream dialog shell: width bounded by (440px) and viewport width minus (32px), (24px) padding, and extra-large corners (14px). Standard actions wrap and align right with an (8px) gap and (20px) top margin. The native dialog scrolls the whole long form, including actions; there is no separate fixed channel footer. Fields remain vertically stacked, with (16px) group gaps and (6px) label gaps.

Recipient dialogs retain their separate bounded-list composition, capped at (520px). Recipient bounds leave (32px) horizontal and (48px) vertical viewport clearance; their result region scrolls with a (336px) flex basis, or (420px) for permission help. At (480px), recipient bounds leave (24px) clearance, search becomes (16px), and the footer becomes two columns with manual entry on its own row. Recipient headers and confirmation actions stay outside the results scroller.

## Elevation & Depth

**The Quiet Surface Rule.** Use borders and tonal separation for working groups; reserve diffuse elevation for menus and dialogs.

Dropdowns use upstream `0 8px 24px var(--mds-toast-shadow)`; dialogs use `0 20px 60px var(--mds-dialog-shadow)`. The modal backdrop is translucent black with (2px) blur, darker in dark mode. The native switch knob has a small soft shadow. Current navigation adds an inset hairline, not a floating card shadow.

Keyboard focus is an accent outline (2px). The application default offset is (1px); fields and search commonly use (2px), checkboxes/switches (3px), and clipped rows use inward offsets. Active recipient rows add an inset outline (1px). Upstream transitions use fast (120ms) and standard (150ms) durations; chevrons and switch movement use the upstream ease curve. Busy icons rotate; reduced motion removes animations and transitions. There is no authored dialog entrance animation.

## Shapes

Upstream controls have small curved corners, groups use the large radius, and dialogs use the extra-large radius. Popup containers use medium corners and options extra-small corners. Local tags use their compact tag radius; contact rows use medium corners. Portraits (36px), selection indicators, and status dots are circular. QR backing stays white for scanning in either appearance. SVG icons convey actions and identity; no decorative raster assets ship.

## Components

- **Buttons:** upstream primary blue, raised secondary, and transparent subtle variants; standard minimum height (34px). Primary hover changes to accent-hover; subtle hover uses its neutral overlay. Disabled buttons use opacity (.45). Channel delete confirmation uses the upstream primary button; other destructive confirmations retain semantic danger color. Channel Delete stays neutral at rest and gains error color on hover. Native labels and action state remain application responsibilities.
- **Fields and switches:** upstream bordered fields provide hover, accent focus, invalid, and disabled states. Switches retain a native checkbox plus an adjacent visual track (34px by 20px); checked state fills blue and moves the knob. Secret controls and validation remain local compositions.
- **Dropdowns:** the existing select-only combobox controller uses upstream field/menu/option skins. Options fill the popup width, align text to the start, and wrap long labels. Selection is bold with the upstream check mask; keyboard-active options use the selected surface. The body-portaled popup is viewport-bounded and may flip upward. Arrows, Home/End, and typeahead preview; Enter/Space commits; Escape cancels. Tab, outside interaction, route changes, resizing, and ancestor scrolling dismiss without committing. Focus stays on the trigger.
- **Navigation and filters:** neutral selected navigation with a thin inset border; nested settings use an indented rule. Filters use `aria-pressed`, neutral selection, a border, and semibold text; they are list toggles, not tab panels.
- **Groups and channels:** the user-facing term is Channel / 通道; internal provider identifiers remain implementation details. Channels join compact rows inside one upstream group. Each row keeps its name/Default badge, type, labeled status, enable switch, and text actions on one line at all widths; narrow screens scroll the list horizontally. Long names truncate with their full value in a tooltip. Connection errors remain available on the status label and in the editor. The already-default action is hidden. Add is a text button above the list at its upper left; Add and Edit open the same standard Magpie channel dialog. App IDs and addresses appear only in the editor. The empty state remains inside the group, and a short routing note below explains that new sessions use the default while existing sessions retain their channel.
- **Channel chooser:** The searchable chooser presents three rows with SVG identity icons, a name and supporting explanation: Feishu Bot for manual credentials, Feishu personal app for QR registration, and Remote Nootify. Existing channels retain their actual connection-type label; personal editors hide manual credential fields.
- **Personal channel management:** Personal authorization reuses the standard Magpie dialog. Active scans hide configuration fields and show a white-backed QR (184px), status, expiry, and official browser authorization action; Cancel remains available except while saving. Expired or failed scans offer retry, while an uncertain save asks the owner to check the channel list instead. Successful completion restores the personal editor with reconnect, same-app reauthorization, and required group/message permission inspection; missing scopes link to the official app console. QR and instructions stack with a (16px) gap. Buttons, inputs, and switches use genuine upstream controls with no local skin overrides: Cancel and browser authorization use the standard secondary button, while management actions use subtle buttons. Local helpers supply vertical form grouping, label spacing, header icon alignment, wrapping actions, and functional QR sizing.
- **Agents:** single-line disclosure buttons expose paths, status details, update actions and instruction text. Checkboxes are separate controls, so enabling an agent does not expand its row and expanding never writes instructions. Expanded state persists through refresh; keyboard focus follows stable row keys.
- **Tags and logs:** small neutral tags supply metadata; delivery-type chips use status-tinted backgrounds. Repository identity tags precede PR titles. Numeric metadata aligns on the right and uses tabular figures.
- **Recipient picker:** human names and runtime portraits lead. Initials survive unavailable images; selected drafts use a blue tint and circular SVG check. Cached contacts remain visible through refresh; keyed rows and decoded images preserve scroll position. Permission help, loading, empty, partial, and error states share a bounded body. Row clicks and keyboard selection change only the draft; confirm persists it. Cancel, Escape, and close discard the draft, abort loading, and restore opener focus. Manual ID entry remains available and save failures remain visible.

## Do's and Don'ts

### Do:

- Do use upstream component classes and semantic tokens, with application composition outside the vendor directory.
- Do preserve useful loaded contacts, stable row identity, and a reachable recipient dialog footer during refresh.
- Do keep portraits as runtime provider data and QR codes as functional imagery.
- Do keep native checkbox semantics, visible keyboard focus, translated labels, and reduced motion.

### Don't:

- Don't persist a recipient from a row click; use explicit confirmation.
- Don't let full IDs outrank human names or duplicate an alias already supplied by the provider.
- Don't describe personal-app QR authorization as automatically granting missing group or message permissions.
- Don't replace the authored dropdown with an operating-system select popup.

Not canonized or repaired: compact navigation category labels remain a carried craft-floor exception, not a reusable eyebrow/kicker style. This documentation pass does not repair source or certify a whole-surface review verdict.
