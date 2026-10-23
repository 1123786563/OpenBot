# b5-242 — Bifrost 05.1 Customer 幂等开户 实施计划

Ticket: #242（组 05，Blocks 05.2/#243、05.3/#244）。Write scope：网关 Customer 适配模块与映射存储、迁移、对应测试。

## Seam（现有实现核验结论）

- **门禁（01.7 已交付）**：`server/src/gateway/readiness.ts` 导出 `assertGatewayReadyForBilling(gate?)`，未就绪抛 `GatewayNotReadyError`；零参时读已安装 gate（`gatewayReadinessControls()`），未安装也是拒绝（`gateway_readiness_gate_unavailable`）。开户第一步调用它。
- **PayerRef（02.1 已交付）**：`server/src/billing/payer.ts` 导出 `PayerRef { kind, id }`、`payerKey(ref)`（`openbot-personal-<id>`，拒绝 `unknown_owner` 与脏 id）。开户只接受 `kind: "personal"`（票面：个人用户与 Customer 一一对应；AC01 两人隔离）。
- **网关 Customer API（Bifrost dev 分支实测）**：`POST /api/governance/customers`，请求 `{ name }`，服务端生成 uuid id，name 唯一（重复名 → 409 `"A customer with this name already exists"`）；`GET /api/governance/customers?search=<name>&limit=N` 返回 `{ customers: [...] }`（search 为模糊匹配，需客户端精确过滤 name）；`GET /api/governance/customers/{id}` 返回 `{ customer }`。
- **幂等策略（远端名唯一 + 本地唯一约束，无需 pending 态）**：远端 name 取 `payerKey(ref)`（确定性）；并发双方同调 POST，一方成功另一方 409 → 按 name 精确解析回同一 id（远端 uuid 唯一，故并发不会产生第二份远端主体）；本地映射 `INSERT ... ON CONFLICT DO NOTHING` + 提交后重读，数据库唯一索引仲裁并发，两方返回同一 customerId。远端成功但本地未落行的崩溃缝隙属 05.2（以 name 解析恢复），本票不实现恢复，只保证 409→resolve 的缝隙不阻断本次调用。
- **测试库**：专用库 `openbot_b5_242v`（docker `b5-verify-pg`，127.0.0.1:5590）；`TEST_DATABASE_URL` 不指向 `openbot`（support/database.ts 已硬拒）。远端用测试内 `Bun.serve` fake（仅测试；生产路径走真实 fetch + 已安装 controls）。

## 变更文件

| 文件 | 动作 |
|---|---|
| `server/src/db/schema/gateway.ts` | 新增 `gatewayCustomers` 表（见下） |
| `server/drizzle/0129_gateway_customers.sql` | 迁移：建表 + 3 个唯一索引 + 2 个 check |
| `server/drizzle/meta/_journal.json` | 追加 idx 129 |
| `server/drizzle/meta/0129_snapshot.json` | 由 0128 快照派生（加新表） |
| `server/src/gateway/customer.ts` | 新模块：类型、HTTP 适配、provisioner、生产入口 |
| `server/tests/gateway-customer-provisioning.integration.test.ts` | RED→GREEN 集成测试 |

不动：app.ts（生产调用方是 05.3 授权签发路径，本票交付模块级零参生产入口 `provisionCustomer(database, ref)`，模式同 01.7）、billing/*（不产生余额/Grant/ledger）。

## 表 `gateway_customers`

- `id` text PK（`gc-` + 8 字节 hex）
- `kind` text notNull check `IN ('personal')`
- `payer_id` text notNull
- `gateway_customer_id` text notNull（Bifrost 服务端 uuid）
- `gateway_customer_name` text notNull（= payerKey，确定性）
- `provision_state` text notNull check `IN ('active')`
- `created_at` timestamptz notNull default now()
- 唯一索引：`(kind, payer_id)`（并发开户只留一条）、`(gateway_customer_id)`（一远端主体 ↔ 一主体）、`(gateway_customer_name)`（name 解析是 05.2 恢复的信任根）

## `server/src/gateway/customer.ts`

- `GatewayCustomerProvisionState = "active"`；`GatewayCustomerMapping { id, kind, payerId, gatewayCustomerId, gatewayCustomerName, provisionState, createdAt }`
- `GatewayCustomerProvisionError`，reason codes（固定常量、可展示、不内插上游字节）：`gateway_customer_unreachable|timeout|unauthenticated|invalid_response|unexpected_status|remote_conflict_unresolved`
- `gatewayCustomerName(ref)`：仅 `personal`，复用 `payerKey`；其余 kind TypeError 拒绝
- HTTP 适配（复用 01.1/01.2：`readGatewayEndpoint` + `resolveGatewayAdminCredential`，Bearer 认证、AbortSignal 超时、响应体字节上限、错误按 name 分类且不保留上游字节）：
  - `createGatewayCustomer`：POST，201/200 → `{id,name}`；409 → 特异信号
  - `findGatewayCustomerByName`：GET `?search=`，客户端精确匹配 name
- `createGatewayCustomerProvisioner(deps)`：deps = `{ database, readGatewayEndpoint, resolveGatewayAdminCredential, gate?, fetchImpl?, now?, log? }`
  - `provisionCustomer(ref)`：① `assertGatewayReadyForBilling(gate)`（门禁未就绪 → 拒绝，AC3）② 本地已映射 → 原样返回（快路径，不触网）③ 远端 create（409 → find by name；找不到 → `remote_conflict_unresolved`）④ `INSERT ON CONFLICT DO NOTHING` → 命中冲突重读已提交行 → 返回该行 customerId（并发收敛，AC1/AC2）。不触碰 billing_customers / credit_grants / credit_ledger / credit_reservations（AC4）
  - `readGatewayCustomerMapping(ref)`
- 模块级 `provisionCustomer(database, ref)`：零参生产入口，读已安装 controls（endpoint/credential）与已安装 gate，模式同 `assertGatewayReadyForBilling`

## TDD

**RED**（先写，全部失败）：`server/tests/gateway-customer-provisioning.integration.test.ts`
1. 重复开户返回同一 customerId、单行、远端只建一次（第二次调用快路径零远端调用）
2. 6 连接并发开户：一个映射行、全部同一 customerId、远端 customer 数 = 1
3. 门禁未就绪（未安装 gate / gate 拒绝）：`GatewayNotReadyError`、零远端调用、零行
4. 409-本地无行缝隙（模拟上次崩溃）：解析同名远端 customer，落一行，同一 id
5. 无余额：开户后 credit_grants / credit_ledger / credit_reservations / billing_customers 对该 payer key 均 0 行
6. 远端故障分类：unreachable / timeout / unauthenticated / invalid_response → 类型化错误、零行
7. 非 personal kind 拒绝；映射持久化可被 `readGatewayCustomerMapping` 读回（05.3/05.8 消费面）

**GREEN**：实现模块 + 迁移，直到全绿。

## 验证命令

```bash
cd server && OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES=on \
  DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_242v bun scripts/migrate.ts
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_242v CREDIT_SCALE=100 \
  bun test server/tests/gateway-customer-provisioning.integration.test.ts
bun run --filter server typecheck
bunx biome lint --error-on-warnings server/src/gateway/customer.ts server/src/db/schema/gateway.ts server/tests/gateway-customer-provisioning.integration.test.ts
```

## 范围护栏

- 不做 05.2 恢复（不实现后台扫描/重放）；不做 05.3 签发；不开网关能力；不触碰生产库 `openbot`；不 commit/push。
