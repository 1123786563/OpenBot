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

`e682af31` 合入 Astryx 迁移。生成路由树增至 100 条，新增 `/tasks` 与 `/ideas`，原 `/responsibilities` 跳转改为直接渲染。五个旧外观页面转为兼容跳转，`/s/activity` 继续提供统一的 Activity，Goals 作为 Responsibilities 的独立视图。当前范围为 88 项页面与任务视图。历史 Astryx 迁移汇总记录为 **88/88 暂定通过 99% 门槛**，其中 86 项得 40/40，两项短暂交接得 36/36。正式验收为 **0/88**，真实部署中的角色和服务、实体设备及读屏待验。全局 Routines 在两张表出现，按一个视图计。Team 与 Personal 应用详情分别计分。旧入口和已删除源码路径可在基线提交回查。#182 的后续抽查分数见首批整改复评。#194 的当前构建证据、逐项待验状态及检测发现见[最终验收台账](acceptance/web127-final-evidence.md)。

| 当前页面 | 对应旧入口 | H1…H10 | 本次暂定分 | 扣分与复验 |
|---|---|---|---:|---|
| `/tasks` | `/s/tasks` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 视图名称覆盖工作与历史，Ideas 与独立入口同名。状态筛选解释待处理来源和已完成时间范围。 [Tasks 与 Ideas 操作复评](#tasks-与-ideas-操作复评) |
| `/ideas` | `/s/ideas` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 忽略前确认具体建议和 30 天影响，取消保留建议，失败可原位重试。 [Tasks 与 Ideas 操作复评](#tasks-与-ideas-操作复评) |
| `/responsibilities` | 原地址跳转到 Bots | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 明确完成目标会停止未来运行。清单提供打开目标和搜索状态的帮助。 [Goals 完成确认复评](#goals-完成确认复评) |
| `/responsibilities?view=goals` | `/s/goals` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 选定 Bot 后直接切换 Goals 和 Routines。浏览器返回和旧书签可恢复对应视图。 [Goals 视图布局复评](#goals-视图布局复评) |
| `/s/activity` | 原地址 | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 失败、排队、重试和已交付分别说明。需要关注时保留任务本身状态。 [Activity 状态措辞复评](#activity-状态措辞复评) |
| `/routines` | `/s/routines` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** | 全部与单 Bot 入口的筛选和清空规则一致。运行后果和暂停恢复可直接阅读。 [Routines 搜索一致性与运行说明复评](#routines-搜索一致性与运行说明复评) |

共享异常状态单独验收。未知地址与路由加载失败均暂定 **36/36（100%）**。两个页面共用主次操作规则，键盘进入工作区后恢复标题焦点。加载失败区分离线与连续失败，重试保留原地址。 [共享路由恢复操作复评](#共享路由恢复操作复评)

路由恢复阶段的独立 Impeccable 检测覆盖 8 个源码文件和 18 组 Chromium 页面状态，结果均为 0 项。Vite 生产构建在 1440、390 和 320 像素宽度验证了未知地址、键盘返回和六条旧书签。后续生产构建 `index-Bm9W0Yw_.js` 验证全部 21 条兼容书签，Team 管理员、Team 成员和 Personal 各执行 21 次，63 次全部通过。Goals 与 Ideas 保留 `agent`，旧 Connections 保留回调参数。Team 的 Memory 入口进入 `/capabilities/memory`，Personal 回到 `/bots`。 [书签矩阵](/tmp/openbot-group-review/bookmark-matrix-final.json)

#193 的隔离 OIDC 复验在生产构建 `a692a090c` 中通过。真实 Keycloak 登录返回旧 Goals 书签，随后迁移到 `/responsibilities?agent=expenses&view=goals`。PostgreSQL 中降级同一账号后，原会话打开管理员书签会回到首页。 [验收记录](acceptance/web127-final-evidence.md)

另验证 API 失败后的原地址重试、访客登录回退以及窄屏导航的 Escape 与焦点归还。Web 类型检查通过，七个定向测试文件共 61 项通过。

Tasks 与 Ideas 的独立复评覆盖 Vite 生产构建、Team 浅色 1440×900 和 Personal 深色 390×844。4 个源文件扫描无发现，14 个渲染场景中有 5 条桌面嵌套容器提示，集中在任务或建议空态。窄屏无检测项及横向溢出。四项模拟读取故障均恢复到正确状态。Web 类型检查和 44 项定向测试通过。

Responsibilities、Goals、Activity 和 Routines 的复评沿用相同的生产构建方式与视口。十次模拟读取故障均可原位恢复，最终构建确认焦点进入对应页面标题或 Goals 区块标题。新建 Routine 的浅色对比度约 17.2∶1、深色约 18.1∶1。Web 类型检查、生产构建和 36 项定向测试通过。真实写入、完整读屏和角色矩阵待验。

本轮独立检测覆盖 28 个渲染场景，发现 7 条桌面提示，涉及嵌入列表空态和 Tasks 错误态的重复文本。窄屏无检测项或横向溢出。Tasks 和 Ideas 的简化空态与恢复焦点已独立复评。Goals 和 Routines 的无名称区块焦点问题在最终生产构建复验修正。

Activity 空态整改后分别检测统一入口与 Bot 专属入口。8 个渲染场景中只剩两条桌面 Actions 容器嵌套提示。4 次键盘重试通过，13 项定向测试通过。

Bot 选择器复评由独立设计评审和检测评审在同一生产构建上完成。Team 浅色 1440×900 和 Personal 深色 390×844 验证切换、刷新和六次失效 Bot 恢复。旧 Goals 和 Ideas 地址保留 Bot 参数。切换后，Routines 和审计链接指向当前 Bot。4 个源码文件扫描无发现，12 个渲染场景共有 5 条桌面嵌套容器提示，均无横向溢出。Web 类型检查和 18 项定向测试通过。

通常满分为 40，两个交接页的满分各为 36。任何适用项扣 1 分都会低于 99%，所以验收要求每个适用项都达到 4 分。百分比只用于展示，门槛以原始分判断。

当前范围的 88 项均采用整改后最新暂定分。五个旧外观视图的历史行已关闭，统一视图已分别计分。`/settings/activity` 在 Personal 部署仍可访问，保留在 88 项验收范围内并完成本地复评。各页的评分和证据链接见最新复评列。顺序2 的 15 项在 2026-11-22 完成三批整改与两轮盲评，其中 9 项在盲评后又落地修复并经活体验证，待下轮复评确认。顺序3 的 15 条评分行（12 个独立视图，其中技能三页为 admin/settings 共用组件）在 2026-11-23 完成盲评（C/D 两评）与整改，盲评后修复全部活体验证，证据链 18 条失败路径全部键盘原位恢复。

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
| `/sign` 登录 | 3 3 3 3 2 2 3 3 2 1 | 25/40 | **40/40（100%，暂定）** · [登录方式重新检查复评](#登录方式重新检查复评) | 登录设置未就绪时可原位检查。管理员入口解释适用范围。恢复后回到标题并保留返回地址。 |
| `/onboarding` 首次使用 | 3 3 3 3 3 3 2 2 2 3 | 27/40 | **40/40（100%，暂定）** · [首次使用复评](web-impeccable-batch-3-conversations.md#首次使用最终复验) | 进度保存失败可重试，完成失败可沿用已保存的姓名。预约失败后 320 像素下仍可继续。移动端显示步骤数。姓名与完成失败时可从姓名字段重试。审批开关为 44 × 44 像素。切换步骤时旧控件立即退出交互，320 像素无溢出。真实预约、实体触屏与读屏待验。 |
| `/desktop-return` 浏览器交还桌面 | 2 3 2 3 2 3 — 4 1 1 | 21/36 | **36/36（100%，暂定）** · [桌面交接状态与恢复复评](#桌面交接状态与恢复复评) | 区分尚未连接和无法确认。重试成功聚焦桌面入口，浏览器可继续。 |
| `/sign-in/$requestId` 为 Bot 登录网站 | 3 3 3 3 3 3 2 3 2 3 | 28/40 | **40/40（100%，暂定）** · [为 Bot 登录网站复评](web-impeccable-batch-3-conversations.md#为-bot-登录网站复评) | 暂时读取失败保留表单与焦点，失效请求关闭表单。已匹配的 Thread 可返回原会话。窄屏长账户换行，处理中显示状态并限制重复提交。显示完整网站地址与当前用户获准查看的 Bot 名称。窄屏两个恢复操作均高 44 像素。真实请求投递、验证码验证和 Bot 浏览器回跳待验。 |
| `/` 首页 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | **33/40（暂定）** · [首批整改复评](#首批整改复评) | 草稿可复制到新建会话，拒绝存储时可在当前标签页继续。真实服务、触屏和读屏待验。 |
| `/channel/new` 新会话 | 2 3 3 3 3 3 3 3 2 2 | 27/40 | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 支持连续选 Bot 和刷新恢复顺序。To 为空时说明发送限制并引导选人。320 像素下 To 可换行。真实服务、触屏和读屏待验。 |
| `/start/$startId` 创建会话中 | 2 3 1 3 2 3 — 3 1 1 | 19/36 | **30/36（暂定）** · [首批整改复评](#首批整改复评) | 剪贴板被拒时聚焦并选中完整原文。群聊首条消息已提交时说明重试会先核对旧消息。 |
| `/channel/$channelId` 单 Bot 会话 | 3 3 3 3 3 3 3 3 3 2 | 29/40 | **待验** · [首批整改复评](#首批整改复评) | 核对与重发各自说明效果。核对不发新消息，重发复用原消息 ID。 |
| `/group/$channelId` 多 Bot 会话 | 3 3 2 2 2 3 2 3 2 2 | 24/40 | **待验** · [首批整改复评](#首批整改复评) | 手动查收失败可原位重试，新回复到达后接续键盘焦点。权限被拒绝时隐藏旧消息和成员。 |
| `/bot` 默认或指定 Bot 快速会话 | 2 3 2 2 3 3 2 3 2 2 | 24/40 | **29/40（暂定）** · [首批整改复评](#首批整改复评) | 长简介可展开阅读，聊天输入框留在视口内。新开会话前明确作用范围和已保存草稿的去向。 |
| `/browser` 自己的浏览器 | 2 3 3 2 3 3 3 3 3 2 | 27/40 | **40/40（100%，暂定）** · [录制列表与开窗说明复评](#录制列表与开窗说明复评) | 长录制标题可完整换行，窄屏独立显示结束状态。录制链接说明可先查看列表，两种入口共用开窗失败提示。 |

### Bot、能力与例行任务

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/bots` Bot 列表 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **40/40（100%，暂定）** · [Bots 隐藏项查找复评](#bots-隐藏项查找复评) | 搜索包含隐藏 Bot，结果仍分组。空结果提供查找指引，隐藏清单失败可原位重试。 |
| `/bots?new=true` 创建 Bot 状态 | 3 3 3 3 4 4 3 3 3 3 | 30/40 | **40/40（100%，暂定）** · [Bot 创建与设置指引复评](#bot-创建与设置指引复评) | 说明空白指令的默认值，隔离电脑的隔离范围、成本与共享影响在选择处可读。 |
| `/bots/$agentId` Bot 档案 | 2 3 3 3 3 3 2 2 2 2 | 25/40 | **40/40（100%，暂定）** · [Bot 档案通知措辞复评](#bot-档案通知措辞复评) | 说明每种通知偏好及设备权限。窄屏完整显示 Active 和通知说明。 |
| `/bots/$agentId/access` 技能与访问 | 2 2 3 2 3 2 2 2 2 2 | 22/40 | **40/40（100%，暂定）** · [Bot 应用访问撤销复评](#bot-应用访问撤销复评) | 撤销前核对授予者和恢复条件。失败可在确认框重试，原行消失后焦点回到 Your apps。 |
| `/bots/$agentId/activity` Bot 活动 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **40/40（100%，暂定）** · [Activity 状态措辞复评](#activity-状态措辞复评) | 和统一 Activity 共用任务状态措辞，明确区分失败和等待用户。 |
| `/bots/$agentId/approvals` 审批规则 | 2 3 2 3 2 3 2 3 2 2 | 24/40 | **40/40（100%，暂定）** · [Bot 审批规则移除复评](#bot-审批规则移除复评) | 移除前核对范围和当前行为，发现规则已变更时暂停。失败可原位重试。 |
| `/bots/$agentId/memory` 记忆来源 | 2 2 3 3 3 2 2 2 2 2 | 23/40 | **32/40（暂定）** · [首批整改复评](#首批整改复评) | 同步和启停的进度、失败与结果显示在对应来源行，键盘可原位重试。 |
| `/bots/$agentId/reach` 联系方式 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **40/40（100%，暂定）** · [断开连接复评](#bot-联系方式断开连接复评) | 断开前确认具体目标和消息影响。取消恢复焦点，失败可重试，连接变化时要求重新查看。 |
| `/bots/$agentId/responsibilities` Goals | 2 2 2 3 3 2 2 3 2 2 | 23/40 | **40/40（100%，暂定）** · [单 Bot Goals 布局复评](#单-bot-goals-布局复评) | 合并标题和说明，创建与搜索紧邻清单。读取恢复后聚焦页面标题。 |
| `/bots/$agentId/routines` Bot 的例行任务 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **40/40（100%，暂定）** · [Routines 搜索一致性与运行说明复评](#routines-搜索一致性与运行说明复评) | 搜索只匹配该 Bot 的例行任务。运行按钮关联可见说明。 |
| `/bots/$agentId/setup` Bot 设置 | 3 2 3 3 3 2 2 2 3 2 | 25/40 | **40/40（100%，暂定）** · [Bot 创建与设置指引复评](#bot-创建与设置指引复评) | 区分名称、简短说明、工作和指令。编辑退出需确认，重试保留草稿并在成功后恢复原行焦点。 |
| `/bots/$agentId/sharing` 分享 | 2 3 3 3 3 3 2 3 2 2 | 26/40 | **40/40（100%，暂定）** · [Bot 分享分配范围复评](#bot-分享分配范围复评) | 明确选择组或全队。离开时保护草稿，失败原位重试，成功后焦点回到原操作。 |
| `/capabilities/skills` 技能列表和编辑面板 | 2 3 2 3 1 3 2 3 2 3 | 24/40 | **33/40（暂定）** · [首批整改复评](#首批整改复评) | 分开说明工具加载与 Bot 授权。工具列表按需展开，收起后保留选择和草稿。 |
| `/capabilities/memory` 记忆列表 | 4 3 4 3 4 4 4 3 4 3 | 23/40 | **33/40（暂定）** · [首批整改复评](#首批整改复评) | 明确记忆来源，长记忆默认显示预览，支持键盘展开，搜索和编辑仍使用全文。 |
| `/routines` 全部例行任务 | 2 3 3 3 3 3 2 3 2 3 | 27/40 | **40/40（100%，暂定）** · [Routines 搜索一致性与运行说明复评](#routines-搜索一致性与运行说明复评) | 搜索无额外请求，运行前能读到执行和发帖影响。 |
| `/routines/new` 创建例行任务 | 3 3 3 3 4 3 2 2 3 3 | 29/40 | **40/40（100%，暂定）** · [新建例行任务措辞复评](#新建例行任务措辞复评) | 输入时示例持续可见，日程显示易读的时区名称，说明结果去向和新会话的命名方式。 |

### 连接

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/connections` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [顺序2终评](../app/.impeccable/critique/2026-11-22T09-55-00Z__order2-connections-admin-plugins.md#round-2--blind-re-assessment-findings-and-fixes) | 盲评 A3 满分：清单骨架、Team account 状态、身份读取失败不误报 Connect、磁贴两行摘要均活体验证。余下为记录项：与目录页搜索计数/空态措辞略异。 |
| `/connections/$key` Team 应用及动作授权回执 | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [断开确认复评](#账户断开确认与窄屏复评) | 窄屏账户和权限正文完整换行。断开前列出影响范围，取消后回到原按钮。 |
| `/connections/$key` Personal 应用 | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [Personal 应用连接加载复评](#personal-应用连接加载复评) | 应用资料与账户状态分别反馈，加载期间可以返回，权限失败及时显示。 |
| `/connections/github` | 2 3 3 4 3 4 4 4 3 4 | **40/40（100%，暂定）** · [GitHub 仓库重复请求复评](#github-仓库重复请求复评) | 仓库添加响应中断后，重试同一草稿只创建一个连接及一条凭据。 |
| `/connections/slack` | 2 3 4 4 4 4 4 4 3 4 | **40/40（100%，暂定）** · [Slack 命令指引复评](#slack-命令指引复评) | 明确命令发送对象与有效期。代码过期后停用复制，并指引重新申请。 |
| `/connections/routines` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [Routines 内置入口复评](#routines-内置入口复评) | 从内置工具区进入原地址，失败可原位重试。 |
| `/connections/browse/arcade` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/connections/browse/composio` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |

### 已退役的外观专属 Web 页面

| 页面 | 基线十项分 | 基线总分 | 迁移状态 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/s/tasks` OpenDuet | 2 3 3 2 3 3 2 2 2 2 | 24/40 | 已退役 | 任务按待办状态分组，混合审批、Goals、Routines。Active/Up next 使用 tab 角色和普通按钮点击，组件无方向键或 roving tabindex。 |
| `/s/routines` OpenDots | 2 3 3 2 3 3 2 3 2 3 | 26/40 | 已退役 | 主操作清晰，嵌入全局列表和它的静默加载，与默认外观标题层级及返回有差异。 |
| `/s/memories` OpenDots | 2 3 2 2 2 3 2 3 2 2 | 23/40 | 已退役 · 历史复评 26/40 | 现为兼容地址。320 像素实测 Team 转到统一记忆页，Personal 转到 Bots。 |
| `/s/activity` OpenFuse | 2 3 3 2 3 3 2 3 2 2 | 25/40 | 已退役 | 继承 Bot 活动反馈和审计入口，空 Bot 有独立态。聚焦当前 Bot 的导航必须在长耗时切换后仍保持明确。 |
| `/s/ideas` OpenFuse | 2 2 3 2 3 2 2 3 2 2 | 23/40 | 已退役 | Ideas 含 Bot 等待人处理及主动研究设置，标题无法直接提示读取、决策和设置之间的关系。 |
| `/s/goals` OpenFuse | 2 2 2 2 3 2 2 2 2 2 | 21/40 | 已退役 | 一列堆叠 Routines 与 Bot Responsibilities，多个域概念在同一个标签内出现。等待与错误继承列表，需要检查移动视口重复标题、滚动、首个动作。 |

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
- **P2 · OpenDuet 标签键盘缺口（历史）。** 原标签实现已随旧外观退役。统一 Tasks 保留相应任务入口。

保留三种已有行为。首页在选 Bot 失败时还原输入，分组会话更换会话时重新挂载以防串历史，新建 Bot 可通过 URL 表达且关闭后保留列表。视觉改动应重视员工看到「我的工作有人接手」的时刻和没有权限／无法启动时的退出方式。对于 IT 管理员，重点是看懂谁授予、用谁的账号以及现在撤销会影响谁。

待方案讨论的取舍有两项。Bot 档案是否作为所有设置的返回锚点，还是保留可直接进入一个跨 Bot 的权限控制台？四个外观共享全部工作流入口，还是让 OpenDuet／OpenDots／OpenFuse 继续拥有仅在各自外观出现的状态？


## 管理与设置

| 页面 | 基线十项分 | 基线总分 | 最新可用评分 | 基线扣分证据与复核任务 |
|---|---|---:|---|---|
| `/admin/` | 3 · 3 · 3 · 3 · 3 · 4 · 2 · 3 · 2 · 2 | 28/40 · 70% | **40/40（100%，暂定）** · [管理首页拼写恢复复评](#管理首页拼写恢复复评) | 常规匹配优先，无结果时尝试一次拼写纠错并明确标注。 |
| `/admin/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | **40/40（100%，暂定）** · [审批规则清单查找复评](#审批规则清单查找复评) | 查找与个人规则一致，新增入口独立放在结果之前。 |
| `/admin/approvals/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [审批规则清单复评](#审批规则清单复评) | 长草稿可逐条展开。折叠摘要保留校验提示，保存响应丢失可用同一草稿重试。 |
| `/admin/approvals/guidance` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **40/40（100%，暂定）** · [审批指导保存条件复评](#审批指导保存条件复评) | 明确保存前需通过检查，历史回放可选。编辑后提示重新检查。 |
| `/admin/audit` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | **32/40（暂定）** · [首批整改复评](#首批整改复评) | 窄屏用一个菜单选择视图，明确标为 Background actions。搜索前可看到范围，CSV 沿用所选视图。 |
| `/admin/boundaries` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **40/40（100%，暂定）** · [边界生效模式复评](#边界生效模式复评) | Trial mode 出现在规则之前。返回后定位原规则，目标已移除时聚焦搜索框。临时故障显示只读规则，权限拒绝清除缓存。 |
| `/admin/boundaries/$index` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **40/40（100%，暂定）** · [边界起点比较与表达式指引复评](#边界起点比较与表达式指引复评) | 表达式示例常驻并关联输入，前后入口共用同一说明。 |
| `/admin/boundaries/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [边界起点比较与表达式指引复评](#边界起点比较与表达式指引复评) | 选择前可读模板限制，编辑时收起起点列表，换回原起点仍保留草稿。 |
| `/admin/components/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（暂定）** · C 36，E 复评满分。 [E 轮复评](#e-轮复评与整改) | 已修并验证：磁贴状态由仅色点改为标题内可见文字（· Published / · Draft，H1/H6 扣分点）。余下："无法绘制"在列表与详情有三种措辞变体（H4）；无图样磁贴的大渐变占位（fixture 数据，H8）。 [源码](../app/src/routes/_authed/admin/components/index.tsx#L37) |
| `/admin/components/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **31/40（暂定）** · [首批整改复评](#首批整改复评) | 内置组件可原位应用已保存描述。Playground 组件指向保存源文件的清单。 |
| `/admin/computers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [设备重置范围与窄屏复评](#设备重置范围与窄屏复评) | 窄屏合并操作；重置确认区分浏览器配置与整台电脑的数据。 |
| `/admin/credentials` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 按供应商、类型和 ID 查找。可从单行替换活动凭据。 替换成功返回新生效条目并显示回执。 |
| `/admin/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **35/40（暂定）** · [首批整改复评](#首批整改复评) | 类型切换同步更新填写提示，发现同名凭据可直接返回并选中 Key ID。 |
| `/admin/identity-providers` | 2 · 2 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 22/40 · 55% | **33/40（暂定）** · [首批整改复评](#首批整改复评) | 按域名、协议或签发者查找。注册后定位到新条目，移除后可继续搜索。 |
| `/admin/learning` | 2 · 2 · 3 · 3 · 3 · 3 · 2 · 2 · 3 · 2 | 25/40 · 62.5% | **40/40（100%，暂定）** · [管理端学习审阅顺序复评](#管理端学习审阅顺序复评) | 先显示所选 Bot 的待审技能，再展示学习与投递状态。离开仍保护 Participation 草稿。 |
| `/admin/people` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | **38/40（暂定）** · [首批整改复评](#首批整改复评) | 角色、访问状态和登录方式用明确文字。窄屏操作归入单个菜单，取消后恢复焦点。 |
| `/admin/permissions` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 3 | 26/40 · 65% | **32/40（暂定）** · [首批整改复评](#首批整改复评) | 成员权限按阻止与允许分组，状态词与覆盖项一致。权限历史直接打开已筛选的 Audit。 |
| `/admin/permissions/describe` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [权限描述审阅复评](#权限描述审阅复评) | 编辑期间可参考常驻示例。长草稿可直达人员影响，离开前可继续编辑或丢弃。 |
| `/admin/playground` | 3 · 2 · 3 · 3 · 2 · 3 · 3 · 2 · 3 · 2 | 26/40 · 65% | **40/40（100%，暂定）** · [Playground 发布重试复评](#playground-发布重试复评) | 发布重试复用已保存版本。其他管理员更新或删除草稿后，旧确认失效。 |
| `/admin/plugins/` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [插件搜索命中复评](#插件搜索命中复评) | 按工具名称或描述搜索时，结果行显示命中的工具。Enter 聚焦首个结果。 |
| `/admin/plugins/$key` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [插件详情工具清单复评](#插件详情工具清单复评) | 工具刷新说明失败原因和旧清单来源，恢复后给出回执。长工具说明和访问状态在窄屏独立显示。 |
| `/admin/plugins/$key/bots/$agentId` | 3 3 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [Bot 插件访问状态复评](#bot-插件访问状态复评) | 可单独恢复 Bot 名称。权限刷新失败时标明旧状态并暂停更改，恢复后保留搜索。 |
| `/admin/plugins/$key/tools/$tool` | 2 4 4 4 4 4 4 4 3 4 | **40/40（100%，暂定）** · [工具授权清单复评](#工具授权清单与写入恢复复评) | 搜索无结果时仍可清空。清单可重试，授权反馈和等待状态按 Bot 分开。 |
| `/admin/plugins/arcade` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/admin/plugins/composio` | 4 4 4 4 4 4 4 4 4 4 | **40/40（暂定）** · [目录布局复评](#目录布局与插件读取复评) | 搜索和行列表已拉平。真实服务授权与辅助技术待验。 |
| `/admin/proactive` | 2 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 2 | 27/40 · 67.5% | **40/40（暂定）** · C 39，E 复评满分。 [E 轮复评](#e-轮复评与整改) | 盲评 C 39，唯一扣分为词汇：已修并验证——行标题 Pings sent → Check-ins sent，"2.0 items in each, on average" 改完整句"Each one carries an average of 2 items."（整数值不再显示 .0），Bot 弹窗统计 Sent in a ping → Check-ins sent，页面全境不再出现 ping。 [源码](../app/src/routes/_authed/admin/proactive.tsx#L131) |
| `/admin/providers` | 4 4 4 4 4 4 4 4 4 4 | **40/40（100%，暂定）** · [模型目录与窄屏复评](#providers-模型目录与窄屏复评) | 目录仅有默认模型时可检查更新。模型草稿保存失败可重试，成功后回到清单并显示回执。 |
| `/admin/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 盲评 C 满分："1 of 2 Bots" 显式状态、应用语态的失败+Retry、New skill 正确跳转、深色窄屏干净。 [源码](../app/src/components/manage/skills-page.tsx#L74) |
| `/admin/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 区分即时授权和内容保存。浏览器后退与页首返回共用草稿保护。 |
| `/admin/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [技能管理保存范围复评](#技能管理保存范围复评) | 明确保存后再分配给 Bot。工具按需展开，收起保留选择。 |
| `/admin/what-if` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | **40/40（100%，暂定）** · [策略测试步骤与结果复评](#策略测试步骤与结果复评) | 在输入前说明提问和检查的区别。修改或清空问题时标明结果对应的动作。 |
| `/settings/` | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 | 29/40 · 72.5% | **40/40（100%，暂定）** · [通用设置窄屏可读性复评](#通用设置窄屏可读性复评) | 窄屏完整显示姓名和选项说明。常驻指示的适用范围独立于预览，编辑时可读全文。 |
| `/settings/activity` | 3 · 3 · 3 · 3 · 3 · 4 · 3 · 3 · 2 · 2 | 29/40 · 72.5% | **40/40（100%，暂定）** · [审计与活动范围复评](#审计与活动范围复评) | 搜索前可看到范围和如何加载更早记录。Background actions 使用与审计相同的名称。 |
| `/settings/approvals` | 2 · 3 · 3 · 3 · 2 · 2 · 2 · 3 · 2 · 2 | 24/40 · 60% | **40/40（100%，暂定）** · [审批规则清单查找复评](#审批规则清单查找复评) | 同时查找个人规则和只读团队规则，Enter 聚焦首条匹配项。 |
| `/settings/browsers` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [已连接浏览器查找复评](#已连接浏览器查找复评) | 可按浏览器名称、连接日期或录制状态筛选，取消断开后保留筛选。 |
| `/settings/components-gallery/` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（100%，暂定）** · [组件图库使用指引复评](#组件图库使用指引复评) | 说明在哪找到组件名称、如何请有权限的 Bot 展示。返回恢复原条目的焦点。 |
| `/settings/components-gallery/$name` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（100%，暂定）** · [图库导航与预览复评](#组件图库导航与预览复评) | 预览使用正常字号并标注样例数据。无样例时说明会话内的可用范围。 |
| `/settings/computer` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [设备重置范围与窄屏复评](#设备重置范围与窄屏复评) | 窄屏保留单个操作菜单，取消后回到对应设备，保留当前筛选。 |
| `/settings/credentials` | 2 · 3 · 2 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 23/40 · 57.5% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 可查找并替换活动密钥。权限被拒后，后续临时故障不会恢复旧缓存。 替换成功返回新生效条目并显示回执。 |
| `/settings/credentials/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **35/40（暂定）** · [首批整改复评](#首批整改复评) | 发现同名密钥时可在表单中改用另一 ID，保留已输入的密钥。 |
| `/settings/learning` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **40/40（100%，暂定）** · [学习分享范围复评](#学习分享范围复评) | 选择前说明管理员批准条件。待批技能明确显示使用范围，分享请求仍可按技能重试。 |
| `/settings/notifications` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **40/40（100%，暂定）** · [通知投递类型复评](#通知投递类型复评) | 失败仅标在匹配的更新类型和渠道旁，原因可用键盘展开。 |
| `/settings/passwords` | 2 · 3 · 3 · 3 · 1 · 3 · 2 · 3 · 2 · 2 | 24/40 · 60% | **32/40（暂定）** · [首批整改复评](#首批整改复评) | 按站点和用户名查找。删除后焦点回到列表内容或页面标题。 |
| `/settings/setup` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [Setup 重查操作复评](#setup-重查操作复评) | Check again 沿用描边次级按钮，触区 44 CSS 像素。失败保留上次结果，重试更新清单。 |
| `/settings/skills` | 2 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 25/40 · 62.5% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | 与 `/admin/skills` 同一组件（skills-page），盲评 C 满分；个人版措辞差异未单独评。 [源码](../app/src/components/manage/skills-page.tsx#L62) |
| `/settings/skills/$slug` | 2 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 27/40 · 67.5% | **34/40（暂定）** · [首批整改复评](#首批整改复评) | Personal 独立验证后退保护、工具单独保存和读取恢复。 |
| `/settings/skills/new` | 3 · 3 · 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 | 28/40 · 70% | **40/40（100%，暂定）** · [技能管理保存范围复评](#技能管理保存范围复评) | 说明保存即向所有个人 Bot 提供技能，工具清单按需展开。 |
| `/settings/this-computer` | 3 · 3 · 3 · 3 · 2 · 3 · 2 · 3 · 2 · 2 | 26/40 · 65% | **40/40（100%，暂定）** · [此电脑诊断预览复评](#此电脑诊断预览复评) | 分享前可查看诊断内容，复制使用已查看的快照。浏览器交接说明安装前提与手动路径。 |

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

## 目标归属与记忆筛选复评

| 页面 | 上轮 | 本轮暂定 | 加分依据 |
|---|---:|---:|---|
| `/responsibilities` | 29/40 | **34/40** | H2、H4、H6、H7、H10 各加 1 分。统一 Goals 用语，显示每项所属 Bot，并提供按 Bot 查看目标和例行任务的入口。 |
| `/responsibilities?view=goals` | 30/40 | **33/40** | H4、H6、H7 各加 1 分。命名与单个 Bot 页面一致，标题显示当前 Bot，选择器和导航可触达，返回入口明确。 |
| `/tasks` | 30/40 | **31/40** | H2 加 1 分。页面说明涵盖 Active 与 Up next，嵌入目标与独立列表用相同方式显示所属 Bot。 |
| `/capabilities/memory` | 30/40 | **32/40** | H1–H10 为 4 · 3 · 3 · 3 · 3 · 4 · 4 · 2 · 4 · 2。H1、H7 各加 1 分。筛选计数、无匹配与空列表可区分，键盘操作后焦点返回筛选框。 |

目标页与 Tasks 用同名的两项目标复验。目标页验证 Team 与 Personal，Tasks 验证标签切换后仍可区分归属。记忆页用 24 条记录复验，320 像素下匹配项从约 3986 CSS 像素移至 448。搜索没有增加读取请求，确认后只删除匹配的那一条。两组生产构建均覆盖 1440、390、320 像素，42 项定向测试通过，Impeccable 改动文件检测无发现。真实任务数据、物理触屏与读屏仍待验。 [Team 目标](/tmp/openbot-order2-review/goals-team-production.log) · [Personal 目标](/tmp/openbot-order2-review/goals-personal-production.log) · [Tasks](/tmp/openbot-order2-review/tasks-ownership-production.log) · [记忆搜索](/tmp/openbot-order2-review/memory-discovery-production.log) · [测试](/tmp/openbot-order2-review/low-pages-final-tests.log)

## 通用设置恢复复评

`/settings/` 从 30/40 升至 **33/40（82.5%，暂定）**。H1–H10 为 4 · 3 · 3 · 4 · 3 · 3 · 4 · 3 · 3 · 3。H1 增 1 分，姓名和常驻指示区分加载、空值及失败，保存成功适时播报。H7 增 1 分，可跳至个人信息、外观及快捷键并聚焦目标标题。H9 增 1 分，常驻指示读取失败可在对话框重试，聚焦恢复的编辑器，保存失败可携原稿再次提交。

生产构建 `index-_GvzkLrh.js` 在 1440、390、320 像素验证 503 读取恢复、保存失败保留草稿、重试保存成功，以及通过键盘跳到快捷键标题。Impeccable 源码检测无发现。桌面端独有设置、长名称和读屏仍待复验。 [生产复验](/tmp/openbot-order2-review/general-recovery-production.log) · [整改前](/tmp/openbot-order2-review/general-recovery-baseline.log) · [320 像素恢复状态](/tmp/openbot-order2-review/general-recovered-control-320.png)

## 个人技能查找复评

`/capabilities/skills` 从 31/40 升至 **34/40（85%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 3 · 4 · 4 · 3 · 4 · 3。H1 增 1 分，显示匹配数和无匹配状态。H6 增 1 分，可按界面名称、完整斜杠命令和描述找回技能。H7 增 1 分，筛选后可打开对应技能，返回时保留筛选词，清空后焦点回到输入框。筛选仅作用于个人技能区，工作区技能可继续浏览。

生产构建 `index-BDTUKLdo.js` 在 1440、390、320 像素验证 24 条技能中的精确定位。320 像素下最后一条从 2160 CSS 像素移至 461，筛选没有增加读取请求。同一构建复验 General 的键盘跳转、读取 503 恢复及保存失败重试。19 项定向测试与 Web 类型检查通过，Impeccable 源码检测无发现。读屏、真实部署中的长清单以及桌面端专属设置仍待检查。 [技能生产复验](/tmp/openbot-order2-review/personal-skill-search-production.log) · [General 生产回归](/tmp/openbot-order2-review/general-final-production.log) · [320 像素技能筛选](/tmp/openbot-order2-review/personal-skill-search-320.png) · [定向测试](/tmp/openbot-order2-review/general-skills-tests.log)

## 设备筛选与 Activity 恢复复评

| 页面 | 上轮 | 本轮暂定 | 加分依据 |
|---|---:|---:|---|
| `/admin/computers` | 31/40 | **33/40（82.5%）** | H1–H10 为 4 · 3 · 3 · 3 · 4 · 4 · 4 · 2 · 4 · 2。H2 与 H7 各增 1 分。没有启动时间时仍读到运行状态。按人员、Bot 或状态筛选，可直接确认更新或重置对应设备。 |
| `/s/activity` | 31/40 | **34/40（85%）** | H1、H7、H9 各增 1 分。首次读取失败仍可进入已授权的审计记录。刷新失败保留上次记录，同时停用旧操作。读取恢复后聚焦 In progress，长标题在详情可完整换行。 |

24 台模拟设备在 1440、390、320 像素通过生产复验。320 像素下最后一台从约 6535 CSS 像素移至 609。筛选不增加读取，取消重置不写入，更新精确命中对应设备，成功后焦点回到搜索框。Team 与 Personal 的确认、目标复查及不确定写入提示通过回归。 [设备筛选生产复验](/tmp/openbot-order2-review/fleet-discovery-final-production.log) · [设备操作回归](/tmp/openbot-order2-review/fleet-discovery-action-regression.log) · [320 像素筛选](/tmp/openbot-order2-review/fleet-after-320.png)

Activity 在生产构建 `index-wkZWFZlJ.js` 的 1440、390、320 像素复验。首次 503 不影响已授权的审计入口。重试后焦点进入 In progress，长标题可读。后续 503 保留上次记录并隐藏停止、取消，返回 403 后隐藏旧记录和审计入口。25 项定向测试和类型检查通过，改动文件 Impeccable 检测无发现。真实设备与辅助技术仍待验。 [活动生产复验](/tmp/openbot-order2-review/activity-read-release-production.log) · [故障基线](/tmp/openbot-order2-review/activity-read-baseline.log) · [定向测试](/tmp/openbot-order2-review/fleet-activity-final-tests.log)

## 任务读取与人员搜索复评

| 页面 | 上轮 | 本轮暂定 | 加分依据 |
|---|---:|---:|---|
| `/tasks` | 31/40 | **35/40（87.5%）** | H1、H5、H7、H9 各增 1 分。临时故障区分缓存、只读与恢复状态。权限拒绝移除缓存行，原生会话链接和 44 CSS 像素操作可用，重试聚焦首个任务分组。 |
| `/admin/people` | 32/40 | **34/40（85%）** | H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 3 · 2。H6 和 H7 各增 1 分。上一组结果及操作不会留在新查询下，无匹配时可清空并继续操作。 |

生产构建 `index-DpxvvQuF.js` 覆盖 1440、390、320 像素。Tasks 在 503 后保留记录与会话链接、隐藏写操作，重试恢复写操作与焦点，403 后移除旧任务。People 复验搜索防抖窗口内旧操作消失、去除首尾空格后只发送一次请求、确认框对应新结果、清空搜索后保留键盘焦点。28 项定向测试与类型检查通过，Impeccable 源码检测无发现。真实角色变动、任务长期运行与辅助技术仍待验。 [任务生产复验](/tmp/openbot-order2-review/tasks-read-final-production.log) · [人员生产复验](/tmp/openbot-order2-review/people-search-transition-production.log) · [定向测试](/tmp/openbot-order2-review/tasks-people-final-tests.log)

## Ideas 链接与建议读取复评

`/ideas` 从 32/40 升至 **35/40（87.5%，暂定）**。H1 增 1 分，建议首次读取失败显示重试，刷新返回 503 时保留已读建议并收起写操作。返回 403 后移除已读内容，随后再遇到 503 也不会重新显示旧内容。H3 增 1 分，失效书签在原页提供 Bot 选择器，只在选中可用 Bot 后请求建议。H7 增 1 分，窄屏将建议操作移到正文下方，主要操作至少 44 CSS 像素高。

生产构建 `index-C9AQPMLn.js` 在 Team 管理员和 Personal 模拟环境各验证 1440、390、320 像素。六组均可用键盘重试并将焦点恢复至建议标题，显示所选 Bot 的建议，无页面脚本错误。23 项定向测试通过，Impeccable 源码检测无发现。真实 Check-ins 保存、权限变更和读屏待验。 [Team 验证](/tmp/openbot-order2-review/ideas-final-team.log) · [Personal 验证](/tmp/openbot-order2-review/ideas-final-personal.log) · [320 像素截图](/tmp/openbot-order2-review/ideas-recovered-320.png)

## 创建 Bot 框架查找复评

`/bots?new=true` 从 32/40 升至 **34/40（85%，暂定）**。H6 增 1 分，可按名称或描述从 13 个选项中查找框架，搜索显示匹配数和无结果提示。H7 增 1 分，筛选后可直接用键盘进入连接设置，返回时保留筛选词，清空后焦点回到搜索框。输入搜索词时按 Enter 保留当前步骤。

生产构建 `index-CSJXW5Iv.js` 在 1440、390、320 像素验证框架查找和键盘往返，无页面脚本错误。320 像素下，Langroid 由距视口顶部约 1199 CSS 像素移至 278。两页合计 44 项定向测试通过，Web 类型检查通过，Impeccable 源码检测无发现。创建后档案的焦点交接、窄屏次操作与真实连接待验。 [生产验证](/tmp/openbot-order2-review/create-bot-framework-production.log) · [320 像素截图](/tmp/openbot-order2-review/create-bot-framework-filter-320.png) · [定向测试](/tmp/openbot-order2-review/ideas-create-final-tests.log)

## 记忆状态与保存复评

`/capabilities/memory` 从 32/40 升至 **36/40（90%，暂定）**。H3 增 1 分，清空组合筛选后回到搜索框，读取重试成功后聚焦 Your memories。H5 增 1 分，只有服务端确认后才更新已存内容或移除条目，刷新失败期间收起写操作。403 清除缓存，随后 503 不会恢复被拒绝的内容。H8 增 1 分，长清单可用文字和状态同时筛选，行内保留来源、待审核与暂停状态。H10 增 1 分，说明 Bot 使用范围、暂停方式与永久删除的后果。

生产构建 `index-g5x63BBx.js` 在 Team 模拟环境的 1440、390、320 像素复验写入失败保留原稿、保存和删除成功后列表刷新失败、权限拒绝后再次读取失败、键盘重试及组合筛选。24 条记录的搜索与删除通过回归。20 项定向测试和 Web 类型检查通过，Impeccable 源码检测无发现。真实 Bot 的记忆使用范围、跨设备同步和读屏待验。 [整改前](/tmp/openbot-order2-review/memory-states-baseline.log) · [生产验证](/tmp/openbot-order2-review/memory-states-production.log) · [320 像素截图](/tmp/openbot-order2-review/memory-states-after-320.png) · [定向测试](/tmp/openbot-order2-review/memory-states-final-tests.log)

## 审计权限与搜索复评

`/admin/audit` 从 32/40 升至 **35/40（87.5%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 4 · 4 · 4 · 3 · 4 · 3。H5 增 1 分，收到 401 或 403 后清除各视图的旧记录和分页位置，收起提问、详情、翻页和导出入口。临时读取故障仍可查看已加载记录。H6 增 1 分，搜索框及导出操作说明各自覆盖的记录范围。H7 增 1 分，键盘可直接清空文字搜索并保留当前筛选和输入焦点，权限恢复后可在原页刷新。

生产构建 `index-CC3sqtSA.js` 在 Team 管理员模拟环境的 1440、390、320 像素复验 503 缓存、403 后切换筛选视图、再次 503、迟到的提问结果和授权恢复。三组均无页面脚本错误。原有翻页与提问流程通过回归，Personal 的 `/settings/activity` 在 390 像素通过权限与刷新回归。76 项审计定向测试通过，Impeccable 源码检测无发现。全历史文字搜索、真实权限变动与读屏待验。 [整改前](/tmp/openbot-order2-review/audit-access-baseline.log) · [生产验证](/tmp/openbot-order2-review/audit-access-production.log) · [320 像素权限拒绝](/tmp/openbot-order2-review/audit-denied-320.png) · [Personal 回归](/tmp/openbot-order2-review/audit-personal-regression.log) · [定向测试](/tmp/openbot-order2-review/audit-access-final-tests.log)


## 个人 Activity 复评

Personal 的 `/settings/activity` 从 29/40 升至 **34/40（85%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 4 · 4 · 4 · 3 · 3 · 3。H1 与 H9 各增 1 分，区分加载、无匹配、暂时失败和权限拒绝。H5 增 1 分，403 后清除原有活动与导出入口。H7 增 1 分，当前搜索可继续匹配新加载的更早记录，清空后焦点回到输入框。H10 增 1 分，导出及本地筛选范围有可见说明。

生产构建 `index-CC3sqtSA.js` 在 1440、390、320 像素验证搜索、翻页后的匹配、范围说明、503 保留记录、403 清除、权限恢复及键盘焦点，无页面脚本错误或横向溢出。真实服务和读屏尚待验收，窄屏工具区仍占首屏较多空间。 [Personal 生产验证](/tmp/openbot-order2-review/personal-activity-review.log) · [320 像素截图](/tmp/openbot-order2-review/personal-activity-after-320.png)

## 身份提供商注册复评

`/admin/identity-providers` 从 32/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3。H2 增 1 分，邮箱域名说明直接解释登录范围。H3 增 1 分，明确拒绝后保留修改上下文，取消核对后迟到的读取响应不会关闭新草稿。H6 增 1 分，协议选中状态可读取，输入说明关联对应字段，重复名称在字段旁提示。H7 增 1 分，主要表单操作至少高 44 CSS 像素，失败说明与核对按钮同时可见，键盘可从核对返回提交或关闭表单。H10 增 1 分，注册结果未确认时提供只读核对；已存在时回到清单，未找到时保留原稿并恢复提交。

读取失败后保留最近清单供查看，并暂停注册和移除。401 或 403 清除缓存，随后 503 也不会显示旧清单。真实 SAML/OIDC 登录回跳、读屏和实体触屏仍待验。

生产构建 `index-JKBTU1my.js` 在 Team 模拟环境的 1440、390、320 像素验证 SAML 与 OIDC 表单、重复名称、明确拒绝、服务端已写但响应不明、列表核对失败、取消后迟到的响应与键盘焦点。三组均无页面脚本错误。30 项分组定向测试、Web 类型检查与 Impeccable 源码检测通过。 [生产验证](/tmp/openbot-order2-review/identity-registration-final-production.log) · [320 像素核对错误](/tmp/openbot-order2-review/identity-registration-uncertain-320.png) · [清单与移除回归](/tmp/openbot-order2-review/identity-registration-directory-regression.log) · [Require SSO 回归](/tmp/openbot-order2-review/identity-registration-final-policy.log)

## 设备状态与操作复评

Team 的 `/admin/computers` 与 Personal 的 `/settings/computer` 均从 33/40 升至 **36/40（90%，暂定）**。Team 的 H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3，H3、H8、H10 各增 1 分。Personal 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3，H3、H7、H10 各增 1 分。停止前说明浏览器工作会中断而登录保留，取消不提交。旧设备状态可读，操作入口收起。设备和文件夹分别提供具名重试，设备读取得以恢复后焦点回到列表标题。操作说明移到清单前并可展开，不必先浏览设备。

生产构建 `index-CLyS619v.js` 在 Team 与 Personal 的 1440、390、320 像素验证取消、503、403 后再次 503、状态变化拦截、一次写入和回执。24 台设备搜索、更新、重置及结果未确认提示通过回归。94 项定向测试、Web 类型检查及 Impeccable 源码检测通过。实体设备、长时间操作和读屏仍待验。 [整改前](/tmp/openbot-order2-review/device-stale-actions-baseline.log) · [生产验证](/tmp/openbot-order2-review/device-recovery-release.log) · [320 像素只读状态](/tmp/openbot-order2-review/device-stale-actions-320.png) · [搜索回归](/tmp/openbot-order2-review/device-recovery-release-search.log) · [更新和重置回归](/tmp/openbot-order2-review/device-recovery-existing-actions.log) · [定向测试](/tmp/openbot-order2-review/device-recovery-final-tests.log)

## Routines 查找与删除复评

`/routines` 从 33/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3。H2 增 1 分，显示自然的下次执行时间及已有排程时区。H5 增 1 分，503 后清单和历史可读，旧写操作收起。权限被拒后清除清单与历史，随后再遇到 503 也不会显示旧记录。删除前复查目标，服务端确认删除后即移除条目。H6 增 1 分，可按名称、任务内容、Bot、排程、状态或会话搜索，并显示匹配数。H7 增 1 分，清空和删除后的焦点回到筛选框，读取恢复后可继续原筛选。

生产构建 `index-DPdl4Fs7.js` 在 1440、390、320 像素用 24 条模拟数据验证搜索、权限恢复和删除。320 像素下最后一项从距视口顶部约 7159 CSS 像素移至 532，搜索无新增读取。三种宽度均验证取消与目标变化不写入，确认后只删除一次，删除回执后的 503 不恢复条目。单 Bot Routines 的开关、触区、删除取消、并发写入和历史切换通过回归。32 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实调度、跨时区与读屏待验。 [整改前](/tmp/openbot-order2-review/routines-find-stale-baseline.log) · [生产验证](/tmp/openbot-order2-review/routines-find-recovery-release.log) · [触区回归](/tmp/openbot-order2-review/routines-find-recovery-release-touch.log) · [并发写入回归](/tmp/openbot-order2-review/routines-find-recovery-release-writes.log) · [320 像素只读状态](/tmp/openbot-order2-review/routines-find-recovery-320.png)

## 通用设置草稿复评

`/settings/` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3 · 4 · 3。H3 增 1 分，关闭已修改的姓名或常驻指示编辑器时，用户可继续编辑或放弃。继续编辑恢复原控件焦点，关闭后回到原设置行。H5 增 1 分，输入未变更或仅改动边缘空格时禁用保存，保存期间防止再次提交和关闭。H9 增 1 分，失败时保留原稿及服务端说明，可在原位重试。姓名保存回执同步更新当前用户缓存，随后刷新返回 503 仍显示已保存名称。

生产构建 `index-DW_FdYp6.js` 在 1440、390、320 像素验证两种编辑器的键盘退出、保留与放弃草稿、保存失败和重试、无变更退出，以及姓名保存成功后刷新失败。常驻指示首读恢复与页面分组导航通过回归。50 项定向测试、Web 类型检查和 Impeccable 源码检测通过。桌面端专属设置和实际读屏仍待验。 [整改前](/tmp/openbot-order2-review/general-name-draft-baseline.log) · [生产验证](/tmp/openbot-order2-review/general-draft-production.log) · [读取与分组回归](/tmp/openbot-order2-review/general-draft-recovery-regression.log) · [320 像素草稿确认](/tmp/openbot-order2-review/general-draft-confirmation-320.png)

## Goals 查找与恢复复评

| 页面 | 上轮 | 本轮暂定 | 加分依据 |
|---|---:|---:|---|
| 全部 Goals | 34/40 | **37/40（92.5%）** | H1、H5、H9 各增 1 分。区分查找无结果、临时故障和权限拒绝。旧目标只读。历史读取可原位重试。 |
| 按 Bot 查看 Goals | 33/40 | **36/40（90%）** | H1、H5、H9 各增 1 分。保留授权范围内的最近记录，刷新和 Bot 查找分别恢复到对应控件。 |
| 单个 Bot 的 Goals 页面 | 35/40 | **37/40（92.5%）** | H5、H7 各增 1 分。暂时无法刷新时关闭旧写操作，按名称、任务和状态筛选可直接进入目标详情。 |

生产构建 `index-D_feQqm9.js` 对三个入口各验证 1440、390、320 像素。按 Bot 查看时，320 像素下最后一项从距视口顶部约 2117 CSS 像素移至 610。搜索无额外读取，运行历史重试回到对应标题，403 清除旧目标及相关缓存。Personal 的同名目标归属和切换通过回归。21 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实 Bot 执行、写入和读屏仍待验。 [生产验证](/tmp/openbot-order2-review/goals-search-release.log) · [Bot 选择恢复](/tmp/openbot-order2-review/goals-search-roster-regression.log) · [Personal 回归](/tmp/openbot-order2-review/goals-search-personal-regression.log) · [320 像素筛选](/tmp/openbot-order2-review/goals-search-after-320.png)

## 个人技能读取与编辑复评

`/capabilities/skills` 从 34/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 4 · 4 · 4 · 3 · 4 · 4。H5 增 1 分，临时故障时搜索仍可用，新建、编辑、授权和删除入口暂停，已开启的表单保留草稿。403 清除旧技能，之后的 503 不会恢复旧内容，也不会被呈现为空列表。工作区技能不能通过直达链接打开个人编辑表单。H10 增 1 分，列表和编辑器说明可继续做什么，重试各自聚焦对应标题。

生产构建 `index-DoRafp2C.js` 在 Team 和 Personal 下各验证 1440、390、320 像素，覆盖暂时故障、权限拒绝、再次失败和恢复。24 条技能的搜索和返回复验通过。36 项定向测试、Web 类型检查和 Impeccable 源码检测通过。主动关闭后的草稿保护、真实角色与 Bot 授权及读屏仍待验。 [Personal 验证](/tmp/openbot-order2-review/personal-skill-recovery-production.log) · [Team 验证](/tmp/openbot-order2-review/team-personal-skill-recovery-production.log) · [搜索回归](/tmp/openbot-order2-review/personal-skill-recovery-search.log) · [320 像素编辑器](/tmp/openbot-order2-review/personal-skill-recovery-editor-320.png)

## 会话交接状态与重试复评

`/start/$startId` 从 26/36 升至 **31/36（86.1%，暂定）**。H1–H10 为 4 · 3 · 3 · 3 · 3 · 4 · — · 4 · 4 · 3。H1 显示账户加载和正在进行的步骤。H6 显示已保存的附件名。H8 交接仅显示消息预览与恢复操作，移除停用的输入框与重复的 Bot 介绍。H9 键盘重试回到标题，失效链接提供可直接使用的新建会话入口。H10 解释如何从原浏览器和首页恢复。

生产构建 `index-B7MI1eI1.js` 在 Team 和 Personal 下各验证 1440、390、320 像素。连续两次创建失败后恢复至同一会话交接，三次提交复用同一请求标识。窄屏长文件名可换行，重试与新建均达到 44 CSS 像素触区。两页合计 70 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实服务的断线重发、审批恢复和读屏仍待验。 [Team 验证](/tmp/openbot-order2-review/start-recovery-design-production.log) · [Personal 验证](/tmp/openbot-order2-review/start-recovery-design-personal-production.log) · [320 像素恢复状态](/tmp/openbot-order2-review/start-recovery-error-40177-320.png)

## 技能详情与 Bot 授权复评

`/admin/skills/$slug` 与 `/settings/skills/$slug` 均暂定 **38/40（95%）**。上轮 Team 为 36/40，Personal 的 31/40 为待复评旧分，两者曾共用 D 轮 36/40 的评语。本轮分别核验，H1–H10 均为 4 · 3 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4。Bot 清单在加载或失败时显示相应状态。部分成功时，已确认的记录可以查阅，授权开关暂停。技能刷新失败时保留草稿，暂停保存、授权和删除。403 后再次遇到 503 不会显示旧技能或误报已删除。两种重试均把键盘焦点交给 Bots 标题。

生产构建 `index-DtOm8fze.js` 对两个入口各验证 1440、390、320 像素。真实授权与读屏仍待验。 [整改前](/tmp/openbot-order2-review/managed-skill-baseline.log) · [Team 验证](/tmp/openbot-order2-review/managed-skill-team-production.log) · [Personal 验证](/tmp/openbot-order2-review/managed-skill-personal-production.log) · [320 像素草稿](/tmp/openbot-order2-review/managed-skill-recovery-personal-320.png)

## Playground 草稿保护复评

`/admin/playground` 从 33/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 3 · 4 · 4 · 4。H1、H3、H5、H9 各增 1 分。列表正在加载、读取失败和成功的空列表有不同提示。打开另一个组件前，如果有未保存编辑，先确认是否替换，取消后保留编辑并把焦点还给对应行。保存后可直接打开另一份草稿。保存列表原位重试保留编辑内容，并将焦点移到列表标题。

生产构建 `index-DFXg_itg.js` 在 1440、390、320 像素验证草稿保护，发布确认、取消和成功回执通过回归。两项整改合计 57 项定向测试、Web 类型检查及 Impeccable 源码检测通过。离开页面时的草稿保护、真实组件发布与读屏仍待验。 [整改前](/tmp/openbot-order2-review/playground-draft-baseline.log) · [浏览器验证](/tmp/openbot-order2-review/playground-draft-production.log) · [发布回归](/tmp/openbot-order2-review/playground-publication-regression.log) · [320 像素确认](/tmp/openbot-order2-review/playground-draft-guard-320.png)

## 快速会话书签与首发指引复评

`/bot` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 3 · 4 · 3 · 4 · 4 · 3 · 4 · 4。H1 增 1 分，Bot 清单和具名 Bot 查询各有独立的失败状态与重试。具名书签在清单 503 时仍可查询对应 Bot。未找到或权限不足时可以返回 Bots。H6、H10 各增 1 分，在输入前可看到当前 Bot 的用途，键盘重试后焦点回到会话标题。草稿原有的隔离、刷新与重新开始行为通过回归。

生产构建 `index-ewgi5pjZ.js` 在 Team 和 Personal 下各验证 1440、390、320 像素。真实网关发送、完整首发引导及读屏仍待验。 [整改前](/tmp/openbot-order2-review/quick-bot-recovery-baseline.log) · [Team 验证](/tmp/openbot-order2-review/quick-bot-recovery-team.log) · [Personal 验证](/tmp/openbot-order2-review/quick-bot-recovery-personal.log) · [320 像素用途提示](/tmp/openbot-order2-review/quick-bot-purpose-40177-320.png)

## 个人审批设置权限与读取恢复复评

`/settings/approvals` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 4 · 3 · 3 · 4 · 3 · 3 · 4 · 4 · 4。H1、H9、H10 各增 1 分。短暂故障可查看只读设置。401 或 403 清除旧审批数据，随后再次遇到 503 时无法恢复旧控件。权限提示说明下一步，具名重试恢复后把键盘焦点交给 Before a Bot acts。

生产构建 `index-ewgi5pjZ.js` 在 Team 和 Personal 下各验证 1440、390、320 像素。设置提交、组织规则限制与共享 Bot 重置确认通过回归。两页合计 46 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实权限传播、审批结果和读屏仍待验。 [整改前](/tmp/openbot-order2-review/approval-settings-cache-baseline.log) · [Team 验证](/tmp/openbot-order2-review/approval-settings-cache-team.log) · [Personal 验证](/tmp/openbot-order2-review/approval-settings-cache-personal.log) · [设置回归](/tmp/openbot-order2-review/approval-settings-cache-regression.log)

## 审批指导并发编辑复评

`/admin/approvals/guidance` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 3 · 3 · 4 · 4 · 4。H1、H9、H10 各增 1 分。保存与删除均按操作开始时的已保存内容校验。发生冲突时，编辑器保留草稿并显示可展开的最新指导。选择保留草稿后焦点回到编辑器，提交前须重新检查。编辑期间迟到的检查响应不会给当前草稿开放保存。

生产构建 `index-dUMd81so.js` 在模拟接口下通过 1440、390、320 像素浏览器复验，草稿退出和恢复流程通过回归。9 项前端测试及 6 项 PostgreSQL 集成测试通过。两次并发保存仅一次生效且只新增一条审计记录，过期删除返回 409。Impeccable 源码检测为 0 项。真实模型与读屏仍待验。 [整改前](/tmp/openbot-order2-review/guidance-conflict-baseline.log) · [生产版浏览器验证](/tmp/openbot-order2-review/guidance-conflict-production-final.log) · [草稿回归](/tmp/openbot-order2-review/guidance-conflict-draft-regression.log) · [320 像素冲突状态](/tmp/openbot-order2-review/guidance-concurrent-320.png) · [PostgreSQL 复验](/tmp/openbot-order2-review/guidance-conflict-server-final.log)

## What if 权限与场景重置复评

`/admin/what-if` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 3 · 3 · 4 · 3。H3 提升，同页打开新审计链接会更新场景，重新开始会清除旧链接，并把焦点还给问题输入框。H5 提升，词表、提问或检查返回 401 或 403 时清除旧结果和草稿，后来遇到 503 也不会恢复。暂时失败时可查看标明来源的上次结果。H9 提升，词表重试成功后焦点回到 The action。

生产构建 `index-DAQq39Zl.js` 在 1440、390、320 像素通过模拟浏览器验证。原有六层判定、解释展开和重试焦点通过回归。6 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实权限传播、模型解读及读屏仍待验。 [整改前](/tmp/openbot-order2-review/what-if-recovery-baseline.log) · [生产验证](/tmp/openbot-order2-review/what-if-recovery-production.log) · [判定回归](/tmp/openbot-order2-review/what-if-access-verdict-regression.log)

## Teach a Bot 权限缓存复评

`/browser` 从 33/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 3 · 3 · 4 · 4。H5 提升，权限被拒后清除旧浏览器状态，随后读取失败不会再次挂载画面或发送打开请求。H6 提升，浏览器状态与录像清单的重试按钮分别命名。H10 提升，权限拒绝后提示确认访问权，只有重新读到授权状态才恢复画面。

生产构建 `index-DyFn8Nj1.js` 在 Team 与 Personal 下各验证 1440、390、320 像素。浏览器重开失败、录像独立重试和普通 503 时保留画面通过回归。两页共 80 项定向测试通过，最终 What if 定向测试及 Web 类型检查重新通过。真实串流、实体触屏和读屏待验。 [整改前](/tmp/openbot-order2-review/browser-cache-baseline.log) · [Team 验证](/tmp/openbot-order2-review/browser-cache-team.log) · [Personal 验证](/tmp/openbot-order2-review/browser-cache-personal.log) · [重开回归](/tmp/openbot-order2-review/browser-cache-reopen-regression.log)

## Learning 读取与保存复评

| 页面 | 上轮 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/admin/learning` | 35/40 | **37/40（92.5%）** | 4 · 3 · 3 · 4 · 4 · 4 · 4 · 3 · 4 · 4 |
| `/settings/learning` | 35/40 | **37/40（92.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 3 |

管理端 Participation 读取故障时保留正在编辑的草稿并暂停保存。保存期间锁定表单，成功后仅保留服务端已确认的值。权限被拒后隐藏草稿和旧设置，下一次 503 不能恢复旧控件。技能审阅和技能列表分别保留标题、加载状态与具名重试，键盘恢复到对应区块的标题。

生产构建 `index-BrACVgJp.js` 在 1440、390、320 像素验证 Team 管理端和个人设置入口，以及 Personal 版个人设置。85 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实 Learning 后端、跨管理员编辑和读屏仍待验。 [整改前](/tmp/openbot-order2-review/learning-safe-baseline.log) · [Team 验证](/tmp/openbot-order2-review/learning-safe-production-final.log) · [Personal 验证](/tmp/openbot-order2-review/learning-safe-personal-production.log) · [320 像素个人恢复](/tmp/openbot-order2-review/learning-read-recovery-40177-320.png)


## 通知渠道与保存恢复复评

按 Impeccable 的十项启发式复评，`/settings/notifications` 从 E 轮 37/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。渠道读取 503 原先会显示 16 个可编辑开关。现在先确认渠道，再显示已配置的选项。写入失败时保留已保存的状态，提示贴近对应行，并指出具体渠道。重试重新读取设置，将本次改动合入最新记录，保留同时更新的其他渠道。恢复后键盘焦点返回区块标题。

Astryx 开关的原生输入不再遮住轨道。浅色和深色关闭态的轨道与拇指对比均超过 5.4∶1，粗指针触区为 44×44 CSS 像素。强制颜色模式保留原生控件。Team 和 Personal 均以模拟接口在 1440、390 和 320 像素复验。继续核对真实投递、设备读屏和并发修改同一渠道。 [整改前](/tmp/openbot-order2-review/notification-routing-baseline.log) · [Team 浏览器复验](/tmp/openbot-order2-review/notification-routing-team.log) · [Personal 浏览器复验](/tmp/openbot-order2-review/notification-routing-personal.log) · [开关对比度](/tmp/openbot-order2-review/notification-switch-contrast-final.log) · [320 像素失败状态](/tmp/openbot-order2-review/notification-save-failure-40175-320.png)

## Recorder 断开与读取恢复复评

`/settings/browsers` 从 34/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 4。列表读取失败时可以查看已确认的缓存行，暂停断开操作。提交前核对目标，503 在弹窗内提供独立重试，读到最新状态后再由用户确认。读到 401 或 403 时关闭旧弹窗并清除缓存，后续 503 不会恢复旧连接。成功断开后焦点移到回执，列表成功恢复后聚焦 Connected browsers。

生产构建 `index-DlAGrQAw.js` 在 Team 的 1440、320 像素和 Personal 的 390 像素使用模拟接口复验。两页共 57 项定向测试通过，另有 13 项共享开关回归测试通过。Web 类型检查和生产构建通过，Impeccable 对两个页面组件的源码检测无发现。正式商店安装、真实服务、设备读屏和实体触屏仍待验。 [整改前](/tmp/openbot-order2-review/recorder-disconnect-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/recorder-disconnect-final.log) · [320 像素弹窗](/tmp/openbot-order2-review/recorder-disconnect-unverified-320.png) · [定向测试](/tmp/openbot-order2-review/notification-recorder-final-tests.log)


## 个人 Activity 移动端浏览与翻页复评

`/settings/activity` 从 34/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 4 · 3 · 3。H3 增 1 分，加载结果导致翻页按钮卸载时，键盘焦点回到结果摘要。H8 增 1 分，视图合为写明当前选项的菜单，搜索或表格筛选改变范围时再展开对应说明。CSV 与本地筛选的范围仍可由辅助技术查阅。320 像素下工具栏从 479 降至 240 CSS 像素，首条记录由第 737 提前到第 498 像素。菜单项触区为 44 CSS 像素，浅色、深色的高亮文字对比度分别约为 18.0∶1、14.1∶1。

生产构建 `index-DFdqg1y3.js` 在 Personal 的 1440、390、320 像素模拟核验键盘视图、翻页、503 缓存、403 隐藏以及权限恢复。全历史文字搜索、实际读屏和真实审计记录仍待验。 [整改前](/tmp/openbot-order2-review/personal-activity-compact-before.log) · [生产复验](/tmp/openbot-order2-review/personal-activity-compact-final.log) · [320 像素菜单](/tmp/openbot-order2-review/personal-activity-views-320.png)

## GitHub 账户与工具连接复评

`/connections/github` 从 34/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 3 · 3 · 4 · 3 · 4 · 4 · 4 · 4 · 4。H1 增 2 分，账户仍在读取时保留区块及加载提示，工具目录或连接读取失败时显示对应原因。连接请求失败原先显示未连接，现可区分。H9 增 1 分，各区块的具名重试成功后聚焦相应标题。

同一生产构建在 Team 的 1440、390、320 像素模拟复验。两页共 62 项定向测试通过，Web 类型检查通过，Impeccable 对四个组件的源码检测无发现。实际 GitHub 授权、断开后的端到端影响和读屏仍待验。 [整改前](/tmp/openbot-order2-review/github-tools-baseline.log) · [生产复验](/tmp/openbot-order2-review/github-tools-verified.log) · [320 像素重试](/tmp/openbot-order2-review/github-tools-recovery-320.png) · [定向测试](/tmp/openbot-order2-review/activity-github-final-tests.log)


## Activity 停止取消与 Bot 档案复评

| 页面 | 上轮 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/s/activity` | 34/40 | **37/40（92.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 3 |
| `/bots/$agentId/activity` | 36/40 | **38/40（95%）** | 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 |
| `/bots/$agentId` | 34/40 | **36/40（90%）** | 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3 |

停止和取消此前在首次按键时直接写入，503 没有反馈。现在显示具体任务和操作影响，初始焦点在取消按钮。确认及失败后重试都先读取最新状态，任务已结束时不会提交。成功给出回执并恢复键盘焦点。401 或 403 清除旧活动，随后再次遇到 503 也不会显示旧行。可读取的临时缓存只供查阅。

Bot 档案的删除确认从 27 CSS 像素增至 44 CSS 像素。请求未结束时无法误关弹窗，503 在弹窗内显示重试，取消后焦点回到原行。Team 和 Personal 保留各自的删除影响说明。

生产构建 `index-DfVuD2hG.js` 使用模拟接口复验 Team 和 Personal 的 1440、390、320 像素场景。41 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实任务中止、删除后的真实数据状态和读屏仍待验。 [操作基线](/tmp/openbot-order2-review/activity-action-baseline.log) · [统一 Activity](/tmp/openbot-order2-review/activity-action-final.log) · [权限与缓存](/tmp/openbot-order2-review/activity-action-read-verified.log) · [单 Bot Activity](/tmp/openbot-order2-review/activity-action-bot.log) · [Bot 档案](/tmp/openbot-order2-review/activity-action-profile.log) · [删除触区基线](/tmp/openbot-order2-review/bot-delete-before.log) · [删除复验](/tmp/openbot-order2-review/bot-delete-final.log) · [320 像素删除失败](/tmp/openbot-order2-review/bot-delete-dialog-320.png)


## 创建 Bot 提交与焦点复评

`/bots?new=true` 从 34/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3。在 Team 的模拟环境，应用授权未返回时再按 Enter，此前会发出两次创建请求。现在从提交到应用授权结束只处理一次。503 保留姓名并可再次提交。成功后等创建面板关闭，再跳转到 Bot 档案。档案数据即使晚到，键盘焦点也落在新 Bot 标题。返回时回到 Bot 清单。

320 像素下，底部操作区由 173 降至 129 CSS 像素，取消与创建同排。生产构建 `index-ClI6rIzu.js` 在 Team 1440、320 像素和 Personal 390 像素通过模拟创建，另在三种宽度复验自定义框架查找。真实自定义连接、实际授权与读屏仍待验。 [基线](/tmp/openbot-order2-review/create-bot-handoff-baseline.log) · [创建复验](/tmp/openbot-order2-review/create-bot-handoff-release.log) · [框架查找回归](/tmp/openbot-order2-review/create-bot-handoff-framework.log) · [320 像素底部操作](/tmp/openbot-order2-review/create-bot-handoff-after-320.png)

## 人员权限和缓存复评

`/admin/people` 从 34/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 3。H9 提升，401 和 403 有单独说明，键盘重试恢复后焦点回到 Who is here。H10 提升，临时失败时说明何时可以再次操作。权限被拒时清空所有搜索的缓存和翻页位置，随后换回原搜索遇到 503 不会恢复旧名单。单独的 503 保留已见记录，并收起授权、移除访问和停止电脑等操作。

同一生产构建在 1440、390、320 像素通过权限和搜索切换复验。34 项定向测试、Web 类型检查、Impeccable 源码检测通过。真实角色变更和设备读屏仍待验。 [基线](/tmp/openbot-order2-review/people-access-baseline.log) · [浏览器验证](/tmp/openbot-order2-review/people-access-final.log) · [搜索回归](/tmp/openbot-order2-review/people-search-access-regression.log) · [320 像素只读状态](/tmp/openbot-order2-review/people-access-stale-320.png) · [定向测试](/tmp/openbot-order2-review/create-bot-people-tests.log)


## 管理首页搜索排序复评

`/admin/` 从 34/40 升至 **36/40（90%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 3。H7 提升，精确名称先于标题前缀及分类、描述匹配，搜索 People 时首项为 People。支持重音字符的输入差异。H8 提升，搜索时将跨分类的结果合成一份列表，清空后恢复分类浏览。桌面及窄屏都验证了 Enter 聚焦首项和浏览器后退恢复已打开结果的键盘焦点。

生产构建 `index-BZ-7du1j.js` 在 1440、390、320 像素复验，并验证 Team 普通成员和 Personal 版访问管理地址时跳转到各自允许的页面。实际管理员任务与读屏仍待验。 [排序基线](/tmp/openbot-order2-review/admin-search-ranked-baseline.log) · [排序与焦点复验](/tmp/openbot-order2-review/admin-search-ranked-final.log) · [角色与搜索回归](/tmp/openbot-order2-review/admin-search-ranked-regression.log) · [320 像素结果](/tmp/openbot-order2-review/admin-search-ranked-after-320.png)

## 组件图库搜索与恢复复评

| 页面 | 基线 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/settings/components-gallery/` | 25/40 | **37/40（92.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 3 |
| `/settings/components-gallery/$name` | 25/40 | **37/40（92.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 3 |

此两页此前已修复首载与错误提示，暂定分仍待补。本轮图库按名称、说明和组件标识查找已发布条目，有匹配数、无匹配反馈和清空入口。Enter 聚焦首个结果，详情返回保留查询。320 像素下长标题和标识符完整换行。目录及详情的独立重试分别聚焦图库标题与组件标题。

同一生产构建在 Team 的 1440、320 像素与 Personal 的 390 像素模拟复验。27 项定向测试、Web 类型检查、Impeccable 源码检测均通过。真实组件发布、对话中的组件可用性和读屏仍待验。 [基线](/tmp/openbot-order2-review/gallery-search-baseline.log) · [生产浏览器验证](/tmp/openbot-order2-review/gallery-search-final.log) · [320 像素详情](/tmp/openbot-order2-review/gallery-detail-after-320.png) · [定向测试](/tmp/openbot-order2-review/admin-gallery-final-tests.log)


## 例行任务与技能草稿复评

| 页面 | 上轮参考 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/routines/new` | E 轮 38/40 | **39/40（97.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |
| `/admin/skills/new` | E 轮 36/40 | **38/40（95%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 |
| `/settings/skills/new` | D 轮 36.5/40 | **38/40（95%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 |

新建例行任务原先可直接取消并丢失已输入内容。现在离开时可继续编辑，未修改的表单直接返回。提交中连续触发表单只发出一次创建请求。503 后保留输入，重试成功回清单并聚焦 Routines，显示创建回执。窄屏可见的下拉选择和时间、名称等输入至少 44 CSS 像素高。

新建技能原先仅保护表单底部取消，页首返回可绕过。Team 和 Personal 现在统一保护所有离开入口。保存失败保留名称和说明并显示提示，浏览器复验无脚本异常。窄屏的保存和取消均至少 44 CSS 像素高。

生产构建 `index-ELg-zMqD.js` 在 Team 1440、320 像素和 Personal 390 像素模拟复验。60 项定向回归、Web 类型检查、Impeccable 源码检测通过。真实排程、实际授权与读屏待验。 [例行任务基线](/tmp/openbot-order2-review/routine-create-draft-baseline.log) · [例行任务生产复验](/tmp/openbot-order2-review/routine-create-draft-verified.log) · [技能基线](/tmp/openbot-order2-review/new-skill-draft-baseline.log) · [技能生产复验](/tmp/openbot-order2-review/new-skill-draft-verified.log) · [320 像素草稿确认](/tmp/openbot-order2-review/new-skill-draft-320.png) · [定向回归](/tmp/openbot-order2-review/routine-skill-draft-tests.log)

## 组件描述草稿与发布复评

`/admin/components/$name` 本轮为 **38/40（95%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 3。基线复现描述保存返回 503 时编辑器关闭且无提示。现在保留原输入，重试成功后显示回执并将焦点归还描述行。发布失败保留已确认状态并显示重试提示，成功取消发布后页首同步。数据函数读取失败显示独立的重试入口。

生产构建 `index-DUAsJ6mh.js` 在 1440、390、320 像素通过管理员模拟复验。58 项定向测试、Web 类型检查及 Impeccable 源码检测通过。已发布组件仍缺少独立应用描述草稿的入口及相应指引。真实发布、聊天可用性和读屏待验。 [失败基线](/tmp/openbot-order2-review/component-detail-recovery-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/component-detail-recovery-final.log) · [320 像素草稿截图](/tmp/openbot-order2-review/component-detail-draft-error-320.png)

## 共享路由异常复评

| 视图 | 上轮 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| 未知地址 | 29/36 | **31/36（86.1%）** | 4 · 4 · 3 · 3 · 3 · 4 · — · 4 · 3 · 3 |
| 路由加载失败 | 28/36 | **31/36（86.1%）** | 4 · 4 · 3 · 3 · 3 · 3 · — · 4 · 4 · 3 |

三种宽度的模拟验收均通过。使用键盘重试后，持续的 503 仍保留重试和工作区入口。恢复后原查询参数保留，焦点从原先的 `BODY` 移到页面 `H1`。未知地址同样聚焦标题，入口可用键盘回到工作区。主要动作至少 44 CSS 像素高，320 像素说明与边缘留有间距。生产构建 `index-DY88dmpR.js`、18 项定向测试、类型检查与 Impeccable 源码检测通过。更广泛的路由故障类型与实际读屏待验。 [键盘基线](/tmp/openbot-order2-review/router-retry-focus-baseline.log) · [生产浏览器复验](/tmp/openbot-order2-review/router-retry-focus-final.log) · [320 像素重试页](/tmp/openbot-order2-review/route-retry-320.png) · [320 像素未知地址](/tmp/openbot-order2-review/route-missing-320.png)

## 会话收件人与失败恢复复评

`/start/$startId` 从 31/36 升至 **34/36（94.4%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · — · 4 · 4 · 3。临时服务故障以面向用户的提示替代内部错误。收件人被拒或匹配不唯一时保留原消息和附件名，提供复制正文、新选 Bot 和附件时机说明。多个匹配项仍按名称显示。已进入首条消息发送阶段的恢复流程继续使用原请求标识。

生产构建 `index-DEPgbSFO.js` 在 Team 与 Personal 的 1440、390、320 像素下模拟验证 503 重试、403、路由匹配冲突、键盘复制和重新选人。两轮失败后的成功重试仍复用同一标识。33 项定向测试、Web 类型检查与 Impeccable 源码检测通过。更换收件人时附件仍须在新会话中重新添加，真实服务和读屏待验。 [基线](/tmp/openbot-order2-review/start-recovery-actions-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/start-recovery-actions-final.log) · [320 像素复制反馈](/tmp/openbot-order2-review/start-recipient-recovery-320.png) · [定向测试](/tmp/openbot-order2-review/start-recovery-actions-tests-current.log)

## Bot 任务状态筛选复评

`/tasks` 从 35/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3。状态选择器汇总匹配项，空结果按状态说明并提供清除入口。清除后焦点回到筛选器，在 Active 与 Up next 之间切换时保留所选状态。Resolved 说明七天范围。审批查询失败时，任务仍可查阅，待审批问题在读取恢复后才重新出现。

生产构建 `index-DSIpxG6L.js` 在 Team 与 Personal 的 1440、390、320 像素模拟复验。权限拒绝后的 503 不会重新显示被清除的任务，恢复成功后才重新加载。17 项定向测试、Web 类型检查和 Impeccable 源码检测通过。Active 标签仍包含最近完成的任务。真实权限变更、长期任务和实际读屏待验。 [筛选基线](/tmp/openbot-order2-review/tasks-filter-baseline.log) · [权限基线](/tmp/openbot-order2-review/tasks-post-denial-baseline.log) · [筛选浏览器复验](/tmp/openbot-order2-review/tasks-filter-current.log) · [权限复验](/tmp/openbot-order2-review/tasks-filter-access-final.log) · [320 像素空结果](/tmp/openbot-order2-review/tasks-filter-after-320.png)


## Ideas 建议搜索复评

`/ideas` 从 35/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 3 · 4 · 4 · 4 · 4 · 4。搜索覆盖当前 Bot 的所有建议，按标题、详情和来源匹配，支持含重音字符的内容。空结果可直接清除并回到搜索框。展开与折叠入口保留键盘焦点，切换 Bot 清空查询。建议区说明开始工作会创建任务，以及忽略建议会要求接下来 30 天的 check-ins 跳过类似内容。

生产构建 `index-BZ_dCbbR.js` 在 Team 与 Personal 的 1440、390、320 像素通过模拟复验。此前的读取、权限与焦点恢复矩阵也通过。11 项定向测试、Web 类型检查和 Impeccable 源码检测通过。忽略建议仍为即点即执行，实际 Check-ins 保存和读屏待验。 [基线](/tmp/openbot-order2-review/ideas-search-baseline.log) · [搜索复验](/tmp/openbot-order2-review/ideas-search-current.log) · [Team 故障回归](/tmp/openbot-order2-review/ideas-search-regression-team.log) · [Personal 故障回归](/tmp/openbot-order2-review/ideas-search-regression-personal.log) · [320 像素空结果](/tmp/openbot-order2-review/ideas-search-after-320.png)


## Bot 列表搜索与返回复评

`/bots` 从 35/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3。按名称或角色筛选可见 Bot、查看匹配数并清除查询。搜索通过网址保留，关闭 New Bot 后仍可继续。浏览器后退恢复原结果和键盘焦点；如果原先打开的是隐藏 Bot，则展开该分组并聚焦相应条目。

生产构建 `index-gl7drM7y.js` 在 Team 与 Personal 的 1440、390、320 像素复验。Team 窄屏也验证了隐藏 Bot 的返回、503 显示旧名单和重试、403 隐藏名单及可用的工作区链接。缓存回归测试验证拒绝后的服务故障不会恢复旧名单。33 项定向测试、类型检查及 Impeccable 源码检测通过。真实角色和读屏仍待复验。搜索按可见 Bot 名称和角色匹配，隐藏 Bot 继续通过独立分组浏览。 [基线](/tmp/openbot-order2-review/bot-directory-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/bot-directory-scored.log) · [320 像素空结果](/tmp/openbot-order2-review/bot-directory-after-320.png) · [定向测试](/tmp/openbot-order2-review/bot-directory-tests-scored.log)


## Bot 记忆来源操作复评

`/bots/$agentId/memory` 从 35/40 升至 **39/40（97.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4。移除说明会停止后续读取并删除该来源已学到的记忆。取消无写入并归还焦点，确认时复查相同来源，临时故障后可在原处重试。成功移除立即更新名单，显示回执并把焦点交给 App sources。来源使用可读的同步状态，长标题可换行。来源或应用动作读取失败时暂停相关写操作。

生产构建 `index-DCKa50TY.js` 通过 Team 管理员 1440、390、320 像素模拟复验。窄屏覆盖预检权限拒绝及后续故障不恢复名单。Personal 旧书签进入 Access。27 项定向测试、类型检查及 Impeccable 源码检测通过。用户记忆链接使用明确的目标名称，逐行同步也有具名按钮。同步与启停仍主要通过行状态反馈。独立 PostgreSQL 验证移除会删除该来源的导入记录。真实第三方同步、撤销和读屏待验。 [直接删除基线](/tmp/openbot-order2-review/memory-source-removal-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/memory-source-removal-scored.log) · [320 像素确认](/tmp/openbot-order2-review/memory-source-confirm-320.png) · [定向测试](/tmp/openbot-order2-review/memory-source-removal-tests-current.log) · [PostgreSQL 删除验证](/tmp/openbot-order2-review/memory-source-removal-postgres.log)


## 边界清单定位与恢复复评

`/admin/boundaries` 从 35/40 升至 **39/40（97.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4。浏览器后退和页面内返回都能聚焦原规则，规则已被移除时回到保留原查询的搜索框。旧策略中的相同表达式合并成一个结果。列表附近说明当前规则如何生效。临时故障保留只读视图，暂停新增和切换 Trial mode。权限被拒后清除旧策略，后续遇到 503 时不会误显示旧规则或空列表。

生产构建 `index-BQ1v9R05.js` 在 1440、390、320 像素模拟复验。24 项定向测试、Web 类型检查与 Impeccable 源码检测通过。规则列表已提供生效方式说明，Trial mode 控件仍在清单下方。真实角色变更、策略生效及读屏待验。 [导航与故障验证](/tmp/openbot-order2-review/boundary-directory-verified.log) · [24 条规则搜索回归](/tmp/openbot-order2-review/boundary-directory-search-regression.log) · [320 像素故障画面](/tmp/openbot-order2-review/boundary-directory-stale-320.png) · [定向测试](/tmp/openbot-order2-review/boundary-directory-tests-scored.log)


## 审计筛选菜单恢复复评

`/admin/audit` 从 35/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。基线打开读取失败的动态筛选菜单会进入通用错误页。现在区分加载、空选项与读取失败，键盘可在菜单内重试，恢复后聚焦首个可选项。审计访问被拒会清除旧筛选选项。已加载事件的文字搜索可按任意顺序跨字段匹配多个词，并兼容重音字符。

生产构建 `index-Dvk95AWc.js` 在 1440、390、320 像素通过管理员模拟复验，打开的子菜单项前景与背景对比度分别为 18.01∶1、14.06∶1、14.06∶1。读取权限与翻页回归、76 项定向测试、Web 类型检查和 Impeccable 源码检测通过。文字搜索仍限于已加载记录，小屏嵌套菜单仍占叠层空间，真实角色变更和读屏待验。 [崩溃基线](/tmp/openbot-order2-review/audit-filter-recovery-baseline.log) · [恢复与对比度复验](/tmp/openbot-order2-review/audit-filter-recovery-scored.log) · [权限回归](/tmp/openbot-order2-review/audit-filter-access-regression.log) · [分页回归](/tmp/openbot-order2-review/audit-filter-cursor-regression.log) · [320 像素菜单](/tmp/openbot-order2-review/audit-filter-recovery-320.png) · [定向测试](/tmp/openbot-order2-review/audit-filter-recovery-tests-scored.log)


## 插件清单查找与账户状态复评

`/admin/plugins/` 从 35/40 升至 **39/40（97.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4。按插件名称、供应商、说明和已列工具名称查找，查询保留在地址中，Enter 聚焦首个匹配项，浏览器后退恢复原条目。无匹配时可清空并回到搜索框。筛选期间先集中呈现目录结果，More apps 单独提供更广的搜索范围。读取账户失败时显示状态未知并提供原位重试。共享账户仍使用独立的部署状态。

生产构建 `index-D0FnwKB8.js` 通过 Team 管理员 1440、390、320 像素模拟复验。11 组插件读取场景回归，70 项定向测试、类型检查和 Impeccable 源码检测通过。结果仍需要打开插件才能查看具体命中的工具。真实供应商授权和读屏待验。 [基线](/tmp/openbot-order2-review/plugin-directory-search-baseline.log) · [浏览器复验](/tmp/openbot-order2-review/plugin-directory-search-current.log) · [插件读取回归](/tmp/openbot-order2-review/plugin-directory-search-regression.log) · [320 像素空结果](/tmp/openbot-order2-review/plugin-directory-search-320.png) · [定向测试](/tmp/openbot-order2-review/plugin-directory-search-tests-scored.log)


## 桌面接续与设备状态复评

`/settings/this-computer` 从 35/40 升至 **39/40（97.5%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3。浏览器提供带具体设置路径的桌面协议入口和手动导航指引。桌面 IPC 读取失败时保留上次状态并暂停启停。确认动作提交前重新核对当前状态，失败时无写入。重试成功把焦点交还页面标题。剪贴板拒绝后，页面选中可手动复制的诊断快照。

生产构建 `index-BxUBRjth.js` 通过 1440、390、320 像素的浏览器及模拟桌面 IPC 验证。原有启停确认、服务已停止后仅重试启动、以及 44 CSS 像素触区回归通过。17 项前端测试、7 项 Rust 入口处理测试、类型检查和 Impeccable 源码检测通过。已核对浏览器 URL 和模拟桌面路由接收；仍需在安装版验证操作系统拉起、读屏和未安装用户的引导。 [基线](/tmp/openbot-order2-review/this-computer-handoff-baseline.log) · [接续与异常复验](/tmp/openbot-order2-review/this-computer-handoff-scored.log) · [启停回归](/tmp/openbot-order2-review/this-computer-handoff-regression.log) · [320 像素浏览器入口](/tmp/openbot-order2-review/this-computer-browser-320.png) · [前端测试](/tmp/openbot-order2-review/this-computer-handoff-tests-scored.log) · [Rust 协议处理测试](/tmp/openbot-order2-review/this-computer-handoff-native.log)


## 错误地址返回与视觉层级复评

| 视图 | 上轮 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| 未知地址 | 31/36 | **35/36（97.2%）** | 4 · 4 · 4 · 3 · 4 · 4 · — · 4 · 4 · 4 |
| 路由加载失败 | 31/36 | **32/36（88.9%）** | 4 · 4 · 3 · 3 · 3 · 4 · — · 4 · 4 · 3 |

未知地址展示待核对的路径，长路径可在 320 像素换行，查询参数只保留在浏览器地址栏。站内进入时可用键盘返回，保留原页查询并聚焦标题。直接打开失效书签时可进入工作区。返回和重试均使用主操作样式，工作区入口保留为次选。连续读取失败后仍能重试，恢复后聚焦原页面标题。

生产构建 `index-ENm7HFn9.js` 在 1440、390、320 像素通过浏览器模拟复验。18 项定向测试、Web 类型检查和 Impeccable 源码检测通过。跨浏览器历史、实际读屏和更广的路由故障仍待验。 [返回缺口基线](/tmp/openbot-order2-review/missing-route-return-baseline.log) · [错误地址返回验证](/tmp/openbot-order2-review/missing-route-return-scored.log) · [加载故障回归](/tmp/openbot-order2-review/missing-route-load-regression.log) · [窄屏长路径](/tmp/openbot-order2-review/missing-route-return-320.png)

## 路由离线与连续失败复评

共享路由加载失败页从 32/36 升至 **34/36（94.4%，暂定）**。H1–H10 为 4 · 4 · 3 · 3 · 4 · 4 · — · 4 · 4 · 4。首次重试仍失败时，页面更新提示并保留重试和工作区入口。离线时暂停重试，联网后可在原地址继续，成功时将键盘焦点交还页面标题。

生产构建 `index-DgUgGBwg.js` 通过 1440、390、320 像素模拟复验。离线期间点击重试未触发 API 请求，联网后保留 `/admin?q=people` 并聚焦 Admin 标题。18 项定向测试、Web 类型检查和 Impeccable 源码检测通过。加载失败页缺少返回原页的入口，通用指引覆盖的故障类型仍需扩展验证。实际读屏和跨浏览器行为待验。 [连续失败基线](/tmp/openbot-order2-review/route-outage-baseline.log) · [离线与联网复验](/tmp/openbot-order2-review/route-outage-scored.log) · [焦点回归](/tmp/openbot-order2-review/route-outage-retry-regression.log) · [320 像素离线画面](/tmp/openbot-order2-review/route-recovery-offline-320.png) · [定向测试](/tmp/openbot-order2-review/route-outage-tests.log)

## 路由加载失败返回复评

共享路由加载失败页从 34/36 升至 **35/36（97.2%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · — · 4 · 4 · 4。站内进入时，返回可以保留原页的查询和标题焦点。离线时按钮优先提供返回。直接打开失效书签时，仍可重试或打开工作区。返回过程中如果先前的重试完成，重试不会重置当前浏览的页面。

生产构建 `index-BIxBnd2F.js` 在 Chromium 与 WebKit 的 1440、390、320 像素验证站内返回、离线重试、联网恢复与未知地址回归。18 项定向测试、Web 类型检查和 Impeccable 源码检测通过。Firefox、已安装桌面端和实际读屏待验。 [缺少返回入口的基线](/tmp/openbot-order2-review/route-error-escape-baseline.log) · [Chromium 返回复验](/tmp/openbot-order2-review/route-error-escape-verified.log) · [WebKit 复验](/tmp/openbot-order2-review/route-cross-browser-webkit.log) · [320 像素离线返回画面](/tmp/openbot-order2-review/route-error-escape-320.png) · [定向测试](/tmp/openbot-order2-review/route-error-escape-tests.log)

## Goals 页内导航复评

`/responsibilities?view=goals` 从 36/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 3 · 3 · 4 · 4 · 4 · 4 · 3 · 4 · 4。选中 Bot 后可以直接跳到本页 Routines 标题，再打开该 Bot 的完整例行任务页面。一页展示 24 条目标时，320 像素 Chromium 的 Routines 标题从距视口顶部 2212 移至 497 CSS 像素，同时接收键盘焦点。地址保留 Bot 和视图参数。

生产构建 `index-hCnSfZh8.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过模拟复验。15 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实读屏、任务写入和嵌入列表密度待验。 [320 像素基线](/tmp/openbot-order2-review/goals-routines-jump-baseline.log) · [Chromium 复验](/tmp/openbot-order2-review/goals-routines-jump-verified.log) · [WebKit 复验](/tmp/openbot-order2-review/goals-routines-jump-webkit.log) · [目标搜索与故障回归](/tmp/openbot-order2-review/goals-routines-jump-search-regression.log) · [320 像素画面](/tmp/openbot-order2-review/goals-routines-jump-320.png)

## Teach a Bot 录制链接恢复复评

`/browser` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。录制链接仍需用户主动打开浏览器，即使初始状态显示无响应也有打开入口。打开进度、失败与重试可辨认，加载期间不会重复提交。录制列表在打开失败时仍可查看。重试成功后聚焦页面标题并保留录制链接参数。

生产构建 `index-BQQRg7Gv.js` 在 Team Chromium、Team WebKit 和 Personal Chromium 的 1440、390、320 像素通过模拟复验。权限恢复增加慢开窗场景，确认临时标题被替换后仍能接续焦点。Web 类型检查及 Impeccable 源码检测通过。普通屏幕和录制链接仍采用不同的开窗说明。窄屏录制标题、真实串流、实体触屏和读屏待验。 [缺少打开入口的基线](/tmp/openbot-order2-review/recording-link-open-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/recording-link-open-scored.log) · [Team WebKit](/tmp/openbot-order2-review/recording-link-open-scored-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/recording-link-open-scored-personal.log) · [权限与焦点回归](/tmp/openbot-order2-review/recording-link-open-scored-access.log) · [320 像素失败画面](/tmp/openbot-order2-review/recording-link-open-320.png) · [定向测试](/tmp/openbot-order2-review/recording-link-open-scored-tests.log)

## Bot Setup 可见范围复评

`/bots/$agentId/setup` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4。Visibility 的说明使用 14–16 CSS 像素，完整显示公开范围与隔离电脑登录共享的后果。选择 Public 后需确认，Escape 取消后焦点回到 Visibility，且无写入。提交前重新读取 Bot。复核期间隔离状态变化时暂停提交，其他资料更新在保存时保留。临时写入失败可在对话框内重试。

生产构建 `index-BpAHEaQC.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。Team 与 Personal 的 320 像素渲染扫描均为零发现，24 项定向测试和 Web 类型检查通过。隔离电脑仍需结合产品术语理解，长列表导航、真实角色写入及读屏待验。 [旧字号和立即写入基线](/tmp/openbot-order2-review/bot-setup-public-baseline.log) · [Chromium 验证](/tmp/openbot-order2-review/bot-setup-public-scored-chromium.log) · [WebKit 验证](/tmp/openbot-order2-review/bot-setup-public-scored-webkit.log) · [状态变化复验](/tmp/openbot-order2-review/bot-setup-public-scored-stale.log) · [320 像素确认画面](/tmp/openbot-order2-review/bot-setup-public-confirm-320.png) · [渲染检测](/tmp/openbot-order2-review/bot-setup-public-scored-detector.log) · [定向测试](/tmp/openbot-order2-review/bot-setup-public-final-tests.log)

## 个人技能草稿退出复评

`/capabilities/skills` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。新建和编辑的草稿在关闭面板或浏览器后退时都可保留，默认聚焦 Keep editing。用户明确放弃或表单未修改时可直接退出。保存进行中暂停输入与离开，失败时保留原稿及提示，成功后返回列表。

生产构建 `index-DhTCHMLx.js` 在 Personal Chromium、Personal WebKit 和 Team Chromium 的 1440、390、320 像素通过模拟复验。22 项定向测试、Web 类型检查和 Impeccable 源码检测通过。工具与 Bot 授权的术语、窄屏表单密度、实际权限和读屏待验。 [草稿丢失基线](/tmp/openbot-order2-review/personal-skill-draft-baseline.log) · [Personal Chromium](/tmp/openbot-order2-review/personal-skill-draft-scored.log) · [Personal WebKit](/tmp/openbot-order2-review/personal-skill-draft-scored-webkit.log) · [Team Chromium](/tmp/openbot-order2-review/personal-skill-draft-scored-team.log) · [读取权限回归](/tmp/openbot-order2-review/personal-skill-draft-scored-recovery.log) · [320 像素确认画面](/tmp/openbot-order2-review/personal-skill-draft-confirm-320.png) · [定向测试](/tmp/openbot-order2-review/personal-skill-draft-scored-tests.log)

## 管理首页任务词复评

`/admin/` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4。16 个设置入口都支持任务词搜索，精确设置名称优先。此前无结果的 `single sign-on`、`revoke an API key`、`simulate a policy` 和 `grant admin access` 现在都能把对应设置排在首位。空结果提供三个示例，Escape 清空并保留输入焦点。输入为空时 Enter 不会打开分类首项。

生产构建 `index-1IctEB-d.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。名称排序、浏览器后退与 Team 成员及 Personal 跳转通过回归。14 项定向测试、Web 类型检查及 Impeccable 源码检测通过。拼写错误和任务词覆盖仍有限，真实管理员任务及读屏待验。 [任务词基线](/tmp/openbot-order2-review/admin-task-search-baseline.log) · [Chromium 验证](/tmp/openbot-order2-review/admin-task-search-scored.log) · [WebKit 验证](/tmp/openbot-order2-review/admin-task-search-scored-webkit.log) · [排序回归](/tmp/openbot-order2-review/admin-task-search-scored-ranked.log) · [角色与焦点回归](/tmp/openbot-order2-review/admin-task-search-scored-navigation.log) · [320 像素空结果](/tmp/openbot-order2-review/admin-task-search-empty-320.png) · [定向测试](/tmp/openbot-order2-review/admin-task-search-tests.log)

## 人员翻页定位复评

`/admin/people` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。中间页和最后一页都把键盘焦点移到第一条新增人员，再按 Tab 即可进入该人员的操作。新增行立即可见，清单会报告已显示人数和是否还有结果。分页失败时保留原数据和原位重试。如果用户已移开焦点，慢请求完成时保留用户当前的位置。

生产构建 `index-DVMjK4hU.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。权限拒绝后清除旧名单、临时故障保留只读结果、搜索切换时隐藏旧操作均通过回归。4 项定向测试、Web 类型检查和 Impeccable 源码检测通过。窄屏操作密度、真实角色写入和读屏待验。 [翻页基线](/tmp/openbot-order2-review/people-pagination-focus-baseline.log) · [Chromium 复验](/tmp/openbot-order2-review/people-pagination-focus-release.log) · [WebKit 复验](/tmp/openbot-order2-review/people-pagination-focus-release-webkit.log) · [慢请求焦点](/tmp/openbot-order2-review/people-pagination-focus-release-intent.log) · [权限回归](/tmp/openbot-order2-review/people-pagination-focus-release-access.log) · [搜索回归](/tmp/openbot-order2-review/people-pagination-focus-release-search.log) · [320 像素画面](/tmp/openbot-order2-review/people-pagination-focus-320.png)

## 记忆草稿与原位刷新复评

`/capabilities/memory` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。新建和编辑记忆共用离开确认，初始焦点为 Keep editing。未改内容可直接退出。临时读取失败时保留对话框和草稿，暂停保存。可在对话框内刷新并继续。权限被拒后关闭对话框并收起操作。

生产构建 `index-7V_c_QYN.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。组合筛选、保存和删除回执、权限缓存与焦点回归通过。13 项定向测试、Web 类型检查及 Impeccable 源码检测通过。长记录的操作密度、实际 Bot 读取、跨设备同步和读屏待验。 [草稿丢失基线](/tmp/openbot-order2-review/memory-draft-baseline.log) · [Chromium 复验](/tmp/openbot-order2-review/memory-draft-scored.log) · [WebKit 复验](/tmp/openbot-order2-review/memory-draft-webkit.log) · [历史行为回归](/tmp/openbot-order2-review/memory-draft-state-regression.log) · [320 像素保存暂停](/tmp/openbot-order2-review/memory-draft-offline-320.png) · [定向测试](/tmp/openbot-order2-review/memory-draft-tests.log)

## 个人审批规则草稿复评

`/settings/approvals` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 3 · 3 · 4 · 4 · 4。新规则对话框在关闭按钮、Cancel 或 Escape 退出时保护草稿，默认聚焦 Keep editing。读取失败可在对话框内刷新，保存进行中暂停编辑和关闭。失败后保留原稿供重试，保存成功后焦点回到 Add a rule。

生产构建 `index-BnFMRqSu.js` 在 Personal Chromium、Personal WebKit 和 Team Chromium 的 1440、390、320 像素通过模拟复验。团队规则及单 Bot 规则的 320 像素关闭和焦点回归通过。38 项定向测试、Web 类型检查和 Impeccable 源码检测通过。规则匹配的可发现性、长规则清单查找、真实审批和读屏待验。 [草稿丢失基线](/tmp/openbot-order2-review/personal-approval-rule-draft-baseline.log) · [Personal Chromium](/tmp/openbot-order2-review/personal-approval-rule-draft-scored.log) · [Personal WebKit](/tmp/openbot-order2-review/personal-approval-rule-draft-webkit.log) · [Team Chromium](/tmp/openbot-order2-review/personal-approval-rule-draft-team.log) · [团队和单 Bot 规则回归](/tmp/openbot-order2-review/personal-approval-rule-draft-shared.log) · [权限回归](/tmp/openbot-order2-review/personal-approval-rule-draft-cache.log) · [320 像素确认画面](/tmp/openbot-order2-review/personal-approval-rule-draft-320.png) · [定向测试](/tmp/openbot-order2-review/personal-approval-rule-draft-tests.log)

## 设备未确认结果复评

`/admin/computers` 与 `/settings/computer` 均从 36/40 升至 **38/40（95%，暂定）**。两页 H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。设备操作结果未确认时，对话框展示最新读取的设备状态，读取失败也有明确说明。设备状态与原操作结果分别呈现，可从对话框进入对应的 Audit 或 Activity。键盘焦点移到 Close，原操作只提交一次。

生产构建 `index-zUR1FzMJ.js` 在 Team 和 Personal 的 Chromium 与 WebKit 1440、390、320 像素通过模拟复验。提交前复查失败、目标状态变化、成功回执、权限拒绝和只读状态通过回归。50 项定向测试、Web 类型检查与 Impeccable 源码检测通过。窄屏操作密度、实体设备与真实日志和读屏待验。 [恢复基线](/tmp/openbot-order2-review/device-outcome-baseline.log) · [Chromium 复验](/tmp/openbot-order2-review/device-outcome-scored.log) · [WebKit 复验](/tmp/openbot-order2-review/device-outcome-webkit.log) · [状态也读不到的复验](/tmp/openbot-order2-review/device-outcome-read-unavailable.log) · [原有操作回归](/tmp/openbot-order2-review/device-outcome-actions-regression.log) · [权限回归](/tmp/openbot-order2-review/device-outcome-access-regression.log) · [320 像素 Team 画面](/tmp/openbot-order2-review/device-outcome-team-320.png) · [定向测试](/tmp/openbot-order2-review/device-outcome-tests.log)

## 通用设置离开与刷新复评

`/settings/` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。姓名和常驻指示的浏览器后退会先确认，默认聚焦 Keep editing。保存过程中会暂停离开，成功后可直接离开。刷新失败时列表标明上次读取内容，编辑器保持草稿，恢复后可继续保存。

生产构建 `index-CfWHmeky.js` 在 Personal Chromium 和 WebKit 的 1440、390、320 像素通过键盘导航复验，Team Chromium 通过读取告警、保存回执与分组导航回归。31 项定向测试、Web 类型检查和 Impeccable 源码检测通过。桌面端专属设置、跨设备同步及读屏待验。 [后退丢稿基线](/tmp/openbot-order2-review/general-route-draft-baseline.log) · [上次读取隐藏基线](/tmp/openbot-order2-review/general-route-draft-stale-baseline.log) · [Chromium 复验](/tmp/openbot-order2-review/general-route-draft-final.log) · [WebKit 复验](/tmp/openbot-order2-review/general-route-draft-webkit.log) · [读取恢复](/tmp/openbot-order2-review/general-route-draft-stale.log) · [保存回归](/tmp/openbot-order2-review/general-route-draft-save-regression.log) · [320 像素离开确认](/tmp/openbot-order2-review/general-route-draft-320.png) · [定向测试](/tmp/openbot-order2-review/general-route-draft-scored-tests.log)

## Activity 翻页接续复评

`/settings/activity` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3。加载旧记录后，键盘焦点移到按当前排序和筛选显示的首条新增记录。新增页没有匹配时显示说明，最后一页无匹配则聚焦结果摘要。分页失败可继续在原位置重试。用户已移开焦点时，慢请求不会把焦点拉回记录。

生产构建 `index-VU-a7Vpe.js` 在 Personal Chromium、Personal WebKit、Team Chromium 的 1440、390、320 像素模拟复验。在已加载 22 条的清单上验证新增页选中匹配行、失败后重试，以及最后一页无新增匹配的反馈。视图、权限和搜索范围通过回归。38 项定向测试、Web 类型检查与 Impeccable 源码检测通过。全历史文字搜索、真实审计记录和读屏待验。 [翻页基线](/tmp/openbot-order2-review/activity-pagination-focus-baseline.log) · [Personal Chromium](/tmp/openbot-order2-review/activity-pagination-focus-scored.log) · [Personal WebKit](/tmp/openbot-order2-review/activity-pagination-focus-webkit.log) · [Team Audit 回归](/tmp/openbot-order2-review/activity-pagination-focus-team.log) · [慢请求焦点](/tmp/openbot-order2-review/activity-pagination-focus-intent.log) · [视图与权限回归](/tmp/openbot-order2-review/activity-pagination-focus-regression.log) · [320 像素新增记录](/tmp/openbot-order2-review/activity-pagination-focus-320.png)

## 快速会话与慢清单复评

`/bot` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。具名会话的详情请求可在慢清单返回前完成并打开会话。详情响应的 Bot ID 必须与书签一致。详情故障时可以重试、浏览 Bots 或打开另一个已确认可用的 Bot。浏览器当前标签页保留原草稿，切到其他 Bot 不带入原内容。

生产构建 `index-DJtrWjsb.js` 在 Team Chromium、Team WebKit 和 Personal Chromium 的 1440、390、320 像素通过模拟复验。96 字符的 Bot 名称在 320 像素可换行且无横向溢出。原有权限拒绝、重试焦点与刷新恢复回归通过。30 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实网关发送、辅助技术和窄屏信息密度待验。 [慢清单基线](/tmp/openbot-order2-review/quick-chat-slow-roster-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/quick-chat-slow-roster-final.log) · [Team WebKit](/tmp/openbot-order2-review/quick-chat-slow-roster-final-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/quick-chat-slow-roster-final-personal.log) · [长名称复验](/tmp/openbot-order2-review/quick-chat-slow-roster-long.log) · [恢复回归](/tmp/openbot-order2-review/quick-chat-slow-roster-final-regression.log) · [320 像素恢复画面](/tmp/openbot-order2-review/quick-chat-slow-roster-320.png)

## Bot 分享复评

`/bots/$agentId/sharing` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4。H5 加 1 分。取消发布需先确认 Bot 和发布对象，再读取发布状态。发布对象发生变化时停在确认弹窗，暂时读取失败或写入失败可原位重试。H7 加 1 分。复制失败后出现可选中的链接，长邮箱可完整换行，取消发布和复制链接的按钮及确认操作达到 44 CSS 像素。

生产构建 `index-CT-aO9U9.js` 通过 Team Chromium 与 WebKit 的 1440、390、320 像素复验。Escape 聚焦原按钮，成功后聚焦回执。8 项定向测试、Web 类型检查及 Impeccable 源码检测通过。组分配仍以星号表示整个团队。真实发布、组分配权限和辅助技术待验。 [Chromium 复验](/tmp/openbot-order2-review/bot-sharing-confirmation-chromium.log) · [WebKit 复验](/tmp/openbot-order2-review/bot-sharing-confirmation-webkit.log) · [320 像素确认画面](/tmp/openbot-order2-review/bot-sharing-dialog-320.png) · [320 像素手动复制画面](/tmp/openbot-order2-review/bot-sharing-copy-320.png)

## Bot 档案复制与恢复复评

`/bots/$agentId` 从 36/40 升至 **37/40（92.5%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 3。H4 加 1 分。复制失败时在原操作下显示错误，键盘焦点留在重试操作。请求和打开副本期间防止重复提交。成功后沿用创建 Bot 的标题焦点交接。320 像素下重置说明可完整换行。

生产构建 `index-D6U9O2m1.js` 通过 1440、390、320 像素的 Team Chromium、Team WebKit 和 Personal Chromium 复验。两套相关测试共 20 项通过，Web 类型检查和 Impeccable 源码检测通过。真实服务写入、读屏及管理区的信息层级仍待复评。 [Team Chromium](/tmp/openbot-order2-review/bot-profile-duplicate-chromium.log) · [Team WebKit](/tmp/openbot-order2-review/bot-profile-duplicate-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/bot-profile-duplicate-personal.log) · [320 像素重试画面](/tmp/openbot-order2-review/bot-profile-copy-team-320.png)

## Slack 连接与重连复评

`/connections/slack` 从 36/40 升至 **39/40（97.5%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4。H1 加 2 分。请求连接码时显示进度并保留焦点。503 或成功响应缺少有效连接码时显示错误，原按钮可以重试。H9 加 1 分。剪贴板被拒时可选中只读命令并手动复制，关闭弹窗后焦点回到触发按钮。

生产构建 `index-5Fyjes2b.js` 在 1440、390、320 像素通过 Chromium 和 WebKit 重连复验，以及 Chromium 初次连接复验。34 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实 Slack 发码、回到 OpenBot 后的账户状态和读屏待验。 [基线](/tmp/openbot-order2-review/slack-code-retry-baseline.log) · [Chromium](/tmp/openbot-order2-review/slack-code-retry-chromium.log) · [WebKit](/tmp/openbot-order2-review/slack-code-retry-webkit.log) · [初次连接](/tmp/openbot-order2-review/slack-code-retry-initial.log) · [320 像素手动复制](/tmp/openbot-order2-review/slack-code-retry-320.png)

## 团队规则连续操作与刷新复评

`/admin/approvals` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 4 · 4 · 3 · 4 · 4。H7 加 1 分。移除后聚焦下一条匹配规则，末尾则尝试上一条。没有相邻项时回到搜索框或规则标题。移除按钮的无障碍名称包含规则对象，触区至少高 44 CSS 像素。H10 加 1 分。刷新失败时，规则区说明可继续查看与筛选，并提供原位刷新。恢复后保留搜索词并重新启用编辑。

生产构建 `index-DQqKI1Ef.js` 通过 Chromium、WebKit 的 1440、390、320 像素复验。24 条规则的筛选、精确移除及空结果恢复回归通过。25 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实团队策略生效、辅助技术和页面布局密度待复评。 [基线](/tmp/openbot-order2-review/team-rule-continuity-baseline.log) · [Chromium](/tmp/openbot-order2-review/team-rule-continuity-chromium.log) · [WebKit](/tmp/openbot-order2-review/team-rule-continuity-webkit.log) · [筛选回归](/tmp/openbot-order2-review/team-rule-continuity-regression.log) · [320 像素故障画面](/tmp/openbot-order2-review/team-rule-stale-320.png)

## 审批指导退出与提交复评

`/admin/approvals/guidance` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4。H4 加 1 分。草稿退出沿用审批规则编辑器的确认，初始焦点在继续编辑。保存期间暂缓站内离开，失败保留草稿并可原位重试。H7 加 1 分。正在检查时焦点留在检查按钮，重复按 Enter 不会发出第二次检查。已放弃的草稿不会写入。

生产构建 `index-54S5ipLC.js` 在 1440、390、320 像素通过 Chromium 和 WebKit 复验。还复验了草稿恢复、并发保存冲突和过期删除。13 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实模型检查和辅助技术待验。 [基线](/tmp/openbot-order2-review/guidance-navigation-baseline.log) · [Chromium](/tmp/openbot-order2-review/guidance-navigation-chromium.log) · [WebKit](/tmp/openbot-order2-review/guidance-navigation-webkit.log) · [草稿回归](/tmp/openbot-order2-review/guidance-navigation-draft.log) · [并发回归](/tmp/openbot-order2-review/guidance-navigation-conflict.log) · [320 像素退出确认](/tmp/openbot-order2-review/guidance-leave-320.png)

## 边界详情保存焦点与回放复评

`/admin/boundaries/$index` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 4 · 4 · 3 · 4 · 3 · 4 · 4 · 4 · 4。H7 加 1 分。保存后，编辑器更新表达式并恢复键盘焦点。焦点已移到返回链接等其他控件时继续留在那里。H8 加 1 分。回放超过五条时先显示影响总数，可用键盘展开或收起所有已返回的明细。

生产构建 `index-qaXgrWRx.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过保存焦点和 12 条回放验证。草稿、并发冲突和书签回归通过。26 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实回放数据、辅助技术及其他长表达式的阅读体验仍待复评。 [基线](/tmp/openbot-order2-review/boundary-save-focus-baseline.log) · [Chromium](/tmp/openbot-order2-review/boundary-save-focus-chromium.log) · [WebKit](/tmp/openbot-order2-review/boundary-save-focus-webkit.log) · [编辑回归](/tmp/openbot-order2-review/boundary-save-focus-regression.log) · [并发回归](/tmp/openbot-order2-review/boundary-save-focus-conflict.log) · [320 像素画面](/tmp/openbot-order2-review/boundary-save-focus-320.png)

## What if 请求切换与窄屏复评

`/admin/what-if` 从 36/40 升至 **38/40（95%，暂定）**。H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3。H7 加 1 分。重置场景、修改正在解读的问题或变更正在试算的动作会中止对应的浏览器请求。旧响应不会覆盖当前场景，也不会结束新请求的等待状态。H8 加 1 分。在 320 像素下，410 个连续字符的原问题可完整换行。选中动作参数后关闭菜单，避免挡住操作区。

生产构建 `index-MKFTub_9.js` 通过 1440、390、320 像素的 Chromium 与 WebKit 复验。权限清除、错误恢复和六层判定通过回归。6 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实模型解读、权限传播和辅助技术待验。 [基线](/tmp/openbot-order2-review/what-if-supersede-baseline.log) · [Chromium](/tmp/openbot-order2-review/what-if-supersede-chromium.log) · [WebKit](/tmp/openbot-order2-review/what-if-supersede-webkit.log) · [权限回归](/tmp/openbot-order2-review/what-if-supersede-access.log) · [判定回归](/tmp/openbot-order2-review/what-if-supersede-regression.log) · [320 像素长文本](/tmp/openbot-order2-review/what-if-supersede-320.png)

## 桌面交接状态与恢复复评

`/desktop-return` 从 33/36 升至 **36/36（100%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · — · 4 · 4 · 4。H2 加 1 分。服务明确表示尚未连接时，引导完成应用登录。暂时无法确认时，引导重试或回到浏览器。成功后显示已知的应用名称，应用名称读取延迟时仍可交还桌面。H8 加 1 分，失败提示在窄屏采用间距令牌，图标与正文保留对齐。H10 加 1 分，明确说明未安装桌面端时可留在浏览器，键盘重试成功后聚焦桌面入口。

生产构建 `index-B3vfjUzc.js` 在 1440、390、320 像素通过 Chromium 和 WebKit 模拟复验。无应用参数时保留通用桌面和浏览器入口。15 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实第三方回调、未安装桌面端的系统提示与辅助技术仍待正式验收。 [基线](/tmp/openbot-order2-review/desktop-return-context-baseline.log) · [Chromium](/tmp/openbot-order2-review/desktop-return-context-chromium.log) · [WebKit](/tmp/openbot-order2-review/desktop-return-context-webkit.log) · [320 像素成功状态](/tmp/openbot-order2-review/desktop-return-context-320.png) · [320 像素尚未连接](/tmp/openbot-order2-review/desktop-return-context-error-320.png)

## Goals 编辑退出与焦点复评

全部 Goals、按 Bot 查看 Goals 和单 Bot 的 Goals 页面均从 37/40 升至 **38/40（95%，暂定）**。前两页 H3 各加 1 分。关闭目标编辑器或进入会话前，用户可选择继续编辑或放弃草稿。单 Bot 页面 H4 加 1 分，沿用同一退出确认和焦点规则。保存改名后如果当前筛选隐藏对应行，焦点返回搜索框。保存未完成时保护草稿。

生产构建 `index-DzpMddi7.js` 在三个入口分别通过 Chromium、WebKit 的 1440、390、320 像素复验，共 18 个编辑场景。三个入口的权限拒绝、只读恢复和运行历史重试通过回归。4 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实 Bot 操作与读屏待验。 [基线](/tmp/openbot-order2-review/goal-close-draft-baseline.log) · [Chromium](/tmp/openbot-order2-review/goal-close-draft-chromium.log) · [WebKit](/tmp/openbot-order2-review/goal-close-draft-webkit.log) · [读取回归](/tmp/openbot-order2-review/goal-close-draft-recovery.log) · [320 像素草稿确认](/tmp/openbot-order2-review/goal-close-draft-320.png)

## Routines 完整指令与历史复评

全部和单 Bot 例行任务页均从 37/40 升至 **38/40（95%，暂定）**。全部例行任务页 H8 加 1 分。超过 120 字符的指令默认折叠，展开后独占整行，支持长词和原有换行。短指令完整显示。单 Bot 页面 H7 加 1 分，长指令可用键盘展开，历史读取恢复后聚焦该任务的历史区域。

生产构建 `index-CFyXPZfY.js` 在两个入口通过 Chromium、WebKit 的 1440、390、320 像素复验。搜索、权限拒绝、只读历史和删除确认通过回归。11 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实调度、跨时区运行和读屏仍待验。 [基线](/tmp/openbot-order2-review/routine-instructions-baseline.log) · [Chromium](/tmp/openbot-order2-review/routine-instructions-chromium.log) · [WebKit](/tmp/openbot-order2-review/routine-instructions-webkit.log) · [筛选和删除回归](/tmp/openbot-order2-review/routine-instructions-regression.log) · [320 像素展开画面](/tmp/openbot-order2-review/routine-instructions-320.png)

## Activity 完成清单与审计入口复评

`/s/activity` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4。H8 加 1 分，默认只显示最近五条完成记录。剩余记录可用键盘展开，保留原有会话链接。用 24 条模拟记录复验时，320 像素 Chromium 上审计入口在首访时距视口顶部从 2589 降至 1108 CSS 像素。H10 加 1 分，审计入口完整说明可查看哪些操作及结果。单 Bot Activity 从 38/40 升至 **39/40（97.5%，暂定）**，H10 加 1 分。

生产构建 `index-ArfBUaGA.js` 在两个入口通过 Chromium 和 WebKit 的 1440、390、320 像素复验，共 12 个场景。展开和收起无额外读取。停止、取消和失败恢复通过回归。13 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实任务、审计写入和读屏待验。 [基线](/tmp/openbot-order2-review/activity-completed-disclosure-baseline.log) · [Chromium](/tmp/openbot-order2-review/activity-completed-disclosure-chromium.log) · [WebKit](/tmp/openbot-order2-review/activity-completed-disclosure-webkit.log) · [单 Bot Chromium](/tmp/openbot-order2-review/activity-completed-disclosure-bot.log) · [单 Bot WebKit](/tmp/openbot-order2-review/activity-completed-disclosure-bot-webkit.log) · [操作回归](/tmp/openbot-order2-review/activity-completed-disclosure-regression.log) · [320 像素画面](/tmp/openbot-order2-review/activity-completed-disclosure-320.png)

## 单 Bot 会话原文恢复复评

`/channel/$channelId` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4。H4 加 1 分。沿用连接与分享页的手动复制方式。浏览器缺少剪贴板或拒绝写入时，复制按钮打开只读原文，键盘焦点移入并选中全文，保留原换行。H10 加 1 分。说明区分历史不完整、带附件和可安全重发的情况。复制不会触发发送，满足条件的重发沿用原消息 ID。

生产构建 `index-CryCYucZ.js` 通过 Chromium、WebKit 的 10 个模拟场景，覆盖 Team 与 Personal、1440、390、320 像素、剪贴板成功和故障。21 项测试在按文件隔离运行时通过。三文件共享进程运行时，双会话并发测试等候按钮超时，单独运行通过。Web 类型检查和 Impeccable 源码检测通过。真实网关断线重发、系统剪贴板权限提示和读屏待验。 [基线](/tmp/openbot-order2-review/first-message-copy-baseline.log) · [Chromium](/tmp/openbot-order2-review/first-message-copy-chromium.log) · [WebKit](/tmp/openbot-order2-review/first-message-copy-webkit.log) · [隔离测试](/tmp/openbot-order2-review/first-message-copy-isolated-tests.log) · [共享进程测试](/tmp/openbot-order2-review/first-message-copy-tests.log) · [320 像素原文恢复](/tmp/openbot-order2-review/first-message-copy-320.png)

## Bot 联系方式连接码与短信复评

`/bots/$agentId/reach` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4。H4 加 1 分。Slack 与 Teams 统一显示连接码的会话名称，切换会话后只显示对应的码。切回原会话可继续使用尚未过期的码。自动复制失败时，键盘焦点移入只读命令并选中全文。H7 加 1 分。320 像素下号码和验证码各占一行，输入区至少高 44 CSS 像素，可用 Enter 提交与确认。

生产构建 `index-BhhbQ6mT.js` 通过 1440、390、320 像素的 15 个模拟浏览器场景，覆盖 Slack、Teams 和 SMS。39 项隔离定向测试、Web 类型检查及 Impeccable 源码检测通过。直接断开连接仍需复评误操作防护。真实平台回调、短信送达和读屏待验。 [基线](/tmp/openbot-order2-review/reach-link-target-baseline.log) · [Slack Chromium](/tmp/openbot-order2-review/reach-link-target-chromium.log) · [Slack WebKit](/tmp/openbot-order2-review/reach-link-target-webkit.log) · [Teams](/tmp/openbot-order2-review/reach-link-target-teams.log) · [短信 Chromium](/tmp/openbot-order2-review/reach-link-target-sms-chromium.log) · [短信 WebKit](/tmp/openbot-order2-review/reach-link-target-sms-webkit.log) · [320 像素短信表单](/tmp/openbot-order2-review/reach-sms-form-320.png)

## Bot 审批规则草稿与恢复复评

`/bots/$agentId/approvals` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4。H4 加 1 分。与个人和团队审批设置一致，临时读取故障时保留可读规则与已打开的草稿，暂停写入。可在弹窗内刷新后继续保存。权限被拒后清除旧规则，后续 503 也不会恢复旧数据。H7 加 1 分，规则行的行为选择与移除控件至少高 44 CSS 像素。列表重试后聚焦 Rules 标题。

生产构建 `index-BfrCiGhE.js` 在 Chromium、WebKit 的 1440、390、320 像素通过模拟复验。团队与单 Bot 表单的草稿退出保护通过回归。28 项隔离测试、Web 类型检查及 Impeccable 源码检测通过。直接移除规则的防误操作、真实审批变更和读屏仍待验。 [基线](/tmp/openbot-order2-review/bot-rule-draft-baseline.log) · [Chromium](/tmp/openbot-order2-review/bot-rule-draft-chromium.log) · [WebKit](/tmp/openbot-order2-review/bot-rule-draft-webkit.log) · [退出确认回归](/tmp/openbot-order2-review/bot-rule-draft-regression.log) · [320 像素只读故障画面](/tmp/openbot-order2-review/bot-rule-draft-recovery-320.png)

## Bot 技能与访问授权范围与反馈复评

`/bots/$agentId/access` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4。H4 加 1 分。应用和技能均在对应行显示写入进度、失败和刷新后的开关状态。应用逐项说明个人、共享与工作区账号范围，区分管理员授予的权限，并说明开启外部应用只授予只读操作。H7 加 1 分。两类开关的触区高约 46 CSS 像素，失败后键盘焦点仍在原开关。

生产构建 `index-BH_rBmny.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六次模拟复验，覆盖授权、撤销、503 原位重试和窄屏触区边缘点击。19 项定向测试、Web 类型检查、生产构建及 Impeccable 源码检测通过。撤销后原行消失的焦点落点、实际账号授权与读屏仍待验。 [Chromium](/tmp/openbot-order2-review/owner-app-chromium.log) · [WebKit](/tmp/openbot-order2-review/owner-app-webkit.log) · [定向测试](/tmp/openbot-order2-review/owner-app-tests.log) · [320 像素画面](/tmp/openbot-order2-review/owner-app-chromium.png)

## Bot 档案重置清单与管理分组复评

`/bots/$agentId` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4。H8 加 1 分。固定和隐藏归入 Your Bots list，复制、重置和删除留在 Manage。H10 加 1 分。重置说明区分个人数据、共享会话与其他人的数据。清单读取失败后可原位重查。提交结果无法确认时先重新读取清单，读取成功且有项目时才可再次确认。

320 像素基线复现了清单读取失败后仍可提交。生产构建 `index-Bzp4rJ0c.js` 通过 Team Chromium、Team WebKit 与 Personal Chromium 的九个模拟场景，验证旧清单下禁止提交、请求期间禁止重复提交、成功反馈和键盘焦点返回。复制操作另通过三个浏览器回归场景。9 项定向测试、Web 类型检查、生产构建及 Impeccable 源码检测通过。真实重置、读屏与通知偏好措辞仍待验。 [基线](/tmp/openbot-order2-review/profile-reset-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/profile-reset-chromium.log) · [Team WebKit](/tmp/openbot-order2-review/profile-reset-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/profile-reset-personal.log) · [320 像素读取失败画面](/tmp/openbot-order2-review/profile-reset-recovery-320.png)

## GitHub 仓库表单与复制复评

`/connections/github` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4。H2 加 1 分。添加成功提示明确需要到 GitHub 完成 webhook 设置，复制反馈归属对应仓库，剪贴板拒绝时就地选中完整地址。H3 加 1 分。提交期间保留表单并拦截重复写入，失败保留仓库名和 webhook 密钥，结束后键盘焦点回到添加入口。断开操作只提交已确认的仓库。

生产构建 `index-G7sKDd4Z.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六个仓库场景，账户及工具读取另通过三个回归场景。35 项定向测试、Web 类型检查及 Impeccable 源码检测通过。提交已生效但响应丢失时的重复添加防护、真实 GitHub 投递与读屏仍待验。 [基线](/tmp/openbot-order2-review/github-repositories-baseline.log) · [Chromium](/tmp/openbot-order2-review/github-repositories-chromium.log) · [WebKit](/tmp/openbot-order2-review/github-repositories-webkit.log) · [账户和工具回归](/tmp/openbot-order2-review/github-tools-repository-regression.log) · [320 像素画面](/tmp/openbot-order2-review/github-repositories-chromium-320.png)

## 组件图库导航与预览复评

| 页面 | 前次 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/settings/components-gallery/` | 37/40 | **39/40（97.5%）** | 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3 |
| `/settings/components-gallery/$name` | 37/40 | **40/40（100%）** | 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |

清单的搜索占位词列出名称和用途，无样例条目省去大幅空预览。页面返回和浏览器后退保留搜索并聚焦原条目。条目已移除时聚焦搜索框。清单对如何在对话中使用组件的帮助仍可完善。详情将标识符标为 Component name，内置样例随页面宽度排版并标为样例数据，无样例时提供会话中的可用范围说明。

生产构建 `index-CfczmFfc.js` 通过六个 Team 与 Personal 导航场景、三个搜索和读取恢复回归场景，以及 14 个内置样例在 Chromium 和 WebKit 的 28 次 320 像素适配检查。5 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实 Bot 授权条件和读屏待验。 [导航 Chromium](/tmp/openbot-order2-review/gallery-return-chromium.log) · [导航 WebKit](/tmp/openbot-order2-review/gallery-return-webkit.log) · [窄屏样例 Chromium](/tmp/openbot-order2-review/gallery-samples-chromium.log) · [窄屏样例 WebKit](/tmp/openbot-order2-review/gallery-samples-webkit.log) · [320 像素详情](/tmp/openbot-order2-review/gallery-readable-chromium-320.png)

## Learning 草稿与分享请求复评

| 页面 | 前次 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/admin/learning` | 37/40 | **39/40（97.5%）** | 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4 |
| `/settings/learning` | 37/40 | **39/40（97.5%）** | 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |

管理端用 Review skills for 说明 Bot 选择器的用途。未保存的 Participation 改动可在离开时继续编辑或确认丢弃。保存期间只提交一次并暂停导航。个人设置的分享错误显示在对应技能，重试只重发分享请求，保留已写入的开关状态。重试控件至少高 44 CSS 像素，成功后聚焦对应开关。响应成功但技能清单不可读时提供具名重试。

生产构建 `index-DupnAESU.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过 12 个草稿及分享场景，Team 与 Personal 的读取恢复另通过 6 个回归场景。86 项定向测试、Web 类型检查及 Impeccable 源码检测通过。管理页区块层级、个人页分享范围用语、真实 Learning 后端和读屏仍待验。 [管理端 Chromium](/tmp/openbot-order2-review/learning-draft-chromium.log) · [管理端 WebKit](/tmp/openbot-order2-review/learning-draft-webkit.log) · [个人设置 Chromium](/tmp/openbot-order2-review/learning-sharing-chromium.log) · [个人设置 WebKit](/tmp/openbot-order2-review/learning-sharing-webkit.log) · [320 像素分享重试](/tmp/openbot-order2-review/learning-sharing-retry-chromium-320.png)

## Playground 编辑器与发布复评

`/admin/playground` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4。H2 加 1 分，分别报告草稿保存阶段和发布确认阶段的失败。H4 加 1 分，删除采用与发布一致的具名确认，失败在原弹窗重试，成功后焦点回到 Saved here。H7 加 1 分，键盘可以在编辑器和预览之间跳转，320 像素下长名称不挤出清单操作。离开页面前确认丢弃草稿，写入期间暂停编辑和离开。

生产构建 `index-B0jvVJf2.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过六个新场景，旧的草稿保护及列表原位恢复另通过三个回归场景。31 项定向测试、Web 类型检查和 Impeccable 源码检测通过。发布重试仍会再次保存草稿，跨管理员并发编辑、真实组件发布与读屏待验。 [基线](/tmp/openbot-order2-review/playground-editor-baseline.log) · [Chromium](/tmp/openbot-order2-review/playground-editor-chromium.log) · [WebKit](/tmp/openbot-order2-review/playground-editor-webkit.log) · [草稿回归](/tmp/openbot-order2-review/playground-editor-regression.log) · [320 像素画面](/tmp/openbot-order2-review/playground-editor-chromium-320.png)

## Recorder 活跃录制复评

`/settings/browsers` 从 37/40 升至 **39/40（97.5%，暂定）**，H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · 4 · 3 · 4 · 4。H2 加 1 分。确认框显示目标连接时间以区分同名浏览器，动作直接说明会停止录制。断开前查到此前未显示的录制时，不提交请求。提示当前状态并让键盘焦点回到取消。H4 加 1 分。连接和断开使用相同的设备操作组件，确认框提供可读描述和安全的初始焦点。

生产构建 `index-CME5pPTw.js` 在 Team 与 Personal 的 Chromium 和 WebKit 中通过六个录制变化场景、三个连接读取回归场景。用本地 API 与真实的未打包 Chromium 扩展确认了取消和连接流程。40 项定向测试、Web 类型检查及 Impeccable 源码检测通过。长设备列表与隐私说明的整体浏览效率、录制服务状态同步、商店扩展和读屏仍待验证。 [基线](/tmp/openbot-order2-review/recorder-active-reconfirm-baseline.log) · [Chromium](/tmp/openbot-order2-review/recorder-active-reconfirm-chromium.log) · [WebKit](/tmp/openbot-order2-review/recorder-active-reconfirm-webkit.log) · [实际扩展回归](/tmp/openbot-order2-review/recorder-active-reconfirm-extension.log) · [320 像素确认框](/tmp/openbot-order2-review/recorder-active-reconfirm-chromium-320.png)

## 凭据和登录项查找与替换复评

| 页面 | 前次 | 本轮暂定 | H1–H10 |
|---|---:|---:|---|
| `/admin/credentials` | 37/40 | **39/40（97.5%）** | 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |
| `/settings/credentials` | 37/40 | **39/40（97.5%）** | 4 · 4 · 3 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |
| `/settings/passwords` | 37/40 | **40/40（100%）** | 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 · 4 |

三个清单的搜索留在本页，不进入地址栏。按 Enter 聚焦首条匹配结果，清空后回到搜索框。同站点的多个登录项可按用户名区分，删除后焦点回到剩余结果或页面标题。两种凭据清单均可从活动行直接进入替换表单，表单锁定凭据标识，只有确认才提交到对应 ID。替换完成返回清单后仍需人工定位原条目。权限被拒后清除旧查询结果，后续 503 不会重新显示它们。

生产构建 `index-CAa2msg-.js` 在 Chromium 和 WebKit 的 Team 与 Personal 入口通过 12 个搜索、替换与权限场景，以及 4 个创建、撤销和删除回归场景。53 项定向测试通过，包含隔离 PostgreSQL 上的凭据替换和撤销。Web 类型检查及 Impeccable 源码检测通过。真实部署下游使用方、实体触屏和读屏仍待验证。 [基线](/tmp/openbot-order2-review/private-list-baseline.log) · [Chromium](/tmp/openbot-order2-review/private-list-chromium-verified.log) · [WebKit](/tmp/openbot-order2-review/private-list-webkit-verified.log) · [回归](/tmp/openbot-order2-review/private-list-regression-verified.log) · [320 像素登录清单](/tmp/openbot-order2-review/private-list-logins-chromium-320.png)


## 身份提供商清单与登录指引复评

`/admin/identity-providers` 从 37/40 升至 **40/40（100%，暂定）**。H4 加 1 分，沿用设置清单的搜索、结果计数和键盘定位。H8 加 1 分，协议与域名可扫读，签发者地址单独显示并完整换行。注册和移除使用同一条最新回执。H10 加 1 分，在 Require SSO 前提示用已注册域名的账号验证登录。注册后聚焦新行。移除筛选结果后，焦点回到搜索框。

生产构建 `index-C9nHw86c.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六个清单场景。注册恢复与 Require SSO 分别通过三个浏览器回归场景。74 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实 SAML/OIDC 回跳、实体触屏及读屏仍待验证。 [基线](/tmp/openbot-order2-review/provider-directory-baseline.log) · [Chromium](/tmp/openbot-order2-review/provider-directory-final-chromium.log) · [WebKit](/tmp/openbot-order2-review/provider-directory-final-webkit.log) · [注册回归](/tmp/openbot-order2-review/provider-directory-regression.log) · [登录政策回归](/tmp/openbot-order2-review/provider-directory-policy.log)

## 工具授权清单与写入恢复复评

`/admin/plugins/$key/tools/$tool` 从 37/40 升至 **40/40（100%，暂定）**。H1 加 2 分，工具读取、Bot 清单读取及单行写入各有明确状态。并发授权分别显示对应行的进度与结果。H9 加 1 分，读取失败可独立重试，写入失败保留开关与原访问状态，可在原行继续操作。无匹配时保留搜索框与清空入口，Enter 聚焦首条匹配 Bot。

生产构建 `index-B1MJXNKJ.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六个工具授权场景。相关插件读取与连接另通过五个回归场景。49 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实供应商工具授权和读屏仍待验证。 [基线](/tmp/openbot-order2-review/tool-grant-roster-baseline.log) · [Chromium](/tmp/openbot-order2-review/tool-grant-roster-final-chromium.log) · [WebKit](/tmp/openbot-order2-review/tool-grant-roster-final-webkit.log) · [插件读取回归](/tmp/openbot-order2-review/tool-grant-roster-regression.log) · [320 像素工具授权](/tmp/openbot-order2-review/tool-grant-roster-chromium-320.png)

## Tasks 与 Ideas 操作复评

`/tasks` 从 38/40 升至 **40/40（100%，暂定）**。H4 加 1 分，Work and history 同时涵盖进行中和已结束的任务，Ideas 与独立页面同名。H10 加 1 分，筛选 Needs input 时说明包含审批请求和问题，筛选 Resolved 时说明仅显示最近七天内已结束的任务。两条说明与筛选控件关联，切换标签后保留状态筛选。

`/ideas` 从 38/40 升至 **40/40（100%，暂定）**。H4 加 1 分，独立页面和 Tasks 中的 Ideas 标签页采用同一个可见的 Dismiss 操作与确认框。H5 加 1 分，提交前显示建议名称和 30 天影响，并复查建议仍在列表中。确认前退出不写入，写入失败可原位重试，成功后保留搜索词并恢复键盘焦点。

生产构建 `index-BMPa7NrG.js` 的 Tasks 状态筛选和 Ideas 搜索均通过 Chromium 的 Team、Personal 复验，各 6 个场景。忽略确认在 Chromium 和 WebKit 各通过 3 个场景，覆盖 1440、390、320 像素。21 项定向测试通过，Impeccable 源码检测为 0 项。真实服务写入与读屏仍待验。 [忽略基线](/tmp/openbot-order2-review/ideas-dismiss-baseline.log) · [Tasks 筛选](/tmp/openbot-order2-review/tasks-review-chromium.log) · [Ideas 搜索](/tmp/openbot-order2-review/ideas-review-search.log) · [Chromium 忽略确认](/tmp/openbot-order2-review/ideas-dismiss-chromium.log) · [WebKit 忽略确认](/tmp/openbot-order2-review/ideas-dismiss-webkit.log)

## Goals 完成确认复评

全部 Goals 由 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分。Mark goal complete 明确指向目标，确认说明此操作会停止未来运行并保留历史。H10 加 1 分。清单说明如何打开目标来编辑指令、调整运行或查看历史，搜索无结果时给出可用状态词。按 Bot 查看 Goals 和单 Bot Goals 各由 38/40 升至 **39/40（97.5%，暂定）**，沿用同一具名操作。按 Bot 的组合页面仍有 Goals 和 Routines 同页的布局扣分。

生产构建 `index-DGxFvFTE.js` 在三个入口用 Chromium 和 WebKit 验证 1440、390、320 像素，共 18 个完成场景。确认前没有写入，取消后焦点回到原操作。模拟 503 后可在原处重试，完成后保留编辑草稿并聚焦标题字段。另通过 9 个 Chromium 草稿回归场景、4 项定向测试、Web 类型检查和 Impeccable 源码检测。真实调度和读屏仍待验。 [基线](/tmp/openbot-order2-review/goal-completion-review-baseline.log) · [Chromium](/tmp/openbot-order2-review/goal-completion-review-chromium.log) · [WebKit](/tmp/openbot-order2-review/goal-completion-review-webkit.log) · [草稿回归](/tmp/openbot-order2-review/goal-completion-review-draft.log)

## Routines 搜索一致性与运行说明复评

全部 Routines 和单 Bot 的 Routines 从 38/40 升至 **40/40（100%，暂定）**。H4 加 1 分。两个入口均可搜索名称、会话、调度和状态，清空后回到搜索框。单 Bot 入口限制为当前 Bot，全部入口还可按 Bot 名称筛选。H10 加 1 分。页面文字解释 Run now 会立即执行并可能向会话发帖。暂停条目提示先打开开关。按钮通过可访问描述关联相应的可见文字，空结果提供可用状态词。

生产构建 `index-BMzgqgtp.js` 在 Team 和 Personal、两个入口、1440、390、320 像素下各跑 Chromium 和 WebKit，共 24 个搜索与说明场景。另有 6 个指令与历史回归场景、3 个读取和删除恢复场景通过。16 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实调度执行、跨时区和读屏仍待验。 [基线](/tmp/openbot-order2-review/routine-action-help-baseline.log) · [Chromium](/tmp/openbot-order2-review/routine-action-help-chromium.log) · [WebKit](/tmp/openbot-order2-review/routine-action-help-webkit.log) · [历史回归](/tmp/openbot-order2-review/routine-action-help-history.log) · [读取和删除回归](/tmp/openbot-order2-review/routine-action-help-recovery.log) · [320 像素页面](/tmp/openbot-order2-review/routine-action-help-320.png)

## Bots 隐藏项查找复评

`/bots` 从 38/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H4 加 1 分。目录按统一的 Search Bots 控件查找名称和角色。匹配的隐藏 Bot 留在 Hidden 分组，遵循同一结果计数和 Enter 定位规则。清空搜索后恢复折叠，浏览器后退保留查询并聚焦上次打开的 Bot。H10 加 1 分。空结果提示尝试较短名称或角色词。隐藏清单失败时明确只查了可见 Bot，重试后恢复查询和焦点。

生产构建 `index-4pwJb_Th.js` 在 Chromium、WebKit 的 Team 和 Personal 版通过 12 个场景，覆盖 1440、390、320 像素。6 个目录回归场景、30 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实工作区数据和读屏仍待验。 [基线](/tmp/openbot-order2-review/bot-hidden-search-baseline.log) · [Chromium](/tmp/openbot-order2-review/bot-hidden-search-chromium.log) · [WebKit](/tmp/openbot-order2-review/bot-hidden-search-webkit.log) · [目录回归](/tmp/openbot-order2-review/bot-hidden-search-regression.log)

## Bot 创建与设置指引复评

`/bots?new=true` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，选择隔离电脑时可见说明它与其他 Bot 的文件、登录及运行成本的关系，公开选项同步更新共享说明。H10 加 1 分，指令字段解释留空时本机托管 Bot 的默认行为，输入框和隔离选项均关联对应的可见说明。

`/bots/$agentId/setup` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，使用 Short description 表达名称下方的简介，编辑器分别说明名称、简介、工作描述和指令的用途。H7 加 1 分，键盘可进入、继续或明确放弃草稿，失败时保留输入并可原位重试。保存或明确放弃后焦点回到原行。

生产构建 `index-BPiggyMz.js` 在 Chromium 和 WebKit 通过 12 个 Team 和 Personal 场景，覆盖 1440、390、320 像素。前一构建另通过 9 个创建交接、框架筛选和公开操作的回归场景。35 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实运行和读屏待验。 [基线](/tmp/openbot-order2-review/bot-create-setup-guidance-baseline.log) · [Chromium](/tmp/openbot-order2-review/bot-create-setup-guidance-chromium.log) · [WebKit](/tmp/openbot-order2-review/bot-create-setup-guidance-webkit.log) · [创建交接](/tmp/openbot-order2-review/bot-create-setup-guidance-handoff.log) · [公开操作](/tmp/openbot-order2-review/bot-create-setup-guidance-visibility.log)

## Bot 分享分配范围复评

`/bots/$agentId/sharing` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分。分配范围明确选择 A group 或 Whole team，提交按钮随范围变化。组名框输入 `*` 时指向正确选项，移除全队分配的按钮具有完整的可访问名称。H4 加 1 分。表单沿用设置页的草稿确认、失败原位重试和成功后的焦点恢复。已有相同分配时阻止重复提交。

生产构建 `index-BPiggyMz.js` 在 Chromium 和 WebKit 通过 1440、390、320 像素共 6 个 Team 管理员场景。取消发布与剪贴板失败通过 3 个 Chromium 回归场景。8 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实成员列表更新和读屏待验。 [基线](/tmp/openbot-order2-review/bot-assignment-scope-baseline.log) · [Chromium](/tmp/openbot-order2-review/bot-assignment-scope-chromium.log) · [WebKit](/tmp/openbot-order2-review/bot-assignment-scope-webkit.log) · [分享回归](/tmp/openbot-order2-review/bot-assignment-scope-unpublish.log) · [320 像素分配弹窗](/tmp/openbot-order2-review/bot-assignment-scope-320.png)

## 技能工具与记忆正文复评

`/capabilities/skills` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分。工具说明明确只加载 Bot 已有权限的工具，Bot 授权区单独说明哪些 Bot 会在命令菜单中显示该技能。H8 加 1 分。默认收起工具清单并显示已选数量。键盘展开、选择工具、关闭再展开时，选择和表单草稿均保留。

`/capabilities/memory` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分。用 Added by you 和 Learned by 描述个人和 Bot 的来源。H8 加 1 分。长记忆先显示正文预览。键盘展开可读取原文并保留换行，收起后操作靠近正文，搜索可匹配预览后面的内容，编辑仍加载全文。

#188 在隔离 PostgreSQL 上接入实际 Hindsight 1.2.3，Memory 集成测试 26 项通过。当前已批准版本才进入索引。变更版本后，旧结果立即被 OpenBot 拒绝，重建后可检索当前版本。其他账号或未获范围的 Bot 无法召回该记忆。删除后，索引和召回均不再包含它。两项需要模型的 Reflect 测试仍待验证。该证据覆盖索引与作用域，页内读屏和独立评分仍待验。

生产构建 `index-BenhbPfL.js` 在 Chromium 和 WebKit 通过 1440、390、320 像素复验。技能覆盖 Team 与 Personal 的 12 个场景，记忆覆盖 Team 的 6 个场景。另通过 9 个草稿、读取和权限回归场景、31 项定向测试、Web 类型检查和 Impeccable 源码检测。真实 Bot 工具加载和记忆同步、读屏仍待验。 [基线](/tmp/openbot-order2-review/capabilities-reading-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/capabilities-reading-chromium.log) · [Team WebKit](/tmp/openbot-order2-review/capabilities-reading-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/capabilities-reading-personal-chromium.log) · [Personal WebKit](/tmp/openbot-order2-review/capabilities-reading-personal-webkit.log) · [320 像素记忆](/tmp/openbot-order2-review/memory-reading-320.png) · [320 像素技能](/tmp/openbot-order2-review/skill-reading-320.png)

## 审批规则清单查找复评

`/settings/approvals` 从 38/40 升至 **40/40（100%，暂定）**。H6 加 1 分。Rules for every Bot 可按动作、应用、Bot 或策略找到个人规则和只读团队规则。H7 加 1 分。Enter 聚焦首条匹配项，清空搜索后保留输入焦点。规则移除按钮带目标名称，触区至少高 44 CSS 像素。

`/admin/approvals` 从 38/40 升至 **40/40（100%，暂定）**。H4 加 1 分。团队与个人规则沿用同一搜索、计数、键盘定位和空结果行为。H8 加 1 分。团队手工新增和文字描述入口放在规则列表前，与既有规则分开。规则说明正常换行，长值仍可折行。

生产构建 `index-BMDmezEB.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过 12 个 Team 与 Personal 场景，包含个人入口查找和团队入口排序与焦点。团队规则移除与刷新、24 条规则的精确搜索及个人草稿保护另通过 9 个回归场景。31 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实规则生效和读屏仍待验。 [基线](/tmp/openbot-order2-review/approval-rule-catalog-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/approval-rule-catalog-team-chromium.log) · [Team WebKit](/tmp/openbot-order2-review/approval-rule-catalog-team-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/approval-rule-catalog-personal-chromium.log) · [Personal WebKit](/tmp/openbot-order2-review/approval-rule-catalog-personal-webkit.log) · [320 像素搜索](/tmp/openbot-order2-review/approval-rule-catalog-320.png)

## 审批指导保存条件复评

`/admin/approvals/guidance` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，编辑框用审批与例行操作说明该写什么，历史回放说明比较对象和模型调用次数。H6 加 1 分，保存旁的状态说明关联保存按钮。用户可在操作前知道检查是前置条件。检查通过后显示可以直接保存，编辑后回到待检查状态，无需记住先前状态。

生产构建 `index-CYoupKg7.js` 在 Chromium 和 WebKit 通过 1440、390、320 像素共 6 个场景。复验编辑后必须重查、无需回放即可保存、回放按钮至少高 44 CSS 像素。另通过 3 个草稿与失败恢复回归场景。规则和指导合计 40 项定向测试、Web 类型检查及 Impeccable 源码检测通过。真实模型解释、历史数据和读屏仍待验。 [基线](/tmp/openbot-order2-review/guidance-readiness-baseline.log) · [Chromium](/tmp/openbot-order2-review/guidance-readiness-chromium.log) · [WebKit](/tmp/openbot-order2-review/guidance-readiness-webkit.log) · [保存回归](/tmp/openbot-order2-review/guidance-readiness-regression.log)

## 审计与活动范围复评

`/admin/audit` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，Background actions 表明此视图筛选例行任务、交接、目标与记忆触发的后台操作。H8 加 1 分，窄屏用独立下拉菜单替代横向视图按钮组，桌面保留直接切换。选项和查询参数在两种布局中一致。

`/settings/activity` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，同一视图采用 Background actions 名称。H10 加 1 分，空查询时也在搜索框上方说明只查已加载事件，并指向 Show older events。导出提示说明 CSV 取所选视图与 Bot 范围，已加载表格的搜索不会缩小导出。

生产构建 `index-CgwkSPlw.js` 在 Chromium 与 WebKit 验证 Team 管理审计和 Personal 活动各 1440、390、320 像素，共 12 个场景。CSV 下载沿用正确视图参数，空结果保留加载旧记录入口。另通过筛选选项重试、403 清除、旧游标隔离和较早结果键盘接续共 12 个回归场景。29 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实工作区日志与读屏待验。 [基线](/tmp/openbot-order2-review/audit-activity-scopes-baseline.log) · [Chromium](/tmp/openbot-order2-review/audit-activity-scopes-chromium.log) · [WebKit](/tmp/openbot-order2-review/audit-activity-scopes-webkit.log) · [筛选恢复](/tmp/openbot-order2-review/audit-activity-scopes-filters.log) · [320 像素审计](/tmp/openbot-order2-review/audit-scopes-320.png) · [320 像素活动](/tmp/openbot-order2-review/activity-scopes-320.png)

## 管理首页拼写恢复复评

`/admin/` 从 38/40 升至 **40/40（100%，暂定）**。H5 加 1 分，常规名称、前缀及任务短语匹配全部优先，只有无结果时才接受一个单词内的一次插入、删除、替换或相邻换位。混合不相关任务词仍无结果，选择前明确告知近似匹配。H9 加 1 分，键盘可从标注的近似结果继续，返回时恢复原查询和焦点。

生产构建 `index-BzmhdXOu.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过 6 个拼写场景。任务词和后退焦点另通过 6 个 Chromium 回归场景。4 项定向测试和 Impeccable 源码检测通过。真实管理员使用和读屏待验。 [基线](/tmp/openbot-order2-review/admin-spelling-baseline.log) · [Chromium](/tmp/openbot-order2-review/admin-spelling-chromium.log) · [WebKit](/tmp/openbot-order2-review/admin-spelling-webkit.log) · [任务词回归](/tmp/openbot-order2-review/admin-spelling-task-regression.log) · [返回回归](/tmp/openbot-order2-review/admin-spelling-ranked-regression.log)

## 人员操作与窄屏复评

`/admin/people` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，清单标题明确是工作区访问，行内区分角色、访问已移除、登录方式和上次登录。H8 加 1 分，窄屏每行合并为一个具名操作菜单，桌面可直接操作。确认使用原人员记录，取消未发写入且恢复焦点。分页后可以从首条新增人员进入该行操作。

生产构建 `index-CPv1_Os7.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过 6 个取消与焦点场景。搜索切换、分页重试和读取权限变化另通过 9 个 Chromium 回归场景。两页合计 5 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实成员操作与读屏待验。 [基线](/tmp/openbot-order2-review/people-actions-layout-baseline.log) · [Chromium](/tmp/openbot-order2-review/people-actions-layout-chromium.log) · [WebKit](/tmp/openbot-order2-review/people-actions-layout-webkit.log) · [分页回归](/tmp/openbot-order2-review/people-actions-layout-focus.log) · [权限回归](/tmp/openbot-order2-review/people-actions-layout-access.log) · [320 像素页面](/tmp/openbot-order2-review/people-actions-layout-320.png)

## 设备重置范围与窄屏复评

`/admin/computers` 和 `/settings/computer` 均从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，共享模式按目标说明影响单个或多个浏览器配置，独立电脑明确会删除设备文件和浏览器配置。确认期间重置范围改变时拦截提交。H8 加 1 分，窄屏各设备使用单个菜单，桌面保留直接操作，取消后保持筛选并归还焦点。

生产构建 `index-BQ6LOLtd.js` 在 Team 和 Personal 的 Chromium 和 WebKit 验证 1440、390、320 像素，共 12 个场景。先前构建另通过设备结果不明与状态重读失败的 12 个回归场景。27 项设备定向测试、Web 类型检查与 Impeccable 源码检测通过。真实设备重置和读屏仍待验。 [基线](/tmp/openbot-order2-review/device-actions-layout-baseline.log) · [Chromium](/tmp/openbot-order2-review/device-actions-layout-chromium.log) · [WebKit](/tmp/openbot-order2-review/device-actions-layout-webkit.log) · [结果回归](/tmp/openbot-order2-review/device-actions-layout-outcome.log) · [重读失败](/tmp/openbot-order2-review/device-actions-layout-outcome-read-failure.log) · [320 像素设备清单](/tmp/openbot-order2-review/device-actions-layout-40175-320.png)

### 设备管理真实环境验收进度

macOS 使用本机安装的 Google Chrome 和独立的 OpenBot 设备数据目录。真实设备服务启动浏览器后返回 1280×800 的屏幕画面。停止后浏览器不再运行，设备配置仍在清单中，重新启动仍保留原配置。共享模式重置清除了指定浏览器配置，保留了另一浏览器配置及设备工作区文件，并更新了运行标识。再次启动得到干净的浏览器配置。 [真实 Chrome 验证](/tmp/openbot-real-device/chrome-real.log)

本机 OpenBot API、隔离 PostgreSQL 和生产构建 `index-B-8IqEyn.js` 连到同一个真实设备服务。个人版 `/settings/computer` 在 320 CSS 像素验证了用 Escape 取消重置，筛选与设备菜单焦点保留，设备和审计均无写入。确认停止后页面显示回执，API 返回 200，Chrome 停止，浏览器配置和工作区文件仍在，数据库新增一条停止审计。 [个人版网页流程](/tmp/openbot-real-device/web-personal-flow.log)

Team `/admin/computers` 使用本机管理员验证共享模式。320 CSS 像素下，键盘取消保留筛选并归还设备菜单焦点，无写入。确认重置后，API 返回 200，网页显示回执，目标浏览器配置已删除，设备工作区保留，该次确认仅新增一条重置审计。最后一个条目消失后显示空清单，键盘焦点归还设备清单标题。独立电脑整机重置、Team 多角色登录、实体触屏和读屏仍待验。本地真实操作的证据已补齐这两个页面的共享模式范围。 [Team 网页流程](/tmp/openbot-real-device/web-team-final.log)

## 通知投递类型复评

`/settings/notifications` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，使用 Approvals 标出需要用户批准的更新，并将失败归到实际更新类型和渠道。H8 加 1 分，同一次投递失败只出现一次。渠道按窄屏两列排列，原因为可用键盘展开的说明，开关保留已保存值。

生产构建 `index-BQ6LOLtd.js` 在 Chromium 和 WebKit 的 Team、Personal 版通过 1440、390、320 像素共 12 个场景。另通过通知保存恢复、开关对比度与 44 CSS 像素窄屏触区回归。10 项通知定向测试、Web 类型检查与 Impeccable 源码检测通过。真实通知渠道与读屏仍待验。 [基线](/tmp/openbot-order2-review/notification-delivery-kind-baseline.log) · [Chromium](/tmp/openbot-order2-review/notification-delivery-kind-chromium.log) · [WebKit](/tmp/openbot-order2-review/notification-delivery-kind-webkit.log) · [保存恢复](/tmp/openbot-order2-review/notification-delivery-kind-recovery.log) · [320 像素通知设置](/tmp/openbot-order2-review/notification-delivery-kind-320.png)

## 边界起点比较与表达式指引复评

`/admin/boundaries/new` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，选择模板前即可看到规则实际拦截的范围和例外。H8 加 1 分，选中起点后收起列表，使用 Change starting point 可重新打开并定位。切换起点保留各自草稿。

边界规则详情从 38/40 升至 **40/40（100%，暂定）**。H4 加 1 分，与新建页复用同一表达式帮助和可读字号。H6 加 1 分，常驻说明解释何时匹配，并提供与输入框关联的 CEL 示例。字段参考仍按需展开，输入后示例和校验反馈可同时查看。

生产构建 `index-DXVAlBr4.js` 在 Chromium 和 WebKit 验证 1440、390、320 像素，共 6 个新建与详情组合场景。模板切换与冲突恢复、详情保存聚焦及历史回放另通过 6 个 Chromium 回归场景。26 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实策略回放和读屏仍待验。 [基线](/tmp/openbot-order2-review/boundary-expression-guide-baseline.log) · [Chromium](/tmp/openbot-order2-review/boundary-expression-guide-chromium.log) · [WebKit](/tmp/openbot-order2-review/boundary-expression-guide-webkit.log) · [新建回归](/tmp/openbot-order2-review/boundary-expression-guide-starter.log) · [保存回归](/tmp/openbot-order2-review/boundary-expression-guide-save.log) · [320 像素边界详情](/tmp/openbot-order2-review/boundary-expression-guide-320.png)

## 策略测试步骤与结果复评

`/admin/what-if` 从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，页首说明这是对允许、拒绝与审批等结果的模拟，用户可以看到哪项控制决定结果。H10 加 1 分，输入框与 Check 都关联说明。Ask 准备动作，Check 才进行判断。用户修改或清空问题后，已有结果仍标明对应的动作。输入非空才提供重新提问指引。

生产构建 `index-DX7bPKou.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过 6 个场景。先前构建的请求切换、过期响应、访问拒绝及刷新恢复共 6 个回归场景通过。6 项定向测试、Web 类型检查与 Impeccable 源码检测通过。真实模型判定与读屏仍待验。 [基线](/tmp/openbot-order2-review/what-if-stage-guide-baseline.log) · [Chromium](/tmp/openbot-order2-review/what-if-stage-guide-chromium.log) · [WebKit](/tmp/openbot-order2-review/what-if-stage-guide-webkit.log) · [切换回归](/tmp/openbot-order2-review/what-if-stage-guide-switch.log) · [权限回归](/tmp/openbot-order2-review/what-if-stage-guide-recovery.log)

## 技能管理保存范围复评

Team 和 Personal 的技能详情均从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，Bot 开关即时更新命令菜单，内容表单单独保存。H3 加 1 分，浏览器后退、页首返回和其他站内导航共用退出确认。仅保存工具也会清除草稿状态，保存失败仍可保留编辑。

Team 和 Personal 的新建技能均从 38/40 升至 **40/40（100%，暂定）**。H2 加 1 分，Team 保存后选择提供技能的 Bot，Personal 保存即向所有个人 Bot 提供。H8 加 1 分，工具清单按需展开，收起时显示选择数量，保留工具及字段草稿。

生产构建 `index-DynBcM9Y.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过 12 个详情和新建组合场景。另通过 9 个草稿失败、权限与回退场景。31 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实技能执行和读屏待验。 [基线](/tmp/openbot-order2-review/managed-skill-editor-guide-baseline.log) · [Chromium](/tmp/openbot-order2-review/managed-skill-editor-guide-chromium.log) · [WebKit](/tmp/openbot-order2-review/managed-skill-editor-guide-webkit.log) · [Team 权限回归](/tmp/openbot-order2-review/managed-skill-editor-guide-recovery-team.log) · [Personal 权限回归](/tmp/openbot-order2-review/managed-skill-editor-guide-recovery-personal.log) · [320 像素技能表单](/tmp/openbot-order2-review/managed-skill-editor-guide-320.png)

## 通用设置窄屏可读性复评

`/settings/` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。常驻指示始终说明适用范围，消息列表选项说明点明会话标题和 Bot 名称，控件关联该说明。H8 加 1 分。窄屏将消息列表选择器放到独立一行。100 字符的姓名可完整换行，说明文字完整显示。常驻指示保留简短预览，编辑器可读全文。

生产构建 `index-be0lccw8.js` 在 Team 与 Personal 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验。切换消息列表选项成功写入，快捷键章节链接移到标题，读取与保存失败可原位恢复。7 项定向测试和 Web 类型检查通过，Impeccable 源码检测为 0 项。原生桌面专属设置、跨设备同步和实际读屏待验。 [320 像素基线](/tmp/openbot-order2-review/general-legibility-baseline.log) · [320 像素复验](/tmp/openbot-order2-review/general-legibility-320.png) · [Team](/tmp/openbot-order2-review/general-legibility-team.log) · [Personal](/tmp/openbot-order2-review/general-legibility-personal.log) · [读取与保存恢复](/tmp/openbot-order2-review/general-legibility-recovery.log)

## 会话过渡页复制与发送确认复评

`/start/$startId` 从 34/36 升至 **36/36（100%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · — · 4 · 4 · 4。H4 加 1 分。过渡页与单 Bot 会话共用原文复制控件。剪贴板被拒绝时，键盘用户直接到达已选中全文的只读字段。H10 加 1 分。群聊首条消息已经提交时，重试说明会先核对原消息。模拟复验确认已送达时直接打开该会话，未重复写入。

生产构建 `index-D1ovZC8O.js` 在 Chromium、WebKit 的 320、390、1440 像素覆盖 Team 与 Personal 的 12 组剪贴板拒绝场景。6 组原有复制与重选收件人回归以及 6 组群聊重试通过。53 项定向测试、Web 类型检查通过，Impeccable 源码检测为 0 项。真实剪贴板权限、生产消息送达与实际读屏待验。 [剪贴板拒绝基线](/tmp/openbot-order2-review/start-copy-fallback-baseline.log) · [拒绝后复制](/tmp/openbot-order2-review/start-copy-fallback-final.log) · [复制与重选回归](/tmp/openbot-order2-review/start-copy-success-final.log) · [群聊重试](/tmp/openbot-order2-review/start-submitted-retry-reviewed.log) · [320 像素复制画面](/tmp/openbot-order2-review/start-copy-fallback-320.png)

## 组件描述原位发布复评

`/admin/components/$name` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H7 加 1 分。已发布的内置组件可用独立按钮发布已保存描述，发布开关保持开启，Bot 授权保持原状。确认默认聚焦 Cancel，发布前重新读取，发现草稿或发布状态已改变时要求重新核对。失败可在确认框原位重试。H10 加 1 分。编辑器说明保存与发布的关系，对空白描述给出输入指引。Playground 组件从 Saved here 打开实际的源草稿。

生产构建 `index-D96JzJoo.js` 在 Chromium 和 WebKit 的 320、390、1440 像素通过六组模拟复验，并通过三组保存、发布开关和数据函数故障回归。Web 类型检查和 71 项定向测试通过，其中 35 项使用专用 PostgreSQL 测试库。Impeccable 源码检测为 0 项。生产部署发布与实际读屏待验。 [发布复验](/tmp/openbot-order2-review/component-description-final.log) · [恢复回归](/tmp/openbot-order2-review/component-description-regression.log) · [PostgreSQL 集成测试](/tmp/openbot-order2-review/component-description-store-final.log) · [320 像素确认](/tmp/openbot-order2-review/component-description-confirm-320.png)

## 快速会话简介与新开会话复评

`/bot` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。页内按钮明确为当前 Bot 新开会话，确认框说明新会话历史为空及已保存草稿的去向。取消时没有新建请求，确认后原草稿在新会话中恢复。H8 加 1 分。简介按需展开，长文本可换行并在区块内滚动，输入框保持可见。

生产构建 `index-DItANzpJ.js` 在 Team 和 Personal 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验。慢清单和切换 Bot 后草稿隔离通过三组回归。真实网关发送与实际读屏待验。 [窄屏基线](/tmp/openbot-order2-review/quick-chat-layout-baseline.log) · [Team](/tmp/openbot-order2-review/quick-chat-layout-team.log) · [Personal](/tmp/openbot-order2-review/quick-chat-layout-personal.log) · [慢清单回归](/tmp/openbot-order2-review/quick-chat-layout-regression.log) · [320 像素展开简介](/tmp/openbot-order2-review/quick-chat-layout-320.png)

## 录制列表与开窗说明复评

`/browser` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。录制链接先说明可查看过往记录或主动打开浏览器，两种入口共用开窗失败文案并保留已知的浏览器状态。H8 加 1 分。长录制标题可完整换行，窄屏将结束状态放到独立一行。

Team 与 Personal 的 Chromium、WebKit 在 320、390、1440 像素通过 12 组模拟复验。打开后恢复焦点与避免重复请求通过三组回归。两页合计 101 项定向测试通过，快速会话按钮改名后的 16 项回归也通过。Web 类型检查通过，Impeccable 源码检测为 0 项。真实串流、实体触屏与实际读屏待验。 [截断基线](/tmp/openbot-order2-review/recordings-legibility-baseline.log) · [Team](/tmp/openbot-order2-review/recordings-legibility-team.log) · [Personal](/tmp/openbot-order2-review/recordings-legibility-personal.log) · [重试恢复](/tmp/openbot-order2-review/recordings-legibility-regression.log) · [320 像素标题](/tmp/openbot-order2-review/recordings-legibility-320.png) · [定向测试](/tmp/openbot-order2-review/quick-recordings-tests-final.log)

## 新增凭据类型与同名冲突复评

`/admin/credentials/new` 和 `/settings/credentials/new` 均从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H7 加 1 分。按类型、Provider 和 Key ID 识别已有的有效凭据，输入框旁说明冲突，键盘操作可直接选中旧 ID。服务端返回并发冲突后，换用其他 ID 可继续创建，密钥仍保留在密码输入框中。H10 加 1 分。类型和 Key ID 输入均关联说明，Provider 提示随选择更新。

生产构建 `index-JsnnbuYp.js` 在 Team 和 Personal 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验。另有三组创建、确认替换和读取恢复的浏览器回归。45 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实服务权限、实体触屏及实际读屏待验。 [缺少原位改用 ID 的基线](/tmp/openbot-order2-review/credential-type-conflict-baseline.log) · [类型与冲突复验](/tmp/openbot-order2-review/credential-type-conflict-final.log) · [替换回归](/tmp/openbot-order2-review/credential-type-conflict-regression.log) · [320 像素表单](/tmp/openbot-order2-review/credential-inline-conflict-320.png) · [定向测试](/tmp/openbot-order2-review/credential-type-conflict-tests.log)

## Bot 插件访问状态复评

`/admin/plugins/$key/bots/$agentId` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H1 加 1 分。刷新失败保留已读取的权限，标明权限来自上次成功读取并暂停更改。重试后恢复写入和标题焦点，保留搜索。403 时隐藏旧权限和操作。H2 加 1 分。名称读取失败时以应用和访问任务命名页面，说明 Bot ID 是用于识别当前 Bot，提供独立的名称重试。两个动作区直接区分只读和会更改数据的操作。

生产构建 `index-CmncExbY.js` 在 Team Chromium、WebKit 的 320、390、1440 像素通过六组模拟复验。插件和连接页的 11 组读取恢复回归通过。51 项定向测试、Web 类型检查通过，Impeccable 源码检测为 0 项。真实授权写入、实体触屏与实际读屏待验。 [名称读取基线](/tmp/openbot-order2-review/plugin-bot-access-baseline.log) · [访问状态复验](/tmp/openbot-order2-review/plugin-bot-current-access-final.log) · [读取恢复回归](/tmp/openbot-order2-review/plugin-bot-current-access-regression.log) · [320 像素旧权限提示](/tmp/openbot-order2-review/plugin-bot-stale-320.png) · [定向测试](/tmp/openbot-order2-review/plugin-bot-current-access-tests-final.log)

## 插件详情工具清单复评

`/admin/plugins/$key` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H1 加 1 分。工具刷新失败时，即使已有工具也会显示原因，并标明清单来自上次成功刷新。详情读取失败时保留旧数据、暂停批量授权并提供独立重试。工具列表重新核对成功后才显示成功回执。H6 加 1 分。工具名和说明完整换行，窄屏把授权数量与动作类型放到独立一行。Bot 名册不完整时仅显示已知授权数。

生产构建 `index-BMM6gBTk.js` 在 Chromium 和 WebKit 的 320、390、1440 像素通过六组模拟复验。另有九组插件读取恢复和三组账户断开回归通过。79 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实服务商刷新、实体触屏和实际读屏待验。 [截断与刷新失败基线](/tmp/openbot-order2-review/plugin-detail-tools-baseline.log) · [工具与详情恢复复验](/tmp/openbot-order2-review/plugin-detail-tools-final.log) · [读取恢复回归](/tmp/openbot-order2-review/plugin-detail-tools-regression.log) · [账户断开回归](/tmp/openbot-order2-review/plugin-detail-disconnect-regression.log) · [320 像素工具行](/tmp/openbot-order2-review/plugin-detail-tool-wrap-320.png) · [定向测试](/tmp/openbot-order2-review/plugin-detail-tools-tests.log)

## 群聊回复查收与权限恢复复评

`/group/$channelId` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H7 加 1 分。键盘查收成功后，焦点移到新回复，用户已转到其他控件时保留其焦点。H9 加 1 分。暂时读取失败时保留原消息和原位重试。权限被拒绝后隐藏旧消息、会话名称和成员入口，之后的暂时故障也不恢复旧数据。

生产构建 `index-BwkYzS7K.js` 在 Team 和 Personal 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验。返回 Activity 的三组焦点回归，以及已提交消息恢复的六组回归通过。21 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实成员权限、网关回复及实际读屏待验。 [刷新按钮消失基线](/tmp/openbot-order2-review/group-reply-refresh-baseline.log) · [查收与权限复验](/tmp/openbot-order2-review/group-reply-release-browser.log) · [Activity 返回](/tmp/openbot-order2-review/group-reply-release-activity.log) · [已提交消息核对](/tmp/openbot-order2-review/group-reply-release-handoff.log) · [320 像素原位重试](/tmp/openbot-order2-review/group-reply-refresh-320.png)

## 登录方式重新检查复评

`/sign` 从 38/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H7 加 1 分。公司登录未启用或工作区无可用登录方式时可原位重新检查。读取失败保留键盘焦点，恢复后返回标题，不丢失登录后的目标地址。H10 加 1 分。说明请 IT 帮助台或邀请人检查工作区登录，管理员入口说明谁可以用它恢复公司登录。

生产构建 `index-1-2Vsple.js` 在 Chromium 和 WebKit 的 320、390、1440 像素通过六组模拟复验，包括配置恢复、接口失败、公司邮箱被拒后的保留和回跳地址。33 项定向测试与 Web 类型检查通过。路由测试单独运行，避开登录测试替换全局 `window` 后的测试环境冲突。Impeccable 源码检测为 0 项。真实身份提供商回跳、联系方式与读屏待验。 [缺少重新检查入口的基线](/tmp/openbot-order2-review/sign-config-recheck-baseline.log) · [双浏览器复验](/tmp/openbot-order2-review/sign-config-recheck-final.log) · [320 像素恢复入口](/tmp/openbot-order2-review/sign-config-recheck-320.png) · [登录测试](/tmp/openbot-order2-review/sign-config-recheck-auth.log) · [路由测试](/tmp/openbot-order2-review/sign-config-recheck-router.log)

## Bot 审批规则移除复评

`/bots/$agentId/approvals` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H5 加 1 分。确认框显示要移除的规则、当前行为和适用范围，说明移除后由其余规则与默认设置决定。默认聚焦取消，取消不写入。确认前重读规则，发现其已变更或失效时提示重新核对。移除失败可在确认框重试，成功后反馈并把焦点移到相邻规则。

生产构建 `index-BqhzN3NA.js` 在 Chromium 和 WebKit 的 320、390、1440 像素通过六组模拟复验。三组草稿、权限和列表恢复回归通过。36 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实规则写入和读屏待验。 [直接写入基线](/tmp/openbot-order2-review/bot-rule-remove-baseline.log) · [移除复验](/tmp/openbot-order2-review/bot-rule-remove-final.log) · [草稿和权限回归](/tmp/openbot-order2-review/bot-rule-remove-draft-regression.log) · [320 像素确认](/tmp/openbot-order2-review/bot-rule-remove-confirm-320.png) · [定向测试](/tmp/openbot-order2-review/bot-rule-remove-tests.log)

## Bot 应用访问撤销复评

`/bots/$agentId/access` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H5 加 1 分。撤销前说明只收回当前用户授予的权限，管理员授予的权限继续生效。应用已经无法由当前用户授予时，确认框说明需要管理员恢复。默认聚焦取消，取消不写入。写入与清单读取失败时保留确认框。成功后有回执，原开关消失时焦点回到 Your apps 标题。

生产构建 `index-B1mDPZMW.js` 在 Chromium 和 WebKit 的 320、390、1440 像素通过六组模拟复验。另有六组应用与技能授权、重试和窄屏触区回归。61 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实账号授权、实体触屏和实际读屏待验。 [立即撤销与焦点丢失基线](/tmp/openbot-order2-review/owner-app-revoke-baseline.log) · [撤销和读取失败复验](/tmp/openbot-order2-review/owner-app-revoke-with-read-final.log) · [Chromium 回归](/tmp/openbot-order2-review/owner-app-revoke-regression-chromium.log) · [WebKit 回归](/tmp/openbot-order2-review/owner-app-revoke-regression-webkit.log) · [320 像素确认](/tmp/openbot-order2-review/owner-app-revoke-320.png)

## 共享路由恢复操作复评

未知地址和路由加载失败页均从 35/36 升至 **36/36（100%，暂定）**。H1–H10 为 4 · 4 · 4 · 4 · 4 · 4 · — · 4 · 4 · 4。H4 加 1 分。在线失败时优先重试。有站内历史的未知地址或离线错误优先返回。直接打开的失效地址没有可返回的页面时，打开工作区成为主操作。两页用相同样式与键盘顺序，键盘进入工作区后把焦点移到首页标题。

生产构建 `index--i1pNh4O.js` 在 Chromium、WebKit 的 320、390、1440 像素通过六组模拟复验。九组站内返回、路径隐私和原址重试回归通过。16 项定向测试与 Web 类型检查通过，Impeccable 源码检测为 0 项。Firefox 在打开页面前启动超时并报告图形渲染错误，真实桌面端和读屏也仍待验。 [离线主操作基线](/tmp/openbot-order2-review/route-shared-actions-baseline.log) · [主操作与焦点复验](/tmp/openbot-order2-review/route-shared-actions-final.log) · [缺失地址回归](/tmp/openbot-order2-review/route-shared-missing-chromium.log) · [离线返回](/tmp/openbot-order2-review/route-shared-back-webkit.log) · [原址重试](/tmp/openbot-order2-review/route-shared-retry-regression.log) · [Firefox 诊断](/tmp/openbot-order2-review/route-shared-firefox-probe.log)

## Bot 档案通知措辞复评

`/bots/$agentId` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。通知选项直接列出全部更新、决定与问题及提醒、仅侧栏徽标。选择器关联说明，说明侧栏徽标一直可用。设备权限单独显示，浏览器阻止通知时指向站点设置，窗口重新获得焦点时重新读取权限。窄屏完整显示 Active 和通知说明。

生产构建 `index-CuSDxwUz.js` 在 Team 和 Personal 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验，验证保存选项、重新读取设备权限和窄屏说明。重置和复制的六组回归通过。32 项定向测试与 Web 类型检查通过，Impeccable 源码检测为 0 项。真实设备权限、通知投递和实际读屏待验。 [原通知措辞基线](/tmp/openbot-order2-review/profile-notification-language-baseline.log) · [通知与权限复验](/tmp/openbot-order2-review/profile-notification-release-browser.log) · [重置回归](/tmp/openbot-order2-review/profile-notification-release-reset.log) · [复制回归](/tmp/openbot-order2-review/profile-notification-release-copy.log) · [320 像素说明](/tmp/openbot-order2-review/profile-notification-language-320.png)

## Activity 状态措辞复评

`/s/activity` 与 `/bots/$agentId/activity` 均从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。任务已失败但仍需要用户关注时，保留失败状态并另外标明需要关注。等待用户、等待开始、自动重试与结果已交付各用明确措辞。两处显示相同的状态与原会话入口。

生产构建 `index-D_a73bgN.js` 在两处 Activity 的 Chromium、WebKit 下通过 320、390、1440 像素共 12 组模拟复验。停止、取消、失败重试及较早完成记录展开共九组回归通过。19 项定向测试与 Web 类型检查通过，Impeccable 源码检测为 0 项。真实任务执行和读屏待验。 [失败状态被覆盖的基线](/tmp/openbot-order2-review/activity-readable-status-baseline.log) · [双入口复验](/tmp/openbot-order2-review/activity-readable-status-final.log) · [任务操作回归](/tmp/openbot-order2-review/activity-readable-status-actions.log) · [320 像素状态](/tmp/openbot-order2-review/activity-readable-status-320.png) · [定向测试](/tmp/openbot-order2-review/activity-readable-status-tests.log)

## 记忆来源同步与启停反馈复评

`/bots/$agentId/memory` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H4 加 1 分。同步与启停采用与 Bot 应用和技能相同的逐行反馈。进度、失败与成功归属正在操作的来源，其他行没有对应提示。请求期间的重复按键不会产生额外写入。暂时失败后，键盘焦点保留在同步按钮，可直接重试。

生产构建 `index-VrtYQzt7.js` 在 Chromium、WebKit 的 320、390、1440 像素通过六组模拟复验。Team 三组移除、权限拒绝及恢复回归，Personal 一个旧书签跳转也通过。19 项定向测试及 Web 类型检查通过，Impeccable 源码检测为 0 项。真实第三方同步和实际读屏待验。 [列表底部故障基线](/tmp/openbot-order2-review/memory-source-action-feedback-baseline.log) · [逐行反馈复验](/tmp/openbot-order2-review/memory-source-action-feedback-final.log) · [移除和路由回归](/tmp/openbot-order2-review/memory-source-action-feedback-removal.log) · [320 像素启停回执](/tmp/openbot-order2-review/memory-source-action-feedback-320.png)

## Bot 联系方式断开连接复评

`/bots/$agentId/reach` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H5 加 1 分。断开前显示 Slack、Microsoft Teams 或具体手机号，并说明 Bot 会停止向该连接发送消息。默认聚焦取消，取消后返回原按钮。提交期间防止重复写入，503 后可原位重试。成功移除该项并聚焦回执。若列表刷新发现连接移到另一会话，则要求关闭确认并查看列表。

生产构建 `index-o6QPpp43.js` 在 Team Chromium、Team WebKit 和 Personal Chromium 的 1440、390、320 像素通过九组模拟断开复验，另通过六组连接码与短信回归。46 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实平台回调、短信送达和实际读屏待验。 [首次按键发送请求的基线](/tmp/openbot-order2-review/reach-disconnect-baseline.log) · [Team Chromium](/tmp/openbot-order2-review/reach-disconnect-chromium.log) · [Team WebKit](/tmp/openbot-order2-review/reach-disconnect-webkit.log) · [Personal Chromium](/tmp/openbot-order2-review/reach-disconnect-personal.log) · [320 像素重试画面](/tmp/openbot-order2-review/reach-disconnect-retry-320.png)

## 新建例行任务措辞复评

`/routines/new` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。指令示例在输入期间保持可见。日程用易读的时区名称复述设置。结果去向说明每次运行会写入所选会话，并解释新会话会使用例行任务名称或指令开头。指令、日程和结果去向都与对应控件建立可访问的描述关联。

生产构建 `index-BsoYmnYL.js` 在 Chromium、WebKit 的 1440、390、320 像素通过六组模拟提交。验证显示 Eastern Time 时仍提交正确的时区，并核对实际发送的每小时配置和新会话命名。三组草稿、重复提交和失败重试回归通过。9 项定向测试、Web 类型检查和 Impeccable 源码检测通过。真实排程和实际读屏待验。 [基线](/tmp/openbot-order2-review/routine-create-guidance-baseline.log) · [Chromium](/tmp/openbot-order2-review/routine-create-guidance-chromium.log) · [WebKit](/tmp/openbot-order2-review/routine-create-guidance-webkit.log) · [草稿回归](/tmp/openbot-order2-review/routine-create-guidance-regression.log) · [320 像素表单](/tmp/openbot-order2-review/routine-create-guidance-320.png)

构建 `105c98736` 的 Chromium 在 390×844 连接隔离 OpenBot API 和 PostgreSQL。Personal 管理员用键盘提交新例行任务，API 只收到一次创建请求并返回 201。列表标题接收焦点，刷新后仍可见该任务。数据库中对应任务仅一条，接口读回 `America/New_York` 及关联会话 ID。 [浏览器记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-browser-db.Ik2oB2/run.json) · [数据库计数](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-browser-db.Ik2oB2/db-count.txt)

同一构建的 Tasks、Ideas、Goals、Routines、新建例行任务和 Activity 在 320 CSS 像素用 Chromium 和 WebKit 检查浅色和深色，24 个模拟页面样本均无页面异常或文档级横向溢出。另有 120 项 Web 和 PostgreSQL 定向测试通过。读屏及最终独立评分仍待验。 [窄屏记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/tasks-narrow.sdlgOU/run.json)

同一构建通过本地 Keycloak 的真实 OIDC 回调登录 Team 管理员和普通成员。两种角色各用键盘保存一次，均返回 201，焦点回到列表标题，刷新后能看到自己的任务。各账号的例行任务接口仅返回本人的记录。隔离数据库确认两条记录归属不同账号。 [Team 浏览器记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-team-browser.fydU7n/run.json) · [数据库计数](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-team-browser.fydU7n/db-count.txt)

## Goals 视图布局复评

`/responsibilities?view=goals` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H8 加 1 分。同一个 Bot 的目标和例行任务各自按需显示。切换入口就在 Bot 选择器下方，例行任务无需滚过目标清单即可查阅。24 条目标的 320 像素 Chromium 场景中，例行任务标题从原来的 2,258 CSS 像素处移至切换后的首屏。只打开 Goals 时无需读取例行任务列表。例行任务视图可用地址直接打开，兼容 `/s/goals` 和旧页内锚点。

生产构建 `index-E8UW0yGn.js` 在 Chromium、WebKit 的 1440、390、320 像素通过六组模拟复验，涵盖 Team 和 Personal、键盘焦点、选择 Bot、后退及旧书签。另通过三组 Bot 读取故障恢复和九组目标完成回归。26 项定向测试、Web 类型检查、Astryx 构建诊断和 Impeccable 源码检测通过。真实调度和读屏待验。 [基线](/tmp/openbot-order2-review/goals-work-views-baseline.log) · [Chromium](/tmp/openbot-order2-review/goals-work-views-chromium.log) · [WebKit](/tmp/openbot-order2-review/goals-work-views-webkit.log) · [读取恢复](/tmp/openbot-order2-review/goals-work-views-roster.log) · [目标完成](/tmp/openbot-order2-review/goals-work-views-completion.log) · [320 像素视图](/tmp/openbot-order2-review/goals-work-views-320.png)

## 单 Bot Goals 布局复评

`/bots/$agentId/responsibilities` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H8 加 1 分。页面合并两个同名标题和说明。创建与搜索紧邻清单。320 像素视口中首条目标从距视口顶部 440 移至 393 CSS 像素。读取失败时收起创建操作，恢复后焦点回到页面标题。空列表保留单个创建入口，取消创建后焦点回到入口。

生产构建 `index-Cd_7DWVB.js` 在 Chromium、WebKit 的 1440、390、320 像素通过六组模拟复验，覆盖 Team、Personal、空清单、503 恢复及 403。九组目标完成和三组跨视图切换回归通过。26 项定向测试、Web 类型检查、Astryx 构建诊断和 Impeccable 源码检测通过。真实调度和读屏待验。 [基线](/tmp/openbot-order2-review/bot-goals-layout-baseline.log) · [Chromium](/tmp/openbot-order2-review/bot-goals-layout-chromium.log) · [WebKit](/tmp/openbot-order2-review/bot-goals-layout-webkit.log) · [目标完成回归](/tmp/openbot-order2-review/bot-goals-layout-completion.log) · [页内切换回归](/tmp/openbot-order2-review/bot-goals-layout-work-views.log) · [320 像素页面](/tmp/openbot-order2-review/bot-goals-layout-320.png)

## 此电脑诊断预览复评

`/settings/this-computer` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H10 加 1 分。帮助文字在复制前说明快照包含安装路径、应用版本、服务状态和内存。键盘可展开只读快照，预览期间剪贴板保持原样。复制时使用已查看的文本，失败后选中同一份完整快照。浏览器交接补充桌面应用的安装前提。

生产构建 `index-B-sM6msk.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过桌面 IPC 模拟及浏览器交接复验。14 项设备定向测试、类型检查、Astryx 构建诊断和 Impeccable 源码检测通过。安装版协议拉起和实际读屏待验。 [Chromium](/tmp/openbot-device-review/chromium.log) · [WebKit](/tmp/openbot-device-review/webkit.log) · [320 像素手动复制](/tmp/openbot-device-review/final-320.png)

## 已连接浏览器查找复评

`/settings/browsers` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H8 加 1 分。可按名称、连接日期或录制状态筛选，按 Enter 聚焦首条结果。取消确认保留筛选，成功只断开选中的连接。24 台设备的 Chromium 320 像素场景中，目标操作从距视口顶部约 3,889 移至 447 CSS 像素。设置入口在长列表下仍可直接聚焦录制隐私说明。

生产构建 `index-BeGWNEiT.js` 在 Chromium 与 WebKit 的 1440、390、320 像素通过六组模拟复验。28 项 Recorder 定向测试、Astryx 构建诊断和 Impeccable 源码检测通过。真实录制状态同步、商店扩展和实际读屏待验。 [基线](/tmp/openbot-device-review/recorder-baseline.log) · [Chromium](/tmp/openbot-device-review/recorder-chromium.log) · [WebKit](/tmp/openbot-device-review/recorder-webkit.log) · [320 像素筛选](/tmp/openbot-device-review/recorder-search-320.png)

## Personal 应用连接加载复评

`/connections/$key` 的 Personal 应用详情从 39/40 升至 **40/40（100%，暂定）**。H1 加 1 分。应用资料与账户读取各有可见状态。应用资料先到时立即显示真实名称和简介，账户读取完成后才显示账户操作。两个阶段均可返回 Connections，读取完成时保留返回链接的键盘焦点。应用资料被拒绝时直接显示错误，未完成的账户读取不会遮住故障。

生产构建 `index-CGF2jx5X.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六组模拟复验。43 项定向测试、Web 类型检查、Astryx 构建诊断及 Impeccable 源码检测通过。真实 OAuth 服务和实际读屏待验。 [基线](/tmp/openbot-device-review/app-connection-baseline.log) · [Chromium](/tmp/openbot-device-review/app-connection-chromium.log) · [WebKit](/tmp/openbot-device-review/app-connection-webkit.log) · [320 像素加载](/tmp/openbot-device-review/app-connection-320.png)

## GitHub 添加重试与 Slack 连接码验证进度

GitHub 仓库表单重试原稿时复用同一请求标识。服务端按账户隔离请求标识，同一次创建在事务内串行处理。Slack 连接弹窗显示私信操作和实际有效期，过期后提示重新申请，剪贴板被拒时选中命令。

10 项 GitHub 前端与事件签名定向测试通过。首个生产构建在 Chromium 和 WebKit 的三种宽度验证了原表单重试、剪贴板回退和过期后重新申请。复验发现 Slack 有两个同名关闭控件，代码现只保留一个，等待新版复验。首个 PostgreSQL 容器退出，内存盘上的隔离重试已通过。 [定向测试](/tmp/openbot-device-review/github-slack-tests.log) · [首轮 Chromium](/tmp/openbot-device-review/github-slack-prior-chromium.log) · [首轮 WebKit](/tmp/openbot-device-review/github-slack-prior-webkit.log) · [GitHub 仓库重复请求复评](#github-仓库重复请求复评)

## Routines 内置入口验证进度

Connections 清单单列内置调度工具，Routines 不进入外部应用数量，仍可由搜索找到并打开原地址。Routines 详情沿用 Connections 的页面框架和读取重试。24 项定向测试通过。生产构建及三种视口复验待完成，暂保留 39/40。 [320 像素基线](/tmp/openbot-device-review/routines-builtin-baseline.log) · [定向测试](/tmp/openbot-device-review/routines-builtin-tests-final.log) · [最新构建](/tmp/openbot-device-review/connections-final-build.log)

## 凭据替换返回复评

`/admin/credentials` 与 `/settings/credentials` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H3 加 1 分。替换成功后按服务端返回的新记录 ID 聚焦新生效的条目，滚动使整行可见，回执显示在对应行。目标缺失时聚焦页面标题并保留回执。

生产构建 `index-8N-NkAXW.js` 在 Chromium 和 WebKit 的 1440、390、320 像素验证返回焦点、回执可见和单次提交，并通过缺失目标回退及 Astryx 构建诊断。真实凭据使用方、实体触屏与读屏待验。 [基线](/tmp/openbot-device-review/credential-return-baseline.log) · [生产 Chromium](/tmp/openbot-device-review/credential-return-production-chromium.log) · [生产 WebKit](/tmp/openbot-device-review/credential-return-production-webkit.log) · [目标不存在](/tmp/openbot-device-review/credential-return-production-fallback.log) · [320 像素画面](/tmp/openbot-device-review/credential-return-320.png)

## 边界生效模式复评

`/admin/boundaries` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H4 加 1 分。Enforcement 移到规则清单上方。320 像素下，已有 24 条规则时 Trial mode 开关的顶部位置从约 2122 降至 329 CSS 像素。生产构建 `index-8N-NkAXW.js` 在 Chromium 与 WebKit 的 1440、390、320 像素均验证了开关的可访问说明、取消零写入、确认携带原策略且仅写入一次，以及搜索条件保留。17 项定向测试通过。真实策略生效及读屏待验。 [基线](/tmp/openbot-device-review/boundary-mode-baseline.log) · [生产 Chromium](/tmp/openbot-device-review/boundary-mode-production-chromium.log) · [生产 WebKit](/tmp/openbot-device-review/boundary-mode-production-webkit.log) · [320 像素画面](/tmp/openbot-device-review/boundary-mode-320.png) · [定向测试](/tmp/openbot-device-review/boundary-mode-tests.log)

## 插件搜索命中复评

`/admin/plugins/` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H6 加 1 分。搜索结果行显示命中的前三个工具和其余命中数量。只有查询依赖工具名称或描述时才显示该说明。320 像素下说明使用整行宽度。Enter 聚焦首个结果，跨工具词组仍能查找。

生产构建 `index-qN7wOXJz.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过六组模拟复验。41 项插件定向测试和 Astryx 构建诊断通过。真实工具目录、供应商授权及读屏待验。 [基线](/tmp/openbot-device-review/plugin-match-baseline.log) · [Chromium](/tmp/openbot-device-review/plugin-match-candidate-chromium.log) · [WebKit](/tmp/openbot-device-review/plugin-match-candidate-webkit.log) · [320 像素画面](/tmp/openbot-device-review/plugin-match-320.png) · [定向测试](/tmp/openbot-device-review/plugin-match-tests.log)

## 管理端学习审阅顺序复评

`/admin/learning` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H8 加 1 分。所选 Bot 的待审技能紧邻选择器，学习与投递状态在其后。320 像素 Chromium 中，首个待审技能由距顶部约 1174 移至 543 CSS 像素。生产构建 `index-qN7wOXJz.js` 在 Chromium 与 WebKit 三种宽度验证切换 Bot 和状态刷新。真实后端与读屏待验。 [基线](/tmp/openbot-device-review/learning-layout-baseline.log) · [Chromium](/tmp/openbot-device-review/learning-layout-candidate-chromium.log) · [WebKit](/tmp/openbot-device-review/learning-layout-candidate-webkit.log)

## 学习分享范围复评

`/settings/learning` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。选择分享范围前说明本人批准的技能仍需管理员批准才能共享。全量分享和逐项分享的说明均体现此限制，待批技能保留当前使用范围。生产构建 `index-qN7wOXJz.js` 在 Chromium 与 WebKit 三种宽度验证提示、待批准的范围及键盘切换。真实管理员批准与读屏待验。 [基线](/tmp/openbot-device-review/learning-scope-baseline.log) · [Chromium](/tmp/openbot-device-review/learning-scope-candidate-chromium.log) · [WebKit](/tmp/openbot-device-review/learning-scope-candidate-webkit.log)

## Setup 重查操作复评

`/settings/setup` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H4 加 1 分。Check again 采用描边次级按钮，触区由 28 增至 44 CSS 像素。生产构建 `index-qN7wOXJz.js` 在 Chromium 和 WebKit 的三种宽度验证键盘重查、失败保留上次结果和成功更新。21 项定向测试通过。真实部署重查和实体触屏、读屏待验。 [基线](/tmp/openbot-device-review/setup-check-baseline.log) · [Chromium](/tmp/openbot-device-review/setup-check-candidate-chromium.log) · [WebKit](/tmp/openbot-device-review/setup-check-candidate-webkit.log) · [定向测试](/tmp/openbot-device-review/setup-check-final-tests.log)

## GitHub 仓库重复请求复评

`/connections/github` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H5 加 1 分。创建已保存但响应断开时，重试原表单复用请求标识。Chromium 和 WebKit 在 1440、390、320 像素验证重试后只显示一个 webhook。隔离 PostgreSQL 上实测两次并发请求只创建一条绑定及一条凭据，账户之间隔离请求标识，同一账户不能用旧标识创建不同仓库。

界面使用生产构建 `index-Cfsc8lXi.js` 复验。10 项前端和签名定向测试、6 项 PostgreSQL 集成测试、Web 类型检查与 Astryx 构建诊断通过。真实 GitHub 投递和读屏待验。 [Chromium](/tmp/openbot-device-review/github-slack-prior-chromium.log) · [WebKit](/tmp/openbot-device-review/github-slack-prior-webkit.log) · [PostgreSQL](/tmp/openbot-device-review/github-db-memory-test.log)

## Slack 命令指引复评

`/connections/slack` 从 39/40 升至 **40/40（100%，暂定）**，H1–H10 均为 4。H2 加 1 分。连接弹窗说明在 Slack 给 OpenBot 应用发送私信，回到 Connections 检查是否连上。有效期来自服务端，过期停用复制按钮。复制失败聚焦并选中命令，弹窗只保留一个关闭控件。

生产构建 `index-Dw8NKdGL.js` 在 Chromium 和 WebKit 的 1440、390、320 像素验证命令、复制失败、到期、关闭和重新申请。真实 Slack 回调和读屏待验。 [Chromium](/tmp/openbot-device-review/github-slack-final-chromium.log) · [WebKit](/tmp/openbot-device-review/github-slack-final-webkit.log) · [320 像素弹窗](/tmp/openbot-device-review/slack-link-320.png)

## Routines 内置入口复评

`/connections/routines` 从 39/40 升至 **40/40（100%，暂定）**，H4 加 1 分。Connections 单列 Built-in tools。Routines 不计入外部应用数量，搜索后仍可走原地址。详情说明每个 Bot 都有此内置工具。读取失败沿用 Connections 的重试样式，恢复后聚焦页面标题。

同一生产构建在 Chromium、WebKit 的三种视口通过 Team 与 Personal 模拟复验，24 项定向测试、Web 类型检查、Impeccable 源码检测和 Astryx 构建诊断通过。真实调度和读屏待验。 [基线](/tmp/openbot-device-review/routines-builtin-baseline.log) · [Chromium](/tmp/openbot-device-review/routines-builtin-chromium.log) · [WebKit](/tmp/openbot-device-review/routines-builtin-webkit.log)

## 组件图库使用指引复评

`/settings/components-gallery/` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H10 加 1 分。搜索旁说明先打开组件查看名称，再请有权限的 Bot 在会话中展示它。生产构建 `index-B-8IqEyn.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。键盘可进入首个搜索结果，详情显示组件名称，返回后恢复筛选和条目焦点。5 项图库测试通过。真实 Bot 渲染和读屏待验。 [基线](/tmp/openbot-device-review/gallery-help-baseline.log) · [Chromium](/tmp/openbot-device-review/gallery-help-final-chromium.log) · [WebKit](/tmp/openbot-device-review/gallery-help-final-webkit.log) · [320 像素画面](/tmp/openbot-device-review/gallery-help-320.png)

## 单 Bot 首条消息恢复说明复评

`/channel/$channelId` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H2 加 1 分。提示区分尚未发送、等待 Bot 连接、核对是否到达和可以重发。核对按钮旁说明只读取会话，不发送新副本。可重发时说明沿用原消息。生产构建 `index-B-8IqEyn.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。验证历史读取失败仍能原位核对，安全重发复用原消息 ID。6 项直接会话测试通过。真实网关断线、系统剪贴板和读屏待验。 [基线](/tmp/openbot-device-review/first-message-recovery-baseline.log) · [Chromium](/tmp/openbot-device-review/first-message-recovery-final-chromium.log) · [WebKit](/tmp/openbot-device-review/first-message-recovery-final-webkit.log) · [320 像素画面](/tmp/openbot-device-review/first-message-recovery-320.png)

## Playground 发布重试复评

`/admin/playground` 从 39/40 升至 **40/40（100%，暂定）**。H1–H10 均为 4。H5 加 1 分。保存草稿成功后，发布重试复用相同的版本，服务端在发布事务中核对。其他管理员修改或删除草稿后，旧确认只能关闭并重新审阅。生产构建 `index-B-8IqEyn.js` 在 Chromium 和 WebKit 的 1440、390、320 像素通过模拟复验。隔离 PostgreSQL 上 44 项测试通过，覆盖同版本重试保持一个已发布修订、新草稿拒绝旧确认以及目标删除后的拒绝。真实部署中的多人操作和读屏待验。 [基线](/tmp/openbot-device-review/playground-publish-baseline.log) · [Chromium](/tmp/openbot-device-review/playground-publish-final-chromium.log) · [WebKit](/tmp/openbot-device-review/playground-publish-final-webkit.log) · [PostgreSQL](/tmp/openbot-device-review/playground-publication-db-tests.log) · [320 像素画面](/tmp/openbot-device-review/playground-publish-320.png)

## 首批整改复评

生产构建 `6a0756d3fca7205430e9aee37ca65a7d0142f8e2`，入口 `index-CczWRu6D.js`，`index.html` SHA-256 为 `bae59005486f5f956f8484c1d2bf28172b68564b6838141ba4797d6493de4a29`。截图和可访问性树按身份、宽度、主题及路径命名。通过 `scripts/browser-acceptance/first-batch.sh` 复跑。 [第一批验收记录](web-impeccable-batch-1.md#首批整改后复评)

### 设计判断

一名评审按 Nielsen 十项给出暂定分。依次为状态可见性、用户语言、控制与退出、一致性、防错、识别、效率、简洁、恢复和帮助。每项满分 4。「待」表示当前构建的任务证据不足，横线表示短时交接视图的效率项不适用。附录中的旧分保留历史来源。正式验收仍为 0/88。

| 页面 | 此前 | 本次 | H1–H10 | 构建 | 测试身份 | 截图文件 | 待验 |
|---|---|---|---|---|---|---|---|
| `/` | 40/40 | 33/40 | 3 4 3 4 3 4 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-home.png` | 首页区分直接起草与挑选 Bot。待验草稿恢复与真实发送。 |
| `/channel/new` | 40/40 | 34/40 | 3 4 3 4 4 4 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-channel-new.png` | To 与消息分组，选 Bot 前显示发送限制。待验有附件草稿的交接。 |
| `/start/$startId` | 36/36（100%，暂定） | 30/36 | 3 4 4 3 3 3 — 4 3 3 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-start-fixture-start.png` | 无草稿时解释原浏览器条件，提供首页和新会话入口。待验有草稿的过渡与核对送达。 |
| `/channel/$channelId` | 40/40（100%，暂定） | 待验 | 待 待 待 待 待 待 待 待 待 待 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-channel-acceptance-plan.png` | 已捕获打开会话状态。待验消息历史、串流、审批与断线后的重复提交。 |
| `/group/$channelId` | 40/40（100%，暂定） | 待验 | 待 待 待 待 待 待 待 待 待 待 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-group-acceptance-plan.png` | 已捕获打开群聊状态。待验群聊消息和审批。停止入口已移除，待服务端支持安全停止。 |
| `/bot` | 40/40（100%，暂定） | 29/40 | 2 4 3 3 3 3 3 4 2 2 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-bot.png` | Bot 名称、私有范围和输入区可见。待验无 Conversation 的线程能否读取或执行。 |
| `/admin/people` | 40/40（100%，暂定） | 38/40 | 4 4 4 4 4 4 3 4 4 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-people.png` | 行内操作在窄屏收入菜单。已走键盘预览、取消回焦、成功、部分完成、冲突。待验真实角色和读屏。 |
| `/admin/identity-providers` | 40/40（100%，暂定） | 33/40 | 3 4 3 3 3 4 3 4 3 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-identity-providers.png` | 注册列表与登录策略分组。待验真实 SSO 影响、断线后重新读取。 |
| `/admin/credentials` | 40/40（100%，暂定） | 34/40 | 3 4 3 4 3 4 3 4 3 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-credentials.png` | 凭据按用途展示。待验撤销影响、真实写入与审计。 |
| `/settings/credentials` | 40/40（100%，暂定） | 34/40 | 3 4 3 4 3 4 3 4 3 3 | `6a0756d3f` | 模拟 Personal | `*-settings-credentials.png` | 个人页使用 Keys 和用途说明。待验真实写入与撤销。 |
| `/admin/credentials/new` | 40/40（100%，暂定） | 35/40 | 3 4 4 4 3 4 3 4 2 4 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-credentials-new.png` | 字段说明区分用途、标识和秘密，Cancel 返回列表。待验替换和冲突后的焦点。 |
| `/settings/credentials/new` | 40/40（100%，暂定） | 35/40 | 3 4 4 4 3 4 3 4 2 4 | `6a0756d3f` | 模拟 Personal | `*-settings-credentials-new.png` | Add key 表单保留同一字段顺序与示例。待验替换成功及重复提交。 |
| `/settings/passwords` | 40/40（100%，暂定） | 32/40 | 3 4 3 4 3 3 3 4 2 3 | `6a0756d3f` | 模拟 Personal | `*-settings-passwords.png` | 说明已保存登录项和使用权限。待验有条目时的具名删除与恢复反馈。 |
| `/admin/skills` | 40/40（暂定） | 34/40 | 3 4 3 4 3 4 3 4 3 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-skills.png` | 清单把新建操作摆在标题旁。待验删除影响计数和 Bot 授权变化。 |
| `/settings/skills` | 40/40（暂定） | 34/40 | 3 4 3 4 3 4 3 4 3 3 | `6a0756d3f` | 模拟 Personal | `*-settings-skills.png` | 个人技能使用相同清单层级。待验删除有 Bot 授权的技能。 |
| `/admin/skills/$slug` | 40/40（100%，暂定） | 34/40 | 3 4 4 4 3 4 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-skills-fixture-skill.png` | 详情将 Bot 授权、内容字段和管理操作分区。待验真实授权编辑与删除。 |
| `/settings/skills/$slug` | 40/40（100%，暂定） | 34/40 | 3 4 4 4 3 4 3 4 2 3 | `6a0756d3f` | 模拟 Personal | `*-settings-skills-fixture-skill.png` | 详情保留同样的字段顺序及返回入口。待验保存失败、离开和删除。 |
| `/capabilities/skills` | 40/40（100%，暂定） | 33/40 | 3 4 3 4 3 4 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员、Personal | `*-capabilities-skills.png` | 页签保留个人技能目的和新建入口。待验编辑和已授权工具。 |
| `/capabilities/memory` | 40/40（100%，暂定） | 33/40 | 3 4 3 4 3 4 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-capabilities-memory.png` | 团队页说明记忆何时被 Bot 使用。待验长记忆、Forget、个人版回退。 |
| `/bots/$agentId/memory` | 40/40（100%，暂定） | 32/40 | 3 4 3 4 3 3 3 4 2 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-bots-whatif-sales-memory.png` | 团队页保留 Bot 上下文与来源入口。待验部分失败、可重试及副本退役。 |
| `/admin/permissions` | 40/40（100%，暂定） | 32/40 | 3 4 3 4 3 3 3 3 3 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-permissions.png` | 成员查询与部署默认值分区。待验并发保存、409 后恢复和 Audit。 |
| `/admin/audit` | 40/40（100%，暂定） | 32/40 | 3 4 3 3 3 4 3 3 3 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-audit.png` | 判定和行上下文可读取，设置读取失败可独立重试。待验真实写入对应的事件。 |
| `/admin/components/$name` | 40/40（100%，暂定） | 31/40 | 3 3 4 4 3 3 3 3 2 3 | `6a0756d3f` | 模拟 Team 管理员 | `*-admin-components-chat.png` | 详情保留返回入口。待验发布、拒绝和审计状态。 |

## #189 Tasks 与 Ideas 独立复评

设计评分与自动检测由两个独立评审完成。以下为修复前的暂定分，使用 `bbbbe63fa` 的隔离 Personal 首屏及已归档的重试、来源跳转和 Orca 流程。

| 视图 | H1–H10 | 暂定分 | 设计判断 |
|---|---|---:|---|
| `/tasks` | 3 3 2 3 2 3 2 3 3 2 | 26/40 | 320 CSS 像素下审批重试标签截断。Mark done 会立即把任务移出当前列表，恢复入口在 Resolved。待复评完成回执、撤销可见性和清单效率。 |
| `/ideas` | 3 3 3 3 3 3 3 3 3 3 | 30/40 | Bot 范围和忽略后果清楚。Orca 在建议读取失败时重复播报，重试后焦点回到建议标题。待复评术语一致性和有建议时的完整操作。 |

自动检测在两个视图的源码和 8 个桌面、窄屏、浅深主题首屏样本中报告 0 项。该检测范围为默认隔离状态，故障状态的截断由设计评审发现。缩短审批重试标签后，Chromium 和 WebKit 在三种宽度和浅深主题下通过 12 次复验，完整标签均可显示，键盘仍分别重试对应请求。修复后的独立评分和真实服务流程仍待验。 [自动检测](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-detector.O96dPs) · [窄屏修复复验](/Users/wuyj/.local/state/openbot-spec-127/evidence/tasks-retry-label.10gpsL/run.json)

### Learning、Check-ins 与 Playground 独立复评

设计与自动检测由两个独立评审完成。下列分数来自修改前的隔离构建，保持暂定。

| 视图 | 构建 | 测试身份 | H1–H10 | 暂定分 | 设计判断 |
|---|---|---|---|---:|---|
| `/admin/learning` | `e9fa68221` | Team 管理员 | 3 2 3 3 3 2 3 3 3 3 | 28/40 | 读失败保留配置草稿并暂停提交。空状态要求到 Participation 选择容器，缺少直达入口。 |
| `/admin/proactive` | `e9fa68221` | Team 管理员 | 3 3 3 2 3 3 3 3 3 3 | 29/40 | 错误时保留每日上限。背景页面和弹窗同时出现重试提示，窄屏弹窗的横排提示换行拥挤。 |
| `/admin/playground` | `e9fa68221` | Team 管理员 | 2 3 3 3 3 3 3 3 4 3 | 30/40 | 恢复路径复用草稿版本。旧列表把「仅草稿」和「发布后有改动」同时用于未发布的组件。 |

独立自动检测覆盖 40 个 Chromium 场景，包括桌面和窄屏、浅色和深色及读取、写入恢复。检测器报告 48 次小字、12 次长行及 20 次嵌套卡片提示，以及 16 次窄屏孤词提示。有效复测未见页面异常或横向溢出。真实发布交付和三页的读屏仍待补证。 [Learning 与 Check-ins](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-detector-recovery.uGkN1U/settings/scans.json) · [Playground](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-detector-recovery.uGkN1U/playground-clean/scans.json)

### Tasks 完成与重试复评

| 视图 | 构建 | 测试身份 | H1–H10 | 暂定分 | 设计判断 |
|---|---|---|---|---:|---|
| `/tasks` | `e32e29d13` | 隔离 Personal | 3 2 3 3 3 3 2 3 3 3 | 28/40 | 完成确认解释了七天内可重新打开任务，取消恢复原焦点，写入失败可重试。简体中文引导中的「已解决」与页面上的 Resolved 不一致。跨状态搜索和实机读屏播报仍待验。 |

独立自动检测覆盖同一构建的 16 个 Chromium 样本，包括桌面与窄屏、浅色与深色，以及有任务、审批重试、完成确认和提交重试。任务元信息出现 8 次小字号警告，桌面浅色有 4 次嵌套卡片提示，窄屏有 10 次孤词提示。源码检测为 0 项，页面异常为 0。 [自动检测原始记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-detector-main.XHTQ59/run.json) · [完成流程证据](/Users/wuyj/.local/state/openbot-spec-127/evidence/web127-main-e32e29d.oysADh/tasks/run.json)

### Ideas 有建议时的独立复评

| 视图 | 构建 | 测试身份 | H1–H10 | 暂定分 | 设计判断 |
|---|---|---|---|---:|---|
| `/ideas` | `23c9dcfed` | 隔离 Personal | 2 3 3 3 3 3 3 3 3 3 | 29/40 | 忽略会解释 30 天影响，取消后复位焦点，提交失败可重试。开始处理时按钮禁用，成功后原先没有回执或直达任务入口。 |

独立自动检测在 390 和 1440 CSS 像素的浅深主题下检查了 16 个 Chromium 场景，包含有建议、忽略确认、忽略重试和启动中。源码检测为 0 项，浏览器检测的 4 项均为桌面浅色嵌套卡片提示，尚未复现具体影响。16 个场景均无页面异常和文档横向溢出。 [自动检测](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-detector-ideas.VEapuq/run.json) · [开始处理记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-ideas-start.AzyjhL/run.json) · [忽略记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-ideas-populated.vhs6LC/run.json)

### Admin 概览、Audit 与 Providers 独立复评

两位独立评审分别执行设计判断和自动检测。以下为修复前暂定分。

| 视图 | 构建 | 测试身份 | H1–H10 | 暂定分 | 设计判断 |
|---|---|---|---|---:|---|
| `/admin/` | `2eff44601` | 隔离 Team 管理员 | 3 3 3 3 3 2 3 3 3 3 | 29/40 | 任务词搜索和返回焦点通过。默认页先显示静态导航分类，常用任务和待处理事项尚未置顶。 |
| `/admin/audit` | `c9265edbc`、`2eff44601` | 隔离 Team 管理员及降权后的成员 | 3 3 3 3 3 3 3 3 4 3 | 31/40 | 搜索和 CSV 说明范围，Why? 区分历史决定与当前策略。真实 Keycloak 登录后的降权清除已加载记录。 |
| `/admin/providers` | `2eff44601` | 隔离 Team 管理员 | 2 2 3 3 3 3 3 3 3 3 | 28/40 | 保存失败保留选项；读取失败文案没有点明受影响的区域。手动输入模型 ID 缺少就近示例。 |

独立自动检测覆盖 44 个 Chromium 状态样本，含桌面和窄屏、浅色和深色、读取失败与恢复。未检测到页面异常。检测器报告 15 项嵌套卡片提示、6 项窄屏孤词提示，以及 Audit 浅色历史解释中的 2 项低对比度提示。正式验收仍为 0/88。 [概览检测](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-detector.LUZvII/overview/scans.json) · [Audit 检测](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-detector.LUZvII/audit/scans.json) · [Providers 检测](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-detector.LUZvII/providers/scans.json)

### #192 Settings 独立复评

| 视图 | H1–H10 | 暂定分 | 主要发现 |
| --- | --- | --- | --- |
| Notifications | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3 | 31/40 | 失败行可重试，保留同时更新的其他渠道；窄屏的说明和开关行较长。 |
| Learning | 3 · 2 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 2 | 28/40 | 重试后焦点回到 Conversation Learning；无记录时缺少如何开始第一条 Learning 会话的说明。 |
| General | 3 · 3 · 3 · 3 · 3 · 3 · 3 · 3 · 4 · 3 | 31/40 | 读取失败时隐藏保存，恢复后回到编辑框；消息列表预览时间戳对比度不足。 |
| Setup | 3 · 3 · 3 · 2 · 3 · 3 · 3 · 3 · 3 · 3 | 29/40 | 清单读取失败可原位恢复；重新读取和主动诊断共用 Check again 文案。 |

独立自动检测包含 Chromium 在 390×844 和 1440×900、浅色和深色下的 44 个状态。没有页面脚本错误。检测共报 116 条警告，包括 80 条小字号、24 条嵌套容器，以及同一个 General 预览时间戳在不同状态重复出现的 12 条低对比度警告。时间戳整改前的对比度为浅色 2.8:1、深色 3.9:1。四个视图均有隔离的浏览器键盘和 Firefox ESR + Orca 读取恢复记录。

移除共享会话行时间戳的半透明前景后，General 预览在 Chromium 和 WebKit 的两种尺寸及主题共八组均达到 4.5:1。实测浅色为 5.04:1，深色为 7.02:1。表中仍保留独立评审原始分数。
