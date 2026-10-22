# B1 native 确定性修复 — 实现报告(2026-10-23)

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`(分支 feat/heroui-v3-migration)
- HEAD: `599613c6f1c2fab8526c7e894a5fc27e67fdf910`(实现期间未做任何 git 写操作,HEAD 未变)
- 依据: `docs/plans/2026-10-23-native-determinism-repair.md`(修复 A 九处 mock.module 注销 + 修复 B preload 预热临界区同步化)
- PRE 基线: `docs/verification/workspace-redesign/final-closure-r7/repair/PRE/`(与工作树逐字节一致,已核)
- POST: `docs/verification/workspace-redesign/final-closure-r7/repair/POST/`(10 文件副本 + manifest.txt + HEAD.txt + status.txt)

## 一、逐文件改动摘要(10 个)

### 修复 A — mock.module 注销句柄捕获

1. **`app/tests/billing-credits-ui.test.tsx`**(e2e-compat,机制完整生效)
   - `mock.module("@/components/ui/dialog", …)` → `const uninstallDialogMock = mock.module(…)`,
     其后注册 `afterAll(() => uninstallDialogMock())`(该文件原有 afterAll)。
   - 头部长注释两句修正:原 "registry-level and OUTLIVES THIS FILE. Later files … exercise the real
     Dialog's semantics through this mock" 改为 "registry level, but this file unregisters the handle
     in its afterAll, so later files in the same process get the real module back";原 "EVERY export,
     because mock.module is process-lifetime: a later test file importing chat-transcript…" 改为
     "because the mock module is generated from the factory's returned keys alone: this file's own
     graph (upgrade-dialog) …"。其余注释未动。
2. **`app/tests/personal-credits-ui.test.tsx`**(e2e-compat,机制完整生效)
   - 同上:捕获句柄 + `afterAll(() => uninstallDialogMock())`;头部注释
     "mock.module is registry-level and OUTLIVES THIS FILE: a simpler shell registered here would
     clobber…" 段修正为 "registry level, but each installer unregisters its handle at its own
     afterAll, so the passthrough never outlives the file that set it…"。
3. **`app/tests/admin-credit-grant-ui.test.tsx`**(bun-test-compat,见偏离 1)
   - `const uninstallDialogMock: unknown = mock.module(…)` + `afterAll` 守卫注销
     (`if (typeof … === "function") (… as () => void)()`)。
4. **`app/tests/admin-catalog-sync-ui.test.tsx`** — 同 3。
5. **`app/tests/admin-gateway-readiness.test.tsx`** — 同 3。
6. **`app/tests/bot-route-default-agent.fixture.tsx`**(4 个 mock.module)
   - 4 个返回值收进 `const uninstallMocks: unknown[] = […]`,fixture 内一个 `afterAll` 依次守卫注销;
     `afterAll` 从 `../../tests/support/bun-test-compat` 导入(见偏离 2)。
7. **`app/tests/channel-new-error-state.fixture.tsx`**(1 个)— 同 6 模式。
8. **`app/tests/home-fallback-routing.fixture.tsx`**(2 个)— 同 6 模式。
9. **`app/src/lib/upload-queue/queue.test.ts`**
   - `beforeEach` 内改为 `uninstallKnowledgeMock = mock.module("@/lib/knowledge", …)`(模块级变量,
     中文注释与本文件既有注释语言一致);既有 `afterEach` 扩展为先守卫注销再 `mock.restore()`。
     beforeEach 每轮重装行为不变。

### 修复 B — preload 同步临界区

10. **`app/tests/preload.ts`**
    - 新增 `import { createRequire } from "node:module"`。
    - react-dom/modal 预热改为 try 块同步临界区:`createRequire(import.meta.url)` →
      `void nodeRequire("react-dom/client")` → `GlobalRegistrator.register()` →
      `void nodeRequire("@heroui/react/modal")` → `GlobalRegistrator.unregister()`(不 await,同现状)。
    - 任一步抛错则 catch 回退:先 `if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()`,
      再走原 await 链(`await import("react-dom/client")` → register → `await import("@heroui/react/modal")`
      → unregister)。原 await import 从主路径移除(它是竞态让出点本体)。
    - 注释保留并扩写:react-aria 一次性 useLayoutEffect 决策、同步临界区消除事件循环让出点、
      "react-dom 先于任何窗口、modal 在窗口内" 不变式。
    - i18n 预热与其余部分未动。

### 范围内的 Biome 规范化(见偏离 4)

8/10 文件在 PRE 状态已不满足 `biome check`(organizeImports/format 存量漂移)。门禁 4 要求 10 文件全绿,
故对 10 文件执行 `bunx biome check --write`(仅 import 排序与格式化;所有语句原样,
`import "./preload"` 在全部文件保持第一行)。

## 二、PRE→POST SHA-256 对照(shasum -a 256)

```
PRE  6dbc1402f87e53a05d3afc7f83343134cd29550dbc3969371a960d7fe3a1ba92  POST b45ee1757fdd85d34f171f6571c4afe545d9f7fd42c013cc23304a7e28ef4d2b  app/src/lib/upload-queue/queue.test.ts
PRE  d5c000515518bc38f065a76797866e430b6f57b97ef845090a04e73f26d69261  POST fbfc23a7a86d2b18eec0366ad8bbf2ff215818f4eb019431cf7fee2941bb6da7  app/tests/admin-catalog-sync-ui.test.tsx
PRE  f92e05f1c954d9d2c9cb610117c4cb0fc79d4332969a1df1d030fc93afbbfb74  POST 134c8221bab03c8b61b277b50e02c467598b0979d07afd00b86ff40c40483656  app/tests/admin-credit-grant-ui.test.tsx
PRE  154c896f000c49507ffc389bf93be01a9c21c9f3ed115a2e45d60cd1a95f657a  POST 33b13237e6879a99ec8d1fedc0695da14433b5f25842ab0e97fc8e0ecbaded74  app/tests/admin-gateway-readiness.test.tsx
PRE  9b5e5b5cfc81caafd2dc9b66796f6317b32eb2861ce5dce47d0681fb2e03b077  POST ec3e5bac338838fe0bef618185ccb752d8d59c56df9d58ba8a8780e081abca24  app/tests/billing-credits-ui.test.tsx
PRE  e85bf35fb5ad280ddf6dd1c44f4ad59949e967fca33b16a297bde0c6ad0dffe5  POST d754253574633b3c687e4c48c86cb1905ac0788537cd33dda173cf628af60a34  app/tests/bot-route-default-agent.fixture.tsx
PRE  90e0a4b114959c7de39798a0544d5ca3b0bb85bc7dbdf3e1a8c442a8226f3cfc  POST 555572a6145fd1a12498c4c877ecdec6b6449f460d4cde4f270e8f9b62773eaa  app/tests/channel-new-error-state.fixture.tsx
PRE  70aa47fd6c575951ac0c417cce42e10e8a1a6d75ef442b474082636d75c2a023  POST e092604a55d25e1fd5533bee13dd7db7ac56fb6499b1bd8da6532608c29b998e  app/tests/home-fallback-routing.fixture.tsx
PRE  494f1acafba6574b923e2322fe0ca2f5b69e773f983a3a40fbfa1e635129fb8f  POST a623ad67e53dd518f4463da643fbca3d76e82ec12c4af449d6a27d448bd428c4  app/tests/personal-credits-ui.test.tsx
PRE  d589111c30b4f1ff6a73ffb2d506292f45eb6a883298c90983e9a00ada717790  POST 398d519f253af5dffc8f9643943479887b245536ebafc07e9bb0af836505ddb9  app/tests/preload.ts
```
(POST manifest 同 `POST/manifest.txt`;POST 副本已逐一与工作树核对一致。)

## 三、验证结果(8 条门禁,全绿)

| # | 命令 | 退出码 | 结果 |
|---|------|--------|------|
| 1 | `E2E_UNIT_OUTPUT=…/repair/v1-bill-dp bunx e2e run --config e2e.unit.config.ts --workers 1 app/tests/billing-credits-ui.test.tsx app/tests/detail-panel.test.tsx` | 0 | Test Files 2 passed (2);Tests 29 passed (29) — 修复前 2 failed |
| 2 | `E2E_UNIT_OUTPUT=…/repair/v2-dp-spike bunx e2e run --config e2e.unit.config.ts --workers 1 app/tests/detail-panel.test.tsx app/tests/heroui-spike.test.tsx` | 0 | Test Files 2 passed (2);Tests 26 passed (26)(detail-panel 11 + heroui-spike 15)— 修复前 spike 2 failed |
| 3 | 九文件孤立运行(每文件一条,exit 0):billing-credits-ui(e2e,18/18)、personal-credits-ui(e2e,8/8)、admin-credit-grant-ui(bun test,7/7)、admin-catalog-sync-ui(bun test,4/4)、admin-gateway-readiness(bun test,4/4)、bot-route-default-agent 宿主(bun test,11/11)、channel-new-error-state 宿主(bun test,7/7)、home-fallback-routing 宿主(bun test,3/3)、queue.test(bun test,10/10) | 全 0 | 全绿(层归属与命令差异见偏离 3) |
| 4 | `bunx biome check` 全部 10 个改动文件 | 0 | Checked 10 files, 0 错误 |
| 5 | `bun run --cwd app typecheck` | 0 | tsc --noEmit 通过 |
| 6 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/repair/v3-full-w4-r1 bunx e2e run --config e2e.unit.config.ts` | 0 | Test Files 131 passed (131);Tests 1008 passed (1008) |
| 7 | 同 6,输出目录 `…/repair/v3-full-w4-r2` | 0 | Test Files 131 passed (131);Tests 1008 passed (1008) |
| 8 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/repair/v4-full-w1 bunx e2e run --config e2e.unit.config.ts --workers 1` | 0 | Test Files 131 passed (131);Tests 1008 passed (1008) — 修复前 1004/1008 |

### 计划内补充(brief 八条之外,因改动了 driven 层文件而补做)

- 配对加证:`--workers 1 app/tests/personal-credits-ui.test.tsx app/tests/detail-panel.test.tsx`
  → exit 0,19/19(另一台 e2e-compat dialog 安装者,证明修复 A 不只对 billing 生效)。
- 计划 §验证.6 的 driven 层:`E2E_BUN_ONLY=app/tests bunx e2e run … tests/bun-suites.test.ts`
  → exit 0,6/6(四个 part + ai-observability + multitenancy);
  `E2E_BUN_ONLY=app/src` → exit 0,1/1。
- 未出现计划签名之外的新失败;未扩大修复范围。

## 四、关键事实核对与偏离(均经本会话探针实证)

1. **Bun 1.4.2 的 `mock.module` 不返回注销句柄**(偏离 1,影响 9 处中的 7 处)。
   计划把 9 处都归因于 e2e-compat 的 mock;实测 7 处(admin-* 三个、三个 fixture、queue.test)
   从 `tests/support/bun-test-compat.ts` 导入,即 **bun:test 原生 mock**(bun-types 1.4.0 签名
   `module(id, factory): void | Promise<void>`;运行时探针:pre-loaded 模块、相对/绝对/URL 说明符
   全部返回 `undefined`;`mock.restore()` 不还原 module mock,探针:b 文件在 restore 后仍拿到 42)。
   因此:
   - 这 7 处按 brief 同样做了"捕获返回值 + 套件结束注销"的注册,但当前运行时下守卫调用是
     **声明的 no-op**,Bun 未来一旦返回句柄即自动生效;文件内注释如实写明这一点。
   - 该层泄漏与 brief 的失败签名无关:native(1008)不含这些文件(它们在 driven 排除清单里,
     由 tests/bun-suites.test.ts 以 `bun test` 分组进程驱动),组进程即用即弃,组内文件顺序固定,
     RED 基线(1006/1008、1004/1008)的失败全部落在 native 层的 detail-panel 与 heroui-spike。
   - 机制完整生效的是 1、5(billing-credits-ui、personal-credits-ui)与 10(preload),
     恰好覆盖全部已知失败签名;门禁 1/2/6/7/8 全绿为证。
2. **fixture 的 `afterAll` 从 bun-test-compat 导入,而非 brief 所写的 e2e-compat**(偏离 2)。
   三个 fixture 及宿主只被 `bun test` 执行;在 bun 进程里导入 e2e-compat(即 e2e runner 的
   hook API)会破坏 driven 层。`afterAll` 改从 fixture 已在用的 bun-test-compat 导入。
3. **门禁 3 的命令按层执行**(偏离 3)。brief 给 queue.test 的 `bunx e2e run …
   app/src/lib/upload-queue/queue.test.ts` 实测 `NO_TESTS`(driven 排除清单的 `!` glob 对
   positional 生效,positionals 不能绕过 config globs,e2e cli 文档亦如此声明,exit 0 但
   "no test file matched");三个 fixture 宿主同理。故 driven 文件的孤立运行用其真实执行层
   `bun test <绝对路径>`。另注意:`bun test` 参数是子串过滤器,首轮曾把 `docs/verification/…/PRE/files/`
   下的同名 PRE 副本一起拉进进程(报告 2 files),改用绝对路径后重跑为干净单文件结果。
4. **10 文件内的 Biome 规范化**(偏离 4):8/10 文件 PRE 即 biome 红(organizeImports/format 存量),
   门禁 4 要求全绿,故在 10 文件范围内应用 `bunx biome check --write`;diff 仅为 import 排序与
   格式化,无语句变化,preload-first 不变式逐文件核过。
5. preload 同步路径已实证:`react-dom/client` 与 `@heroui/react/modal` 在 Node v22.22.3 上
   `require(esm)` 均同步求值(27ms/258ms,无 TLA);react-dom 的 CJS 底层实例与 ESM import 共享
   (`createRoot` 同一引用),scheduler 预热不变式保持。Bun 路径走 catch 回退(与其文档一致),
   双层 preload 共用不受影响(driven 6/6、1/1 为证)。

## 五、结论

- 改动文件:10 个(全部在 brief 清单内),无其他文件改动,无 git 写操作。
- 门禁 1–8:全绿(2 个配对、9 个孤立、biome、typecheck、全量 w4 两轮、全量 w1 一轮),
  另加 driven 层 6/6 与 1/1、personal+detail-panel 配对加证。
- POST 哈希与本报告绑定;若工作树内容再变更需按计划补做验证。
