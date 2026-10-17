# Company and Team Multi-Tenancy — Issue #6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use Orca-supervised Pi Dispatches for each task, with a same-task independent Pi reviewer. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the approved company/team isolation design across all 143 Tickets and reach a unified readiness gate only after every §8 business closure and applicable client path has positive and unauthorized-access evidence.

**Architecture:** Reuse the existing Tenant/Principal/Membership/Workspace and business stores. Add team membership and versioned team-public policy at current authorization seams; keep company-workbench billing separate from personal Bifrost billing. Implement the validated Ticket DAG in `docs/plans/2026-10-15-company-team-multitenancy-execution/dag.json`, preserving explicit Blocked by edges and expanding compatibility before migrating behavior and contracting only after consumers are migrated.

**Tech Stack:** Bun/TypeScript, Hono, Drizzle/PostgreSQL with RLS and restricted runtime roles, React/TanStack Query, Tauri/Rust, and the canonical OpenMuse submodule as actually present at BASE.

**Spec:** `docs/specs/2026-10-14-company-team-multitenancy-design.md`; ADR 0004, 0002, 0003; `CONTEXT.md`; GitHub Issue snapshot `docs/plans/2026-10-15-company-team-multitenancy-execution/github-intake.json`.

## Global Constraints

- “公司之间隔离；同公司团队之间默认互不可见。”
- “员工可以加入同一家公司的多个团队。”
- “加入团队后自动获得团队公共 Bot、公共知识库使用权；个人会话、文件和凭据保留个人权限。”
- “所有现有功能完成隔离后统一上线。实施允许分批，开放门槛统一。”
- “公司工作台采用公司统一余额，团队分别统计用量。”
- “外部 Bot 直连 Bifrost 保留已有个人余额机制，个人模型授权及独立撤销规则保留。”
- Team-public access is a new policy version; old `public` semantics do not widen. Personal ownership and explicit grants remain separate.
- Missing or invalid scope, unavailable authorization dependencies and RLS failures deny access; no default-tenant fallback.
- Database behavior is verified only against dedicated PostgreSQL with restricted business roles. Never fall back to development `DATABASE_URL`; skipped database tests do not pass.
- Migrations follow expand → migrate → contract; do not remove compatibility fields or paths until all consumers are migrated and verified.
- Company-workbench execution and company jobs charge the company account; authorized external Bot Bifrost calls charge the person. Account choice is server-fixed, and insufficient balance never switches accounts.
- Preserve each business Ticket as its bounded vertical slice; do not split into database/backend/frontend horizontal deliverables.
- No commits, push, merge, production migration, deployment, multi-tenant enablement, or release. Use content-addressed uncommitted checkpoints.
- Implementers and independent reviewers run only as Orca-supervised `--agent pi`; no worker spawns agents. Validators/reviewers are read-only.

## Review Focus

1. Cross-company resource IDs, credentials, callbacks, signed downloads and payment references never disclose existence or trigger side effects.
2. Same-company non-members and cross-team members cannot enumerate, retrieve, execute, subscribe, download or manage another team’s resources; valid membership has a positive control.
3. Revocation and company/team switches invalidate HTTP, stream, in-flight, cache, background-job and external-storage state at the next sensitive action.
4. Background workers trust persisted ownership and constrained machine identity, never queue/client tenant selectors; long tasks re-check scope and support cancellation.
5. Company and personal billing, retries, callbacks, idempotency and settlement retain one fixed payer with no fallback or duplicate charge/credit.

---

## Execution order and durable evidence

- Root Issue #6 contains 20 Epic groups and 143 independently accepted Tickets. The full machine DAG, acceptance, explicit Blocked by, role, verification and status are in `docs/plans/2026-10-15-company-team-multitenancy-execution/dag.json`; bodies and comments are in `github-intake.json`. `contains` edges are not execution dependencies.
- The one-row-per-Ticket task index follows. Each Orca Task Brief is generated from its single source Ticket and this DAG. Before dispatch, coordinator freezes actual current-HEAD file ownership, interfaces, preconditions, verification and checkpoint/review paths into that Brief. Overlapping files or shared state serialize with a single owner.
- Roots MT001, MT002 and MT103 form the initial wave. A Ticket becomes verified/integrated only after implementer evidence, independent Pi review, coordinator validation and hash-checked checkpoint transfer. Only then may dependents run.
- Checkpoint strategy: no commits. Record task BASE, staged/unstaged diff, full untracked file contents and SHA-256, commands/results and review package. Reviewer sees the same immutable checkpoint hash. Transfer only task delta to the coordinator integration worktree and verify hashes before opening dependents.

### Task 1: MT001 — Runtime entry inventory

**Source / dependency / roles:** Issue #44; no Ticket prerequisites. Owner `backend_implementer`; validator `backend_validator`; independent Pi reviewer.

**Files / ownership:** Create `server/scripts/multitenancy/inventory.ts` and `server/tests/multitenancy/inventory.test.ts`. Read actual current entry assembly in `server/src/app.ts`, `server/src/index.ts`, `server/src/production-entry.ts` and current Enterprise assembly; do not edit those entry files.

**Consumes / Produces:** Consumes approved Spec/ADR and current assembled routers. Produces CoverageInventory JSON and human-readable gap report with entrance/type/business closure/owning Ticket/status; route registration changes must affect generated output and drift test.

**Acceptance:** Ticket criteria and A6/A11 as preserved in #44 snapshot.

- [ ] RED: test dynamic/conditional actual route assembly and assert a new or removed registration changes inventory/gap output.
- [ ] GREEN: enumerate actual deployment and enterprise entries, background programs, tables and external dependencies. Do not use a manually maintained route list as source of truth.
- [ ] Run `bun test server/tests/multitenancy/inventory.test.ts`; run inventory command and capture JSON + gap report. Static inventory works without `TEST_DATABASE_URL`; DB-dependent portions explicitly disclose unavailable status.
- [ ] Save report/checkpoint, independent Pi review and coordinator ruling. No commit.

### Task 2: MT002 — Restricted PostgreSQL fixture harness

