# ME05 (#477) Fix Round 1 Report — 评审 F1/F3-F7 修复

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`；本轮零 commit/push/stash）
- 输入：`fix-round-1-brief.md`（修复契约）+ `review-findings.md` S3（F1-F8）
- 方法：TDD——先写固定名测试跑出 RED（记录命令+输出），再实现 GREEN，最后全量绿波 + typecheck + biome。

## 1. 逐 finding 处置

| Finding | 处置 | 说明 |
|---|---|---|
| **F1** [Important] claim 过期 ↔ 迟到 driver 缺围栏 | **fixed** | `recordOperationStarted` 改为判别结果 `MastraOperationStartedResult`（`{ started: true } \| { started: false; status: "unknown" \| "executed" }`，INSERT…ON CONFLICT DO NOTHING RETURNING，冲突时读存量 status）。围栏消费点在 orchestrator 构造的 `receiptSink.started()`（approvals.ts）：非记录者抛具名拒绝 `MASTRA_CONTINUATION_CLAIM_LOST`（新增于 `MASTRA_CONTINUATION_REFUSALS` named-extras 块，既有码零改动零弱化）。因驱动路径（resume-driver.ts:164）与任何 harness driver 都在同一 await 点调用 `started()`，围栏对所有 driver 实现一律在 `resumeStream` 之前生效，engine drive 计数 0、receipt 状态不变。既有语义保持绿：单恢复者照常驱动、`crash_between_decision_and_claim_is_reappliable`、receipt 复用/待处置、跨进程 `new_process_can_resume` 全部通过。新测试：`late_driver_after_takeover_refused_before_drive`、`concurrent_started_fences_exactly_one_driver`。 |
| **F3** [Minor] 三个未测面 | **fixed**（补行为证据） | 三条固定名测试补齐：(a) `foreign_actor_cannot_approve`——他人 scope 恢复被拒 `MASTRA_CONTINUATION_NOT_FOUND`、行保持 waiting、零驱动；(b) `declined_drive_never_records_receipt`——decline 分支经 orchestrator+driver 全链路，无 started/executed receipt、approve 分支未走、行终态 `declined`；(c) `lease_not_current_blocks_resume`——`leaseCurrent:false`（沿用六门编排已有的 lease-probe slot 注入）拒绝 `MASTRA_CONTINUATION_GENERATION_STALE`、claim 未取（revision 不变）。三条实现侧机制此前已存在（评审亦如此记载），测试为行为证据，RED 阶段即绿（见 §3 说明）。 |
| **F4** [Minor] saveContinuation 重放竞态跳过载荷一致性 | **fixed** | 冲突路径（读回行 ≠ 本地 continuationId，即 INSERT 输给了并发保存者）现在复核三重身份 `operationId / argsDigest / packageFingerprint`，不一致抛 `MASTRA_CONTINUATION_REVISION_CONFLICT`（沿用既有"同 (run,call) 不同载荷"语义，未改名未弱化；一致载荷的收敛保存仍返回同一 ref）。测试 `save_replay_with_changed_args_refuses` 用**未提交事务持有唯一键**的确定性手法命中竞态窗口：胜者事务先执行 INSERT（未提交）→ 重放的 pending-load 读到"无行"→ 其 INSERT 阻塞在唯一键上 → 提交胜者 → 重放走冲突路径被拒。 |
| **F5** [Minor] ref.revision 建议性 | **fixed**（并入 F1，注释机制，无新代码路径） | approvals.ts claim 处注释（约 :217-222）明确：caller 提供的 `ref.revision` 仅为定位（advisory），currency 由 fresh read + store 侧 CAS 重建，drive 由 receipt sink 的 **store 侧判别结果**围栏——不是 caller revision。无独立机制（按 brief）。 |
| **F6** [Minor] operationId 公式重复 | **fixed**（最小改动；与 brief 指认位置有出入，如实记录） | **事实核验**：sha256 公式全仓只有一处（`continuationOperationId`，continuation-store.ts:198-206）；execution.ts:368-372 与 store 均调用它（单一 helper、两处消费——brief 所述"抽取 helper、两处消费"在树上已成立）。评审指的 tools.ts 侧**不存在**该公式重复：tools.ts:194 造的是 `op_${randomUUID()}`（ME04 每次 execute 的进程内身份，注释明确"两个未键控 execute 绝不合并身份"，与持久派生身份是两个概念），改它会破坏 ME04 语义——未动 tools.ts。真正的静默漂移点是评审 F6 正文所指：`saveSuspension` 丢弃 `MastraSuspensionFact.operationId`、store 重推导。修复：`saveContinuation` 增加可选第三参 `expectedOperationId`，install 的 `saveSuspension` 传入 `suspension.operationId`，store 断言相等，漂移抛具名拒绝 `MASTRA_CONTINUATION_OPERATION_ID_MISMATCH`（新增 named-extra）。wiring 测试 `suspension_saves_continuation_before_the_stream_ends` 的 onSuspension 同步传入 `fact.operationId`（加强非弱化：真实 suspension 的 fact 推导与 store 推导若漂移，该测试即红）。 |
| **F7** [Minor] 报告计数过期 | **fixed** | `report.md` §1.1：17→20 pass、unit 15→18 条（并写明 18 条的构成）；§1.3：116→119、529→539。§1 开头加"修正记录（fix-round-1）"注明原因与去向（新实际数见本报告 §4）；其余段落结论未改。评审 F7 提到的 §2 逐测试行号 ~2 行漂移按 brief 范围（"不改其他段落"）未动。 |
| F2 [Important, integration]（迁移号 164 与主树冲突） | **deferred**（非本轮范围） | brief 未列 F2；属集成时重编号动作（controller action item），本轮未触碰 drizzle 迁移。 |
| F8 [Minor] 测试环境泄漏（ME05_RUN_ID 未还原） | **deferred**（brief 未列） | 评审自评"harmless / hygiene only"；brief 修复清单不含 F8，未扩大范围。 |

## 2. 变更文件与 diff 摘要

| 文件 | 净行数 | 摘要 |
|---|---|---|
| `server/src/mastra/continuation-store.ts` | 706 → 772（+66） | 新增判别结果类型 `MastraOperationStartedResult`；refusal 表新增 2 个 named-extra（`claimLost`、`operationIdMismatch`，既有 12 码零改动）；`recordOperationStarted` 重写（RETURNING + 冲突读现状，异常路径 `MASTRA_CONTINUATION_RECEIPT_LOST` 纯 Error，沿 SAVE_LOST 先例）；抽出 `findReceiptRow` 供 `findReceipt` 与围栏共用；`saveContinuation` +`expectedOperationId` 断言（F6）+ 冲突路径三重身份复核（F4）。 |
| `server/src/mastra/approvals.ts` | 383 → 416（+33） | `receiptSink.started()` 成为围栏：消费 store 判别结果，非记录者抛 `MASTRA_CONTINUATION_CLAIM_LOST`（拒绝来自 src，harness 只模仿生产 RECEIPT ORDER，不带围栏逻辑）；sink 接口 doc 写明围栏契约；F5 advisory-revision 注释；`saveSuspension` 传入 `suspension.operationId`（F6）。 |
| `server/src/mastra/resume-driver.ts` | 206 → 209（+3） | 驱动路径 `await receiptSink.started()` 处注释写明 F1 围栏语义（迟到 driver 在 `resumeStream` 之前被拒）；另被 biome 修正 import 名排序（formatter）。驱动代码零逻辑改动（围栏在 sink 强制，driver 无法越过）。 |
| `server/tests/mastra-continuations.test.ts` | 876 → 1169（+293） | +1 import（schema 表，F4 测试需直插胜者行）；wiring 测试 onSuspension 传 `fact.operationId`（F6 加强）；新增 7 条固定名测试（F1×2、F3×3、F4×1、F6×1）。未弱化/未改名任何既有测试。 |
| `docs/plans/2026-10-19-mastra-execution-run/me05/report.md` | 171 → 177（+6） | F7 计数更正 + 修正记录注。 |
| `docs/plans/2026-10-19-mastra-execution-run/me05/fix-round-1-report.md` | 新增 | 本报告。 |
| `server/src/mastra/execution-contracts.ts`、`server/src/mastra/tools.ts` | 未改 | 围栏不需要新契约类型（判别结果类型落在本 store 模块内）；tools.ts 见 F6 处置。 |

## 3. RED → GREEN 证据

命令（唯一环境；无 dev DATABASE_URL、无 .env）：

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/mastra-continuations.test.ts
```

