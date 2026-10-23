# b5-223 (Bifrost 03.1) — 目录抓取与 ModelRef 规范化

BASE: branch `1123786563/b5-223` @ `bab7c0b9`（工作区含集成层未提交改动，本票不触碰）。前置 #213 已集成：`server/src/gateway/readiness.ts` 提供 `assertGatewayReadyForBilling()`。

## 事实源摘录

- 上游 wire shape（已读 bifrost 源码核实，submodule 在主 checkout）：
  - `GET /v1/models`（`transports/bifrost-http/handlers/inference.go:865`）返回
    `BifrostListModelsResponse { data: Model[], next_page_token }`（`core/schemas/models.go:72`）。
  - `Model.id` 恒为 `"<provider>/<model>"`（live 路径 `string(providerKey)+"/"+…`，catalog 回退路径同形，`core/bifrost.go:581`）。
  - 能力信号字段：`Model.supported_methods []string`（provider 词汇各异：Gemini `SupportedGenerationMethods`、Cohere `Endpoints`、HF pipeline tags，见 `core/providers/*/models.go`）；`architecture.{input,output}_modalities` 是内容模态，不足以单独判定调用能力。
  - 分页参数 `page_token`（`inference.go:999`）。管理面凭证为 Bearer admin key（01.2 resolve，与 probe `/api/config`、negotiation `/api/plugins` 同法）。
- 设计 doc：Q4/Q17（目录同步、失败保留最后成功快照）；AC06。设计 61 行：目录同步必须用脱敏的列表接口，不得复用会返回 Key 明文的详情 GET —— `/v1/models` 为模型元数据列表，符合。

## 交付契约（Produces）

- `ModelRef { provider, model, capability }`；`modelRefKey(ref)` = `provider + "|" + model + "|" + capability`。
  capability ∈ chat|embedding|image|speech|transcription|rerank|realtime|video|unknown（Q20 能力集 + unknown）。
- `CatalogEntry { ref, capabilitySource, unknownReason?, rawEntry }`；unknown 携带固定原因码
  （`catalog_capability_no_signal` / `catalog_capability_unrecognized`），绝不默认 chat。
- `CatalogFetchRecord { fetchedAt, source, rawItemCount, configVersion }`。
- `fetchCatalog()`：门禁（assertGatewayReady）→ dial `/v1/models`（跟随 next_page_token，页数上限）→ 规范化 →
  单事务整表替换 + 追加 fetch 记录；失败返回结构化 outcome（固定原因码）且**不触碰** last-good refs，失败原因持久化可展示。
  永不 throw（probe 模式），永不降级。
- `listModelRefs()`：读 last-good refs。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/db/schema/gateway.ts` | 追加 `gateway_model_catalog_refs`（UNIQUE(provider,model,capability)）与 `gateway_catalog_fetches`（append-only） |
| `server/drizzle/0129_gateway_model_catalog.sql`(+meta/_journal) | drizzle-kit generate + 手写 append-only 触发器（0128 模式） |
| `server/src/gateway/catalog.ts` | 新增：类型、规范化（纯函数）、fetch 服务、enterprise store、`gatewayCatalogControls()`（不改 app.ts） |
| `server/tests/catalog-model-ref.test.ts` | RED 先行：fixture 规范化测试（同名不同 provider、缺 capability、多能力、缺 provider 前缀、去重） |
| `server/tests/catalog-fetch.integration.test.ts` | RED 先行：门禁未就绪不拨号（fetch spy 未调用）、成功替换、失败保留 last-good、唯一约束、分页跟随/超限 |

能力推导：仅采信 `supported_methods`（固定词汇表，小写去符号后映射）；多能力产出多条 ModelRef；
存在字段但全不认识 → unknown/`catalog_capability_unrecognized`；字段缺失 → unknown/`catalog_capability_no_signal`。
`architecture.modalities` 不作为能力证据（记录于 rawEntry 供 03.2/03.3 复核）。

## RED→GREEN 验证命令

```bash
cd server
TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5590/openbot_b5_223' CREDIT_SCALE=100 \
  bun test server/tests/catalog-model-ref.test.ts server/tests/catalog-fetch.integration.test.ts   # 仓库根跑法
bun run typecheck          # server
bun x biome lint src/gateway/catalog.ts tests/catalog-model-ref.test.ts tests/catalog-fetch.integration.test.ts
```

迁移库：postgres://openbot:openbot@localhost:5590/openbot_b5_223（专用实例 b5-verify-pg，禁止触碰主实例 5432/live openbot 库）。
