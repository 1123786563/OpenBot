# 覆盖与设计自查

状态：设计文档与视觉索引检查完成，未实施生产 UI。

代码基点：`203d0f0244b2f898218fa12027089c631e8448d9`。页面事实读取当前工作区。

## 路由覆盖

- 87 个 createFileRoute 声明：76 个页面 + 4 个布局 + 7 个兼容跳转。
- 76 个唯一页面 ID，逐页说明和视觉索引共用 pages.json。
- 所有来源文件存在；兼容地址与共享可观测性组件已记录。

| 空间 | 页面数 |
| --- | --- |
| 日常工作区 | 28 |
| 个人设置 | 13 |
| 管理后台 | 29 |
| 独立流程 | 6 |

## 视觉索引验证

Chrome headless 本地文件，76 页面 × 2 主题 × 2 布局 = 304 次 DOM 渲染检查；无整页横向溢出、空预览、undefined 文本或运行时异常。

页面搜索、空间筛选、点击切换、完整索引恢复，以及加载/空/错误/权限状态示意通过。状态开关是示意能力，不模拟实际业务请求。

截图抽查：Bots 暗色、Craft 暗色、设置亮色、知识库窄屏；PNG 已打开检查。初轮发现索引 Grid 的自动最小宽度引发窄屏横溢，增加 grid item min-width:0 后复验通过。

证据：[browser-check.json](../../../.archive/runs/2026-10-20-workspace-redesign-b1/reviews/design/browser-check.json)。检查脚本通过独立 headless Chrome 与原生 CDP 执行，无新增项目依赖。

## 候选配色对比度

共 42 个指定色对，正文/辅助文字/语义文字目标 4.5:1、必要控件边界目标 3:1，全部达到目标。最小文字配对 4.87:1。

证据：[contrast.json](../../../.archive/runs/2026-10-20-workspace-redesign-b1/reviews/design/contrast.json)。不包含半透明叠色、实际字体渲染、所有交互态和生产 DOM；不能据此宣称全产品通过 WCAG 审核。

## 设计检测记录

静态检测退出码 2，唯一 finding 为 `overused-font`（Inter 常见字体，warning）。保留：项目已有 Inter + 中文回退字体是本方案明确继承的约束；本轮不为设计索引换字体。不存在其他检测项。原始结果：[design-detector.json](../../../.archive/runs/2026-10-20-workspace-redesign-b1/reviews/design/design-detector.json)。这项是有记录的取舍，不把检测称为全绿。

## 未执行/限制

- 未修改生产 UI，没有运行全应用测试、类型检查、构建或 OCR；本次不是实现交付。
- 未逐页连接后端验证业务态；浏览器检查范围仅为设计索引。
- 没有交付 76 张高保真独立截图：交付为逐页文字规格 + 模板级结构示意。
- 原图中的新 Logo/头像/文案仅为概念参考，既有品牌资产保留。
- 追加概念拼板的 imagegen 调用因网络错误失败，无新增生成图；保留先前已展示的参考图。


## 完整路由与设计项映射

