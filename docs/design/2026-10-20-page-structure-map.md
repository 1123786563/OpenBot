# OpenBot 页面结构与设计覆盖地图

日期：2026-10-20。分支：feat/heroui-v3-migration。
依据：当前工作区路由、共享布局、导航配置和代表性业务组件；包含已有未提交迁移内容。
范围：静态代码结构分析与视觉设计建议。不是已批准实施 Spec，也不代表所有页面已经浏览器验收。

## 1. 三套外壳与基本布局

| 外壳 | 当前结构 | 滚动与导航 |
| --- | --- | --- |
| 日常工作区 `_authed/_app.tsx` | 340px AppSidebar + 主区域 + 可选右侧面板 | 固定视口，各区域内部滚动；顶部有 SelfHostBanner |
| 个人设置 `settings/route.tsx` | 300px SettingsSidebar + 内容 | 配置页文档流；返回主应用入口 |
| 管理后台 `admin/route.tsx` | 300px AdminSidebar + 内容 | 管理员角色门禁；返回主应用入口 |

共享骨架：`SidebarShell` 保存折叠偏好；`PageShell` 提供标题、说明、主操作、可选返回入口，正文默认 max-w-2xl（16px 根字号约 672px），wide 为 max-w-5xl（约 1024px）。
`PageSection` 是分组；`PageRows` 是带圆角外框的多行容器，内部行不单独圆角。
`DetailPanel` 默认 400px；可用区域不足 detailWidth + 400px 时转 Sheet。此判断是容器宽度，不是统一浏览器断点。
主导航移动端小于 768px 使用侧栏 Sheet；不能推导所有业务页都已适配移动端。

代码依据：
- [应用外壳](../../app/src/routes/_authed/_app.tsx)
- [后台外壳](../../app/src/routes/_authed/admin/route.tsx)
- [设置外壳](../../app/src/routes/_authed/settings/route.tsx)
- [页面骨架](../../app/src/components/layout/page-shell.tsx)
- [详情面板](../../app/src/components/layout/detail-panel.tsx)

## 2. 主导航的真实入口

AppSidebar 当前是：品牌/新建对话 → 搜索 → 会话列表（置顶、未读、忙碌、分页）→ Bots / 技能 / Craft → 用户菜单（个人设置、管理员入口、退出）。
当前没有样例图里常驻的“工作台 / 知识库 / 审批”同级主导航。知识库位于后台；个人审批在设置，Bot 待办在 Bot 详情。
设置与后台会替换侧栏内容，不是一直保留会话列表再叠加第二个全局导航。

代码依据：[AppSidebar](../../app/src/components/app-sidebar/app-sidebar.tsx)、[SettingsSidebar](../../app/src/components/settings/settings-sidebar.tsx)、[AdminSidebar](../../app/src/components/admin/admin-sidebar.tsx)。

## 3. 日常工作区页面

| 页面/路由 | 当前大致结构 | 设计关注点 |
| --- | --- | --- |
| 首页 `/` | 居中的新对话入口、Composer、探索 Agent 横向卡片区 | 首次行动清楚，Bot 身份展示与后续列表保持一致 |
| 新对话 `/channel/new` | 顶部收件 Bot 选择、会话区域与输入；首条发送才建会话 | 单 Bot / 多 Bot 选择和创建中反馈 |
| 单 Bot 对话 `/channel/$channelId` | 顶部会话标题与动作、消息/输入区、可选右栏 | 对话是主区域；右栏为电脑、工作坊、Bot 资料三者之一 |
| 群聊 `/group/$channelId` | 群聊标题、成员入口、暂停提示、GroupChat | 多 Bot 发言身份、消息顺序与成员信息 |
| 直接 Bot 聊天 `/bot` | Bot 标题、新建对话动作、CopilotChat，可打开电脑面板 | 另一条聊天入口，视觉要与 channel 保持一致 |
| Bots `/bots` | 标题+创建按钮，分组行列表 | 顺序为需要你、置顶、自己的、共享的、折叠隐藏的；当前不是卡片网格 |
| 技能 `/skills` | 个人/工作区技能分组列表，新建/编辑右侧详情 | 列表与编辑面板组合，权限和技能归属清楚 |
| 例行任务 `/routines` | PageShell + RoutinesList | 与 Bot 局部例行任务共用列表组件 |

