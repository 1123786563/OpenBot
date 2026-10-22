# T04 Independent Review Brief

- Role `reviewer`; read-only, separate Spec and quality verdicts.
- Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- Delta `checkpoints/t04/delta.patch`, SHA `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`.
- Report `docs/plans/reports/T04-review.md`.
- Inputs T04 brief, P06/P07 route-acceptance entries, relevant implementation spec, T04 implementation report, PRE/POST manifests and snapshots.
- Review only the four-file delta: existing `groupRoster` precedence and action behavior unchanged; hidden group folded; 64px min row, two-line long text and fixed action area; profile content order; config/manage expanded; danger Delete separate, confirmation/permission preserved; no data/API/route/search behavior changed. Validate all modified files and patch hash. Browser evidence is deferred, so do not claim rendered overflow or computed style.
- No tests/source edit/commit. Findings include exact file/line/severity and separate verdicts.
