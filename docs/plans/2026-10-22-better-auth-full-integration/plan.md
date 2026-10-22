# Better Auth Full Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留既有身份、业务 ID、付款事实和技术栈的前提下，以 Better Auth 唯一管理公司/团队目录，完成可撤权、可恢复的公司多租户闭环。

**Architecture:** 在现有 auth factory、Scope gate 和业务授权之间加入受控 Directory Interface。目录命令在同一 PostgreSQL 连接/事务内完成 BA 写入、最终状态校验、持久版本、资格投影、审计与 outbox；业务继续通过实时 Scope、资源授权和受限角色访问。客户端统一选择流程，下载和长运行按敏感检查点重新核验。

**Tech Stack:** Bun/Hono、Better Auth 1.7.1（候选固定版本，P01 核验）、Drizzle/PostgreSQL、React/Vite/TanStack Router/Query、现有 shadcn 体系、现有 Mastra/Worker、Tauri/已启用移动端；tester-army e2e 统一调度。

**Spec:** [2026-10-22-better-auth-full-integration-design.md](../../specs/2026-10-22-better-auth-full-integration-design.md)，v2.3、尚未批准实施；本计划按用户要求提前展开，**不改变 Spec 批准状态，也不启动实施**。

## Global Constraints

- “Better Auth 统一管理身份、会话、公司目录、团队目录、成员与邀请；OpenBot 管理公司业务生命周期、可信 Scope、资源权限、运行审批、数据库隔离、公司/个人付款账户与审计。”
- “保留 Bun/Hono、React/Vite/TanStack Router、Mastra 执行适配及现有 Worker”。
- “一个全局 User 对应一个全局 Principal”，保留历史 User/Principal/Tenant/Workspace、payer 和外部账号 identity；不按相同邮箱自动合并主体。
- “`activeOrganizationId`、`activeTeamId`、header、URL 都只是选择器。”不得从 JSON 恢复可信 Scope。
- “每个成员关系只有一个写入权威”；旧成员表是同事务派生投影，持久 clocks/tombstone 不随重建丢失。
- 全局身份使用独立 IdentityCommand，不伪造 tenant；首次公司入职在同一命令内幂等建立 Principal。团队能力区分公司角色、团队 Grant、批准 provisioning rule，禁止假 Grant/管理员 session。
- 凭据 use/disclose 和个人 owner 属于授权来源，新 lease 签发和直接明文披露均先比较来源代际；仅失效旧 lease 不够。
- “公司管理权、团队管理权、业务内容权、公司财务权、平台运维权分别判定。”固定 owner/admin/member/auditor，动态角色、模拟登录、裸用户/组织物理删除默认关闭。
- “成员撤销提交后，新业务事务和后续敏感动作的准入不能继续使用旧资格”；下载最多保留撤权前已准入的一个 **256 KiB** 批次，无新准入宽限。
- 公司认证 challenge 首期最多有效 **10 分钟**；公司证明不能从 accounts 绑定或 session freshness 反推，session 续期不延长 IdP 认证年龄。
- “公司工作台消费公司统一余额，团队只统计用量；个人 Bifrost 授权消费个人余额，余额不足不互相兜底。”不替换现有 Lago/积分/订单/支付权威。
- “身份/权限/存储不可用时相关入口关闭”；公司先 provisioning 后 active，不回退默认用户/公司/团队/管理员。
- 平台开通为本计划默认；首期完整个人工作台、自助公司创建、嵌套团队、跨公司分享、新支付提供方及 KB 恢复均不实施。既有启用能力必须保留并回归。
- 真实 PostgreSQL、实际 BA adapter、受限角色验证事务/RLS/锁；测试从公共模块或实际挂载入口进入。缺环境、跳过或零用例不计通过。

## Review Focus

1. 同一用户在 A 为 owner、B 为 member，显式 selector 与乱序 active 更新冲突：拒绝冲突，管理与请求归属不漂移；P05/P07/P24 测试。
2. 撤权与慢客户端、Range 重试、outbox 故障交错：后续批次不能新准入，已准入批次不超过 262144 字节；P15/P24 测试。
3. 接受邀请期间策略变化、邮箱换绑、会话轮换及 IdP 回调换账号：邀请接受与公司认证分别校验，不能生成跨会话证明；P08/P11 测试。
4. 受控命令被跳过、私有 adapter 升级或恢复丢失 tombstone：提交失败或关闭范围，禁止异步双写、版本重置与临时提权；P01/P04/P22 测试。
5. Worker 重放、数据库回退、支付/邮件已发生且用户离职：固定范围/payer，旧能力不复活，外部副作用不重复；P16/P18/P22 测试。

---

## 1. 范围、事实源和执行准备

本轮只交付计划。规划基线为 2026-10-22 本地 HEAD `bcf51633f16201aa453ed5f4dbe81007f498de55` 加当前工作区；Spec 中 e8ea2102 是其历史读取基线，不能直接当作执行 BASE。当前 `main` 含用户及其他工作的 staged/unstaged/untracked 改动，部分 tenancy 文件仍在变化；计划列出的是复用位置，不证明现有能力已完成。恢复或开工必须重核 Git、文件内容、适用规则及新的批准事实源。

事实源：Spec → [ADR 0011](../../adr/0011-better-auth-identity-and-membership-authority.md) 的已接受选型 → [CONTEXT.md](../../../CONTEXT.md) → 相邻职责 ADR。读取 [ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)、[0007](../../adr/0007-personal-space-business-scope-and-payer.md)、[0008](../../adr/0008-test-runner-tester-army-e2e.md)、[0009](../../adr/0009-remove-knowledge-base-domain.md)、[0010](../../adr/0010-mastra-execution-openbot-governance.md) 的适用条款；proposed 个人空间不因本计划变为批准。

未指定新 Issue，本计划 `source_issues=[]`，不声称已摄取远端 Issue，不复活旧 Issue #6。如果后续以新 Issue 执行，先完整读取其树、讨论和依赖，解决与获批 Spec 的差异，再生成快照及执行 DAG。

配套文件：[任务间接口](interfaces.md)、[验收与验证方法](acceptance.md)。原规划事实快照在 `.archive/runs/2026-10-22-better-auth-implementation-plan/`，本版 14 项整改的增量/验证/复核入口在 `.archive/runs/2026-10-22-better-auth-defect-remediation/`；该目录本地忽略，不随 clone/worktree 自动传递。第三轮审核 F-01–F-10 已写回 Spec v2.3 与本目录计划，为纯文档修订，其finding 登记在 `.archive/runs/2026-10-22-better-auth-review-f01-f10/`，实施证据另归执行 run。后续执行单独建立 run，方案在 docs、实时 DAG/Ledger/Brief/检查点和测试/Review/OCR 在 `.archive/runs/<执行 run>/`，不把运行报告写回本方案。

### G0：实施前置门槛，不是本轮已完成状态

- [ ] 核对新范围批准、实施授权及部署启用清单；确认 256 KiB、600 秒、平台开通、固定角色等建议仍被采用。批准变更先更新 Spec、接口和验收映射。
- [ ] 收集数据库版本/角色、数据量、拓扑、IdP/SCIM、邮件/存储/沙箱、客户端支持版本、owner 指定及迁移窗口。缺信息可做不依赖它的本地实现；相应生产准入和验收保持 blocked，禁止猜测 owner、恢复点或付款映射。
- [ ] 执行 `using-git-worktrees`，按 Orca 规范先查已有任务工作区；本轮为文档计划复用当前 checkout，**不是已建立实施隔离**。实现时核验或建立一个任务工作区，重录 BASE 和分支。
- [ ] 显式将未提交 Spec、ADR、本目录计划及依赖的授权改动复制到执行工作区，核对文件清单和 SHA-256；不把新 worktree 缺少文件当作需求消失，不整包带入无关用户改动。
- [ ] 派发前用 SDD 预检共享文件、接口和任务内部一致性；每次单个 Brief，专业角色、必要路径/检查点、权限、提交策略、验收、失败处理与报告位置齐备，禁止子 Agent 再派发。
- [ ] 当前无提交授权；所有任务默认使用未提交检查点。每 Task 前后保存 HEAD、staged/unstaged diff、范围内 untracked 全文和哈希，生成包含增删文件的增量 Review Package；验证和 Review 绑定同一检查点。不得以空 BASE..HEAD 替代审查。

### 任务纪律

默认按下面拓扑序串行实施；ready 只表示依赖已 verified 且内容已集成，不表示允许并行。每个生产任务结束后，由对应 validator 验证、独立 reviewer 分别给出 Spec compliance 和 code quality；通过后才更新 Ledger 为 verified。验证者不改业务/测试源。共享文件的所有权仅在任务活动期间独占，后续任务串行接管。

步骤里的测试断言是该用例必须具备的核心断言，fixture/变量由该文件测试准备步骤创建；不是要求复制一段没有上下文的完整测试实现。每 Task 的 RED 必须因目标行为缺失失败，不能以数据库连接、导入错误或零用例作为 RED。统一执行方法见 acceptance.md；除明确说明的 native/子模块命令外均在根目录运行。

**每 Task 的共同测试登记步骤（属于该 Task，不交给 P24 补写）：** 在 RED 前逐文件测量本 Task 新增/受影响测试的加载方式，按 ADR 0008 冻结 native/driven 分区。所有含新测试的 Task 在自身 owned_files 中共同拥有 `tests/config/e2e-bun-suites.json` 的受限增量，仅能登记本 Task 已存在且有实际 Bun 耦合证据的文件；Node/e2e-compat 文件保留 native，不同时加入 driven。P01 只建立分组/driver 能力和当时存在的文件，不能预登记未来文件；DIRECTORY_ISLANDS 不自动发现文件。每 Task 在 Brief 展开实际文件列表并在 RED/GREEN 记录目标文件/用例实际数，运行 `node scripts/e2e-coverage-audit.mjs` 对账；省略目标登记必须被检测为失败。共享分区配置的超范围变化回到所属任务，必须经 writeManifest 生成 files/groups 的同一增量，禁止手改 files 不改 groups。保留既有 groups 名称与成员，新 better-auth 岛用稳定批次 ID 追加（最多 24 文件/组），只变本任务新岛组，既有 part N 不重排。P01 扩展生成器/审计，强制 files 恰好等于 groups 展开、无重复/未知文件；files-only 反例非零失败，Bun driver 的无匹配组也非零失败，不以 skip 通过。

**每个迁入 gate/旧写路径 Task 的 authority 回归：** P04/P05/P06/P08/P09/P11/P12/P14/P16/P17/P18/P23 必须在自己的新测试文件加入 `legacy_authority_keeps_existing_tenancy_green` 参数矩阵，复用现有 multitenancy 的适用请求。M0/M1 旧请求不查 BA 空表/clocks/proof，旧写仍旧权威；ba 分支才强制新版本及 proof，paused 分支目录写 503，不能用 release gate 代替权威选择。P04 先提供基础 authority-matrix 夹具，P25 扩充迁移场景，P22 测同一请求 M3→M4 切换。没有此同版证据不得 verified。

前端 P07/P10/P13/P19/P20/P21 同样依据 P04 authority discovery 广告选择旧或 BA adapter；M4 前保持旧 DTO/入口，不把 BA 新字段伪填到旧响应。P20 新企业部署依赖未就绪时 503，不以 standalone 兼容。

**每 Task 的共同失败处理：** 行为失败返回本 Task 修复并补受影响验证；同一检查点未通过验证或独立 Review 不得 verified，依赖任务保持 pending/blocked。基础设施缺失记录具体环境与恢复条件；接口/Spec 冲突先修订事实源和调用方计划，不擅自放宽权限。Task 内最多 5 轮；连续两轮同一问题无进展触发 systematic-debugging，4–5 轮按工程规则升级。记录独立 report、review package 和裁决，不以实现者自查代替独立审查。

## 2. 切片、DAG 与文件边界

八个业务切片仍沿用 Spec T01–T08；下面 P01–P25 是切片内可独立审查的任务，不将前后端改成独立产品 Ticket。目录、Scope、认证和业务授权紧密耦合，采用一份主计划与接口/验收附件；各任务均受对外多租户 release gate 保护；该 gate 与 directory authority/write gate 分离。M0/M1 维持旧受控读写，M2/M3 才暂停目录写，M4 才启 BA 分支，不能因新 gate 合入使现有租户退化。

| Spec 切片 | 任务 | 依赖依据 |
| --- | --- | --- |
| T01 固定版本与可行性 | P01、P02 | 同连接、延迟 hook/SSO 证据及 UI 兼容是 schema/接入前提 |
| T02 目录模型与迁移预演 | P03、P04、P25 | schema/角色、authority 双轨、终结后，先交付 M0–M3 工具再迁入新 gate |
| T03 开通并进入团队 | P05、P06、P07 | Scope 实时版本、开通生命周期、前端选择形成闭环 |
| T04 邀请、成员与撤权 | P08、P09、P10 | 单写命令可用后扩展成员、指定团队授权与 UI |
| T05 企业身份及全局管理 | P11、P12、P13 | 会话公司证明先于 provisioning 和客户端追加认证 |
| T06 业务授权与执行 | P14、P15、P16、P17 | 权限与证明接口稳定后逐业务闭环接入 |
| T07 多客户端、容量账务 | P18、P19、P20、P21 | 账务及客户端消费新合同，业务 UI 消除旧缓存/流 |
| T08 迁移、恢复与准备 | P22、P23、P24 | 前置工具 P25 不依赖客户端；最终模型齐备后切换/恢复、装配、真实验收及独立审查 |

