# S04 Implementer Report：重复分钟描述去重（AC A04）

- **日期**: 2026-10-20
- **owner_role**: mechanical_worker
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`
- **正式 Issue**: [#493](https://github.com/1123786563/OpenBot/issues/493)（本地票 `docs/tickets/upstream-openbot-update/issues/up04.md`）
- **结论**: 完成。RED → GREEN 全程证据在案，`schedule.ts` 与上游参考逐字节一致，两文件 `bunx biome format` 真实 exit 0。

## 改动 diff（git diff 摘录，全部改动）

只改了两个 owned 文件，共 11 insertions / 1 deletion。

### `server/src/routines/schedule.ts`（+4 −1，与上游参考 `evidence/upstream-sources/server/src/routines/schedule.ts` 现已逐字节一致，`diff` 通过）

```diff
@@ -298,7 +298,9 @@ export function describeCron(cron: string): string {
         .split(",")
         .map((part) => parsePlainInt(part, 0, 59));
       if (minutes.every((value): value is number => value !== null)) {
-        const times = [...minutes]
+        // De-duplicated like `weekdays`: cron fires once for `0,0`, so it must not read as
+        // "09:00 and 09:00".
+        const times = [...new Set(minutes)]
           .sort((a, b) => a - b)
           .map((value) => `${pad2(hour)}:${pad2(value)}`);
         return `Every day at ${joinWords(times)}`;
```

唯一行为差异是分钟列表在排序前 `[...new Set(minutes)]` 去重（附上游原注释）；`describeCron` 签名、`nextOccurrence`、floor/DST/时区逻辑零改动。

### `server/tests/routine-schedule.test.ts`（+8，紧接既有 "a comma list of plain minutes on one hour" 用例之后）

```diff
+  // Cron fires once for a repeated minute — `0,0` is one firing, not two — so the prose must say
+  // it once. A duplicate in the list is dropped before the times are joined, the way `weekdays`
+  // says Sunday once when it arrives as both 0 and 7.
+  test("a repeated minute is described once", () => {
+    expect(describeCron("0,30,0 9 * * *")).toBe("Every day at 09:00 and 09:30");
+    expect(describeCron("0,0 9 * * *")).toBe("Every day at 09:00");
+  });
```

## RED 证据

命令：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/routine-schedule.test.ts`（先加测试、未改实现时运行）

- 新用例失败，且是唯一失败：

```
 FAIL |node| server/tests/routine-schedule.test.ts > describeCron > a repeated minute is described once
 ASSERTION_FAILED: expected "Every day at 09:00, 09:00 and 09:30" to be "Every day at 09:00 and 09:30"

 Test Files  1 failed | 0 passed (1)
      Tests  1 failed | 28 passed (29)
```

（首跑经管道转储时 `echo ${PIPESTATUS[0]}` 在 zsh 下失效显示 EXIT: 0，属取值方式错误，非运行器退出码；失败事实由上方 Test Files/Tests 计数证明。后续运行均改为重定向后直接 `echo $?`，如下。）

## GREEN 证据

同一命令，实现改为 `[...new Set(minutes)]` 后运行：

```
EXIT: 0
 Test Files  1 passed (1)
      Tests  29 passed (29)
   Start at  18:07:52
   Duration  287ms
```

- 新用例通过（含 `0,30,0 9 * * *` → `Every day at 09:00 and 09:30` 与 `0,0 9 * * *` → `Every day at 09:00` 同小时形态）。
- 既有 28 条全部保持：`nextOccurrence` DST 跨界、floor 句式（every-minute / */5 / 45,55 跨日 / 25 12 / 跨午夜）、15 分钟地板、时区拒绝、五字段契约、严格-after、`*/15` 通过、星期别名（7→Sunday、`0,7` 说一次、`6,7` 列表）、`*/20`/`*/15` 步进、`*/40` 与 `*/1` 回退原文、小时列表按设计回退、垃圾输入不抛——零回归。

## 格式与范围自查

- `bunx biome format server/src/routines/schedule.ts server/tests/routine-schedule.test.ts` → **exit 0**，输出 `Checked 2 files in 17ms. No fixes applied.`（真实退出码，直接 `$?` 取得；无需任何修复，新增行无格式问题，亦无触碰既有行）。
- `git diff --stat` 证实本任务仅触碰两个 owned 文件；工作区在场 S01–S03 改动（`server/src/config.ts`、`server/src/responsibilities/email.ts`、`server/src/telemetry/scrub.ts` 及 `server/tests/config.test.ts`、`enterprise-controls.test.ts`、`otel-export-scrubbing.test.ts`、`responsibility-triggers.test.ts`）不属于本任务、未被修改。
- 未 commit / 未 push / 未使用 git stash；未派发子 Agent。

## 调度不变性确认

去重只发生在 `describeCron` 的自然语言渲染分支（wideOpen + 单小时 + 纯分钟列表），不进入 `nextOccurrence` 的解析与 floor 判定；`0,30,0 9 * * *` 与 `0,30 9 * * *` 的实际触发时刻集合本来就相同（cron 对重复分钟只触发一次），故实际调度行为不变，仅描述不再读作 "09:00, 09:00 and 09:30"。
