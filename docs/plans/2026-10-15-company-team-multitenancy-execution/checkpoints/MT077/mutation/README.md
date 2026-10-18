# MT077 变异检查（5/5 被捕获）

每次变异：对 `server/src/enterprise/tenancy/routing-policy.ts` 施加单一语义变异 →
带完整测试库 env 跑聚焦套件 `bun test tests/multitenancy/routing-policy.test.ts
--timeout 60000` → 确认 exit 1 且失败用例靶向 → 从 `pristine/routing-policy.ts`
还原 → SHA-256 复核（pristine `43c5c851…`，还原后逐次一致）。

带 env 纪律：所有变异运行均 `source` 测试库 env（MT014 §D5 / MT112 §7.5 教训）；
每次运行都有真实 pass/fail 计数，无 skip 假跑。

| 变异 | 靶向 | 结果（聚焦套件） |
| --- | --- | --- |
| MUT1 | 删除 capability 覆盖放大防线（resolve 不再拒绝 `true`） | **捕获**：35/2 —— 验收 2 两个 `CAPABILITY_OVERRIDE_WIDENS_POLICY` 专门用例 |
| MUT2 | 删除 egress mode 强度比较（覆盖可选更弱 mode） | **捕获**：36/1 —— 验收 2 `NETWORK_OVERRIDE_WIDENS_POLICY`（weaker mode）用例。（首跑因 biome 换行导致替换未命中产生一次 pristine 假绿 `exit 0`，已用正则命中重跑覆盖存档，`replacements: 1` 留痕于运行记录） |
| MUT3 | 删除 egress rules 公司子集校验 | **捕获**：36/1 —— 验收 2 rules 子集用例（index、不回显） |
| MUT4 | 删除 resolve 读取事务的 `set_config('app.tenant_id', …)` | **捕获**：26/11 —— FORCE RLS fail-closed，验收 1 全体读取用例（`GOVERNANCE_POLICY_NOT_FOUND`） |
| MUT5 | 删除 `updateInstall` 的 CAS revision 谓词 | **捕获**：36/1 —— 验收 3 stale expectedRevision 冲突用例（丢失更新可复现） |

还原后复绿：`GREEN-3-post-refactor.txt` 37/0/0，exit 0。
