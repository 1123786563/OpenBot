# b5-244 实施计划 — Bifrost 05.3 为有效授权签发独立 Key（#244）

状态：**执行中（TDD）**。Ticket：`docs/tickets/bifrost-5/issues/05.3-per-authorization-short-key-issuance.md`。

## 0. 依赖核验（开工前记录，均以仓库实际实现为准）

- **05.1 customerId**：`server/src/gateway/customer.ts` 的 `createGatewayCustomerProvisioner`（可注入 gate/endpoint/credential/fetch）与零配置生产入口 `provisionCustomer(database, ref)`；映射表 `gateway_customers`（0132/0135）；`readGatewayCustomerMapping`。✅ 已在基线。
- **03.11 冻结契约**：`server/src/gateway/model-discovery-routes.ts`（`/api/model-discovery`，`requireBotService` 门）。本票不改它。✅
- **04.5 AccessGrant**：`server/src/bot-services/access-grants.ts` 的 `resolveForBot(grantId, identity)` —— key 签发的授权使用检查 seam；统一拒绝类 `AccessGrantUseError`（unknown/revoked/cross-Bot/disabled-Bot 一类）。表 `access_grants`（partial unique：每 (user,bot,identity) 一条 active）。✅
- **04.2 requireBotService**：`server/src/bot-services/auth.ts`；`botServiceRoutes` 已有 `bindingCodes` 子路由先例（04.3 挂 `/binding-codes`）。✅
- **#252 credit-service-auth**：`server/src/billing/credit-service-auth.ts` —— 明文仅响应一次、vault 存储、sha256 指纹、审计模式。本票同域一致。✅
- **Bifrost 虚拟 Key API**（管理面，本票 HTTP 适配目标）：`POST /api/governance/virtual-keys`，body `{ name(required), customer_id, expires_at?, ... }`，响应 `{ virtual_key: { id, value: "sk-bf-…" } }`（value 为明文，仅此一次）；name 唯一（重复 409）。bifrost 子模块在本 worktree 未初始化，以 `/Users/wuyongjun/trea/OpenBot/bifrost`（同 repo dev 分支 checkout）只读参考，测试用 fake 管理面（Bun.serve）。
- 测试环境：5590（b5-verify-pg）专用全新库 **openbot_b5_244_k**，roles 已在实例上，migrate 全链（140 条后）通过；`TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5590/openbot_b5_244_k`，bun test 一律 `./` 前缀。

## 1. 设计（Q8：每「用户 × Bot 授权」独立 Key；AC02/AC08）

### 1.1 契约（Produces）

```
issueKeyForGrant(grantId, identity) → {
  keyId, grantId, botId, customerId, gatewayVirtualKeyId,
  credentialVersion, status: "active", expiresAt: null, createdAt, secret
}
```

- `secret` 明文在内存中只返回一次给调用方（签发路由 = 已认证 Bot 服务端通道；05.4 在其上定义 CredentialBundle 与脱敏边界）。本地不落明文：只落 `value_hash`（sha256 hex，同 `bot_binding_offers.code_hash` 域模式）。
- `credentialVersion` 每授权从 1 开始单调递增：每次签发 = 新版本（明文不存储 ⇒ 重复领取即换发，与「签发记录持久化」一致）。
- 所有 Key 关联同一 `customerId`：签发先过 `provisionCustomer(grant.userId)`（幂等 seam，两 Bot 收敛同一映射行）。
- 不新增额度/Grant/预算：远端 create body 只带 `{ name, customer_id }`（**无 budgets、无 provider 预算** —— Bifrost 侧由 customer 预算治理，scope=customer）；本地不写 credit_grants/ledger/payer_accounts。
- expiresAt：05.5 交付默认期限与部署配置；本票列存 `expires_at`（可空，当前签发为 null），不实现 05.5 的策略（功能准入纪律）。

### 1.2 模块

