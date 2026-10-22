# T03 independent frontend validation

Status: **DONE_WITH_CONCERNS** — same-checkpoint automated evidence and source identity pass; rendered/browser acceptance remains pending as explicitly deferred by the brief.

## Revision and integrity

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- Current HEAD / POST HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (no commit created).
- T03 POST incremental checkpoint SHA-256: `4c22784ae453cc3a8015e063d1f3592f6e4b05d7565cfff7139ba8d0be4f5f7d`.
- POST manifest SHA-256: `f864e2e1526d121af0fb0b7d4fda8ce59626d2124a466830c6fb8518bf3204d6`.
- Integrity command: `python3` script loading `docs/verification/workspace-redesign/execution/checkpoints/t03/POST/manifest.json`, SHA-256 hashing every listed path and comparing both hash and byte length, and hashing `delta.patch`.
- Result: all 31/31 manifest paths exist and match POST hashes/byte lengths; no changed or missing paths. `delta.patch` hash matches the brief exactly. Current HEAD matches POST `head.txt`.
- `git status --short` showed the broader pre-existing dirty workspace. No business/test source was changed during validation; only this report was added.

## Same-checkpoint evidence reused

The implementation report is bound to the POST checkpoint above and records these commands/results; the source manifest independently confirms the tested source/test files still match that checkpoint. As permitted by the brief, no redundant suite rerun was needed.

| Exact command | Collection and result | Exit |
|---|---|---:|
| `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx app/tests/sidebar-preference.test.ts app/tests/sidebar-shortcut-layouts.test.tsx app/tests/skill-form.test.ts` | 4 files; 20 tests passed (3/3, 4/4, 3/3, 10/10 respectively); 0 failed, 0 skipped | 0 |
| `E2E_BUN_ONLY='app/src' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 1 driven outer group passed; 0 failed/skipped at outer level | 0 |
| `E2E_BUN_ONLY='app/tests part 3' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 1 driven outer group passed, includes `app/tests/computer-control-button.test.tsx`; inner per-file case totals are not reported by this driver | 0 |
| `E2E_BUN_ONLY='app/tests part 4' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 1 driven outer group passed; includes `app/tests/skills-read-failure.test.tsx`; inner per-file case totals are not reported by this driver | 0 |

The tracked-scope static check is also recorded in the same-checkpoint implementation report: `bunx biome check` over the 14 changed source/test files, exit 0, no fixes. TypeScript was run there as `node_modules/.bin/tsc --noEmit -p app/tsconfig.json`; exit 2 from the existing unrelated `app/tests/button-native.test.tsx:54` ref callback typing error, with no T03-owned source diagnostics.

## Acceptance assessment

- Sidebar preference initialization and storage vocabulary: automated native suite covers missing/expanded/collapsed and round-trip values. T03 source remains byte-identical to POST.
- Responsive persistence isolation and shortcut/layout behavior: implementation report records targeted preference and shortcut/layout suites passing. The report does not give test-by-test collection detail beyond totals.
- Detail lifecycle: native test covers caller-owned value and dirty state through 960→959→960, verifies no close callback, and checks explicit close unmount behavior. It intentionally does not assert DOM identity.
- Skills transferred draft/form behavior: skill form native tests passed; driven `app/src` group passed. The tests do not establish a real browser-entered draft through an actual rendered breakpoint transition.
- Computer control release: the driven computer group passed and includes the control-button regression test. This is source-level automated evidence only.
- Accessibility and rendered responsive behavior: not independently established in a browser. The assigned brief explicitly says browser checks were deferred; keyboard/focus behavior, computed geometry at C=879/880 and 959/960, real resize preference write counts, URL/Back behavior, and actual Skills/Craft draft preservation remain unverified. The implementation report also lists Craft task draft browser interaction among pending acceptance evidence.

## Risks / gaps

1. Browser-rendered acceptance remains pending, so T03 is not fully verified against the responsive UI and accessibility acceptance described in the implementation detail and plan.
2. The Skills and Craft user-entered draft lifecycle and the browser-level computer-control release path were not demonstrated by the automated source-level suites.
3. App TypeScript remains red for the unrelated T02 test typing error described above; no T03-owned TypeScript issue was reported.
4. Driven groups expose one outer e2e test each, so inner Bun totals are unavailable in the evidence summarized by the implementation report.
