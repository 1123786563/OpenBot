# orca-dag-wave3 MT 线第二轮核验报告：#89–#93（MT046–MT050）

- 核验基线：`main@3b4a7c68132c3507300408346a44fb9d56f3c14c`（本 worktree `mt4`，含 wave2 集成提交 `fd62295a`）。
- 核验方式：B 类——每票先 `gh api` 读正文与验收，再核对 3b4a7c68 是否已含等价实现；证据为文件定位 + 命令 + 退出码，缺口逐 AC 给 `file:line`。
- 事实源：`docs/adr/0004-company-team-tenancy.md`、`docs/specs/2026-10-14-company-team-multitenancy-design.md`（A1/A2/A5/A7/A8 定义，§8 覆盖矩阵行「电脑、浏览器、代码与沙箱」）、`CONTEXT.md`「公司与团队」（Tenant=公司租户、Workspace=团队工作空间）。
- 结论速览：**五票全部 FAILED**（3b4a7c68 无等价实现；票面 Verification 测试文件均不存在，命令均 exit 1）。#91/#93 存在企业面/Go 面的部分等价基础设施，逐 AC 标注如下，供后续实施排期。

## 总证据：五票票面验证命令在 3b4a7c68 均无可执行文件

从仓库根执行（ADR 0008 驱动层形态 `bun test ./<file>`）：

| 票 | 命令 | 退出码 | 输出要点 |
| --- | --- | --- | --- |
| #89 | `bun test ./server/tests/multitenancy/computer-allocation.test.ts` | **1** | `Test filter … had no matches` |
| #90 | `bun test ./server/tests/multitenancy/execution-artifacts.test.ts` | **1** | 同上 |
| #91 | `bun test ./server/tests/multitenancy/runs-protocol.test.ts` | **1** | 同上 |
| #92 | `bun test ./server/tests/multitenancy/agent-adapters.test.ts` | **1** | 同上 |
| #93 | `bun test ./server/tests/multitenancy/native-runtime.test.ts` | **1** | 同上 |

全仓 `find` 复核：五个文件名在仓库内只命中 `docs/tickets/multitenancy/tickets/` 下的票面 markdown（MT047 连同名票面文件都无），无任何同名测试或等价 MT 层套件。

---

## #89 MT046 电脑与浏览器实例分配、远程屏幕与人工接管授权 — **FAILED**

前置（Blocked by）已具备：#85/MT042（`server/src/enterprise/runs/scan-executor.ts` + `server/tests/multitenancy/scan-executor.test.ts`）、#72/MT029（`server/src/enterprise/tenancy/credential-lease.ts` + 同名测试）。

- **AC1（归属范围内授权主体才可看屏/接管；跨范围拒绝）缺口**：计算机面入口全部是个人级 actor 模型，无任何公司/团队（tenant/workspace）作用域概念。
  - `server/src/agents/computer-access.ts:14-23`：`canUseComputer = actor.role==="admin" || visibility==="public" || ownerUserId===actor.id`——无租户/工作区维度。
  - `server/src/computer/routes.ts:94`：路由守卫是 `canUseBot`，其实现为 `agentProfileStore.get(actor, botId) !== null`（`server/src/app.ts:2116-2119`），同为可见性模型。
  - 接管/屏幕入口 `server/src/computer/routes.ts:440-455`（`/control/take|release|cancel`）只过上述守卫；`agent-computer` 进程侧仅有部署级共享 token（`agent-computer/src/authorisation.ts:14-53`）。
- **AC2（回收后状态清理、不跨范围复用登录态/工作目录）缺口**：存在按 Bot 的 stop/reset/清退机制（`server/src/computer/gateway.ts:283-287` `stopComputer/resetComputer`；`server/src/computer/capacity.ts:62-63` `sweepIdle`；`agent-computer/src/browser-eviction.ts`、`sessions.ts` run 边界、`reset-run.test.ts`），但键是 `botId`，无归属概念，也无跨范围复用回归测试（票面验证文件缺失，exit 1）。`agent-computer/src/sessions.ts:29` 自述「this process is not a security boundary」。
- **AC3（服务 token 只授予登记能力；请求任意公司数据被拒）缺口**：computer/sandbox/supervisor 三个执行面 token 都是部署级共享秘密，无能力登记表——`agent-computer/src/authorisation.ts:14-23`（`matchesToken`）、`agent-sandbox/src/proxy.ts:133`（`x-sandbox-token`）、`supervisor/src/authorisation.ts:10-16`（共享 Bearer）。持 token 者在机器层面等价，无按公司数据的拒绝语义。
- **AC4（撤权后屏幕会话与接管立即终止）缺口**：现有 revoke 只针对单个 handoff 请求或 holder/admin（`server/src/computer/routes.ts:466-505` `revokeControl`，含 logout 收尾）；MT 层成员撤权（`server/src/enterprise/tenancy/revocation.ts`，MT007）未接线到计算机会话终止。

