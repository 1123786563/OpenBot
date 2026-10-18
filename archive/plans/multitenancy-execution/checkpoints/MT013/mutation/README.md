# MT013 mutation testing

Target file: `server/src/enterprise/tenancy/startup-checks.ts`
Original sha256 (before first mutation, verified identical after each restore):
`7efcced630e3b38a48198888c88b63aef47873cdd7628d2494bda36a2f1276da`

Command per mutation: `cd server && bun --no-env-file test tests/multitenancy/startup-checks.test.ts`
(纯单元子集即可捕获——变异只涉及纯 evaluator/verdict，不依赖 DB env)

| id | mutation (diff shape) | exit | caught by (failing tests) |
|----|----------------------|------|---------------------------|
| MUT1 | `evaluateInventoryCoverage`: `if (uncovered.length > 0)` → `if (false && uncovered.length > 0)`（unowned/unclassified 拒绝路径停用） | 1 | 3 fail: 「存在 unowned 入口 → 拒绝」「存在 unclassified 入口 → 拒绝」「豁免只豁免列出的入口，其余 unowned 仍阻断」→ logs: MUT1-coverage-refusal-dropped-TESTS-FAIL.txt |
| MUT2 | `evaluateDevBypassResidue`: `if (findings.length > 0)` → `&& false`（绕过残留静默通过） | 1 | 4 fail: singleUser=true / OPENBOT_DEV_NO_AUTH=true / 垃圾值残留 / 编排器拒绝路径 b → MUT2-devbypass-refusal-dropped-TESTS-FAIL.txt |
| MUT3 | `evaluateRoleSafety`: capabilityAttributesSafe / loginAttributesSafe / loginHasNoOtherMemberships 三条 `!== true` 判定 → `&& false`（特权角色与提权成员资格放行） | 1 | 3 fail: 特权属性拒绝 / 第二成员资格拒绝 / 编排器拒绝路径 c → MUT3-roles-refusal-dropped-TESTS-FAIL.txt |
| MUT4 | `applyStartupVerdict`: 拒绝时 hooks.exit/process.exit 分支 → `&& false`（记录日志但不拒绝启动） | 1 | 1 fail: 「refused → 同一条记录留痕后 exit(1)」→ MUT4-verdict-no-exit-TESTS-FAIL.txt |

Restore discipline: every mutation was reverted with the exact inverse edit; sha256
re-verified equal to the original hash above after each revert. An earlier mutation round
had run against the pre-waiver-trail-fix file (hash 7efcced6…); after the audit-trail fix
(refused records now also carry waivedEntrances) all four mutations were re-executed against
the final file — the logs in this directory are that final round.

## Restore verification

Final state after MUT4 restore (also appended to original-hashes.txt):
`7ab7275eff18fd2c38a5f38bbed3ebfaa265c6eb87b25028b6883c83e98f8a46  src/enterprise/tenancy/startup-checks.ts`

Post-restore full green evidence: `RED-restore/GREEN-after-restore.txt` (startup-checks
unit 33 pass without env; full-suite 181 pass evidence in `../red-green/GREEN-full-regression-181pass-0skip.txt`).
