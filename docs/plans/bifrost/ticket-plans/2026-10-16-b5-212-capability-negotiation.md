# b5-212 / Bifrost 01.6 — 积分准入扩展能力协商（实施计划）

Ticket: docs/plans/tickets/bifrost-5/issues/01.6-admission-extension-negotiation.md
BASE: bab7c0b9（worktree /Users/wuyongjun/orca/workspaces/OpenBot/b5-212，未提交检查点模式）
专用测试库: postgres://openbot:openbot@localhost:5432/openbot_b5_212（已 createdb + scripts/migrate.ts 迁移 ok）

## 消费的前置契约（已核验实际实现，不臆测）

- 01.1 `server/src/gateway/endpoint-config.ts`: `GatewayEndpointConfig { baseUrl, requestTimeoutMs, configVersion }`（env 默认读作 version 0）、`readGatewayEndpoint()`（corrupted 行读作 unconfigured）、`gatewayEndpointControls()`
- 01.2 `server/src/gateway/admin-credential.ts`: `resolveGatewayAdminCredential()`（`GatewayAdminCredentialNotConfiguredError` = 未配置）
- 01.5 `server/src/gateway/probe.ts`: `probeGateway()` → `GatewayProbeRun { ready:true, result: ProbeResult } | { ready:false, reasonCode }`；`GatewayProbeResult { status, reasonCode, checkedAt, configVersion, durationMs }`；probe 路径 `/api/config`；持久化模式 = `enterprise_settings` 单行 JSONB + checkedAt 条件覆盖（setWhere）+ 严格 fromStored
- 关键禁-line：01.5 probe 只答"可达 + 凭据可用"；本票证伪"健康 200 ⇒ 就绪"

## 设计（契约交付）

**核心判定**：`negotiateGatewayCapabilities()` = probe（必须 ok）→ `GET {baseUrl}/api/plugins`（auth-gated 扩展清单）→ 识别 `openbot-credit-admission` → 版本兼容判定。健康 200 但缺扩展 = 协商完成且判 absent（未就绪、原因明确）；扩展存在且版本兼容 = present（仅此状态允许下游进入就绪判定，01.7 消费）。

- `CapabilityNegotiation`（票面 Produces 三字段 + 绑定/展示字段，JSON 可序列化）:
  - `creditAdmissionExtension: "present" | "absent" | "incompatible"`
  - `extensionVersion: string | null` — 仅当为严格 `^\d+\.\d+\.\d+$` 时回显；unparseable 一律 null（不回显未验证上游串）
  - `reasonCode`（稳定常量，不内插上游数据）
  - `supportedRange: string | null` — 本模块自有常量 `">=1.0.0 <2.0.0"`，incompatible 时非空（AC02"说明所需版本范围"自包含）
  - `checkedAt`、`configVersion`（与所拨 endpoint 快照绑定）
- 版本兼容规则：严格 X.Y.Z 数字版本，major === 1（`CREDIT_ADMISSION_SUPPORTED_MAJOR`）；范围展示常量 `CREDIT_ADMISSION_SUPPORTED_RANGE = ">=1.0.0 <2.0.0"`；无 semver 依赖，模块内解析
- 扩展清单契约（本模块定义，fake fixture 同形）：2xx JSON object `{ plugins: [{ name, version }, ...] }`；plugins 非数组 / 条目缺 name 或 version / 同名条目重复 ⇒ 整份清单不可信 → `manifest_invalid_body`（fail closed：清单缺失≠扩展缺失的证据）
- reasonCode 词汇（全部稳定常量）:
  - 协商完成: `gateway_capability_extension_present` / `gateway_capability_extension_absent` / `gateway_capability_extension_version_incompatible` / `gateway_capability_extension_version_unparseable`
  - 协商未完成（不持久化，不伪装结果）: 沿用 probe 的 `gateway_probe_*` 原因（未运行/不 ok）+ 本模块 `gateway_negotiation_manifest_{unauthorized,unexpected_status,connection_failed,timeout,invalid_body,response_too_large}`
- Run 形状（镜像 01.5 的诚实拒绝）: `{ negotiated:true, negotiation } | { negotiated:false, reasonCode }`；negotiated:false 不持久化
- 持久化: `enterprise_settings` 行 `gateway_negotiation_result`，checkedAt 条件覆盖 + 严格读取（同 probe 模式，现有表满足"持久化与迁移"，无新迁移）
- **AC04 失效语义**: `readLastGatewayNegotiation()` 只在持久化行 `configVersion === 当前 endpoint configVersion` 时返回；不匹配（配置已变更）读作 undefined ⇒ 必须重新协商；持久化历史行保留但判失效
- 脱敏（镜像 01.5 构造性脱敏）：清单 body 只用于校验后丢弃；headers 不读；fetch error 只取 name；日志/结果/持久化行只含白名单字段；`extensionVersion` 仅回显通过严格正则的字符串

## 文件级变更（全部在 Write scope 内）

