# 企业 AI 平台四份设计与实施文档系统评审

**评审日期：2026-10-09｜评审方式：全文静态评审、当前代码接缝核对、关键官方资料核查**

**总评：方向可以保留，但四份文件尚不能作为一致、可直接执行的 MVP 基线。应先统一决策及端到端安全契约，再继续实施。当前暂不引入 OpenFGA/OPA 是可行的简化，不构成取消资源授权、危险动作约束或撤权一致性的理由。**

## 阅读说明与证据边界

| 简称 | 本次完整阅读的文件 |
|---|---|
| D：总体方案 | [2026-10-09-enterprise-ai-platform-design.md](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md) |
| M：总计划 | [2026-10-09-enterprise-ai-00-master.md](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md) |
| R：运行时 | [2026-10-09-enterprise-ai-01-runtime.md](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md) |
| T：租户权限 | [2026-10-09-enterprise-ai-02-tenancy.md](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md) |

- 以用户本次明确的“当前阶段暂不引入 OpenFGA/OPA”为约束。T 第 13 行已经记录此决定；不把 D、M 中相反的旧要求继续视为现行批准项。
- “确定问题”表示原文、代码片段或当前文件证据能够直接证明矛盾/遗漏；“设计缺口”表示尚不足以证明可行，不表示已发生事故。
- 当前 HEAD 为 `4773ef6`，但存在未提交变更及未跟踪的 `runtime-go/`、企业域代码。仅用 HEAD 不能代表本次所见工作区。
- `plans/` 当前列出 00、01、02；03–06 在本次工作区未提供。不能断言后续功能完全没有设计，也不能把未提供的分册当作已经覆盖问题的证据。
- 本次未执行编译、单元测试、数据库迁移、漏洞复扫或部署；未修改四份原文、源代码、依赖、Git 配置。既有依赖记录中的扫描结果仅作为待处置证据，不等于本次复验结论。
- 行号对应本次读取快照。问题编号供修订跟踪；跨文档同源矛盾集中在第三部分，避免重复计数。

## 一、总体评价

### 1.1 文档成熟度

| 维度 | 评价 | 主要依据 |
|---|---|---|
| 目标与范围 | 总体定位清楚，范围分层较完整；现行 MVP 边界未统一 | D 覆盖业务、技术、安全、交付；M/T 对其作了未同步的实质修订 |
| 架构原则 | 较合理 | 单写入方、执行隔离、权限交集、未知回执、版本锁定均有明确表述 |
| 实施可执行性 | 局部详细，整体尚未闭环 | T 有 SQL/接口/测试，但资源开通、写操作策略与后续账本契约尚缺；R 有失效章节引用 |
| Go/TypeScript 分工 | M/R/T 已形成较一致方向，D 仍冲突 | 保留 TS 控制平面与新增 Go 控制平面两条路线并存 |
| 身份与授权 | T 的方向可行，不能推广为全部平台授权已完成 | 显式成员、RLS、ACL、撤权复核合理；仅有 `read` 动作，无服务主体完整契约 |
| 持久性与副作用 | 原则正确，缺关键状态机与交互协议 | Temporal、Run Ledger、Go 会话、工具回执之间的写入和恢复权责未封闭 |
| 运维与性能 | 有目标，没有足够可执行的容量和故障验证条件 | 声明数字不是实测是优点；还需负载、依赖、故障边界及恢复顺序 |
| 文档治理 | 当前最明显短板 | 历史覆盖声明、已勾选步骤、计划阶段声明及实际代码状态不一致 |

### 1.2 值得保留的设计

1. **不把协议当安全与可靠性系统。** D §0、§14、§15 区分 AG-UI、MCP、A2A 的职责，并强调需要独立鉴权与治理。
2. **区分“请求取消”“实际退出”“外部操作已撤销”。** D §9.3–9.4、R R3 对未知副作用没有轻率承诺 exactly-once。
3. **新旧域隔离优于全面重写。** M §1、T §1/§7 选择独立企业入口，明确旧业务路由不能自动共享给 SaaS 租户。
4. **T 对 RLS 的定位基本正确。** 非特权角色、事务局部上下文、复合外键、无上下文默认拒绝、RLS 不是抵御已控制应用进程的边界，均有明确约束。
5. **不引入外部授权引擎后仍保留安全要求。** T 不缓存允许结果、不自动切换宽松实现，未知策略版本失败关闭；管理员不默认获得内容权限。
6. **规划与证据分开。** D 明确容量、人员、性能不是实测；T 明确替身测试不能证明真实数据库隔离。

### 1.3 推荐结论

- **可以认可：** TS 控制平面＋独立 Go 执行候选、PostgreSQL 权威 ACL＋本地 TS 授权、独立 Node 持久编排、按信任边界隔离工具/解析/浏览器的方向。
- **不建议认可：** 将现有四份文件标记为“整体实施就绪”，或将 R1/R2 的局部代码等同于“Go 运行服务可用于共享租户”。
- **不需要为完成评审而新增授权产品。** 当前重点应是统一规则所有者、可信身份、持久状态与副作用契约，而不是再引入一个平台组件。

## 二、逐份文档问题

### 2.1 D：总体方案

#### D-01｜业务成功标准未形成可签署的需求闭环

**定位：** [§1.3，L50–54](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:50)、[§25.2，L937–946](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:937)、[§29，L1041](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:1041)。

**原文：**“首期优先选择企业知识问答、文档处理、带审批的业务操作三类闭环”；“真实业务样本可用”。

**问题与影响：** 用户、能力和指标清单完整，但未把首批场景映射为输入、授权主体、成功/失败定义、非功能条件、责任人和验收数据集。上述表述适合作为评审假设，不足以决定 M1/M2 何时退出，容易出现“接口完成”但业务未可用。

**严重程度：P1，需求基线缺口。**

**修改建议：** 增加 `需求ID→场景→输入/输出→权限→风险→验收集→阈值制定人→分册任务` 表。尚缺业务输入的格明确为“待业务确认、阻断对应闭环验收”，不编造阈值、不把全部研发都阻塞在真实样本提供之前。

#### D-02｜最小生产部署粒度没有跟随简化后的基线收敛

**定位：** [§4，L92–118](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:92)、[§5.2，L171–178](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:171)。

**原文：**“MVP 不建设几十个微服务”；最小部署又列出过渡 BFF、Go 控制平面、运行服务、Temporal Worker、解析 Worker、工具网关与沙箱控制器。

**问题与影响：** 独立安全进程有充分理由，不能只按服务数量判断过度设计；但 Go 控制平面、外部权限服务已不属于现行基线，清单仍包含它们。缺少“必需/复用客户服务/可选/后续”的物理清单、每项运维所有者与私有化替代条件，成本和可部署性无法评估。

**严重程度：P1，部署与维护范围风险。**

**修改建议：** 按 M/T 修订物理部署图；保留安全隔离进程，合并无独立故障/权限/伸缩理由的治理模块。形成制品与依赖清单，包含版本冻结点、架构/系统要求、持久卷、凭证、连接方向、备份与运维责任。无需在本轮指定未经验证的新组件。

