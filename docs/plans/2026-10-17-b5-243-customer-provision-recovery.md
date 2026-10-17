# b5-243 实施计划 — Bifrost 05.2 远端成功本地丢失的可恢复关联（#243）

状态：**已改造并验证（GREEN，第二轮）**。第二轮按 coordinator 简报（msg_44a052c78c68）完成跨票冲突改造：首轮因同步层早于 #242 集成而重建了 gateway_customers 表；main 已集成 #242 版该表（0132 不可改），故改为 **0135_gateway_customer_recovery.sql 的 ALTER 演进**（external_reference 存储生成列 + gateway_customer_id 可空 + 4 值 state CHECK + reference 唯一索引），消费既有表与 customer.ts 的 provisionCustomer seam（预约采纳分支为其最小演进）。详见 `.omc/reports/b5-243.md` 第二轮改造报告与 `.omc/reports/b5-243-red.log`（对旧 seam 的 RED 证据 8 fail）。验证：全新库 openbot_b5_243v3@5590 roles+migrate；本票 16 测试 + #242 回归 17 测试合跑 33/33 GREEN；typecheck、biome 通过。

---

历史状态（首轮）：**已实现并验证（GREEN）**。前两任因依赖缺失 + 502 风暴中断，coordinator 指示从断点继续（接续简报 msg_edd9afa2861e），按本计划 B 分支落地：本 worktree 基线内无 05.1 交付，由本票构建最小 provisionCustomer seam + 本票恢复逻辑；生产 HTTP 适配器（真实 Bifrost 管理面）因 bifrost 子模块缺失/不可验证而保留为注入 seam，对应能力保持未验证/不可启用。

实际落点（对照第 3 节计划）：

- `server/src/gateway/customer-provision.ts`（新建）：customerCorrelationKey（复用 payerKey）、provisionState 状态机、recoverable 查找/确认、两条幂等路径、门禁前置。
- `server/src/db/schema/gateway.ts`（追加）：`gateway_customers` 表（kind/payer_id/customer_id 可空/external_reference/provision_state + CHECK×3 + 唯一索引×3）。
- `server/drizzle/0132_gateway_customer_provision.sql` + `meta/0132_snapshot.json` + journal idx 132（手工构建；drizzle-kit generate 因仓库既有 meta 0054/0055、0086/0096 snapshot 冲突不可用，与本票无关）。
- `server/tests/customer-provision-recovery.test.ts`（新建，12 测试）：响应丢失注入、重试幂等、可重复恢复、lookup-miss 新建、零余额/Grant/Key、并发、拒绝清理、门禁拒绝、传输分类。
- `server/tests/support/fake-gateway-customers.ts`（新建）：fake 网关客户路由（create 可丢响应、按关联键查询、拒绝注入）+ GatewayCustomerClient HTTP 客户端（仅测试脚手架）。

验证：`bun test server/tests/customer-provision-recovery.test.ts` → 12 pass / 0 fail（专用库 openbot_b5_243v2@127.0.0.1:5590）；`bun run --filter server typecheck` 通过；biome lint（4 文件）无警告；相关回归 5 文件 71 测试全绿。证据详见 `.omc/reports/b5-243.md`。

## 0. 依赖状态（开工前核验记录）

- 05.1 契约（provisionCustomer / 映射存储 / provisionState）**不在本 worktree 基线**：
  - `server/src` 全量 grep 无 provisionCustomer/provisionState/Customer 映射存储；
  - 迁移链止于 `0131_access_grant_source`（journal 131 项）；
  - 无 `customer-provisioning` 测试、无 b5-242 计划文件；ledger T50 明示 #242 在就绪队列，T55–T58 无集成记录。
  - `bifrost/` 子模块初始化中断（仅空目录，dispatch 时刻 07:49 local 生成）。
- 05.1 的上游已就位：01.7 `assertGatewayReadyForBilling()`（server/src/gateway/readiness.ts）、02.1 PayerRef/PayerAccount（server/src/billing/payer.ts，`payerKey(ref)` 稳定关联键先例）。
- 按票面约束「依赖未完成不造假桩冒充已集成」，未伪造契约开工；已上报等待。

## 1. 环境准备（已完成）

- `.env` 已从主 checkout 复制；`cd server && bun install` 完成。
- 专用测试库：**127.0.0.1:5590（b5-verify-pg）/ openbot_b5_243v**，owner=openbot；
  `OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on bun scripts/migrate.ts` 已跑通 → `{"status":"ok"}`，
  132 项迁移 + 4 个 ob_ent_* roles 实证。
- TEST_DATABASE_URL=`postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_243v`（不触碰 live openbot）。
- 曾误建于禁用 5432 实例的空库 openbot_b5_243 已 DROP（本 session 自建、空库，零数据）。

## 2. 设计（对齐 Spec Q6/Q7/Q10、AC01、设计文档 L91）

### 2.1 稳定关联键

- 关联键由本地稳定身份派生：复用 02.1 的 `payerKey(PayerRef)` 形态（个人=基于稳定账户 ID 的确定性字符串），
  作为网关 Customer 的外部引用（external reference）随开户请求携带，事后可按它找回远端主体。
- 关联键满足：确定性（同账户同键）、全局唯一、不含明文个人信息、可安全出现在网关查询中。

