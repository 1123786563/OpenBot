# HeroUI 迁移 Issue 拆分

[父 Issue #443](https://github.com/1123786563/OpenBot/issues/443)。设计状态：待评审；当前已授权设计与建单，未授权实现。

本组为设计与排期拆分，尚未授权实施。默认采用主 Web 应用 app/、保留现有 WorkBuddy 视觉；不包含独立 desktop 引导程序、OpenMuse/Bifrost 子模块和 Craft 生成模板的迁移。用户如选择整体重设计或扩大范围，应先更新父方案。

保留 React/Vite/TanStack/CopilotKit 及业务 API；保留 PromptArea、Streamdown、Recharts、Embla、问卷/消息滚动的专用行为。不得改变权限、业务范围、付款账户、错误事实或数据协议。

正式实施按根 AGENTS：执行工作区与 BASE → writing-plans → SDD → 独立验证/Review → OCR → 必要修复与复审。没有提交授权时使用未提交增量检查点；不因缺少提交停滞。标签 ready-for-agent 不是实施授权；当前方案仍待评审，暂不添加此标签。

共享 UI、主题、布局、locale 和 lockfile 同一时刻只有一个写入者。默认串行执行；依赖已关闭仍须核验已审查代码集成与验收证据。涉及其他 Issue 所有权的修正，先记录共享 Interface 变更，不并行覆盖文件。


## 业务 Issue 与依赖

| ID | Issue / 交付 | depends_on | 父级验收 |
| --- | --- | --- | --- |
| [H01 #444](https://github.com/1123786563/OpenBot/issues/444) | 建立 UI 迁移基线并验证 HeroUI 关键交互兼容 | 无 | A01, A02, A04, A05, A09 |
| [H02 #445](https://github.com/1123786563/OpenBot/issues/445) | 让现有页面通过 HeroUI 基础控件保持主题与表单行为 | H01 | A01, A02, A05, A08, A09 |
| [H03 #446](https://github.com/1123786563/OpenBot/issues/446) | 完成模型访问授权与撤销的 HeroUI 业务试点 | H02 | A03, A04, A05, A07 |
| [H04 #447](https://github.com/1123786563/OpenBot/issues/447) | 迁移个人设置、连接管理与记忆维护流程 | H03 | A03, A04, A05, A07, A08 |
| [H05 #448](https://github.com/1123786563/OpenBot/issues/448) | 迁移模型目录、网关与凭据管理流程 | H03 | A03, A04, A05, A07 |
| [H06 #449](https://github.com/1123786563/OpenBot/issues/449) | 迁移 Bot、技能、知识库与日常任务管理流程 | H03 | A03, A04, A05, A07, A08 |
| [H07 #450](https://github.com/1123786563/OpenBot/issues/450) | 迁移公司成员、权限分享、审批与审计流程 | H03, H04, H06 | A03, A04, A05, A07, A08 |
| [H08 #451](https://github.com/1123786563/OpenBot/issues/451) | 迁移个人与公司积分、购买和订单记录流程 | H03 | A03, A04, A05, A07, A08 |
| [H09 #452](https://github.com/1123786563/OpenBot/issues/452) | 迁移登录、工作台导航和窄屏侧栏流程 | H03 | A02, A03, A04, A05, A07, A08 |
| [H10 #453](https://github.com/1123786563/OpenBot/issues/453) | 迁移聊天输入、消息动作与实时屏幕交互 | H03, H09 | A03, A04, A05, A06, A07, A08 |
| [H11 #454](https://github.com/1123786563/OpenBot/issues/454) | 迁移 Craft 工作区、预览和产物操作流程 | H10 | A03, A04, A06, A07, A08 |
| [H12 #455](https://github.com/1123786563/OpenBot/issues/455) | 迁移运行记录、评估对比与运维观测流程 | H03, H06 | A03, A04, A05, A07, A08, A09 |
| [H13 #456](https://github.com/1123786563/OpenBot/issues/456) | 迁移组件画廊与市场交互并保持生成内容适配 | H03 | A02, A03, A05, A07, A08 |
| [H14 #457](https://github.com/1123786563/OpenBot/issues/457) | 移除 Base UI 底座并核对完整迁移覆盖 | H04, H05, H06, H07, H08, H09, H10, H11, H12, H13 | A01, A02, A06, A09 |
| [H15 #458](https://github.com/1123786563/OpenBot/issues/458) | 完成全流程、可访问性与独立审查交付验收 | H14 | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10 |

## DAG 与排期
硬依赖：H01 → H02 → H03；H04/H05/H06/H08/H09/H13 消费 H03；H07 另消费 H04 的连接授权控件与 H06 的 Bot 详情壳；H10 消费 H09 的导航浮层；H11 消费 H10；H12 消费 H06；H14 汇合所有业务切片；H15 做完整交付验收。
建议默认串行顺序 H01–H15。它是避免共享文件/环境冲突的排期策略，未在 GitHub 中伪造顺序依赖。

静态覆盖：88 个路由文件、26 个公共 UI 文件、200 个组件 TSX 文件有唯一主归属；覆盖是规划归属，不是实现完成证明。新增文件必须在 H01/H14 重扫。

## 路由覆盖
| 路由文件 | 主 Issue |
| --- | --- |
| `app/src/routes/__root.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/routes/_authed/settings/model-access.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/routes/_authed/_app/bots.$agentId.memory.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/_app/bots.$agentId.reach.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/_app/memory.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/_app/reachability.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/$key.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/composio.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/index.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/plugins/open-connector.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/connected-accounts/$key.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/connected-accounts/index.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/index.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/memory.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/notifications.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/settings/passwords.tsx` | [H04 #447](https://github.com/1123786563/OpenBot/issues/447) |
| `app/src/routes/_authed/admin/bot-services.tsx` | [H05 #448](https://github.com/1123786563/OpenBot/issues/448) |
| `app/src/routes/_authed/admin/credentials.tsx` | [H05 #448](https://github.com/1123786563/OpenBot/issues/448) |
| `app/src/routes/_authed/admin/gateway.tsx` | [H05 #448](https://github.com/1123786563/OpenBot/issues/448) |
| `app/src/routes/_authed/admin/model-catalog.tsx` | [H05 #448](https://github.com/1123786563/OpenBot/issues/448) |
| `app/src/routes/_authed/_app/agents/index.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bot.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bots.$agentId.index.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bots.$agentId.routines.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bots.$agentId.setup.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/bots.index.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/responsibilities.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/routines.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/skills.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/team-bots.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/admin/knowledge.$kbId.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/admin/knowledge.index.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/admin/learning.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/admin/skills.tsx` | [H06 #449](https://github.com/1123786563/OpenBot/issues/449) |
| `app/src/routes/_authed/_app/approvals.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/_app/bots.$agentId.access.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/_app/bots.$agentId.approvals.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/_app/bots.$agentId.sharing.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/approvals.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/audit.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/boundaries.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/enterprise.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/identity-providers.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/people.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/settings/approvals.tsx` | [H07 #450](https://github.com/1123786563/OpenBot/issues/450) |
| `app/src/routes/_authed/admin/billing.tsx` | [H08 #451](https://github.com/1123786563/OpenBot/issues/451) |
| `app/src/routes/_authed/settings/invoices.tsx` | [H08 #451](https://github.com/1123786563/OpenBot/issues/451) |
| `app/src/routes/_authed/settings/orders.tsx` | [H08 #451](https://github.com/1123786563/OpenBot/issues/451) |
| `app/src/routes/_authed/settings/usage.tsx` | [H08 #451](https://github.com/1123786563/OpenBot/issues/451) |
| `app/src/routes/_authed/_app/index.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/_app.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/admin/index.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/admin/route.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/onboarding.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/settings/route.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/sign-in/$requestId.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/tenant/channels.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/tenant/selection.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/sign.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/routes/_authed/_app/channel/$channelId.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/routes/_authed/_app/channel/new.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/routes/_authed/_app/group/$channelId.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/routes/_authed/_app/group/new.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/routes/share.$token.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/routes/_authed/_app/craft/$sessionId.tsx` | [H11 #454](https://github.com/1123786563/OpenBot/issues/454) |
| `app/src/routes/_authed/_app/craft/index.tsx` | [H11 #454](https://github.com/1123786563/OpenBot/issues/454) |
| `app/src/routes/_authed/_app/craft/tasks.tsx` | [H11 #454](https://github.com/1123786563/OpenBot/issues/454) |
| `app/src/routes/_authed/_app/bots.$agentId.datasets.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.exports.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/_app/bots.$agentId.runs.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/admin/ai-observability.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/admin/computers.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/admin/observability.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/admin/playground.tsx` | [H12 #455](https://github.com/1123786563/OpenBot/issues/455) |
| `app/src/routes/_authed/admin/components/$name.tsx` | [H13 #456](https://github.com/1123786563/OpenBot/issues/456) |
| `app/src/routes/_authed/admin/components/index.tsx` | [H13 #456](https://github.com/1123786563/OpenBot/issues/456) |
| `app/src/routes/_authed/admin/market.tsx` | [H13 #456](https://github.com/1123786563/OpenBot/issues/456) |
| `app/src/routes/_authed/settings/components-gallery/$name.tsx` | [H13 #456](https://github.com/1123786563/OpenBot/issues/456) |
| `app/src/routes/_authed/settings/components-gallery/index.tsx` | [H13 #456](https://github.com/1123786563/OpenBot/issues/456) |

## 公共控件覆盖
| 文件 | 主 Issue |
| --- | --- |
| `app/src/components/ui/button.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/checkbox.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/empty.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/field.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/input-group.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/input.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/item.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/label.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/separator.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/skeleton.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/switch.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/textarea.tsx` | [H02 #445](https://github.com/1123786563/OpenBot/issues/445) |
| `app/src/components/ui/combobox.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/components/ui/dialog.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/components/ui/dropdown-menu.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/components/ui/select.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/components/ui/tooltip.tsx` | [H03 #446](https://github.com/1123786563/OpenBot/issues/446) |
| `app/src/components/ui/sheet.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/components/ui/sidebar.tsx` | [H09 #452](https://github.com/1123786563/OpenBot/issues/452) |
| `app/src/components/ui/bubble.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/carousel.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/context-menu.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/live-waveform.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/message-scroller.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/message.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |
| `app/src/components/ui/questionnaire.tsx` | [H10 #453](https://github.com/1123786563/OpenBot/issues/453) |

## 覆盖与恢复说明
`manifest.json` 保存全部组件所有权、原生 contains/depends_on 关系、Issue 编号/ID、发布与回读验证结果。每个 Issue 正文为本地 issues/hXX.md 的发布快照。
本组细化后估算约 14–27 人日，含共享控件验证、遗漏面补齐与独立验收；原方案 10–20 人日为初步范围估算。H01 后重新校准；不承诺并行压缩日历时间。