#### D-03｜备份恢复后的撤权和删除重放缺独立事实来源

**定位：** [§11.3，L418–422](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:418)、[§18.3，L720–724](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:720)、T [§8.3，L1281–1283](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1281)。

**原文：**“恢复旧备份时重新应用删除与撤权账本”。

**问题与影响：** 原则正确，但未说明账本是否与被恢复的业务库具有相同丢失窗口。若业务表与撤权事件同时恢复到旧时点，仅从这份旧库不能得知后来发生的撤权，存在已删除内容或权限恢复的风险。

**严重程度：P1，生产恢复阻断。**

**修改建议：** 明确恢复水位、撤权/删除事实的独立保留方式及可信来源；在对账达到恢复水位前关闭内容读取、索引检索和新工具调用。按“密钥与身份→数据库/对象→撤权删除重放→索引/工作流对账→开放业务”列出可执行演练；无法取得安全水位时保持隔离，不猜测放行。

#### D-04｜分期矩阵与正文对 MVP 安全/质量能力的归属不一致

**定位：** [§11.5，L428–434](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:428)、[§12.3，L471–484](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:471)、[§25.1，L924–929](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:924)。

**问题与影响：** 正文要求 MVP 基础重排、业务评测和审批等待；分期表却将“重排”“质量评测”“审批编排”写入二期。可以解释为基础能力与运营增强之别，但原文没有这个限定，执行者可能把首期必须的审批恢复或质量门禁后移。

**严重程度：P1（审批）；P2（检索/评测分期表述）。**

**修改建议：** 改成“MVP：最小审批暂停/恢复与参数绑定；二期：可视审批流程、复杂审批规则”；区分基础重排/发布评测与运营化重排/持续评测。为每一项列出明确排除内容。

> D 关于语言、身份源、OpenFGA/OPA 和状态权威的核心问题集中见 X-01、X-03、X-05，不在此重复登记。

### 2.2 M：总实施计划

#### M-01｜把尚未交付的分册描述为完整实施说明

**定位：** [§1，L48](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:48)、[§3，L70–79](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:70)、[§10，L199–212](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:199)。

**原文：**“本文件与六份子计划共同构成实施说明。”

**问题与影响：** 当前只提供 01、02，03–06 未在该目录中出现。映射到 E/P/K/D 的覆盖表只能证明计划分工意图，不能证明运行账本、预算、工具策略、知识 ACL、生产隔离已有完整设计。

**严重程度：P1，整体实施就绪性缺口。**

**修改建议：** 为每册标注“已交付/修订中/待编写/已批准”，并区分“需求已分配”与“方案已覆盖”。允许独立 R/T 验证继续准备，但相关闭环必须在对应专项规格和验收契约齐备后实施。

#### M-02｜依赖图遗漏关键边，可能指导错误并行

**定位：** [§3 表格与 Mermaid，L76–95](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:76)。

**问题与影响：** 表格规定 K 依赖 T2、E1、E4，图中却只有 `T→K`；表格规定运行适配依赖 R4，但图中的 E 没有 R 依赖。平台存储先做、真正执行后接入可以成立，当前却没有拆开这些验收对象。

**严重程度：P1，集成与排期风险。**

**修改建议：** 区分“契约/存储可先做”和“生产执行接线可完成”，把 E 的适配接线、K 的预算和模型依赖画成显式边。由一份任务依赖表生成图，不分别维护互相矛盾的两份真相。

#### M-03｜工作区事实、计划状态和证据快照已经漂移

**定位：** [§2，L52](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:52)、R [R1/R2 已勾选步骤](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:35)、R [L3](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:3)。

**原文：** M 写“`runtime-go/` 当前不存在，也没有 Go module”；R 仍写“本次仅编写计划，不运行其中命令”，同时 R1/R2 多项为 `[x]`。

**当前证据：** [runtime-go/go.mod:1](runtime-go/go.mod:1) 已有 module；[runtime-go/cmd/runtime/main.go:33](runtime-go/cmd/runtime/main.go:33) 入口仍主要挂健康服务；AG-UI/认证组件存在，但不能据此证明真实服务接线或 R4 互操作通过。

**问题与影响：** “计划编写时事实”“后续执行进度”“当前可用能力”混在同一时态。可能导致重复初始化、忽略现有用户变更，或把组件测试误认为系统验收。

**严重程度：P1。**

**修改建议：** 将 M §2 改成有时间戳的历史快照；单列当前状态、工作区差异摘要、证据制品哈希。R 的每个勾选项关联执行记录；R2 分成“组件代码”“认证装配”“真实 HTTP 接线”“协议测试”。本次并不判断历史授权是否充分。

#### M-04｜安全迁移入口与 T 的修订不一致

**定位：** [§5，L143–151](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:143)、T [T1-A，L262](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:262)、T [T1-B，L319–344](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:319)。

**当前证据：** [server/package.json:9](server/package.json:9) 的 `db:generate/db:migrate` 显式加载 `../.env`。

**问题与影响：** M 仍展示旧脚本作为通用执行入口；T 已因环境加载风险改用隔离测试执行器。单独阅读 M 可能误用实际部署连接。T 的修订不能自动修正 M 中可复制的旧命令。

**严重程度：P1，执行环境安全。**

**修改建议：** M 仅引用 T 的隔离测试迁移步骤；生产迁移另列批准的发布作业。G0 拆为本地 R 验证所需环境和数据库/身份集成环境，不让健康服务试验先依赖全部外部基础设施。

### 2.3 R：Go 运行时验证计划

#### R-01｜引用不存在的 R2-B，真实运行入口和能力就绪标准不完整

**定位：** [R2，L155–172](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:155)。

**原文：**“实际完整接线使用下文 R2-B 的 `New`。”全文不存在 R2-B。

**问题与影响：** 有 Resolver 片段，却没有完整说明认证 middleware、真实 Agent、AG-UI Handler、启动入口、关闭与 readiness 如何装配。当前代码入口尚未挂真实 AG-UI，说明这不是纯排版问题。R1 健康就绪不能代表 R2 执行就绪。

**严重程度：P1，执行阻断。**

**修改建议：** 补充明确的 R2-B 或删除引用并指向真实章节；定义监听路由、middleware 顺序、固定模型出口、依赖缺失时 readiness 行为、关闭资源。验收必须启动实际二进制并经过 TS 客户端，不只直接调用 Handler。

#### R-02｜“HTTP 不重试”不足以约束业务重复副作用

**定位：** [R3，L178–219](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:178)、D [§9.4，L344–346](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:344)。

**原文：** `Call(ctx, assertion, name, args)(Result,error)`；`Result{Text string; IsError bool}`；网络错误为 `OUTCOME_UNKNOWN`。

**问题与影响：** 契约缺少稳定的 `operation_id`、一次尝试标识、参数摘要、审批引用、fencing 和结构化回执状态。HTTP client 只调用一次，仍不能阻止 Agent 下一轮、Activity 重试或 Go 重启再次发起同一业务操作。将未知结果折叠成普通错误/文本，也不足以让账本与前端可靠进入人工核对状态。

