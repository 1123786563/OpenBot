# H13 Task Brief — frontend_implementer（组件画廊与市场交互，生成内容适配）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#456 票面旧状态不适用）。不 commit/push。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h13.md`（范围、AC1–AC4）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `docs/verification/heroui-migration/h03/REPORT.md`「下游 Interface」节
4. `docs/verification/heroui-migration/LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、H03–H12 已改文件（见各自 POST-CHECKPOINT）。

## 范围（主所有权）
- 路由：admin/components/{index,$name}、admin/market、settings/components-gallery/{index,$name}。
- 组件：`gallery/*`（activity、cards、charts、decisions、form、frame、preview、quote、refused、table）、`market/*`（connectors-pane、experts-pane、my-experts-view、skills-pane、wb）、`component-preview.tsx`。
- `app/src/lib/copilot/generative-ui.ts`：仅允许与迁移直接相关的描述校准；其他漂移记录为后续项。

## 合同（AC 对照 h13.md）
- 画廊列表/详情/预览表单表格与市场筛选/详情/动作可用；不新增未批准市场能力。
- 应用内 gallery 控件遵循 HeroUI 主题；**原生表格/图表按必要性保留，不强制全部重写**。
- **sandboxed generated UI 与 Craft 模板是独立文档/代码——不得假设可导入父应用 HeroUI 或读 CSS token**（保持隔离事实）。
- generative-ui guidance 与主题直接冲突的描述：仅迁移相关可改，其余记录。

## 已知红（须修复或单变量归因）
- `gallery-components` 表单相关红（2026-10-20 归因落本域；明细见 `h02/form-primitives/report.json`）。pre-existing 勿追：zz-probe 8、heroui-spike、他域红。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h13/native bunx e2e run --config e2e.unit.config.ts`
- 变更文件 biome lint/format

## 交付
`h13/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。阻塞记录证据继续可做部分。
