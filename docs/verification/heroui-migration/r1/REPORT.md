# Wave R1 — Visual redesign to HeroUI native baseline (issue #502)

日期：2026-10-20。范围：迁移交付后的视觉基线切换。用户裁决（预览 v2 即视觉规范）：整库从
WorkBuddy 保留配色切换到 HeroUI 原生默认主题。交付方式：未提交工作树（不 commit/push）。

## 1. Changed files + rationale

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `app/src/styles/tokens.css` | 全量重写 `--ob-*` 值（light `:root` + `.dark`）；保留全部 token 名、结构与注释风格 | token 架构使换肤成为纯值替换；新值逐条取自 ground truth `@heroui/styles/dist/themes/default/variables.css`（含 color-mix 公式）。品牌青绿退役，brand/action/focus/chart-1 统一为 accent `oklch(0.6204 0.195 253.83)`；radius 0.6rem→0.5rem；阴影取 HeroUI surface-shadow（dark 透明）。头部注释更新为新基线（2026-10-20 用户裁决，#502）与"两文件换肤"原理 |
| `app/src/styles.css` | ob-app 层 `html { font-size: 15px→16px }`；相邻 Display-tier 注释同步（20px→21.3px @16px root） | 决策第 3 条。无其他改动；CJK 字体栈、@layer 架构、reduced-motion 分支原样保留 |
| `app/src/styles/heroui-theme.css` | 桥接收敛：删除全部 28 组映射/覆写，文件从 179 行减到 ~40 行，仅存头注释 + 空 `ob-theme` 层 | 逐条判定：ob 值 == HeroUI 默认 → 删除让库默认原生流动；纯 WorkBuddy 视觉（黑/白 action、backdrop 色阶、pulse skeleton、灰阶 scrollbar、`.ob-checkbox`/`.ob-switch` 几何+青绿 ON 色、H14 dark OFF 补丁）→ 退役。处置表见 §2。层保留为未来结构性覆写的唯一住址 |
| `app/src/styles/legacy-ui-bridge.css` | 仅更新一处头注释（声明来源从 `heroui-theme.css` 改为 HeroUI base 默认）；别名零改动 | 别名全部指向 `--ob-*`，随 token 自动换值；文件内无任何 WorkBuddy 硬编码 hex（grep 证实） |
| `app/DESIGN.md` | front-matter 色板/组件注记改写为新值（含 oklch 注释与 hex 近似）；Overview/Colors/Typography/Shapes/Components/Do-Don'ts 全部改写为新方向，标注 2026-10-20 + #502 及"取代 WorkBuddy 保留方向" | 决策第 4 条。rem 尺寸与布局合同不变；px 等值按 16px root 重算 |
| `docs/specs/2026-10-19-heroui-ui-migration-design.md` | 追加 §11 日期修订（不重写历史） | 决策第 5 条：视觉基线交付后切换为 HeroUI 原生，记录用户裁决与影响面 |
| `docs/verification/heroui-migration/r1/browser/cdp-r1.mjs` | 新建：12 张截图矩阵 + computed-style 断言 + WCAG 对比度测量 | 决策要求的浏览器 QA 证据；沿用 h15 CDP 模式（cookie + localStorage 预置），复制到 /tmp/cdp-harness 运行 |

业务组件、路由、测试文件：零改动（本波触碰仅上表 7 文件 + 截图/报告产物）。

## 2. Bridge-convergence disposition table（28 removed / 0 kept）

旧 `heroui-theme.css` 每条覆写的处置：

