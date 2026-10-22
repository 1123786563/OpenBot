# OpenBot 工作台视觉与布局实施规格

状态：**待用户审阅；未批准、未实施**。2026-10-20。第二轮执行细节见 [implementation-detail.md](./implementation-detail.md)，尤其是DetailPanel生命周期与有限兼容修复，不能仅修改阈值就声称草稿已保留。
范围：现有 76 页面、4 布局、7 兼容跳转。第一批仅 T01–T08。事实源依次为用户本轮边界、CONTEXT.md、既有行为/权限合同、布局合同及本规格；pages.md 的候选值由本稿收敛，不回写旧稿。

## 1. 产品与交付合同

现代科技工作台方向已确定，不重新发现风格。沿用 React 19、Tailwind 4、HeroUI v3 当前安装版本、TanStack、现有图标/头像/翻译与专用聊天引擎，不安装依赖、不换框架。Operate 模式：状态可读、操作明确、内容优先。

本规格只改变视觉和明确标注的布局/局部视图切换。基础导航、URL、搜索参数、权限、公司/团队/个人资源归属、付款主体、确认流程和服务协议均保持源码合同。I-01/02 为独立候选，不进入任何基础任务；I-03 明确不合并全局/Craft 会话。图中搜索框、审批数量、推荐指标没有源码能力依据则排除。

来源：`../../README.md`、`../layout-contract.md`、五张 `../references/*.png`、`../../pages.md`、本目录 `source-evidence.json`。旧迁移见根目录 `docs/plans/2026-10-19-heroui-v3-migration-execution.md`；不重新派发 H01–H15。`app/DESIGN.md` 仍是 HeroUI 默认主题事实，本稿是新的待审阅目标，T01 获实施授权后才更新它。

## 2. Token 的唯一值源

`tokens.css @layer ob-tokens` 唯一拥有 `--ob-*` 的主题值；`heroui-theme.css @layer ob-theme` 唯一拥有 HeroUI 原生语义变量映射；`legacy-ui-bridge.css @layer ob-legacy` 仅保留旧应用别名，不再次声明 HeroUI 名称。层顺序沿用 styles.css，不添加未分层的主题声明。CSS 根字号固定 16px；下列 px 不随截图缩略比例改变。

颜色精确定义见 [theme-contract.json](./theme-contract.json)，该表逐项覆盖当前全部 39 个 ob Token，并添加状态、边界和布局 Token。下表暗/亮是最终建议值，不再保留范围。

| Token | dark | light | 用途 |
| --- | --- | --- | --- |
| --ob-canvas | #111318 | #F5F7FA | 页面底面 |
| --ob-sidebar | #0D1015 | #EEF1F6 | 导航底面 |
| --ob-surface | #191D26 | #FFFFFF | 正文组 |
| --ob-overlay | #242B38 | #FFFFFF | 浮层 |
| --ob-hover-surface / --ob-muted-surface | #242B38 | #EEF1F6 | hover/弱底面，绝非弱文本 |
| --ob-foreground | #EBEFF7 | #192131 | 正文 |
| --ob-muted-text | #A2ACBE | #526079 | 辅助文本、占位 |
| --ob-border | #303949 | #D8DFE9 | 仅分组装饰线 |
| --ob-control-border / --ob-field-border | #68788F | #7A879B | 输入、outline 操作等必要边界 |
| --ob-field-background | #191D26 | #FFFFFF | 字段填充 |
| --ob-action | #3D6BDA | #315FCF | 主动作填充 |
| --ob-action-hover | #345FC7 | #2853BD | 不降低白字对比的 hover |
| --ob-action-foreground | #FFFFFF | #FFFFFF | 主动作文字 |
| --ob-accent-text / --ob-focus | #8DB4FF | #315FCF | 链接、独立焦点 |
| --ob-success | #69D5AC | #16704D | 状态文字/实底 |
| --ob-success-foreground | #10231B | #FFFFFF | 实底状态的文字 |
| --ob-warning | #F0BE69 | #8B570B | 等待确认/注意 |
| --ob-warning-foreground | #2A1D08 | #FFFFFF | 实底状态文字 |
| --ob-danger | #FF9EA7 | #B32745 | 错误、危险文字 |
| --ob-danger-foreground | #30141B | #FFFFFF | 实底状态文字 |