**严重程度：P0，仅对接入真实写工具而言的安全阻断。**

**修改建议：** 在 R3 定义最小工具调用信封与回执 Schema，由平台签发/分配业务操作标识；区分 `not_submitted/submitted/succeeded/failed/unknown`，并通过持久操作账本阻断未知状态的自动重试。fake 回调可用于 G1a，真实副作用必须等待工具域契约验收。

#### R-03｜只过滤 state/forwardedProps，没有完整的可信输入边界

**定位：** [R2，L153–172](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:153)、[R4，L247–255](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:247)。

**问题与影响：** 清空 state 和 forwardedProps 是正确防护，但计划未说明 system/developer 消息、历史 assistant/tool 消息、工具定义、resume 内容、专家版本和模型路由由谁生成、谁可覆盖。AG-UI 输入格式合法不等于业务上下文可信；签名只绑定 Run 身份也不能证明输入被批准。

**严重程度：P1，混淆代理与历史注入风险。**

**修改建议：** 建立字段来源表：用户只提交新内容和受限选项；系统指令、工具目录、历史回执、模型路由、恢复状态来自 TS 权威配置。Go 再校验版本/摘要/大小等合同。添加伪造系统消息、工具回执、工具 Schema、未批准恢复输入的负向契约测试。

#### R-04｜R4 事件与恢复验收过薄，难以支持采用决策

**定位：** [R4，L229–257](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:229)。

**问题与影响：** 示例只检查一次 RUN_STARTED、一次末尾终止事件；作为首个单元测试合理，作为互操作验收则不够。没有精确规定文本/工具 ID 配对、交错消息、等待审批、断流重连、慢消费者、重复执行和服务重启应得到什么结果。报告 `adoption` 只有 candidate/rejected，也无法表达“协议验证通过但未准入生产”。

**严重程度：P1。**

**修改建议：** 以锁定的 TS/Go SDK 建立事件语义表与 golden fixtures；分别记录 transport、AG-UI turn、平台 Run 状态，不能把 RUN_FINISHED 一律当业务成功。报告改为分门禁状态和证据引用，取消/重启用故障注入验收；不要求当前 SDK 必须实现滚动文档的草案字段。

#### R-05｜依赖风险已有记录，但没有形成可追踪的候选处置流程

**定位：** [R1，L55–72](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:55)、[G1 评审步骤，L257](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:257)。

**既有证据：** [dependency-review.json:54–86](runtime-go/dependency-review.json:54) 记录漏洞扫描 `exitCode: 3`，并注明风险未修复、需要在接入租户流量前补丁处置或拒绝候选。本次未复扫，不确认其漏洞列表或修复版本仍然准确。

**问题与影响：** 锁定版本保证可重现，不保证安全。计划缺少“依赖冻结后发现风险→如何变更冻结图→谁批准→如何复跑兼容门禁”的闭环；容易以“必须固定候选”作为拖延修复的理由。

**严重程度：P0，生产准入阻断；不等于证明当前已遭利用。**

**修改建议：** 建立候选修订号、依赖图摘要、当前风险核查、修复/不适用证据及批准人。安全修订改变依赖图后复跑 R2–R4；隔离验证和真实租户准入分开。另给 RSS、并发、首事件、取消滞后等指定负载和可接受标准，不能只采集数字而无采用阈值。

### 2.4 T：租户、身份与权限计划

#### T-01｜独立验收需要的资源和 ACL 开通路径缺失

**定位：** [§1.3，L43–47](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:43)、[T1-C，L499–508](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:499)、[T3-A，L1026–1043](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1026)。

**原文：**“合法用户……读取自己明确有权限的资源元数据”；CLI 仅支持 `provision-member` 与 `suspend-member`。

**问题与影响：** 有资源、grants 表和读取接口，但没有对应的 workspace/resource 初始化、授予/撤销 ACL 的生产受控入口；撤销仅在测试 fixture 中描述。测试可通过插入数据跑通，不等于实际试点用户能获得可读资源。

**严重程度：P1，独立交付闭环缺失。**

**修改建议：** 二选一并明确：将 T 的完成标准限缩为基础库/契约验证；或新增离线受控 `create-workspace/create-resource/grant-read/revoke-read` 操作，统一 strict 输入、operationId、锁协议、epoch、审计。无需提前建设管理前端，更不能让 API 使用 operator 连接补洞。

#### T-02｜资源层级与角色范围不足以对应总体模型

**定位：** [Schema，L211–255](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:211)、[角色与只读授权，L848](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:848)、D [§6.1–6.2](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:194)。

**问题与影响：** T 有 Project 表，但 Resource 只引用 Workspace，项目与资源之间没有关系；没有空间/项目成员模型。角色只有 tenant_admin/member/auditor，内容访问全部依靠显式单资源 read grant。这是可选的最小设计，却没有明确声明总体层级、空间角色、继承、共享均未实现，后续模块可能各自补出不同语义。

**严重程度：P1，领域模型与扩展契约。**

**修改建议：** 明确 MVP 是否真正使用 Project；不用则暂缓表和产品承诺，使用则定义项目归属及复合约束。补一页角色—动作—资源范围矩阵，明确无继承/无跨租户共享/无隐式管理员读取。执行、审批、发布权限另建动作规则，不能扩展 `read` 的含义。

#### T-03｜策略版本发布流程与单一常量实现矛盾

**定位：** [T2-C，L830–850](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:830)。

**原文：** `resource.policyRevision!==LOCAL_POLICY_REVISION` 即 503；又要求“先发布兼容代码、验收后更新数据库版本，再退役旧版”。

**问题与影响：** 当前实现只能识别一个版本。若新副本只识别新版本，数据库尚未切换时新副本拒绝；先切数据库又会使旧副本拒绝。滚动发布的兼容窗口没有编码支持。

**严重程度：P1，可用性与授权升级风险。**

**修改建议：** 采用显式受支持版本集合/确定性规则函数映射，先部署同时支持旧新版本的代码，再切换租户期望版本，排空旧副本后移除旧实现；未知版本仍失败关闭。若选择停机切换，应明示停机窗口及安全回退，不宣称滚动兼容。这不需要外部策略引擎。

#### T-04｜禁用单用户模式的配置变量与当前实现不符

**定位：** [T3-B，L1092–1095](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1092)。

**原文：** 检查 `SINGLE_USER_MODE`。

**代码证据：** [server/src/auth/dev-actor.ts:59–85](server/src/auth/dev-actor.ts:59) 实际开关为 `OPENBOT_SINGLE_USER` 与兼容的 `OPENBOT_DEV_NO_AUTH`。

**问题与影响：** 当前片段不能实现文字承诺的显式配置拒绝。它同时要求真实 auth，并拒绝 `dev-local-user`，所以**不能仅凭变量错误断言已经存在匿名鉴权绕过**；问题在于保护约束无效及未来接线容易误判。

**严重程度：P1，防护与配置合同错误。**

