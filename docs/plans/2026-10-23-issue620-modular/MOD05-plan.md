# MOD05 计划（#625：集中 Bot 档案固定版本与团队发布的业务出口，M03 BotCatalog）

状态：冻结（2026-10-24）。实施基点 `0e31d54ae`（集成分支 `1123786563/issue-620-integration` HEAD）。实施 Agent pi；本文件全文内嵌于 `briefs/MOD05-impl-brief.md`。

## 0. 侦察事实（编排者已核实，pi 免重复侦察）

- M03 组（checker moduleRoots 已预置）：`server/src/agents/`（~9266 行）、`server/src/team-bots/`（routes.ts 119 + team-bots.ts 551）、`server/src/enterprise/experts/`（version-catalog.ts 273）。新增 `agents/public.ts` 落组内 → 预期检查器零 delta（基线 654）。
- **生产管理入口（真实存在，本票迁移对象）**：
  - `assembly/http.ts:2764` 挂载 `/api/team-bots` → `createTeamBotRoutes(coworker.teamBots, requireUser, coworker.shared?.use)`；路由族（team-bots/routes.ts）：`GET /`、`DELETE /consents`、**`PUT /:botId/publication`（发布）**、**`DELETE /:botId/publication`（撤回）**、`POST|DELETE /:botId/assignments`、`POST /:botId/consents`。
  - `assembly/http.ts:2757` 挂载 `/api/bots` → `createBotLifecycleRoutes(coworker.lifecycle, requireUser)`（agents/lifecycle-routes.ts）。
  - `assembly/runtime.ts:1691` `agentProfileStore = createAgentProfileStore(...)`、`:2574` `teamBots = createTeamBots({database, connectedServers})`；teamBots 消费点 :2619/:2681/:3291/:3442/:3604/:4422/:5359。
- **能力面（全部 M03 组内，门面只委托不改）**：
  - `agents/profile-store.ts:64` `AgentProfileStore.create(actor, input)`（Bot 创建；:440 `createAgentProfileStore`）；
  - `team-bots/team-bots.ts:283` `publish(...)`；撤回为 DELETE publication 路径（:69 调用 unpublish，**实际成员名由 pi 证实**）；:92 `createTeamBots` 返回 `{ teamBotAccess, credentialActorFor, listenForConsent, publish, … }`；:50 管理员发布开关（TeamBotPublishForbidden 类）为原有权限面；
  - `enterprise/experts/version-catalog.ts:166` `ExpertVersionCatalog { putOrGet(:170), resolve(:224), resolveInTransaction(:253) }`——`putOrGet` 的 `on conflict do nothing` + 快照读即「模板更新不改已固定版本」的现状机制。
- **版本目录跨模块消费者（本票不动）**：`enterprise/contracts.ts`、`enterprise/runs/service.ts`、`enterprise/runs/runner.ts`、`mastra/headless.ts`。
- **验收④审计现状**：跨模块「写 Bot 表」疑点逐项排除（plugins Map.delete、db/schema 定义、channels/delivery/voice 各自域表）；门面职责=给跨模块未来消费者一个**能力级出口**，不 re-export store/teamBots 整对象。
- **存量测试**：`bot-publish.test.ts`、`bots-ownership.test.ts`（multitenancy，describeDb DB 门控，无 TEST_DATABASE_URL 收集为空）；`bot-lifecycle.test.ts` 消费的是 `enterprise/tenancy/bot-lifecycle`（M02 域，**本票不碰**，报告披露归属）。

## 1. 目标形态

### A. `server/src/agents/public.ts`（新增，M03 BotCatalog 门面）

`createBotCatalog({ profileStore, teamBots, expertVersions })` → 薄委托四能力（interface-contracts 候选名）：

- `createBot(input)` → `profileStore.create`；
- `getVersion(ref)` → `expertVersions.resolve`（或 resolveInTransaction，按调用语义）；
- `publish(botId, audience)` → `teamBots.publish`；
- `withdraw(botId)` → `teamBots.unpublish`（实际成员名以 pi 证实为准）。

