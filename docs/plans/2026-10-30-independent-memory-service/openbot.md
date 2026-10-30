# OpenBot 接入与整体交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans；用户选择多 Agent 后才使用 superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenBot 以稳定身份调用独立记忆服务，支持内嵌管理，并删除旧记忆运行路径。

**Architecture:** 服务器保留业务来源授权并通过最小客户端取得记忆；浏览器的记忆管理由独立 React/HeroUI 页面承载。OpenBot 全局身份通过独立中心认证，本地业务目录与资源授权维持唯一写入者。

**Tech Stack:** 现有 Bun/Hono、React/TanStack/HeroUI；MEMORY 客户端；Better Auth OIDC 客户端；现有 e2e 运行器。

**Spec:** [已批准 Spec v3](../../specs/2026-10-30-independent-memory-service-design.md)。消费[跨仓库合同](contracts.md)，全局约束与 Review Focus 继承[计划入口](README.md)。路径相对当前 OPENBOT 仓库。

## Global Constraints

所有现有改动先核归属，不能覆盖他人正在修改的 memory UI、runtime 或 auth 文件。旧记忆数据不迁移、不删除；删除旧路径不得删除非记忆 Bot 生命周期功能。浏览器数据访问、页面布局和产品文案遵守相应 OpenBot skills。

## Review Focus

O01 负责身份连续和会话撤销；O02 负责来源伪造与所有运行入口；O03 负责内嵌登录/退出/深链接；O04 负责旧路径残留；Z01 验证跨仓库组合而非仅单仓单元通过。

### O01：统一身份客户端与本地兼容投影

**Files:** Create `server/src/auth/identity-center-client.ts`、`server/src/auth/subject-projection.ts`、`server/tests/identity-center-client.test.ts`、`server/tests/identity-center-continuity.test.ts`；Modify `server/src/auth/index.ts`、`server/src/auth/guards.ts`、`server/src/auth/public.ts`、`server/src/auth/directory/principal-registry.ts`、`server/src/config.ts`、`.env.example`。必要投影 schema/迁移在执行基线核查后新增，不更新或删除旧记忆表。

**Interfaces:** 消费 I01/I02；`resolveCenterActor(request: Request): Promise<AuthenticatedActor | null>` 返回现有 guards 使用的 AuthenticatedActor，角色仍从 OpenBot 自己的受控角色事实读取；`projectVerifiedSubject(ref: SubjectRef): Promise<{ userId: string; principalId: string }>` 仅写稳定映射/必要兼容字段。

- [ ] 写 `center_subject_reuses_existing_user_and_principal`、`same_email_does_not_merge_users`、`disabled_center_subject_is_not_revived`、`company_admin_is_not_platform_admin`、`local_projection_cannot_register_independent_identity`。
- [ ] 经 ADR 0008 的实际分区运行这两个具名 suite，确认预期失败；原生入口为 `E2E_UNIT_SCOPE=server bun run test server/tests/identity-center-client.test.ts server/tests/identity-center-continuity.test.ts`。有真实 Bun 耦合时先登记分区，再分别执行 `E2E_BUN_ONLY=server/tests/identity-center-client.test.ts bun run test tests/bun-suites.test.ts` 和 `E2E_BUN_ONLY=server/tests/identity-center-continuity.test.ts bun run test tests/bun-suites.test.ts`，从报告核对两个文件确实执行。
- [ ] 实现 OIDC 客户端及中心状态验证，保留稳定 userId/principalId；关闭本地独立注册、账户编辑与停用写权或改为中心受控调用。公司/团队目录命令保留原受控执行器，不能借 OIDC claim 直接授予业务角色或绕开本地撤权事务。
- [ ] 同一 suite 转绿；验证中心故障的具名拒绝、旧本地登录不能回退、历史资源/成员/订单引用未变。在隔离 fixture 验证切换和切换前中止，真实身份导入另依授权。

### O02：来源核验与统一运行客户端

**Files:** Create `server/src/memory-service/client.ts`、`server/src/memory-service/context.ts`、`server/src/memory-service/source-check.ts`、`server/src/memory-service/cleanup.ts`、`server/src/memory-service/routes.ts`、`server/tests/memory-service-source-check.test.ts`、`server/tests/memory-service-runtime.test.ts`；Modify `server/src/assembly/runtime.ts`、`server/src/assembly/http.ts`、`server/src/copilot.ts`、`server/src/agents/agent-resolver.ts`、`server/src/config.ts`、`.env.example`。

