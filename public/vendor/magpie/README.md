# Magpie Design System (vendored)

Source: https://github.com/idy/magpie-design-system

Release: **v0.4.1**

Commit: **284dd0341351fb4bbeaf55ce1a6658397c7d5941**

The `css/`, `fonts/`, `icons/`, and root `LICENSE` are unmodified files from this release. Nootify consumes the CSS components and tokens, retaining its existing routing, accessible dropdown controller, and native dialog lifecycle. JavaScript helpers are not bundled because the application owns those behaviors.

All runtime resources are served on the same origin under `/ui/vendor/magpie/`. Relative font and icon paths must be preserved. The desktop staging task includes this directory automatically.

To update, replace these directories and the root license together from a reviewed upstream release, update this provenance, and run the UI asset and interaction tests. Keep application-specific styles in `public/styles.css`; never patch the vendored styles in place.

Licenses: `LICENSE` covers this library; `css/Magpie-MIT.txt` retains Magpie's MIT attribution; `icons/LICENSE` covers the Phosphor assets; `fonts/` contains the bundled fonts' OFL notices. The icon manifest records upstream provenance.
