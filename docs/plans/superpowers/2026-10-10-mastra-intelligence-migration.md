# Mastra 统一 Runtime 与 Intelligence 替代 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 专业实现 Agent 串行派发，主控统一派发 validator/reviewer/OCR。

**Goal:** 以自托管 Mastra 统一执行和 Intelligence 替代能力，保留 OpenBot 的组织权限、聊天体验、每 Run 预算及技能发布规则。

**Architecture:** Mastra Agent/Tools/Workflows/Memory/PostgresStore 提供执行和持久框架状态；OpenBot 提供可信身份、资源授权、业务 Run、回执、UI 事件投影与发布。新消息切换后仅 Mastra 可写，旧消息表作为导入源；默认不启用未经故障验证的自动 crash recovery。

**Tech Stack:** TypeScript/Bun/Hono、Mastra、AG-UI、React、Drizzle/PostgreSQL、Tauri Rust；SDK 兼容版本由 Task 1 实际 exports/peer/runtime 验证后精确锁定。

**Spec:** [2026-10-10 已批准规格](../../specs/superpowers/2026-10-10-mastra-intelligence-migration-design.md)，用户于 2026-10-10 回复“确认”。继承 [企业规格](../../specs/superpowers/2026-10-09-enterprise-ai-platform-design.md) 的治理需求；旧 [迁移规格](../../specs/superpowers/2026-10-09-trpc-intelligence-migration-design.md) 的 AC-01–12 经下述替代映射保留。没有 Issue，不虚构 Issue 树。未发现项目 CONTEXT.md/独立 ADR；不能以缺失文档新增约束。

## Global Constraints

- “采用自托管 Mastra Framework 与存储，常规运行不要求 Mastra Cloud 或 Memory Gateway 的 SaaS 账号。”
- “每个业务 Run 单独限额，跨该 Run 的调用累积记账。”
- “禁止 OpenBot 消息表与 Mastra Memory 同时成为新的可写消息主存储。”
- “从可信 scope 生成，不接受客户端替换。”
- “未知副作用进入对账”；不自动重跑整个 Agent 消除 unknown。
- “默认不自动发布”；学习关闭设置不得被迁移重置。
- 自动 crash recovery 默认关闭，直到回执对账、幂等、双实例互斥和故障测试通过。
- 原目录/已有检查点/Go 源码及用户改动保留；不提交、stash、推送、部署、导出真实资料或运行真实库迁移。
- DB tests 只使用显式校验 TEST_DATABASE_URL 的专用合成库，不能回退 DATABASE_URL 或 openbot。
- 实现者禁止再派 Agent；验证者不改生产/测试源；所有有效阻塞 finding 必须关闭，不以 parked 冒充完成。

## Review Focus

1. 两租户/账号同时运行不能串 scope/resource/store；Tasks 2、5、7 固定并发与账号切换负例。
2. Agent/subagent/observer/reflector/eval 隐藏模型调用不能绕过预算；Tasks 3、10、11 实测。
3. framework 流结束不能掩盖 waiting approval/unknown side effect；Tasks 4、5、8 固定终态与重启竞态。
4. 历史 parts/附件/tool/activity 在 replay→live 间隙不丢不重；Tasks 6、7、8 固定客户端契约与故障。
5. 导出不完整、活动 Run 或已在 Mastra 写入时禁止盲目切换/回退；Task 12，且 Task 13 干净初始化不要求旧账号。

---

## 工作区、事实源与检查点

