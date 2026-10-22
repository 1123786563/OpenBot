# ME09 Report — 定时任务通过统一 Mastra 执行并回写原会话 (#481)

> 控制器注：本报告由 ME09 实现 Agent（claude 型）以文本返回，控制器于 2026-10-22 原文落盘（该 Agent 对此路径无写权限）。控制器已独立复跑 22 文件波：255 pass / 0 fail / 1268 expects，与报告一致。

- Date: 2026-10-22. Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`, branch `1123786563/mastra-exec2-2`, BASE/HEAD `bcf51633f162`（无 commit/push/stash；ME01–ME08 共享未提交树原样保留，本票增量叠加其上）。
- Ticket: `docs/tickets/mastra-agent-execution/issues/me09.md`（6 AC）；Brief: `me09/brief.md`；Spec §5/§8；ADR 0006/0008/0010

## 0. 交付概要

定时任务到点触发经**同一受控 Mastra turn** 执行的端到端切片：

- **`server/src/mastra/headless.ts`（新）**：`createGovernedTurnRunner(deps)` — 满足现有 `createTurnRunner` 的 TurnRunner 可观察合同，内部走 `executeGovernedMastra` 受控循环 + `conversation-runtime` 服务端历史重建/单写者回写 + `continuations` 挂起合同 + controlled granted tools/learned surfaces。执行租约是 OpenBot 权威（runs 服务的 request lease：acquire/定时 renew/release-once 全出口释放），**无 Intelligence socket、无私有 thread lock**。意图幂等：`governedFiringIntentKey(routineId, firingId)` 决定 clientMessageKey（≤200，超长 sha256），重复投递在 `runs.start` 处以 `RUN_IDEMPOTENCY_CONFLICT` 收敛为命名拒绝 `ROUTINE_INTENT_ALREADY_ADVANCED`；`createGenerationCurrentGate(runs)` 把 index.ts 内联的组合 generation 门提取为唯一定义。
- **runs 服务最小面新增（brief 授权的 "run 重激活" 接口变更）**：`markRunSuspended`（受 request-lease fence 的 running→waiting_approval/suspended 转移，run 保持 ACTIVE，恢复期继续按原 run 铸造 capability）与 `reactivateSuspensionLease`（仅 waiting_approval/suspended 且当前 attempt 的 run 重臂租约；拒绝已 settle run 与活 owner；返回该 run 自己的 modelRouteRef/ceiling 供 loopFor 再绑定）。`enterprise/contracts.ts` 同步 RunService 接口（加法）。
- **`index.ts` 生产装配（服务端 engine selector 合同）**：enterprise capabilities 齐备时 `routineRunner.runTurn = createGovernedTurnRunner`——scope 以 schedule-entrypoint resolver 从可信目录按记录 owner+thread 现场重签（会话行决定 tenant/workspace/principal，队列字符串不可选）；缺配置（`OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS` 未设/非法）→ `ROUTINE_BUDGET_UNCONFIGURED` 命名拒绝，不猜默认公司/无限额度；route 用与浏览器 runner 同一 `productionModelSelection` + `modelRoutes.put`，admission 经 `runWithBoundModelRoute`（runner.ts 新导出）绑定 request-local route facts；continuations 上下文以本 run 的 binding 组合（与浏览器引擎路径同构）。无 enterprise 时保持 legacy `createTurnRunner` 装配不变。
- **ME06 入场条件收口**：
  - `MASTRA_RESUME_LOOP_MODEL_UNWIRED` 移除，换 governed resume drive：wrapper 先 `reactivateSuspensionLease`（attempt/generation 与绑定不一致 → GENERATION_STALE），loopFor 用该 run 自己的 route/ceiling 建 `createGovernedModelExecution` 载体（同一网关、同一预算台账），tools 经 `createMastraTools` 带 `leaseCurrent` 探针（=renewRequestLease，丢租约按名拒绝新外部调用）；drive 结束按 outcome settle（resumed/declined→complete/fail 同租约；re_suspended→release 租约、run 保持 waiting）；drive 抛错→release 租约、run 保持 suspended，按 receipt evidence 治理重投。
  - `toolGrantCurrent` kind-aware（approvals.ts 加法 `kind` 字段并透传 `record.payload.kind`）：approval 查 plugin grant 台账（原语义），frontend_tool 查参与面自身可撤权权威（guardBotTurn：Bot 存在且未暂停；成员身份已由 field-wise 校验前置）。
  - legacy 双通道 computer 收敛（本票职责面）：governed headless 装配的 computer 工具切 `createMastraComputerTools`（computer-scope.ts 作用域环境：地址含全部 scope 段、裸 botId 按名拒绝），以 granted 形状挂载；responsibility/approval 两处 index 旧装配与 run-turn.ts 的 HeadlessToolsMiddleware 属 ME10/ME11 及 legacy 引擎面，本票未动（brief 允许 "或以 ME06 的装配面包一层"，按职责面收敛并在此声明）。
  - 组合 generation 门生产级测试（integration 第 4 例，真 runs 服务真行）。
- **回写/等待/阻断**：成功在 RUN_FINISHED 前经 `persistExecutionMessages` 回写原会话（刷新即见），`runs.complete` 需 `settlementClean()`；失败按 `classifyGovernedRunFailure` 分类后 `runs.fail`（预算 402→MODEL_BUDGET_EXCEEDED），settle-once 守卫；挂起经 continuations hook save-before-waiting → `markRunSuspended`（approval→waiting_approval、其余→suspended）→ 释放租约 → `HeadlessToolSuspension`（runner 落 waiting 行）。`routines/runner.ts`：`intentAlreadyAdvanced` 落 **skipped**（不入疲劳计数）；`run(runId, {firingKey})` 把 sweep offer key 透传为 turn runId；`sweep.ts`/`worker/src/index.ts`/`app.ts` 加法透传 firingKey。

## 1. 命令与真实结果

### 1.1 本票套件（独跑，多轮）
```
ME01_TEST_PG_PORT=5433 bun test server/tests/mastra-headless.test.ts
→ 19 pass / 0 fail / 82 expect()（多轮同计数）

ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/enterprise/mastra-routines.integration.test.ts
→ 4 pass / 0 fail / 26 expect()（真实 PG 一次性 me03 式库；四轮复跑同计数，每次新建库、teardown drop）
```

### 1.2 全量绿波（20 基线 + 本票 2 = 22 文件）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://…:5433/openbot_test bun test <22 文件 = me13 §1.3 的 18 + me07 的 2 + 本票 2>
→ **255 pass / 0 fail / 1268 expect()**（基线 231/1157 + 本票 24/111，其中 continuations 套件 +1 例 kind-aware +3 expect）
（首轮 254/1 系绿波运行中 biome --write 同时改写两套件所致伪红；净树复跑 255/0，如上。）
```

