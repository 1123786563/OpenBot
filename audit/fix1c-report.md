# FIX-1c：bifrost 域剩余 app 分区 A 缺口 — 修复报告

- 日期：2026-10-26
- 工作区/分支：`1123786563/b5r-fix1`（worktree `b5r-fix1`）
- 基线 HEAD：5aa40039c（REV-1b 双 PASS 后）
- 新 HEAD：**79b189119** `fix(FIX-B5-PART-A2): 分区 A 缺口 2 件 import 对齐 bun-test-compat……`，2 files changed, 2 insertions(+), 2 deletions(-)，未推送
- Run 归档：验证读数全文在 context-mode 批次索引（sections "Bun *" / "Native e2e * exclusion"），e2e 原生运行输出目录 `.e2e/2026-10-26-b5r-fix1c/<suite>/`（Report 未写出，系 NO_TESTS 排除路径的固有行为）

## 与任务描述的基线差异（经协调器裁决）

协调器早先的 git-blob 快速扫描把 4 件都列为「manifest 已登记但仍 import e2e-compat」。本 Worker 对当前 HEAD 完整文件实核：

- `app/tests/personal-credits-ui.test.tsx` 第 10 行、`app/tests/realtime-usage-ui.test.tsx` 第 9 行**已经** import `../../tests/support/bun-test-compat`（分别自 9f3a58f44 / e8ea2102a 即如此，先于本分支 7 件修复提交）——记为 **baseline-aligned，零改动**。
- 实际残留缺口只有 2 件：`async-jobs-ui.test.tsx`（第 9 行）与 `user-key-status-ui.test.tsx`（第 2 行）仍 import `../../tests/support/e2e-compat`。

裁决入口：orca ask（msg 回复「以实际 HEAD 字节为准，仅改 2 件，另 2 件记录 baseline-aligned；4 件仍全量验收」）；后续协调器 status 消息「continue FIX-1c」重申 realtime-usage-ui 的 3 fail 已另立 F-A8，不在本任务修。

## 代码改动（git diff 全量，无任何 import 行以外的变化）

```diff
 app/tests/async-jobs-ui.test.tsx    @@ -9
-import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
+import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
 app/tests/user-key-status-ui.test.tsx @@ -2
-import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
+import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
```

改写方向与 `scripts/e2e-apply-partition.mjs` 对 manifest 成员的改写一致（仅换 compat 层后缀；manifest 成员属 Bun 层，须 import `support/bun-test-compat`）。断言、fixture、测试名零改动。

## 验收读数（仓库根执行，均在含本修复的工作树上实测）

### Bun 运行器（`bun test app/tests/<f> --timeout=120000`）

| 套件 | exit | pass | fail | expect() | 备注 |
| --- | --- | --- | --- | --- | --- |
| async-jobs-ui | 0 | 4 | 0 | 19 | 修复后由 bun:test 正常收集执行（Ran 4 tests across 1 file, 458ms） |
| personal-credits-ui | 0 | 10 | 0 | 51 | baseline-aligned；与审计树读数 10/0 一致（411ms） |
| realtime-usage-ui | **1** | **0** | **3** | 2 | baseline-aligned 零改动；**存量失败**，见下节（两轮复跑同数 0/3，314ms） |
| user-key-status-ui | 0 | 4 | 0 | 16 | 修复后正常执行；与审计树读数 4/0 一致（307ms） |

### 原生 e2e 排除验收（`./node_modules/.bin/e2e run --config e2e.unit.config.ts app/tests/<f>`，各配独立 `E2E_UNIT_OUTPUT`）

四件行为完全一致：**exit=2，`configuration error NO_TESTS (collection)`**，报错原文逐件指名 `no test file matched app/tests/<f> (excluded by the tests entry "!app/tests/<f>")`，`Test Files no test files / Tests no tests executed`。**四件均无 COLLECTION_ERROR**。NO_TESTS 按任务约定记为排除验收（该文件由 e2e 驱动层经 Bun 执行，不走原生收集），不表述为「Node 下通过」。

## realtime-usage-ui 存量失败（本任务范围外，协调器已立 F-A8）

- 现象：3 条用例全败——`实时会话行渲染消费、待结算与异常原因，原始代码不进 DOM`、`空载荷渲染空句，不伪造行`、`实时面不可用时整节隐藏，不把错误装扮成空列表`。
- 根因形态：`TypeError: undefined is not an object (evaluating 'balance.account.status')`，抛在 `app/src/components/billing/personal-balance-card.tsx:54`（组件取 `balance.account.status`，测试侧 mock 的 balance 载荷无 `account` 键）；组件与套件最近一次实质改动同属 e8ea2102a（tenant scoping 批）。
- 归属判定：本修复未触碰该文件（HEAD blob 与本树逐字节相同），两轮复跑同为 0 pass/3 fail，系 pristine main 既存基线红，非分区 A import 层问题，亦非本任务引入。

## 结论

分区 A 缺口收敛：4 件清单成员现全部由 `bun-test-compat` 承载（2 件本批翻转 + 2 件 baseline-aligned），Bun 层全部可收集执行，e2e 原生层全部明确排除且无 COLLECTION_ERROR。遗留：realtime-usage-ui 3 fail 移交 F-A8。
