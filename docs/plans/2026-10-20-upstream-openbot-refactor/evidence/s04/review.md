# S04 Independent Review：例程时间描述重复分钟去重（AC A04，Issue #493）

- Reviewer：独立 reviewer（只读；唯一写入为本报告）。日期 2026-10-20。
- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`，HEAD = `3b4a7c68`（与实施/验证基线一致）。
- 审查范围：S04 两文件增量（`server/src/routines/schedule.ts`、`server/tests/routine-schedule.test.ts`）。after-tracked.diff 中 `server/src/config.ts`、`server/src/responsibilities/email.ts`、`server/src/telemetry/scrub.ts`、`server/tests/config.test.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`、`server/tests/responsibility-triggers.test.ts` 为 S01–S03 已验收在场改动，不在本次范围。
- 质量关口定位：OCR 关卡已按用户指示取消，本 Review 为 S04 最终质量关口。

## 独立复核记录（全部亲自执行）

| 项 | 命令/方法 | 结果 |
| --- | --- | --- |
| e2e 验收 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/routine-schedule.test.ts` | **exit 0，29 passed (29)，0 failed**，与实现者报告一致；新用例 `a repeated minute is described once` 与全部既有用例同场通过 |
| 上游一致性 | `diff` 本地 `schedule.ts` vs `evidence/upstream-sources/server/src/routines/schedule.ts` | **逐字节一致（IDENTICAL）**，含上游原注释 `De-duplicated like \`weekdays\`: cron fires once for \`0,0\`...` |
| 证据绑定 | `git diff` 两文件 vs `after-tracked.diff`；另比对 s03/after-tracked.diff → s04/after-tracked.diff 增量 | 两处 hunk（schedule.ts `@@ -298,7`、test `@@ -182,6`）与证据逐字一致；**S03→S04 增量恰为这两个 owned 文件**，S04 未触碰任何其他文件 |
| 改动最小性 | `git diff HEAD -- server/src/routines/schedule.ts` | 仅 1 行改动（`[...minutes]` → `[...new Set(minutes)]`）+ 2 行上游注释；`nextOccurrence`、`refuseSubFloorCycle`、floor/DST/时区逻辑与 HEAD **逐字节相同** |
| 行为抽查 | `bun -e` import 当前模块，12 组独立断言 | `0,30,0 9 * * *`→`09:00 and 09:30`；`0,0 9 * * *`→`09:00`（joinWords 单元素路径）；`5,05 9 * * *`→`09:05`（同分钟异写法合并）；`* * 7`→`Sundays`、`* * 0,7`→`Sundays`（说一次）、`* * 6,7`→`Saturdays and Sundays`；fallback `*/7 3,4`→原文、`30 9,10`→原文、`1-5`→`Weekdays`；`45,55 8`→`08:45 and 08:55`。排序/文案格式全部保持（初查一组 mismatch 系 reviewer 自己期望值笔误，实现本身正确：`30 9 * * *`→`Every day at 09:30`） |
| RED 真实性 | 按被删除的 BASE 算法（`[...minutes]` 不去重）独立重放 | `0,30,0` → **`Every day at 09:00, 09:00 and 09:30`**、`0,0` → `Every day at 09:00 and 09:00`，与实现者 RED 断言失败信息**逐字一致**；HEAD 测试计数 28 → 当前 29（+1），与 RED 报告 `1 failed \| 28 passed (29)` 算术吻合 |
| format / lint | `bunx biome format` + `bunx biome lint --error-on-warnings` 两文件 | 均 exit 0，`No fixes applied` |
| 类型检查 | `bunx tsc --noEmit`（server，重定向后取真 `$?`） | exit 2，恰 3 个错误全部在 `scripts/bootstrap-local-gateway.ts`（本分支 0 改动的既有错误，与 S03 review 记录相同）；**无 S04 引入的新错误**（见 F3） |
| seam 结构 | 测试源码核对 | 新用例只断言公共 `describeCron(cron): string` 返回值，置于同型兄弟用例 `a comma list of plain minutes on one hour` 之后；无内部函数单测 |
| 防回退项 | 源码核对 + diff hunk 范围 | `weekdays()` 别名/`0,7` 去重、fallback try/catch、`nextOccurrence` 的五字段契约、时区校验、floor 判定全部原样；`describeCron` 签名未动 |
| 消费方影响 | grep 全仓 `describeCron` 使用 | `craft/scheduled-tasks.ts`、`routines/store.ts`、`routines/routes.ts` 均只作展示文本（注释明示 "opaque display text, never a value to parse"）；仅 `routine-schedule.test.ts` 测它；全仓无任何断言旧重复文案（`09:00 and 09:00`）的残留 |
| 引擎层交叉验证 | `CronExpressionParser.parse` 直接探测 | 解析器对任意字段列表**拒绝重复值**（`CronMinute Validation error, duplicate values found: 0`），故 `nextOccurrence` 对重复分钟表达式改动前后同样拒绝（代码零改动）——见 F1 |

