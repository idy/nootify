# Shared application controls

Nootify uses [Magpie Design System v0.4.1](https://github.com/idy/magpie-design-system/tree/v0.4.1). The unmodified CSS, font, and icon assets live in `public/vendor/magpie/`; its README records the exact release, commit, license notices, and update procedure. `src/ui.ts` explicitly serves the runtime assets under `/ui/vendor/magpie/`, and desktop staging copies the public tree recursively.

`public/styles.css` imports the upstream stylesheet. Magpie owns palette, typography, focus, standard control skins, automatic system appearance, and reduced motion. Nootify owns its 224px navigation column, centered 960px working column, native window-control clearance, live lists, recipient picker, provider editor, and narrow-screen composition. Keep application overrides outside the vendor directory. No runtime CDN or extra framework is required.

## Component mapping

| Application element | Magpie component | Application responsibility |
| --- | --- | --- |
| Shell and navigation | `mds-shell`, `mds-sidebar`, `mds-nav`, `mds-nav-item`, `mds-subnav` | Hash routing, live counts, native chrome, horizontal navigation on small screens |
| List/settings groups | `mds-group` | Data rows, disclosures, sorting, filters, responsive tables |
| Channel list | `mds-group` with application rows | Single-line identity/type/status/switch/actions, locally scrolling on narrow screens; text Add above the list |
| Agent list | Native checkbox and disclosure button | Single-line collapsed state; details and update/instruction content expand independently from enablement |
| Actions | `mds-button`, `mds-button--primary`, `mds-button--subtle`, `mds-icon-button` | Action state and translated accessible names; a local danger modifier uses semantic tokens |
| Text fields | `mds-input`, `mds-mono` | Labels, validation, secret handling, responsive width |
| Switches | `mds-switch` with a checkbox and adjacent `mds-switch-track` | The native checkbox retains its ID, label, checked/disabled state and change handler |
| Checkboxes | `mds-check` around the native input | Repository follow and agent injection state |
| Language popup | `mds-select-menu`, `mds-select-option`, `mds-input` | Existing `Dropdown` controller and its dismissal semantics |
| Channel chooser/editor/delete dialogs | Unmodified `mds-dialog`, `mds-dialog-actions`, Magpie controls | Vertical form composition, native modal lifecycle/scrolling, async save and focus restoration; no local width, padding or footer-skin overrides |
| Recipient picker | `mds-dialog` with the application’s bounded-list composition | Independently scrolling contacts and reachable selection footer |

Filter buttons remain toggle buttons with `aria-pressed`, since they filter one list rather than switch tab panels. Repository identity tags, delivery types and contact rows are domain compositions using Magpie tokens. The penguin stays Nootify's brand mark.

## Dropdown

`src/dropdown.ts` exports `Dropdown`, a select-only combobox. Nootify retains this controller so keyboard commits, focus restoration, and dismissal behavior remain compatible. It consumes Magpie's visual primitives rather than creating a second dropdown appearance.

- The trigger is a button with `setting-field dropdown-button mds-input`, an accessible label, and a `[data-dropdown-label]` child. Its string `value` holds the committed selection.
- The popup uses `dropdown-menu mds-select-menu` and `role="listbox"`. Options have `dropdown-option mds-select-option`, `role="option"`, unique `data-value`, and `[data-option-label]` children. The upstream CSS mask draws the selected check; the retained legacy SVG is hidden.
- The controller links trigger and popup through ARIA and portals the popup to `document.body` to escape clipping groups.

```ts
import { Dropdown } from './dropdown.js';

const control = new Dropdown(button, menu);
control.value = 'system';
button.addEventListener('change', () => {
  // Commit control.value to the setting's state.
});
```

The value setter updates labels and selection without emitting a change. User selection emits one bubbling `change` only when the committed value changes. Call `refresh()` after translation or option updates; `close()` dismisses without committing, and `close(true)` also restores trigger focus.

Focus remains on the trigger while open. Arrow keys, Home/End, and typeahead preview options; Enter/Space commits; Escape cancels. Tab, outside interaction, route changes, resizing, and ancestor scrolling dismiss without committing. Internal menu scrolling remains usable. Disabled options are skipped, and CSSOM positioning bounds the popup to the viewport and flips it upward when needed. No inline scripts, relaxed CSP, or native operating-system select popup are required.

## Personal channel authorization

The chooser offers Feishu Bot (manual credentials), Feishu personal app (scoped app-registration QR), and Remote Nootify. The `connection_type` stored for each Feishu channel determines its list label and editor; the transport remains Feishu in both cases.

Channel dialogs retain the upstream 440px bounded width, 24px padding, and standard action row with 20px top spacing. Their form fields use a vertical flow; long forms scroll as native dialogs rather than introducing a separate footer surface. Local CSS only groups fields, aligns header icons, and sizes the functional QR.

A personal scan records the channel name and enabled state before starting. The standard editor then hides the configuration fields and shows only the QR, official authorization link, expiry, and Cancel. Cancellation while saving is refused; a completion racing Cancel is reconciled before closing, with focus returning to the saved entry. Failed and uncertain save outcomes do not silently retry. Completion restores the personal editor, which exposes Reconnect (stored credentials), same-app reauthorization, and permission checks without revealing an App Secret. Missing scopes are linked to the official app console; scanning alone does not grant them.

## Verification

`npm run preview:ui` serves synthetic data through the direct local UI transport, with an optional encrypted gateway URL. Local editing does not require a capsule or authorization prompt; remote access remains read-only for settings. It supports provider CRUD, remote settings, repository choices, agent toggles, language switching and contact selection without modifying production state. Personal authorization uses an explicitly synthetic QR flow; `--hold-registration` holds its waiting state for visual inspection. Real OAuth and filesystem operations remain unavailable.

Regression coverage includes `test/dropdown.test.ts`, `test/providers-ui.test.ts`, `test/logs-ui.test.ts`, `test/recipient-list.test.ts`, and i18n/update UI checks. `test/ui.test.ts` follows the served stylesheet dependency graph to verify every local CSS import, font, and SVG is reachable with the correct MIME type; unknown vendor paths remain unavailable. `test/ui-owner-auth.test.ts` covers the trusted gateway and authorization boundary.
