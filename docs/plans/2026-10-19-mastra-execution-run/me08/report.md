# ME08 Report — 保留可选学习技能的快照校验、加载与撤销 (#480)

> 控制器注：本报告由 ME08 实现 Agent 以文本返回，控制器于 2026-10-20 原文落盘（该 Agent 对此路径无写权限）。

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`
- HEAD: `bf64d0f2772766a7c0cdbc3e9831c9024400e165`（无 commit/push/stash；ME01–ME06 共享未提交树原样保留，本票增量叠加其上）
- Ticket: `docs/tickets/mastra-agent-execution/issues/me08.md`（6 条 AC）；Brief: `me08/brief.md`

## 0. 交付概要

Mastra 执行路径打开可选学习技能：外层 run 由同一条 legacy 中间件（`RunBuiltAgent` 每外层 run 一次 `acquireLearnedSkills`，copilot.ts:3270-3281 零改动）取得经校验快照 invocation，经 `mastraAgentConfiguration` 进入执行请求（新 `learnedSkills` 合同字段）；两个保留名工具（`copilotkit_load_skill`/`copilotkit_read_skill_file`）以 ME04 同款受控包装挂载（abort 闸 + 可选 lease 探针 + operationId/argsDigest/onOperation 同一公式，已提取共享 prologue 防身份公式分叉）；execute 直通 SDK 原读（归档校验/绑定 revision/文件范围/撤销策略全在 pinned SDK，零重实现）。catalog 以 legacy 原文进可信 prompt 的 legacy 位置（computer 段之后、tail 末尾）。`MASTRA_TEXT_ONLY_SLICE` 拒绝分支移除。不改：自动学习算法、Intelligence 服务本体、`server/src/approvals/**`、记忆、CopilotKit learned-skills 校验代码（全部零逻辑改动）。app/ 零改动。

## 1. 命令与真实结果

### 1.1 RED（TDD 先证伪，实现前 9 条测试）
`bun test server/tests/mastra-learned-skills.test.ts` → 5 pass / 4 fail：
- `catalog_reaches_the_model_in_the_legacy_position`、`load_and_read_execute_the_real_sdk_snapshot_end_to_end`、`granted_tool_claiming_a_reserved_learned_name_refuses_at_mount` → 均 `MASTRA_TEXT_ONLY_SLICE`（待移除的拒绝）；
- `one_validated_snapshot_per_run_…` → 测试期望误写（见 §5），非产品缺口。

### 1.2 GREEN — 本票套件
`bun test server/tests/mastra-learned-skills.test.ts` → **13 pass / 0 fail / 72 expect()**（9 e2e 形态 + 4 wrapper 单测）。

### 1.3 全量绿波（基线 15 文件 + 本票 1 新套件 = 16 文件）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/mastra-learned-skills.test.ts server/tests/mastra-computer-tools.test.ts \
  server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts \
  server/tests/mastra-continuations.test.ts server/tests/enterprise/mastra-continuations.integration.test.ts \
  server/tests/mastra-stream-events.test.ts server/tests/mastra-ag-ui-agent.test.ts \
  server/tests/mastra-governed-execution.test.ts server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-browser-runner.test.ts server/tests/mastra-agent-resume-process.test.ts \
  server/tests/enterprise/mastra-compatibility.test.ts server/tests/mastra-tools.test.ts \
  server/tests/mastra-message-parts.test.ts server/tests/enterprise/mastra-conversation-runtime.integration.test.ts \
  app/tests/mastra-runtime-compat.test.tsx
→ 首轮 176 pass / 2 fail（§1.5 伪红）；复跑 **178 pass / 0 fail / 868 expect()**，终验再跑一次同计数
```
基线 165（me06 §1.2）+ 本票 13 = 178。

### 1.4 受影响 driven 组
```
E2E_UNIT_OUTPUT=.e2e-me08 E2E_BUN_ONLY="server/tests part 6"（+ PG env）
bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts → 1 passed / 0 failed（exit 0）
```

### 1.5 波内已知伪红（非本票回归）
首轮 2 fail 均为 `me06 child exited null without a result line`（共享进程下子进程 spawn 超时，同 me06 §5 同源）。ADR 0008 口径独跑：`mastra-frontend-tool-participation.integration` 5/0；`conversation-runtime + continuations.integration` 17/0；全波复跑两次 178/0。

### 1.6 邻家学习套件（零回归）
- `bunx e2e run --config e2e.unit.config.ts server/tests/learning-runtime.test.ts` → 9 passed；
- 同法 learning-config + learning-handoff + learning-settings → 13 passed；
- `bun test` learning-agent.integration / learning-mastra → 各自 0 fail。
注：learning-runtime/config/handoff/settings 为 e2e-native（`e2e-compat` 入口）；`bun test` 直跑会在 import 期报 bun 的 `node:module` 缺 `registerHooks`——运行层模式错误，非回归（该四文件本就不在 bun manifest 册）。

### 1.7 清单再生 / Typecheck / Biome
- `node scripts/e2e-file-audit.mjs` → exit 0（1040 files）；`node scripts/e2e-bun-manifest.mjs` → exit 0；**471 kept / 34 driven group(s)**（470→471、33→34：新套件入册 "server/tests part 6"）；2 still ours to fix（既有环境条件，零变化）。
- `bun run --cwd server typecheck` → 恰 3 条基线错误（bootstrap-local-gateway.ts:106/108/120）。
- `bunx biome check server/src/mastra` → clean；本票新/改 test 文件 → clean；copilot.ts lint 计数 HEAD 基线 10 = 本票后 10（新增 0）。

## 修正记录（fix-round-1，2026-10-20）

独立评审（Explore 型只读 reviewer，自跑全波 178/0/868 精确吻合）判定 APPROVED_WITH_FINDINGS：AC4 由 PASS 改判 PARTIAL（run 腿 MET；boot/import 构造腿为 HEAD 既有、ME15 AC1 所有）；两处行号引用修正（copilot.ts acquire :3322-3334；tools.ts execute :333-347）。次要发现（不阻塞）：confirmed_failure 测试标题宽于实际驱动面（传播腿由未改动的 RunBuiltAgent 中间件承担）；learned wrapper 若 surface 只发布两个保留名之一会挂载单工具子集（当前 SDK 恒成对发布，防御性备注）；评审无法字节级验证 pre-ME08 wrapper 提取等价（文件从未在 BASE 存在，以哈希连续性+行为等价+套件全绿佐证，如实披露）。

## 2. AC 对照（file:line + 测试名；测试文件均为 `server/tests/mastra-learned-skills.test.ts`）

- **AC1 PASS**：invocation 由 legacy 同源 per-run acquire（copilot.ts:3322-3334；acquire 在 :3326——修正于 fix-round-1）→ `mastraAgentConfiguration` 消费（copilot.ts:2444 catalog、:2454 completion）；execute 直通 SDK（mastra/tools.ts:333-347——修正于 fix-round-1）。测试：`catalog_reaches_the_model_in_the_legacy_position`（:266，模型 system prompt 见真实 catalog、保留名工具原名上 wire）；`load_and_read_execute_the_real_sdk_snapshot_end_to_end`（:306，load→SKILL 真文、read→真实文件、TOOL_CALL_RESULT 恰 2、整 run 快照请求=1）；`confirmed_learning_service_failure_is_a_real_run_failure_not_an_empty_skill_list`（:364，DELIVERY_DISABLED → acquire 真实拒绝）。
- **AC2 PASS**：一 run 一 invocation；SDK registry 键 `[containerId, revision]`（learning/runtime.ts:98-99）。测试：`one_validated_snapshot_per_run_and_each_run_revalidates_under_its_bound_revision`（:401，run 内两次调用 1 次快照；pinned r1 下 r2 应答不重绑——继续 r1 绑定内容 + stale=true + INVALID_SNAPSHOT 可观察；下一 run 重核取新内容而 run1 invocation 仍 r1）。
- **AC3 PASS**：granted 保留名拒绝（tools.ts:190-195 既有）+ learned 侧只挂 `LEARNED_SKILL_TOOL_NAMES`（tools.ts:298-302 FOREIGN）、拒无 execute（:285）、拒 granted 冲突（:308）、拒重复（:313）；桥丢弃保留名（ME06 既有）；读取范围 SDK 把守。测试：`granted_tool_claiming_a_reserved_learned_name_refuses_at_mount`（:458，真 mount 拒绝、零拨号）；wrapper `refuses_any_surface_that_is_not_the_reserved_pair`（:599）、`mounts_exactly_the_reserved_pair_under_their_original_names`（:587）、`executes_the_real_sdk_read_and_refuses_a_path_outside_the_skill`（:647，`../secret` 拒）。
- **AC4 PARTIAL（修正于 fix-round-1，2026-10-20 独立评审）：run 腿 MET；boot/import 构造腿为 HEAD 既有行为（index.ts:836/2134/4273、copilot.ts:4613 无条件构造），归 ME15 AC1 所有，见 §6.1**：触碰模块与 copilot.ts 顶层零 `new CopilotKitIntelligence`/`createIntelligenceClient`（grep 证据）；disabled 时 selectLearningTarget 短路、client 零调用。测试：`disabled_learning_mounts_no_skills_and_calls_no_intelligence_client`（:375，spy 0 次快照请求、无 catalog、wire 无保留名）；enabled 真实 health：`transient_delivery_failure_degrades_stale_and_reports_real_health`（:543，status 报真实 stale/lastError/revision）；独立配置 = createLearningRuntime 独立 client + 独立 store。
- **AC5 PASS**：`waitForSnapshot`（learning/runtime.ts:62-76 未改）abort 只拒本 invocation；registry 键容器+revision。测试：`two_runs_share_one_inflight_refresh_and_one_cancel_does_not_kill_it`（:488，A abort、B 完成、拉取=1）；`different_learning_containers_never_share_a_snapshot_across_scopes`（:513，两容器内容互串为零）。
- **AC6 PASS**：失败/降级语义全在 SDK（confirmed 拒绝 / transient stale+lastError 可观察）；catalog 只进 server 组合的 system prompt。测试：:543（降级可观察）+ :364（真失败）+ :306 尾部断言（TEXT_MESSAGE_* 事件与 persistExecutionMessages 收到内容均不含 catalog 标记）。

## 3. 改动文件清单（全部未提交）
- **新增（tests）**：`server/tests/mastra-learned-skills.test.ts`（13 条）。
- **修改（src）**：`server/src/mastra/execution-contracts.ts`（`LearnedSkillInvocationSurface` + `ExecutionRequest.learnedSkills`，加法）；`server/src/mastra/tools.ts`（`createMastraLearnedTools`/`MastraLearnedToolGuard` 新增；共享 `controlledToolOperation`（:116）提取，granted wrapper 行为逐字保留；`isReservedToolName` 注释更新）；`server/src/mastra/execution.ts`（buildAgent 挂 learned：signal/grantedNames/onToolOperation 同 guard，mount 序 granted→learned→bridges）；`server/src/mastra/ag-ui-agent.ts`（completion.learnedSkills 入 request）；`server/src/copilot.ts`（移除 MASTRA_TEXT_ONLY_SLICE 分支、catalog legacy 位、completion 接线、注释更新）。
- **修改（tests）**：`server/tests/mastra-browser-runner.test.ts`（`learned_skills_still_refuse_…` → `learned_skills_reach_the_mastra_factory_like_computer_guidance_does`，断言 factory 可达 EXECUTION_BINDING_UNBOUND）；`server/tests/mastra-governed-execution.test.ts`（过时注释 + **format-only**：L890 先于本票的格式漂移以 biome formatter 修复，20/20 不变）；`server/tests/mastra-tools.test.ts`（过时注释）。
- **生成物**：`docs/verification/e2e-bun-suites.json`、`archive/verification/e2e-file-audit.json`（再生 470→471）。`.e2e-me08/` 已删除。

## 4. 生产装配说明
零新增装配点即生效：`actorAgentResolver.get acquireLearnedSkills()`（index.ts:2890-2892，既有）→ buildAgents → RunBuiltAgent per-run acquire → governed `builtInAgentConfiguration` → engine selector 选 mastra → 本票接线。engine selector（ME14/ME16 切换）指到 mastra 的 Bot 学习即随行，无第二开关。Legacy 引擎路径零改动（learning-agent.integration 3 条继续绿）。Resume：生产 loopFor 维持 `MASTRA_RESUME_LOOP_MODEL_UNWIRED` fail-closed（ME06 §4 既定）；learned 工具随行属 ME09/ME10 以同一 `ExecutionRequest.learnedSkills` 面装配；acquisition 层"绑定 revision + 每 run 重核"合同已由测试固定。

## 5. 修正记录
- 首版对"越版应答"期望为拒绝（RED 发现）：SDK 定义 INVALID_SNAPSHOT（transient）→ 有已验证缓存时 stale 降级、绝不重绑；期望改为断言 stale + INVALID_SNAPSHOT + 绑定内容继续服务。
- `mastra-governed-execution.test.ts` L890 格式漂移为共享树先在问题（ME03 附件用例 hunk），本票 formatter 修复（空白级）。

## 6. UNVERIFIED / 边界（不装通过）
1. **Intelligence 客户端 boot 构造时机**：`learningProbeIntelligence`（index.ts:836）等四处 `createIntelligenceClient` 在 HEAD 基线即无条件构造（构造不开网络）。按 brief（"ME15 会再动构造时机；本票只保证 disabled 时不构造"）本票不改时机——run/import 腿已证，boot 腿留 ME15。
2. **真 Intelligence 服务端到端**（无外部凭据）：以 pinned SDK + 真实 ZIP/etag/manifest 合成快照驱动真实 `SkillRegistry`；`learning-agent.integration` LLMock 真引擎用例继续绿作旁证。
3. **续跑循环中的 learned 工具**：生产 loopFor fail-closed，ME09/ME10 接线时装配；本票固定 acquisition 合同与挂载面。
4. **AC5 的 OpenBot 租户隔离面**：容器即授权边界（同容器=同发布技能集）；公司/团队 Bot 各有 settings 行与 user 绑定（`containerForThread` 既有测试绿）。RLS 级跨租户证据属企业 runs 套件既有环境门槛，非本票新增面。

## 7. 冲突与升级记录
无 Spec §7/ADR 0005/0010 冲突。未实现新学习算法；未删除任何 CopilotKit learned-skills 校验代码；`server/src/approvals/**`、memory、learning/runtime.ts、learning/remote.ts 零逻辑改动。