disabled 状态统一 `background:var(--ob-disabled-background)`（=muted-surface）、`color:var(--ob-disabled-foreground)`（=muted-text）、control-border、opacity:1、无hover/active位移；现有防点击/表单disabled语义保留。readOnly 保持正常field填充与正文颜色，不套disabled；invalid 用不透明danger边界、正常field填充和邻近错误文字，不降低暗色边界透明度。

soft 状态底固定为 `color-mix(in srgb, var(--ob-STATE) 10%, var(--ob-surface))`，hover 16%；文字用未混合的状态色，不再应用 opacity。success/warning/danger 均配文字/图标，未知用 muted + “未知”，无数据不显示 0。focus 为 2px 实色 outline、offset 2px；不依赖半透明 ring。单条 selected 行用 hover surface + 2px accent-text 内侧标记，hover 无标记，focus 独立。

### 原生 HeroUI 所有权表

所有映射均在 `heroui-theme.css` 写在 `:root, [data-theme="light"]` 与 `.dark, [data-theme="dark"]` 两主题有效作用域；取 ob 变量的映射可共用，不能把亮色常量继承到暗色。主题根在 html，portal 到 body 同样继承。独立 iframe 不继承父主题、不注入不受控 CSS。

| HeroUI 变量 | 映射 / 确定策略 |
| --- | --- |
| --background / --foreground | --ob-canvas / --ob-foreground |
| --surface / --surface-foreground | --ob-surface / --ob-foreground |
| --surface-secondary / --surface-secondary-foreground | --ob-muted-surface / --ob-foreground |
| --surface-tertiary / --surface-tertiary-foreground | --ob-hover-surface / --ob-foreground |
| --overlay / --overlay-foreground | --ob-overlay / --ob-foreground |
| --muted | **--ob-muted-text**，保持弱文字合同 |
| --accent / --accent-foreground / --accent-hover | --ob-action / --ob-action-foreground / --ob-action-hover，保持强调填充合同 |
| --accent-soft / --accent-soft-hover | action 与 surface 按 sRGB 10% / 16% 混合 |
| --accent-soft-foreground / --link | --ob-accent-text |
| --default / --default-foreground | --ob-secondary-surface / --ob-secondary-foreground |
| --default-hover / --default-soft / --default-soft-hover | hover surface / muted surface / hover surface |
| --default-soft-foreground | --ob-foreground |
| --field-background / --field-foreground / --field-placeholder | --ob-field-background / --ob-foreground / --ob-muted-text |
| --field-hover / --field-focus | --ob-field-background（稳定填充） |
| --field-border / --field-border-hover / --field-border-focus | --ob-control-border / --ob-focus / --ob-focus |
| --field-border-width / --border-width | 1px / 1px |
| --border / --separator / --separator-secondary / --separator-tertiary | --ob-border（装饰分隔） |
| --border-secondary / --border-tertiary | --ob-control-border（必要边界） |
| --focus | --ob-focus |
| --success / --success-foreground / --warning / --warning-foreground / --danger / --danger-foreground | 各同名 ob Token |
| --success-hover / --warning-hover / --danger-hover | 各状态色与 foreground 配对色按 sRGB 90%/10% 混合，仅实底组件 |
| --STATE-soft / --STATE-soft-hover / --STATE-soft-foreground | 状态色与 surface 10% / 16% 混合 / 状态色；STATE=success,warning,danger |
| --radius / --field-radius | 8px / 8px |
| --surface-shadow / --overlay-shadow / --field-shadow | --ob-shadow-card / --ob-shadow-overlay / none |
| --backdrop | --ob-backdrop，亮 rgba(0,0,0,.24)，暗 rgba(0,0,0,.60) |
| --disabled-opacity | 1；wrapper 单独定义 disabled 状态，不整块淡化必读文案 |
| --scrollbar / --scrollbar-thumb | --ob-control-border |
| --scrollbar-track / --scrollbar-gutter / --scrollbar-width / --scrollbar-color | transparent / auto / thin / var(--scrollbar-thumb) transparent |
| --skeleton-animation | shimmer；reduced-motion 时 none |
| --background-secondary / --background-tertiary / --background-inverse | --ob-muted-surface / --ob-hover-surface / --ob-foreground |
| 原始色板 --white/--snow/--eclipse 等、库动画/结构量 | HeroUI 库拥有，保持安装版本值；产品不得直接消费它们代替语义 Token |

