# tRPC-Agent-Go 与 Intelligence 完整替换 Implementation Plan

> 2026-10-10 设计变更：用户已选择 Mastra 统一承担 Agent 执行与 Intelligence 替代能力。新书面设计见 [Mastra 迁移设计](../../specs/2026-10-19-mastra-agent-execution-migration-design.md)。原 Go 方向 T05–T20 暂缓派发，新规格已批准，新计划与 DAG 已更新于 `docs/plans/superpowers/2026-10-10-mastra-intelligence-migration.md` 和 `docs/plans/2026-10-10-mastra-intelligence-dag.json`；本旧 Go 计划不再派发，既有已验证检查点保留。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 专业实现 Agent 串行执行，主控负责集成、验证派发、Review 与 OCR。

**Goal:** 使 OpenBot 使用 tRPC-Agent-Go 执行托管 Agent，以自有服务完整替换 Intelligence 的会话、实时事件、恢复、记忆、学习及初始化依赖。

**Architecture:** 保留 TS/Hono/Bun 控制平面和当前前端体验。TS 统一写入权威存储；Go 通过短期 Invocation 和受控内部接口执行，不直连业务数据库。CopilotKit 保留自有 AgentRunner/SSE 接缝及必要开源 UI，平台自己提供异步历史、频道和学习接口。

**Tech Stack:** Bun/Hono/TypeScript/Drizzle/PostgreSQL、React、RxJS/AG-UI、tRPC-Agent-Go、Tauri Rust、Docker Compose/Helm。以 bun.lock/go.sum 和 SDK 1.77.0 基线为起点，安全升级须记录并重验契约。

**Spec:** [已批准迁移规格](../../specs/superpowers/2026-10-09-enterprise-ai-platform-design.md)；[企业规格](../../specs/superpowers/2026-10-09-enterprise-ai-platform-design.md)、[总合同/门禁](2026-10-09-enterprise-ai-00-master.md)、[租户前置](2026-10-09-enterprise-ai-02-tenancy.md)。批准来源：用户在本会话确认书面规格，2026-10-09。

## Global Constraints

- “TS 是产品身份、授权、会话、运行账本、工具回执、预算和发布状态的唯一写入方。”
- “Go 无业务数据库权限，也不持有长期模型供应商密钥。”
- “采用仓库企业域实体及 `storage_backend` 方案，沿用已有标识而不创建另一套独立聊天账本。”
- “每个会话同一时刻只有一个主系统写入。”
- “SDK RUN_FINISHED 仅结束当前 Turn”；业务 Run 终态由平台确认，不能按流结束猜成功。
- “未知副作用进入对账”；“禁止自动重跑整个 Agent 来消除错误。”
- “候选先授权审核/评测，再发布不可变版本”，学习关闭设置不得被迁移重置。
- “不迁移控制平面语言，不顺带引入 OpenFGA/OPA，不重新设计整套企业平台。”
- “测试使用隔离库、合成身份与数据”；TEST_DATABASE_URL 缺失/指向 openbot 即失败，不回退 DATABASE_URL。
- 不修改原工作区、不自动提交/推送/合并、不导出真实数据或部署。全部本地变更使用未提交检查点；所有真实阻塞项必须解决或明确报告未完成。

## Review Focus

1. 两个请求同时进入共享进程时，actor/tenant 不得串到另一个 runner；Task 8 的 concurrent_users_do_not_share_runner_scope 和 Task 9 账号切换固定此行为。
2. 重放历史到订阅 live 的间隙产生消息、ACK 丢失或 TS 多副本时，事件不漏、不重复确认；Task 7 的 replay_to_live_has_no_gap_and_revocation_closes_stream 覆盖。
3. 模型/SDK 结束一轮但仍等待审批或工具回执 unknown 时，业务 Run 不能成功或自动重做副作用；Task 4、5、10、11 终态/故障测试覆盖。
4. 原群聊、已删 Bot 历史、定时任务和来源撤权时，迁移不能丢功能或保留失效权限；Task 3、12、13 行为测试覆盖。
5. 没有旧项目凭据、导出不完整或已在新后端写入时，初始化应成功但真实数据切换不能假成功/盲目回退；Task 16、17、18、19 固定。

---

## 工作区、基线与恢复

工作区：`/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`，BASE=`fbdecc29cd786952c4b496abc68384b31a320b17`，detached HEAD。已存在并附属于本会话；不得重新创建或切换原目录。

[规格来源基线](../../../.archive/runs/legacy-plans/2026-10-09-trpc-intelligence/2026-10-09-trpc-intelligence-spec-baseline.json)、[计划基线](../../../.archive/runs/legacy-plans/2026-10-09-trpc-intelligence/2026-10-09-trpc-intelligence-plan-baseline.json)、[DAG/验收映射](../2026-10-09-trpc-intelligence-dag.json)、[执行前自检](../2026-10-09-trpc-intelligence-preflight.md)随计划保存。原工作区有持续变化的认证、配置、账务和运行时验证修改；仅记录路径/hash，未复制其业务代码。本隔离 BASE 自身是有效起点，但后续集成回当前分支前必须按最新 Git 做差异核对，不用 stash。

当前交付为详细计划。产品依赖未安装、测试未运行，planned/ready 不代表 verified。既有基线失败须记录并归属，不把环境错误当业务 RED。文档被当前 .gitignore 忽略，需以完整内容快照归档，最终交付清单不能只看 git diff。计划批准后按既定 SDD 执行，不重新询问执行方法。

执行前运行 SDD scripts/sdd-workspace 创建计划专属目录；Ledger 第一行写本计划绝对路径。每任务前后保存 HEAD、tracked staged/unstaged patch、任务内 untracked/ignored 交付文件内容及 SHA256；生成增量 Review Package，记录验证对应快照。状态 pending/ready/running/blocked/verified；下游仅在前置 verified、Review 通过且增量已存在此工作区时运行。恢复先读 Ledger/Git/快照，不重派完成任务。

## 共享接口注册与版本

Task 1 在 `server/src/enterprise/contracts.ts` 定义所有平台接口、依赖对象及请求/返回类型；wire 类型从 server strict schema 推导，禁止不同任务复制 DTO。以下名称是规范接口名，后续 Task Interfaces 的参数类型从此注册表消费。

