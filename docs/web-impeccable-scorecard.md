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

基线得分为 **52.5%–75%**。Astryx 合入前的复评记录为 **24 条有较新暂定分，65 条沿用基线，正式验收为 0/89**。有复评的页面按最新批次记分，即便分数下降。首页和新建会话以第三批的生产构建复评为准。每个复评分的十项明细与证据见该行链接。

上一轮范围核对基于 `effb61ab` 及第二、三批工作区改动。三个索引路由 `/bots/`、`/bots/$agentId/` 和 `/connections/` 按无末尾斜线的入口计分。三个内置连接视图由 `/connections/$key` 分派，Team 与 Personal 的通用连接页各自计分。沿用基线的页面正文、交互与异常状态仍需在当前渲染下复评。

## 合入主线后的路由与评分

`e682af31` 合入 Astryx 迁移。生成路由树增至 100 条，新增 `/tasks` 与 `/ideas`，原 `/responsibilities` 跳转改为直接渲染。五个旧外观页面转为兼容跳转，`/s/activity` 继续提供统一的 Activity，Goals 作为 Responsibilities 的独立视图。按原统计口径，当前有 **88 项页面与任务视图，正式验收为 0/88**，其中首页、新建会话、首次使用和为 Bot 登录网站在模拟环境中暂定达到 99% 门槛。下表采用本轮生产构建和模拟接口的暂定分。表外页面沿用各自的历史证据，旧入口和已删除源码路径供回查基线提交。 当前口径取 83 条非旧外观基线记录，将全局 Routines 替换为本节的新评分，并新增 Tasks、Ideas、Responsibilities、独立 Goals 和统一 Activity 五条。