**Source / dependency / roles:** Issue #45; no Ticket prerequisites. Owner `backend_implementer`; validator `backend_validator`; independent Pi reviewer.

**Files / ownership:** Create `server/tests/multitenancy/support/fixture.ts`, `server/tests/multitenancy/support/scenarios.ts`, `server/tests/multitenancy/fixtures.test.ts`; modify `server/tests/support/enterprise-database.ts` only when necessary for the fixture contract.

**Consumes / Produces:** Consumes current enterprise role guard, real business factories and transaction context. Produces a reusable real-database fixture for two companies, three teams, all eight Spec identity classes and restricted-role transactions.

**Acceptance:** Ticket criteria and A6 as preserved in #45 snapshot.

- [ ] RED: test all eight identity classes, membership combinations, missing URL refusal, commit/rollback context cleanup and pooled-connection reuse.
- [ ] GREEN: construct fixture through real factories; do not mock the authorization path.
- [ ] Dedicated isolated PostgreSQL is at `postgres://postgres@127.0.0.1:55432/openbot_enterprise_issue6_test` (empty schema, ephemeral container); never use development `DATABASE_URL`. Provision/use restricted runtime role for business transactions.
- [ ] Run `bun test server/tests/multitenancy/fixtures.test.ts`. Treat skipped DB cases as not passed. Save hashes, output and independent Pi review; no commit.

### Task 3: MT103 — Canonical mobile submodule baseline

**Source / dependency / roles:** Issue #146; no Ticket prerequisites. Owner `implementer` (report-only); independent Pi reviewer.

**Files / ownership:** Create `docs/plans/2026-10-15-company-team-multitenancy-execution/mt103-canonical-mobile-baseline.md`; inspect `apps/openmuse` only inside this Ticket’s private child worktree.

**Consumes / Produces:** Consumes `.gitmodules`, parent gitlink and canonical source. Produces reproducible report of gitlink/canonical SHAs, missing adapter differences, commands, prerequisites and risks for MT104.

**Acceptance:** Ticket criteria and A11 as preserved in #146 snapshot.

- [ ] Record gitlink and canonical source versions/branches and compare adapter files without modifying coordinator or external main worktree.
- [ ] Establish a read-only nested submodule baseline in this task-private workspace; do not recreate deleted legacy mobile directory or modify production/mobile source.
- [ ] Record exact commands/outputs and report risks for MT104; this report-only task has no product test.
- [ ] Independent Pi reviewer verifies conclusions against the same checkpoint hash. No commit.

## Remaining Ticket tasks

Each row is a separate business-slice Task. Exact source acceptance, scope boundary and verification are in the snapshot and DAG. Before dispatch, coordinator performs current-code path/interface reconnaissance and writes one self-contained Task Brief; no guessed paths or unintegrated prerequisite stubs.

