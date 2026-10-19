# [bf-B2] Bifrost B 类核验 — #264 / #270 / #272 / #273 / #278

批次：bf-B2（Bifrost 域，B 类）。Worktree：`1123786563/bf027`（BASE `3ca32d49`）。
DB：`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027`（容器 `orca-all-bf027-pg`，保留未删）。
本批改动：**仅 1 处测试侧小修（#278，+4 行断言）**，产品侧零改动（IMPLEMENTED 配额 0/1）。
本报告覆盖 bf-B1 旧报告（旧批 #227/#232/#240/#242/#251 已由前任派发结算）。

## 总览

| 票 | 标题 | 结论 |
|---|---|---|
| #264 | Bifrost 07.1 准入扩展挂载与开关 | **SATISFIED（零改动）** |
| #270 | Bifrost 07.7 provider 输出封顶强制 | **SATISFIED（零改动）** |
| #272 | Bifrost 07.9 重复 ack 只记录一次 | **SATISFIED（零改动）** |
| #273 | Bifrost 07.10 流式最终用量结算 | **SATISFIED（零改动）** |
| #278 | Bifrost 08.3 ledger 已结算但 ack 丢失的重放 | **SATISFIED+FIX（测试侧 +4 行）** |

## 核验前提（环境事实）

- `bifrost` submodule 初始为空。本人在本 worktree 以本地 fetch（源：主 checkout `/Users/wuyongjun/trea/OpenBot/bifrost`，shallow）初始化到钉定 commit `e44890f8`，与 `main`/本分支 `git ls-tree` 钉定完全一致 → 本 worktree 核验即代表 main 现状。submodule commit 信息：`feat(governance): 落地输入绑定、输出上限、结算 outbox 与流式结算证据`。
- Go 工具链：`plugins/governance/go.mod` 要求 go 1.27.0，本机默认 go 1.26.3 且 `GOPROXY=off`/`GOSUMDB=off` 阻止工具链自动下载；改用模块缓存中已有的 `golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go` 直接调用（`go version go1.27.0`）。
- ledger（`docs/plans/2026-10-16-bifrost-5-ledger.md`）记载 #264 第 47 张集成（review-264 双 PASS，Spec 4/4）、#270 第 63 张集成、#272 第 77 张集成、#273 第 79 张集成（review-273 双 PASS）；#278（08.3）未单独派发，其场景由 #277（08.2）交付的 `recovery-replay.ts` 承载。

---

## #264 Bifrost 07.1 准入扩展挂载与开关 — SATISFIED（零改动）

主战场 `bifrost`，交付物位于 `bifrost/plugins/governance/`（creditadmission.go / resolver.go / creditadmission_test.go 等，钉定 commit 内）。

**AC 逐条实证**

- AC1「扩展缺失或未启用时，付费模型请求被拒绝且供应商调用数为 0」：`TestPreLLMHookRefusesAPaidModelWhenAdmissionIsDisabled`（开关 false → 拒）、`TestPreLLMHookRefusesAPaidModelWhenTheExtensionIsNotConfigured`（无配置块 → 拒）。拒绝发生在 PreLLMHook，`admissionRefusalFor` 断言返回 `*schemas.LLMPluginShortCircuit` 且非 nil（断言消息明示 "the request reached the provider instead of being turned away"）——短路即未达 provider，供应商调用数 0；ctx 打上 `governanceRejectedContextKey` 标记供下游。✓
- AC2「拒绝原因是可解释的准入未启用」：`bifrost/plugins/governance/resolver.go:42` `DecisionCreditAdmissionNotEnabled = "credit_admission_not_enabled"`；测试断言 `bifrostErr.Type == credit_admission_not_enabled`（503，"the deployment's posture"）、message 含 "not enabled" 且点名扩展名 `openbot-credit-admission`。✓
- AC3「不存在绕过扩展的推理入口（含 fallback 与备用路由）」：`TestAdmissionGateCoversEveryInferenceFunnel`（realtime_admission / embedding_dispatch 两子测，走 `Evaluate` 门）+ `TestPreLLMHookRefusesAPaidModelOnEveryFallbackAttemptAndOnStreams`（fallback 每 attempt 同门、stream 同 hook）+ `TestAdmissionGateAppliesToARequestThatPresentsNothing`（无 VK 呈现同门）。✓
- AC4「扩展版本可被 OpenBot 协商判定」：`CreditAdmissionExtensionVersion = "1.0.0"`（严格 X.Y.Z）；`TestCreditAdmissionExtensionDeclaresANegotiableIdentity` 钉住名字 `openbot-credit-admission` 与 major=1 可信线；`TestCreditAdmissionExtensionDescriptorReflectsTheSwitch` 三态（no config/switch off/switch on）断言 descriptor 的 Name/Version/Enabled 可读。✓

**命令与输出**

```
go test -C bifrost/plugins/governance -count=1 -run Admission ./...   → ok 0.940s（8 个 Admission 相关测试全 PASS，含 refusal/funnel/identity/descriptor 子测）
go test -C bifrost/plugins/governance -count=1 ./...                  → ok 15.706s（全模块）
go vet -C bifrost/plugins/governance ./...                            → 0（VET_OK）
```

