# B1 native 确定性修复 — 独立验证报告(frontend_validator,2026-10-23)

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- 验证方式: 只读独立复跑,未修改任何生产代码/测试,未执行任何 git 写命令
- 依据: `docs/plans/2026-10-23-native-determinism-repair.md`、`docs/plans/reports/2026-10-23-native-determinism-repair-impl.md`
- 基线: `…/final-closure-r7/repair/{PRE,POST}/`;新鲜输出目录: `…/final-closure-r7/repair/validation/`

## 1. 哈希完整性

### 1.1 当前工作树 10 文件 vs POST/manifest.txt(shasum -a 256 独立重算)

10/10 逐条一致,无一漂移:

| 文件 | 现算哈希 = POST? |
|---|---|
| app/src/lib/upload-queue/queue.test.ts | 一致(b45ee175…) |
| app/tests/admin-catalog-sync-ui.test.tsx | 一致(fbfc23a7…) |
| app/tests/admin-credit-grant-ui.test.tsx | 一致(134c8221…) |
| app/tests/admin-gateway-readiness.test.tsx | 一致(33b13237…) |
| app/tests/billing-credits-ui.test.tsx | 一致(ec3e5bac…) |
| app/tests/bot-route-default-agent.fixture.tsx | 一致(d7542535…) |
| app/tests/channel-new-error-state.fixture.tsx | 一致(555572a6…) |
| app/tests/home-fallback-routing.fixture.tsx | 一致(e092604a…) |
| app/tests/personal-credits-ui.test.tsx | 一致(a623ad67…) |
| app/tests/preload.ts | 一致(398d519f…) |

完整哈希见 `POST/manifest.txt`(本次重算结果逐字节等于其内容)。

### 1.2 PRE 副本完整性

PRE 目录 10 个副本独立重算,10/10 与 `PRE/manifest.txt` 一致;PRE/POST `HEAD.txt` 均为
`599613c6f1c2fab8526c7e894a5fc27e67fdf910`,与实现报告声明一致。

### 1.3 PRE vs 当前 diff 抽样(3 个,覆盖三类修复)

抽样 billing-credits-ui(e2e-compat 修复 A)、preload.ts(修复 B)、admin-credit-grant-ui(bun-test-compat 修复 A)。
结论:三份 diff 均**仅限**实现报告所述范围,未发现越界改动:

- billing-credits-ui.test.tsx: 句柄捕获 `const uninstallDialogMock = mock.module(...)` + `afterAll(() => uninstallDialogMock())` + 头部两段注释按报告原文修正 + e2e-compat import 块的 biome 排序位移。无其他语句变化。
- preload.ts: `import { createRequire } from "node:module"` + 同步临界区 try 块(react-dom/client → register → @heroui/react/modal → unregister)+ catch 回退(先 isRegistered 判定 unregister 再走原 await 链),与报告 §一.10 逐点吻合。
- admin-credit-grant-ui.test.tsx: `const uninstallDialogMock: unknown = mock.module(...)` + 守卫式 `afterAll`(typeof function 判定)+ biome 格式化(import 展开多行、函数签名/实参换行)。mock factory 语义体未变。

附带核对:`import "./preload"` 在 7 个套件入口文件仍为第一行;3 个 fixture 文件本就以 react / bun-test-compat import 开头(PRE 亦然),不适用该不变式。

## 2. 新鲜复跑(独立输出目录 validation/,全部绿)

