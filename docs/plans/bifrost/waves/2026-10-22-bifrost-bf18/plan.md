# Bifrost 15.4–15.7（#317/#318/#319/#320）实施计划

- Run: `.archive/runs/2026-10-22-bf18-15x/`（ledger、快照、验证证据）
- 工作区：本 worktree bf18 = main@a789f6a4 + 未提交前置增量；分支 `1123786563/bf18`，不 commit 不 push
- 基线核验（2026-10-22 已做）：
  - bifrost 子模块本地 clone pinned **ad9470a5**（= gitlink；bf13 的 pin e44890f8 是其父，ad9470a5 仅多一个 docs 提交），并按 artifacts 规则显式复制 bf13 的 8 个未提交 15.x 门控链文件（哈希核对 8/8，见 checkpoints/bifrost-baseline-transfer.sha256）
  - 前置三套件实跑：realtime-session-identity + realtime-unit-reservation 21/0（bf18 库）；governance 全量 ok；其中两个 realtime fixture 缺 bf17 的 video_input 键，按 bf17 报告原样补（哈希一致，记为基线修复非自有增量）
  - bf18 测试库已建（orca-w3-bf-pg@5566，OrbStack 引擎挂死重启后恢复，容器四只原样拉起）

## 语义总纲（四票共用的串行模型）

会话的钱按单元移动，任一时刻至多一个"在耗"单元：holds（reserved/processing）且预算未尽的单元是 live 单元；输入只活在 live 单元下；新单元只在前序单元终结（settled/unknown/refused）或预算耗尽后才能开。拒绝优先于排队：一律拒绝并记录，绝不缓冲。资金绝不超过 hold 上限；确认不了的尾部进 unknown 由 08.x 处置。

## #317 15.4 旧单元未结清不放开新输入（bifrost Go）

门控（realtimeinputgating.go）加三层判定，全部由 15.2 注册表推导、无新增客户端可达输入：

1. **live 单元续用**：选单元从"最新记录"改为"最旧的 holds+有预算单元"——更新的无 hold 记录（新 unitId）永远不能顶掉 live 旧单元，也不触发新 door 调用。
2. **在途开单元拒绝**：会话存在 pending input_audio 单元时，并发 billed 输入拒绝（新拦截码 `unit_open_in_progress`），零 door 调、零新单元、可观测。
3. **refused 锁存**：最新 input 单元 refused 且无 live 单元时，后续 billed 输入一律按原拒绝类别拦截，不再 mint 单元、不再调 door（客户端节奏不能制造无界单元/记录）。
4. **有界观测**：Stats 改为运行计数器；拦截记录环形保留最近 64 条，计数永真。

测试 `realtimeserialization_test.go`（-run RealtimeUnitSerialization）：新 unitId 不放行（旧 live 单元续用、无第二 hold）、并发在途拒绝、锁存后 flood 的单元数/记录数有界、策略对闭集内 billed 类型一致且非 billed 事件不受影响、15.3 预算滚存回归。

## #318 15.5 耗尽后停止后续单元（server + Go）

- **0203_realtime_session_stop.sql**：realtime_sessions 加 `stopped_at`/`stop_reason` + 形状 CHECK（两者同空或同非空）。停止≠关闭：state 仍 open（closed 形状是 15.6 的）。
- realtime-unit.ts：openUnit 前置检查 stopped → 拒绝码 `session_stopped`（携带 stopReason，无单元行）；reserve 拒绝为 `insufficient_credits` 时同事务把会话写 stopped。
- 会话记录（restore/RealtimeSessionRecord）携带 stoppedAt/stopReason——耗尽与网络错误码可区分、对读方可见。
- Go：门控加拦截码 `unit_reserve_exhausted`（door 码映射 CreditRefusalInsufficientBalance 时），与 unreachable/其他拒绝在统计上可区分；锁存后同因复拒。
- 测试：`server/tests/realtime-exhaustion.integration.test.ts`（余额只够一个单元→第二单元 insufficient_credits+会话 stopped→第三单元 session_stopped、0 新 hold、既有 hold 停止后仍可结算）+ Go 用例。