**改动文件**：无。
**遗留**：transports 层 `/api/plugins` 版本透传在 review-264 时已裁决拆为独立票 07.1b（`docs/tickets/bifrost-5/issues/07.1b-transports-plugin-version.md`，07.12 前落地）；AC4 在协商身份与 descriptor 层面满足，不依赖该票。

---

## #270 Bifrost 07.7 provider 输出封顶强制 — SATISFIED（零改动）

主战场 `bifrost`，交付物 `bifrost/plugins/governance/outputcapevidence.go` + `outputcapevidence_test.go`。前轮 b5-270 工作已集成为第 63 张，本轮重点复验成立。

**AC 逐条实证**

- AC1「启用的模型都有输出封顶强制证据」：`TestBoundEvidenceRefusesCallWithoutEnforceableOutputCap`（无可执行封顶即拒，#269 侧）+ `TestBoundEvidenceAcceptsLegacyMaxTokensAsTheOutputCap` + `TestOutputCapVerifiedCellDispatchesAndCarriesTheCap`（仅 verified 证据的 cell 可派发并携带封顶）。✓
- AC2「无证据的模型/调用方式不可调用且原因可见」：`TestOutputCapGateRefusesModelWithoutEvidence` 四子测（无任何记录 / 只有其他模型证据 / 只有其他调用方式证据 / 词表不可界定的调用方式）；`TestOutputCapEvidenceUnverifiedAndFailedCellsAreRefusedWithRecordedReason`（unverified / not_enforced 两态拒且原因入 `Detail`）。✓
- AC3「证据记录包含验证环境与结果，可复现」：`OutputCapEnforcementRecord` 含 `Environment`（如 "fake-provider-harness"）、`Result`（封闭词表 verified/not_enforced/unverified，仅 verified 放行）、`VerifiedAt`（RFC 3339）、`Source`（复现来源）；`TestOutputCapEvidenceRecordStructureIsClosedAndComplete` + `TestOutputCapEvidenceSnapshotCarriesVerificationFacts` 断言结构封闭完整、坏记录不静默跳过而是以问题拒掉该 cell。✓
- AC4「供应商超出封顶时不会产生未预留费用」：`TestOutputCapExcessUsageIsNotBookedBeyondTheCap` 四子测（低于封顶全额入账 / 超封顶只按封顶费用入账 / provider 上报 cost 无法走私超额 / 失败路径计费用量同样钳制到封顶），核心是 `clampChatUsageToOutputCap`。✓

**命令与输出**

```
go test -C bifrost/plugins/governance -count=1 -v -run OutputCap ./... → 8 测全 PASS，ok 0.469s
```

（typecheck / vet / 全量已在本批统一执行，见文末。）

**改动文件**：无。
**遗留**：无。真实供应商环境的封顶验证按票面 Resume hint 语义以 fake provider 完成确定性验证，真实供应商 cell 保持 unverified/不可启用（fail-closed，符合父 Spec Q11）。

---

## #272 Bifrost 07.9 重复 ack 只记录一次 — SATISFIED（零改动）

主战场 both。票面 Verification 声明的 `server/tests/settlement-duplicate-ack.integration.test.ts` **不存在**（漂移）；等价覆盖在 governance Go 测试 + `settle-idempotency.integration.test.ts`（按语义定位，符合批次纪律）。

**AC 逐条实证**

- AC1「同一结算消息重复投递只扣费一次」：`TestSettlementOutboxThreeDeliveriesChargeOnce`（三次投递一次扣费）。✓
- AC2「ack 丢失后的重投收敛为同一结算结果」：`TestSettlementOutboxLostAckRedeliveryConvergesToOneSettlement`；另有 `TestPostLLMDuplicateResultRecordsOnceAndNeverRedrivesTheDelivery`（重复结果不重驱投递）。✓
- AC3「重复事件被记录且可观测」：`settlementoutbox.go` 记录级 `DuplicateEvents` 计数 + 封闭来源词表（`duplicate_result` / `duplicate_delivery_report`）；测试断言计数 1（重复结果计在其复制的记录上）/ 3（反复到达累计）/ 0（基线）。✓
- AC4「重复投递不改变用户可见余额的正确性」：接收端 Settle 幂等（06.9）实证 `bun test server/tests/settle-idempotency.integration.test.ts` → **29 pass / 0 fail**（168 expect）。✓

**命令与输出**

```
go test -C bifrost/plugins/governance -count=1 -v -run "TestPostLLMDuplicateResultRecordsOnce|TestSettlementOutboxDuplicateAckAndLateFailure|TestSettlementOutboxLostAckRedelivery|TestSettlementOutboxThreeDeliveriesChargeOnce" ./...
  → 4 测全 PASS，ok 0.563s
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test server/tests/settle-idempotency.integration.test.ts
  → 29 pass / 0 fail
```

**改动文件**：无。
**遗留**：票面声明的 bun 测试文件名漂移（如后续要补同名文件属新票范围，非缺口——AC 已有等价实证）。

---

