# H01 契约矩阵（公共 UI 处置 × 迁移状态 × 证据，AC1/AC5 归属产物）

- 生成：2026-10-19（UTC ~17:10）。处置口径来自 Spec §2.2；状态列是当前工作区实测（grep import 而非文档转录）。

| 组件（components/ui） | 原底座 | 处置 | 波次 | 当前状态 | 证据/报告 |
| --- | --- | --- | --- | --- | --- |
| button.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| input.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| textarea.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| checkbox.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| switch.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| label.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| separator.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| skeleton.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H02 | ✅ @heroui/react（已迁移） | H02 REPORT |
| dialog.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H03 | ✅ @heroui/react（已迁移） | H03 REPORT |
| select.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H03 | ✅ @heroui/react（已迁移） | H03 REPORT |
| combobox.tsx | base-ui/react | HeroUI v3 / 等价 Adapter | H03 | ✅ 等价 Adapter（react-aria-components 一等组合 Popover+Input+ListBox+useFilter，已迁移；HeroUI v3 ComboBox 的 multiple 回调为二等语义，不满足顺序合同，见 h03 REPORT） | H03 REPORT |
| dropdown-menu.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H03 | ✅ @heroui/react（已迁移） | H03 REPORT |
| tooltip.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H03 | ✅ @heroui/react（已迁移） | H03 REPORT |
| context-menu.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H04-H13 | ✅ @heroui/react（已迁移） | H04-H13 REPORT |
| sheet.tsx | heroui/react | HeroUI v3 / 等价 Adapter | H09 | ✅ @heroui/react（已迁移） | H09 REPORT |
| sidebar.tsx | plain | HeroUI v3 / 等价 Adapter | H09 | ⏳ plain（待迁移/等价保留） | H09 REPORT |
| bubble.tsx | plain | HeroUI v3 / 等价 Adapter | H10 | ⏳ plain（待迁移/等价保留） | H10 REPORT |
| message-scroller.tsx | plain | HeroUI v3 / 等价 Adapter | H10 | ⏳ plain（待迁移/等价保留） | H10 REPORT |
| questionnaire.tsx | plain | HeroUI v3 / 等价 Adapter | H10 | ⏳ plain（待迁移/等价保留） | H10 REPORT |
| message.tsx | plain | HeroUI v3 / 等价 Adapter | H10 | ⏳ plain（待迁移/等价保留） | H10 REPORT |
| router-link.tsx | plain | HeroUI v3 / 等价 Adapter | H02 | ⏳ plain（待迁移/等价保留） | H02 REPORT |
| item.tsx | plain | HeroUI v3 / 等价 Adapter | H04-H13 | ⏳ plain（待迁移/等价保留） | H04-H13 REPORT |
| field.tsx | plain | HeroUI v3 / 等价 Adapter | H04-H13 | ⏳ plain（待迁移/等价保留） | H04-H13 REPORT |
| empty.tsx | plain | HeroUI v3 / 等价 Adapter | H04-H13 | ⏳ plain（待迁移/等价保留） | H04-H13 REPORT |

## 保留的专用依赖（Spec §7 明确保留）
- PromptArea/Streamdown、Recharts、Embla、问卷与消息滚动引擎：组件引擎层保留，仅其通用控件/动作入口迁移。

## @base-ui 组件层残留（H14 退场清单底稿，截至本文件生成时）
- src/components/ui/combobox.tsx
