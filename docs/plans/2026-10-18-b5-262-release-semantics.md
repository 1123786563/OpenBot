# b5-262 实施计划（06.11 Release 需确认未计费与过期额度不复活）

Ticket: docs/tickets/bifrost-5/issues/06.11-release-only-with-no-charge-proof.md（父 #5，AC15）
BASE: HEAD 3e8a6072 + 未提交集成层（#260 settle / #261 conflictKind+grant-expiry / 06.8 unknown / 06.12 attribution / 0144–0146 迁移）。
Worktree: /Users/wuyongjun/orca/workspaces/OpenBot/b5-262。验证库: b5-verify-pg2 @5594 全新库 `openbot_b5_262_0611`（迁移 0146 止，已跑 migrate ok；冒烟 settle-idempotency 29 绿 + settle-conflict-grant-expiry 7 绿已复现）。

## 现有行为与共享接口（已读实际实现）

- `server/src/billing/credits-writer.ts`：`releaseReservation(reservationId, reason)` 仅释放 `reserved`；`unknown` 抛 `CreditReservationConflictError`（conflictKind 目前为默认泛型）；released/settled 幂等静默；`releaseUnknownReservation` 是 unknown 的唯一处置门（06.8/08.x）。写侧是 `credit_reservations` 唯一写者。
- `server/src/billing/credit-settle.ts`（06.9 契约，Consumes）：服务+端点模式——纯形状校验（先于任何 DB 接触）→ 行读锚定 → 冲突以稳定 `detail.kind` 回答（06.10 词汇）→ writer 事务裁决；`POST /settle` 挂 06.1 guard 内，生产 app.ts 装配未挂（06.9 先例）。
- `server/src/billing/credit-reserve.ts`（06.2/06.4，Consumes）：writer-over-tx（SAVEPOINT）组合模式、`RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS` 形状边界。
- `server/src/billing/capacity.ts`：读侧过滤——`liveGrants` 仅计 `expiresAt > at` 的 grant；`held` 仅计 reserved（未过期）与 unknown。#261 已钉死：释放回的过期 grant 额度在读侧死亡。
- `server/src/billing/usage-evidence.ts`：`CONFIRMED_NO_COST_REASONS = {provider_error, bound_refused, no_usage}` 是内部失败路径的"确认无费用"权威（`src/index.ts` LLM 流已按此门控释放；无把断连当释放的路径——resume hint 已核）。
- 无迁移需求：`credit_reservations.release_reason/status/terminal_at` 已存在。

## 交付（Write scope：Release 服务与路由 + 对应测试）

1. **新文件 `server/src/billing/credit-release.ts`**
   - 契约（票面 Produces）：`{ reservationId, reason, noChargeEvidence }`；缺证据拒绝。
   - `RELEASE_NO_CHARGE_EVIDENCE_KINDS = ["provider_error","bound_refused","no_usage"]`（封闭集，与 usage-evidence 的 CONFIRMED_NO_COST_REASONS 对齐；断连/流错/取消/超时/查无日志明确不是成员）。
   - `RELEASE_REFUSAL_REASONS = ["request_invalid","payer_conflict","release_conflict"]` + 每码一句展示语。
   - 纯形状校验（0 读）：body 对象；禁带账户键（顶层+evidence 内）→ `payer_conflict`；reservationId 形状（`cr-`+16hex）；reason 标识符；evidence `{kind∈封闭集, reference?}`。
   - 服务：单事务 `SELECT … FOR UPDATE` 锚定行（对并发 settle 的行写互斥）→ missing→`release_conflict/no_such_reservation`；unknown→`release_conflict/reservation_unknown`（明确原因：只能走 08.x）；settled→`release_conflict/reservation_settled`（已计费，释放不能成立）；released→幂等 200（首个终态结果成立）；reserved→writer-over-tx `releaseReservation`（同连接 SAVEPOINT，reserve 先例）→ `{status:"released", reservationId, attemptId, releasedCredits}`。
   - `creditReleaseEndpoints`：`POST /release`（06.1 guard 内组合，与 settle 端点同构：200/422/非 JSON→422 request_invalid）。
2. **`server/src/billing/credits-writer.ts` 一行**：unknown 释放拒绝补稳定 conflictKind `"reservation_unknown"`（06.10 既有判别器设计点的向后兼容细化；错误类/`code` 不变，现无任何测试钉泛型值）。
3. **不改动**：app.ts 生产装配（06.9 settle 先例未挂；票面 Write scope 未含，越界即停）、schema/迁移（不需要）、settle/reserve 接口。

## TDD（RED→GREEN→REFACTOR）

新文件 `server/tests/release-semantics.integration.test.ts`（沿用 #260/#261 测试骨架：5594 专用库、prefix 隔离、`expireGrant` 时钟控制）：

- RED-1（模块缺失）：整文件 import 失败 = 特性缺失。
- 三类拒绝：缺证据（absent/null/非对象/未知 kind）→ request_invalid 且行仍 reserved；**非证据词表**（client_disconnected/stream_error/cancelled/timeout/usage_missing）→ request_invalid（resume-hint 钉死）；unknown→`release_conflict/reservation_unknown` 且容量仍占用（+writer 直调抛同 kind，RED-2 精确失败点）。
- 释放幂等：同消息两次→均 released 且结果一致、终态只写一次；并发双释放→无额外效果；settled 后释放→`reservation_settled` 且台账不动；不存在→`no_such_reservation`。
- 过期额度不复活（集成，释放面）：reserve→expireGrant→释放→balance=0、新 reserve 拒绝（availableCents 0）、settle 仍拒 `reservation_released`；对照：grant 未过期时释放→容量即时回还（释放面与写面一致）。
- 词表一致性：RELEASE_NO_CHARGE_EVIDENCE_KINDS 每员 `isConfirmedNoCost===true`，非证据理由均不在集内（防两面漂移）。
- 线上：401 统一拒绝；200/422；非 JSON→422。

GREEN：`credit-release.ts` 最小实现 → writer 一行 → 全绿。
REFACTOR：仅当绿后有重复/命名问题。

## 验证命令

```bash
cd server
TEST_DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_262_0611 bun test ./tests/release-semantics.integration.test.ts
TEST_DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5594/openbot_b5_262_0611 bun test ./tests/settle-idempotency.integration.test.ts ./tests/settle-conflict-grant-expiry.integration.test.ts   # 前置回归
bun run --filter server typecheck
bunx biome lint --error-on-warnings src/billing/credit-release.ts src/billing/credits-writer.ts tests/release-semantics.integration.test.ts
```

严禁 5432/5435/55432；缺 TEST_DATABASE_URL 不跑、不记通过。