**RED**（实现前，25 条中 21 pass / 4 fail / 80 expect()；恰好 4 条行为变更测试红，F3 的 3 条证据测试按预期即绿——其机制已存在，brief 原文"实现已双重防护，补行为证据"）：

```
(fail) late_driver_after_takeover_refused_before_drive
  → expect(firstApply).rejects.toMatchObject({ code: "MASTRA_CONTINUATION_CLAIM_LOST" })
    Expected - 3 / Received + 1（旧 sink 永不拒绝，迟到 driver 继续驱动、stale finish 报 REVISION_CONFLICT）
(fail) concurrent_started_fences_exactly_one_driver
  → TypeError: undefined is not an object (evaluating 'attempt.started')
    （recordOperationStarted 返回 void，无判别结果）
(fail) save_replay_with_changed_args_refuses
  → expect(received).rejects...  Received promise that resolved: Promise { <resolved> }
    （冲突路径静默返回胜者 ref，无一致性复核）
(fail) save_with_drifted_operation_id_refuses
  → expect(received).rejects...  Expected promise that rejects
    （第三参被忽略，operationId 漂移静默通过）
```

**GREEN**（实现后同命令）：`25 pass / 0 fail / 93 expect() calls / Ran 25 tests across 1 file`。
确定性复跑：共 **5 次**全绿（3 次在围栏实现完成后即刻、2 次在 biome formatter 后），两条时序敏感测试（TTL 50ms + sleep 80ms，与既有 `claim_expiry_requires_receipt_evidence` 同款手法）无抖动。