## #90 MT047 快照、shell、文件、cancel/reset/cull 的归属 — **FAILED**（执行侧接口票）

- **AC1（快照与工作目录按归属命名/隔离；列举与下载需授权）缺口**：沙箱快照/工作目录仅按 `botId` 组织——`agent-sandbox/src/snapshot.ts:1-50`（「a Bot's whole working directory」）、`agent-sandbox/src/proxy.ts:159`（`x-openbot-bot-id` 头）；鉴权是共享 `x-sandbox-token`（`proxy.ts:133`），无公司/团队作用域，无按归属的列举/下载授权。
- **AC2（shell/文件以执行业务身份授权）缺口**：shell 由网关策略 + 审计行守门，但决策主体是用户级 `ActionActor`（`agent-computer/src/shell.ts:1-25` 自述「the gateway decides … writes the audit row」；`server/src/computer/gateway.ts:225-287` 全部 `(botId, actor)` 签名）；不存在「执行业务身份/Scope」入参。
- **AC3（cancel/reset/cull 只对有权主体生效且留审计）缺口**：reset 有审计与 actor 门（`server/src/codesandbox/routes.ts:50-60`；`server/src/computer/routes.ts:424-437` stop/reset/update 经 `act()` 审计链；cull=`capacity.ts:62-63` `sweepIdle`），但授权是用户级而非归属级，且票面验证文件缺失（exit 1）。
- **AC4（清理不删其他范围快照/工作目录）缺口**：隔离粒度是 per-Bot（快照 restore 整目录替换、sweep 按 botId），无公司/团队粒度的清理边界与越权测试。

### 供 #86/MT043 AC3 使用的当前执行侧接口形态（全部无 scope 入参）

| 面 | 接口 | 位置 | 鉴权/身份 |
| --- | --- | --- | --- |
| Computer | `stopComputer(botId, actor): {wasRunning}` / `resetComputer(botId, actor): {cleared}` / `updateComputer(botId, actor)` | `server/src/computer/gateway.ts:283-292` | 用户级 `ActionActor`，审计先行 |
| Computer 接管 | `takeControl / releaseControl / cancelControl / revokeControl(botId, actor, requestId|reason)` | `server/src/computer/gateway.ts:231-252`、`server/src/computer/routes.ts:440-505` | 同上；revoke 带 observed lease 防竞态 |
| Computer 清退 | `sweepIdle(now?): Promise<string[]>`（idle culler） | `server/src/computer/capacity.ts:62-63` | 内部例程，按 botId |
| Sandbox 生命周期 | `SandboxClient.resetWorkspace()`；HTTP `POST /reset` | `server/src/codesandbox/routes.ts:50-60` | actor 门 + 审计 |
| Sandbox 运行中 | `POST /session/:id/abort`、`POST /devserver/stop`、`POST /webapp/stop` | `agent-sandbox/src/proxy.ts:48,58,61,109-110` | 共享 `x-sandbox-token` + `x-openbot-bot-id`（`proxy.ts:133,159`） |
| Go Runtime | 已验签 cancel 端点（要求完整 VerifiedRun 元组 + fencing） | `runtime-go/internal/server/cancel_test.go:228-296` | TS 治理面签发的 VerifiedRun |

**对 #86 的含义**：MT043 AC3（取消传播到含沙箱/浏览器的外部执行）今天没有可复用的 scope 承载入口——上表所有接口的键是 `(botId, 用户级actor)` 或共享 token。实施 #86 前须先落 MT047/MT050 的归属化改造（或在网关层新增 `(companyId, teamId) → 归属执行集 → 逐面传播` 的取消入口），否则取消传播只能以机器身份绕过归属校验，与 A8 相抵触。

## #91 MT048 运行协议环节的归属 — **FAILED**（企业面存在部分等价，逐 AC 如下）

