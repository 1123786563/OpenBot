# 公司团队全功能多租户整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全部现有功能完成公司、团队及个人权限隔离后统一上线；公司工作台共用余额，Bifrost 个人余额保留。

**Architecture:** 复用现有 Tenant/Principal/Membership/Workspace、业务存储、授权和计费机制，新增团队成员与版本化公共资源规则。按请求/任务固定公司团队归属，受限数据库事务、外部状态、客户端缓存遵守一致权限；公司与个人付款账户分开路由。

**Tech Stack:** Bun/TypeScript、Hono、Drizzle/PostgreSQL RLS、React/TanStack Query、现有 Worker/Agent、Go Runtime、Tauri/Rust、OpenMuse Expo/React Native。使用现有锁定依赖。

**Spec:** `docs/specs/2026-10-14-company-team-multitenancy-design.md`（已批准 R1–R7/A1–A13）；ADR `docs/adr/0004-company-team-tenancy.md`（accepted），保留 ADR 0001–0003 各自路径保证。

## Global Constraints

- 公司之间隔离；同公司团队之间默认互不可见。
- 员工可以加入同一家公司的多个团队。
- 加入团队后自动获得团队公共 Bot、公共知识库使用权；个人会话、文件和凭据保留个人权限。
- 所有现有功能完成隔离后统一上线。实施允许分批，开放门槛统一。
- 公司工作台采用公司统一余额，团队分别统计用量。
- 外部 Bot 直连 Bifrost 保留已有个人余额机制，个人模型授权及独立撤销规则保留。
- 缺少作用域或依赖不可用时拒绝，不回退默认公司、第一个团队或另一付款账户。
- 不复制权威业务数据，不修改旧策略隐含语义；个人凭据、支付资料及管理动作不继承团队公共权限。
- 普通业务使用受限数据库角色与事务本地上下文，不跨网络等待持有数据库授权锁。
- 无提交、推送、合并、生产迁移及发布授权。若实施获准，使用未提交检查点，不执行 git commit。
- 默认串行；validator/reviewer 只读，Spec compliance 与 code quality 分别报告。

## Review Focus

1. 多公司用户切换时，OAuth、已创建任务与费用仍属于原始范围——T07/T10/T15/T17–T22/T26。
2. 团队公共 Bot 不泄露发布者或其他调用人的凭据、个人会话、浏览器状态——T05/T07/T11/T18/T26。
3. 公司管理员、SCIM、删除恢复不误删其他公司资格、不自动读取个人内容——T02/T14/T16/T26。
4. 旧 REST/Copilot/mobile、分享、计数、检索、下载、事件流不成为旁路——T01/T06/T09/T12/T25/T26。
5. 公司/个人账户在重放、并发、未知结算、余额不足时不切换或重复授额——T15/T24/T26。

---

## 批准、工作区与事实源

