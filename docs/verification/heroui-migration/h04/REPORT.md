# H04 (#447) REPORT — 个人设置、连接管理与记忆维护

状态：**implemented（域内红清零，两层测试全绿）**；浏览器证据按分工留给 frontend_validator。
BASE：`203d0f0244b2`（HEAD 未动，无 commit）。工作目录：`.worktrees/heroui-migration`。
上游检查点：H03 Interface（dialog/select/combobox/dropdown/tooltip 冻结导出）已按 BRIEF 只消费未修改。

## 改动文件（5 个）

| 文件 | 要点 |
| --- | --- |
| `app/tests/preload.ts` | **根因修复（共享测试基建，两层已回归验证）**：把 `await import("react-dom/client")` 移到**第一个** `GlobalRegistrator.register()` 之前。原顺序（先开窗评估 @heroui/react/modal、关窗后再评估 react-dom）让 react-dom 在「窗口已注册又关闭」之后求值，其内部 `scheduleTimeout = setTimeout` 捕获到死窗口的定时器 —— 此后**所有**由定时器/微任务调度的重渲染（查询resolve→重渲染）静默丢失，DOM 永远停在 Loading。渲染本身与事件触发的更新不受影响（act 同步冲刷），所以症状恰好是「缓存有数据、界面不更新」。单变量二分证据见下「根因实验」。该类冻死影响 H04 域 3 个套件：user-preferences（3）、devices-settings（2）、update-routing-settings（1）。 |
| `app/tests/user-preferences.test.tsx` | 触发器查询 `getByRole("combobox")` → `getByRole("button", { name: "Message list emphasis" })`，并加注释说明原因（HeroUI Trigger 丢弃 wrapper 传的 role，见 Interface 变更申请）。加载期禁用断言、错误/重试/保存语义断言全部保留。3/3 绿。 |
| `app/tests/bot-memory.test.tsx` | 同类修正：`queryByRole("combobox", { name: /^Bot/ })`（2 处空断言）与 `openAddSource` 里的 `findByRole("combobox", { name: "Connected app action" })` → button 角色；option 查询不变（RAC ListBoxItem 仍是 role="option"）。5/5 绿。 |
| `app/tests/bot-reaching-you.test.tsx` | 同类修正：Conversation 触发器 3 处点击 + Bot 空断言 1 处 → button 角色；link code 复现、验证码、取消语义断言不变。6/6 绿。 |
| `app/src/components/plugins/shared-approval-fields.tsx` | outsideInput 的原生 `<input type="checkbox">` → `ui/checkbox`（HeroUI/RAC 基座；与 passwords/sign-in-form 的既有用法同一控件），label 文本、role="checkbox"、可点击路径与受控语义不变。audience 三选 radio **保持原生**（无 ui/radio-group 原语，见 Interface 变更申请）；native radio 的 role/name/表单语义本就是 AC2 所需。shared-grant-dialog 3/3 绿。 |

## 根因实验（preload 重排的单变量归因，全部 native 层 e2e/单文件）

| 变体 | 结果 |
| --- | --- |
| 无 preload（测试自注册窗口） | 定时器重渲染正常 → 排除 runner/RTL/happy-dom 本身 |
| 仅 react-dom 预热（不开窗） | 正常 → 「在窗口外求值 react-dom」不是问题 |
| 仅 window-1 舞步（@heroui/react modal 开窗→关窗） | **复现冻死** |
| 仅 window-2 舞步（@base-ui dialog + i18n 开窗→关窗） | **复现冻死** |
| react-dom 预热放在任何开窗**之前**（即本次修复） | 正常 |

结论：kill 因子是「react-dom 在任意 register/unregister 循环之后求值」，修复=把预热提到所有开窗之前；与 preload 文件头注释自述的目标（"scheduler that outlives the window"）一致，只是原代码把顺序让位给了 react-aria 的 useLayoutEffect 捕获。**历史疑点如实记录**：Oct 19 23:03 的 `h04/native/report.json` 里 user-preferences 前两条曾是 pass、今天同输入复现失败；同 runner(0.20.0)/同 node(v22.22.3)/同依赖/app 域文件 mtime 全部早于该基线，无法完全复原当时为何通过（preload 注释自称的“import-order luck”是唯一自洽解释，但本轮未能重现其条件）。01:54 全量 native（LEDGER 2026-10-20）已把 user-preferences 记为红，与本轮观察一致。