1. `server/src/gateway/capability-negotiation.ts`（新）
   - 常量: `GATEWAY_EXTENSIONS_MANAGEMENT_PATH="/api/plugins"`、`CREDIT_ADMISSION_EXTENSION_NAME="openbot-credit-admission"`、`CREDIT_ADMISSION_SUPPORTED_RANGE`、`GATEWAY_NEGOTIATION_RESULT_KEY`
   - 类型: 扩展状态 / reasonCode 词汇 / `GatewayCapabilityNegotiation` / Run / Store seam
   - `fetchGatewayExtensionManifest()`（cap 读 + 严格校验，分类同 probe 姿态）
   - `createEnterpriseGatewayNegotiationStore(database)`
   - `createGatewayCapabilityNegotiationService(deps)` — `negotiateGatewayCapabilities()` / `readLastGatewayNegotiation()`
   - `gatewayCapabilityControls()` — 装配 endpoint/credential/probe controls（模式同 gatewayProbeControls）
2. `server/tests/support/fake-gateway.ts`（**加性**修改）：`startFakeGateway(plan, routes?)` 支持按路径应答（probe /api/config 与 /api/plugins 不同答）；缺省行为不变，01.5 测试不受影响
3. `server/tests/gateway-capability-negotiation.test.ts`（新，无 DB，注入 deps —— Verification 命令可直接跑）
   - RED: 三情形（无扩展 absent / 旧版本 0.9.1 incompatible+范围 / 兼容 1.4.2 present）
   - RED: probe 不 ok 时协商拒绝（401 → gateway_probe_unauthorized，且未发 /api/plugins 请求，未持久化）
   - RED: manifest 传输失败分类（401/500/连接拒绝/超时/非 JSON/超限）+ 清单形状拒绝（缺 plugins、条目畸形、同名重复）+ 版本不可解析（"1.0"、"v1.0.0"、"1.0.0-beta" → incompatible + version null）
   - RED: AC04 —— 协商绑定 v7；endpoint 升 v8 后 readLast 返回 undefined；行仍在（判失效非删除）
   - RED: 脱敏 —— 清单/错误中注入 upstreamSecretMarker，断言结果、日志、持久化值均无明文及 base64/base64url/hex 变体；unparseable 版本串不回显
   - RED: 结果字段白名单审计（无第六个字段夹带）
4. `server/tests/gateway-capability-negotiation.integration.test.ts`（新，TEST_DATABASE_URL=专用库 openbot_b5_212）
   - 真实 endpoint 行（save v1）+ 真实凭据 vault + fake 网关双路径: 健康+兼容 → present 持久化，新 service 实例（重启语义）可读
   - **AC05 关键拒绝路径**: 健康 200 + 无扩展 → negotiated absent 且持久化（门禁可读到"健康但未就绪"）
   - save endpoint v2（真实 configVersion bump）→ readLast undefined（失效）→ 重新协商 → v2 行
   - manifest 401 注入敏感 body → 无协商行持久化；endpoint/credential/比例行原样；持久化行无敏感串

## 不做（越界即停）

- 不加 HTTP 路由（01.8）、不改 app.ts / controls.ts / schema（enterprise_settings 现有表覆盖"持久化与迁移"）、不启用网关能力（07.1）、不 probe.ts 逐字节保持原样
- docs/plans/（本文件）与 .omc/reports/ 为编排纪律操作工件，非票面代码范围

## RED/GREEN 命令

```bash
# RED（先写测试；模块不存在时必须失败）
cd server && bun test tests/gateway-capability-negotiation.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_b5_212 bun test tests/gateway-capability-negotiation.integration.test.ts

# GREEN
cd server && bun test tests/gateway-capability-negotiation.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_b5_212 bun test tests/gateway-capability-negotiation.integration.test.ts
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/gateway/capability-negotiation.ts server/tests/support/fake-gateway.ts server/tests/gateway-capability-negotiation.test.ts server/tests/gateway-capability-negotiation.integration.test.ts
# 回归：01.5 前置票测试不受 fake-gateway 加性修改影响
cd server && bun test tests/gateway-probe.test.ts
```

## 检查点（执行者填写，2026-10-16 会话完成）

- BASE：`bab7c0b9b481d6563fdacb99fddf8af21f08c729`，worktree 全程未提交（编排纪律：禁止 commit/push/stash）
- 交付文件 sha256（前 12）：
  - `server/src/gateway/capability-negotiation.ts` `070377513bbd`（新增）
  - `server/tests/gateway-capability-negotiation.test.ts` `1ce1c3c33672`（新增，25 例全绿）
  - `server/tests/gateway-capability-negotiation.integration.test.ts` `6f48e8829ebf`（新增，8 例专用库全绿）
  - `server/tests/support/fake-gateway.ts` `629c44e9378f`（修复前一 worker 残缺注释块；routes 能力即本计划 Task 2）
  - 删除 `server/tests/support/gateway-probe{,.integration}.test.ts`（意外逐字节重复副本，import 不可解析）
- 完整报告：`.omc/reports/b5-212.md`（逐条 AC 证据、验证命令输出、遗留风险）