| Plan task | Ticket / Issue | Depends on | Owner / validator | Acceptance | Verification | Status |
|---|---|---|---|---|---|---|
| 4 | MT001 / #44 MT001 从真实装配生成全入口清单与覆盖缺口报告 | — | backend_implementer / backend_validator | see acceptance | `bun test server/tests/multitenancy/inventory.test.ts；清单生成命令输出 JSON + 缺口报告。` | ready |
| 5 | MT002 / #45 MT002 多公司多团队测试身份夹具与受限角色数据库 harness | — | backend_implementer / backend_validator | A6 | `bun test server/tests/multitenancy/fixtures.test.ts（含连接池复用泄漏用例）。` | ready |
| 6 | MT003 / #46 MT003 按任务生成迁移的安全迁移工具（dry-run/apply + manifest） | MT001 | backend_implementer / backend_validator | A6, A12 | `bun test server/tests/multitenancy/migration-tool.test.ts。` | blocked |
| 7 | MT004 / #47 MT004 团队成员关系数据模型与复合约束 | MT003 | backend_implementer / backend_validator | A1, A3 | `bun test server/tests/multitenancy/membership-model.test.ts。` | blocked |
| 8 | MT005 / #48 MT005 团队资格进入集中授权 seam 与事务内重验 | MT002, MT004 | backend_implementer / backend_validator | A1, A2, A5, A6 | `bun test server/tests/multitenancy/team-eligibility.test.ts。` | blocked |
| 9 | MT006 / #49 MT006 公司与团队列表、选择与管理入口 | MT005 | backend_implementer / backend_validator | A1, A3, A6 | `bun test server/tests/multitenancy/selection-api.test.ts。` | blocked |
| 10 | MT007 / #50 MT007 成员停用与撤权的级联生效与审计留痕 | MT005, MT006 | backend_implementer / backend_validator | A5, A2 | `bun test server/tests/multitenancy/revocation.test.ts。` | blocked |
| 11 | MT008 / #51 MT008 资源可见性属性与 workspace-v1 策略版本（expand） | MT005 | backend_implementer / backend_validator | A4, A2 | `bun test server/tests/multitenancy/resource-policy.test.ts。` | blocked |
| 12 | MT009 / #52 MT009 团队公共资源动作规则（可用不可改） | MT008 | backend_implementer / backend_validator | A4, A2, A3 | `bun test server/tests/multitenancy/team-public-rules.test.ts。` | blocked |
| 13 | MT010 / #53 MT010 个人资源权限与显式跨团队分享例外 | MT008 | backend_implementer / backend_validator | A1, A2, A3, A4 | `bun test server/tests/multitenancy/personal-share-rules.test.ts。` | blocked |
| 14 | MT011 / #54 MT011 无权对象按不可见处理，错误与计数不泄露存在性 | MT009, MT010 | backend_implementer / backend_validator | A2, A1 | `bun test server/tests/multitenancy/invisible-semantics.test.ts。` | blocked |
| 15 | MT012 / #55 MT012 核心租户域表的 RLS 与受限业务角色兜底 | MT002, MT008 | backend_implementer / backend_validator | A6, A1, A2 | `bun test server/tests/multitenancy/rls-core.test.ts（真实 PostgreSQL）。` | blocked |
| 16 | MT013 / #56 MT013 多租户模式开关与启动就绪校验 | MT001, MT005 | backend_implementer / backend_validator | A6, A11 | `bun test server/tests/multitenancy/readiness.test.ts。` | blocked |
| 17 | MT014 / #57 MT014 公司运行配置装配（替换部署级单份租户包） | MT013, MT006 | backend_implementer / backend_validator | A1, A6, A8 | `bun test server/tests/multitenancy/runtime-config.test.ts。` | blocked |
| 18 | MT015 / #58 MT015 缓存键与外部命名空间包含公司、团队与配置版本 | MT014 | backend_implementer / backend_validator | A8, A10, A1 | `bun test server/tests/multitenancy/cache-keys.test.ts。` | blocked |
| 19 | MT016 / #59 MT016 Bot 与配置的创建、列表、详情按公司团队归属 | MT014, MT009 | backend_implementer / backend_validator | A1, A2, A3 | `bun test server/tests/multitenancy/bots-ownership.test.ts。` | blocked |
| 20 | MT017 / #60 MT017 Bot 发布受众与旧 public 语义的显式迁移 | MT016 | backend_implementer / backend_validator | A2, A3, A4 | `bun test server/tests/multitenancy/bot-publish.test.ts。` | blocked |
| 21 | MT018 / #61 MT018 使用团队公共 Bot 时保持使用者自己的会话与凭据 | MT017, MT009 | backend_implementer / backend_validator | A4, A2, A1 | `bun test server/tests/multitenancy/public-bot-usage.test.ts。` | blocked |
| 22 | MT019 / #62 MT019 Bot 生命周期动作逐项授权（复制/隐藏/重置/删除/模板更新/远端回调） | MT016, MT017 | backend_implementer / backend_validator | A2, A4, A5 | `bun test server/tests/multitenancy/bot-lifecycle.test.ts。` | blocked |
| 23 | MT020 / #63 MT020 专家/模板安装与安装回执的公司团队归属 | MT016, MT017 | backend_implementer / backend_validator | A1, A2, A4 | `bun test server/tests/multitenancy/marketplace-install.test.ts。` | blocked |
| 24 | MT021 / #64 MT021 频道与会话列表、计数、分页游标的作用域 | MT016, MT014 | backend_implementer / backend_validator | A1, A2, A3 | `bun test server/tests/multitenancy/conversations-list.test.ts。` | blocked |
| 25 | MT022 / #65 MT022 消息读写、重命名、归档与历史 replay 的授权 | MT021 | backend_implementer / backend_validator | A2, A3, A4 | `bun test server/tests/multitenancy/conversation-messages.test.ts。` | blocked |
| 26 | MT023 / #66 MT023 群聊成员与 Bot 席位的作用域 | MT022, MT018 | backend_implementer / backend_validator | A1, A2, A3 | `bun test server/tests/multitenancy/group-membership.test.ts。` | blocked |
| 27 | MT024 / #67 MT024 附件暂存上传、绑定、下载签发与清理的归属 | MT022 | backend_implementer / backend_validator | A2, A5, A8 | `bun test server/tests/multitenancy/attachments.test.ts。` | blocked |
| 28 | MT025 / #68 MT025 事件流订阅授权与外部线程映射归属 | MT022 | backend_implementer / backend_validator | A2, A5, A10 | `bun test server/tests/multitenancy/streams.test.ts。` | blocked |
| 29 | MT026 / #69 MT026 公司 SSO/SCIM 配置归属与定向停用 | MT007, MT014 | backend_implementer / backend_validator | A1, A5, A7 | `bun test server/tests/multitenancy/sso-scim.test.ts。` | blocked |
| 30 | MT027 / #70 MT027 连接凭据与站点登录归属，可用不等于可读明文 | MT014, MT010 | backend_implementer / backend_validator | A1, A2, A5 | `bun test server/tests/multitenancy/credentials-ownership.test.ts。` | blocked |
| 31 | MT028 / #71 MT028 OAuth 回调按服务端 state 固定归属 | MT027 | backend_implementer / backend_validator | A7, A1, A5 | `bun test server/tests/multitenancy/oauth-state.test.ts。` | blocked |
| 32 | MT029 / #72 MT029 凭据取用 lease：固定用途、作用域且可撤销 | MT027, MT018 | backend_implementer / backend_validator | A2, A5, A4 | `bun test server/tests/multitenancy/credential-lease.test.ts。` | blocked |
| 33 | MT030 / #73 MT030 全局身份、刷新锁与例外端点显式登记 | MT027, MT013 | backend_implementer / backend_validator | A6, A11 | `bun test server/tests/multitenancy/global-exceptions.test.ts。` | blocked |
| 34 | MT031 / #74 MT031 插件安装与连接归属（目录只读，安装不全局） | MT027, MT016 | backend_implementer / backend_validator | A1, A2, A4 | `bun test server/tests/multitenancy/plugin-install.test.ts。` | blocked |
| 35 | MT032 / #75 MT032 工具调用时重新校验当前用户连接与 Bot 授权 | MT031, MT018 | backend_implementer / backend_validator | A2, A5 | `bun test server/tests/multitenancy/tool-invocation.test.ts。` | blocked |
| 36 | MT033 / #76 MT033 技能与组件发布、组件数据函数的作用域 | MT031, MT009 | backend_implementer / backend_validator | A2, A4, A3 | `bun test server/tests/multitenancy/skills-components.test.ts。` | blocked |
| 37 | MT034 / #77 MT034 共享账号审批绑定对象、参数摘要与归属 | MT031, MT029 | backend_implementer / backend_validator | A2, A5, A1 | `bun test server/tests/multitenancy/shared-approvals.test.ts。` | blocked |
| 38 | MT035 / #78 MT035 Host Access、签入帮助与危险动作审批的归属与既有行为保持 | MT034 | backend_implementer / backend_validator | A2, A5, A8 | `bun test server/tests/multitenancy/host-access.test.ts + 既有 approvals 回归套件。` | blocked |
| 39 | MT036 / #79 MT036 知识库的团队归属与受限查询（独立库，不假装跨库外键） | MT012, MT014 | backend_implementer / backend_validator | A1, A2, A4 | `bun test server/tests/multitenancy/kb-ownership.test.ts（含知识库专用测试库）。` | blocked |
| 40 | MT037 / #80 MT037 检索在候选、重排与进入模型之前限制范围 | MT036 | backend_implementer / backend_validator | A2, A4, A8 | `bun test server/tests/multitenancy/retrieval-restriction.test.ts。` | blocked |
| 41 | MT038 / #81 MT038 文档上传、删除、导入与重解析的作用域 | MT036 | backend_implementer / backend_validator | A2, A5, A8 | `bun test server/tests/multitenancy/document-lifecycle.test.ts。` | blocked |
| 42 | MT039 / #82 MT039 个人记忆与来源选择保持个人权限 | MT038, MT010 | backend_implementer / backend_validator | A4, A2, A1 | `bun test server/tests/multitenancy/personal-memory.test.ts。` | blocked |
| 43 | MT040 / #83 MT040 学习容器、研究与演示记录隔离 | MT036, MT014 | backend_implementer / backend_validator | A2, A8, A1 | `bun test server/tests/multitenancy/learning-demonstrations.test.ts。` | blocked |
| 44 | MT041 / #84 MT041 任务、运行、触发与租约固定原始归属与配置版本 | MT005, MT014 | backend_implementer / backend_validator | A2, A8, A5 | `bun test server/tests/multitenancy/job-ownership.test.ts。` | blocked |
| 45 | MT042 / #85 MT042 全局扫描只有调度权，每项执行重建业务作用域 | MT041 | backend_implementer / backend_validator | A8, A6, A2 | `bun test server/tests/multitenancy/scanner-scope.test.ts。` | blocked |
| 46 | MT043 / #86 MT043 认领、重试与人工取消保持归属 | MT042 | backend_implementer / backend_validator | A8, A5, A2 | `bun test server/tests/multitenancy/job-claim-cancel.test.ts。` | blocked |
| 47 | MT044 / #87 MT044 入站邮件、GitHub 与 Webhook 的归属解析 | MT042, MT028 | backend_implementer / backend_validator | A7, A8, A6 | `bun test server/tests/multitenancy/inbound-attribution.test.ts。` | blocked |
| 48 | MT045 / #88 MT045 主动建议与外部调用前后的事务边界 | MT042 | backend_implementer / backend_validator | A8, A2 | `bun test server/tests/multitenancy/proactive-tx.test.ts。` | blocked |
| 49 | MT046 / #89 MT046 电脑与浏览器实例分配、远程屏幕与人工接管授权 | MT042, MT029 | backend_implementer / backend_validator | A1, A2, A5, A8 | `bun test server/tests/multitenancy/computer-allocation.test.ts。` | blocked |
| 50 | MT047 / #90 MT047 快照、shell、文件、cancel/reset/cull 的归属 | MT046 | backend_implementer / backend_validator | A1, A2, A8, A5 | `bun test server/tests/multitenancy/execution-artifacts.test.ts。` | blocked |
| 51 | MT048 / #91 MT048 运行协议环节的归属：委托、能力、步骤、事件、恢复与取消 | MT042, MT046 | backend_implementer / backend_validator | A8, A7, A2 | `bun test server/tests/multitenancy/runs-protocol.test.ts` | blocked |
| 52 | MT049 / #92 MT049 TypeScript agent 适配器统一消费已验证归属 | MT048 | backend_implementer / backend_validator | A8, A7, A2 | `bun test server/tests/multitenancy/agent-adapters.test.ts` | blocked |
| 53 | MT050 / #93 MT050 Go Runtime、supervisor 与原生 agent 适配器的归属传递 | MT049 | backend_implementer / backend_validator | A8, A1, A2 | `go test ./...（runtime-go 及受影响 module）+ bun test server/tests/multitenancy/native-runtime.test.ts。` | blocked |
| 54 | MT051 / #94 MT051 执行上界、审批与机密脱敏的既有保证不回退 | MT047, MT050 | backend_implementer / backend_validator | A8, A5 | `既有 execution/approvals/redaction 套件 + bun test server/tests/multitenancy/execution-guarantees.test.ts。` | blocked |
| 55 | MT052 / #95 MT052 状态化公共 Bot 为不同使用者隔离浏览器与工作区 | MT046, MT018 | backend_implementer / backend_validator | A4, A2, A8 | `bun test server/tests/multitenancy/public-bot-profiles.test.ts。` | blocked |
| 56 | MT053 / #96 MT053 Craft 会话、turn、消息与快照的作用域 | MT022, MT046 | backend_implementer / backend_validator | A1, A2, A4 | `bun test server/tests/multitenancy/craft-sessions.test.ts。` | blocked |
| 57 | MT054 / #97 MT054 Craft 计划任务、子任务与应用连接的归属 | MT053, MT041 | backend_implementer / backend_validator | A8, A2, A5 | `bun test server/tests/multitenancy/craft-schedules.test.ts。` | blocked |
| 58 | MT055 / #98 MT055 产物与对象存储路径按归属隔离 | MT053 | backend_implementer / backend_validator | A2, A8, A1 | `bun test server/tests/multitenancy/artifact-storage.test.ts。` | blocked |
| 59 | MT056 / #99 MT056 签名下载与代理访问在签发点和访问点都授权，撤销即停止 | MT055, MT010 | backend_implementer / backend_validator | A5, A2, A1 | `bun test server/tests/multitenancy/signed-download.test.ts。` | blocked |
| 60 | MT057 / #100 MT057 Workshop 会话、执行、产物与沙箱实例关联的作用域 | MT053, MT047 | backend_implementer / backend_validator | A1, A2, A8 | `bun test server/tests/multitenancy/workshop-scope.test.ts。` | blocked |
| 61 | MT058 / #101 MT058 分享令牌改为有效分享授权（受众、有效期、撤销） | MT056, MT010 | backend_implementer / backend_validator | A3, A2, A5 | `bun test server/tests/multitenancy/share-tokens.test.ts + 前端分享页测试（MT092）。` | blocked |
| 62 | MT059 / #102 MT059 私有 OpenMuse Bot 按公司团队用户幂等创建 | MT016, MT014 | backend_implementer / backend_validator | A1, A2, A4 | `bun test server/tests/multitenancy/openmuse-private-bot.test.ts。` | blocked |
| 63 | MT060 / #103 MT060 OpenMuse 任务、计划、监控与租约的作用域 | MT059, MT041 | backend_implementer / backend_validator | A1, A2, A8 | `bun test server/tests/multitenancy/openmuse-tasks.test.ts。` | blocked |
| 64 | MT061 / #104 MT061 OpenMuse 文件、PDF 检视/填写/传输与个人工作区的作用域 | MT060, MT055 | backend_implementer / backend_validator | A1, A2, A5 | `bun test server/tests/multitenancy/openmuse-files.test.ts。` | blocked |
| 65 | MT062 / #105 MT062 OpenMuse 目标、想法、记忆与财务产物的作用域 | MT060, MT039 | backend_implementer / backend_validator | A2, A4, A1 | `bun test server/tests/multitenancy/openmuse-personal.test.ts。` | blocked |
| 66 | MT063 / #106 MT063 OpenMuse 连接器、邮件与日历动作的归属 | MT060, MT028 | backend_implementer / backend_validator | A7, A1, A2, A5 | `bun test server/tests/multitenancy/openmuse-connectors.test.ts。` | blocked |
| 67 | MT064 / #107 MT064 OpenMuse 审阅动作提案与回执的归属 | MT063, MT034 | backend_implementer / backend_validator | A2, A5, A7 | `bun test server/tests/multitenancy/openmuse-reviewed-actions.test.ts` | blocked |
| 68 | MT065 / #108 MT065 OpenMuse 活动流与通知的归属与正文过滤 | MT064 | backend_implementer / backend_validator | A2, A5, A7 | `bun test server/tests/multitenancy/openmuse-activity-notifications.test.ts` | blocked |
| 69 | MT066 / #109 MT066 语音、听写与移动聚合接口只返回当前范围 | MT060, MT065 | backend_implementer / backend_validator | A2, A10, A9 | `bun test server/tests/multitenancy/voice-mobile-bff.test.ts。` | blocked |
| 70 | MT067 / #110 MT067 退出公司与全局账号删除是两个不同操作 | MT060, MT026 | backend_implementer / backend_validator | A5, A1, A2 | `bun test server/tests/multitenancy/deletion-semantics.test.ts。` | blocked |
| 71 | MT068 / #111 MT068 清理、保留与恢复带可核验归属与不可伪造 manifest | MT067 | backend_implementer / backend_validator | A5, A12, A2 | `bun test server/tests/multitenancy/purge-restore.test.ts。` | blocked |
| 72 | MT069 / #112 MT069 公司计费 Customer 映射与公司/个人账户类型（expand） | MT014, MT008 | backend_implementer / backend_validator | A9, A13, A12 | `bun test server/tests/multitenancy/payer-accounts.test.ts（真实 PostgreSQL）。` | blocked |
| 73 | MT070 / #113 MT070 公司调用归属与同一余额的原子预扣 | MT069, MT041 | backend_implementer / backend_validator | A9, A13, A1 | `bun test server/tests/multitenancy/company-reservation.test.ts（真实 PostgreSQL 并发）。` | blocked |
| 74 | MT071 / #114 MT071 结算、释放、尾差与重试幂等在新归属下保持 | MT070 | backend_implementer / backend_validator | A9, A13, A12 | `bun test server/tests/multitenancy/settlement-idempotency.test.ts（真实 PostgreSQL）。` | blocked |
| 75 | MT072 / #115 MT072 支付回调、订阅激活、outbox 与对账从原记录解析付款账户 | MT070 | backend_implementer / backend_validator | A7, A9, A13 | `bun test server/tests/multitenancy/payer-resolution.test.ts。` | blocked |
| 76 | MT073 / #116 MT073 账务可见性：付款人订单、公司财务授权与团队用量视图 | MT070, MT010 | backend_implementer / backend_validator | A9, A13, A2 | `bun test server/tests/multitenancy/billing-visibility.test.ts。` | blocked |
| 77 | MT074 / #117 MT074 历史余额只迁一次到原有公司，个人 Bifrost 路径不变 | MT069, MT003 | backend_implementer / backend_validator | A12, A13 | `bun test server/tests/multitenancy/balance-migration.test.ts + Bifrost 个人路径回归套件。` | blocked |
| 78 | MT075 / #118 MT075 部署级平台管理与公司/团队管理动作分离 | MT006, MT013 | backend_implementer / backend_validator | A1, A2, A5 | `bun test server/tests/multitenancy/admin-separation.test.ts。` | blocked |
| 79 | MT076 / #119 MT076 人员提升、降级与离职按公司授权 | MT075, MT026 | backend_implementer / backend_validator | A5, A1, A2 | `bun test server/tests/multitenancy/people-lifecycle.test.ts。` | blocked |
| 80 | MT077 / #120 MT077 网络、能力与模型路由策略和模板按归属保存 | MT075, MT014 | backend_implementer / backend_validator | A1, A2, A8 | `bun test server/tests/multitenancy/routing-policy.test.ts。` | blocked |
| 81 | MT078 / #121 MT078 业务审计与身份审计分域，计费管理需明确授权 | MT075, MT073 | backend_implementer / backend_validator | A2, A5, A9 | `bun test server/tests/multitenancy/audit-domains.test.ts。` | blocked |
| 82 | MT079 / #122 MT079 纯个人偏好保持全局，业务配置按归属保存 | MT075, MT015 | backend_implementer / backend_validator | A2, A10, A1 | `bun test server/tests/multitenancy/preferences.test.ts。` | blocked |
| 83 | MT080 / #123 MT080 Web 公司与团队选择界面及无资格空状态 | MT006, MT009 | frontend_implementer / frontend_validator | A3, A6, A10 | `bun test app/tests/multitenancy/selection.test.tsx。` | blocked |
| 84 | MT081 / #124 MT081 Web REST 与上传下载签发统一附加当前范围 | MT080, MT056 | frontend_implementer / frontend_validator | A10, A6, A3 | `bun test app/tests/multitenancy/transport-rest.test.tsx` | blocked |
| 85 | MT082 / #125 MT082 Web SSE 与 WebSocket 建连、续订携带范围并终止旧连接 | MT081, MT025 | frontend_implementer / frontend_validator | A10, A6, A3 | `bun test app/tests/multitenancy/transport-streams.test.tsx` | blocked |
| 86 | MT083 / #126 MT083 按公司团队隔离查询缓存并拒绝旧 generation 的在途响应 | MT082 | frontend_implementer / frontend_validator | A10, A3, A6 | `bun test app/tests/multitenancy/cache-generation.test.tsx。` | blocked |
| 87 | MT084 / #127 MT084 Web Bot 详情与配置页接入范围 | MT083, MT017, MT019 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | `bun test app/tests/multitenancy/web-bot-detail.test.tsx` | blocked |
| 88 | MT085 / #128 MT085 Web Bot 共享与发布页按服务端能力展示 | MT084 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | `bun test app/tests/multitenancy/web-bot-publish.test.tsx` | blocked |
| 89 | MT086 / #129 MT086 Web Bot 职责、电脑与审批页面接入范围 | MT085, MT046, MT034 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | `bun test app/tests/multitenancy/web-bot-ops.test.tsx` | blocked |
| 90 | MT087 / #130 MT087 Web 会话与群聊页面接入范围 | MT083, MT023 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test app/tests/multitenancy/web-channels.test.tsx` | blocked |
| 91 | MT088 / #131 MT088 Web 技能与连接账号页面接入范围 | MT087, MT033, MT027 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test app/tests/multitenancy/web-skills-connections.test.tsx` | blocked |
| 92 | MT089 / #132 MT089 Web 记忆与定时任务页面接入范围 | MT088, MT039, MT041 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test app/tests/multitenancy/web-memory-routines.test.tsx` | blocked |
| 93 | MT090 / #133 MT090 Web 通知与个人设置页面：偏好全局、业务配置按范围 | MT089, MT079 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test app/tests/multitenancy/web-notifications-settings.test.tsx` | blocked |
| 94 | MT091 / #134 MT091 Web Craft 与 Workshop 页面接入范围 | MT083, MT057 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | `bun test app/tests/multitenancy/web-craft-workshop.test.tsx` | blocked |
| 95 | MT092 / #135 MT092 Web 分享页的身份、受众与撤销状态 | MT091, MT058 | frontend_implementer / frontend_validator | A2, A3, A4, A10 | `bun test app/tests/multitenancy/web-share-page.test.tsx` | blocked |
| 96 | MT093 / #136 MT093 Web 知识管理与文档处理页面接入范围 | MT083, MT038 | frontend_implementer / frontend_validator | A2, A4, A10 | `bun test app/tests/multitenancy/web-knowledge.test.tsx` | blocked |
| 97 | MT094 / #137 MT094 Web 插件、技能与组件页面接入范围 | MT093, MT033 | frontend_implementer / frontend_validator | A2, A4, A10 | `bun test app/tests/multitenancy/web-plugins-components.test.tsx` | blocked |
| 98 | MT095 / #138 MT095 Web people、身份提供方与凭据管理界面按能力开放 | MT083, MT076 | frontend_implementer / frontend_validator | A2, A5, A9, A10 | `bun test app/tests/multitenancy/web-admin-people.test.tsx` | blocked |
| 99 | MT096 / #139 MT096 Web 学习、企业与审计管理界面按能力开放 | MT095, MT078 | frontend_implementer / frontend_validator | A2, A5, A9, A10 | `bun test app/tests/multitenancy/web-admin-audit.test.tsx` | blocked |
| 100 | MT097 / #140 MT097 Web 账单、订单与团队用量视图 | MT083, MT073 | frontend_implementer / frontend_validator | A9, A13, A10, A2 | `bun test app/tests/multitenancy/web-billing.test.tsx。` | blocked |
| 101 | MT098 / #141 MT098 桌面原生组织上下文模型与命令门控 | MT028 | frontend_implementer / frontend_validator | A7, A10, A13 | `cargo test --manifest-path desktop/src-tauri/Cargo.toml org_context` | blocked |
| 102 | MT099 / #142 MT099 桌面凭据命名空间与 OAuth state 绑定 authority | MT098, MT069 | frontend_implementer / frontend_validator | A7, A10, A13 | `cargo test --manifest-path desktop/src-tauri/Cargo.toml credential_namespace` | blocked |
| 103 | MT100 / #143 MT100 桌面切换或退出组织时清理公司媒体与订阅状态 | MT099 | frontend_implementer / frontend_validator | A10, A7, A5 | `cargo test --manifest-path desktop/src-tauri/Cargo.toml org_switch_cleanup + bun test desktop/src/OrgSwitchCleanup.test.tsx。` | blocked |
| 104 | MT101 / #144 MT101 桌面组织登录、公司团队选择与嵌入工作台携带选择 | MT099, MT082 | frontend_implementer / frontend_validator | A3, A7, A10 | `bun test desktop/src/CompanySelection.test.tsx。` | blocked |
| 105 | MT102 / #145 MT102 桌面本地状态与业务缓存按组织隔离 | MT100, MT101 | frontend_implementer / frontend_validator | A10, A3, A13 | `bun test desktop/src/LocalStateIsolation.test.tsx + cargo test（相关命名空间用例）。` | blocked |
| 106 | MT103 / #146 MT103 移动端 submodule 基线核对与可审查差异报告 | — | frontend_implementer / frontend_validator | A11 | `差异报告文档 + 复核命令记录（无需产品测试）。` | ready |
| 107 | MT104 / #147 MT104 移动端 tenancy 适配层：选择与缓存 | MT103, MT083 | frontend_implementer / frontend_validator | A3, A10, A2 | `bun test apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts。` | blocked |
| 108 | MT105 / #148 MT105 移动端流式与媒体传输携带当前范围 | MT104, MT025 | frontend_implementer / frontend_validator | A10, A2, A7 | `bun test apps/openmuse/apps/mobile/src/openbot/transport.test.ts。` | blocked |
| 109 | MT106 / #149 MT106 Web、iOS、Android 三端选择与缓存一致性验证 | MT104, MT105 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test apps/openmuse/apps/mobile/src/openbot/three-client-selection.test.ts + 三端运行记录` | blocked |
| 110 | MT107 / #150 MT107 移动聚合接口范围与三端流式/媒体一致性验证 | MT106, MT066 | frontend_implementer / frontend_validator | A2, A3, A10, A11 | `bun test apps/openmuse/apps/mobile/src/openbot/aggregation.test.ts + 三端运行记录` | blocked |
| 111 | MT108 / #151 MT108 Trace、日志与事件的归属字段注入 | MT050, MT065 | backend_implementer / backend_validator | A8, A9, A13, A2 | `bun test server/tests/multitenancy/telemetry-attribution.test.ts` | blocked |
| 112 | MT109 / #152 MT109 用量事件的账户区分与脱敏回归 | MT108, MT069 | backend_implementer / backend_validator | A8, A9, A13, A2 | `bun test server/tests/multitenancy/telemetry-usage.test.ts + 既有脱敏回归套件` | blocked |
| 113 | MT110 / #153 MT110 共享观测后端的查询、导出与 trace 链接授权 | MT109, MT078 | backend_implementer / backend_validator | A1, A2, A9 | `bun test server/tests/multitenancy/observability-authz.test.ts。` | blocked |
| 114 | MT111 / #154 MT111 已启用集成的隔离与账户路由证据 | MT109, MT072 | backend_implementer / backend_validator | A13, A9, A11 | `bun test server/tests/multitenancy/integration-evidence.test.ts + 证据清单文档。` | blocked |
| 115 | MT112 / #155 MT112 创建原有公司与默认团队并建立映射 | MT003, MT004 | backend_implementer / backend_validator | A12, A1, A2 | `bun test server/tests/multitenancy/legacy-company.test.ts（真实 PostgreSQL）` | blocked |
| 116 | MT113 / #156 MT113 历史根记录归属回填并保持既有个人授权 | MT112, MT074 | backend_implementer / backend_validator | A12, A1, A2 | `bun test server/tests/multitenancy/root-backfill.test.ts（真实 PostgreSQL）` | blocked |
| 117 | MT114 / #157 MT114 主库子记录回填第一批：Bot、会话、凭据与插件 | MT113, MT016, MT021, MT027, MT031 | backend_implementer / backend_validator | A12, A1, A6 | `bun test server/tests/multitenancy/child-backfill-main-batch1.test.ts（真实 PostgreSQL）` | blocked |
| 118 | MT115 / #158 MT115 主库子记录回填第二批：记忆、任务、Craft/Workshop、OpenMuse、账务与策略 | MT114, MT039, MT041, MT053, MT057, MT060, MT069, MT077, MT109 | backend_implementer / backend_validator | A12, A1, A6 | `bun test server/tests/multitenancy/child-backfill-main-batch2.test.ts（真实 PostgreSQL）` | blocked |
| 119 | MT116 / #159 MT116 知识库侧归属回填与独立进度记录 | MT113, MT036 | backend_implementer / backend_validator | A12, A1, A6 | `bun test server/tests/multitenancy/child-backfill-kb.test.ts（知识库测试库）` | blocked |
| 120 | MT117 / #160 MT117 跨库一致性校验、断点续跑与回填报告 | MT114, MT115, MT116 | backend_implementer / backend_validator | A12, A1, A6 | `bun test server/tests/multitenancy/backfill-consistency.test.ts（两个测试库）` | blocked |
| 121 | MT118 / #161 MT118 对象存储文件与产物的归属迁移 | MT117, MT055, MT061 | backend_implementer / backend_validator | A12, A8, A6 | `bun test server/tests/multitenancy/external-files-migration.test.ts` | blocked |
| 122 | MT119 / #162 MT119 外部线程、浏览器状态与向量命名空间迁移 | MT118, MT037, MT052 | backend_implementer / backend_validator | A12, A8, A6 | `bun test server/tests/multitenancy/external-runtime-migration.test.ts` | blocked |
| 123 | MT120 / #163 MT120 无法归属外部状态的隔离清单与启用阻断 | MT119 | backend_implementer / backend_validator | A12, A8, A6 | `bun test server/tests/multitenancy/quarantine-list.test.ts + 隔离清单报告` | blocked |
| 124 | MT121 / #164 MT121 冻结写入、备份恢复、失败隔离与回退程序（含演练） | MT120 | backend_implementer / backend_validator | A12, A11 | `演练记录文档 + bun test server/tests/multitenancy/rollback-procedure.test.ts（可自动化部分）。` | blocked |
| 125 | MT122 / #165 MT122 部署主入口按已认证身份建立上下文并使用作用域工厂 | MT014, MT005, MT041 | backend_implementer / backend_validator | A6, A1, A8, A11 | `bun test server/tests/multitenancy/entry-context.test.ts` | blocked |
| 126 | MT123 / #166 MT123 移除启动期默认公司状态并保持 API 兼容 | MT122 | backend_implementer / backend_validator | A6, A1, A8, A11 | `bun test server/tests/multitenancy/startup-defaults.test.ts + 既有入口回归套件` | blocked |
| 127 | MT124 / #167 MT124 企业入口装配接入统一上下文与授权 | MT123 | backend_implementer / backend_validator | A2, A5, A6, A11 | `bun test server/tests/multitenancy/assembly-enterprise.test.ts` | blocked |
| 128 | MT125 / #168 MT125 旧 REST、Copilot 与移动聚合入口装配与兼容 | MT124, MT066 | backend_implementer / backend_validator | A2, A5, A6, A11 | `bun test server/tests/multitenancy/assembly-legacy.test.ts` | blocked |
| 129 | MT126 / #169 MT126 流式与长连接入口的上下文与订阅授权装配 | MT123, MT025 | backend_implementer / backend_validator | A10, A2, A6 | `bun test server/tests/multitenancy/assembly-stream.test.ts。` | blocked |
| 130 | MT127 / #170 MT127 全局登录、健康检查与平台静态目录例外登记闭合 | MT125, MT030 | backend_implementer / backend_validator | A6, A11, A13 | `bun test server/tests/multitenancy/global-exception-closure.test.ts + 登记表审阅` | blocked |
| 131 | MT128 / #171 MT128 机器回调与个人 Bifrost 直连路径例外登记闭合 | MT127, MT069 | backend_implementer / backend_validator | A6, A11, A13 | `bun test server/tests/multitenancy/machine-personal-exceptions.test.ts` | blocked |
| 132 | MT129 / #172 MT129 多租户启动就绪强制与缺口阻断 | MT123, MT128, MT013, MT012 | backend_implementer / backend_validator | A6, A8, A11 | `bun test server/tests/multitenancy/readiness-enforcement.test.ts` | blocked |
| 133 | MT130 / #173 MT130 Worker 与后台装配去默认公司 | MT129, MT042 | backend_implementer / backend_validator | A6, A8, A11 | `bun test server/tests/multitenancy/worker-assembly.test.ts` | blocked |
| 134 | MT131 / #174 MT131 验收 harness 与独立测试环境 | MT001, MT002 | backend_implementer / backend_validator | A11, A1, A2, A6 | `bun test server/tests/multitenancy/acceptance-harness.test.ts` | blocked |
| 135 | MT132 / #175 MT132 身份矩阵 runner 与逐入口覆盖状态输出 | MT131, MT128 | backend_implementer / backend_validator | A11, A1, A2, A6 | `bun test server/tests/multitenancy/identity-matrix-runner.test.ts + 覆盖状态报告` | blocked |
| 136 | MT133 / #176 MT133 覆盖证据：Bot、会话与附件 | MT132, MT019, MT024 | backend_implementer / backend_validator | A1, A2, A3, A4, A11 | `bun test server/tests/multitenancy/coverage-bots-conversations.test.ts + 覆盖报告` | blocked |
| 137 | MT134 / #177 MT134 覆盖证据：插件审批、知识与记忆 | MT133, MT035, MT040 | backend_implementer / backend_validator | A1, A2, A3, A4, A11 | `bun test server/tests/multitenancy/coverage-plugins-knowledge.test.ts + 覆盖报告` | blocked |
| 138 | MT135 / #178 MT135 覆盖证据：后台任务与执行隔离 | MT132, MT045, MT051 | backend_implementer / backend_validator | A2, A5, A8, A11, A12 | `bun test server/tests/multitenancy/coverage-jobs-execution.test.ts + 覆盖报告` | blocked |
| 139 | MT136 / #179 MT136 覆盖证据：Craft/Workshop、OpenMuse 与删除恢复 | MT135, MT058, MT068 | backend_implementer / backend_validator | A2, A5, A8, A11, A12 | `bun test server/tests/multitenancy/coverage-craft-openmuse.test.ts + 覆盖报告` | blocked |
| 140 | MT137 / #180 MT137 覆盖证据：公司/个人付款账户与账务可见性 | MT132, MT073 | backend_implementer / backend_validator | A7, A9, A12, A13, A11 | `bun test server/tests/multitenancy/coverage-billing.test.ts（真实 PostgreSQL）+ 覆盖报告` | blocked |
| 141 | MT138 / #181 MT138 覆盖证据：治理、审计与观测出口 | MT137, MT079, MT111 | backend_implementer / backend_validator | A7, A9, A12, A13, A11 | `bun test server/tests/multitenancy/coverage-governance.test.ts + 覆盖报告` | blocked |
| 142 | MT139 / #182 MT139 覆盖证据：Web 客户端 | MT132, MT097 | backend_implementer / backend_validator | A3, A10, A11, A13 | `bun test app/tests/multitenancy + 覆盖报告` | blocked |
| 143 | MT140 / #183 MT140 覆盖证据：桌面与移动端 | MT139, MT102, MT107 | backend_implementer / backend_validator | A3, A10, A11, A13 | `bun test desktop/src apps/openmuse/apps/mobile/src/openbot + cargo test + 覆盖报告` | blocked |
| 144 | MT141 / #184 MT141 缺口关闭与阻塞项清单 | MT121, MT130, MT134, MT136, MT138, MT140 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | `bun test server/tests/multitenancy/gap-closure.test.ts + 缺口清单文档` | blocked |
| 145 | MT142 / #185 MT142 独立 Review 与完整范围代码审查 | MT141 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | `审查记录 + 完整范围代码审查报告 + 复审结论` | blocked |
| 146 | MT143 / #186 MT143 统一上线候选包与证据汇总 | MT142 | backend_implementer / backend_validator | A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13 | `bun test server/tests/multitenancy/full-coverage.test.ts + 上线候选包文档` | blocked |