**Interfaces:** 消费 MemoryClient/SourceCheck。`createMemoryContextLoader(deps): (scope: PlatformScope, botId: string) => Promise<{ content: string; result: RecallResult }>` 将返回正文转为现有执行上下文/依据格式；`checkOpenBotMemorySource(input: SourceCheck): Promise<SourceDecision>` 从签发引用重建范围，调用现有 Access/来源判定。

`applyMemoryCleanup(notification: VerifiedCleanupNotification): Promise<CleanupReceipt>` 定义在 `cleanup.ts`；VerifiedCleanupNotification 由记忆服务签名及通知归属验证器构造，不能从匿名回调直接断言。declarations、实际可控副本范围及未能控制的下游范围一并返回。

- [ ] 写 `source_ref_cannot_select_another_company_or_bot`、`membership_alone_does_not_authorize_external_consumer`、`browser_and_headless_use_same_authorized_loader`、`service_outage_continues_plain_chat_without_old_memory`、`memory_required_task_pauses`、`explicit_remember_requires_user_evidence`。
- [ ] 按 O01 相同分区方法运行两个具名 suite，确认预期失败；使用 stub HTTP 记忆服务，不能 mock 掉来源授权判定。
- [ ] 实现 `/api/memory-service/source-check` 和服务身份认证、来源引用签发/核验；客户端只从当前可信 scope 绑定本人，不采信 body 的 userId/tenantId。浏览器、频道、定时、后台及远程实际记忆消费者共用装载器；返回依据保持现有消息引用可解释。
- [ ] 测试转绿；分清服务整体故障与来源拒绝，捕获没有权限核验的旧副本使用。应用原始内容提交复用同一用户采集委托并保持幂等；清理通知接入后，受控副本如实回执，未控制的模型上下文/外发副本保持未完成。

### O03：侧栏内嵌与顶层登录回跳

**Files:** Create `app/src/components/memory-service/frame.tsx`、`app/src/lib/memory-service/queries.ts`、`app/src/lib/memory-service/mutations.ts`、`app/tests/memory-service-frame.test.tsx`、`tests/e2e/better-auth/web/memory-service.e2e.ts`；Modify `app/src/routes/_authed/_app/memory.tsx`、`app/src/components/app-sidebar/app-sidebar.tsx`、`app/src/lib/agents/legacy-routes.ts`、`app/src/routes/_authed/settings/memory.tsx`、`app/src/routes/_authed/_app/bots.$agentId.memory.tsx`、`server/src/memory-service/routes.ts`。旧 settings/Bot 链接改为新管理能力的受控入口，不留下旧表写入页面。

**Interfaces:** 消费 MEMORY embed 模式和四种消息。`MemoryServiceFrame({ src, allowedOrigin, requestId })` 只接收服务器配置的 URL；`GET /api/memory-service/entry` 返回当前会话适用的受控承载信息，不返回服务秘密。浏览器读写走现有 client 与 queryOptions/mutationOptions。

- [ ] 写 `frame_keeps_sidebar_and_has_no_second_navigation`、`wrong_origin_or_window_is_ignored`、`auth_message_cannot_choose_return_url_or_user`、`logout_clears_embedded_state`；UI 浏览器 suite 验证独立站/内嵌、深链接刷新、顶层登录回跳及会话失效。
- [ ] 运行具名 app suite 确认预期失败；真实浏览器通过 `e2e run --config e2e.better-auth.config.ts tests/e2e/better-auth/web/memory-service.e2e.ts`，先满足既有 Better Auth preflight，不改为默认 engine 绕过。
- [ ] 现有 `/memory` 改为内部承载页，保留 `_app` Outlet 和侧栏。首个 fixture 用同站 HTTPS + 明确宿主 Origin 的受控 iframe；顶层 OIDC 回跳只用登记的路径，拒绝消息中的任意地址。选定支持环境须验证存储受限条件；跨站部署不宣称未经验证的支持。
- [ ] app suite 与真实浏览器验收转绿，运行 `bun run --filter app typecheck`、`bun run --filter app build`。不能仅以外链能打开或 iframe 截图代替登录/授权/退出链路验收。

### O04：移除旧运行路径与旧界面写入

