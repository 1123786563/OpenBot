# MOD19 计划（#639：让 Web 范围状态与业务调用消费统一 Module Interface，第五批客户端）

状态：冻结（2026-10-26）。实施基点 `ec94fdc2e`（集成 HEAD，MOD18 已并入）。载体制裁=Orca 或编排者进程内（按会话死亡判据择形，落盘纪律入派发 prompt）。

## 0. 侦察事实（编排者已核实 @ `ec94fdc2e`，含只读普查代理逐行清单）

- **基建语义**：`guarded()`（tenant/queries.ts:91）=代次前后双读、变动抛 `TenantSelectionChangedError`（迟到响应拒绝，不写缓存）；`selectWorkspaceScope`（selection.ts:359）=唯一切换缝（写 current→推进共享代次→删旧子树；公司/团队/入域三级删除粒度）；`useStreamScope`/`streamWriteStillCurrent`（stream-scope.ts）=流对应物（key=选择对@代次，帧写门）。**ScopePair 搭载**（MT086 先例）：`type ScopePair = { tenantId?; workspaceId? }` spread 进 client options；client.ts:332-348 仅同源路径且命中 `SCOPE_HEADER_ALLOWED_PATHS`（18 前缀，client.ts:193-320）才生成 `x-openbot-tenant`/`x-openbot-workspace` 头；pair 在 caller headers 之后合并不可覆盖。
- **服务端消费面**：`x-openbot-tenant` 全仓 14 点，集中 `enterprise/tenancy/{workspace-scope-routes,entry-context,workspace-admin,execution-surfaces}`+`assembly/runtime`——允许清单=scope 准入挂载的路线族。**`/api/route`、`/api/threads`、`/api/copilotkit` 服务端零消费**（headers inert，扩清单=空转）。
- **验收③现状（普查结论=零签发）**：全 app 无 body 携带 tenantId/workspaceId；头字面仅 client.ts:146-147 与 stream-scope.ts:128-129 两处基建；选择来源=URL（权威）/localStorage（用户上次显式选择）/活缓存 entry，无「替用户默认选」；无 payer 决定代码（命中均展示层）。D 以负向源级钉固化。
- **已接线面（零改动）**：agents/channels/approvals 的 scoped 半边（guarded+prefix key）、channels 事件流全链（MT082：pending 不建连/帧门/effect 重绑）、workshop/craft/computer/voice 流、company-admin 全部 8 读+3 写+audit、`enterprise/queries.ts`+`enterprise/mutations.ts`（**admin 面，设计上不绑 scope——非漏迁**）、`enterprise/tenant/mutations.ts`（移动契约仅 tenantId）。
- **待迁移面（冻结入册，实施报告§1 普查表须逐行复认）**：
  - **T1a 路径已在允许清单、只差传 pair**（纯接线，零 wire 变化）：`copilot/thread-messages.ts:192`（answer-basis，`/api/enterprise/` 前缀）、`copilot/mastra-participation.ts:47/:111`（`/api/mastra-continuations` 已在清单）、`copilot/computer-tools.tsx:541`（`/api/agents/:id/declined`）、`copilot/approval-tools.tsx:103`（`/api/approvals/computer/:id`）、`agents/mutations.ts:260/:267`（grants 写，`/api/plugins` 在清单，补 `...scopeOptions(scope)`）、`channels/mutations.ts:79`（activity）`:106`（busy，工厂签名补 scope 参数）。
  - **T1b unscoped 半边消费者迁移**：`agentListQueryOptions`(queries:122)/`agentQueryOptions`(:179)/`agentHandoffQueryOptions`(:273)、`channelListQueryOptions`(queries:85)/`channelDetailQueryOptions`(:100)、`approvalInboxOptions`(approvals:84) 的无 scope 半边——**消费者 census 先行冻结清单**（已知：bot-roster.tsx 等、inline-approval.tsx:27/:98、settings-rows.tsx:80、routes/_authed/_app/bot.tsx:60 兜底读→改消费既有 `scopedAgentDetailQueryOptions`），逐消费者改 scoped 半边（个人上下文=scope null→spread {}，语义等同）；豁免面登记（`capabilities` :87=部署配置 staleTime Infinity、`test-connection` :298=探测端点、admin 面）；unscoped 半边零消费者后可删（登记）。
  - **T2 统一缝归一**：`plugin-packages/use-package-scope.ts:27-35` 直读 `readStoredSelection`→改 `useScopedCache`（消灭旁路；同 tab 时序窗口与跨 tab 收敛语义不变）。
  - **T3 不接线、只登记**：`/api/route`（route.ts:55）、`/api/threads` mint/known（bot-thread:50/:70）、`/api/copilotkit` 历史（thread-messages:237）与 AG-UI 流（provider.tsx runtimeUrl；CopilotKit SDK 驱动）——服务端零消费，**本票不扩 `SCOPE_HEADER_ALLOWED_PATHS`**；第二段登记（须服务端 scope 准入先行，归所属服务端模块票）。