## Preflight and consistency checks

- Recursive GitHub intake covers #6, all 20 formal Epics and 143 Tickets; 143 `Blocked by` sections were parsed and compared to local breakdown with zero mismatches. The DAG has 274 resolved edges, no self-edge/cycle, and a 143-node topological order.
- A1–A13 each map to Tickets; R1–R7 map through Spec §11; §8 business closures are cross-mapped to corresponding Epic families. Planned coverage is not completion evidence.
- Current source paths differ from stale planning assumptions. Inspect `server/src/app.ts`, `server/src/index.ts`, `server/src/production-entry.ts`; do not assume `server/src/enterprise/app.ts` exists.
- `docs/agents/domain.md` is absent; root `CONTEXT.md` is the project domain source.
- `TEST_DATABASE_URL` was absent in coordinator shell. A fresh dedicated ephemeral PostgreSQL is running at loopback port 55432 with an empty `openbot_enterprise_issue6_test` database; it is separate from the development service.
- Pi is registered and effective. Current visible default was `glm-5.3 • medium`; worker-start does not provide effective model/effort, so this does not prove strongest final-review settings. Resolve/record effective configuration before full final Pi review.
- Shared schema/migration journals, route registries, submodule state, build outputs, DB state and external namespaces are exclusive resources; serialize conflicting tasks. Preserve explicit expand → migrate → contract edges.
