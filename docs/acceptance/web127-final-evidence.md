# #194 最终验收台账

正式验收 **0/88**。历史迁移汇总记录为 88/88 暂定达标（86 项 40/40、两项 36/36）。#182 的抽查分数保留原构建来源。以下 88 项和两项共享恢复视图登记本轮证据与待验状态。

## 构建与证据

浏览器使用 `2f0692e69f2e6f06578a398d711d1199ecad0972` 的 Web 源码和入口 `index-CczWRu6D.js`。入口 HTML 的 SHA-256 为 `bae59005486f5f956f8484c1d2bf28172b68564b6838141ba4797d6493de4a29`，1,535 个归档文件与 #182 的对应文件哈希一致。#194 的应用运行时代码改动在服务端偏好写入和共享类型边界。浏览器访问独立回环模拟接口，PostgreSQL 兼容读取另行验证。

每行的 `view-N` 是截图、可访问性树和流程 JSON 的文件名前缀。身份均为模拟。视口为 1440×900 和 390×844，各覆盖浅色与深色。原始产物位于 `~/.local/state/openbot-spec-127/evidence/t194/`。逐页截图在 `sweep-retry/captures/`，逐个样本的 URL、身份、主题、首个 Tab 焦点、控制台和 API 状态在 `sweep-retry/run.json`。路由清单和捕获工具随仓库提供。 [路由清单](web127-views.json) [捕获工具](../../scripts/browser-acceptance/full-sweep.mjs)

浏览器记录 360/360 张逐页截图，0 个文档级横向溢出样本，4 个含页面异常的样本，360 个含控制台警告或错误的样本。356 个样本访问了未实现的模拟接口。组件目录、已发布组件和 CopilotKit 的共用首载接口在 356 个样本中返回 501。任务、Routines、Goals 等页面还有各自的读取缺口。固定 ID 或权限守卫可以导致缺失、空态或回退，表中标注实际采集结果。Admin Playground 的 iframe 异常单独登记。

## 合入主线后复验

对合入主线的 `87e7b5876` 重建 Web。两轮逐页走查共用该产物，入口 HTML 的 SHA-256 为 `0fd07448b67a1806cd7c4f44d444fb04ad6ef8fb174333da0b3e6dcada68cc95`。原始产物在 `~/.local/state/openbot-spec-127/evidence/current-87e7b5876.OLJTNv/`。两轮各自的 `run.json` 位于 `baseline/` 和 `fixed-roster/`。

模拟服务补齐组件目录登记、已发布组件列表及 CopilotKit 的两个启动入口。运行时发现使用 fixture 已有的 Bot。两轮各采集 360 个页面样本，书签目的地均为 63/63，文档级横向溢出均为 0。四个共用启动请求的 501 从 1,424 次降至 0。含任意 501 的页面样本从 356 个降至 216 个。剩余缺口包括 Bot 提醒、Browser、连接及会话历史接口。Playground 沙箱仍有四个 Service Worker 异常。

基线的第一批模拟验收记录覆盖 129 个样本，People 的四种视口和主题组合均跑过确认流程。当前构建的会话、书签、导航和偏好定向测试 129 项通过，隔离 PostgreSQL 的 People、身份提供者、凭据和偏好集成测试另有 34 项通过。正式验收维持 0/88。

Playground 异常来自 Playwright 的 Service Worker 拦截脚本。该脚本在不允许同源访问的 iframe 中读取 `navigator.serviceWorker`，Chromium 因而抛出异常。验收工具现在使用全新浏览器上下文，继续限制预览请求到本地测试站点，并检查未启用 Service Worker。设 `SWEEP_MODE=playground` 可单独复跑四种视口和主题组合，验证 iframe 中的示例实际渲染、沙箱权限和页面异常。对照结果在 `~/.local/state/openbot-spec-127/evidence/playground.pGSThR/`，旧配置四个样本均有异常，修复后四个均通过。