- **AC1（创建/步骤/事件携带并校验同一归属；缺失拒绝）——部分等价，且最近套件在本 harness 红**：企业面把 `PlatformScope{tenantId,workspaceId,…}`（`server/src/enterprise/contracts.ts:40-48`）贯穿 admission→capability→events：能力解析强校验同 scope（`server/src/enterprise/runs/governed-execution.ts:217-234`，tenant/workspace/principal/run/attempt/generation/route/ceiling 全等才放行）；事件写入按 tenantId 过滤/加锁（`server/src/enterprise/runs/events.ts:141-266`）；scope 只能由 resolver 铸造（`assertTrustedScope`，`server/src/enterprise/tenancy/store.ts:47-51`）。但最近等价套件在 3b4a7c68 红：
  - `server/tests/enterprise/governed-execution.test.ts`：原生层 `bunx e2e run --config e2e.unit.config.ts server/tests/enterprise/governed-execution.test.ts` → **14 fail / 1 pass，exit 1**，全部 `WORKSPACE_FORBIDDEN` 于 `server/src/enterprise/tenancy/store.ts:161`。根因是测试假件早于 MT005 团队资格门：假事务的 select 桩（`governed-execution.test.ts:44-66`）返回成员行而不含 `status` 字段，过不了 `store.ts:141-162` 的 workspace-membership 门槛——产品代码与套件漂移，不是 DB 缺项（该套件纯内存，不需要 TEST_DATABASE_URL；备好库后复跑仍同败，见附录）。
  - `server/tests/enterprise/runs.integration.test.ts`：驱动层 `bun test ./server/tests/enterprise/runs.integration.test.ts`（企业四库就绪后）→ **0 pass / 1 fail，exit 1**，同 `store.ts:161`。根因同类：`provisionDeployment`（`server/src/enterprise/tenancy/provision.ts`）只造 tenant/principal/membership/workspace，不插 `enterprise_workspace_memberships`；全仓唯一插入点是 MT005 的 `server/src/enterprise/tenancy/workspace-admin.ts:638`。
- **AC2（恢复只在原归属范围；异范围身份恢复被拒）缺口**：`RecoveryService.resume(scope, input)` 只有契约声明（`server/src/enterprise/contracts.ts:213-215`），`server/src/enterprise/**` 内零实现（grep `resume(` 无命中）；「按原归属恢复」无从谈起。
- **AC3（取消传播到执行中步骤与外部执行；事件不推无权订阅者）——半缺口**：取消传播到在途 relay 与超时终态（`server/src/enterprise/runs/runner.ts:298,446-450,585-587,685,821`）；订阅侧授权已由 MT025 独立覆盖（`server/src/enterprise/tenancy/streams.ts` + `server/tests/multitenancy/streams.test.ts`）。但「外部执行（计算机/沙箱）」无接线：`gateway.stopComputer/resetComputer` 在 `server/src/computer|capacity` 之外零调用方，运行取消不会到达浏览器/沙箱。
- **AC4（外部线程上下文按持久记录解析归属）——存在绿色等价**：`server/tests/enterprise/runner-scope.test.ts` 原生层单跑 **34/34 pass，exit 0**：`server_creates_bound_thread_without_client_storage_ids`、`conversation_message_routes_resolve_scope_from_the_persisted_thread`、`anonymous_actor_cannot_mint_scope`、`thread_owned_by_other_principal_is_denied`、legacy mapping 拒外来/过期/歧义（`runner-scope.test.ts:34-334`）。单 AC 等价不救整票。

## #92 MT049 TypeScript agent 适配器统一消费已验证归属 — **FAILED**

- **AC1（归属缺失/篡改时拒绝执行）缺口**：适配器回调身份是签名 `RunAssertion`，字段仅 `botId/actorId/runId/threadId/depth/initiator(+handoff)`（`server/src/agents/handoff-signing.ts:16-27`；铸造/校验 `server/src/agents/callback-token.ts:1-45`，TTL 10min，与 per-agent token 互相校验）——**不含任何公司/团队归属字段**，适配器无从拒绝 scope 漂移。
- **AC2（适配器不自行构造 Scope、只消费签发入口）缺口**：适配器进程只有一个共享 `MANAGED_AGENT_TOKEN`（`agent-langgraph/src/index.ts:66-69,251-285,498`；`shared/agent-authorisation.ts:14-21` 恒时比较）。不存在「签发入口产生的 Scope」可消费；`agent-langgraph/src/index.ts:285` 自述工具侧「not in a position to know」调用者身份。
- **AC3（回调解析结果跨适配器一致，共享用例覆盖全部适配器）缺口**：共享测试只有 `shared/agent-authorisation.test.ts`（token 比较函数）；回调/断言解析测试仅存在于 `agent-langgraph/tests/{trace-chain,tool-answer}.test.ts`，无覆盖全部适配器（adk/ag2/agno/crewai/langgraph-agui/langroid/llamaindex/microsoft/pydantic-ai/strands/mastra）的共享矩阵。
- **AC4（日志含归属标识不含明文秘密）缺口**：适配器无归属标识可记；秘密掩码只在 computer 面（`agent-computer/src/secret-masking.ts`）。

## #93 MT050 Go Runtime、supervisor 与原生 agent 适配器的归属传递 — **FAILED**（Go Runtime 面大体齐备；接口形态供 #86 使用）