| # | 覆写（旧） | 处置 | 理由 |
| --- | --- | --- | --- |
| 1 | `--background` / `--foreground` | removed | ob-canvas/eclipse == HeroUI 默认 |
| 2 | `--surface` / `--surface-foreground` | removed | == 默认 white/eclipse |
| 3 | `--surface-secondary` | removed | == 默认 oklch(0.9524 0.0013 286.37) |
| 4 | `--surface-tertiary` (+fg) | removed | 旧映射把 tertiary 压成 WorkBuddy 灰阶 0.9524；原生 0.9373 是新基线 |
| 5 | `--overlay` / `--overlay-foreground` | removed | == 默认 |
| 6 | `--muted`（静音文字） | removed | == 默认 oklch(0.5517…) |
| 7 | `--accent` / `--accent-foreground` / `--accent-hover` | removed | == 默认 accent 蓝；黑/白 action 映射即被退役的 WorkBuddy 选择 |
| 8 | `--accent-soft-foreground` | removed | WorkBuddy 灰 soft ink；原生为 accent 染色 soft ink |
| 9 | `--link` | removed | 原生 `--link: var(--foreground)`；"无蓝链接"是 WorkBuddy 选择 |
| 10 | `--default` / `--default-foreground` | removed | == 默认 oklch(94%…)/eclipse |
| 11 | `--field-background` / `--field-foreground` / `--field-placeholder` | removed | == 默认（白底 field） |
| 12 | `--field-border` | removed | == 默认 transparent |
| 13 | `--field-border-width` | removed | 原生 0（field 由填充定义）；1px 是 WorkBuddy 描边 |
| 14 | `--border-width` | removed | == 默认 1px |
| 15 | `--border` | removed | == 默认 oklch(90% 0.004 286.32) |
| 16 | `--separator` | removed | 原生 92%（旧映射成 90% border） |
| 17 | `--focus` | removed | == 默认 accent（旧为黑） |
| 18 | `--ring-offset-width` | removed | == 默认 2px |
| 19 | `--danger` / `--danger-foreground` / `--danger-soft` | removed | == 默认（soft 公式 15%） |
| 20 | `--success` / `--success-foreground` | removed | == 默认（eclipse 墨，旧为白字压浅绿） |
| 21 | `--radius` / `--field-radius` | removed | ob radius 新值 0.5rem == 默认；field-radius 原生 ×1.5 |
| 22 | `--disabled-opacity` | removed | == 默认 0.5 |
| 23 | `--skeleton-animation` | removed | 原生 shimmer；pulse 是 WorkBuddy 动效口味 |
| 24 | `--scrollbar-thumb` / `--scrollbar-track` / `--scrollbar-color` | removed | 原生 foreground-15% 混合公式 |
| 25 | `--backdrop`（含 `.dark` 块） | removed | 原生 rgba(0,0,0,.5)/.6（旧 .5/.70 即要退役的 scrim 色阶） |
| 26 | `.ob-checkbox` 几何+颜色块 | removed | 原生 checkbox 选中即 accent 填充 + snow 墨；WorkBuddy 16px/4px/青绿覆写退役，wrapper 类成惰性标记 |
| 27 | `.ob-switch` 几何+颜色块 | removed | 原生 switch ON 即 accent 轨 + snow 拇指；32×18.4 定制退役 |
| 28 | `.dark .ob-switch` OFF 态补丁（H14） | removed | 该补丁只服务被删除的 WorkBuddy 深色 OFF 样式；原生 dark OFF（default 轨 + 白拇指）无缺口 |

无 portal z-index 或行为类覆写存在于旧文件，故无 "kept" 项。

## 3. Contrast table（WCAG，浏览器实测 + 计算复核）

| 对 | 亮 | 暗 | 判定 |
| --- | --- | --- | --- |
| 正文（eclipse/snow）on canvas | **16.25** | **19.79** | PASS（≥4.5） |
| Snow on accent（按钮文字，正文尺寸） | **3.59** | **3.59** | <4.5 —— **库默认取舍**：HeroUI 官方 accent/foreground 配对，按任务要求原样保留并记录，未擅改 accent |
| Accent on white（非文本/图表下限） | **3.68** | — | PASS（≥3） |
| Accent on dark surface（非文本） | — | **4.81** | PASS（≥3） |
| Muted text on surface（实测取样） | **4.43**（画布底）/ 4.83（白卡底） | **7.72** | 画布底 4.43 为 HeroUI 自身 muted/background 配对的近似贴线值，按库基线保留（白卡底达标） |
| 库基线备忘 | danger on white 3.57；snow on danger 3.48 | danger on dark 3.97 | 亦为 HeroUI 默认配对，同上保留 |

### Chart palette（新五色，各对所在主题底色 ≥3:1，全部在 sRGB gamut 内）