聊天工作坊右栏实际有六个 Tab：过程、文件、产物、用量、分享、计划任务。
右栏的 settings/watch/workshop 通过搜索参数控制，打开一种会清除其他种类；生成的概念图中固定“任务详情”不是现有面板的逐项复刻。

代码依据：[BotRoster](../../app/src/components/bots/bot-roster.tsx)、[WorkshopPanel](../../app/src/components/channels/workshop-panel.tsx)、[单 Bot 对话](../../app/src/routes/_authed/_app/channel/$channelId.tsx)。

## 4. Bot 详情与配置链

`/bots/$agentId` 是一个纵向 Bot 工作详情页：身份头像/职责 → 暂停提示 → 需要你处理的事项/建议 → 当前启用与通知配置 → 进行中/计划中/已完成活动 → Bot 设置入口 → 管理操作。
管理操作包括置顶、隐藏、复制、重置、删除，具体按权限或分配状态显示。
它不是已经存在的左侧 Bot 专属导航 + 顶部一排 Tab。

| 子页面 | 当前内容结构 |
| --- | --- |
| `/responsibilities` | 职责列表、新建/编辑职责弹窗 |
| `/reach` | 此 Bot 联系用户的投递配置 |
| `/memory` | 记忆来源、主动研究设置、个人记忆入口 |
| `/approvals` | 此 Bot 的审批规则；待处理事项也出现在 Bot 主详情 |
| `/routines` | 当前 Bot 的例行任务列表及操作 |
| `/access` | 技能、连接器/授权、交接配置 |
| `/sharing` | 发布/共享与可见性配置 |
| `/setup` | 身份信息、连接配置、回调凭据等 |
| `/runs`、`/runs/$bindingId` | 筛选/分页运行列表；详情按概览、可用性、引用、元数据、步骤纵向分组 |
| `/datasets`、`/evaluations` | 数据集列表；评估页同时呈现数据集与实验区域 |
| `/evaluations/$datasetId` | 数据集详情 |
| `/evaluations/experiments/$experimentId/$executionId` | 实验执行结果 |
| `/evaluations/experiment-comparisons` | 实验比较 |
| `/exports` | 导出任务状态 |

前八个配置入口在 `BotSettingsRows` 中；观测与评估路由的存在不代表已经全部出现在这组设置入口中。原型时需逐一核对入口，不能把“有路由”当作“用户容易找到”。
子页多数使用 `BotSubpage`：返回 Bot → 页面标题/说明 → 当前配置内容。

代码依据：[BotProfile](../../app/src/components/bot-profile/profile.tsx)、[设置入口](../../app/src/components/bot-profile/settings-rows.tsx)、[BotSubpage](../../app/src/components/bot-profile/bot-subpage.tsx)、[运行详情](../../app/src/components/ai-observability/run-detail.tsx)。

## 5. Craft 工作台

| 页面 | 当前结构 |
| --- | --- |
| `/craft` | 主应用侧栏之外，再有 Craft 会话侧栏；中间显示选择会话提示 |
| `/craft/$sessionId` | 主应用侧栏 + Craft 会话侧栏（w-64）+ 聊天主区 + 固定 420px 输出区 |
| `/craft/tasks` | Craft 会话侧栏 + 计划任务列表 + 可打开的计划任务编辑面板 |

Craft 输出区有预览、文件、产物三个 Tab；聊天标题栏显示沙箱状态。
计划任务列表展示启用/暂停、上次运行状态、调度描述、下次运行时间与编辑动作。

设计建议：Craft 应保留“对话 + 产物工作区”的特征；优先研究窄屏下全局导航、会话列表、聊天、输出区的收起/切换方式。当前多列固定宽度会挤压聊天区，是否出现溢出需浏览器实测。
Bot 例行任务、Craft 计划任务和聊天工作坊计划任务是不同入口，不能只凭名称相似直接合并。