执行 worktree `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`，已核验 linked worktree，当前 HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`；原始全交付 BASE `fbdecc29cd786952c4b496abc68384b31a320b17` 来自旧计划，最终 OCR 前再次用 Git 核验祖先关系。没有新 commit 授权。

T01–T04 既有 reviewed 内容复用；以 ledger/report/hash 为完成证据，不看旧 checkbox 推断。T04-R3 最终 R5 reviewer/validator 均 PASS，29 tests/134 assertions；gateway SHA256 `43653d0f853774b94824e4a8b6352bf37fff8eac01aa747b5c290e3116826b7d`。Task 1 不重派这些修复。原 T04 ledger 位于 `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-review-fixes-r1/progress.md`，最终 R5 报告在 `.superpowers/sdd/2026-10-10-trpc-intelligence-t04-r3-fixes-r5/reports/`。

2026-10-10 恢复基线：gateway/roster 共 38 pass；learning-mastra 一个既有失败，原因是从 workspace 外 agent-mastra 导入 @mastra/core/agent 不能解析，Task 1 系统定位。Bun 实际 1.4.2，packageManager 声明 1.3.14，兼容报告记录差异。已知 server probe readonly array TS2345 在 Task 17 明确纳入交付修正。上述不算新测试 RED/不声称全基线 clean。

本计划专属 ledger `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/progress.md`；DAG/验收映射 `docs/plans/2026-10-10-mastra-intelligence-dag.json`。文档及部分 enterprise 源被既有 ignore 规则排除，完整内容/hash 快照必须显式纳入，不只 git diff。每任务 pre/post 保存 HEAD、tracked staged/unstaged patch、owned untracked/ignored 完整内容/hash，并保留 workspace 总基线；review package 是前后增量，不是空 HEAD diff。validator/reviewer 绑定同一 after hash，变更即补验证/review。

## 接口一致性与执行约定

Task 2 单独持有 `server/src/mastra/contracts.ts` 注册 binding/history/runtime projection 公共类型；SDK 类型取 Task 1 实测导出而非最新文档猜测。旧 enterprise 产品 DTO 保留，新增字段需 strict schema/negative tests。Task 5 定义 HostedRunInput/HostedRuntimeEvent，不允许 Task 6 复制类型；Task 6 冻结实际客户端 protocol。Mastra 默认每会话来源为绑定的 private thread memory；跨 thread resource 只按本地显式 ACL 开启，Observational/long-term recall 等待 Task 10 验收。每 Task 把用到的前置 types/导出及 owned files 从注册表摘入 brief，不能要求实现者读整份计划。

Task 12（导入）、Task 13（学习管理 UI）、Task 14（服务端部署）、Task 15（Tauri 安装）及 Task 16（桌面 UI）各自有独立 owner、owned files、validator、checkpoint 与 reviewer。Task 12/13 在稳定 Task 11 API 后互不依赖，可并行派发且不共享文件/DB fixture；Task 14 等待两者 verified，Task 15→16 串行；禁止用跨端 default 实现。所有 schema/journal/shared interfaces 修改串行集成，不共享 stash。

所有 Task 共同步骤：先写下面命名测试并证明对应断言 RED（环境导入失败只算环境证据）；GREEN/refactor/self-review；保存完整证据和 report；主控生成增量 package，派相应 validator 补缺失行为与 reviewer 给 spec+quality verdict；两门 PASS 后 verified，才可执行下游。无提交的 checkpoint 替代 commit 步骤。失败产生编号 fix，不能降级验收；缺环境在可授权的本地隔离 fixture 中解决，确实无法解决则记录 blocked 不谎称完成。

## 验收替代映射

旧 AC-02 的 Go 执行要求被已批准 Mastra native 执行替代，历史主存储由 Mastra、目录授权由 OpenBot；AC-07 Go checkpoint 被 native workflow/HITL snapshot 与业务 fencing/receipt 恢复替代；AC-12 Go 检查仅适用于实际修改的 Go 文件，本计划默认不改 Go。其余 AC 保留原产品行为。规格 §1–10 映射到 Task 1–17：兼容及 tenant storage 为 Task 1–2；预算、工具、执行与持久事件为 Task 3–8；后台、记忆、学习为 Task 9–11；导入/UI/部署/桌面为 Task 12–16；端到端完成证据为 Task 17。

### Task 1: 兼容版本与真实 Agent/AG-UI 启动闭环

**Depends on:** 既有 verified T01–T04 检查点。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/package.json`, `bun.lock`, `server/tests/learning-mastra.test.ts`; Create `server/src/mastra/compatibility.ts`, `server/tests/enterprise/mastra-compatibility.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: 既有 locked core 1.64.0/client-js 1.43.0/AG-UI 1.1.6；真实包 exports 与合成模型 endpoint。
Produces: probeMastraCompatibility(): Promise<MastraCompatibilityReport>；Report 含实际 packageVersions、agentStream（raw TEXT_MESSAGE_CHUNK）、workflowSuspendResume、honoMount、storageConstructor、runtime 字段；均为可序列化验收证据，不含配置秘密。

- [ ] **Step 1 — RED:** imports_are_real_and_agent_emits_agui_events: 实际 Agent 访问 loopback 合成供应商，断言实际 raw TEXT_MESSAGE_CHUNK delta 非空、RUN_FINISHED、没有 RUN_ERROR；Task 6 再把 bridge event 明确转为产品 canonical TEXT_MESSAGE_CONTENT；workflow_native_suspend_resume: 断言原生工作流 suspend 后 resume 输出既定值；hono_mount_responds_without_saas: 实际请求 Hono adapter；existing_harness_learning_import_resolves: 原 learning-mastra 三轮工具结果测试真正通过。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 检查 lock 与安装布局，先定位既有 learning-mastra 从 workspace 外 agent-mastra 路径无法解析 core 的根因，再最小修正测试隔离依赖解析。将 server 的 core/client-js 固定为锁中已解析值；对 @mastra/memory、@mastra/pg、@mastra/hono 查询真实 registry peer/engine 与 exports，选 core 1.64.0 兼容版本并精确锁定，显式声明实际使用的 AI SDK 包。禁止 wildcard、Bun 私有缓存路径或伪造 probe 成功。新增 compatibility 模块只用于启动/测试能力核验，不装配产品 runtime。原生 Agent/Tool/Workflow/AG-UI/Hono 在 Bun 合成 endpoint 上实测；记录 PostgresStore/Memory 构造的真实签名，持久化隔离由 Task 2 实测。task-1-report.md 必须给每项能力列 tested/unsupported/disabled 及其证据；未测的 Durable Agent、多实例 reconnect、长期/观察记忆保持 disabled，Task 8/10 实测前不能被默认装配。若 Bun 失败，先证明根因，再在独立 Node 子进程运行同一协议测试并记录后续部署调整。不得调用真实供应商。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-compatibility.test.ts server/tests/learning-mastra.test.ts server/tests/mastra-roster.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-02, AC-03, AC-12；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 2: 可信会话绑定与 Mastra 主存储

**Depends on:** Task 1。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/enterprise/contracts.ts`, `server/src/enterprise/conversations/service.ts`, `server/src/enterprise/conversations/store.ts`, `server/src/db/schema/enterprise-conversations.ts`, `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `server/drizzle/`; Create `server/src/mastra/contracts.ts`, `server/src/mastra/tenant-storage.ts`, `server/src/mastra/conversations.ts`, `server/tests/enterprise/mastra-storage.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: PlatformScope、assertTrustedScope、ConversationService、Task 1 实测 SDK 签名；现有会话 ACL。
Produces: MastraConversationBinding={tenantId,conversationId,threadId,resourceId,storageKey,backend}; MastraConversationRepository.resolve(scope:PlatformScope,conversationId:string):Promise<MastraConversationBinding>；history(scope,conversationId,before:string|null,limit:number):Promise<MastraHistoryPage>；TenantStorageRegistry.forTenant(tenantId:string):Promise<TenantMastraStorage>；TenantProvisioner.provisionTenant(input:TenantProvisionInput):Promise<TenantProvisionReceipt> 创建受限 schema/role 并存储 credential reference；仅可信 registry/provisioner 可取得连接/凭据，运行时 app role 不得升级 provisioning。

