# MOD06 计划（#626：封装会话完整历史与消息单写者并隐藏引擎存储，M04 Conversation）

状态：冻结（2026-10-25）。实施基点 `9fd8228ff`（集成分支 `1123786563/issue-620-integration` HEAD）。实施 Agent pi；本文件全文内嵌于 `briefs/MOD06-impl-brief.md`。

## 0. 侦察事实（编排者已核实 @ `9fd8228ff`，pi 免重复侦察）

- M04 组（moduleRoots 已预置）：`server/src/channels/` + `server/src/enterprise/conversations/`。45 条 MOD06 环例外（全部「X→M04 文件」入向），exit_condition 均为两段式「M04 建立 public/integration 出口**并**让 Mxx 改走公开出口」——**本票=出口段**（与 MOD05 同构）；消费者迁移（含 tenancy conversation-actions/conversations-list、runs/、models/budget、mastra/headless、legacy-import、channels 系入向）属后续票。
- **#472 既有结果已对码证实**（RF-1 规划输入落实：设计文档阶段标注不作事实源，以本侦察为准）：`createConversationService({data, mastraStorage?})`（service.ts:383，~53KB）已统一双存储；模型读路径 `mastra/conversation-runtime.ts:111` `deps.conversations.history`（类型经 M02 contracts 注入，无 M04 直连）与客户端刷新同源——验收①「同一份历史」现状已真。
- **ConversationService 接口在 M02**：`enterprise/contracts.ts:69`（AppendMessageInput/HistoryInput/MessageDTO/MessagePage 等 DTO 词汇表同源）——M04→M02 类型方向合法（环例外均为 M02→M04 入向 store.ts）。
- **迁移臂落点（生产真实）**：`enterprise/conversations/routes.ts`——GET `/` :135（list）、POST `/` :147（getOrCreate）、**GET `/:threadId/messages` :171（客户端刷新，service.history :180）**、**POST `/:threadId/messages` :194（聊天提交，service.append :214）**；装配 runtime.ts :1290 `enterpriseConversationRoutes` → coworker :8234。
- 引擎存储消费面已近收敛：`TenantMastraStorage`/`MastraConversationRepository` 直接消费者仅 `mastra/conversations.ts`（repo 助手）与 `conversations/service.ts` 自身（构造注入）；runtime.ts:1257 直传 `mastraStorage`。
- `mastra-intent-reconciler.ts`（:40 createMastraMessageIntentReconciler）：finalize 恢复语义（OCR R2-5 注释：唯一 finalized-intent 校验/组装共享于收敛重读 readFinalizedMessage）——验收④现状机制。
- 存量测试：`conversation-messages.test.ts`、`conversations-list.test.ts`（multitenancy，消费 tenancy 服务，DB 门控）、`mastra-message-parts.test.ts`、`group-conversations{,.integration}.test.ts`、`coverage-bots-conversations.test.ts`。

## 1. 目标形态

### A. `server/src/enterprise/conversations/public.ts`（新增，M04 公开出口）

`createConversationPublic({ service })` → 能力级薄委托（interface-contracts 候选）：`list` / `getOrCreate` / `history`（授权历史读）/ `append`（幂等 append）/ `appendEngineMessage`（引擎侧唯一写入口）。类型只引 M02 contracts（合法方向）+ M04 组内；**不 re-export** ConversationService/store/DTO 整对象；零新策略。

### B. `server/src/enterprise/conversations/integration.ts`（新增，引擎集成适配器）

`createMastraStorageArm(...)` 具名兼容臂：包装 TenantMastraStorage→service 的装配（现 runtime.ts:1257 内联直传），装配点改经 integration 构造；**service.ts 内件零改动**（仍构造注入 mastraStorage）。单写=appendEngineMessage 唯一引擎写入口（现状已真，测试钉死）；普通调用方无需了解 Mastra binding。

### C. 迁移臂（唯一臂）

`conversations/routes.ts` 刷新（GET `/:threadId/messages`）与提交（POST `/:threadId/messages`）两 handler 改经 A 门面（组内迁移=Issue「先迁移聊天提交与刷新同一份历史」）；`runtime.ts` :1257/:1290 一带最小接线（B 装配+A 注入）。tenancy/其它模块消费者**不动**（45 例两段式第二段）。模型读路径（conversation-runtime deps 注入）不动。

### D. `server/tests/multitenancy/conversation-public.test.ts`（新增）

1. 委托等价：五能力 vs 直调 service 逐项（替身注入：同参/同结果/同错误实例）；
2. 验收②幂等：同 message key 仅一份、同键不同输入冲突（service.append 现状语义，替身或真内件）；
3. 验收③保真：完整 message parts/tool-call/result/附件经 append/appendEngineMessage 不丢（结构断言+存量 mastra-message-parts 复跑引用）；
4. 验收④恢复：存储写成 finalize 失败按同一 intent 恢复不新增重复（现状 reconciler 语义——源级钉+存量证据引用）；
5. 验收⑤单写：引擎存储只在 integration.ts 暴露（public.ts/routes.ts import 白名单零 Mastra binding）；兼容臂具名；
6. 存量复跑：conversation-messages/conversations-list（DB 阻塞按 MOD04/05 先例 BASE 对照披露）、mastra-message-parts、group-conversations。

## 2. owned_files（冻结）

| 文件 | 权限 |
| --- | --- |
| `server/src/enterprise/conversations/public.ts` | 新增全权 |
| `server/src/enterprise/conversations/integration.ts` | 新增全权 |
| `server/tests/multitenancy/conversation-public.test.ts` | 新增全权 |
| `server/src/enterprise/conversations/routes.ts` | 受限：提交/刷新两 handler 经门面 |
| `server/src/assembly/runtime.ts` | 受限：B 装配+A 注入最小接线（逐 hunk 白名单） |
| `server/tests/module-imports.json` | 预期零 delta |

其余全仓只读：service.ts/store.ts/mastra-intent-reconciler.ts（内件零改动）、mastra/**（含 conversations/conversation-runtime/message-parts）、channels/**、tenancy/**、contracts.ts 显式不碰。事实与计划不符→停下上报（MOD04/05 惯例）。

## 3. 验证门

checker 654 零 delta；`(cd server && bun run typecheck)` 恰 3 存量；审计 26 缺口零新增+605 native（新测试计入）；新测试根入口全绿；存量 conversation/intent 套件 BASE 对照复跑；biome 我方文件清（存量不修）。

## 4. 验收映射（Issue #626 五条）

①同一份历史→现状已真（C 迁移后路由族与模型读同经 service，D1 等价钉）；②幂等键→D2；③parts 保真→D3；④finalize 恢复→D4；⑤引擎存储只经内部 Adapter+兼容臂具名单写→B+D5。45 环例外出口段建立=Consumes/Produces 的 Produces 段兑现；消费者迁移登记后续票。
