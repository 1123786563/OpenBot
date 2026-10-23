# b5-230 (Bifrost 03.8) — Bot 能力过滤：listSelectableModels

BASE: `bab7c0b9`（工作区含前置票已集成的未提交改动；本票只新增模型可选性过滤模块与对应测试，不触碰其他票文件）。
测试库：`postgres://openbot:openbot@localhost:5432/openbot_b5_230`（专用，已应用全部迁移；绝不触碰 live `openbot`）。

## 前置契约核实（已读实际实现）

- 03.1 `server/src/gateway/catalog.ts`：`ModelRef {provider, model, capability}`；`MODEL_CAPABILITIES = [chat, embedding, image, speech, transcription, rerank, realtime, video, unknown]`（封闭集，含 `unknown` 诚实未知）；`GatewayCatalogStore.readCatalogRefs()` → `CatalogStoredRef[]`（按 provider/model/capability 排序）；`modelRefKey()`。同一上游模型多能力 → 每 ref 独立。
- 03.7 `server/src/gateway/model-scope.ts`：`createGatewayModelScopeService(deps)` → `isModelOpen(ref)` = scope 行为 `open` **且** ref 仍在 last-good 目录（下架即不可选，Q17）；无 scope 行默认 closed；store 故障 throw，绝不默认 open。`GatewayModelScopeService` 同时暴露 `listAdminCatalog()`（含管理元数据——绝不能进本票结果）。
- 03.3 `server/src/gateway/price-status.ts` + 03.2 `price-snapshot.ts`：`GatewayPriceSnapshotStore.listLatestPriceSnapshots()` → `PriceSnapshot[]`，每条带 `classification`（`known` / `free` / `unknown{reasonCode, missingDimensions}`）。`unknown` 永非零成本；`free` 是价格不是准入。
- 03.6（新鲜度门禁）**未交付**（不在本票 Blocked by）。其未来契约 `assertCatalogFresh(modelRef, now)` 属 03.6；本票只为「目录过期」原因码留**注入 seam**（`deps.isCatalogFresh?`），缺省时不因过期排除任何模型，不重复实现 03.4/03.6 的语义。
- 04.1 Bot 能力声明未交付。按 Resume hint，本票以「Bot 支持能力 = 封闭目录能力词汇的非空子集（不含 `unknown`）」为最小输入契约，04.1 交付后由调用方换接真实声明，模块不变。

## 设计决策

1. **纯函数核 + DB 服务**：排除判定是纯函数 `classifyModelSelection`，输入 `{capabilityMatch, open, fresh, priceStatus}`，输出可选/排除+原因码；DB 服务只负责取数与批量询问。纯函数单测不需要 DB，SQL 路径用专用库真实集成测试，无内存 mock。
2. **原因码封闭集（4 个，固定、可展示）**：`model_capability_mismatch`（含 `unknown` 能力 ref——不能证明匹配即不匹配）/ `model_not_open`（03.7 未开放或已下架）/ `model_price_unknown`（最新分类 unknown；无快照 unmapped 同归此类）/ `model_catalog_stale`（注入的新鲜度门禁拒绝）。新增成员是契约变更。
3. **优先级固定**：能力不匹配 → 未开放 → 价格未知 → 目录过期。未开放优先于价格未知：03.7 拒绝开放 unknown 价格模型，故「未开放+价格未知」主因是未开放（管理端已展示 unmapped）；唯一「开放但变 unknown」的路径是开放后新同步出 unknown 快照——防御深度场景，`model_price_unknown` 兜住。
4. **消费 03.7 的 isModelOpen（字面消费）**：对通过能力过滤的候选逐个 `Promise.all` 批量询问 `isModelOpen`，不复制开放语义、不读 scope 原始行。已知代价：目录大时 N 次查询；批量 API 属 03.7，不在本票写范围。
5. **结果最小面**：`selectable: ModelRef[]` + `excluded: {ref, reasonCode}[]`。仅 ref 三元组与封闭集原因码——无 scope reason/changedBy、无 rawEntry、无凭据/配置/URL。`requester` 只进结构化日志（类型+id），不进结果。
6. **能力匹配语义（Q4）**：Bot 声明支持能力集合，ref.capability ∈ 集合才可能可选。聊天 Bot 的候选集里永远不出现 `image` ref——纯图像模型天然排除；chat+image 双能力模型只排除其 image ref，chat ref 仍可选。
7. **确定性顺序**：selectable/excluded 均保持目录 store 的 (provider, model, capability) 排序。
8. **输入校验**：能力集为空或含 `unknown` → `TypeError`（调用方编程错误，不是可展示拒绝）。
9. **controls 访问器**：`gatewayModelCapabilityFilterControls()` 按兄弟模块模式经 `enterpriseControls()` 组装（catalog store + price store + 03.7 `gatewayModelScopeControls()`），新鲜度 seam 留空待 03.6。
10. 无路由、无 UI、无迁移、无 schema 变更（03.10/03.11 消费本模块契约）。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/gateway/model-capability-filter.ts` | 新增：原因码封闭集、`classifyModelSelection`（纯）、`createGatewayModelCapabilityFilterService(deps)` → `listSelectableModels(botCapabilities, requester)`、`gatewayModelCapabilityFilterControls()` |
| `server/tests/model-capability-filter.test.ts` | RED（纯函数，无 DB）：四类原因码逐条、优先级（未开放压过价格未知）、free/known 可选、unknown 能力 ref 不匹配、双能力模型拆分、输入校验、原因码封闭可读 |
| `server/tests/model-capability-filter.integration.test.ts` | RED（专用库）：聊天 Bot 不拿到纯图像模型；未开放排除；开放后新快照变 unknown → 价格未知排除；新鲜度 seam 拒绝/缺省放行；结果不含管理标记（reason/changedBy/rawEntry 注入特征串断言不存在）；字段结构断言 |

## RED→GREEN 验证命令

```bash
cd /Users/wuyongjun/orca/workspaces/OpenBot/b5-230
export $(grep -E '^DATABASE_URL=' .env | head -1 | tr -d '\r')
export TEST_DATABASE_URL="${DATABASE_URL%/*}/openbot_b5_230"
cd server
bun test tests/model-capability-filter.test.ts tests/model-capability-filter.integration.test.ts
bun run typecheck && bun run --filter app typecheck
bunx biome lint src/gateway/model-capability-filter.ts tests/model-capability-filter.test.ts tests/model-capability-filter.integration.test.ts
```
