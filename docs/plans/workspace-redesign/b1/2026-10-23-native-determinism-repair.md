# B1 native 确定性修复(2026-10-23)

授权来源: 本会话 B1 T01–T08 交接指令第 7/9 节的范围内必要修复授权。
问题: 标准全量 native 验证命令非确定性失败(1006/1008,约 2/3 概率),阻止 B1 完成门禁。

## 事实与根因(全部经本会话实验复现)

### 根因 A — mock.module 注册表泄漏

`tests/support/e2e-compat.ts` 的 `mock.module(specifier, factory)` 返回注销句柄,
但 9 处调用点忽略返回值。e2e-compat 的 resolve 钩子按**原始说明符字符串**匹配
(`moduleMocks.has(specifier)`),mock 在同 worker 进程内对后续文件永久生效:

- 同进程先运行 `billing-credits-ui`(或 admin-* 安装者)后运行 `detail-panel`,
  detail-panel 的两个 Dialog 语义测试拿到 passthrough mock(无 aria-labelledby),
  `findByRole("dialog", {name})` 失败。串行 `--workers 1` 下 100% 复现;
  默认 4 worker 下取决于调度(≈2/3 失败率,3 次观测 2 失败)。
- 单文件+detail-panel 配对二分定位: `billing-credits-ui.test.tsx` 单独即可复现。
- 一次性探针(aa-mockprobe,已删)证明: e2e-compat mock.module 的 afterAll 注销
  对**静态导入受害者**也有效 — 运行器在执行进程中惰性逐文件导入。