- **测试基线**：根入口 `E2E_UNIT_SCOPE=app` 秒级回合（e2e.unit.config.ts 先生成 application-config）；`app/tests/multitenancy/` 17 套件（selection 25/transport-rest 16/transport-streams 15/cache-generation 12/web-bot-ops 11/…）；**copilot 五文件+grants/activity/busy 零 scope 测试=D 缺口**；「切换不污染」既有覆盖=cache-generation(:263-:471 七钉)+transport-streams(:377-:625 五钉)+面级 web-channels/web-bot-detail/web-bot-ops。**app tsc 基线 63 error**（红基线，两侧对照法）；checker app 侧例外 78 全 cycle 类（app 整体单模块，新跨 lib 边成环须登记例外）。
- **BA 边界**：BA #542/#543/#604 新接线由原树管理；BA Run 与本票可能并发碰 `app/src/lib/copilot/**`——共享入口纪律在案，冲突面先上报不抢改。

## 1. 目标形态

### A. T1a+T1b 迁移（主交付）
- T1a 六组调用点传 pair/补 scope 参数（形状照 MT086：`...(scope ?? {})` / `...scopeOptions(scope)`；调用方如何拿到 scope=经 `useScopedCache()` 或既有 ScopedCache 注入，照 channels/start.ts:84 先例）。
- T1b 消费者 census 冻结→逐个迁移；**界面与 wire 零变化**（不改 URL/方法/body/响应形状；只补已评审清单内的请求头对）。
### B. T2 统一缝（use-package-scope 归一）
### C. 普查先行（报告§1 普查表=第一交付物：T1a/T1b/T2/T3 全册+消费者 census+豁免面）
### D. 新测试套件 `app/tests/multitenancy/web-copilot-scope.test.ts(x)`（名称可调，新增全权）
1. D1 T1a 接线等价（pair 经 options 搭载→头形状断言，照 enterprise-client.test.ts :61/:84 先例；无 pair 字节不变钉）
2. D2 验收①（新接线面切换代次拒绝迟到响应；T2 归一后 package 面同一缝）
3. D3 验收②（审批/连接/等待/错误状态行为不变：既有 approval-tools/bot-thread/thread-messages/channel 套件两侧对照+关键行为新钉）
4. D4 验收③负向源级钉（零 body 签发；头字面仅两处基建；无 payer 决定）
5. D5 验收④ census 固化（app/src 裸 `client(`/`tryClient(` 面=client.ts 自身+登记豁免集恰等；routes 零直调（admin/audit.tsx admin 面登记豁免））
6. D6 验收⑤负向（零新 UI/路由/视觉——改动面文件清单断言）
7. D7 既有 17 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）

## 2. owned_files（冻结——与消费者 census 交叉核对后入报告）

`copilot/{thread-messages,mastra-participation,bot-thread(仅登记),computer-tools.tsx,approval-tools.tsx}`、`agents/{queries,mutations}.ts`、`channels/{queries,mutations}.ts`、`channels/route.ts`（仅登记不改）、`approvals.ts`、`plugin-packages/use-package-scope.ts`、`routes/_authed/_app/bot.tsx`、T1b 消费者文件（census 冻结清单内逐个列名）、D 新增全权；`client.ts` **本票预期零改动**（T3 不扩清单）。其余全仓只读（**enterprise/tenant/** 基建零改动**、server/** 零 hunk、BA 所辖接线面**——发现基建缺口或范围不符先停下上报）。事实不符→停下上报。

> R1-F1 教训：本清单已与普查逐行清单交叉核对（T1a 六组/T1b 半边/T2/T3 全在册）。

## 3. 验证门

checker **649 基线**（新 app 边成环须登记例外并逐条说明，预期新增 0–N 条 cycle 例外；违规 0 幻影 0）；**app typecheck 63 error 基线零新增**（两侧对照：BASE=基点树首跑，IMPL=同树复跑）；server typecheck 0（server 零 hunk 则免跑并注明）；D 全部根入口（`E2E_UNIT_SCOPE=app` 快速回合）；multitenancy 17 套件+直接相关既有套件（enterprise-client/bot-thread/thread-messages/approval-tools/agents/channel-* 家族）两侧对照；biome 我方文件零新增；新测试文件入收集面后做审计两侧对照（native+1、manifest 零 delta，MOD18 同法）；复跑独立落盘。

## 4. 验收映射

①→D2；②→D3；③→D4；④→D5；⑤→D6（D1=接线等价；D7=存量对照）。
