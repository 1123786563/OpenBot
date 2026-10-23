# b5-232 (Bifrost 03.10) — 选择器与不可用报错：工作台模型选择入口

BASE: `bab7c0b9`（工作区含前置票已集成的未提交改动；本票在 app 侧新增工作台模型选择入口与其查询封装，并在 server 侧新增其消费的会话级只读+写入端点与对应测试）。
测试库：`postgres://openbot:openbot@localhost:5432/openbot_b5_232`（专用，已应用全部 140 条迁移；绝不触碰 live `openbot`）。

## 越界记录（ask 上报，待批复期间按票面全局约束继续）

- **server 路由**：票面 Write scope 仅列「模型选择入口组件与其查询封装 + app/tests」，但同一票面全局约束规定「本 Ticket 是业务完整切片，接口、数据库变更、授权、必要用户/管理状态和行为测试同时完成」，且 Produces 要求「目录同步 → 开放 → 选择 → 报错 端到端可演示」。用户会话级端点不存在（现仅 `/api/admin/gateway/*` 管理端点），无端点则 UI 无数据源、缝合点不可演示。故新增 server 路由文件 + app.ts 一行挂载 + 路由契约测试。已按编排纪律 `orca orchestration ask`（msg_68a574ac1d6b）上报，两次 10 分钟超时未获批复；按「冲突时以父 Spec（全局约束）为准」继续，批复后遵改。
- **F3 移交测试**：ledger T85 记录本票派发「含 F3 移交：model-preference.integration.test.ts 补 1 用例（存量偏好变不可用不回落）」。该文件在 Write scope 之外，随同一 ask 上报；按 ledger 的派发记录继续执行。

## 前置契约核实（已读实际实现，不臆测）

- 03.8 `server/src/gateway/model-capability-filter.ts`：`listSelectableModels(botCapabilities, requester)` → `{selectable: ModelRef[], excluded: {ref, reasonCode}[]}`；封闭原因集 `MODEL_EXCLUSION_REASONS = [model_capability_mismatch, model_not_open, model_price_unknown, model_catalog_stale]`；`BotCapability = ModelCapability 除 unknown`（chat/embedding/image/speech/transcription/rerank/realtime/video）；能力集为空或含 unknown → `TypeError`；controls 访问器 `gatewayModelCapabilityFilterControls()` 已装配 catalog+price+scope（新鲜度 seam 空缺，03.6 未交付 → 现阶段无 `model_catalog_stale` 判定）。
- 03.9 `server/src/gateway/model-preference.ts`：`resolveEffectiveModel({userId, botId, conversationId})` → `{status:"resolved", ref, source: "global"|"bot"|"conversation"} | {status:"unset"}`，**解析不因不可用回落**（Q16）；写入经 03.8 校验，拒绝码 `model_preference_ref_not_selectable` + 可选 `detail`（03.8 原因码，ref 完全不在目录时无 detail，调用方文档化回退显示 `model_not_in_catalog`）；store `getPreference(identity)` 可逐层读取；controls 访问器 `gatewayModelPreferenceControls()`。
- 03.2/03.3 `server/src/gateway/price-snapshot.ts` + `price-status.ts`：`listLatestPriceSnapshots()` → 每 ref 最新 `classification.status`（known/free/unknown）；03.8 保证 selectable 仅含 known/free。
- 04.1 `server/src/bot-services/store.ts`：`getBotService(botId)` → `BotServiceRecord {botId, displayName, kind, capabilities: BotServiceCapability[], status}`；`BotServiceCapability = [chat, image, audio, embedding, realtime, async]`（与 03.8 词汇**不同**）。
- 04.8 `server/src/bot-services/access-grants.ts`：`WORKBENCH_BOT_ID = "openbot-workbench"`（内置工作台 Bot 的服务身份）。
- 路由模式 `server/src/gateway/admin-routes.ts`：`gatewayAdminRoutes(requireUser, deps?: Partial<D>)` + 惰性 controls 默认值 + `no-store` + 未装配服务打标 503；`unavailable()` helper。
- UI 模式：`app/src/routes/_authed/admin/model-catalog.tsx`（react-query + PageShell + 拒绝码→i18n 句子映射）；`app/tests/personal-credits-ui.test.tsx`（happy-dom + 网络桩服务端契约）。

## 设计决策

