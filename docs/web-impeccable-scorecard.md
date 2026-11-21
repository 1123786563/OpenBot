# OpenBot Web 逐页设计评分

评分基线为 `a23764974e532bdfd97fa3916e519a8719b21781`（`feat/openfuse-native-session`），评审日期为 2026 年 11 月 21 日。本版本尚未接入 Astryx，部署后可到达的四种外观均纳入评审。本轮范围为 Web。

两名独立评审员分别检查核心工作区与管理设置，第三名评审员独立采集浏览器和检测器证据。逐页分数采用 Nielsen 十项启发式，各项 0–4 分。两个瞬时交接页的效率项不适用。所有分数以源码为统一基线。表中列出扣分证据与复核任务。

| 路由树条目 | 计数 |
|---|---:|
| 直接渲染的页面入口 | 78 |
| 兼容跳转 | 16 |
| 共用布局 | 3 |
| 外观专属页面分派 | 1 |
| 合计 | 98 |

评分表共 **89 条**。除 78 个直接渲染入口，还评分了 6 个外观专属页面、1 个新建 Bot 的独立流程状态和 4 个同路由额外视图。管理和设置里承担不同角色任务的页面独立计分。

本轮评分为 **52.5%–75%**，达到 99% 的页面为 **0/89**。通常满分为 40，两个交接页的满分各为 36。任何适用项扣 1 分都会低于 99%，所以验收要求每个适用项都达到 4 分。百分比只用于展示，门槛以原始分判断。

| 观察 | 扣分影响 |
|---|---|
| 加载、空数据与故障容易长得一样 | 全部 89 条评分的状态可见性均扣分。多处首次查询直接返回空内容。 |
| 动作失败后缺少可用的下一步 | 全部 89 条评分的错误恢复均扣分。刷新、原始异常和缺少就地重试集中出现在会话、授权及设置。 |
| 高影响操作缺确认或后果说明 | 凭据撤销、SSO 删除、停止电脑、移除访问、删除技能和记忆均需逐动作核验。 |
| 专有名词和层级增加决策成本 | 员工需要知道该等谁、从哪继续。管理员需要在同一处看清授权主体、作用域、后果和生效结果。 |


## 核心工作区、认证与外观专属页面

每个分值依序对应 H1 状态可见、H2 用户语言、H3 用户控制、H4 一致性、H5 防错、H6 可识别、H7 效率、H8 简洁、H9 恢复、H10 帮助。适用项按 0–4 赋整数，源代码已有的行为记入分数。单向瞬时交接的 H7 无适用操作，注明 —，从分母剔除。分数仅随证据更新。

### 登录、会话和浏览器

