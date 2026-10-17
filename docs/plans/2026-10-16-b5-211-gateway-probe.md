# b5-211 / Bifrost 01.5 — 网关连接与认证探测（实施计划）

Ticket: docs/tickets/bifrost-5/issues/01.5-gateway-connection-probe.md
BASE: bab7c0b9（worktree /Users/wuyongjun/orca/workspaces/OpenBot/b5-211，未提交检查点模式）
专用测试库: postgres://openbot:openbot@localhost:5432/openbot_b5_211（已 createdb + 迁移）

## 消费的前置契约（已核验实际实现）

- 01.1 `server/src/gateway/endpoint-config.ts`: `GatewayEndpointConfig { baseUrl, requestTimeoutMs, configVersion }`、`gatewayEndpointControls()`（corrupted 行读作 unconfigured）
- 01.2 `server/src/gateway/admin-credential.ts`: `resolveGatewayAdminCredential()`（内部解密入口，无 ref 时取当前；`GatewayAdminCredentialNotConfiguredError` 表示未配置）、`gatewayAdminCredentialControls()`
- 持久化模式: `enterprise_settings` 单行 JSONB（endpoint/conversion_rate/admin_credential 三兄弟均如此），`conversion-rate-store.ts` 的 advisory lock + notify 模式

## 设计（契约交付）

- `ProbeResult`（票面契约）: `{ status: ok|unauthenticated|unreachable|timeout|invalid_response, reasonCode, checkedAt, configVersion, durationMs }`
  - durationMs 为探测耗时（非敏感、可展示）；其余字段与票面一致
- 未就绪不伪装成探测失败: 地址未配置 / 凭据未配置 / 凭据解密不可用时返回 `{ ready:false, reasonCode }`，不产生探测结果、不持久化（01.7 门禁单独判定这些条件）
- 分类规则（status / reasonCode，均为稳定常量，不内插任何上游数据）:
  - 2xx 且 body 为 JSON object（≤512KiB）→ ok / `gateway_probe_ok`
  - fetch 按 AbortSignal 超时（TimeoutError/AbortError）→ timeout / `gateway_probe_timeout`
  - 其他 fetch 异常 → unreachable / `gateway_probe_connection_failed`
  - 401/403 → unauthenticated / `gateway_probe_unauthorized`
  - 2xx 但 body 非 JSON object → invalid_response / `gateway_probe_invalid_body`
  - body 超过 512KiB 上限 → invalid_response / `gateway_probe_response_too_large`
  - 其余状态码（3xx/4xx/5xx）→ invalid_response / `gateway_probe_unexpected_status`
- 探测请求: `GET {baseUrl}{GATEWAY_PROBE_MANAGEMENT_PATH="/api/config"}`（Bifrost 管理面端点，auth-gated），`Authorization: Bearer <adminKey>`，`redirect:"manual"`，`signal: AbortSignal.timeout(requestTimeoutMs)`
- configVersion 绑定: 探测开始时读取 endpoint 配置快照，结果与持久化都绑定该快照的 configVersion（并发保存后不回读）
- 持久化: `enterprise_settings` 行 `gateway_probe_result`，按 checkedAt 条件覆盖（`setWhere`，旧完成不覆盖新记录）；读取时严格校验形状，损坏读作 undefined + warn
- 脱敏: 结果/日志只含 status、reasonCode、configVersion、durationMs、checkedAt；不记 URL、不记 error.message（error 仅记 name）、不读响应头、body 仅用于 JSON 校验后丢弃
- 禁改: 探测失败只写自己的行，绝不触碰 endpoint/conversion_rate/admin_credential 行

## 文件级变更（全部在 Write scope 内）

1. `server/src/gateway/probe.ts`（新）
   - 类型: GatewayProbeStatus / GatewayProbeReasonCode / GatewayProbeResult / GatewayProbeRun / GatewayProbeRecord
   - `probeGatewayManagementEndpoint({ config, adminKey, fetchImpl, now })` — 纯分类（供测试与复用）
   - `GatewayProbeResultStore` seam + `createEnterpriseGatewayProbeStore(database)`（enterprise_settings 实现）
   - `createGatewayProbeService(deps)` — probeGateway() / readLastGatewayProbe()
   - `gatewayProbeControls()` — 从 enterpriseControls 装配（模式同 gatewayEndpointControls）
2. `server/tests/support/fake-gateway.ts`（新）— Bun.serve 可编程 fake 网关 helper（记录请求、可控响应/挂起）
3. `server/tests/gateway-probe.test.ts`（新，无 DB，注入 fetchImpl —— Verification 指定命令可直接跑）
   - RED: 五类结果分类、401/403 同类、500/3xx → unexpected_status、畸形 body、超限 body、timeout 与 unreachable 区分
   - RED: 脱敏断言（注入敏感串的 body/headers/error.message，断言结果与日志无明文及 base64/hex 变体）
   - RED: Authorization 头携带凭据（仅测试侧断言请求）、结果字段恰好五个
4. `server/tests/gateway-probe.integration.test.ts`（新，TEST_DATABASE_URL=专用库）
   - 真实 endpoint 行 + 真实凭据 vault + fake 网关: ok → 持久化、新 service 实例（重启语义）可读
   - 真实 fetch 信号超时 → timeout（证明 signal 接线）
   - 连接拒绝 → unreachable 持久化
   - 401 注入敏感 body → 结果/日志/持久化行均无敏感串
   - 探测在途时并发保存 v2 → 结果与持久化行绑定 v1
   - 探测失败后 endpoint 行（version/baseUrl）与 conversion rate 行原样

## RED/GREEN 命令

```bash
# RED（先写测试，未实现时必须失败: 模块不存在）
cd server && bun test tests/gateway-probe.test.ts

# GREEN
cd server && bun test tests/gateway-probe.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_b5_211 bun test tests/gateway-probe.integration.test.ts
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/gateway/probe.ts server/tests/support/fake-gateway.ts server/tests/gateway-probe.test.ts server/tests/gateway-probe.integration.test.ts
```

## 越界说明

- 不加 HTTP 路由（触发探测的 route 属 01.8）；不改 app.ts / controls.ts / schema（无新表迁移——持久化走 enterprise_settings，与三个兄弟配置行同模式，票面"持久化表与迁移"以现有表满足，无需新迁移）
- docs/plans/（本文件）与 .omc/reports/ 为编排纪律要求的操作工件，非票面代码范围