**修改建议：** 明确企业入口拒绝两个实际开关及其规范化值，或提取共享解析器后执行企业专属“禁止启用”规则；保留真实认证及开发身份拒绝测试，新增带身份配置但错误开启开发开关的用例。

#### T-05｜复用认证工厂时，身份连接最小权限没有展开到真实依赖

**定位：** [角色合同，L279–285](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:279)、[T3-B/C，L1080–1086、L1157–1177](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1157)。

**代码证据：** [createAuth:203–259](server/src/auth/index.ts:203) 创建既有 enterprise settings/SSO 接线；[L281–286](server/src/auth/index.ts:281) 登录校验读取企业设置；[L430–441](server/src/auth/index.ts:430) 创建用户后写入角色；T bootstrap 还读取 revokedAccess。

**问题与影响：** 缩小 `DeploymentConfig` 类型不会自动消除工厂内部数据库依赖。若“仅身份表访问”按狭义执行，真实登录可能权限不足；若为图方便扩大角色到全部旧业务表，又破坏最小权限。

**严重程度：P1，认证可用性与授权面。**

**修改建议：** 列出登录/回调/会话/撤销实际读写表及权限；对必要旧设置使用最小查询接口或只读投影，对不需要的插件显式禁用。真实身份环境使用受限角色完成首登、再次登录、撤销、登出与回调测试，而非仅用假 getSession。

#### T-06｜认证路由白名单只有语法校验，没有实现危险类别禁止规则

**定位：** [T3-A，L934](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:934)、[T3-B，L1098–1117](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1098)。

**问题与影响：** 正则只验证 `GET|POST /api/auth/...` 格式，SCIM、SSO 注册等危险类别中的合法格式路径仍可被配置进去。管理员配置是可信输入，但文档承诺“本册禁止公开”就应有启动硬约束，而不仅是操作提醒。

**严重程度：P1，误配置导致管理面暴露的风险。**

**修改建议：** 从已验证的认证功能清单生成可选路由集合，配置只能选其子集；按确切方法、规范化路径、请求类型校验。补危险端点配置拒绝、真实 OIDC/SAML 回调可用性、重复斜杠/编码路径等测试。认证回调不能套用普通 JSON API 的 Origin 要求。

#### T-07｜本地授权保留两次事务和整套快照复核，复杂度偏高

**定位：** [T2-B，L698–751](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:698)、[T2-C，L771](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:771)。

**问题与影响：** 外部授权调用已删除，但仍采用 snapshot→本地规则→readIfCurrent 的两次 DB 事务。每次都重查成员并获取多层锁，增加往返、竞争、409 和误用旧快照的接口面。此方案并非错误；对当前仅返回元数据的同步本地规则，额外阶段没有明确收益。

**严重程度：P2，性能与可维护性。**

**修改建议：** 优先考虑一个 `readAuthorizedResource` 用例：同一短事务内取得保护锁、核对成员/资源/ACL/规则、读取允许字段，然后返回。保留纯 `Authz` 规则接口，但禁止其内部网络 I/O。若保留双阶段，说明用例并封装为不可绕过的服务 API，不把两个半成品接口任由业务组装。

#### T-08｜锁协议与安全测试尚不能证明并发撤权正确

**定位：** [T2-B，L619–650、L686–696](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:619)、[竞态示例，L753–762](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:753)、[RLS 测试，L289–306](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:289)。

**问题与影响：**

- 示例是先取快照、再撤销、再读，验证了过期快照，却没有验证两个活跃事务竞争同一 advisory lock。
- A/B 测试使用 `.every(...)`，空结果也为 true；无上下文无行测试若无夹具同样可能空通过。
- data 角色没有 UPDATE 权限，UPDATE 被拒绝不能单独证明 RLS 的 WITH CHECK 正确。
- 文档依靠所有写方自觉遵守 advisory 锁；T1 的 row lock 片段与 T2 的补强分散，尚未固定隔离级别及全局状态变更的完整锁顺序。官方明确 advisory lock 不由数据库自动强制参与者使用。

**严重程度：P1，安全证据不足，不等于已证明隔离失败。**

**修改建议：** 使用屏障同步的双连接测试，覆盖“读先持锁/撤权等待”“撤权先提交/读拒绝”“授权间隙改版”“异常回滚”。先断言夹具存在且有正向可见结果，再验证负向结果；区分表权限拒绝、RLS 拒绝和 FK 拒绝。固定 READ COMMITTED 或说明其他隔离级别下的快照/重试语义；汇总读写锁表和唯一变更入口，测试超时与锁竞争。

#### T-09｜全局 Principal 与租户级 operator 的变更范围没有完全对齐

**定位：** [Principal Schema，L196–201](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:196)、[operator 策略，L402–423](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:402)、[状态写入，L688](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:688)。

**问题与影响：** `enterprise_principals` 是全局主体表，operator 的策略 `USING(true)` 且具有 UPDATE；一个租户操作进程因此有能力修改全局主体状态/身份绑定。文档确实把它定义为离线特权，不应误报为普通用户越权，但必须区分租户成员暂停与全平台主体暂停，否则会误伤同一自然人的其他租户成员关系。

**严重程度：P1，特权操作与身份完整性。**

**修改建议：** 冻结已建立的 principal↔user 绑定；全局主体暂停/绑定修复单列高权限审批路径和审计，租户 operator 只操作本租户 membership/ACL。按需要细化列权限或能力角色，禁止后续管理 API 复用全局 operator。

#### T-10｜进程停机片段实际是强制断连接，不是排空

**定位：** [T3-C，L1144–1151](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1144)。

**原文：** `await server.stop(true)`。

**问题与影响：** Bun 官方说明 `true` 立即关闭活跃连接。对只读元数据路径主要是中断响应；以后加写入和事件流会增加“已提交但客户端未知”的窗口。shutdown 也没有先让 readiness 失效及错误处理。

**严重程度：P2；未来写路径接入前升级为 P1。**

**修改建议：** readiness 标记 draining→停止接纳新请求→限时等待在途请求→超时才强制关闭→关闭连接池；shutdown 异常应有脱敏记录与确定的退出行为。明确 SIGTERM 的预算和部署终止宽限期。

#### T-11｜错误、审计、索引及检查入口还有可维护性缺口

**定位：** [错误定义，L146–154](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:146)、[错误处理，L972–975](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:972)、[测试配置，L1245–1253](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1245)、[CI说明，L1324](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1324)。

**问题与影响：**

- 所有非业务异常均返回 503，未给 request_id、内部分类和重试语义，难区分程序错误、超时、依赖故障；不应为安全而丢失脱敏诊断。
- 新 tsconfig 只包含 tenancy 测试，没有统一纳入已有 enterprise runtime 测试；新增 `typecheck:enterprise` 不等于根 CI 已调用它。
- “新增 case 后更新预期数量”与 [scripts/test-ci.ts:16–57](scripts/test-ci.ts:16) 的最低测试数门槛不一致，不应每次新增用例都改精确总数。
- 成员目录按 principal 查询，但 membership 主键以 tenant 开头；缺少面向目录/撤权/审计的索引和查询计划验收。
- `policies.sql` 再复制进 custom migration 存在双份 SQL 漂移风险。