集成提交 `954600c7a` 补齐剩余模拟端点后，使用同一个 `87e7b5876` 生产构建复跑全量。360 个页面样本完成采集，63 个书签均匹配目的地，API 501、页面异常和文档级横向溢出均为 0。四个 Playground 样本均通过预览和沙箱检查。未登录样本的 `GET /api/me` 按预期返回 401。接口和 Playground 的 24 项定向测试通过。证据在 `~/.local/state/openbot-spec-127/evidence/full-fixture.R4ZED5/` 的 `summary.json` 和 `sweep/run.json`。全量走查现在对遇到的 501 直接报错。真实环境验收按要求挂起，正式验收维持 0/88。

## 路由恢复构建的文字对比抽样

构建 `11314d882` 的 423 个 Chromium 样本通过全量走查。脚本记录了可测量的可见告警与链接文字。暗色 1,040 次测量的最低对比度为 6.37:1，浅色最低为 5.58:1。测量限于前景和最近的纯色不透明背景，排除透明文字、渐变和叠层。原始数值位于 `~/.local/state/openbot-spec-127/evidence/route-recovery.cRo2UM/full-contrast/run.json`。正式独立评分仍待验。

## 2026-11-28 Chromium 全量复跑

Web 构建提交为 `ccca02100ed6f9eb68321eb03541053553c04449`，入口 HTML 的 SHA-256 为 `eb353cf054f1bb1c114cfc7e3013ef160ec4d60a445102af1fd5cbc266726dae`。首次走查发现模拟 API 缺少 `GET /api/computers/pilot`。补齐未启用时的 `{ lifecycle: null }` 响应后，用同一构建重跑。360 个页面样本和 63 个书签组合均完成，页面异常、文档级横向溢出、未实现接口和目的地不匹配均为 0。原始矩阵和截图位于 `~/.local/state/openbot-spec-127/evidence/current-acceptance.z62MJZ/full-sweep-pilot/`。

可访问性快照另发现，Bot 档案和 Admin Check-ins 各有四个样本落入路由错误边界。模拟的 Bot 工具授权和企业设置响应补齐后，八个样本均渲染了预期标题和内容。用同一归档构建复跑的 423 个样本通过新增的渲染异常检查，刻意模拟路由加载故障的样本仍保留。复验记录在同一目录的 `full-sweep-render-verified/run.json`。

本轮使用本地隔离模拟 API。逐页真实任务与独立评分仍待验，正式验收维持 0/88。

### 主线生产构建走查

Chromium 使用主线 `bbbbe63fa` 的生产构建和隔离 API，完成 360 个页面样本和 63 个书签样本。页面样本包括 88 个正式视图和两个共享恢复视图，覆盖桌面、窄屏和浅深主题。63 个书签都到达预期地址。页面异常、文档级横向溢出和未实现的模拟接口均为零。首次使用页按预期补上 `step=welcome`。本轮记录首屏与路由行为，完整任务和独立评分继续待验。 [构建清单](/Users/wuyj/.local/state/openbot-spec-127/evidence/current-main-web127.hjF9eT/manifest.json) · [走查汇总](/Users/wuyj/.local/state/openbot-spec-127/evidence/current-main-web127.hjF9eT/summary.json)

## 书签与退役

21 条书签 × Team 管理员、Team 成员、Personal 共 **63/63**，覆盖六个旧外观入口、Bot 参数、Personal Memory 回退和两个回调参数。两条 Connections 回调在页面消费参数之前经过带参数的目标地址，浏览器历史保存在 `bookmark-history/run.json`。未知 `/s/*` 进入共享恢复页。组件测试另覆盖模拟登录返回和角色变化。 [书签合同](web127-bookmarks.json)

六条旧外观路径在 Team 管理员、Team 成员和 Personal 下共 18 次跳转均匹配。Memory 保留按角色回退，Ideas、Goals 和 Activity 保留 Bot 参数。书签、主题与偏好定向测试共 123 项通过，其中包括隔离 PostgreSQL 对旧偏好记录的兼容读取。 [六条路径矩阵](/Users/wuyj/.local/state/openbot-spec-127/evidence/current-main-web127.hjF9eT/legacy-six-route-matrix.json) · [定向测试](/Users/wuyj/.local/state/openbot-spec-127/evidence/current-main-web127.hjF9eT/legacy-retirement-tests.log)

