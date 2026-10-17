# b5-213 / Bifrost 01.7 — 消费入口就绪门禁（实施计划）

Ticket: docs/tickets/bifrost-5/issues/01.7（#213）
BASE: bab7c0b9（worktree /Users/wuyongjun/orca/workspaces/OpenBot/b5-213，未提交检查点模式）
专用测试库: postgres://openbot:openbot@localhost:5590/openbot_b5_213（b5-verify-pg 容器，已 createdb + roles.sql + migrate）

## 消费的前置契约（已核验实际实现，非臆测）

- 01.1 `server/src/gateway/endpoint-config.ts`: `GatewayEndpointConfig { baseUrl, requestTimeoutMs, configVersion }`、`gatewayEndpointControls()`（corrupted 行读作 unconfigured → undefined）
- 01.2 `server/src/gateway/admin-credential.ts`: `resolveGatewayAdminCredential()`（`GatewayAdminCredentialNotConfiguredError` = 未配置；其他异常 = 不可用）、`gatewayAdminCredentialControls()`（index.ts 已安装）
- 01.3/01.4 `server/src/gateway/conversion-rate.ts` + `conversion-rate-store.ts`: `ConversionRateState`、`billingAdmission(state)`（**注释明示 "the seam 01.7's readiness gate consumes"**）、`readConversionRate()`（存储行损坏时 parseStored 抛错——"已配置且合法"的非法分支）、`notConfiguredConversionRateState()`
- 01.5 `server/src/gateway/probe.ts`: `GatewayProbeRecord { status, reasonCode, checkedAt, configVersion, durationMs }`、`readLastGatewayProbe()`、`createEnterpriseGatewayProbeStore(database)`
- 01.6 `server/src/gateway/capability-negotiation.ts`: `GatewayNegotiationRecord { creditAdmissionExtension: present|absent|incompatible, ... }`、`readLastGatewayNegotiation()`（configVersion 已漂移时返回 undefined）、`createEnterpriseGatewayNegotiationStore(database)`
- 注入模式: `installGatewayAdminCredentialService` / `*Controls()` 模块级单例；app.ts 持有 `config.gateway?.creditConversionRate`（boot 时已经 `parseConversionRate` 验证）
- 装配前提: `enterpriseControls()`（app.ts 已 import）、`GATEWAY_PROBE_RESULT_KEY`/`GATEWAY_NEGOTIATION_RESULT_KEY` 行在 `enterprise_settings`

## 设计（契约交付）

**合取就绪条件（全部满足才 ready；每条独立评估，聚合全部阻塞原因，不只报第一个）:**

| # | 条件 | 评估 | 失败 reasonCode |
|---|------|------|-----------------|
| 1 | 已配置地址 | `readGatewayEndpoint()` 非 undefined | `gateway_readiness_endpoint_not_configured`（undefined 含 corrupted 行读作未配置的语义）/ 读失败 `gateway_readiness_endpoint_unavailable` |
| 2 | 凭据可用 | `resolveGatewayAdminCredential()` 不抛 | `gateway_readiness_credential_not_configured`（NotConfigured）/ `gateway_readiness_credential_unavailable`（其他） |
| 3 | 探测 ok | 最新持久化探测记录存在、`status==="ok"`、且 `probe.configVersion === 当前 configVersion`（配置变更后旧探测作废，与 01.6 读取器同规则） | `gateway_readiness_probe_missing` / 非 ok `gateway_readiness_probe_not_ok` / 读失败 `gateway_readiness_probe_unavailable` |
| 4 | 扩展兼容 | 最新协商 verdict 存在（configVersion 已由 01.6 读取器把关）且 `creditAdmissionExtension==="present"` | 无 verdict `gateway_readiness_extension_not_negotiated` / `gateway_readiness_extension_absent` / `gateway_readiness_extension_incompatible` / 读失败 `gateway_readiness_extension_unavailable` |
| 5 | 比例已配置且合法 | `billingAdmission(await readConversionRate())` enabled | `gateway_readiness_rate_not_configured` / 存储行损坏抛错或读失败 `gateway_readiness_rate_unavailable` |

**Produces 契约:**