**严重程度：P2。**

**修改建议：** 与 D §17.1 统一错误信封并输出脱敏诊断；在实际 CI 显式调用企业类型检查并覆盖 runtime 测试；修正测试计数说明；以真实查询计划补索引；将安全迁移设为唯一可执行来源，规范 SQL 仅生成或链接引用。无需给每次元数据读取增加重复账本。
## 三、跨文档问题

### X-01｜现行架构基线没有唯一来源：Go、身份源、授权引擎三项冲突

**严重程度：P0，继续按整套计划执行前的决策阻断；不是指已发现生产漏洞。**

| 决策 | D 总体方案 | M 总计划 | R/T 后续文件 | 本次应采用的解释 |
|---|---|---|---|---|
| 控制平面 | §0/§4/§24：新增 Go、TS 作为过渡 BFF | §1：保留 Hono/Bun，Go 仅验证运行时 | R/T 均延续 TS 控制平面 | 不迁移 Go 控制平面 |
| Agent 运行时 | §4/§12：默认采用 tRPC-Agent-Go | §1/§6：候选，通过门禁再采用 | R：G1a/G1b 分层验证 | 候选未等于生产选型已通过 |
| 身份源 | §4/§6：Casdoor/企业 IdP，Better Auth 过渡 | §1：复用 Better Auth 和既有 OIDC/SAML | T：受控统一身份源，人工成员开通 | 保留现有认证，无强制身份源迁移 |
| 资源授权 | §4/§6：MVP OpenFGA | §1：集成门禁验证 | T：PostgreSQL ACL＋local-ts | 当前不引入 OpenFGA |
| 条件策略 | §4/§6：MVP OPA | §1：集成门禁验证、CEL 仅遗留 | T：移出当前范围，执行策略交给后续域 | 当前不引入 OPA，但必须补本地动作策略 |

**直接证据：** D [L99–105](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:99)、[L217–219](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:217)、[L868](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:868)、[L1039](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:1039)；M [L35–46](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:35)；T [L13](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:13)。

**影响：** 总体图、采购/依赖清单、人员配置、接口语言和验收门禁可能各按不同版本执行。T 的“本次只改 02”可以解释修订历史，却不是长期的跨文档一致性方案；而且其覆盖措辞限定“参与本册验收”，容易被理解成 04 等后续 MVP 模块仍必须引入 OPA。

**建议：** 在一处记录现行决策及适用整个当前阶段的范围；原地更新四份文档的规范性段落。旧路线保留在“已取代方案”章节，不再作为技术栈表或执行命令。未来是否采用外部授权引擎需要新 ADR，不能默认延迟到某册自动启用。

### X-02｜移除 OPA 后，危险动作的确定性策略所有者未落地

**严重程度：P0，真实写工具上线阻断。**

**定位：** D [§6.3，L219–222](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:219)、[§9.4，L344–346](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:344)；M [L43](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:43)；T [L258](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:258)、[L1337–1339](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1337)。

**问题：** T 的本地 Authz 只回答资源是否可读，明确不处理执行/审批；D 原来由 OPA 承担数据等级、无人值守、网络、危险工具等条件判断；M 又把旧 CEL 限定在遗留路径。当前所提供的文件没有定义新的确定性执行策略合同。

**影响：** 后续工程可能误把“能读资源”“专家绑定了工具”“用户点击了批准”当作足够执行条件，或悄悄复用旧允许策略。

**建议：** 在 04 开始编码前定义本地 TS `ActionPolicy` 的输入/输出与调用点：基于可信主体、当前租户/资源权限、安装授权、专家固定版本、委托、审批绑定、参数约束、网络和预算判断；返回 allow/deny/requires_approval 及稳定原因码/规则版本。由工具网关强制执行，不放入 Go Agent 决策循环。缺规则、状态不确定或未知动作默认拒绝。

**范围判断：** 这是后续工具域设计阻断，不意味着 T 的只读验收必须提前实现全部工具策略。

### X-03｜01 复用旧工具入口，而 02 的独立入口明确禁止该路由

**严重程度：P0，企业执行路径的身份与路由阻断。**

**定位：** R [R3，L178](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:178) 调 `/api/agent-tools/call`；T [T3-A，L948–951](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:948) 要求同一路径 404；M [§4，L119](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:119) 规定企业基址 `/api/enterprise/v1`，D [§17](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:650) 仍列 `/api/v1`。

**代码证据：** [callback-token.ts:75–121](server/src/agents/callback-token.ts:75) 旧断言没有 tenantId/principalId；[app.ts:1643–1719](server/src/app.ts:1643) 使用旧 token 与 signed run 链路；TS 验证路由的 `verify` 是宿主注入接口，不是已经存在的企业租户查询实现。

**影响：** 启动独立企业服务不能完成 R3 的真实工具回调；若为跑通而挂回整套旧入口，则绕过 T 的迁移隔离前提。旧断言本身没有 tenant 不意味着必然不安全，但必须有权威 Run→tenant/principal 映射，不能从请求头或 Go body 补出身份。

**建议：** 将旧入口限定为隔离 G1a 兼容实验；定义仅内部可达的企业运行验证和工具回调端点，使用服务身份＋短期窄能力＋Run 当前状态/租约映射。企业路径与旧 CEL/部署 token 默认许可彻底分离。统一公共 API 基址，列出公开、内部、遗留三类路由及网络可达矩阵。

### X-04｜G1、G1a、G1b 的准入含义没有统一

**严重程度：P1，验收治理缺口。**

**定位：** M [§6，L162–168](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:162) 用 G1 决定采用；R [L18](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:18) 明确 R1–R4 只达 G1a，G1b 依赖 T2/E2/P3/D4；R [L257](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:257) 又回到“评审 G1”。

**影响：** 即使各测试都诚实记录，读者也无法判断“采用”是否允许真实租户、写工具、持久任务或生产流量。

**建议：** M 统一定义 G0=输入/环境授权，G1a=协议与身份候选，G1b=持久恢复/隔离/安全准入，试点发布=业务、SLO、恢复及双部署验收。每个门禁列出前置、负责签署者、证据、禁止用途和失败处理；01 不单独发放生产准入。

### X-05｜Go、Run Ledger、Temporal 三方的状态权威与恢复粒度未封闭

**严重程度：P1；接入有副作用的自动恢复前属于 P0 阻断。**

**定位：** D [§12.4，L486–490](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:486)、[§13.1，L498–500](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:498)、[§16.4，L642](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:642)；M [L7](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:7)；R [L221](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:221)。

**问题：** 文档同时规定 PostgreSQL 运行状态为权威、Temporal 控制恢复、Go 执行图步骤，但尚未定义：