9 处泄漏点:
1. `app/tests/billing-credits-ui.test.tsx` — `@/components/ui/dialog`
2. `app/tests/admin-credit-grant-ui.test.tsx` — 同上
3. `app/tests/admin-catalog-sync-ui.test.tsx` — 同上
4. `app/tests/admin-gateway-readiness.test.tsx` — 同上
5. `app/tests/personal-credits-ui.test.tsx` — 同上
6. `app/tests/bot-route-default-agent.fixture.tsx` — @copilotkit/react-core/v2 + 3 个 @/lib/copilot/*
7. `app/tests/channel-new-error-state.fixture.tsx` — @/components/layout/sidebar-toggle
8. `app/tests/home-fallback-routing.fixture.tsx` — sidebar-toggle + @/components/ui/carousel
9. `app/src/lib/upload-queue/queue.test.ts` — `@/lib/knowledge`(beforeEach 中安装)

注意: `composer-queue-attachments.test.tsx` 注释"Bun has no way to unregister a module mock"
描述的是 bun 原生 mock,不适用于 e2e-compat 重新实现(它有注销句柄)。

### 根因 B — preload 预热竞态(heroui-spike 串行失败)

`app/tests/preload.ts` 的预热链含两个顶层 await:
`await import("react-dom/client")`(无窗口)→ `GlobalRegistrator.register()` →
`await import("@heroui/react/modal")`(窗口内)→ unregister。

时序插桩(pid 标注)证明: 执行进程并发导入多个套件文件时,preload 实例在第一个
await 处让出事件循环,并发套件图在此间隙以 document=undefined 首次求值
`react-aria/dist/private/utils/useLayoutEffect.mjs`。该模块按
`typeof document !== 'undefined'` 做一次性决策 → no-op useLayoutEffect 锁死 →
该进程内所有 RAC Modal 退场(useExitAnimation 的 useLayoutEffect)永不完成 →
`data-exiting="true"` 挂起 → heroui-spike 两个 Modal ESC 测试断言失败。

- 收集进程串行导入无竞态(doc=true);执行进程并发导入出竞态(doc=false)。
- `detail-panel + heroui-spike` 配对(--workers 1)100% 复现;11 个 detail-panel
  用例逐个都复现(毒在文件级,不在具体用例)。
- 最小探针(已删)进一步钉死: 仅"前文件真实渲染过 Dialog/RAC Modal"即致毒,
  纯 div 渲染与纯生命周期(register/unregister)均无害 — 与 no-op 决策机制吻合
  (渲染触发退场路径;no-op 时退场永不完成)。

## 修复设计

### 修复 A(9 文件): 捕获注销句柄并在套件结束时注销

每处 `mock.module(...)` 改为 `const uninstallX = mock.module(...)`,并注册
`afterAll(uninstallX)`(queue.test.ts 为 beforeEach/afterEach 对)。五个 dialog
安装者文件头部注释中"registry-level and OUTLIVES THIS FILE"的表述同步修正为
"注册表级,但本文件在 afterAll 注销,同进程后续文件拿回真实模块"。

fixture 文件(6/7/8)在被宿主套件导入时求值 — 由 fixture 自身注册 afterAll
(从 e2e-compat 导入),宿主无需改动。

语义不变式: 安装者自己的测试仍在 mock 下运行(探针已证);同进程后续文件
拿回真实模块;真实模块本就是"最富语义",此前孤立运行全绿即证明兼容。

### 修复 B(1 文件): preload 预热临界区去 yield

`app/tests/preload.ts` 的 react-dom 预热与 modal 预热改为同步路径:
`createRequire(import.meta.url)` + Node 22 的同步 `require(esm)`,
顺序保持注释不变式(react-dom 先于任何窗口;modal 在窗口内)。
同步临界区内无事件循环让出点 → 并发套件图无法在窗口外首次求值 react-aria。
createRequire 不可用或 require(esm) 抛错时(如 bun 运行时),回退到现有
await 路径,回退前若已注册先 `await GlobalRegistrator.unregister()`。
预热完成后其余逻辑(i18n 等)保持不变。

## 验证(实现者执行,独立输出目录)

RED 基线(修复前已录): `final-closure-r7/native`(1006/1008)、
`final-closure-r7/native-r3`(1006/1008)、`native-w1`(1004/1008)。

修复后必须全绿:
1. `--workers 1 app/tests/billing-credits-ui.test.tsx app/tests/detail-panel.test.tsx`
2. `--workers 1 app/tests/detail-panel.test.tsx app/tests/heroui-spike.test.tsx`
3. 九个泄漏文件各自的孤立运行(含三个 fixture 宿主 + queue.test)
4. 全量 `E2E_UNIT_SCOPE=app` 默认 worker 连续 2 次
5. 全量 `--workers 1` 1 次(最强串行)
6. driven `E2E_BUN_ONLY=app/tests` 6/6、`E2E_BUN_ONLY=app/src` 1/1(preload 双层共用)
7. Biome(变更文件)、`bun run --cwd app typecheck`
8. 覆盖审计 `bun scripts/e2e-coverage-audit.mjs` 1078 无缺口

## 所有权与检查点

- 10 个目标文件均为既有脏基线内容(用户 2026-10-22/23 的自动同步提交已吸收),
  按 R-01 保护规则以边界化修复任务处理: sole writer = frontend_implementer,
  只读验证 = frontend_validator,独立复审 = reviewer。
- PRE: 各目标文件的 HEAD(599613c6)字节哈希与副本,存
  `.archive/runs/2026-10-20-workspace-redesign-b1/verification/final-closure-r7/repair/PRE/`。
- POST: 修复后哈希 + diff,同目录 `POST/`。
- 验证与复审绑定同一 POST 哈希;内容再变更则补做。

## 会话事件记录(修复期间发生,与修复无关但须留痕)

- 用户侧自动同步工具在会话期间两次提交(5cf35587 chore(sync) 00:18:42、
  599613c6 docs 00:19:59,作者 wuyj),吸收了本会话的验证工件与探针暂存;
  诊断插桩(preload.ts / node_modules react-aria 两个 .mjs)已在提交前还原,
  提交内的 preload.ts 干净(已核)。
- Ledger 既有"index 全暂存"守卫(git reset -q)在吸收性提交后失效;
  本会话执行过一次该守卫,worktree 字节未受影响。
- 主仓 HEAD reflog 存在不可读对象(fsck 报 invalid reflog entries)——
  历史性损坏,与本会话无关,不做处置,仅记录。
