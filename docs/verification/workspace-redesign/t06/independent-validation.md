# T06 Independent Validation — Bot Observability Chain

**Status: DONE_WITH_CONCERNS**  
**Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`; dirty workspace). No source or test files were changed by this validation.

## Checkpoint integrity

- PRE manifest contains 30 unique paths; recomputing SHA-256 for every saved `PRE/files/<path>` snapshot matched all 30 manifest hashes.
- POST incremental manifest contains exactly four paths, all marked `delta: true`. Recomputed current-worktree hashes match all four POST hashes:

| File | POST SHA-256 |
|---|---|
| `dataset-detail.tsx` | `ffab001960b18cb110167937d3100591e993d5ae458175256afde875248a8b93` |
| `experiment-comparison.tsx` | `60d0907020aec17fbb5d4149a40b2df40e16961e55354d254e568b369bdd0588` |
| `experiment-results.tsx` | `cba62102e63056ad54fa1f893e3ed079ef3b2a2416aa7dcc993f3ccca9522d45` |
| `experiments-section.tsx` | `5f84e55296aa4081c702ae4029ae491c7cf1540ecc0ccf2932b381f68159ea0a` |

## Verification evidence

- **Driven tests:** Re-ran `E2E_BUN_ONLY=app/tests/ai-observability E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t06/independent-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; runner reports **1 file / 1 test passed** (`bun runtime suite app/tests/ai-observability`). This count is the e2e driver test, not an assertion count for the nested Bun suite. The run skipped collection of unrelated `bot-subpage`, `routines-list`, and billing integration files due Node's unsupported `bun:` protocol. Preload emitted repeated example `KEY_ENCRYPTION_KEY` warnings. These skips are outside the selected observability suite.
- The implementation report's `driven/report.json` is bound to this revision but has the same runner-level count (1 executed / 1 passed, 7,942 discovered). It has no warning field and does not preserve the nested Bun assertion count; the rerun stdout clarifies skips and warnings.
- **Biome:** `bunx biome check app/src/components/ai-observability/dataset-detail.tsx app/src/components/ai-observability/experiment-results.tsx app/src/components/ai-observability/experiment-comparison.tsx app/src/components/ai-observability/experiments-section.tsx` — exit 0; 4 files checked, no fixes.
- **Typecheck:** `bun run --cwd app typecheck` — exit 2, one diagnostic: `app/tests/button-native.test.tsx:54:13` TS2322 (callback ref returns `HTMLButtonElement | null`; React 19 callback ref expects void or cleanup). This test is outside T06's 30 paths and was not changed in the T06 POST delta.

## P16–P23 source review

Reviewed each route/component against `docs/design/2026-10-20-workspace-redesign/pages.md` and the T06 brief. Routes retain the nested run/evaluation Outlet behavior and `requireBotObservabilityAccess` on the list routes; detail/export routes retain their existing guarded query behavior and Back links. P16 retains filters, cursor state, explicit syncing/empty/fault distinctions and unknown values. P18–P20 preserve dataset navigation, version facts, empty and fault handling; P19's dataset and experiment sections remain independent and the changed section shows an availability notice on a dataset read fault. P21 keeps pending/running cancellation, failed/missing values and separate score/statistic fallbacks. P22 preserves unaddressed selection, compatibility/missing states, direction/unit labeling and JSON download. P23 preserves queued/running/success/failed/unavailable distinctions and only exposes artifact download for completed jobs.

**Acceptance gap:** P17's design acceptance calls for expandable/collapsible technical steps (`pages.md`, P17). `run-steps.tsx` renders the step tree directly; source inspection found no disclosure/expand control or collapsed state. The implementation report acknowledges this and says it intentionally did not add one. This remains a source-level gap pending resolution against the P17 acceptance.

Source inspection supports distinct loading/pending, empty, unavailable/fault and successful states and the observed existing keyboard-operable controls use native buttons/inputs/links with labels in the inspected paths. Responsive source uses wrapping/stacking and local data containers where present; **390px behavior, visual hierarchy, focus appearance, and browser interaction were not exercised**. Browser/rendered acceptance was explicitly deferred in the T06 brief, so no browser pass is claimed.

## Validation commands

- `git rev-parse HEAD`
- Python SHA-256 verification script over `PRE/manifest.json`, every PRE snapshot, and `POST/manifest.json` plus the four current source files.
- `bunx biome check app/src/components/ai-observability/dataset-detail.tsx app/src/components/ai-observability/experiment-results.tsx app/src/components/ai-observability/experiment-comparison.tsx app/src/components/ai-observability/experiments-section.tsx`
- `bun run --cwd app typecheck`
- `E2E_BUN_ONLY=app/tests/ai-observability E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t06/independent-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`