| Token | 亮（vs 白卡） | 暗（vs dark surface oklch(0.2103…)） | 色相 |
| --- | --- | --- | --- |
| chart-1 `oklch(0.6204 0.195 253.83)` | 3.68 | 4.81 | accent 蓝本体 |
| chart-2 `oklch(0.62 0.15 55)` / dark `oklch(0.78 0.14 70)` | 3.83 | 8.64 | 琥珀 |
| chart-3 `oklch(0.55 0.15 150)` / dark `oklch(0.75 0.16 150)` | 4.54 | 8.47 | 绿（success 族） |
| chart-4 `oklch(0.55 0.22 300)` / dark `oklch(0.70 0.18 300)` | 5.41 | 6.19 | 紫 |
| chart-5 `oklch(0.58 0.22 340)` / dark `oklch(0.70 0.19 340)` | 4.84 | 6.04 | 玫红 |

设计原则：chart-1 即 accent（品牌统一）；其余四相异色相保证系列可分（未做五蓝）。亮色对画布
`oklch(0.9702 0 0)` 复核：3.38 / 3.51 / 4.16 / 4.97 / 4.44，全部 ≥3。

## 4. Screenshot manifest（12 张，`docs/verification/heroui-migration/r1/screenshots/`）

| 页面 | light-zh | light-en | dark-zh | dark-en |
| --- | --- | --- | --- | --- |
| home `/` | r1-home-light-zh-1440.png | r1-home-light-en-1440.png | r1-home-dark-zh-1440.png | r1-home-dark-en-1440.png |
| model-access `/settings/model-access` | r1-model-access-light-zh-1440.png | r1-model-access-light-en-1440.png | r1-model-access-dark-zh-1440.png | r1-model-access-dark-en-1440.png |
| admin-gateway `/admin/gateway` | r1-admin-gateway-light-zh-1440.png | r1-admin-gateway-light-en-1440.png | r1-admin-gateway-dark-zh-1440.png | r1-admin-gateway-dark-en-1440.png |

CDP computed-style 断言（`browser/cdp-r1.mjs`，26/26 PASS）：root font-size 16px；`--ob-action`/`--ob-brand`/`--ob-focus` == `oklch(0.6204 0.195 253.83)`；主按钮填充 == `oklch(0.6204 0.195 253.83)`、文字 == `oklch(0.9911 0 0)`；body 背景 == canvas；`--ob-canvas`/`--ob-border` == 新阶梯；`--ob-radius` == 0.5rem；交互元素采样（按钮/链接/input/switch/checkbox 的 bg/color/border/outline，含 rgb()/oklch() 两种序列化）中 **零** WorkBuddy 青（#00c29a / #3dd9b6）**零** 旧黑主按钮填充（#171717）。

## 5. Exit codes（真实值）

| 命令 | Exit | 备注 |
| --- | --- | --- |
| `cd app && bun run typecheck` | **0** | |
| `cd app && bun run build` | **0** | vite build ✓（chunk 体积警告为 BASE 既有） |
| `bunx e2e run --config e2e.unit.config.ts app/tests/theme-preference.test.ts app/tests/heroui-spike.test.tsx` | **1**（21 pass / 2 fail） | 2 失败为 **已知既有** 的 H01 Modal ESC 隔离条件红（"is controlled by isOpen and emits onOpenChange on ESC" + "nests a second dialog and closes only the top layer on ESC"），与 BACKLOG-H14-H15.md F2 / LEDGER W3C-F2 记录的 "TextArea+2 Modal ESC" 同族同签名；spike 走 happy-dom，不加载 app CSS（preload.ts 无 styles 导入，import 图与本次改动零交集），**非本波引入，亦非颜色断言，故不改测试**。theme-preference.test.ts 单文件 PASS |
| `bunx biome check <4 个改动样式文件>` | **0** | 曾报 tokens.css 1 条格式化，已 `--write` 修复后复检干净 |
| WorkBuddy hex 残留 grep（styles/ + styles.css） | 无命中 | 00c29a / 3dd9b6 / #171717 / #f2f2f2 / #f4f5f5 / #ebebeb / #d9d9d9 / #b42c3f / #0a7d47 零残留 |
| `node cdp-r1.mjs`（浏览器 QA） | **0**（26 PASS / 0 FAIL） | |

## 6. Leftovers / watch items