### 1.3 门禁
- `bun x tsc --noEmit`（server/）→ **恰好 3 条基线错误**（bootstrap-local-gateway.ts:106/108/120），本票 0 新增。
- `bunx biome check server/src/mastra` → **clean**（26 files）；本票两个测试文件 → clean。index.ts 预存 lint 噪声（noUnusedImports/noConsole/noNonNullAssertion，均非本票行）与本票前一致。
- 邻家回归核查：`bun test server/tests/routine-run-now.integration.test.ts` → 1/0；`routine-sweep.integration.test.ts` → 27/0（sweep/runner 签名加法零回归）；`routine-run-turn/runner/routes` 等 e2e-native 层文件 bun 直跑报 `registerHooks` 为既定错层模式（非 bun 册成员，与本票无关）。
- 清单注册：`node scripts/e2e-add-driven.mjs server/tests/mastra-headless.test.ts`（609 driven/39 groups）、`…mastra-routines.integration.test.ts`（610/39）——逐文件单独调用；`node scripts/e2e-bun-manifest.mjs` → **610 kept / 39 groups**；`e2e-file-audit.mjs` exit 0（3 个 COLLECTION_ERROR 均为本工作区既有 multitenancy 文件收集错误，与本票零交集）。

### 1.4 Driven 组核查（ADR 0008 two-tier）
- `E2E_UNIT_OUTPUT=.e2e-me09b E2E_BUN_ONLY="server/tests part 9"（+5433 PG env）bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → 组内红仅为两个 **red-alone 基线文件**：`memory-store.integration.test.ts`（PluginRefusedError GRANT_TOOL_NAME_INVALID，me13 §1.5 已登记同类）与 `ocr-pricing.test.ts`（video_input fixture，main 侧 0202 遗留）；driver 式直接复现（part 9 全组 24 文件单进程 bun 调用）：**本票 headless 套件 0 失败**，全部失败归属上述基线文件。
- part 6（integration 套件所在组）driver 式直接复现：组内失败全在 entrypoint-enumeration/gateway-admin-routes/gateway-readiness/tenancy/tenancy-rls/runs 邻居（me13 §1.5 已登记的官方企业环境 red-alone 组）；**本票 routines integration 套件 0 失败、零噪声**。

## 2. AC 逐条证据

- **AC1（可信记录+目录重建 scope；队列字符串不构成授权）**：headless.ts 先 `schedulingRecordFor(routineId)` 重读持久记录，caller thread/agentId 与记录不符 → `ROUTINE_FIRING_CONTEXT_MISMATCH`（记录缺失/停用 → `ROUTINE_SCHEDULING_RECORD_GONE`）（单测 `a_queue_string_cannot_redirect_a_firing`、`a_gone_or_paused_record_refuses_before_anything_runs`）；scope 由 schedule-entrypoint resolver `resolveForThread` 现签（integration beforeAll 断言 resolveForThread 以会话行重签出同一 principal/tenant、entrypoint=schedule；生产装配同 resolver 形状）。
- **AC2（明确预算+固定 payer；缺配置拒绝给原因）**：预算=部署显式 env（`OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS`，正 int32），payer=admission 绑定的 scope principal（budget reservation 锁定）；缺失/非法 → `ROUTINE_BUDGET_UNCONFIGURED` 且 append/admission 均未发生（单测 `missing_budget_configuration_refuses_with_the_named_reason`、`the_admission_carries_the_route_and_the_explicit_ceiling`）。
- **AC3（重复 firing/重投递只认领同一意图；lease/heartbeat/stop 为 OpenBot 权威，无 Intelligence socket/私有 lock）**：意图键确定性（单测 `derives_one_stable_intent_key_per_firing…`）；重投递收敛（单测 `a_redelivery_converges…`：0 dial/0 complete/单次 admission；integration 第 1 例真实 PG：countBudgetReservations=1、run 行仍 1 条、红投 0 dial）；锁=request lease + 定时 renew + abort 停线。
- **AC4（完整历史+当前授权上下文；参与走通用挂起合同，无浏览器不绕审批）**：模型上下文唯一来自 `runtime.loadExecutionInput` 服务端重建（integration 第 1 例 history 断言）；工具仅 granted 面（plugins grant→policy→credential→audit 不变）；frontend 桥挂起（单测 `a_participation_wait_parks_the_run_and_throws_the_suspension`：save 先于 waiting、run parked=suspended、HeadlessToolSuspension、0 fabricated 结果；integration 真库同例真行断言）；governed granted 工具的 legacy 审批等待按 tools.ts 命名拒绝关闭（不绕过）。
- **AC5（失败/暂停/取消与结果准确回写原会话，刷新可见；旧运行不被重试重复收费）**：integration 第 1 例——history seq 顺序 user→assistant、run 行 succeeded、capability 全 confirmed、重投后 reservations=1/run 行=1；settlement 脏（单测 `malformed_usage_settlement_never_reads_as_success`）→ 0 confirm/0 complete/0 回写/真失败；未终止 → `ROUTINE_TURN_UNTERMINATED`。
- **AC6（撤权/lease 丢失/预算耗尽阻断新敏感调用，真实错误+结算证据）**：撤权=integration `a_revoked_member_is_blocked_before_anything_is_admitted`（membership suspended → 目录原句抛出、0 dial、0 run 行）；lease 丢失=单测 `a_lost_lease_blocks_the_run_before_it_can_continue` + 恢复路径 tools 的 leaseCurrent 探针；预算 402=单测 `a_budget_402_blocks_the_run_with_the_classified_code`（MODEL_BUDGET_EXCEEDED 落 runs.fail）；结算证据=run 行 status/errorCode + capability 台账（integration 断言 confirmed）+ 恢复期 re-activation 拒绝 terminal run。

## 3. 文件清单（本票增量，全部未提交）

新增：`server/src/mastra/headless.ts`；`server/tests/mastra-headless.test.ts`；`server/tests/enterprise/mastra-routines.integration.test.ts`。

修改（既有脏树内加法；`*` 为本票首触文件）：`server/src/mastra/approvals.ts`、`execution-contracts.ts`、`execution.ts`；`server/src/enterprise/contracts.ts`；`server/src/enterprise/runs/store.ts*`、`service.ts*`、`runner.ts*`；`server/src/routines/runner.ts`、`store.ts`、`sweep.ts*`；`worker/src/index.ts*`；`server/src/app.ts`；`server/src/index.ts`；`server/tests/mastra-continuations.test.ts`（+1 例）；`tests/config/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（入册再生）。

