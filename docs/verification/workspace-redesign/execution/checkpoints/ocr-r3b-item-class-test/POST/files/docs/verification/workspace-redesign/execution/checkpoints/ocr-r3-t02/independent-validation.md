# R3 T02 independent validation

**Result:** DONE_WITH_CONCERNS  
**Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (no commits)  
**Validated source checkpoint:** the four R3 wrapper sources match implementation report POST SHA-256 exactly. Manifest: `POST-independent.sha256`.

## Checks and evidence

- `bunx e2e run --config e2e.unit.config.ts app/tests/ui-wrapper-merge.test.tsx` — PASS, 1 file / 2 tests, against test hash `4bfafa765bab895160e7190533974dc7621932d8ae28c7ee044b6c25df155b6f` and the four matching source hashes.
- `bunx e2e run --config e2e.unit.config.ts app/tests/item-disabled.test.tsx` — PASS, 1 file / 1 test, against matching source hashes.
- Both focused runs reported the unrelated server billing integration suite skipped at collection because Node cannot load its `bun:` import.
- `bunx biome check app/src/components/ui/field.tsx app/src/components/ui/item.tsx app/src/components/ui/input.tsx app/src/components/ui/questionnaire.tsx app/tests/ui-wrapper-merge.test.tsx` — PASS (5 files), on the same R3 source checkpoint and test hash above.
- `bun run --cwd app typecheck` — invoked; `generate:app-config` and `tsc --noEmit` ran with no diagnostic output. The implementation report independently records PASS against the same four source hashes. The test file was edited by R3A while the command was running; therefore do not treat this as evidence for the later test snapshot.
- `bun run --cwd app build` — PASS, Vite built successfully (exit 0; 18384 modules transformed). Existing third-party annotation, dynamic/static import, and large-chunk warnings remain.
- Built CSS in `app/dist/assets/index-*.css` contains emitted selectors for `pointer-coarse\\:h-11\\!`, `pointer-coarse\\:min-h-11\\!`, and `pointer-coarse\\:min-h-11`. This confirms compilation/emission, not live computed style under a coarse-pointer device.

## Acceptance assessment

- **Item merge:** assertions observe rendered element class and style taking precedence, wrapper-only style retention, and element handler running before Item handler. Pass.
- **Field normalized state:** current implementation removes caller `data-invalid` before forwarding and writes normalized boolean state last. However, the R3 test used `data-invalid="true"`; that assertion would also pass with the old spread ordering and does not demonstrate the regression. A false input assertion (e.g. `data-invalid="false"` results in no `data-invalid` attribute) would catch the prior behavior. This is an acceptance coverage gap. R3A changed the test after R3 validation; its new hash is in the manifest, but no rerun was done because the test owner was actively updating it. R3A must provide final test hash and bound rerun evidence.
- **Tailwind v4 touch rules:** production build succeeds and emits the important-modifier selectors. No live computed-style check was performed; report this limitation.

## Limitations / risks

This validates the four-source R3 checkpoint and the test snapshot that existed when focused checks ran. The test was subsequently changed by R3A (current observed hash `7889d781c02396f2720a8ae29b1cf0b9c44d89daccea09e86bad32de6978fe1e`); that hash is not covered by the R3 test run, Biome, or typecheck evidence recorded here. Revalidate R3A's final hash before claiming complete independent acceptance. No accessibility, responsive browser, or live interaction browser review was applicable to these shared wrapper fixes; interaction semantics were checked through rendered DOM tests. `git status` includes unrelated user/worktree changes, which were not modified.