1. **Snow-on-accent 3.59:1**（正文尺寸 <4.5）：库默认取舍，已按指示记录，未改 accent。若后续要达标，需用户层面的 accent 决策（非本波权限）。
2. **Muted text 4.43:1 on 画布**（白卡 4.83）：HeroUI muted/background 配对的贴线值，保留库基线。
3. **`--input` → `--ob-field-border` = transparent**：`border-input` 现解析为透明。HeroUI 原生控件不受影响（本来就是无描边填充），但仍有 21 处 `border-input` 用法（questionnaire 选择框指示器、craft 面板等）中"借 field 槽画可见边界"的调用点在亮色下失去描边——组件文件本波禁改，列为下一波组件级复核项（语义上应迁到 `--ob-border`）。
4. **原生 dark switch OFF 拇指为白**（HeroUI 组件无 `.dark` 覆写）：即库原生外观，截图可见；如需调整属上游/后续决策。
5. heroui-spike 2 条 Modal ESC 红为既有隔离条件失败（见 §5），归 H02/H01 域既有清单，非本波范围。

## 7. Contracts kept

- CJK 字体栈逐字未动（Inter Variable + PingFang SC + HarmonyOS Sans SC + Microsoft YaHei + 回退）。
- 组件/路由/测试文件零改动；`@layer` 架构原样（theme→base→components→utilities→ob-tokens→ob-theme→ob-legacy→ob-app），无新增未分层规则；reduced-motion 行为不变（tool-line 分支未触碰）。

---

## R1b — 单项修复：`--input` 别名与 field-border 拆分（2026-10-20，R1 §6.3 遗留收口）

### 修复内容（token 级，组件零改动）

R1 把 `--input` 别名到 `--ob-field-border`（transparent，对 HeroUI 无描边填充 field 是正确的），
但 `border-input` 背后的映射链（`--color-input: var(--input)`，styles.css:113）把 21 处把它当
**可见描边**用的调用点一并静音——shadcn 词汇里 `--input` 本义是"输入框描边"，亮色描边因此全部
消失，暗色的 `dark:border-input` 与 `bg-input/30` 淡填充同样不可见。R1b 在别名处拆开两个消费者：

- `app/src/styles/legacy-ui-bridge.css`：`--input: var(--ob-field-border)` →
  `--input: var(--ob-border)`（border 阶梯：light `oklch(90% 0.004 286.32)` = HeroUI `--border`，
  dark `oklch(28% 0.006 286.033)`），并附 why 注释写明两槽语义（输入描边 vs field 填充边界）。
- `app/src/styles/tokens.css`：Boundaries 组注释补一句——legacy `--input` 故意走 `--ob-border`
  而非 `--ob-field-border`，防止被"修回去"。
- HeroUI 原生 field 链原样不动：`--ob-field-border: transparent`、`--field-border: transparent`、
  `--border-width-field: 0px`（浏览器断言在两主题验证均未变）。

这比 R1 §6.3 预想的"组件级迁移"更小：一处别名修正同时修复全部 21 个调用点，无需触碰组件。

### `border-input` 调用点清单与分类（21 处 / 15 文件，全部是"本来就要可见描边"）

| 文件:行 | 用法 | 分类 |
| --- | --- | --- |
| `ui/input.tsx:25` | 输入框描边 + `dark:bg-input/30`、`disabled:bg-input/50` | 可见描边（+暗色淡填充） |
| `ui/textarea.tsx:21` | 同上 | 可见描边 |
| `ui/select.tsx:522` | 触发器描边 + `dark:bg-input/30`、`dark:hover:bg-input/50` | 可见描边 |
| `ui/checkbox.tsx:89` | 指示器盒描边 | 可见描边 |
| `ui/combobox.tsx:119` | 触发器描边 | 可见描边 |
| `ui/combobox.tsx:143` | 多选模式 `border-b` | 可见描边 |
| `ui/input-group.tsx:14` | 组描边 + `has-disabled:bg-input/50` | 可见描边 |
| `ui/questionnaire.tsx:107` | 选择卡描边 + `dark:bg-input/20` | 可见描边 |
| `ui/questionnaire.tsx:120` | 选择指示器圈（R1 发现的例证） | 可见描边 |
| `ui/questionnaire.tsx:139` | 快捷键小徽标描边 | 可见描边 |
| `ui/questionnaire.tsx:170` | 文本输入描边 | 可见描边 |
| `ui/button.tsx:25` | outline 暗色 `dark:border-input` + `dark:bg-input/30`（亮色是 `border-border`） | 可见描边 |
| `craft/composer.tsx:122` | 输入区描边 | 可见描边 |
| `craft/chat-panel.tsx:246` | `hover:border-input` 悬停描边 | 可见描边 |
| `craft/output-panel/preview-tab.tsx:231` | `border-dashed` 落区 | 可见描边 |
| `craft/output-panel/artifacts-tab.tsx:76,85` | 小按钮描边 | 可见描边 |
| `ai-observability/experiments-section.tsx:294,318` | 原生 select 仿制描边 | 可见描边 |
| `billing/admin-credit-grant.tsx:185` | 原生 input 仿制描边 | 可见描边 |
| `channels/workshop-artifacts.tsx:107` | 小按钮描边 | 可见描边 |