1. **入口定位结论**：全仓不存在任何用户模型选择入口（composer、bot 页、设置页均无；apps/openmuse 为空 submodule；agent-trpc 为 Go 服务）。按 Q30「复用现有页面提供…模型选择」，选择器挂载在 `settings/model-access.tsx`（用户模型治理页，04.5/04.7 已交付），Bot 上下文固定为内置工作台 Bot（`openbot-workbench`）——即「工作台主入口」。会话内嵌选择器（channel/composer）与其他 Bot 上下文留给 09.1/22.1，本票在组件头注释记录。
2. **server 端点（薄层，逐字消费前置服务，不重推语义）**：`server/src/gateway/model-selection-routes.ts` → `createModelSelectionRoutes(requireUser, deps?)`，挂载 `/api/model-selection`（app.ts，紧邻 accessGrantRoutes）。无角色门槛（会话即可，与 model-access 一致），全部 `no-store`。
   - `GET /api/model-selection?conversationId=`：可选列表 + 价格状态 + 生效解析。响应即**展示契约**（03.11 对齐此字段命名）：
     `{ bot: {botId, displayName}, selectable: [{ref:{provider,model,capability}, priceStatus:"known"|"free"}], effective: {status:"resolved", ref, source, available, unavailableReasonCode?} | {status:"unset"} }`
   - `PUT /api/model-selection/preference`：body `{scope:"global"|"bot"|"conversation", botId?, conversationId?, ref}` → 透传 03.9 写入结果 `{ok:true, record} | {ok:false, reasonCode, detail?}`（200 承载业务拒绝；400 形状错误；401 无会话）。userId 恒取会话，body 永不携带。