- Scope：PlatformScope 含可信 tenantId/workspaceId/principalId/actorId、memberEpoch、aclEpoch 及入口类型；ScopeResolver 与 ResourceReader 由 Task 2 实现。客户端选择器不能生成 Scope。
- Conversation：ConversationInput/AppendMessageInput/HistoryInput/MessagePage/StorageBackend/MessageDTO；存储归属仅 intelligence 或 platform，迁移状态单独记录；Task 3 实现 ConversationService。
- Run：StartRunInput/CancelRunInput/RunDTO、RuntimeInvocation、BudgetInput/BudgetReservation；状态 queued/running/waiting_approval/suspended/succeeded/failed/cancelled；不同 run/attempt/turn 字段不得复用。Task 4 拥有转换和 ModelGateway，Task 6 签发 Invocation。
- Tools：ToolPreparation/ToolExecution/PreparedTool/ToolReceiptDTO/ApprovalResolution/ApprovalDTO；字段及固定 status 取总计划 §4。Task 5 实现 ToolService。
- Events：EventProposal/EventAck/EventCursor/EventPage/EventDTO；source_event_id 内容摘要冲突 409；seq 为平台作用域单调整数；公开 DTO 不含 Invocation、凭据或授权快照。Task 7 实现 EventService。
- Recovery：CheckpointProposal/CheckpointAck/CheckpointDTO/ResumeInput；schema/expert/runtime 兼容版本、消息/操作/审批/预算/产物引用及摘要取总合同。Task 10 实现 CheckpointService/RecoveryService，Task 11 实现 Go 恢复。
- Runtime：PlatformRunnerDeps/PlatformCopilotDeps/PlatformRuntimeDeps/PlatformRuntime、HeadlessTurnInput/HeadlessTurnResult；deps 明确持有以上服务、授权 Agent loader 及 scope，不接受任意全局连接。Task 8 装配，Task 12 headless adapter。
- Memory/Learning：MemorySourceReference/DeletionReceipt/LearningJobDTO/SkillCandidateDTO/CandidateReviewInput/SkillVersionDTO/SkillSelection/SkillSnapshot；Task 13、14 分别实现，技能资产与审核状态不复用框架私有结构。
- Migration：LegacyArchive/ImportOptions/ImportReport/CutoverInput/CutoverReceipt，含原始内容hash、映射及未完成项；Task 16 实现。
- 公开路径：`/api/enterprise/v1` 沿既有基线；当前聊天兼容 handler 保留客户端配置的 CopilotKit basePath。异步 threads 路由优先于 SDK handler。所有 public 请求先认证、CSRF/origin 检查及 scope 解析。
- 内部路径：总合同 validate 和 tool prepare/execute；新增 `/internal/enterprise/v1/runs/:run_id/events`、`/checkpoints`、`/resume`，均限定服务身份、业务能力、attempt/lease/fencing，不挂到公网 listener。

- 会话业务接口：GET/POST `/api/enterprise/v1/conversations`、GET `/conversations/:id/messages`、POST `/conversations/:id/messages`，由 ConversationService 处理并做资源授权；SDK `/threads` 路由映射至同一服务。
- 学习业务接口：GET `/api/enterprise/v1/learning/jobs`、GET `/learning/candidates`、POST `/learning/candidates/:id/review`、POST `/learning/candidates/:id/publish`、GET `/learning/skills`，由 Task 14 实现，Task 15 消费；前缀同为 `/api/enterprise/v1`，旧 settings 接口仅适配已有配置。
- Snapshot/报告是执行管理产物，不进入产品接口。单元 fixture 的辅助方法由所属任务测试文件定义，Task 1 只提供隔离环境、身份、时钟和生命周期，不在第一任务实现后续服务。

## 验证与任务收尾约定

下面测试片段指定核心断言，fixture 由 Task 1 定义，各任务扩展自己的 service fixture；断言前置必须实际驱动被测行为，不写只比较常量的测试。RED 来自尚未实现的行为，不能删除既有代码制造失败。单元/契约测试与真实 DB/进程/浏览器验收分别报告，不用 mock 通过代替真实验证。

每个任务末尾步骤 5 的验证若失败，由原实现角色修复；步骤 6 由主控保存检查点、派发专业 validator（只读，不改业务或测试源）以及独立 reviewer（Spec compliance + quality），结论及哈希写 Ledger。valid critical/high/medium 未解决不得 verified。共享 Schema/迁移/bootstrap 串行变更；实际路径变更记录 Ruling 并同步所有引用后再交下游。

### Task 1: 冻结 SDK、wire 合同与隔离验证入口

**Depends on:** 无；计划获准且基线核验后 ready。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `shared/enterprise/contracts.ts`、`server/src/enterprise/contracts.ts`、`server/src/enterprise/wire-schema.ts`、`server/src/enterprise/runtime-v1.schema.json`、`server/src/enterprise/runtime-errors.ts`、`shared/runtime-compatibility.ts`、`server/tests/enterprise/fixtures/runtime-wire.json`、`server/tests/enterprise/contract-schema.test.ts`、`server/tests/enterprise/sdk-compatibility.test.ts`、`server/tests/enterprise/fixtures/platform.ts`、`server/scripts/runtime-test-environment.ts`、`server/package.json`、`bun.lock`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：批准规格、总计划 §4、锁定 CopilotKit/AG-UI SDK；现有测试库保护器。Produces：WireSchemaV1、PublicRunInputSchema、PlatformScope、ConversationDTO、RunDTO、EventDTO、CheckpointDTO、ToolReceiptDTO；RuntimeTestFixture。

- [x] **Step 1 — RED 测试：** 写 `rejects_client_identity_and_unknown_wire_fields`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：rejects_client_identity_and_unknown_wire_fields
expect(PublicRuntimeInvocationSchema.safeParse({ tenant_id: "forged", state: {} }).success).toBe(false);
```

- [x] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [x] **Step 3 — 实现：** 按总计划字段逐一冻结 strict Zod schema、由其生成版本化 JSON Schema、稳定 operation error code registry 和正负 JSON 黄金样本；测试所需的锁定 CopilotKit core 与 Ajv 作为 server 精确版本 devDependencies，不能依赖 transitive dependency 或 Bun 私有目录；工具 arguments 限为深度最多 32、单 operation canonical JSON UTF-8 最多 65536 字节的有限 JSON 值；args_digest 从同一 canonical 编码计算。OperationErrorCode 固定为 `invalid_request, unauthenticated, forbidden, not_found, conflict, gone, rate_limited, unsupported_version, budget_exceeded, approval_required, reconciliation_required, unavailable, internal`；公开 envelope 为 `{ error: { code, message, request_id } }`，internal 不携带内部细节。公共 DTO 排除内部能力及身份字段。通过锁定版本真实客户端调用捕获 info/discovery、threads/history、run/stop、tool result、approval wait/resume、reconnect 的请求/响应。测试必须驱动对应锁定客户端 API/call site，并断言实际传出的请求体、cursor 与返回/重放；仅解析路由或读取手写 fixture 不算互操作证据；thread list 必须断言客户端消费非空项和分页 cursor，stop 必须捕获请求方法/活动 run body 并记录客户端忽略响应的事实，reconnect cursor 必须与同一传输内实际消费的事件重放关联。平台自有 API 样本单独标识。运行时 canonical JSON 对所有层级 property name 统一限制 <=200 Unicode code points，并以 ASCII 与非 BMP 边界测试证明 Zod 与 JSON Schema 结果一致。测试助手 createRuntimeTestFixture() 返回受控身份、时钟及可关闭的隔离 DB/服务；数据库入口仅接受 testDatabaseUrl() 校验后的 TEST_DATABASE_URL，无值时明确失败。记录现有 UI activity/附件/工具请求，不复制 SDK 实现。
- [x] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [x] **Step 5 — 验证：** `bun test server/tests/enterprise/contract-schema.test.ts server/tests/enterprise/sdk-compatibility.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [x] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-03、AC-05、AC-12；锁定客户端真实调用样本含工具结果/审批/恢复/重连，portable schema 与错误码存在；工具参数是有界 JSON，严格 DTO 负例仅多出敏感字段并针对性拒绝。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 2: 建立可信 Scope 与资源授权前置

