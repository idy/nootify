---
name: Nootify
description: Compact native-feeling settings for local agent messaging.
colors:
  bg: "#f7f7f8"
  sidebar: "#efeff1"
  panel: "#ffffff"
  raised: "#f5f5f7"
  field: "#ededf0"
  line: "#d9d9df"
  line-soft: "#e6e6eb"
  hover: "#e8e8ed"
  selected: "#dedee5"
  text: "#27272a"
  muted: "#61616b"
  faint: "#6f6f78"
  blue: "#245dc1"
  green: "#1d7b45"
  amber: "#93630b"
  red: "#bd322b"
  focus-line: "#9999a3"
  check-line: "#868690"
  dark-bg: "#18181b"
  dark-sidebar: "#1d1d20"
  dark-panel: "#1c1c1f"
  dark-raised: "#202024"
  dark-field: "#232327"
  dark-line: "#2c2c31"
  dark-line-soft: "#252529"
  dark-hover: "#232328"
  dark-selected: "#2d2d33"
  dark-text: "#ececef"
  dark-muted: "#9b9ba4"
  dark-faint: "#888893"
  dark-blue: "#82a9ff"
  dark-green: "#4fc27d"
  dark-amber: "#e2a541"
  dark-red: "#f07a73"
  dark-focus-line: "#4a4a53"
  dark-check-line: "#55555e"
typography:
  navigation:
    fontFamily: 'Montserrat, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif'
    fontSize: "14px"
  heading:
    fontFamily: 'Lato, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif'
    fontSize: "16px"
    fontWeight: 600
  primary:
    fontFamily: 'Lato, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
  body:
    fontFamily: 'Lato, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "13px"
    lineHeight: 1.4
  meta:
    fontFamily: 'Lato, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "12px"
  code:
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace'
    fontSize: "11.5px"
rounded:
  tag: "5px"
  control: "7px"
  field: "8px"
  person: "10px"
  group: "11px"
  dialog-mobile: "14px"
  dialog: "16px"
spacing:
  compact: "8px"
  section-gap: "12px"
  panel-inset: "16px"
  page-gutter: "22px"
components:
  button-text:
    rounded: "{rounded.control}"
    height: "30px"
    padding: "0 10px"
  button-text-primary:
    textColor: "{colors.blue}"
    rounded: "{rounded.control}"
    height: "30px"
    padding: "0 10px"
  button-dialog-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.panel}"
    rounded: "{rounded.field}"
    padding: "0 14px"
  button-dialog-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "0 14px"
  field:
    backgroundColor: "{colors.field}"
    rounded: "{rounded.field}"
    height: "30px"
    padding: "0 10px"
  group:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.group}"
  tag:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.muted}"
    rounded: "{rounded.tag}"
    height: "18px"
    padding: "0 6px"
  recipient-person:
    rounded: "{rounded.person}"
    padding: "10px 12px"
---

# Design System: Nootify

## Overview

**Creative North Star: "Local settings"**

This is a descriptive record of the incumbent interface, not a new identity. Nootify uses compact neutral groups, bundled website typography with system Chinese fallbacks, its existing penguin identity, and blue actions. Settings prioritize accurate connection and access states in Chinese and English.

**Key Characteristics:**

- Compact rows with names before metadata.
- Neutral layers that follow system appearance.
- Blue interactive states and explicit confirmation.

Provenance: scan of the finished build. The Feishu modal is a user-pinned local component extension; concept/seed provenance is not applicable. No seed was generated. Surface direction and task-specific evidence remain in `.impeccable/surfaces/feishu-recipient.md`.

## Colors

### Primary

Blue identifies actions, links, selected controls, and keyboard focus. Green, amber, and red communicate success, incomplete access, and errors; they are semantic statuses, not additional brand accents.

### Neutral

Background and sidebar frame panel groups. Raised surfaces separate footers and details; field surfaces contain input. Line and soft-line separate groups and rows. Text, muted, and faint establish reading priority. The frontmatter records both source palettes; `prefers-color-scheme: dark` reassigns the corresponding CSS properties automatically.

**The Role Continuity Rule.** Preserve color roles across appearances. Recipient selection mixes blue (10%) with panel; partial-access notice mixes amber (9%) with panel.

## Typography

English typography uses Montserrat for navigation menus, their section labels and counts, and the brand. Lato carries body text, controls, content headings, row titles, notes, metadata, and log actions. The Latin font files are bundled locally through `desktop/fonts.css` and `desktop/fonts/`, shared with the offline page; Chinese keeps the existing system fallback stack. Code retains its separate monospace stack, tabular numerals, and disabled ligatures. The compact fixed type scale and line boxes remain unchanged.

- Heading: page hierarchy; semibold. The modal locally uses (17px/24px), reducing to the heading size on mobile.
- Primary: row names and settings labels; medium with fixed line boxes.
- Body: controls and explanatory copy; modal descriptions use (1.6) line-height.
- Meta: secondary names, statuses, hints; recipient subtitles use (17px) line-height.
- Code: identifiers, subordinate to names.

**The Names First Rule.** Lead contact rows with nickname plus default name, preserving already formatted aliases; show English names or short ID suffixes only as secondary disambiguation.

