# HeroUI v3 迁移覆盖对账（coverage.md）

- 生成：2026-10-20，H14（#457）收口轮。工作区 `.worktrees/heroui-migration`，BASE/HEAD `203d0f0244b2`。
- 方法：以 manifest.json 的 88 路由表为基准，重扫当前工作区 `app/src/routes/**/*.tsx`（88 文件）与 `app/src/components/ui/*.tsx`（27 模块）逐一对账；组件域按 manifest owned_files 归属；底座状态以 grep import 实测而非文档转录。
- 结果：**路由 88 = 88，零新增、零改名、零删除**；ui 模块 26（manifest）→ 27（现树），唯一增量 = `ui/router-link.tsx`（H02 交付、h01 契约矩阵已列、manifest 未收录——本文件补录）。
- 全局底座扫描：`@base-ui` 在 `app/src` **0 命中**（app 直接依赖已删，见 h14/REPORT.md）；`@radix-ui` 0 命中；碰撞名 `bg-muted`/`bg-accent`/`text-accent`/`hover:bg-accent` 均 **0 命中**（H08/H12 等波清扫完成），其余 legacy 词汇经 `styles/legacy-ui-bridge.css` 别名层解析（保留，理由见 h14/REPORT.md）。

## 1. 路由（88/88，全部有唯一归属）