- [x] **Step 1 — RED:** two_tenant_roles_cannot_read_each_other_schema: 真实 PG restricted role 直查对方失败；forged_thread_resource_and_revoked_member_rejected: 请求替换 ID/撤权皆拒绝；messages_survive_pool_restart: 通过 Mastra store 写读并关闭重建 pool；cutover_legacy_append_rejected: 切换后旧 append 拒绝，新历史无双写；private_and_channel_resources_do_not_overlap。
- [x] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [x] **Step 3 — 实现:** 建立服务端 conversation→thread/resource 绑定和 trusted tenant registry，个人 resource 按 tenant/principal，频道按 tenant/channel 授权域；默认 thread memory，客户端不能提供 schema/DSN。生产 provisioning 显式配置每 tenant schema/受限角色，不把 API metadata 当 RLS。StorageBackend 增加 mastra 并持久化单写归属，platform 历史保留为旧导入源。消息 parts/附件持久化字段使用框架真实类型，不压成纯文本。授权前置复用现有 live membership/ACL；公开返回不得含 storageKey/内部标识/凭据。下一迁移号从 journal 读取，禁止覆盖已有 0056–0060；不运行真实库迁移。
- [x] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-storage.integration.test.ts server/tests/enterprise/conversations.integration.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。R1D/FIX1 and final R1C audit reran all four serial suites with all tests passing, plus Biome/diff-check. Server typecheck reports only the already assigned, unrelated M17 probe diagnostic `server/scripts/enterprise-runtime-probe.ts:63`; the Mastra conversation service paths report no additional issue.
- [x] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。R1D and FIX1 packages/reports are hash-bound; final nine-file R1C validator and reviewer passed. M02-R8 verified in `.superpowers/sdd/2026-10-10-m02-r1c-final-acceptance-reaudit/`.

**Acceptance / failure handling:** AC-02, AC-03, AC-05, AC-10；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 3: 每 Run 治理的原生模型适配

**Depends on:** Task 2。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/enterprise/models/runtime-adapter.ts`, `server/src/enterprise/runs/service.ts`, `server/src/enterprise/contracts.ts`; Create `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`, `server/tests/enterprise/mastra-model.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: RunService one-use capability、ModelInvocationContext、RuntimeModelRoute、PlanModel；Task 2 binding。
Produces: GovernedModelContext={scope:PlatformScope,runId:string,attemptId:string,modelRouteRef:string,signal:AbortSignal}; createGovernedMastraModel(deps,context:GovernedModelContext):Promise<GovernedMastraModel>，SDK model 类型取 Task 1 实测导出；每次 generate/stream 必须独立取得并消费 capability。

- [ ] **Step 1 — RED:** all_nested_calls_share_run_ceiling: 主/子/observer/reflector/eval 请求合计超额前拒绝；abort_unknown_and_usage_settles_once；plan_model_preserves_tools_and_signal；forged_route_never_resolves_secret；stream_secrets_and_provider_errors_not_public。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 用锁定 AI SDK native model wrapper 对每次调用做 reserve/consume/usage settle，并校验 DB-time attempt fencing；并发调用共享同一业务 Run ceiling。取消/usage 不明保守 markUnknown，失败不得释放已 dispatch claim。异步观察/学习单独建立 Run。禁止供应商 key 注入 Agent state/events 或继承全局 ambient provider。复用 T04 Gateway 仅用于确需 HTTP 的兼容 route，保持其源码/测试已验证检查点；不能用追加 HTTP 作为 native 支持替代。桌面 PlanModel 从现有 adapter 复用并真实模型协议测试。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-model.test.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/model-gateway.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-02, AC-05, AC-07, AC-12；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 4: 工具审批与副作用回执接入 Mastra

**Depends on:** Task 3。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/enterprise/contracts.ts`, `server/src/db/schema/index.ts`, `server/drizzle/`; Create `server/src/enterprise/tools/service.ts`, `server/src/enterprise/tools/store.ts`, `server/src/db/schema/enterprise-tools.ts`, `server/src/mastra/tools.ts`, `server/tests/enterprise/mastra-tools.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: ToolPreparation/ToolExecution/PreparedTool/ApprovalResolution、已有授权工具连接；Task 3 governed model。
Produces: createToolService(deps):ToolService；createMastraTools(deps,context:GovernedModelContext):Promise<Record<string,GovernedMastraTool>>；真实 SDK tool 类型来自 Task 1；approval 状态持久化，operation ID 在重试保持稳定。

- [ ] **Step 1 — RED:** duplicate_execute_has_one_effect_and_same_receipt；revocation_after_approval_denies_execute；timeout_unknown_requires_reconciliation；native_hitl_resume_after_restart_keeps_operation；argument_digest_conflict_is_409。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 实现旧 T05 已批准治理要求：准备、bounded canonical arguments、授权重查、审批、执行权争抢和回执。Mastra tool execute 只能走 ToolService，不直接调用 connector。unknown 必须对账，不标安全重试。审批利用原生 HITL/workflow 快照，但审批主体/decision/reference 属产品存储；恢复必须验证当前 scope 与 operation digest。仅合成副作用 fixture，不执行真实账号操作。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-tools.integration.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-05, AC-06, AC-07；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 5: Mastra 装配与业务 Run dispatcher

