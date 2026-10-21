# 个人与小型企业 Agent 产品：官方资料对比

- 检索日期：2026-10-16（Asia/Shanghai）
- 研究范围：Manus、Lindy、Zapier Agents、Claude Cowork、Notion Custom Agents。只采用厂商官方产品页、帮助中心、文档或公告；营销示例按“厂商描述”记录，不视为独立实测。
- 价格仅用来说明计费结构和计划门槛，不在此横向比较具体金额；各厂商计划、用量单位和地区条件不同。

## 摘要

1. 这组产品大致分为“个人通用任务代理”（Manus、Claude Cowork）和“围绕现有业务工具运转的自动化/团队代理”（Lindy、Zapier Agents、Notion Custom Agents）。后者更明确提供定时或事件触发、团队共享/管理，但要求用户已有相应工作区与连接器。
2. 上手路径以自然语言起步逐渐成为常见设计：Manus 可描述自动化；Lindy 宣称可用 prompt 建 Agent；Notion 可由 AI 草拟说明、触发器及访问范围；Zapier Agents 支持自定义说明或模板。厂商“几分钟”之类表述是营销承诺，未做实测。
3. 审批粒度差异明显。Manus 可在发送/发布前设审批；Lindy 宣称有外部影响的动作由具名审批人放行；Notion 对 Calendar 工具能配置操作确认，另有访问范围、日志和可逆性；本轮 Zapier Agents 官方证据清楚说明测试/发布，但未核实 Agents 内通用动作审批机制；Claude Cowork 的 Anthropic 资料强调交付前由用户复核/批准，但没有核实 Cowork 每种工具动作的统一审批开关。
4. 计费可理解性不等于总成本可预测：Notion 按工作量消耗 workspace credits，并可在后台跟踪；Zapier Agents 用 activities、同时存在日消息限制；Lindy 用 credits；Manus API 文档有不同 agent profile 及用量级别，消费细节依账户/计划；Cowork 此处没有足够官方证据估算任务边际成本。
5. 定时/重复任务是例行工作自动化，不证明 Agent 会自主推进一个跨月项目。官方资料中未发现任何产品对数月连续项目推进作出可验证保证。Claude 的多小时长任务证据指向 Managed Agents（开发平台能力），不能直接套用到 Cowork 桌面产品。

## 产品证据

### Manus

