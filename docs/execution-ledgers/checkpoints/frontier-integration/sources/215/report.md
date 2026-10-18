# 215 · Bifrost 02.1 PayerRef 账户模型与映射唯一性 — 执行报告

- Ticket: https://github.com/1123786563/OpenBot/issues/215（AC01/AC13 的账户层基础）
- 状态：**完成（未提交检查点）** — RED → GREEN 全程证据见同目录 `red.md` / `green.md`
- Worktree `issue5-215` @ BASE `f0520524`；未提交、未推送、未合并、未触碰 dev/prod 数据

## 交付的契约（供 #216–#220 及后续财务消费者）

`server/src/billing/payer-ref.ts`（纯模块，无 DB）：

- `PayerRef { kind: 'personal' | 'company' | 'legacy_deployment' | 'unknown_owner', id }` —— 唯一计费主体表达；`PAYER_KINDS` 为闭合集合
- `assertPayerRef` / `isPayerRef`：malformed（空 id、未知 kind、首尾空白）→ TypeError（调用方 bug，与 CreditWriter 惯例一致）
- `externalCustomerIdForPayer`：确定性、跨 kind 可注入的账户键推导 —— `personal → payer-personal-<id>`、`company → payer-company-<id>`、`legacy_deployment → 委托 deploymentExternalCustomerId(<id>)`（一处真相）、`unknown_owner → PayerOwnerUnknownError`（隔离，永不可推导）
- `PayerOwnerUnknownError`（code `unknown_owner`）

`server/src/billing/payer-account.ts`（服务层）：

- `createPayerAccount(PayerRef)`：幂等创建账户记录（客户地板 + `ON CONFLICT (kind, owner_id) DO NOTHING` + 败者回读）；**不创建任何余额**
- `payerKey(PayerRef) → externalCustomerId`：fail-closed 解析 —— 未注册 → `PayerAccountMissingError`（不回退、不隐式推导、不自动建户）；`unknown_owner` 有行也拒绝
- 并发正确性：双唯一索引 + 跨索引冲突恢复（见“关键发现”），真实 6 连接并发验证

`server/src/db/schema/payer.ts` + 迁移 `server/drizzle/0122_payer_accounts.sql`：

- `payer_accounts(id, kind, owner_id, external_customer_id → billing_customers, created_at)`
- 双向唯一：`unique(kind, owner_id)` + `unique(external_customer_id)`；`kind` CHECK 闭合集合
- 迁移已通过 `server/scripts/migrate.ts` 在专用测试库验证并应用

## 验收标准核验

| AC | 证据 |
| --- | --- |
| 同一主体并发创建只留一个有效映射 | 6 个独立连接（6×max:1）并发 createPayerAccount → 恰一行、恰一个 created:true、同一账户 id（integration test 2；变更检查：去掉 ON CONFLICT 该测试与幂等测试均失败） |
| 一个 externalCustomerId 不能属于两个账户 | 两个方向均有测试：同键不同主体 → `payer_accounts_external_customer_unique_idx` 违反；同主体不同键 → `payer_accounts_owner_unique_idx` 违反；服务层对“显式绑定已占用键”的场景抛出原始违反 |
| 不同账户 Grant/台账互不可见 | 账户 A grant+reserve+settle 后，B 的 availableBalance=0、grants=[]、consumption=[]（经 payerKey 解析各自键，走现有读取接口，无跨账户聚合） |
| 无余额复制/分摊/迁移 | createPayerAccount 后 availableBalance=0、无 grants/ledger 行；legacy_deployment 推导 === 现有部署键（记录原键不动，零迁移） |

## 验证命令与结果（green.md 为完整输出）

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5561/openbot_test \
  bun test server/tests/payer-ref.test.ts server/tests/payer-account.integration.test.ts   # 18 pass / 0 fail ×8 连续