| 当前页面 | 对应旧入口 | H1…H10 | 本次暂定分 | 扣分与复验 |
|---|---|---|---:|---|
| `/tasks` | `/s/tasks` | 3 3 3 3 3 4 3 3 3 2 | **30/40（75%）** | 按十项分值核算。任务区改为紧凑空态，合并页内 Routines 链接。键盘重试回到当前标签面板，窄屏可能将页标题滚出视口。嵌入列表仍需满数据复验。 |
| `/ideas` | `/s/ideas` | 3 3 3 3 3 3 3 4 4 3 | **32/40（80%）** | 上次 31/40。键盘重试聚焦恢复的内容标题，建议空态改为紧凑文案。Check-ins 按钮在窄屏首屏可见，高 36px。失效 Bot 书签可恢复，较 Goals 和 Activity 多一步。实际写入、读屏和权限变更待验。 |
| `/responsibilities` | 原地址跳转到 Bots | 3 2 3 3 3 3 3 4 3 2 | **29/40（72.5%）** | 迁移走查 26/40。Goals 加载与失败可见，空态只保留一个创建入口。页面与区块用语仍需要对齐。 |
| `/responsibilities?view=goals` | `/s/goals` | 3 3 3 3 3 3 3 3 3 3 | **30/40（75%）** | 上次 27/40。可在页内切换 Bot，Goals 排在 Routines 之前。选择器高 36px，下方导航较紧，Goals 与 Responsibilities 用语仍需统一。 |
| `/s/activity` | 原地址 | 3 3 3 3 3 4 3 3 3 3 | **31/40（77.5%）** | 上次 29/40。页内切换 Bot 后审计链接随之更新，Team 和 Personal 的审计入口均在首屏。选择器高 36px，实际审计数据和读屏待验。 |
| `/routines` | `/s/routines` | 4 3 4 3 3 3 3 3 4 3 | **33/40（82.5%，暂定）** | 并发操作保留各行的处理中提示。失败可在对应行恢复，较晚返回的启动请求保留用户打开的历史。 [写入反馈复评](#routines-写入反馈复评) |

共享异常状态单独验收。独立设计评审给未知地址 **29/36**，给路由加载失败 **28/36**。两种页面的效率项不适用于单次恢复决策。未知地址保留书签并提供工作区入口。加载失败可重试原路径并保留参数。成功重试后焦点未移动到带标签的控件，连续失败指引和实际读屏仍待检查。

路由恢复阶段的独立 Impeccable 检测覆盖 8 个源码文件和 18 组 Chromium 页面状态，结果均为 0 项。Vite 生产构建在 1440、390 和 320 像素宽度验证了未知地址、键盘返回和六条旧书签。后续生产构建 `index-Bm9W0Yw_.js` 验证全部 21 条兼容书签，Team 管理员、Team 成员和 Personal 各执行 21 次，63 次全部通过。Goals 与 Ideas 保留 `agent`，旧 Connections 保留回调参数。Team 的 Memory 入口进入 `/capabilities/memory`，Personal 回到 `/bots`。 [书签矩阵](/tmp/openbot-group-review/bookmark-matrix-final.json)

另验证 API 失败后的原地址重试、访客登录回退以及窄屏导航的 Escape 与焦点归还。Web 类型检查通过，七个定向测试文件共 61 项通过。

Tasks 与 Ideas 的独立复评覆盖 Vite 生产构建、Team 浅色 1440×900 和 Personal 深色 390×844。4 个源文件扫描无发现，14 个渲染场景中有 5 条桌面嵌套容器提示，集中在任务或建议空态。窄屏无检测项及横向溢出。四项模拟读取故障均恢复到正确状态。Web 类型检查和 44 项定向测试通过。

Responsibilities、Goals、Activity 和 Routines 的复评沿用相同的生产构建方式与视口。十次模拟读取故障均可原位恢复，最终构建确认焦点进入对应页面标题或 Goals 区块标题。新建 Routine 的浅色对比度约 17.2∶1、深色约 18.1∶1。Web 类型检查、生产构建和 36 项定向测试通过。真实写入、完整读屏和角色矩阵待验。

本轮独立检测覆盖 28 个渲染场景，发现 7 条桌面提示，涉及嵌入列表空态和 Tasks 错误态的重复文本。窄屏无检测项或横向溢出。Tasks 和 Ideas 的简化空态与恢复焦点已独立复评。Goals 和 Routines 的无名称区块焦点问题在最终生产构建复验修正。

Activity 空态整改后分别检测统一入口与 Bot 专属入口。8 个渲染场景中只剩两条桌面 Actions 容器嵌套提示。4 次键盘重试通过，13 项定向测试通过。

Bot 选择器复评由独立设计评审和检测评审在同一生产构建上完成。Team 浅色 1440×900 和 Personal 深色 390×844 验证切换、刷新和六次失效 Bot 恢复。旧 Goals 和 Ideas 地址保留 Bot 参数。切换后，Routines 和审计链接指向当前 Bot。4 个源码文件扫描无发现，12 个渲染场景共有 5 条桌面嵌套容器提示，均无横向溢出。Web 类型检查和 18 项定向测试通过。

通常满分为 40，两个交接页的满分各为 36。任何适用项扣 1 分都会低于 99%，所以验收要求每个适用项都达到 4 分。百分比只用于展示，门槛以原始分判断。

当前范围的 88 项均有评分。82 项已有后续复评分或整改后待复评；六个沿用基线的旧地址（五个旧外观视图与 `/settings/activity`）源码已在 Astryx 默认化中删除或转为跳转（`/settings/activity` 实测落到 Settings General；统一视图 `/tasks`、`/ideas`、`/responsibilities`(+Goals)、`/s/activity` 各自分已评分），按"不再是对外提供的页面"关闭，不计入 88 项的未达标面。首页、新建会话、首次使用、为 Bot 登录网站、连接清单和技能清单在模拟环境中得 40/40（暂定），真实任务验收待补。顺序2 的 15 项在 2026-11-22 完成三批整改与两轮盲评，其中 9 项在盲评后又落地修复并经活体验证，待下轮复评确认。顺序3 的 15 条评分行（12 个独立视图，其中技能三页为 admin/settings 共用组件）在 2026-11-23 完成盲评（C/D 两评）与整改，盲评后修复全部活体验证，证据链 18 条失败路径全部键盘原位恢复。

## 本轮评审与检测

两名独立评审分别检查工作区改动的页面影响和运行 Impeccable 检测。设计评审核对新增和变化的页面，确认三批记录已经覆盖页面级改动。共享导航、标题折行及全局样式的影响仍需在各子页实测。

- 扫描当前 426 个 JSX/TSX 文件，发现 0 条主要问题、1 条动效提示，位置在 Bot 头像。扫描整个 `app/src` 时另有两条字体提示，分别指向全局 Inter 和 A2UI 生成提示词中的字体描述。 [头像](../app/src/components/channels/avatar.tsx#L185) [全局字体](../app/src/theme.css#L107)
- 在第三批源码构建上，用模拟身份和数据抽查 People 停机、Saved logins 删除和 Boundaries 试运行确认。1440×900 浅色与 390×844 深色共六次渲染，检测均返回 0 项。取消有默认焦点、Escape 可关闭、对话框完整可见。生产环境写入、真实读屏和更多角色组合待验。
- 设计评审发现通用路由异常会落到框架的默认错误界面，可展开技术细节，缺少回到任务的入口。基线中的快速会话和 Playground 夹具曾触发这一界面。按 P1 纳入第二批补验。 [路由配置](../app/src/router.tsx) [整改计划](web-impeccable-remediation-plan.md)

## 基线主要问题

| 观察 | 扣分影响 |
|---|---|
| 加载、空数据与故障容易长得一样 | 全部 89 条评分的状态可见性均扣分。多处首次查询直接返回空内容。 |
| 动作失败后缺少可用的下一步 | 全部 89 条评分的错误恢复均扣分。刷新、原始异常和缺少就地重试集中出现在会话、授权及设置。 |
| 高影响操作缺确认或后果说明 | 凭据撤销、SSO 删除、停止电脑、移除访问、删除技能和记忆均需逐动作核验。 |
| 专有名词和层级增加决策成本 | 员工需要知道该等谁、从哪继续。管理员需要在同一处看清授权主体、作用域、后果和生效结果。 |


## 核心工作区、认证与外观专属页面

每个分值依序对应 H1 状态可见、H2 用户语言、H3 用户控制、H4 一致性、H5 防错、H6 可识别、H7 效率、H8 简洁、H9 恢复、H10 帮助。适用项按 0–4 赋整数，源代码已有的行为记入分数。单向瞬时交接的 H7 无适用操作，注明 —，从分母剔除。分数仅随证据更新。

### 登录、会话和浏览器

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/sign` 登录 | 3 3 3 3 2 2 3 3 2 1 | 25/40 | **38/40（95%）** · [登录复评](web-impeccable-batch-3-conversations.md#登录恢复复评) | 公司邮箱有持久标签。登录选项恢复后焦点回到标题，第三方请求失败保留操作焦点。管理员联系方式和真实身份回跳待验。 |
| `/onboarding` 首次使用 | 3 3 3 3 3 3 2 2 2 3 | 27/40 | **40/40（100%，暂定）** · [首次使用复评](web-impeccable-batch-3-conversations.md#首次使用最终复验) | 进度保存失败可重试，完成失败可沿用已保存的姓名。预约失败后 320 像素下仍可继续。移动端显示步骤数。姓名与完成失败时可从姓名字段重试。审批开关为 44 × 44 像素。切换步骤时旧控件立即退出交互，320 像素无溢出。真实预约、实体触屏与读屏待验。 |
| `/desktop-return` 浏览器交还桌面 | 2 3 2 3 2 3 — 4 1 1 | 21/36 | **33/36（91.7%）** · [桌面交还复评](web-impeccable-batch-3-conversations.md#桌面交还复评) | 确认失败时可重试或留在浏览器，确认成功时提供打开桌面与浏览器两种路径。已验证本机协议唤起，真实账号回调待验。 |
| `/sign-in/$requestId` 为 Bot 登录网站 | 3 3 3 3 3 3 2 3 2 3 | 28/40 | **40/40（100%，暂定）** · [为 Bot 登录网站复评](web-impeccable-batch-3-conversations.md#为-bot-登录网站复评) | 暂时读取失败保留表单与焦点，失效请求关闭表单。已匹配的 Thread 可返回原会话。窄屏长账户换行，处理中显示状态并限制重复提交。显示完整网站地址与当前用户获准查看的 Bot 名称。窄屏两个恢复操作均高 44 像素。真实请求投递、验证码验证和 Bot 浏览器回跳待验。 |
| `/` 首页 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | **40/40** · [生产构建复评](web-impeccable-batch-3-conversations.md#共享页头与草稿交接复评) | 草稿可复制到新建会话，拒绝存储时可在当前标签页继续。真实服务、触屏和读屏待验。 |
| `/channel/new` 新会话 | 2 3 3 3 3 3 3 3 2 2 | 27/40 | **40/40** · [生产构建复评](web-impeccable-batch-3-conversations.md#共享页头与草稿交接复评) | 支持连续选 Bot 和刷新恢复顺序。To 为空时说明发送限制并引导选人。320 像素下 To 可换行。真实服务、触屏和读屏待验。 |
| `/start/$startId` 创建会话中 | 2 3 1 3 2 3 — 3 1 1 | 19/36 | **26/36** · [第1批](web-impeccable-batch-1.md) | 刷新恢复草稿并复用请求标识。PostgreSQL 验证群聊重复创建和并发首发只产生一条用户消息。Intelligence 网关断线重发、真实审批恢复及本页新版本设计评分待验。 [首次发送复验](web-impeccable-batch-1.md#首次发送的-postgresql-复验) |
| `/channel/$channelId` 单 Bot 会话 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | **37/40（92.5%）** · [首发重试复评](web-impeccable-batch-3-conversations.md#单-bot-会话首发重试复评) | OpenBot 直聊可用原消息 ID 重发纯文本首条消息。重新检查保留焦点。待确认气泡有状态标签，窄屏恢复按钮高 44 像素。已修正提示内边距和重复措辞。无法重发时的说明和各入口的一致性待完善。真实服务及读屏待验。 |
| `/group/$channelId` 多 Bot 会话 | 3 3 2 2 2 3 2 3 2 2 | 24/40 | **38/40（95%）** · [多人会话复评](web-impeccable-batch-3-conversations.md#多人会话回复状态复评) | 刷新恢复文本与点名，发送失败重试沿用原消息 ID。自动刷新结束后可手动查收。回复失败保留已生成内容并按发起人权限提供指引。从 Activity 返回时焦点回到原链接，原回复消失时焦点移到消息区。真实成员权限及动作结果待验。 |
| `/bot` 默认或指定 Bot 快速会话 | 2 3 2 2 3 3 2 3 2 2 | 24/40 | **33/40（82.5%）** · [快速会话复评](web-impeccable-batch-3-conversations.md#快速会话触控与首发指引复评) | 草稿按账号与 Bot 隔离，刷新和重新开始均会保留。发送、附件及页头主要操作区至少 44×44。首次使用帮助和真实网关待完善。 |
| `/browser` 自己的浏览器 | 2 3 3 2 3 3 3 3 3 2 | 27/40 | **33/40（82.5%，暂定）** · [连接与录像恢复复评](#teach-a-bot-连接与录像恢复复评) | 重开失败有原位反馈，录像列表可独立重试。后台刷新 503 保留已打开的画面，403 移除旧画面和导航入口。 |

### Bot、能力与例行任务

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/bots` Bot 列表 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **35/40（87.5%）** · [第三批 Bot 复评](web-impeccable-batch-3-conversations.md#bot-清单创建与档案复评) | New Bot 和搜索触区为 44 像素。列表读取失败可原位重试，成功后聚焦 Bots 标题。浏览器后退仍会清空搜索并丢失焦点。 |
| `/bots?new=true` 创建 Bot 状态 | 3 3 3 3 4 3 2 3 3 3 | 30/40 | **32/40（80%）** · [第三批 Bot 复评](web-impeccable-batch-3-conversations.md#bot-清单创建与档案复评) | 创建主操作为 44 像素，写入失败保留草稿。窄屏次操作占用较多空间，自定义流程仍一次展示 13 个框架，创建后档案焦点待补。 |
| `/bots/$agentId` Bot 档案 | 2 3 3 3 3 3 2 2 2 2 | 25/40 | **34/40（85%）** · [第三批 Bot 复评](web-impeccable-batch-3-conversations.md#bot-清单创建与档案复评) | 首载有状态。503 可原位重试并聚焦标题，403 或 404 引导回清单。暂停失败显示错误并保留已确认状态。删除确认控件为 28 像素，窄屏状态说明仍有截断。 |
| `/bots/$agentId/access` 技能与访问 | 2 2 3 2 3 2 2 2 2 2 | 22/40 | **37/40（92.5%）** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 共享应用就绪检查失败时只提示一次。44 像素的原位重试成功后焦点回到标题。仍需复评多个应用的授权范围、写入反馈与键盘效率。 |
| `/bots/$agentId/activity` Bot 活动 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **36/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | Bot 首载和区块读取均可重试。刷新失败保留已读内容。满数据、停止、取消及真实历史定位待验。 |
| `/bots/$agentId/approvals` 审批规则 | 2 3 2 3 2 3 2 3 2 2 | 24/40 | **37/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 加载失败提供重试，成功空响应才显示无规则。真实规则变更与正在等待的审批需分别验收。 |
| `/bots/$agentId/memory` 记忆来源 | 2 2 3 3 3 2 2 2 2 2 | 23/40 | **35/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 来源读失败可局部重试，成功聚焦 App sources。Personal 的旧链接进入 Access。真实同步和权限撤销待验。 |
| `/bots/$agentId/reach` 联系方式 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **37/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 连接目的地加载和读取失败可见，重试回到区块标题。真实 SMS、Slack 和 Teams 验证待补。 |
| `/bots/$agentId/responsibilities` Goals | 2 2 2 3 3 2 2 3 2 2 | 23/40 | **35/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | Bot 和 Goals 列表读取失败可局部重试。需对齐 Goals 与 Responsibilities 的用语并验证新建与归属。 |
| `/bots/$agentId/routines` Bot 的例行任务 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **37/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | Bot 加载成功后才显示 New routine，读取失败可以原位重试。真实排程、运行和取消待验。 |
| `/bots/$agentId/setup` Bot 设置 | 3 2 3 3 3 2 2 2 3 2 | 25/40 | **36/40（90%）** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 隔离能力区分加载、失败、不支持和权限拒绝。已有隔离在禁止开启时仍可关闭。渲染检测发现 7 处说明文字为 11.25 像素。真实写入待验。 |
| `/bots/$agentId/sharing` 分享 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **36/40** · [第三批子页复评](web-impeccable-batch-3-conversations.md#九个-bot-子页复评) | 分享状态明确加载和失败。重试回到页标题。真实发布、取消发布和组分配权限待验。 |
| `/capabilities/skills` 技能列表和编辑面板 | 2 3 2 3 1 3 2 3 2 3 | 24/40 | **31/40（77.5%，暂定）** · [技能与记忆复评](#技能与记忆读取恢复复评) | 清单和编辑器均可原位恢复。键盘重试后聚焦编辑标题，菜单删除确认前没有写入。长标题可换行，窄屏菜单操作可触达。 |
| `/capabilities/memory` 记忆列表 | 2 3 2 3 2 3 2 2 2 2 | 23/40 | **30/40（75%，暂定）** · [技能与记忆复评](#技能与记忆读取恢复复评) | 读取失败可重试，临时故障保留已读数据。写入失败保留编辑草稿，移除写入前先确认并复查。窄屏开关有文字标签，行操作可换行。 |
| `/routines` 全部例行任务 | 2 3 3 3 3 3 2 3 2 3 | 27/40 | **33/40（暂定）**，见写入反馈复评 | 明确会话与新建双入口。编辑仅从会话处理，页面的历史、开关、立即运行和删除全部集中在同一行，长列表和错误定位需查。 [全局 Routines](../app/src/routes/_authed/_app/routines.tsx#L22) [行操作](../app/src/components/routines/routines-list.tsx#L435) |
| `/routines/new` 创建例行任务 | 3 3 3 3 4 3 2 2 3 3 | 29/40 | **38→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 表单约束和保存状态明确；时区、日期和 Bot 内容在同页聚集。fixture 补 `POST /api/channels` 契约后创建流程已活体验证：无脚本错误、成功跳回 /routines 且新任务入列。余下：重复提交防抖、离开表单未提醒草稿。 [排程表单](../app/src/components/routines/new-routine-page.tsx#L280) |

### 连接

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/connections` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [顺序2终评](../app/.impeccable/critique/2026-11-22T09-55-00Z__order2-connections-admin-plugins.md#round-2--blind-re-assessment-findings-and-fixes) | 盲评 A3 满分：清单骨架、Team account 状态、身份读取失败不误报 Connect、磁贴两行摘要均活体验证。余下为记录项：与目录页搜索计数/空态措辞略异。 |
| `/connections/$key` Team 应用及动作授权回执 | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [断开确认复评](#账户断开确认与窄屏复评) | 窄屏账户和权限正文完整换行。断开前列出影响范围，取消后回到原按钮。 |
| `/connections/$key` Personal 应用 | 3 4 4 4 4 4 4 4 4 4 | **39/40（暂定）** · [断开确认复评](#账户断开确认与窄屏复评) | 可确认断开一个或全部账户，失败可重试，成功后有回执。 |
| `/connections/github` | 2 3 3 4 3 4 4 4 3 4 | **34/40（暂定）** · [顺序2终评](../app/.impeccable/critique/2026-11-22T09-55-00Z__order2-connections-admin-plugins.md#round-2--blind-re-assessment-findings-and-fixes) | A3 旧分；其后已修并活体验证：新增仓库落库、两处 Disconnect 均确认、Lets 语法回正。剪贴板无权限时静默为环境限制（有权限显示 Copied）。 |
| `/connections/slack` | 2 3 4 4 4 4 4 4 3 4 | **36/40（暂定）** · [顺序2终评](../app/.impeccable/critique/2026-11-22T09-55-00Z__order2-connections-admin-plugins.md#round-2--blind-re-assessment-findings-and-fixes) | A3 旧分；其后已修并活体验证：Reconnect 全流程打开带代码对话框（fixture 补 challenges）。Lets 语法回正。 |
| `/connections/routines` | 4 4 4 3 4 4 4 4 4 4 | **39/40（暂定）** · [顺序2终评](../app/.impeccable/critique/2026-11-22T09-55-00Z__order2-connections-admin-plugins.md#round-2--blind-re-assessment-findings-and-fixes) | A3 扣 H4：Routines 列于应用区与条目语义不符——既定设计（代码注释记录），保留。读失败 alert+Retry 已验证。 |
| `/connections/browse/arcade` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/connections/browse/composio` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |

### 外观专属 Web 页面

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/s/tasks` OpenDuet | 2 3 3 2 3 3 2 2 2 2 | 24/40 | 沿用基线 | 任务按待办状态分组，混合审批、Goals、Routines。Active/Up next 使用 tab 角色和普通按钮点击，组件无方向键或 roving tabindex。 [Tasks](../app/src/skins/openduet/tasks-screen.tsx#L86) |
| `/s/routines` OpenDots | 2 3 3 2 3 3 2 3 2 3 | 26/40 | 沿用基线 | 主操作清晰，嵌入全局列表和它的静默加载，与默认外观标题层级及返回有差异。 [OpenDots Routines](../app/src/skins/opendots/screens.tsx#L53) |
| `/s/memories` OpenDots | 2 3 2 2 2 3 2 3 2 2 | 23/40 | **26/40** · [第1批](web-impeccable-batch-1.md) | 包装后仍继承单击 Forget 和静默加载，能力等待导致整个页面空白。复测 Personal 能力回退。 [OpenDots Memories](../app/src/skins/opendots/screens.tsx#L68) |
| `/s/activity` OpenFuse | 2 3 3 2 3 3 2 3 2 2 | 25/40 | 沿用基线 | 继承 Bot 活动反馈和审计入口，空 Bot 有独立态。聚焦当前 Bot 的导航必须在长耗时切换后仍保持明确。 [OpenFuse Activity](../app/src/skins/openmuse/screens/activity.tsx#L11) |
| `/s/ideas` OpenFuse | 2 2 3 2 3 2 2 3 2 2 | 23/40 | 沿用基线 | Ideas 含 Bot 等待人处理及主动研究设置，标题无法直接提示读取、决策和设置之间的关系。 [OpenFuse Ideas](../app/src/skins/openmuse/screens/ideas.tsx#L16) |
| `/s/goals` OpenFuse | 2 2 2 2 3 2 2 2 2 2 | 21/40 | 沿用基线 | 一列堆叠 Routines 与 Bot Responsibilities，多个域概念在同一个标签内出现。等待与错误继承列表，需要检查移动视口重复标题、滚动、首个动作。 [OpenFuse Goals](../app/src/skins/openmuse/screens/goals.tsx#L13) |

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

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/admin/` | 3 · 3 · 3 · 3 · 3 · 4 · 2 · 3 · 2 · 2 | 28/40 · 70% | **34/40（85%，暂定）** · [设置搜索复评](#管理首页设置搜索复评) | 16 个入口可按名称、分组或任务描述查找。Enter 聚焦首个结果，返回首页恢复搜索词。 |
| `/admin/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | **36/40（90%，暂定）** · [团队审批决策与搜索复评](#团队审批决策与搜索复评) | 共享账户请求可原位恢复，决策需确认并复查当前访问范围。团队规则可筛选并直接操作匹配项。 |
| `/admin/approvals/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [审批规则清单复评](#审批规则清单复评) | 长草稿可逐条展开。折叠摘要保留校验提示，保存响应丢失可用同一草稿重试。 |
| `/admin/approvals/guidance` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **33/40（82.5%，暂定）** · [指导草稿复评](#审批指导草稿复评) | 离开前保护未保存草稿，恢复已保存内容时清除旧检查与回测结果。详细安全规则可展开查看。 |
| `/admin/audit` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | **32/40（80%，暂定）** · [审计分页复评](#审计分页复评) | 空页仍可继续查找更早记录，失败后原位键盘重试。提问示例可见，Why? 分开显示已记录判定与当前策略。 |
| `/admin/boundaries` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **35/40（87.5%，暂定）** · [边界清单搜索复评](#边界清单搜索复评) | 可按名称、说明或规则搜索。筛选后仍打开对应规则，返回时保留查询。 |
| `/admin/boundaries/$index` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **36/40（90%，暂定）** · [边界详情编辑复评](#边界详情编辑复评) | 稳定书签和并发保存已复验。离开前保护描述与表达式草稿，当前表达式通过校验后才可提交。 |
| `/admin/boundaries/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **38/40（95%，暂定）** · [边界起点与草稿复评](#新建边界起点与草稿复评) | 选定起点后表单在前。切走的草稿也受离开确认保护，冲突可刷新后再提交。 |
| `/admin/components/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（暂定）** · C 36，E 复评满分。 [E 轮复评](#e-轮复评与整改) | 已修并验证：磁贴状态由仅色点改为标题内可见文字（· Published / · Draft，H1/H6 扣分点）。余下："无法绘制"在列表与详情有三种措辞变体（H4）；无图样磁贴的大渐变占位（fixture 数据，H8）。 [源码](../app/src/routes/_authed/admin/components/index.tsx#L37) |
| `/admin/components/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **38→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 盲评 C 38，仅有的两条扣分（失败态 h1 降级为通用 "Components"、不可渲染组件的 Published 开关与"下方设置无效"通告矛盾）均已在盲评后修复并活体验证：标题显示组件名，开关随可渲染性禁用；"无法绘制"措辞已统一为 This build cannot draw 一族（详情通告与预览占位同词）。 [源码](../app/src/routes/_authed/admin/components/$name.tsx#L102) |
| `/admin/computers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **31/40（77.5%，暂定）** · [设备操作复评](#设备操作确认与恢复复评) | 重置与更新前重新核对目标，取消后焦点回到对应行。提交结果不明时提示先核对设备和 Audit。 |
| `/admin/credentials` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | **37/40（暂定）** · [凭据与已保存登录项复评](#凭据与已保存登录项复评) | 403 移除缓存条目及撤销操作。键盘重试成功后回到 Saved credentials。 |
| `/admin/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **38/40（暂定）** · [凭据与已保存登录项复评](#凭据与已保存登录项复评) | 创建冲突聚焦提示并保留输入。保存和替换完成后在清单页显示回执。 |
| `/admin/identity-providers` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | **32/40 · 80%（暂定）** · [登录策略复评](#identity-providers-登录策略复评) | 注册清单读取失败可原位重试。Require SSO 提交前说明退出会话的影响，已保存但清理未完成时可原位续做。 |
| `/admin/learning` | 2 · 2 · 3 · 3 · 3 · 3 · 2 · 2 · 3 · 2 | 25/40 · 62.5% | **35→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 盲评 C 31，其最重的三条（裸服务端错误文本 ×4+保存、区块失败只能刷新恢复、提议弹窗"Try again"无按钮且 404 死路）均已修复：六处读取失败改统一 SectionReadError（ curated 文案 + 原位 Retry），提议详情弹窗失败原位 Retry，fixture 补详情端点。失败运行原因句已验证（fixture 改用真实 failureCode 后行文显示映射句而非"The run failed."；代码本就在 FAILURES 映射内）。九节已重排：Review and publish 与 Proposed skills 提到 Participation 之前，审阅工作流首屏可达（实测 heading y 708 vs 962）；容器配置降为第三。余下："Weekly digest" 同现两节为 fixture 数据重叠（p2 与已发布技能同名）。 [源码](../app/src/routes/_authed/admin/learning.tsx#L600) |
| `/admin/people` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | **32/40 · 80%（暂定）** · [清单恢复复评](#管理清单读取与恢复复评) | 分页失败保留已读结果与重试焦点，窄屏行操作可换行。 |
| `/admin/permissions` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **40/40（100%，暂定）** · [权限结果与审计入口复评](#permissions-结果与审计入口复评) | 成员权限按阻止与允许分组，状态词与覆盖项一致。权限历史直接打开已筛选的 Audit。 |
| `/admin/permissions/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [权限描述审阅复评](#权限描述审阅复评) | 编辑期间可参考常驻示例。长草稿可直达人员影响，离开前可继续编辑或丢弃。 |
| `/admin/playground` | 3 · 2 · 3 · 3 · 2 · 3 · 3 · 2 · 3 · 2 | 26/40 · 65% | **33→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 盲评 C 36。已修并验证：Publish 先确认（对话框复用页面自己的"每个 Bot 可用"文案，Cancel 可退，确认后通知"Published."且清单行翻为 published）；空草稿时 Save/Publish 禁用并在按钮旁说明"Name and title are needed first."。余下：写失败横幅沿用服务端原文（写路径约定，fixture 的人为文本放大了观感）；离开编辑不提醒未保存草稿。 [源码](../app/src/routes/_authed/admin/playground.tsx#L182) |
| `/admin/plugins/` | 2 4 3 4 3 4 4 4 3 4 | **35/40（暂定）** · [插件读取复评](#目录布局与插件读取复评) | 插件清单读取失败可键盘重试，成功后回到 Plugins 标题。 |
| `/admin/plugins/$key` | 3 4 4 4 4 3 4 4 4 4 | **38/40（暂定）** · [断开确认复评](#账户断开确认与窄屏复评) | 共享账户断开明确说明受影响的 Bots 与应用。账户读取仍可原位重试。 |
| `/admin/plugins/$key/bots/$agentId` | 3 3 4 4 4 4 4 4 4 4 | **38/40（暂定）** · [插件读取复评](#目录布局与插件读取复评) | 重试恢复插件与 Bot 页面标题。 |
| `/admin/plugins/$key/tools/$tool` | 2 4 4 4 4 4 4 4 3 4 | **37/40（暂定）** · [插件读取复评](#目录布局与插件读取复评) | 重试后焦点回到工具标题。 |
| `/admin/plugins/arcade` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/admin/plugins/composio` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/admin/proactive` | 2 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 2 | 27/40 · 67.5% | **40/40（暂定）** · C 39，E 复评满分。 [E 轮复评](#e-轮复评与整改) | 盲评 C 39，唯一扣分为词汇：已修并验证——行标题 Pings sent → Check-ins sent，"2.0 items in each, on average" 改完整句"Each one carries an average of 2 items."（整数值不再显示 .0），Bot 弹窗统计 Sent in a ping → Check-ins sent，页面全境不再出现 ping。 [源码](../app/src/routes/_authed/admin/proactive.tsx#L131) |
| `/admin/providers` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [模型目录与窄屏复评](#providers-模型目录与窄屏复评) | 目录仅有默认模型时可检查更新。模型草稿保存失败可重试，成功后回到清单并显示回执。 |
| `/admin/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（暂定）** · C 满分，E 复评再确认。 [E 轮复评](#e-轮复评与整改) | 盲评 C 满分："1 of 2 Bots" 显式状态、应用语态的失败+Retry、New skill 正确跳转、深色窄屏干净。 [源码](../app/src/components/manage/skills-page.tsx#L74) |
| `/admin/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **36/40（暂定）** · [顺序3盲评](#顺序3盲评与整改) | 盲评 D 36.0。已修并验证：保存成功出"Skill saved" toast（fixture 补 `POST /api/plugins/skills` 后原 404 死路消除，浏览器实测 toast 出现）；Bots 开关写入随 fixture grants 落地；工具弹窗去掉内置 Close，Done 成为唯一具名退出（实测按钮仅 Select all/Done）。已修并验证：编辑中途点返回栏先问"Leave without saving?"（干净表单直接返回；PageShell linkProps 铺开顺序修正使页面可拦截自己的返回栏）。"GMAIL FETCH THREADS" 为 fixture 工具名缺装饰——真实 snake_case 名已由 toolTitle 美化。 [源码](../app/src/components/manage/skill-page.tsx#L76) |
| `/admin/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **36→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 盲评 D 36.5。已修并验证：工具读取失败由"Reload the page."改为原位 Retry（保住草稿，H4/H9 扣分点）；脏表单 Cancel 先确认"Leave without saving?"，干净表单直接返回（H5 扣分点）。余下：同详情页的 fixture 工具名。 [源码](../app/src/components/manage/new-skill-page.tsx#L28) |
| `/admin/what-if` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | **33/40 · 82.5%（暂定）** · [判定语义复验](#what-if-判定语义整改) | 提问后聚焦解读，检查和重试后显示判定并聚焦标题。重置回到输入框。保留失败前的动作，说明上一题与当前动作的关系。 |
| `/settings/` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | **30/40** · [第2批](web-impeccable-batch-2.md) | 个人信息、外观及快捷键分组明确，姓名与指示有局部编辑。账户及外观状态分处多节，快去某设置的搜索弱，设置失败的恢复方式因组件而异。 [源码](../app/src/routes/_authed/settings/index.tsx#L44) |
| `/settings/activity` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | 沿用基线 | 个人措辞对齐 Bot Activity，搜索、过滤、导出有用。初读空白，读不到数据和导出失败需更直接的恢复。 [源码](../app/src/components/manage/audit-page.tsx#L274) |
| `/settings/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | **33/40（82.5%，暂定）** · [开关与窄屏复评](#个人审批设置复评) | 就近说明 Extra vigilant 与 Auto-review 的关系。默认安全规则可展开，权限拒绝后不显示缓存的审批设置控件。 |
| `/settings/browsers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **34/40（85%，暂定）** · [Recorder 设置复评](#recorder-设置复评) | 页首先进入分段的隐私说明，连接时明确提示在哪个标签页确认。刷新 503 保留上次列表，403 隐藏旧连接和操作。 [源码](../app/src/components/settings/browsers/browser-sections.tsx#L23) |
| `/settings/components-gallery/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 整改后待复评 | Personal/Team 的空态语义正确，预览帮助识别。已修并活体验证：首读骨架磁贴占位（四格）、读取失败改 curated 文案 + 原位 Retry（不再"Reload the page."）。 [源码](../app/src/routes/_authed/settings/components-gallery/index.tsx#L63) |
| `/settings/components-gallery/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | 整改后待复评 | 有预览、详情、返回及缺失状态。已修并活体验证：首读骨架占位、读取失败改单数 curated 文案 + 原位 Retry（不再"Reload the page."）。 [源码](../app/src/routes/_authed/settings/components-gallery/$name.tsx#L72) |
| `/settings/computer` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **33/40（82.5%，暂定）** · [设备操作复评](#设备操作确认与恢复复评) | 每个操作按钮都标明对应浏览器。重置确认先说明登录影响，更新成功后有回执。 |
| `/settings/credentials` | 2 · 3 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 23/40 · 57.5% | **37/40（暂定）** · [凭据与已保存登录项复评](#凭据与已保存登录项复评) | 清单、空态与添加入口统一使用 Keys。空态只保留一个添加入口。权限变更后隐藏旧条目。 |
| `/settings/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **38/40（暂定）** · [凭据与已保存登录项复评](#凭据与已保存登录项复评) | Add key 和 Save key 与清单一致。创建冲突聚焦提示，保存与替换后显示回执。 |
| `/settings/learning` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **35→E 后待复评** · [E 轮复评](#e-轮复评与整改) | 盲评 D 33.5，其最重的两条已修复并验证：两区块读取失败不再裸传"Fixture read failed"也不再吞掉节标题，改 curated 文案 + 原位 Retry；唯一待审提议的详情弹窗 404 死路（"Try again." 无按钮）由 fixture 端点 + 弹窗内 Retry 消除。写入（模式/逐技能开关、Learn now）当时即为满分样本。 [源码](../app/src/routes/_authed/settings/learning.tsx#L16) |
| `/settings/notifications` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **33/40（暂定）** · [顺序3盲评](#顺序3盲评与整改) | 盲评 D 33.0。已修并验证：设备与投递读取失败不再伪装成"No devices yet"假空态（curated 文案 + 原位 Retry，三条 Retry 键盘可恢复）；开启中的渠道若最近一次投递失败，开关旁现内联琥珀提示"Recent deliveries are failing."（错误原因在 tooltip，实测 SMS 两处、含 Number unreachable）。窄屏触区一项经核为评估环境误判：Astryx Switch 在粗指针下自动扩到 44×44 命中区（组件文档行为），Playwright 截图不激活该分支。 [源码](../app/src/routes/_authed/settings/notifications.tsx#L15) |
| `/settings/passwords` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | **37/40（暂定）** · [凭据与已保存登录项复评](#凭据与已保存登录项复评) | 空态提示与签入表单共用 Save this login 说法。503 保留已有清单，403 隐藏旧登录项及删除操作。 |
| `/settings/setup` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **39（暂定）** · [E 轮复评](#e-轮复评与整改) | 盲评 D 35.0。已修并验证：重查失败文案改"Couldn't check again. The list below is from the last check."（消除无按钮的"Try again."悬空句，并标明列表为上次结果）；fixture 补 `POST /api/setup/check` 并给出全绿五行数据后，"全绿隐藏清单"不复现——组件本就渲染全部行（实测 5 行 ready），D 的零行观察是 fixture 空 rows 所致；随之暴露的 Ready/Amber 药丸对比度缺陷（emerald-600/10% 底 3.3:1）已升为 700 档并通过 detector 复扫，同一修法同步到 what-if 结果药丸。余下："Check again" 为无边框文字按钮样式（H4）。 [源码](../app/src/components/setup/setup-checklist.tsx#L105) |
| `/settings/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（暂定）** · 同组件复评确认。 [E 轮复评](#e-轮复评与整改) | 与 `/admin/skills` 同一组件（skills-page），盲评 C 满分；个人版措辞差异未单独评。 [源码](../app/src/components/manage/skills-page.tsx#L62) |
| `/settings/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **31→E 后待复评** · 同组件。 [E 轮复评](#e-轮复评与整改) | 与 `/admin/skills/$slug` 同一组件（skill-page），盲评 D 36.0 及本轮修复（保存成功 toast、grants 落地）同样生效；个人版措辞差异未单独评。 [源码](../app/src/components/manage/skill-page.tsx#L117) |
| `/settings/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **36.5/40（暂定）** · [顺序3盲评](#顺序3盲评与整改) | 与 `/admin/skills/new` 同一组件（new-skill-page），盲评 D 36.5 及本轮修复（工具读取原位 Retry、脏表单 Cancel 先确认）同样生效。 [源码](../app/src/components/manage/new-skill-page.tsx#L28) |
| `/settings/this-computer` | 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 26/40 · 65% | **35/40** · [设备与凭据复评](#设备与凭据复评) | 已验证原位重试、停止与重启确认、取消焦点。服务停止后启动失败时，仅重试启动。浏览器入口缺桌面接续。 [源码](../app/src/routes/_authed/settings/this-computer.tsx#L82) |

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

## 基线浏览器与检测证据

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

## 设备与凭据复评

生产构建 `index-OPDOnrY6.js`。独立设计评审使用 Chromium 在 320、390 和 1280 像素视口采集 63 张截图，覆盖 Team 管理员、Personal 和模拟桌面接口。独立检测覆盖 22 个页面状态，均无横向溢出。检测发现设备组 23 条主要问题，包含 Browsers 的 18 处小字。凭据与保存登录项组有 7 条主要问题，新增凭据的占位文案对比度为浅色 3.9∶1、深色 4.45∶1。真实浏览器连接、Recorder、桌面服务控制、凭据写入及读屏待验。 [独立设计评审](/tmp/openbot-group-review/device-pages-a/assessment.md) [独立检测](/tmp/openbot-group-review/device-pages-b/browser-summary.json) [有数据时的检测](/tmp/openbot-group-review/device-pages-b/seeded-summary.json)

| 页面 | H1…H10 | 暂定分 |
|---|---|---:|
| `/browser` | 2 4 3 3 3 4 3 4 3 4 | 33/40 |
| `/settings/browsers` | 2 3 3 3 4 3 2 2 2 4 | 28/40 |
| `/settings/this-computer` | 2 3 2 3 2 4 2 3 2 3 | 26/40 |
| `/settings/computer` | 2 3 3 3 4 3 2 3 2 4 | 29/40 |
| `/admin/computers` | 2 3 3 3 4 3 2 2 2 4 | 28/40 |
| `/admin/credentials` | 4 4 3 3 3 4 2 3 3 3 | 32/40 |
| `/admin/credentials/new` | 3 3 4 3 3 3 2 3 3 3 | 30/40 |
| `/settings/credentials` | 4 3 3 3 3 4 2 3 3 3 | 31/40 |
| `/settings/credentials/new` | 3 3 4 3 3 3 2 3 3 3 | 30/40 |
| `/settings/passwords` | 4 4 3 3 4 3 2 4 3 4 | 34/40 |


### 凭据写入与桌面操作复评

生产构建 `index-BH8HLir3.js` 使用模拟 API 与桌面 IPC。独立设计评审在 320、390 和 1280 像素宽度下验证凭据首读、创建冲突、替换取消、陈旧目标和桌面服务部分失败。表单和确认的主要操作触区至少 44 像素。PostgreSQL 定向测试覆盖并发创建。真实部署写入权限、桌面服务、触屏和读屏待验。 [设计评审](/tmp/openbot-group-review/device-controls-final-a/assessment.md) [凭据测试](/tmp/openbot-group-review/credential-write-tests.log) [桌面测试](/tmp/openbot-group-review/desktop-controls-tests.log)

| 页面 | H1…H10 | 前次 | 暂定分 |
|---|---|---:|---:|
| `/admin/credentials/new` | 3 4 4 4 4 4 3 4 3 3 | 30/40 | **36/40** |
| `/settings/credentials/new` | 3 3 4 4 4 4 3 4 3 3 | 30/40 | **35/40** |
| `/settings/this-computer` | 4 3 4 3 4 3 3 4 4 3 | 26/40 | **35/40** |

独立检测在 Team 和 Personal 上通过 6 条流程、28 个渲染状态。首读期间按 Enter 未发送写请求，读取失败后的键盘重试保留表单并恢复标题焦点。重复创建触发重新读取，取消确认恢复到触发按钮且未写入，替换请求绑定到已确认的凭据 ID。确认说明对比度为浅色 5.86∶1、深色 6.37∶1。移动端未检出问题，8 个桌面状态各检出一条嵌套卡片提示。两种身份在创建冲突后仍需更明确的焦点和状态提示，Personal 的列表和表单命名也需统一。 [浏览器检测](/tmp/openbot-group-review/credential-write-b/final/browser-summary.json) [源码检测](/tmp/openbot-group-review/credential-write-b/final/source-detector.json)

This computer 在 320 像素深色模式下验证了四种停止和重启操作。确认默认聚焦取消，Escape 恢复触发按钮焦点且未写入 IPC。先停止后启动失败时，重试只调用启动，调用顺序为 `stop → start → start`。恢复后的数据页有三处 11.25 像素文字，重复的停止和重启标签也需在视觉上明确对应的服务。 [桌面检测](/tmp/openbot-group-review/credential-write-b/final/desktop-summary.json)

### 设备读取与重试复评

独立设计评审在当前开发构建验证 12 组设备与连接读取恢复，以及 12 组文件夹访问与 Bot 清单读取恢复。覆盖 Team 和 Personal，在 320、390 和 1280 像素宽度用键盘从 503 恢复到成功，并验证焦点回到受影响标题。三项 Browser 定向用例和 48 项 Recorder、Computer 测试通过。设计评审同时检查了页面信息密度与连续失败的后续路径，复评允许下调分数。 [独立设计评审](/tmp/openbot-group-review/device-recovery-a/assessment.md) [Browser 用例](/tmp/openbot-group-review/device-browser-keyboard-verified.log) [Recorder 与 Computer 用例](/tmp/openbot-group-review/device-settings-tests-final.log)

| 页面 | H1…H10 | 前次 | 暂定分 |
|---|---|---:|---:|
| `/browser` | 3 3 3 3 3 3 2 3 3 3 | 33/40 | **29/40** |
| `/settings/browsers` | 3 3 3 3 3 4 2 3 3 2 | 28/40 | **29/40** |
| `/settings/computer` | 3 3 3 3 3 4 2 3 3 2 | 29/40 | **29/40** |
| `/admin/computers` | 3 2 3 3 3 4 2 2 4 2 | 27/40 | **28/40** |

独立检测在开发构建通过 8 组浏览器检查，覆盖四条路由及 320 像素深色、1280 像素浅色。键盘重试后焦点返回对应标题，页面和主内容区无横向溢出。Browser 和 Browsers 在两个尺寸都保留缓存数据并提示状态。检测仍提示 Recorder 隐私区文字过小、Admin 设备说明过长和嵌入列表层级偏深。 [独立检测](/tmp/openbot-group-review/device-recovery-b/assessment.md) [Browser 与 Recorder 检测](/tmp/openbot-group-review/device-recovery-b/current/browser-summarybrowser,browsers.json) [设备清单检测](/tmp/openbot-group-review/device-recovery-b/current/browser-summarybrowsers,personal,admin.json)

生产构建 `index-D-2aFag0.js` 通过 Astryx 检查和 Web 类型检查。设备、录制、管理导航、Network 和 Permissions 共 98 项定向测试通过。Team 管理员的企业设置读取失败时，Idle computers 提供一个就地重试。成功后同时恢复闲置设置和 Network，焦点回到 Idle computers 标题。独立设计评审覆盖 320、390、1280 像素，评分仍为 **27/40**。故障期间 Network 区块消失，提示未说明重试会恢复两个区块。 [生产构建](/tmp/openbot-group-review/device-idle-verified-build.log) [定向测试](/tmp/openbot-group-review/device-checkpoint-tests.log) [共享管理组件测试](/tmp/openbot-group-review/device-idle-shared-tests.log) [设计评审](/tmp/openbot-group-review/device-idle-a/assessment.md)

独立检测在同一生产构建通过四条路由的 8 组恢复检查，以及企业设置在开发和生产构建上的 4 组检查。320 像素深色和 1280 像素浅色均恢复键盘焦点。Browser 和 Browsers 在后台刷新失败后仍显示上次读到的内容。Admin 的三处桌面检测提示涉及较长的说明和嵌套空态。以上均使用模拟 API。 [独立检测](/tmp/openbot-group-review/device-idle-b/assessment.md)

最终生产构建 `index-D2TPU9Us.js` 保留故障期间的 Network 标题。唯一的告警列出 Idle computers 和 Network，一次键盘重试同时恢复两区，焦点回到 Idle computers。设计评审的 3 组和独立检测的 2 组 Chromium 场景全部通过，涵盖 320、390、1280 像素与浅暗主题。恢复从 3 提升至 4 分，页面总分为 **28/40**。8 项共享管理组件测试、Web 类型检查及 Astryx 构建检查通过。真实设置写入、触屏和读屏待验。 [设计评审](/tmp/openbot-group-review/device-shared-status-a/assessment.md) [独立检测](/tmp/openbot-group-review/device-shared-status-b/assessment.md) [定向测试](/tmp/openbot-group-review/device-shared-status-tests.log)

### 设备清单与 Recorder 复评

生产构建 `index-BQiSr3hb.js`。设备清单分开呈现运行状态、归属和网络路径。长设备名、文件夹名和浏览器配置名在 320、390、1280 像素的夹具中完整换行。Recorder 的说明行字号为 13.125 像素，连接和断开控件高 48 像素。录制去向统一由对应版本的隐私披露说明。独立设计评审执行 12 组，独立检测执行 6 组，均通过预定场景。 [设计评审](/tmp/openbot-group-review/device-row-polish-a/final/assessment-a.md) [独立检测](/tmp/openbot-group-review/device-row-polish-b/assessment.md)

| 页面 | H1…H10 | 前次 | 暂定分 |
|---|---|---:|---:|
| `/admin/computers` | 3 3 3 3 3 2 2 3 3 3 | 28/40 | **28/40** |
| `/settings/computer` | 3 3 3 3 3 3 2 3 3 3 | 29/40 | **29/40** |
| `/settings/browsers` | 3 3 3 4 3 3 2 3 3 3 | 29/40 | **30/40** |

生产构建 `index-BwTl0NYT.js` 的独立设计复评仍为 **30/40**。在 320、390、1280 像素上取消断开可返回原按钮，断开成功聚焦回执，下一次 Tab 可到剩余连接的断开按钮。扩展取消或关闭后焦点回到 Connect，用户主动移走焦点时保留当前位置。两组独立检测验证 320 像素深色和 1280 像素浅色，移动端返回 0 项，桌面仍有两条披露文字行长提示和一条容器层级提示。该构建仍有成功连接后焦点落到页面正文的问题。 [独立设计评审](/tmp/openbot-group-review/recorder-focus-a/assessment-a-addendum.md) [独立检测](/tmp/openbot-group-review/recorder-focus-b/assessment.md)

设备操作的可访问名称需包含目标，重置和更新确认的触区仍偏小。真实扩展、桌面连接、读屏和实体触屏待验。60 项 Web 与扩展定向测试通过，随后针对 Recorder 改动复跑 25 项通过。 [定向测试](/tmp/openbot-group-review/device-row-final-tests.log) [Recorder 测试](/tmp/openbot-group-review/device-row-verified-tests.log)

生产构建 `index-BnFOxu1h.js` 的独立设计复评为 **29/40（72.5%）**，十项分为 **3 3 3 3 4 3 2 3 3 2**。10 组设计走查和 6 组独立 Chromium 验证覆盖 320、390、1280 像素与浅暗主题。连接成功聚焦可播报的 Connected 回执，用户已移走焦点时保持当前位置。独立检测也验证了受信任的直接连接和用 Shift+Tab 回到本浏览器的断开操作。桌面仍有两条披露行长和一条容器层级提示，源码及 320 像素检测返回 0 项。新版更新了对确认标签页、移动发现和不支持浏览器指引的评分。测试使用模拟 API 与扩展，真实跨标签交接和读屏播报待验。38 项定向测试、Web 类型检查、生产构建和 Astryx doctor 通过。 [设计评审](/tmp/openbot-group-review/recorder-success-a/assessment.md) [独立检测](/tmp/openbot-group-review/recorder-success-b/assessment.md) [定向测试](/tmp/openbot-group-review/recorder-success-tests.log)

## 治理七页复评

独立设计评审与独立检测使用当前生产构建 `index-BnFOxu1h.js`。桌面浅色与手机深色覆盖七页，额外抽查 Team 成员的 Admin 跳转及 Team 成员和 Personal 的 Approvals。十项分按总表顺序记录，模拟数据、身份和接口用于暂定分。 [设计评审](/tmp/openbot-governance-recheck/a/assessment.md) [逐项分数](/tmp/openbot-governance-recheck/a/scores.json)

| 页面 | H1…H10 | 基线 | 本轮暂定 | 优先整改 |
|---|---|---:|---:|---|
| `/admin/approvals/describe` | 3 3 3 3 2 3 3 3 2 3 | 28/40 | **28/40** | 改写描述后，仍可保存先前生成的规则。将保存资格绑定当前描述与候选规则。 |
| `/admin/approvals/guidance` | 3 3 3 3 4 3 2 3 2 3 | 27/40 | **29/40** | 编辑后旧检查立即失效。首读失败缺原位重试，窄屏 Check guidance 触区偏小。 |
| `/admin/audit` | 2 3 3 3 3 2 3 2 2 2 | 29/40 | **25/40** | 窄屏须横向滚动才能看到 Decision，视图切换也独立横滚。首读失败仅提示重载。 |
| `/admin/boundaries/new` | 3 3 2 3 3 3 3 3 2 3 | 28/40 | **28/40** | 切换模板清空自定义草稿，试运行返回校验错误后仍可提交。部署级作用范围清楚。 |
| `/admin/permissions/describe` | 3 3 2 3 2 3 2 3 2 3 | 28/40 | **26/40** | 已验证人员影响预览。源码显示改写描述后候选仍可保存，需校验候选版本。 |
| `/admin/what-if` | 2 3 2 2 2 2 3 3 2 3 | 29/40 | **24/40** | 已验证六层判定结果。读取失败缺原位重试，源码存在旧结果覆盖已编辑场景的风险。 |
| `/settings/approvals` | 2 2 2 3 2 3 2 3 2 3 | 24/40 | **24/40** | 读取失败仍显示可操作的默认开关和无规则提示。全部共享 Bot 同意项重置缺确认。 |

模拟浏览器验证 Permissions 显示受影响人员及权限前后差异，What if 显示六层判定并指出拒绝原因。Audit 的完整 CSV、截断提示和 503 错误均通过 Chromium 验证。13 个定向测试文件合计 49 通过、2 失败，两项失败均可独立重现，通用 `status` 查询匹配了 Astryx 的空播报区域。真实角色权限、持久化写入、供应商模型与读屏播报待验。 [预览验证](/tmp/openbot-governance-recheck/preview-browser.json) [导出验证](/tmp/openbot-governance-recheck/audit-export-browser.json) [测试日志](/tmp/openbot-governance-recheck/tests.log)

独立检测记录了 30 次 Chromium 截图、16 项交互检查和 14 次 URL 扫描。Team 成员访问六个 Admin 页面均回到工作区。Personal 的 Audit 转到 Settings Activity，另外五页转到 Settings General。源码扫描无主要发现。Approvals 的小字号警告在两个视口均复现，桌面另有行长警告。六条桌面嵌套卡片提示匹配共用设置壳，需结合实际布局判断。 [独立检测](/tmp/openbot-governance-recheck/b/assessment.md)

## 治理七页整改后复评

2026 年 11 月 22 日，独立设计与检测评审在生产构建上检查七个页面。默认场景使用 `index-CR-XHTFN.js`，Boundary 的提交防错在 `index-D-L94HvC.js` 复核，What if 的重查失败在最终构建 `index-C7O-WQWx.js` 复核。覆盖 1440×1000 浅色与 390×844 深色，使用英文界面与模拟接口。

| 页面 | H1…H10 | 上轮 | 本轮暂定 | 已验证的变化 | 剩余扣分 |
|---|---|---:|---:|---|---|
| `/admin/approvals/describe` | 3 3 2 3 3 3 2 3 3 3 | 28/40 | **28/40 · 70%** | 描述变动即阻止保存旧规则，预览失败可保留草稿重试。 | 旧解读与候选规则仍占据编辑区，取消缺少草稿保护。 |
| `/admin/approvals/guidance` | 3 3 3 3 3 3 2 3 3 3 | 29/40 | **29/40 · 72.5%** | 指导和回测样本读取可重试，复查失败撤销保存资格。删除失败在确认框内恢复。 | 安全说明偏长，缺少将草稿恢复到已保存版本的入口。 |
| `/admin/audit` | 3 2 3 3 3 2 3 2 3 2 | 25/40 | **26/40 · 65%** | 读取失败留在当前筛选，Refresh 原位恢复。切换筛选时隐藏上一组结果。 | 390px 下 Decision 仍需横滚，缺少滚动提示。视图切换按钮高 24px。 |
| `/admin/boundaries/new` | 3 3 3 3 4 3 3 2 3 3 | 28/40 | **30/40 · 75%** | 各起点保留草稿，生成中、描述变更或规则校验失败均拦截提交。策略冲突可原位刷新后重新确认。 | 手机上表单排在起点列表之后，选好起点仍需滚动。 |
| `/admin/permissions/describe` | 3 3 2 3 3 3 2 3 3 3 | 26/40 | **28/40 · 70%** | 提交绑定当前描述及人员影响预览，预览失败可重试。 | 描述改动后旧解读仍可见，移除单项后缺少原位撤销。 |
| `/admin/what-if` | 3 3 2 3 3 2 3 3 3 2 | 24/40 | **27/40 · 67.5%** | 迟到响应按场景丢弃，失败重查清除旧判定，词表读取支持原位重试。 | 缺少一步重置场景的入口，手机上的示例文本被截断。 |
| `/settings/approvals` | 3 3 3 3 4 3 2 2 3 3 | 24/40 | **29/40 · 72.5%** | 配置读取失败时隐藏未知默认状态并限制写入。重置共享 Bot 权限需确认，失败可在弹窗内重试。 | 手机首屏主要是安全说明，小字号和较小的开关触区仍待处理。 |

最终构建的 Chromium 检查通过 28/28，覆盖七页在两个视口的默认渲染和故障恢复，未记录未捕获的页面错误。Impeccable 的 14 次源码扫描无发现，14 次渲染扫描报告 15 条提示，包括 6 条嵌套容器、8 条过小字号和 1 条行长提示。审批设置的共享 Bot 说明在 390px 下被截断。Audit 的 Recording and export 缺少模拟接口数据，仅检查到错误态。

30 个定向测试文件共 148 项全部通过。Web 类型检查、Vite 生产构建、Astryx doctor、差异检查均通过。真实角色权限、持久化写入、模型返回、物理触屏和读屏播报仍待正式验收。审批规则批量保存还需验证服务端在响应丢失后的重复提交行为。

[独立设计评审](/tmp/openbot-governance-hardened/a/assessment.md) · [独立检测](/tmp/openbot-governance-hardened/b/assessment.md) · [测试日志](/tmp/openbot-governance-hardened/tests-delivery.log) · [Astryx doctor](/tmp/openbot-governance-hardened/doctor-delivery.log)

## Audit 与审批设置窄屏复评

2026 年 11 月 22 日，独立设计评审和自动检测使用生产构建 `index-B7LWiTQ9.js`。Chromium 模拟接口覆盖 320、390、768 和 1440px，设计评审查看 390px 深色与 1440px 浅色。

| 页面 | H1…H10 | 上轮 | 本轮暂定 | 剩余扣分 |
|---|---|---:|---:|---|
| `/admin/audit` | 3 2 3 3 3 3 3 3 3 2 | 26/40 | **28/40 · 70%** | 390px 下仍需在记录区纵向滚动，筛选触区偏小。模拟的 Approval requested 事件显示 Allowed，需用真实审计事件核对判定用词。 |
| `/settings/approvals` | 3 3 3 3 3 3 2 3 3 3 | 29/40 | **29/40 · 72.5%** | Extra vigilant 和 Auto-review 的组合效果缺少就近解释，重置及命令选择器触区偏小。 |

90 项定向测试、Web 类型检查、生产构建和 Astryx doctor 通过。模拟验证覆盖两页的宽度、Audit 时间排序、审批说明换行和重置弹窗焦点。真实设备和读屏播报仍待正式验收。

[设计评审](/tmp/openbot-governance-narrow/a/assessment.md) · [独立检测](/tmp/openbot-governance-narrow/b/assessment.md) · [宽度验证](/tmp/openbot-governance-narrow/responsive.json) · [测试日志](/tmp/openbot-governance-narrow/tests-verified.log)

## Audit 判定与窄屏触区复评

2026 年 11 月 22 日，独立设计评审与自动检测使用生产构建 `index-DHk-x-WY.js`。覆盖 Chromium 320×780 浅色、390×844 深色和 1440×950 浅色，使用按服务端契约构造的英文模拟事件。

| 页面 | H1…H10 | 上轮 | 本轮暂定 | 剩余扣分 |
|---|---|---:|---:|---|
| `/admin/audit` | 3 3 3 3 3 3 3 3 3 2 | 28/40 | **29/40 · 72.5%** | Why? 弹窗缺少明确的历史判定和当前策略标题，且使用 Refused 对应表格的 Blocked。320px 首条 Decision 仍需下滑，Ask 和侧栏按钮的触区偏小。 |

`approval.evaluated` 中的 `ask` 显示 Approval requested，人工批准和拒绝有独立文案。无明确放行或拦截的审批事件独立于本地 Allowed 分类。管理页按事件类型划分的其余查询已改称 Other events。浏览器验证了 320px 和 390px 下视图、搜索、筛选、刷新、导出、排序和 Why? 的触区均高 44 CSS px，移除筛选为 44×44，审计记录随页面纵向滚动。键盘排序更新 `aria-sort`，关闭说明后焦点回到触发按钮。Impeccable 源码扫描与三组视口扫描均为 0 项发现。 独立浏览器走查复现了两个问题。页内文字搜索只过滤已加载记录，CSV 导出仍按服务端视图和结构化条件取数。Why? 请求失败后需关闭弹窗再打开才能重试。

18 个定向测试文件共 77 项通过，Web 类型检查、生产构建和 Astryx doctor 通过。真实数据库、物理触屏、读屏播报和非英文内容待验。

[独立设计评审](/tmp/openbot-audit-review.GIcV1O/a/report.md) · [独立浏览器记录](/tmp/openbot-audit-review.GIcV1O/b/chromium.json) · [测试日志](/tmp/openbot-audit-review.GIcV1O/tests-final.log)

## 顺序3盲评与整改

2026 年 11 月 23 日凌晨，两名互相独立、不知整改历史的盲评员（C：管理六视图；D：设置与表单六视图）在生产构建与 40175 fixture 上按 Nielsen 十项打分。本轮整改先于盲评落地的部分已计入其分数；盲评后又落地一批修复并全部活体验证，下轮复评确认。

| 视图 | 盲评 | 本轮整改后状态 |
|---|---:|---|
| `/admin/skills`（与 `/settings/skills` 同组件） | C 40/40 | 保持。 |
| `/admin/proactive` | C 39/40 | 扣分点（ping 词汇）已修：行标题、平均值句式（整数不带 .0）、Bot 弹窗统计全部改为 check-ins，活体验证页面无 ping 残留。 |
| `/admin/components/$name` | C 38/40 | 两条扣分（失败 h1 降级、不可渲染仍可发布）已修并活体验证。 |
| `/admin/playground` | C 36/40 | Publish 先确认（Cancel 可退、确认后"Published."且清单行翻 published）；禁用按钮旁显示"Name and title are needed first."。写失败横幅沿用服务端消息为既定约定。 |
| `/admin/components/` | C 36/40 | 磁贴状态由仅色点改为标题内文字（· Published / · Draft）。余措辞变体与 fixture 图样占位两项待下轮。 |
| `/admin/skills/new`（与 `/settings/skills/new` 同组件） | D 36.5/40 | 工具读取失败改原位 Retry（保草稿）；脏表单 Cancel 先确认、干净表单直接返回。 |
| `/admin/skills/$slug`（与 `/settings/skills/$slug` 同组件） | D 36/40 | 保存成功"Skill saved" toast 活体验证（fixture 补 POST /api/plugins/skills）。 |
| `/settings/setup` | D 35/40 | 重查失败文案标明列表来自上次检查，消除悬空"Try again."；fixture 补 check 端点。 |
| `/settings/learning` | D 33.5/40 | 两区块 curated + 原位 Retry；提议详情 404 死路由 fixture 端点 + 弹窗内 Retry 消除。 |
| `/settings/notifications` | D 33/40 | 设备/投递失败不再伪装空态（curated + Retry）。SMS 数据场景提示与窄屏触区两项待下轮。 |
| `/routines/new` | D 33/40 | fixture 补 `POST /api/channels` 契约后创建端到端活体验证：无脚本错误、跳回 /routines 且新任务入列。 |
| `/admin/learning` | C 31/40 | 最重三条（裸服务端文本、区块无重试、提议弹窗死路）全修；失败运行无原因、九节纵排、fixture 数据重叠三项待下轮。 |

证据：`/tmp/openbot-order2-review/b3/`（24 组桌面浅色+窄屏深色截图/ARIA/JSON，重跑于整改后构建，18 条失败路径全部键盘原位恢复、0 页面错误、0 横向溢出）、`assessorC-report.md`、`assessorD-report.md`、`verify-cd-fixes.mjs`（17 项断言全过）。`$impeccable detect` 复扫五个改动视图仅剩全站两项基线（tiny-text 小字约定、PageRows 嵌套卡片），无低对比度发现。类型检查通过，定向 6 文件 134 项测试通过（learning-sharing 期望文案随修复更新）。

### 收官后追加批（同日第四批）

盲评记录的余项清完并全部活体验证：Learning 九节重排（审阅工作流先行，Participation 第三）；技能编辑返回栏脏离开守卫（含 PageShell linkProps 铺开顺序修正）；组件"无法绘制"措辞统一；Notifications 开启渠道的投递失败内联提示；Setup fixture 补全绿五行后确认清单不隐藏，并连带修掉 Ready/Amber 药丸 3.3:1 对比度（emerald/amber-600→700，同步 what-if 结果药丸，detector 复扫 0 low-contrast）；窄屏开关触区经组件文档核实为粗指针下自动 44×44，判为评估环境误判。定向测试 30 项通过（setup 药丸断言随配色更新）。

全站已知项（跨批次跟踪，不计单页扣分）：base-ui 1.7.0 对话框 Tab 焦点泄漏；736px prose 行宽；"Weekly digest" 同现两节为 fixture 数据重叠（p2 与已发布技能同名），考虑改 fixture 命名。

## E 轮复评与整改

2026-11-23 凌晨，盲评 E（不知整改历史）对顺序3 的 12 个视图复评，随后其发现经甄别落地一批修复并全部活体验证（`/tmp/openbot-order2-review/assessorE/`、`verify-eround.mjs`、`verify-final.mjs`、`debug-*.mjs`）。

| 视图 | E 分 | E 轮整改后状态 |
|---|---:|---|
| /admin/skills（含 /settings/skills） | 40 | 保持满分（E 逐一复核了 Retry 恢复与键盘可达）。 |
| /admin/components/ | 40 | 保持（状态行内可见、行可键盘达）。 |
| /admin/proactive | 40 | 保持（写失败回滚+文案被评为正面样本）。 |
| /settings/setup | 39 | "Check again 无反馈"为 fixture 零延迟假象；真实检查有 Checking… 进行态。 |
| /routines/new | 38 | Bot 下拉读失败改为"Couldn't load your Bots."+Retry（活体验证）。 |
| /admin/components/$name | 38 | 失败标题 camel 拆词（Claim summary）、错误文案改单数；横幅与 Available-to 弹窗措辞矛盾记录待下轮。 |
| /settings/notifications | 37 | 读失败下的"No devices yet"/"No deliveries yet"假空态消除（错误分支不再渲染空态）；开关静默写失败补"Couldn't save that. The switches show what the server last saved."。 |
| /admin/skills/new | 36 | 静默保存失败补"Couldn't save this skill. Your edits are still on screen."（活体验证）。 |
| /admin/learning | 35 | roster 读失败时容器选择器不再显示裸 ID，改"Couldn't load the Bot list."+Retry（活体验证）。"Fixture read failed"为评审染料：SectionReadError 按测试固化的契约优先显示服务端句子，真实服务端文案面向用户。 |
| /settings/learning | 35 | 开关写失败显示服务端句子（直通契约）位于节尾，位置与重试入口记录待下轮。 |
| /admin/playground | 33 | "Saved here"读失败显示"Couldn't load what's saved here."+Retry（不再伪装空态）；写失败横幅改"Couldn't save. Your edits are still on screen."。 |
| /admin/skills/$slug（含 /settings 同组件） | 31 | 四组扣分全修并活体验证：保存成功即解除脏态（守卫不再误报）、未改动禁用 Save changes、开关写失败显示"Couldn't change which Bots offer this skill. Try again."、失败/加载标题由 slug 生成（Weekly Digest）。 |

同时修正评审工具两处：fixture 的 grants DELETE 分支补 writeerror 守卫（此前只有 POST 失败，低估了写路径）；/api/agents 可见/隐藏两个查询分开计数（共享计数曾让失败槽位被另一查询消耗）。E 的三条批次级结论：泄漏的评审染料文案（部分为契约内直通）、静默失败（本轮全部补上反馈）、技能编辑器脏/存态（本轮全修）。E 观察的"节流下首屏约 1s 白屏"记录为全站基线（SPA 装载期）。

E 轮整改后定向 13 文件 133 测试通过、tsc/biome 净；audit/what-if 的 7 组新 fixture 端点随本轮启用并活体验证（Why? 弹窗 Recorded decision/With current policy 完整渲染）。

## 治理草稿与 Audit 整改验证

2026-11-23，沿用 Web 评分范围，以生产构建 `index-BIRqwy5j.js` 复验以下四页。此批记录具体扣分项的整改证据，完整十项分数待独立复评。

| 页面 | 已验证的改动 | 待复评 |
|---|---|---|
| `/admin/permissions/describe` | Undo 恢复本次草稿的移除项，重写后清除旧撤销记录。取消离开时原文保留，确认后回到 Permissions。 | 真实部署的权限变更、不同角色和读屏。 |
| `/admin/approvals/describe` | Undo 将移除的规则放回原位置，重写后清除旧撤销记录。取消离开时原文保留，确认后回到 Approvals。 | 编辑长草稿的效率、真实模型和读屏。 |
| `/admin/audit` | 提问示例在输入框外完整显示，按 Enter 可提交问题。录制记录遇到 503 后，可用键盘在原位重试。修正无人值守状态在浅色拒绝行上的低对比度，保留录制设置说明全文。 | 满数据、真实模型和读屏。 |
| `/admin/what-if` | Ask 按钮禁用时，可编辑的输入框保持正常对比度。示例文字放大到正文辅助字号。 | 完整规则判定、真实模型和读屏。 |

两个草稿页沿用浏览器原生离开确认，覆盖页面链接和刷新。保存成功后直接返回列表。Chromium 1440×900 浅色和 390×844 深色共通过六条交互流程。Impeccable 渲染扫描覆盖两种宽度的四页初始状态，窄屏 0 项，桌面有四条共享页面框架下的嵌套容器提示。扫描未发现低对比度。21 项前端测试和 25 项服务端测试通过，其中审批规则持久化使用专用 PostgreSQL 测试库。

[Audit 窄屏截图](/tmp/openbot-order2-review/audit-question-example/390x844.png) · [提问和录制恢复流程](/tmp/openbot-order2-review/verify-audit-question.mjs) · [治理草稿复验](/tmp/openbot-order2-review/verify-describe-rewrite.mjs) · [窄屏检测](/tmp/openbot-order2-review/governance-rewrite-390x844-detect.json) · [桌面检测](/tmp/openbot-order2-review/governance-rewrite-1440x900-detect.json)

## What-if 键盘与窄屏复验

2026-11-23，生产构建 `index-CjsiJTTE.js` 的本地暂定分 **32/40（80%）**。上次独立复评为 27/40。本次 Chromium 使用 Team 管理员模拟身份与服务端录制的六层判定，比较 1440×900 浅色、390×844 深色与 320×844 深色。

| H1…H10 | 证据与扣分 |
|---|---|
| 4 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 3 · 3 | Ask、Check 与重试都有处理反馈，成功后焦点跟随解读与判定。始终可见的示例、具名动作字段及判定依据降低记忆负担。页面标题与导航词不同，Audit 的 Blocked 对应此页的 Refused。更换页面会放弃当前场景。编辑问题时能区分旧解读，仍可检查旧动作。320 像素下完整细节需要较长滚动。失败可原键重试，错误说明与规则字段仍需统一成面向管理员的语言。规则链接提供情境帮助，陌生术语仍需离开当前场景查询。 |

三种视口均验证 Ask、503 后键盘原位重试、完整判定和 Start over。等待判定时把焦点移回提问框，返回结果会保留该焦点。无横向溢出和页面异常。源码、320 与 390 像素初始状态检测为 0 项，1440 像素仍有一条共享页面容器提示。18 项前端测试和 24 项服务端测试通过。使用专用 PostgreSQL 测试真实策略判定和 API 角色限制，提问模型使用录制响应。正式验收还需真实模型、实体触屏和读屏。

[320 像素判定截图](/tmp/openbot-order2-review/what-if-polish/result-320.png) · [桌面判定截图](/tmp/openbot-order2-review/what-if-polish/result-1440.png) · [浏览器复验](/tmp/openbot-order2-review/verify-what-if-polish.mjs) · [桌面初始检测](/tmp/openbot-order2-review/what-if-polish/detect-1440x900.json)

## What-if 判定语义整改

页面和导航均显示 Test a policy。What-if 结果与 Audit 使用 Blocked 表示被拦截。未执行的行显示 Not reached，其推演解释可展开查看。触发判定的名称与原因仍直接可见，完整规则表达式可按需展开。

生产构建 `index-Cvnjgc3c.js` 的本地暂定分为 **33/40（82.5%）**，十项分数为 **4 · 3 · 3 · 4 · 3 · 4 · 3 · 3 · 3 · 3**。H4 从 3 升至 4，页面标题、侧栏和 Audit 判定已对齐。320、390 和 1440 像素 Chromium 均验证焦点、失败重试、展开状态和完整六层判定。两种窄屏初始状态的 Impeccable 检测为 0 项，桌面仍有一条嵌套容器提示。10 项定向测试通过。仍需复验跨页场景保留、规则术语帮助、真实模型、触屏与读屏。 [浏览器日志](/tmp/openbot-order2-review/what-if-verdict-browser.log) · [窄屏截图](/tmp/openbot-order2-review/what-if-verdict/result-320.png) · [测试日志](/tmp/openbot-order2-review/what-if-verdict-tests.log)

## Routines 刷新失败时的恢复

例行任务清单和运行历史在后台读取出现网络错误或服务端错误后保留上次成功加载的记录，显示原位 Retry。服务返回 403 后隐藏对应记录，避免把访问失败显示为真正的空清单。独立 Bot Routines 页和工作区入口共用此逻辑。

10 项定向测试通过。开发构建在 1440×900 浅色和 390×844 深色验证 503 后记录仍可见、键盘原位重试、403 后缓存记录隐藏且不出现空态。源码检测为 0 项。工作区 Routines 仍沿用 28/40，完整界面复评待补。 [窄屏截图](/tmp/openbot-order2-review/routines-cache/routines-retained-390.png) · [浏览器日志](/tmp/openbot-order2-review/routines-cache-browser.log) · [测试日志](/tmp/openbot-order2-review/routines-cache-tests.log)

## Routines 触控与暂停复评

工作区 `/routines` 的本地暂定分为 **32/40（80%）**。上一轮为 28/40。状态流程提供初次读取、后台刷新失败与原位重试反馈。暂停可反向恢复，操作名称和删除确认指向任务，取消后焦点回到原按钮。创建、立即运行、历史和删除的触区均至少 44×44 CSS 像素。暂停后保持任务文字对比度，开关的轨道和焦点在浅色及深色可辨。

评分仍扣分的场景包括会话与 Bot 同名时的上下文区分、长指令在清单上的截断、立即运行前的就地提示、较长清单的定位效率，以及写入失败的进一步恢复。实测使用本地开发构建和模拟 API，覆盖 1440 像素工作区浅色、390 像素工作区深色及 320 像素 Bot Routines 深色。15 项定向测试通过。新的工作区页面两种视口初始状态 Impeccable 检测均为 0 项。真实调度、实体触屏与读屏仍待验。

[390 像素暂停截图](/tmp/openbot-order2-review/routines-touch/paused-390.png) · [320 像素 Bot 暂停截图](/tmp/openbot-order2-review/routines-touch/paused-320.png) · [浏览器日志](/tmp/openbot-order2-review/routines-touch-browser.log) · [测试日志](/tmp/openbot-order2-review/routines-touch-tests.log)

## Routines 写入反馈复评

生产构建 `index-cfY7HxE9.js` 的工作区 Routines 暂定为 **33/40（82.5%）**。上一轮为 32/40。H9 从 3 升至 4。后台读失败保持已读记录并可重试，写入失败紧贴该任务，失败的开关保留已确认状态。临时故障提示原位恢复，明确拒绝保留服务端原因。手动启动失败显示对应任务和原因。Bot 与会话同名时，消息图标及无障碍名称标明会话链接。

回归测试在整改前复现第二条任务保存时第一条提前可用。整改后 16 项测试通过。生产版在 1440×900 工作区和 390×900 Bot Routines 使用模拟 API 验证并发保存、单行失败、启动失败和乱序响应。较早的启动请求返回时，界面保留用户后来打开的历史。工作区 1440×900 与 390×844 的 Impeccable 初始扫描均为 0 项。长指令展示、长清单定位、真实调度与读屏仍待复验。

[失败截图](/tmp/openbot-order2-review/routines-writes/production/write-error-390.png) · [生产版复验日志](/tmp/openbot-order2-review/routines-writes-production.log) · [整改前回归](/tmp/openbot-order2-review/routines-writes-before.log) · [整改后测试](/tmp/openbot-order2-review/routines-writes-tests.log)

## 管理清单读取与恢复复评

2026-11-23，使用管理员模拟身份对两个管理入口进行本地暂定复评。Chromium 验证宽度为 1440、390 和 320 CSS 像素。

| 页面 | H1…H10 | 最新暂定分 | 证据与待验 |
|---|---|---:|---|
| `/admin/people` | 4 · 3 · 4 · 3 · 4 · 3 · 3 · 3 · 3 · 2 | **32/40（80%）**，此前 28/40 | 503 后保留已读人员，分页按钮保持焦点并可用 Enter 重试。最后一页成功后聚焦 Who is here。角色以文字呈现，窄屏三项行操作完整可达。大量记录的查找效率、真实角色变更和读屏待验。 |
| `/admin/identity-providers` | 4 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 | **30/40（75%）**，此前 27/40 | 首读失败没有空态，重试成功聚焦 Registered。503 保留已读提供商，403 隐藏缓存。移除预检失败无写入。长 issuer 换行，移除操作在窄屏独立成行。Require SSO 的影响提示和真实身份回跳待验。 |

10 项定向测试通过，生产构建 `index-DJILYxvY.js` 在三种视口使用模拟 API 复验通过。触区以 CSS 最小高度和布局高度核对，避免动画中的坐标浮点误差。Impeccable 对两页源码的检测为 0 项。默认数据的渲染扫描仍发现 Sign-in 区两处 11.25 像素说明文字，以及桌面两页各一项嵌套容器提示。正式验收仍待补。

[生产版浏览器日志](/tmp/openbot-order2-review/admin-directory-production-browser.log) · [People 窄屏重试](/tmp/openbot-order2-review/admin-directory-production/people-pagination-320.png) · [Identity providers 窄屏恢复](/tmp/openbot-order2-review/admin-directory-production/identity-recovered-320.png) · [桌面渲染检测](/tmp/openbot-order2-review/admin-directory-production/detect-1440x900.json)

## Identity providers 登录策略复评

`/admin/identity-providers` 暂定 **32/40（80%）**，上一轮为 30/40。H1–H10 为 4 · 3 · 3 · 3 · 4 · 3 · 3 · 3 · 4 · 2。H5 增 1 分，Require SSO 启停都先确认，启用时说明退出会话的影响及例外，取消后焦点回到开关。H9 增 1 分，缺少已注册提供商时显示服务端给出的前置条件；策略已保存但会话清理失败时刷新开关状态，并保留原因和恢复按钮，允许提交相同策略以完成清理。

生产构建 `index-BuBthknZ.js` 在 1440 像素浅色及 390、320 像素深色以管理员模拟 API 复验。三种视口均通过键盘取消、409 拒绝、503 部分保存、关闭后重试、重新允许其他登录方式和焦点恢复，页面无横向溢出或浏览器运行时异常。Sign-in 两处说明从 11.25 增至 13.125 CSS 像素。Impeccable 源码及 320 像素扫描为 0 项，桌面仍报告一项共用行容器嵌套提示。13 项前端定向测试和 5 项独立 PostgreSQL 集成测试通过。服务端实测覆盖前置条件、重试后的会话清理和例外账户保留。外部 SAML/OIDC 回跳、浏览器到真实服务的完整任务和读屏仍待验。

[生产版浏览器日志](/tmp/openbot-order2-review/sign-in-policy-production.log) · [320 像素部分保存提示](/tmp/openbot-order2-review/sign-in-policy/partial-dialog-320.png) · [320 像素原位恢复](/tmp/openbot-order2-review/sign-in-policy/recovery-320.png) · [桌面渲染检测](/tmp/openbot-order2-review/sign-in-policy/desktop-detect.json) · [服务端集成测试](/tmp/openbot-order2-review/sign-in-policy-server.log)

## 技能与记忆读取恢复复评

| 页面 | H1…H10 | 最新暂定分 | 分值变化依据 |
|---|---|---:|---|
| `/capabilities/skills` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3 | **31/40（77.5%）**，此前 28/40 | H1 编辑链接明确显示加载与失败。H7 主操作、行菜单和菜单项均达到 44 CSS 像素高，极长标题不挤出菜单。H9 从侧栏原位重试，恢复后聚焦 Edit skill。 |
| `/capabilities/memory` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 2 · 4 · 2 | **30/40（75%）**，此前 26/40 | H1 首读失败、真实空列表及保留旧记录分别呈现。H6 开关有可见标签，逐行按钮以记忆内容命名。H7 行操作达到 44 CSS 像素高，长文本可换行。H9 清单可原位重试，编辑失败后可用原草稿再次保存。 |

两页生产构建 `index-tNdWv9f1.js` 使用管理员模拟身份，在 1440 像素浅色及 390、320 像素深色通过复验。记忆删除取消或预检失败均无写入，删除成功回到 Remember a fact。技能菜单删除支持取消，成功移除后回到 New skill。36 项定向测试通过，Impeccable 源码扫描为 0 项。真实技能授权、记忆实际使用范围、长清单定位和读屏仍待验。

[三种宽度的生产版浏览器日志](/tmp/openbot-order2-review/memory-skills-final-production.log) · [320 像素记忆列表](/tmp/openbot-order2-review/memory-skills/memory-loaded-320.png) · [320 像素技能列表](/tmp/openbot-order2-review/memory-skills/skills-loaded-320.png) · [定向测试](/tmp/openbot-order2-review/memory-skills-tests.log)

## 团队审批读取复评

共享账户决策基线在 1440 和 320 像素复现两项缺口。请求读取连续两次失败时整个区块消失，点击 Approve 会立即提交模拟写请求。待补区块内恢复与确认。 [共享账户基线](/tmp/openbot-order2-review/shared-account-baseline.log)

`/admin/approvals` 暂定 **29/40（72.5%）**，此前 27/40。H1–H10 为 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 4 · 2。H1 从 2 到 3，加载期间显示进度，首读 503 时隐藏未取得的设置与规则，成功空响应才显示 No team rules。H9 从 3 到 4，统一错误文案并提供 Retry，键盘恢复后焦点回到 Approvals。生产构建 `index-tNdWv9f1.js` 在 1440 CSS 像素浅色及 320 CSS 像素深色使用管理员模拟 API 验证 503 后成功恢复，2 项团队设置测试通过。共享账户决策、真实审批服务与读屏仍待复验。

[整改前](/tmp/openbot-order2-review/admin-approvals-read-before.log) · [生产版复验](/tmp/openbot-order2-review/admin-approvals-read-production.log) · [320 像素读取失败](/tmp/openbot-order2-review/admin-approvals-read-after.png)

## 边界详情历史回放复评

`/admin/boundaries/$index` 暂定 **31/40（77.5%）**，此前 28/40。H1–H10 为 3 · 4 · 3 · 3 · 3 · 3 · 2 · 3 · 4 · 3。H1 提升，规则与历史回放都显示加载和错误状态。H2 提升，历史回放明确比较记录中的判定与移除规则后的判定，并说明 Trial mode 可以记录拒绝而让动作继续。H9 提升，两处失败均可原位重试，回放成功后焦点回到回放标题。

生产构建 `index-COVDJp0n.js` 在 1440 像素浅色与 320 像素深色使用管理员模拟 API 验证双 503 恢复、回放结果、颜色及 44 CSS 像素的移除按钮。Impeccable 改动文件源码扫描为 0 项。按位置寻址的旧书签、真实审计记录、实际编辑与读屏仍待复验。 [两种视口生产版日志](/tmp/openbot-order2-review/boundary-replay-production.log) · [320 像素失败状态](/tmp/openbot-order2-review/boundary-replay-error-320.png)

## 边界列表与试运行复评

`/admin/boundaries` 暂定 **32/40（80%）**，此前 28/40。H1–H10 为 3 · 4 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3。H1 提升，初次读取显示进度，失败时区分旧数据与当前策略。H2 提升，试运行说明区分记录中的拒绝和实际拦截。H7 提升，较长规则以有限行数预览，窄屏可继续浏览其余设置。H9 提升，读取可原位重试，成功后焦点回到 Boundaries。取消、提交前 503 及陈旧确认均无写入，重试成功后回到 Trial mode 开关。写入成功后的刷新若失败，开关保留服务端已确认的新模式并显示读取提示。

生产构建 `index-B5YBQTEZ.js` 在 1440、390 和 320 CSS 像素以管理员模拟 API 复验。边界相关前后端定向测试 90 项通过。本机并发负载较高，复跑放宽了 Testing Library 等待上限。真实审计与执行、长清单定位和读屏仍待验。 [定向测试](/tmp/openbot-order2-review/boundary-final-tests-stable.log) · [生产版浏览器日志](/tmp/openbot-order2-review/boundary-list-current-production.log) · [320 像素试运行](/tmp/openbot-order2-review/boundary-list-trial-320.png)

## 设备操作确认与恢复复评

| 页面 | H1…H10 | 最新暂定分 |
|---|---|---:|
| `/admin/computers` | 4 · 2 · 3 · 3 · 4 · 4 · 3 · 2 · 4 · 2 | **31/40（77.5%）**，此前 28/40 |
| `/settings/computer` | 4 · 3 · 3 · 3 · 4 · 4 · 3 · 3 · 4 · 2 | **33/40（82.5%）**，此前 29/40 |

H1 提升，更新有明确回执。H5 提升，重置或更新提交前重新读取目标，发现变动时停止提交。H7 提升，同行按钮以设备命名，重置按钮实测至少 44×44 CSS 像素。Personal 的 H9 提升，确认前读取失败可原位重试，收到结果不明的写入回复后提示先核对状态和 Activity。Team 对应提示指向 Audit。

生产构建 `index-zVVzWTgm.js` 用独立的 Team 与 Personal 模拟 API 复验，覆盖 Team 1440 像素浅色、Team 320 像素深色和 Personal 390 像素深色。三组均通过取消无写入、写入前读取失败重试、重置结果不明时停止重试、设备变化拦截更新及更新回执后的焦点恢复。34 项定向测试通过，Impeccable 源码扫描为 0 项。停止浏览器的失败仍提示在列表顶部，真实设备、实体触屏和读屏仍待验。

[生产版浏览器日志](/tmp/openbot-order2-review/device-action-production.log) · [窄屏重置提示](/tmp/openbot-order2-review/device-reset-uncertain-team-320.png) · [定向测试](/tmp/openbot-order2-review/device-action-tests.log)

## Teach a Bot 连接与录像恢复复评

`/browser` 暂定 **33/40（82.5%）**，此前 29/40。H1–H10 为 4 · 3 · 4 · 3 · 3 · 3 · 3 · 3 · 4 · 3。H1 提升，已关闭的浏览器区分连接中和连接失败。H3 提升，键盘重试成功后焦点回到浏览器区域。H7 提升，重开按钮实测至少 44×44 CSS 像素，录像列表可独立重试。H9 提升，录像列表恢复后焦点回到 Your recordings，状态刷新 503 保留画面，403 移除旧画面及导航入口。

生产构建 `index-Dxe1OqEJ.js` 使用模拟 API 在 1440 像素浅色、390 像素深色及 320 像素深色通过复验。87 项定向测试通过，Impeccable 源码扫描为 0 项。真实浏览器串流、录制回传、实体触屏和读屏仍待验。 [生产版浏览器日志](/tmp/openbot-order2-review/browser-reopen-production.log) · [窄屏重开失败提示](/tmp/openbot-order2-review/browser-reopen-failed-320.png) · [定向测试](/tmp/openbot-order2-review/browser-reopen-tests-verified.log)

## 审批指导草稿复评

`/admin/approvals/guidance` 暂定 **33/40（82.5%）**，此前 29/40。H1–H10 为 3 · 3 · 4 · 3 · 4 · 3 · 3 · 4 · 3 · 3。H3 提升，恢复已保存的指导前可取消，恢复后焦点回到编辑框。H5 提升，带未保存草稿离开时提示确认，恢复会清除仅适用于旧草稿的检查和回测结果。H7 提升，Check guidance 实测至少 44 CSS 像素高。H8 提升，表单保留安全摘要，细则可用键盘展开。

生产构建 `index-Dfap6-5y.js` 在 1440、390 和 320 CSS 像素使用管理员模拟 API 复验，三种视口均通过离开确认、恢复取消、恢复后焦点、恢复无写入、安全规则展开和正式保存。25 项定向测试通过，Impeccable 源码扫描为 0 项。真实模型回测、多人同时编辑、实体触屏和读屏仍待验。 [生产版浏览器日志](/tmp/openbot-order2-review/guidance-draft-production.log) · [窄屏恢复状态](/tmp/openbot-order2-review/guidance-restored-320.png) · [定向测试](/tmp/openbot-order2-review/guidance-draft-tests.log)

## 个人审批设置复评

`/settings/approvals` 暂定 **33/40（82.5%）**，此前 29/40。H1–H10 为 3 · 4 · 3 · 3 · 4 · 3 · 3 · 4 · 3 · 3。H2 提升，明确 Extra vigilant 适用于规则尚未决定的变更，关闭它时 Auto-review 仍可能要求审批或交还操作。H5 提升，权限拒绝后不显示缓存的审批设置控件。H7 提升，两个开关的命中区、命令选择器和共享 Bot 权限重置按钮实测至少 44 CSS 像素高。H8 提升，默认规则放入可用键盘展开的说明。

生产构建 `index-BU4M_ID0.js` 在 Team 1440 像素浅色、Team 320 像素深色和 Personal 390 像素深色使用模拟 API 复验。组织强制 Auto-review、个人偏好写入、权限拒绝隐藏控件、Team 重置确认与 Personal 无团队控件均通过。62 项前后端定向测试通过，Impeccable 源码扫描为 0 项。真实审批结果、实体触屏和读屏仍待验。 [生产版浏览器日志](/tmp/openbot-order2-review/approval-settings-usability-production.log) · [Team 窄屏](/tmp/openbot-order2-review/approval-settings-team-320.png) · [定向测试](/tmp/openbot-order2-review/approval-settings-usability-final-tests.log)

## 管理首页设置搜索复评

`/admin/` 暂定 **34/40（85%）**，此前 29/40。H1–H10 为 4 · 3 · 4 · 4 · 3 · 4 · 3 · 3 · 3 · 3。H1 提升，搜索结果数量和无匹配状态可见。H3 提升，Enter 聚焦首条结果、返回恢复原查询、清空后焦点回到搜索框。H7 提升，16 个入口可按名称、分组及任务描述查找。H9 和 H10 提升，空结果提示可改用设置名称或任务查找，并保留清空入口。

生产构建 `index-D8wQvtEq.js` 在 1440、390 和 320 CSS 像素使用模拟身份复验搜索、键盘交互、浏览器返回及 44 CSS 像素的搜索与清空触区。普通 Team 成员和 Personal 用户的管理页跳转也通过。2 项相关导航与搜索测试通过，Impeccable 源码扫描为 0 项。真实账号、读屏和更多实际用语仍待验。 [生产版浏览器日志](/tmp/openbot-order2-review/admin-search-production.log) · [320 像素命中结果](/tmp/openbot-order2-review/admin-search-match-320.png) · [相关测试](/tmp/openbot-order2-review/admin-search-tests.log)


## Recorder 设置复评

`/settings/browsers` 暂定 **34/40（85%）**，此前最新独立复评为 29/40。H1–H10 为 3 · 4 · 3 · 3 · 4 · 4 · 3 · 3 · 4 · 3。H2 提升，连接等待状态指明浏览器标签栏里的 OpenBot Recorder 标签页和 Connect 按钮。H6 与 H7 提升，页首的 Set up Recorder 可用键盘直接聚焦隐私说明标题，触区至少 44 CSS 像素。说明按采集范围、去向与用途分段，Team 和 Personal 各显示对应去向，六类采集内容仍在连接操作之前。不支持扩展的浏览器提示改用桌面 Chrome 或 Edge。H9 提升，503 保留已读列表，403 隐藏旧条目及操作，键盘重试成功后焦点回到 Connected browsers。

生产构建 `index-Dsg-92Le.js` 在 Team 1440 像素浅色、Team 320 像素深色和 Personal 390 像素深色使用本地模拟 API 复验。另在独立 Chromium 配置中加载 Recorder 的发布版构建，使用本地模拟 API 验证实际确认标签页会显示请求地址，取消不交换连接码，确认只交换一次，并聚焦网页 Connected 回执。39 项 Web、扩展和共享披露测试通过，Impeccable 改动文件源码扫描为 0 项。正式商店安装、真实服务、实体触屏和读屏仍待验。 [生产版浏览器日志](/tmp/openbot-order2-review/recorder-setup-production.log) · [扩展交接日志](/tmp/openbot-order2-review/recorder-extension-browser.log) · [320 像素隐私说明](/tmp/openbot-order2-review/recorder-setup-disclosure-320.png) · [定向测试](/tmp/openbot-order2-review/recorder-setup-tests.log)


## 凭据与已保存登录项复评

| 页面 | H1…H10 | 前次 | 最新暂定分 |
|---|---|---:|---:|
| `/admin/credentials` | 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 4 · 3 | 32/40 | **37/40（92.5%）** |
| `/settings/credentials` | 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 4 · 3 | 31/40 | **37/40（92.5%）** |
| `/admin/credentials/new` | 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 3 | 36/40 | **38/40（95%）** |
| `/settings/credentials/new` | 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 3 | 35/40 | **38/40（95%）** |
| `/settings/passwords` | 4 · 4 · 3 · 4 · 4 · 3 · 3 · 4 · 4 · 4 | 34/40 | **37/40（92.5%）** |

两种凭据清单都只留一个添加入口，Personal 版的入口、清单和表单统一用 Keys。创建冲突可保留输入，焦点停在说明。创建和替换成功后回到清单并显示回执。已保存登录项的空态与网站签入表单使用同一文案。凭据和登录清单在 503 时标记保留上次读到的条目，在 403 时移除旧条目和操作。通过键盘重试恢复后，焦点回到清单标题。添加、撤销和删除的触区实测至少 44×44 CSS 像素。

生产构建 `index-CaH921jc.js` 使用本地模拟 API，覆盖 Team 1440 浅色、Team 390 深色、Personal 1440 浅色和 Personal 320 深色。四组均通过创建、创建冲突、取消替换、确认替换、清单 503 与 403 恢复、删除和签入表单文案校验，窄屏长站点地址无横向溢出。31 项定向测试通过，Impeccable 扫描 4 个前端文件无检测项。仍需验证真实服务权限、实体触屏和读屏。按已有凭据查找替换入口和排查使用方仍需额外步骤。 [生产版浏览器日志](/tmp/openbot-order2-review/credential-recovery-browser.log) · [320 像素恢复状态](/tmp/openbot-order2-review/credential-recovered-key-320.png) · [定向测试](/tmp/openbot-order2-review/credential-recovery-tests.log)


## 应用目录加载、搜索与添加复评

| 页面 | 前次 | 最新暂定分 |
|---|---:|---:|
| `/admin/plugins/arcade` | 30/40 | **39/40（97.5%）** |
| `/admin/plugins/composio` | 30/40 | **39/40（97.5%）** |
| `/connections/browse/arcade` | 36/40 | **39/40（97.5%）** |
| `/connections/browse/composio` | 36/40 | **39/40（97.5%）** |

H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。四个入口共用同一目录页，确认当前服务后才发目录请求。搜索时不显示上一次结果，清空可用键盘完成并让焦点回到搜索框。连接状态读取失败时，仍可查找其他应用，已添加应用显示状态未知。确认添加后若请求失败，确认框留在原位，Personal 关闭未使用的登录标签页。只有添加成功才出回执。

生产构建 `index-C04JoPGO.js` 用本地模拟 API 覆盖 Team Composio 1440、Team Arcade 320、Personal Composio 390 和 Personal Arcade 320 像素。四组均通过服务读取、连接状态和搜索的键盘重试，以及取消不写入、失败可重试和成功回执。42 项定向测试通过。Impeccable 源码扫描无检测项，渲染复扫去除了两组的占位字对比度和小字号提示，Team 桌面仍报一条容器嵌套提示。目录说明和搜索区层级仍可压缩，窄屏输入框的起始内边距偏紧。真实服务授权、实体触屏和读屏仍待验证。 [四入口浏览器日志](/tmp/openbot-order2-review/directory-recovery-browser.log) · [Personal 窄屏](/tmp/openbot-order2-review/directory-recovered-personal-arcade.png) · [Team 渲染扫描](/tmp/openbot-order2-review/directory-detect-team-1440.json) · [定向测试](/tmp/openbot-order2-review/directory-recovery-tests.log)


## 目录布局与插件读取复评

生产构建 `index-CkIR4ILT.js` 去掉四个应用目录的重复区块标题和行外卡片。搜索框保持至少 44 CSS 像素的高度，增加文字与控件边缘之间的留白。Team 1440、Personal 320 的 Impeccable 渲染复扫均无检测项，四个目录入口的加载、搜索、键盘清空、连接读取失败和添加路径继续通过测试。H8 从 3 提升到 4，四个入口在模拟环境暂定 **40/40**，此前 39/40。 [四入口日志](/tmp/openbot-order2-review/directory-flat-production.log) · [Personal 320 像素布局](/tmp/openbot-order2-review/directory-flat-recovered-personal-arcade.png) · [Team 渲染复扫](/tmp/openbot-order2-review/directory-flat-detect-team.json) · [Personal 渲染复扫](/tmp/openbot-order2-review/directory-flat-detect-personal.json)

| 页面 | 前次 | 最新暂定分 |
|---|---:|---:|
| `/admin/plugins/` | 32/40 | **35/40（87.5%）** |
| `/admin/plugins/$key` | 31/40 | **36/40（90%）** |
| `/admin/plugins/$key/bots/$agentId` | 36/40 | **38/40（95%）** |
| `/admin/plugins/$key/tools/$tool` | 35/40 | **37/40（92.5%）** |
| `/connections/$key` Personal 应用 | 33/40 | **37/40（92.5%）** |


插件清单、详情、工具与 Bot 授权页的主读取失败均可键盘重试，成功后焦点回到页面标题。管理员详情账户读取失败时保留工具和设置，重试后焦点回到 Connection。Personal 应用的账户重试和 Team 的通用连接页重试均回到应用标题。管理员详情从缓存刷新得到 403 时，隐藏旧工具与操作。Team 动作授权回执视图沿用 39/40，尚需处理不可执行的断开菜单项。

11 组浏览器场景使用本地模拟 API，涵盖 Team 1440、Team 320 和 Personal 390。85 项定向测试、类型检查与生产构建通过。真实授权、实体触屏和读屏仍待验。 [插件页浏览器日志](/tmp/openbot-order2-review/plugin-keyboard-final-browser.log) · [320 像素权限拒绝](/tmp/openbot-order2-review/plugin-denied-320.png) · [定向测试](/tmp/openbot-order2-review/plugin-keyboard-tests.log)


## 连接撤销指引与单项授权复评

Team 的供应商 OAuth 连接以状态文字显示 Connected。在 Access 区说明如何从服务商的第三方访问设置移除 OpenBot。320 像素长权限名完整换行，未连接时保留 44 CSS 像素高的 Connect。OAuth 场景 H5 从 3 提升到 4，H8 为 3，渲染复扫发现两处 11.25 CSS 像素的账户和权限说明。

单项授权的确认说明紧邻所选动作，可用 Escape 取消并把焦点归还原按钮。授权失败就地显示错误，重新读取动作的 Retry 恢复焦点至 Actions 标题。已授权的回执每次返回只显示一次。真实可断开的账户仍需补确认，窄屏账户说明会截断。Team OAuth 与单项授权合计评分暂定 **39/40（97.5%）**。

生产构建 `index-CPHbtemf.js` 使用本地模拟 API 在 1440 浅色和 320 深色通过连接与授权流程。114 项定向测试、类型检查和生产构建通过。真实服务商撤销、实体触屏和读屏仍待验。 [浏览器复验](/tmp/openbot-order2-review/oauth-access-production.log) · [320 像素 OAuth 指引](/tmp/openbot-order2-review/oauth-guidance-320.png) · [320 像素授权失败](/tmp/openbot-order2-review/oauth-consent-failed-320.png) · [渲染复扫](/tmp/openbot-order2-review/oauth-access-rendered-320.json)


## 账户断开确认与窄屏复评

| 页面与场景 | 前次 | 最新暂定分 |
|---|---:|---:|
| `/connections/$key` Team OAuth 与单项授权 | 39/40 | **40/40** |
| `/connections/$key` Personal 应用 | 37/40 | **39/40（97.5%）** |
| `/admin/plugins/$key` Team 共享账户 | 36/40 | **38/40（95%）** |

断开确认分别说明指定账户、个人全部账户和共享账户的影响。对全部账户和共享账户，确认会展示已知的其他受影响应用，以及有待核实的范围。取消不写入并恢复原按钮焦点。断开一个账户保留其余账户，写入失败可在确认框内重试，成功后有回执。OAuth 与账户说明不再截断，320 像素的 Notion 渲染复扫清除了此前两处小字号提示。

生产构建 `index-DtKMypSR.js` 在 Team 1440、Team 320 和 Personal 390 模拟账户上通过确认流程，Team 两种视口还复验 OAuth、单项授权和共享账户。102 项定向测试、类型检查与生产构建通过。因本机并发负载，定向测试复跑将 Testing Library 的等待上限放宽到 10 秒，仅用于本地验证。真实服务商断开、实体触屏和读屏仍待正式验收。 [断开流程日志](/tmp/openbot-order2-review/disconnect-confirm-production.log) · [OAuth 与单项授权](/tmp/openbot-order2-review/disconnect-oauth-production.log) · [320 像素确认](/tmp/openbot-order2-review/disconnect-all-team-320.png) · [OAuth 渲染复扫](/tmp/openbot-order2-review/disconnect-oauth-rendered-320.json) · [定向测试](/tmp/openbot-order2-review/disconnect-confirm-tests-stable.log)


## Providers 独立读取与模型编辑复评

`/admin/providers` 暂定 **38/40（95%）**，此前 32/40。H1–H10 为 3 · 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。供应商和用量能在设置读取失败时独立加载与重试。模型目录失败仍可编辑已保存的选择或补录完整模型名。默认模型说明明确区分可在选项中看到的模型与策略允许的运行。

保存过程中保留编辑框并禁止关闭。保存失败时保留草稿并聚焦提示，成功后清单显示回执，焦点回到编辑按钮。弹窗内的读取重试把焦点归还搜索框。用户在等待期间移到另一字段时，保留用户的位置。搜索、保存和重试触区实测至少 44 CSS 像素高。取消关闭模型守卫的确认会恢复开关焦点且不写入。

生产构建 `index-D9P4RNAL.js` 以模拟 API 在 Team 1440 浅色、390 深色和 320 深色通过浏览器复验。119 项定向测试、类型检查、生产构建和 Biome 通过。320 像素渲染扫描仍有一处 11.25 CSS 像素的正文提示，编辑框中的自定义模型标识重复。真实服务商读取、写入、实体触屏和读屏仍待验。 [浏览器复验](/tmp/openbot-order2-review/providers-current-browser.log) · [320 像素保存失败](/tmp/openbot-order2-review/providers-save-failed-320.png) · [渲染复扫](/tmp/openbot-order2-review/providers-rendered-320.json) · [定向测试](/tmp/openbot-order2-review/providers-recovery-final-tests.log)

## Providers 模型目录与窄屏复评

`/admin/providers` 由暂定 38/40 升至 **40/40（100%，暂定）**。H1 增 1 分，供应商仅返回默认模型时，页面保留默认模型及已有允许项，标明目录待确认，提供重新检查。目录恢复前，搜索无结果时保留读取状态。H8 增 1 分，模型选择说明在 320 CSS 像素下为 15 CSS 像素，手填标识只出现一次，输入框示例可完整显示。

以模拟 API 在 1440 浅色、390 和 320 深色复验。重新检查成功后搜索清单更新，键盘焦点回到搜索。保存失败保留草稿，重试成功后显示回执并恢复入口焦点。320 像素渲染扫描无告警。真实供应商读取、设置持久化、实体触屏及读屏待正式验收。 [浏览器复验](/tmp/openbot-order2-review/providers-polish-production.log) · [320 像素渲染复扫](/tmp/openbot-order2-review/providers-polish-production-detect.json)

## Permissions 能力说明与覆盖项复评

`/admin/permissions` 由 29/40 升至 **31/40（77.5%，暂定）**。H1–H10 为 3 · 4 · 3 · 3 · 3 · 4 · 2 · 3 · 3 · 3。H2 增 1 分，组织权限关闭后保留每条能力的说明，组的 `No grant` 与角色的 `Inherit` 分别指向各自的行为。H6 增 1 分，选择器直接显示当前覆盖状态，窄屏可读完长组名。管理员仍需另查指定成员的有效权限及实际受影响的人员。

模拟 API 在生产构建 `index-Bfwaot7E.js` 的 1440、390、320 像素验证。取消组织变更时写入为零，组覆盖写入失败后以同一作用域与原值重试，成功显示回执。关闭覆盖项弹窗后，焦点返回打开按钮。两级选择器的可触区域至少 44 CSS 像素高，真实权限生效与辅助技术待正式验收。两页相关的 129 项定向测试、类型检查、Vite 构建和 Biome 通过。 [浏览器复验](/tmp/openbot-order2-review/permissions-overrides-production.log) · [320 像素覆盖项](/tmp/openbot-order2-review/permissions-overrides-320.png) · [定向测试](/tmp/openbot-order2-review/providers-permissions-final-tests.log)

## Permissions 变更影响复评

`/admin/permissions` 由 31/40 升至 **34/40（85%，暂定）**。H1–H10 为 4 · 4 · 3 · 3 · 4 · 4 · 2 · 3 · 4 · 3。单项确认复用服务端的权限判定，显示哪些成员会获得、失去或保留权限，以及变更前后的生效来源。加载中、预览失败或目标作用域失效时禁用提交。预览失败可原位重试。保存冲突时刷新权限，要求管理员关闭确认框后按当前值重新发起。

生产构建 `index-RKeRILJL.js` 在 1440、390、320 像素通过浏览器复验，覆盖模拟的组织、角色与组权限预览、组名换行、重试和冲突。主按钮对比度至少 16.7:1，高至少 44 CSS 像素。Permissions 主页面在 320 像素的 Impeccable 扫描无告警。113 项定向测试、类型检查与生产构建通过。待补齐按成员查询当前有效权限，并在真实部署验证权限生效、实体触屏和读屏。 [浏览器复验](/tmp/openbot-order2-review/permissions-impact-production.log) · [320 像素影响预览](/tmp/openbot-order2-review/permissions-person-preview-320.png) · [渲染扫描](/tmp/openbot-order2-review/permissions-impact-detect-320.json) · [定向测试](/tmp/openbot-order2-review/permissions-preview-final-tests.log)

## Permissions 成员有效权限复评

`/admin/permissions` 由 34/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3。H3 增 1 分，返回时保留查询并恢复搜索焦点，读取错误可原位恢复。H7 增 2 分，管理员能在同一页搜索完整目录、按页查找，直接查看允许或阻止状态及生效来源。已移除工作区访问的成员显示对应状态。余下三项为覆盖项与个人结果的状态措辞统一、较长权限清单的扫读和 Audit 入口。

生产构建 `index-DWBs77Ep.js` 在 1440、390、320 像素复验，覆盖分页失败保留现有行、重试后焦点移到新结果、四种策略来源、人员查无结果和身份失效。48 CSS 像素高的入口在窄屏可操作，Impeccable 渲染扫描无告警。43 项前端测试和 10 项独立 PostgreSQL 集成测试通过，后者验证成员读取边界、实际规则优先级和已移除访问状态。真实部署、实体触屏和读屏待验。 [浏览器复验](/tmp/openbot-order2-review/member-access-production.log) · [320 像素权限结果](/tmp/openbot-order2-review/member-access-320.png) · [数据库测试](/tmp/openbot-order2-review/member-access-server-tests.log) · [前端测试](/tmp/openbot-order2-review/member-access-app-tests.log)

## Permissions 结果与审计入口复评

`/admin/permissions` 从 37/40 升至 **40/40（100%，暂定）**。H4 增 1 分，覆盖选项、变更前后预览和成员结果统一使用 Allowed 与 Blocked，保留 Use default 和 No grant 两种作用域各自的行为。H8 增 1 分，先呈现阻止项及数量，再呈现允许项，行内保留策略来源并省去重复状态。H10 增 1 分，Permission history 直接打开以权限变更为筛选条件的 Audit，清除该筛选保留已有 Bot 范围。

生产构建 `index-C-B6k4pu.js` 在 1440、390、320 像素复验成员搜索和权限分组、覆盖项和请求恢复、以及审计入口和筛选恢复。窄屏长组名可换行，审计入口至少 44 CSS 像素高，320 像素 Impeccable 渲染扫描无告警。43 项前端测试、类型检查和构建通过。浏览器使用模拟接口。真实部署、实体触屏及读屏仍待正式验收。 [成员结果复验](/tmp/openbot-order2-review/permissions-finish-member-production.log) · [权限覆盖复验](/tmp/openbot-order2-review/permissions-finish-preview-production.log) · [审计入口复验](/tmp/openbot-order2-review/permission-history-production.log) · [320 像素权限结果](/tmp/openbot-order2-review/permissions-finish-member-320.png)

## 权限描述草稿复评

`/admin/permissions/describe` 由 28/40 升至 **35/40（87.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 3 · 2 · 4 · 4 · 3。描述一经改写即收起旧解读、候选项和影响预览。移除一项后仅显示新影响，焦点移到 Undo，撤销后回到恢复的行。提交等待中保留当前页面，预览失败时继续禁用保存。保存失败后可以使用同一份草稿重试。

生产构建 `index-C2n2oOVO.js` 在 1440、390、320 像素用模拟接口通过改写、撤销、预览重试和保存失败复测，主要按钮触区至少 44 CSS 像素。46 项前端测试、类型检查与构建通过，320 像素渲染扫描无告警。剩余扣分涉及离开草稿的原生确认、返回入口的链接语义、长清单中的审阅效率，以及撰写时缺少常驻示例。真实模型结果、持久化和读屏待验。 [浏览器复验](/tmp/openbot-order2-review/permissions-describe-final-production.log) · [320 像素改写状态](/tmp/openbot-order2-review/permissions-description-edited-320.png) · [前端测试](/tmp/openbot-order2-review/permissions-describe-final-tests.log)

## 权限描述审阅复评

`/admin/permissions/describe` 从 35/40 升至 **40/40（100%，暂定）**。H4 增 1 分，站内离开草稿使用带键盘焦点的确认框，返回入口使用原生链接。H6 和 H10 各增 1 分，撰写时可见示例，指引覆盖全组织、角色和组。H7 增 2 分，在审阅入口按 Enter 可跳过长候选清单，焦点移入当前人员影响区域，删除与撤销仍能回到原行。

生产构建 `index-DmlEtp70.js` 在 1440、390、320 像素通过模拟接口复验。验证了 12 项候选的影响跳转、保留或丢弃草稿、保存期间阻止站内离开，以及审批与边界页的返回链接。43 项前端测试、类型检查、构建通过，320 像素 Impeccable 扫描无告警。真实模型、持久化、实体触屏和读屏待验。 [浏览器复验](/tmp/openbot-order2-review/permissions-discard-production.log) · [320 像素离开确认](/tmp/openbot-order2-review/permissions-discard-320.png) · [前端测试](/tmp/openbot-order2-review/permissions-discard-final-tests.log)

## 审批描述草稿复评

`/admin/approvals/describe` 由 28/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 3 · 3 · 4 · 4。改写描述时收起旧规则和回测。直接编辑规则时仅展示当前回测及警告，无效规则指向对应字段。新增常驻示例、回测跳转和站内草稿确认。键盘移除后到达 Undo，撤销后回到恢复的行。保存前必须通过当前规则的回测。余项为批量写入响应丢失后的重复提交、长表单的扫读和逐条定位效率。

生产构建 `index-DsGZc0ds.js` 在 1440、390、320 像素验证草稿、无效字段、当前警告、预览与保存重试，以及共用离开确认的权限描述页。46 项前端测试、类型检查和生产构建通过。320 像素渲染扫描无告警。浏览器使用模拟接口。真实模型、写入持久化、实体触屏和读屏待验。 [审批描述复验](/tmp/openbot-order2-review/approvals-draft-production.log) · [权限描述回归](/tmp/openbot-order2-review/approvals-shared-permissions-regression.log) · [320 像素改写状态](/tmp/openbot-order2-review/approvals-draft-edited-320.png) · [定向测试](/tmp/openbot-order2-review/approvals-draft-final-tests.log)

## 审批批量保存重试复评

`/admin/approvals/describe` 由 37/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · 3 · 3 · 4 · 4。H5 增 1 分，网络中断后页面提示保存结果未确认，并允许使用同一草稿重试。服务端按管理员和保存标识绑定草稿，规则、审计与回执同一事务提交。同一标识携带不同草稿时返回冲突。

前端生产构建 `index-D71Nempe.js` 在 1440、390、320 像素的模拟网络中断后均用同一标识重试。迁移 `0097` 在独立 PostgreSQL 应用成功，5 项集成测试覆盖首次响应丢失、并发保存、规则校验失败以及规则与审计计数。29 项前端测试及前后端类型检查通过。长规则清单仍待改善，迁移与真实服务仍待部署验收。 [浏览器复验](/tmp/openbot-order2-review/approval-save-production.log) · [PostgreSQL 集成测试](/tmp/openbot-order2-review/approval-save-final-server-tests.log) · [前端测试](/tmp/openbot-order2-review/approval-save-final-app-tests.log)

## 审批规则清单复评

`/admin/approvals/describe` 从 38/40 升至 **40/40（100%，暂定）**。H7 增 1 分，键盘可以直接展开目标规则，新增时焦点进入工具字段，撤销后回到恢复的摘要。H8 增 1 分，多规则草稿默认折叠，摘要列出行为、工具、Bot、动作和目标，折叠时保留校验提示。同一时刻展开一条规则。

生产构建 `index-DhQP1eBX.js` 在 1440、390、320 像素的模拟接口下，验证了八条规则的扫描、展开、字段错误、删除、新增和保存重试。320 像素的长工具名可换行，摘要触区至少 44 CSS 像素。33 项前端测试、类型检查和生产构建通过。真实模型、迁移部署、实体触屏和读屏待验。 [浏览器复验](/tmp/openbot-order2-review/approval-rule-list-production.log) · [320 像素规则摘要](/tmp/openbot-order2-review/approval-rule-list-320.png) · [前端测试](/tmp/openbot-order2-review/approval-list-tests.log)

## 新建边界起点与草稿复评

`/admin/boundaries/new` 从 30/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。选定起点后表单排在起点列表之前，键盘焦点移到表单标题。可原位回到起点列表并继续编辑各自的草稿。改写描述会收起之前生成的表达式。未改动的模板可直接离开，修改过的草稿需要确认。保存冲突后焦点移到恢复区，刷新当前边界后可带着草稿重新提交。模板代价和适用范围仍需在选用前更容易比较。CEL 示例仍需改善常驻性。

生产构建 `index-CHB-EYY_.js` 在 1440、390、320 像素通过选中起点、保留切走的草稿、保存等待、冲突刷新和键盘焦点验证。28 项定向测试通过，补充的 7 项描述回归测试也通过。类型检查及生产构建通过。真实服务和读屏待验。 [生产构建复验](/tmp/openbot-order2-review/boundary-starter-production.log) · [320 像素编辑器](/tmp/openbot-order2-review/boundary-starter-editor-320.png) · [前端测试](/tmp/openbot-order2-review/boundary-starter-tests.log)

## 边界清单搜索复评

`/admin/boundaries` 从 32/40 升至 **35/40（87.5%，暂定）**。H1–H10 为 4 · 4 · 3 · 3 · 3 · 4 · 4 · 3 · 4 · 3。H1 增 1 分，搜索实时显示匹配数量，无结果与尚无规则各有提示。H6 增 1 分，名称、说明和原始 CEL 都可用于查找。H7 增 1 分，可用键盘打开筛选前位置对应的规则，返回详情或刷新后仍保留查询。清空搜索时焦点留在搜索框。

24 条模拟规则在 1440、390、320 像素通过生产构建复验。320 像素下，搜索前最后一条距视口顶约 1891 CSS 像素，筛选后在约 376 CSS 像素处可见。键盘输入未产生额外策略请求。36 项定向测试和 Web 类型检查通过。 [长度基线](/tmp/openbot-order2-review/boundary-list-length-baseline.log) · [生产构建验证](/tmp/openbot-order2-review/boundary-search-production.log) · [定向测试](/tmp/openbot-order2-review/boundary-search-final-tests.log)

## 边界详情书签复评

`/admin/boundaries/$index` 从 31/40 升至 **32/40（80%，暂定）**。H1–H10 为 3 · 4 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3。H7 增 1 分，从清单打开的新地址在规则重排或保存表达式后仍可复用。现有规则用表达式生成初始标识，首次编辑时保存该标识。新建规则直接保存独立标识。旧数字书签和已失效的链接解释原因，可保留筛选词回清单，并收起编辑和移除操作。

生产构建 `index-BWuHU9jN.js` 以模拟策略接口在 1440、390、320 像素复验重排、编辑后刷新、已移除规则、旧书签以及键盘返回，均通过且无浏览器异常。相同构建也复验了清单搜索和稳定链接配合。7 项独立 PostgreSQL 持久化测试通过，覆盖重新装载策略后保留规则标识。Impeccable 对四个前端改动文件扫描无发现，开发构建中两个回退页面在 1440、320 像素经渲染检测无发现。 [重排基线](/tmp/openbot-order2-review/boundary-legacy-link-baseline.log) · [书签生产复验](/tmp/openbot-order2-review/boundary-rule-id-browser-production.log) · [搜索生产复验](/tmp/openbot-order2-review/boundary-search-stable-production.log) · [旧书签截图](/tmp/openbot-order2-review/boundary-bookmark-legacy-320.png) · [持久化测试](/tmp/openbot-order2-review/boundary-rule-id-durability.log) · [渲染检测](/tmp/openbot-order2-review/boundary-bookmark-cdp.log)

### 详情编辑并发保存

复验时模拟另一管理员先新增规则，证实旧页面保存会覆盖新增项。整改后，保存随请求带上所编辑的策略版本。冲突时保留草稿，暂停提交并引导原位重新加载。若当前规则仍在，可在新策略上继续编辑，焦点回到 Rule。若当前规则被改动或移除，保留草稿供复制，并继续禁用保存。

生产构建 `index-9vFYnT8O.js` 在 1440、390、320 像素验证冲突拒绝、重读失败、键盘恢复、保留并发新增以及阻止覆盖同期编辑或恢复已移除项，同时复验了稳定书签和搜索。78 项定向测试、8 项 PostgreSQL 持久化测试和 Web、服务端类型检查通过。两个独立策略存储之间的测试复现相同冲突，确认重新读取后可保存并保持另一条规则和原标识。320 像素下另复现了直接离开时丢失草稿，以及校验已报错仍可尝试提交，H3 和 H5 均为 3 分。真实服务任务与读屏仍待验。 [并发基线](/tmp/openbot-order2-review/boundary-edit-conflict-baseline.log) · [并发生产复验](/tmp/openbot-order2-review/boundary-edit-conflict-final-production.log) · [320 像素冲突截图](/tmp/openbot-order2-review/boundary-edit-conflict-320.png) · [定向测试](/tmp/openbot-order2-review/boundary-conflict-final-tests.log) · [数据库复验](/tmp/openbot-order2-review/boundary-conflict-durability.log) · [编辑草稿与校验基线](/tmp/openbot-order2-review/boundary-detail-draft-baseline.log)

两个模拟规则在重新排序后，同一旧详情地址显示了另一条规则。后续需处理旧书签，并在真实策略和辅助技术下复验。 [位置书签复现](/tmp/openbot-order2-review/boundary-legacy-link-baseline.log)

## 边界详情编辑复评

`/admin/boundaries/$index` 从 32/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 3 · 3 · 3 · 4 · 4。H1 增 1 分，检查、校验失败、无法回放和保存成功各有状态反馈。H3 增 1 分，离开前可继续编辑或明确丢弃描述与表达式，提交期间保留当前页面。H5 增 1 分，只有当前表达式已通过服务端检查才可保存，修改生成规则的描述后需重新生成。未配置可读历史的部署仍可提交已通过语法检查的规则。H10 增 1 分，编辑时可展开与新建页共用的属性参考和表达式示例。

生产构建 `index-B9SqbQmR.js` 在 1440、390、320 像素复验草稿确认、校验错误拦截、503 原位重试及焦点归还、保存回执、并发冲突与书签定位。79 项定向测试和 Web 类型检查通过。三个改动文件的 Impeccable 扫描无发现。仍需改进保存后的键盘焦点、表达式快速查找与长回放的阅读效率，并验证真实服务和辅助技术。 [编辑生产复验](/tmp/openbot-order2-review/boundary-detail-editor-final-production.log) · [并发生产复验](/tmp/openbot-order2-review/boundary-edit-conflict-final-final-production.log) · [草稿确认截图](/tmp/openbot-order2-review/boundary-draft-dialog-320.png) · [定向测试](/tmp/openbot-order2-review/boundary-editor-tests.log)

## 团队审批决策与搜索复评

`/admin/approvals` 从 29/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 3 · 3 · 4 · 3。H1 增 1 分，请求读取、等待决策和决策完成分别显示状态。H2 增 1 分，确认区分当前与请求的访问，并说明外部事件可否触发 Bot 使用共享账号。H3 增 1 分，确认可取消并归还焦点。H5 增 1 分，确认后重新读取；请求消失或当前访问变化时停止提交，服务端 409 和写入结果未确认各有反馈。H6 与 H7 各增 1 分，按动作、应用、Bot、策略等筛选团队规则，仍可操作对应规则，移除后焦点回到筛选框。H10 增 1 分，批准和拒绝时都可在确认前查看后果。

生产构建 `index-DfrdQjU2.js` 在 1440、390、320 像素复验请求读取恢复、取消、访问变化拦截、写入失败重试、409、写入结果未确认与成功后的读取失败。另以 24 条规则验证搜索计数、无额外读取、清空键盘焦点及精确移除。320 像素下最后一条从约 3763 CSS 像素移至 409。31 项定向测试、23 项 PostgreSQL 持久化测试与 Web 类型检查通过。Impeccable 的三个改动文件源码检测无发现。真实共享连接器端到端任务、辅助技术和跨团队管理场景仍待复验。 [共享账户基线](/tmp/openbot-order2-review/shared-account-baseline.log) · [共享请求生产复验](/tmp/openbot-order2-review/shared-account-regression.log) · [规则清单基线](/tmp/openbot-order2-review/team-rule-discovery-baseline.log) · [规则搜索生产复验](/tmp/openbot-order2-review/team-rule-discovery-production.log) · [持久化测试](/tmp/openbot-order2-review/shared-account-persistence.log)

## 审计分页复评

`/admin/audit` 从 29/40 升至 **32/40（80%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3。H1 增 1 分，区分当前加载页没有记录、仍有更早记录，以及筛选无结果。H9 增 1 分，较早记录读取失败时可原位重试，键盘焦点留在分页按钮；切换视图期间隐藏旧分页入口。H10 增 1 分，提问示例常驻，Why? 可查看已记录判定及当前策略。

生产构建 `index-DXHe29P0.js` 在 1440、390、320 像素复验空页继续翻页、筛选切换、503 后键盘重试，以及恢复后看到更早的记录。提问及录制记录恢复在桌面与手机布局回归通过。23 项定向测试通过，改动文件 Impeccable 源码检测无发现。文字搜索仍只检查已加载记录，真实模型与辅助技术待验。 [分页基线](/tmp/openbot-order2-review/audit-cursor-baseline.log) · [分页生产复验](/tmp/openbot-order2-review/audit-cursor-production.log) · [提问回归](/tmp/openbot-order2-review/audit-cursor-question-regression.log) · [定向测试](/tmp/openbot-order2-review/audit-cursor-final-tests.log)
