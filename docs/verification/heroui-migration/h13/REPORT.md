# H13 (#456) — 组件画廊与市场交互迁移、生成内容适配（REPORT）

状态：implemented（workspace 增量，无 commit）；BASE `203d0f0244b2`，分支 `feat/heroui-v3-migration`。
工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`。
检查点产物：`POST-CHECKPOINT.sha256`（本轮 3 个改动文件终态 sha256）；全量 native 证据 `native/report.json`（**修正 W3C-F1**：runner 实际 exitCode=1——存在 3 个域外失败；本报告此前两处误记 exit 0，计数与归因本身经 W3C 复审核实无误，E2E_UNIT_OUTPUT 落盘）。

## 域起点事实（决定本轮 delta 形态）

业务域在 H02–H06 波已消费 HeroUI 化 `ui/*`，本轮按预期 **verify-and-fix**：

- 全域 grep `@base-ui`/`@radix-ui`：0 命中（gallery/*、market/*、component-preview.tsx、5 个路由）。
- 早期波已有未提交改动（本轮逐一复核、零追加）：`gallery/table.tsx`（bg-muted→ob-muted-surface token 3 处）、`market/{connectors,experts,skills}-pane.tsx`+`market/wb.tsx`（`Button render={<Link>}`→`ButtonLink` 共 10 处，`WbPrimaryLink`/`WbPrimaryButton`/`WbSecondaryButton` 改签名 `ButtonProps`/`ButtonLinkProps`）、`admin/components/$name.tsx` 与 `settings/components-gallery/$name.tsx`（ButtonLink + token）。这些文件本轮**不再改动**，哈希即现状（见 `git diff 203d0f02`）。
- 裸原生控件盘点（gallery/* 实际输入与动作，即 h13 实施任务 #1）：`gallery/form.tsx` 原生 `<select>`（1 处）、`gallery/decisions.tsx` ApprovalCard 原生 note `<input>`（1 处）。ChoiceCard 选项行 `<button>`、table 排序 `<button>`、market WB chips/tabs 属列表行/装饰组合，非表单控件（H06 同类裁定：不属替换对象）。

本轮改动 = **2 个源文件的控件迁移（Select 域值合同 + HeroUI 控件主题）+ 1 个测试文件的驱动方式适配（已知名红修复）**。

## 变更清单（本轮 3 文件，终态 sha256 见 POST-CHECKPOINT.sha256）

| 文件 | 变更 | 要点 |
| --- | --- | --- |
| `app/src/components/gallery/form.tsx` | 原生 `<select>` → `ui/Select` | `Select/SelectTrigger/SelectValue/SelectContent/SelectItem`（`:350-375`）：`value={values.get(field.id) || null}`（无 String() 强转、无 any）；`onValueChange` null =「未选择/关闭弹层」直接丢弃，保持已存答案（与 H05/H06 同一 null 语义约定 `:352-356`）；`SelectValue placeholder` 承接原「Choose an option」空选项；label 经 `htmlFor`+trigger `id`（`:364`）关联，`aria-invalid`/`aria-describedby` 上 trigger（`:360-362`）。错误聚焦路径从 `form.elements.namedItem` 改为 `document.getElementById`（prefix+fieldId）（`:231-236`）——RAC Select 不在 form 内落 name 元素，而本表单三种控件（Input/Textarea/SelectTrigger）都携带字段 id，聚焦行为对全部字段类型保持。badInput 检查仍走 `form.elements.namedItem`（number 的 RAC Input 是真 input，`:190`）。 |
| `app/src/components/gallery/decisions.tsx` | 原生 note `<input>` → `ui/Input` | 删除手写样式 `rounded-md border border-border bg-transparent px-3 py-1.5 text-sm`，改 `className="w-full"`（`:105-112`）；`value`/`onChange`(native event)/`disabled`/`aria-label`/`placeholder` 原样透传，H02 的 field 中性化样式接管视觉。发送中 disabled、note.trim() 进同一 answer 的合同不变。 |
| `app/tests/gallery-components.test.tsx` | 已知名红修复 + Select 驱动适配 | (1) 4 处 `user.clear` → `clearField`（Backspace 键链，`:80-83`，why-comment 在案）——根因：RAC 受控 Input 不处理 `user.clear`/`fireEvent.change` 的合成 input 事件，受控值在下次渲染复活（本红呈现为 email 追加成合法地址故无错可报、seats 复活成 "321"）；与 H06 bot-setup/composing-enter 同一单变量定因。(2) select 驱动改 click trigger（`getByRole("button", { name: "Priority" })`，可访问名来自外部 label）+ click option（`:97-98`），与 learning-admin/bot-memory 惯例一致。(3) biome safe fix：import 块 organizeImports+format（同命令对 BASE 版本得到完全相同 2 条 → 既有噪声，顺手清零）。 |

不改动（越权清单均未触碰）：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`tests/preload.ts`、`tests/heroui-spike.test.tsx`（只读检视）、H03–H12 已改文件；H09（sidebar/auth/sign/tenant）与 H12（ai-observability/runs/evaluations）域零接触。

## 已知名红处置（BRIEF 指定项）

- **`gallery-components` 表单红（h02/form-primitives/report.json 落本域）→ FIXED**。修复前定向复跑：1 failed / 7 passed（`required and typed fields keep the form pending until corrected`，email 断言 `:135`）；修复后 8/8（定向会话输出 + 全量 native report.json 内 8 passed / 0 failed）。根因单变量：同一测试在 H02 Input 换 RAC 后对 `user.clear` 失效（H06 已探针证实复活机制），非本域逻辑缺陷；本轮以真键击路径修复。
- **pre-existing 勿追项本轮实测**：zz-probe-context-menu 1 红 + `h10-scratch-menu` 1 红（同名 touch-long-press 用例，两文件均未跟踪 scratch/probe，失败于自身测试代码 bug `Assignment to constant variable`，Ledger 记 zz-probe 为既有真回归）；heroui-spike 3 红（**隔离条件性口径**，W3C F2：隔离 12/15 = TextArea + 2 Modal ESC；其自录全量 native 产物中该套件 14/15 仅 TextArea 红——两条 Modal ESC 只在隔离运行复现，见 F3 节）。均不在本轮改动面。

## W3A 转办 F3：heroui-spike 排除清单条目 + TextArea import-order 约束复核

**结论：不存在任何层清单条目；h04 的「两侧都不可运行」声明已过时；import-order 理论被本轮实测否定。**

1. **native 层**：`docs/verification/e2e-known-broken.json` `entries: []` 且与 BASE 字节一致（`git diff 203d0f02 -- …known-broken.json` 为空）；`e2e.unit.config.ts` 无 heroui-spike 引用。该套件（`app/tests/heroui-spike.test.tsx`，未跟踪）**可收集且实际运行**：本轮定向（隔离）跑 15 tests（12 pass / 3 fail），全量 native 亦收集并计入 1002（同套件在全量上下文 14 pass / 1 fail——红数是隔离条件性的，W3C F2 口径）。h04 REPORT「native 排除清单内…两侧都未被收集」与 W3A「excluded on both layers」对现状失实——无清单可「仍被正当化」，事实就是没有排除。
2. **driven 层缺席是正当的**：`e2e-bun-suites.json` 只收 Bun 运行时依赖者（ADR 0008：bun:sqlite/Bun is not defined/加载器行为等根因）；heroui-spike 是 e2e-compat 原生套件、零 Bun 依赖，不在 driven 清单正是分层制的正确状态，无需 Interface 变更申请。
3. **TextArea import-order 约束（preload 旧注释理论）被否定**：fix-round-1 后 preload 已是 react-dom 先于任何 happy-dom 窗口求值（`preload.ts` warm 在首个 register 之前）。本轮在该顺序下 TextArea 用例仍红（`expected 0 to be 2`，`fireEvent.change` 合成事件零次 onChange）——单变量对照：若 import-order 是因，react-first 应已转绿；仍红说明真因是 RAC 受控 TextArea 不处理合成 change（与 `user.clear` 同族，H06 探针记录）。该套件是 H02 交付物（本轮只读），其修复（改真键击驱动）与 2 个 Modal ESC 红归 H02/H01 域；原约束「React 先于 HeroUI 求值影响 textarea onChange」应按此改写，现行 preload.ts 已无该注释，无文件需要回改。

## AC 状态

### AC1 画廊列表、详情、预览表单/表格和市场现有筛选/详情/动作可用；不新增未批准市场能力 — PASS（组件/单元级）

- 画廊表单/表格：gallery-components 8/8（表格双向排序+aria-sort、空表拒收、必填/类型校验 pending、失败重试不重复提交、完成态只读回显、畸形 spec 无活动字段、注册导出合同、畸形参数释放挂起 run）；本轮 Select 迁移后同一合同逐条过（answer values `priority: "This month"` 原值流经 RAC key 往返，无字符串化）。
- 画廊列表/详情/预览：component-preview 4/4（driven）——published 源只进 SDK 沙箱边界（html/css/js+sample args 逐项断言）、未发布不渲染、只读画廊不 fetch 管理员草稿、compiled 预览用真组件且不 fetch 沙箱源；index 磁贴 `aria-hidden+inert` 缩放预览（component-preview.tsx:145-221）。
- 市场：本轮零改动；早期波 ButtonLink 迁移经本轮复读核验（connectors/experts/skills pane 与 wb.tsx 的 10 处替换等价：`to/params/search` 直传，无嵌套 button>a、无 `role=button` anchor）；筛选（tab/搜索/分类/已安装）、详情 Dialog、install/uninstall 动作面与 BASE 同构（admin/market.tsx 结构未动）；无新增市场能力（diff 仅连接件壳替换）。
- 测试面：native 全量 `gallery-components` 8 passed、`component-preview` 经 driven 4/4；市场无测试文件（BASE 亦无），编译级由 typecheck/build 承担。

### AC2 应用内 gallery 控件遵循 HeroUI 主题；原生表格/图表按必要性保留 — PASS

- 迁移实际输入与动作：form select → `ui/Select`（HeroUI/RAC，trigger 视觉与原手写类同语言：rounded-lg/h-9/focus ring-3，密度不变）；ApprovalCard note → `ui/Input`。加上前波已迁的 `ui/Button`（activity/decisions/form 提交与动作钮）、`ui/Textarea`，gallery 控件现全部走 HeroUI 化 `ui/*`。
- 按必要性保留（AC2 明示 carve-out，非强制重写）：`gallery/table.tsx` 原生 `<table>`+排序钮（`aria-sort`/region 滚动合同有测试背书）；`gallery/charts.tsx` 原生 SVG（bar/pie/line/area/progress，纯绘制无输入）；`gallery/decisions.tsx` ChoiceCard 选项行 `<button>` 与 `table.tsx` 排序钮为列表行组合（H06 同类裁定不属表单控件）；market WB chips/tabs/搜索框为 WorkBuddy 视觉合同面（wb.tsx:7-15 明文视觉合同来自 WorkBuddy v5.7.7、以 app 主题 token 表达），market 非画廊、其密度合同（WorkBuddy density unchanged）优先。

### AC3 sandboxed generated UI 与 Craft 模板为独立文档/代码，不导入父应用 HeroUI、不读 CSS token — PASS（隔离事实保持，零改动）

- 事实陈述在案：`lib/copilot/generative-ui.ts:13-24`——生成界面渲染在 sandboxed iframe、无 same-origin 访问：cannot reach the stylesheet, the theme class, or the CSS custom properties，故颜色必须字面量给出；`prefers-color-scheme` 是唯一能穿过的信号（iframe 看不到 app 主题开关）。
- 边界实测背书：component-preview 4/4 中 sandboxed 用例断言 published html/css/js **只**经 `OpenGenerativeUIActivityRenderer`（SDK 沙箱）这一条边界进入，且外层 `inert+aria-hidden`（component-preview.tsx:145-198）；compiled gallery 组件是**应用内 React**（同文档、可 import `ui/*`）——与沙箱生成 UI 是两条互不越界的路径，测试逐条锁死（compiled 不 fetch、sandboxed 不编译）。
- 本轮及全迁移波均未给 gallery 组件添加任何「可被沙箱复用」的假设；Craft 模板通道本轮零接触，其独立文档/代码性质未被触碰。

### AC4 generative UI guidance 与本次主题相关变更有对比证据；不扩展数据权限/执行能力 — PASS（对比证据：零迁移相关漂移）

- 逐值对比（`git show 203d0f02:app/src/styles.css` vs `app/src/styles/tokens.css`）：调色板**数值零变化**——light `#ffffff/#171717/#f2f2f2/#5c5c5c/#ebebeb/#b42c3f/#0a7d47`、dark `#141414/#222222/#f2f2f2/#a1a1a1/rgba(255,255,255,0.12)/#f09595/#5dcaa5`，H02/H03 波只做**改名**（`--muted`→`--ob-muted-surface` 等语义解歧）。因此 `generative-ui.ts` **无需迁移相关校准，本轮零改动**（`git diff 203d0f02 -- generative-ui.ts` 为空）。
- 权限/能力面：guidance 只描述绘制规范（调色板/字体/形状/沙箱机制/数据诚实），本轮未改且无任何数据权限或执行能力扩展；gallery-tools 的 grant/refusal 逻辑本轮零接触。

## 验证命令与 exit code（全部实跑；测试经 ADR 0008 分层）

| 命令 | 结果 |
| --- | --- |
| `cd app && bun run typecheck` | **EXIT 0** |
| `cd app && bun run build` | **EXIT 0**（chunk>500kB 警告为既有） |
| native 域内定向（修复前基线）`E2E_UNIT_OUTPUT=…/probe bunx e2e run --config e2e.unit.config.ts app/tests/gallery-components.test.tsx` | 1 failed / 7 passed（已知红复现；探针产物按规已清，账目在此） |
| native 域内定向（修复后，同命令） | **8 passed / 0 failed**，exit 0（含 biome 整理后复跑） |
| native 全量（仓库根）`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h13/native bunx e2e run --config e2e.unit.config.ts` | **exit 1（修正 W3C-F1，原误记 exit 0）；131 files / 1002 tests：999 pass / 3 fail**（3 红全部域外，见上节归因；gallery-components 8/8 在 report.json 内）。注：`E2E_UNIT_OUTPUT` 指向仓库外目录会被 runner 拒绝（INVALID_CONFIG），须在项目根内 |
| driven 层 `cd app && bun test tests/component-preview.test.tsx` | **EXIT 0**，4 pass / 0 fail（本轮域内唯一 driven 套件，bun-test-compat 层） |
| `bunx biome check` 3 个改动文件 | **EXIT 0**（test 文件 2 条 BASE 同在的 organizeImports/format 既有噪声已顺手 safe-fix 清零；源文件零诊断） |

已知 stderr 噪声（如实记录）：修复后 native 运行 gallery-components 打印 18 条 `The current testing environment is not configured to support act(...)`。已取证为 react-aria 内部更新落在 RTL `asyncWrapper` 的 `IS_REACT_ACT_ENVIRONMENT=false` 窗口外（调用栈：react-aria `Document.ts queueUpdate`（RAC 集合注册表，弹层开/关）与 `useHover triggerHoverEnd`）；BASE 版本（无 RAC 弹层交互）为 0 条。act 包裹试验（38 条）反而更糟——`asyncWrapper` 反转使包裹无法消除。属 harness 级噪声：用例确定性 8/8、exit 0，记录为 H14/H15 测试基建清扫项，不在测试文件里垫抑制补丁。

## 遗留 / 移交

1. **generative-ui.ts 字面量色板与 app 真实色板不符（pre-BASE 既有，非迁移引入）**：prompt 写 light bg `#fafafa`/text `#0a0a0a`/muted `#636363`/border `#e5e5e5`、accents `#e7000b/#009689`（dark `#0a0a0a/#171717/#fafafa/#a1a1a1/…/#ff6467/#00bba7`），而 app 自 BASE 起就是 `#ffffff/#171717/#5c5c5c/#ebebeb`、`#b42c3f/#0a7d47`（HEAD tokens.css 同值）。BRIEF 只授权「迁移直接相关的描述校准」，此漂移先于迁移存在 → **记录为后续项**，不在本轮改。若后续校准，AC3 的隔离陈述与「prefers-color-scheme 是唯一信号」两段须原样保留。
2. **heroui-spike 3 红（H02/H01 域，文件本轮只读）**：TextArea 合成 change 需改真键击驱动；2 个 Modal ESC 用例针对**裸 `@heroui/react` Modal**（app 内 dialog 走 ui/dialog 守卫 v3，CDP 证据链独立有效），raw HeroUI Modal 在 happy-dom 的 ESC/onOpenChange 行为归 H01 spike 范畴处置或明确豁免理由。**H14 处置回执**：TextArea 已按 H06/H13 真键击模式修复（隔离 13/15）；2 条 Modal ESC 红确认为隔离条件性（全量 native 上下文通过，W3C F2 + H14 spike-isolated 复跑同谱），生产 dialog 不走此路径，保持记录不视为产品回归。
3. **act 环境噪声 18 条**（见上）→ H14/H15 测试基建项（方向：native 层为 RAC 弹层交互统一 act 策略，或 harness 级配置 `IS_REACT_ACT_ENVIRONMENT`）。
4. **zz-probe/h10-scratch-menu touch-long-press 红**：未跟踪 scratch 文件自身 bug（`Assignment to constant variable`）+ 既有真回归，归探针所有者，非本域。
5. 浏览器级证据（真实点击 Select 弹层、WorkBuddy 市场视觉、gallery 磁贴缩放）按 BRIEF 分工归 frontend_validator；本轮未引入 portal/focus/滚动自定义逻辑（Select 弹层 portal 由 H03 冻结 wrapper 承担，其浏览器证据链在 h01/h03）。
