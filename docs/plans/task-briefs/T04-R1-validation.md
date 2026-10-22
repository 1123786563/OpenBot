# T04-R1 Independent Validation Brief

- Role `frontend_validator`; read-only source/test, write only `docs/verification/workspace-redesign/t04-r1/independent-validation.md` and runner artifacts.
- Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`.
- Delta SHA `ee2537522984034554a211bae4d863e4b5cf8be9c73e9e8ec6ff45db356288c8` under `checkpoints/t04-r1/delta.patch`.
- Verify current POST hashes; rerun the correct ADR0008 driven `app/tests part 1` command recorded in `T04-R1-impl.md`; scoped Biome for both changed files. Confirm test asserts exact full 120-char name and 300-char description and absence of line-clamp. Don't rely on browser geometry. Report exact collection/pass/fail/skip and exit.