- **个人/小团队使用与交付：** Automations 将运行结果列入 Updates，支持先 Test run；官方列举会议简报写入 Notion、Sheets 报表发 Slack、GitHub PR 检查等示例。它显示出跨资料来源形成可查看产物的工作流路径；示例仍属厂商描述。[Automations 产品页](https://www.manus.im/features/automations)
- **后台/定时：** 支持一次性、每日、工作日、每周、每月、自定义及 Cron 排程，可指定时区和结束时间，也支持连接器事件或 webhook 触发。页面说明可选“Same task”让每次运行沿用任务消息、文件和结果，或每次新任务；这属于重复运行上下文设置，不足以推断任意长项目会持续自主推进。[Automations 产品页](https://www.manus.im/features/automations)
- **审批与连接器：** 可将发送或发布配置为需批准；连接器列表包含 Gmail/Outlook、日历、GitHub、Shopify、Slack、Notion、Google Workspace、RSS、Webhook 等。产品页说明可暂停、修改、删除自动化，失败运行可查看并请求解释/修复。[Automations 产品页](https://www.manus.im/features/automations)
- **成本/限制：** Manus API 文档列出 standard/lite/max 等 profile，并说明免费个人账户会被降为 lite；该 API 说明不是对所有消费者计划计费的完整描述。面向普通用户每项自动化的成本估算方式、本次页面未明确核实。[API task.create 文档](https://open.manus.im/docs/v2/task.create)

### Lindy

- **个人/SMB 上手与协作：** Lindy 首页把产品定位为 Slack 中的 AI teammate：个人可在 DM 使用私有助手，团队可在频道共享助手。它列举 Gmail、Slack、Notion、HubSpot 等集成，以及 MCP；还描述生成报告、Notion 文档、邮件或预订等多步动作。[官方产品/定价页](https://www.lindy.ai/)
- **后台/审批：** 官方称可按计划运行晨间简报、周报等；并称外部影响动作（例如发送邮件、改 ticket、发频道消息、发布文档）需具名审批人批准。此为产品方的控制承诺，不构成实际可靠性测试。[官方产品/定价页](https://www.lindy.ai/)
- **费用理解：** 页面展示个人席位额度以月度 credits 表达，不同计划额度不同，Enterprise 提供共享用量与审计日志等。Credit 单位对每类任务的消耗换算不够直观，建议将“credits”与真实业务任务成本视为需试跑确认。[官方产品/定价页](https://www.lindy.ai/)
- **限制/适用性：** 团队协作依赖 Slack 工作区及管理员连接；个人用户可能无需完整团队流程，但这组公开材料主要偏团队助手定位。官方页面也称私有 Slack 频道需频道经理邀请，personal DMs 不对共享助手开放。[官方产品/定价页](https://www.lindy.ai/)

### Zapier Agents

- **个人上手与触发：** 官方帮助文档允许自定义创建或套用模板，之后设置 trigger、测试、发布。Agent 使用 Zapier 应用生态执行自动化；Zapier 的产品页声称有 9,000+ 应用，但属于厂商目录规模陈述。[创建 Agent 帮助](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents)、[Zapier Agents 定价页](https://zapier.com/pricing)
- **团队协作限制：** 帮助文档明确 Agents 是绑定个人账户的自动化；可分享模板供他人建立自己的副本，但 Agent 本身不是多人共享的实时体验。企业用户需要管理员/所有者启用账户级访问。[创建 Agent 帮助](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents)
- **成本与容量：** 用量以 activities 计，另有每天 500 条消息上限（自定义计划例外按活动数决定）；存在 token 限制。计划页给出每月活动额度层级，因两种单位并存，用户须分别理解“运行次数”和“消息数”。[创建 Agent 帮助](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents)、[Agents 定价页](https://zapier.com/pricing)
- **产品状态/审批未知：** 官方帮助页提示 Zapier 正在将 Agents 迁移至 AI by Zapier；因此产品名与持续可用性可能处于过渡中。该页有测试、发布说明，但本次未找到官方资料确证 Agents 自身存在覆盖所有副作用操作的统一审批机制；不要用普通 Zapier 审批模板替代 Agents 证据。[创建 Agent 帮助](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents)

### Claude Cowork

- **产品边界与交付：** Anthropic 官方资料将 Cowork 描述为桌面应用，可跨本地文件和连接应用完成多步骤项目；连接器可连接云端工具（如 Drive、Gmail、Asana、Notion）及桌面扩展。另有官方金融服务模板案例：Cowork 插件可在用户桌面旁工作，交付 Excel 模型、PowerPoint 简报和 Outlook 草稿等；这属于特定模板/行业案例。[Anthropic 产品总览 PDF](https://www-cdn.anthropic.com/files/4zrzovbb/website/34783bca828d7fa331f515ced26f1c9232151b2c.pdf)、[连接工具教程](https://academy.claude.com/tutorials/connect-your-tools-to-unlock-a-smarter-more-capable-ai-companion)、[金融服务 Agents 公告](https://www.anthropic.com/news/finance-agents)
- **动作审批：** Anthropic 金融服务公告称用户会在工作交给客户、归档或采取行动前复核、迭代并批准。它没有证明 Cowork 的每个连接器动作都具备通用、强制审批闸门，产品评估时应查具体连接器权限行为。[金融服务 Agents 公告](https://www.anthropic.com/news/finance-agents)
- **后台/长期任务边界：** 同一公告区分 Cowork 桌面插件与 Claude Managed Agents 云端平台；后一种才明确提及自主运行、多小时长会话和夜间排程。不要把 Managed Agents 的托管运行能力归到 Cowork。此次检索未找到 Cowork 一般用户版可按月重复排程并离线持续工作的官方证据。[金融服务 Agents 公告](https://www.anthropic.com/news/finance-agents)
- **成本/上手未知：** 这组官方来源可说明连接器设置与桌面应用边界，但未能核实 Cowork 任务级成本单位、跨计划可用性细则，也未找到对个人/小企业计划适用性的完整官方说明。不能据此声称成本透明或一定包含于某订阅。

### Notion Custom Agents

- **上手/团队背景：** Custom Agents 内嵌 Notion，能用 AI chat 起草指令、触发器与访问范围；可以基于页面/数据库与 Slack 工作。Notion Agent 是按需个人助手；Custom Agents 则定位团队共享后台工作流。[Custom Agents 帮助](https://www.notion.com/help/custom-agents)、[Agents 产品页](https://www.notion.com/product/agents)
- **排程/权限/审批：** 支持每日、每周、每月等时间计划，以及 Notion、Slack 事件触发。默认不是全工作区访问，需要明确授予页面、数据库和外部应用。Calendar 连接可设置读或读写，以及单独的操作前确认；具体审批机制随集成不同，不能概括成所有写操作默认需审批。[Custom Agents 帮助](https://www.notion.com/help/custom-agents)、[Calendar 连接帮助](https://www.notion.com/en-gb/help/connect-calendar-to-custom-agents)
- **协作与交付：** 可给团队成员分配编辑、运行、交互权限，查看运行日志/版本；Agent 可将子工作交给其他 Custom Agents。常见产物是 Notion 页面/数据库更新、Slack 消息和定时报告，利于已有 Notion 团队形成闭环。[权限帮助](https://www.notion.com/help/custom-agents-sharing-and-permissions)、[Agents 帮助](https://www.notion.com/help/custom-agents)
- **费用与可用范围：** 需要 Business 或 Enterprise（包含试用）；Custom Agents 按 workspace Notion credits 计费，每个任务消耗取决于工作量，余额共享并按月重置。官方提供用量看板和阈值通知，但多步骤 Agent 的单次成本仍有波动。[Agents 产品页](https://www.notion.com/product/agents)

## 对 OpenBot 产品讨论的推论

- **推论（横跨来源）：** 个人与 SMB 若需“交付一个可检查的成果”，产品应同时展示运行记录、草稿/产物位置、下游动作状态和审批入口；只强调 Agent 能力而不说明完成物与失败恢复，会让用户难判断是否可托付。
- **推论：** 应把两条入口讲清楚：个人临时任务（桌面/浏览器/文件工作区）和团队例行自动化（连接 SaaS 后定时或事件触发）。后者可能要求管理员授权、既有 workspace、订阅附加用量，不能包装成零配置个人体验。
- **推论：** “行动前审批”须落实到具体副作用边界，例如邮件发送、公开发布、改写业务数据；同时展示可授予工具的读/写范围。仅有 Agent 活动日志不能替代运行前授权。
- **推论：** 费用解释应将 Agent 消息、运行次数、外部动作、模型/重试及 workspace 共用额度分开呈现；若用 credits，应给代表性任务的预计区间或运行后实际消耗，不能只给抽象余额。
- **推论：** 用“工作流可按日/周/月重复运行”描述排程能力；将“跨月项目推进”描述为需要用户持续检查点、保存项目状态和明确继续规则的另一项能力。此次来源没有产品保证跨月自主推进。

## 检索限制与未知

- Manus、Lindy、Zapier、Notion、Anthropic 官方页面均可访问。对 Lindy 使用了官网当前主页/价格内容，带合作追踪参数的搜索结果最终按主站 `https://www.lindy.ai/` 引用。
- Claude Cowork 有 Anthropic 官方资料验证产品存在及桌面/连接器/插件定位；本次没有找到可直接支持 Cowork 消费级定时后台任务、任务级成本和个人/SMB计划适用性的官方说明。因此将这些列为未知，不以 Claude Managed Agents 补齐。
- Zapier Agents 官方帮助页面直接提示产品迁移至 AI by Zapier。本文只描述 Agents 当前帮助文档记录的限制，不推断迁移时间或未来兼容。
- 排程能力仅说明按时间重复启动。没有证据显示上述产品能无须复核地跨数月持续规划和完成开放式项目。
