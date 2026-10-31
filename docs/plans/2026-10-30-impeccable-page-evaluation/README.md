# 全站逐页 Impeccable 基线评测流程

- 日期：2026-10-30
- 范围：`app/src/routes` 下全部 94 个唯一路由（别名去重后）
- 方法：`/impeccable critique` 逐页评测，**只诊断不修复**
- 产出：每页一行评分 + 问题清单；系统性缺陷聚类；修复批次建议

## 1. 目标与非目标

**目标**

- 每个路由都有结论：`scored`（已评分）/ `designed-unavailable`（本机设计内不可用）/ `blocked`（缺数据或实例，附原因）。
- 每页产出 Nielsen 10 项评分（0–4，不适用记 `n/a` 并按适用上限归一）、P0–P3 问题、证据截图。
- 跨页共现的问题聚成「系统性缺陷」，作为一次修复多处受益的候选。

**非目标**

- 不在本流程里改代码。修复走后续 `/impeccable polish` 批次。
- 不追求每页走完所有状态。正常态必查；空态/错误态/超长内容只在数据允许时抽查，并在 ledger 记「未覆盖」，不假装覆盖。
- 不改 DESIGN.md / PRODUCT.md（那是修复阶段或 `document` 的事）。

**完成定义**：ledger 中不再有 `pending`；汇总报告已落盘；top 修复批次已排序并映射到 impeccable 命令。

## 2. 前置环境（每批开始前核对一次）

| 项 | 核对方法 | 失败时 |
| --- | --- | --- |
| server | `curl -s localhost:3002/ready` 返回 `{"status":"ok","database":"up"}` | 按 `local-server-boot-recipe` 起 server，别重跑迁移之外的步骤 |
| 前端端口 | 依次试 `:8081` `/sign`（历史配方），再试 signals 报的 `:5173/:5174/:8080`；以能打开应用为准 | 记录实测端口到 ledger，不假设 |
| 登录态 | Better Auth 邮箱密码：`POST :3002/api/auth/sign-in/email` 拿 `better-auth.session_token`，在浏览器里 `document.cookie` 注入（见 `local-authed-debug-session`） | 未登录时页面一律跳 `/sign`，评分无效 |
| 实例 ID | 从列表页点进第一个真实实例，把 URL 记进 ledger | 无实例时记 `blocked: no instance`，不虚构 ID |

凭据与 session token 只在本机临时使用，用完清 cookie、`agent-browser close`；ledger 不写密码或 token。

## 3. 路由分批（9 批，共 94 个唯一路径）

别名只评一次：`/admin` 与 `/admin/`、`/settings` 与 `/settings/`、`/bots` 与 `/bots/`、`/craft` 与 `/craft/`、`/plugins` 与 `/plugins/` 等以无尾斜杠为准；`tenant/*` 与 `admin/*` 同源组件时，`tenant` 只当镜像抽查（评 1 页代表，其余标 `mirror-of`）。

| 批 | 主题 | 路径 |
| --- | --- | --- |
| B1 | 公开/认证 | `/sign`、`/sign-in/$requestId`、`/forgot-password`、`/reset-password`、`/verify-email`、`/accept-invitation`、`/share/$token`、`/onboarding` |
| B2 | 入口与主应用 | `/`、`/agents`、`/bots`、`/bot`、`/craft`、`/craft/tasks`、`/memory`、`/packages`、`/reachability`、`/responsibilities`、`/routines`、`/skills`、`/team-bots`、`/approvals` |
| B3 | Bot 详情 | `/bots/$agentId`、`.../setup`、`.../access`、`.../approvals`、`.../sharing`、`.../routines`、`.../responsibilities`、`.../reach`、`.../memory` |
| B4 | Bot 数据与运行 | `.../datasets`、`.../evaluations`、`.../evaluations/$datasetId`、`.../experiment-comparisons`、`.../experiments/$experimentId/$executionId`、`.../exports`、`.../runs`、`.../runs/$bindingId` |
| B5 | 会话与频道 | `/channel/new`、`/channel/$channelId`、`/group/new`、`/group/$channelId`、`/craft/$sessionId` |
| B6 | 设置 | `/settings`、`.../approvals`、`.../async-jobs`、`.../components-gallery`、`.../components-gallery/$name`、`.../connected-accounts`、`.../connected-accounts/$key`、`.../invoices`、`.../memory`、`.../model-access`、`.../notifications`、`.../orders`、`.../passwords`、`.../usage` |
| B7 | 管理 A | `/admin`、`.../ai-observability`、`.../approvals`、`.../audit`、`.../billing`、`.../bot-services`、`.../boundaries`、`.../computers`、`.../credentials`、`.../enterprise`、`.../gateway`、`.../identity-providers`、`.../learning`、`.../market` |
| B8 | 管理 B | `.../model-catalog`、`.../observability`、`.../people`、`.../playground`、`.../plugins`、`.../plugins/$key`、`.../plugins/$key/bots/$agentId`、`.../plugins/$key/tools/$tool`、`.../plugins/composio`、`.../plugins/open-connector`、`.../skills`、`.../components`、`.../components/$name` |
| B9 | 组织与租户 | `/organization/$view`、`/tenant/admin`、`.../audit`、`.../billing`、`.../enterprise`、`.../learning`、`.../people`、`/tenant/channels`、`/tenant/selection` |

## 4. 每页标准操作（S.O.P.）

对每个路径，按顺序做完 6 步，缺一步视为未完成：