**Depends on:** Task 1。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/tenancy/store.ts`、`server/src/enterprise/tenancy/provision.ts`、`server/src/enterprise/authz/service.ts`、`server/src/enterprise/authz/legacy-channel-scope.ts`、`server/src/db/schema/enterprise-tenancy.ts`、`server/tests/enterprise/tenancy.integration.test.ts`、`server/tests/enterprise/authz.integration.test.ts`。
- **Modify existing:** `server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/meta/`、`server/drizzle/`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：PlatformScope、RuntimeTestFixture；既有 users、channelMemberships、Bot 可见性与批准租户计划 T1–T3。Produces：ScopeResolver.resolve(request: Request): Promise<PlatformScope>；ResourceReader.readAuthorizedResource(scope: PlatformScope, id: string): Promise<ResourceView>。

- [ ] **Step 1 — RED 测试：** 写 `revoked_members_and_foreign_tenants_cannot_read`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：revoked_members_and_foreign_tenants_cannot_read
await expect(fixture.resourceReader.readAuthorizedResource(fixture.revokedScope, fixture.resourceId)).rejects.toThrow();
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 落实 T1–T3 的最小 tenant/workspace/principal/member/resource/grant、复合关系及 RLS，不实现二期角色继承。提供显式 provisionDeployment(input: ProvisionDeploymentInput): Promise<ProvisioningReceipt> 离线管理入口；用户/principal/租户绑定逐一录入，不把客户端 tenant header 当权限。legacy-channel-scope 复用当前频道成员及 Bot 权限生成有限映射，企业入口不隐式继承部署管理员权限；成员/ACL 检查在同一短事务中完成。Schema 导出和 drizzle 注册由本任务串行管理，生成的下一编号迁移必须重新读取 journal 确定，禁止覆盖 0053 或后续用户迁移。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/tenancy.integration.test.ts server/tests/enterprise/authz.integration.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-05；真实 PostgreSQL 两主体/两租户、撤权、部署 admin 无默认内容读权限、频道成员退出拒绝。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 3: 持久会话、消息与附件历史

**Depends on:** Task 2。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/conversations/service.ts`、`server/src/enterprise/conversations/store.ts`、`server/src/enterprise/conversations/routes.ts`、`server/src/db/schema/enterprise-conversations.ts`、`server/tests/enterprise/conversations.integration.test.ts`。
- **Modify existing:** `server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/`、`server/src/channels/thread-status.ts`、`server/src/channels/attachments.ts`（仅抽取接受调用方事务的附件授权/发送标记 helper，并保留既有 API 包装）。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：PlatformScope、ConversationDTO、`DataDatabase`、T02 `assertTrustedScope`、既有附件授权与频道映射。Factory：`createConversationService({ data: DataDatabase }): ConversationService`，不向服务注入可绕过授权的 mock store。Produces：ConversationService.getOrCreate(scope, input: ConversationInput): Promise<ConversationDTO>；append(scope, input: AppendMessageInput): Promise<MessageDTO>；history(scope, input: HistoryInput): Promise<MessagePage>；resolveBackend(scope, threadId: string): Promise<StorageBackend>。线程状态兼容器独立为 `createThreadReader({ readPlatform(threadId, actorId), readLegacy(threadId, actorId) })`；T03 交付 adapter，不从旧 `(threadId, actorId)` 自行伪造 tenant/workspace scope，生产入口接线由 T17 提供可信身份上下文。

- [ ] **Step 1 — RED 测试：** 写 `conflicting_client_message_keys_do_not_replace_history`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：conflicting_client_message_keys_do_not_replace_history
await expect(fixture.conversations.append(fixture.scope, fixture.conflictingMessage)).rejects.toMatchObject({ code: "message_conflict" });
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 建立会话、参与者、parts 消息、去重键与 storage_backend；映射既有 user/channel/thread，禁止为同一历史创建第二份主状态。按消息游标分页；相同客户端键和摘要返回原记录，不同内容返回 409。附件授权、消息/parts 写入及 attachedAt 标记必须共享一个 `DataDatabase` 事务；在该事务内重查当前 scope、频道未删除状态、成员资格、上传者与附件所属 thread/channel。为在线数据角色仅授予 legacy `channels`、`channel_memberships`、`intelligence_channel_mappings`、`attachments` 的必要列级 SELECT 和 `attachments.attached_at` UPDATE，不授附件字节或 Operator 权限。抽取的事务 helper 继续由现有 `markAttachmentsSent` 兼容包装调用。附件复用现有存储/下载权限，禁止修改文件字节格式；新 thread known/unknown 查询来自平台，存储故障不能返回 unknown。软删 Bot 的已授权历史保持可读，频道退出后收回访问。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/conversations.integration.test.ts server/tests/thread-routes.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-02、AC-03、AC-05、AC-10；重开 DB 连接历史保持，附件及已删除 Bot 历史权限不变。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 4: 运行账本、租约、模型出口与预算

**Depends on:** Task 3。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/runs/service.ts`、`server/src/enterprise/runs/store.ts`、`server/src/enterprise/runs/outbox.ts`、`server/src/enterprise/models/gateway.ts`、`server/src/enterprise/models/budget.ts`、`server/src/db/schema/enterprise-runs.ts`、`server/tests/enterprise/runs.integration.test.ts`、`server/tests/enterprise/model-gateway.test.ts`。
- **Modify existing:** `server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：ConversationService、PlatformScope、RunDTO；既有凭据 vault、provider OAuth/plan-model、billing entitlement。Produces：RunService.start(scope, input: StartRunInput): Promise<RunDTO>；cancel(scope, input: CancelRunInput): Promise<RunDTO>；get(scope, runId: string): Promise<RunDTO>；ModelGateway.handle(request: Request): Promise<Response>；reserveModelBudget(scope, input: BudgetInput): Promise<BudgetReservation>。

- [ ] **Step 1 — RED 测试：** 写 `concurrent_starts_reserve_once_and_fence_old_attempts`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：concurrent_starts_reserve_once_and_fence_old_attempts
expect(await fixture.countBudgetReservations(fixture.clientMessageKey)).toBe(1);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 以一个事务建立 Run、版本引用、预算预留、lease/fencing 及启动 outbox；同会话活动运行冲突返回 409。Run/attempt/turn 独立 ID，终态转换 CAS；SDK RUN_FINISHED 不自动代表业务成功。模型出口从现有模型选择和凭据读取器解析业务路由，不在 Go 保存长期 key；选定现有 provider 和桌面计划入口逐一验证，网关提供 Go 所需协议转换或适用适配器，不静默退回默认模型。预算限额来自部署/业务配置，使用整数精度、幂等预留、确认用量及释放；复用现有 billing 接口不重写账务。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/runs.integration.test.ts server/tests/enterprise/model-gateway.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-02、AC-05、AC-07、AC-12；并发启动只一个成功、越界路由拒绝、秘密不在响应/log/state 中。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 5: 工具准备、审批与持久执行回执

