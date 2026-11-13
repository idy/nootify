# Magpie Design System (vendored)

Source: https://github.com/idy/magpie-design-system

Bundled release: **v0.4.4**

Commit: **fc0e8f1c43521b22b72d3be4223ea924189c1adb**

The `css/`, `fonts/`, `icons/`, and root `LICENSE` are unmodified files from this release. Nootify consumes the CSS components and tokens, retaining its existing routing, accessible dropdown controller, and native dialog lifecycle. JavaScript helpers remain owned by the application and are not downloaded or bundled from Magpie.

## Runtime resources

The service checks jsDelivr for the latest stable release in the background at startup and every six hours. It downloads the complete CSS, font, icon, and license set into `STATE_DIR/ui-assets/magpie`, checking every file's size and SHA256 against the pinned release manifest before making that cache available. A complete validated cached release is used only when newer than this bundled baseline. Offline or failed checks retain a usable cached release or fall back to the checked-in bundle.

Resources are served on the same origin; the stable stylesheet URL resolves to a versioned path such as `/ui/vendor/magpie/@v0.4.4/css/magpie.css`. Preserve all upstream relative font, import, and icon paths. Versioned stylesheets keep CSS imports and referenced fonts and icon masks on one release. HTML SVG references use stable paths and resolve to the active release when requested. A newly downloaded stylesheet takes effect on the next page load. The browser does not fetch Magpie directly from the CDN. No additional settings or JavaScript framework is needed.

## Updating the bundled baseline

From the repository root, run:

```sh
npm run vendor:magpie
```

`scripts/sync-magpie.mjs` uses the same jsDelivr metadata endpoints as the runtime:

- Latest stable version: `https://data.jsdelivr.com/v1/package/resolve/gh/idy/magpie-design-system@latest`
- Pinned file manifest: `https://data.jsdelivr.com/v1/package/gh/idy/magpie-design-system@vVERSION/flat`
- Pinned file bytes: `https://cdn.jsdelivr.net/gh/idy/magpie-design-system@vVERSION/PATH`

The command downloads only `css/`, `fonts/`, `icons/`, and root `LICENSE` into a new empty temporary directory. It validates paths, sizes, and SHA256 base64 hashes for every selected file before replacing the bundled directory. A staged directory swap removes obsolete upstream assets and preserves this Nootify provenance README. Downloaded scripts are never included or executed. Normal builds and desktop packaging use the checked-in bundle without running this maintenance command or querying the CDN.

The local `manifest.json` records the runtime baseline as `{ "version": "v0.4.4", "files": [{ "name": "css/base.css", "hash": "<SHA256 base64>", "size": 2109 }] }`. Each `name` is relative without a leading slash; `size` counts bytes; every upstream resource is listed. This local manifest and this README are Nootify metadata, outside the upstream file list.

After syncing, resolve the release tag to its commit, update this provenance and the application/design documentation, and review the bundle diff. Keep application-specific styles in `public/styles.css`; never patch the vendored styles in place. Verify the UI asset paths and interactions separately.

Licenses: `LICENSE` covers this library; `css/Magpie-MIT.txt` retains Magpie's MIT attribution; `icons/LICENSE` covers the Phosphor assets; `fonts/` contains the bundled Outfit and Source Sans 3 OFL notices. The icon manifest records upstream provenance.