### 2.2 provisionState 状态机（本票新增字段）

```
        ┌────────────┐  remote create issued
        │  pending   │──────────────────────────────┐
        └────────────┘                              │
              │ remote ack + local mapping commit   ▼
              │                              ┌──────────────┐
              ├─────────────────────────────▶│  confirmed   │
              │        (success path)        └──────────────┘
              │ response lost / timeout            ▲
              ▼                                    │ recovery: found by
        ┌──────────────┐   lookup by external ref   │ correlation key
        │ recoverable  │────────────────────────────┘ (found → confirm)
        └──────────────┘
              │ lookup misses → create anew → confirmed (fresh path)
```

- `pending`：请求已发出、结果未知且本地未确认（仅远端成功本地丢失场景进入 recoverable；本地明确失败可安全重试 pending）。
- `recoverable`：远端可能已创建、本地未确认。恢复过程幂等：可重复执行，结果一致。
- `confirmed`：本地映射与远端主体一致。
- 约束：状态迁移只前进（pending→confirmed / pending→recoverable→confirmed），恢复不重置余额、不产生 Grant、不签发 Key。

### 2.3 恢复流程（公开边界）

1. `provisionCustomer(ref)` 进入时读映射行：
   - 无行 → 正常开户（带关联键），成功置 confirmed；响应丢失置 recoverable（远端可能已建）。
   - 行=confirmed → 直接返回既有 customerId（幂等）。
   - 行=recoverable → 先按关联键查询远端：
     - 找到 → 采纳该 customerId，确认映射（补齐本地 customerId/状态），返回；
     - 未找到 → 走正常创建，返回新 customerId（远端确实没有主体时这是唯一正确路径），置 confirmed。
2. 两条路径都幂等；恢复重复执行结果一致（同 customerId、同状态）。
3. 门禁：恢复/创建均先过 01.7 `assertGatewayReadyForBilling()`，未就绪拒绝（沿用 05.1 语义）。

### 2.4 故障注入模型（fake 网关，仅测试）

- fake 网关新增两条管理面路由：
  - `POST /api/customers`（创建）：接受请求、在 fake 内记录 Customer（含 external reference），然后按注入计划**丢弃响应**（hold/hang 直至客户端超时）→ 客观模拟「远端成功、本地确认丢失」。
  - `GET /api/customers?external_reference=…`（按关联键查询）：返回 fake 内已记录的主体。
- fake 内 Customer 存储允许测试断言「远端只有一个 Customer」。
- fake 仅为测试 scaffolding，不进生产路径（沿 01.5 先例注释约束）。

## 3. 文件级实施计划

| 文件 | 动作 | 说明 |
|---|---|---|
| `server/tests/customer-provision-recovery.test.ts` | 新增（RED 先行） | 响应丢失注入、重试幂等、恢复后映射一致、恢复零余额/零 Grant/零 Key、未找到走新建路径 |
| `server/tests/support/fake-gateway.ts` | 扩展 | customer create（响应可丢）+ external-reference 查询路由（票面写 scope 内「fake 网关测试 helper」） |
| `server/src/gateway/customer-provision.ts` | A: 扩展同步进来的 05.1 模块 / B: 经授权新建（含最小幂等 seam + 本票恢复） | provisionState 机 + recoverable 查找/确认 + 两条幂等路径 |
| `server/src/db/schema/gateway.ts`（或独立 `gateway-customer.ts`） | 扩展 | 映射行状态字段 provisionState（pending/confirmed/recoverable CHECK 约束）、关联键唯一 |
| `server/drizzle/0132_*.sql` + `meta/_journal.json` + `meta/0132_snapshot.json` | 新增 | 仅状态字段迁移；**journal when 严格递增（> 1792090549121）**；A 情形若 05.1 已占 0132 则顺延 0133 |
| `docs/plans/2026-10-17-b5-243-customer-provision-recovery.md` | 本文件 | 计划 + RED/GREEN 命令 |

不触碰：app/、bot-services/、billing 计价、授权模块、其他 worktree、bifrost/ 子模块内容。

## 4. RED → GREEN 验证命令

```bash
# RED：先写失败测试并观察失败（feature missing，非 error）
cd server && TEST_DATABASE_URL='postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_243v' \
  bun test server/tests/customer-provision-recovery.test.ts

# GREEN 后：类型检查 + lint + 显式文件列表测试
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/gateway/customer-provision.ts server/tests/customer-provision-recovery.test.ts server/tests/support/fake-gateway.ts
```

## 5. 验收标准 → 证据映射（计划）

- AC「远端成功但本地确认丢失时，重试不创建第二份 Customer」← 响应丢失注入 + 重试后 fake 内 Customer 计数=1 断言。
- AC「恢复后本地映射与远端主体一致」← 映射行 customerId == fake 内主体 ID、状态=confirmed。
- AC「恢复过程可重复执行且结果一致」← 恢复调用两次，结果（customerId/状态/远端计数）全等断言。
- AC「恢复不产生余额、Grant 或额外 Key」← billing_customers/ledger/reservation 零新增 + fake 未签发任何 virtual key 断言。

## 6. 检查点

- 未提交检查点（保持 git status 未提交，未 commit/push）：实现完成后以 `git status --porcelain` + 文件哈希清单记入 `.omc/reports/b5-243.md`；不 commit/push。