| id | depends_on | owner_role | validator_role | 主要产出 |
| --- | --- | --- | --- | --- |
| P01 | 无 | backend_implementer | backend_validator | 固定 BA/adapter 的事务及团队扩展合同 |
| P02 | P01 | frontend_implementer | frontend_validator | 固定 UI 来源、兼容组件及 client 插件 |
| P03 | P01 | backend_implementer | backend_validator | schema、受限角色、clocks/assurance/命令表 |
| P04 | P03 | backend_implementer | backend_validator | 单写 executor、finalizer 与 outbox |
| P25 | P04 | backend_implementer | backend_validator | 前置 M0–M3 工具及 legacy/ba 权威请求矩阵 |
| P05 | P04、P25 | backend_implementer | backend_validator | 双层 Scope/版本与公开选择 DTO |
| P06 | P05 | backend_implementer | backend_validator | 公司开通/暂停/恢复及固定 payer |
| P07 | P02、P06 | frontend_implementer | frontend_validator | 唯一选择状态机与空态 |
| P08 | P06 | backend_implementer | backend_validator | 邀请、固定角色、owner 保护与旧入口转译 |
| P09 | P08 | backend_implementer | backend_validator | 无提权的指定团队管理命令 |
| P10 | P07、P09 | frontend_implementer | frontend_validator | 公司/成员/团队/公开邀请 UI |
| P11 | P08 | backend_implementer | backend_validator | 公司会话证明和追加认证 |
| P12 | P11 | backend_implementer | backend_validator | SCIM/JIT、全局禁用及跨部署主体绑定 |
| P13 | P10、P12 | frontend_implementer | frontend_validator | 登录账户、追加认证、平台管理 UI |
| P14 | P09、P12 | backend_implementer | backend_validator | 内容/资源/Memory 真实授权 |
| P15 | P14 | backend_implementer | backend_validator | 敏感下载代理与旧直连能力关闭 |
| P16 | P14 | backend_implementer | backend_validator | 执行/Worker/审批/租约固定身份与 payer |
| P17 | P15、P16 | backend_implementer | backend_validator | 外部状态、入站/事件、观测与配额接点 |
| P18 | P16、P17 | backend_implementer | backend_validator | 公司/个人账务、财务授权、容量/审计 |
| P19 | P13、P18 | frontend_implementer | frontend_validator | Desktop 选择和原生认证交接 |
| P20 | P13、P17、P18 | frontend_implementer | frontend_validator | Mobile/OpenMuse 选择和原生认证 |
| P21 | P13、P17、P18 | frontend_implementer | frontend_validator | 全业务 UI、缓存、流与账务回归 |
| P22 | P25、P19、P20、P21 | backend_implementer | backend_validator | 停写迁移、投影重建、恢复与回退工具 |
| P23 | P22 | backend_implementer | backend_validator | 实际入口装配、authority gate 和覆盖核对 |
| P24 | P23 | 主控（只写证据） | backend_validator、frontend_validator、reviewer | BA01–BA20、完整 Review/OCR、发布准备材料 |

全部任务初始为 pending；G0 放行后才可启动 P01。deps 是接口与数据前置关系，不是“同属切片”关系。源码和测试精确路径在各 Task 中，生成的 Drizzle 序号以实际 journal 为准，不预占可能与其他工作冲突的序号。

## 3. 共享文件、任务预检与恢复

| 共享文件组 | 串行拥有顺序 | 派发前核验 |
| --- | --- | --- |
| 默认/BA Web/BA Mobile 配置及 engine manifest | P10 默认排除 BA 子树、建 Web/preflight/audit → P20 建独立 Mobile 配置 → P24 只读 | 收集互斥，文件/配置/实际 target/origin/build digest 对账；缺 origin 访问前退出 |
| package/lock/client 插件 | P01 → P02 → P13 | 服务端/客户端版本一致，P02 registry 来源固定，锁文件无无关升级 |
| schema/migrations/connections | P03 → P04 → P14 → P16 → P18 | 每次 journal 最新、schema barrel/显式清单同步，权限不扩大 |
| contracts/Scope/gate/revocation/assurance | P04 先产 CompanyAssurance 类型/关闭实现及 authority → P05 → P11 → P14/P16 | 新版本字段和 proof 注入必需，无可选比较/伪 Scope |
| Directory/Identity/executor/ingress/Principal | P01 → P04 → P06/P08/P09 → P11/P12 | operation 表唯一、原生与私有权限一致、finalizer 之后无目录 DML |
| selection/cache/streams/UI | P02 → P07 → P10 → P13 → P21 | 单一选择来源、旧代际不能回写、后端决定权限 |
| app/index/startup/Worker | 各任务仅接自有服务 → P23 总核验 | 实际注册顺序、SCIM 全方法、服务端/后台/脚本同协议 |
| 测试分区 manifest | P01 建组 → 各新增测试 Task 的受限登记增量 → P24 只读对账 | 只收本 Task 文件，native/driven 唯一，目标实际执行且漏登记失败 |
| OpenMuse 子模块及真实 App 接线 | P17 独占后端 BFF 文件 → P20 独占移动客户端文件 | 两仓 dirty baseline、局部规则、独立源码检查点及 Review |

每个 Brief 必填：Task ID/Spec 章节/验收；depends_on 已 verified 的检查点；owner/validator/reviewer；owned_files 完整展开；Consumes/Produces 精确签名；测试分区/命令/预期；不提交策略；失败处理；报告路径。Task 的测试、业务与装配范围一起交付；不得将测试或实际路由接线留给验证者补写。

恢复时先读执行 Run 的 index/Ledger、Git 与检查点 hash，核对哪些任务已集成，禁止重派已 verified 任务。当前规划时文件变化、真实路径差异或外部环境缺失都写具体事实；没有覆盖证据不以“已有大量代码”判定完成。

## 4. 自查及后续执行方式

- [x] 对照 Spec BA-R01–BA-R12 与 BA01–BA20、interfaces.md 和 acceptance.md 完成需求/接口/测试映射，所有依赖引用存在且无环。
- [x] 核验 owned_files 已存在或明确 Create，动态生成文件有确定生成方法和 manifest；未展开的扩展清单在派发前固化，不授整个仓库写权限。
- [x] 核验 Review Focus 五类均有任务用例，版本/字段/命令命名一致，未启用高风险功能没有默认开放入口。
- [x] 本文没有运行结论；本轮文档自检结果在规划 Run，实施证据只绑定实施检查点，不能混用。

用户当前要求将审核修正方案写回设计及配套计划，结束于方案文档交付。若后续明确要求执行，按现有工程规则默认 SDD 沿 DAG 串行推进；无需再就执行方式重复确认。先完成 G0，P01/P02 取得可行性证据后再进入目录与业务接入，任一可行性阻塞先修订事实源，不把尚未批准 Spec 默认为已批准。

实施时以数字 1–25 调用 SDD `task-brief`，P01–P25 是 DAG 稳定 ID；Task 25/P25 物理放在 Task 4 之后，拓扑顺序 P01→P02/P03→P04→P25→P05…，编号不代表执行顺序。例如 `bash <技能目录>/scripts/task-brief docs/plans/2026-10-22-better-auth-full-integration/plan.md 1 .archive/runs/<执行 run>/briefs/P01-brief.md`；先创建目标目录，替换路径参数。使用其第三个输出参数，避免报告误落默认临时目录。Review Package/独立 Report/验证证据全部按项目规则归档；工具必须创建的 scratch 只作临时位置，Ledger 以本次 Run 为事实源并核对计划身份。每份 Brief 另带原文 Global Constraints、必要接口及前置检查点，不给实现者整份主会话。规划自查不代替开工后的共享文件/接口逐对预检。

## 5. 详细任务

### Task 1: P01 — 固定依赖，证明事务/hook、SSO 证据与测试驱动可行

**Dependencies / Roles:** 无；backend_implementer → backend_validator → reviewer。对应 T01、BA08/BA18/BA17。

**Files:** Modify `server/package.json`, `app/package.json`, `bun.lock`；Create `server/src/auth/directory/contracts.ts`, `server/src/auth/directory/transaction-adapter.ts`, `server/src/auth/directory/team-extension.ts`；Create `server/tests/better-auth/transaction-contract.test.ts`, `server/tests/better-auth/support/fixture.ts`, `server/tests/better-auth/support/schema.ts`；Modify `scripts/lib/e2e-manifest.mjs`, `tests/config/e2e-bun-suites.json` 仅限新测试目录的隔离分组和有 Bun 加载证据的分区增量；Create `server/src/auth/sso-evidence.ts`, `server/tests/better-auth/sso-evidence-contract.test.ts`；Modify `tests/bun-suites.test.ts`, `scripts/e2e-coverage-audit.mjs`；Create `tests/support/bun-suite-env.ts`, `tests/bun-suite-env.test.ts`, `tests/e2e-manifest-contract.test.ts`（Node/e2e-compat，不加入 driven）。

**Interfaces:** Consumes 现有 `createAuth`/Database 与实际 1.7.1 包源码；Produces interfaces.md §2–3 的最小 Directory/Identity/PrincipalRegistry/TeamMutationCapability 类型、TransactionBoundBa/BaTxOutcome、hook 分类登记、SsoEvidenceBridge 和团队扩展，测试隔离 schema，不开放组织端点。

- [ ] **Step 1 — 建立真实夹具与失败用例。** `support/fixture.ts` 导出 `createBaFixture(): Promise<BaFixture>`；fixture 提供真实数据库、受限连接、认证用户及 HTTP Request 调用、测试后清理。使用独立 `openbot_enterprise_*` 测试库和明确 URL，缺配置标 blocked。`transaction-contract.test.ts` 命名用例 `invite_accept_nested_tx_rolls_back_every_write`，注入 member/投影/审计/outbox 故障，核心断言 `expect(after).toEqual(before); expect(sentMail).toHaveLength(0)`。
- [ ] **Step 2 — RED。** 按 acceptance.md V-B 执行该文件；先确认 DB/测试已收集，再确认当前接入不能满足外层原子回滚。
- [ ] **Step 3 — 实现版本绑定与适配。** 所有直接 BA 核心及适用配套包锁定经核实的兼容精确版本；候选为当前本地 1.7.1，不盲升级。显式将 tx 绑定请求/服务端调用；内部 transaction 复用外层 ALS store/tx，不误认 1.7.1 自动创建 savepoint；显式补偿用 savepoint，保留最初 SQLSTATE/cause。原生 HTTP 写请求不得经 `auth.handler` 进入事务——其 `runWithAdapter` 每请求新建 ALS store（`isTransactionActive:false`）覆盖外层并自行 drain hooks；ingress 形态固定为转译 `auth.api.<endpoint>({headers, body, query, asResponse})`，P01 用真实 HTTP 请求证明该约束。adapter transaction:true 不依赖 SCIM；外层 executor 独占 pendingHooks，先分类再 finalizer/commit，提交后只 drain read-only/已核验 disabled-cache-noop，回滚不 drain。BA 权威 factory 固定禁用 secondaryStorage/cookieCache、session/verification 落同一 DB；覆盖固定版 deleteCachedUserSessions/mirrorSessionToSecondaryStorage/refreshUserSessions 三来源，不能把内部缓存写当只读。必须原子的 seedRole/recordProvisioned/stampSignIn 迁移模板放 finalizer，通知 outbox，applyConfiguredAdmin 禁止登录提权；实际生产 factory 接线 P04/P12 按 authority 分支落定。禁止全局可变当前连接或 after 闭包全局 DML；测试用触发器和最小 finalizer 验证真实 DML 顺序。
- [ ] **Step 4 — 验证关键合同。** 增加 `two_parallel_requests_never_share_tx`, `team_before_member_is_legal_only_when_final_state_valid`, `missing_finalizer_rejects_commit`, `native_http_handler_is_never_used_for_directory_writes`, `server_api_scim_jit_use_same_tx`, `scoped_team_extension_has_no_admin_session`、`identity_command_security_writes_share_tx`、`verification_mail_is_not_sent_before_user_commit`。`native_http_handler_is_never_used_for_directory_writes` 对每条目录写端点发真实 HTTP 请求，断言请求内 BA 写与 executor 外层事务的 `txid_current()` 相同——只用 auth.api 夹具会产生假阳性。以源码扫描生成固定版不经 ALS 的 `ctx.context.adapter` 直写清单并与 interfaces §3.1 逐项一致，包升级引入清单外直写必须失败。在隔离的固定插件配置中证明各入口可受事务包装；实际 OpenBot 全部 provisioning/运行期装配分别由 P12/P23 完成，不产生任务循环。增加 `deferred_after_hooks_are_classified_not_dropped`、`after_hook_writes_cannot_use_global_connection`、`disabled_secondary_storage_hooks_are_accounted_for`、`secondary_storage_or_cookie_cache_config_is_rejected_before_routes`、`request_reset_token_and_outbox_receipt_share_tx_despite_swallowed_callback_error`、`invite_compensation_preserves_original_sqlstate`、`scim_first_provision_hook_failure_rolls_back_roles_projection_members_and_clocks`；实际 SCIM HTTP 首建夹具对每个迁入 hook 写注故障，roles/SCIM projection/member/clock 要么全有要么全无。
  在 sso-evidence-contract.test.ts 用签名测试 OIDC/SAML IdP，测试 `oidc_auth_time_equals_verified_id_token_claim`、`saml_authenticated_at_equals_assertion_authn_instant`、`tampered_state_or_relay_state_never_persists_proof`；按 interfaces §5 证明自有 callback/ACS 原始证据和 challenge 关联，不能靠 provisionUser userInfo。任何已启用协议证据缺口都 blocked。
  测试基础设施同步交付：writeManifest 保留既有组/稳定新岛批次、files/groups 一一对应，coverage-audit 对 `files_only_registration_is_rejected` 非零；`new_ba_file_does_not_rename_existing_groups` 固定原组名。bunEnv 抽到 support 模块，BA island 先于 MT 分支匹配；BA_TEST_DATABASE_URL 映射 TEST_DATABASE_URL/DATABASE_URL/ENTERPRISE_TEST_SETUP_DATABASE_URL，BA_TEST_DIRECTORY/DATA/OPERATOR_DATABASE_URL 分别映射 ENTERPRISE_TEST_*，BA_TEST_AUTH_WRITER_DATABASE_URL 原名传给夹具。缺任一专用连接失败、不继承 MT/共享开发 URL；`ba_island_receives_all_isolated_role_urls` 用假 DSN 捕获实际子进程 env，日志只写角色存在性。无匹配组/零实际用例非零。记录实际 `pg_backend_pid`/事务身份、源码包 hash、hook 与发信行为；合法全成、非法全回滚、并发不串。
- [ ] **Step 5 — 保存检查点与可行性报告。** 报告支持/失败的每条写路径、hook 分类表、OIDC/SAML 签名证据和 driver URL/分区反例。无法安全绑定、私有 adapter 不能复用或插件提前发送不可拦截副作用时，本 Task blocked，停止依赖任务并修订设计；不使用异步投影/临时管理员代替。

### Task 2: P02 — 验证并固定 Better Auth UI 组件与客户端组合

**Dependencies / Roles:** P01；frontend_implementer → frontend_validator → reviewer。T01、BA01/BA17。

