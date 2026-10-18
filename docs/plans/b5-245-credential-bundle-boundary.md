# B5-245 实施计划 — Bifrost 05.4 CredentialBundle 内容与明文边界

票面：`docs/tickets/bifrost-5/issues/05.4-credential-bundle-and-plaintext-boundary.md`
基线：branch `1123786563/b5-245` @ 344dc208（#244 集成层已在基线内）。
专用测试库：`postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_245`（已 createdb + roles.sql + migrate）。

## 现有行为（已读实现，不臆测）

- `server/src/gateway/key-issuance.ts`（#244）：`issueKeyForGrant` 铸造 `sk-bf-…` 明文，恰好一次
  经 `IssuedGatewayKey.secret` 交调用方；本地仅存 sha256（`value_hash`）；审计只带 4 hex 指纹；
  `POST /api/bot-service/keys`（04.2 门禁后）目前应答 `{ key: serializeKey(key) }`。
- `server/src/gateway/model-discovery-routes.ts`（#233，03.11 契约）：`ModelRef` 三元组
  `{provider, model, capability}`，`mappedModelCapabilities(bot.capabilities)` +
  `listSelectableModels` 得 Bot 可选模型。
- `server/src/gateway/endpoint-config.ts`（01.1）：`gatewayEndpointControls().readGatewayEndpoint()`
  → `{ baseUrl, requestTimeoutMs, configVersion } | undefined`。
- 用户侧/状态侧目前**不存在**任何读 `gatewayVirtualKeys` 的路由（05.10 未实施）。

## 变更文件（全部在 Write scope 内：CredentialBundle 响应层与脱敏工具 + 对应测试）

1. **新增 `server/src/gateway/credential-bundle.ts`**（响应层 + 脱敏工具）
   - `CredentialBundle = { endpoint, modelRefs: ModelRef[], secret, expiresAt, credentialVersion }`
     — 冻结契约，仅经认证 Bot 服务端通道（04.2 门禁后的 `/api/bot-service/keys`）返回。
   - `buildCredentialBundle({ endpointConfig, modelRefs, issued })` — 组装 + 校验形状完整。
   - `gatewayKeyStatusView(row)` — 状态视图 `{ keyId, status, expiresAt, credentialVersion }`，
     Produces 契约给 05.10：状态类接口只回期限与状态，永不回 secret。
   - `credentialSecretVariants(secret)` — 精确值、URL 编码、base64/base64url/hex、
     长度 ≥8 的前缀/后缀截断变体（4 hex 指纹在阈值之下，保留）。
   - `redactCredentialSecrets(text, secret)` / `…Deep(value, secret)` — 字符串/嵌套结构脱敏，
     替换为固定 `[REDACTED:gateway-key]`。
   - `scrubErrorOfCredentialSecret(error, secret)` — 就地清洗 Error 的 message/stack，
     保持 instanceof 身份（供签发器在铸出明文后的失败路径兜底）。
2. **修改 `server/src/gateway/key-issuance.ts`**（响应层挂载点，#244 应答形状保持不变）
   - `KeyIssuanceRoutesDeps` 增加 `bundle?: CredentialBundleSources`
     （`readGatewayEndpoint` + `listSelectableModels(botId)`）。
   - claim 处理器：bundle 源缺失 → 铸造前 503 `credential_bundle_unavailable`；
     铸造成功后组装 bundle，endpoint 缺失 → 503 `credential_bundle_endpoint_unconfigured`，
     模型读取抛错 → 502 `credential_bundle_models_unavailable`（孤儿键惰性、重试自愈，
     与模块既有「remote create 之后失败」纪律一致）。
   - 200 应答 `{ key, bundle }` — `key` 为 #244 原状，`bundle` 为本票冻结契约。
   - 新增 `app.onError`：未知错误 → 固定 500 `key_issuance_unexpected`（常量体，不经 Hono 默认错误输出）。
   - `issueKeyForGrant`：铸出明文后的异常统一过 `scrubErrorOfCredentialSecret`。
3. **修改 `server/src/bot-services/registry.ts`**（响应层在部署内的组合，机械接线）
   - `keys` 组合加入 `bundle` 源：endpoint 走 `gatewayEndpointControls()`，模型走
     `gatewayModelCapabilityFilterControls()` + 本 registry 的 bot 记录 +
     `mappedModelCapabilities`（与 03.11 发现路由同一映射，不重推导）。
4. **新增 `server/tests/credential-bundle-boundary.test.ts`**（票面指定文件；真实 PostgreSQL + 假 Bifrost）

## TDD

- RED：先写测试（下述 8 条），跑 `bun test ./tests/credential-bundle-boundary.test.ts` → 失败。
- GREEN：实现 1–3，重跑 → 绿；`bun run --filter server typecheck`、biome lint。
- REFACTOR：注释与命名校准，不扩面。

## 验证命令

```bash
cd server && bun test ./tests/credential-bundle-boundary.test.ts
cd server && TEST_DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_245 bun test ./tests/key-issuance.integration.test.ts   # 依赖票不回归
cd server && bun run typecheck
bunx biome lint --error-on-warnings server/src/gateway/credential-bundle.ts server/src/gateway/key-issuance.ts server/src/bot-services/registry.ts server/tests/credential-bundle-boundary.test.ts
```

## 测试清单（对应票面 Tests to write）

1. 认证 Bot 服务端 claim → 200，bundle 五字段完整、secret === 假 Bifrost 铸造的可识别标记值。
2. 明文边界·前端/越权：无凭据/错凭据打 `/keys` → 401/401，响应体无 secret 及变体。
3. 明文边界·日志：注入 capture logger，成功 + 全部错误路径跑完后，逐条序列化扫描 → 无 secret 及变体。
4. 明文边界·审计：回读 `gateway.key_issued` 事件 payload → 无 secret 及变体；含 4 hex 指纹且 ≠ secret 片段。
5. 状态接口不含 secret：`gatewayKeyStatusView` 输出键集冻结、JSON 序列化无 secret；DB 行无明文列（value_hash ≠ secret）。
6. 错误响应脱敏：403（grant 拒绝）/503（gate 未就绪）/502（远端失败）/503（endpoint 缺失）/502（模型读取失败）
   各路径响应体均为常量文案，无 secret 及变体。
7. 脱敏工具单测：raw/base64/hex/urlencode/前缀截断/后缀截断 全部被清除；短指纹保留；Deep 遍历嵌套对象数组。
8. bundle 源缺失（未组合部署）→ 铸造前 503，假 Bifrost 收到 0 次创建调用。

## Checkpoint

完成后：`.omc/reports/b5-245.md` + 本文件 Checkpoint 节补 sha256 清单；git 保持未提交。

2026-10-18 第四任：已完成，报告见 `.omc/reports/b5-245.md`；票面 05.4 文件 Checkpoint 节已填 sha256 清单。收敛性修复三处：① claim 路由对 bundle 两个源 seam 的任意抛错翻译为类型化拒绝（503/502），非类型化错误不再落 500；② 05.3 回归测试 `appFor()` 补接 bundle 源（生产同构接线，断言零改动）；③ 多轮 claim 测试补显式超时预算（本机共享负载下单周期可达 ~2s，默认 5s 会误杀）。
