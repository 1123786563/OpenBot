# H03 (#446) — 模型访问授权试点 + Overlay/Collection 控件

状态：implemented；功能测试通过（driven 层）；真实键盘/指针浏览器证据已闭环（2026-10-20 CDP 可信输入：守卫矩阵 A–E+F1 回归、combobox.mjs 11 项、combobox-dialog.mjs 11 项含 Dialog 内 ESC 逐层/快速连按/焦点返还/F2 嵌套死弹层，见 `h01/browser/cdp-harness/run-2026-10-20-*.log`；复审 REVIEW-2026-10-20.md 双结论 pass）。
检查点：workspace 增量；H02 检查点之后。

## 变更

- `dialog.tsx` → HeroUI Modal（Root/Backdrop/Container/Dialog/Heading/CloseTrigger）。`open`→`isOpen`，保留 `onOpenChange`、`overlayClassName`、`showCloseButton`、Body 独立滚动、`max-h-[85svh]`、Close 可访问名。嵌套 Modal 经实测 HeroUI/RAC 会为每层渲染 backdrop（无需 Base UI 的 forceRender 垫片）。
- `select.tsx` → HeroUI Select + RAC ListBox。`value`/`onValueChange` 适配为 RAC 受控值；领域 ID（数字/null/对象身份）不字符串化；`SelectItem value`→ListBoxItem `id`；复杂标签支持 `textValue`；禁用项不可选。触发器带 `aria-haspopup="listbox"`；浏览器实测（RUN-2026-10-19 收口轮）其 `role` 属性为空——此前版本声称保留 `role="combobox"` 与实测不符，已更正；是否必须补 role 由 H15 a11y 裁决。
- `combobox.tsx` → 迁移完成（2026-10-20 终态；2026-10-19 曾失实声称「已迁 HeroUI ComboBox」、实仍 `@base-ui/react`，由独立审查发现并如实记录）。HeroUI v3 的 `ComboBox` 单件 multiple 回调为 `Key | null` 二等语义（无序、无变更原因），无法表达 To 字段的顺序合同；按 Spec 的等价 Adapter 通道改为 react-aria-components 一等公民组合：`Popover`（触发摘要按钮带 `aria-haspopup="listbox"` + `aria-expanded`）+ 弹层首行 chips + filter `Input`（`autoFocus`）+ `ListBox(selectionMode="multiple")` + `useFilter`。领域 ID 原样流经 `getKey`，无 String() 强转、无 any；`onSelectedChange` 收完整有序 id 列表；ESC/外点由 RAC overlay 原生处理且不清空选择。行为验证（CDP 可信输入，`h01/browser/cdp-harness/run-2026-10-20-combobox.log` + `run-2026-10-20-combobox-dialog.log`）：打开/顺序多选/过滤/chip 移除/空态/ESC 逐层（Dialog 内 Combobox、快速连按、嵌套 F2）/重开保留 全部 PASS；typecheck 0；build 0。触发器 `role` 属性实测为空、`aria-haspopup="listbox"` 属实——与 Select 同一 a11y 裁决项归 H15。
- `dropdown-menu.tsx` / `tooltip.tsx` → HeroUI Menu/Dropdown + Tooltip；Tooltip 触发组合保持单一交互元素（H01 双角色发现）。
- `styles.css`：HeroUI 组件 CSS 全部改为显式 `layer(components)`（修复调用点 `max-w-*`/`p-*` 被组件样式覆盖），新增 H03 组件 CSS。
- 调用点机械修正：chat-transcript、routines-list、triggers。

## 验证

| 项 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| typecheck | `bun run --cwd app typecheck` | EXIT 0 | 会话输出 |
| 模型访问/授权核心 | `bun test app/tests/model-picker-ui.test.tsx` | 8 pass / 0 fail | 会话输出 |
| 用户授权列表 | `bun test app/tests/user-authorizations-ui.test.tsx` | 4 pass / 0 fail | 会话输出 |
| 管理端联动 | admin-catalog-sync 4/4、admin-gateway-readiness 4/4、admin-credit-grant 7/7 | pass | 会话输出 |
| dialog 相关 | shared-grant-dialog 3/3、account-mode-dialog 3/3 | pass | `h03/dialog.md` |

说明：上述 5 个文件在 e2e native 配置中被显式排除（driven 层），按 ADR 0008 以 Bun 执行并记录；e2e 直接传参返回 NO_TESTS，不作为失败。

## 失败归因

`billing-credits-ui`（13 fail）与 `personal-credits-ui`（5 fail）在**未改动基线仓库**上用同一命令得到**完全相同**的 13 failed / 13 passed → 既有环境/harness 问题，不是本次迁移引入。

## 未完成（不计通过）

- 真实浏览器（2026-10-20 收窄口径；ESC 逐层、初始/返回焦点、嵌套遮罩已由 CDP 矩阵与
  combobox-dialog.mjs 实测覆盖）：外点（outside press）关闭、scroll lock、短视口滚动、
  Select popover 定位。转 H15 in-app/视口轮补证。
- AC1/AC3 的完整授权→撤销端到端流程仅有单元/组件级证据；浏览器级待 H15。

## 下游 Interface

Dialog 保持原导出与 props；Select/ComboBox 保持 `value`/`onValueChange` 与领域值；Dropdown/Tooltip 导出面不变。H04–H13 不应再改这些 wrapper，若必须改需记录 Interface 变更。
