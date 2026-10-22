# T03-R1 Independent Validation Brief

- Role: `frontend_validator`, read-only for product/test source; write only the report `docs/verification/workspace-redesign/t03-r1/independent-validation.md` and runner artifacts.
- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- Exact increment: `docs/verification/workspace-redesign/execution/checkpoints/t03-r1/delta.patch`, SHA `96ae5928a597c79821f6e9addc0ce9097625a2fbbfbd86c718263ac9af68725d`.
- Inputs: repair plan `docs/plans/2026-10-20-workspace-redesign-b1-t03-repair-01.md`, original T03 review and R1 report, PRE/POST manifests and snapshots, ADR0008.
- Independently recompute PRE/POST/live hashes and patch hash. Rerun `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx app/tests/sidebar-preference.test.ts app/tests/sidebar-shortcut-layouts.test.tsx`; confirm counts/exits. If any group uses driven runner per ADR, verify only when needed; do not change runner configuration/source.
- Validate behavior contracts at source/test level: shell widths, sidebar write/no-write transitions, delayed Craft query seed after remount, DetailPanel draft close/unmount. Do not perform browser checks; user deferred them.
- Report exact results, counts, exits, same-hash in `docs/verification/workspace-redesign/t03-r1/independent-validation.md`. No source edits, commit, dependencies, or agent delegation.
