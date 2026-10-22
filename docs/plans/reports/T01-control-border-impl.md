# T01 control-border cascade repair implementation report

## Outcome

Implemented the bounded cascade repair. HeroUI's shared `base.css` reset was imported without a cascade layer, so its universal `border-color: var(--border, currentColor)` declaration outranked the layered utility classes on controls. The import now uses the existing `base` layer, below HeroUI `components` and Tailwind `utilities`, preserving the shared global border baseline while allowing explicit wrapper border utilities to win.

Added a focused assertion that the public Textarea wrapper carries `border-[var(--ob-control-border)]`. Existing Input and outline Button assertions already guard the same token contract.

## Changed files

- `app/src/styles.css` — place HeroUI base reset in `layer(base)`.
- `app/tests/button-native.test.tsx` — assert Textarea's semantic control-border utility.

The files were already dirty at the PRE checkpoint. Existing work was preserved; the implementation delta is limited to the import layer and one assertion.

## Verification

- `bunx biome check app/src/styles.css app/tests/button-native.test.tsx` — passed; 2 files checked, no fixes.
- `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t01/control-border-repair/native-report bunx e2e run --config e2e.unit.config.ts app/tests/button-native.test.tsx` — passed; 1 file, 9 tests.
- `git diff --check -- app/src/styles.css app/tests/button-native.test.tsx` — passed.
- Browser computed-style validation in light/dark for Input, Textarea, Select, Combobox and outline Button, including dimensions and focus/Escape behavior — pending coordinator; this implementation report does not claim browser acceptance.

## Checkpoint

- PRE HEAD: `203d0f0244b2f898218fa12027089c631e8448d9`.
- POST snapshot: `docs/verification/workspace-redesign/t01/control-border-repair/POST/`.
- `hashes.txt` records the resulting working source files; `snapshot-hashes.txt` verifies the preserved copies in `files/`.
- No commits, dependency changes or OCR were performed.

## Assumptions and remaining risk

The cascade ordering follows the existing declared layer order (`base`, `components`, `utilities`, then app layers). Confirming browser-computed values and behavior remains part of coordinator validation. No other visual behavior was adjusted.