- **`server/src/gateway/key-issuance.ts`**（新建）：
  - `GatewayVirtualKeyClient` HTTP 适配（`POST /api/governance/virtual-keys`）：customer.ts 同款纪律 —— 一请求一 deadline 覆盖 body、字节上限、上游字节只验证即弃、固定 reasonCode 分类（endpoint_not_configured / credential_unavailable / unreachable / timeout / unauthenticated / invalid_response / unexpected_status / conflict）。
  - `createGatewayKeyIssuer({ database, resolveForBot, provisionCustomer, client, log? })` → `issueKeyForGrant(grantId, identity)`：
    1. `resolveForBot`（04.5 seam：统一拒绝 + registry 活读）；
    2. 事务内锁授权行（`SELECT … FOR UPDATE`）复核 active + botId 匹配（关掉 revoke 竞态窗口），`max(credential_version)+1`；
    3. `provisionCustomer({kind:'personal', id: grant.userId})` → customerId（gate 前置）；
    4. 远端 create（name = `openbot:<grantId>:v<version>:<8hex>` —— 随机后缀使崩溃孤儿惰性无害，05.8 状态同步管辖漂移）；
    5. 本地插入 `gateway_virtual_keys`（唯一索引 `(grant_id, credential_version)` 为并发仲裁）；
    6. 审计 `gateway.key_issued`（不含明文/不含 hash 以外可还原物；fail-closed 同 04.5 —— 审计失败则签发失败，重试收敛新版本）。

    审计时序：远端 create 成功后、本地插入同事务内？——审计写在事务提交后（同 04.5 confirm），fail-closed：审计抛错 ⇒ 调用方见错，Key 已存在但调用方重试得新版本（v+1），无静默未审计 Key。与 04.5 的取舍一致。
  - `createKeyIssuanceRoutes(deps?)`：`POST /keys`（挂 `/api/bot-service` 之下，04.3 `bindingCodes` 同款），strict body `{ grantId }`；错误语义：400 `key_issuance_invalid_request` / 401 门 / 403 `model_access_grant_refused`（统一，不分支原因）/ 502 网关分类码（`GatewayNotReadyError` → 503）。**响应含 `secret`**（唯一一次）。
- **`server/src/db/schema/gateway.ts`**（追加）+ **`server/drizzle/0140_gateway_virtual_keys.sql`**（新建表，手工 snapshot/journal，同 0132 先例）：

```
gateway_virtual_keys(
  id text PK,                          -- gvk-<16hex>
  grant_id text NOT NULL → access_grants.grant_id,
  bot_id text NOT NULL,
  gateway_customer_id text NOT NULL,   -- 本 Key 计费的同一 Customer
  gateway_virtual_key_id text NOT NULL,-- Bifrost 侧 vk id（唯一索引）
  value_hash text NOT NULL,            -- sha256(value) hex；无明文
  credential_version integer NOT NULL CHECK >= 1,
  status text DEFAULT 'active' CHECK IN ('active','expired','revoked'),
  expires_at timestamptz NULL,
  created_at timestamptz DEFAULT now()
)
UNIQUE (grant_id, credential_version)；INDEX bot_id；INDEX gateway_customer_id
```

- **`server/src/bot-services/auth.ts`**（最小编辑）：`BotServiceRouteDependencies.keys?` 子路由 + `app.route("/keys", …)`（`bindingCodes` 完全同款）。
- **`server/src/bot-services/registry.ts`**：组合 `keys`（database + 04.5 service + provisionCustomer 生产入口 + vk 客户端 + 审计）。
- **`server/src/app.ts`**：`botServiceRoutes({…, keys: botServices.keys})` 透传。
- **`server/src/audit.ts`**：事件白名单追加 `gateway.key_issued`。

## 2. TDD（RED → GREEN → REFACTOR，证据留档 .omc/reports/b5-244-*）

**RED 测试** `server/tests/key-issuance.integration.test.ts`（真实 PostgreSQL + 真 04.2 认证器/凭证库 + fake Bifrost 管理面 customers+virtual-keys + 可注入 gate/provisioner）：

1. 双 Bot 同一用户两授权 → 两把不同 Key、同一 customerId（远端两个 vk、本地两行、mapping 一行）；
2. 签发不新增额度/Grant/预算：credit_grants、access_grants 计数不变；create body 无 budgets 字段；
3. 跨 Bot 用他人授权领取 → 403 统一 `model_access_grant_refused`，无本地行、远端零 create；撤销后同样拒绝；
4. 本地无明文 + 版本单调：同授权两次签发 → version 1、2；行内任何列不含 `sk-bf-` 明文，`value_hash` = sha256(secret)；
5. 越权/故障注入：未认证 401、未知 grantId 403 同类、网关 500 → 502 分类、gate 未装 → 503。

**GREEN** 最小实现；**验证**：
```bash
TEST_DATABASE_URL=… openbot_b5_244_k bun test ./tests/key-issuance.integration.test.ts   # ./ 前缀
TEST_DATABASE_URL=… bun test ./tests/access-grant.integration.test.ts ./tests/bot-service-auth.test.ts ./tests/gateway-customer-provisioning.integration.test.ts ./tests/customer-provision-recovery.test.ts  # 前置回归
bun run --filter server typecheck && bun run --filter app typecheck（app 无改动则按实际）
bunx biome lint --error-on-warnings <changed files>
```

## 3. 边界（越界即停）

只改：`server/src/gateway/key-issuance.ts`（新）、`server/src/db/schema/gateway.ts`（追加表）、`server/drizzle/0140_*`（新 + meta）、`server/src/bot-services/auth.ts`（keys 挂载点 2 处）、`server/src/bot-services/registry.ts`、`server/src/app.ts`（透传 1 处）、`server/src/audit.ts`（事件 1 条）、`server/tests/key-issuance.integration.test.ts`（新）、票面 Checkpoint、本计划、`.omc/reports/b5-244*`。禁 commit/push/stash。