## 4. 偏差与边界

- **恢复流走 "run 重激活" 臂**（而非重开 attempt）：重开 attempt 会移动 generation、与六门 generation 门正面冲突；重激活保持同一 run/attempt/generation，capability 铸造仍受 run 剩余预算与 reservation 约束，不绕网关/预算/租约。
- **headless 事件台账 best-effort**：`deps.events.append` 失败仅记日志不失败本轮（浏览器 relay 是 fail-run）；headless 无实时订阅者，run 行+会话回写+capability 台账已承载结算证据；升级为 fail-run 留 ME10+ 面收口。
- **computer 收敛范围**：仅本票职责面（governed headless 装配）切作用域装配；index.ts 另两处 legacy 装配与 run-turn.ts 的 HeadlessToolsMiddleware 属 ME10/ME11 及 legacy 引擎面，未动。
- **手动触发意图身份**：manual firing 无 offer key，以 `manual-<uuid>` 自成意图；startManualRun 的 open-run 互斥保证双击不并发。
- **集成 fixture**：复用 `createMe03Fixture`（pg-container helper）；continuation store/run 行断言走 admin 句柄（表按租户列显式过滤），其余服务全走 ob_ent_data 受限角色。

## 5. 修正记录（实施期真实行为差异）

1. 集成夹具 `INVALID_TENANT_PROVISION_INPUT`：storageKey 必须为 `tenantStorageKey(tenantA)` 派生。
2. `WORKSPACE_FORBIDDEN`：MT005 工作区成员行不在 provisionDeployment 内，直接 insert `enterpriseWorkspaceMemberships`。
3. 撤权值：`enterprise_member_status` CHECK 只允许 active/suspended，改用 "suspended"（对 resolver 的 active 谓词等效阻断）。
4. 测试意图键二次包裹：先传完整 intent key 导致 `routine-adv:` 双前缀——改为传 firing id、断言用 `governedFiringIntentKey` 派生。
5. 单测 TEXT_TURN 误传已构造 Response → 网关 502；改为传工厂本身。
6. runner 生产修正（集成前推演发现）：`surfaceFor` 增加 `binding` 入参（wiring 的 continuations 钩子以同一 binding 落账）；失败结算加 settle-once 守卫；租约释放改 release-once 并覆盖全部出口。