代码依据：[Craft 会话](../../app/src/routes/_authed/_app/craft/$sessionId.tsx)、[会话侧栏](../../app/src/components/craft/session-sidebar.tsx)、[输出区](../../app/src/components/craft/output-panel/index.tsx)。

## 6. 个人设置

设置侧栏实际包含以下页面，主要是单列分组配置；费用页使用 wide 宽度。

| 页面 | 大致结构 |
| --- | --- |
| `/settings` | 深浅主题、语言、消息列表偏好、常驻指令、快捷键说明 |
| `/settings/notifications` | 更新投递路由、原生设备、最近投递记录 |
| `/settings/approvals` | 执行前确认设置、所有 Bot 通用规则、其他 Bot 规则 |
| `/settings/memory` | 个人记忆列表 + 手动记住事实入口 |
| `/settings/connected-accounts` | 账号搜索/列表、共享账号、已关联账号、GitHub 来源、团队 Bot 同意记录 |
| `/settings/connected-accounts/$key` | 单个服务账号状态、连接/撤销操作、授权信息；不同接入类型分支不同 |
| `/settings/model-access` | 模型选择、已有模型授权、绑定码输入/预览/确认结果、说明 |
| `/settings/passwords` | 保存的登录信息列表及删除 |
| `/settings/components-gallery` 与 `/$name` | 组件预览集合；单个组件预览与元信息 |
| `/settings/usage` | 订阅、个人积分账户、购买、奖励积分、消费记录，按配置呈现 |
| `/settings/orders` | 订单表、订阅状态、积分发放追溯 |
| `/settings/invoices` | 时间范围、账单列表、分页、账单详情弹窗、下载 |

设计建议：账号、权限、记忆是个人配置类；费用页面是数据/交易类。二者共用色彩与控件，正文宽度和信息密度保持区分。
个人消费账户、公司积分和 Bot 模型访问授权须遵循 CONTEXT.md 的领域区分。

## 7. 管理后台

后台首页当前是分组配置入口目录，不是已有的 KPI 大屏。侧栏把入口分为四组。

| 导航组 | 页面 | 大致结构 |
| --- | --- | --- |
| 连接/治理 | `/admin/credentials` | 凭据列表、添加输入、操作 |
| 连接/治理 | `/admin/bot-services` | Bot 服务注册列表、新建/编辑弹窗 |
| 连接/治理 | `/admin/gateway` | 就绪状态、网关地址、限流、凭据设置 |
| 连接/治理 | `/admin/model-catalog` | 同步设置/动作、模型目录列表 |
| 连接/治理 | `/admin/boundaries` | 边界说明、策略与试运行结果 |
| 连接/治理 | `/admin/approvals` | 团队审批设置与规则 |
| 连接/治理 | `/admin/computers` | 主机目录配置、电脑列表、目录授权 |
| 能力/资源 | `/admin/plugins` 与详情链 | 连接器列表；单连接器账号模式、启用状态、Bot/工具授权详情；含 Composio / Open Connector 专页 |
| 能力/资源 | `/admin/skills` | 已安装技能列表、编写技能弹窗 |
| 能力/资源 | `/admin/market` | 专家、技能、连接器三个 Tab；发现/已有内容与详情弹窗 |
| 能力/资源 | `/admin/knowledge` | 知识库列表、新建、删除确认 |
| 能力/资源 | `/admin/knowledge/$kbId` | 添加文档、上传任务、文档筛选/排序/列表、检索测试 |
| 能力/资源 | `/admin/learning` | 学习配置、目标参数、容器设置 |
| 能力/资源 | `/admin/components` 与 `/$name` | 组件预览、详情与配置 Sheet |
| 能力/资源 | `/admin/playground` | 输入/代码编辑与生成 UI 预览 |
| 人员/费用/身份 | `/admin/people` | 人员信息、角色/访问控制 |
| 人员/费用/身份 | `/admin/billing` | 管理员积分发放、计费清理执行 |
| 人员/费用/身份 | `/admin/identity-providers` | 身份提供方列表、配置、元数据 |
| 历史 | `/admin/audit` | 审计记录、动作/发起人/目标信息、翻页 |