## #273 Bifrost 07.10 流式最终用量结算 — SATISFIED（零改动）

主战场 both。ledger 记载 review-273 裁决「零生产改动形态」满足票面（Produces 是行为契约，07.4/06.3/07.8 集成层已承载流式路径；交付物即 `streamsettlement_test.go` 5 测试）。本轮复验成立。

**AC 逐条实证（5 测与 4 AC 一一对应）**

- AC1「完整流式响应按最终真实用量结算，金额与台账一致」：`TestStreamSettlementFinalChunkSettlesTheFinalRealUsageNotThePartial`。✓
- AC2「客户端中途断开时已发生用量仍被结算，不丢账」：`TestStreamSettlementClientDisconnectStillSettlesTheUsageAlreadyProcessed`。✓
- AC3「无法确认的部分进入 unknown 并保持预留」：`TestStreamSettlementDisconnectWithoutMeasurableUsageIsRecordedUnknownAndHolds` + `TestStreamSettlementFinalChunkWithoutAUsableReportIsRecordedUnknownAndHolds`。✓
- AC4「流式与非流式使用同一 Settle 契约与幂等键规则」：`TestStreamSettlementRidesTheSameSettleContractAsTheNonStreamPath`。✓

**命令与输出**

```
go test -C bifrost/plugins/governance -count=1 -v -run StreamSettlement ./... → 5 测全 PASS，ok 0.521s
```

**改动文件**：无。
**遗留**：无。

---

## #278 Bifrost 08.3 ledger 已结算但 ack 丢失的重放 — SATISFIED+FIX（测试侧 +4 行）

主战场 openbot。票面声明的 `server/tests/recovery-ack-lost.integration.test.ts` **不存在**（漂移）。ledger 无 #278 单独派发记录；其场景由 #277（08.2）交付的 `server/src/billing/recovery-replay.ts` 承载：`recovery-unacked-replay.integration.test.ts:473` 的 "a replay over an already-settled hold converges on the first settlement and acks" 正是 08.3 形态（模块头注释亦点名 "an ack lost after the settle landed, 08.3's"）。

**AC 逐条实证**

- AC1「台账已结算但 ack 丢失时，恢复后仍只有一笔结算」：上述用例构造「首投递 settle 已落账、进程死于 ack 前」（reservation=settled、outbox=pending、RecoveryItem=pending），重放后 `ledger toHaveLength(1)`。✓
- AC2「恢复动作不触发第二次 Settle」：结果级 ✓（台账仅一笔、金额不变，重放以同幂等事实收敛于首次结算）。设计说明：实现采用「幂等收敛」而非 resume hint 设想的「只读核对后 0 次 Settle 调用」——重放会重发一次同幂等键的 Settle，由 06.9 幂等返回首次结果、不产生第二笔记账。**本轮小修**：原用例未断言 spy 计数，补 `expect(settleCalls()).toBe(1)`（+注释共 4 行）把「恢复只发起一次 Settle、补 ack 本身不再结算」钉住；票面 Tests-to-write 的「无第二次 Settle 断言（spy 计数）」至此落地。✓
- AC3「RecoveryItem 在补记 ack 后关闭并可审计」：用例断言 item `state=resolved`、outbox `creditsStatus=delivered`；RecoveryItem 行含 owner/lastReason/failureCount 等可审计字段（迁移 0148，0147 表）。✓
- AC4「金额与首次结算完全一致」：`ledger[0].credits = 45`、`requestId = eventId` 与首投递一致。✓

**命令与输出**

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf027 bun test server/tests/recovery-unacked-replay.integration.test.ts
  → 7 pass / 0 fail，71 expect()（小修前 70）
bunx biome lint --error-on-warnings server/tests/recovery-unacked-replay.integration.test.ts → No fixes applied
bun run --filter server typecheck → Exited with code 0
```

**改动文件**：`server/tests/recovery-unacked-replay.integration.test.ts`（+4 行，未提交）。
**遗留**：若协调者裁定 AC2 必须采「只读核对、Settle 调用数为 0」的字面形态，则属生产侧行为变更（recovery-replay.ts 分支重设计），超出本批 ≤20 行测试侧小修范围，需专项派发；本轮按结果级 AC（台账一笔、金额一致、不重扣）判定满足。

---

## 批级统一验证

- governance 全模块：`go test -count=1 ./...` → ok 15.706s；`go vet ./...` → 0。
- `bun run --filter server typecheck` → Exited 0。
- DB：`orca-all-bf027-pg`（127.0.0.1:5561/bf027）全程在用，容器保留未删。
- bifrost submodule 在本 worktree 已初始化至钉定 `e44890f8`（未提交状态变化，`git submodule status` 前缀空格=与钉定一致）。

## 遗留汇总（跨票）

1. #278 AC2 的字面形态（0 次 Settle 调用）与实现的幂等收敛形态差异已留档，需协调者知悉（不影响本批结论）。
2. #264 的 07.1b（transports 版本透传）独立票仍待 07.12 前落地。
3. 票面 Verification 段路径漂移两处（#272、#278 声明的 bun 文件不存在），等价覆盖均已实证。