**Depends on:** Task 4。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/tools/service.ts`、`server/src/enterprise/tools/receipts.ts`、`server/src/enterprise/tools/routes.ts`、`server/src/enterprise/authz/action-policy.ts`、`server/src/db/schema/enterprise-tools.ts`、`server/tests/enterprise/tool-receipts.integration.test.ts`、`server/tests/enterprise/tool-approval.test.ts`。
- **Modify existing:** `server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：RunService、ResourceReader、ToolReceiptDTO；既有 computer gateway、plugin/MCP 权限及 audit。Produces：ToolService.prepare(scope, input: ToolPreparation): Promise<PreparedTool>；execute(scope, input: ToolExecution): Promise<ToolReceiptDTO>；resolveApproval(scope, input: ApprovalResolution): Promise<ApprovalDTO>。

- [ ] **Step 1 — RED 测试：** 写 `ack_loss_does_not_execute_a_tool_twice`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：ack_loss_does_not_execute_a_tool_twice
expect(fixture.externalEffectCount).toBe(1);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 按总计划 prepare/execute 内部路径落实唯一 operation_id 和参数摘要冲突；执行前在事务中重验权限/委托/审批/预算/fencing，再调用现有治理适配器。回执状态固定为 not_submitted/submitted/succeeded/failed/unknown；超时不能改为 succeeded，也不能自动 execute 第二次。审批引用绑定主体、operation、摘要及版本；内部服务身份不是业务权限。沿用已批准本地 TS ActionPolicy 合同，不把遗留工具 endpoint 挂到企业内部 listener。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/tool-receipts.integration.test.ts server/tests/enterprise/tool-approval.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-05、AC-06、AC-07；执行中撤权、审批改参、unknown 对账、回执 ACK 丢失覆盖。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 6: 装配真实 tRPC-Agent-Go 服务

**Depends on:** Task 5。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `runtime-go/internal/server/assembly.go`、`runtime-go/internal/server/assembly_test.go`、`server/src/enterprise/runtime/invocation.ts`、`server/tests/enterprise/runtime-process.test.ts`。
- **Modify existing:** `runtime-go/cmd/runtime/main.go`、`runtime-go/internal/adapter/agui.go`、`runtime-go/internal/callback/client.go`、`runtime-go/internal/identity/context.go`、`runtime-go/internal/server/auth.go`、`runtime-go/internal/server/cancel.go`、`server/src/enterprise/runtime/validation-routes.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：WireSchemaV1、RunService、ToolService、ModelGateway；现有 Go adapters。Produces：createRuntimeInvocation(scope, run: RunDTO): Promise<RuntimeInvocation>；createRuntimeValidationRoutes(deps: RuntimeValidationDeps): Hono；Go server.Assemble(cfg Config, deps Dependencies) (http.Handler, func() error, error)。Also consumes the Gateway's injected authenticated invocation resolver: authenticate the Go service independently, verify the TS-signed RuntimeInvocation claims (including workspace and membership epoch), use a tenancy-owned internal scope factory to recheck current membership/principal/workspace under existing tenant RLS, then consume the one-use model capability and compare run/attempt/generation/route to the signed invocation. Never derive scope from unsigned Go headers/body and do not add a cross-tenant capability-digest lookup role/function. `aclEpoch` is currently a fixed `1`; do not claim dynamic ACL revalidation without a separately defined source.

- [ ] **Step 1 — RED 测试：** 写 `real_process_serves_authorized_run_and_rejects_forgery`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：real_process_serves_authorized_run_and_rejects_forgery
expect(await fixture.runViaGoProcess(fixture.forgedInvocation)).toMatchObject({ status: 401 });
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 更新候选验证为正式短期 capability 与独立服务认证，绑定输入摘要/租约/fencing/turn；不得继续信任旧 readRunAssertion 缺失身份的企业请求。签名 RuntimeInvocation 增加 workspace 与 member epoch 并在 TS 校验；tenancy 内部 scope factory 只接受已验证断言，重查当前 membership/principal/workspace 后发放可信 scope；RunService 消费模型 capability 后比较 run/attempt/generation/route。入口 mount 真实 AG-UI、模型 Gateway、取消、健康与 tool callback，增加 header/read timeout、请求体上限及关闭清理；部署配置明确地址、TS 内部地址与模型出口。Go 用 llmagent 和锁定路由执行，配置中的专家/工具来自已验证版本，工具出口只调用 Task 5。测试启动真实 Go 子进程和 fake 模型，不仅测试 Handler。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `go test ./... -count=1（runtime-go）；bun test server/tests/enterprise/runtime-process.test.ts（仓库根）`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-02、AC-05、AC-06；实际进程端口由 OS 分配，无业务 DB/key 权限，关闭后资源收敛。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 7: 持久事件、ACK 与可重放订阅

**Depends on:** Task 6。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/runs/events.ts`、`server/src/enterprise/runs/subscription.ts`、`server/src/enterprise/runs/event-routes.ts`、`server/src/enterprise/runtime/event-ingest.ts`、`runtime-go/internal/callback/events.go`、`runtime-go/internal/callback/events_test.go`、`server/tests/enterprise/event-replay.integration.test.ts`。
- **Modify existing:** `server/drizzle/`。
- **Modify predecessor delivery:** `server/src/db/schema/enterprise-runs.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：RunService、RuntimeInvocation、EventDTO；Task 6 的受认证执行通道。Produces：EventService.append(scope, proposal: EventProposal): Promise<EventAck>；replay(scope, input: EventCursor): Promise<EventPage>；subscribe(scope, input: EventCursor, signal: AbortSignal): AsyncIterable<EventDTO>；Go EventClient.Propose(ctx, proposal) (Ack,error)。

- [ ] **Step 1 — RED 测试：** 写 `replay_to_live_has_no_gap_and_revocation_closes_stream`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：replay_to_live_has_no_gap_and_revocation_closes_stream
expect(fixture.receivedSeqs).toEqual([1, 2, 3]);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** Go 执行事件携带稳定 source_event_id，TS 仅在 lease/fencing 合法时分配 seq 并持久化/outbox 后 ACK。同 ID 同内容返回原 ACK，内容冲突 409；ACK 丢失重传同提案。自有前端/协议中间件派生事件也必须过 EventService，不在浏览器绕过写入。订阅以 DB 水位衔接重放与 live，定期复核权限，限额和游标错误来自配置/Schema；多 TS 进程通过持久 outbox/DB 唤醒机制同步，内存广播不是主状态。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/event-replay.integration.test.ts；go test ./internal/callback -count=1（runtime-go）`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-04、AC-05、AC-07；两个 TS 进程、ACK 重传、重放窗口并发追加、跨主体游标及撤权覆盖。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 8: 自有 AgentRunner 与后端 SDK 兼容

**Depends on:** Task 7。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/runtime/platform-runner.ts`、`server/src/runtime/copilot-handler.ts`、`server/src/runtime/thread-routes.ts`、`server/src/runtime/bootstrap.ts`、`server/tests/enterprise/platform-runner.test.ts`、`server/tests/enterprise/copilot-transport.test.ts`。
- **Modify existing:** `server/src/copilot.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：RunService、ConversationService、EventService、ScopeResolver；锁定 SDK AgentRunner 接口与现有 Agent middleware。Produces：createPlatformRunner(deps: PlatformRunnerDeps, scope: PlatformScope): AgentRunner；createPlatformCopilotHandler(deps: PlatformCopilotDeps): (request: Request) => Promise<Response>；createPlatformRuntime(deps: PlatformRuntimeDeps): PlatformRuntime。

