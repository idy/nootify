# Feishu recipient picker

Mode: Operate. Scope: the Feishu recipient selection dialog within Nootify settings.

## Direction contract

THESIS: A focused contact picker replaces the rejected full-width native select. People and selection lead; application IDs remain secondary.

OWN-WORLD: Inherit Nootify's local system type, restrained neutral surfaces, existing blue action color, and automatic light/dark appearance. Use one centered native dialog, compact search, human-readable nickname-plus-name rows, real provider avatars with quiet initial fallbacks, and a single clear selection action.

STORY: Open the picker, see cached or progressively loaded contacts immediately, search by name, choose one person, and confirm. Missing app permissions produce an honest administrator setup explanation, a locally generated official-console QR code, and retry. Manual ID entry remains a fallback.

FIRST VIEWPORT: A roughly 520px dialog with a title and close control, search field, 300–360px independently scrolling results, and a fixed footer. Names are primary; full open_ids never dominate the result rows. Loading, empty, permission, and network states occupy this same bounded frame.

FORM: User-pinned modal contact picker inside the existing settings surface. Seed reference: not applicable; no seed was generated. The new-work playbook explicitly excludes concept rolls for precisely specified local components (§1 and §3); the user's modal requirement fixes the form, and the incumbent app fixes the visual system. The signature interaction is useful results arriving while the remaining directory is still loading.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Acceptance: provider avatars with safe lazy loading and initial fallbacks; nickname-plus-name without duplicate formatting; keyboard selection and Escape; focus restoration; 375px width; light/dark; Chinese/English; progressive first results; valid permission QR; cancellation and retry; no remote contact or secret disclosure. No decorative raster assets ship.

## Evidence

- `../review/avatar-live.png` and `../review/avatar-mobile.png`: read-only actual configured-recipient check, showing the configured recipient's provider-formatted name and portrait. The supplied live-check record reports a loaded 72px Feishu CDN image; source CSS displays it at 36px. The mobile capture is the current 375px footer evidence: manual entry above separate cancel and confirm actions. No bulk directory identity check is implied.
- `../review/desktop.png`, `../review/dark.png`, `../review/permission-desktop.png`, `../review/permission-mobile.png`, and `../review/partial.png`: earlier synthetic-contact fixtures for layout, appearance, permission QR/retry, and usable partial results. `../review/mobile.png` predates the footer fix and is superseded by `avatar-mobile.png` for mobile acceptance.
- Source checked: `public/styles.css` root/light/dark tokens, shared controls and groups, recipient dialog and mobile rules; `public/index.html` dialog markup; `src/ui-app.ts` contact rendering, progressive states, explicit confirmation, cancellation, and focus restoration. `PRODUCT.md` and README Settings establish product behavior; this documentation pass does not rerun interaction or backend acceptance tests.
- `../../DESIGN.md` records the incumbent system; `../design.json` holds preview snippets and extension metadata. Photos are runtime provider data; the permission QR is generated locally. Neither is a decorative raster asset.
- Acceptance covers the mobile footer, draft-only persistence, profile presentation, and source-backed permission boundaries. Local-component provenance is user-pinned as recorded in FORM; no concept seed is required or generated.