**Depends on:** Task 4。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/copilot.ts`, `server/src/enterprise/runs/outbox.ts`, `server/src/index.ts`; Create `server/src/mastra/runtime.ts`, `server/src/mastra/dispatcher.ts`, `server/tests/enterprise/mastra-runtime.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: Tasks 2–4 bindings/model/tools；createRunOutbox claim/ack、DB-time lease。
Produces: HostedMastraRuntime.run(scope:PlatformScope,input:HostedRunInput,signal:AbortSignal):AsyncIterable<HostedRuntimeEvent>；HostedRunInput={conversationId,runId,botId,clientMessageKey}; cancel(scope,runId):Promise<void>；close():Promise<void>；createHostedMastraRuntime(deps):HostedMastraRuntime；HostedRuntimeEvent 保留 AG-UI 事件及业务 run/attempt/source ID。

- [ ] **Step 1 — RED:** trusted_bot_run_emits_persisted_message；two_dispatchers_one_active_attempt；stale_attempt_cannot_finish；run_finished_turn_is_not_business_success；untrusted_state_tools_and_forwarded_scope_discarded。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 建立 focused server/src/mastra assembly，注册授权 Bot/model/tools/memory；默认托管执行采用 Mastra，remote roster 保留兼容类型。business Run 与 framework execution ID 单独存储；worker lifecycle 启动/关闭 managed，有 fencing 的 outbox claim/ack。Hono middleware 顺序必须身份优先，Mastra native endpoints 不可绕过产品授权。移除默认 Go invocation/callback 路由派发，保留 Go 源码。Copilot refactor 仅接 runtime seam，旧 Intelligence 全删由 Task 13 控制。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-runtime.integration.test.ts server/tests/mastra-roster.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-02, AC-05, AC-07, AC-08；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 6: 持久 UI 事件与自有 Runtime 协议

**Depends on:** Task 5。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/copilot.ts`, `server/src/channels/thread-routes.ts`, `server/src/db/schema/index.ts`, `server/drizzle/`; Create `server/src/enterprise/events/service.ts`, `server/src/enterprise/events/store.ts`, `server/src/db/schema/enterprise-events.ts`, `server/src/mastra/agui.ts`, `server/src/mastra/routes.ts`, `server/tests/enterprise/mastra-agui.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: HostedMastraRuntime、EventService 合同、MastraConversationRepository。
Produces: createMastraRoutes(deps):Hono；createEventService(deps):EventService；MastraAgentBridge.forRequest(scope:PlatformScope,conversationId:string):Promise<AbstractAgent>；实际客户端支持的 discovery/run/stop/history 与 product list/replay 路由冻结为 SDK 黄金样本。

- [ ] **Step 1 — RED:** real_sdk_discovery_run_stop_history_nonempty；replay_to_live_no_gap；same_source_id_same_digest_idempotent_conflict_409；revoke_closes_live_stream；canonical_parts_tool_activity_attachment_replay。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 通过已维护 @ag-ui/mastra 本地桥运行；将 raw Mastra bridge TEXT_MESSAGE_CHUNK 转为产品 canonical TEXT_MESSAGE_CONTENT 并通过锁定客户端端到端测试；必要时用自有 AgentRunner 管理跨请求订阅，仅实现产品 projection 不复制模型循环。先 append commit 再 emit，单调 seq/source event 去重，ACK/replay 无间隙；终态由平台确认。禁止用框架 cache/trace 冒充永久历史。锁定 CopilotKit 实际客户端调用 protocol，旧 private runner lock 接缝改产品 Run lease。thread list/history 用自有 API，移除其 Intelligence 读取。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-agui.integration.test.ts server/tests/enterprise/sdk-compatibility.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-02, AC-03, AC-04, AC-05；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 7: 聊天 UI 自有线程与历史恢复

**Depends on:** Task 6。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:** Modify `app/src/lib/copilot/thread-messages.ts`, `app/src/lib/copilot/join-thread.ts`, `app/src/lib/copilot/bot-thread.ts`, `app/src/components/channels/`; Create `app/src/lib/copilot/platform-threads.ts`, `app/tests/mastra-chat-history.test.tsx`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: Task 6 product thread/history/replay 路由；现有 React/AGUI UI。
Produces: createPlatformThreadClient(fetcher):PlatformThreadClient；list({cursor}),history({threadId,before}),join({threadId,lastSeq})；返回 schema 来自 Task 6，不重复 DTO。

- [ ] **Step 1 — RED:** nonempty_paginated_list_and_parts_hydration；account_switch_clears_private_history；reconnect_no_duplicate_tools；deleted_bot_authorized_history_readable；attachments_and_generated_ui_preserved。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 替换 Rich Threads/useThreads Intelligence 驱动数据路径，保持已有组件的文本/tool/activity/附件展示；列表分页与历史 hydration 来自产品 API，threadId 服务端签发。账号/tenant 切换关闭订阅并清除 cache；游标与已消费事件保持一致。频道现有功能保留，不重设计 UI。
- [ ] **Step 4 — GREEN/self-review:** `bun test app/tests/mastra-chat-history.test.tsx app/tests/composer-attachments-ui.test.tsx`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-03, AC-04, AC-05；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 8: 审批取消与受治理恢复

**Depends on:** Task 6, Task 7。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/mastra/runtime.ts`, `server/src/mastra/routes.ts`, `server/src/enterprise/runs/store.ts`; Create `server/src/mastra/recovery.ts`, `server/tests/enterprise/mastra-recovery.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: Tasks 4–6 operation receipts/native snapshots/events；RunService。
Produces: createMastraRecoveryService(deps):RecoveryService；resume(scope:PlatformScope,input:ResumeInput):Promise<RunDTO>；cancel 授权 API 复用 RunService，framework state 使用持久引用不建立自有 loop checkpoint。