`PATCH /api/settings/preferences` 只接受 `openbot` 作为 skin。退役值返回 400，混合请求中的其他变更也不生效。既有 PostgreSQL 行即使存有 `openduet`，读出和更新其他偏好后的响应均为 `openbot`，数据库继续保留兼容值。

#193 使用构建提交 `ccca02100` 复跑了旧书签、登录回跳和认证客户端测试，共 126 项通过。模拟 Team 成员从 `/s/goals?agent=expenses` 发起登录后，目标路径仍保留原地址。恢复已登录会话后，路由到达 `/responsibilities?agent=expenses&view=goals`。隔离 OIDC 复验使用构建 `a692a090c`、本机 Keycloak 26.4.7 和 PostgreSQL，经过 OpenBot 的真实授权码回调，保留 `agent=expenses` 并进入 Goals。在同一会话内将测试账号从管理员降为成员后，`/api/me` 返回成员，重新打开 `/admin/plugins/parallel` 回到首页。记录与截图位于 `~/.local/state/openbot-spec-127/evidence/group-acceptance.2OHO1J/bookmarks-oidc/`。 [书签测试](../../app/tests/legacy-bookmarks.test.tsx) [登录回跳测试](../../app/tests/sign-resume.test.tsx)

## #184 首次使用与交还复验

Chromium 和 WebKit 各验证了首次使用的进度保存、完成保存与预约回退。测试覆盖 320、390、1440 CSS 像素与低动态模式。进度写入返回 503 后，键盘重试保存当前步骤，重新打开无步骤参数的地址仍回到该步骤。完成写入返回 503 后，键盘重试进入工作区。模拟离线时，预约入口提示日历不可用，并发出在新标签页打开预约入口的请求。测试捕获了该跳转，真实预约待验。 [流程与构建索引](/Users/wuyj/.local/state/openbot-spec-127/evidence/web184-onboarding-recovery.md)

桌面交还的模拟连接确认从 503 恢复后，Firefox ESR 的焦点回到桌面入口，Orca 读出了链接。为 Bot 登录网站的四个隔离浏览器场景验证了读取重试恢复焦点，以及请求过期后移除表单。真实请求投递、验证码与桌面协议端到端流程仍待复验。 [桌面交还读屏](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-desktop-return.VQNRGK) · [为 Bot 登录网站记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/website-sign-in-main.GnnhT1/evidence/run.json)

## 设计判断

`design.md` 记录一名评审对两项共享恢复画面的 H1–H10 观察。两个画面分别展示地址失效和页面加载失败，首要动作与焦点环可见。完整任务状态与第二名独立评审仍待验证。表中「待」代表当前构建缺少可打分的完整任务证据。「–」表示 H7 效率项按既有口径不适用。

## 自动检测

- Impeccable 扫描 `app/src`，在 `detector.json` 报告两条 Inter 字体警告和一条头像弹跳提示。全站共用主题字体关联全部视图，生成界面字体和头像动效关联会话与 Browser。源码发现保留在检测记录，待独立评审确认其产品影响。
- `shells-final/run.json` 记录工作区、Admin 和 Settings 的窄屏抽屉流程，浅暗合计 6/6 次 Escape 关闭后回焦。共 128 条实色对比样本，其中 4 条告警最低 8.67∶1，124 条链接最低 16.53∶1。半透明和叠层背景、其余页面的告警、完整读错回归继续待验。
- Astryx 构建检测 4 项通过，0 警告，0 失败。#194 定向回归通过。集成全套记录在 wave-2 基线 `6a0756d3f`，尾分片仍有 6 项失败。#194 的独立 fixture 范围内以定向结果为准。
- Playground 首轮在部分单元捕获到沙箱 iframe 的存储或 Service Worker 异常。复测将主题初始化限制在顶层文档，本地存储异常消失，四个单元仍有 Service Worker 异常。成功发布与真实组件加载仍需适用环境。

