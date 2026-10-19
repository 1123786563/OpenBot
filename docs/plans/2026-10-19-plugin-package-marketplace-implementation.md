# Plugin Package Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在现有授权、连接和 Run 治理上交付可版本锁定、可撤权、可迁移的团队插件包市场。

**Architecture:** 用不可变制品和公共 release 描述包内容，用范围安装装配现有 Skill、专家和连接模块。连接器安装继续由 enterprise plugin catalog 持有；包来源调用必须走范围 grant、Run pin 和当前授权判定。

**Tech Stack:** TypeScript、Bun/Hono、Zod、Drizzle/PostgreSQL、React/TanStack Query、现有 MCP/OpenConnector/Composio transport；tester-army e2e 为统一测试入口。

**Spec:** [详细技术方案](../specs/2026-10-19-plugin-package-marketplace-design.md)。同时阅读根 CONTEXT.md、ADR 0004/0006/0008；ADR 0007 未批准，Personal Space 是后续接入依赖。

**Issue 拆解更新（2026-10-19）：** 用户随后要求拆为具体 Issue，已发布父方案 [#459](https://github.com/1123786563/OpenBot/issues/459) 与 12 张纵向业务票；[真实依赖与验收映射](../tickets/plugin-package-marketplace/README.md) 取代本文 T1–T10 作为 Issue 领取顺序。本文仍作技术实现参考，执行单个 Issue 时只提取它需要的 Task，不把整套水平任务提前实施。

## Global Constraints

- 本计划只规划，不实施；任务均 pending。规划工作区 /Users/wuyongjun/trea/OpenBot，main，BASE 为 295c0b89fc29e1f1745f0ccf484c51f49a04a1ea。实施时重新记录 BASE，先用 using-git-worktrees 核验/建立执行工作区，显式复制 Spec/Plan 并校验哈希。其他会话脏改动不转移、不覆盖。
- schemaVersion=1、platformApi=1；manifest ≤64 KiB，资源 ≤256，普通文件 ≤512，总包 ≤16 MiB，单文本 ≤1 MiB；路径及 digest 算法按 Spec §5。
- 计划有效期 10 分钟；配置 ≤32 个平面非秘密字段；分页默认 20、上限 100；部署开关默认关闭。
- V1 团队安装只接收可信 PlatformScope；tenant_admin 管理权不自动提供私人 Bot 内容读取权。
- 包不存 token，不运行安装脚本，不解释任意 MCP URL；不允许 scope/账号/版本/legacy 回退。
- 不新增 npm 依赖；使用已有 Zod、node:crypto/fs 和现有认证、事务及 transport。迁移编号在实施时串行分配，不覆盖当前 journal。
- 默认串行实施；没有本地提交授权时用未提交检查点与任务增量 Review Package。计划本身不授予提交权限。
- 每任务先独立 reviewer 审查 Spec 与质量，再放行下游；最后运行完整范围 OCR。本轮不派发实施或 Review Agent。

## Review Focus

1. 用户快速切换两家公司/团队、伪造 installId、OAuth 回调迟到：原归属不变，响应不泄露其他范围存在性。T5/T7/T8 覆盖。
2. 两个计划并发升级/停用，Run 正在派发：revision/CAS 和派发线性化点唯一，已发送效果不被误标为已取消。T4/T6 覆盖。
3. 同名 Skill/工具、同版本异内容：不覆盖资源，旧 Run 不吸收新指令、schema 或权限。T1/T3/T6 覆盖。
4. owner 数据库、全局 grant、部署 token 或管理员身份被当作范围授权：真实受限角色拒绝，无回退。T2/T5/T7 覆盖。
5. 派发后进程崩溃或写超时：unknown 可核对、不自动重发，卸载和回退不删除证据。T6/T9 覆盖。

---

## DAG、记录和验证约定

| Task | source / acceptance | depends_on | owner_role | validator_role | status |
| --- | --- | --- | --- | --- | --- |
| T1 制品与契约 | Spec §4–5；A01 | — | backend_implementer | backend_validator | pending |
| T2 存储与权限 | §6；A02/A12 | T1 | backend_implementer | backend_validator | pending |
| T3 资源与专家 | §8；A04/A08/A10 | T1,T2 | backend_implementer | backend_validator | pending |
| T4 安装生命周期 | §7–8/10；A03/A06/A08 | T2,T3 | backend_implementer | backend_validator | pending |
| T5 范围 grant 与连接 | §6/9；A02/A04/A07 | T2,T4 | backend_implementer | backend_validator | pending |
| T6 Run pin 与派发 | §9–10；A05/A06/A07 | T4,T5 | backend_implementer | backend_validator | pending |
| T7 全入口接线 | §7/9；A02/A05/A07/A12 | T3,T4,T5,T6 | backend_implementer | backend_validator | pending |
| T8 Web 市场 | §11；A11 | T7 | frontend_implementer | frontend_validator | pending |
| T9 发布、迁移、回退 | §12；A08/A09/A12 | T1,T7,T8 | backend_implementer | backend_validator | pending |
| T10 验收与审查 | §15；A01–A12 | T9 | 主控 | 专业验证者 + reviewer | pending |

默认拓扑顺序 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10。此表为拆票前技术参考。正式实施须读取父 Issue #459 与正式子 Issue，领取顺序和业务依赖以 Issue DAG 为准，不能把本表当作已批准的实施派发。

实施记录写入 docs/plans/2026-10-19-plugin-package-marketplace/ledger.md，每任务保存 HEAD、before/after 快照哈希、拥有文件、验证输出和 Review 状态。前置 verified 且检查点内容集成后才执行下游。

测试先读 ADR 0008：纯函数/Node 可收集套件直接进入 e2e；Bun 数据层套件登记 Bun-driven manifest。native 命令示例：
~~~sh
E2E_UNIT_OUTPUT=.e2e/package-t1 bunx e2e run --config e2e.unit.config.ts server/tests/package-artifact.test.ts
~~~
driven 任务内 RED/GREEN 可用 bun test ./<file> 定位 Bun 行为；正式验收由 e2e 统一调度。E2E_BUN_ONLY 按 manifest 的 group.name 子串筛选，不接收文件名；下例运行真实 multitenancy 组：
~~~sh
E2E_BUN_ONLY=server/tests/multitenancy E2E_UNIT_OUTPUT=.e2e/package-t2 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
~~~
后续任务替换输出目录；native 可选文件，driven 从生成后的 manifest 查实际组名，普通 server DB 组用 E2E_BUN_ONLY=server/tests，不能把文件路径当组名。任务内 targeted Bun 结果只能作针对性证据，T10 仍需统一入口报告。必须观察实际测试数大于 0，缺数据库/角色、skip 或收集失败均不等于通过。

### Task 1: 清单、wire 契约与确定性制品

**Files / ownership:** 创建 shared/enterprise/plugin-package-contracts.ts、server/src/plugin-packages/{manifest,artifact,catalogue}.ts、scripts/plugin-packages/build.ts、server/tests/package-artifact.test.ts。本任务只用 fixture，不迁移真实市场目录。

**Interfaces:** 产出 parsePackageManifest(input: unknown): PackageManifestV1；buildArtifact(root: string): Promise<VerifiedArtifact>；loadArtifact(root: string, digest: string): Promise<VerifiedArtifact>；parseMarketplace(input: unknown): MarketplaceV1。VerifiedArtifact 包含 manifest、文件索引、digest 与核验后的缓冲。shared 定义 Plan/Install/Grant/List DTO、Zod 和封闭错误码，后续任务引用同一份类型。

- [ ] RED：artifact_hash_is_order_independent、rejects_same_release_with_new_digest；参数化路径逃逸、symlink、重复 ID、超限、未知字段与非空 dependencies；精确断言 Spec 限值上下边界。
- [ ] 按 native 命令执行，预期因接口未实现而 FAIL，不能是收集失败。
- [ ] 实现 strict Zod、同缓冲哈希、受限文件读取与原子制品写入；同内容构建两次同摘要。
- [ ] 同命令 PASS；补测校验期间更换源文件无法改变已验证缓冲或明确拒绝。
- [ ] 独立 Review 检查 wire 与制品算法一致；保存增量与证据，checkpoint T1 verified。

### Task 2: 存储、RLS 与管理事务

**Files / ownership:** 创建 server/src/db/schema/enterprise-plugin-packages.ts、server/src/enterprise/plugin-packages/{contracts,store,mutation-context}.ts、server/tests/multitenancy/package-storage.test.ts；修改 server/src/db/schema/{index,enterprise-plugins}.ts、server/src/enterprise/tenancy/plugin-catalog.ts、server/scripts/multitenancy/migrate-test.ts；创建实施时分配的 Drizzle SQL 和元数据。

**Interfaces:** 消费 T1 DTO；产出 createPackageStore(data: DataDatabase): PackageReadStore、createPackageMutationStore(operator: OperatorDatabase): PackageMutationStore。管理事务接口 transaction<T>(scope: PlatformScope, admin: CompanyAdminContext, fn: (tx: PackageWriteTx) => Promise<T>): Promise<T>。PackageWriteTx 只由此模块签发；普通 Database 不可冒充。store 覆盖计划、修订、链接、grant、pin、dispatch 的范围 CRUD，不执行 transport。

- [ ] RED：真实 DB 的跨 tenant/workspace FK、RLS 计数、未验证通道、成员撤销、管理员降级与事务上下文清除；测试必须使用真实受限角色。
- [ ] 注册 PKG001 测试迁移，按既有 dry-run → manifest → apply 配方；缺测试数据库记 blocked。
- [ ] 实现 Spec §6 九张表及 compound unique/FK/CHECK/索引；既有 connector install 增 revision、connection 增 generation 与必要复合唯一键。
- [ ] 在既有 setEnabled/uninstall/bind/unbind 补共同锁与代次更新；保留 active/disabled 的原读取含义，真实角色最小授权与 FORCE RLS 分别验证。
- [ ] 登记 Bun-driven manifest，运行 package-storage driven 命令；池 max=1 验无二次借连接死锁，迁移 journal 与 schema 同步。
- [ ] Review 通过后 checkpoint T2。

### Task 3: Skill 资源与专家模板装配

**Files / ownership:** 创建 server/src/enterprise/plugin-packages/{resources,expert-template}.ts、server/tests/package-resources.test.ts、server/tests/package-expert.integration.test.ts；修改 server/src/agents/profile-store.ts、server/src/enterprise/tenancy/bots-ownership.ts；新增本任务串行分配的函数迁移及相应测试迁移步骤。

**Interfaces:** 消费 T1 VerifiedArtifact/T2 PackageWriteTx；产出 materializeResources(tx: PackageWriteTx, artifact: VerifiedArtifact, install: InstallRevisionRef): Promise<ResourceLink[]>；instantiateExpert(scope: PlatformScope, input: InstantiateExpertInput): Promise<{agentId:string}>。给原领域 owner 增加 createWithin/createBotWithin，以服务端固定 agentId 在同一受限事务内写入，约束见 Spec §8。

- [ ] RED：同名 Skill 不抢全局 slug；私人编辑不改包内容；重复创建返回同 agentId；profile 成功后 ownership 失败则全回滚；模板 endpoint/auth 注入拒绝。
- [ ] 提取既有 create 的事务内部实现，原接口委托它；显式 built_in 模式防止 managedConfiguration 改变模板执行方式，不向普通客户端开放 agentId。
- [ ] 原子写 profile、企业 ownership、模板来源与仅含明确 Skill 的范围 grant；connector grant 初始为空，复用 expert version catalog 保存实际 prompt 摘要。
- [ ] 运行 package-resources native、package-expert driven 及既有 profile/Bot ownership 回归。
- [ ] 建立 Spec §8 固定的 openbot_create_package_expert 函数；测试 PUBLIC 无 EXECUTE、operator 只有该函数能力、伪造范围/actor、endpoint/auth 注入与非管理员拒绝。createWithin 通过此函数写全局 profile，禁止 owner DB 回退。
- [ ] Review 通过后 checkpoint T3。

### Task 4: 安装计划、幂等提交与生命周期

**Files / ownership:** 创建 server/src/enterprise/plugin-packages/{install-service,plans,lifecycle}.ts、server/tests/package-install.integration.test.ts、server/tests/package-lifecycle.integration.test.ts。

**Interfaces:** 消费 T2 store/T3 adapters；产出 PackageService.list/get/plan/apply/changeStatus，精确签名沿用 Spec §7；resolveInstallRevision(scope, installId, revision): Promise<InstallRevision>。计划保存规范输入、digest 与 actor，写只经 mutation transaction。

- [ ] RED：并发同 plan 只消费一次；已消费计划过期后同键仍返回原 result；不同 plan 同包只一安装；同键异输入 409；10 分钟过期、revision 改变、release 撤回拒绝；已消费重放返回原 result。
- [ ] 在事务外核验制品；事务内按共同锁序重验、CAS 并写 install/revision/resource links/change/consumed；外部网络 spy 恒为 0。
- [ ] 升级/回滚新建 revision；停用/卸载/重装 generation 单调增加且撤 grant；不删除用户 Bot、Skill、账号与共享 connector。
- [ ] 使用两个真实 DB 连接和 barrier 检查 install/upgrade/disable 竞争，运行两个 driven 套件。
- [ ] Review 检查错误与跨范围 not-found；checkpoint T4。

### Task 5: 范围 grant 与受管连接访问

**Files / ownership:** 创建 server/src/plugins/{package-grants,package-access}.ts、server/tests/package-grants.integration.test.ts、server/tests/package-managed-access.integration.test.ts；修改 server/src/plugins/{access,store}.ts 及连接领域最小接口。

**Interfaces:** 消费 T2 scope/mutation、T4 安装；产出 setBotGrant(scope: PlatformScope, input: PackageGrantInput): Promise<PackageGrantDTO>；resolveManagedAccess(scope: PlatformScope, input: ManagedAccessInput): Promise<TrustedManagedAccess>。输入含 connectorInstallId/connectionId/botId/toolRef；可信访问对象只在进程内存在，含 transport 与凭据引用/generation，不进入 wire。

- [ ] RED：仅安装、仅需求声明、legacy 全局 grant、他团队同 Bot ID、他人 connection、发布者账号、部署 token 都不能单独放行。
- [ ] 使用 Bot ownership/resource policy；包来源仅查范围 package grant；核验工具 ref、schema hash/effect，read 变 write 重新授权。
- [ ] 接入现有企业 connector decision、账号授权和供应商真实可用性；Google 保持 OpenConnector 合同，不接受包内任意目标。
- [ ] secret canary 验 list/plan/error/log/模型均无泄漏；断连接、换代次或资格撤销后再次解析拒绝。跑两个 driven 套件及既有 plugin-install 回归。
- [ ] Review 确认无全局 grant/账号 OR 回退；checkpoint T5。

### Task 6: Run pin、派发与外部效果

**Files / ownership:** 创建 server/src/enterprise/plugin-packages/{runtime,pins,dispatch}.ts、server/tests/package-runtime.integration.test.ts、server/tests/package-dispatch.integration.test.ts；修改 server/src/enterprise/runs/{service,store,request-context}.ts、server/src/plugins/{tools,store}.ts。

**Interfaces:** prepareWithin(tx: RunWriteTx, scope: PlatformScope, input: PreparePackageRunInput): Promise<PackageRunSnapshot>；beginDispatch(scope: PlatformScope, input: BeginPackageDispatchInput): Promise<DispatchPermit>；completeDispatch(permit: DispatchPermit, result: DispatchResult): Promise<void>。Snapshot 固定 Run/attempt、pins、资源摘要与 tool bindings；Permit 固定 operationId、argsDigest 和当前 generation，只有服务端可签发。

- [ ] RED：升级后旧 Run 读旧 Skill；撤 grant 立即拒；新增 schema/effect/工具不进入旧 pin；同 toolCallId 并发只派发一次。
- [ ] Run 创建、pin 与 outbox 必须同一事务提交，另测 worker 抢占不可能看到无 pin 的已就绪 Run；Skill 按需读取也重验；工具名映射检测碰撞；callTool 采用 legacy/package 标签分支并接既有策略、审批与审计。
- [ ] 两连接真实并发验证停用/撤回与 dispatch 线性化：先停用则网络 0 次，先 dispatched 则保留回执；网络等待不持 DB 锁。
- [ ] 注入派发后收回执前崩溃、写超时，状态 unknown，重入只核对不重发；参数/连接/generation 变更使旧审批失效。
- [ ] 运行两个 driven 套件与既有工具调用回归；Review 通过后 checkpoint T6。

### Task 7: HTTP、审批、后台全入口接线

**Files / ownership:** 创建 server/src/enterprise/plugin-packages/routes.ts、server/tests/package-routes.integration.test.ts、server/tests/package-entrypoints.integration.test.ts；修改 server/src/{app,index}.ts、server/src/plugins/routes.ts、server/src/approvals/execute.ts、server/src/memory/ingestion.ts、server/src/enterprise/tenancy/admin-separation.ts 和已存在的定时/责任任务工具组装点（在 T7 Brief 中根据 index.ts 的 grantedTools/grantedSkills 调用追踪固定文件清单）。

**Interfaces:** 消费 PackageService/T6 runtime；产出 createPackageRoutes(deps: PackageRouteDeps): Hono。装配 packages: PackageServices | null，缺依赖提供 unavailable route；后台从持久 Run 身份重建可信 Scope，不反序列化信任客户端 scope。

- [ ] RED：Spec 七组接口的成功/错误、非管理员、跨范围、伪造 scope/回调、缺 operator、计划过期和秘密脱敏。
- [ ] 挂载路由；管理写按精确路径与 HTTP 方法注册 company 管理面，平台管理员没有隐含公司权限。
- [ ] 对 tools、routes call、app 内部 call、approval resume、schedule/responsibility、memory ingestion 写入口清单；逐入口证明包上下文到达，缺 pin/attempt/generation 必拒。
- [ ] 审批期间改参、切范围、断连接、撤权后恢复均重验；无受管回调的外部 Bot 返回 unsupported。
- [ ] 跑 routes/entrypoints driven 及管理面隔离回归；无可信逻辑私有 Bot 执行范围时检查 PACKAGE_BOT_SCOPE_UNAVAILABLE；缺任何实际入口证据不能 verified。Review 后 checkpoint T7。

### Task 8: Web 市场、安装预览与范围缓存

**Files / ownership:** 创建 app/src/lib/plugin-packages/{queries,mutations}.ts、app/src/components/market/{package-pane,package-detail,package-install-dialog,package-grants}.tsx、app/tests/plugin-package-market.test.tsx；修改 app/src/routes/_authed/admin/market.tsx、app/src/locales/{zh-CN,en}/market.json。

**Interfaces:** 消费 shared DTO/allowedActions/readiness；查询 key 固定包含 plugin-packages、tenantId、workspaceId、principalId；mutation 带发起时固定范围与 planId，不读取可变全局 current scope。

- [ ] RED：普通成员无管理动作；缺连接真实引导；pending 禁重复提交；切范围废弃待确认 plan；迟到响应只写旧 key。
- [ ] 实现目录/已安装、详情、预览、升级权限增量、停用/卸载影响与显式工具授权；账号连接继续去原连接页。
- [ ] 按现有 native/driven 分区执行 UI 套件，新增文案中英文齐全，错误后保留非秘密输入并可重作计划。
- [ ] frontend_validator 做浏览器键盘、窄屏、慢网、失败恢复、两范围切换验收；保存截图。复用同代码有效 API 证据。
- [ ] 独立 Review 后 checkpoint T8。

### Task 9: 发布目录、旧安装迁移与回退

**Files / ownership:** 创建 plugins/marketplace.json、plugins/packages/openbot/*、scripts/plugin-packages/{publish,migrate-legacy}.ts、docs/operations/plugin-packages.md、server/tests/package-migration.integration.test.ts、server/tests/package-deployment.test.ts；修改 package.json、Dockerfile、server/src/config.ts、server/src/marketplace/{catalogue,routes,store}.ts。

**Interfaces:** migrate-legacy 默认 dry-run，输出源 ID/哈希、映射、unresolved 与 manifest；apply 显式传同摘要 manifest，CAS 重验范围及当前内容。publish 只经部署管理身份/通道注册 T1 制品和 release，不能执行包代码。

- [ ] RED：私人改过的 Skill 不覆盖；缺范围不迁；并发源改变拒绝；expert slug 映射保留；卸载不破坏共享 connector。
- [ ] 真实 CATALOGUE_* 导出为包文件，构建与镜像携带只读制品；默认关闭开关，pilot allowlist 使用精确 tenant/workspace 元组，启动探测说明真实缺项。
- [ ] 新旧同范围影子读取对账，无双写；旧 grant 含义不变，未映射资源保持 legacy 并点名。
- [ ] 演练启用→创建 pin→关闭新入口：原 Run 仍受包治理或安全暂停；不降级 legacy、不自动 GC，unknown 与历史版本可查。
- [ ] 跑 migration driven/deployment native；Review 后 checkpoint T9。

### Task 10: 验收、独立审查与交付记录

**Files / ownership:** 创建 docs/plans/2026-10-19-plugin-package-marketplace/{ledger,acceptance,entrypoints,verification}.md 与各轮 Review/OCR 报告。验证者只能写指定报告和运行产物。

- [ ] A01–A12 关联测试、截图和检查点哈希；列出 blocked/skip。没有真实受限 DB 证据不得将 T2/T5/T6 verified。
- [ ] 执行受影响 native/driven 与 node scripts/e2e-coverage-audit.mjs 对账；测试数大于 0，每轮使用独立报告目录。
- [ ] 运行 bun run --filter server typecheck、bun run --filter app typecheck、改动文件 Biome、受影响构建与真实 API/browser 验收；基线失败和本次引入分别记录。
- [ ] 独立 reviewer 给出 Spec/质量两结论；有效阻塞问题回到对应专业实现者，验证后复审。
- [ ] 主控按 open-code-review Skill 完整审查，始终 --audience agent；未提交交付用 workspace，若有提交再覆盖原始 BASE..HEAD。有效 finding 进入编号修复计划与 SDD，直到全范围通过。
- [ ] 保存全部证据和裁定，明确 V1 团队、legacy 私人兼容、Personal Space 后续依赖。未授权的提交、推送或发布不包含在本计划内。

## 自查与恢复

T1–T10 节点唯一、依赖存在且无环；共享文件串行修改；三类资源有写入方；A01–A12 全覆盖；Scope/DTO/事务/pin/dispatch 接口先产出后消费。T3 的 createWithin 和 T5 的 TrustedManagedAccess 是高风险接口，Task Brief 必须附对应 Spec 和前置检查点。

恢复先读 Spec、本文、ledger 和当前 Git，不重派 verified Task。实施前核验最新代码签名、迁移编号和测试分区；并行工作已提供同一能力时更新计划复用已审查实现。

本轮仅编写方案和静态自查。以上命令是未来验证指令，未在本轮运行，不证明生产实现完成。