| # | 命令 | 退出码 | 结果行 | 期望 |
|---|------|--------|--------|------|
| a | `E2E_UNIT_OUTPUT=…/validation/v-bill-dp bunx e2e run --config e2e.unit.config.ts --workers 1 app/tests/billing-credits-ui.test.tsx app/tests/detail-panel.test.tsx` | 0 | Test Files 2 passed (2);Tests 29 passed (29) | 绿 |
| b | `E2E_UNIT_OUTPUT=…/validation/v-dp-spike bunx e2e run … --workers 1 app/tests/detail-panel.test.tsx app/tests/heroui-spike.test.tsx` | 0 | Test Files 2 passed (2);Tests 26 passed (26) | 绿 |
| c | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/validation/v-full-w4 bunx e2e run …` | 0 | Test Files 131 passed (131);Tests 1008 passed (1008) | 1008/1008,exit 0 |
| d | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=…/validation/v-driven-app bunx e2e run … tests/bun-suites.test.ts` | 0 | Test Files 1 passed (1);Tests 6 passed (6) | 6/6 |
| e | `E2E_BUN_ONLY=app/src E2E_UNIT_OUTPUT=…/validation/v-driven-src bunx e2e run … tests/bun-suites.test.ts` | 0 | Test Files 1 passed (1);Tests 1 passed (1) | 1/1 |
| f | `bunx biome check`(10 个目标文件) | 0 | Checked 10 files in 30ms. No fixes applied. | 全绿 |
| g | `bun run --cwd app typecheck` | 0 | tsc --noEmit 通过 | 全绿 |

每条命令的控制台输出已存 `validation/<dir>.console.log` / `v-biome.console.log` / `v-typecheck.console.log`;
a–e 的 report.json(`run.status=passed`,`run.exitCode=0`)在各自输出目录内。

## 3. 与实现报告声明的逐条对照

新鲜复跑 report.json(`run.summary.passed/failed`)vs 实现报告:

| 项 | 实现报告声明 | 实现 run report.json | 新鲜复跑 | 结论 |
|---|---|---|---|---|
| 门禁1 bill+dp w1 | 29 passed | v1-bill-dp: 29/0 | 29/0 | 一致 |
| 门禁2 dp+spike w1 | 26 passed(11+15) | v2-dp-spike: 26/0 | 26/0 | 一致 |
| 全量 w4 r1/r2 | 1008/1008 ×2 | 1008/0 ×2 | 1008/0(单轮) | 一致 |
| 全量 w1 | 1008/1008 | v4-full-w1: 1008/0 | —(任务未要求复跑 w1) | 一致 |
| 孤立 billing | 18/18 | g3-iso-billing: 18/0 | — | 一致 |
| 孤立 personal | 8/8 | g3-iso-personal: 8/0 | — | 一致 |
| personal+dp 配对加证 | 19/19 | g3-extra-personal-dp: 19/0 | — | 一致 |
| driven app/tests | 6/6 | g-driven-apptests: 6/0 | 6/0 | 一致 |
| driven app/src | 1/1 | g-driven-appsrc: 1/0 | 1/0 | 一致 |
| biome 10 文件 | 0 错误 | — | 0 错误 | 一致 |
| typecheck | 通过 | — | 通过 | 一致 |

内部一致性旁证: 29 = 18(billing 孤立)+ 11(detail-panel);26 = 11 + 15(heroui-spike);均自洽。

**未发现任何不一致。**

## 4. 偏离记录核实

1. **admin-credit-grant-ui.test.tsx 的 import 来源 = bun-test-compat**:属实。当前文件第 15 行
   `} from "../../tests/support/bun-test-compat";`,全文无 e2e-compat 引用(PRE 副本同源,该文件本就使用 bun-test-compat)。
2. **该文件不在 native 全量收集清单**:属实。新鲜 `v-full-w4/report.json` 共 131 个 file 条目,其中
   `app/tests/admin-credit-grant-ui.test.tsx`、`admin-catalog-sync-ui`、`admin-gateway-readiness`、
   三个 fixture、`app/src/lib/upload-queue/queue.test.ts`、`app/tests/preload.ts` 均 ABSENT;
   在列的是 `billing-credits-ui` 与 `personal-credits-ui`(与报告"机制完整生效的是 1、5、10"的分层描述一致;
   注:composer 目录另有同名 `app/src/components/channels/composer/queue.test.ts` 在列,非本次目标文件)。

## 5. 发现的差异

无。哈希、命令结果、report.json 数值、偏离记录四方面全部与实现报告吻合,未观察到修复签名之外的失败或范围外改动。

## 6. 总结论

**PASS** — POST 绑定的 10 文件哈希与工作树逐字节一致、PRE 基线完整、7 条验证命令新鲜复跑全部绿(含 1008/1008 全量、两个确定性配对、双 driven 层、biome、typecheck)、实现报告全部声明(含两条偏离)经独立核实属实,未发现任何不一致或范围外改动。