硬约束：只 import M03 组内（agents|team-bots|enterprise/experts）；**不 re-export** AgentProfileStore/TeamBots/ExpertVersionCatalog 整对象或其类型面（能力级出口）；零新策略、零缓存、零写面新逻辑；依赖经构造注入。

### B. 迁移臂（唯一臂，冻结）

1. `runtime.ts`：装配 `botCatalog = createBotCatalog({ profileStore: agentProfileStore, teamBots, expertVersions })` 并注入 `coworker`（`coworker.botCatalog`）。`expertVersions` 来源：若 runtime.ts 已有 ExpertVersionCatalog 装配点则复用；**若无**（侦察显示版本目录消费者全在 runs/mastra 模块内自建），则本票在 runtime.ts 新增一行 `new ExpertVersionCatalog(...)` 装配（需 DataDatabase，pi 证实可用性）；若两路皆不通，getVersion 降为「测试路径委托等价 + 报告披露生产装配点属 runs 模块」，**不动 runs/、mastra/**（非本票 owned）。
2. `team-bots/routes.ts`：`PUT|DELETE /:botId/publication` 两 handler 改经 `botCatalog.publish/withdraw`（createTeamBotRoutes 签名增收门面参数，http.ts 挂载点相应传参）。其余 handler 与 credentialActorFor/listenForConsent 等继续直用 teamBots（组内自由）。
3. `http.ts`：仅 coworker 类型与挂载传参的最小接线改动。

行为逐字节等价（门面委托到原函数本体）；`TeamBots` 类型仍经 coworker 传递给路由族（非门面职责）。

### C. `server/tests/multitenancy/bot-catalog-public.test.ts`（新增）

1. 委托等价：四能力 vs 直调内件逐项相等（无 DB 路径为主，用可构造的最小依赖）；
2. 验收①：createBot 输入→现有 create 入参直传（身份字段与运行配置的现有分离不被破坏，结构断言）；
3. 验收②：putOrGet 幂等（同定义两次 → 同 ref）+ resolve 读回快照不受后续定义变化影响（可用内存 stub 证实委托方向）；撤回=publication 行删除不触档案/版本（对 unpublish 实现的调用面断言或委托等价）；
4. 验收③：publish 委托直传 actor，无新增授权分支（结构断言 + TeamBotPublishForbidden 路径照旧）；
5. 验收④：门面不暴露 store/teamBots 整对象（类型面断言）；全仓 grep 证明本票未给跨模块新写面；
6. 存量 bot-publish/bots-ownership BASE 对照复跑（DB 门控环境阻塞按 MOD04 先例披露；有库则复跑绿）。

## 2. owned_files（冻结）

| 文件 | 权限 |
| --- | --- |
| `server/src/agents/public.ts` | 新增全权 |
| `server/tests/multitenancy/bot-catalog-public.test.ts` | 新增全权 |
| `server/src/assembly/runtime.ts` | 受限：门面装配+coworker 注入（逐 hunk 白名单） |
| `server/src/assembly/http.ts` | 受限：coworker 类型+挂载传参最小改动 |
| `server/src/team-bots/routes.ts` | 受限：publication 两 handler 经门面 |
| `server/tests/module-imports.json` | 预期零 delta（若 checker 要求则条件重收敛） |

其余全仓只读（内件七文件、db/schema/*、enterprise/tenancy/bot-lifecycle.ts、runs/、mastra/ 显式不碰）。计划与事实不符时停下上报（MOD04 惯例），获授权后最小适配并在报告登记。

## 3. 验证门

checker 零 delta（654）；`(cd server && bun run typecheck)` 恰 3 条存量；`node scripts/e2e-coverage-audit.mjs`（26 缺口零新增、新测试 native 计入，预期 604）；新测试根入口全绿；存量抽检 bot-publish/bots-ownership BASE 对照；biome 清。

## 4. 验收映射（Issue #625 四条）

① 身份与运行配置分离→现状机制经 C2 钉死；② 模板不改已固定版本+撤回不删资产→C3；③ 只授原有权限→C4（薄委托零新授权）；④ 跨模块不直写+不全量 re-export→C5。迁移真实管理入口→臂 B（publication 动作经门面，生产链路真实改接）。
