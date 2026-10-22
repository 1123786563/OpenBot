# S04 Validator Report：重复分钟描述去重（AC A04，Issue #493）

- **日期**: 2026-10-20
- **validator**: backend_validator（只读验收；唯一写入为本文件）
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`
- **材料**: `evidence/s04/implementer-report.md`、`evidence/s04/after-tracked.diff`、上游参考 `evidence/upstream-sources/server/src/routines/schedule.ts`
- **结论**: **ACCEPT —— 四项全 PASS**。一处记账性备注（+4/-1 实测为 +3/-1），不影响实质。

## 1. 行为 —— PASS

亲跑（validator 本人在工作区根目录执行，exit code 直接 `$?` 取得）：

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/routine-schedule.test.ts
→ EXIT: 0
  Test Files  1 passed (1)
       Tests  29 passed (29)
```

新用例 `describeCron > a repeated minute is described once` 在运行清单中出现且通过。另用 bun 直接 import `server/src/routines/schedule.ts` 独立复核两条断言（不经测试框架）：

- `describeCron("0,30,0 9 * * *")` → `"Every day at 09:00 and 09:30"` ✓
- `describeCron("0,0 9 * * *")` → `"Every day at 09:00"` ✓
- 回归对照：`describeCron("0,30 9 * * *")` → `"Every day at 09:00 and 09:30"`（与既有用例一致，未受影响）

## 2. 调度不变 —— PASS

- `git diff -- server/src/routines/schedule.ts` **仅一个 hunk**（@@ -298,7 +298,9 @@，位于 `describeCron` 的 wideOpen + 单小时 + 纯分钟列表渲染分支内）。`nextOccurrence`（schedule.ts:143–178）、`refuseSubFloorCycle`、时区校验、`MINIMUM_INTERVAL_MS` 间隔判定、DST 相关逻辑**零 hunk、零改动**。
- 去重位置：`const times = [...new Set(minutes)]` 在 `.sort()` **之前**、在 `${pad2(hour)}:${pad2(value)}` 文案格式化**之前**，仅作用于自然语言渲染分支；不进入任何解析/触发路径。
- `server/src/routines/schedule.ts` 与上游参考 `evidence/upstream-sources/server/src/routines/schedule.ts` 逐字节比对：**diff 为空**（exit 0）。
- 消费方复核：`describeCron` 的输出只进展示层（`server/src/routines/store.ts:654` 的 `schedule:` 字段、`server/src/craft/scheduled-tasks.ts:220`），且 `server/src/routines/routes.ts:148` 明文约定它是 "opaque display text, never a value to parse"。实际调度始终用原始 cron 经 `nextOccurrence`，cron 对重复分钟本就只触发一次，故去重不可能改变任何触发时刻。

## 3. 范围 —— PASS（含一处记账备注）

- `git diff --numstat`：`server/src/routines/schedule.ts` **+3 / −1**；`server/tests/routine-schedule.test.ts` **+8 / −0**（纯插入，单一 hunk，无任何既有行被修改或删除）。
- 验收清单写的 "schedule.ts +4/-1" 与实施报告 "+4 −1" 实测应为 **+3/-1**（1 deletion：`-        const times = [...minutes]`；3 insertions：两行注释 + 一行 `new Set` 代码）。"4" 来自 `git diff --stat` 的 4 格标记（3+1 合计），属计数口径误读。**实质无影响**：改动就是最小去重三行，别无其他。
- 既有断言零削弱：测试文件 hunk 中既有行全部是上下文行；`"a comma list of plain minutes on one hour"`（`0,30 9 * * *` → `Every day at 09:00 and 09:30`）原文未动，本次运行仍然通过。
- 范围封闭：工作区 tracked 修改恰为 after-tracked.diff 所列 9 个文件；除 S04 两个 owned 文件外的 7 个（config.ts、email.ts、scrub.ts、config.test.ts、enterprise-controls.test.ts、otel-export-scrubbing.test.ts、responsibility-triggers.test.ts）属已验收的 S01–S03，不在本任务范围；未跟踪文件仅 docs/ 下材料。无越界改动。
- 格式：`bunx biome format server/src/routines/schedule.ts server/tests/routine-schedule.test.ts` → **exit 0**（`Checked 2 files in 3ms. No fixes applied.`）。

## 4. RED 真实性 —— PASS

按修复前逻辑（`[...minutes]` 无 Set）对 `"0,30,0 9 * * *"` 做独立路径复算：minutes = [0, 30, 0] → 排序 [0, 0, 30] → times = ["09:00","09:00","09:30"] → `joinWords`（schedule.ts:210，`"A, B and C"` 规则）→ **`"Every day at 09:00, 09:00 and 09:30"`** —— 与报告 RED 失败消息逐字符一致：

```
expected "Every day at 09:00, 09:00 and 09:30" to be "Every day at 09:00 and 09:30"
```

失败计数 `1 failed | 28 passed (29)` 与现状 29 条用例（28 既有 + 1 新增）吻合；新用例内第一条 `expect` 先抛，故仅出现第一条断言的失败消息，报告只引用该条亦与执行语义一致。报告还主动披露了首跑 `PIPESTATUS` 在 zsh 下取值失效的取码错误并改用 `$?` 复跑，属诚实记录，反而增强可信度。RED 判定为真实且与逻辑一致。

## 备注（不阻塞验收）

1. 上文 +3/-1 vs +4/-1 的计数口径差异，建议在归档时更正实施报告那一行（validator 无权代改）。
2. 本验收未重跑 RED（需临时改源码，超出只读权限），真实性由逐字符路径复算 + 计数对账证明。
