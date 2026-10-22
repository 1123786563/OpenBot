# H01 路由归属与依赖清单（AC1 产物）

- 生成时间：2026-10-19（UTC ~17:05），工作区 feat/heroui-v3-migration，未提交状态。
- 口径：`src/routes/**` 全部路由文件；每个文件列其 import 的 `components/ui/*`（迁移面）与 `@base-ui`（退场面，H14 核对用）。`@heroui` 导入单独汇总。

## 路由文件总数
      88

## 逐文件归属
- `src/routes/__root.tsx` | ui: tooltip | @base-ui: 0 | @heroui: 1
- `src/routes/_authed.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/agents/index.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/approvals.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bot.tsx` | ui: button | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.access.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.approvals.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.datasets.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.evaluations.$datasetId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.evaluations.experiments.$experimentId.$executionId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.evaluations.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.exports.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.index.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.memory.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.reach.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.responsibilities.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.routines.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.runs.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.setup.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.$agentId.sharing.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/bots.index.tsx` | ui: router-link | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/channel/$channelId.tsx` | ui: button | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/channel/new.tsx` | ui: combobox | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/craft/$sessionId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/craft/index.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/craft/tasks.tsx` | ui: button,empty,item,router-link,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/group/$channelId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/group/new.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/index.tsx` | ui: carousel,empty,skeleton | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/memory.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/reachability.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/responsibilities.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/routines.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/skills.tsx` | ui: button,dropdown-menu,empty,item,router-link,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/_app/team-bots.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/ai-observability.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/approvals.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/audit.tsx` | ui: button | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/billing.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/bot-services.tsx` | ui: button,checkbox,dialog,field,input,item,select,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/boundaries.tsx` | ui: button,input | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/components/$name.tsx` | ui: button,dialog,empty,item,router-link,separator,switch,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/components/index.tsx` | ui: empty | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/computers.tsx` | ui: button,dialog,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/credentials.tsx` | ui: button,dialog,field,input,item,select,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/enterprise.tsx` | ui: button,dialog,input,item,label,select,separator,switch,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/gateway.tsx` | ui: button,field,input,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/identity-providers.tsx` | ui: button,dialog,input,item,label,separator,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/index.tsx` | ui: item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/knowledge.$kbId.tsx` | ui: button,checkbox,dialog,empty,input,label,switch,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/knowledge.index.tsx` | ui: button,dialog,empty,input,item,separator,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/learning.tsx` | ui: button,input | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/market.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/model-catalog.tsx` | ui: button,dialog,field,input,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/observability.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/people.tsx` | ui: button,input,item,separator,switch | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/playground.tsx` | ui: button,dialog,field,input,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/$key.tsx` | ui: button,checkbox,dialog,field,input,item,separator,switch | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/$key_.bots.$agentId.tsx` | ui: button,dialog,input,item,separator,switch | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/$key_.tools.$tool.tsx` | ui: item,separator,switch | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/composio.tsx` | ui: button,input,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/index.tsx` | ui: item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/plugins/open-connector.tsx` | ui: button,input,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/route.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/admin/skills.tsx` | ui: button,dialog,field,input,item,separator,textarea | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/onboarding.tsx` | ui: button | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/approvals.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/components-gallery/$name.tsx` | ui: empty,item,router-link,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/components-gallery/index.tsx` | ui: empty | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/connected-accounts/$key.tsx` | ui: button,dropdown-menu,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/connected-accounts/index.tsx` | ui: button,input-group,item | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/index.tsx` | ui: item,select,separator,switch | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/invoices.tsx` | ui: button,dialog,empty,select,skeleton | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/memory.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/model-access.tsx` | ui: button,input,item | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/notifications.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/orders.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/passwords.tsx` | ui: button,item,separator | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/route.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/settings/usage.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/sign-in/$requestId.tsx` | ui: — | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/tenant/channels.tsx` | ui: button,item,select | @base-ui: 0 | @heroui: 0
- `src/routes/_authed/tenant/selection.tsx` | ui: button,select | @base-ui: 0 | @heroui: 0
- `src/routes/share.$token.tsx` | ui: button | @base-ui: 0 | @heroui: 0
- `src/routes/sign.tsx` | ui: button,input,separator | @base-ui: 0 | @heroui: 0

## 组件层 @base-ui 导入文件（H14 退场清单的静态底稿）
src/components/ui/combobox.tsx

## 组件层 @heroui 导入文件
src/components/ui/button.tsx
src/components/ui/checkbox.tsx
src/components/ui/context-menu.tsx
src/components/ui/dialog.tsx
src/components/ui/dropdown-menu.tsx
src/components/ui/input.tsx
src/components/ui/label.tsx
src/components/ui/select.tsx
src/components/ui/separator.tsx
src/components/ui/sheet.tsx
src/components/ui/skeleton.tsx
src/components/ui/switch.tsx
src/components/ui/textarea.tsx
src/components/ui/tooltip.tsx
src/routes/__root.tsx
