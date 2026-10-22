# T04 Independent Frontend Validation Brief

- Role: `frontend_validator`; source/test read-only; write only `docs/verification/workspace-redesign/t04/independent-validation.md` and runner artifacts.
- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- Scope delta: `checkpoints/t04/delta.patch`, SHA `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`.
- Inputs: T04 brief/plan, P06/P07 acceptance, implementation report, PRE/POST manifests and snapshots, ADR0008.
- Verify patch and all current POST hashes. Rerun the seven targeted tests with the same native filter/runner and Bun-driven partition `E2E_BUN_ONLY='app/tests part 1' ... tests/bun-suites.test.ts` if valid to rerun. Do not change tests/config/source. Check actual collection/pass/fail/skip and classify any isolated sibling reruns from report output.
- Inspect observable contracts at source/test level: group precedence and hidden folded; large row size/wrapping/action shrink; P07 identity and action order; management/default sections and delete permission/confirmation preserved. Browser acceptance remains deferred.
- Report exact commands, counts, exits, hashes and limits to specified path. No commits/deps/browser checks.