- [ ] **Step 1 — RED 测试：** 写 `concurrent_users_do_not_share_runner_scope`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：concurrent_users_do_not_share_runner_scope
expect(fixture.userBEvents.some((event) => event.runId === fixture.userARunId)).toBe(false);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 以自有 runner 的 SSE mode 创建 CopilotRuntime，不传 intelligence/channels/ɵlearning。runner 实现 run/connect/isRunning/stop，使用平台服务及确认事件，不用 InMemoryAgentRunner。每请求捕获不可变 scope，禁止共享 runner 可变 actor。数据库历史接口由自己的异步 routes 截获，禁止伪装 SDK 同步 LocalThreadEndpointRunner 返回 Promise。保留已授权 agent loader、remote AG-UI/Mastra、中间件和生成式 UI；它们产生的事件统一持久化，外部 Agent 也绑定平台 Run/权限与调用治理。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/platform-runner.test.ts server/tests/enterprise/copilot-transport.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-02、AC-03、AC-05；Task 1 黄金样本、清空所有线程越权、库故障不变空历史、remote adapter 覆盖。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 9: 前端聊天、工具与重连兼容

**Depends on:** Task 8。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:**

- **Create:** `app/src/lib/copilot/platform-transport.ts`、`app/src/lib/copilot/platform-transport.test.ts`、`tests/runtime/chat-journey.ts`。
- **Modify existing:** `app/src/lib/copilot/provider.tsx`、`app/src/lib/copilot/conversation.tsx`、`app/src/lib/copilot/thread-messages.ts`、`app/src/lib/copilot/join-thread.ts`、`app/src/lib/copilot/repair-history.ts`、`app/src/lib/copilot/stopped-turn.ts`、`app/src/components/channels/channel-chat.tsx`、`app/src/components/channels/conversation-view.tsx`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：createPlatformCopilotHandler wire、ConversationDTO、EventDTO；现有 CopilotKit React 和工具组件。Produces：createPlatformTransport(options: PlatformTransportOptions): PlatformTransport；既有组件通过同一后端消费历史、运行和订阅。

- [ ] **Step 1 — RED 测试：** 写 `account_switch_discards_previous_thread_subscription`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：account_switch_discards_previous_thread_subscription
expect(await fixture.visibleMessagesAfterAccountSwitch()).not.toContain(fixture.privateMessage);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 沿 Task 1 捕获协议接入自有后端，保留聊天/附件/工具/审批渲染和 opt-out generative UI 行为。游标与消息键绑定当前用户、thread，账号切换清除旧订阅并重新授权；断线显示真实状态，不用修复历史逻辑删除尚未确认消息。禁止把刷新或多标签页 connect 当作新 Run。真实浏览器测试覆盖模型文本、附件、前端工具、审批等待和 activity UI；若 SDK transport 不兼容，仅修改 provider/transport 接缝。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test app/src/lib/copilot/platform-transport.test.ts；bun tests/runtime/chat-journey.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-02、AC-03、AC-04、AC-05；真实浏览器刷新/重连/两标签/账号切换，不能只用组件 mock。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 10: 平台检查点、取消与审批恢复

**Depends on:** Task 9。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/runs/checkpoints.ts`、`server/src/enterprise/runs/recovery.ts`、`server/src/enterprise/runs/recovery-routes.ts`、`server/tests/enterprise/recovery.integration.test.ts`。
- **Modify predecessor delivery:** `server/src/enterprise/runs/service.ts`、`server/src/enterprise/runs/store.ts`、`server/src/enterprise/tools/receipts.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：RunService、EventService、ToolService、CheckpointDTO；已验证 SDK/前端流程。Produces：CheckpointService.read(scope, runId: string): Promise<CheckpointDTO | null>；propose(scope, input: CheckpointProposal): Promise<CheckpointAck>；RecoveryService.resume(scope, input: ResumeInput): Promise<RunDTO>。

- [ ] **Step 1 — RED 测试：** 写 `unknown_receipt_blocks_resume_without_repeating_effect`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：unknown_receipt_blocks_resume_without_repeating_effect
await expect(fixture.recovery.resume(fixture.scope, fixture.unknownReceiptResume)).rejects.toMatchObject({ code: "reconciliation_required" });
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 检查点包含总计划版本/摘要/消息/operation/待审批/预算/产物引用，引用必须已经确认；合法 attempt/fencing 才可写入。取消先持久化再通知 Go；旧 attempt 提交拒绝。审批恢复保留业务 run，换 turn/必要时换 attempt；unknown/submitted 回执进入对账，不能自动重做副作用。schema/runtime 兼容不满足时 suspended 并给明确原因；恢复用事务 CAS 防双执行。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/recovery.integration.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-06、AC-07；数据库和 TS 重启、取消竞争、检查点引用伪造、不兼容版本与 double resume。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 11: Go 恢复接缝及跨进程故障验证

**Depends on:** Task 10。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `runtime-go/internal/adapter/recovery.go`、`runtime-go/internal/adapter/recovery_test.go`、`runtime-go/internal/callback/checkpoints.go`、`runtime-go/internal/callback/checkpoints_test.go`、`server/scripts/runtime-fault-probe.ts`、`server/tests/enterprise/runtime-recovery.test.ts`。
- **Modify predecessor delivery:** `runtime-go/internal/server/assembly.go`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：CheckpointService、RecoveryService、EventService；Task 6 assembly 与 Task 7 callback。Produces：Go RestoreAgent(ctx context.Context, checkpoint PlatformCheckpoint, deps RecoveryDeps) (agent.Agent,error)；跨进程故障报告 runtime-recovery-report.json。