- [ ] **Step 1 — RED:** restart_native_pause_resume_with_one_side_effect；cancel_vs_finish_is_fenced；unknown_receipt_blocks_resume；incompatible_bot_snapshot_refused；persistent_event_reconnect_two_instances。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 验证 framework native persistence 跨真实子进程重启；通过 business fencing/审批/current auth 明确恢复。自动 crash recovery 保持关闭直到幂等/对账/双实例故障用例全部通过；Durable beta 是否可用按 Task 1 API 与 Task 6 bridge 实测做 Ruling，普通显式恢复满足产品协议。没有安全路径则明确 blocked，禁止整 Run 重试来掩盖 unknown。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-recovery.integration.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-04, AC-06, AC-07；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 9: 后台频道、定时任务与 handoff

**Depends on:** Task 8。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/routines/runner.ts`, `server/src/agents/handoff-runner.ts`, `server/src/channels/routes.ts`, `server/src/channels/group.ts`; Create `server/src/mastra/headless.ts`, `server/tests/enterprise/mastra-headless.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: HostedMastraRuntime、RunService、既有 scheduler delegation/频道身份。
Produces: runHostedHeadless(scope:PlatformScope,input:HeadlessTurnInput,signal:AbortSignal):Promise<HeadlessTurnResult>；原有 DTO 复用 enterprise/contracts。

- [ ] **Step 1 — RED:** scheduler_and_browser_duplicate_share_admission；delegation_revocation_refused；group_handoff_all_model_calls_governed；no_browser_no_intelligence_complete_run。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 全部入口用同一 admission/runtime/model/tool/event 路径；任务执行实时检查委托主体与频道 membership；handoff 保持 Bot 版本与 Run budget 继承，后台任务设独立 Run/ceiling；不继续调用 Intelligence thread lock/history。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-headless.integration.test.ts server/tests/learning-handoff.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-05, AC-08；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 10: Memory 来源治理与删除传播

**Depends on:** Task 9。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/memory/store.ts`, `server/src/memory/routes.ts`, `server/src/mastra/conversations.ts`, `server/src/db/schema/index.ts`, `server/drizzle/`; Create `server/src/mastra/memory.ts`, `server/src/mastra/deletion.ts`, `server/tests/enterprise/mastra-memory.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: Task 2 tenant store、现有个人 memory source/tombstone；governed model。
Produces: MastraMemoryService.forConversation(scope,conversationId):Promise<GovernedMemory>；deleteSource(scope,sourceId):Promise<DeletionReceipt>；deleteConversation(scope,conversationId):Promise<DeletionReceipt>；GovernedMemory 使用 Task 1 native Memory。

- [ ] **Step 1 — RED:** thread_default_and_explicit_authorized_recall；disabled_source_never_reappears；partial_delete_retry_not_false_success；revocation_removes_derived_memory_and_projection；observer_has_tracked_run_budget。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** 框架消息/上下文采用 Mastra Memory；现有个人 memory 作为用户管理事实/来源治理保留，注入适配不双写 framework 消息。删除作业清消息/working/semantic/observational 派生数据及检索/event 投影，逐项持久状态；来源撤权同步阻断召回，失败不回退旧 prompt。native Observer/Reflector 只能使用 Task 3 governed route；未证明后台预算的 native 功能默认不启用。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-memory.integration.test.ts server/tests/memory-runtime.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-05, AC-09；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 11: 学习工作流、Evals 与技能发布

**Depends on:** Task 10。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify `server/src/learning/runtime.ts`, `server/src/learning/remote.ts`, `server/src/learning/routes.ts`, `server/src/learning/settings.ts`, `server/src/db/schema/index.ts`, `server/drizzle/`; Create `server/src/mastra/learning.ts`, `server/src/enterprise/learning/service.ts`, `server/src/db/schema/enterprise-learning.ts`, `server/tests/enterprise/mastra-learning.integration.test.ts`。目录条目仅拥有本任务必要增量，禁止覆盖用户已有内容。

**Interfaces:** Consumes: MemorySourceReference、LearningJobDTO、SkillCandidateDTO、SkillVersionDTO，Task 3 模型与 Task 10 sources。
Produces: createLearningService(deps):LearningService；createMastraLearningWorkflow(deps):GovernedLearningWorkflow；published SkillSnapshot 锁定于 Run，保留 acquire/status/inspect 兼容语义但 inspector 来源自有。

- [ ] **Step 1 — RED:** disabled_learning_collects_nothing；eval_candidate_never_autopublishes；approve_requires_authorized_current_sources；revision_immutable_and_run_pinned；failed_job_retry_dedupes_and_budgeted。
- [ ] **Step 2 — 确认 RED:** 执行下述针对性命令，保存失败断言和源码 hash；环境错误先定位，不能作为产品 RED。
- [ ] **Step 3 — 实现:** native Workflow 分析授权数据，Evals 用于质量检查，OpenBot 保存候选/审核/不可变发布；默认不自动发布。替代 SkillRegistry/Intelligence inspector 的服务依赖，保留既有技能加载工具名的兼容行为。设置关闭不得迁移重置，后台 model/eval 建独立 Run。开发 Studio 仅受管理权限可达，普通页面用自有 status。
- [ ] **Step 4 — GREEN/self-review:** `bun test server/tests/enterprise/mastra-learning.integration.test.ts server/tests/learning-runtime.test.ts server/tests/learning-routes.test.ts server/tests/learning-mastra.test.ts`；预期 exit 0，所列验收实际执行，没有 skip 代替通过。运行 owned code Biome；受影响 typecheck。
- [ ] **Step 5 — 未提交检查点与独立门禁:** 完整 before/after/package/hash，report 写 tests/commands/results/concerns；validator 补验，reviewer 独立 spec compliance + code quality；两门 PASS 后 ledger verified。

**Acceptance / failure handling:** AC-06, AC-09；覆盖规格对应职责。失败按共同执行约定修复与复审，前置未 verified 时下游 pending。

### Task 12: 授权历史导入与原子单写切换

**Depends on:** Task 11。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify server/src/enterprise/conversations/store.ts, server/src/mastra/conversations.ts, server/src/db/schema/index.ts, server/drizzle/; Create server/src/mastra/import.ts, server/tests/enterprise/mastra-import.integration.test.ts。