1. **定 target**：先解析源码文件（`app/src/routes/<对应文件>`），再确定实例 URL。impeccable 解析 target 时优先源码路径，浏览器证据用 URL。
2. **进页面**：注入登录态（受保护页），打开实例 URL。动态参数页用第 2 节记录的实例；没有实例就 `blocked`。
3. **抓证据**：桌面 1440 全页截图 + 移动 390 截图，存在 `.archive/runs/<run-key>/screenshots/<slug>/`。截图后先看一眼：空白/报错/半加载 → 记为 `blocked: capture invalid`，不得拿去评分。
4. **跑评测**：
   ```
   /impeccable critique app/src/routes/<文件>
   ```
   并在提示里附上：实例 URL、登录态说明、截图路径、页面用途一句话。
   critique 内部会起两个隔离子 agent（A 设计评审 / B 检测器+浏览器证据），**不要**在一个上下文里内联跑，否则报告首行必须是 `⚠️ DEGRADED`。
5. **落 ledger**：把评分与问题写进 ledger（字段见第 5 节），问题必须带类别标签，便于后续聚类。
6. **核对快照**：确认 `.impeccable/critique/` 下有该页快照（critique 自动写）；没有则记 `snapshot missing`，不阻塞。

**节奏**：批内逐页串行（critique 内部已并行）；不要两页同时跑，`live-server` 会互相踩。每批结束即写批报告并落盘，中断可从下一批续跑。

## 5. Ledger 字段（`.archive/runs/<run-key>/ledger.md`）

| 字段 | 说明 |
| --- | --- |
| batch / route / source | 批次、路由、源码文件 |
| instance | 实例 URL 或 `blocked` 原因（参数路由必填） |
| auth | `public` / `session` / `n/a` |
| shots | desktop / mobile 截图相对路径 |
| score / max | 总分与适用上限（有 n/a 时归一） |
| na | 记 n/a 的启发式编号 |
| p0 / p1 / p2 / p3 | 各severity 问题数 |
| top issues | ≤3 条，格式 `[类别] 问题 — 证据` |
| status | `scored` / `designed-unavailable` / `blocked` / `pending` |
| note | 证据、异常、镜像关系 |

问题类别固定为：`层级`、`对比`、`一致性`、`文案`、`状态`、`响应式`、`可访问性`、`认知负荷`。新增类别先改本文件，不临时发明。

## 6. 本机先验不可用清单（跑前核对，实测为准）

| 页面 | 先验状态 | 处理 |
| --- | --- | --- |
| `/admin/enterprise`、`/tenant/admin*` | 本机未配 `ENTERPRISE_*`，API 503 unavailable（设计内 fail-closed） | 标 `designed-unavailable`，只记录页面呈现的不可用态是否清楚 |
| `/memory`、`/settings/memory`、`/bots/$agentId/memory` | Hindsight 未挂载（404），页面为 orUnmounted 解释态 | 仍评设计，备注「未挂载态」 |
| `/admin/billing`、`/settings/invoices`、`/settings/orders` | 受 Lago 计费门禁/支付配置影响 | 实测；不可用即上表同法 |
| `/admin/gateway`、`/admin/computers`、`/admin/bot-services` | Bifrost/egress 依赖环境 | 实测；缺 readiness 记 `blocked: env` |

这些页面**不计入设计缺陷**，单独列；但「不可用态本身讲不清」属于设计问题，照常打分。

## 7. 汇总与排序

全部批次结束后：

1. **系统性缺陷**：同一类别 + 同一模式出现在 ≥3 页 → 单列一条，标注出现页数；不进单页修复清单。
2. **单页问题**：其余按 `P0 数 → P1 数 → 用户路径权重` 排序。权重：主应用/会话 3、设置 2、管理 1、租户镜像 0.5。
3. **修复批次建议**：top 10 映射到命令——层级/布局 → `layout`；字阶 → `typeset`；对比/用色 → `colorize`；文案/错误 → `clarify`；状态/边界 → `harden`；窄屏 → `adapt`；性能 → `optimize`；收口 → `polish`。
4. **未覆盖清单**：所有 `blocked` 与未抽查状态，逐条写原因。

**报告结构**（存 `.archive/runs/<run-key>/reviews/baseline-summary.md`）：

- 总览表（94 行，按批次分组）
- 系统性缺陷 Top N（含页数与代表证据）
- 单页 P0/P1 Top 20
- 设计内不可用清单
- 未覆盖清单
- 修复批次建议（命令 + 范围 + 预估页数）

## 8. 质量控制与退出

- `scored` 必须有 2 张有效截图 + 完整 10 项评分 + ≥1 条问题；缺任一 → 回退 `blocked`。
- 评分必须基于实测页面与截图，不凭代码或记忆。
- 同一页面重复跑只保留最新快照，ledger 记 run 序号。
- 单页 3 次尝试仍无法打开 → `blocked`，写清尝试过的 URL 与错误，继续下一页。
- 每批完成条件：该批所有路由状态非 `pending`，批报告已落盘。

## 9. 风险与已知局限

- **成本**：94 页 × 每页 critique（双 agent + 浏览器证据）≈ 8–20 小时 agent 时间；按批提交，可随时停。
- **同源镜像**：`tenant/*` 与 `admin/*`、`components-gallery` 与 `admin/components` 可能是同一组件，评分会重复；用 `mirror-of` 标注，不重复修复。
- **认证边界**：`/share/$token`、`/sign-in/$requestId` 需要有效 token/请求，拿不到就 `blocked`，不伪造。
- **本地环境**：企业面与 Hindsight 缺失会让部分页只能评「未挂载/不可用」态，结论上限写明。
- **快照位置**：impeccable 以 `app/` 为 cwd 写 `app/.impeccable/critique/`；这批快照是本流程的续跑依据，不要清理。