- [ ] **Step 1 — RED 测试：** 写 `go_restart_uses_confirmed_receipt_and_fences_old_attempt`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：go_restart_uses_confirmed_receipt_and_fences_old_attempt
expect(fixture.externalEffectCountAfterRestart).toBe(1);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 根据平台确认快照重建锁定版本执行上下文，待审批工具仅消费已确认回执，不将整个 SDK graph/run 盲目重放。Go cancellation 释放资源但保留平台决定；失去 lease 后停止产生可执行请求。probe 在运行启动、工具 submitted、回执写入、checkpoint ACK、事件 ACK 和取消阶段分别 kill Go/TS，验证 fencing 与恢复；不支持恢复的框架阶段显式 suspended，报告原因并作为真实业务阻塞处理。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `go test ./... -count=1（runtime-go）；bun test server/tests/enterprise/runtime-recovery.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-06、AC-07；真实进程故障，报告与当前源文件 SHA256 绑定。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 12: 定时任务、频道、handoff 与后台入口

**Depends on:** Task 11。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/tests/enterprise/headless-entrypoints.test.ts`、`server/tests/enterprise/channel-runtime.test.ts`。
- **Modify existing:** `server/src/routines/run-turn.ts`、`server/src/routines/runner.ts`、`server/src/work/loop.ts`、`server/src/channels/events.ts`、`server/src/channels/group.ts`、`server/src/channels/thread-routes.ts`、`server/src/agents/handoff-runner.ts`、`server/src/agents/wake-up.ts`、`server/src/voice/summary.ts`、`server/src/index.ts`、`worker/src/index.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：createPlatformRuntime、RunService、ConversationService、ResourceReader；既有 routine/handoff/voice/demonstration/memory 调用点。Produces：runPlatformTurn(scope: PlatformScope, input: HeadlessTurnInput): Promise<HeadlessTurnResult>；既有入口通过平台服务调用并产生同一账本。

- [ ] **Step 1 — RED 测试：** 写 `scheduled_turns_without_browser_preserve_owner_and_run_once`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：scheduled_turns_without_browser_preserve_owner_and_run_once
expect(fixture.runsForFiring(fixture.firingKey)).toHaveLength(1);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 移除无界面入口 IntelligenceLike/private ɵ 锁方法，保留任务拥有者、initiator、可撤销 delegation 及稳定 firing key。全仓检索 getThreadMessages/getOrCreateThread 等，迁移 titler/summary、演示/记忆 ingestion、语音总结等实际调用点，允许新增局部 adapter 文件并记录 ownership 增量。群聊及 multi Bot 不在 SSE Runtime 传 channels，而由 OpenBot 自有调度与权限调用 runPlatformTurn；handoff 复核 grant 和递归/调用限额。切换调度所有权时停止旧路径并确认活动 Run，重复 firing 不创建第二个运行。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/headless-entrypoints.test.ts server/tests/enterprise/channel-runtime.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-03、AC-05、AC-08；无浏览器聊天、群聊参与者、定时任务撤权、handoff、summary/voice/demonstration 链路。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 13: 复用个人记忆并补齐来源与删除传播

**Depends on:** Task 12。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/db/schema/enterprise-memory-provenance.ts`、`server/tests/enterprise/memory-provenance.integration.test.ts`。
- **Modify existing:** `server/src/memory/store.ts`、`server/src/memory/ingestion.ts`、`server/src/memory/tools.ts`、`server/src/memory/routes.ts`、`server/src/memory/types.ts`、`server/src/db/schema/memory.ts`、`server/src/db/schema/index.ts`、`server/drizzle.config.ts`、`server/drizzle/`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：ConversationService、ResourceReader、RunService；现有 personalMemories/source/reviewState。Produces：MemoryProvenanceService.record(scope, input: MemorySourceReference): Promise<void>；forgetSource(scope, source: MemorySourceReference): Promise<DeletionReceipt>；现有 createMemoryStore 保持兼容。

- [ ] **Step 1 — RED 测试：** 写 `deleted_source_is_not_relearned_or_returned_to_another_user`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：deleted_source_is_not_relearned_or_returned_to_another_user
expect(await fixture.recalledAfterSourceDeletion()).toEqual([]);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 在已有记忆表/服务上扩展来源 conversation/message/revision、作用域和删除链，不新建竞争 MemoryStore。查询同时重验主体、Bot grant、来源 ACL 与 deleted 状态；未确认候选不进入生产上下文。用户更正或删除来源使派生记录失效/重新审核并记录删除 outbox，备份按保留策略处置；旧 source/provenance 字段保留兼容。现有 /memory 页面及工具行为继续有效。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/memory-provenance.integration.test.ts server/tests/memory-runtime.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-05、AC-09；更正/删除/撤权/重新 ingestion、同文本跨用户和已遗忘内容覆盖。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 14: 自有学习作业、候选审核与版本发布

**Depends on:** Task 13。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/learning/jobs.ts`、`server/src/learning/candidates.ts`、`server/src/learning/skills.ts`、`server/tests/enterprise/learning-pipeline.integration.test.ts`。
- **Modify existing:** `server/src/learning/runtime.ts`、`server/src/learning/routes.ts`、`server/src/learning/settings.ts`、`server/src/learning/remote.ts`、`server/src/db/schema/learning.ts`、`server/src/db/schema/index.ts`、`server/drizzle/`、`shared/learning.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：RunService、MemoryProvenanceService、ModelGateway、ResourceReader；现有 learning settings/first-thread bindings。Produces：LearningService.enqueueCompleted(scope, runId: string): Promise<LearningJobDTO | null>；review(scope, input: CandidateReviewInput): Promise<SkillCandidateDTO>；publish(scope, candidateId: string): Promise<SkillVersionDTO>；acquire(scope, input: SkillSelection): Promise<SkillSnapshot>。

- [ ] **Step 1 — RED 测试：** 写 `learning_off_and_unreviewed_candidates_never_publish`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：learning_off_and_unreviewed_candidates_never_publish
expect(await fixture.learning.acquire(fixture.scope, fixture.selection)).toMatchObject({ skills: [] });
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 保存既有 enabled/off 设置与 Bot 范围绑定，将外部 container 转为平台学习集合映射，不复制不可读取的外部技能。分析为持久后台作业，使用受控模型路由/预算；任务键去重，失败和证据可查询。候选先授权审核/评测，再创建不可变版本；运行加载已发布快照，现有 skill tools 接口可适配版本快照。学到的技能不能把任意代码变成未授权执行路径。来源删除传播到候选/快照可用性；停止外部 inspector/registry 调用。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/learning-pipeline.integration.test.ts server/tests/learning-runtime.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-05、AC-09；作业重试不重复发布、设置 off、两用户作用域、已发布版本运行内稳定。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 15: 学习管理页面与自有能力显示

**Depends on:** Task 14。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:**

- **Create:** `app/src/lib/learning/queries.test.ts`、`tests/runtime/learning-journey.ts`。
- **Modify existing:** `app/src/routes/_authed/admin/learning.tsx`、`app/src/lib/learning/queries.ts`、`app/src/lib/deployment/queries.ts`、`app/src/components/layout/self-host-banner.tsx`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：LearningService HTTP DTO、现有 learning settings UI 与本地 billing/capabilities。Produces：学习管理页面使用自有作业/证据/候选/审核/版本接口；无 Intelligence inspector 外链和套餐控制。

- [ ] **Step 1 — RED 测试：** 写 `private_learning_evidence_is_not_rendered_after_revocation`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：private_learning_evidence_is_not_rendered_after_revocation
expect(await fixture.visibleEvidenceAfterRevocation()).toEqual([]);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 提供作业状态、失败原因、候选证据、审核/发布及版本列表；保持关闭设置不被重置。普通用户和无资源授权管理员不能读取私有学习证据。删除来源后的失效状态在 UI 可见；自有能力显示从本地服务读取，不调用 Intelligence entitlements。修改现有 `app/src/components/layout/self-host-banner.tsx` 的展示与依赖，保留当前挂载位置。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test app/src/lib/learning/queries.test.ts；bun tests/runtime/learning-journey.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-01、AC-05、AC-09；真实浏览器关闭/审核/发布/失败重试/撤权与版本显示。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 16: 旧历史与技能资料导入及单写切换