**Interfaces:** Consumes MastraConversationRepository, authorized scope、单写 backend、Mastra Memory store。Produces previewConversationImport(scope, conversationId, source): Promise<ImportReceipt>、commitConversationImport(scope, receiptId): Promise<ImportReceipt>、cutoverConversation(scope, {conversationId, receiptId, expectedBackend:"legacy"}): Promise<ImportReceipt>。ImportReceipt freezes version/source digest/message+parts+attachment+skill counts、status、createdAt；cutover is separate admin/user authorization and CAS transaction.

- [ ] **Step 1 — RED:** same_export_import_twice_is_idempotent_and_digest_checked; incomplete_parts_or_attachment_reference_rejects_preview; active_run_rejects_cutover; changed_digest_after_preview_rejects_commit; concurrent_cutover_and_mastra_write_have_one_winner; legacy_write_after_cutover_is_rejected。最后三个断言使用两个 DB connections 同步竞争并验证只有一个 active writer。
- [ ] **Step 2 — 确认 RED:** 用已存在 PostgreSQL TEST_DATABASE_URL fixture，production 未改时保存每个预期失败与数据库清理证据。
- [ ] **Step 3 — 实现:** Preview 只读旧来源并计算稳定摘要，不导出真实数据。Commit 验证受审 receipt digest 和所有引用存在后将消息/parts/附件/技能摘要写入 Mastra storage；切换事务重查 current ACL、receipt source digest、活动 Run=0、live Mastra conversation writes=0；先写入隔离 staging resource，再由 cutover CAS 原子提升为 active resource，staging writes 不计为 active conversation writes；并以 conversation backend 版本 CAS 转 Mastra 单写。两个并发写/切换只能一个获准；拒绝时保留 legacy backend。切换后旧 append 一律拒绝。禁止“先切换再补历史”及隐式回退。
- [ ] **Step 4 — GREEN:** bun test server/tests/enterprise/mastra-import.integration.test.ts server/tests/enterprise/conversations.integration.test.ts；预期两个进程同时切换仅一个成功，摘要/引用计数一致，其余冲突安全失败。Biome 与受影响 server typecheck 单独记录。
- [ ] **Step 5 — 检查点:** task-12-after 内容/hash 增量 package，backend validator 与 reviewer 独立门禁。

**Acceptance:** AC-02、AC-03、AC-05、AC-10；来源不可得或数据不全时只允许显式重导出/阻塞，不声称成功。

### Task 13: 学习管理 UI 迁移到自有 API

**Depends on:** Task 11；Task 12 数据导入不阻塞管理 UI。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:** Modify app/src/routes/_authed/admin/learning.tsx, app/src/lib/learning/queries.ts; Create app/tests/mastra-learning-admin.test.tsx。仅 app 层，不改 server API。

**Interfaces:** Consumes Task 11 自有 learning routes：settings、overview、candidate list/review/publish 与 job status；复用现有 query/auth/audit contract。Produces user/admin UI query/mutation hooks 与 rendered states，不重新声明服务 DTO。

- [ ] **Step 1 — RED:** admin_overview_uses_self_hosted_status_endpoint; disabled_learning_state_survives_reload; eval_candidate_requires_explicit_review_before_publish; non_admin_and_failed_jobs_show_safe_states。
- [ ] **Step 2 — 确认 RED:** bun test app/tests/mastra-learning-admin.test.tsx，预期缺少产品 API/现有 Intelligence 调用未满足新断言。
- [ ] **Step 3 — 实现:** 让管理员页只读写自有 endpoint；保留 requireAdmin、同源及审计；页面展示 Mastra job/Evals 结果但不能直接访问不受保护的 Studio；候选仍需显式审核，关闭状态不重置。普通用户已有设置界面沿用。
- [ ] **Step 4 — GREEN:** bun test app/tests/mastra-learning-admin.test.tsx app/tests/learning-admin.test.tsx 且 bun run --filter app typecheck；每条命令独立保存 exit/output/hash。
- [ ] **Step 5 — 检查点:** app 专属增量 package、frontend validator 和 reviewer；通过后 Task 13 verified。

**Acceptance:** AC-09；frontend validator 必须对实际屏幕状态/键盘可达性作独立结果。

### Task 14: 服务端默认装配与租户存储 fail-closed 部署

**Depends on:** Tasks 12、13。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:** Modify server/src/config.ts, server/src/index.ts, server/src/copilot.ts, server/src/intelligence-client.ts, .env.example, docker-compose.yml, Dockerfile, charts/openbot/values.yaml, charts/openbot/templates/configmap.yaml, charts/openbot/templates/server/deployment.yaml, scripts/generate-app-config.ts, server/src/computer/deployment-routes.ts; Create server/tests/enterprise/mastra-bootstrap.test.ts, tests/mastra-deployment.test.ts。

**Interfaces:** Consumes Task 2 TenantStorageRegistry.provisionTenant/forTenant restricted schema+role and migration readiness; startup fails if registry/restricted creds absent or schema version stale. Mastra worker lifecycle and Task 6 product health API. Produces GET /api/runtime/health with status/capabilities/version only; no credentials. New tenant provisioning receives trusted control-plane tenant ID and creates schema/least-privilege credentials through existing secret manager contract; it never falls back to app admin DSN.