## Spec compliance 逐条核对（Spec §2 第 5 条调度句 / up04 AC）

| AC / Spec 条目 | 证据 | 结论 |
| --- | --- | --- |
| `0,30,0 9 * * *` 只描述 09:00 和 09:30；`0,0` 只描述一次 | 独立 e2e 29/29 + `bun -e` 行为抽查双证实；`[...new Set(minutes)]` 在排序前去重 | 满足 |
| 去重后保持排序和原有文案格式 | Set→`sort((a,b)=>a-b)`→`pad2`→`joinWords` 链与既有顺序/格式零改动；数值排序下去重先后等价 | 满足 |
| 其他 cron 形态兼容（weekday 别名、重复星期、fallback） | 7→Sunday、`0,7` 说一次、`6,7` 列表、`*/7 3,4`/`30 9,10` 回退原文全部在独立抽查与 29 用例中通过；改动仅在「单小时 + 纯分钟列表」分支内 | 满足 |
| 下一次触发时间、时区、DST、最小间隔不变 | diff 仅触 `describeCron` 分钟列表分支；`nextOccurrence` 及 floor/DST 逻辑与 HEAD 逐字节相同；既有 DST 跨界、15 分钟地板、`45,55` 跨日、严格-after 用例全绿 | 满足 |
| 去重只作用于可描述集合，不改变 next occurrence | 去重发生在 `minutes.every(parsePlainInt 校验通过)` 之后的渲染分支，不进入解析/调度路径；另证：解析器本就拒绝重复值表达式，调度层改动前后行为一致 | 满足 |
| 补丁只涵盖描述语义；定向验证与独立审查证据交付 | numstat：schedule.ts **3/1**（含注释）、test **8/0**；本报告即独立审查证据 | 满足 |

## Findings

无 Blocker / Major / Minor。以下均为 Info 级。

### F1（Info）：报告/注释的机制表述与仓库引擎实际行为有出入（结论不受影响）

实现报告称「`0,30,0 9 * * *` 与 `0,30 9 * * *` 的实际触发时刻集合本来就相同（cron 对重复分钟只触发一次）」，源码注释（上游原文）亦称 "cron fires once for `0,0`"。本仓实测：`cron-parser` 对重复值列表直接**拒绝解析**（`CronMinute Validation error, duplicate values found: 0`），`nextOccurrence` 对这类表达式改动前后均抛 `ScheduleRefusedError(UNREADABLE_MESSAGE)`——即调度引擎从未接受过重复分钟表达式，正常创建路径不可能产生此类 routine，`describeCron` 只会从非 API 来源见到该形态。**不变性结论本身为真**（nextOccurrence 代码零改动、改动前后同样拒绝，已亲证），不构成缺陷；且注释为上游逐字原文，brief 明确要求与上游一致，不应改写。仅记录在案：后续读者不应据此推断「重复分钟 routine 可被调度」；若上游后续修描述，不改变本仓验收门行为。

### F2（Info）：zsh PIPESTATUS 误读不影响其 RED 证据可信度

实现者披露首跑 `echo ${PIPESTATUS[0]}` 在 zsh 下取值失效显示 EXIT: 0。该误读不削弱证据：RED 失败事实由运行器自身输出承载（断言信息 `expected "Every day at 09:00, 09:00 and 09:30" to be ...` + `1 failed | 28 passed (29)` 计数），且本 reviewer 用 BASE 算法独立重放得到**逐字相同**的失败文案；误读被主动披露而非掩盖，后续证据全部改为重定向后直接 `$?`（本 reviewer 复核 format/lint/e2e 时同法取得真实退出码，均与报告一致；复查期间 reviewer 本人在一次管道 tsc 运行上犯了同类错误并当场纠正，亦佐证该纪律的必要性）。判定：披露诚实、纠正到位、结论可独立复现，证据可信。

### F3（Info，既有）：tsc 既有错误非 S04 引入

`bunx tsc --noEmit` 报 3 个错误，全部位于 `scripts/bootstrap-local-gateway.ts`（本分支 0 改动文件，S03 review 已记录同一组错误）。S04 两文件无任何类型错误。

## 结论

改动为与上游参考逐字节一致的最小去重（1 行代码 + 2 行上游注释），测试仅经公共 `describeCron` seam 断言且紧邻同型兄弟用例；调度、时区、DST、floor、weekday 别名、重复星期、fallback 全部零回归；RED/GREEN 证据链完整且经独立重放证实；S04 增量严格限定在两个 owned 文件。

Spec compliance: pass
Code quality: pass
