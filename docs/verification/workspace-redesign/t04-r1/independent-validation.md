# T04-R1 Independent Validation

- **Status:** DONE_WITH_CONCERNS
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`), dirty worktree.
- **Assigned delta:** `docs/verification/workspace-redesign/execution/checkpoints/t04-r1/delta.patch`, SHA-256 `ee2537522984034554a211bae4d863e4b5cf8be9c73e9e8ec6ff45db356288c8` (matches brief).
- **POST hashes:** matched checkpoint manifest: `app/src/components/bot-profile/profile.tsx` `28d24ba4e25439ad78f9ac7100d2f0994ddeb4ea3bd3f3b73acbb3ab33ab7c5f`; `app/tests/bot-profile-active.test.tsx` `ec0f82ca603ccff739a83f84d9f5364006d0ae3ae37bfa199033addeced7e67f`.

## Validation

1. `E2E_BUN_ONLY='app/tests part 1' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t04-r1/independent-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **exit 0**. Collection discovered 7,942 tests; selected/executed 1 driver wrapper; passed 1, failed 0, skipped 0, interrupted 0. The driven Bun suite output notes four files that fail only when sharing a process; per ADR0008, each was isolated successfully. Runner artifact: `independent-driven/report.json`.
2. `bunx biome check app/src/components/bot-profile/profile.tsx app/tests/bot-profile-active.test.tsx` — **exit 0**, 2 files checked, no diagnostics.
3. Source assertion inspection in `app/tests/bot-profile-active.test.tsx` — `"Bot name ".repeat(13)` (9 chars × 13) plus `"end"` gives an exact 120-character name; `"D".repeat(300)` gives an exact 300-character description. Both full strings are queried via `findByText`/`getByText`; both elements assert `break-words` and assert class absence of `line-clamp`. The implementation removes the profile name/title/description clamp utilities while retaining wrapping.

## Acceptance gaps and risks

- Browser geometry, focus, 390px viewport, and 200% zoom were explicitly deferred by the implementation report and were not independently checked. The acceptance evidence here is DOM/class based, as assigned; it does not establish rendered geometry.
- The worktree contains extensive unrelated dirty/untracked changes. Validation was scoped to the two owned files; the runner used the current worktree at the stated HEAD. Those unrelated changes may affect broad workspace behavior, though no failure was observed in the assigned driven partition.
