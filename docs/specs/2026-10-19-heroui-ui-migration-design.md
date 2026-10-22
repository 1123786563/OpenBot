# OpenBot 主应用迁移 HeroUI 设计方案

状态：待评审草案；用户已要求完善详细方案并拆解创建具体 Issue，未批准实施。日期：2026-10-19。
代码取样：当前工作区，HEAD `295c0b89`；存在其他任务未提交修改，本文不把它们当作迁移交付。
本轮范围为本方案、官方研究和 Issue 拆分/发布；不安装应用依赖、不修改业务代码、不提交或部署。

## 1. 推荐决策与默认假设

推荐主应用 `app/` 迁移到 **HeroUI v3**，采用“兼容验证 → 基础设施 → 一个完整业务试点 → 分批业务迁移 → 移除旧底座”的方式。

- 默认范围：主 Web 应用，以及同一主应用在桌面 WebView 中的使用验证。独立 `desktop/` 引导程序、Git 子模块 `apps/openmuse/` 和 `bifrost/`、`server/assets/craft/web-template/` 不纳入本批组件迁移。
- 默认视觉：保留现有 WorkBuddy 方向、信息架构和密度；HeroUI 提供组件行为和基础样式，再由 OpenBot 主题统一。若用户选择整体重设计，需先补页面视觉稿和更新 `app/DESIGN.md`，工期另计。
- 框架替换指公共交互控件底座统一；不意味着替换 React、Vite、TanStack、CopilotKit、聊天编辑器、Markdown 或图表引擎。
- 全程使用 v3 文档与锁定版本；不引入 HeroUI v2 的 Provider、Tailwind 插件或组件 API。
- 实施开始前重新核验 npm 版本和 peer dependencies。研究时 `@heroui/react` 的 npm latest 为 `3.2.6`；`@heroui/styles` 单独核验兼容版本后固定，不能推定所有包版本一致。[研究记录](../research/2026-10-19-heroui-official-research.md)

用户尚未明确的两项偏好为“是否整体视觉重设计”“是否覆盖其他前端”；当前建议按以上默认值评审，不把默认值记录为用户批准。

## 2. 已核验的项目现状

### 2.1 技术与入口

| 项目 | 当前证据 | 迁移含义 |
| --- | --- | --- |
| React / React DOM | `app/package.json`：`^19.2.0` | 满足 v3 React 主版本要求；实际安装版本实施时复核 |
| Tailwind | `^4.3.3`，使用 `@tailwindcss/vite` | 已使用 v4，无需为迁移跨代升级 Tailwind |
| Vite | `^7.1.12` | 沿用既有构建和路由拆包 |
| UI 底座 | `@base-ui/react ^1.6.0`，本地 shadcn 风格封装 | 不是 Radix 项目，不能照搬 Radix 的 asChild 迁移脚本 |
| 其他 UI 依赖 | `@shadcn/react`、`shadcn`、`prompt-area`、`recharts`、`streamdown` | 按职责分别处置，不批量删除 |
| 路由 / 数据 / 表单 | TanStack Router / Query / Form | 保留业务与数据状态，仅调整控件接入 |
| 国际化 | i18next / react-i18next，已有中英文 | 应用翻译继续由既有系统负责 |
| 主题 | 自有 ThemeProvider，`openbot-theme`，html `.dark` | 延续单一主题状态，不增加第二套存储 |
| 全局样式 | `app/src/styles.css` 导入 Tailwind、shadcn、prompt-area | CSS 层顺序和变量语义是首要兼容风险 |
| 路由构建 | `app/vite.config.ts` 已划分登录、聊天、管理、设置等 chunk | 不因公共入口导入整组业务模块而破坏拆包 |