额外存在 `/admin/enterprise` 企业配置页，以及 `/admin/observability`、`/admin/ai-observability` 两个共享同一可观测性汇总组件的路由。
这几个路由不在当前 AdminSidebar 的 GROUPS 中；是否有其他深链入口需另核对，不能按路由文件自动增加导航。
可观测性汇总是时间范围 + 采集健康 + Bot 范围汇总，设计不得用无数据来源的指标装饰替代现有事实。
后台知识库是资源管理界面；把知识库移进普通用户主导航属于信息架构/权限设计变更。

## 8. 独立流程与兼容入口

- `/sign`：品牌/Agent 视觉、身份提供方按钮、SSO 输入。
- `/onboarding`：欢迎、电脑能力、Bot 名册等步骤和前进/返回操作。
- `/sign-in/$requestId`：Bot 请求的私人登录表单，不等同于平台登录页。
- `/tenant/selection`：公司与团队选择、成员/权限相关状态。
- `/tenant/channels`：租户选择、频道列表、选中频道记录。
- `/share/$token`：公开分享预览/只读信息、举报入口，不继承已登录应用外壳。
- 旧 `/agents` 按参数转到 `/bots`、新建 Bot 或 Bot 详情；`/team-bots` 转到 `/bots`。
- 旧 `/approvals`、`/memory`、`/reachability` 分别转到设置；`/responsibilities` 转到 Bots；`/group/new` 转到新对话。

## 9. 适合统一的页面模板与样稿优先级（建议）

| 模板 | 适用页面 | 视觉结构 |
| --- | --- | --- |
| A 对话协作 | 单 Bot 对话、群聊 | 导航 + 对话 + 按需上下文面板 |
| B 对象列表 | Bots、技能、知识库、连接器 | 标题/主操作 + 可选筛选 + 分组行列表 |
| C 对象详情/配置 | Bot 主详情/子页、账号详情、网关等 | 返回/标题 + 关键状态 + 配置分组 + 操作 |
| D 数据记录 | 用量、账单、订单、审计、运行 | 标题 + 筛选 + 列表/表格 + 分页/详情 |
| E 创作工作台 | Craft、Playground | 会话/编辑 + 实时输出/预览 |
| F 发现与预览 | 市场、组件画廊 | 分类/Tab + 资源预览 + 详情 |
| G 引导与授权 | 登录、引导、公司团队选择、绑定 | 聚焦单一操作的流程页 |

统一层：HeroUI 控件、Token、图标尺寸、字体层次、焦点与状态、圆角、间距。
差异层：阅读宽度、数据密度、编辑/预览分栏、面板是否常驻。

建议下一批样稿按代表性排序：
1. Bots 列表 + Bot 详情：验证身份、待办、活动和设置如何组合。
2. Craft：验证复杂分栏及输出空间。
3. 知识库详情：验证资源管理、上传和检索。
4. 设置/模型授权 + 用量：验证配置与交易数据两种密度。
5. 网关/运行详情：验证技术信息与异常状态。

本文件没有修改生产 UI、路由、权限或导航，也未生成新的页面效果图。

## 10. 路由文件索引（自动扫描）

以下是文件声明的路由 ID。`_authed` 和 `_app` 是无路径布局；末尾下划线用于路由嵌套控制，不是最终 URL 的字面字符。
组件列是静态 JSX 标记的入口线索，不是完整运行时组件树；兼容跳转单独标记。