- 平台 run_id 与 AG-UI 一轮执行、重试 attempt、Temporal workflow/run 的映射；
- Go checkpoint 是临时内存、平台对象引用还是框架 session；谁可写、如何兼容框架升级；
- Run 创建与 Temporal 启动的原子性缺口如何用 Outbox/对账收敛；
- Go 事件产生、平台持久化、向客户端发布之间的 ACK、seq、重复/丢失处理；
- 崩溃后从哪个步骤恢复，如何拒绝旧进程/旧 lease 的结果；
- 审批等待是否结束当前 AG-UI turn，恢复是否创建新 turn，平台 Run 如何保持同一业务身份。

**影响：** 将整个 Agent Run 包装为一个可重试 Activity，可能重新执行已经发生的写操作；把 Go 会话与平台会话都当主存储又产生双主。Temporal 自身持久化不自动保证这些跨系统业务不变量。

**建议：** 03 先交付状态转换表、写权限矩阵和故障点时序：TS 运行域唯一修改业务账本；Node Worker 通过受认证内部命令推进；Go 仅上报执行事件/检查点提案。每个 attempt 带 fencing，平台在接受事件、调用工具和最终提交时校验。检查点先冻结最小兼容数据，不直接序列化任意框架对象；明确长 Activity 的 heartbeat、取消和重试禁止区间。

### X-06｜Web 主体模型尚不能直接承接定时任务、服务账号和共享会话

**严重程度：P1，跨进程身份契约缺口。**

**定位：** D [§6.2，L211](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:211)、[§6.5，L238](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:238)；T [Principal Schema，L196–201](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:196)、[§10，L1342](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1342)；R [VerifiedRun，L100](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:100)、[ResolveUser，L164–166](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:164)。

**问题：** T 的 principal 必须关联 users，Scope 必须含 userId；R 只有 actor/tenant/bot/run/thread，未区分主体、发起方、服务身份、有效委托。`tenant+actor+bot` 的运行时 user key 有利于隔离，但也意味着同一共享 thread 对不同参与者可能形成不同框架会话，需要明确是否仅支持个人对话。

**影响：** 后台任务容易使用伪造用户或永久借用创建者会话；跨进程传递 WeakSet Scope 不成立；共享会话记忆可能分裂或被错误合并。

**建议：** MVP 可以明确只支持人工身份发起＋受控委托的计划，不必立即建设通用身份平台；但需定义 principal_kind、actor/initiator/service identity、委托有效期与撤销、run/attempt 绑定。服务请求重新认证并由 TS 重建 Scope，不传递 JS 对象信任。另明确个人/共享会话各自的键与参与者授权规则。

### X-07｜密钥与模型出口仍缺少 Go 可调用但不可绕过治理的合同

**严重程度：P1，预算/数据出域控制缺口。**

**定位：** R [L7](docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md:7) 不接管模型供应商密钥；D [§10.2–10.4](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:356)、[§12.2，L453](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:453)。

**问题与影响：** 真实运行时需要模型端点和调用能力，但目前具体片段只说明 fake 模型测试。未定义业务别名由谁解析、Go 可否修改端点/参数、调用如何关联预算预留、模型网关失败谁重试、使用量如何去重。若给 Go 一个长期共享模型网关密钥，也可能绕过逐 Run 上限。

**建议：** TS 解析已批准路由并预留预算，向 Go 发固定路由引用和短时/窄作用域调用能力；模型网关或代理验证租户/run/attempt/额度，网络层禁止 Go 直连其他供应商。秘密引用由 TS/网关解析，Go 不获取长期供应商密钥。复用客户既有秘密服务可以，不将 OpenBao 变成未经验证的强制额外依赖。

### X-08｜故障承诺、分期与容量目标没有映射到当前拓扑

**严重程度：P1（故障与准入）；P2（排期口径）。**

**定位：** D [§5.2，L175–176](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:175)、[§21.1，L781–790](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:781)、[§26.2，L973–976](docs/superpowers/specs/2026-10-09-enterprise-ai-platform-design.md:973)；M [§7，L172–178](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:172)、[§9，L193](docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md:193)；T [§7.3 就绪与连接池](docs/superpowers/plans/2026-10-09-enterprise-ai-02-tenancy.md:1154)。

**问题与影响：**

- D 说控制平面故障时已启动 Run 可继续，而当前 TS 承载在线身份复核、工具网关、预算与账本；只能说明部分纯计算可继续，不能笼统保证执行与结果发布。
- D 将风险验证与 MVP 分开估时，M 的整体周次已包含风险验证；需要统一起算点，不应机械相加或当成交付承诺。
- “私有化可用”与完整离线包位于不同阶段，需区分不依赖 SaaS 控制平面与完全无外网交付。
- p95/RPO/RTO 有建议数字，但缺少目标部署、依赖故障范围、峰值持续时间、队列容量、事件保留和连接预算。99.5% 的平台可用性与一次灾难恢复允许的时长不能直接互证。

**建议：** 更新按依赖的故障表：认证/DB/工具网关不可用时哪些动作暂停、拒绝或只缓存提案；将排队、续流、已提交事件与未确认结果分开描述。容量验收绑定硬件/副本、真实 ACL/Chunk/消息大小与负载模型；全系统 DB 连接按所有进程/副本求和。双部署验收明确联网受控私有化与 air-gapped 的不同范围。

## 四、风险与优先级

### 4.1 分级含义

- **P0：阻断相应阶段。** 包括必须先统一的执行基线，以及在真实租户/真实副作用/自动恢复前必须完成的安全门禁；不代表所有问题都是已确认可利用漏洞。
- **P1：重大设计或交付风险。** 在相关模块实施或集成验收前修订，否则容易返工、无法验收或破坏生产边界。
- **P2：质量与维护改进。** 在文档定稿或相应生产能力上线前完成，不要求阻塞与其无关的隔离实验。

### 4.2 风险集中区

| 风险 | 核心问题编号 | 影响对象 | 阻断点 | 建议责任方 |
|---|---|---|---|---|
| 旧基线继续驱动编码/采购 | X-01 | 全平台 | 整体执行基线批准前 | 架构/技术负责人 |
| read 授权被误用为工具执行许可 | X-02、T-02 | 工具、审批、无人值守 | 真实写工具前 | 安全＋工具域负责人 |
| 企业运行绕回遗留入口 | X-03、X-06 | 共享租户与服务身份 | 企业端到端执行前 | 身份/运行域负责人 |
| 未知回执或恢复导致重复副作用 | R-02、X-05 | 外部业务系统、计量 | 有副作用自动恢复前 | 运行/工具/编排负责人 |
| 候选依赖风险未闭环 | R-05 | Go 运行服务 | 真实租户准入前 | 运行＋安全负责人 |
| 资源授权无法完成实际开通 | T-01 | 租户模块独立交付 | T3 正向验收前 | 租户域负责人 |
| 版本切换或身份表授权导致停服 | T-03、T-05、T-06 | 登录、授权、升级 | 真实身份/滚动升级验收前 | 后端＋SRE |
| 空夹具/顺序测试给出虚假安全感 | T-08、T-11 | 安全测试体系 | T2/T3 门禁前 | QA＋安全 |
| 灾后权限或数据复活 | D-03 | 全部存储与索引 | 生产恢复验收前 | SRE＋数据/安全 |
| 状态过期、分册未交付、依赖图错误 | M-01–M-03、X-04 | 多人实施与验收 | 对应任务启动前 | 技术负责人 |
| 重复事务、池与索引缺少容量证据 | T-07、T-11、X-08 | 性能与维护 | 容量验收前 | 后端＋SRE |

