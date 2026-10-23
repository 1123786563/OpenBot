# ME14 Fix Round 1 Report — F1 在途处置契约词校验（invalid_disposition / invalid_effect）

- Date: 2026-10-23。Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`，branch `1123786563/mastra-exec2-2`，HEAD `46b4180ed3`（无 commit/push/stash；本票增量叠加在 ME11/ME12/ME14 既有未提交增量之上，其余增量零触碰）。
- 评审来源：独立评审 F1（Medium）。单票单修，范围即 F1。

## 0. 处置（disposition）

**缺陷确认（修复前探针，真实输出）**：`classifyInFlight`（cutover.ts:1010-1024 原行号）对任何不在契约分支词表内的处置词与 convert-pause 效果词静默放行——

- 处置词 `isloate`（isolate 拼写错）→ `ok:true`，线程**静默移出切换集**（ledger 记 `{"kind":"excluded","disposition":"isloate"}`）；
- 处置词 `legacy_drain`（连字符写成下划线）→ `ok:true`，同样静默 exclude（应得的 `not_drained` 排空拒绝被跳过）；
- convert-pause 效果词 `receipt`（receipted 拼写错）→ `ok:true`，**静默转换**（垃圾词被当作已知外部效果）。

与文件内已有的 unknown run id（`unknown_item`）和 unknown entry id（typo 防护）同一失败等级的拼写错类，此前从 exclude/convert 落穿路径漏过。

**修复**：逐条目校验，违例在**任何门通过之前**给具名拒绝（沿用文件既有 `xxx:<id>` 风格）：

- `disposition ∈ {convert-pause, legacy-drain, isolate, re-initiate}` → 违例拒绝 `invalid_disposition:<runId> ("…") — use one of convert-pause|legacy-drain|isolate|re-initiate`；
- （仅 convert-pause）`effect ∈ {none, receipted, unknown}` → 违例拒绝 `invalid_effect:<runId> ("…") — use one of none|receipted|unknown; an unknown effect must isolate instead`。`unknown` 仍是契约词（保持既有 `convert_requires_known_effect` 拒绝语义，不按拼写错拒绝）；
- 校验同时覆盖 `classifyInFlight` 两个循环（在途条目循环 + 非在途 id 循环：幽灵 id 上的拼写错处置词现在也是 `invalid_disposition:<id>` 而非笼统 `unknown_item`）；
- CLI（server/scripts/mastra-agent-cutover.ts）不再盲 cast `DISPOSITIONS` JSON：新增导出 `parseInFlightDispositions(input: unknown)` 在解析时校验整个账本形状（含非对象条目、非对象账本），违例以同一具名错误 `CUTOVER_DISPOSITIONS_INVALID: <failures>` 退出码 2 拒绝，在任何数据库连接/门评估之前。

## 1. RED → GREEN（TDD）

### 1.1 RED（先证伪，先写测试）

新测试先行写入 `server/tests/mastra-cutover-switch.test.ts`（+5 案，见 §2）：

- 模块级 RED：`bun test server/tests/mastra-cutover-switch.test.ts` → `SyntaxError: Export named 'parseInFlightDispositions' not found in module '…/cutover.ts'`（0 pass / 1 fail，与 ME14 原始 RED 同型）。
- 行为级 RED（旧代码探针，修复前）：§0 三条 `ok:true` 静默 exclude/convert 输出，即被本修拒绝的行为。

### 1.2 GREEN（实现后）

- `cd server && bun test tests/mastra-cutover-switch.test.ts` → **40 pass / 0 fail / 123 expect()**（35 → 40，+5 案）。
- `ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test tests/enterprise/mastra-cutover.integration.test.ts`（server/ 下）→ **15 pass / 0 fail / 64 expect()**（不变，全绿）。
- 修复后探针：三条垃圾词全部 `ok:false` 且具名（`invalid_disposition:run-1 ("isloate") — …`、`invalid_disposition:run-1 ("legacy_drain") — …`、`invalid_effect:run-1 ("receipt") — …`）；`parseInFlightDispositions` 对垃圾词 `{ok:false}`、对合法账本 `{ok:true}` 原样回传。

## 2. 新增测试（+5，全部先 RED 后 GREEN）

1. `an unrecognized disposition word is a named refusal, never a silent exclude`——`isloate` 与 `legacy_drain` 在途条目具名拒绝（`invalid_disposition:<runId>`，无 `not_drained` 混入）；幽灵 id 上的 `legacy_drain` 同样具名拒绝。
2. `a garbage effect on a convert-pause is a named refusal, never a conversion`——`effect: "receipt"` → `invalid_effect:run-1`，且不是 `invalid_disposition`。
3. `every contract disposition and effect word still classifies`——四个契约处置词 + `effect: "none"` 照常分类；`effect: "unknown"` 仍走既有 `convert_requires_known_effect`（契约词，非拼写错）。
4. `the CLI's ledger parse checks the JSON shape with the same named errors`——`parseInFlightDispositions` 拼写错/非对象条目具名拒绝；合法账本原样回传。
5. `a typo'd disposition refuses the switch before any thread is bumped`——`runCutover` 端到端：`isloate` → `CUTOVER_GATES_FAILED` 内含 `invalid_disposition:run-1`，`ports.bumps === []`（零线程 bump、零排除）。