**Depends on:** Task 15。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/runtime/migration/export.ts`、`server/src/runtime/migration/import.ts`、`server/src/runtime/migration/cutover.ts`、`server/scripts/migrate-intelligence-history.ts`、`server/tests/enterprise/history-import.integration.test.ts`、`server/tests/enterprise/fixtures/intelligence-export.json`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：ConversationService、RunService、LearningService；获准旧导出数据。Produces：importLegacyArchive(scope, archive: LegacyArchive, options: ImportOptions): Promise<ImportReport>；cutoverConversation(scope, input: CutoverInput): Promise<CutoverReceipt>。

- [ ] **Step 1 — RED 测试：** 写 `partial_export_cannot_mark_cutover_complete`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：partial_export_cannot_mark_cutover_complete
await expect(fixture.cutoverConversation(fixture.scope, fixture.incompleteCutover)).rejects.toMatchObject({ code: "incomplete_archive" });
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 冻结导出 schema 保存原始来源 ID、parts、附件、Bot/user/channel、记忆及已发布技能资料；dry-run 先核对身份映射/数量/hash/引用。合成夹具验证完整性和幂等；真实导出命令必须显式提供授权来源、输出目录和 scope，不读取默认 .env。切换先冻结写入并等待活动 Run 收敛，同事务 CAS storage_backend 后恢复平台写入。不可导出字段和不完整资料列为未完成；已有新消息后禁止直接回指旧线程，使用平台备份恢复。过渡只读 adapter 单独配置并可禁用。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/history-import.integration.test.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-09、AC-10；顺序/parts/附件/grants/技能资料、重复导入、活动 Run、导入失败及后切换回退禁止。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 17: 自有模式默认配置、bootstrap 与部署

**Depends on:** Task 16。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/src/enterprise/bootstrap.ts`、`server/src/enterprise/app.ts`、`server/src/enterprise/index.ts`、`docker/runtime-go.Dockerfile`、`charts/openbot/templates/runtime/deployment.yaml`、`charts/openbot/templates/runtime/service.yaml`、`server/tests/enterprise/platform-config.test.ts`、`tests/runtime/deployment-offline.test.ts`。
- **Modify existing:** `server/src/config.ts`、`server/src/index.ts`、`server/src/app.ts`、`server/src/self-host-banner.ts`、`server/src/intelligence-client.ts`、`.env.example`、`docker-compose.yml`、`charts/openbot/values.yaml`、`charts/openbot/templates/configmap.yaml`、`charts/openbot/templates/validation.yaml`、`charts/openbot/templates/secret.yaml`、`charts/openbot/templates/externalsecret.yaml`、`charts/openbot/templates/networkpolicy.yaml`、`scripts/start.sh`、`scripts/setup-learning.ts`、`scripts/self-hosted-learning.ts`。
- **Modify predecessor delivery:** `server/src/runtime/bootstrap.ts`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：createPlatformRuntime、ScopeResolver、ModelGateway、迁移结果；既有认证/账务/组织连接和部署配置。Produces：RuntimeCapabilities 的 platform 模式；PlatformRuntimeConfig；自有 TS/Go bootstrap、隔离内部 listener、Compose/Helm 交付。

- [ ] **Step 1 — RED 测试：** 写 `clean_platform_configuration_starts_without_intelligence`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：clean_platform_configuration_starts_without_intelligence
expect(fixture.configFromEnvironmentWithoutIntelligence().runtime.mode).toBe("platform");
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 新安装默认 platform 且不要求 Intelligence URL/key/licence；过渡历史导出配置仅进入专用 migration 工具。保留当前 OAuth、组织模式、桌面模型计划、billing 行为，逐个迁移对 config.runtime.intelligence 的调用。内部 listener 单独绑定及认证，公网不挂内部工具/validation。Compose/Helm 加入 Go 服务与受控模型出口，Go 无 DB 网络权限/长期密钥；local startup 不初始化外部学习项目。readiness 分别检查必要自有依赖，liveness 无付费探测。旧正常运行 client 和付费 banner 在全仓调用迁移后删除。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/platform-config.test.ts tests/compose.test.ts；bun tests/runtime/deployment-offline.test.ts；helm lint charts/openbot`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-01、AC-02、AC-11；干净部署、Helm render/network boundary、无外部 DNS 可正常运行。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 18: 桌面原生安装与连接迁移

**Depends on:** Task 17。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `desktop/src-tauri/src/platform_runtime.rs`。
- **Modify existing:** `desktop/src-tauri/src/lib.rs`、`desktop/src-tauri/src/plan.rs`、`desktop/src-tauri/src/env.rs`、`desktop/src-tauri/src/preparation.rs`、`desktop/src-tauri/src/acquire.rs`、`desktop/src-tauri/src/deployment.rs`、`desktop/src-tauri/src/deployment_release.rs`、`desktop/src-tauri/src/stack.rs`、`desktop/src-tauri/src/intelligence.rs`、`desktop/src-tauri/src/self_hosted_intelligence.rs`、`desktop/src-tauri/src/desktop_connection.rs`、`desktop/src-tauri/src/saved_intent.rs`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：PlatformRuntimeConfig 与新 Compose 制品；既有 installation/saved intent/organization/provider contracts。Produces：`platform_runtime_status() -> Result<PlatformRuntimeStatus, Problem>`、`platform_runtime_prepare(input: PlatformSetupInput) -> Result<PlatformSetupResult, Problem>`、`platform_runtime_reconnect(input: PlatformReconnectInput) -> Result<PlatformRuntimeStatus, Problem>`；状态DTO在同任务定义，桌面模型/组织凭据类型维持现有独立含义。

- [ ] **Step 1 — RED 测试：** 写 `old_saved_intent_restores_without_intelligence_key`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```rust
// 核心断言：old_saved_intent_restores_without_intelligence_key
assert!(restored.platform_runtime.is_some());
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 移除 Intelligence sign-in/project/licence 命令、安装步骤及保存配置要求，新增 platform runtime 启动/readiness。安装包和恢复流程包含 Go 制品与数据库；旧 saved intent 只迁移部署选项，不把 Intelligence key 当组织 token。保留组织/供应商/工具登录，更新 connection failure 分类和用户可读状态；窗口关闭/取消安装不会留下无归属子进程。所有 native command wire DTO 写到共享夹具供 Task 19 消费。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `cargo test --manifest-path desktop/src-tauri/Cargo.toml platform_runtime；cargo check --manifest-path desktop/src-tauri/Cargo.toml`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-01、AC-07、AC-11；旧保存设置、新安装、重新启动、组织模式和模型刷新独立。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 19: 桌面初始化界面与各客户端验收

**Depends on:** Task 18。**Roles:** frontend_implementer → frontend_validator → reviewer。

**Files / ownership:**

- **Create:** `tests/runtime/desktop-setup-journey.ts`、`tests/runtime/mobile-chat-journey.ts`。
- **Modify existing:** `desktop/src/App.tsx`、`desktop/src/App.test.tsx`、`desktop/src/telemetry.ts`、`desktop/src/telemetry.test.ts`、`desktop/src/Problem.tsx`、`desktop/src/HarnessPicker.tsx`、`desktop/src/ProviderPicker.tsx`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：Task 18 Tauri command DTO；Task 9 transport；既有 OrganizationSignIn/ProviderPicker。Produces：无 Intelligence 账号/project/key 的可恢复安装向导与 Web/移动/桌面相同聊天行为。

