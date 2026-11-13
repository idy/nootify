# Bundled typefaces

These WOFF2 assets are served from the same origin as the application.
No external font service is required at runtime.

| Typeface | Asset | Role | Weights requested by this library |
| --- | --- | --- | --- |
| Outfit | `outfit-latin.woff2` | Large titles and button actions | 300 only (static Light face) |
| Source Sans 3 | `source-sans-3-latin.woff2` | Headings, body copy, navigation and other interface text | 400; 700 only for explicit body emphasis |

Both files are unmodified Google Fonts Latin subsets. Source Sans 3 is a
variable font with a `wght` axis from 200 to 900; Outfit is a static Light
face at weight 300.

- [Outfit asset](https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4W61O4a0EwItq6fNIg.woff2), SHA-256 `642044f7e80e815f6f7d89d5a0f57b51e5f9992a62bc1dd03f7f444176529f71`.
- [Source Sans 3 asset](https://fonts.gstatic.com/s/sourcesans3/v20/nwpStKy2OAdR1K-IwhWudF-R3w8aZejf5Hc.woff2), SHA-256 `587435ca9d90732b8c1ce4958222c6ad3ade2b875500188e1d318efbcb61f4c5`.

The files contain Latin glyphs. CJK text uses the system fallback in the
font-family tokens. Technical code and addresses retain the separate
`--mds-mono` stack. Interface text uses regular weight, including selected states;
large titles and button actions use light weight.

Both typefaces are distributed under the SIL Open Font License 1.1;
the original copyright notices and full license texts are included:

- [Outfit](Outfit-OFL.txt): The Outfit Project Authors; [upstream license](https://github.com/google/fonts/blob/main/ofl/outfit/OFL.txt).
- [Source Sans 3](Source-Sans-3-OFL.txt): Adobe; [upstream license](https://github.com/google/fonts/blob/main/ofl/sourcesans3/OFL.txt).

The font files retain their own licenses and are not covered by the
repository's MIT license. Keep the license files when vendoring the fonts.