## 触发器 role 的 Interface 变更申请（不直接改冻结文件）

1. **`ui/select.tsx`（H03 交付物）**：wrapper 用 `TriggerWithRole` 转发 `role="combobox"`，但 HeroUI `Select.Trigger` 实际渲染为 `button[aria-haspopup="listbox"]` 且**丢弃**该 role（DOM 证据：`.e2e/unit-h04-probe*` 与 h04/native report 的失败转储均无 role 属性）。H03 REPORT 已记录“实测 role 属性为空、归 H15 裁决”。本次域内处置：测试按实际契约（button + 可访问名）查询。若 H15 决定必须恢复 combobox 语义，需在 H03 域内改 wrapper（例如经 props 层映射或 DOM ref 补写），不应由各业务域自行垫片。
2. **缺 `ui/radio-group` 原语**：app/src 内唯一的 radio 组（shared-approval-fields 的 audience）暂留原生。请 H01/编排者补 `ui/radio-group.tsx`（HeroUI `RadioGroup`/`Radio`+`Radio.Content/Control/Indicator` 组合，样式对齐 `heroui-theme.css` 的 ob-checkbox 形状）并在 `styles.css` 增加 `@import "@heroui/styles/components/radio.css" layer(components)`（styles.css 本轮为并行修复轮冻结，未动）。落地后本域调用端即可迁移。
3. **`preload.ts` 归属**：该文件是 H02/H03 建立的共享测试基建，本轮改动了 1 条 import 的顺序（动机与证据如上）；driven 层 30+20 条用例回归全绿，native 层域内 53+31 条全绿。若 H02/H03 owner 对顺序有约束（原注释提到的 TextArea onChange 捕获），请复核：heroui-spike 测试目前在 native/driven 两侧都未被收集（e2e-known-broken/排除清单），本轮无法用其作回归证据。

## AC 状态与证据

- **AC1 个人资料、密码/通知、消息偏好、连接添加/编辑/断开、账号模式切换路径可用 — PASS（组件/单元层）**
  user-preferences 3/3（加载→已保存 emphasis 渲染、禁用/错误/重试、保存只更新当前账号缓存）；account-mode-dialog 3/3；connected-accounts-list 4/4；connection-fields、composio-picker、open-connector-picker、brokered-connection-card、brokered-account-row、shared-app-notice、shared-connected-accounts、devices-settings 2/2、update-routing-settings 1/1 全绿；passwords/sign-in-form 本轮零改动（行为保持）。浏览器级路径由 validator 复核。
- **AC2 共享审批、撤销与权限不足状态保留；OAuth 回调/外部跳转不被吞 — PASS**
  shared-grant-dialog 3/3（含「从 Bot 当前暴露收窄到 owner」与 named-people 条件展示；checkbox 迁移后语义/角色不变）；account-mode-dialog 的 wouldRevoke/失败分支 3/3；OAuth 跳转保持 `window.location.assign/href`（linked-accounts.tsx:193、brokered-account-row.tsx:419、connected-accounts/$key.tsx:122、admin/plugins/$key.tsx:337，均未改动）；memories.tsx:222 的外部 sourceLink 保持真实 anchor（未改动）；域内无内部裸 `<a>`（内部链接走 `ui/router-link` ButtonLink）。
- **AC3 记忆候选确认/编辑/遗忘与来源权限保持、不新增自动记忆 — PASS**
  memory-settings（driven）与 bot-memory 5/5（只列本 Bot 来源、无 Bot 选择器、action setting 独立字段、失败后重开保留草稿不保留错误）；memories.tsx/sources.tsx 本轮零行为改动（无自动记忆相关新增）。
- **AC4 异步加载、空态、表单错误、pending、取消可观察；敏感值不回填 — PASS**
  user-preferences：加载期 Select disabled+「Loading…」、503 → role="alert"+Retry、保存 pending status 行；devices/update-routing 空态/加载断言绿；bot-reaching-you 取消（ESC 关闭后不再重发）断言绿；sign-in-form 的 password/code 为受控输入且提交 settled 后强制清空（179、215–216 行），从未从服务端回填。共享审批对话框 ESC/外点关闭由 RAC overlay 原生处理（H03 CDP 证据链仍有效）。
