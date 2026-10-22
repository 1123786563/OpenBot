# H10 — message-UI wrappers (message half)

状态：implemented（未提交）。范围：`app/src/components/ui/{bubble,message,live-waveform,questionnaire,message-scroller}.tsx`。

## 文件与变更

- `bubble.tsx`：删除 `@base-ui/react/merge-props`、`@base-ui/react/use-render`。`BubbleContent` 改为显式 JSX；`render` 契约保留（元素或 `(props, state) => element`，state 仍为 `{ slot: "bubble-content" }`）。本地合并语义对齐 Base UI：外部 props 覆盖内部、`className` 走 tailwind-merge（替换元素的 utilities 胜）、`style` 浅合并、refs 全部挂载、同名事件先替换元素后内部（右到左）。无 `any`。
- `message.tsx`、`live-waveform.tsx`：本就不含 Base UI；未改。canvas/AudioContext 可视化、Message 槽位原样保留。
- `questionnaire.tsx`：保留 `@shadcn/react/questionnaire` 引擎；动作按钮由引擎渲染原生 `<button>` + 应用 `buttonVariants`，不经过 render prop → 无 Base UI 语义可适配；类名与 HeroUI Button 同一套词汇。未改。
- `message-scroller.tsx`：保留 `@shadcn/react/message-scroller` 引擎与回底按钮组合；`render` 的目标是 H02 的 HeroUI Button（元素形式）。运行时探针确认第三方生成的 `onClick`/`data-active`/`data-direction`/`inert`/`type`/`tabIndex`/合并类名都落到原生 `<button>`，`onClick` 经 React Aria `usePress` 执行。未改。

## 保留的契约

- bubble：`Bubble`/`BubbleGroup`/`BubbleReactions` 的 variant/align/data-slot；`data-slot="bubble-content"`。
- message：`message`/`message-avatar`/`message-content`/`message-header`/`message-footer`/`message-group`。
- scroller：`message-scroller`、`-viewport`、`-content`、`-item`、`-button`、`-provider` 及三个 hooks。
- questionnaire：15 个导出与全部 data-slot 不变。
- 未触碰流式、滚动锚定、附件生命周期、IME、屏幕接管。

## 验证

- `bun run --cwd app typecheck` → EXIT 0（`typecheck.log`）。
- 发现命令只命中 `app/tests/transcript-attachments.test.tsx`（驱动层，`bun test`）。连同 3 个相邻聊天套件：**64 pass / 1 fail**（`driven-tests.log`）。
- 失败 `a thumbnail is a crop…` 断言灯箱触发器 `aria-haspopup="dialog"`；单独复跑仍红，且把 `bubble.tsx` 换回 HEAD 版本（A/B）同样红 → 属 H03 dialog 包装层，非 H10。
- 临时探针（已删除，不入库）：element/function 两种 render、类名合并、双事件链、HeroUI Button 执行第三方 `onClick`、回底按钮 DOM 属性，4/4 pass。

## 必需 HeroUI CSS

无新增。既有 `styles.css` 的 `@heroui/styles` `layer(components)` 导入与 `--ob-*` token 已覆盖本组样式。

## 浏览器缺口

真实滚动状态下的 active 切换/`inert` 焦点、回底过渡、IME/流式滚动锚定、实时屏幕接管与波形 canvas 均未在真实浏览器复验。