构建 `ccca02100` 的 #183 Chromium 复验记录了 28 个共享布局与恢复页样本。工作区、Admin 和 Settings 在 390×844 的浅色与深色下都能用 Escape 关闭抽屉，焦点返回原按钮，共六组。页面异常和文档级横向溢出均为 0。49 项导航定向测试在 15 秒超时下全部通过。首次与浏览器走查并行执行时，有三项达到默认 5 秒超时。原始矩阵见 `~/.local/state/openbot-spec-127/evidence/current-acceptance.z62MJZ/shells-pilot/run.json`。真实读屏仍待验。Settings 路由依赖恢复另见下文。

## 待验项目

| 项目 | 当前限制 | 所需环境 |
|---|---|---|
| 三类真实角色、权限降低、登录回跳、已有书签进入原任务 | 已在隔离 OpenBot、PostgreSQL 和 Keycloak 验证 Team 登录回跳和同会话降权，并验证 Team 两种角色及 Personal 的例行任务写入。其余任务仍以模拟身份为主 | 用三个角色逐条执行剩余任务，并验证适用的外部 OAuth 提供者 |
| 每个视图的适用默认、首载、空、失败、禁止、不可用及写入成功、取消、重试 | 本轮只采集首屏与一次 Tab。部分 API 缺失或模拟 ID 没有对应数据 | 为受影响路由补齐可控服务、失败注入、并发写入与有效记录，再逐页走查 |
| 回退目标与恢复操作 | Chromium 和 WebKit 已验证 Settings 路由依赖连续返回 HTTP 503 后恢复，保留原 URL 并将焦点移到标题。其余视图的返回和恢复仍待验 | 具有返回历史、离线和可控依赖中断的逐页流程 |
| Bot 流式回复、审批、A2UI 和发送幂等 | 会话仅有首屏或模拟反馈，#182 的组件证据仍有效 | 真实 Intelligence 网关、模型和可追踪执行记录 |
| 第三方连接、授权取消、真实预约和桌面交还 | 回环 fixture 拦截外部请求和协议调用 | Google、Microsoft、SSO、Composio、Calendly 与已安装的桌面应用 |
| 全量告警和 ReadError 对比度、非 Chromium 及主题变体 | 只采集 Chromium 和少量实色样本 | 可控错误状态、品牌配色、WebKit 与 Firefox |
| 读屏与实体触屏 | 可访问性树、单次 Tab 与抽屉键盘流程 | VoiceOver 与 Safari、NVDA 与 Firefox、实体手机与可用设备权限 |
| 两名评审独立复评分和完整生产回归 | 有限的设计观察与定向测试 | 完整任务 fixture、第二名独立评审和本构建 CI 五分片 |

### 补充流程证据

- Chromium 和 WebKit 在主线构建 `87bb5713a` 中验证相同的路由依赖故障。初次失败后无支持码，重试仍失败时显示 `WEB-ROUTE-ASSET`，服务恢复后保留原 URL 并聚焦 Notifications 标题。 [双浏览器记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/route-support-current.VJox3Z/evidence/run.json)
- 例行任务在独立 OpenBot API 和 PostgreSQL 中验证了三个角色的实际写入。Personal 管理员和两种 Team 角色分别收到一次 201，焦点回到列表标题，刷新后读回任务。Team 两条记录的所有者不同。 [Personal 记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-browser-db.Ik2oB2/run.json) · [Team 记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-team-browser.fydU7n/run.json)
- 治理页面在桌面、390 和 320 CSS 像素各复跑浅色和深色，使用模拟 API 验证边界读取重试、并发保存和 People 的键盘确认。另有 95 项 Web 与 PostgreSQL 测试通过。 [治理矩阵](/Users/wuyj/.local/state/openbot-spec-127/evidence/governance-320.q9hGHS/run.json)

- #187 在源码 `a0949919f` 上使用 Chromium headless shell 通过 9 项设备和凭据页面测试。测试覆盖两种部署版本及浅深外观、503 原位重试、403、操作触区和键盘流程。完整 Chromium 进程在本机提前退出，同一套测试改用 headless shell 后全部通过。另有 20 项本地 Computer 服务测试通过，覆盖浏览器进程替换后恢复登录、Recorder 和接管交还。两个 Google 外网场景跳过。原生桌面窗口和实体触屏仍待验。读屏补测见下一条。 [页面日志](/Users/wuyj/.local/state/openbot-spec-127/evidence/device-browser-regression.SUrH9v/device-pages.log) · [Computer 日志](/Users/wuyj/.local/state/openbot-spec-127/evidence/device-browser-regression.SUrH9v/computer-service.log)