```ts
export type GatewayReadinessReasonCode = ...上表 14 个...
export type GatewayReadiness = {
  ready: boolean;
  blockingReasons: readonly GatewayReadinessReasonCode[]; // 每条可展示（固定常量，不含任何上游/地址/凭据字节）
  configVersion: number; // 就绪时 = 当时 endpoint configVersion，供下游锁定；未配置时 0
  checkedAt: string;     // ISO 8601
};
export class GatewayNotReadyError extends Error {
  readonly readiness: GatewayReadiness; // message = 逐条可展示拒绝句（无密钥、无地址、无上游数据）
}
export type GatewayReadinessService = {
  evaluateGatewayReadiness(): Promise<GatewayReadiness>;
  assertGatewayReadyForBilling(): Promise<GatewayReadiness>; // 未就绪抛 GatewayNotReadyError
};
export function createGatewayReadinessService(deps: GatewayReadinessDeps): GatewayReadinessService;
export function installGatewayReadinessService(svc): void;
export function gatewayReadinessControls(): GatewayReadinessService | undefined; // 未安装 = undefined
export function assertGatewayReadyForBilling(gate?): Promise<GatewayReadiness>; // 单一门禁入口；gate 缺省取已安装；未安装 → fail closed（gateway_readiness_gate_unavailable）
```

**关键决定:**

- 门禁**只读持久化状态**（最新探测/协商记录 + 配置行），不在请求路径上拨网络；刷新探测/协商是 01.8 管理面与后续同步票据的职责。无 ok 探测记录 = fail closed（`probe_missing`），"从未验证过"不是就绪。
- 不降级、不回退：门禁拒绝一律抛 `GatewayNotReadyError`；模块头与测试明确禁止回退供应商直连或免费放行；未安装门禁本身也是拒绝（`gateway_readiness_gate_unavailable`），不是放行。
- app.ts 注入点（Write scope 内）: `installGatewayReadinessService(createGatewayReadinessService({...}))`，五个 deps 从既有服务装配（`gatewayEndpointControls()`、`gatewayAdminCredentialControls()`、两个 enterprise store、`createConversionRateStore({ database, environmentRate: config.gateway?.creditConversionRate })`）。测试 app（无 enterprise controls）同样安装，评估时各条件 fail closed。
- 静态调用点清单测试：扫描 `server/src`（排除测试），断言引用五个条件源标识符的生产文件都在显式清单内（gateway 模块自身 + app.ts）；下游票据新增付费入口时要么经过门禁、要么有意识地扩展清单（清单即 AC4 证据）。

## 文件级变更（全部在 Write scope 内）

1. `server/src/gateway/readiness.ts`（新）— 契约类型、`createGatewayReadinessService`、install/controls、`assertGatewayReadyForBilling`、`GatewayNotReadyError`
2. `server/src/app.ts`（修改，仅注入点）— import + `installGatewayReadinessService(...)`（放在 gateway credential 挂载附近）
3. `server/tests/gateway-readiness-gate.test.ts`（新，无 DB；Verification 指定命令直接跑）— RED: 逐条件拒绝、聚合原因、configVersion/checkedAt、错误消息可展示且脱敏、fail-closed（门禁未安装）、DI spy 消费模式、静态调用点清单
4. `server/tests/gateway-readiness.integration.test.ts`（新，TEST_DATABASE_URL=专用库）— 真实行状态驱动的合取条件：逐条翻转五个真实持久化条件，门禁随之拒绝/放行；损坏比例行 → `rate_unavailable`

## RED/GREEN 命令

```bash
# RED（模块不存在时必须失败）
cd server && bun test tests/gateway-readiness-gate.test.ts
# GREEN（单元）
cd server && bun test tests/gateway-readiness-gate.test.ts
# GREEN（集成，专用库）
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5590/openbot_b5_213 CREDIT_SCALE=100 bun test tests/gateway-readiness.integration.test.ts
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/gateway/readiness.ts server/src/app.ts server/tests/gateway-readiness-gate.test.ts server/tests/gateway-readiness.integration.test.ts
```

## 越界说明

- 不加 HTTP 路由（管理员就绪页面与探测触发属 01.8）；不改 index.ts（凭据服务已由基线安装，app.ts 注入点足够）；无新迁移（五个条件全部读既有行/表，无新持久化）。
- docs/plans/（本文件）与 .omc/reports/ 为编排纪律要求的操作工件，非票面代码范围。