## 6. UNVERIFIED（环境/范围边界，不以 mock 冒充）

- 真实时钟调度端到端（真 cron 到点、真 worker 进程链路）：以 offer-key 形状 firing id + 集成等价断言覆盖；worker dispatch 改动（+firingKey body 字段）未跑真 worker 进程。
- 真实 provider/真实模型网关 dial：carrier 为真实 createGovernedModelExecution，上游 dial 为 stub SSE（me02 起既定 harness 形态）。
- 恢复 drive 的跨进程全链路集成（真引擎 resumeStream+重激活+终态 settle 一条龙）：loopFor 组合生产装配就位，六门/CAS/receipt 契约由 ME05/ME06 套件与 kind-aware 新例覆盖；本工作区未重复建设 me05-child 形态第三进程重放。
- 预算耗尽在真实 runs 服务上的 402 注入（集成层）：以真实 carrier+合成 runs 分类断言覆盖。
- `OPENBOT_ROUTINE_RUN_OUTPUT_TOKENS` 的配置样例/部署文档未加入任何配置文件（仅 env 读取；配置面登记属部署收口）。

## 7. 边界确认

未改调度算法/疲劳规则/产品行为；未改 OpenMuse、Craft/Computer 引擎；未 commit/push/stash；ME01–ME08 未提交增量零触碰（除上列加法文件中本票自己的增量行）。