- #187 在 Firefox ESR 与 Orca 中用隔离 API 复验五个设备视图的读取失败。按 Enter 原位重试后，Browser 回到 Teach a Bot 标题，Browsers 回到 Connected browsers，Personal 和 Team 的设备列表分别回到 Your Bots’ browsers 与 Computers in this deployment，Saved logins 回到页面标题。Saved logins 首轮缺少成功响应，启用空列表数据后复跑通过。原生设备、真实部署权限、实际扩展连接和独立评分仍待验。 [Browser](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-browser-status.QjO0OS) · [Browsers](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-connected-browsers.GvWD1n) · [设备列表](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-device-fleet.XeOs8s) · [Saved logins](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-saved-logins-restored.GbbQUL)

- #185 在 Web 构建 `87bb5713a` 的 390×844 Chromium 中使用本地 Keycloak 登录 Team 管理员和成员。独立 OpenBot API 创建双 Bot 群聊，成员加入前读取为 404。管理员在浏览器添加成员后，成员可读取群聊并看到两位 Bot 和两位成员。成员移除创建者被拒绝。管理员确认移除成员后，成员请求恢复为 404，重新打开只显示恢复入口。 [群聊权限记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/group-team-members.8gMLMu/run.json) · [构建清单](/Users/wuyj/.local/state/openbot-spec-127/evidence/group-team-members.8gMLMu/manifest.json)