## #319 15.6 撤销/到期阻止后续单元并尽力关停（server + Go）

- realtime-session.ts 加 `close(sessionId, reason)`：guarded open→closed（closed_at+close_reason，0193 closed 形状 CHECK 的首写）。
- realtime-unit.ts openUnit：reserve 拒绝属授权族（grant_invalid/payer_unresolved/payer_conflict；model_not_open 按 15.2 已钉口径不动会话行）时，同事务 close 会话 + sweep 该会话 holding 单元 → unknown。网关不可达由 Go 门控按拒绝处理（已有诚实姿态，15.4 锁存坐实）。
- Go：decision 加 `Shutdown`；door 拒绝映射授权族时门控进入 shutdown 锁存（注册表 live 单元记 unknown），此后任何事件（含非 billed）都答 shutdown 决策；wsrealtime 转发路径对 shutdown 决策写错误并 stop relay（runRealtimeRelays closeBoth 关上游+客户端两侧——尽力关停覆盖双向）。
- 测试：`server/tests/realtime-revocation.integration.test.ts`（会话中撤销 grant → 新单元 grant_invalid、会话 closed、holding 单元 unknown 且 hold 不释放、既有费用仍可结算；grant 到期同路径）+ Go shutdown 用例。

## #320 15.7 关停尾部费用只结算一次（server + Go）

- **0204_realtime_unit_tail.sql**：realtime_units 加 `unknown_reason`/`settled_at` + 形状 CHECK（unknown 必带 reason、settled 必带 settled_at，互斥）。
- realtime-unit.ts `settleUnit`：形状（closed 用量维度、evidence 闭集 provider_usage_report、settledBy、idempotencyKey）→ 单元 holding（reserved/processing/unknown，含关停后）→ 锁定基线精确定价（06.9 同一算术）→ 精确成本 ≤ bound_cents 时组合 06.9 settle（幂等由 reservation 围栏 + 单元状态守卫双保险）→ 单元 settled；**超出上限整单元 unknown**（unknown_reason='tail_exceeds_bound'，hold 保持，不部分结算不追加——一预留一结算使部分结算不可表达，Q26 硬约束）；无证据可依的尾部即 close 扫写的 unknown（'shutdown_tail_unconfirmed'），单元行即"不可用+原因"的可见记录。
- Go：注册表补 `RecordRealtimeUnitSettled`/`RecordRealtimeUnitUnknown`（15.2 预留位落地，shutdown 扫与回执记录用）。
- 测试：`server/tests/realtime-tail-settlement.integration.test.ts`（上限内结算一次+重放不重扣、重复关停后尾部只结算一次、超限→unknown+hold 保持+ledger 0、refused/不存在单元的拒绝答案）+ Go 迁移用例。

## 验证命令（每票 GREEN 后跑）

```bash
cd bifrost/plugins/governance && go test -run RealtimeUnitSerialization ./...   # #317
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf18 bun test server/tests/realtime-exhaustion.integration.test.ts   # #318
TEST_DATABASE_URL=... bun test server/tests/realtime-revocation.integration.test.ts   # #319
TEST_DATABASE_URL=... bun test server/tests/realtime-tail-settlement.integration.test.ts   # #320
bun run --filter server typecheck
cd bifrost/plugins/governance && go test ./...
bunx biome lint --error-on-warnings <changed files>
node scripts/e2e-add-driven.mjs server/tests/<suite> "<reason>"; node scripts/e2e-coverage-audit.mjs
```

## 约束口径

- GitHub 只读；不 commit 不 push；bifrost 子模块零提交（全部 Go 改动留未提交树）。
- 已知基线红（server typecheck 3 处 bootstrap-local-gateway 等）不修不隐瞒，如实报。
- 不改 .archive/ 既有内容、不改 server/src/mastra/**。
- 报告：reports/orca-dag-wave3-bf18.md（自有文件全清单 + 哈希）。