- 设计及ADR已于2026-10-14批准；本实施计划编写日期2026-10-15，等待审阅与执行方法选择。
- 工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy`；分支：`1123786563/company-team-multitenancy`。
- BASE（计划编写时）：`c0167c5cf33c441588fa20d3eb5a7e2ade789371`。原目录 `/Users/wuyongjun/trea/OpenBot` 的其他会话改动不集成。
- 分支同步（2026-10-15 第二次）：main 已与 origin/main 统一为 `f0520524`（两条分叉线已合并），分支已合并 main HEAD（merge `bea61c03`）。合并带来 enterprise 栈重构：`server/src/enterprise/tenancy/scope.ts`、`transaction.ts`、`db/schema/enterprise-authz.ts`、`enterprise/app.ts` 已删除或内联（`resolveScope` 现在在 `server/src/index.ts`）；旧租户测试套件被新企业测试取代（governed-execution、enterprise-role-preflight、schema-migration-r2、mastra-compatibility、model-route-rebind、run-failure-contract 等）。Spec §2「当前代码事实」与 Testing Decisions 的 prior-art 清单按新栈解读；受影响文件引用见 dag-ledger 2026-10-15 同步记录。
- 提交授权（2026-10-15 用户确认）：本分支允许文档（计划 + 工单）提交并推送；产品代码提交、合并、生产迁移、部署与发布仍无授权。
- **任务清单以 GitHub Ticket 为准**：本计划的 26 个规划任务已按用户粒度要求细化并发布为 143 张 Ticket（MT001–MT143，Issue #44–#186，分 20 个分组 Epic #187–#206，父 Spec [#6](https://github.com/1123786563/OpenBot/issues/6)）。分册仅作文件级归属与共享接口参考。
- 已复制7个必要事实源并核对hash，见 `source-manifest.json`。不依赖新worktree自动带入未提交文档。
- 本次没有目标Issue，`source_issues=[]`，需求来自批准Spec；不创建或读取虚构Issue树。
- AGENTS引用的docs/agents两文件本地缺失已记入Spec；以实际AGENTS/CONTEXT/ADR/Spec和Git为事实源。
- 当前仅规划：未安装产品依赖、未运行产品测试或数据库迁移。执行开始时在独立测试实例完成环境/基线检查，再运行任务RED。

## 文件结构与分册

| 分册 | Tasks | 可独立测试的产物 |
| --- | --- | --- |
| [01 基础](01-foundation.md) | T01–T04 | 清单、成员与撤权、资源策略、公司配置 |
| [02 工作台](02-workbench.md) | T05–T08 | Bot/发布、会话/文件、凭据/OAuth、插件/审批 |
| [03 执行](03-execution.md) | T09–T12 | 知识/记忆、自动化、电脑/Runtime、Craft/Workshop |
| [04 业务](04-business.md) | T13–T16 | OpenMuse个人域、连接/删除、账务、治理 |
| [05 客户端](05-clients.md) | T17–T22 | Web公共选择与工作流、Rust原生、桌面UI、Canonical三端 |
| [06 收尾](06-release.md) | T23–T26 | 观测、历史迁移、全入口装配、完整验收 |
| [共同Interface](interfaces.md) | 全部 | 一次定义的类型、行为与测试seam |
| [DAG/Ledger](dag-ledger.md) | 全部 | 依赖、验收映射、恢复及检查点 |
| `tasks.json` / `surface-inventory.json` | 全部 | 可机器校验的DAG及文件/静态入口候选 |

本工作涉及多个子系统，采用总计划+六份可独立验证分册；分册通过冻结Interface连接，不将全系统写成一个不可审查任务。分册通过仅代表其候选功能可用，所有分册及最终门禁通过才统一开放。

## 最小改动原则与具体实现决定

1. 复用已有权威表及配置/授权/计费port；旧数据沿既有表加归属和复合关系，不向新旧两套业务存储双写。
2. 用一个可信公司Scope，加团队资格与资源授权事务；域facade绑定固定上下文并逐操作开短事务，不给所有调用链增加可伪造全局当前团队。
3. 团队公共资源的新策略workspace-v1与旧策略共存；团队角色仅workspace_admin/member，公司角色复用现有三个角色。
4. 增加OPENBOT_MULTITENANT模式以保持原单租户兼容；启用时必须通过全覆盖readiness，单用户绕过与缺上下文不允许。迁移期间候选代码保持未开放。
5. 公司账务和个人Bifrost账户是两个明确域，无跨账户余额回退；个人模型资格不会授予公司内容。
6. 共用连接池、编译模板与静态目录，按公司团队隔离业务配置、文件/线程/学习容器/浏览器状态、缓存和事件。
7. 不实现目前仅存在于另一个设计中的新Bifrost/Opik业务；实际已启用的集成按本计划提供隔离证据，设计不能算运行证据。

## Canonical OpenMuse基线差异

OpenBot BASE固定gitlink `apps/openmuse@46792335dfc260efa05f2185aa353093b12d9937`；该对象没有 `apps/mobile/src/openbot/`。本机canonical源码 `/Users/wuyongjun/trea/openmuse@81d0d3a15a27b00e24b2bed6f8b24c5b4d5330b4` 有已集成适配层。T22显式核对和审查原gitlink→集成基线→任务交付三段变化，不修改canonical主目录，不重新创建旧复制客户端。

子模块从实际审查基线独立建工作区或初始化本工作区的子模块；记录nested HEAD及递归未提交内容。无提交授权时不能把父仓库空gitlink diff当审查完成，OCR单独覆盖nested差异；候选发布时需要可复现的已批准gitlink/提交交付策略，未满足则不发布。

## 全文件与入口覆盖

`surface-inventory.json` 是基于冻结BASE生成的静态候选与文件归属，非已完成审计。T01取得真实注册路由（包括条件与动态路由）、Worker/脚本/agent入口、SQL表与外部存储明细；T25用真实装配与T26测试证明覆盖。未分类或业务正向不可用一律阻断release。

新增BASE合入的OpenMuse任务、个人文件/PDF、财务artifact、邮件/日历、reviewed-actions、通知、删除/保留/恢复分别归T13/T14；不能因早期设计表未单列而遗漏。

## 串行调度、文件共享与执行门禁

- T01开始前整体计划批准及执行方法已选择；读取Ledger+Git恢复状态。
- 只在所有depends_on为verified、已审查检查点已集成时派发任务。默认按DAG拓扑串行；ready不表示必须并行。
- 共享文件：`db/schema/core.ts` T05→T06→T07；`coworker.ts` T05→T10；`db/schema/openmuse.ts` T13→T14；`enterprise/contracts.ts` T02→T03。
- 单一拥有者 Interface：`auth/guards.ts`由T02定义、T07消费；`app/src/lib/enterprise/tenant`的公共选择由T17定义、T19消费，各域代码排除该显式所有权。
- Drizzle snapshot/journal由单任务独占写入，按0110–0125序列分配；独立KB0001由T09独占。变更BASE后重新核验编号。
- `server/src/app.ts/index.ts`由T25统一集成（T01只读）；候选域测试用真实域factory，T25再证明所有真实入口装配。
- `production-entry.ts`：T24→T25；`runtime-go/`、共享执行协议及agent进程：T11独占；`apps/openmuse`：T22独占nested写权限；桌面原生T20、桌面UI T21分开。
- 未列出的API/表/源文件必须归入拥有其业务闭环的任务并更新清单、Brief及验证；不得凭目录前缀自动判为已覆盖。
- 不共用git stash。数据库、端口、外部命名空间与生成目录都是冲突状态。

## Task Brief、报告及审查

每个Brief含单Task、批准事实源指针、workspace/BASE、owned_files/排除文件、Consumes/Produces、前置检查点hash、三个固定测试场景、验证命令、报告路径、提交策略（未提交）和失败处理。子Agent不继承整段会话，不再派发Agent。

后台任务归backend_implementer，Web/React Native归frontend_implementer，Rust组织连接归backend_implementer。验证者禁止修业务/测试源码；reviewer只读给两个独立结论。无需因为任务多而升级default实现角色。

每任务独立Review最多遵守SDD规定轮次；问题修复仍由专业实现者进行。全交付review按风险使用reviewer或default+显式Sol high/Astra high，固定角色的model不能用参数假装升级。调用时核对运行时实际可用模型，不在本计划捏造可用性。

## 检查点与OCR

本次默认不提交：主控任务前后记录HEAD、tracked staged/unstaged diff、全内容untracked/删除文件及hash，保存 `checkpoints/Txx/`。Review审任务增量，不能用空BASE..HEAD；验证绑定同一hash，内容改变则补相关验证/Review。

最终主控用open-code-review，始终audience agent：未提交内容workspace模式；若后来获得提交授权或发生混合交付，额外覆盖原始BASE至真实HEAD。nested子模块分别审完整变化，并记录原gitlink至nested基线的覆盖证据。报告记录退出码、范围、警告、跳过及失败文件；exit0但不完整不得通过。

有效critical/high/medium finding生成编号修复计划/DAG，由SDD对应角色修复，再验证、review、OCR复审；真实阻塞问题不能park后声称完成。连续两轮同问题无进展触发systematic-debugging及合理升级。

## 适用验证与统一开放

针对性任务命令见各分册。最终至少：
- `bun run typecheck`、`bun run --cwd server typecheck:enterprise`、`bun run lint`、`bun run format:check`、`bun run test:ci`、`bun run build`；
- `bun test server/tests/multitenancy`、`bun test app/tests/multitenancy`；
- `go test ./...`（cwd=runtime-go及实际修改Go适配器）、`cargo test --manifest-path desktop/src-tauri/Cargo.toml`；
- 各实际修改Python agent使用其自己的依赖环境运行原有pytest套件，不将缺依赖当隔离行为失败或跳过成功；
- Canonical OpenMuse apps/mobile typecheck、Web/iOS/Android export与真实原生端工作流验收；不以Expo export替代原生行为测试；
- 使用独立 `e2e.multitenancy.config.ts` 及独立服务端口、数据库、外部存储；不读取原root .env或共享既有本地栈。具体进程端口在验收配置中固定并启动前检冲突。

release必须同时满足A1–A13、所有入口有归属/覆盖、正向与越权检查均通过、无关键skips、独立验证/Review/OCR完整通过、历史迁移/恢复演练有证据。计划批准不是生产apply/部署/发布授权，验收脚本不能自动对外发布。

## 计划自查记录

DAG唯一性、引用、自环、循环、验收覆盖及路径存在性由规划检查脚本核验；shared-file与Interface见上文，工作区与批准来源hash见manifest。静态目录清单不能替代T01/T25实际注册表。本文不声称产品测试或隔离已通过。

## Execution Handoff

请审阅总计划及关注的分册，并选择：
- **Subagent-driven（推荐）**：主控串行派发专业实现者，每Task由独立验证/reviewer放行，再做完整OCR；适合本计划26个涉及数据与权限的任务。
- **Native**：本会话逐Task实施，末尾独立全交付Review/OCR；前期成本较低，但缺少逐任务独立Review。

已批准的设计不重新发现需求；具体计划与执行方法确认后才开始实现。

