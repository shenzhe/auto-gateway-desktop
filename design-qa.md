# Configuration Step Design QA

## Reference and implementation

- Reference: `/var/folders/33/36dkdkyj78v0h0kz9rtjsp4c0000gn/T/codex-clipboard-fdf319aa-5564-4d2e-bf87-90d111663ce6.png`
- Loading state: `design-qa-configuration-loading.png`
- Completed state: `design-qa-configuration-complete.png`
- Focused comparison state: `design-qa-configuration-focused.png`
- Side-by-side comparison: `design-qa-comparison.png`
- Preview routes:
  - `http://127.0.0.1:4173/?preview=configuration-loading`
  - `http://127.0.0.1:4173/?preview=configuration-complete`

## Normalization

- Source viewport: 2048 × 608 pixels.
- Implementation viewport: 2048 × 608 pixels for the loading-state full view and 2048 × 900 pixels for the focused content capture.
- The source image is a cropped content-area reference, so the focused implementation capture excludes the wizard sidebar and compares the configuration surface directly.
- Browser density: default desktop density.
- Theme and locale: light theme, English locale. Chinese strings were verified through the existing localization resource and production build.

## Required states and surfaces

- Loading button displays an animated spinner and a configuring label.
- A newly generated API key is shown in a dedicated, copyable field.
- Automatic Codex configuration runs after key creation without an extra click.
- The primary action changes to Next only after configuration completes.
- The Manage API Key button is absent.
- Previous is disabled while configuration is running.
- Copy feedback changes to Copied after activation.
- Next transitions to the finish step after configuration completes.
- No warning or error entries are emitted by the browser preview.

## Iteration history

1. Implemented the automatic key-creation and configuration state machine, API-key reveal, copy action, spinner, retry state, and completed-state Next action.
2. Removed the Manage API Key action and retained the existing full-width status surface and bottom-right navigation hierarchy.
3. Added isolated design-preview states for loading and completion.
4. Found that the browser preview initialized Tauri event listeners and emitted preview-only errors. Guarded desktop event and deep-link listeners during preview, then re-ran the visual and interaction checks with a clean console.

## Findings

- P0: none.
- P1: none.
- P2: none remaining.
- The completed implementation adds the API-key field inside the existing status card. This intentionally increases the card height while preserving the reference palette, spacing rhythm, border treatment, and right-aligned action layout.

## Final result

passed

---

# Codex Update Button Alignment QA

## Reference and implementation

- Reference: `/var/folders/33/36dkdkyj78v0h0kz9rtjsp4c0000gn/T/codex-clipboard-7ba462d1-403c-4e74-9826-60c35fa5d320.png`
- Implementation: `design-qa-codex-update-layout.png`
- Focused implementation: `design-qa-codex-update-notice.png`
- Side-by-side comparison: `design-qa-codex-update-comparison.png`
- Preview route: `http://127.0.0.1:4173/?preview=codex-update`

## Normalization

- Source viewport: 2048 × 608 pixels.
- Implementation viewport: 2048 × 608 CSS pixels at default desktop density.
- The source is a content-area crop; the focused comparison normalizes both images to the update-notice region before comparing typography, spacing, and alignment.
- State: signed-in, installed Codex with a newer version available, light theme, English implementation text. The localized Chinese copy uses the same layout and controls.

## Findings and fixes

- [P1] The update action was previously placed in the bottom navigation row, separated from the two version values.
  - Fix: moved the action into the version grid as its third aligned column.
  - Evidence: `design-qa-codex-update-comparison.png` shows the installed version, latest version, and update action on one row.
- P0: none remaining.
- P1: none remaining.
- P2: none remaining.

## Required fidelity surfaces

- Fonts and typography: existing app font stack, weights, and compact version-label hierarchy are preserved.
- Spacing and layout rhythm: the update control aligns to the version-value row, with an 18-pixel grid gap and the existing notice padding and border radius.
- Colors and visual tokens: the existing warning notice surface and primary-outline update control remain unchanged.
- Image quality and assets: no image assets are used by this screen.
- Copy and content: the localized update copy, installed version, and latest version remain unchanged.

## Verification

- Confirmed the update action appears once in the version row and is removed from the bottom navigation.
- Confirmed Previous and Next remain in the bottom navigation.
- Confirmed the preview has no browser warnings or errors.
- Confirmed production TypeScript and Vite build completes successfully.

## Final result

passed