## 4. 最终验证（fix-round-1 后的实际计数）

绿波（report.md §1.3 的 13 文件清单，命令同原清单 env）：

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test \
  server/tests/mastra-continuations.test.ts \
  server/tests/enterprise/mastra-continuations.integration.test.ts \
  server/tests/mastra-stream-events.test.ts \
  server/tests/mastra-ag-ui-agent.test.ts \
  server/tests/mastra-governed-execution.test.ts \
  server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-browser-runner.test.ts \
  server/tests/mastra-agent-resume-process.test.ts \
  server/tests/enterprise/mastra-compatibility.test.ts \
  server/tests/mastra-tools.test.ts \
  server/tests/mastra-message-parts.test.ts \
  server/tests/enterprise/mastra-conversation-runtime.integration.test.ts \
  app/tests/mastra-runtime-compat.test.tsx
→ exit 0；**126 pass / 0 fail / 0 skip**，13 files，567 expect() calls（跑两遍均同数）
```

（基线 119/539 + 本轮 7 新测试 / +28 expect = 126/567，账目吻合。）

Typecheck：

```
bun run --cwd server typecheck → 恰好 3 条基线错误（scripts/bootstrap-local-gateway.ts (106,52) (108,53) (120,74)），无其他。
```

Biome：

```
bunx biome check server/src/mastra server/tests/mastra-continuations.test.ts
```

- 本轮触碰的 3 个文件（approvals.ts、resume-driver.ts、mastra-continuations.test.ts）经 formatter 修正后 **0 诊断**；continuation-store.ts 0 诊断。
- **如实记录（与"必须 clean"的偏差）**：该命令覆盖整个 `server/src/mastra` 目录，其中 4 条诊断位于本轮**未触碰、也不在 brief 允许修改清单内**的文件：`compatibility.ts:412` noConsole、`conversation-runtime.ts:1` organizeImports、`conversation-runtime.ts` format、`instructions.ts` format。全部为 fix-round-1 之前的既有基线（本轮零贡献），按"不改 scope 外文件"的围栏未动，留待对应文件的属主轮处理。
- 清单入册：本轮**未新增测试文件**（仅修改既有文件 + 新增 2 个 docs/plans 下的 .md），`e2e-file-audit` / `e2e-bun-manifest` 无需重跑（brief 完成标准 3 为条件项"若新增文件"）。

## 5. UNVERIFIED / 遗留

1. **biome 全目录 clean 未达成**（见 §4：4 条既有基线诊断在 scope 外文件）——本轮可证：3 个触碰文件 + continuation-store.ts 全部 0 诊断，且 4 条诊断文件本轮零改动（git status 未出现本轮对它们的写入）。
2. report.md §2 的逐测试行号引用（unit:631 等）仍差 ~2 行——brief F7 只 mandate 计数更正（"不改其他段落"），行号未动。
3. F2（迁移号 164 集成期冲突）与 F8（ME05_RUN_ID 环境卫生）按 brief 范围 deferred，需在集成轮/后续轮跟踪。
4. 评审 S5.2（Mastra 引擎对同 run 并发 resumeStream 的行为）仍不可从本仓验证——F1 围栏使双驱动在 OpenBot 层不可达（迟到者在 `resumeStream` 之前被拒），该引擎层问题不再是本切片的依赖。
5. 零 commit/push/stash；除上表 6 个文件外无任何文件写入（`git status` 复核过）。