**Files:** Modify `server/src/assembly/runtime.ts`、`server/src/assembly/http.ts`、`server/src/copilot.ts`、`server/src/app.ts`、`server/src/agents/lifecycle-reset.ts`、`server/src/proactive/store.ts`、`server/src/proactive/engine.ts`、`app/src/lib/memory.ts`、`app/src/lib/hindsight/queries.ts`、`app/src/lib/hindsight/mutations.ts`；Create `server/tests/memory-service-no-legacy.test.ts`。`server/src/memory/`、`server/src/hindsight/` 及旧 UI 文件仅在实际消费者核清后删除对应旧记忆实现；不按目录通配符整删。

**Interfaces:** O02/O03 为唯一运行/管理入口。旧 `/api/memory`、`/api/hindsight` 记忆写入不继续挂载；依赖来源核验/非记忆功能的共用代码提取至具名当前所有者，不让新服务反向依赖旧 store。

- [ ] 写 `all_execution_surfaces_use_remote_client`、`old_memory_routes_cannot_mutate`、`service_failure_cannot_enable_legacy_loader`、`reset_does_not_delete_old_memory_data`；覆盖 Bot lifecycle 和 proactive 必需非记忆行为。
- [ ] 运行具名 suite 确认预期失败；同时用 `rg -n 'createMemoryStore|createHindsightRecallArm|createHindsightSyncArm|setMastraPersonalMemoryContext' server/src app/src` 建立实际消费者清单，区分还保留的协议装载器名称和旧实现调用，不能用 grep 零结果冒充行为测试。
- [ ] 删除旧 store/引擎记忆/默认采集及回退的运行接线、旧后台同步和界面写入；移除旧文档的现行入口并标替代。保留旧数据表和记录，不发 DROP、DELETE 或记忆 backfill，关闭可能继续清理旧记忆的旧 sweeper。
- [ ] 测试转绿，对当前 diff 再审所有消费者及 DB 写入点，证明只剩新客户端和来源核验。若非记忆职责仍消费 defaults，先将其按原行为独立保留，再删除旧路径。

### Z01：跨仓库集成、恢复与交付验证

**Files:** Create `tests/e2e/better-auth/web/memory-service-lifecycle.e2e.ts`、`server/tests/memory-service-cross-app.test.ts`、`scripts/memory-service-acceptance.ts`；必要测试收集清单按 ADR 0008 更新。各新仓库已有测试脚本和构建合同归各自 Task，不在此复制实现。

**Interfaces:** 消费三个仓库的已验证版本、协议与隔离 fixture；执行器输出每个 Spec A01–A19 的匹配场景和证据位置，失败/跳过保留真实状态。

- [ ] 在独立测试环境登记两个应用、两个本人、两个来源范围，准备可控的 OIDC/Hindsight/网关故障与副本回执；记录数据库、进程/镜像版本、请求身份、命名空间及清理 owner，不复用归属不明的现有栈。
- [ ] 先运行各仓库相关 unit/integration、typecheck/build；再通过既有 Better Auth e2e 配置运行两条浏览器 suite 和实际验收脚本。退出码为零仍须核非零用例数、真实收集、失败与跳过。
- [ ] 覆盖 A01–A19：跨应用/来源隔离、更正共享失效、临时来源失败与永久撤销、未知费用、片段期限、备份恢复、中心停用主体、OpenBot 停机而独立服务可用，以及两管理入口的登录退出。
- [ ] 独立 reviewer 完成真实行为与 Spec/质量验收；修复后复核受影响增量及组合链路，完整适用代码经 OCR，纯文档不送 OCR。证据归唯一 `.archive/runs/<run-key>/`，按实际输出记录未验证项。
- [ ] 按创建时归属清理 fixture 资源，核对实际删除/保留范围；仅在另行授权后提交、推送或部署。交付说明逐一列出身份中心、记忆服务、OpenBot 的可用版本及接入状态，不把本地实现当已上线。

## 适用测试命令说明

前述新 suite 要么 e2e 原生收集，要么因实际 Bun 耦合进入受驱动清单。当前 `tests/bun-suites.test.ts` 的 `E2E_BUN_ONLY` 接受单个完整文件或组名匹配字符串，不能传逗号分隔多文件，也不按任意文件路径前缀匹配。使用具名文件并核对报告。测试基础设施变更与产品行为分别验收，不能为了固定计划命令而改生产代码。