| 路由 ID | 路由文件 | 页面骨架/组件线索 |
| --- | --- | --- |
| `/_authed/_app/agents/` | [index.tsx](../../app/src/routes/_authed/_app/agents/index.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/approvals` | [approvals.tsx](../../app/src/routes/_authed/_app/approvals.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/bot` | [bot.tsx](../../app/src/routes/_authed/_app/bot.tsx) | BotChat, DetailPanel, ComputerViewPanel, SidebarToggleBar, ComputerChatControls |
| `/_authed/_app/bots/$agentId/access` | [bots.$agentId.access.tsx](../../app/src/routes/_authed/_app/bots.$agentId.access.tsx) | BotSubpage, AccessSections |
| `/_authed/_app/bots/$agentId/approvals` | [bots.$agentId.approvals.tsx](../../app/src/routes/_authed/_app/bots.$agentId.approvals.tsx) | BotSubpage, BotApprovalRules |
| `/_authed/_app/bots/$agentId/datasets` | [bots.$agentId.datasets.tsx](../../app/src/routes/_authed/_app/bots.$agentId.datasets.tsx) | BotSubpage, ObservationDatasetsBody |
| `/_authed/_app/bots/$agentId/evaluations/$datasetId` | [bots.$agentId.evaluations.$datasetId.tsx](../../app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx) | ObservationDatasetDetailPage |
| `/_authed/_app/bots/$agentId/evaluations/experiment-comparisons` | [bots.$agentId.evaluations.experiment-comparisons.tsx](../../app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx) | ObservationExperimentComparisonPage |
| `/_authed/_app/bots/$agentId/evaluations/experiments/$experimentId/$executionId` | [bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx](../../app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx) | ObservationExperimentResultsPage |
| `/_authed/_app/bots/$agentId/evaluations` | [bots.$agentId.evaluations.tsx](../../app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx) | ObservationEvaluationsPage |
| `/_authed/_app/bots/$agentId/exports` | [bots.$agentId.exports.tsx](../../app/src/routes/_authed/_app/bots.$agentId.exports.tsx) | ObservationExportsPage |
| `/_authed/_app/bots/$agentId/` | [bots.$agentId.index.tsx](../../app/src/routes/_authed/_app/bots.$agentId.index.tsx) | PageShell, BotProfile, ManageSection, BotSettingsRows |
| `/_authed/_app/bots/$agentId/memory` | [bots.$agentId.memory.tsx](../../app/src/routes/_authed/_app/bots.$agentId.memory.tsx) | BotSubpage, MemorySources, ProactiveResearchSettings |
| `/_authed/_app/bots/$agentId/reach` | [bots.$agentId.reach.tsx](../../app/src/routes/_authed/_app/bots.$agentId.reach.tsx) | BotSubpage, ReachingYou |
| `/_authed/_app/bots/$agentId/responsibilities` | [bots.$agentId.responsibilities.tsx](../../app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx) | BotSubpage, BotResponsibilities |
| `/_authed/_app/bots/$agentId/routines` | [bots.$agentId.routines.tsx](../../app/src/routes/_authed/_app/bots.$agentId.routines.tsx) | BotSubpage, RoutinesList |
| `/_authed/_app/bots/$agentId/runs/$bindingId` | [bots.$agentId.runs.$bindingId.tsx](../../app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx) | ObservationRunDetailPage |
| `/_authed/_app/bots/$agentId/runs` | [bots.$agentId.runs.tsx](../../app/src/routes/_authed/_app/bots.$agentId.runs.tsx) | ObservationRunsPage |
| `/_authed/_app/bots/$agentId/setup` | [bots.$agentId.setup.tsx](../../app/src/routes/_authed/_app/bots.$agentId.setup.tsx) | BotSubpage, SetupSections |
| `/_authed/_app/bots/$agentId/sharing` | [bots.$agentId.sharing.tsx](../../app/src/routes/_authed/_app/bots.$agentId.sharing.tsx) | BotSubpage, SharingSections |
| `/_authed/_app/bots/` | [bots.index.tsx](../../app/src/routes/_authed/_app/bots.index.tsx) | PageShell, BotRoster, CreateAgentDialog |
| `/_authed/_app/channel/$channelId` | [$channelId.tsx](../../app/src/routes/_authed/_app/channel/$channelId.tsx) | DetailPanel, ComputerViewPanel, WorkshopPanel, AgentProfile, SidebarToggle |
| `/_authed/_app/channel/new` | [new.tsx](../../app/src/routes/_authed/_app/channel/new.tsx) | SidebarToggle, Combobox, ChannelAvatar, ConversationView |
| `/_authed/_app/craft/$sessionId` | [$sessionId.tsx](../../app/src/routes/_authed/_app/craft/$sessionId.tsx) | SessionSidebar, SandboxStatusIndicator, ChatPanel, OutputPanel |
| `/_authed/_app/craft/` | [index.tsx](../../app/src/routes/_authed/_app/craft/index.tsx) | SessionSidebar |
| `/_authed/_app/craft/tasks` | [tasks.tsx](../../app/src/routes/_authed/_app/craft/tasks.tsx) | SessionSidebar, DetailPanel, ScheduledTaskEditor, PageShell, PageSection |
| `/_authed/_app/group/$channelId` | [$channelId.tsx](../../app/src/routes/_authed/_app/group/$channelId.tsx) | SidebarToggle, ChannelAvatar, GroupPeopleButton, BotPausedBanner, GroupChat |
| `/_authed/_app/group/new` | [new.tsx](../../app/src/routes/_authed/_app/group/new.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/` | [index.tsx](../../app/src/routes/_authed/_app/index.tsx) | SidebarToggleBar, Composer, Carousel, CarouselPrevious, CarouselNext |
| `/_authed/_app/memory` | [memory.tsx](../../app/src/routes/_authed/_app/memory.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/reachability` | [reachability.tsx](../../app/src/routes/_authed/_app/reachability.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/responsibilities` | [responsibilities.tsx](../../app/src/routes/_authed/_app/responsibilities.tsx) | 兼容跳转/门禁 |
| `/_authed/_app/routines` | [routines.tsx](../../app/src/routes/_authed/_app/routines.tsx) | PageShell, RoutinesList |
| `/_authed/_app/skills` | [skills.tsx](../../app/src/routes/_authed/_app/skills.tsx) | DetailPanel, NewSkill, EditSkill, PageShell, PageSection |
| `/_authed/_app/team-bots` | [team-bots.tsx](../../app/src/routes/_authed/_app/team-bots.tsx) | 兼容跳转/门禁 |
| `/_authed/_app` | [_app.tsx](../../app/src/routes/_authed/_app.tsx) | SidebarShell, SkipToContent, AppSidebar, SelfHostBanner |
| `/_authed/admin/ai-observability` | [ai-observability.tsx](../../app/src/routes/_authed/admin/ai-observability.tsx) | ObservationAdminSummaryPage |
| `/_authed/admin/approvals` | [approvals.tsx](../../app/src/routes/_authed/admin/approvals.tsx) | PageShell, TeamApprovalSettings |
| `/_authed/admin/audit` | [audit.tsx](../../app/src/routes/_authed/admin/audit.tsx) | PageShell, PageSection, PageEmpty, Row, StartedBy |
| `/_authed/admin/billing` | [billing.tsx](../../app/src/routes/_authed/admin/billing.tsx) | PageShell, PageSection, AdminCreditGrantCard, BillingCleanupExecutionCard |
| `/_authed/admin/bot-services` | [bot-services.tsx](../../app/src/routes/_authed/admin/bot-services.tsx) | BotService, PageShell, RegisterDialog, EditDialog, PageSection |
| `/_authed/admin/boundaries` | [boundaries.tsx](../../app/src/routes/_authed/admin/boundaries.tsx) | PageShell, PageSection, Input, DryRunResult |
| `/_authed/admin/components/$name` | [$name.tsx](../../app/src/routes/_authed/admin/components/$name.tsx) | PageShell, ComponentDetail, Sheet, SettingsItemBackground, AdminComponentPreview |
| `/_authed/admin/components/` | [index.tsx](../../app/src/routes/_authed/admin/components/index.tsx) | PageShell, PageRowsSkeleton, SettingsItemBackground, AdminComponentPreview |
| `/_authed/admin/computers` | [computers.tsx](../../app/src/routes/_authed/admin/computers.tsx) | PageShell, HostFoldersSection, PageSection, PageEmpty, PageRows |
| `/_authed/admin/credentials` | [credentials.tsx](../../app/src/routes/_authed/admin/credentials.tsx) | PageShell, Input, PageSection, PageRowsSkeleton, PageEmpty |
| `/_authed/admin/enterprise` | [enterprise.tsx](../../app/src/routes/_authed/admin/enterprise.tsx) | PageShell, TableSkeleton, EnterpriseSections, PageSection, PageRows |
| `/_authed/admin/gateway` | [gateway.tsx](../../app/src/routes/_authed/admin/gateway.tsx) | PageShell, PageSection, PageRowsSkeleton, ReadinessView, Input |
| `/_authed/admin/identity-providers` | [identity-providers.tsx](../../app/src/routes/_authed/admin/identity-providers.tsx) | PageShell, PageSection, PageRowsSkeleton, PageEmpty, PageRows |
| `/_authed/admin/` | [index.tsx](../../app/src/routes/_authed/admin/index.tsx) | PageShell, PageSection, PageRows, StaggerItem, Separator |
| `/_authed/admin/knowledge/$kbId` | `knowledge.$kbId.tsx`（已随 ADR 0009 删除） | PageShell, AddDocument, UploadTasksPanel, DocumentList, RetrievalTest |
| `/_authed/admin/knowledge/` | `knowledge.index.tsx`（已随 ADR 0009 删除） | KnowledgeBase, PageShell, PageSection, PageRows, Separator |
| `/_authed/admin/learning` | [learning.tsx](../../app/src/routes/_authed/admin/learning.tsx) | Input, LearningSettings, PageShell, PageSection, Checkbox |
| `/_authed/admin/market` | [market.tsx](../../app/src/routes/_authed/admin/market.tsx) | Tab, SkillSubject, SidebarToggleBar, WbSecondaryButton, WbCardSkeleton |
| `/_authed/admin/model-catalog` | [model-catalog.tsx](../../app/src/routes/_authed/admin/model-catalog.tsx) | PageShell, PageSection, PageRowsSkeleton, PageEmpty, PageRows |
| `/_authed/admin/observability` | [observability.tsx](../../app/src/routes/_authed/admin/observability.tsx) | ObservationAdminSummaryPage |
| `/_authed/admin/people` | [people.tsx](../../app/src/routes/_authed/admin/people.tsx) | PageShell, PageSection, Input, PageRowsSkeleton, PageEmpty |
| `/_authed/admin/playground` | [playground.tsx](../../app/src/routes/_authed/admin/playground.tsx) | Draft, SidebarToggle, TextField, CodeField, OpenGenerativeUIActivityRenderer |
| `/_authed/admin/plugins/$key` | [$key.tsx](../../app/src/routes/_authed/admin/plugins/$key.tsx) | OpenDialog, PageShell, PageEmpty, PageSection, PageRows |
| `/_authed/admin/plugins/$key_/bots/$agentId` | [$key_.bots.$agentId.tsx](../../app/src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx) | SharedUseApproval, PageShell, PageEmpty, PageRows, Switch |
| `/_authed/admin/plugins/$key_/tools/$tool` | [$key_.tools.$tool.tsx](../../app/src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx) | PageShell, PageEmpty, PageSection, PageRows, Switch |
| `/_authed/admin/plugins/composio` | [composio.tsx](../../app/src/routes/_authed/admin/plugins/composio.tsx) | PageShell, PageSection, Input, PageRowsSkeleton, PageEmpty |
| `/_authed/admin/plugins/` | [index.tsx](../../app/src/routes/_authed/admin/plugins/index.tsx) | PageShell, PageRowsSkeleton, PageSection, PageEmpty, PageRows |
| `/_authed/admin/plugins/open-connector` | [open-connector.tsx](../../app/src/routes/_authed/admin/plugins/open-connector.tsx) | PageShell, PageSection, Input, PageRowsSkeleton, PageEmpty |
| `/_authed/admin` | [route.tsx](../../app/src/routes/_authed/admin/route.tsx) | SidebarShell, SkipToContent, AdminSidebar |
| `/_authed/admin/skills` | [skills.tsx](../../app/src/routes/_authed/admin/skills.tsx) | PageShell, PageSection, PageRowsSkeleton, PageEmpty, PageRows |
| `/_authed/onboarding` | [onboarding.tsx](../../app/src/routes/_authed/onboarding.tsx) | AgentOrb, Composer, ComputerPlaceholder, DesktopIllustration, RosterCard |
| `/_authed/settings/approvals` | [approvals.tsx](../../app/src/routes/_authed/settings/approvals.tsx) | PageShell, ApprovalSettings |
| `/_authed/settings/components-gallery/$name` | [$name.tsx](../../app/src/routes/_authed/settings/components-gallery/$name.tsx) | PageShell, SettingsItemBackground, ComponentPreview, PageSection, PageRows |
| `/_authed/settings/components-gallery/` | [index.tsx](../../app/src/routes/_authed/settings/components-gallery/index.tsx) | PageShell, PageRowsSkeleton, SettingsItemBackground, ComponentPreview |
| `/_authed/settings/connected-accounts/$key` | [$key.tsx](../../app/src/routes/_authed/settings/connected-accounts/$key.tsx) | PageShell, PageSection, PageRows, BrokeredAccountRow, PageEmpty |
| `/_authed/settings/connected-accounts/` | [index.tsx](../../app/src/routes/_authed/settings/connected-accounts/index.tsx) | Mark, PluginLogo, PageShell, PageRowsSkeleton, PageSection |
| `/_authed/settings/` | [index.tsx](../../app/src/routes/_authed/settings/index.tsx) | PageShell, PageSection, PageRows, Switch, LanguagePreference |
| `/_authed/settings/invoices` | [invoices.tsx](../../app/src/routes/_authed/settings/invoices.tsx) | PageShell, PageSection, InvoiceRow, BillingPager, InvoiceDialog |
| `/_authed/settings/memory` | [memory.tsx](../../app/src/routes/_authed/settings/memory.tsx) | PageShell, RememberFact, MemoryList |
| `/_authed/settings/model-access` | [model-access.tsx](../../app/src/routes/_authed/settings/model-access.tsx) | BindingPreview, AccessGrant, PageShell, ModelPicker, ModelAccessAuthorizations |
| `/_authed/settings/notifications` | [notifications.tsx](../../app/src/routes/_authed/settings/notifications.tsx) | PageShell, UpdateRoutingSection, NativeDevices, RecentDeliveries |
| `/_authed/settings/orders` | [orders.tsx](../../app/src/routes/_authed/settings/orders.tsx) | OrdersGrantsView |
| `/_authed/settings/passwords` | [passwords.tsx](../../app/src/routes/_authed/settings/passwords.tsx) | PageShell, PageSection, PageRowsSkeleton, PageEmpty, PageRows |
| `/_authed/settings` | [route.tsx](../../app/src/routes/_authed/settings/route.tsx) | SidebarShell, SkipToContent, SettingsSidebar |
| `/_authed/settings/usage` | [usage.tsx](../../app/src/routes/_authed/settings/usage.tsx) | UsageCreditsView |
| `/_authed/sign-in/$requestId` | [$requestId.tsx](../../app/src/routes/_authed/sign-in/$requestId.tsx) | PageShell, SignInForm |
| `/_authed/tenant/channels` | [channels.tsx](../../app/src/routes/_authed/tenant/channels.tsx) | PageShell, PageSection, TableSkeleton, PageEmpty, ChannelsSection |
| `/_authed/tenant/selection` | [selection.tsx](../../app/src/routes/_authed/tenant/selection.tsx) | PageShell, PageSection, TableSkeleton, PageEmpty, ScopeSelectors |
| `/_authed` | [_authed.tsx](../../app/src/routes/_authed.tsx) | CopilotProvider, AppHotkeys |
| `/share/$token` | [share.$token.tsx](../../app/src/routes/share.$token.tsx) | SharePage |
| `/sign` | [sign.tsx](../../app/src/routes/sign.tsx) | AuthProviderId, ProviderLogo, AgentOrb, Separator, Input |

扫描到 87 个 createFileRoute 声明（含布局、兼容入口，不等于独立业务页数）。
代码基点 HEAD：`203d0f0244b2f898218fa12027089c631e8448d9`，分析读取当前工作区内容而非仅该提交。