- [ ] **Step 1 — RED 测试：** 写 `setup_needs_model_and_deployment_but_no_intelligence_account`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：setup_needs_model_and_deployment_but_no_intelligence_account
expect(screen.queryByText(/Intelligence API Key/i)).toBeNull();
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 移除 Intelligence 初始化 state/screens/constants，默认托管 runtime 使用 Go，同时保留远端 Bot 注册入口和独立模型选择。安装/更新/失败重试与 saved intent 都消费平台状态；本地和组织部署都无外部 Intelligence 必填项。使用真实页面验证聊天/附件/工具/取消和重新打开，不强行把 React Web 组件搬到移动端；移动入口只改存在的协议适配差异并登记文件所有权。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test desktop/src/App.test.tsx desktop/src/telemetry.test.ts；bun run --cwd desktop typecheck；bun tests/runtime/desktop-setup-journey.ts；bun tests/runtime/mobile-chat-journey.ts`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-01、AC-03、AC-11；桌面前进/返回/取消/重连、mobile client 请求与历史。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

### Task 20: 完整交付审计、依赖风险与离线验收

**Depends on:** Task 19。**Roles:** backend_implementer → backend_validator → reviewer。

**Files / ownership:**

- **Create:** `server/scripts/runtime-acceptance.ts`、`server/tests/enterprise/intelligence-removal.test.ts`、`docs/plans/2026-10-09-trpc-intelligence-evidence.md`。
- **Modify existing:** `runtime-go/dependency-review.json`、`runtime-go/testdata/compatibility-report.json`、`README.md`、`reference/architecture.md`、`reference/configuration.md`、`reference/deployment.md`、`reference/development.md`、`reference/automatic-learning.md`、`reference/coworkers.md`、`reference/releasing.md`、`charts/openbot/README.md`、`scripts/architecture-diagram.ts`、`assets/architecture-light.svg`、`assets/architecture-dark.svg`。

迁移目录只拥有本任务新增文件及 journal/snapshot 增量；已有源文件局部修改，不覆盖前置交付。

**Interfaces:** Consumes：全部 Task 检查点及验收证据；原始 BASE 到交付范围；当前完整依赖图。Produces：AC-01–AC-12 汇总、完整依赖扫描报告、持久执行/Review/OCR 证据索引。

- [ ] **Step 1 — RED 测试：** 写 `runtime_import_graph_has_no_intelligence_service_dependency`，准备有效请求/存储/权限，再触发该场景并固定以下断言；其余负例按验收栏落实。

```ts
// 核心断言：runtime_import_graph_has_no_intelligence_service_dependency
expect(fixture.requiredIntelligenceConnections).toEqual([]);
```

- [ ] **Step 2 — 确认 RED：** 运行下述针对性命令。预期新增行为断言失败或缺少待实现导出；若环境/工具不可用则记录阻塞并准备独立环境，不声称完成 RED。
- [ ] **Step 3 — 实现：** 审计所有 Intelligence imports、配置、URL、私有锁方法和实际外连；只能允许已记录的过渡导出工具，最终运行不得依赖旧服务。重新核对当前 Go/Bun SDK 版本、go mod verify/govulncheck 与安全升级，升级需契约回归；有效高风险不能以记录代替修复。无外部网络部署测试、重启故障集及三客户端流程汇总后更新文档和架构图。真实数据尚无权限时明确 synthetic 通过/真实迁移未完成，不宣称最终生产切换完成。
- [ ] **Step 4 — 回归及自查：** 运行新增用例和被修改入口的既有相关测试，确认许可/错误/取消分支；删除重复逻辑，不扩大到无关改动。
- [ ] **Step 5 — 验证：** `bun test server/tests/enterprise/intelligence-removal.test.ts；bun server/scripts/runtime-acceptance.ts；go mod verify、go vet ./...、go test ./... -count=1、govulncheck ./...（runtime-go）；bun run typecheck；bun run lint；bun run build`。预期 exit 0、核心用例实际执行且无 skip 冒充验收；需要 DB/Go/浏览器的验证独立启动隔离环境，保存完整输出与源文件hash。
- [ ] **Step 6 — 检查点与独立审查：** 保存本任务增量快照，派发上述 validator 与 reviewer；Spec compliance 和 quality 都通过、证据绑定同一hash后标 verified。不执行 git commit。

**Acceptance / failure handling:** AC-01–AC-12；构建、依赖风险、实际外连与故障报告齐全；独立 Review/OCR 由主控另行执行。真实阻塞记录为 blocked，前置未 verified 的下游保持 pending；纠正范围/接口时先更新计划与 Ruling，禁止降低验收以结束任务。

## 全范围 Review、OCR 与修复

所有 Task 验证与任务 Review 后，主控派发 `default + gpt-6-astra/high` 做完整实现范围独立审查，提供批准规格、计划、原始 BASE、全部未提交检查点及验收索引；该角色仅审查、不再次派发 Agent。专业实现角色模型不靠 spawn 参数假装升级；需升级时按用户 AGENTS 规则记录阻碍和显式模型，再使用 default。

主控使用 open-code-review Skill 直接执行 `ocr review --audience agent --workspace --background <本次迁移背景文件内容> --output <本轮完整报告路径>`，以实际 OCR Skill 支持的 workspace 参数为准，不猜测未支持选项。当前全部未提交，无需空 BASE..HEAD 审查；如果后续获得授权产生提交，则额外 `--from fbdecc29cd786952c4b496abc68384b31a320b17 --to <实际HEAD>` 覆盖。ignored 文档先显式列入交付快照，不能假设 OCR 自动覆盖忽略文件。

报告按轮次保存 exit code、覆盖文件、失败/跳过/警告。所有有效 critical/high/medium 必须修复：保留 finding ID、证据及 ruling，生成只覆盖 findings 的编号修复计划，writing-plans → SDD 对应专业实现角色 → validator → reviewer → OCR 复审。连续两轮同问题无进展触发 systematic-debugging 并升级上下文/模型。缺安装按 Skill 安装；provider/凭据失败明确阻塞，不编造凭据。

完整证据汇总写 `docs/plans/2026-10-09-trpc-intelligence-evidence.md`，包括验收状态、hash、实际测试、Review/OCR范围及 ruling。任何 G1b/G2、真实历史切换或生产效果缺证据时明确未完成。最后依 finishing-a-development-branch 收尾；无提交/推送授权则保留工作区和未提交交付，不删除所需 ignored 文档或计划证据。

## 自查与执行前预检

预检逐行记录在关联文件：每个 Task 内部测试/接口/文件一致性，以及每一对共享文件/接口的生产-消费关系。全部 12 条 AC 在 DAG 验收映射覆盖；节点唯一、引用存在、无自环/循环且所有任务可由入口到达。Task 1 提供公共 DTO，后续只实现所属服务；Schema/journal、service.ts 和 bootstrap 共享路径按串行检查点运行，禁止并行写入。

计划是可审阅的执行依据，尚未完成任何业务验收。用户确认计划后继续 SDD，不再询问执行方法，不在任务间询问是否继续。真实数据导出、对外部署、共享分支合并仍按独立授权边界处理。
