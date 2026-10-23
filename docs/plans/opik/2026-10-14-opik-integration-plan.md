# Opik Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本仓库默认沿 DAG 串行派发专业实现者，由主控统一派发验证与独立 Review；子 Agent 不继续派发。

**Goal:** 在工作台交付 Opik 自托管追踪、脱敏授权查看和可比较的版本评测闭环，并为企业租户预留可信范围接口。

**Architecture:** 执行数据使用受治理的 OpenTelemetry 路径，Opik 保存脱敏后的追踪与评测。OpenBot 持有权威归属、数据定位和任务状态，所有读取及评测操作通过 OpenBot 授权。工作台 adapter 首期落地，企业 adapter 等租户 Spec 批准后实现；不创建假租户。

**Tech Stack:** Bun、TypeScript、Hono、Drizzle/PostgreSQL、现有 WorkQueue、OpenTelemetry JS/OTLP、Opik REST/TypeScript SDK、React、TanStack Router/Query、现有 e2e tester-army。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`，2026-10-14 用户书面批准，SHA256 `6ed5e9ce9ae427acc904ed31a0e402d50d6b10c15f932bd0d64230e93bb56c97`。

## Global Constraints

- “企业租户正在设计，本次预留接入位置，不实现或冻结企业租户模型。”
- “Opik 仅保存脱敏后的业务内容，管理员也不通过 Opik 获得额外原文访问权。”
- “将来企业入口必须提供已认证且已授权的 scope；缺失、未知或未配置的企业 scope 拒绝访问，不能回退到工作台范围。”
- “Opik workspace/project 是存储组织方式，不是访问权限证据。”
- “首期默认运行追踪保留 7 天、评测集与实验保留 30 天”。保留期对应实际存储与删除任务，不只是页面隐藏。
- “token 来自 provider 实际报告；缺失为 unavailable，不以 0 代替。”Opik 成本不能替代 Credit Ledger/Settlement。
- “首期调用工具使用 fixture 或测试环境”；Judge 不自动使用 Opik 默认模型，必须通过适用的准入、预算与结算。
- “HTTP headers 发出不表示 run 完成”；重试、取消、未知终态、工具提议与实际执行分别记录。
- 首期内置与 LangGraph 为 detailed 目标；其他经过 OpenBot 的远程路径为 basic，不修改其内部业务逻辑。未通过运行时验收不得声明 detailed。
- 不更改 `bifrost/`、企业表、企业运行信封、生产原文访问权限或现有会话事实源。Bifrost 并行设计尚未批准，不据其讨论替换当前计费路径。
- 只执行锁定兼容版本的可选 Opik 装配；关闭 Opik 不启动采集任务，不改变既有 tracing 的关闭语义。
- 使用当前库版本与现有测试预加载，不升级 CopilotKit、AI SDK、LangGraph 来迁就接入。根包声明 Bun 1.4.3；计划工作区实测 Bun 1.4.2，后续交付需在仓库声明版本复核。
- 本轮只有计划授权。提交策略为未提交检查点；没有本地提交、推送、合并或发布授权。禁止共享 stash、拷贝生产 .env 或打印凭证。

## Review Focus

1. **同一资源 ID 出现在不同 scope**：游标、缓存、详情、导出和任务不得串用。Task 2/6/8/9/11 的对抗性测试覆盖。
2. **权限在分页、缓存命中或任务排队后撤销**：旧访问资格不能继续读取或执行。Task 6/8/9/11 覆盖。
3. **流结束或 lease 过期但外部调用结果未知**：不能标成成功，不能自动重复调用/扣费。Task 4/9 覆盖。
4. **正文、错误、附件 URL 或 SDK 自动追踪携带秘密**：不应到达任何 Opik 写入、Judge 记录或导出。Task 1/3/5/8/9/11 覆盖。
5. **Opik 部分成功、慢响应或断开**：业务运行继续，观测/删除/同步状态如实显示，不能跨项目重试。Task 1/3/6/8/9/11 覆盖。

---

## 工作区、事实源与执行规则

- 执行工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration`。
- Orca ID：`d6edf033-748a-4549-ae5a-e9efd34cef91::/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration`。
- 分支：`1123786563/opik-integration`；原始 BASE：`7bfc18f28152a3fb2a3fa014ae33a61025246f1b`。
- 设计已从主工作区显式复制并逐字及哈希校验；见 `docs/plans/evidence/2026-10-14-opik/workspace.json`。
- 事实源：批准 Spec → `docs/adr/0001-conservative-input-bound.md` → `CONTEXT.md` → Git → 本计划/DAG/Ledger。最新主工作区领域快照保存在 `evidence/2026-10-14-opik/source-context.md`；Bifrost 在设计中的快照仅作兼容参考，不是批准 Spec。
- `AGENTS.md` 引用的 `docs/agents/domain.md`、`docs/agents/issue-tracker.md` 在 BASE 不存在；使用根 `CONTEXT.md` 和用户提供的规则。没有目标 Issue，`source_issues=[]`，不声称读取过 Issue 树，也不自动创建 Issue。
- 基线：`bun install --frozen-lockfile` 成功；6 个相关文件 42 pass / 0 fail，日志在 `evidence/2026-10-14-opik/baseline-tests.log`。这是针对性基线，不等于全仓测试通过。
- 机器可恢复 DAG：`.archive/runs/legacy-plans/dags/2026-10-14-opik-integration-dag.json`；执行账本：`.archive/runs/legacy-plans/ledgers/2026-10-14-opik-integration-ledger.md`。
- 每个 Task 的本节、Global Constraints、Interfaces 和验收组成 Task Brief。派发时只提供该 Brief、必要事实源、前置接口、文件所有权和报告路径；`fork_turns=none`，实现者知道自己不是唯一工作者，不得撤销他人改动。
- 共享文件只有当前 Task 可以写。前置任务 verified 且已审查的检查点在同一工作区后，主控才能放行下游。就绪节点仍默认串行。
- 每 Task 前后记录 HEAD、staged/unstaged diff、任务新增文件完整内容及哈希，输出增量 Review Package；报告与验证绑定检查点哈希。空 BASE..HEAD 不能代替未提交审查。
- 实现者完成 RED → GREEN → REFACTOR 和自查；验证者只写报告/测试产物；独立 reviewer 分别判定 Spec compliance 与 code quality。每 Task 报告写入本计划的 `evidence/2026-10-14-opik/task-NN/`。

## 文件组织与所有权预检

