# Bundled typefaces

These WOFF2 assets are reused unchanged from the existing idy.dev shared
assets in [TailSplit](https://github.com/idy/tailsplit/tree/main/site/shared).
They are served from the same origin as the application. No external font
service is required.

| Typeface | Asset | Role | Weights requested by this library |
| --- | --- | --- | --- |
| Montserrat | `montserrat-latin.woff2` | Large titles and actions | 400–800 (variable) |
| Monda | `monda-latin.woff2` | Ordinary headings and field titles | 400, regular only |
| Lato | `lato-regular-latin.woff2` | Body copy and other interface text | 400 |
| Lato | `lato-bold-latin.woff2` | Emphasised body text and selected options | 700 |

The files contain Latin glyphs. CJK text uses the system fallback in the
font-family tokens. Technical code and addresses retain the separate
`--mds-mono` stack.

All three typefaces are distributed under the SIL Open Font License 1.1;
the original copyright notices and full license texts are included:

- [Montserrat](Montserrat-OFL.txt): The Montserrat Project Authors.
- [Monda](Monda-OFL.txt): The Monda Project Authors.
- [Lato](Lato-OFL.txt): tyPoland Lukasz Dziedzic.

The font files retain their own licenses and are not covered by the
repository's MIT license. Keep the license files when vendoring the fonts.