使用构建 `9f72e8f5f` 的隔离 API，按 Personal 和 Team 的实际路由要求启用模拟 Arcade 或 Composio。四个目录入口各在桌面、窄屏及浅深两套主题组合复验，16 个样本均进入预期目录。修正后的全量走查仍有 360 个页面样本和 63 个书签样本，未检测到页面异常、文档级横向溢出或未实现的模拟端点。此轮证据覆盖路由和首屏。真实供应商授权和完整任务仍待验。目录读屏补测见下方。 [全量记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/full-broker-corrected.hcLqq1/run.json) · [目录采集修正 PR #261](https://github.com/1123786563/OpenBot/pull/261)

### #188 Memory 与 #190 供应商目录复验

在主线构建 `bbbbe63fa` 上，Memory 的模拟 403 隐藏新增入口。权限恢复后，键盘重试聚焦 Your memories，搜索与状态筛选可同时生效。Chromium 和 WebKit 共通过 12 个场景，覆盖三种宽度与浅深主题。另用 Orca 复验模拟 503 的重试焦点。Web 和隔离 PostgreSQL 定向回归 139 项通过，3 项自托管 Hindsight 测试跳过。 [权限与筛选场景](/Users/wuyj/.local/state/openbot-spec-127/evidence/memory-permission-browser.s3Ylzs/run.json) · [读屏](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-memory-recovery.3qUf8a) · [定向回归](/Users/wuyj/.local/state/openbot-spec-127/evidence/web188-current-regression.c8nOgF/results.log)

同一主线构建使用 Firefox ESR、Orca 和隔离 API 复验四个 Arcade 与 Composio 目录入口。Personal 和 Team 管理员收到模拟 503 时均可在原页重试。配置恢复后，焦点回到 Search apps。连接和授权定向回归共 125 项通过，覆盖 GitHub 添加中断后沿用请求标识以及 Arcade 连接与审计写入。真实供应商授权、真实 Bot 使用范围和独立评分仍待验。 [Personal 读屏](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-broker-directory.UReeeL) · [Team 读屏](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-admin-broker-directory.sZVzgc) · [连接回归](/Users/wuyj/.local/state/openbot-spec-127/evidence/web190-connection-regression.tT7XaJ/results.log)

### #180 审批有效期复验

主线 `e94fe7f4c` 合入后，在隔离 PostgreSQL 重跑四项测试。待批请求在 Run 仍进行时保留，不按经过时间过期。Run 完成、失败或停止后，迟到的审批无法继续该 Run。语音触发工具的审批通过后，原 Run 只续跑一次。以上使用测试模型和持久化数据库，真实供应商流式回复与审批续跑仍待验。 [实现 #271](https://github.com/1123786563/OpenBot/pull/271) · [定向复验日志](/Users/wuyj/.local/state/openbot-spec-127/evidence/web180-main-postgres.WpVvau/results.log)

### #189 工作视图复验

Firefox ESR 和 Orca 在 Personal 隔离环境中复验了 Tasks、Ideas、Goals、嵌入式 Routines 和 Activity 的读取失败与键盘重试。Goals 的首次复验发现焦点落在标题。用 `e644eb6ef` 加上 #263 的代码改动重新构建后，焦点回到 Bot 选择器。Ideas 建议读取恢复后聚焦建议区标题。Activity 恢复后聚焦进行中区块，Orca 依次读出三个空态。新建例行任务的调度控件读出了时区与夏令时说明。 [读屏证据索引](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-acceptance-audit.md) · [Goals 修复 #263](https://github.com/1123786563/OpenBot/pull/263)

Chromium 和 WebKit 在三种宽度及浅深主题下通过 12 个 Tasks 并发失败场景。任务与审批各显示一个错误，键盘只重试对应请求，恢复后聚焦任务状态筛选器。两种浏览器也验证了任务和例行任务历史的来源链接。Goals 的 Bot 选择器和导航至少相隔 16 CSS 像素。新建表单实测的四个控件均达到 44 × 44 CSS 像素。这些浏览器场景使用隔离模拟 API。真实角色的保存记录见上方例行任务条目。独立评分仍待完成。 [Chromium 并发恢复](/Users/wuyj/.local/state/openbot-spec-127/evidence/tasks-concurrent-themed.XCD3BY/run.json) · [WebKit 并发恢复](/Users/wuyj/.local/state/openbot-spec-127/evidence/tasks-concurrent-webkit-en.1nHRMf/run.json) · [布局与触区](/Users/wuyj/.local/state/openbot-spec-127/evidence/routine-targets.0ljWZC/run.json)

在候选构建 `36b040e89` 上，Personal 用户用 macOS 27.2.1 与 Safari 27.2 复验 Tasks 的读取恢复。VoiceOver 开启期间，Option-Tab 到达无障碍按钮「重新加载任务」。按 Enter 后，隔离 API 由 503 恢复为 200，焦点回到 `Task status` 组合框。验收后已确认 VoiceOver 关闭。记录包含 Safari 无障碍焦点和 HTTP 请求，语音播报仍待验。 [实机记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/safari-tasks.k877fJ/README.md)

同一构建下，320 CSS 像素的 Chromium 英语和 WebKit 简体中文场景验证了「标记为完成」的初始焦点、Escape 取消后焦点回归、取消零写入，以及保存成功但响应丢失时只写入一次。 [浏览器记录](/Users/wuyj/.local/state/openbot-spec-127/evidence/web189-build.yWpzDB/run.json) · [实现 #273](https://github.com/1123786563/OpenBot/pull/273)

### #191 治理与 #192 Admin 复验

Firefox ESR 和 Orca 在主线构建 `bbbbe63fa` 的隔离 Team 环境验证了 People、Boundaries 和 Audit 的首次读取故障。按 Enter 原位重试后，焦点分别落在 Workspace access、Boundary rules 和 Refresh。另有 102 项治理回归通过。批量审批规则的 10 项定向测试在隔离 PostgreSQL 中验证了提交后丢失响应、同一标识重试和并发首次保存，规则与审计只写入一次。真实角色、真实模型和权限传播待验。 [治理证据索引](/Users/wuyj/.local/state/openbot-spec-127/evidence/web191-acceptance-audit.md) · [Audit 读屏](/Users/wuyj/.local/state/openbot-spec-127/evidence/orca-audit-refresh.lw0dv1)

同一构建的 Admin 概览在 Chromium 与 WebKit 通过 8 个键盘场景，覆盖桌面、窄屏、浅色和深色。搜索无结果时显示示例，Escape 清空，Enter 聚焦并打开 What if。返回后保留查询和结果焦点。另有 109 项 Web 与隔离 PostgreSQL 回归通过，覆盖 Audit 导出范围、Providers 保存失败、Learning 草稿和 Playground 焦点恢复。独立评分待完成。 [搜索场景](/Users/wuyj/.local/state/openbot-spec-127/evidence/admin-search-keyboard.Em4HO3/run.json) · [定向测试](/Users/wuyj/.local/state/openbot-spec-127/evidence/web192-admin-settings-regression.LKR4Wk/results.log)

## 逐页记录

| ID | 视图与路由 | 模拟身份 | 捕获与具体缺口 | H1–H10 | 满分 |
|---|---|---|---|---|---:|
| `view-1` | /sign · `/sign` | 未登录 | 4/4。首屏，待验完整任务状态 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-2` | /onboarding · `/onboarding` | Personal | 4/4 首屏。另验进度写入、完成写入和预约回退，真实预约待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-3` | /desktop-return · `/desktop-return` | Personal | 4/4 首屏。另验模拟确认失败后的读屏重试和桌面入口焦点 | 待 待 待 待 待 待 – 待 待 待 | 36 |
| `view-4` | /sign-in/$requestId · `/sign-in/$requestId` | Personal | 4/4 首屏。另验读失败恢复与过期表单清理，真实请求待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-5` | Home · `/` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-6` | New conversation · `/channel/new` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-7` | Start handoff · `/start/$startId` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 – 待 待 待 | 36 |
| `view-8` | Single-Bot conversation · `/channel/$channelId` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-9` | Group conversation · `/group/$channelId` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-10` | /bot · `/bot` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-11` | /browser · `/browser` | Personal | 4/4 首屏。另验状态读取失败后的键盘重试与标题焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-12` | Bots list · `/bots` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-13` | Create Bot · `/bots?new=true` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-14` | Bot profile · `/bots/$agentId` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-15` | Bot skills/access · `/bots/$agentId/access` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-16` | Bot activity · `/bots/$agentId/activity` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-17` | Bot approval rules · `/bots/$agentId/approvals` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-18` | Bot memory sources · `/bots/$agentId/memory` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-19` | Bot reach · `/bots/$agentId/reach` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-20` | Bot Goals · `/bots/$agentId/responsibilities` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-21` | Bot Routines · `/bots/$agentId/routines` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-22` | Bot setup · `/bots/$agentId/setup` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-23` | Bot sharing · `/bots/$agentId/sharing` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-24` | Skills · `/capabilities/skills` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-25` | Memory · `/capabilities/memory` | Team 管理员 | 4/4 首屏。另验模拟权限拒绝、读屏重试与组合筛选 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-26` | Routines · `/routines` | Personal | 4/4 首屏。另验历史来源跳转与嵌入视图重试。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-27` | New routine · `/routines/new` | Personal | 4/4 首屏。另验三种本地角色保存、调度读屏和触区。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-28` | Connections · `/connections` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-29` | Team app + grants · `/connections/$key` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-30` | Personal app · `/connections/$key (Personal)` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-31` | GitHub · `/connections/github` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-32` | Slack · `/connections/slack` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-33` | Routines connection · `/connections/routines` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-34` | Arcade directory · `/connections/browse/arcade` | Personal | 4/4 首屏。另验配置读取失败后的读屏重试与搜索焦点，真实授权待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-35` | Composio directory · `/connections/browse/composio` | Personal | 4/4 首屏。另验配置读取失败后的读屏重试与搜索焦点，真实授权待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-36` | /tasks · `/tasks` | Personal | 4/4 首屏。另验并发故障、键盘重试及源会话跳转。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-37` | /ideas · `/ideas` | Personal | 4/4 首屏。另验 Bot 列表与建议读取的读屏重试。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-38` | /responsibilities · `/responsibilities` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-39` | Goals view · `/responsibilities?view=goals` | Personal | 4/4 首屏。另验 Bot 选择器的间距与重试焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-40` | Activity · `/s/activity` | Personal | 4/4 首屏。另验读屏重试、焦点和三个空态。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-41` | Admin home · `/admin/` | Team 管理员 | 4/4 首屏。另验任务词搜索、空结果和返回时的键盘焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-42` | Admin approvals · `/admin/approvals` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-43` | Admin approval describe · `/admin/approvals/describe` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-44` | Admin approval guidance · `/admin/approvals/guidance` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-45` | Admin audit · `/admin/audit` | Team 管理员 | 4/4 首屏。另验隔离 Audit 读取失败后的读屏刷新。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-46` | Admin boundaries · `/admin/boundaries` | Team 管理员 | 4/4 首屏。另验隔离策略读取失败后的读屏重试。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-47` | Boundary detail · `/admin/boundaries/$index` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-48` | New boundary · `/admin/boundaries/new` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-49` | Admin components · `/admin/components/` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-50` | Component detail · `/admin/components/$name` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-51` | Admin computers · `/admin/computers` | Team 管理员 | 4/4 首屏。另验 Team 空设备列表的读屏重试与标题焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-52` | Admin credentials · `/admin/credentials` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-53` | New credential · `/admin/credentials/new` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-54` | Identity providers · `/admin/identity-providers` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-55` | Admin learning · `/admin/learning` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-56` | People · `/admin/people` | Team 管理员 | 4/4 首屏。另验 Team 管理员模拟列表重试与焦点恢复。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-57` | Permissions · `/admin/permissions` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-58` | Permissions describe · `/admin/permissions/describe` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-59` | Playground · `/admin/playground` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API。有页面异常 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-60` | Admin plugins · `/admin/plugins/` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-61` | Plugin detail · `/admin/plugins/$key` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-62` | Plugin Bot access · `/admin/plugins/$key/bots/$agentId` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-63` | Plugin tools · `/admin/plugins/$key/tools/$tool` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-64` | Arcade admin · `/admin/plugins/arcade` | Team 管理员 | 4/4 首屏。另验配置读取失败后的读屏重试与搜索焦点，真实授权待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-65` | Composio admin · `/admin/plugins/composio` | Team 管理员 | 4/4 首屏。另验配置读取失败后的读屏重试与搜索焦点，真实授权待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-66` | Admin proactive · `/admin/proactive` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-67` | Providers · `/admin/providers` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-68` | Admin skills · `/admin/skills` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-69` | Admin skill detail · `/admin/skills/$slug` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-70` | New skill · `/admin/skills/new` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-71` | What if · `/admin/what-if` | Team 管理员 | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-72` | Settings home · `/settings/` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-73` | Settings activity · `/settings/activity` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-74` | Settings approvals · `/settings/approvals` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-75` | Browsers · `/settings/browsers` | Personal | 4/4 首屏。另验已连接浏览器列表的读屏重试与标题焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-76` | Components gallery · `/settings/components-gallery/` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-77` | Component preview · `/settings/components-gallery/$name` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-78` | Settings computer · `/settings/computer` | Personal | 4/4 首屏。另验 Personal 空设备列表的读屏重试与标题焦点。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-79` | Settings credentials · `/settings/credentials` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-80` | New saved login · `/settings/credentials/new` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-81` | Settings learning · `/settings/learning` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-82` | Notifications · `/settings/notifications` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-83` | Passwords · `/settings/passwords` | Personal | 4/4 首屏。另验空列表读取失败与标题焦点恢复。独立评分待验 | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-84` | Setup · `/settings/setup` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-85` | Settings skills · `/settings/skills` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-86` | Settings skill detail · `/settings/skills/$slug` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-87` | New personal skill · `/settings/skills/new` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-88` | This computer · `/settings/this-computer` | Personal | 4/4。首屏，待验完整任务状态。含未实现的模拟 API | 待 待 待 待 待 待 待 待 待 待 | 40 |
| `view-89` | Unknown address · `shared recovery` | Personal | 4/4。未知地址画面，待验证站内返回与读屏。含未实现的模拟 API | 待 待 待 待 待 待 – 待 待 待 | 36 |
| `view-90` | Route load failure · `shared recovery` | Personal | 4/4。阻断 Settings 分块，待验证依赖恢复与重试。含未实现的模拟 API | 待 待 待 待 待 待 – 待 待 待 | 36 |