## Layout

The desktop shell has a (224px) sidebar, (52px) titlebar, and a shared content column capped at (960px), centered within the working area to the right of the sidebar. Titles, page actions, banners, and every page's lists and settings share that column. Responsive side insets preserve page-gutter spacing on narrow windows while keeping scrollbars at the working area's edge. Only the native macOS window reserves space before the brand for its window controls; browser views and desktop-layout previews keep the normal left inset. Groups use panel-inset spacing and section-gap separation. At (760px), page gutters become (14px); browser navigation reflows horizontally. Logs, both PR queues, and subscriptions place search and page actions in the title row, with compact text filters directly above the list card. List titles, descriptions, counts, and connection information sit above and outside the bordered list cards; the cards begin with their first data item. PR summaries precede the filters, while Agents connection summaries sit directly above their list. The selected filter uses blue text and semibold weight. Narrow title rows hide search inputs behind labeled search icons and use a sort icon. Clicking search or pressing `/` opens a field below the title row; Escape and outside clicks close it without clearing the query. Active queries tint the search icon blue. Pause and export use icons when native update status is also visible. Working content reflows through a container query at (640px), including single-column Feishu QR flows and wrapping settings actions. Import preview filenames wrap within their row.

The recipient modal is capped at (520px), with viewport width minus (32px) and dynamic viewport height minus (48px). Its result body scrolls independently with a (336px) flex basis, or (420px) for permission help; header, status, and footer remain outside that scroller. Rows have a (60px) minimum height and (12px) gap.

At (480px) and below, modal bounds leave (24px) total viewport clearance. The footer becomes two columns with manual entry on its own row; its selection summary hides. Permission mode uses a (1:2) column ratio. Search input grows to (16px). These are local modal adaptations, not a new whole-app composition.

## Elevation & Depth

Settings groups rely on tonal layering and thin borders. The modal adds a diffuse shadow (`0 20px 64px rgb(0 0 0 / .24)`) and backdrop (`rgb(12 16 24 / .36)`). Focus is a blue outline (2px) offset (1px); keyboard-active contact rows use an inset outline (1px). No new modal entrance animation is defined. Existing switches and chevrons transition over (.15s); busy icons spin and respect reduced motion.

## Shapes

Controls use modest curved corners; groups are slightly rounder. The modal uses the largest corners, reduced on mobile. Provider portraits and selection indicators are circles; portraits display at (36px) with cover cropping. QR images display at (184px) on white for scanning in either appearance.

## Components

- **Buttons:** quiet text actions in settings; blue filled confirmation/retry and bordered panel-colored cancellation in the modal. Dialog buttons have (34px) minimum height. Primary hover uses brightness (.94); disabled primary has opacity (.5). Secondary and text actions use the hover surface. Global keyboard focus remains visible.
- **Fields:** neutral fill, soft border, field radius; focused settings fields change border color. The modal search uses a stronger blue focus border, (10px) corners, and (11px 12px) padding.
- **Navigation, tags, groups:** navigation uses selected neutral fill; tags are compact metadata; groups contain separated two-line rows rather than individually elevated cards. Agent checkbox rows keep their panel background on hover; keyboard focus and checkbox states remain visible. The Providers list retains a card with centered empty-state text when no providers exist.
- **Contact rows:** a provider portrait overlays an initial fallback. Images load lazily, decode asynchronously, omit referrers, and fall back on failure. Selected draft has blue tint and a circular SVG check. The saved recipient sorts first when search is empty and carries a current-recipient subtitle. Search includes name, nickname, English name, and ID.
- **Directory states:** cached contacts appear immediately and remain visible during background refresh. Rows and decoded portraits are keyed by open_id and reused across streamed batches, search, selection, and polling; the visible scroll anchor stays fixed. New avatar URLs replace the old portrait only after decoding. Initial skeletons appear only without usable contacts. Progress remains in a polite status region. Interrupted and partial lists remain selectable, with separate access help. Empty, search-empty, and network errors use the same bounded body.
- **Permission help:** hide search and show administrator instructions, locally generated official-console QR, browser link, scope details, and retry. Scanning does not itself grant app permissions; publication/approval and contact visibility are distinct requirements.
- **Selection lifecycle:** row clicks and keyboard selection update only the draft. Confirmation persists it; cancel, Escape, and close discard it. Closing aborts pending loading and restores focus to the opener. Manual ID entry remains available. Save errors remain visible in an alert.

## Do's and Don'ts

### Do:

- **Do** use the bundled application font roles with system Chinese fallbacks, preserving semantic colors and automatic appearance.
- **Do** preserve useful loaded contacts and a reachable footer while loading or explaining access.
- **Do** keep portraits as runtime provider data and the permission QR as locally generated functional imagery.

### Don't:

- **Don't** persist a recipient from a row click; use explicit confirmation.
- **Don't** let full IDs outrank human names or duplicate an alias already supplied by the provider.
- **Don't** describe a QR scan as automatic application authorization.

Not canonized or repaired: incumbent navigation section-label styling is outside this local extension and is not promoted into a reusable eyebrow/kicker rule; unrelated application drift is outside the write boundary. No decorative raster assets ship.