## 五、具体修改建议

### 5.1 建议统一写入各文档的现行基线文本

以下是建议文本，不代表已替用户批准新架构：

> 当前 MVP 保留 TypeScript/Hono/Bun 控制平面，负责身份映射、租户成员、资源与动作授权、资产版本、运行账本、预算与审计。Go 仅作为独立、可替换的 Agent 执行候选，不访问业务数据库，不获取长期模型供应商密钥，不自行扩大工具权限。通过协议候选门禁不等于生产准入。
>
> 当前阶段不引入 OpenFGA/OPA，不部署对应服务，不维护策略包、外部模型或自动切换适配器。PostgreSQL 保存成员及 ACL 权威数据；本地 TypeScript 执行确定性授权规则；工具网关在每次敏感动作前复核委托、安装授权、审批参数、当前权限和预算。未来引入外部引擎必须另行设计与批准。
>
> Temporal 使用独立 Node Worker，负责持久工作流与调度；TS 运行域拥有业务 Run 状态，Go 拥有可重建的执行态。各写入路径通过版本、幂等键、租约和 fencing 收敛，不形成业务状态双主。旧业务/工具通道仅服务明确隔离的遗留部署，不能作为企业路径的安全后备入口。

### 5.2 Go、TypeScript 与其他组件的建议职责矩阵

| 组件 | 应负责 | 明确不负责 | 数据与接口边界 |
|---|---|---|---|
| React/TypeScript 客户端 | 展示、用户输入、受控事件归约、审批交互 | 决定权限、保管供应商密钥、直接写外部系统 | 版本化 DTO/事件；展示权限不是服务端许可 |
| TS/Hono/Bun 企业 API | 会话适配、目录、Scope、资源/动作授权、资产、运行账本、预算、审计 | 执行不可信代码、把框架内部对象作为公共模型 | 唯一业务写入域；事务及授权在服务端完成 |
| Go Agent Runtime | 执行固定专家配置、模型编排、提议工具调用、上报事件、响应取消 | 租户治理、业务库写入、签发身份、绕过模型/工具网关 | 内部运行信封；短时能力；检查点/事件由平台确认 |
| Node Temporal Worker | 确定性编排、长等待、调度、Activity 生命周期、故障协调 | 直接 import Bun DB client、另写一份 Run 主账本、任意重试未知副作用 | 受认证内部命令；稳定业务幂等键和 fencing |
| 工具网关 | 参数验证、当前权限交集、审批绑定、意图与回执、受限执行 | 信任模型声明、把 HTTP 成功当外部业务完成 | 本地 TS ActionPolicy；调用与尝试分离 |
| 模型网关 | 批准出口、协议适配、并发/调用约束、尝试用量 | 成为业务账单唯一来源、替代知识 ACL | 固定路由/模型能力；关联预算预留与 attempt |
| 解析/索引 Worker | 处理不可信文件、生成版本化派生物、更新索引投影 | 获得全部租户身份库权限、越权传给重排/模型 | 受限任务身份及存储能力；ACL 与删除水位 |
| 沙箱/浏览器 | 执行受控任务、隔离凭证主体和文件、资源限制 | 访问控制区数据库、拿宿主 socket、自行放开出网 | 执行控制器分配 lease；产物扫描登记后发布 |

**技术选型判断：**

- **Go＋TS 是可行的边界选择，不是天然性能优势。** 分工必须依赖进程权限和接口，不能靠“用了 Go”证明安全或恢复可靠。
- **tRPC-Agent-Go 适合继续作为候选验证。** 已核对固定提交提供 UserIDResolver、StateResolver、输入 Hook 等接缝；仍需验证锁定客户端、真实启动、工具暂停/恢复、资源上限与依赖风险，不应直接宣布最终采用。
- **Node Worker 与 Bun API 分离合理。** Temporal 官方当前分支说明 Worker 依赖 Node 专有特性，强烈不建议运行在其他兼容运行时。还应冻结 SDK/Node/镜像，全部 Temporal 包版本对齐；本文不把当前分支说明当作任何已发布版本的兼容证明。仅写“glibc”仍不足以证明目标镜像与架构可用。
- **PostgreSQL ACL＋本地规则可覆盖当前受控 MVP。** 适用前提是明确资源/动作范围、受控写入口、事务与撤权语义；不意味着可以无限扩展成自研通用策略语言。
- **RLS 是纵深边界，不是万能隔离。** 会话参数来自可信服务；被盗业务数据库凭证或已控制 API 进程不在其防护承诺内。TRUNCATE 要靠表权限而非 RLS 阻断。
- **Higress、pgvector、对象存储、gVisor 的角色与 D 的目标相容，但并未完成本次兼容验收。** 必须按真实模型协议、ACL 过滤、中文检索、浏览器系统调用、网络策略执行与私有化环境测试。保留客户已有等价基础服务，避免重复建设。

### 5.3 应补齐的最小合同，而不是新增平台

以下字段是建议用于专项设计的最低检查项，不是已实现 API：

| 合同 | 必须明确的字段/语义 | 权威方 |
|---|---|---|
| RuntimeInvocation | schema_version、tenant/principal/actor/initiator、run/attempt/thread、专家版本、输入摘要、路由引用、截止时间、lease/fencing | TS 运行域签发/校验，Go 消费 |
| ToolInvocation | operation_id、attempt_id、固定工具安装版本、目标与参数摘要、授权/审批引用、fencing、未知回执处理 | TS 工具域 |
| RunEvent | 平台 run_id、执行 attempt、源事件标识、单调 seq、持久化 ACK、脱敏 payload、重发去重 | TS 运行账本；Go 不分配最终业务 seq |
| AuthorizationDecision | 动作、资源、策略/ACL/成员版本、allow/deny/requires_approval、原因、约束 | 本地 TS 规则＋数据库事实 |
| Checkpoint | schema/专家/框架兼容版本、消息引用、已完成操作回执、待审批步骤、剩余额度、内容摘要 | 平台持久化；Go 提案，不承诺任意内部对象稳定 |
| RecoveryWatermark | 数据备份时点、撤权/删除重放水位、对象/索引版本、工作流对账状态 | 受控恢复流程 |

### 5.4 推荐的端到端验收切面

| 切面 | 必须观察到的行为 | 不足以作为通过的证据 |
|---|---|---|
| 只读租户 | 受限真实 DB 角色、真实会话、可开通的资源、显式 ACL 可读、撤权后拒绝 | 仅 fake Directory/Authz；空表无行 |
| 协议候选 | 实际 Go 二进制＋TS HttpAgent，可信输入与事件生命周期可验证 | Handler 单测；手写 SSE echo |
| 受控工具 | 参数变更不能复用审批、未知回执不重试、旧 fencing 无效、旧入口不可达 | HTTP client 调用次数一次 |
| 持久恢复 | 启动/执行/提交各故障点可对账，已确认副作用不重放，取消有真实终态 | Worker 能重启、数据库有 Run 行 |
| 模型预算 | 并发预留不超上限，所有 attempt 可核账，Go 无其他出口 | 事后汇总网关日志 |
| 生产交付 | 安全角色、实际网络隔离、容量负载、排空升级、恢复安全水位、SaaS/私有化边界 | YAML 检查、服务健康、备份成功日志 |