**Files:** Modify `app/package.json`, `bun.lock`, `app/src/lib/auth/client.ts`；Create `app/src/lib/auth/ui-source.json`, `app/src/lib/auth/ui-compatibility.test.tsx`, `app/src/lib/auth/ui-provider.tsx`, `app/src/lib/auth/organization-plugin.tsx`, `app/src/lib/auth/auth-plugin.ts`；Create/导入官方 registry 必需的 Auth/Settings 基础组件到 `app/src/components/auth/`，Organization 组件固定到 `app/src/components/auth/organization/`；实际精确文件清单写入 ui-source.json；只导入 P0 所需依赖，不改全站主题。

**Interfaces:** Consumes P01 固定 BA 版本；Produces `organizationClient`、本地 `organizationPlugin` 与 `OpenBotAuthProvider({children}: PropsWithChildren): ReactElement`；provider 复用现有 QueryClient/Router，包装已校验 registry 组件，记录来源 URL/commit 或内容 digest、许可证及文件 SHA-256；不假定 registry latest 是兼容版本。

- [ ] **Step 1 — 写兼容用例。** `renders_organization_shell_with_existing_router_and_query_provider`，使用当前 React/Router/Query provider；`expect(screen.getByRole('navigation')).toBeDefined()`，并断言无 Next.js 导入、无第二个 query client、危险组件不展示。增加 `organization_components_do_not_call_x_class_endpoints`：OrganizationSwitcher/Members 等组织组件默认经 client hook 读取已分类为 X 的原生 GET（/organization/list、list-user-teams、get-invitation、list-user-invitations），断言接入后的组件树不调用这些端点。
- [ ] **Step 2 — RED。** V-F 执行该文件，缺组件/插件导致目标断言失败；网络不可用是来源阻塞，不算 RED。
- [ ] **Step 3 — 导入最小匹配 registry 产物。** 先下载到隔离临时目录核对来源和依赖，选择匹配固定 BA 的产物后保存根目录、来源和精确文件清单并接现有路由；P02 独占生成清单内文件。保留 `ssoClient`，新增组织/团队能力；不运行未经审查的全量 latest 覆盖。对每个组织组件在 ui-source.json 显式声明“注入 OpenBot adapter”或“不复用该组件”——组件默认读取的 X 类原生 GET 必须由注入的 adapter 替代；未声明的组件不得进入渲染树。
- [ ] **Step 4 — GREEN。** V-F、app typecheck；组件可渲染、client methods 类型正确，创建个人空间/动态角色/裸删除/模拟登录关闭。无法兼容则阻断 P07，提交具体差异，不另起 UI 框架。
- [ ] **Step 5 — 保存来源和检查点。** 后续 P07/P10/P13 只在已导入组件中接业务 adapter；需要新增生成文件先扩充该版本清单并审查。

### Task 3: P03 — 追加目录、持久版本、证明与数据库能力模型

**Dependencies / Roles:** P01；backend_implementer → backend_validator → reviewer。T02、BA09/BA15/BA19。