| 路由文件 | 归属波次 | 处置 | 证据 |
| --- | --- | --- | --- |
| `app/src/routes/__root.tsx` | H02 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h02/REPORT.md; W3A |
| `app/src/routes/_authed.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/_app.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/_app/agents/index.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/approvals.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/_app/bot.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/bots.$agentId.access.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/_app/bots.$agentId.approvals.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/_app/bots.$agentId.datasets.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.exports.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.index.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/bots.$agentId.memory.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/_app/bots.$agentId.reach.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/_app/bots.$agentId.responsibilities.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/bots.$agentId.routines.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.runs.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/_app/bots.$agentId.setup.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/bots.$agentId.sharing.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/_app/bots.index.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/channel/$channelId.tsx` | H10 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h10/REPORT.md; W5 |
| `app/src/routes/_authed/_app/channel/new.tsx` | H10 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h10/REPORT.md; W5 |
| `app/src/routes/_authed/_app/craft/$sessionId.tsx` | H11 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h11/REPORT.md; W6 |
| `app/src/routes/_authed/_app/craft/index.tsx` | H11 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h11/REPORT.md; W6 |
| `app/src/routes/_authed/_app/craft/tasks.tsx` | H11 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h11/REPORT.md; W6 |
| `app/src/routes/_authed/_app/group/$channelId.tsx` | H10 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h10/REPORT.md; W5 |
| `app/src/routes/_authed/_app/group/new.tsx` | H10 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h10/REPORT.md; W5 |
| `app/src/routes/_authed/_app/index.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/_app/memory.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/_app/reachability.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/_app/responsibilities.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/routines.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/skills.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/_app/team-bots.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/admin/ai-observability.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/admin/approvals.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/audit.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/billing.tsx` | H08 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h08/REPORT.md; W3B |
| `app/src/routes/_authed/admin/bot-services.tsx` | H05 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h05/REPORT.md; W3A |
| `app/src/routes/_authed/admin/boundaries.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/components/$name.tsx` | H13 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h13/REPORT.md; W3C |
| `app/src/routes/_authed/admin/components/index.tsx` | H13 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h13/REPORT.md; W3C |
| `app/src/routes/_authed/admin/computers.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/admin/credentials.tsx` | H05 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h05/REPORT.md; W3A |
| `app/src/routes/_authed/admin/enterprise.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/gateway.tsx` | H05 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h05/REPORT.md; W3A |
| `app/src/routes/_authed/admin/identity-providers.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/index.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/admin/knowledge.$kbId.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/admin/knowledge.index.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/admin/learning.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/admin/market.tsx` | H13 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h13/REPORT.md; W3C |
| `app/src/routes/_authed/admin/model-catalog.tsx` | H05 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h05/REPORT.md; W3A |
| `app/src/routes/_authed/admin/observability.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/admin/people.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/admin/playground.tsx` | H12 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h12/REPORT.md; W3C |
| `app/src/routes/_authed/admin/plugins/$key.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/plugins/composio.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/plugins/index.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/plugins/open-connector.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/admin/route.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/admin/skills.tsx` | H06 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h06/REPORT.md; W3B |
| `app/src/routes/_authed/onboarding.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/settings/approvals.tsx` | H07 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h07/REPORT.md; W4 |
| `app/src/routes/_authed/settings/components-gallery/$name.tsx` | H13 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h13/REPORT.md; W3C |
| `app/src/routes/_authed/settings/components-gallery/index.tsx` | H13 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h13/REPORT.md; W3C |
| `app/src/routes/_authed/settings/connected-accounts/$key.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/connected-accounts/index.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/index.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/invoices.tsx` | H08 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h08/REPORT.md; W3B |
| `app/src/routes/_authed/settings/memory.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/model-access.tsx` | H03 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h03/REPORT.md+combobox-migration.md; REVIEW-2026-10-20 |
| `app/src/routes/_authed/settings/notifications.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/orders.tsx` | H08 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h08/REPORT.md; W3B |
| `app/src/routes/_authed/settings/passwords.tsx` | H04 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h04/REPORT.md; W3A |
| `app/src/routes/_authed/settings/route.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/settings/usage.tsx` | H08 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h08/REPORT.md; W3B |
| `app/src/routes/_authed/sign-in/$requestId.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/tenant/channels.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/_authed/tenant/selection.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |
| `app/src/routes/share.$token.tsx` | H10 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h10/REPORT.md; W5 |
| `app/src/routes/sign.tsx` | H09 | 已迁移/核验（消费冻结 HeroUI ui/* 面） | h09/REPORT.md; W3B |

## 2. 公共 UI 模块（components/ui，27 = manifest 26 + router-link 补录）

| --- | --- | --- | --- | --- |
| ui/button.tsx | H02 | @heroui/react | 已迁移（HeroUI adapter，冻结面） | h02/REPORT.md; W3A |
| ui/checkbox.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/empty.tsx | H02 | plain 组合 | 等价保留（无旧底座依赖） | h02/REPORT.md; W3A |
| ui/field.tsx | H02 | plain 组合 | 等价保留 | h02/REPORT.md; W3A |
| ui/input-group.tsx | H02 | plain 组合 | 等价保留 | h02/REPORT.md; W3A |
| ui/input.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/item.tsx | H02 | plain 组合 | 等价保留 | h02/REPORT.md; W3A |
| ui/label.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/separator.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/skeleton.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/switch.tsx | H02 | @heroui/react | 已迁移（冻结面）；H14 补非受控镜像 change 监听 | h02/REPORT.md + h14/REPORT.md |
| ui/textarea.tsx | H02 | @heroui/react | 已迁移（冻结面） | h02/REPORT.md; W3A |
| ui/router-link.tsx | H02（补录） | plain（TanStack Link 真锚点） | 等价保留（合同禁 Button render=Link） | h02/REPORT.md; W3C |
| ui/combobox.tsx | H03 | react-aria-components | 等价 Adapter 迁移（Popover+Input+ListBox+useFilter，multiple 顺序合同） | h03/REPORT.md + combobox-migration.md |
| ui/dialog.tsx | H03 | @heroui/react | 已迁移（守卫 v3，冻结面） | h03/REPORT.md |
| ui/select.tsx | H03 | @heroui/react | 已迁移（keyForValue 往返，冻结面） | h03/REPORT.md; W3C |
| ui/dropdown-menu.tsx | H03 | @heroui/react | 已迁移（冻结面） | h03/REPORT.md |
| ui/tooltip.tsx | H03 | @heroui/react | 已迁移（冻结面） | h03/REPORT.md |
| ui/sheet.tsx | H09 | @heroui/react | 已迁移（冻结面） | h09/REPORT.md; W3B |
| ui/sidebar.tsx | H09 | plain（等价保留） | 等价保留（data-* variants 消费方） | h09/REPORT.md; W3B |
| ui/bubble.tsx | H10 | plain | 等价保留（token 收口毕） | h10/REPORT.md; W5 |
| ui/carousel.tsx | H10 | embla-carousel-react | **保留**（Spec §7 Embla 轨道合同） | h10/REPORT.md carousel-keyboard 3/3; W5 |
| ui/context-menu.tsx | H10 | @heroui/react | 已迁移（冻结面；CDP 7/7） | h10/REPORT.md; W5 |
| ui/live-waveform.tsx | H10 | plain（@tabler/icons-react） | 等价保留 | h10/REPORT.md; W5 |
| ui/message.tsx | H10 | plain | 等价保留 | h10/REPORT.md; W5 |
| ui/message-scroller.tsx | H10 | @shadcn/react/message-scroller | **保留**（Spec §7 专用行为） | h10/REPORT.md; W3C ac-reach |
| ui/questionnaire.tsx | H10 | @shadcn/react/questionnaire | **保留**（Spec §7 专用行为） | h10/REPORT.md; W3C ac-reach |

## 3. 组件域（app/src/components/*）

| 域 | 归属 | 处置 | 证据 |
| --- | --- | --- | --- |
| `settings/*（model-picker、model-access-authorizations 除外）` | H04 | 已迁移/核验 | h04/REPORT.md |
| `settings/model-picker.tsx、model-access-authorizations.tsx` | H03 | 已迁移/核验 | h03/REPORT.md |
| `settings/settings-sidebar.tsx` | H09 | 已迁移/核验 | h09/REPORT.md |
| `plugins/*、memory/*、passwords/*、delivery/*` | H04 | 已迁移/核验 | h04/REPORT.md |
| `admin/model-billing-paths.tsx` | H05 | 核验零 diff（BASE 即终态哈希） | h05/REPORT.md |
| `admin/* 其余`（admin-sidebar 归 H09、billing-cleanup-execution-card 归 H08） | H05/H07/H08/H12/H13 按路由域 | 已迁移/核验 | 各波 REPORT |
| `agents/*、bots/*、skills/*、knowledge/*、responsibilities/*、routines/*、bot-profile/*（access/sharing 除外）` | H06 | 已迁移/核验 | h06/REPORT.md |
| `bot-profile/access.tsx、sharing.tsx、approvals/*` | H07 | 已迁移/核验 | h07/REPORT.md |
| `billing/*、admin/billing-cleanup-execution-card.tsx` | H08 | 已迁移/核验 | h08/REPORT.md |
| `app-sidebar/*、layout/*` | H09 | 已迁移/核验（ButtonLink/token） | h09/REPORT.md |
| `channels/*（workshop-* 除外）、computer/*、suggestions/*` | H10 | 已迁移/核验 | h10/REPORT.md |
| `craft/*、channels/workshop-*` | H11 | 已迁移/核验 | h11/REPORT.md |
| `ai-observability/*、evaluations/*` | H12 | 已迁移/核验 | h12/REPORT.md |
| `gallery/*、market/*、component-preview.tsx` | H13 | 已迁移/核验 | h13/REPORT.md |
| `auth/provider-logo.tsx` | （纯展示，零 UI 库 import） | 保留（无旧底座依赖，非任何波次改动面） | grep 实测 |
| `icons/waveform.tsx` | H14 票面组件清单项 | 保留（@tabler/icons-react createReactComponent，无迁移面） | h14/REPORT.md |
| `theme-provider.tsx、lib/theme.ts、lib/markdown.tsx` | H02（theme 面）/ 前波（markdown token） | 已迁移/核验 | h02/REPORT.md |

## 4. 保留的专用依赖与引擎（AC3，原因 + 主题兼容证据）

| 保留项 | 消费点 | 保留原因 | 主题兼容证据 |
| --- | --- | --- | --- |
| `@shadcn/react`（questionnaire/message-scroller 引擎） | `ui/questionnaire.tsx:1`、`ui/message-scroller.tsx:6` | Spec §7 明确保留专用行为（问卷引擎、消息滚动）；通用控件/动作入口已由 wrapper 承担 | `styles.css:81-82` `@source` 扫描其类名；语义 token 经 `@theme inline` 供给；CDP ac-reach（h01/browser/cdp-harness/run-2026-10-19-ac-reach.log） |
| PromptArea | `channels/composer/*` | Spec §7 保留；其预设自带 fallback `:root` token 会压过 app 值，故只 `@source` 扫描不导入预设 | `styles.css:74-82` 注释即兼容策略 |
| Streamdown | `craft/message/text.tsx`、`channels/chat-transcript.tsx` | Bot 正文渲染引擎，依赖内 markup 无类扫描不可见 | `styles.css:81` `@source`（注释载明） |
| Recharts | billing 用量图表 | Spec §7 保留 | h08/REPORT.md 合同零 diff 核验 |
| Embla | `ui/carousel.tsx` | Spec §7 保留轮播轨道 | h10/REPORT.md carousel-keyboard 3/3；W5 复审 |
| `shadcn`（CLI 包，**保留**） | `styles.css:63` `@import "shadcn/tailwind.css"` | 该导出提供 `data-*` custom variants、`no-scrollbar`、`scroll-fade-*`，被**已迁移 ui 层活跃消费**（ui/sidebar.tsx:478、ui/message-scroller.tsx:43、app-sidebar.tsx:274、field/questionnaire/dropdown/select/context-menu 的 data-* 变体）；AC2「删除」的前提（H02 已删该 import）**不成立**——BASE styles.css:3 与现 styles.css:63 逐字相同，从未删除；按 AC2 自身「按实际使用决定」原则保留 | 本文件 §2；h14/REPORT.md AC2 节 |
| `tw-animate-css`（**保留**） | `styles.css:62` | `ui/select.tsx:629`（slide-in/animate-in 族）与 `craft/chat-panel.tsx:246` 活跃消费 | grep 实测 |
| `class-variance-authority`（**保留**） | ui/{field,input-group,empty,item,bubble,sidebar,button,router-link}.tsx | plain 组合层在用的变体工厂 | grep 实测 8+ 文件 |
| `agent-mastra/bun.lock`（保留为交付物） | agent-mastra 子包 | 六个兄弟子包的 bun.lock 在 BASE 即为已跟踪文件，本文件系 2026-10-20 环境修复补齐的最后一块，使 agent-mastra 与兄弟包一致 | 仓库清单对照；h14/REPORT.md BACKLOG 表 |

## 5. 对账备注

1. 88 路由快照后无新增/改名路由——AC4「不以旧清单掩盖遗漏」由零 diff + 全量重扫满足。
2. `ui/router-link.tsx` 为 manifest 后新增的公共 UI 模块（H02），本文件补录归属。
3. `styles/legacy-ui-bridge.css`（ob-legacy 层）**未删除**：其自述删除条件（app/src 无文件读取别名名）远未满足——`text-muted-foreground` 629 处、`border-border` 147、`text-foreground` 124、`bg-card` 41、`bg-background` 35 等仍活跃解析；碰撞名（`bg-muted`/`bg-accent` 直用类）已清零。删除属后续词汇级改名决策，非 H14 范围（h14/REPORT.md BACKLOG 表）。
4. 本轮新修复的公共面：`ui/switch.tsx` 非受控镜像、`heroui-theme.css` 暗色 OFF 轨道、`legacy-ui-bridge.css` 冗余声明移除——细节与验证见 h14/REPORT.md。
