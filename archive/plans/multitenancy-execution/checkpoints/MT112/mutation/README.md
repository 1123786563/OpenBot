# MT112 变异检查（mutation checks）

每个变异修改 `server/scripts/multitenancy/migrate-test.ts` 中 MT112 任务的
SQL 步骤（交付物本身，不是测试），在**全新变异库**
`openbot_enterprise_mt112_mut_test`（同容器、重建）上预置基础 schema +
MT004，再运行 `bun test tests/multitenancy/legacy-anchor.test.ts`，
记录目标用例失败；随后恢复 pristine（SHA-256
`b87caeb457ddca70c3826703161d5ea524b3ff73aace58b6e814c5480b4ad83a`
逐次复核）。所有运行 exit 1 = 被捕获。

| 变异 | 移除的交付物 | 靶向验收 | 失败用例（存档文件） | 结果 |
| --- | --- | --- | --- | --- |
| MUT1 | `CREATE UNIQUE INDEX "enterprise_deployment_anchor_identity"`（部署身份唯一索引） | 验收 2 映射唯一 | `a second tenant claiming the same deployment identity is rejected by the unique index` + catalog 用例 | 捕获（19 pass / 2 fail，exit 1） |
| MUT2 | 锚点租户 INSERT 的 `ON CONFLICT ("id") DO NOTHING`（幂等键） | 验收 1 幂等 | `replaying the anchor-row steps verbatim inserts no duplicate entities`（重放撞 23505） | 捕获（20 pass / 1 fail，exit 1） |
| MUT3 | `enterprise_deployment_anchor_billing_derivation` CHECK | 验收 2 可核验（派生自证） | `a billing customer key that does not follow the derivation is rejected by the check`（23514 断言翻转）+ catalog 用例 | 捕获（19 pass / 2 fail，exit 1） |
| MUT4 | `CREATE UNIQUE INDEX "enterprise_deployment_anchor_billing_customer"`（计费 Customer 方向唯一） | 验收 2 映射唯一（结构面） | `the unique indexes and the derivation check really exist in the catalog` | 捕获（20 pass / 1 fail，exit 1） |

说明（诚实披露）：

- MUT1/MUT2/MUT3 直接覆盖 brief 点名的「幂等键 + 映射唯一约束」两项。
- 计费 Customer 方向的行为级唯一性碰撞在派生 CHECK 完好时**不可能构造**
  （billing 键 = f(部署身份)，身份唯一即计费键唯一），因此 MUT4 的证据
  落在目录断言（索引真实存在）+ 派生 CHECK 的行为断言，二者合起来把
  「同一计费 Customer 被第二个租户认领」封死。这一逻辑在报告
  `reports/MT112.md` 验收 2 一节展开。
- MUT2 首次尝试时曾出现一次**未生效的假跑**（needle 未命中导致 pristine
  通过，输出 21/0）——该次输出未计入存档；修正 needle 后的捕获运行才是
  存档文件。全程 pristine SHA 在每次变异前复核。