官方 v3 快速开始要求 React 19+、Tailwind 4，安装行为包与样式包，且 Tailwind 的 CSS 导入在前。v3 不要求通用 `HeroUIProvider`；Router、locale、Toast 等集成功能按需配置。[Quick Start](https://heroui.com/en/docs/react/getting-started/quick-start)、[Migration](https://heroui.com/en/docs/react/migration)

### 2.2 影响规模

静态盘点口径：`app/src` 下 `.ts/.tsx` 共 511 个文件；`routes/` 下 88 个 `.tsx` 文件，包含布局和入口，不等于 88 个独立页面；公共 `components/ui/` 共 26 个 `.tsx` 文件。

下表引用数为匹配 `from "@/components/ui/<name>"` 的不同源文件数，包含测试和公共模块；不计相对导入、动态导入，不代表实例数量或全量调用点。

| 当前文件 | 引用文件数 | 目标与处置 |
| --- | ---: | --- |
| button | 138 | HeroUI Button；链接按钮独立处理 |
| item | 72 | 保留 OpenBot 设置行组合，移除 Base UI 的渲染工具依赖 |
| separator | 69 | HeroUI Separator，或通过语义验收的原生分隔线 |
| input | 45 | HeroUI Input，保留原生输入事件和 name/ref 语义 |
| dialog | 41 | HeroUI Modal，重点验证受控状态、嵌套和焦点 |
| field | 25 | 保留业务字段组合，对接 Label / FieldError / Description |
| textarea | 21 | HeroUI TextArea；不替代聊天富文本编辑器 |
| switch | 20 | HeroUI Switch，显式转换 checked / isSelected 等契约 |
| select | 19 | HeroUI Select / ListBox，重新明确值和选项身份 |
| empty | 13 | 保留 OpenBot 空状态结构和文案 |
| skeleton | 9 | HeroUI Skeleton，保留原有占位尺寸 |
| sidebar | 5 | 保留导航模型与折叠状态，内部控件用 HeroUI，移动浮层用 Drawer |
| label | 4 | HeroUI Label，验证 label 与控件关联 |
| input-group | 4 | HeroUI InputGroup，验证按钮嵌套与 ref |
| checkbox | 4 | HeroUI Checkbox，覆盖半选、禁用和表单提交 |
| dropdown-menu | 4 | HeroUI Dropdown / Menu 内容，以锁定版实际导出为准 |
| tooltip | 3 | HeroUI Tooltip，验证触摸、键盘和延迟 |
| sheet | 2 | HeroUI Drawer，保持侧栏与非模态详情面板的区别 |
| bubble | 2 | 保留聊天气泡组合，移除 Base UI 渲染工具依赖 |
| message | 2 | 保留消息语义和排版，内部动作迁移 HeroUI |
| live-waveform | 2 | 保留音频可视化实现 |
| combobox | 1 | HeroUI ComboBox，覆盖搜索、清空、异步选项 |
| questionnaire | 1 | 暂保留 `@shadcn/react/questionnaire` 行为，审计其按钮组合兼容性 |
| message-scroller | 1 | 暂保留 `@shadcn/react/message-scroller` 行为，验证“回到底部”按钮组合 |
| context-menu | 1 | 验证 HeroUI 菜单能否满足右键定位、键盘与触摸；不满足则先完成等价 Adapter 再迁移该业务 |
| carousel | 1 | 保留 Embla，内部导航按钮迁移 HeroUI |

15 个直接导入 Base UI 的源文件均集中在 `components/ui/`，这是可利用的迁移 seam。但这些文件对外暴露了 Base UI Props 和 render 语义，不能因此假设只改封装内部就能完成迁移。

## 3. 产品行为与视觉约束

本次迁移为 Operate 场景：用户要配置 Bot、聊天、审批、管理公司和查看费用；迁移后需保持操作路径、数据归属、权限、付款和错误反馈的既有合同。

沿用 `app/DESIGN.md` 和代码证据：黑/白主按钮，青绿品牌细节，紧凑设置行，15px 根字号和 rem 尺寸，Tabler 图标，中英文排版，亮暗双主题，PageShell → PageSection → PageRows 布局。

需先记录并处理设计文档漂移：DESIGN 中部分背景、品牌勾选图标颜色、图表色和暗色卡片阴影与 `styles.css` 不同；代码已包含对比度修正。迁移不借机恢复旧值；基线截图、当前计算样式和可访问性修正应明确记录，设计文档修订另留评审差异。

以下内容不随 UI 换库改变：

- TanStack 路由身份、搜索参数和权限守卫；公司/团队选择必须继续传递原有领域值。
- 订单与付款账户归属、积分金额格式、提交幂等、权限不足拒绝状态。
- 聊天草稿、附件生命周期、输入法组合、流式消息、停止/重试、滚动锚点和屏幕接管。
- 拖文件到非接收区域时的根级防导航保护。
- 页面 loading / empty / error / permission-denied / pending / success 状态及其原有事实含义。

事实源：根 `CONTEXT.md`、[ADR 0004](../adr/0004-company-team-tenancy.md)、[已批准支付设计](2026-10-15-billing-payment-account-and-fulfillment-design.md)、[Hindsight 设计](2026-10-15-hindsight-personal-memory-design.md)。规划中的个人空间扩展不因本迁移自动成为已实施功能。

## 4. 目标结构与封装策略

```text
业务路由与功能模块（保留业务状态、校验、数据请求）
    ↓
OpenBot 公共组合与必要 Adapter
  components/ui/：应用级尺寸、视觉变体、a11y、有限兼容
  components/layout/：PageShell / PageRows / DetailPanel
    ↓
HeroUI v3（公共交互控件）
    + 保留的专用引擎（PromptArea / Streamdown / Recharts / Embla / 消息行为）

OpenBot 主题 token → HeroUI 变量与组件样式 + 专用引擎主题桥接
```

继续使用 `@/components/ui/*` 作为应用入口，不新增一个简单转发全部 HeroUI Props 的通用工厂。保留能集中隐藏真实复杂度的 Adapter：按钮变体、链接行为、弹窗结构、受控选择值、字段错误关联；简单控件可以直接再导出或采用简单样式包装。

对外类型逐步使用应用拥有的 Interface，不再导出 Base UI 类型。兼容层只覆盖实际使用的能力；复杂的 render、多态触发器和对象选项不以 `any`、任意属性透传或 cloneElement 猜测来模拟。不能等价适配的调用点，在所属业务切片显式改写并验收。

建议新增或整理的文件（仅方案，当前未创建）：

- `app/src/styles/tokens.css`：OpenBot 语义颜色、字号、间距、圆角；亮暗集中定义。
- `app/src/styles/heroui-theme.css`：HeroUI 变量和必要 BEM/状态覆写。
- `app/src/styles/legacy-ui-bridge.css`：有删除计划的旧 token/utility 过渡映射。
- `app/src/styles/vendor-ui.css`：PromptArea、Streamdown 等保留引擎的主题衔接。
- `app/src/components/ui/router-link.tsx`：如 spike 证明需要，集中 TanStack 链接与 HeroUI 样式/交互适配。
- `app/src/components/ui/overlay-policy.ts`：仅在 Modal/Drawer/Menu 确实有共享配置时提取；没有共享逻辑不创建空抽象。

### 4.1 根集成

沿用 `main.tsx` 中 QueryClientProvider 与 TanStack RouterProvider。根路由继续拥有 ThemeProvider、language sync、drop guard。按锁定版官方接口，集中为 HeroUI/React Aria 设置 locale 与路由导航集成；其 RouterProvider 与 TanStack 同名时用别名区分。

主题状态仍归 `openbot-theme`；若采用 `data-theme`，与 `.dark` 从同一状态同步，连同 `app/index.html` 的首屏预设一起修改，避免“首次绘制正确、挂载后闪色”。不引入 Next.js 专属的 next-themes。

Toast 不是现有公共 UI 文件，不能虚构 Sonner 替换任务。仅当实际业务反馈需要统一 Toast 时接入 `Toast.Provider`；阻塞错误和表单错误仍在原位置呈现，不改成会消失的 Toast。

### 4.2 主题迁移是首要技术门槛

HeroUI 使用 CSS 变量与 BEM 样式，支持集中覆写。[Theming](https://heroui.com/en/docs/react/getting-started/theming)

关键冲突：当前 `--accent` 是浅灰菜单高亮，而 HeroUI 将 accent 用于强调；同名变量不代表同一语义。`--muted`、圆角、阴影、field 相关 token 与 Tailwind `--color-*` 映射也需逐项核对。

处理步骤：

1. 先把 OpenBot 的来源值固定为 `--ob-*` 语义变量，建立 token 表；至少区分 action、brand、surface、hover-surface、muted-text、danger、focus、field、sidebar、chart。
2. 为 HeroUI 定义明确映射：强调主按钮采用 action 黑/白，菜单背景采用 surface；品牌色通过控件局部或专用 token 配置，不把所有 action 一并改成青绿。
3. 用独立的 legacy 命名空间迁移冲突 utility，例如旧背景类由 `bg-accent` / `bg-muted` 改为 `bg-ob-hover` / `bg-ob-muted-surface`。旧原始 CSS 和第三方样式依赖也一起扫描。
4. 共享且语义一致的变量可复用；冲突变量不能继续在同一根作用域同时承担两种含义。第三方旧 CSS 若必须使用旧名称，只在受控容器局部桥接，并验证其浮层 portal；不得让局部旧 token 覆盖 HeroUI 子控件。
5. 固定 CSS layer 与 import 顺序：Tailwind 先于 HeroUI；OpenBot 覆写位于明确的 layer。避免新增无 layer 的全局控件规则压过 utility。
6. 在同页同时渲染旧/新按钮、输入、弹窗、菜单和聊天片段，检查 computed style、截图与键盘行为。旧页没有迁移时，也必须仍能使用。

首批允许全量导入 HeroUI CSS，以减少漏样式风险；获得真实产物数据后再决定按需样式导入。不预先声称 HeroUI 一定更小或更快。

## 5. 必须显式处理的 Interface 差异

| 场景 | 当前约束 | 目标策略与验证 |
| --- | --- | --- |
| Button 变体 | default / outline / secondary / ghost / destructive / link，含 xs 和 icon 尺寸 | 保留应用语义，映射到锁定版 HeroUI 变体并集中定制；不按名字直接一一替换 |
| 链接按钮 | Button.render 可接 TanStack Link，另有 nativeButton 判断 | 保留真正的 anchor、href、新标签页和组合键行为；由 Link Adapter 或官方 Router 集成完成，不嵌套 button/a |
| Trigger 组合 | Base UI render 支持元素和函数，部分传入公共 Button | 改用 v3 支持的组合方式；核验 ref、props、事件顺序、preventDefault，避免双重触发和嵌套按钮 |
| 选择值 | Base UI 的 value / onValueChange、对象 items 和显示标签 | 领域值不变；HeroUI 单选按锁定版 value/onChange，选项 id 与 React key 分离，复杂标签提供 textValue |
| Checkbox / Switch | checked/onCheckedChange 等受控语义 | 在 Adapter 中明确布尔及半选转换；原生表单 name/value/required 不丢失 |
| 输入与表单 | TanStack Form、原生 change、ref、label、错误关联 | 保持一次事件更新一次字段；不同时引入第二套表单状态或校验源 |
| Dialog / Drawer | open/onOpenChange、关闭按钮、max 85svh、独立滚动体 | 适配 Modal/Drawer；处理 ESC、点击外部、提交中关闭策略和焦点返回 |
| 嵌套 Overlay | 当前有 overlayClassName 与强制遮罩能力 | 先用原生 HeroUI 组合验证嵌套；严查 body lock、inert、菜单选择后焦点和双 ESC 行为 |
| Tooltip | 根级 provider、触摸与 hover | 不保留无意义 Provider；行为参数只有实际需要时由应用层承接 |
| 样式状态 | data-open/data-closed/data-checked、data-slot 和 CSS 变量 | 逐项更新成新状态属性；应用拥有的 data-slot 可保留，不依赖库私有 DOM |
| @shadcn/react | 问卷与滚动控制使用 render 组合 | 核验“由外库向 HeroUI 按钮注入 props/ref”的兼容；失败时只重写动作 Adapter，不重做整个问卷或滚动引擎 |

HeroUI 当前 Select 文档使用 `value` / `onChange`，支持选项集合及独立 ListBox；不能照抄旧 v2 `selectedKeys` 示例作为本方案的单选实现。[Select](https://heroui.com/en/docs/react/components/select)

Modal、Drawer 和组合方式以 v3 官方资料与实际类型为依据：[Modal](https://heroui.com/en/docs/react/components/modal)、[Drawer](https://heroui.com/en/docs/react/components/drawer)、[Composition](https://heroui.com/en/docs/react/getting-started/composition)。

## 6. 迁移阶段与任务 DAG 草案

这是设计级拆分，不是已经完成 using-git-worktrees / writing-plans / SDD 的可执行计划。实施授权后，按根 AGENTS 流程建立执行工作区、BASE、详细 Task Brief 与检查点 Ledger；不能把本文当作跳过实施流程的依据。

初步任务顺序：`T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8`。顺序是风险和共同文件所有权约束下的推荐串行顺序，不声称所有业务都存在硬依赖。

### T0：建立基线和完整调用契约清单（0.5–1 人日）

- 角色：researcher，验证由 frontend_validator；无业务代码修改。
- 所有权：计划专属 inventory、baseline、截图与验证记录；读取 `app/src`、构建配置和现有测试。
- 输入：本设计、研究记录、当前 Git、适用 Spec/ADR；输出：全量导入/相对引用清单、render/回调/字段值清单、基线截图、产物大小、已有失败分类。
- 步骤：固定执行工作区和 BASE；核对实际版本；扫描全部 26 文件及原生控件；列清每个暴露的 Base UI Props 在调用端的用法；测量登录/聊天初始 chunk 和总 CSS。
- 验收：88 路由文件均归入迁移或保留清单；每个特殊交互有具体业务调用点；用户已有修改可对账。环境不足的测试记 blocked，不能记 pass。

### T1：兼容性 spike 与主题共存验证（1–2 人日）

- 角色：frontend_implementer → frontend_validator → reviewer；验证者与 reviewer 只读。
- 所有权：隔离验证页面/测试、最小样式实验、依赖实验；不改线上业务入口。
- 输入：T0 契约和当前版本；输出：锁定版本、可用映射、CSS/token 策略、右键菜单结论。
- 验证最难的六项：TanStack Link；Modal 中 Select；嵌套 Modal/Drawer；单选与可搜索选择器；旧 token 与 HeroUI 同页；Questionnaire/Scroller 的 render 按钮组合。
- 验收：每项有浏览器交互或类型/样式证据；无无法等价迁移的静默能力损失。若右键菜单或外库组合不满足，先明确 Adapter 方案和新增成本，不能删去原功能过关。

### T2：接入主题、locale、路由与基础控件（1–2 人日）

- 角色：frontend_implementer → frontend_validator → reviewer。
- 所有权：`app/package.json`、实际 Bun lockfile、`main.tsx`、`routes/__root.tsx`、`index.html`、ThemeProvider/theme、styles 文件、button/input/textarea/label/field/separator/skeleton/checkbox/switch/input-group。
- 输入：T1 验证通过的契约；输出：基础控件、同源主题和类型约束；共享接口此后冻结，后续变化记录到 Ledger。
- 步骤：先建立 token 桥接与状态测试，再逐控件替换；处理已有调用的编译错误；复核 disabled、loading、type=submit、invalid、ref 和 Link。
- 验收：迁移后的基础控件在旧页面可用，亮暗/中英正确，既有主题存储兼容；typecheck 和 build 通过。

### T3：完成一个真实业务试点——模型访问设置（1–1.5 人日）

- 角色：frontend_implementer → frontend_validator → reviewer。
- 所有权：`routes/_authed/settings/model-access.tsx` 及其实际调用的业务模块；Modal/Select/Tooltip/Dropdown 等公共封装按 T0 清单集中归本任务负责，不与其他任务同时写。
- 输入：T2 基础控件与 T1 Overlay 映射；输出：完整的加载、授权/撤销、表单、失败与成功反馈路径。
- 步骤：先迁移该页真实用到的 Overlay/选择控件；按实际字段执行完整流程；公共封装有剩余使用者时同步修正其不兼容调用，避免“试点通过但其他页编译坏了”。
- 验收：授权和撤销行为、有效期/错误反馈与原有合同一致；Tab/ESC/提交焦点正确；主流程可独立验收。若该页实际交互不覆盖选择器，T1 fixture 保留为组件证据，不虚构页面功能。

### T4：设置与管理业务切片迁移（2–4 人日）

- 角色：frontend_implementer → frontend_validator → reviewer；实际执行可拆为多个串行 Brief。
- 所有权：`routes/_authed/settings/**`、`routes/_authed/admin/**` 及对应 agents/plugins/settings/admin/billing 模块；公共控件变更由当前唯一 owner 集中执行。
- 输入：T3 已审查公共接口；输出：按功能分组的已验收页面。
- 顺序：个人设置/连接 → 模型/凭据 → Bot/技能/知识库 → 公司成员/权限 → 计费/订单/审计。实际文件集合按 T0 生成，避免跨目录漏掉共享视图。
- 验收：每组覆盖读取、编辑、取消、提交失败、权限拒绝；费用页保持个人/公司付款账户与原有金额精度；表格保留原排序/分页/空态，不为换库额外重写数据层。

### T5：导航、登录、引导与窄屏布局（1–2 人日）

- 角色：frontend_implementer → frontend_validator → reviewer。
- 所有权：app-sidebar、ui/sidebar/sheet/item、layout、sign、onboarding、tenant selection 和各 shell 路由。
- 输入：已验收控件；输出：键盘可用导航、移动 Drawer、统一设置行和页面外壳。
- 步骤：保留侧栏宽度/折叠偏好/快捷键；替换内部渲染工具；验证公司/团队切换与返回导航；检查短视口滚动，不让 PageShell 与应用外壳同时锁死页面。
- 验收：登录/退出、深链接、新标签页、侧栏展开/折叠、移动关闭后焦点均正确；受限资源不因导航迁移重新变成可见或可操作。

### T6：聊天与专用界面迁移（2–3 人日）

- 角色：frontend_implementer → frontend_validator → reviewer。
- 所有权：channels/composer、chat-transcript、chat 相关 ui、carousel、context-menu、questionnaire/message-scroller Adapter、craft/共享聊天入口。
- 输入：已审查控件/Overlay 与右键菜单方案；输出：HeroUI 动作层及保留的聊天行为。
- 步骤：迁移发送/附件/菜单/问卷动作；保留 PromptArea 内容模型、Streamdown 渲染、消息滚动、Embla；验证输入法合成期间 Enter 不误发送，提交一次只发一条；确认 iframe 内容不会从父文档自动获得主题。
- 验收：附件添加/取消/失败/重试、流式消息、手动滚动与回底部、复制/上下文菜单、屏幕键盘接管全部通过；跨公司/团队切换不带入错误草稿或异步结果。

### T7：旧底座退场与全局一致性（0.5–1.5 人日）

- 角色：frontend_implementer → frontend_validator → reviewer。
- 所有权：ui 中剩余 Base UI 依赖、styles/legacy bridge、package 与 lockfile、迁移清单。
- 输入：所有业务切片验收记录；输出：删除证明、保留依赖例外及最终主题规范。
- 步骤：扫描生产代码、测试、类型与 CSS；删除 `@base-ui/react` 直接依赖及 `shadcn/tailwind.css` 后重建；逐条确认生成工具和动画是否仍使用，再决定删除 `shadcn` / `tw-animate-css`；`cva` 有实际使用则保留。
- 验收：`app/src` 无 Base UI import/导出类型；锁文件无本次无意依赖漂移；`@shadcn/react` 的问卷与消息滚动列为明确保留项，不谎称“仓库所有 shadcn 都已清除”。

### T8：交付验证与完整范围 Review（1–2 人日）

- 角色：frontend_validator、独立 reviewer；主控执行 OCR，修复仍按对应实现角色派发。
- 所有权：验证和 Review/OCR 报告；验证者不修改业务或测试源文件。
- 输入：全部已审查检查点；输出：需求覆盖表、测试证据、性能比较、最终差异和回退说明。
- 验收：§7 所有标准有证据；最终 OCR 覆盖原始 BASE..HEAD 和全部未提交交付内容，没有有效 critical/high/medium；环境阻塞不能被视为迁移完成。

## 7. 验收与验证矩阵

| 编号 | 验收标准 | 证据 |
| --- | --- | --- |
| A01 | 公共交互控件由 HeroUI 承担；Base UI 直接引用与类型依赖清零 | 全量 import/type/CSS 扫描与包清单 |
| A02 | 亮暗主题、首屏、菜单和 portal 无 token 污染 | 基线对比、computed style、主题持久化测试 |
| A03 | 模型访问设置试点与每个业务组完整流程正确 | 浏览器操作记录和对应行为测试 |
| A04 | 弹窗、Drawer、菜单、Select 可键盘操作，关闭返回焦点 | 真实浏览器 Tab/ESC/方向键/滚动锁验证 |
| A05 | 表单提交一次、错误可关联，Link 保持正常浏览器语义 | DOM/交互测试与新标签页实测 |
| A06 | 聊天编辑、附件、流式输出和滚动行为正确 | 复用现有聊天测试，加缺失的迁移 seam 测试 |
| A07 | 公司/团队、付款、权限与敏感字段行为保持合同 | 相关页面正反向用例；不依靠隐藏按钮代替授权 |
| A08 | 桌面与窄屏可用，中英文长文案不截断关键动作 | 两主题 × 两语言 × 代表视口截图与交互 |
| A09 | 无无意的性能或构建退化 | 同环境初始 JS/CSS gzip、路由 chunk、关键交互测量 |
| A10 | 生产范围通过独立 Review 与 OCR，保留项有理由 | Review Package、OCR 报告、例外清单 |

建议视口：1440×900、1280×720、390×844、320px 宽度下限；另测 200% 缩放和操作系统 reduced-motion。代表页面选登录、模型访问、带长表单的管理页、计费列表、聊天与窄屏导航，不要求 88 个文件全部做重复截图。

可访问性标准：普通文本对比度至少 4.5:1、控件/焦点等相关非文本至少 3:1；图标按钮具名；表单错误可被辅助技术关联；不能只用颜色表达状态。小型密集控件保留既有尺度时也需核对实际触达区域。

性能建议门槛（待基线测量后固化）：登录和聊天初始 JS gzip、总 CSS gzip各自增长超过 10% 时暂停扩散并定位；若基线过小导致比例失真，记录绝对 KB 增量并评审。不得以迁移后更慢为代价默认过关，也不承诺未经测量的提速。

### 7.1 仓库命令与已有测试

实施前阅读 [ADR 0008](../adr/0008-test-runner-tester-army-e2e.md)，保持 native 与 driven 分层，不把直接 `bun test` 当作统一验收入口。

```sh
# 从仓库根运行。检查依赖于生成 app-config 的既有前置步骤。
bun run --cwd app typecheck
bun run --cwd app build

# native 层；此范围不包含 driven 文件的实际执行。
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=<本轮独立报告目录> bunx e2e run --config e2e.unit.config.ts

# driven 层；先核对清单中 app 文件，避免 native 排除后误以为已经覆盖。
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=<另一个本轮独立报告目录> bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts

# 既有 UI 入口；依赖本地应用/API、账号和模型环境，按实际报告判定。
bun run test:ui
```

命令中的报告目录为实施时必须替换的参数，不能直接照抄尖括号。执行前按当时清单核验 `E2E_BUN_ONLY` 前缀覆盖；`app/src` 下 driven 文件如存在，需加入实际前缀。新测试也必须进入 native/driven/engine 正确分区并做覆盖对账。

复用重点：`app/tests/theme-preference.test.ts`、`sidebar-preference.test.ts`、`sidebar-shortcut-layouts.test.tsx`、`shared-grant-dialog.test.tsx`、`account-mode-dialog.test.tsx`、`sign-in-card.test.tsx`、`multitenancy/selection.test.tsx`、`billing-credits-ui.test.tsx`、`model-billing-paths.test.tsx`、`composer-*`、`live-screen-keyboard.test.tsx`，以及 `tests/e2e/bot-chat.e2e.ts`、`billing.e2e.ts`。测试文件存在不等于已通过，实施时记录同一版本的真实结果。

对变更文件执行 Biome lint/format 检查；最终执行 `bun run test:ci` 与适用构建要求。全仓已有失败先记录基线，再判断迁移新增失败；不修复无关业务来换取形式上的全绿。Focus、portal、定位、IME 必须有浏览器证据，happy-dom 不能替代。

## 8. 回退与风险处理

| 风险 | 发现时机 | 处理 |
| --- | --- | --- |
| 同名 token 改坏旧页面或第三方内容 | T1/T2 | 命名空间与 utility 迁移；验证通过前不扩散 |
| Base UI render 无法直接对应 HeroUI 组合 | T1/T3 | 按实际调用改写 Interface，记录变更点与浏览器测试 |
| 多套 Overlay 在共存期争夺焦点/inert | T1/T3 | 组合用例先过关；避免在同一个链路混用旧/新浮层管理 |
| 选择值 null/空字符串/数字或对象被错误转换 | T1/T3/T4 | 明确各选择器的领域 ID 和空值合同，不对所有值做 String 强转 |
| DOM/data 属性变更导致 UI 测试假失败 | 各任务 | 以角色/名称/可观察结果定位；仅在证明确属结构依赖时调整测试 |
| 聊天大模块被引入公共入口、包体上升 | T2/T6 | 保持现有路由拆分，按实测选择样式导入方式 |
| 以删除依赖为目标重写成熟聊天引擎 | T6/T7 | 保留例外清单，把彻底替换 @shadcn/react 作为独立后续决策 |
| 其他会话持续修改共享 UI 文件 | 实施开始与每次派发 | 隔离执行工作区、记录 BASE；不 stash 或覆盖用户修改，集成后重验 |

回退单位为已验收业务波次或匹配的一组公共控件 + 样式 + 依赖锁文件；同一个共享 Button 的实现变化会影响全部调用者，因此不能声称“按页面开关”就能回退。公共适配存在重大问题时回到最近已审查检查点，不部署半完成的类型/CSS 混合状态。

本批不设计数据迁移，因而不需要数据库回滚。实施任务按授权使用本地提交或未提交检查点；没有提交授权时保留完整增量快照和哈希，不能私自提交。

## 9. 成本、交付物与待确认项

最初按一条串行前端实现流估算为 10–20 人日；细化为 H01–H15 并补齐画廊、Craft、评估运维等覆盖后，当前估算约 **14–27 人日（约 3–6 工作周）**；独立验证与 Review 安排可能增加日历时间。此估算基于静态盘点，T1 后重估；右键菜单复杂度、外库组合、已有失败环境、全新视觉方向会扩大成本，不是固定交付承诺。

实施交付物：

1. 已评审范围、版本与组件映射；如需长期架构决策，批准后补正式 ADR。
2. using-git-worktrees 后的执行工作区、详细计划、Task Brief、DAG 与 Ledger。
3. HeroUI 主题、公共控件与所有授权业务页面迁移。
4. 依赖删除证明、保留能力清单、两主题/中英文/代表视口验收证据。
5. 同一代码检查点绑定的测试、构建、独立 Review、完整范围 OCR 和回退记录。

待确认的产品选择：保留现有视觉还是采用全新 HeroUI 视觉；是否把独立桌面引导页等其他前端纳入范围。技术问题由 T0/T1 用证据解决，不要求用户选择每个 CSS 或控件属性。

本设计的完成不代表迁移已完成；当前尚未安装 HeroUI、运行兼容性 spike 或执行应用测试。

## 10. 具体 Issue 拆分（取代 §6 的粗粒度排期）

用户本轮要求把方案细化为具体 Issue。§6 的 T0–T8 保留为设计演进背景，实际 Ticket 范围、主所有权和硬依赖以本节及 [Issue 拆分清单](../tickets/heroui-migration/README.md) / [manifest](../tickets/heroui-migration/manifest.json) 为准。

T0/T1 合并为 H01；T2 对应 H02；T3 对应 H03；T4 拆为 H04–H08，并明确 H12/H13 的评估运维和画廊市场；T5 对应 H09；T6 拆为 H10/H11；T7 对应 H14；T8 对应 H15。由此避免“大设置管理任务”覆盖过宽或遗漏 Craft、评估和市场。

远端父项：[父 Issue #443](https://github.com/1123786563/OpenBot/issues/443)。

| ID | 业务目标 | 硬依赖 |
| --- | --- | --- |
| [H01 #444](https://github.com/1123786563/OpenBot/issues/444) | 建立 UI 迁移基线并验证 HeroUI 关键交互兼容 | 无 |
| [H02 #445](https://github.com/1123786563/OpenBot/issues/445) | 让现有页面通过 HeroUI 基础控件保持主题与表单行为 | H01 |
| [H03 #446](https://github.com/1123786563/OpenBot/issues/446) | 完成模型访问授权与撤销的 HeroUI 业务试点 | H02 |
| [H04 #447](https://github.com/1123786563/OpenBot/issues/447) | 迁移个人设置、连接管理与记忆维护流程 | H03 |
| [H05 #448](https://github.com/1123786563/OpenBot/issues/448) | 迁移模型目录、网关与凭据管理流程 | H03 |
| [H06 #449](https://github.com/1123786563/OpenBot/issues/449) | 迁移 Bot、技能、知识库与日常任务管理流程 | H03 |
| [H07 #450](https://github.com/1123786563/OpenBot/issues/450) | 迁移公司成员、权限分享、审批与审计流程 | H03, H04, H06 |
| [H08 #451](https://github.com/1123786563/OpenBot/issues/451) | 迁移个人与公司积分、购买和订单记录流程 | H03 |
| [H09 #452](https://github.com/1123786563/OpenBot/issues/452) | 迁移登录、工作台导航和窄屏侧栏流程 | H03 |
| [H10 #453](https://github.com/1123786563/OpenBot/issues/453) | 迁移聊天输入、消息动作与实时屏幕交互 | H03, H09 |
| [H11 #454](https://github.com/1123786563/OpenBot/issues/454) | 迁移 Craft 工作区、预览和产物操作流程 | H10 |
| [H12 #455](https://github.com/1123786563/OpenBot/issues/455) | 迁移运行记录、评估对比与运维观测流程 | H03, H06 |
| [H13 #456](https://github.com/1123786563/OpenBot/issues/456) | 迁移组件画廊与市场交互并保持生成内容适配 | H03 |
| [H14 #457](https://github.com/1123786563/OpenBot/issues/457) | 移除 Base UI 底座并核对完整迁移覆盖 | H04, H05, H06, H07, H08, H09, H10, H11, H12, H13 |
| [H15 #458](https://github.com/1123786563/OpenBot/issues/458) | 完成全流程、可访问性与独立审查交付验收 | H14 |

contains 与 depends_on 分别记录；默认串行排期，不能把表格次序当作原生依赖。所有 Ticket 为待评审设计，建单不代表授权实施。确认视觉/范围或修订默认假设后，再进入执行工作区、详细计划与 SDD。

## 11. 修订（2026-10-20）：视觉基线在交付后切换为 HeroUI 原生

Wave R1（issue #502）：用户在预览 HeroUI 默认主题后裁决，放弃本文 §1"保留现有 WorkBuddy 视觉"的默认假设，主应用整体切换到 **HeroUI 原生默认主题**（accent 蓝 `oklch(0.6204 0.195 253.83)` 作为 action/brand/focus/chart-1，WorkBuddy 青绿与黑/白主按钮退役；根字号 15px→16px；radius 0.6rem→0.5rem；图表五色统一围绕 accent 重配并满足两主题 ≥3:1）。迁移的组件行为、布局合同、信息架构与验收矩阵（§7）不受影响；变更落在 `app/src/styles/tokens.css`、`app/src/styles.css`（根字号）、`app/src/styles/heroui-theme.css`（桥接收敛，WorkBuddy 覆写退役）、`app/DESIGN.md`（视觉基线改写）。WorkBuddy 保留方向自本日起由用户裁决取代；证据见 `docs/verification/heroui-migration/r1/`。
