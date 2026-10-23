# R3A Field false-state test: independent validation

**Result:** DONE_WITH_CONCERNS (focused acceptance passed; unrelated suite collection skip)
**Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (no commits)
**Plan / implementation report:** `docs/plans/2026-10-23-b1-ocr-repair-03a.md`; `docs/plans/reports/2026-10-23-b1-ocr-repair-03a-impl.md`.
**PRE evidence:** `PRE/checkpoint.sha256` records test SHA-256 `4bfafa765bab895160e7190533974dc7621932d8ae28c7ee044b6c25df155b6f`.

## Checkpoint binding

The four production files match R3 `POST-independent.sha256` exactly:

- `app/src/components/ui/field.tsx` — `89e0fb6b8f22cb239a64cc5e112a4a0c366b3c3f53fe539886b52ccf906eec73`
- `app/src/components/ui/item.tsx` — `0bbd4287436c5ebb2595e7d6358b96a39b0b6396a7a2588b1fdd28e46a1f7b71`
- `app/src/components/ui/input.tsx` — `95829e4c97a39c267d062cb6a2295c435f9d6e41ae256cbf2ed5d04c632a70ae`
- `app/src/components/ui/questionnaire.tsx` — `e9dd7622e4f300efbcc1859e2e3746e4376b013f8e6f20aded74e5849f43aab5`

Final test file `app/tests/ui-wrapper-merge.test.tsx` SHA-256: `7889d781c02396f2720a8ae29b1cf0b9c44d89daccea09e86bad32de6978fe1e`, matching the R3A implementation report POST.

The new check renders `<Field data-invalid="false" />` and asserts the resulting `[data-slot=field]` lacks the attribute. With the pre-R3 spread ordering, the original string prop would be spread onto the DOM as `data-invalid="false"`, so `hasAttribute` would return true and this assertion would fail. In current implementation the prop is removed before forwarding and normalized state is written as `false || undefined`, so the attribute is absent.

## Commands and results

- `sha256sum app/src/components/ui/field.tsx app/src/components/ui/item.tsx app/src/components/ui/input.tsx app/src/components/ui/questionnaire.tsx app/tests/ui-wrapper-merge.test.tsx` — PASS; hashes above.
- `bunx e2e run --config e2e.unit.config.ts app/tests/ui-wrapper-merge.test.tsx` — PASS, 1 file / 2 tests, including false-state assertion. Runner emitted the known unrelated skip for `server/tests/billing-period-fulfillment.integration.test.ts`: Node ESM loader cannot load its `bun:` protocol import.
- `bunx biome check app/tests/ui-wrapper-merge.test.tsx app/src/components/ui/field.tsx app/src/components/ui/item.tsx app/src/components/ui/input.tsx app/src/components/ui/questionnaire.tsx` — PASS, 5 files, no fixes applied.
- `git diff --check` — PASS (exit 0, no output).

## Scope and limitations

Validation is bound to the current test hash and matching R3 source hashes. No source or test files were changed during validation. Accessibility, responsive browser rendering, and live browser interaction are not applicable to this test-only assertion; rendered DOM behavior is covered by the focused test. The unrelated billing collection skip remains a runner/environment limitation and was not evaluated by this focused check. The worktree contains other concurrent/unrelated modifications; they were left untouched.