旧别名所有权：card→surface、popover→overlay、primary→action、secondary→secondary-surface、muted-foreground→muted-text、destructive→danger、brand→action、input→**control-border**、ring→focus、sidebar-*→同名 ob Token、chart-*→ob-chart-*；对应 foreground 成对映射。`--background/foreground/border/radius/success` 由原生表覆盖，不放回 legacy；`--accent/--muted` 永不在 legacy 声明。styles.css 的 Tailwind alias 只映射，不再定义颜色。

## 3. Wrapper 修改落点与语义

| 范围 / 文件 | 明确决定 | 保留合同 |
| --- | --- | --- |
| ui/button.tsx + router-link.tsx | 保留六 variant/八 size 及 HERO_VARIANT/HERO_SIZE 映射；更新 cva 颜色、focus、disabled；outline 使用 control-border，link 使用 accent-text。常规 36px、lg 40px、sm 28px、xs 24px、icon 32px、icon-xs 24px、icon-sm 28px、icon-lg 36px；pointer:coarse 对交互 box 最小 44×44px，允许行增高 | mergeRefs/adaptRender、原生事件一次、submit type、disabled、真实 anchor 的新标签/组合键 |
| ui/input.tsx / textarea.tsx | 在 wrapper 类中删除 bg-transparent、hover/focus/invalid 中性化背景和 dark:bg-input/30；统一 field-background + control-border + 1px border + 8px radius + shadow-none；invalid 保持填充、用 danger border + 错误文字。输入 36px，textarea min-height 96px；composer 专用自动增高不改 | ref、name/value/defaultValue、onChange 原生事件、required/readOnly/disabled、文件输入、IME |
| ui/select.tsx / combobox.tsx | 修改 trigger/input 的视觉类与边界，不动值注册/identity/null/textValue 适配；宽度默认随内容，表单内 w-full；popover max-height=min(320px,可用视口)，可滚动 | listbox 键盘、label/value、portal、焦点返回；不因美化强行改 combobox role |
| ui/checkbox.tsx / switch.tsx | 几何沿用 HeroUI；marker 类保持；只用变量调整颜色，粗指针 label 命中区 44px；OFF 轨使用 control-border，ON 使用 accent | checked/onCheckedChange 与表单隐藏字段、ref、native event 合同 |
| ui/dialog.tsx / sheet.tsx | wrapper 负责 scrim/geometry，SCRIM 改用 --ob-backdrop，去除旧固定黑透明度与 blur；表面用 overlay、16px 圆角；sheet 在 <768px 全宽，其他 min(detailWidth,100vw)。弹窗宽 min(512px,100vw-32px)、max-height calc(100dvh-32px)、内部滚动 | 已有 ESC 栈、焦点/滚动锁、原关闭策略、嵌套 popup；不重写事件补丁 |
| ui/dropdown-menu/context-menu/tooltip/bubble.tsx | surface/foreground/radius/shadow 只归变量 + wrapper 类；菜单项最小 36px（coarse 44px），tooltip 12/18px，最大宽 320px；portal 不单建主题 provider | 定位、长按/Shift+F10、disabled、dismiss 与 focus |
| ui/item/field/label/separator/skeleton/empty.tsx | 统一密度/文案层次；field 错误紧贴控件，skeleton 与实际行匹配；separator 用装饰线 | label/description/error 的关联，不生成伪数据 |
| ui/message/message-scroller/questionnaire.tsx | 仅接收 token/字号/边界调整；不替换专用问卷、滚动/编辑器实现 | 滚动锚点、问卷提交与消息协议 |
| page-shell.tsx | WIDTHS prose=672px、wide=1024px；PageRows 12px 圆角；移除静态卡片阴影和深色透明边界例外 | PageShell 公共 props 不变、内部 scroller、返回链接 |