bun run --filter server typecheck                                                          # exit 0
bunx biome lint --error-on-warnings <7 个变更文件>                                            # clean
bunx biome format <变更文件>                                                                 # clean
TEST_DATABASE_URL=… bun test <8 个相邻 billing/credits 套件>                                  # 90 pass / 0 fail
```

专用测试库：docker 容器 `openbot-215-pg`（pgvector/pgvector:pg17，127.0.0.1:5561 → openbot_test），CI 同款角色引导 + 迁移；未触碰任何开发/生产数据库。

## 关键发现 / 决策

1. **双唯一索引下的 ON CONFLICT 跨索引竞态**：Postgres 只仲裁 ON CONFLICT 指定的索引；并发同值插入时败者可能从另一个唯一索引（external_customer_id）收到 unique violation 而非 do-nothing。首次 GREEN 曾因此在合并运行中偶发失败。修复：捕获 payer_accounts 的 unique violation → 回读；回读命中 → 答复既有行（同主体竞态收敛）；未命中 → 原样重抛（真实撞键，写入失败）。修复后 8× 连续稳定。
2. **drizzle-kit generate 仓库级预存故障（非本 Ticket 引入）**：pinned 0.31.10 与 bunx 0.31.11 均报 `drizzle/meta/0054↔0055、0086↔0096 snapshot parent collision`，任何新迁移都无法生成 snapshot。本迁移按 drizzle 生成格式手写 SQL + `_journal.json` 追加 idx 122 —— 部署/测试走的 `scripts/migrate.ts`（journal+SQL）不受影响；**snapshot 链修复建议另立工单**（超出本 Ticket 写入范围）。
3. `payerKey` 有意不自动建户（fail-closed）：消费方先 `createPayerAccount`（幂等、便宜）再解析；漏建得到响亮拒绝而不是静默自注册 —— 与“解析入口唯一化”的收敛方向一致。
4. 仓库级 `bun run format:check` / `bun run lint` 在未变更文件上预存失败（agent-sandbox、alipay.ts 等）；本 Ticket 变更文件全部 clean。

## 文件清单与 SHA-256（未提交检查点）

```
774c3591f2d5cf9a265dffa47b1336fbb8d987909290d478e6046fab30ed499f  server/src/billing/payer-ref.ts        (新增)
315e33e540b9a71d48897fc9cf582866472c10071c4366bc7c572dc19c3f0b60  server/src/billing/payer-account.ts    (新增)
400b037abee54b7eaa265fd7a2100b57785e4ae794e9c696a796e58859b0db4a  server/src/db/schema/payer.ts          (新增)
b3913af40da6fdacd716da5fa10aac0d35513f8d1da9d137dd2ed94c4f4ae6ad  server/drizzle/0122_payer_accounts.sql (新增)
461beb3a6abbc50c2864b1663898afd0a5041f44c28cbb07685a037e548c782d  server/tests/payer-ref.test.ts         (新增)
3775308fc9366c376b19c75422adb72f3b3d6fdcf511c14d46080e16e9359f54  server/tests/payer-account.integration.test.ts (新增)
642981b18523e0c5114886650fb6344f75c4b3559dcdf708758e33c922fd8e15  server/src/db/schema/index.ts          (修改：注册 payer schema)
623fe383e53ed385f9da3b6def523f841a9d3571162de23f027d8f84f538cf38  server/drizzle.config.ts               (修改：注册 schema 文件)
5229afd6bbe3c9c81d685cab7f0501993bb69c3f06af71a3a806ef568df00f0f  server/drizzle/meta/_journal.json      (修改：追加 idx 122)
docs/execution-ledgers/checkpoints/215/{plan.md, red.md, green.md, report.md}（本检查点）
```

不越界：未改 CreditWriter/计费算法/部署键函数本体/任何 UI；未启用任何 gateway 能力；未发布。

## 交接（Resume hint）

- 02.2 直接消费 `payer_accounts` + `PayerOwnerUnknownError`/`PayerAccountMissingError` 语义：显式绑定用直接 INSERT（撞唯一约束即失败）；unknown_owner 行“可读作审计、不可被任何新消费路径使用”已由 payerKey 的 kind 前置拒绝保证。
- 05.1 幂等开户：先 `createPayerAccount` 再 `payerKey`，推导键即 provider 外部 ID，天然幂等。
- 若要让 CreditWriter 只接受已注册键（“解析入口唯一化”），属后续 Ticket，不在本切片。
