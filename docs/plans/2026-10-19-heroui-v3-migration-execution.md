# HeroUI v3 主应用迁移 — 执行计划

状态：执行中。日期：2026-10-19。
授权来源：父 Issue #443 的委派提示词（2026-10-19），明确授权实施 H01–H15（#444–#458）、隔离工作区、依赖安装、验证、Review Agent、OCR 与修复；不授权 commit/push/merge/deploy。Issue 与本地文档中“待评审、未授权实施”为历史状态，保留原文不改。

## 1. 事实源与基线

- 仓库：`1123786563/OpenBot`（origin），参考副本 `CopilotKit/OpenBot`（upstream）。
- 执行工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`，分支 `feat/heroui-v3-migration`。
- BASE：`203d0f0244b2f898218fa12027089c631e8448d9`（`main`，工作区干净，仅 `bifrost` 子模块有本地修改，未带入本任务）。
- 设计：`docs/specs/2026-10-19-heroui-ui-migration-design.md`；研究：`docs/research/2026-10-19-heroui-official-research.md`；Ticket：`docs/plans/tickets/heroui-migration/`。
- 测试规范：`docs/adr/0008-test-runner-tester-army-e2e.md`（native/driven/engine 分层，`bun test` 不是入口）。
- 远端读取：2026-10-19T12:54Z，`gh -R 1123786563/OpenBot` 确认父 Issue #443 与子 Issue #444–#458 均为 OPEN、无实现。`gh` 默认解析到 upstream（CopilotKit/OpenBot）会读到无关 Issue，查询必须显式 `-R`。

## 2. 实测范围（2026-10-19 重扫）

- `app/src/routes/**/*.tsx`：88，与清单一致。
- `app/src/components/ui/*.tsx`：26，与清单一致。
- `app/src/components/**/*.tsx`：200，与清单一致。
- 直接 `@base-ui/react` 导入：15 个文件，全部在 `components/ui/`：sheet、bubble、tooltip、combobox、switch、item、dialog、sidebar、separator、button、checkbox、dropdown-menu、select、input、context-menu。
- 引用频次（`@/components/ui/<name>`）：button 138、item 72、separator 69、input 45、dialog 41、field 25、textarea 21、switch 20、select 19、empty 13、skeleton 9、sidebar 5、label 4、input-group 4、dropdown-menu 4、checkbox 4、tooltip 3、sheet 2、message 2、live-waveform 2、bubble 2、questionnaire/message-scroller/context-menu/combobox/carousel 各 1。
- 当前依赖：React 19.2、Tailwind 4.3、Vite 7、TanStack、CopilotKit 1.77、`@base-ui/react ^1.6.0`、`@shadcn/react ^0.3.0`、`prompt-area`、`streamdown`、`recharts`、`embla-carousel-react`。
- HeroUI：版本线 `@heroui/react@3.2.6` + `@heroui/styles@3.2.6`（npm peer：React >=19、Tailwind >=4、react-aria 3.52.x、react-aria-components 1.21.x）。安装后以实际类型为准。

## 3. DAG 与所有权

硬依赖按父 Issue：H01→H02→H03；H04/H05/H06/H08/H09/H13←H03；H07←H03,H04,H06；H10←H03,H09；H11←H10；H12←H03,H06；H14←H04..H13；H15←H14。

共享写入者规则：
- H02 是 `package.json`/lockfile/`main.tsx`/`__root.tsx`/styles/tokens 与 12 个基础控件的唯一写入者；H03 是 5 个 Overlay/collection 控件的唯一写入者。此后共享 UI 冻结，仅缺陷修复可改并记录 Interface 变更。
- H04/H05/H06/H08/H09/H12/H13 文件集互不重叠，可在 H03 verified 后并行；H07/H10 在对应上游 verified 后执行；H11 依赖 H10；H14/H15 串行收口。
- 单一 lockfile 写入者：仅 H02 与 H14 安装/移除依赖。

## 4. 执行波次

| 波次 | Issue | 角色 | 产物 |
| --- | --- | --- | --- |
| W0 | H01 #444 | frontend_implementer（spike）+ 主控编排 | inventory、版本锁定、spike fixture、基线、契约矩阵 |
| W1 | H02 #445 | frontend_implementer | HeroUI 依赖/主题/token/12 基础控件、link adapter |
| W2 | H03 #446 | frontend_implementer | 模型访问试点、5 个 Overlay/collection 控件 |
| W3 | H04/H05/H06/H08/H09/H12/H13 | 并行 frontend_implementer（文件不重叠） | 各业务切片 |
| W4 | H07/H10 | frontend_implementer（串行/可并行，文件不重叠） | 治理与聊天 |
| W5 | H11 #454 | frontend_implementer | Craft |
| W6 | H14 #457 | frontend_implementer | 移除 Base UI、覆盖对账、包体 |
| W7 | H15 #458 | frontend_validator + reviewer + 主控 OCR | 全量验收、Review、OCR、交付报告 |

每个实现波次完成后：只读验证（frontend_validator）→ 独立 reviewer（Spec compliance + code quality）→ 主控 OCR（`--audience agent`）→ 有效 critical/high/medium 退回修复与复审。

## 5. 检查点

未提交增量检查点。每波次记录：
- 起始/结束 HEAD（本任务不提交，HEAD 固定为 BASE；以 workspace diff 为交付范围）。
- `git status --porcelain` + 范围内已跟踪 diff 的文件哈希。
- 新增文件完整内容哈希。
- 检查点指纹 `CHECKPOINT.sha256`（清单：path + sha256 排序后哈希）。
- Review Package 由该清单 + diff 组成；验证与 Review 报告记录同一指纹。
- 最终 OCR 使用 workspace 模式覆盖全部未提交交付；BASE..HEAD 为空，不作为审查范围。

## 6. 验收映射（A01–A10）

A01 公共控件 HeroUI 化 + Base UI 清零 → H02/H03/H14 + 扫描证据。
A02 主题/首屏/portal token → H02 + 浏览器 computed style/截图。
A03 业务试点与各业务组 → H03–H13 + 浏览器/测试。
A04 Overlay 键盘/焦点 → H01 fixture、H03、各业务。
A05 表单/Link 语义 → H02/H03 + 交互测试。
A06 聊天编辑/附件/流式/滚动 → H10 + 既有 composer 测试。
A07 权限/付款/敏感字段 → H04/H05/H07/H08 正反向。
A08 桌面/窄屏/中英文/主题 → H02/H09/H15 截图。
A09 性能/构建 → H01 基线、H14/H15 对比。
A10 独立 Review + OCR → H15。

## 7. 验证命令（ADR 0008）

- `bun run --cwd app typecheck`、`bun run --cwd app build`。
- native：`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-19-heroui-migration/<wave>/native bunx e2e run --config e2e.unit.config.ts`。
- driven：`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=<dir> bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（执行前按清单核验前缀覆盖）。
- `bun run test:ci`（最终波次）。
- 变更文件 Biome lint/format。
- 浏览器：`bun run test:ui` 或本地 dev server + 浏览器工具；焦点/portal/IME/定位/滚动必须真实浏览器。
- 包体：同环境记录登录/聊天初始 JS gzip 与总 CSS gzip；>10% 增长需定位并评审。

## 8. 合同（不得以删功能过关）

- 真实 anchor/新标签页/组合键；无嵌套 button/a。
- Select/ComboBox 保留领域 ID、null 合同、`textValue`，不 `String()` 强转、不用 `any` 掩盖。
- Modal/Drawer/Menu 焦点、ESC、嵌套遮罩、滚动锁、关闭策略。
- 权限/租户/付款账户/金额精度/敏感字段/错误状态合同。
- IME 组合期不误发、附件生命周期、流式与滚动锚点、实时屏幕接管、根级 drop 保护。
- 保留 PromptArea/Streamdown/Recharts/Embla/@shadcn/react 问卷与消息滚动的专用行为；仅迁移其中的通用控件和动作入口。
- 独立 iframe 不假设父应用主题穿透。

## 9. 回退

回退单位 = 已验收波次（共享 UI + 样式 + lockfile 一组）。工作区未提交，回退点 = BASE `203d0f02` 或上一波次检查点指纹。重大兼容失败时停止扩散，保留证据并回退到最近已审查检查点。
