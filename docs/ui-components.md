# Shared application controls

Nootify bundles [Magpie Design System v0.4.4](https://github.com/idy/magpie-design-system/tree/v0.4.4). The unmodified CSS, font, and icon assets live in `public/vendor/magpie/`; its [README](../public/vendor/magpie/README.md) records the exact release, commit, license notices, and update procedure. The root Go module embeds browser assets through `public/assets.go`, and `internal/webui/` owns trusted asset serving for the Go host and desktop gateway. The stable Magpie stylesheet URL resolves to a versioned same-origin path such as `/ui/vendor/magpie/@v0.4.4/css/magpie.css`; preserve upstream relative CSS, font, and icon paths.

`public/styles.css` imports the upstream stylesheet. Magpie owns palette, typography, focus, standard control skins, automatic system appearance, and reduced motion. Nootify owns its 224px navigation column, centered 960px working column, native window-control clearance, live lists, recipient picker, provider editor, and narrow-screen composition. Keep application overrides outside the vendor directory. JavaScript helpers, including dropdown behavior and dialog lifecycle, remain owned by the app.

## Resources and updates

At startup and every six hours, the service checks stable latest through `https://data.jsdelivr.com/v1/package/resolve/gh/idy/magpie-design-system@latest`. It pins the resolved `vVERSION`, reads `https://data.jsdelivr.com/v1/package/gh/idy/magpie-design-system@vVERSION/flat`, and downloads resources from `https://cdn.jsdelivr.net/gh/idy/magpie-design-system@vVERSION/PATH`. Only the complete CSS, font, icon, and license set is cached at `STATE_DIR/ui-assets/magpie`; every file's byte size and SHA256 base64 must match the manifest before activation. Cached releases are preferred only when newer than the bundled baseline. A usable validated cache or the bundle remains available offline or after a failed update.

The browser loads assets from the local origin, keeping the existing CSP. Versioned stylesheets keep CSS imports and referenced fonts and icon masks on one release; a downloaded stylesheet takes effect on the next page load. HTML SVG references use stable paths and resolve to the active release when requested. This automatic background check adds no user setting and does not fetch upstream JavaScript helpers.

`npm run vendor:magpie` explicitly refreshes the checked-in baseline using the same endpoints and validation. The local `public/vendor/magpie/manifest.json` has a `version` such as `v0.4.4` and `files` entries containing relative `name` (no leading slash), SHA256 base64 `hash`, and byte `size`. Builds and desktop packaging use the checked-in bundle without networking; review provenance and design documentation when maintaining that baseline.

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
| Checkboxes | `mds-check` around the native input | Agent injection state |
| Language popup | `mds-select-menu`, `mds-select-option`, `mds-input` | Existing `Dropdown` controller and its dismissal semantics |
| Channel chooser/editor/delete dialogs | Unmodified `mds-dialog`, `mds-dialog-actions`, Magpie controls | Vertical form composition, native modal lifecycle/scrolling, async save and focus restoration; no local width, padding or footer-skin overrides |
| Recipient picker | `mds-dialog` with the application’s bounded-list composition | Independently scrolling contacts and reachable selection footer |

Filter buttons remain toggle buttons with `aria-pressed`, since they filter one list rather than switch tab panels. Delivery types and contact rows are domain compositions using Magpie tokens. The penguin stays Nootify's brand mark.

## Dropdown

`src/dropdown.ts` exports `Dropdown`, a select-only combobox. Nootify retains this controller so keyboard commits, focus restoration, and dismissal behavior remain compatible. It consumes Magpie's visual primitives rather than creating a second dropdown appearance.

- The trigger is a button with `setting-field dropdown-button mds-input`, an accessible label, and a `[data-dropdown-label]` child. Its string `value` holds the committed selection.
- The popup uses `dropdown-menu mds-select-menu` and `role="listbox"`. Options have `dropdown-option mds-select-option`, `role="option"`, unique `data-value`, and `[data-option-label]` children. The upstream CSS mask draws the selected check at regular text weight; the retained legacy SVG is hidden.
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

The personal-app editor includes **Recover previous authorization** for a refreshed/closed page or a lost start response. It restores the original name, enabled state, target channel and scan, so the owner can resume or cancel without waiting for expiry. A completed scan restores the persisted channel instead of creating another one. Recovery uses a local-only POST and never puts credentials in browser storage.

A personal scan records the channel name and enabled state before starting. The standard editor then hides the configuration fields and shows only the QR, official authorization link, expiry, and Cancel. Cancellation while saving is refused; a completion racing Cancel is reconciled before closing, with focus returning to the saved entry. Failed and uncertain save outcomes do not silently retry. Completion restores the personal editor, which exposes Reconnect (stored credentials), same-app reauthorization, and permission checks without revealing an App Secret. Missing scopes are linked to the official app console; scanning alone does not grant them.

## Verification

`npm run preview:ui` is an isolated synthetic browser fixture for channel dialogs, remote settings, agent toggles, language switching, and contact selection. Use the local URL printed by the command. Personal authorization uses an explicitly synthetic QR flow; real provider connections and filesystem actions are unavailable. Preview results do not prove that the Go host serves every embedded asset or that native transport and desktop integration work.

The production Go host allows direct loopback editing without an authorization link and preserves that access after a page reload, subject to actual peer, Host/origin/fetch-site, and UI-header checks. LAN settings remain read-only. The encrypted desktop/CLI gateway is separate from direct browser access.

Browser regression coverage includes `test/dropdown.test.ts`, `test/providers-ui.test.ts`, `test/logs-ui.test.ts`, `test/recipient-list.test.ts`, and i18n/update UI checks. Native HTTP and gateway coverage belongs under `internal/host/` and `internal/webui/`; per-channel registration/setup and recovery belong under `internal/settings/` and `internal/providers/`. Verify every local CSS import, font, and SVG through the built Go asset handler with the correct MIME type, including `/ui/vendor/magpie/`; unknown vendor paths must remain unavailable. Confirm desktop packaging and the real authorization boundary separately from the synthetic preview.
