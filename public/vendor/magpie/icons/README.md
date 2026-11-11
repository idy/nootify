# Phosphor Icons

Interface icons use **[Phosphor Icons](https://phosphoricons.com/)** in the
**Regular** weight, vendored from `@phosphor-icons/core` **2.1.1**. They are
local SVG assets with no runtime dependency or external icon service.

The original [MIT license and copyright notice](LICENSE) are included.
[manifest.json](manifest.json) records the exact upstream release archive,
its npm SHA-512 integrity value and the mapping from public sprite IDs to
Phosphor filenames.

## Usage

```html
<svg class="mds-icon" aria-hidden="true">
  <use href="/assets/mds/icons/icons.svg#reload"/>
</svg>
```

The sprite preserves the existing Magpie IDs for compatibility. Its paths
use Phosphor's 256 × 256 viewBox, inherit `currentColor`, and already encode
the Regular weight as filled geometry. Do not add a CSS stroke; that would
change the upstream icon weight. The authored Magpie brand mark is a logo,
separate from the interface icon set.

| Magpie ID | Phosphor Regular icon |
| --- | --- |
| `link` | `link` |
| `globe` | `globe` |
| `route` | `path` |
| `device` | `desktop` |
| `code` | `code` |
| `copy` | `copy` |
| `reload` | `arrow-clockwise` |
| `check` | `check` |
| `file` | `file-text` |
| `lock` | `lock-simple` |
| `up` | `arrow-up` |
| `x` | `x` |
| `alert` | `warning` |
| `info` | `info` |
| `palette` | `palette` |
| `type` | `text-t` |
| `toggle` | `toggle-right` |
| `layout` | `sidebar` |
| `bell` | `bell` |
| `minimize` | `minus` |
| `maximize` | `square` |
| `caret-down` | `caret-down` |
| `spinner` | `circle-notch` |

`caret-down.svg`, `check.svg` and `spinner.svg` expose the same upstream
geometry as standalone assets for CSS controls. The select caret has a
neutral fill for native-select fallback; the check and spinner are used as
CSS masks so their colours follow the theme tokens.
