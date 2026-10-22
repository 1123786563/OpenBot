# T03 independent frontend validation brief

- **Role:** `frontend_validator`; read-only for product/test source. You may write only the validation report/artifacts under `docs/verification/workspace-redesign/t03/`.
- **Worktree:** `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- **Scope:** verify T03 report claims for responsive shell preference behavior, DetailPanel state preservation, transferred Skills/Craft draft state, and computer control release. Use the exact current POST checkpoint SHA `4c22784ae453cc3a8015e063d1f3592f6e4b05d7565cfff7139ba8d0be4f5f7d`.
- **Inputs:** plan Task 3, `implementation-detail.md` §§3–6, `docs/plans/reports/T03-impl.md`, checkpoint PRE/POST manifests and `delta.patch`, ADR0008.
- **Checks:** independently verify live source matches POST manifest; run the targeted native suite and relevant driven groups if evidence is not already same-hash. No browser checks; user deferred them. Do not edit business/test source to fix failures. Report exact commands, collection/pass/fail/skip counts and exits, plus limitations at `docs/verification/workspace-redesign/t03/independent-validation.md`.
- **Constraint:** no commits, dependencies, or source changes. Browser rendered acceptance remains pending.