| 页面 | H1…H10 | 原始分 | 扣分证据与复核任务 |
|---|---|---|---|
| `/sign` 登录 | 3 3 3 3 2 2 3 3 2 1 | 25/40 | 供应商显示打开中，SSO 必选时收起管理员入口。公司邮箱仅有占位提示，用户遇到无可用登陆方式时只读到让管理员设置。补可访问标签、组织登录恢复与联系路径。 [登录页](../app/src/routes/sign.tsx#L175) |
| `/onboarding` 首次使用 | 3 3 3 3 3 3 2 2 2 3 | 27/40 | 能力读取提供重试，完成错误可见，保存当前步骤失败只写控制台。演示、预约及权限说明会竞争首个有效任务。复测 Self-host/Team 两套分支和返回恢复。 [步骤保存与失败](../app/src/routes/_authed/onboarding.tsx#L285) |
| `/desktop-return` 浏览器交还桌面 | 2 3 2 3 2 3 — 4 1 1 | 21/36 | 服务端确认失败和成功都调用协议跳转，界面总说可关闭标签页。链接可重复尝试，未安装或协议被阻止时缺浏览器继续路径。 [回到桌面](../app/src/components/desktop/desktop-return.tsx#L45) |
| `/sign-in/$requestId` 为 Bot 登录网站 | 3 3 3 3 3 3 2 3 2 3 | 28/40 | 页面说明输入交给 Bot 浏览器，验证、接管和完成被分组。请求错误直接显示供应端句子，复测过期请求如何回到受阻会话。 [入口](../app/src/routes/_authed/sign-in/$requestId.tsx#L18) [登录操作](../app/src/components/passwords/sign-in-form.tsx#L87) |
| `/` 首页 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | 首次发送失败时恢复草稿，已有缓存透传。问话、建议、运行状态、探索 Bots 和商业版入口争夺首屏。验证首次用户能区分自动选 Bot 与点名，空 Bot 时可到达创建或诊断。 [首页](../app/src/routes/_authed/_app/index.tsx#L175) |
| `/channel/new` 新会话 | 2 3 3 3 3 3 3 3 2 2 | 27/40 | 已知收件人保持在链接里，区分权限失败和请求错误，空 roster 查询时页面为空。复杂度集中在选收件人、多 Bot、模型与命令。验证键盘选人、URL Bot 无权限时保留草稿并更换。 [新会话](../app/src/routes/_authed/_app/channel/new.tsx#L151) |
| `/start/$startId` 创建会话中 | 2 3 1 3 2 3 — 3 1 1 | 19/36 | 保留本条发送的视觉位置并显示 Picking a Bot，刷新时内存记录不存在会回首页。没有取消、明确解释或恢复入口。核验长等待、确认后后退与重新打开。 [过渡会话](../app/src/routes/_authed/_app/start.$startId.tsx#L71) |
| `/channel/$channelId` 单 Bot 会话 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | 有流式状态、重发和运行错误，通道初始查询返回空白，读取失败要求整页刷新。验证停、重试、上传、排队消息和恢复时可得知消息实际状态。 [会话容器](../app/src/routes/_authed/_app/channel/$channelId.tsx#L201) [会话重试](../app/src/components/channels/channel-chat.tsx#L1257) |
| `/group/$channelId` 多 Bot 会话 | 3 3 2 2 2 3 2 3 2 2 | 24/40 | 初始使用回退标题 Group 并先显示参与人控件，组消息和回答错误显示原始句子。实测多人时什么 Bot 在执行、错误影响范围，以及重复暂停横幅挤压。 [群组会话](../app/src/routes/_authed/_app/group/$channelId.tsx#L16) [消息](../app/src/components/channels/group-chat.tsx#L174) |
| `/bot` 默认或指定 Bot 快速会话 | 2 3 2 2 3 3 2 3 2 2 | 24/40 | Bot 等待空白，无 Bot 时只报空态，读失败要求刷新。同一产品里快速会话和已保存会话的差异需要验证，尤其是旧对话和电脑窗状态。 [Bot 快速会话](../app/src/routes/_authed/_app/bot.tsx#L81) |
| `/browser` 自己的浏览器 | 2 3 3 2 3 3 3 3 3 2 | 27/40 | 状态分支和部分重开操作可见，首次读取返回空白。复测角色不可用、启动、轮询失联保留上一画面时隔离离线提示，移动端操作返回。 [浏览器](../app/src/components/browser/browser-page.tsx#L80) |

### Bot、能力与例行任务

| 页面 | H1…H10 | 原始分 | 扣分证据与复核任务 |
|---|---|---|---|
| `/bots` Bot 列表 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 已有缓存保留，初读没有加载提示。列表同时承载待处理、本人、共享、隐藏及 Personal 的技能入口，长名单时须确认找到所属 Bot 的效率。 [列表](../app/src/components/bots/bot-roster.tsx#L52) |
| `/bots?new=true` 创建 Bot 状态 | 3 3 3 3 4 3 2 3 3 3 | 30/40 | 有分步校验、返回关闭、创建后进入档案和带描述的错误，Endpoint 和 Isolated 仍要求管理员理解部署选择。建议与 Bot 列表保留不同验收场景。 [创建步骤](../app/src/components/agents/new-bot-sheet.tsx#L420) |
| `/bots/$agentId` Bot 档案 | 2 3 3 3 3 3 2 2 2 2 | 25/40 | 角色、暂停与运行摘要使员工能认识 Bot，操作入口与设置行同时展开，个人与共享权限路径差异大。加载静默，无法访问与网络故障用同一消息。 [档案](../app/src/routes/_authed/_app/bots.$agentId.index.tsx#L13) [设置行](../app/src/components/bot-profile/settings-rows.tsx#L90) |
| `/bots/$agentId/access` 技能与访问 | 2 2 3 2 3 2 2 2 2 2 | 22/40 | Team 使用人授权和管理员授权并排，Personal 一页叠加权限、审批规则、Goals 和 check-ins。加载中多个区块消失，拥有方和授权来源难概览。 [Personal/Team](../app/src/routes/_authed/_app/bots.$agentId.access.tsx#L20) [权限控件](../app/src/components/bot-profile/access.tsx#L134) |
| `/bots/$agentId/activity` Bot 活动 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 明确当前、排程、按需与已完成，还有按身份开放的动作审计。加载空白，错误要求整页刷新，验证停止、取消和定位历史。 [活动](../app/src/components/bot-profile/activity.tsx#L328) |
| `/bots/$agentId/approvals` 审批规则 | 2 3 2 3 2 3 2 3 2 2 | 24/40 | 规则作用于当前 Bot 的区分存在，首次读取空白、错误显示原始消息。复测撤销后规则与正在等人审批的请求能否准确区分。 [规则](../app/src/components/approvals/bot-rules.tsx#L26) |
| `/bots/$agentId/memory` 记忆来源 | 2 2 3 3 3 2 2 2 2 2 | 23/40 | 来源同步和添加进度可见，初始列表安静，工具引用及设置类型学习成本高。验证能力获得/撤销、首次同步与权限失败。无 Memory 跳回 Bot Access。 [来源](../app/src/components/memory/sources.tsx#L120) |
| `/bots/$agentId/reach` 联系方式 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 渠道选择和短信确认有条件约束，首次状态空白，错误直接报接口消息。复测跨设备验证完成、过期、取消及禁用复原。 [联系方式](../app/src/components/delivery/reaching-you.tsx#L185) |
| `/bots/$agentId/responsibilities` Goals | 2 2 2 3 3 2 2 3 2 2 | 23/40 | Goals 与产品术语 Responsibility 需通过实例解释。加载无反馈，待办成果、归属和后续动作的扫描依赖各行。 [Goals](../app/src/components/responsibilities/responsibilities.tsx#L40) |
| `/bots/$agentId/routines` Bot 的例行任务 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 有运行、运行历史、删除确认，初始空白、运行警报位置远离动作。当前 Bot 与全局页的上下文须靠可见标题和返回路径。 [例行任务操作](../app/src/components/routines/routines-list.tsx#L229) |
| `/bots/$agentId/setup` Bot 设置 | 3 2 3 3 3 2 2 2 3 2 | 25/40 | 操作反馈和局部校验存在，Endpoint、隔离与电脑接续等操作并列，建议验证管理员能解释本次更改影响范围并从失败返回。 [Bot 设置](../app/src/components/bot-profile/setup.tsx#L234) |
| `/bots/$agentId/sharing` 分享 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 分享/分配对话框各自显示错误，首次加载留空，团队分配还需知道组名。需用不同工作区角色验证分享预览与撤销后的可见范围。 [分享](../app/src/components/bot-profile/sharing.tsx#L69) |
| `/capabilities/skills` 技能列表和编辑面板 | 2 3 2 3 1 3 2 3 2 3 | 24/40 | 用斜杠语法解释如何调用，列表和编辑同地址。菜单删除即执行且没有撤销，行按钮缺文本类可访问名。Wi-Fi 失联时列表报错要求整页刷新。 [技能](../app/src/routes/_authed/_app/capabilities.skills.tsx#L125) |
| `/capabilities/memory` 记忆列表 | 2 3 2 3 2 3 2 2 2 2 | 23/40 | 编辑、确认、Forget 和使用开关平铺，Forget 直接提交。初始列表为空白，适用性因部署而异。验证可预览哪些 Bot 会用这段记忆。 [记忆操作](../app/src/components/memory/memories.tsx#L237) |
| `/routines` 全部例行任务 | 2 3 3 3 3 3 2 3 2 3 | 27/40 | 明确会话与新建双入口。编辑仅从会话处理，页面的历史、开关、立即运行和删除全部集中在同一行，长列表和错误定位需查。 [全局 Routines](../app/src/routes/_authed/_app/routines.tsx#L22) [行操作](../app/src/components/routines/routines-list.tsx#L435) |
| `/routines/new` 创建例行任务 | 3 3 3 3 4 3 2 2 3 3 | 29/40 | 表单约束和保存状态明确；时区、日期和 Bot 内容在同页聚集。需验证切换频率时字段变化和结果预览，尤其跨时区/夏令时。 [排程表单](../app/src/components/routines/new-routine-page.tsx#L280) |

### 连接

| 页面 | H1…H10 | 原始分 | 扣分证据与复核任务 |
|---|---|---|---|
| `/connections` 连接清单 | 2 3 3 3 3 3 3 3 2 2 | 27/40 | 搜索带可访问名称、无匹配和 OAuth 回执，多个依赖任一等待都让关键区域空白，账号与应用分组须通过状态说明。 [连接目录](../app/src/routes/_authed/_app/connections.index.tsx#L401) |
| `/connections/$key` Team 应用及动作授权回执 | 2 2 3 3 3 2 2 2 3 2 | 24/40 | 公开授权回执及相关动作，第一次加载占位弱。共享/个人、账号、授权粒度并存，验证确认授权前范围、回调失败和已断开时的主操作。 [应用详情](../app/src/routes/_authed/_app/connections.$key.tsx#L350) |
| `/connections/$key` Personal 应用 | 2 2 3 2 3 2 2 2 3 2 | 23/40 | 应用启用、使用账号、工具和 Bot 授权合并为长页，存在读取失败状态，权限切换对认知要求高。验证长工具名、撤销效果与授权分组。 [Personal 应用](../app/src/components/manage/plugin-page.tsx#L595) |
| `/connections/github` GitHub 身份 | 2 2 3 3 3 2 2 2 2 2 | 23/40 | 同一页含身份、来源、作为本人运行的工具；连接查询尚未得知答案时，`connected` 回退为空数组并可能表现为 Not connected。验证加载误读及重新绑定入口。 [身份详情](../app/src/components/connections/identity-connection-page.tsx#L89) |
| `/connections/slack` Slack 身份 | 3 3 3 3 3 3 2 3 2 2 | 27/40 | 单渠道身份路径和回调提示简短，复测身份占用、不同工作区与断开后 Bot 的能力是否清晰。 [渠道身份](../app/src/components/connections/identity-connection-page.tsx#L73) |
| `/connections/routines` 内置 Routines 详情 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | 说明内置应用并引导至排程，读失败与无计划在摘要区域体现，须验证无需额外连接是明确状态。 [内置连接](../app/src/components/routines/routines-connection-page.tsx#L39) |
| `/connections/browse/arcade` Arcade 目录 | 3 3 3 3 3 3 3 3 2 2 | 28/40 | 有搜索、加载占位、逐行连接反馈和回退。错误展示供应商消息，首次获取插件设置失败要求全页刷新。实际 provider 不匹配或 Team 会跳转。 [目录入口](../app/src/components/manage/broker-directory-page.tsx#L27) [目录状态](../app/src/components/plugins/broker-directory.tsx#L280) |
| `/connections/browse/composio` Composio 目录 | 3 3 3 3 3 3 3 3 2 2 | 28/40 | 和 Arcade 同一目录实现。此分支另验证 OAuth 弹窗、API key 及取消后的逐行反馈。缺提供商 key 时个人用户需知道向谁请求。 [目录](../app/src/components/plugins/broker-directory.tsx#L303) |

### 外观专属 Web 页面

| 页面 | H1…H10 | 原始分 | 扣分证据与复核任务 |
|---|---|---|---|
| `/s/tasks` OpenDuet | 2 3 3 2 3 3 2 2 2 2 | 24/40 | 任务按待办状态分组，混合审批、Goals、Routines。Active/Up next 使用 tab 角色和普通按钮点击，组件无方向键或 roving tabindex。 [Tasks](../app/src/skins/openduet/tasks-screen.tsx#L86) |
| `/s/routines` OpenDots | 2 3 3 2 3 3 2 3 2 3 | 26/40 | 主操作清晰，嵌入全局列表和它的静默加载，与默认外观标题层级及返回有差异。 [OpenDots Routines](../app/src/skins/opendots/screens.tsx#L53) |
| `/s/memories` OpenDots | 2 3 2 2 2 3 2 3 2 2 | 23/40 | 包装后仍继承单击 Forget 和静默加载，能力等待导致整个页面空白。复测 Personal 能力回退。 [OpenDots Memories](../app/src/skins/opendots/screens.tsx#L68) |
| `/s/activity` OpenFuse | 2 3 3 2 3 3 2 3 2 2 | 25/40 | 继承 Bot 活动反馈和审计入口，空 Bot 有独立态。聚焦当前 Bot 的导航必须在长耗时切换后仍保持明确。 [OpenFuse Activity](../app/src/skins/openmuse/screens/activity.tsx#L11) |
| `/s/ideas` OpenFuse | 2 2 3 2 3 2 2 3 2 2 | 23/40 | Ideas 含 Bot 等待人处理及主动研究设置，标题无法直接提示读取、决策和设置之间的关系。 [OpenFuse Ideas](../app/src/skins/openmuse/screens/ideas.tsx#L16) |
| `/s/goals` OpenFuse | 2 2 2 2 3 2 2 2 2 2 | 21/40 | 一列堆叠 Routines 与 Bot Responsibilities，多个域概念在同一个标签内出现。等待与错误继承列表，需要检查移动视口重复标题、滚动、首个动作。 [OpenFuse Goals](../app/src/skins/openmuse/screens/goals.tsx#L13) |

### 兼容地址与路由边界

| 地址 | 预期检查 |
|---|---|
| `/agents/` | 无参数进 `/bots`。`new=true` 优先，`agent` 指定档案。 |
| `/team-bots` | 进 `/bots`。 |
| `/group/new` | 进 `/channel/new`，从 To 选多个 Bot。 |
| `/approvals` | 进 `/settings/approvals`。 |
| `/memory` | 进 `/capabilities/memory`，能力不可用时经守卫进 `/bots`。 |
| `/skills` | 进 `/capabilities/skills`，保留 new/edit。 |
| `/reachability` | 进 `/settings/notifications`。 |
| `/responsibilities` | 进 `/bots`，该版本没有该全局独立页面。 |
| `/capabilities` | 父级 Outlet。 |
| `/capabilities/` | Index 进 `/capabilities/skills`。 |
| `/connections/$key/bots/$agentId` | 进对应 `/connections/$key`。 |
| `/connections/$key/tools/$tool` | 进对应 `/connections/$key`。 |
| `/s/$screen` | 当前外观无对应页面时回首页，验证旧链接给人可理解的反馈。 |
| 未知路由 | 根级回首页，再根据会话进入登录或上手。缺失链接的用户得不到原因或明确回路。 |
| 外层布局 | `__root`、`_authed` 和 `_authed/_app` 影响全站焦点与导航。各外观下验证从受保护链接登入、未完成上手，以及返回原任务。 |

### 核心场景

新员工从受保护链接登录，从自动路由结果知道是哪位 Bot 接手，遇到发送失败保留原文和附件。员工操作中断时，从批准通知进入原会话，读懂审批作用范围并继续。IT 管理员能预览 Bot 可用的账户、工具、规则、团队、数据权限及修改后果。键盘和读屏使用者能完成选 Bot、查看执行进度、恢复失败并回到最近工作。视觉特异性来自 Bot 身份、同事式交接、电脑与工作记录。管理操作的风格应通过一致的行结构、状态和错误提示表达，优先降低一页上同时要做的决策数。

### 严重度和体验落点

- **P1 · 删除技能、遗忘记忆。** 压力测试者误点相邻行时，二者提交破坏性动作。删除技能应针对具体对象确认或允许撤销。忘记记忆还需要说明已发生的会话是否受影响。 [技能删除](../app/src/routes/_authed/_app/capabilities.skills.tsx#L166) [忘记记忆](../app/src/components/memory/memories.tsx#L255)
- **P1 · 登录与回调恢复。** 新员工登录时需要知道哪个邮箱该填，以及失败后如何回到原任务。桌面回调结果未知时引导关闭标签页会让用户猜测连接是否成功。审查角色和组织 SSO、第三方取消、协议未安装、网页版继续走查。 [登录](../app/src/routes/sign.tsx#L242) [桌面回调](../app/src/components/desktop/desktop-return.tsx#L49)
- **P1 · 首条消息准备中。** 首次用户应该从「正在选择哪位 Bot／正在建会话／已发送」理解工作真正开始的时间。现在刷新过渡页会悄然回首页。强制断网和回执晚到时验证是否能恢复草稿、防止重复发送。 [过渡](../app/src/routes/_authed/_app/start.$startId.tsx#L71)
- **P2 · 权限审查的认知负担。** Personal Access 的 Skills、应用权限、审批规则、Goals、check-ins 是至少五个意图。按检查表有明确的分块与一次一事两项风险，显示状态、就地解释并将低频设置逐层展开，保留 Team 的技术边界。 [Access](../app/src/routes/_authed/_app/bots.$agentId.access.tsx#L34)
- **P2 · OpenDuet 标签键盘缺口。** 熟练用户和键盘使用者在 Active / Up next 两者之间找切换控制。当前实现用自绘 tabs，缺箭头键和 roving tabindex。保留两项层级，以共享语义组件和真实键盘测试覆盖。 [Tabs](../app/src/skins/openduet/tasks-screen.tsx#L108)

保留三种已有行为。首页在选 Bot 失败时还原输入，分组会话更换会话时重新挂载以防串历史，新建 Bot 可通过 URL 表达且关闭后保留列表。视觉改动应重视员工看到「我的工作有人接手」的时刻和没有权限／无法启动时的退出方式。对于 IT 管理员，重点是看懂谁授予、用谁的账号以及现在撤销会影响谁。

待方案讨论的取舍有两项。Bot 档案是否作为所有设置的返回锚点，还是保留可直接进入一个跨 Bot 的权限控制台？四个外观共享全部工作流入口，还是让 OpenDuet／OpenDots／OpenFuse 继续拥有仅在各自外观出现的状态？


## 管理与设置

| 页面 | 十项分（各 0–4） | 合计 | 现状依据 |
|---|---|---:|---|
| `/admin/` | 3 · 3 · 3 · 3 · 3 · 4 · 2 · 3 · 2 · 2 | 28/40 · 70% | 任务问题分区及整行链接有方向感。第二组并列七项，侧栏与正文重复，常用入口没有检索；描述是基础导航帮助。 [源码](../app/src/routes/_authed/admin/index.tsx#L51) |
| `/admin/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | 团队设置、动作、规则和共享账户聚在一页。待加载为空，开关与撤销缺少逐项影响提示，失败读原始异常。 [源码](../app/src/components/approvals/team-settings.tsx#L103) |
| `/admin/approvals/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 自然语言示例、预览与回测让规则可辨认。保存前能检查且可返回；长任务没有跨页草稿，异步检查与保存错误直接读异常。 [源码](../app/src/routes/_authed/admin/approvals_.describe.tsx#L91) |
| `/admin/approvals/guidance` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | 用措辞示例、检查与回测解释作用，删除需要确认；初读无提示，检查和保存失败多为服务端文本。 [源码](../app/src/routes/_authed/admin/approvals_.guidance.tsx#L96) |
| `/admin/audit` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | 有快捷筛选、搜索、清空 Bot 和导出，审计与命令记录同页。初读内容空白，查询或导出失败的原位恢复不足。 [源码](../app/src/components/manage/audit-page.tsx#L274) |
| `/admin/boundaries` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | 写明试运行与默认行为，规则行可达。初读缺进度，部署级试运行开关直接保存，缺切换前的控制范围提示与失败重试。 [源码](../app/src/routes/_authed/admin/boundaries.tsx#L82) |
| `/admin/boundaries/$index` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | 最近拦截、修改和确认删除一起呈现。用于深链接的是规则位置而非稳定规则 ID，列表变动后应验证目标，最近拦截加载为空。 [源码](../app/src/routes/_authed/admin/boundaries_.$index.tsx#L112) |
| `/admin/boundaries/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 模板与自然语言降低上手成本，保存由规则检查保护。高级表达式增加阅读负担，切换方式、离开后草稿恢复仍待验证。 [源码](../app/src/routes/_authed/admin/boundaries_.new.tsx#L214) |
| `/admin/components/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 图样和发布可帮助识别，现有列表按组件预览展示。初读空白，规模化时缺快速搜索，读取错误靠刷新。 [源码](../app/src/routes/_authed/admin/components/index.tsx#L28) |
| `/admin/components/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | 预览、发布状态、模型描述、Bot 授权和数据读取权限均有解释。首次加载整页空白，立即发布开关缺紧邻影响范围与失败恢复。 [源码](../app/src/routes/_authed/admin/components/$name.tsx#L291) |
| `/admin/computers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 重置、升级有影响确认，控制台可识别所属对象；同屏还叠加休眠和网络策略，队列与大规模查找有限，列表失败没有原位重试。 [源码](../app/src/components/manage/computers-page.tsx#L205) |
| `/admin/credentials` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | 分辨活动和已撤销凭据，撤销直接提交且同屏未见撤销处理错误。首次加载为空，名称与类型包含存储术语。 [源码](../app/src/components/manage/credentials-page.tsx#L56) |
| `/admin/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 字段校验与轮换说明在旁，能返回且保存有状态。密钥作用范围仍需要从上下文推断，失败缺提供者相关的恢复步骤。 [源码](../app/src/components/manage/new-credential-page.tsx#L72) |
| `/admin/identity-providers` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | 空态指向机构元数据，注册弹窗支持 SAML/OIDC。删除直接触发，列表待加载空白，SSO 失败后只提示刷新，移除前缺域和登录影响。 [源码](../app/src/routes/_authed/admin/identity-providers.tsx#L121) |
| `/admin/learning` | 2 · 2 · 3 · 3 · 3 · 3 · 2 · 2 · 3 · 2 | 25/40 · 62.5% | 有运行诊断和具体空态，单页承担配置、后台状态、提议、运行历史与发布技能。容器 ID 和修订版要求额外背景，部分查询初读为空。 [源码](../app/src/routes/_authed/admin/learning.tsx#L245) |
| `/admin/people` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | 姓名和邮箱可搜，同时显示管理员、身份与访问状态。停止电脑、移除访问和修改管理员权直接提交，自身和预设管理员有保护但他人操作缺具体后果确认。 [源码](../app/src/routes/_authed/admin/people.tsx#L125) |
| `/admin/permissions` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | 组织、角色、组作用域有说明，覆盖规则位于二级弹窗。开关即写入，计算后的有效权限与受影响范围需另查，失败对照原位有限。 [源码](../app/src/components/admin/controls/capabilities-section.tsx#L48) |
| `/admin/permissions/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 自然语言翻译先预览，代码说明允许回看和拒绝空变化。仍需要执行者核对组织/角色/组优先级，切走后草稿及错误恢复弱。 [源码](../app/src/routes/_authed/admin/permissions_.describe.tsx#L85) |
| `/admin/playground` | 3 · 2 · 3 · 3 · 2 · 3 · 3 · 2 · 3 · 2 | 26/40 · 65% | 边写边预览，JSON 解析错误定位字段，删除有确认。编辑、发布、草稿、预览和清单并列，离开时未见未保存变更处理，触屏和键盘长表单待测。 [源码](../app/src/routes/_authed/admin/playground.tsx#L182) |
| `/admin/plugins/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 已连接和可连接按任务分组，工具失败靠近行。首读为空，MCP allowlist 在同页与插件发现竞争，目录入口可用性依赖 broker。 [源码](../app/src/components/manage/plugins-list-page.tsx#L163) |
| `/admin/plugins/$key` | 3 · 2 · 3 · 3 · 3 · 3 · 2 · 2 · 3 · 3 | 27/40 · 67.5% | 区分 OAuth 客户端、个人/团队账号与工具授权，缺回调环境有具体指导。组件仍把连通性、账号归属、工具、Bot、已失效授权及多个弹窗串成一页。 [源码](../app/src/components/manage/plugin-page.tsx#L653) |
| `/admin/plugins/$key/bots/$agentId` | 3 · 2 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 28/40 · 70% | 支持工具搜索、读/写分组、批量进度和共享账户确认。工具技术名加权限影响造成密度，初读不显示进度，故障多提原始异常。 [源码](../app/src/components/manage/plugin-bot-page.tsx#L429) |
| `/admin/plugins/$key/tools/$tool` | 2 · 2 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | 呈现作用、逐 Bot 授权与凭据缺失，但原始操作名及 AGENT_TOOL_TOKEN 进入主阅读路径。开关即保存，首读空白，长 Bot 列表缺快找。 [源码](../app/src/components/manage/plugin-tool-page.tsx#L142) |
| `/admin/plugins/arcade` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 | 29/40 · 72.5% | 有搜索、加载占位、逐项连接状态和加载失败，目录前置配置失败需刷新。评分适用于 Arcade 启用；验证无 broker 及拒绝同意回程。 [源码](../app/src/components/plugins/broker-directory.tsx#L259) |
| `/admin/plugins/composio` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 | 29/40 · 72.5% | 同一目录骨架，检索、目录加载和逐项连接进度可见。评分适用于 Composio 启用；需要实际读取同意返回的错误、重试和焦点。 [源码](../app/src/components/plugins/broker-directory.tsx#L259) |
| `/admin/proactive` | 2 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 2 | 27/40 · 67.5% | 周期过滤、聚合和每日上限弹窗可读。首读及指标等待不显示，开关和指标共页，失败常停在文字。 [源码](../app/src/routes/_authed/admin/proactive.tsx#L123) |
| `/admin/providers` | 2 · 3 · 3 · 3 · 2 · 3 · 3 · 3 · 2 · 3 | 27/40 · 67.5% | 连接、会话选择、允许模型、用量分节并可搜索；待加载为空，模型更改前缺同屏的受影响 Bot 及现有默认项；依赖可用模型配置。 [源码](../app/src/components/admin/controls/model-sections.tsx#L80) |
| `/admin/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 技能列表和添加入口清楚，空态说明下一步。待加载空白，长列表缺过滤，缺让管理员识别哪些 Bot 还未提供某技能。 [源码](../app/src/components/manage/skills-page.tsx#L62) |
| `/admin/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | Bot 开关、编辑和删除确认分组，明确删除影响。首读空白，开关与编辑使用不同保存方式，切走编辑未见保留草稿。 [源码](../app/src/components/manage/skill-page.tsx#L117) |
| `/admin/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 表单说明保存后设置提供它的 Bot，支持返回和校验。无草稿恢复，错误后需要用户识别字段及下一步。 [源码](../app/src/components/manage/new-skill-page.tsx#L28) |
| `/admin/what-if` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | 自然语言与结构化检查各有入口，给出场景示例和结果，适合管理员试查。术语词表失败与检查失败的恢复有限，长复合场景待验。 [源码](../app/src/routes/_authed/admin/what-if.tsx#L128) |
| `/settings/` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | 个人信息、外观及快捷键分组明确，姓名与指示有局部编辑。账户及外观状态分处多节，快去某设置的搜索弱，设置失败的恢复方式因组件而异。 [源码](../app/src/routes/_authed/settings/index.tsx#L44) |
| `/settings/activity` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | 个人措辞对齐 Bot Activity，搜索、过滤、导出有用。初读空白，读不到数据和导出失败需更直接的恢复。 [源码](../app/src/components/manage/audit-page.tsx#L274) |
| `/settings/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | 区分聊天问询、自动审查、所有 Bot 的规则及共享 Bot 同意。初读空白，几个相邻开关作用域不容易比较，失败集中成一个提示。 [源码](../app/src/components/approvals/settings.tsx#L91) |
| `/settings/browsers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 信息披露将 Recorder、浏览器与 Learning 串起来。需跨浏览器扩展和此页完成连接，失败、失效与恢复正是证据缺口。 [源码](../app/src/components/settings/browsers/browser-sections.tsx#L21) |
| `/settings/components-gallery/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | Personal/Team 的空态语义正确，预览帮助识别。待加载为空，组件多时缺过滤和根据信息挑选的帮助。 [源码](../app/src/routes/_authed/settings/components-gallery/index.tsx#L63) |
| `/settings/components-gallery/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 有预览、详情、返回及缺失状态。初读整页不渲染，错误靠刷新，页面帮助没解释何时向 Bot 请求该组件。 [源码](../app/src/routes/_authed/settings/components-gallery/$name.tsx#L72) |
| `/settings/computer` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 个人措辞区分己有浏览器和 Bot 所属浏览器，清除或重置有确认；本地目录与版本依赖桌面，列表失败恢复薄弱。 [源码](../app/src/components/manage/computers-page.tsx#L205) |
| `/settings/credentials` | 2 · 3 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 23/40 · 57.5% | 入口叫 Keys，节叫 Saved credentials；按提供者显示令牌元数据。撤销无确认和明确失败反馈，首次加载不显示。 [源码](../app/src/components/manage/credentials-page.tsx#L56) |
| `/settings/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 提供者示例、输入验证和返回路径清楚，提醒轮换次序。普通用户仍需知道去哪拿有效的键和哪些 Bot 受影响。 [源码](../app/src/components/manage/new-credential-page.tsx#L72) |
| `/settings/learning` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | 审阅提议和共享可见性有分节，空态和解释随版本变。两个组件同时待加载时内容空白，自动批准和技能分享影响需实测。 [源码](../app/src/routes/_authed/settings/learning.tsx#L16) |
| `/settings/notifications` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 按全局 check-ins、路由、设备和投递分节。多数等待无提示，移除设备直接执行，路由配置失败与投递失败缺一致的原位恢复。 [源码](../app/src/routes/_authed/settings/notifications.tsx#L15) |
| `/settings/passwords` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | 清楚区分关闭、无保存、最后使用时间。单图标直接永久删除，等待为空，行内缺失败恢复。 [源码](../app/src/components/passwords/passwords-page.tsx#L39) |
| `/settings/setup` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 分项列出状态、重查并衔接下一环，有明确角色差异。初读列表没反馈，环境项的修复和重进路径待实测。 [源码](../app/src/components/setup/setup-checklist.tsx#L63) |
| `/settings/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 复用技能列表，空态指向添加；个人版需清楚技能和自动学习之间怎么找，长清单缺搜索/筛选。 [源码](../app/src/components/manage/skills-page.tsx#L62) |
| `/settings/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | 复用技能详情，有明确删除确认和授予对象。加载空白，保存两套方式，表单导航丢草稿待复测。 [源码](../app/src/components/manage/skill-page.tsx#L117) |
| `/settings/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | 复用技能表单并在保存后转到详情。粘贴长指令及跳离重进的保留行为需要验证，缺就地恢复。 [源码](../app/src/components/manage/new-skill-page.tsx#L28) |
| `/settings/this-computer` | 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 26/40 · 65% | 浏览器显示桌面专用提示，桌面 WebView 有运行、版本、更新、记录与软件信息。浏览器提示无下一步入口，桌面可能遇到进度或操作失败；桌面原生壳超出范围。 [源码](../app/src/routes/_authed/settings/this-computer.tsx#L82) |

### 共享壳与兼容入口

| 路由树条目 | 目的地或职责 |
|---|---|
| `/admin` | 共享侧栏和授权守卫。Team 管理员在此壳内打开 `/admin/`，普通成员跳回首页。Personal 迁移到设置或 Connections。 [守卫](../app/src/routes/_authed/admin/route.tsx#L9) |
| `/settings` | 共享设置侧栏和 Outlet。Overview 是 `/settings/`。 [布局](../app/src/routes/_authed/settings/route.tsx#L6) |
| `/admin/enterprise` | Team 管理员进入 Admin，Personal 走父路由迁移策略。 [跳转](../app/src/routes/_authed/admin/enterprise.tsx#L8) |
| `/settings/memory` | 进入 `/capabilities/memory`，由目的地的角色和部署能力处理降级。 [跳转](../app/src/routes/_authed/settings/memory.tsx#L4) |
| `/settings/connected-accounts/` | 进入 `/connections`，保留已声明的回调搜索参数。 [跳转](../app/src/routes/_authed/settings/connected-accounts/index.tsx#L13) |
| `/settings/connected-accounts/$key` | 进入 `/connections/$key`，保留已声明的回调搜索参数。 [跳转](../app/src/routes/_authed/settings/connected-accounts/$key.tsx#L10) |
| `/settings/plugins/$` | Personal 进入相应 Connections 地址，Team 回到 Settings。 [跳转](../app/src/routes/_authed/settings/_personal/plugins.$.tsx#L5) |

Personal 专属设置由无路径父路由 `_personal` 守卫。它负责拒绝 Team 打开个人 Activity、Computer、Keys 和 Skills。Admin 的同类地址在 Personal 下迁移至设置，Plugins 地址迁移至 Connections，其他地址回到 Settings。Arcade/Composio 只有当前启用的 broker 能打开，设置页的 This computer 在普通浏览器显示桌面提示。 [Personal 守卫](../app/src/routes/_authed/settings/_personal.tsx#L12) [映射](../app/src/lib/manage-paths.ts#L98)

### 人物走查与风险

- IT Owner 在 Admin 首页可以按“谁能进”“Bot 能访问什么”找到入口。Access、SSO、Keys 改动影响其他人和 Bot，列表直接提交使“决定前看影响，提交中知道状态，失败后在同一行恢复”成为优先场景。
- 高频管理员从 Audit 按 Bot 筛选并导出比平铺清单高效。转向 Permissions、Boundaries 和 Approvals 时要记住三类范围，修改前后没有一个贯穿的有效策略摘要。What if 是可复用的验证入口，重要变更应带动作和对象到这里。
- 键盘及屏幕阅读器使用者能从源码看到大量命名开关与告警角色，加载返回 null 会留下大段静默。需要使用真实键盘验证弹窗焦点回归、删除流程、窄屏滚动后可达性以及成功与失败朗读。
- Personal 用户处理 Recorder、Learning 和自己的浏览器时要跨扩展、Web、桌面。闭环需要在当前界面表明是否连接、记录属于谁、失效后在哪重连。Settings 与 Admin 的连接文案应按领域术语区分连接、外部账户、插件和授权。

## 浏览器与检测证据

独立设计评审取样了 11 个核心页面或状态，各以 1440×900 浅色和 390×844 深色打开。另以 1280×800 浅色检查 Team Admin 首页、People 读取失败和 Personal General。核心页各用独立浏览器会话。管理页用单独预览标签页。访问用固定版本的隔离应用，API 由测试夹具部分提供。

- 移动端登录将公司邮箱用途留在占位文字里，失败时缺直接帮助入口。首次使用底部的 Get started 保持可达。
- Team 成员首页的未共享 Bot 区域有解释，无下一步。窄屏 Bots 清单中，两个高空态把隐藏和管理路径推到首屏以下。
- 单 Bot 会话读取旧消息和语音历史分别失败时，编辑栏仍可用。两条并列消息一条要求刷新，另一条说明可以继续。初步键盘检查能见到编辑栏操作焦点。
- Team Admin 首页的侧栏与正文分区提供相似路径。People 读取失败仍显示搜索，但只给重载提示。Personal General 的相邻偏好采用不同的读取、失败与恢复反馈。

独立技术评审按 95 个规范化 URL 模式各尝试两次，涵盖 98 个路由条目。桌面为 1440×900 浅色，窄屏为 390×844 深色。主要使用 Team 管理员和 Personal 夹具，也抽查了 Team 成员、未登录和未完成上手状态。

| 首次访问结果 | 桌面浅色 | 窄屏深色 |
|---|---:|---:|
| 留在原路径并渲染，未观察到夹具请求失败 | 41 | 29 |
| 留在原路径并渲染，部分夹具请求失败 | 32 | 42 |
| 跳转到其他路径 | 20 | 20 |
| 遇到错误信号 | 2 | 2 |
| 等待期内无可见正文 | 0 | 2 |
| 合计 | 95 | 95 |

`/bot` 缺对应的模拟 AG-UI agent，两个视口都进入错误边界。Playground 的 sandbox 错误来自夹具初始化。窄屏 Passwords 和 Setup 在并行走查中超时留空，桌面有渲染结果。旧书签、示例 ID 无效和能力不适用都可触发跳转；20 次重定向的观测包含这些状态。390 像素视口没有测得文档级水平溢出。嵌套滚动、触控目标与焦点覆盖仍待专门复核。

Impeccable 静态检测扫描 458 个候选文件，报告 0 条主要问题和 1 条动效提示，位置在 [Bot 头像](../app/src/components/channels/avatar.tsx#L185)。等待 React 渲染后，检测器成功注入独立浏览器中的 10 个截图状态。首页、创建会话、General 和登录有检测项。People 样本处于接口读取失败态。直接 URL 扫描有首屏时序限制，记录为辅助信号。检测结果未计入十项分数。

真实 OAuth、真实 Bot 流式执行、授权写入、全角色和外观组合、完整键盘与读屏验收仍待复核。隔离服务、检测服务与浏览器会话均已关闭。