其余 UI 包装文件逐项清单由 T02 owned_files 锁定；无视觉职责的 carousel/live-waveform/input-group 只验证继承，不重写行为。业务调用方的 override 若抵消公共变量，优先在所属业务 Task 移除该 override；不在全局加入更高 specificity 去压制。

## 4. 字体、间距与形状

字体：`Inter Variable, PingFang SC, HarmonyOS Sans SC, Microsoft YaHei, sans-serif`；技术路径/代码使用现有等宽栈，金额/时间 tabular-nums。

| 层级 | size/line-height | weight |
| --- | --- | --- |
| 页面标题 | 24/32px | 600 |
| 对话顶栏、行标题 | 14/20px | 500 |
| 分组标题 | 16/24px | 600 |
| 配置、列表正文 | 14/22px | 400 |
| 聊天消息正文 | 16/28px | 400 |
| 辅助说明 | 13/20px | 400 |
| 时间、标签 | 12/18px | 500 |
| 窄屏表单输入 | 16/24px | 400 |

空间：4px 基准，8/12/16/24/32/48px。桌面内容边距 24px，<768px 16px；分组间距 32px；组内 padding 16px；行 min-height 64px，设置行 min-height 72px，随长文增高、不裁切。头像 32px，行操作保留 44px 可达区域。容器 12px、控件 8px、Modal 16px；标签胶囊 999px；组中间行 0 圆角。静态组阴影 none；亮色浮层 `0 8px 24px rgb(25 33 49 / .12)`，暗色浮层 none。动效 180ms ease-out，sidebar 200ms，reduced-motion 0ms；不增加循环装饰动效。

## 5. 外壳和 DetailPanel（布局变化 L-01/L-02）

应用 expanded=280px；设置/后台 expanded=256px；可折叠图标轨总占用=64px（包括 border/padding，不能在 inset 样式下再加 16px）；移动导航宽 min(280px,100vw-32px)。主区 min-width:0/min-height:0。应用 h-svh 内部分区滚动，设置/后台延续页面文档滚动，不能为了统一壳把表单 footer 裁掉。

prose=672px 保持现有 max-w-2xl，wide=1024px 保持 max-w-5xl；聊天消息/输入阅读列=720px。选择 672 而非 720 是保留已存在的配置阅读宽度；长授权、模型标识允许换行。宽表、代码、预览仅在具名区域内部横滚。

响应式判断顺序：<768px 强制导航 Drawer；≥768px 普通页面按已有用户偏好显示 full/rail。仅多面板页在 1280–1439px 自动采用 rail（除非本次访问用户显式展开），≥1440px 优先按已存偏好；768–1279px 辅助面板按需 overlay。自动响应式模式、Drawer open、用户持久化偏好三种状态分离；只有显式桌面 toggle 写 `SIDEBAR_STORAGE_KEY`，viewport/ResizeObserver 不触发存储。手动展开后，容器不足把辅助面板转 Sheet，不偷偷折回用户选择。

