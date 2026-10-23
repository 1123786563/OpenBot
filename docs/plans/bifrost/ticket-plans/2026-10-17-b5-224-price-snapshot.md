# b5-224 (Bifrost 03.2) — 多维价格快照持久化与版本

BASE: `bab7c0b9`（工作区含 #223 已集成的未提交改动，本票不触碰其文件，只在其 seam 上叠加）。
测试库：`postgres://openbot:openbot@localhost:5432/openbot_b5_224`（专用，已应用 130 个迁移；绝不触碰 live `openbot`）。

## 前置契约核实（已读实际实现）

- 03.1 `server/src/gateway/catalog.ts`：`ModelRef {provider,model,capability}`、`CatalogStoredRef`（含 `rawEntry`/`configVersion`/`fetchedAt`）、`listCatalogEntries()`、`GATEWAY_CATALOG_SOURCE = "gateway:/v1/models"`。`raw_entry` 原样保存上游字节 —— 价格映射的唯一输入。
- 01.4 `server/src/gateway/conversion-rate-store.ts`：`readConversionRate()` → `ConversionRateState`（configured=true 时带 `rateVersion`；环境比率为版本 0；未配置是合法状态）。快照记录"当时 rateVersion"，未配置记 NULL（诚实缺失，不是 0）。
- 0128/0129 迁移模式：append-only 由 DB 触发器拒绝 UPDATE/DELETE/TRUNCATE；行级触发器看不见 TRUNCATE，需语句级触发器补位。

## 上游 wire 事实（读 bifrost 源码核实，submodule 在主 checkout）

`GET /v1/models` 的 `Model.pricing`（`core/schemas/models.go:206`）是 8 个 decimal *string* 字段：
`prompt, completion, request, image, web_search, internal_reasoning, input_cache_read, input_cache_write`（JSON key 与 Go 字段名一致，core/schemas/models.go 实证）。
由 `modelcatalog/modelinfo.go:185` `formatCost = %.10f` 从 datasheet Options 投影。音频/视频/分层阶梯等 datasheet 字段**不在** wire 上 —— 映射不到的维度按票面记 unknown，绝不补 0。

## 设计决策

1. **维度封闭集（12 个，新增需迁移）**：`input`/`output`/`reasoning`（per token）、`image`（per input image）、`image_output`（per output image，v1 无 wire 来源）、`audio_input`/`audio_output`（per audio second，v1 无 wire 来源）、`cache_read`/`cache_write`（per token）、`video`（per video second，v1 无 wire 来源）、`surcharge_web_search`（per request）、`surcharge_per_request`（flat）。单位由词汇表定义（模块常量），不入行。
2. **精确十进制**：金额一律 decimal string，TS 层规范化为最简形式（`^(0|[1-9]\d*)(\.\d*[1-9])?$`），存储逐字保存规范化串；DB CHECK 兜底 `^\d+(\.\d+)?$`（禁负数/指数/浮点）。禁止 parseFloat。
3. **缺维度 = unknown，不是 0**：dims 为全维度 map，每维 `{status:"known",amount}` 或 `{status:"unknown",reason}`。固定原因码：`price_dim_no_source`（wire 无字段）/ `price_dim_unreadable`（有字段但非合法非负 decimal，绝不静默当 0）。known 且 amount="0" 才是"明确免费"（03.3 分类消费此状态）。DB CHECK 函数强制 12 键齐全、状态闭合 —— 缺键插入即拒绝。
4. **身份与不合并**：快照身份 = ModelRef 三元组 + `snapshot_version`；同名不同 provider 天然两列版本序列。
5. **不可变 + 版本**：每 ref 单调 per-ref 版本；仅当 dims 相对 latest 有变才追加（变更生成新版本，不变不刷屏）。append-only 触发器（0128 模式）拒绝改写历史。结算按 `(ref, version)` 解析；`latestPriceSnapshot(ref)` 供门禁。
6. **来源与时间**：每行记 `source`（固定 `gateway:/v1/models`）、`fetched_at`（产生该价格的目录抓取完成时间）、`config_version`、`rate_version`（同步时点；未配置为 NULL）。
7. **同步事务**：`pg_advisory_xact_lock(hashtext('gateway_price_snapshots'))` 串行化并发 sync；整批一事务 all-or-nothing；outcome 结构化、永不 throw（catalog.ts 纪律）。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/db/schema/gateway.ts` | 追加 `gateway_price_snapshots`（PK(provider,model,capability,snapshot_version)，dims jsonb + CHECK，capability 闭合 CHECK） |
| `server/drizzle/0130_gateway_price_snapshots.sql` (+meta/_journal) | drizzle-kit generate + 手写 dims 校验函数（置于建表前）、append-only 触发器（行级 + TRUNCATE 语句级） |
| `server/src/gateway/price-snapshot.ts` | 新增：维度词汇表、`mapPriceDims`（纯）、decimal 规范化、store（append/latest/byVersion/listLatest）、service `syncFromCatalog`、`gatewayPriceSnapshotControls()` |
| `server/tests/price-snapshot.test.ts` | RED：多维 datasheet fixture 映射往返、同名不同 provider、缺维度 unknown（音频/视频/图像输出）、unreadable 不当 0、极小单价精度、规范化 |
| `server/tests/price-snapshot.integration.test.ts` | RED：专用库上 append/版本单调、不变不追加、改写历史被 DB 拒绝（UPDATE/DELETE/TRUNCATE）、dims CHECK 拒绝缺键/负数、同名不同 provider 独立序列、latest/byVersion 解析 |

## RED→GREEN 验证命令

```bash
cd server
export TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5432/openbot_b5_224'
DATABASE_URL="$TEST_DATABASE_URL" bun scripts/migrate.ts   # 迁移就绪后
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test tests/price-snapshot.test.ts tests/price-snapshot.integration.test.ts
bun run typecheck
bun x biome lint src/gateway/price-snapshot.ts src/db/schema/gateway.ts tests/price-snapshot.test.ts tests/price-snapshot.integration.test.ts
```