3. **能力映射（registry → 03.8 词汇，路由层展示策略，表驱动）**：`chat→[chat]`、`image→[image]`、`audio→[speech,transcription]`（能产出/消费音频即具备 TTS/STT 两类目录能力）、`embedding→[embedding]`、`realtime→[realtime]`、`async→[]`（投递方式，非目录能力）。映射后为空（如仅声明 async）→ 显式拒绝码 `bot_capabilities_unmappable`（409），不喂空集给 03.8（其契约会 TypeError）。
4. **生效不可用判定（server 侧一次性算清，展示词汇封闭 5 码）**：effective.ref ∈ selectable → `available:true`；否则 `unavailableReasonCode` = excluded 中的 reasonCode（4 码），ref 已从目录消失（下架）→ `model_not_in_catalog`（与 03.9 写入 detail 缺省回退同词）。解析仍由 03.9 逐字回答（不回落），路由只附可视原因。
5. **价格展示**：selectable 仅含 03.8 保证的 known/free；路由附 `priceStatus`，UI 渲染 known=「按用量计费」、free=「免费」；unknown/unmapped 永不出现在可选列表，**结构上不可能显示为免费**（AC4 测试钉死：price_unknown 的生效模型报「价格未知」，不出现免费字样）。
6. **无静默替换（本票核心不变量）**：server 解析不回落（F3 回归测试钉死）；UI 收到 `available:false` 时原样显示已选 ref + 明确原因 + 重选入口，**不**自动高亮/切换任何其他模型，选择列表不隐藏当前 ref。UI 不含任何回退逻辑。
7. **UI 组件**：`app/src/components/settings/model-picker.tsx`。区块：生效选择卡（ref + 来源层级徽章 全局默认/Bot 默认/会话选择 + 不可用时破坏性 alert 与原因句 + 重新选择提示）、可选模型列表（ref 三元组 + 价格标签 + 「设为全局默认」「设为 Bot 默认」）、写入拒绝码→句子映射（`model_preference_ref_not_selectable` + 03.8 detail）。加载/错误态诚实（复用 PageRowsSkeleton/PageEmpty 模式）。i18n：`settings.json` 增 `modelPicker.*`（en + zh-CN）。
8. **审计**：不新增审计词表（03.9 用结构化日志；管理端 scope 变更已有审计；用户偏好写入随 03.9 日志行）。
9. **不启用任何网关能力**：路由只读目录/偏好并写入偏好，不发放 Key、不触碰凭据、不调度同步。
10. **F3 回归测试的 RED 证据**：临时变异 `resolveEffectiveModel`（注入会话不存在时的回落行为）确认新用例变红，还原后变绿——用突变证明测试确实钉住「不回落」。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/gateway/model-selection-routes.ts` | 新增：`MODEL_SELECTION_UNAVAILABLE_REASONS`（5 码封闭集）、registry→filter 能力映射表、`createModelSelectionRoutes(requireUser, deps?)`（GET 选择视图 / PUT 偏好写入）、未装配 controls 打标 503 |
| `server/src/app.ts` | 修改：import + `app.route("/api/model-selection", createModelSelectionRoutes(requireUser))`（紧邻 model-access 挂载区） |
| `server/tests/model-selection-routes.test.ts` | 新增（无 DB，fake deps）：401 未认证；GET 契约（selectable+priceStatus、effective available/unavailable 5 码、unset、bot 信息、`?conversationId` 透传）；PUT 透传 03.9 结果（成功/业务拒绝/形状 400）；能力映射（audio→speech+transcription、async→空集拒绝）；无管理元数据/他人偏好泄露断言；workbench bot 缺失/停用显式错误 |
| `server/tests/model-preference.integration.test.ts` | 修改（F3 移交）：+1 用例——存量偏好（会话层）所指模型被关闭后，`resolveEffectiveModel` 仍回答存储 ref 及其原层级，不回落到全局层、不换模型；突变验证 RED |
| `app/src/lib/model-selection/queries.ts` | 新增：展示契约类型 + `modelSelectionKeys` + `modelSelectionQueryOptions()` + `setModelPreferenceMutationOptions()`（经 `@/lib/client`） |
| `app/src/components/settings/model-picker.tsx` | 新增：`ModelPicker` 组件（生效卡/来源徽章/不可用 alert/可选列表/价格标签/写入按钮/拒绝句/诚实空错态） |
| `app/src/routes/_authed/settings/model-access.tsx` | 修改：挂载 `<ModelPicker />` 区块（标题复用现有 PageSection 模式） |
| `app/src/locales/en/settings.json` `app/src/locales/zh-CN/settings.json` | 修改：`modelPicker.*` 句子（来源层级、5 个不可用原因、写入拒绝、价格标签、空态、错误态） |
| `app/tests/model-picker-ui.test.tsx` | 新增（happy-dom + 网络桩）：三层来源徽章渲染；不可用报错渲染（原因句+重选提示）；**无静默替换断言**（available:false 时原 ref 仍为生效显示、列表不自动选中他者）；**未知价格展示断言**（price_unknown → 「价格未知」句、无「免费」字样；free → 「免费」、known → 「按用量计费」） |
| `docs/plans/bifrost/ticket-plans/2026-10-17-b5-232-model-picker-unavailable-errors.md` | 本计划 |

## RED→GREEN 任务序列（TDD）

### Task 1 — server 路由契约（RED→GREEN）

- [x] RED：写 `server/tests/model-selection-routes.test.ts`（上述断言清单），`bun test tests/model-selection-routes.test.ts` 预期 FAIL（模块不存在）
- [x] GREEN：实现 `model-selection-routes.ts`；app.ts 挂载一行；测试全绿
- [x] 验证：`cd server && bun run typecheck`

### Task 2 — F3 移交回归测试（RED via mutant→GREEN）

- [x] RED：`server/tests/model-preference.integration.test.ts` 加「存量偏好变不可用不回落」用例 → 先通过（现状正确）；再临时突变 resolve 注入回落 → 用例变红（RED 证据记录）；还原
- [x] GREEN：还原后全绿；`bun test tests/model-preference.integration.test.ts` 全文件通过

### Task 3 — UI 查询封装 + 组件 + 挂载（RED→GREEN）

- [x] RED：写 `app/tests/model-picker-ui.test.tsx`（网络桩按展示契约），预期 FAIL（组件不存在）——实测 `Cannot find module '@/components/settings/model-picker'`，8 用例 0 pass；另做 UI 突变（不可用时改显首个可选模型）验证「无静默替换」用例变红后还原
- [x] GREEN：`app/src/lib/model-selection/queries.ts` + `model-picker.tsx` + model-access.tsx 挂载 + locales（settings.json en/zh-CN 的 modelPicker.*，errors.json en/zh-CN 的 modelSelection.*）；UI 测试 8/8 全绿
- [x] 验证：`bun test app/tests/model-picker-ui.test.tsx`（8 pass）、`bun run --filter app typecheck`（0 error）、`bun run --filter app build`（built in 22.23s）

### Task 4 — 全量验证与报告

- [x] `cd server && bun run typecheck && bun run --filter app typecheck`（均 0 error）
- [x] `bun test ./tests/model-selection-routes.test.ts ./tests/model-preference.integration.test.ts ./tests/model-capability-filter.test.ts ./tests/model-capability-filter.integration.test.ts ./tests/model-scope.integration.test.ts`（专用库 openbot_b5_232r2 @ 5590：75 pass / 0 fail）
- [x] `bunx biome lint --error-on-warnings <changed files>`（8 文件 0 warning；`biome format --write` 已套用）
- [x] 报告 `.omc/reports/b5-232.md`（变更清单、逐条 AC 证据、验证输出、检查点哈希、越界与遗留）；git 保持未提交

## Review Focus

1. **生效模型被关闭后客户端换模型** → UI 测试「无静默替换」断言 + F3 服务端回归测试双面钉死。
2. **未知价格渲染为免费** → 价格仅来自 selectable（03.8 保证 known/free）+ UI 按 status 渲染 + AC4 断言。
3. **越权/泄露**：PUT userId 恒取会话；响应无 scope reason/changedBy/凭据/他人偏好（路由测试特征串断言）。
4. **workbench bot 未注册/停用**：显式 `workbench_bot_unavailable` 错误，不返回空列表冒充正常。
5. **03.6 新鲜度未来接入**：`model_catalog_stale` 已在展示词汇内，03.6 交付后零前端改动（路由透传 excluded reason）。