分类结论：21/21 在 shadcn 语义里就是描边槽，R1 的透明渲染对每一处都是意外而非意图——
**没有调用点故意依赖透明**。其中 6 个 ui/ 包装（input/textarea/select/combobox/input-group/
questionnaire）此前在亮色"恰好"无描边、观感贴近 HeroUI filled field；修复后呈 HeroUI bordered
变体观感（1px hairline + 透明填充，暗色加 `input/30` 淡底），与库的 bordered-variant 一致。
若后续想让这些包装回到 filled（无描边），应逐组件改用 `--ob-field-border`/去掉 `border-input`
类，而不是再动 `--input` 别名。

### button outline / select trigger 复核

- `ui/button.tsx` outline：亮色 `border-border`（一直可见），暗色 `dark:border-input`（修复前
  不可见）。修复后两主题 computed border-color == hairline（浏览器断言 PASS ×2）。
- `ui/select.tsx` 触发器（`border border-input`）：修复后两主题 computed border-color ==
  hairline（`/settings/invoices` 实测 PASS ×2）。两处经 border 阶梯与 HeroUI bordered 变体观感
  对齐。

### 浏览器证据（`browser/cdp-r1b.mjs`，20 PASS / 0 FAIL，exit 0）

- 截图（`screenshots/`）：`r1b-invoices-light-zh-1440.png`、`r1b-invoices-dark-zh-1440.png`
  （含 select 触发器）、`r1b-questionnaire-light-zh-1440.png`、`r1b-questionnaire-dark-zh-1440.png`
  （`/bots?new=true` 新建向导：step 0 含 outline"取消"按钮 + app Input，step 1 visibility 含
  选择卡与指示器圈）。
- 断言（两主题各 10 条）：`--input` == `--ob-border`（亮 `oklch(90% 0.004 286.32)` / 暗
  `oklch(28% 0.006 286.033)`）且 == `--border`；`--ob-field-border`/`--field-border` 仍
  transparent；`--border-width-field` 仍 0px 且合成 `.input` 元素 computed border-top-width
  0px（原生 field 依旧无描边）；select 触发器、outline 按钮、app Input、questionnaire 未选中
  选择卡、选择指示器圈的 computed border-color 全部 == `--input` hairline。

### Exit codes（真实值）

| 命令 | Exit | 备注 |
| --- | --- | --- |
| `cd app && bun run typecheck` | **0** | |
| `cd app && bun run build` | **0** | vite build ✓（chunk 体积警告为既有） |
| `bunx biome check src/styles/legacy-ui-bridge.css src/styles/tokens.css` | **0** | |
| `bunx biome check docs/verification/heroui-migration/r1/browser/cdp-r1b.mjs` | **0** | 3 条 unsafe-fix info（与 cdp-r1.mjs 同族），非 error |
| `node cdp-r1b.mjs`（在 /tmp/cdp-harness 运行） | **0** | 20 PASS / 0 FAIL |

改动文件：`app/src/styles/legacy-ui-bridge.css`、`app/src/styles/tokens.css`、
`browser/cdp-r1b.mjs`（新建）、本 REPORT 追加节、4 张 r1b 截图。组件/路由/测试仍零改动
（§7 契约维持）。