- [ ] **Step 1 — RED:** fresh_boot_without_intelligence_or_mastra_saas; tenant_storage_registry_missing_fails_closed; stale_tenant_schema_disables_agent_admission; two_tenant_restricted_roles_cannot_cross_read; shutdown_closes_mastra_workers; runtime_health_route_not_parsed_as_bot_id。
- [ ] **Step 2 — 确认 RED:** 分别跑服务配置单测和部署模板合成检查，记录缺失行为；每租户角色只在 TEST_DATABASE_URL 隔离库创建及清理。
- [ ] **Step 3 — 实现:** 移除正常运行入口 CopilotKit Intelligence client/history/runner-lock/auth/license 和 env 要求；替换默认 agent dispatch 为 Mastra。迁移读取仅显式离线命令开放。部署管理新增 tenant storage registry schema/role 配置、provision/migrate/credential rotate 流程，secret 引用来自可信 secret manager；不允许通过普通 env 向 app 注入跨租户管理员 DSN。未知/缺失/过期配置拒绝服务。健康路径加入部署 routes 保留名单。允许保留仍离线使用的 CopilotKit OSS 协议依赖，但扫描所有 SDK/transitive Intelligence license 包的加载路径并证明启动不触达其 SaaS。
- [ ] **Step 4 — GREEN:** 分别运行 bun test server/tests/enterprise/mastra-bootstrap.test.ts tests/mastra-deployment.test.ts、bun run --filter server typecheck、bunx biome check <owned-ts-files>；任一非零即停止后续命令并修复，不用分号吞错。Helm helm template（若已安装）亦单独记结果。真实双租户 roles 用 guarded TEST_DATABASE_URL。
- [ ] **Step 5 — 检查点:** 保存部署模板/代码完整清单与哈希，backend validator + reviewer 评 fail closed/restricted role实际权限。

**Acceptance:** AC-01、AC-02、AC-05、AC-08、AC-11；无 SaaS 账户可启动；无 tenant registry 不能执行 agent；OpenBot 登录/模型/工具账号继续正常。

### Task 15: Tauri 安装端租户存储配置

**Depends on:** Task 14。**Roles:** implementer → backend_validator → reviewer。

**Files / ownership:** Modify desktop/src-tauri/src/install.rs, desktop/src-tauri/src/desktop_connection.rs, desktop/src-tauri/src/lib.rs; relevant Rust tests only.

**Interfaces:** Consumes Task 14 stable /api/runtime/health/provision result and existing desktop organization connection store. Produces desktop setup status persistence; no tenant DB credential/token persisted in plaintext.

- [ ] **Step 1 — RED:** Rust tests setup_requires_authenticated_tenant_registry; restart_keeps_connection_reference_not_secret; missing_registry_reports_actionable_state.
- [ ] **Step 2 — 确认 RED:** cargo test --manifest-path desktop/src-tauri/Cargo.toml scoped names, save output.
- [ ] **Step 3 — 实现:** 保持 Rust change narrow：存受保护的 OpenBot connection/tenant registry reference，健康检查和 provision 失败状态；不存 Postgres admin/tenant password。
- [ ] **Step 4 — GREEN:** scoped cargo test then cargo check --manifest-path desktop/src-tauri/Cargo.toml，两个命令独立保存结果。
- [ ] **Step 5 — 检查点:** Rust files package/hash，backend validator 检查秘密存储边界，reviewer 独立门禁。

**Acceptance:** AC-01、AC-05；无桌面真实组织账户或秘密数据。

### Task 16: 桌面初始化体验接入 Mastra 状态

**Depends on:** Task 15。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:** Modify desktop/src/Welcome.tsx, desktop/src/App.tsx; Create desktop/src/MastraSetup.test.tsx。

**Interfaces:** Consumes Task 14 health/provision API 与 Task 15 typed desktop connection status；Produces view states loading/ready/registry missing/schema stale/auth required/retry; 不暴露 store credentials。

- [ ] **Step 1 — RED:** welcome_boots_without_intelligence_fields; tenant_provision_status_has_safe_retry; health_response_never_renders_credentials; keyboard_can_complete_setup。
- [ ] **Step 2 — 确认 RED:** bun test desktop/src/MastraSetup.test.tsx desktop/src/App.test.tsx。
- [ ] **Step 3 — 实现:** 显示组织连接、自托管 Mastra readiness、可恢复配置错误；保持模型与工具账号独立接入，不新增 SaaS 登录卡。
- [ ] **Step 4 — GREEN:** bun test desktop/src/MastraSetup.test.tsx desktop/src/App.test.tsx then bun run --filter openbot-desktop typecheck，单独检查结果。
- [ ] **Step 5 — 检查点:** UI before/after hash 与 render/e2e 证据，frontend validator 审视觉状态与键盘路径，reviewer 独立门禁。

**Acceptance:** AC-01、AC-11；frontend validator 是必需 gate。

### Task 17: 完整交付验收、独立 Review 与 OCR

**Depends on:** Task 16。**Roles:** 主控编排验收；independent backend_validator、frontend_validator、reviewer（最强可用模型）。

**Files / ownership:** Create server/tests/enterprise/mastra-acceptance.integration.test.ts, `.archive/runs/2026-10-10-mastra-intelligence-migration/verification/report.md`；若已知 probe readonly error仍是交付阻塞，以机械修改仅修 server/scripts/enterprise-runtime-probe.ts 正确可变类型，并将其列为此 Task owned file。

**Interfaces:** Consumes 所有 verified checkpoints 与原 BASE；Produces 持久 acceptance report、ignored content mirror manifest 与最终 OCR report，不改产品实现（除 probe 类型修正的 TDD 子任务）。

