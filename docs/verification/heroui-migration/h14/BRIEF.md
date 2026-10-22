# H14 Task Brief — frontend_implementer（旧底座退场与完整覆盖核对）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#457 票面旧状态不适用）。不 commit/push。
前置：H04–H13 全部实现并复审完成（读各自 REPORT + `reviews/` 全部结论 + `BACKLOG-H14-H15.md`）。
**本任务是 lockfile/package.json 的唯一写入者（继 H02 之后）**——interface 变更申请在此集中执行。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h14.md`（范围、AC1–AC5）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `BACKLOG-H14-H15.md`（本任务的输入清单）+ `LEDGER.md` 全部 2026-10-20 段
4. `h01/contract-matrix.md`（@base-ui 残留底稿）

## 范围
- `app/package.json` + 根/实际 Bun lockfile、`styles/legacy-ui-bridge.css`（ob-legacy 层删除评估）、`components/ui` 残留引用、迁移覆盖清单、`docs/verification/heroui-migration/coverage.md`（新建）。

## AC 对照 h14.md
1. **app/src 无 `@base-ui/react` import/re-export/类型引用**，app 直接依赖移除（先全量 grep 证实，再从 package.json 删除 `@base-ui/react`；bun install 更新 lockfile；typecheck/build 复证）。
2. `shadcn/tailwind.css` import 已在 H02 删除——证实 styles.css 无引用后评估 `shadcn` 包本体去留（`shadcn` CLI 是否仍被脚本/生成流程使用：grep scripts、package.json、文档）；`tw-animate-css` 按实际 @import 使用决定；`cva` 有实际使用则保留。
3. **保留例外清单**（明确原因+主题兼容证据）：`@shadcn/react`（问卷/消息滚动）、PromptArea、Streamdown、Recharts、Embla。
4. **覆盖对账**：重扫全部路由与公共 UI 文件（对照 manifest 的 88 路由表），新增/改名路由重新归属；`coverage.md` 输出全量清单（文件×归属×处置×证据指针）。
5. **lockfile 无无关漂移**（diff 前后仅预期条目）；同环境 typecheck/build + **JS/CSS gzip 终测**（对照 H01 基线：登录 JS 430,849 / 聊天 JS 1,168,268 / CSS 49,906 gzip——超 10% 门槛附评审结论；当前 CSS +6.8KB=+13.7% 已有 H02 评审结论，按最终迁移面复算并引用）。

## BACKLOG 输入（逐项处置或转 H15，写明去向）
- puppeteer-core 声明（cdp-harness）→ devDependency 声明（根或 app）或 README CHROME_PATH 注记强化。
- `agent-mastra/bun.lock` 是否交付范围（环境修复产物）→ 核对后处置。
- upgrade-dialog.tsx 2 条 BASE 既有 biome 诊断（轮询逻辑）→ 复核是否可安全修（H08 判定 unsafe，如仍 unsafe 记录保留）。
- W3A/W3B 的 5+5 条 low 文档小项（/tmp 路径、计数、行号）→ 批量修正各 REPORT。
- heroui-spike 排除清单条目（H13 F3 结论）→ 处置。
- H02 审查 Low 五项（switch 镜像 stale、暗色 OFF 轨道、merge 三拷贝、ob-theme 冗余、router-link to+href）→ 逐项修复或记录。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build` + gzip 测量
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h14/native bunx e2e run --config e2e.unit.config.ts`（期望：除 H15 转办项外全域绿）
- driven：`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h14/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（执行前按清单核验前缀覆盖）
- 全量 import/type/CSS 扫描（@base-ui、shadcn/tailwind.css、bg-muted 残留）
- `bun run test:ci`（收口轮；对账工具先行）

## 交付
`h14/REPORT.md`（删除证明、保留例外、覆盖对账、包体对比、BACKLOG 处置表）+ `coverage.md` + `POST-CHECKPOINT.sha256`。阻塞记录证据继续可做部分。