- **AC1（归属字段跨语言不丢不改；缺失拒绝）——runtime-go 等价、其余三面缺口**：`runtime-go` 的 `VerifiedRun` 携带 `TenantID` 与完整信封（`runtime-go/internal/identity/context.go:33-58`），`FromContext` 拒绝任何字段缺失（`context.go:66-80`，`UNAUTHENTICATED_RUNTIME`）；身份只在 auth 中间件经 TS 治理面 ledger 验签后铸造（`runtime-go/internal/server/auth.go:290-383`），模型载荷/请求体不产生身份。但 **supervisor（`supervisor/src/authorisation.ts:10-16` 共享 Bearer）、agent-computer（`agent-computer/src/authorisation.ts:14-53` 共享 token）、agent-sandbox（`agent-sandbox/src/proxy.ts:133,159` 共享 token + bot-id 头）三处边界完全丢弃归属**。
- **AC2（原生组件不以本地信任跳过校验）——runtime-go 达标、supervisor/sandbox/computer 缺口**：runtime-go 明文拒绝 legacy agent-token 当身份（`auth.go:18-21,54-58`）；其余三面接受任何持部署秘密者，无逐调用方校验。
- **AC3（日志/错误含归属标识不含明文秘密）——部分**：runtime-go 有 trace 面与金丝雀测试（`trace_test.go`、`wire_golden_test.go`）；computer 有 `secret-masking.ts`；supervisor/sandbox 日志无归属标识（无归属概念）。
- **AC4（Go 侧正向与越权用例）——runtime-go 达标**：`go test ./...`（`runtime-go/`）**全部 ok，exit 0**；越权用例在册：`auth_test.go:321` `TestAuthRejectsMissingEnterpriseCredentials`、`auth_test.go:345` `TestAuthValidatesAndInjectsVerifiedIdentity`、`cancel_test.go:99` `TestCancelRequiresVerifiedIdentity`、`cancel_test.go:349` `TestCancelRefusesAnotherUsersRun`。票面另一半 `bun test ./server/tests/multitenancy/native-runtime.test.ts` exit 1（文件不存在）；supervisor/sandbox/computer 无归属测试面。
- **跨语言契约提示**（票面备注要求与 MT049 互引）：VerifiedRun 的 `TenantID` 目前语义是「公司租户」，`workspaceId` 未入信封——MT049 侧 TS 适配器若引入 Scope 消费，Go 信封需同步补 workspace 维度，两侧契约必须一致。

---

## 测试库记录（约束项：TEST_DATABASE_URL 配方）

- 容器 `orca-w3-mt-pg`（pgvector/pg16，127.0.0.1:5565）在位。
- 新建 `openbot_enterprise_mt4`：`CREATE DATABASE` → `server/ops/enterprise/roles.sql`（superuser，exit 0）→ `bun server/scripts/enterprise-test-db.ts migrate`（TEST_DATABASE_URL + 三个 `ent*_test` 角色 URL）→ `{"type":"migrations-applied","status":"ok"}`，exit 0。本轮 **0163 与迁移链未冲突**（坑未触发）。
- 已知坑的变体仍触发：0163 恢复出的 MT004/MT014 三表（`enterprise_workspace_memberships`、`enterprise_runtime_configs`、`enterprise_runtime_config_overrides`）在迁移链内**无 RLS/GRANT**，fresh 库上目录角色 `permission denied for table enterprise_workspace_memberships`。按授权配方从 `openbot_enterprise_mt3` 侧Dump 重放（仅库侧，仓库零改动）：3×`ENABLE ROW LEVEL SECURITY` + 14×`CREATE POLICY` + 9 条 GRANT，重放后与 mt3 逐表比对 `GRANTS_MATCH_MT3` / `POLICIES_MATCH`。此后 `runs.integration.test.ts` 的 aclcheck 消失，剩余失败为上述 store.ts:161 产品/套件漂移（归属判定，非环境）。
- 驱动/原生两层遵守 ADR 0008：`bun:test` 文件走 `bun test ./<file>`；`e2e-compat` 文件走 `bunx e2e run --config e2e.unit.config.ts <file>`（`runs.integration.test.ts` 以原生层跑得 `no test files` exit 2，即层错配信号，改驱动层后正常执行）。

## 零改动证明

- 仓库源码零改动：`git status --porcelain` 唯一输出 `?? reports/orca-dag-wave3-mt-r2.md`（本报告，任务指定的产物，未 commit）；无任何已跟踪文件修改。
- `git rev-parse HEAD` = `3b4a7c68132c3507300408346a44fb9d56f3c14c`；`git rev-parse HEAD^{tree}` = `git write-tree` = `2f28875132275120dbe5c28aae28a1ff4732a33b`（已跟踪内容与 HEAD 树哈希一致）。
- `git diff HEAD | shasum -a 256` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（空输入哈希，即 diff 为空）。
- 未 commit / 未 push / 未对 GitHub 票据做任何写操作；共享 stash 栈有 1 条他人条目，未触碰。
- 测试运行产物只落在 gitignored 的 `.e2e/`（ADR 0008 runner 输出）。