**Files:** Create `server/src/db/schema/auth-directory.ts`, `auth-eligibility.ts`, `auth-assurance.ts`；Modify `server/src/db/schema/core.ts`, `server/src/db/schema/enterprise-tenancy.ts`, `server/src/db/schema/company-finance.ts`, `server/src/db/schema/enterprise-credentials.ts`, `server/src/db/schema/access-grants.ts`, `server/src/db/schema/gateway.ts`, `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `server/src/enterprise/tenancy/connections.ts`；Create 生成的 `server/drizzle/*_better_auth_directory.sql` 及对应 meta/journal 增量；Create `server/tests/better-auth/schema-roles.test.ts`。

**Interfaces:** Consumes 固定插件 schema + interfaces.md；Produces auth directory/binding、durable clocks、命令/变更键/receipt/outbox、challenge/assurance、authority version/phase/directoryAuthority/release gate 表，P04 读取接口；Principal identityGeneration/唯一 user 绑定，新增团队管理 Grant 与批准 provisioning rule，以及凭据授权来源代际和投影团队版本；验证过的 AuthDirectoryDatabase 能力连接。

- [ ] **Step 1 — 写 schema/角色反例。** `same_workspace_id_in_two_companies_maps_to_distinct_teams` 与 `runtime_roles_cannot_write_projections_or_reset_clocks`：`expect(bindingA.teamId).not.toBe(bindingB.teamId)`；真实 data/reader/operator 直接写受保护列均拒绝，旧 FK 仍存在。
- [ ] **Step 2 — RED。** V-B；缺表/权限边界被测试明确捕获，环境健康后再记录 RED。
- [ ] **Step 3 — 建模并生成 expand 迁移。** Organization 沿用 Tenant ID；team 新全局 ID + 旧复合 binding，绑定不可换公司。唯一成员键，clock 稳定四列键和 tombstone，版本安全整数约束；既有 epoch 列保持 integer，新建 clock/代际列用 bigint（interfaces §2），迁移不改既有列类型，identityGeneration 服务器控制。现有资源/财务 Grant 追加适用安全版本列；新建 auth_team_management_grants、auth_provisioning_rules，字段/唯一键/固定动作按 interfaces.md，不假设有既有团队管理 Grant。凭据动作保存受权人 identity/company generation，团队来源另存 team generation；个人凭据保存 owner 的 identity/company generation。expand 阶段旧行可空但不填默认代际，新权威下缺版本不可有效，P09/P14/P18 接签发检查，P22 核验旧行。个人 access_grants 保存授权 user/principal/identityGeneration，gateway_virtual_keys 保存来源 identityGeneration，独立于公司成员资格；expand 可空不自动按 active 补代际，BA 签发/准入缺版本拒绝。P12 签发、P16 实际准入、P25/P22 迁移核验。Tenant status 加 provisioning。challenge 存储 token 摘要和一次消费状态，不保存明文秘密。
- [ ] **Step 4 — 安装 DML guard 与延迟约束框架。** 命令/receipt 区分 company 与 identity 域，identity 目标 user 不要求 tenant；限定 writer、迁移及函数 owner 权限，固定 search_path、撤 PUBLIC EXECUTE；投影/clock 仅受控函数更新。明确 PrincipalRegistry 与 CompanyAssurance.require 的角色 GRANT：auth-writer 经受控函数获得 principals 的必要写，data 角色获得 clocks/assurance 的受控读（require 在 data-role 业务事务内调用，interfaces §5），缺授权在 schema-roles 反例与启动检查中失败。新增文件同时加入 schema barrel 和 drizzle 显式列表，核验 journal 单调；M1 保留旧 writer 权限/旧隔离路径，新组织写关闭；收旧 DML 只在 M4 同事务切换，不随 expand 提前执行。
- [ ] **Step 5 — GREEN 与检查点。** V-B + server typecheck；在空库及含旧身份/历史 FK 的 fixture 迁移成功，错 role/schema/缺表启动拒绝。未知 owner、重复关系不自动修正；阻断对应回填，不破坏现有数据。

### Task 4: P04 — 完成唯一写 executor、最终状态终结和提交后副作用

**Dependencies / Roles:** P03；backend_implementer → backend_validator → reviewer。T02、BA08/BA18。

**Files:** Create `server/src/auth/directory/executor.ts`, `finalizer.ts`, `ingress.ts`, `outbox.ts`, `principal-registry.ts`, `identity.ts`, `authority.ts`, `read-gate.ts`；Create `server/src/auth/company-assurance.ts` 的 CompanyAssurance 类型/关闭实现；Modify `contracts.ts`, `transaction-adapter.ts`, `server/src/auth/index.ts`, `server/src/app.ts`；Modify P03 受控函数的新增迁移；Create `server/tests/better-auth/directory-command.test.ts`, `ingress-coverage.test.ts`, `principal-registry.test.ts`, `identity-command.test.ts`；Create `server/tests/better-auth/support/authority-matrix.ts`（基础 withAuthorityMatrix，P25 扩充）。

**Interfaces:** Consumes P03 能力连接、P01 tx adapter；Produces `Directory.execute`、`Identity.execute` 协议、`PrincipalRegistry.ensure(tx,userId)`、finalizer 和提交后 outbox；Produces interfaces §3.3 DirectoryAuthority/read gate 及 §5 createClosedCompanyAssurance；两类 operation/payload/actor 按 interfaces.md 分域，P12 接实际身份管理入口，不用虚构 tenant。member.provision、team.management.grant/revoke、provisioning.rule.approve/revoke 及角色/Grant/规则三类团队能力在此注册，后续完成表内动作。

- [ ] **Step 1 — 写原子性与绕过测试。** `missing_command_or_unknown_action_rejects_dml`, `idempotent_replay_does_not_advance_versions`, `audit_failure_rolls_back_invite`、`principal_creation_and_member_write_roll_back_together`、`concurrent_first_membership_creates_one_principal`、`identity_finalization_failure_rolls_back_security_state`；断言 `expect(replayed.commandId).toBe(first.commandId)`、版本不变、失败后所有表快照一致。
- [ ] **Step 2 — RED。** V-B 本任务全部目标文件，确认真实 HTTP 请求经 ingress 转译为 `auth.api` 调用后与 `auth.api`、私有扩展触达同一协议；`auth.handler` 每请求重建 ALS store，不得作为事务内写路径（F-01）。
- [ ] **Step 3 — 实现 executor/finalizer。** 可信 actor → tenant 排他及 user/principal/member 稳定锁序 → 锁内授权 → receipt payload hash → BA 同步步骤 → 核对 hook 分类/pendingHooks → finalizer → commit → drain read-only/disabled-cache-noop。DML 只登记变更键；终结时校验最终 BA 集合、推进 clock、先公司/团队存根及公司成员再团队投影、写审计/outbox，具名 SET CONSTRAINTS IMMEDIATE；终结后禁止新目录 DML。PrincipalRegistry 在 principal 层初始化真实新主体或沿用既有绑定，历史损坏不当新建，finalizer 检查完整绑定。Identity 使用独立信封、user/principal 锁和平台域终结，不在持 principal 后等待 tenant；有效安全状态变化、session 撤销、审计/receipt 同事务。
- [ ] **Step 4 — 接 ingress 与副作用。** 固定版本将 organization/provisioning 分类到 Directory，Admin 安全写及 session revoke 分类到 Identity；未知类别拒绝，普通注册/登录不要求 tenant；未知变更 fail closed；原生 HTTP 与服务端 API 不导出裸写 handler。ingress 把原生 HTTP 目录写请求转译为外层事务内的 `auth.api.<endpoint>({headers, body, query, asResponse})` 调用，禁止在事务内调用 `auth.handler`（每请求重建 ALS store 并另开事务）；SCIM PUT/PATCH/DELETE 同样转译。邮件/webhook 实际发送在提交后 outbox，幂等投递；通知失败不改变实时撤权。保留普通身份非致命登录审计合同。原生 GET/POST 逐条按 interfaces §3.2 分类，DirectoryReadGate 在同一读事务核验 lifecycle/proof，暂停成员/公司和缺 proof 的每个目录 GET 均拒绝；自身发现/邀请使用 OpenBot 自有 adapter；对应原生 GET 关闭，BA 每个 organization GET 均有三类反例。设置 allowUserToCreateOrganization:false、disableOrganizationDeletion:true，dynamicAccessControl 关闭、Admin impersonate 权限移除，ingress 明确拒绝删除/模拟登录。P04 注册所有 Identity operation，提供恢复 ingress 复用的内部同连接身份事务边界与 token/outbox receipt 提交围栏；P08 实现 recovery actor 的锁内签发、原生 route 唯一消费和请求邮件围栏，P12 完成 Admin 创建/编辑/密码/批撤 session 接线。BA 权威 factory 启动拒绝 secondaryStorage/cookieCache 和 backgroundTasks.handler，session/verification 强制 DB 存储；实际缓存 hook 按 interfaces §3.1 登记，不丢无存储下仍登记的 refresh no-op。
  authority.ts 在当前 tx 读取/比较持久 AuthorityState，实现 legacy/paused/ba 分支与独立写/release gate；身份/目录最终写都检查当前 authorityVersion。company-assurance.ts 先产类型与关闭实现，无 proof 要求可 null，需要 proof 则受控拒绝；P11 才接完整证据。
- [ ] **Step 5 — GREEN 与检查点。** V-B、server typecheck；逐阶段故障、并发幂等同键异 payload、teamMember→member/反向删除均符合合同。legacy authority 下保留原 SCIM/JIT/旧目录受控写，BA 分支在 P12 接线前关闭；M2/M3 才统一暂停目录写。新增 `native_directory_get_matrix_checks_lifecycle_and_assurance`、`disabled_native_admin_and_deletion_routes_are_refused` 和两种 authority 回归，不为兼容放开 BA 无 envelope 写入。

### Task 25: P25 — 前置 M0–M3 工具与 authority 双轨夹具

**Dependencies / Roles:** P04；backend_implementer → backend_validator → reviewer。T02、BA15/BA18/BA19；在 P05 之前执行，稳定编号不按数字排期。

**Files:** Create `server/scripts/better-auth/inventory.ts`, `migrate-directory.ts`, `verify-directory.ts`, `server/tests/better-auth/migration-expand.test.ts`；Modify P04 的 `server/tests/better-auth/support/authority-matrix.ts` 及 `server/src/auth/directory/authority.ts` 的离线迁移能力。脚本 P22 随最终 schema 扩展，禁止复制第二套 M0–M3 工具。

**Interfaces:** Consumes P03 schema、P04 DirectoryAuthority；Produces `withAuthorityMatrix(fixture, scenario): Promise<void>`（legacy/paused/ba 三种真实 DB 状态，每个场景断言相同请求行为），M0–M3 显式阶段 CLI，以及 legacy 目录写入者静态清单（逐项写明处置阶段，P08/P12/P22 消费），后续 Task 消费。CLI 默认 dry-run、显式隔离目标 URL/phase，真实生产运行不在本任务授权内。

- [ ] **Step 1 — 写 RED。** `legacy_authority_keeps_existing_tenancy_green`：BA 表未回填/clock 缺失时 legacy 的既有公司读取/管理成功，ba 分支拒绝缺 clock；`paused_authority_rejects_all_directory_writers` 覆盖 UI/API/CLI/SCIM/JIT/startup。`m0_m3_never_create_ba_only_runtime_writes` 验 shadow 不变成第二主。`legacy_tenants_receive_deterministic_unique_slugs` 验每个回填 tenant 获得按 interfaces §2 规则派生的归一化、唯一、重跑幂等的 slug：冲突按稳定后缀、重跑不重派、BA 唯一约束违例阻断。
- [ ] **Step 2 — 运行 RED。** V-B 目标文件与现有 multitenancy 的 workspace-scope/migration-tool 适用用例，确认实际收集后因缺双轨合同失败。
- [ ] **Step 3 — 实现工具与夹具。** inventory 保存稳定映射/owner/payer/授权来源/已知撤权高水位；同时产出 legacy 目录写入者静态清单，覆盖 UI/API/CLI/SCIM/JIT/startup 及非路由写入者（`deletion-semantics.ts` 的 operator 直删团队行/停用成员、`root-backfill.ts` 的 raw SQL insert principals/memberships、`scripts/enterprise-runtime-seed.ts` 的启动种子），逐项写明处置阶段，清单外写入者被扫描发现即失败；M2 inventory 核验 `sso_providers.organization_id` 存量为空，非空阻断。M1 expand 不改 legacy 路由；M2 明确停目录写、幂等回填，M3 集合/键/版本/FK/付款对账。旧个人模型 Grant/Key 只在有授权历史证据时重签，否则撤销并要求重新授权，不能以当前 active 推断历史。未知 owner/归属/代际阻断切换。
- [ ] **Step 4 — 验证失败与重试。** 迁移 actor 仅离线停写可用；失败后 legacy 或 paused 状态确定且 authorityVersion 不倒退，不发通知/模型调用、不变历史 payer。后续任务新增 schema 必须扩充映射 manifest，旧工具不得因缺新表而宣称 M3 完成。
- [ ] **Step 5 — GREEN 与检查点。** V-B，legacy 既有多租户回归和 BA 缺版本反例均通过；报告 M0–M3 工具可用，不宣称已执行生产迁移。任何未分类 writer 使 P05 blocked。

### Task 5: P05 — 可信 Scope、双层持久版本与选择 API

**Dependencies / Roles:** P04、P25；backend_implementer → backend_validator → reviewer。T03、BA02/BA06/BA07/BA09。

**Files:** Modify `server/src/enterprise/contracts.ts`, `server/src/enterprise/tenancy/store.ts`, `server/src/enterprise/tenancy/scope-gate.ts`, `server/src/enterprise/tenancy/revocation.ts`, `server/src/enterprise/tenancy/workspace-admin.ts`, `server/src/enterprise/tenancy/workspace-scope-routes.ts`；Create `shared/auth-directory.ts`, `server/tests/better-auth/scope-generations.test.ts`, `selection-api.test.ts`。

**Interfaces:** Consumes Directory/clocks；Produces interfaces.md §4 的 DTO、扩展 PlatformScope 和 validate-selection；P04 已生产 CompanyAssurance 类型/createClosedCompanyAssurance，require 是必需注入。legacy 继续既有 gate；ba 分支在 P11 前仅无证明需求公司可通过，需证明则拒绝。

- [ ] **Step 1 — 写实时撤权与 selector 测试。** `removed_rejoined_member_cannot_reuse_scope`, `forged_scope_json_is_rejected`, `explicit_b_company_does_not_follow_active_a`, `mixed_company_and_team_returns_refusal`；`expect(oldScopeResult.code).toBe('SCOPE_REVOKED')`，新 scope 正向成功，伪造对象不得执行 operation。
- [ ] **Step 2 — RED。** V-B；复用现有 gate 真实共享锁/角色 fixture，移除重加后当前 active 不足以放行旧版本。
- [ ] **Step 3 — 扩展 resolver/gate。** 新增团队 epoch、公司/团队 generation 和 identityGeneration；先在事务内读取 AuthorityState，ba 分支才比较 clock、lifecycle、session/actor 并调用 proof；legacy 不查未回填 BA clock/关系，paused 按 §3.3 处理。所有字段仅服务器读取，保留 WeakSet 签发约束与事务本地 RLS 清理；不从 headers 或 stored JSON 获取权威。
- [ ] **Step 4 — 实现 listing/validate-selection。** 输出稳定业务 ID 与 BA ID；公司管理不依赖团队选择；显式冲突 400、隐藏对象 404、存储故障 503，active 不覆盖显式目标。服务不可用不 fallback。
- [ ] **Step 5 — GREEN 与检查点。** V-B + 现有 `server/tests/multitenancy/workspace-scope.test.ts`/`server/tests/enterprise/tenancy-rls.integration.test.ts` 对应受影响部分，连接池复用后不能遗留 app.*。ba 分支字段缺失关闭操作，不能只做可选比较；legacy_authority_keeps_existing_tenancy_green 必须覆盖未回填的现有租户。

### Task 6: P06 — 平台开通、暂停恢复与公司生命周期

**Dependencies / Roles:** P05；backend_implementer → backend_validator → reviewer。T03、BA04/BA05/BA12。

**Files:** Create `server/src/auth/directory/lifecycle.ts`, `server/tests/better-auth/company-lifecycle.test.ts`；Modify `server/src/enterprise/tenancy/provision.ts`, `company-admin-routes.ts`, `server/src/billing/payer-company.ts`, `payer-binding.ts`, `server/src/app.ts`。

**Interfaces:** Consumes Directory、固定 payer 服务；Produces company.provision/suspend/restore/deletion.request，平台 `POST /api/enterprise/companies` 接 `{name,slug,ownerUserId,defaultTeamName}` 和幂等头；平台动作授权与公司 role 隔离。

- [ ] **Step 1 — 写开通失败/重试测试。** `billing_initialization_failure_keeps_company_provisioning`；`expect(company.status).toBe('provisioning')`，业务拒绝；重试后一个 Tenant、organization、默认 team、owner 与 payer 映射，原 ID 不变。
- [ ] **Step 2 — RED。** V-B，区分本地原子失败和外部初始化失败；模拟外部边界用于故障注入，真实 provider 验收留 P24。
- [ ] **Step 3 — 实现开通和恢复命令。** 平台确认目标 owner，不能采用首个用户；在同一命令内调用 PrincipalRegistry.ensure，不要求 seed 先建主体；本地记录同事务，外部 Customer/供应商通过幂等 outbox，全部就绪才 active。裸 BA create organization 不能成为自助旁路。
- [ ] **Step 4 — 补暂停/删除申请。** 公司状态变更和受影响资格版本在受控锁中串行化，暂停/恢复不复活旧能力；公司暂停拒绝普通业务/目录管理，仅受控恢复及停用原因查询。删除申请检查资产、运行、费用与保留期，首期不物理级联删除。
- [ ] **Step 5 — GREEN 与检查点。** V-B；无 owner/付款映射冲突/容量失败有确定拒绝，不发半份初始权益；控制面管理权不产生客户内容读取权。

### Task 7: P07 — Web 唯一公司/团队选择与缓存代际

**Dependencies / Roles:** P02、P06；frontend_implementer → frontend_validator → reviewer。T03、BA02/BA13。

**Files:** Modify `app/src/lib/enterprise/tenant/selection.ts`, `scoped-cache.ts`, `stream-scope.ts`, `app/src/routes/_authed/tenant/selection.tsx`, `app/src/routes/_authed/_app.tsx`；Create `app/tests/better-auth/scope-selection.test.tsx`；Modify P02 的 organization-switcher/team-switcher adapter。

**Interfaces:** Consumes ScopeListing/ValidatedSelection、BA active preference；Produces 单一业务 selection 状态，已有 `selectWorkspaceScope` 接线新 validate-selection 并保持 query/cache generation 合同。

- [ ] **Step 1 — 写切换/竞态用例。** `late_a_response_cannot_commit_after_b_selection`, `failed_switch_never_displays_b_with_a_headers`, `other_tab_switch_aborts_old_stream`；`expect(renderedTenant).toBe(sentTenantHeader)`、旧代际 UI 写入为零。
- [ ] **Step 2 — RED。** V-F；用可控 promise 交错 active/validate/query/mutation，不靠任意 sleep 决定时序。
- [ ] **Step 3 — 实现唯一切换协调。** 先冻结旧交互、校验目标、更新 BA 偏好，再递增/传播代际、取消旧请求及后续写、清 cache/断流/临时凭据，最后发布 selection；失败保持无范围或原已验证范围。BA team.id 经 binding，不直接当 workspace.id。
- [ ] **Step 4 — 补空态和身份清理。** 无公司、待邀请、无团队、公司暂停、追加认证不足分别呈现；首期不显示完整个人工作台/自助开通。登出/换账号/移除同步清全部身份和范围缓存，长任务范围保持。
- [ ] **Step 5 — GREEN 与检查点。** V-F + app typecheck；可从无团队状态管理允许的公司设置，不对公司 API 发无 Scope 的默认请求。

### Task 8: P08 — 邀请、固定角色、owner 保护和旧管理入口转译

**Dependencies / Roles:** P06；backend_implementer → backend_validator → reviewer。T04、BA04/BA05/BA06/BA18。

**Files:** Create `server/src/auth/directory/membership.ts`, `server/src/auth/directory/read-routes.ts`, `server/src/auth/mail.ts`, `server/src/auth/password-recovery.ts`, `server/tests/better-auth/membership-lifecycle.test.ts`；Create `server/tests/better-auth/email-verification.test.ts`, `password-recovery.test.ts`；Modify `server/src/auth/index.ts`, `server/src/config.ts`, `server/src/index.ts`, `server/src/auth/directory/outbox.ts`, `server/src/auth/directory/ingress.ts`, `server/src/enterprise/tenancy/workspace-admin.ts`, `workspace-scope-routes.ts`, `company-admin-routes.ts`, `people-lifecycle.ts`, `deletion-semantics.ts`；Modify 旧目录 CLI 调用点以 P25 inventory 产出的 legacy 目录写入者静态清单为边界，新增清单需先在 Brief 明确文件。

**Interfaces:** Consumes executor/finalizer、实时管理授权；Produces interfaces.md 的 invitation/member/owner/team profile 动作；旧接口按 authority 分支：legacy 保持旧受控写，ba 才转译稳定 ID/Directory；Produces `createAuthMail(deps)` 的固定 BA sendVerificationEmail/sendResetPassword 和 AuthMailDelivery，P13 消费邮箱验证及 F006/F007；密码重置消费 P04 Identity.password.reset 内部同连接事务/安全终结合同；Produces interfaces §5.1 RecoveryIngress，两条原生 POST 由其独占包装。

- [ ] **Step 1 — 写邀请与最后 owner 测试。** `concurrent_last_owner_leave_and_demotion_preserves_owner`, `invitation_accept_requires_verified_matching_email`, `existing_member_role_is_not_overwritten`、`new_user_without_principal_accepts_invitation_atomically`、`password_signup_verify_then_accept_invitation`、`expired_or_changed_email_verification_link_is_rejected`；断言 `expect(activeOwners).toBeGreaterThanOrEqual(1)`，pending 无业务权、低角色邀请不改变既有角色。
- [ ] **Step 2 — RED。** V-B；accept 通过实际 BA 带团队邀请路径，包含 teamMember 先写的顺序。
- [ ] **Step 3 — 完成生命周期动作。** 锁内检查公司/邀请/有效期/邮箱/可委派角色/团队/容量，接受在同一命令内调用 PrincipalRegistry 并一次原子建立主体、成员、clock/投影及审计；邀请不授 owner/财务/平台角色。接受/拒绝不要求既有公司成员或公司 SSO proof，后续业务仍要求。更新 profile 限定字段，logo 走既有安全上传，slug 冲突/旧链接无跨公司解析。invitation.resend 由 OpenBot 受控命令实现（取消旧记录、新建邀请并保留审计），不进入原生 invite-member 的 resend 分支——该分支经 `ctx.context.adapter` 直写 expiresAt，在 executor 事务外提交（interfaces §3.1 直写清单）。实现 server mail callback/outbox：使用 BA 固定版验证 URL/过期校验、重发限流、加密投递秘密且不记日志，提交后经 G0 核验的 AuthMailDelivery 投递。固定 sendResetPassword 接入 factory，reset token 3600 秒、一次消费、本站 /reset-password、加密 outbox 和真实投递。依 interfaces §5.1 实现唯一顺序：request-reset 外层事务观察新 verification，callback 仅同 tx 写加密 outbox/receipt，原生吞异常后 executor 仍检查 callback 状态与 token/receipt 一一对应，失败保留原因并回滚；无用户无 token/邮件，延迟 callback 无有效 tx 不得写/发信。reset-password 用非授权定位→user/principal→verification 锁内重验→签发本 tx recovery actor→原生 BA POST 唯一消费 token/写 hash→Identity finalizer 推进代际、撤全部 session/proof→commit。禁止先消费 token、两次 Identity.execute、依赖 onPasswordReset 后补写；裸原生 HTTP/auth.api 不可绕过。Admin 密码写由 P12 平台 actor 使用同一 finalizer。revokeSessionsOnPasswordReset:true 不能代替此原子性。新增 `request_reset_receive_mail_set_password_then_sign_in`、`expired_or_consumed_reset_token_is_refused`、`untrusted_reset_redirect_is_rejected_before_delivery`、`reset_failure_rolls_back_hash_token_generation_and_sessions`、`native_reset_post_consumes_once_and_failure_leaves_token_retryable`、`request_reset_outbox_failure_rolls_back_token_despite_ba_success`、`late_reset_mail_callback_cannot_write_or_send`、`concurrent_reset_consumes_once_without_receipt_bypass`、`password_reset_invalidates_old_proof_and_long_lived_authority`；已 disable 用户不被恢复。纯 SSO 拒绝密码恢复。本人邀请列表/落地查询按 interfaces §3.2 接 read-routes.ts 自有 adapter，关闭对应 BA 原生 GET；未登录只给最小状态不泄露目录。不能把邀请模板当验证 sender；依赖缺失阻断相应账户闭环。
- [ ] **Step 4 — 完成移除/暂停/恢复与兼容。** company remove 清所有 BA team 关系但保留业务历史 FK，clock 单调，P03/P14 的凭据来源版本失效且不能另事务补清理；团队暂停旧入口转为移出。owner 交接/新增/退出/降级/暂停全部锁内保护；命令审计失败整体失败。任务范围内 seed/CLI/admin 在 ba 分支不再独立写目录；legacy 保持旧受控路径，M2/M3 统一停写，ba 的 SCIM/JIT 等待 P12。
- [ ] **Step 5 — GREEN 与检查点。** V-B；实际邮件分别覆盖注册→验证→接受及请求重置→收邮件→设密码→重新登录；验证邮件测试不能代替恢复。故障不提前发信；覆盖取消/过期/重发/重复接受、并发席位竞争、角色失效、团队跨公司、暂停仍有结构关系但无业务资格。任何旧直写发现均阻断该入口，不能只改 UI。

### Task 9: P09 — 指定团队管理员的无提权命令

**Dependencies / Roles:** P08；backend_implementer → backend_validator → reviewer。T04、BA17/BA07。

**Files:** Create `server/src/auth/directory/team-grants.ts`；Modify `server/src/auth/directory/team-extension.ts`, `executor.ts`, `contracts.ts`, `server/src/enterprise/tenancy/company-admin-routes.ts`, `server/src/enterprise/tenancy/workspace-scope-routes.ts`, `resource-policy.ts`, `server/src/enterprise/tenancy/assembly-enterprise.ts`（入口清单按实际路由形状登记）, `server/src/app.ts`, `server/src/index.ts`；Create `server/tests/better-auth/scoped-team-admin.test.ts`。

**Interfaces:** Consumes TeamMutationCapability、P03 新团队管理 Grant/持久代际及 actor 分类；Produces 公司管理 `GET|POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/management-grants` 和 `DELETE /api/enterprise/workspace-scope/admin/teams/:workspaceId/management-grants/:grantId`，GET 返回 interfaces.md 的 TeamManagementGrantView，POST/DELETE 分别转译 team.management.grant/revoke；团队成员增删不新增与既有 `DELETE .../members/:principalId` 同形的路由，而是扩展转译既有 `POST .../admin/teams/:workspaceId/members` 与 `DELETE .../members/:principalId`——path 参数固定为 OpenBot 稳定业务 principalId，服务端解析为 BA userId 后构造 team.member.add/remove（interfaces §3），精确固定动作，不改 BA member 默认角色。

- [ ] **Step 1 — 写权限边界用例。** `company_admin_grants_and_revokes_team_management_through_api`、`manager_of_a_cannot_manage_b_or_company_roles`，原生 BA 端点仍 403；`expect(actor.role).toBe('member')`，仅甲团队增删成功，外部用户邀请/自身 Grant 委派失败。
- [ ] **Step 2 — RED。** V-B；普通 member 的 BA 原生权限不足必须成为可观察拒绝，不使用伪 admin fixture。
- [ ] **Step 3 — 实现扩展准入。** 先实现公司 owner/admin 的 Grant 授予/撤销和动作闭集，受权人需有效目标团队资格，版本由服务器签发，调用者不能委派自身 Grant。Directory 锁内按 company-role/team-grant/provisioning-rule 判别依据；本任务完成前两支，P12 完成规则分支，未知依据关闭。验证 Grant、动作、团队、目标已有公司资格及 proof；创建绑定 tx/command/目标的单次能力，调用 P01 adapter，不构造管理员 session/登录 executor 身份。
- [ ] **Step 4 — 补撤权与重放。** 从实际授予 API 取得 Grant 后再验 scoped manager；撤销/重授推进 Grant generation，Grant generation 变化、跨公司能力、错 target、重复消费拒绝；重放成功 command 按 receipt 返回，不再执行。审计保留真实 actor、内部 executor 名与 grant ID/gen；发布走 Resource Policy，不能从成员管理动作推导。
- [ ] **Step 5 — GREEN 与检查点。** V-B；无法安全消费私有 adapter 时阻断，回到 P01 方案，禁止临时提升组织角色。

### Task 10: P10 — 公司、成员、团队与邀请落地 UI

**Dependencies / Roles:** P07、P09；frontend_implementer → frontend_validator → reviewer。T04、BA05/BA13/BA17。

**Files:** Modify `app/src/components/auth/organization/` 的 P02 清单组件、`app/src/components/company-admin/company-admin-area.tsx`, `app/src/routes/_authed/tenant/admin/people.tsx`, `app/src/locales/zh-CN/company-admin.json`, `app/src/locales/en/company-admin.json`；Create `app/src/routes/_authed/organization/$view.tsx`, `app/src/routes/accept-invitation.tsx`, `app/src/lib/enterprise/tenant/directory.ts`, `app/tests/better-auth/directory-pages.test.tsx`, `e2e.better-auth.config.ts`, `tests/e2e/better-auth/web/directory.e2e.ts`；Modify `e2e.config.ts`, `package.json`, `scripts/e2e-coverage-audit.mjs`；Create `tests/support/better-auth-preflight.ts`, `tests/config/e2e-engine-suites.json`, `tests/e2e-browser-isolation.test.ts`。

**Interfaces:** Consumes DirectoryResult/role/capabilities 与受控 BA client；Produces viewPaths 绑定现有 Router，company admin 原生路径与 scoped team manager 命令路径分开；P09 的独立 Grant 授予/撤销由 company owner/admin UI 消费，普通 scoped manager 不展示或调用委派入口。

- [ ] **Step 1 — 写邀请与角色 UI 用例。** `invitation_survives_login_and_wrong_account_switch`, `scoped_manager_uses_only_team_command`；`expect(returnPath).toBe('/accept-invitation?id=inv-a')`，无外域跳转；团队管理员不能看到可操作公司角色的控件。
- [ ] **Step 2 — RED。** V-F；直接访问公开落地页，未登录可显示受控状态但不能读取私有目录。
- [ ] **Step 3 — 接组件与 commands。** 人员搜索/分页服务端授权；固定角色与最后 owner 冲突明确文案；取消/过期/邮箱不符/未验证/已接受/并发冲突可恢复。服务端决定能力，UI 隐藏不充当授权。浏览器文件移至 better-auth/web 子树，默认配置仅收原根目录文件并明确拒绝 BA 子树/CLI 强制路径；BA Web config 只收 web 子树，Mobile 留 P20 独立配置。共享 preflight 在创建任何 engine/访问站点前核验 APP/API origin、build digest/检查点、测试身份和引擎；BA 文件也有 suite guard，禁止从默认 target 运行。package 增 test:ui:better-auth 入口。coverage-audit 对文件/config/target/preflight 精确对账，不以 engine tier 计数代替。tests/e2e-browser-isolation.test.ts 测互斥收集、未知 BA 文件/配置错 target 失败、移除 origin 后所有可收集入口访问前非零退出（用无服务的网络访问 spy）；默认 test:ui 不收 BA。
- [ ] **Step 4 — 接公司资料与安全操作。** 业务 status 只读，删除为申请，裸 user/组织删除、模拟登录、动态角色和完整个人工作台入口关闭；公司设置不要求管理员加入每个团队。
- [ ] **Step 5 — GREEN 与检查点。** V-F、V-I 静态收集/preflight 反例、app typecheck，键盘/表单错误/加载/空态/403/503 可操作；受限 team manager 全程保持普通组织 member。

### Task 11: P11 — 公司会话认证证明与追加认证

**Dependencies / Roles:** P08；backend_implementer → backend_validator → reviewer。T05、BA10/BA20。

**Files:** Modify P04 已创建的 `server/src/auth/company-assurance.ts`、P01 的 `sso-evidence.ts`；Create `server/src/auth/company-auth-routes.ts`, `server/tests/better-auth/company-assurance.test.ts`；Modify `server/src/auth/index.ts`, `guards.ts`, `server/src/enterprise/tenancy/store.ts`, `scope-gate.ts`, `server/src/auth/directory/executor.ts`, `server/src/app.ts`。

**Interfaces:** Consumes assurance/challenge schema、P01 已证明的 SsoEvidenceBridge/原始签名证据、DirectoryActor；Produces interfaces.md §5 CompanyAssurance，注入 P05/P04，不开放任意提交 claims 的公开 API。

- [ ] **Step 1 — 写核心会话反例。** `linked_b_idp_does_not_authorize_password_session_for_b`，`expect(before.code).toBe('COMPANY_REAUTH_REQUIRED')`；正确 B 追加认证后准入。其他用例固定 Clock 测 600 秒过期、session expiry、maxAge 和 provider strength。
- [ ] **Step 2 — RED。** V-B；accounts 关联不能作为当前 session proof，证明不足时业务和目录都拒绝。
- [ ] **Step 3 — 实现 challenge/complete/require。** 绑定原 user/session/tenant/provider/policy、一次消费、受控 returnPath、服务器持久的 state/nonce/PKCE、AuthnRequest ID/RelayState/InResponseTo 绑定；按 interfaces §5 接自有 OIDC callback/SAML ACS，普通 BA 登录 callback 不改；可信 issuer/subject/真实认证时间与强度归一化，缺声明拒绝。callback 锁内重验成员/策略，换账号/丢资格不落 proof。
- [ ] **Step 4 — 接轮换与失效。** session 轮换只给最终 session 本次公司的 proof，旧 session/proof 失效，其他公司不复制；续期不延长认证年龄。identity/company gen、policy revision、session revoke 均实时比较。部署强制 SSO 继续生效；break-glass 单独、限公司/时效/理由且审计，无配置则无例外。
- [ ] **Step 5 — GREEN 与检查点。** V-B；重放/并发 callback 仅一次成功、returnPath 编码绕过拒绝、invitation accept 不陷入“先有成员才能接受”的循环。签名 OIDC/SAML fixture 复用 P01，逐项断言 authenticated_at 等于断言时间而非回调时间、篡改 state/RelayState 不落 proof；真实已启用 IdP 正向/反例验证留 P24，缺凭据不能宣布企业认证验收完成。

### Task 12: P12 — SCIM/JIT、全局用户管理和跨部署身份

**Dependencies / Roles:** P11；backend_implementer → backend_validator → reviewer。T05、BA01/BA08/BA10/BA20。

**Files:** Modify `server/src/auth/directory/identity.ts`, `server/src/auth/directory/ingress.ts`, `server/src/auth/directory/executor.ts`, `server/src/auth/directory/team-extension.ts`, `server/src/auth/directory/contracts.ts`, `server/src/enterprise/tenancy/company-admin-routes.ts`, `server/src/index.ts`, `server/src/auth/index.ts`, `scim.ts`, `roles.ts`, `guards.ts`, `organization.ts`, `organization-store.ts`, `server/src/enterprise/tenancy/scim-directory.ts`, `sso-scim-config.ts`, `identity-binding.ts`, `server/src/app.ts`；Create `server/src/auth/mobile-session.ts`, `mobile-session-routes.ts`, `server/tests/better-auth/provisioning-global-admin.test.ts`, `remote-identity-binding.test.ts`, `personal-model-identity.test.ts`, `mobile-authority-contract.test.ts`；Modify `server/src/bot-services/access-grants.ts`, `server/src/bot-services/types.ts`, `server/src/gateway/key-issuance.ts`, `server/src/gateway/key-renewal.ts`, `server/src/db/schema/access-grants.ts`, `server/src/db/schema/gateway.ts`（仅消费 P03 schema，必要增量先修订接口）；Modify `server/scripts/enterprise-runtime-seed.ts`（启动种子写入按 P25 静态清单处置，ba 分支不独立写目录）。

**Interfaces:** Consumes Directory provisioning actor/批准 rule、PrincipalRegistry、独立 IdentityCommand、company proof/global identity generation；Produces 固定 connection/company 的 SCIM/JIT 路径、BA Admin 全局角色单权威、稳定 issuer+subject 身份映射；interfaces §5.2 OpenBot mobile authorize/exchange/online-authorize 路由及 opaque BFF session，P17 只消费此合同。

- [ ] **Step 1 — 写隔离与禁用测试。** `scim_a_deactivate_preserves_b_and_personal_account`, `global_disable_invalidates_all_old_sessions`, `matching_email_with_different_issuer_does_not_merge`、`scim_first_member_without_invitation_has_one_principal`、`approved_rule_adds_team_member_and_revoked_rule_rejects`、`provisioning_capability_cannot_cross_company_or_request`、`identity_each_security_write_failure_rolls_back`、`legacy_seed_role_without_envelope_cannot_write`、`sso_callback_with_provider_organization_id_never_creates_member`；断言 B active、全局 User 未被 SCIM 删除、带 provider.organizationId 的 OIDC/SAML 回调不产生 member 行；增加 `global_disable_blocks_mounted_bot_claim_and_renew_without_outbox`、`restore_requires_explicit_personal_model_reauthorization`、`admin_create_edit_password_and_revoke_all_are_enveloped`、`enterprise_session_exchange_is_single_use_pkce_bound`，禁用后 identityGeneration 增长且恢复不使旧能力有效。
- [ ] **Step 2 — RED。** V-B；分别从实际 SCIM HTTP 方法、JIT callback、服务端 API 及管理员 endpoint 进入。
- [ ] **Step 3 — 迁入所有 provisioning。** token/connection 固定公司，externalId/subject/group 带 binding 维度；首次公司成员通过 member.provision + PrincipalRegistry，无邀请也能合法建立，重复不增版/不覆盖角色，恢复显式审批。从现有公司管理配置入口调用 provisioning.rule.approve/revoke，实现固定 binding/externalGroup/teams 的持久批准规则/revision，不新增客户自助 IdP 配置；scim/jit 无规则批准权，组映射仅批准的团队/最低固定角色；team.member.add/remove 用 provisioning-rule 单次能力，逐事件重验撤销/版本/固定目标，审计记 binding/rule/event 而非伪 Grant。多步事件同一命令原子组，不在 callback 外另事务投影；启用前确认旧 reconciler 不再直接 SQL 写成员。SSO factory 硬前提固定 `sso({organizationProvisioning:{disabled:true}})`，缺失或被改时启动拒绝；ingress 对 `/sso/register`、`/sso/update-provider` 等请求剥离并拒绝客户端提交的 organizationId，provider↔公司绑定只由服务器按固定 binding 写入；带 organizationId 的 OIDC/SAML 回调不产生 member 行（固定版 assignOrganization 分支不可达）。
- [ ] **Step 4 — 接 Admin 与跨部署绑定。** BA 管全局 role，旧 role repo 只受控读，INITIAL_ADMIN/bootstrap 不在每次登录重提权。逐项按 interfaces §3.2 接 Admin，包括 user.create/profile.update/password.reset/sessions.revoke；删除/模拟登录后端拒绝并移除 impersonate 权限。P01 分类的 seedRole/recordProvisioned/stampSignIn 全改当前 tx finalizer；不允许 database after hook 用工厂全局 database 写库，adapter transaction 不受 SCIM 开关影响。通过 P04 Identity.execute 接 disable/restore/role.set/session.revoke，锁内重验平台 actor，User/Principal/identityGeneration/session/proof/审计及 outbox 故障全回滚；单 session revoke 不扩散其他 session。全局 disable 在 principal 排他锁内改安全代际并撤 session；不删某公司成员冒充全局禁用。远程 authority 验 issuer+subject/服务器绑定，不按邮箱 materialize 授权；保留 Desktop/Expo/OpenMuse 已启用登录回调合同，按 interfaces §5.2 实现 mobile authorize→一次性 PKCE code→注册 BFF exchange→opaque handle；每次业务调用 online-authorize，绑定原 BA session/identityGeneration/issuer/subject/client/audience，既有普通 API 不因此新增通用 bearer。P17 的服务凭据不得自填 actor/company 获授权。code 重放/换账号/错 authority/过期和 accessKey 都拒绝。
  同时修个人 Model Access Grant→claim/renew 链：授权保存当前主体代际，resolveForBot 查实时用户/Principal，签发/续签最终事务 principal→grant→key 锁序重验，不仅检查 Bot/active Grant；远端 create 在锁外，最终判定失效不披露并幂等补偿回收。恢复不刷新旧 Grant/Key；显式重新确认在同 tx 撤旧 stale-active Grant 再建新 grantId/当前代际，遵守原 one-active-per-identity 索引、不改旧代际；并发重授权仅一份 active，旧 Key 不换绑，新增 `explicit_reauthorization_replaces_stale_active_grant_with_new_id`。公司成员移除仍保留个人授权。
- [ ] **Step 5 — GREEN 与检查点。** V-B + 现有 `sso-required-sessions.integration.test.ts`, `auth-mobile-scheme.integration.test.ts`, `organization-store.integration.test.ts` 相关部分；ba 分支所有写路径证明进入 executor 后才启用 SCIM/JIT；legacy 继续旧受控路径，不在开发等待期间停写。实际挂载 /api/bot-service 的 claim/renew 在 disable 提交、outbox 暂停时拒绝，restore 后原 Grant 仍拒绝；P16 另验旧 Key 新调用。协议/真实 IdP 未测标阻塞，不以研究中的新版本 Beta 行为替代本地合同。

### Task 13: P13 — 账户安全、追加认证与平台管理前端

**Dependencies / Roles:** P10、P12；frontend_implementer → frontend_validator → reviewer。T05、BA01/BA04/BA20。

**Files:** Modify `app/src/lib/auth/client.ts`, `app/src/lib/auth/queries.ts`, `app/src/lib/auth/mutations.ts`, `app/src/main.tsx`, `app/src/routes/__root.tsx`, `app/src/routes/_authed.tsx`, `app/src/routes/_authed/admin/people.tsx`, `app/src/routes/_authed/settings/connected-accounts/index.tsx`；Create `app/src/lib/auth/company-assurance.ts`, `app/src/routes/verify-email.tsx`, `app/tests/better-auth/account-assurance.test.tsx`, `tests/e2e/better-auth/web/session.e2e.ts`；Create `app/src/routes/forgot-password.tsx`, `app/src/routes/reset-password.tsx`；接线 P02 固定 Auth/Settings provider 组件，不重建路由体系。

**Interfaces:** Consumes 403 COMPANY_REAUTH_REQUIRED/challenge result、BA Admin methods；Produces 目标公司保持且暂停业务的追加认证交互、全局创建/资料编辑、密码安全重置、会话查看/单个与批量撤销/禁用页面及 F006/F007 密码恢复。

- [ ] **Step 1 — 写受控恢复测试。** `reauth_required_preserves_target_and_blocks_business`, `company_admin_cannot_enter_platform_user_admin`；`expect(businessRequestCountWhileReauth).toBe(0)`，正确回调后重新 validate-selection，不复用旧 selection proof。
- [ ] **Step 2 — RED。** V-F；模拟过期/换账号/session rotation 及受控 callback，检验真实 client adapter 路径。
- [ ] **Step 3 — 接账户/登录组件。** 只显示后端启用方法、保持原有 SSO/原生交接、可信 origin/returnPath，账户绑定不能绕过主体核验；接 P08 的验证邮件发送/重发；固定返回页为本 Task Create 的 `app/src/routes/verify-email.tsx`，不开第二条重复验证路由，正确验证后回到原邀请；邮箱控制权证明不当公司 SSO 成功。测试新邮箱密码用户完整正向及过期/换邮箱拒绝。接 /forgot-password、/reset-password 的实际 auth client 方法和 P08 恢复邮件 callback；测试真实请求重置→邮件→设密码→重新登录，过期/消费过/不可信返回页拒绝，旧 session/proof/个人模型授权失效需重新认证/授权；恢复页 no-referrer/无第三方资源，token/密码不记日志。只在启用密码登录时展示，纯 SSO 关闭。不新增默认 bearer/JWT/API Key 入口。
- [ ] **Step 4 — 接平台管理与失效。** 平台创建/资料编辑字段闭集，修改 role/密码分别走专用操作；单个/全部 session revoke、密码安全重置后清身份和范围缓存；公司 admin 没有平台页面/API 权限；模拟登录/裸 DeleteUser 关闭，break-glass 显示真实例外而非 MFA 成功。
- [ ] **Step 5 — GREEN 与检查点。** V-F、app typecheck；错误/取消/失去公司资格可恢复，不自动切另一家公司掩盖 proof 失败。

### Task 14: P14 — 资源、会话、Bot 与 Memory 的实际业务授权

**Dependencies / Roles:** P09、P12；backend_implementer → backend_validator → reviewer。T06、BA02/BA03/BA09/BA14。

**Files:** Modify `server/src/enterprise/tenancy/resource-policy.ts`, `resource-visibility.ts`, `bot-publish.ts`, `public-bot-usage.ts`, `plugin-catalog.ts`, `skills-components.ts`, `conversation-actions.ts`, `personal-memory.ts`（以上同 tenancy 目录）；Modify `server/src/channels/routes.ts`, `server/src/channels/thread-routes.ts`, `server/src/agents/routes.ts`, `server/src/team-bots/routes.ts`, `server/src/plugins/routes.ts`, `server/src/plugins/shared-use-routes.ts`, `server/src/marketplace/routes.ts`, `server/src/hindsight/bank-scope.ts`, `server/src/hindsight/scoped-recall.ts`, `server/src/memory/routes.ts`, `server/src/db/schema/enterprise-tenancy.ts`, `server/src/db/schema/personal-shares.ts`, `server/src/db/schema/enterprise-credentials.ts`, `server/src/enterprise/tenancy/credential-ownership.ts`；Create 本任务对应 Drizzle 增量和 `server/tests/better-auth/business-resource-matrix.test.ts`, `credential-source-generations.test.ts`（同测试目录）。

**Interfaces:** Consumes trusted Scope + Resource Policy，既有各 service；Produces 当前公司的团队发布/个人内容/依赖动作闭环，升级现有模块，不另起授权框架。

- [ ] **Step 1 — 写同团队私有/公共与依赖矩阵。** `same_team_private_conversation_and_credentials_remain_private`, `published_bot_cannot_use_another_users_private_connection`, `memory_recall_filters_source_authorization`、`rejoined_member_cannot_use_old_credential_action_or_disclose_plaintext`、`old_personal_credential_owner_id_does_not_restore_authority`；`expect(publicRun.status).toBe(200)`、私有内容/跨公司/退出来源团队后的 recall 为 404/受控拒绝。
- [ ] **Step 2 — RED。** V-B；从真实 channels/Bot/plugin/skill/Memory HTTP 或公共 service 进入，不能只测新判定纯函数。
- [ ] **Step 3 — 接实时版本和动作。** 各入口检查归属、read/run/write/share/manage、发布与依赖，Grant 保存/比较适用代际；凭据 use/disclose 来源及个人 owner 比较 P03 的 identity/company/来源 team generation，缺版本拒绝，重新授权明确签发；authorizeUse/disclosePlaintext 不经过 lease 也必须生效；company/team admin 不隐含私有内容权。缓存键与 Memory bank/namespace 带真实 scope，非首个 user_id 聚合。
- [ ] **Step 4 — 接数据库兜底。** 根归属/子表复合 FK、团队关系及 app.* RLS；未知父子归属阻断。市场全局模板与已安装私有实例分开，跨公司分享关闭，KB 不恢复。
- [ ] **Step 5 — GREEN 与检查点。** V-B + 现有对应模块受影响测试；每类入口至少一个正向和一个同团队私有/跨公司反例，具体路由与 testId 写进版本化覆盖清单（P23 汇总）。发现清单外入口先归属任务再补验，不能当全局例外略过。

### Task 15: P15 — 敏感文件代理与严格下载撤权

**Dependencies / Roles:** P14；backend_implementer → backend_validator → reviewer。T06、BA06/BA14。

**Files:** Create `server/src/enterprise/tenancy/sensitive-download.ts`, `server/tests/better-auth/download-revocation.test.ts`；Modify `server/src/enterprise/tenancy/attachments.ts`, `server/src/enterprise/tenancy/execution-artifacts.ts`, `server/src/enterprise/tenancy/openmuse-file-tenancy.ts`, `server/src/channels/attachments.ts`, `server/src/computer/routes.ts`, `server/src/craft/file-routes.ts`, `server/src/craft/artifact-routes.ts`, `server/src/craft/storage/object-store.ts`, `server/src/workshop/public-routes.ts`, `server/src/openmuse-files/routes.ts`, `server/src/app.ts`。

**Interfaces:** Consumes scope/resource authorization + 私有对象读取；Produces interfaces.md §5 敏感下载服务，旧 download/preview/share 统一转入；对象存储 URL 不返回客户端。

- [ ] **Step 1 — 写可控慢下载并发测试。** `revocation_blocks_next_batch_even_when_outbox_is_down`；highWaterMark:0 的实际 Bun/Hono 响应以屏障暂停下一次 pull；撤权前最多一次 enqueue，提交撤权后再触发 pull，`expect(bytesFromPreauthorizedBatch).toBeLessThanOrEqual(262144)`、下一 pull 拒绝且 enqueue 计数不再增加、runtime 应用缓冲最多 262144 字节。另测撤权后首个新请求/HEAD/Range/旧 capability 全拒绝。
- [ ] **Step 2 — RED。** V-B；测试显式屏障固定顺序，记录事务准入而非仅根据客户端总缓存字节猜测。
- [ ] **Step 3 — 实现代理。** 拉取式 ReadableStream<Uint8Array>、highWaterMark:0；每个串行 pull 最多私有预取一批，短 gate 事务准入后最多一次 enqueue（262144 字节），下一 pull 重新验权；不使用 start/write 循环/转换流预排授权，不以 write 返回当交付完成。Bun/Hono 运行时预读同样走下一 pull，禁应用层附加缓冲，慢客户端记录实际 pull/enqueue/缓冲上限；存储/网络等待不持锁。实现单 Range/206/HEAD/416/取消/错误，私有 no-store，拒 CDN 旁路。
- [ ] **Step 4 — 关闭旧能力。** 旧签名/公开 URL 需存储策略/位置/签名密钥等实际失效证据；停止新签发不足。分享链接仅定位且每次在线鉴权，跨公司不开放。无法使旧 URL/离线 lease 失效的能力保持关闭，清单进入 P22/P24。
- [ ] **Step 5 — GREEN 与检查点。** V-B；慢 storage/client 不持 tenant 锁，通知停机仍拒绝新准入；已输出/OS 缓冲不声称可追回。

### Task 16: P16 — Run/Worker/审批与外部能力的固定范围执行

**Dependencies / Roles:** P14；backend_implementer → backend_validator → reviewer。T06、BA06/BA07/BA11。

**Files:** Modify `server/src/enterprise/runs/service.ts`, `store.ts`, `runner.ts`, `model-capability.ts`, `server/src/enterprise/tenancy/revocation.ts`, `credential-lease.ts`, `shared-approvals.ts`, `tool-invocation.ts`, `worker-assembly.ts`, `job-control.ts`, `server/src/work/queue.ts`, `worker/src/index.ts`；Modify `server/src/db/schema/enterprise-runs.ts`, `server/src/db/schema/job-ownership.ts`, `server/src/db/schema/enterprise-credential-lease.ts`, `server/src/db/schema/enterprise-execution-lease.ts`, `server/src/db/schema/enterprise-shared-approvals.ts`, `server/src/db/schema/enterprise-host-access.ts`, `server/src/db/schema/approvals.ts`, `server/src/db/schema/shared-use.ts` 并生成对应 Drizzle 增量；Create `server/tests/better-auth/execution-revocation.test.ts`, `gateway-identity-admission.test.ts`, `server/src/gateway/identity-admission.ts`；Modify `server/src/billing/credit-reserve.ts`, `server/src/app.ts`, `server/src/index.ts` 的在线准入装配；核验部署后按固定清单 Modify `bifrost/plugins/governance/main.go`, `creditadmission.go`, `creditrefusal.go`，Create 同目录 `identityadmission_test.go`；如使用既有远程 hook 配置也须在 Brief 列真实配置文件，不能只改辅助函数。子模块读其 AGENTS、冻结 dirty baseline/独立 Review；Go runner 按现有 foreign registry 登记，不替换根 e2e。

**Interfaces:** Consumes 版本/proof/现有预算 reservation；Produces 持久运行安全引用 + 领取/恢复/工具/凭据/产物检查点，不接受 queue 中任意 Scope 或 payer。

- [ ] **Step 1 — 写任务重放/离职/证明失效测试。** `worker_rebuilds_scope_from_run_and_keeps_original_payer`, `expired_assurance_suspends_next_tool_action`, `rejoin_does_not_revive_old_approval`、`fresh_lease_after_rejoin_rejects_old_use_grant`；`expect(executedSensitiveActionsAfterRevocation).toBe(0)`、历史费用 payer 不变；`old_personal_key_is_denied_at_enabled_gateway_after_disable` 从实际启用 Bifrost 入口用禁用前有效 Key 发请求，outbox 暂停/restore 后都不能新 dispatch；正向需显式重授权的新 Key。
- [ ] **Step 2 — RED。** V-B；以真实持久 Run/Job、队列消费入口和工具调用公共 seam 验证，伪造队列字段不得覆盖记录。
- [ ] **Step 3 — 持久化并重验。** 保存 identity/company/team 版本及 AssuranceRef；旧能力未知版本只可迁移核验重签/撤销。新 lease 先比较 P14 的来源授权版本，不能拿旧 use 行盖当前 Scope 版本；Worker 重新签发可信 Scope，在所有敏感检查点核验；证明到期挂起，恢复需新 proof 和运行授权，不隐式给予无人值守长期豁免。
- [ ] **Step 4 — 处理外部副作用/取消。** 每次新工具/文件/控制动作先在线 gate，不能在线约束的离线 lease 不开放；审批结果不替代使用时检查。个人模型 Key 的每次新调用也经过 identity-admission，按已认证 keyId/hash 解析 P03/P12 来源，实时 principal/shared lock 比较 User/Principal、Grant/Key identityGeneration；身份不可用或代际不匹配拒绝，不能只依赖外部吊销或 credit-reserve 辅助 seam。管理员接管/资产交接是独立审计动作，不换原 payer；已准入不可撤回外部结果和未知费用继续原账户记录/结算。
- [ ] **Step 5 — GREEN 与检查点。** V-B + 现有 enterprise runs/runner 及 worker isolation 相关测试；重试幂等、不重复支付/模型调用，不在 DB 锁中等待模型流/人类审批。保存实际网关 route/hook→OpenBot online-admission→provider dispatch 的同版观测；辅助测试通过而实际网关未接线不得 verified，任何绕过入口使该能力 blocked。

### Task 17: P17 — 外部状态、入站事件、沙箱与观测隔离

**Dependencies / Roles:** P15、P16；backend_implementer → backend_validator → reviewer。T06、BA09/BA14/BA16。

**Files:** Modify `server/src/enterprise/tenancy/computer-allocation.ts`, `host-access.ts`, `learning-demonstrations.ts`, `inbound-attribution.ts`, `proactive-delivery.ts`, `streams.ts`, `oauth-state.ts`, `runtime-config.ts`, `observability-authz.ts`, `telemetry-attribution.ts`, `openmuse-activity-tenancy.ts`, `openmuse-task-tenancy.ts`, `openmuse-reviewed-action-tenancy.ts`, `openmuse-voice-mobile-tenancy.ts`（以上同 tenancy 目录）；Modify `server/src/ai-observability/scope.ts`, `server/src/host-access/routes.ts`, `server/src/learning/routes.ts`, `server/src/proactive/routes.ts`, `server/src/approvals/routes.ts`, `server/src/openmuse-notifications/routes.ts`, `server/src/openmuse-tasks/routes.ts`, `server/src/openmuse-reviewed-actions/routes.ts`, `server/src/workshop/routes.ts`, `server/src/craft/routes.ts`；Create `server/tests/better-auth/external-surface-matrix.test.ts`, `mobile-bff-contract.test.ts`；Create `apps/openmuse/apps/server/src/enterprise.ts`；Modify 子模块 `apps/server/src/app.ts`, `auth.ts`, `workspace.ts`, `config.ts` 和实际 scoped store/runtime/CopilotKit/媒体 adapter（均以 apps/openmuse/ 为根；Step 1 展开精确文件）。这些后端变更归本 backend_implementer，P20 不补服务器缺口。

**Interfaces:** Consumes P14/P16 gate/version/action、现有外部适配；Produces 服务器持久归属的 callback/subscription/event，分公司/团队/用户的存储与外部实例；interfaces §5.2 企业 OpenMuse BFF 全路由/原 Workspace DTO，消费 P12 mobile authority，P20 在此 verified 后接 App。

- [ ] **Step 1 — 写外部串用反例。** `pooled_browser_reset_does_not_reuse_a_cookie_for_b`, `webhook_body_cannot_override_persisted_company`, `auditor_observability_excludes_private_prompt`；先读取子模块 AGENTS/CONTEXT/实际 App 消费路由，从 createApp/auth/workspace/runtime/scoped store 和媒体 imports 固定 owned_files 完整清单，双仓快照独立保存。新增 `enterprise_bff_login_workspace_stream_media_and_reauth_contract`、`enterprise_access_key_never_falls_back_to_standalone`，实际两个 createApp 实例走 P12 authority，逐条核验 route/actor/company/team。`expect(bCookieJar).not.toContain(aSecret)`、伪 tenant body 不改变已保存关联。
- [ ] **Step 2 — RED。** V-B；供应商/存储故障在适配 seam 注入，但真实池复用、流 token/回调及来源要在 P24 验证，不把 mock 当部署验收。
- [ ] **Step 3 — 接归属和副作用边界。** 电脑/浏览器/学习容器分配、清理、恢复；渠道/通知/webhook/OAuth state/订阅固定服务器关联，正文和每次新敏感动作重验。事件、缓存、幂等键带实际 scope/version，流主动失效只是辅助。OpenMuse server 固定 enterprise/standalone 配置；enterprise /api/session 只接 PKCE code，不接 accessKey/默认 local-user/sample seed。统一 middleware 在线核验 session/selector/action，scoped store 和执行 adapter 消费上下文，不把旧 owner 字段当完整权限。workspace 按 interfaces §5.2 原 DTO 逐字段映射，CopilotKit 保持固定 SDK wire schema并固定服务端 Run/payer，媒体 ticket 每请求/pull 在线核验/转 P15，scope/challenge 路由桥接同一 BA session。原生 callback、失效/过期/错误码均按合同，无到旧 origin 的重试。
- [ ] **Step 4 — 接观测/设置/全局分类。** 配置读取和工具 capability 使用准入，导出/审计元数据与正文分权；健康/静态/公共模板明确例外，租户安装/业务配置不可列全局。记录 route/consumer/provider 与测试证据要求，未知项阻断。
- [ ] **Step 5 — GREEN 与检查点。** V-B；开启能力每类正反例；P12/P17 的可调用服务器合同（登录/首屏/一次流/媒体/追加认证）和子模块类型/构建均通过才放行 P20，不能留到客户端阶段返工。外部凭据不可用的具体场景记录 blocked，不能整个目录标已验收。

### Task 18: P18 — 固定公司/个人账务、独立财务授权和容量审计

**Dependencies / Roles:** P16、P17；backend_implementer → backend_validator → reviewer。T07、BA04/BA05/BA08/BA12。

**Files:** Modify `server/src/billing/payer-company.ts`, `payer-personal.ts`, `payer-binding.ts`, `workbench-payer.ts`, `company-finance-visibility.ts`, `server/src/enterprise/tenancy/company-capabilities.ts`, `server/src/enterprise/tenancy/telemetry-usage.ts`, `audit-domains.ts`, `server/src/db/schema/company-finance.ts`（消费 P03 版本列及必要约束）；Create `server/tests/better-auth/billing-capacity-audit.test.ts`。

**Interfaces:** Consumes 固定 PayerRef、reservation、Directory 席位锁和财务 Grant；Produces 同公司共用余额、团队用量维度、独立财务动作/版本，审计保留原体系。

- [ ] **Step 1 — 写并发余额和分权测试。** `two_teams_compete_for_one_company_balance`, `owner_without_finance_grant_cannot_read_or_adjust`, `personal_key_never_opens_company_data`、`disabled_identity_pending_usage_keeps_original_payer`；总预扣不超可用余额、ledger/usage/payer 一致，余额不足不切账户。
- [ ] **Step 2 — RED。** V-B；真实原子余额/账务事务，payment/provider 幂等边界单独注入，不新建 Credits 权威。
- [ ] **Step 3 — 接代际和固定归属。** 财务 Grant/退款/调整独立动作，资格撤销后失效；支付 callback 用订单/服务器 payer 映射，UI organization 参数不改付款。离职/全局禁用/密码重置不释放未知费用，重放不重复发放/结算；旧个人 Grant/Key 失效后的迟到 usage 仍用原 user/payer/customer，恢复/重新授权不重绑旧 Key 历史，显式公司移除不撤个人授权。
- [ ] **Step 4 — 接席位/业务配额/审计。** active 公司成员计一次，pending 单列接受时原子检查，不改变既有套餐账期；团队/Bot/并发/存储/模型分别在实际操作处 enforce。目录变更审计失败关闭该命令，非致命身份登录审计维持原合同，脱敏/只追加/平台公司分域。
- [ ] **Step 5 — GREEN 与检查点。** V-B + 现有 `company-payer-e2e.integration.test.ts` / `payer-company-resolution.integration.test.ts` 相关部分；不增加支付 provider、不双发权益。

### Task 19: P19 — Desktop 登录交接与选择一致性

**Dependencies / Roles:** P13、P18；frontend_implementer → frontend_validator → reviewer。T07、BA01/BA13/BA20。

**Files:** Modify `desktop/src/App.tsx`, `desktop/src/App.test.tsx`, `desktop/src/CompanySelection.tsx`, `desktop/src/CompanySelection.test.tsx`, `desktop/src/OrgLocalState.ts`, `desktop/src/LocalStateIsolation.test.tsx`, `desktop/src/OrgSwitchCleanup.tsx`, `desktop/src/OrgSwitchCleanup.test.tsx`, `desktop/src-tauri/src/organization_auth.rs`, `desktop/src-tauri/src/org_context.rs`, `desktop/src-tauri/src/org_switch_cleanup.rs`, `desktop/src-tauri/src/provider_oauth.rs`；不再新建第二份 company-scope 状态；server 侧变更归 P12，发现合同缺口先回修该任务。

**Interfaces:** Consumes 可信远程 authority 绑定、selection/proof API；Produces Desktop 当前部署/账号/公司/团队一致的请求与 deep link 会话，UI scope 不改变后台 Run。

- [ ] **Step 1 — 写跨部署回调反例。** `late_deep_link_from_old_authority_cannot_replace_current_session`；`expect(activeAuthority).toBe(expectedAuthority)`、旧账户响应不写入新视图，pending challenge 绑定不变。
- [ ] **Step 2 — RED。** V-F 的 desktop 路径；Rust 行为通过现有 Tauri 集成方式与可执行测试入口验证，不把 TS mock 作为 native bridge 证明。
- [ ] **Step 3 — 接登录/切换。** 复用服务器 scope DTO 和公司追加认证，切部署/换账号清 native token、缓存/流和 pending callback，保留必要的受控兼容映射；无法匹配原 session 重新 challenge。
- [ ] **Step 4 — 验证兼容。** Desktop typecheck/build、相应 Rust 检查和实际支持版本 deep link/登出/撤权流程；旧版本不能因无团队字段而放宽服务端 gate。
- [ ] **Step 5 — 保存检查点。** 缺原生执行环境时源码测试可通过，但 BA13/BA20 的真客户端部分 blocked，不能签发发布通过结论。

### Task 20: P20 — Mobile/OpenMuse 登录、范围和流

**Dependencies / Roles:** P13、P17、P18；frontend_implementer → frontend_validator → reviewer。T07、BA01/BA13/BA20。

**Files:** Modify `apps/openmuse/apps/mobile/src/openbot/transport.ts`, `apps/openmuse/apps/mobile/src/openbot/tenancy.ts`, `apps/openmuse/apps/mobile/src/openbot/transport.test.ts`, `apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts`, `apps/openmuse/apps/mobile/src/openbot/three-client-selection.test.ts`；Create 同目录 `company-assurance.ts`, `company-assurance.test.ts`，以及根仓库 `tests/better-auth-mobile.test.ts`（固定白名单 e2e 调度器）。Create 根仓库 `tests/e2e/better-auth/mobile/app.e2e.ts`；Create `e2e.better-auth-mobile.config.ts`，Modify `tests/config/e2e-engine-suites.json`, `package.json`, `tests/support/better-auth-preflight.ts`，显式读取隔离测试的 `E2E_BA_MOBILE_ORIGIN`，不得默认共享开发栈。另 Modify 子模块真实入口 `apps/openmuse/apps/mobile/App.tsx`, `src/api.ts`, `src/chat.tsx`, `src/computer.tsx`, `src/agent-workspace.tsx`, `src/details.tsx`, `src/PdfReader.native.tsx`, `src/PdfReader.web.tsx`, `app.json`（src 与 app.json 均相对 apps/openmuse/apps/mobile/）；这些文件和上述辅助模块组成允许范围。开工从实际 import/fetch/provider/deep-link/媒体调用点冻结精确清单，其他调用点先扩 Brief，不因辅助模块可测而略过。共享 server BFF 缺口回修 P12/P17。

**Interfaces:** Consumes P12 已验证的 session handoff/online-authorize 与 P17 已验证 OpenMuse BFF 的原 Workspace/CopilotKit/媒体 DTO；Produces 真实 App/MuseApi/CopilotKit/媒体挂载后的已启用 Mobile/OpenMuse 请求、SSE/附件/下载都携带验证过的稳定 ID 对，原生跳转绑定正确账号/部署。

- [ ] **Step 1 — 核验子模块。** 读取其当前 AGENTS/CONTEXT、记录子模块 HEAD 和 dirty baseline；历史 `docs/agents` 链接按父仓库现行 `.agents/rules` 解析，不因旧路径猜规范缺失。子模块未提交改动保留并独立快照，不只记录 superproject gitlink。
- [ ] **Step 2 — 写 RED 用例。** `mobile_switch_aborts_old_stream_and_reauth_is_company_bound`；`expect(headers).toEqual(expectedScopeHeaders)`，旧 generation 写入为零；通过根白名单 driver 运行辅助用例，另用专属 Mobile 配置/target 和隔离 Expo web export 的真实 App 浏览器用例观察 MuseApi/CopilotKit/媒体出站请求；源应用不调用 transport/proof 时该用例必须失败。子模块套件不假称被根目录 glob 收集，真实 native 另验。
- [ ] **Step 3 — 实现真实应用接线及 transport/tenancy/proof。** App 挂载单一 tenancy/认证 provider，MuseApi/CopilotKit/流和媒体不各自造 session；企业模式显式配置 authority 和 OpenMuse enterprise BFF origin，按 PKCE handoff 获取 BFF session，保留 /api/workspace 原 DTO；真实 App 登录→首屏→一次 CopilotKit 流→媒体→公司追加认证全部用 P12/P17 已交付路由，不回落 standalone accessKey。原生 Linking/deep-link 进入同一会话意图；公司无团队有空态、proof 不足暂停业务；callback 不跟随临时 active，native session 无法匹配则重新发起；附件/预览走在线代理，登出/撤权清临时凭据。
- [ ] **Step 4 — GREEN。** 子模块适用 typecheck、隔离输出的 Expo build:web 和实际 App 浏览器用例、V-I 默认/BA Web/BA Mobile 互斥静态收集/缺 Mobile origin 非零且无 3010 访问反例、现有 transport/tenancy/three-client 用例及支持平台真客户端验证；所有输出路径可指定或归档，不覆盖其他任务产物。
- [ ] **Step 5 — 保存双仓检查点。** 无子模块提交授权时不提交/gitlink 假更新；报告实际文件哈希和可转移 patch。缺设备/凭据的测试项 blocked，根 server 隔离仍必须成立。

### Task 21: P21 — 全业务 Web 入口、缓存/长流与账务页面回归

**Dependencies / Roles:** P13、P17、P18；frontend_implementer → frontend_validator → reviewer。T07、BA03/BA12/BA13/BA14。

**Files:** Modify `app/src/lib/enterprise/tenant/scoped-cache.ts`, `app/src/lib/enterprise/tenant/stream-scope.ts`, `app/src/components/company-admin/company-payment-records.tsx`, `app/src/routes/_authed/tenant/admin/billing.tsx`, `app/src/routes/_authed/_app/memory.tsx`, `app/src/components/channels/workshop-files.tsx`, `app/src/lib/channels/queries.ts`, `app/src/lib/channels/mutations.ts`, `app/src/lib/channels/use-channel-events.ts`, `app/src/lib/bot-lifecycle/queries.ts`, `app/src/lib/bot-lifecycle/mutations.ts`, `app/src/lib/craft/client.ts`, `app/src/lib/craft/queries.ts`, `app/src/lib/craft/streaming.ts`, `app/src/lib/workshop/client.ts`, `app/src/lib/workshop/queries.ts`, `app/src/lib/ai-observability/exports.ts`, `app/src/lib/ai-observability/runs.ts`, `app/src/lib/approvals.ts`, `app/src/lib/memory.ts`, `app/src/lib/billing/scoped.ts`, `app/src/lib/billing/queries.ts`；Create `app/tests/better-auth/business-scope-matrix.test.tsx`, `tests/e2e/better-auth/web/business.e2e.ts`。其他入口先明确文件归属再扩 Brief，不能给整个 app 无边界写权限。

**Interfaces:** Consumes P14–P18 正式业务 API、P07 selection generation；Produces 全部启用 Web 业务的 query key/optimistic rollback/stream/download 统一范围与权限状态。

- [ ] **Step 1 — 写旧响应与乐观回滚测试。** `a_failed_mutation_cannot_rollback_b_cache`, `finance_page_does_not_fetch_without_finance_capability`, `revoked_download_does_not_retry_direct_storage`；`expect(bCache).toEqual(beforeOldRollback)`，没有财务权限不发账单正文请求。
- [ ] **Step 2 — RED。** V-F；对入口清单每类至少一个真实 query/mutation hook 或页面测试，不能只测 cacheWriteGate 本身。
- [ ] **Step 3 — 接全部业务调用。** Bot/会话/Memory/文件/审批/账务/观测带显式范围，stream URL/header 走白名单，旧 response/乐观更新/回滚都比较 generation。权限收缩/无团队/503/reauth 的交互不回退全局数据。
- [ ] **Step 4 — 补页面验收。** 财务独立能力、个人余额入口、团队用量无钱包、私有凭据无内容越权；确认发布/成员管理按钮分权，键盘操作和空态有确定下一步。
- [ ] **Step 5 — GREEN 与检查点。** V-F、app typecheck/build；全业务 browser 流程由 P24 复用同一版本证据，UI 截图不能代替后端越权测试。

### Task 22: P22 — 停写回填、持久版本重建及恢复/回退预演

**Dependencies / Roles:** P25、P19、P20、P21；backend_implementer → backend_validator → reviewer。T08、BA15/BA19。

**Files:** Modify P25 已创建的 `server/scripts/better-auth/inventory.ts`, `migrate-directory.ts`, `verify-directory.ts`；Create 同目录 `rebuild-projections.ts`, `rehearse-recovery.ts`；Modify `server/src/enterprise/tenancy/backfill-consistency.ts`, `external-files-migration.ts`, `rollback-procedure.ts`, `startup-checks.ts`, `root-backfill.ts`（raw SQL insert principals/memberships 按 P25 静态清单处置）；Create `server/tests/better-auth/migration-recovery.test.ts`。backfill-consistency/external-files-migration/rollback-procedure 等当前包含其他工作尚未提交的新文件；开工重读 staged/unstaged/untracked 全文、确认来源和授权检查点后再集成，不只依据文件存在或 HEAD。

**Interfaces:** Consumes 完整目录/业务模型、旧授权核验清单、真实备份/对象高水位；扩展 P25 M0–M3 工具到最终 schema，Produces M4–M5 切换/完整恢复预演工具、校验报告和回退 runbook；CLI 默认 dry-run、显式测试/目标数据库与阶段参数，不默认执行生产。

- [ ] **Step 1 — 写迁移/恢复反例。** `duplicate_workspace_ids_keep_historical_business_ids`, `rebuild_preserves_revoked_old_grant_and_valid_new_grant`, `missing_or_rolled_back_clock_blocks_reopen`；`expect(clocksAfterRebuild).toEqual(clocksBeforeRebuild)`、旧 Grant/审批/lease 仍拒绝、新授权仍通过；保留凭据旧 use/disclose 及个人 owner 来源，新 Scope 也不能新签发/解密。
- [ ] **Step 2 — RED。** V-B；包含原身份/account/password hash、Run/订单/FK、payer、未知 owner、孤立关系和缺历史代际夹具；恢复只用一致副本，不操作开发/生产库。
- [ ] **Step 3 — 扩展并重验前置 M0–M3。** P25 已交付，不等待 P19–P21 才首次实现； 全入口清单、备份/哈希和外部事实记录；旧 UI/API/CLI/SCIM/JIT/startup/业务衍生写停写并受控重试。稳定映射幂等回填（BA organization.slug 按 interfaces §2 的归一化/碰撞/幂等规则派生，重跑不重派），旧能力核验重签/撤销，旧直连 URL 实际失效，旧 session 按公司 proof 处理；M2 inventory 核验 `sso_providers.organization_id` 存量为空，非空阻断回填；覆盖个人模型 Grant/Key 来源代际，未经历史核验的旧授权撤销而不自动有效；有未知归属/owner/payer/撤权历史保持隔离。
- [ ] **Step 4 — 实现 M4–M5 与重建。** 新增 `m3_to_m4_same_request_matrix_preserves_behavior_and_single_authority`，同一身份/公司/业务/管理/SCIM/模型 claim 请求在切换前后各有确定结果，paused 只拒目录写，legacy 不因缺 BA clock 退化； 原子 authority_version 切换、收旧写权限、仅 BA 命令写；重建只替换派生列，不删除历史行/clock，不发邮件/扣费。备份恢复核对 identity/directory/clocks/policy/grants/账务/外部对象同恢复点及已知撤权高水位；不能证明不回退则范围保持关闭。增加整个目录/clock/Grant/readiness 内部自洽但较旧的恢复副本，核验独立可信撤权高水位，不能只测删一行 clock；邮件/支付/工具外部事实对账不重复执行。
- [ ] **Step 5 — GREEN 和检查点。** V-B；M4 前无 BA-only 写才可回旧目录，M4 后只回兼容 BA 权威版本；权威回退需额外停写与完整事实恢复。记录数据量、耗时、锁等实测，不承诺零停机/RTO。M6 真发布不在本 Task 执行。

### Task 23: P23 — 启动、实际路由与后台装配闭环

**Dependencies / Roles:** P22；backend_implementer → backend_validator → reviewer。T08、BA08/BA09/BA16。

**Files:** Create `server/src/enterprise/tenancy/directory-readiness.ts`, `tests/config/better-auth-surfaces.json`, `scripts/check-better-auth-surfaces.ts`, `server/tests/better-auth/mounted-assembly.test.ts`；Modify `server/src/config.ts`, `server/src/index.ts`, `app.ts`, `server/src/enterprise/tenancy/startup-checks.ts`, `assembly-enterprise.ts`, `assembly-legacy.ts`, `assembly-stream.ts`, `worker-assembly.ts`, `worker/src/index.ts`。这些文件当前有并发改动，开工重新读取并按检查点集成。

**Interfaces:** Consumes P01–P25 的前置和最终实现、authority version、受限角色；Produces runtime 实际挂载覆盖和 startup refusal。清单是 CI 实际输入，留在版本控制，不能写进 `.archive`。

- [ ] **Step 1 — 写真实装配失败测试。** `unwrapped_auth_write_or_old_member_writer_blocks_startup`, `mixed_authority_process_cannot_write`, `every_mounted_business_surface_has_positive_and_negative_case`；`expect(unclassifiedSurfaces).toEqual([])`、错版本进程不启动写入，不只测试一个手工传入的 readiness 布尔函数。
- [ ] **Step 2 — RED。** V-B；创建真实 createApp/bootstrap 测试实例，按 interfaces §3.2 全端点清单覆盖 Admin/Organization 原生读写及 server API，R 类每个 GET 必须有 suspended member/company/missing proof 三反例，X 类所有 GET 包含发现/邀请原生端点均拒绝；本人窄读改用 OpenBot adapter，不泄露目录；关闭项后端拒绝，任何新增未知方法失败。覆盖 auth GET/POST、SCIM PUT/PATCH/DELETE、SSO 端点（interfaces §3.2 全表）、服务端 auth.api、CLI/seed/startup、Worker、长连接及真实旧版本并存进程拒写，不漏路由注册顺序。仍可达 `auth.handler` 的写端点一律列为失败（F-01）；以源码扫描核对固定版不经 ALS 的 `ctx.context.adapter` 直写清单（interfaces §3.1），清单外新增直写失败。
- [ ] **Step 3 — 接统一装配。** 全部目录入口注入 Directory、全局管理安全写注入 Identity，业务注入 gate/proof；对 PrincipalRegistry、邮箱验证、团队 Grant 授予/撤销及 provisioning rule 依据也核对实际装配，普通运行期不持离线迁移 operator 凭据；核验 P04 已存在的命令写 gate/authority 双轨与多租户 release gate 分开，不到本任务才首次实现。authority/schema/角色/必需服务不匹配，相关入口 503/启动拒写，不使用开发身份降级。
- [ ] **Step 4 — 实现可对账清单。** 每项含 id、实际 route/method 或 consumer、scopeKind、ownerTask、auth entry、enabledBy/authorityPhase、nativeDisposition、positiveTest/negativeTest（所有原生 organization GET 逐条三反例）、externalEvidence；从真实注册/consumer 调用点扫描核对，新增未知入口非零失败。公共例外逐项写理由，启用能力不允许空 evidence 引用。
- [ ] **Step 5 — GREEN 与检查点。** V-B、`bun scripts/check-better-auth-surfaces.ts` 和受影响启动测试；真实实例验证后续新请求不穿旧路由，最后才允许进入 M5 内部验收，M6 gate 继续关闭。

### Task 24: P24 — 独立验收、完整 Review/OCR 与发布准备交接

**Dependencies / Roles:** P23；主控只读业务代码/测试源、只写归档；backend_validator、frontend_validator 分验收范围，reviewer 独立双结论。T08、全部 BA 验收。

**Files:** 仅 `.archive/runs/<执行 run>/verification/`, `.archive/runs/<执行 run>/reviews/`, `.archive/runs/<执行 run>/ocr/`, `.archive/runs/<执行 run>/ledger.md`, `.archive/runs/<执行 run>/index.md`；修复生产/测试源须另建编号修复计划并派给对应实现角色，不借验证任务修改。

**Interfaces:** Consumes 已集成检查点、覆盖清单与 [acceptance.md](acceptance.md)；Produces 匹配相同版本的验收矩阵、全范围审查、迁移/恢复准备包及尚未执行的发布步骤。

- [ ] **Step 1 — 冻结交付版本。** 保存 superproject 与子模块 HEAD/diff/untracked 哈希、BASE 和检查点；复用同版本已有有效证据，只补缺失行为/环境。内容变化则补受影响验证与 Review。
- [ ] **Step 2 — 运行独立验收。** 按 BA01–BA20、本版 14 finding 及第三轮 F-01–F-10 验收、V-B/V-F/V-I/V-N/V-Q 执行真实 DB/角色/IdP/邮件/存储/原生客户端和全链路；结果包含实际用例数、skip/block、外部服务和清理证据。未取得真实已启用能力证据不得放行。
- [ ] **Step 3 — 独立最终 Review。** 专业验证者给行为结论，fresh reviewer 给 Spec compliance/code quality；高风险完整范围按已验证可用 Sol high/Astra high 及角色规则审查，不把测试通过当 Review。发现有效问题转修复任务，验证者不直接改。
- [ ] **Step 4 — 主控执行 OCR 外层闭环。** 读取当时 open-code-review 技能，以业务/验收/接口为背景，始终 `--audience agent`；未提交交付用 workspace，混合交付还审原始 BASE..HEAD，子模块源码单独覆盖，不能只审 gitlink。保存每轮完整范围/警告/跳过/退出码；真实 critical/high/medium 修复后重新完整审查。
- [ ] **Step 5 — 形成发布准备包。** 全部验收 verified、无真实阻塞 finding、旧写关闭/旧敏感 URL 失效/恢复通过，且实际 Mobile BFF/App 接线、邮箱验证及密码恢复正向、逐原生端点反例、个人模型 Key 实际网关撤权、hook/SSO 原始证据、浏览器配置/target 与 files/groups 对账、Principal 首建、Identity 故障回滚、Grant 生产/撤销与规则依据均有同版证据后，记录可部署兼容版本、停写顺序、监控/停用条件、回退点。**不自动执行 M6 发布、提交、推送或合并**；发布动作遵守届时独立授权，不能把计划或测试通过当发布授权。

**Failure handling:** 任一必需环境/验收/Review/OCR 缺失，标明具体 blocked 项及恢复条件，gate 保持关闭。OCR 有效问题生成新编号修复 DAG/计划，按 SDD 修复/验证/独立复审，再完整 OCR；连续两轮同问题无进展触发 systematic-debugging 并升级合适角色上下文，不假称完成。