| 位置 | 职责 | 写入 Task |
| --- | --- | --- |
| `docker/compose/opik.yml`、`docker/opik/`、`server/scripts/opik-contract.ts` | 上游部署、契约与版本清单 | 1；11 追加保留/访问验证 |
| `server/src/ai-observability/{scope,bindings,opik-port,opik-http}.ts` | 授权、归属、定位与上游 adapter | 2；6 查询；8/9 评测；11 删除 |
| `server/src/db/schema/ai-observability.ts` | 安全引用及状态，无正文副本 | 2；8；9 |
| `shared/ai-observability.ts`、`shared/ai-trace.ts` | 安全投影与受治理 OTel | 3；5 |
| `server/src/ai-observability/run-agent.ts` | run订阅、终结、取消和clone | 4 |
| `server/src/ai-observability/{model,langgraph,retrieval}.ts` | 默认运行时步骤 adapter | 5 |
| `server/src/ai-observability/{routes,reader}.ts` | 创建者受控接口 | 6；8/9 评测路由；11 导出 |
| `server/src/ai-observability/evaluation/` | 样本版本、执行、评分与对比 | 8 数据集；9 执行 |
| `server/src/ai-observability/{admin-routes,lifecycle,exports,console-auth}.ts` | 汇总、健康、删除、导出与控制台资格 | 11 |
| `app/src/lib/ai-observability/`、`app/src/components/ai-observability/` | 页面与状态 | 7；10；12 |
| `server/src/index.ts`、`server/src/copilot.ts`、`server/src/config.ts` | 小范围装配，完整逻辑在独立模块 | 1/3/4/5/6/8/9/11 串行 |
| `app/src/components/bot-profile/manage.tsx`、locales、`routeTree.gen.ts` | 入口与生成路由 | 7/10/12 串行 |
| `server/drizzle/` 与 journal/snapshots | 迁移一致性 | 2:0087；8:0088；9:0089 |

BASE 最新 journal idx=86。若执行前分支集成了新迁移，主控先更新计划中的三个编号与所有引用，再派发；不得覆盖其他迁移或用错误快照制造通过。

## 共享接口合同

定义位置以各 Task 为准；下列类型名是跨任务约定，禁止实现者自行改名。Task 内部辅助类型不需要主控批准。

- `ObservationActor = { kind: "workbench"; actor: AgentActor } | { kind: "enterprise"; verifiedContext: unknown }`。首期 enterprise 分支拒绝；不解析 unknown，不新增 tenant 参数。
- `ObservationAction = "read" | "manage_dataset" | "execute_evaluation" | "export" | "admin"`。
- `ObservationTarget = { botId: string } | { admin: true }`。
- `AuthorizedScope` 是 scope 模块内部创建的不可伪造授权句柄，含不透明 `scopeKey`、动作与目标；序列化进任务的是范围引用，执行前重授权，不能反序列化出访问资格。
- `OpikLocator = { workspace: string; projectId: string; projectName: string }`；映射由权威 store 查询，不接受客户端 locator。
- `RunBinding = { id: string; scopeKey: string; botId: string; threadId: string; runId: string; attemptId: string; traceId: string; opikTraceId: string | null; capability: "basic" | "detailed" | "unavailable"; state: RunState; expiresAt: Date }`。
- `RunState = "running" | "completed" | "failed" | "canceled" | "interrupted" | "unknown"`；`RunSummary` 另含毫秒耗时、实际 token 或 null、配置版本和省略标记，无原始 actor、正文或凭证。
- `SafeObservation` 是脱敏模块创建的安全数据投影；`SafeBody = { value: unknown; mode: "redacted" | "metrics_only"; truncated: boolean; policyVersion: string }`。原始 unknown 数据不能直接传给 OpikPort。
- `RunFilter = { from?: string; to?: string; state?: RunState; cursor?: string; limit?: number }`，ISO 时间；默认 limit=25，1..100；游标绑定 scope、目标、筛选与顺序。
- `RunList = { items: RunSummary[]; nextCursor: string | null }`；`RunDetail = { run: RunSummary; steps: SafeObservation[]; availability: "ready" | "syncing" | "upstream_unavailable" }`。
- `DatasetVersionRef = { id: string; datasetId: string; scopeKey: string; botId: string; opikDatasetId: string; contentHash: string; policyVersion: string }`。一个不可变版本对应一个上游数据集快照，不依赖可变名称或上游默认版本。
- `EvaluationSnapshot` 含 Bot 非敏感配置、Prompt 指纹/版本、modelRef、参数、fixtureVersion、scorerVersion、datasetVersionId、policyVersion；必须提供可执行版本引用，缺失时拒绝提交。
- `EvaluationJobState = "queued" | "running" | "completed" | "failed" | "cancel_requested" | "canceled" | "needs_reconciliation" | "syncing"`。样本执行和评分分别有状态；具体 DTO 在 Task 9 的 `evaluation/contracts.ts` 扩展定义，Task 10/11/12 直接复用。
- 所有业务 Opik 写入必须经过 SafeObservation/SafeBody 投影；API/SDK/HTTP adapter 只接收安全类型，不开启未治理的自动追踪。

## Task 1: 验证可部署的 Opik 及完整契约

**Depends on:** 无。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A1/A4/A10/A11/A13 的上游前置证据。

**Files:** Create `docker/compose/opik.yml`, `docker/opik/collector.yaml`, `docker/opik/versions.json`, `server/scripts/opik-contract.ts`, `server/tests/opik-contract.test.ts`, `reference/opik.md`; Modify `.env.example`, `server/package.json`, `bun.lock`。不复制完整 Opik 源码，不修改默认 compose。

**Interfaces:** Consumes 当前 OTLP contract；Produces `VerifiedOpikContract` manifest：服务 tag/digest、SDK 精确版本、对应上游提交、实际 OTLP/查询/项目/数据集/实验/删除请求与响应 fixture、ID 映射、数据删除证据、支持的正文上限。所有后续 HTTP 序列化只由该 manifest 驱动。

- [ ] Step 1: 为契约脚本写失败测试：`expect(validateContract({deleteVerified:false}).ok).toBe(false)`；未显式传测试实例地址时 `expect(() => contractTarget({})).toThrow()`；秘密 canary 不出现在捕获 payload。
- [ ] Step 2: Run `bun test server/tests/opik-contract.test.ts`；Expected RED：contract 解析/安全请求未实现。
- [ ] Step 3: 选择执行时最新非预发布、官方声明匹配且通过实测的服务/SDK版本，精确锁定至 `versions.json` 与 lockfile。脚本 `runOpikContract(target: URL, evidenceDir: string): Promise<VerifiedOpikContract>` 用合成数据验证创建、OTLP写入、父子关系、thread关联、查询、版本化样本、实验写入及全部删除；失败退出非零，不以 skip 算通过。
- [ ] Step 4: 按选定上游 tag 的 compose/Helm 文件装配实际依赖；本地 UI loopback 端口默认 5174，Collector默认4319，可配置。内部依赖不对外发布；使用独立项目/volume。Collector入口要求内部生产者凭证，未认证请求在真实冒烟中必须401/403；header使用部署配置且不进入报告。Collector 路由 Agent span及最小父上下文，不把任意 HTTP正文/附件镜像到Opik；仅受支持、受认证的内部生产者可送入。
- [ ] Step 5: Run `bun test server/tests/opik-contract.test.ts`、`docker compose --project-directory . -f docker/compose/opik.yml config --quiet`，再按 `reference/opik.md` 启动专属合成实例并运行 `bun server/scripts/opik-contract.ts --target http://127.0.0.1:5174/api --evidence docs/plans/evidence/2026-10-14-opik/task-01/contract`；Expected GREEN：所有能力逐项 pass、版本清单非浮动、实际 canary 无泄露、删除后记录查不到。
- [ ] Step 6: 保存检查点、测试与真实契约证据并 Review。未验证删除、ID映射、受治理Judge或OTLP兼容时不放行；修adapter或报告阻塞，不能据此削掉批准需求。