DetailPanel 公共 props 不变，DEFAULT_DETAIL_WIDTH=400px；**MIN_MAIN_WIDTH 从 400 改为 480px**，所有调用方一起执行此规则。容器 content width C ≥ detailWidth+480 时并排，否则 Sheet；边界严格 `<`，C=880/960 分别是 400/480 右栏并排的第一点。电脑右栏仍 400px，工作坊仍 480px，Bot 资料默认 400px；Skills、Craft tasks 编辑默认宽度保留其调用值并应用同一下限。将更早进入 Sheet 是显式布局变化，不能宣称只有颜色变化。T03 先测所有调用者，T07 再测真实聊天。

### 聊天

顶栏 48px（长名可两行至 64px），消息区 flex:1/min-height:0/overflow-y:auto，Composer 是主区内底部 flex 项，不用覆盖正文的 viewport fixed。safe-area-inset-bottom；软键盘下保持发送与附件可见。`settings/watch/workshop` 仍由原 show() 互斥管理，URL/Back/自动 watch/释放控制逻辑保持；不新增统一 task API 或复制执行状态。并存参数的既有优先级按原代码保留。跨断点不得主动 onClose 或修改 search；已经关闭时保持原卸载策略，已打开跨并排/Sheet 的草稿状态归属于断点分支之外的调用者，按 implementation-detail §4 先验证可行性再实施必要接线；不能声称现有分支已经稳定挂载。

群聊无单 Bot 资料/电脑入口。Bot 详情身份→待办/建议→启用/通知→活动→配置→管理；本稿取消“窄屏折叠管理”的候选：所有配置/管理分组默认展开，危险动作仍单独分组，沿用原确认。Bots 分组算法/顺序/隐藏项默认折叠完全保留，不新增搜索/筛选。

## 6. Craft 精确状态与切换（后续批次 T09）

宽度：session=224px、chat min=480px、output=420px；不新增拖拽比例。C 为扣除全局导航后的 Craft content width。

| viewport / 空间 | 默认可见 | 操作规则 |
| --- | --- | --- |
| ≥1440px 且 C≥1124px | session/chat/output 三列 | 可手动收起 session；output tab 默认 preview |
| ≥1440px 且 900≤C<1124px | chat/output；session Drawer | 会话按钮打开 Drawer，选择后关闭；URL 标识会话 |
| 1280–1439px | 全局 rail；C≥1124 三列，否则 C≥900 chat/output，否则 chat | 用户展开全局导航后重新按 C 判断 |
| 768–1279px | chat；session Drawer、output 按需 Sheet | 只显示一个辅助 Sheet，开另一个先关旧的，chat 实例不卸载 |
| <768px | session route 默认 chat；index 默认会话列表 | 对话/输出切换，session Drawer 独立打开；输出有返回对话操作；非当前区 hidden+inert，不复制 DOM |

在所有 viewport，C<900 禁止并排 chat/output；C<1124 禁止三列。切换只影响显示，不能改变 sessionId、发送/停止状态或 draft。`ChatPanel({sessionId})` 与 `OutputPanel({sessionId})` 保持原 public API；单个会话路由内稳定挂载一个 ChatPanel/OutputPanel。新增 `craft/workspace-layout.tsx` 唯一拥有 sessionDrawerOpen/outputOpen/activeView，全部为本次 route 局部状态，不写 sidebar 偏好、不加 URL 参数。

- 断点变化：已选 session、draft、附件 chips、消息滚动位置、viewedSubagentId、输出 tab、preview iframe 实例不变；关闭/切换不取消运行，不新建会话。切回后恢复焦点到发起按钮；隐藏区 inert，不接收 Tab，停止音频等沿用现有显式控制。
- 输出 preview/files/artifacts 切换：保留每个已经访问 tab 的内容实例（首次访问才挂载，之后 hidden+inert），保证 preview DOM 节点和 HMR 连接不重建；files 的选择与滚动可恢复。隐藏 iframe 仍是原安全来源，ticket/cookie/ready 逻辑不变。
- session 导航去另一 URL：沿用现有消息/运行生命周期和草稿行为，本批不增加跨会话草稿持久化、不擅自自动保存；保证不会把上一 session 草稿/附件错发到下一 session。跨会话若原代码会重置，保持该行为。
- index 不自动创建 session；tasks 保持独立领域。preview fullscreen 沿用同一 iframe 改 wrapper positioning，不新增 portal/第二 iframe；祖先不能加 transform/filter/backdrop-filter 破坏 fixed。

