# Shared application controls

The local UI uses the application palette, typography, fields, and focus states in `public/styles.css`. Reuse these controls rather than introducing native popup styling or a separate component library.

## Dropdown

`src/dropdown.ts` exports `Dropdown`, a select-only combobox with an application-styled button and listbox. The language control in `public/index.html` is the complete markup example.

- The trigger is a `button` with the shared `setting-field dropdown-button` classes, an accessible label, and a `[data-dropdown-label]` child. Its string `value` holds the committed selection.
- The popup has class `dropdown-menu` and role `listbox`. Each option is a button with class `dropdown-option`, role `option`, a unique `data-value`, and a `[data-option-label]` child. A `dropdown-check` SVG indicates the selected option.
- The component links the trigger and popup through ARIA, assigns option IDs, and portals the popup to `document.body` to escape clipping cards. Do not position the popup inside an overflow-hidden settings group.

```ts
import { Dropdown } from './dropdown.js';

const control = new Dropdown(button, menu);
control.value = 'system';
button.addEventListener('change', () => {
  // Commit control.value to this setting's state.
});
```

The `value` getter reads the trigger's current DOM value. Its setter updates the label and selected state without emitting a change event. User selection emits one bubbling `change` only when the committed value changes. `refresh()` rereads option labels after translation or option updates; `close()` dismisses without committing, and `close(true)` also restores trigger focus.

Focus remains on the trigger while open. Arrow keys, Home/End, and typeahead update the active option. Enter/Space commits; Escape cancels. Tab, outside interaction, route changes, resizing, and ancestor scrolling dismiss the popup. Internal menu scrolling remains usable. Disabled options are skipped, and popup positioning is bounded to the viewport with an upward flip when necessary. Handled keys do not trigger page shortcuts.

The stylesheet owns menu appearance through `--dropdown-radius`, `--dropdown-option-height`, and `--dropdown-shadow`. Panel, field, border, text, blue selection check, and neutral active-option colors come from the existing light/dark palette. Geometry uses individual CSSOM properties; the control does not require relaxed script or style CSP.

Regression coverage is in `test/dropdown.test.ts`; language integration and served-module coverage remain in the UI/i18n tests.