| 路由 ID | 类型 | 页面设计 |
| --- | --- | --- |
| `/_authed/_app/agents/` | redirect | COMPAT |
| `/_authed/_app/approvals` | redirect | COMPAT |
| `/_authed/_app/bot` | page | P05 |
| `/_authed/_app/bots/$agentId/access` | page | P13 |
| `/_authed/_app/bots/$agentId/approvals` | page | P11 |
| `/_authed/_app/bots/$agentId/datasets` | page | P18 |
| `/_authed/_app/bots/$agentId/evaluations/$datasetId` | page | P20 |
| `/_authed/_app/bots/$agentId/evaluations/experiment-comparisons` | page | P22 |
| `/_authed/_app/bots/$agentId/evaluations/experiments/$experimentId/$executionId` | page | P21 |
| `/_authed/_app/bots/$agentId/evaluations` | page | P19 |
| `/_authed/_app/bots/$agentId/exports` | page | P23 |
| `/_authed/_app/bots/$agentId/` | page | P07 |
| `/_authed/_app/bots/$agentId/memory` | page | P10 |
| `/_authed/_app/bots/$agentId/reach` | page | P09 |
| `/_authed/_app/bots/$agentId/responsibilities` | page | P08 |
| `/_authed/_app/bots/$agentId/routines` | page | P12 |
| `/_authed/_app/bots/$agentId/runs/$bindingId` | page | P17 |
| `/_authed/_app/bots/$agentId/runs` | page | P16 |
| `/_authed/_app/bots/$agentId/setup` | page | P15 |
| `/_authed/_app/bots/$agentId/sharing` | page | P14 |
| `/_authed/_app/bots/` | page | P06 |
| `/_authed/_app/channel/$channelId` | page | P03 |
| `/_authed/_app/channel/new` | page | P02 |
| `/_authed/_app/craft/$sessionId` | page | P27 |
| `/_authed/_app/craft/` | page | P26 |
| `/_authed/_app/craft/tasks` | page | P28 |
| `/_authed/_app/group/$channelId` | page | P04 |
| `/_authed/_app/group/new` | redirect | COMPAT |
| `/_authed/_app/` | page | P01 |
| `/_authed/_app/memory` | redirect | COMPAT |
| `/_authed/_app/reachability` | redirect | COMPAT |
| `/_authed/_app/responsibilities` | redirect | COMPAT |
| `/_authed/_app/routines` | page | P25 |
| `/_authed/_app/skills` | page | P24 |
| `/_authed/_app/team-bots` | redirect | COMPAT |
| `/_authed/_app` | layout | SHELL |
| `/_authed/admin/ai-observability` | page | P70 |
| `/_authed/admin/approvals` | page | P48 |
| `/_authed/admin/audit` | page | P67 |
| `/_authed/admin/billing` | page | P65 |
| `/_authed/admin/bot-services` | page | P44 |
| `/_authed/admin/boundaries` | page | P47 |
| `/_authed/admin/components/$name` | page | P62 |
| `/_authed/admin/components/` | page | P61 |
| `/_authed/admin/computers` | page | P49 |
| `/_authed/admin/credentials` | page | P43 |
| `/_authed/admin/enterprise` | page | P68 |
| `/_authed/admin/gateway` | page | P45 |
| `/_authed/admin/identity-providers` | page | P66 |
| `/_authed/admin/` | page | P42 |
| `/_authed/admin/knowledge/$kbId` | page | P59 |
| `/_authed/admin/knowledge/` | page | P58 |
| `/_authed/admin/learning` | page | P60 |
| `/_authed/admin/market` | page | P57 |
| `/_authed/admin/model-catalog` | page | P46 |
| `/_authed/admin/observability` | page | P69 |
| `/_authed/admin/people` | page | P64 |
| `/_authed/admin/playground` | page | P63 |
| `/_authed/admin/plugins/$key` | page | P51 |
| `/_authed/admin/plugins/$key_/bots/$agentId` | page | P52 |
| `/_authed/admin/plugins/$key_/tools/$tool` | page | P53 |
| `/_authed/admin/plugins/composio` | page | P54 |
| `/_authed/admin/plugins/` | page | P50 |
| `/_authed/admin/plugins/open-connector` | page | P55 |
| `/_authed/admin` | layout | SHELL |
| `/_authed/admin/skills` | page | P56 |
| `/_authed/onboarding` | page | P72 |
| `/_authed/settings/approvals` | page | P31 |
| `/_authed/settings/components-gallery/$name` | page | P38 |
| `/_authed/settings/components-gallery/` | page | P37 |
| `/_authed/settings/connected-accounts/$key` | page | P34 |
| `/_authed/settings/connected-accounts/` | page | P33 |
| `/_authed/settings/` | page | P29 |
| `/_authed/settings/invoices` | page | P41 |
| `/_authed/settings/memory` | page | P32 |
| `/_authed/settings/model-access` | page | P35 |
| `/_authed/settings/notifications` | page | P30 |
| `/_authed/settings/orders` | page | P40 |
| `/_authed/settings/passwords` | page | P36 |
| `/_authed/settings` | layout | SHELL |
| `/_authed/settings/usage` | page | P39 |
| `/_authed/sign-in/$requestId` | page | P73 |
| `/_authed/tenant/channels` | page | P75 |
| `/_authed/tenant/selection` | page | P74 |
| `/_authed` | layout | SHELL |
| `/share/$token` | page | P76 |
| `/sign` | page | P71 |
