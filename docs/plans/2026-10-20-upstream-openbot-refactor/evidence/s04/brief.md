# Task Brief S04：重复分钟描述去重

- **Task/AC**: S04 / A04。正式 Issue：[#493](https://github.com/1123786563/OpenBot/issues/493)（本地票 `docs/tickets/upstream-openbot-update/issues/up04.md`）。
- **owner_role**: mechanical_worker（你，机械精确性优先）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push。

## 事实源

1. Spec §2 第 5 条调度句：只去重可描述的分钟集合，不改变 next occurrence。
2. 上游参考（只读）：`evidence/upstream-sources/server/src/routines/schedule.ts` ——唯一差异是分钟列表在排序前 `[...new Set(minutes)]` 去重（上游注释：`0,0` 不应读作 "09:00 and 09:00"）。
3. `describeCron(cron:string):string` 签名与 `nextOccurrence` 相关逻辑不动。

## owned_files

- `server/src/routines/schedule.ts`
- `server/tests/routine-schedule.test.ts`

## 要求（RED→GREEN）

1. **RED**：断言 `describeCron('0,30,0 9 * * *') === 'Every day at 09:00 and 09:30'`；`0,0` 只描述一次（同小时形态）。先运行证明失败。
2. **GREEN**：最小改动（Set 去重后再按现有顺序/格式化）；weekday 别名、重复星期、无法自然描述 fallback、DST、最小间隔、next-occurrence 测试全部保持通过。
3. **V-N**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/routine-schedule.test.ts`。

## 禁止

- 不修改 cron 执行/时区/间隔逻辑；不改自然语言格式其他部分；不修改其他文件/ledger/docs。

## 报告

`evidence/s04/implementer-report.md`：改动 diff、RED/GREEN 证据、回归确认。