- **AC5 公司/团队切换隔离、中英长标签可读 — PASS（单元层）/浏览器层留证**
  本轮 diff 不触碰任何 tenant/workspace 作用域逻辑；记忆/Bot 查询继续以显式 agentId 传参（sources.tsx 未改）；multitenancy/selection（H13 域）未被本轮触碰。长标签为视觉断言，按分工由 validator 在真实浏览器取证；本轮改动未引入任何会破坏换行/密度的样式（checkbox 仅加 `text-sm`，与字段集一致）。

## 验证命令与 exit code（全部在本 worktree 根执行；测试经 ADR 0008 分层）

| 命令 | 结果 |
| --- | --- |
| `cd app && bun run typecheck` | **EXIT 2 — 唯一 1 条错误为 `app/tests/h06-clear-probe.test.tsx(10,1) TS2304`，属并行 H06 agent 今日 13:28 新建的未跟踪探针文件（`?? app/tests/h06-clear-probe.test.tsx`），不在 H04 改动面；除此之外全项目 0 错误（含 H04 全部改动文件）。** |
| `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.e2e/unit-h04-final-native bunx e2e run --config e2e.unit.config.ts <16 个域内 native 文件>` | **EXIT 0**，16 files / **53 tests passed / 0 failed**（user-preferences、devices-settings、update-routing-settings、shared-grant-dialog、connected-accounts-list、connection-fields、composio-picker、open-connector-picker、plugin-logo、shared-app-notice、shared-connected-accounts、brokered-account-row、brokered-connection-card、grant-roster、plugin-grants、bot-app-grants、screen-connection） |
| `bunx e2e run --config e2e.unit.config.ts app/src/components/settings/linked-accounts.test.tsx` | **EXIT 0**，31/31 |
| `cd app && bun test tests/bot-memory.test.tsx tests/bot-reaching-you.test.tsx tests/memory-settings.test.tsx tests/account-mode-dialog.test.tsx tests/craft-session-title.test.tsx`（driven 层） | **EXIT 0**，20 pass / 0 fail |
| `cd app && bun test tests/model-picker-ui.test.tsx tests/user-authorizations-ui.test.tsx tests/account-mode-dialog.test.tsx tests/admin-catalog-sync-ui.test.tsx tests/admin-gateway-readiness.test.tsx tests/admin-credit-grant-ui.test.tsx`（H03 回归，driven 层） | **EXIT 0**，30 pass / 0 fail（preload 重排对其无影响） |
| `cd app && bun run build` | **EXIT 0**（chunk>500kB 警告为既有） |
| `bunx biome check <5 个改动文件>` | 3 个测试文件各有 organizeImports/format 提示；对 HEAD 版本同命令得到**完全相同**的 6 条 → 既有噪声，非本轮引入；preload.ts 与 shared-approval-fields.tsx 无任何诊断 |

## 遗留项 / 移交

1. **Interface 变更申请三条**（见上）——select 触发器 role 归 H15 裁决；radio-group 原语归 H01/编排者；preload.ts 顺序请 H02/H03 owner 复核。
2. **heroui-spike TextArea**（native 排除清单内）当前两侧都不可运行，preload 注释里「React 先于 HeroUI 求值会影响 textarea onChange」的旧约束本轮无法用该套件回归；其清单条目应在 H02/H13 verify 轮核实。
3. **shared-grant-dialog.test.tsx 现为 native 层**（e2e-compat），在 bun 下按预期报 registerHooks 加载错；H03 REPORT「以 Bun 执行」的说法已过时，属文档漂移，不改 H03 产物，在此记录。
4. 浏览器级证据（AC1/AC5 真实点击、长标签、focus 视觉）按 BRIEF 由 frontend_validator 执行；本轮代码未引入 portal/focus/滚动自定义逻辑，不会阻塞其验证。
5. 并行会话提示：OCR-fix-r1（styles.css/theme-preference）与 H06 探针文件与本轮文件集零重叠；本轮未触碰任何冻结文件。

## 阻塞

无。