- [ ] **Step 1 — RED:** synthetic_full_chat_restart_history_approval_cancel_learning_flow; two_tenants_and_revocation_end_to_end; network_guard_no_intelligence; no_skipped_required_assertions。
- [ ] **Step 2 — 实现验收夹具:** 只使用隔离 synthetic PostgreSQL、mock model、test browser、host-only network guard；修正 probe TypeScript 错误时先对确切只读数组约束写行为测试并证实 RED。
- [ ] **Step 3 — GREEN:** 逐条单独执行 bun test server/tests/enterprise/mastra-acceptance.integration.test.ts、bun run typecheck、bun run lint、bun run build、browser suite；每一命令成功后才运行下一条，保存每个 exit/result 与同一 after-hash。非必要 provider/浏览器环境若不可用，报告受限不将 skip 计通过。
- [ ] **Step 4 — Independent Review:** 主控 dispatch backend_validator、frontend_validator（按代码面）、最终 reviewer；独立 spec/code quality PASS 后做 OCR。
- [ ] **Step 5 — OCR 覆盖 ignored files:** 由 .gitignore 已忽略 docs/、.superpowers/ 和部分 enterprise source，仅 OCR workspace 不会保证读到 ignored 文件。生成精确 delivery allowlist；将每个 ignored delivery 文件复制到临时目录 codex-ocr-review-mirror-<run-id>/，采用非隐藏平铺文件名并保留扩展名，启动 OCR 前逐一路径执行 git check-ignore 并断言未忽略；manifest 写 source path/mirror path/source hash/mirror hash，并逐一断言一致。OCR workspace review 生成输出到 SDD 报告目录；从 OCR 实际结果抽取 reviewed mirror 文件名，映射回 source path，并与 ignored delivery allowlist 一一比对；缺任一文件即 coverage incomplete。review完成后仅删除自身 codex-ocr-review-mirror 临时副本，保留源与报告。另以 --from <原BASE> --to <真实HEAD> 审查所有已提交范围。Command: ocr review --audience agent --background-file docs/specs/superpowers/2026-10-10-mastra-intelligence-migration-design.md --output .superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/ocr-workspace.md。OCR 不完整/exit非0/skip files不能 PASS。有效 C/H/M 问题进入新编号 writing-plans+SDD修复波次，再验收、re-review和OCR；不由controller修源码。
- [ ] **Step 6 — Preserve & finish:** 完整验证/review/OCR/ruling 和快照哈希报告进入持久路径；工作区有未提交交付不得删除或 archive 唯一副本。

**Acceptance:** AC-01–AC-12 每项链接端到端证据；真实限制和遗留项逐一列出。没有有效 critical/high/medium OCR finding、hash/coverage完整，才报告完成。

## 自查与执行前预检

- [x] 用户批准来源、旧验收替代和检查点复用已明确；无虚构 Issue。
- [x] 所有规格职责映射到 Task；Review Focus 五类有明确测试归属。
- [x] binding/model/runtime/types 的 producer/consumer 名称一致；SDK 签名由兼容任务实测后冻结。
- [x] DAG 17 个唯一节点，依赖存在且拓扑通过；12/13 并行就绪，14 依赖 12/13 verified，后续 15→16→17。
- [x] 共享 schema/contract/lock/copilot 写权限串行，跨端任务按专业子 Brief 分派。
- [x] 无自动 commit；每任务新增 ignored/untracked 交付在 checkpoint 包内；原 worktree 改动不回退。
- [x] 新计划保存并展示后沿既有端到端授权执行；用户 AGENTS.md §3 优先于 writing-plans 的再次确认建议。

## 最终独立 Review 与 OCR

SDD 全交付 review 覆盖原 BASE→HEAD 与未提交/ignored 新交付，收集 deferred/Ruling。OCR 按 open-code-review Skill 由主控执行 `--audience agent`、业务背景、每轮独立报告：workspace 覆盖未提交全范围，另覆盖真实 BASE→HEAD。记录 exit/warnings/coverage/failed files；不支持或凭据失败不能当 PASS。有效 critical/high/medium 生成 writing-plans+SDD 修复计划，再验收和 OCR；完成报告保留全部证据后使用 finishing-a-development-branch，禁止删未提交交付的唯一副本。

### M02 R1B / R1D / R1C repair gate update — verified

R1B was independently verified. The original R1C M02-R8 audit kept the requirement open with three evidence gaps. R1D added the read-only legacy repository boundary and direct real restricted-store/reopen, identity, dispatch, revocation, and attachment-denial evidence. Its independent validator passed all four serial suites. The R1D reviewer identified M02-R1D-01 (medium): a foreign actor using the owner's attachment on a Mastra conversation the foreign actor owns lacked a direct denial/no-side-effect test.

The numbered follow-up plan `.archive/runs/legacy-plans/superpowers-briefs/2026-10-10-m02-r1d-fix1-foreign-mastra-attachment.md` added that exact foreign-owned-thread case. FIX1 independent validation passed the 34-test conversations suite, targeted Biome, and diff-check; independent review returned Spec Compliance PASS and Code Quality PASS, closing M02-R1D-01. Final R1C re-audit used nine hash-frozen files (snapshot SHA-256 `49d04dc5d98fbebe6c927551e067d8b825e3aff6dfdd1990256d010a5cc0d7da`): all four serial database suites, targeted Biome, and `git diff --check` passed; independent final review returned Spec/Code PASS with no critical/high/medium finding. Reports and hashes are under `.superpowers/sdd/2026-10-10-m02-r1c-final-acceptance-reaudit/`.

Ruling `M02-R1C-FINAL-P01` reconciles the journal note: 0060 was the pre-R1B baseline; R1B introduced 0061/0062; the original pre-R1D R1C validator had already observed journal 0062 without running migrations, and the final audit likewise ran no migration. The final validator's missing pre-run journal capture is disclosed, and prior snapshot evidence attributes 0062 to the existing R1B state. M02-R8, R1C, R1D, and root Task 2 are verified. Task 12 production cutover CAS and in-flight transition behavior remain explicitly assigned to Task 12. The unrelated `server/scripts/enterprise-runtime-probe.ts:63` typecheck diagnostic remains assigned to Task 17 and is not claimed as fixed here. Updated cumulative DAG is `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/m02-r1-dag.json`.