### 5.5 按优先级排序的修订清单

按“先解除错误执行方向，再封闭安全接线，再完善可用性/维护”的顺序执行；这是文档修订建议，不授权编码或部署。

| 顺序 | 优先级 | 修订事项 | 涉及问题 | 完成标准 |
|---|---|---|---|---|
| 1 | P0 | 统一 TS 控制平面、Go 候选、现有认证、当前无 OpenFGA/OPA 的基线 | X-01 | D/M/R/T 的规范性段落、技术栈、图和验收要求一致；旧方案明确失效 |
| 2 | P0 | 定义本地动作策略与真实企业工具边界 | X-02、X-03 | 不复用旧入口放宽权限；read 与 execute/approve/publish 明确分离 |
| 3 | P0 | 固定 Run→主体/租户/attempt 绑定与短期服务能力 | X-03、X-06 | TS 可权威解析映射；Go/Worker 不能凭 body 或序列化 Scope 取得权限 |
| 4 | P0 | 完成工具 operation/attempt/receipt/unknown 合同 | R-02、X-05 | Agent/网络/Activity/进程重试均不会绕过操作账本；未知结果进入核对 |
| 5 | P0 | 将已有依赖风险转为修订/拒绝候选的准入处置 | R-05 | 当前依赖与工具链有复核证据；修订后重跑兼容验证；未闭环不接租户 |
| 6 | P1 | 统一 G1a/G1b/试点门禁和状态词汇 | X-04、R-04 | 每级用途、禁区、前置、证据和签署人唯一明确 |
| 7 | P1 | 补齐 03–06 的交付状态、契约依赖及任务图 | M-01、M-02 | 不再把分配任务当作设计覆盖；图表依赖一致 |
| 8 | P1 | 修正当前工作区快照、R2 勾选粒度与不存在的 R2-B | M-03、R-01 | 区分历史事实、组件存在、真实接线、测试结果；提供可定位章节 |
| 9 | P1 | 补齐资源/ACL 离线开通和受控变更闭环 | T-01、T-09 | 测试无需绕过生产契约建授权；租户与全局操作分离 |
| 10 | P1 | 固定最小层级、角色、身份与会话范围 | T-02、X-06 | Project/Workspace 是否纳入明确；定时主体及共享会话不靠隐含约定 |
| 11 | P1 | 修正策略版本滚动切换方案 | T-03 | 混合版本副本可安全过渡，未知版本拒绝，回退顺序明确 |
| 12 | P1 | 修正身份配置、真实表权限、认证路由白名单 | T-04–T-06 | 实际开发开关被拒绝，真实登录可用，危险管理端点配置不能放行 |
| 13 | P1 | 补齐可信输入、事件语义、检查点与模型出口合同 | R-03、R-04、X-05、X-07 | system/history/tools/resume 来源可追溯；状态映射、预算和出口不依赖默认行为 |
| 14 | P1 | 增强数据库权限与并发撤权的实际证据 | T-08 | 非空正向夹具＋双连接屏障＋不同拒绝原因；锁协议和隔离级别固定 |
| 15 | P1 | 统一安全迁移入口与恢复水位 | M-04、D-03 | 测试不加载部署环境；灾后未完成撤权/删除对账不开放业务 |
| 16 | P1 | 绑定业务验收集、最小部署与故障/容量条件 | D-01、D-02、X-08 | 有责任人和数据集；依赖/成本/私有化范围可验收，非框架宣传 |
| 17 | P1/P2 | 修正审批、检索、评测的分期口径 | D-04 | 首期安全基础与二期运营增强不混淆 |
| 18 | P2 | 简化本地读取授权事务，完善索引、错误与 CI | T-07、T-11 | 无绕过式仓库接口；企业测试进入 CI；错误可定位且不泄密 |
| 19 | P2 | 改为限时排空停机并验证连接预算 | T-10、X-08 | 先退出就绪、再排空、最后强停；写路径上线前完成 |
| 20 | P2 | 统一文档版本、链接、片段属性和证据归档 | M-03、T-11 | 用稳定章节/文档摘要；明确伪代码/可编译样例；SQL 单一来源 |

**建议的评审处置：** 保留总体方向；退回“跨文档基线及安全接线”专项修订。可以继续不触及真实租户的候选验证准备，但不应把未闭环的 R3、自动恢复或旧工具入口开放给生产。完成前列修订后，再按独立验收切面推进，不以整册复选框代替生产证据。

## 附录：本次外部技术依据与适用限制

检索/读取日期均为 2026-10-09；滚动页面只用于能力和语义核查，不自动证明锁定依赖、当前工作区或生产部署支持这些功能。

| 来源 | 本报告使用的事实 | 限制 |
|---|---|---|
| [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) | owner/BYPASSRLS 边界、FORCE RLS、默认拒绝、TRUNCATE 不受 RLS 保护 | 不证明 T 的迁移 SQL 已执行或全部正确 |
| [PostgreSQL 17 Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html) | advisory 锁依赖应用共同遵循；事务级锁生命周期；锁内存与死锁风险 | 未进行并发数据库实验 |
| [Bun Server](https://bun.sh/docs/runtime/http/server) | `stop()` 排空，`stop(true)` 立即终止活跃连接 | 需在仓库锁定 Bun 版本做停机验证 |
| [AG-UI Events](https://docs.ag-ui.com/concepts/events) | lifecycle、工具事件、含 interrupt 的结束语义与扩展草案 | 不能用滚动页面替代 TS/Go SDK 契约 |
| [固定提交 tRPC-Agent-Go runner/options.go](https://raw.githubusercontent.com/trpc-group/trpc-agent-go/9bb1c42b968c659124a5bb76eb6a676d546442a1/server/agui/runner/options.go) | 默认 user、客户端 state 合入、解析器/Hook、元数据开关等接缝 | 支持边界分析，不是互操作和恢复通过证据 |
| [Temporal TypeScript SDK 官方仓库](https://github.com/temporalio/sdk-typescript) | 当前分支 Worker 依赖 Node 专有能力，不建议使用替代运行时；包版本需对齐 | 分支要求不必然等于 npm 发布版本；镜像/架构仍待验证 |
| [gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/security/) | 增加系统调用隔离但有模型边界，不能替代网络/挂载/权限治理 | 未做目标浏览器、CNI、RuntimeClass 实测 |

**证据保留建议：** 当前文档目录被 `.gitignore` 忽略，Git commit 不能追踪其修订。可通过批准的文档库或文件摘要保存每次评审快照；是否修改忽略规则、纳入版本控制由用户另行决定。本次只新增本评审报告。
