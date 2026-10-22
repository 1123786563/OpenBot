# H14/H15 遗留与收口清单（主控汇总，2026-10-20）

来源：h01/REPORT.md、h02/REPORT.md、H01/H02/H03 独立审查、OCR fix-r1、LEDGER。H14/H15 Brief 派发时消费本清单并逐项核销。

## 转 H15（浏览器/验收类）
1. light+zh 组合、200% 缩放、reduced-motion 的真实 app 页浏览器证据（spike 无 i18n 面）。
2. ContextMenu 物理键（Shift+F10/ContextMenu 键）、触摸/长按 in-app browser 复核（headless CDP 不触发，已如实记录）。
3. Questionnaire 浏览器侧 change 事件证据（逻辑层引擎单测已覆盖）。
4. 弹窗外点关闭 / scroll lock / 短视口滚动 / Select popover 定位（h03 REPORT 未完成清单收窄项）。
5. `role=combobox` 缺失的 a11y 裁决（现实现 aria-haspopup=listbox）。
6. H02 整轮 native 的 2 个共享进程隔离失败 + 1 个既有环境失败：隔离复跑/基线对比呈报。
7. 亮暗首屏（pre-paint）浏览器检查缺 H02 专项证据（并入第 1 项一起补）。

## 归 H10（聊天波次）
- `bubble.tsx:33` hover 仍用 `--muted`（AC1 token 漏网，H02 审查 M1）。

## 归 H14（底座退场/依赖类）
1. `puppeteer-core` 未在任何 package.json 声明（cdp-harness 依赖传递解析）——Interface 变更申请：声明或统一改 playwright-core（lockfile 唯一写入者=H14）。
2. CSS 增量复核：当前 +6.8KB gzip（+13.7% 超 10% 门槛已有评审结论——逐组件导入为最小路径）；H14 按最终迁移面复算，必要时裁剪 base/variants。
3. 删除计划执行：`styles/legacy-ui-bridge.css`（ob-legacy 层）在业务域 token 清扫完成后移除。
4. H02 审查 Low：switch 镜像非受控 stale、heroui-theme 暗色 OFF 轨道、merge 三拷贝、ob-theme 冗余声明、router-link to+href 同传。
5. `shadcn`/`tw-animate-css`/`cva` 按实际使用决定去留；`@shadcn/react` 问卷/消息滚动明确保留项。
6. `agent-mastra/bun.lock`（环境修复产生）核对是否属交付范围。

## 归 H04+ verify 轮点检（H03 复审 Low 四项）
- maxSelected=0 边界；document 级探测；effect 闭包；hidden-coworker parity。

## 检查点债
- H01 终态检查点指纹重算（绑定终态 diff，H15 统一做）。
- H02 检查点 d78d04b0 为封存快照，7 文件哈希漂移——H03 收口后受影响文件增量复验（fix-r1 已覆盖 styles.css/theme 相关，剩余文件在 H15 对账）。

## W3A 复审追加（REVIEW-W3A-2026-10-20.md）
- F3→H13 verify 轮：heroui-spike 排除清单条目 + TextArea import-order 约束复核（H02/H13）。
- F4→H15（涉 H03 adapter 文件）：ui/select.tsx:515-519 注释失实（role="combobox" 被 react-aria filterDOMProps 丢弃）——下次触碰 adapter 时修正注释；role 缺失的 a11y 裁决一并做。
- F5→H14 lint 清扫：bot-reaching-you/bot-memory 测试注释位置与缩进。

## H07 后主控裁定（16:58）
- heroui-spike TextArea 红（H02/H01 域）：根因=RAC 合成 change 吞噬（H06 族，测试侧）→ **H14 处置**：按 H06/H13 的 Backspace/真键击模式修测试；若复跑仍红则升级为 ui/textarea 生产回归（Interface 变更流程）。
- W3C-F2：heroui-spike 红数是隔离条件性的——全量 native 中 14/1（仅 TextArea）；隔离复跑 12/15（TextArea+2 Modal ESC）。H14 处置时按隔离条件记录。

## W5 复审追加（REVIEW-W5-2026-10-20.md）
- F4 [medium]→**即时修复轮**：demonstration-recorder.tsx 丢失 BASE 的可重选空选项（"only in conversation"）——修复后复验。
- F5：H15 项 ArrowDown-from-wrapper（CDP 已记录）入本清单=本条即回填。
- F6：heroui-spike TextArea 归属统一裁定为 **H14**（H10 报告中 H15 字样以本裁定为准）。
- F1/F2/F9：h10 REPORT 标签/空产物/措辞小修→H14 文档清扫批量做。
- F3：context-menu.tsx 无独立 pre-H10 字节锚——H15 终态检查点统一 pin。