## 7. 后续页面确定规则

设置：只保留内层设置导航，672px 分组配置；<768px label/description 在前、control 在后；≥768px 标签区 flex:1/control max-width:280px，长控件换行。既有 connected-account 搜索保留，不扩散为全局搜索。个人模型访问授权、管理员登记服务、共享账号分开。

知识库：<1280px 单列，返回/身份→添加→上传任务→筛选排序/文档→检索输入/结果；≥1280px 且内容 C≥1000px 时 wide=1024px，文档主列 minmax(0,1fr)、检索辅助列320px、gap24px，添加/上传仍在主列且先于文档。上传/索引/失败/空文档/空检索分别表达；沿用现有选中、批量删除、过滤字段，不增加切片/命中率。390px 文档必要列具名横滚，文档标题可两行，动作不挤出屏。

数据/运行/比较：1024px，保留已有可用性与服务就绪判断；比较 <768px 基线/候选上下，单位相邻；metadata/code 可横滚但页面不横滚。Admin 两可观测地址共享同一 body，仍分别验收 URL。

列表/编辑：原 DetailPanel 与 URL/选择状态保留，转 Sheet 按 §5。Gallery/market >=1024px 三列、768–1023px 两列、<768px 单列；以当前业务已用布局为基础，不给没有创建能力的页加按钮。Playground >=1280px 且 C≥960px 双列，否则编辑/预览切换，稳定挂载保留 draft。

登录/引导/服务登录/租户选择/公开分享保持各自独立流程，不插入应用侧栏。登录表单上限 384px；流程正文672px；分享1024px。payer/金额/币种/订阅/发放到期/异常结算语义不改。

## 8. 状态矩阵与验收门槛

| 状态 | 视觉 / 行为 | 测量 |
| --- | --- | --- |
| 正常 | 真实字段、主动作一个、区域顺序按 route acceptance | 截图 + 操作 trace |
| 加载 | 只在正在加载区域 skeleton 或现有 loading；不先报空 | 慢请求/受控 fixture |
| 空内容 | 说明事实、仅已有动作；筛选空与无数据区分 | 空 fixture |
| 读取异常 | 明确错误；刷新失败保留已有数据 | 首次失败/背景失败分别测 |
| 保存/发送中 | 防重复原合同、局部状态、保留输入 | 双击/回车/IME |
| 保存/发送失败 | 保留 draft/附件，原恢复入口 | 注入 4xx/5xx 或受控 mock |
| 无权限/只读 | 沿用 route guard 与服务端能力，敏感信息不进入 DOM | admin/member/资源不可访问身份 |
| 长内容 | 120字名称、300字说明、200字符不可断 ID、100行列表 | 390/768/1280/1440，200% zoom |
| disabled/readOnly/invalid | disabled 不响应；只读可读；invalid 有 label/error，不只红色 | 键盘与表单值提交 |
| hover/selected/focus | 三者独立；focus 2px+2px offset；必要边界≥3:1 | computed style + 键盘截图 |
| 运行/等待/暂停/失败/未知 | 用原字段映射一个权威状态；不复制图中矛盾状态 | 实际/fixture 数据来源记录 |

文本与指定背景≥4.5:1，必要控件边界/焦点≥3:1；装饰线不声称承担控件识别。亮暗 × zh/en × 390×844、768×1024、1280×800、1440×900。初始 DPR=1；200% 缩放额外在1280×800测。纯色值不写镜像 CSS 单测；[verification-plan.md](./verification-plan.md) 约束 DOM/浏览器证据、native/driven、环境缺口和 checkpoint。所有实现 Task 均需 Spec compliance + quality 独立 review；OCR 只对未来实际交付执行，本轮文档没有生产验收结论。
