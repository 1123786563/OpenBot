# 215 · Bifrost 02.1 PayerRef 账户模型与映射唯一性 — 实施计划与检查点

- Ticket: https://github.com/1123786563/OpenBot/issues/215
- Parent Spec: #5（AC01/AC13），ADR 0002 / 0004
- Worktree: `issue5-215`（BASE `f0520524`，未提交检查点）
- 执行者：dispatched worker（task_3124e76595a3）

## 范围（与 Ticket owned_scope 一致）

| 文件 | 动作 |
| --- | --- |
| `server/src/billing/payer-ref.ts` | 新增：PayerRef 契约、校验、账户键推导 |
| `server/src/billing/payer-account.ts` | 新增：PayerAccount 服务（幂等创建 / 解析） |
| `server/src/db/schema/payer.ts` | 新增：`payer_accounts` 表（双向唯一约束） |
| `server/src/db/schema/index.ts`、`server/drizzle.config.ts` | 注册新 schema 文件（drizzle.config 自身注释要求同一变更内登记） |
| `server/drizzle/0122_*.sql` + `meta/_journal.json` + snapshot | 新增迁移（drizzle-kit generate 产出） |
| `server/tests/payer-ref.test.ts` | 新增：纯单元测试（无 DB） |
| `server/tests/payer-account.integration.test.ts` | 新增：PostgreSQL 集成测试（专用 TEST_DATABASE_URL） |
| `docs/execution-ledgers/checkpoints/215/*` | 本计划 + RED/GREEN 证据 + 报告 |

不改动：CreditWriter 金额/幂等/预留语义（组 06）、计费算法、dev/prod 数据；不提交、不推送。

## 契约设计（Produces，供 #216–#220 及后续财务消费者）

1. **PayerRef**：`{ kind: 'personal' | 'company' | 'legacy_deployment' | 'unknown_owner', id }`
   - 服务端构造；客户端不可指定 payer；malformed（空 id、未知 kind、首尾空白）→ TypeError（调用方 bug，沿用 credits-writer 惯例）。
2. **账户键推导**（确定性、可注入性 → collision-safe）：
   - `personal` → `payer-personal-<id>`；`company` → `payer-company-<id>`
   - `legacy_deployment` → 委托 `deploymentExternalCustomerId(<id>)`（一处真相，不复制格式）
   - `unknown_owner` → 拒绝推导（隔离语义：只能审计，不可被任何新消费路径使用）
3. **PayerAccount 存储**（`payer_accounts` 表）：
   - `unique (kind, owner_id)`：一个主体只有一个有效账户
   - `unique (external_customer_id)`：一个 externalCustomerId 只属于一个账户
   - FK → `billing_customers(external_id)`（沿用客户地板），onDelete cascade
4. **createPayerAccount(PayerRef)**：幂等创建账户记录（只建账户，不建任何余额）。
   `ON CONFLICT (kind, owner_id) DO NOTHING` + 回读现有行；并发创建败者回读到同一行。
   external_customer_id 冲突（不同主体撞同一键）不被吞掉：以唯一约束失败的形式抛出。
5. **payerKey(PayerRef) → externalCustomerId**：只读解析、fail-closed：
   - 已注册 → 返回其唯一映射键（CreditWriter 接口语义不变，消费方继续传 externalCustomerId）
   - 未注册 → `PayerAccountMissingError`（不回退、不隐式推导、不自动建户）
   - `unknown_owner` → `PayerOwnerUnknownError`（即使有行也拒绝）
6. 本 Ticket 不迁移、不复制、不分摊任何余额；旧记录留在原账户键上（legacy_deployment 推导即原键，天然零迁移）。

## 测试计划（RED 在先）

`server/tests/payer-ref.test.ts`（纯单元）：
- 推导确定性 + 跨 kind 可注入（personal:X ≠ company:X ≠ legacy:X）
- legacy_deployment 推导 === deploymentExternalCustomerId(id)（一处真相）
- unknown_owner 拒绝推导；malformed ref → TypeError；isPayerRef guard

`server/tests/payer-account.integration.test.ts`（PG，多连接，不用 mock）：
- 幂等：重复 createPayerAccount 答复既有行（created:false，同 id/键）
- 并发：6 个独立连接（6×max:1 连接池）并发创建同一主体 → 恰一行、恰一个 created:true、全部同一账户 id
- 双向唯一：同 externalCustomerId 不同主体 → 写入失败（unique violation）；同主体不同键 → 写入失败
- payerKey：已注册解析成功；未注册抛 PayerAccountMissingError（不回退推导串）；unknown_owner 有行仍拒绝
- 跨账户隔离：账户 A grant 后 B 的 availableBalance/grants/consumption 均不可见 A 的记录
- AC4：createPayerAccount 不产生任何余额（availableBalance=0、无 credit_grants 行）；legacy 键等于原部署键

## 验证命令

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5561/openbot_test bun test server/tests/payer-account.integration.test.ts
bun test server/tests/payer-ref.test.ts
bun run --filter server typecheck
bunx biome lint --error-on-warnings <changed files>
```

专用测试库：docker `openbot-215-pg`（pgvector/pgvector:pg17，127.0.0.1:5561，openbot_test）；迁移用 `server/scripts/migrate.ts` 指向该库，绝不触碰 dev/prod。

## 执行记录

- [x] 依赖核验：Blocked by = None；读取 credit-writer / credits schema / deployment-key / test-harness 实际实现
- [x] 测试库启动 + 基线迁移（0121）
- [x] RED：两个测试文件先写先跑、记录失败（red.md）
- [x] GREEN：schema → 迁移 → payer-ref → payer-account → 测试转绿（green.md，含变更检查与 8× 稳定性）
- [x] typecheck + biome lint + format（变更文件全部 clean）
- [x] 检查点（文件哈希清单）+ 报告（report.md）