## 3. 门禁（commands + counts）

- **双 ME14 套件**：40/0/123（unit）、15/0/64（integration，真 PG `openbot_test@5433`）——均绿。
- **32 文件 mastra 波**：文件清单 = `tests/config/e2e-bun-suites.json` manifest 内 `server/tests/` 的全部 `mastra-*`（33 件）减 `mastra-storage.integration`（主侧既有环境红，不在波内）= 32 件（清单落盘 `/tmp/me14-wave-32.txt`）。`ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test <32 件>` → **379 pass / 0 fail / 1782 expect()**，复跑第二轮同计数（379/0/1782）。分解核对：其余 30 件 = 324 pass（与 ME12 控制器 30 文件波 324/0 记录一致）+ 本票 unit 40 + integration 15 = 379。注：me14/report.md §1.3 既有记录为 376/0（实现者 1767 expect、控制器 1759 expect，两口径本已漂移）；本报告以本清单与命令的实际计数为准，两轮全绿。
- **tsc**：`bun run --cwd server typecheck` → 恰 **3 条基线**（`scripts/bootstrap-local-gateway.ts` 106/108/120），`grep -c "error TS"` = 3，本修 0 新增。
- **biome**：`bunx biome check server/src/mastra/cutover.ts server/scripts/mastra-agent-cutover.ts server/tests/mastra-cutover-switch.test.ts` → **Checked 3 files, No fixes applied**（clean）。

## 4. 文件清单（本修增量，全部未提交）

- `server/src/mastra/cutover.ts`：新增契约词表（`IN_FLIGHT_DISPOSITION_VALUES` / `IN_FLIGHT_EFFECT_VALUES`）、`inFlightEntryFailures` 逐条目校验、导出 `parseInFlightDispositions`；`classifyInFlight` 两循环接入校验 + 文档补一行。
- `server/scripts/mastra-agent-cutover.ts`：`DISPOSITIONS` 读入改为 `parseInFlightDispositions` 解析时校验，违例 `CUTOVER_DISPOSITIONS_INVALID` exit 2。
- `server/tests/mastra-cutover-switch.test.ts`：+5 案（§2）+ import 一行。

## 5. 边界

无生产 apply/切换/停机/发布；全部验证为单测与授权一次性 fixture 库（既有 integration 套件自身 teardown DROP）；无 commit/push/stash；`git status` 文件集与本修前完全一致（三件触达文件均在既有未提交增量集内）。最小改动：契约词表与既有分支词面逐一对照（`convert-pause|legacy-drain|isolate|re-initiate`、`none|receipted|unknown`），未改动任何既有合法路径语义。