## Task 2: 可信范围、权威归属与可恢复存储

**Depends on:** 1。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A5/A6/A12，A1/A11 的持久前提。

**Files:** Create `server/src/ai-observability/{scope,bindings,opik-port,opik-http,contracts}.ts`, `server/src/db/schema/ai-observability.ts`, `server/drizzle/0087_opik_observability.sql`, `server/drizzle/meta/0087_snapshot.json`, `server/tests/opik-scope.test.ts`, `server/tests/opik-bindings.integration.test.ts`, `server/tests/support/opik-fixtures.ts`, `server/scripts/opik-test-env.ts`; Modify `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `server/drizzle/meta/_journal.json`。

**Interfaces:** Produces `createObservationAuthorizer(deps).authorize(actor: ObservationActor, target: ObservationTarget, action: ObservationAction): Promise<AuthorizedScope>`；`createRunBindingStore(db)` 的 `begin(input: RunBindingInput): Promise<RunBinding>`、`finish(id: string, result: RunResult): Promise<void>`、`get(scope: AuthorizedScope, id: string): Promise<RunBinding|null>`、`list(scope: AuthorizedScope, filter: RunFilter): Promise<RunList>`、`locator(scope: AuthorizedScope, botId: string): Promise<OpikLocator>`。Task 2在contracts定义 RunBindingInput/RunResult：可信scope/Bot/run/attempt及安全汇总，禁止正文/凭证。Produces `OpikPort`、`createOpikHttpPort(contract, connection): OpikPort`，首期方法 `readTrace(locator, traceId): Promise<SafeObservation[]>`、`deleteRecords(locator, refs): Promise<void>`；Task8按manifest扩展评测方法。前置授权接口与Opik响应解码独立。

- [ ] Step 1: 写测试 `enterprise_never_falls_back`、`public_chat_access_is_not_observation_access`、`admin_can_observe_system_bot`：例如 `expect(await authorizer.authorize(enterpriseUnknown, {botId:"b"}, "read").catch(errorCode)).toBe("not_found")`；两个scope中相同run ID查询只返回本scope记录。
- [ ] Step 2: Run `bun test server/tests/opik-scope.test.ts`；Expected RED：authorizer/store接口不存在。
- [ ] Step 3: 实现工作台adapter：当前归属/管理规则决定创建者资格，平台管理员可以观测systemOwned Bot，不修改现有canManageAgent保护规则；enterprise分支fail-closed。范围为部署不透明key，不能接受client scope。表 `ai_observation_bindings` 与 `ai_observation_partitions` 以scope构成键；保留定位及过期/删除状态，不存业务正文或假tenant。
- [ ] Step 4: 测试环境脚本 `bun server/scripts/opik-test-env.ts up` 创建任务专属Postgres与安全 TEST_DATABASE_URL 文件 `.env.opik-test`（现有.env.*规则忽略、报告不含密码；TEST_DATABASE_URL与迁移用DATABASE_URL都只指向该专属库）；禁止使用应用DATABASE_URL。集成测试调用现有 `testDatabaseUrl()`，未提供测试库时拒绝。生成迁移同时登记schema/journal/snapshot，时间戳使用真实当前时间。
- [ ] Step 5: Run `bun test server/tests/opik-scope.test.ts server/tests/migration-journal.test.ts`；Run `bun --env-file=.env.opik-test test server/tests/opik-bindings.integration.test.ts`。Expected GREEN：跨scope隔离、原子begin幂等、归属变更生效、SQL迁移/快照一致、上游project不从client取得。
- [ ] Step 6: 将注入式内存OpikPort与真实adapter契约测试记入报告，封存schema与Interfaces检查点。两次begin同一attempt不能产生重复上游/计费任务。

## Task 3: 脱敏投影与有界的受治理导出

**Depends on:** 1,2。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A1/A4/A10，A13的导出接口。

**Files:** Create `shared/ai-observability.ts`, `shared/ai-trace.ts`, `server/src/ai-observability/{redaction,config,health}.ts`, `server/tests/opik-redaction.test.ts`, `server/tests/opik-export.test.ts`; Modify `shared/trace.ts`, `server/src/config.ts`, `.env.example`。

**Interfaces:** 定义并导出 `AiObservationSink`（emit/flush/health方法）、`ObservationHealth`（按scope统计导出、丢弃、失败、pending和最近成功时间）、`RuntimeObservationContext`（bindingId、attemptId、traceparent、policyVersion，仅由已认证的部署装配传递）；Consumes Task2 binding/locator和Task1 OTLP contract；Produces `projectObservation(raw: unknown, policy: RedactionPolicy): SafeObservation`、`createAiObservationSink(config).emit(binding: RunBinding, event: SafeObservation): void`、`flush(): Promise<void>`、`health(): ObservationHealth`。`RedactionPolicy`在本Task定义为version、结构化白名单/替换规则、文本策略；无可靠文本规则为metrics_only。Observer emitter是非阻塞void，不影响业务结果。

- [ ] Step 1: 写canary测试：`expect(JSON.stringify(projectObservation(rawWithSecret, metricsOnlyPolicy))).not.toContain(secret)`；覆盖嵌套数组、数字手机号、JSON key含秘密、错误栈、URL凭证、附件链接、reasoning字段、循环对象及超长文本；`expect(sink.health().dropped).toBeGreaterThan(0)`检查队列饱和。
- [ ] Step 2: Run `bun test server/tests/opik-redaction.test.ts server/tests/opik-export.test.ts`；Expected RED：投影及导出未实现。
- [ ] Step 3: 实现字段白名单和正文策略投影；身份只留HMAC匿名引用，凭证/思维链/原文附件一律省略。为名字、tags、metadata和异常同样处理。输出带policyVersion/truncated/omitted，不声称regex保证任意文本脱敏。
- [ ] Step 4: 共享tracer只注册一次，沿用OPENBOT_TRACES关闭语义；Opik单独enabled开关与受控Collectorendpoint。配置名固定为 `OPENBOT_OPIK_ENABLED`（默认off）、`OPENBOT_OPIK_API_URL`、`OPENBOT_OPIK_WORKSPACE`、`OPENBOT_AI_OTLP_ENDPOINT`、`OPENBOT_AI_OTLP_HEADERS`；地址和header只来自部署配置。enabled而缺API/OTLP地址时拒绝该功能配置，不能自动指向Cloud。OPENBOT_TRACES=off仍禁用观测，health标tracing_disabled、评测提交返回503 tracing_disabled，普通Agent照常执行；不偷偷注册provider。新增span在导出前安全投影；不初始化第二套自动捕获client。不允许未绑定run业务内容导出。队列默认2048记录、批次128、导出超时5秒，失败有安全计数/日志，关闭时flush有10秒上限。
- [ ] Step 5: Run新测试与 `bun test server/tests/trace.test.ts server/tests/trace-middleware.test.ts server/tests/trace-outbound.test.ts`。Expected GREEN：实际fake OTLP收到的bytes解码后无canary，原有传播/off开关通过，慢/故障出口不抛到执行层，正文限制遵守Task1验证上限（本地上限32KiB，取二者更小）。
- [ ] Step 6: 自查动态header/secret未进入诊断输出，保存RED/GREEN、OTLP解码证据及检查点后Review。

## Task 4: 工作台真实run生命周期与basic路径

**Depends on:** 2,3。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A3/A5/A10，A2的通用运行记录。

**Files:** Create `server/src/ai-observability/run-agent.ts`, `server/tests/opik-run-agent.test.ts`; Modify `server/src/copilot.ts`, `server/src/agents/agent-resolver.ts`, `server/src/agents/runtime-agents.ts`, `server/src/agents/endpoint.ts` 的小范围装配。

**Interfaces:** Produces `observeAgent(inner: AbstractAgent, resolveBinding: (input: RunAgentInput)=>Promise<RunBinding|null>, sink: AiObservationSink): AbstractAgent`。binding来自认证actor与服务端Bot装配；安全上下文用独立内部引用传递，不能信任input.state/forwardedProps的自报归属。现有已验证run assertion可用于回调绑定，绝不写入span。

- [ ] Step 1: 写 `headers_before_terminal_does_not_end_run`、`clone_keeps_observer_but_not_active_state`、`unsubscribe_without_confirmed_cancel_is_unknown`：`expect(binding.state).toBe("running")`在Response/首帧后仍成立；只有真实终态后 `expect(endCount).toBe(1)`；clone的abort不影响原实例。
- [ ] Step 2: Run `bun test server/tests/opik-run-agent.test.ts server/tests/run-built-agent-cancellation.test.ts`；Expected新增测试RED、现有取消测试GREEN。
- [ ] Step 3: 围绕实际Observable订阅处理RUN_STARTED/FINISHED/ERROR、error/complete/finalize、确认取消及重试attempt。区分run结束与观看断开；不能把finalize一律当canceled或completed。保留 `.runAgent` middleware和clone行为，不修改运行锁或撤销现有取消传递。
- [ ] Step 4: 为内置与远程AG-UI共同建立可信binding；索引不可写时停止该run业务观测、计数故障而不改变正常执行结果。通过受控出站传播相关上下文，沿用现有跨hostredirect剥离规则。外部Agent不能直接向私有Collector写入；basic只采集OpenBot真实观察到的数据。
- [ ] Step 5: Run `bun test server/tests/opik-run-agent.test.ts server/tests/run-built-agent-cancellation.test.ts server/tests/trace-outbound.test.ts agent-langgraph/tests/stream.test.ts`。Expected GREEN：成功/失败/重试/明确取消/未知都有唯一结局；TOOLS提议不算执行，采集故障不变更SSE事件流；跨hostredirect不泄露观测凭据。
- [ ] Step 6: Review检查每个入口的actor绑定和父子关系；未知路径标basic/unavailable，不依赖client填写capability。

## Task 5: 内置与LangGraph的模型、工具、检索详细记录

**Depends on:** 3,4。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A2/A3/A4/A8/A13。

**Files:** Create `server/src/ai-observability/{model,retrieval,langgraph}.ts`, `server/tests/opik-model.test.ts`, `server/tests/opik-step.test.ts`, `agent-langgraph/tests/opik-tracing.test.ts`; Modify `server/src/copilot.ts`, `server/src/knowledge/middleware.ts`, `agent-langgraph/src/index.ts`, `agent-langgraph/package.json`, `agent-langgraph/bun.lock`, `shared/ai-trace.ts`, `docker-compose.yml`, `supervisor/src/environment.ts`, `supervisor/tests/environment.test.ts` 中现有env透传装配。LangGraph为独立包，其依赖与lock必须一起更新；不要误改根lock代替它。

**Interfaces:** Produces `observeModel<T>(model: T, getBinding: ()=>RunBinding|null, sink: AiObservationSink): T`（保留provider/modelId/doGenerate/doStream契约）、`observeStep<T>(binding: RunBinding, step: StepDescriptor, operation: ()=>Promise<T>): Promise<T>`；本Task定义 `StepDescriptor = { id: string; parentStepId?: string; kind: "model"|"tool_proposal"|"tool_execution"|"retrieval"; name: string; policyVersion: string }`、`createLangGraphObserver(bindingContext: RuntimeObservationContext, sink: AiObservationSink): BaseCallbackHandler`。LangGraph callback转换成同一OTel路径，不同时开启OpikCallbackHandler造成重复未经治理上传。

- [ ] Step 1: 写 `settlement_failure_is_not_model_success`、`missing_usage_is_null`、`surface_call_is_proposal_until_receipt`：`expect(providerCalls).toBe(1)`，未知usage汇总为null；结算异常后span不是成功；没有可信执行回执的surface tool为unobserved。
- [ ] Step 2: Run `bun test server/tests/opik-model.test.ts server/tests/opik-step.test.ts agent-langgraph/tests/opik-tracing.test.ts`；Expected RED。
- [ ] Step 3: 观察现有meteredModel外层并保留finish chunk只有结算成功才转发的规则；记录真实model调用与拒绝/失败，不重复调用provider或再次结算。doGenerate和doStream都验证。检索采用现有LoadKnowledgeForBot调用的wrapper，不改变memory/knowledge注入合同；工具仅包实际execute入口，提议单独记。
- [ ] Step 4: LangGraph使用同一次调用的callback构建层级，run端点读取OpenBot生成的可信相关上下文，模型消息和日志中不含该上下文凭证。配置/endpoint只能由部署装配提供，body不能覆盖。源端先脱敏再导出，默认无策略只指标；长期调用仍能通过权威run绑定关联，不能因assertion过期退回匿名公共project。
- [ ] Step 5: 先按更新后的独立lock安装LangGraph依赖，Run新增测试和 `bun test server/tests/copilot-usage-meter.test.ts server/tests/run-built-agent-cancellation.test.ts agent-langgraph/tests/stream.test.ts`；再Task1真实实例冒烟内置与LangGraph各一个工具/检索执行，保存父子关系与最终payload。Expected GREEN且A2/A13证据来自真实Opik。
- [ ] Step 6: 实际版本不支持目标callback/usage时修adapter；只有该路径验收通过才把capability设detailed。动态进程env只透传非业务配置及既有安全凭据，不新增全局明文dump。

## Task 6: 创建者受控查询及稳定页面接口

**Depends on:** 1,2,4,5。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A5/A6/A10/A12，A2的可读交付。

**Files:** Create `server/src/ai-observability/{reader,routes}.ts`, `server/tests/opik-routes.test.ts`, `server/tests/opik-reader.test.ts`; Modify `server/src/index.ts`, `server/src/agents/routes.ts`。不增加任意上游代理接口。

**Interfaces:** Produces `createObservationReader(deps).list(actor, botId, filter): Promise<RunList>`、`detail(actor, botId, bindingId): Promise<RunDetail>`，授权后调用Task2 store/OpikPort；路由 `GET /api/agents/:botId/observability/runs`→`{runs:RunList}`，`GET .../runs/:bindingId`→`{detail:RunDetail}`；Bot详情增加服务端 `canObserve:boolean`，不改变既有canManage。

- [ ] Step 1: 写 `guessed_trace_or_foreign_cursor_returns_uniform_404`、`revoked_owner_loses_cached_detail`、`upstream_foreign_project_is_discarded`：先由Alice读取，再移交给Bob，`expect(second.status).toBe(404)`；返回trace project不匹配时不返回任何span；cursor跨scope拒绝。
- [ ] Step 2: Run `bun test server/tests/opik-routes.test.ts server/tests/opik-reader.test.ts`；Expected RED。
- [ ] Step 3: 每次从当前Bot权限解析scope，上游网络await结束后再次校验权限才返回内容；先限定scope/Bot再分页和聚合，不在上游全局查询后筛页面。读取ID经权威binding定位，span/project响应需核验；attachments不自动下载/展开。验证时间、状态、limit和排序，签名cursor与筛选绑定，无client locator/filter字符串透传。
- [ ] Step 4: 首期不缓存带业务内容的详情，避免revocation窗口；查询结果的客户端缓存键包含会话用户与Bot，登出清空。Opik暂不可达返回upstream_unavailable/syncing，不把未知数值变成0。无权限与未知ID使用同一404；未启用为503 `opik_disabled`，显式关闭tracing为503 `tracing_disabled`，配置故障为503 `opik_unavailable`。
- [ ] Step 5: Run新测试及 `bun test server/tests/agent-profile-policy.test.ts server/tests/agent-routes.test.ts`；Expected GREEN：所有ID猜测、公开Bot使用者、systemOwned管理员、移交及上游恶意响应均符合权限；异常日志无payload。
- [ ] Step 6: 保存HTTP DTO fixture供前端Task7/9/11使用，冻结接口后Review。

## Task 7: 创建者运行列表与详情页面

**Depends on:** 6。**Role:** frontend_implementer。**Validation:** frontend_validator + reviewer。**Acceptance:** A2/A5/A6/A10的用户可见行为。

**Files:** Create `app/src/lib/ai-observability/{queries,types}.ts`, `app/src/components/ai-observability/{run-list,run-detail,availability}.tsx`, `app/src/routes/_authed/_app/bots.$agentId.runs.tsx`, `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx`, `app/src/components/ai-observability/run-views.test.tsx`; Modify `app/src/components/bot-profile/manage.tsx`, `app/src/lib/agents/queries.ts`, `app/src/locales/{en,zh-CN}/agents.json`, `app/src/locales/{en,zh-CN}/errors.json`，生成 `app/src/routeTree.gen.ts`。

**Interfaces:** Consumes Task6 DTO/HTTP与canObserve；Produces `runListQueryOptions(actorCacheKey: string, botId: string, filter: RunFilter)`、`runDetailQueryOptions(actorCacheKey: string, botId: string, bindingId: string)`，复用client/queryOptions/现有BotSubpage。企业选项首期不发送、不增加客户端currentTenant全局状态。

- [ ] Step 1: 写DOM测试 `basic_run_says_internal_steps_unobserved`、`missing_tokens_are_not_zero`、`revoked_permission_clears_detail`：`expect(screen.queryByText("0 tokens")).toBeNull()`；503 disabled与upstream故障文案不同；权限404后不显示缓存span。
- [ ] Step 2: Run `bun test app/src/components/ai-observability/run-views.test.tsx`；Expected RED。
- [ ] Step 3: 按现有BotSubpage构建列表、时间/状态筛选、分页与步骤详情；入口按canObserve显示，system Bot管理员可见。safe内容以文本渲染，不用dangerouslySetInnerHTML，附件不提供原文链接。为keyboard、loading、empty、syncing、metrics_only、truncated、basic、故障状态提供en/zh-CN文案。
- [ ] Step 4: 用户身份/权限变化清空该观测查询空间；401/404不沿用旧成功数据。窄屏将表格行展开为可读内容，步骤树可keyboard展开，错误提示role=alert。
- [ ] Step 5: Run该DOM测试、`bun run --cwd app typecheck`、`bun run --cwd app build`；Expected GREEN且路由由生成器产生。frontend_validator用Task6 fixture页面检查desktop/mobile、键盘与XSS字符串，结果写报告。
- [ ] Step 6: 取得独立Spec/code质量Review；不把后端权限验证交给隐藏入口代替。

## Task 8: 可审查的脱敏样本与不可变数据集版本

**Depends on:** 2,3,6。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A4/A5/A6/A12，A7/A11的版本前提。

**Files:** Create `server/src/ai-observability/evaluation/contracts.ts`, `server/src/ai-observability/evaluation/datasets.ts`, `server/tests/opik-datasets.test.ts`, `server/tests/opik-datasets.integration.test.ts`, `server/drizzle/0088_opik_datasets.sql`, `server/drizzle/meta/0088_snapshot.json`; Modify `server/src/ai-observability/{opik-port,opik-http,routes}.ts`, `server/src/db/schema/ai-observability.ts`, `server/drizzle/meta/_journal.json`, `server/drizzle.config.ts`。

**Interfaces:** Consumes Task2授权/locator及Task3安全投影；扩展OpikPort `createDatasetSnapshot(locator: OpikLocator, idempotencyKey: string, cases: SafeDatasetCase[]): Promise<{datasetId:string;contentHash:string}>` 与 `readDatasetSnapshot(locator, datasetId):Promise<SafeDatasetCase[]>`，SafeDatasetCase定义在本Task合同，仅含经过审查的SafeBody/fixture；Produces `createDatasetService(deps).saveVersion(actor: ObservationActor, botId: string, input: DatasetVersionInput): Promise<DatasetVersionRef>`、`list(actor,botId):Promise<DatasetSummary[]>`、`getVersion(actor,botId,datasetId,versionId):Promise<DatasetVersionDetail>`；在evaluation/contracts.ts定义 `DatasetVersionInput`（本地候选bindingId或显式审查的合成input/expected/toolFixtures、policyVersion）、DatasetSummary、DatasetVersionDetail及共享EvaluationSnapshot。Task9使用这些定义，不复制一套版本类型。

- [ ] Step 1: 写 `metrics_only_trace_cannot_be_saved_as_text_case`、`saved_version_is_immutable`、`cross_bot_dataset_id_is_not_a_grant`：`expect(response.status).toBe(422)`在候选没有安全文本且没有审查后的合成案例时；修改原候选后 `expect(version.contentHash).toBe(originalHash)`；外Bot读取版本404。
- [ ] Step 2: Run `bun test server/tests/opik-datasets.test.ts`；Expected RED。
- [ ] Step 3: 实现候选审查、结构化fixture验证和安全投影。每个版本创建独立、不可变的Opik数据集快照；本地保存scope/Bot关联、hash、Opik定位、策略版本与过期时间，不保存原始正文。上游写入与本地引用用pending/syncing恢复，失败不遗失上游待清理定位。
- [ ] Step 4: 在0088迁移加入数据集与版本引用，预留scope且不新增tenant。HTTP：GET/POST `.../datasets`、POST `.../datasets/:datasetId/versions`、GET `.../datasets/:datasetId/versions/:versionId`，响应dataset(s)/version；非法案例422、权限/ID404、不可达503。客户端不能指定上游project/dataset ID；跨Bot复用需有权后显式复制。
- [ ] Step 5: Run单测、migration-journal及独立库集成；真实Opik验证两个版本有独立定位和固定内容hash，撤权后上游读取结果不回给旧用户。Expected GREEN：正文/Judge候选无canary，版本不可变、范围不可串用、部分成功可恢复，不使用上游可变默认版本。
- [ ] Step 6: 封存dataset接口、HTTP fixture和迁移检查点，取得独立Review后才放行Task9执行或Task10编辑页。

## Task 9: 隔离执行、受控评分与持久实验任务

**Depends on:** 2,3,4,5,6,8。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A4/A5/A6/A7/A8/A9/A10/A12。

**Files:** Create `server/src/ai-observability/evaluation/{jobs,execution,scorers,worker,comparison}.ts`, `server/tests/opik-evaluation.test.ts`, `server/tests/opik-evaluation.integration.test.ts`, `server/drizzle/0089_opik_evaluations.sql`, `server/drizzle/meta/0089_snapshot.json`; Modify `server/src/ai-observability/{opik-port,opik-http,routes,contracts}.ts`, `server/src/ai-observability/evaluation/contracts.ts`, `server/src/db/schema/ai-observability.ts`, `server/drizzle.config.ts`, journal、`server/src/copilot.ts`（受控evaluation agent工厂）、`server/src/index.ts`（注入与worker启动）。复用WorkQueue，不引入第二套Redis/BullMQ实现。

**Interfaces:** 扩展OpikPort `writeExperiment(locator:OpikLocator, experiment:SafeExperiment, idempotencyKey:string):Promise<{experimentId:string}>`，SafeExperiment在本Task定义为仅含安全版本引用/逐样本投影/评分及状态；Consumes Task8不可变DatasetVersionRef、EvaluationSnapshot与数据集HTTP；Produces `createEvaluationService(deps).submit(actor, botId, snapshot: EvaluationSnapshot, idempotencyKey: string): Promise<EvaluationJob>`、`cancel(actor,botId,jobId): Promise<EvaluationJob>`、`get(actor,botId,jobId): Promise<EvaluationJobDetail>`；`EvaluationExecutor.runSample(authorization: ExecutionAuthorization, snapshot, item, signal): Promise<SampleResult>`、`JudgePort.score(authorization,snapshot,safeSample,signal): Promise<ScoreResult>`；`compare(actor,botId,leftId,rightId): Promise<ExperimentComparison>`；`startEvaluationWorker(deps): {stop():Promise<void>}`。contracts定义所有DTO并导出供后续Task复用。

- [ ] Step 1: 写 `unknown_attempt_is_not_replayed_after_lease_expiry`、`revoke_between_samples_stops_next_call`、`judge_cannot_bypass_credit_gate`：`expect(providerCallCount).toBe(1)`即使worker重启；第二样本前撤权后无新调用；不足预算时 `expect(judgeCallCount).toBe(0)`；格式检查 `expect(score({output:"{}",expectedFields:["answer"]}).passed).toBe(false)`。
- [ ] Step 2: Run `bun test server/tests/opik-evaluation.test.ts`；Expected RED。集成测试必须使用Task2独立测试库，不能skip当pass。
- [ ] Step 3: 在0089加入任务/逐样本状态与实验定位，引用Task8已持久化的不可变版本；正文仍只在脱敏上游快照，本地保存hash、引用、安全配置和scope。上游实验与保存定位采用可恢复pending/syncing步骤，部分成功记录待清理，不靠跨网络数据库事务保证原子。
- [ ] Step 4: 使用WorkQueue kind=`ai.eval`，key包含scope/Bot/job ID；默认并发2、每实验最多100条、单样本60秒，可运维配置。逐样本先原子登记attempt再发调用；lease恢复遇到invoking/未知结果标needs_reconciliation，不自动调用。每样本重新授权，取消停止新调度并传播AbortSignal；completed不可被迟到更新覆盖。
- [ ] Step 5: 在copilot装配提供 `createEvaluationAgent(snapshot, authorization, fixtures)`，复用相同模型/工具解析和现有meteredModel；独立临时thread、空生产memory/learning、fixture工具目录，不进入生产Intelligence thread写入。使用现有 `withUsageOrigin("api", ...)`，另在观测记录scenario=evaluation。被测remote runtime只有证明fixture/隔离/计费适配后才可执行，basic不等于可安全评测。
- [ ] Step 6: Judge通过部署注入的受控模型port执行；SDK自动追踪关闭，SDK规则/模型评分结果统一安全投影后写Opik。规则首期为JSON/必需字段/工具名称与参数匹配；Judge首期为基于reference/context的任务完成评分，保存rubric/scorer版本。无法受控的模型配置在提交前拒绝，不能临时直连provider。
- [ ] Step 7: 路由在 `/api/agents/:botId/observability/` 下：复用Task8数据集接口，新增GET/POST `experiments`（POST要求Idempotency-Key）、GET `experiments/:jobId`、POST `experiments/:jobId/cancel`、GET `compare?left=&right=`。响应keys为dataset(s)/version/experiment(s)/comparison；错误404权限、409不兼容或key冲突、422非法fixture/版本/评分配置、503未启用/暂不可用。dataset和fixture语义不合格时拒绝评测，不能仅因同Bot放行。
- [ ] Step 8: 比较以冻结dataset contentHash、scorerVersion及样本IDs判断可比性；不相同返回comparable=false和差异，不能给误导平均分。结果包含有效评分数、执行/评分失败、耗时/token、逐项delta及bindingId。Opik同步失败不会重新执行模型，只重试幂等写入。
- [ ] Step 9: Run `bun test server/tests/opik-evaluation.test.ts server/tests/migration-journal.test.ts server/tests/copilot-usage-meter.test.ts`；Run独立库集成；再真实Opik用合成数据比较两种配置。Expected GREEN：版本不可变、双worker无重复调用、撤权/取消有效、fixture无生产写、judge计费证据、实验可追溯且payload无canary。
- [ ] Step 10: 保存真实契约增量和模型/评分调用次数证据，Review先检查执行路径是否绕开原门控；不以SDK返回score成功替代此项验证。

## Task 10: 创建者评测集与实验对比页面

**Depends on:** 7,8,9。**Role:** frontend_implementer。**Validation:** frontend_validator + reviewer。**Acceptance:** A4/A5/A7/A8/A9用户流程。

**Files:** Create `app/src/components/ai-observability/{dataset-editor,experiment-list,experiment-detail,experiment-comparison}.tsx`, `app/src/lib/ai-observability/evaluations.ts`, `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx`, `app/src/components/ai-observability/evaluation-views.test.tsx`; Modify运行详情（添加候选样本）、manage入口、en/zh-CN agents/errors及生成routeTree。

**Interfaces:** Consumes Task9 HTTP DTO；Produces dataset/experiment query/mutation options，mutation提交同一操作重试使用相同Idempotency-Key，用户新建操作使用新key。运行详情链接到本Bot评测页，并传本地bindingId作为候选引用。

- [ ] Step 1: 写 `scoring_failure_is_visible`、`incompatible_experiments_have_no_quality_winner`、`cancel_requested_is_not_canceled`：`expect(screen.queryByText("Winner")).toBeNull()`在comparable=false时；评分失败行仍可见；metrics_only样本不能直接提交。
- [ ] Step 2: Run `bun test app/src/components/ai-observability/evaluation-views.test.tsx`；Expected RED。
- [ ] Step 3: 实现候选案例审查与保存版本、选择已批准模型/fixture/scorer配置、提交任务、状态轮询、取消及两个实验对比。版本与rubric固定后显示配置差异；不提供原文附件或任意模型地址输入。处理重复提交、409、失败、缺失评分、同步中及权限撤销。
- [ ] Step 4: 复用现有form/table/dialog交互与双语文案；维持焦点、键盘操作、状态读屏与手机布局。危险字符串作为文本显示。比较表明确分数方向、样本数和不可比较原因。
- [ ] Step 5: Run DOM测试、app typecheck/build。frontend_validator走创建候选→保存版本→运行两实验→对比→回到运行流程，包含失败、取消和权限404。Expected GREEN、所有状态均可解释且无法误读为成功。
- [ ] Step 6: 独立review通过后封存页面checkpoint，后端接口若改变先同步契约及验证，不能通过前端猜测兼容。

## Task 11: 管理范围内汇总、导出与真实数据生命周期

**Depends on:** 2,6,8,9。**Role:** backend_implementer。**Validation:** backend_validator + reviewer。**Acceptance:** A4/A5/A6/A10/A11/A12。

**Files:** Create `server/src/ai-observability/{admin-routes,lifecycle,exports,console-auth}.ts`, `server/tests/opik-lifecycle.test.ts`, `server/tests/opik-admin-routes.test.ts`, `server/tests/opik-lifecycle.integration.test.ts`, `server/scripts/opik-acceptance.ts`; Modify `server/src/index.ts`, `server/src/agents/routes.ts`（删除/移交通知）、`server/src/ai-observability/{routes,bindings,opik-http}.ts`, `docker/compose/opik.yml`, `reference/opik.md`。不修改现有Bot删除权限与企业资源生命周期。

**Interfaces:** Produces `createObservationLifecycle(deps).scheduleDelete(scopeRef, resourceRef): Promise<DeletionTask>`、`sweep(now:Date):Promise<SweepResult>`；`createExportService(deps).request(actor,botId,input):Promise<ExportJob>`、`download(actor,exportId):Promise<Response>`；`AdminSummary`与`DeletionTask`在contracts定义；ObservationHealth复用Task3定义，不重新定义。范围受限健康数据只汇总其scope，平台全实例数据需要独立admin资格。API `/api/admin/ai-observability/summary`→`{summary}`、`/health`→`{health}`；创建者POST `.../exports`→`{export}`，GET `.../exports/:exportId`受控下载；POST `.../datasets/:id/delete`→`{deletion}`。

- [ ] Step 1: 写 `delete_timeout_retains_locator_for_retry`、`old_export_link_fails_after_transfer`、`scope_admin_cannot_open_instance_console`：上游失败后 `expect(deletion.state).toBe("pending")`且映射存在；撤权下载404；范围受限管理员没有整实例URL。时间边界7天/30天前后分别断言保留与删除。
- [ ] Step 2: Run `bun test server/tests/opik-lifecycle.test.ts server/tests/opik-admin-routes.test.ts`；Expected RED。
- [ ] Step 3: kind=`ai.cleanup`任务先撤销可见性再删除上游trace/spans、版本/实验及文件；仅上游验证查不到后完成。失败保留scope和locator以重试；Bot软删除不能级联擦除待清理定位。保留期用DB时钟，默认7/30天，在权限判定中即时生效。
- [ ] Step 4: kind=`ai.export`只读取已授权的安全DTO，JSON导出流无原始URL、可执行HTML和凭证；持久文件按scope安全定位、每次下载重授权、不会生成绕过API的长期公开链接。删除/过期/撤权取消排队任务并清缓存；评测集版本物理删除前先禁止新实验。
- [ ] Step 5: 管理汇总先限定scope，再计算Bot/状态/有效样本/token缺失计数。平台运维管理员控制台入口要在反向代理/网络层保护整个Opik私有API；`authorizeConsoleAccess(actor, authorization): boolean`只允许整实例平台资格，反向代理使用现有身份校验或平台私网身份，不新增Opik账号表。部署验证直接访问未保护backend不可达，创建者/受限管理员访问任意console私有API被拒绝；浏览器角色不是唯一门控。部署手册列明实际volume/object存储、备份保留上限、完整清理步骤及证据，不能把备份策略空缺标通过。
- [ ] Step 6: Run新单测和独立库集成，再Task1真实实例验证trace、span、dataset snapshot、experiment删除及跨scope不受影响。Expected GREEN：权限即时失效、上游实际查不到、故障重试不跨project、不误报完成、受限admin无法直达私有API。
- [ ] Step 7: 实现 `runOpikAcceptance(targets: AcceptanceTargets, evidenceDir: string): Promise<AcceptanceReport>`，包含A1..A13合成fixture与机器可读证据；先测试缺server/Opik/独立DB配置退出非零。真实检查只调用专属实例、与Task1共享contract harness，不默认运行应用.env。更新真实contract manifest的删除证据；完整Review并把可操作部署命令、保留行为和剩余平台限制保存在reference/opik.md。

## Task 12: 管理员汇总、健康与创建者导出状态

**Depends on:** 7,10,11。**Role:** frontend_implementer。**Validation:** frontend_validator + reviewer。**Acceptance:** A5/A6/A10/A11用户可见行为。

**Files:** Create `app/src/routes/_authed/admin/ai-observability.tsx`, `app/src/components/ai-observability/{admin-overview,export-status}.tsx`, `app/src/lib/ai-observability/admin.ts`, `app/src/components/ai-observability/admin-views.test.tsx`, `tests/e2e/opik-observability.e2e.ts`; Modify `app/src/components/admin/admin-sidebar.tsx`、运行/评测页面导出操作、en/zh-CN admin/agents/nav/errors及生成routeTree。不泛改layout目录。

**Interfaces:** Consumes Task11 HTTP DTO/返回的console可达资格；不在浏览器拼接Opik内网地址、授权header或scope。

- [ ] Step 1: 写 `export_revocation_removes_download`、`health_drop_is_not_zero_traffic`、`scoped_admin_has_no_console_button`：`expect(screen.queryByRole("link", {name:"Open Opik"})).toBeNull()`在服务端未给资格时；删除pending不能显示已删除；unknown token不算0。
- [ ] Step 2: Run `bun test app/src/components/ai-observability/admin-views.test.tsx`；Expected RED。
- [ ] Step 3: 实现管理范围内汇总、Bot/time过滤、队列/丢弃/失败/同步提示、未绑定记录与运维入口；导出状态queued/running/ready/failed/revoked；只ready且有权时下载。汇总与详情相同范围，不把basic内部缺失算成健康。
- [ ] Step 4: 同样提供双语、加载/空/关闭/故障状态与窄屏布局；复用图表/表格系统，不展示内部SDK细节或凭证。直接打开管理路由仍处理后端403/404。
- [ ] Step 5: Run DOM测试、app typecheck/build；frontend_validator检查管理角色与普通角色、键盘、mobile、故障和撤权。Expected GREEN且角色受限页面无越权资源信息。
- [ ] Step 6: 新增既有tester-army的Opik专属e2e场景，覆盖创建者运行→候选样本→两种实验→对比、管理员汇总、basic/故障/撤权/取消；使用隔离测试账户与Task11验收环境，不更改用户bot-chat测试。独立Review后封存checkpoint；将真实导航文件纳入哈希清单，不遗漏生成路由或locale新增文件。

## Task 13: 全范围验证、独立Review与OCR闭环

**Depends on:** 1..12全部verified。**Owner:** 主控。**Validation:** backend_validator、frontend_validator与最终default + gpt-6-sol/high（reviewer约束）分别只读。**Acceptance:** A1..A13全部映射和真实证据。

**Files:** 只读验证者写 `docs/plans/evidence/2026-10-14-opik/final/` 报告；不写业务或测试源文件。复用Task11的 `server/scripts/opik-acceptance.ts` 和Task12的 `tests/e2e/opik-observability.e2e.ts`；缺失或有缺陷则重新派发对应Task修复，不由主控补写。

**Interfaces:** 验收脚本输入专属测试server/Opik/数据库环境及evidence目录；缺任何环境或真实fixture前置条件时退出非零，不全skip成功。e2e测试按现有e2e runner注册，不自建Playwright编排器。

- [ ] Step 1: 主控确认Task11/12已审查的验收脚本与场景覆盖A1..A13，并在专属实例运行 `bun server/scripts/opik-acceptance.ts --env .env.opik-test --evidence docs/plans/evidence/2026-10-14-opik/final/acceptance`。缺环境退出非零，合成fixture验证所有目标，不依赖真实用户数据。
- [ ] Step 2: backend_validator复用前置同hash测试，补跑缺失的真实实例与迁移/预算行为；frontend_validator运行 `bunx e2e run --help` 确认当前runner过滤语法后仅跑 `tests/e2e/opik-observability.e2e.ts`，不启动已有共享e2e环境。A8计费与生产写隔离必须独立验证。
- [ ] Step 3: 在专属测试DB环境运行 `bun run test:ci`、`bun run typecheck`、`bun run lint`、`bun run build`；生成app配置用测试env。若现有全仓基线失败，记录命令/错误与BASE对照，不伪称通过或静默跳过；补充计划解决此次影响或明确环境阻塞。
- [ ] Step 4: reviewer检查完整交付的未提交增量、引用的真实证据、Spec覆盖与code quality。所有中高严重问题由对应原实现者修复，验证和Review重新绑定hash；Task13不批准自己编写的内容。
- [ ] Step 5: 主控读取open-code-review Skill，执行OCR完整workspace范围，业务背景含本Spec、A1..A13、租户预留和脱敏/计费约束，始终 `--audience agent`；每轮报告另存，不先探测是否安装。若未来取得授权有提交，再追加原始BASE到HEAD审查，不能只审最后修复。
- [ ] Step 6: 有有效critical/high/medium finding时保留finding ID/证据，创建编号修复DAG/计划，用writing-plans + SDD修复、独立Review、OCR复审。连续同问题两轮无进展时systematic-debugging并按仓库规则升级；缺provider配置如实报告，不编造完成。
- [ ] Step 7: 完成条件：所有A1..A13有同版本证据，所有交付节点verified，必要检查通过，独立Review与完整OCR通过；最终diff只有Opik范围。保存证据/Ruling/Ledger后再使用finishing-a-development-branch。没有授权不提交/推送/合并或删除持久工作区。

## 需求与验收映射

| Spec要求 | Tasks |
| --- | --- |
| 自托管/可选关闭/宿主与容器/兼容版本 A1,A13 | 1,3,5,13 |
| 可信归属与scope预留 A5,A6,A12 | 2,4,6,8,9,11,13 |
| 实际生命周期/完整默认路径 A2,A3 | 4,5,6,7,13 |
| 导出前脱敏/附件/SDK/Judge A4 | 1,3,5,8,9,10,11,13 |
| 样本版本与评测、预算/工具隔离 A7,A8 | 8,9,10,13 |
| 可比结果与退化定位 A9 | 9,10,13 |
| Opik故障不改变执行、缺失状态 A10 | 1,3,4,6,7,9,11,12,13 |
| 保留、物理删除、导出撤权 A11 | 1,2,8,11,12,13 |
| 管理员与创建者页面、双语/无障碍 | 7,10,12,13 |

## 执行前预检与失败处理

- [ ] 主控验证批准Spec哈希、BASE/HEAD、工作区新增用户改动及各Task owned_files；检查DAG无自环、无循环、引用完整且A1..A13全覆盖。
- [ ] 检查Task2/3/6/8/9/11接口与所有下游test/DTO名字一致；跨Task变更先修订计划/Brief，不能单方面改契约。
- [ ] 每次派发核对实际agent_type、模型及推理等级符合专业路由；子Agent不得再派发。验证者只读业务和测试源码。
- [ ] 所有共享schema/journal、copilot/index、locale、routeTree、Collector/Opik端口及测试数据库沿拓扑序独占，不并行抢写/重置。
- [ ] 本地提交未授权，所有任务均用未提交检查点；新增/删除文件及完整内容纳入Review Package，所有报告绑定hash。
- [ ] 真实契约不支持、环境/凭据不足或批准Spec与现有ADR冲突时标blocked并报告具体证据；继续不受影响工作，不把未知当实现完成。
- [ ] 计划批准前不启动生产实现。批准后按仓库保留的SDD执行方法派发，无需重复询问每个常规修复。

## 计划自查记录

- 已逐项覆盖批准Spec的目标、非目标、三个企业seam、运行能力分级、生命周期、脱敏、授权、评测、页面、部署/删除及A1..A13。
- 已分开前后端稳定接口与专业ownership，Task内保持可独立评审的交付；默认串行，未启用子Agent执行。
- 已检查shared文件写入顺序、DTO名、接口消费者/生产者和迁移起点；新增接口定义在明确Task，不留TODO/TBD。
- 具体版本由Task1的真实兼容选择和契约manifest产出，这是可验收前置任务；本计划不捏造已安装版本或已通过真实Opik证据。
- BASE针对性测试42/0已记录；完整检查、真实部署、前端验收与OCR属于实施阶段，当前没有宣称它们通过。
