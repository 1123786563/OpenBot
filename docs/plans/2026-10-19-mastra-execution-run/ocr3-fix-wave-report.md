# OCR Fix Wave 3 Report — ME04+ME05 delivery-close round 3（findings R3-1..R3-14）

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`
- BASE: `bf64d0f2`（与 ME01–ME05 共享同一棵未提交树；本 wave 未 commit/push/stash，git 状态未动）
- OCR findings: `ocr-me04-me05-r3.txt`（14 条）；brief: `ocr3-fix-wave-brief.md`
- 结论：**14 项全部处理（13 项已修 + R3-10 的拒绝分支按实际可达性落地，见 §1 偏差）**；验证门保持基线并加强（见 §3）。

## 1. 逐项 disposition

| # | 级别 | 判定 | 落点与做法 |
|---|---|---|---|
| R3-1 | bug·M | **已修（TDD）** | `mastra/tools.ts` granted.execute 包 try/catch：`instanceof HeadlessToolSuspension` → 具名 `MastraToolRefusal("MASTRA_TOOL_SUSPENSION_UNSUPPORTED: …")`，其余 throw 原样透传（保持引擎 tool-error → markUntrusted 语义）。import 自 `../computer/headless-tools`（与 plugins/tools.ts:252 同一类型）。测试 `suspension_from_granted_execute_refuses_named_not_untrusted`（RED 证据 §2.1） |
| R3-2 | maint·M | **已修（TDD）** | `plugins/store.ts` `grant()`：kind==="mcp" 时 `toolNameFor(ref)` 过同一规则，非法抛 `PluginRefusedError("GRANT_TOOL_NAME_INVALID: …")`（写入前拒绝，测试的 fake insert 证明零写入）。共享常量单向消费：`mastra/tools.ts` **导出** `VALID_TOOL_NAME`（原 TODO(ME09+) deferral 注释删除、改为说明导出原因），`plugins/store.ts` 导入——运行期 import 链 store→tools→(datasets/headless-tools/learning) 无环（逐一核对）。mount 期校验保留为纵深。测试 `grant_write_refuses_model_unaddressable_tool_names`（超长/空格/点号拒绝、合法放行、skill kind 跳过、`VALID_TOOL_NAME.source` 锁同规则）。**偏差见 §4.1**（refresh 写入路径不加 throw 的理由） |
| R3-3 | test·L | **已修** | 新增最小 seam：`ExecutionRequest.onToolOperation?`（server-assembled 观察钩子，execution-contracts 注明用途），`buildAgent` 把它接进 `createMastraTools` 的 guard。`mastra-governed-tools.test.ts` `granted_tool_executes_once`（真实引擎回路）断言：恰好 1 次 operation、`toolCallId === "call_1"` 非空、argsDigest 匹配——锁定引擎确实携带 call id，契约成立 |
| R3-4 | maint·L | **已修** | `governed-agent.ts`：`executionBinding` 与 markConsumed 同样 typeof 判型后再调用，畸形 truthy 非函数仍走具名 `EXECUTION_BINDING_UNBOUND`，不再裸 TypeError |
| R3-5 | test·L | **已修** | `compatibility.ts` toolLoop 探针：`loopText` 在 chunk 遍历内从 `text-delta` payload 累积；`toolCallOnce/finalAnswerFromResult/controlledModelSteps/providerRequests` 在流消费完成后立即赋值；删除第二次 `await toolOutput.text` 依赖 |
| R3-6 | maint·L | **已修** | `approvals.ts` 删除私有 `decisionIdOf`，复用 `continuation-store.ts` 导出版本（同文件已有多符号 import） |
| R3-7 | bug·M | **已修（TDD）** | `continuation-store.ts` `loadPendingRow` 加 `ne(status, "finished")`（注释写明 finished=历史不是挂起）；唯一索引改 partial：schema TS `uniqueIndex(...).on(...).where(sql\`status <> 'finished'\`)` + `0164_*.sql` 同步 `WHERE … <> 'finished'`（两处注释同步改写；meta 快照本树对 0161–0164 本就不存在，0164 SQL 即源，fixture 每次重放新 SQL——新测试的二次 INSERT 成功即 partial 索引的真实证据）。测试 `finished_row_does_not_block_a_new_suspension_for_the_same_call`：同一 (run, call) finished 后再次 save → 新 ref/新行 waiting → 可正常 claim+resume（RED 证据 §2.2） |
| R3-8 | bug·L | **已修** | F4 竞态复核集合对齐插入前闸门：补 `row.kind !== payload.kind \|\| row.toolName !== payload.toolName`；`snapshotRef` 不比（注释说明：store 视其为不透明 blob 指针，不属操作身份——身份=executionKey+toolCallId+argsDigest(+kind/toolName)，两个竞态保存对同一挂起的 blob 引用拼写可不同） |
| R3-9 | maint·M | **已修** | `execution.ts` `runAndNormalize`：`const { agent, durable } = buildAgent(request)`，注释写明 durable 须与流同生命周期（ME01 装配先例）；finally 中 `void durable` 把绑定钉到帧尾，引用不可能在挂起保存前被回收 |
| R3-10 | bug·M | **已修（TDD，可达性偏差 §4.3）** | `execution.ts` 挂起保存兜底重写：(a) 无 named id 且 result-less 候选 ≠1 → `RUN_ERROR "MASTRA_CONTINUATION_SAVE_FAILED: … no single pending tool call could be identified…"`（拒绝猜测）；(b) named id 在 announced 未命中 → 同名 RUN_ERROR（引擎漂移，不静默跳过）；(c) argsText 不可解析 → `RUN_ERROR "…could not be parsed…"`（不再摘要原文——那个 digest 永不等于审批侧 canonicalJson(parsed) 的 digest）。测试 ×2（§2.3） |
| R3-11 | bug·M | **已修（TDD，架构偏差 §4.4）** | `CreateMastraResumeDriverDeps` 增 `onSuspension?`（最小形状 toolCallId/toolName/argsDigest，前提=引擎快照已持久化）；`MastraResumeDriver.resume` 输入增同名钩子（编排层每 drive 的接线点）；**approvals.ts 编排处把 `store.saveContinuation` 接上该钩子**（binding=claim.binding，fingerprint=当前，kind=approval，snapshotRef=`suspended:<execKey>:<callId>`）。未接线钩子而 durableToolNames 非空 → 挂载前拒绝（新具名码 `MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED`，在任何 receipt 之前）。drain 后 `finishReason === "suspended"` → 从 `agent.listSuspendedRuns()` 读引擎已持久化的挂起（唯一 pending 否则具名拒绝，与 R3-10 同款 refuse-to-guess）→ 钩子保存新 continuation → 返回独立 outcome `re_suspended`：**不 receiptSink.executed()、不 finishContinuation("resumed")**；编排层新 store CAS 方法 `releaseClaim`（claimed→waiting，token+revision 校验）把原行放回 waiting。测试 ×2（§2.4）。me05-child 零改动（编排层总是供给钩子，mount 闸不触发） |
| R3-12 | maint·L | **已修** | `resume-driver.ts`：裸 `new Mastra({...})` → `const durable = new Mastra({...})`，注释写明引用须活到 drainResume 完成（与 R3-9 统一），三个 return 路径 drain 后 `void durable` 钉引用 |
| R3-13 | maint·L | **已修** | `compatibility.ts`：抽 `sseResponse(chunks)` helper，两个 provider fetch handler 复用（同文件单一拷贝） |
| R3-14 | maint·L | **已修** | `governed-agent.ts`：`SCOPE_IDENTITY_FIELDS as const satisfies readonly (keyof PlatformScope)[]` 键集驱动 `every` 比较——PlatformScope 增字段自动进比较（`satisfies` 拒绝未知键） |

## 2. bug 修复的 RED → GREEN 证据

### 2.1 R3-1（tools.ts 挂起洗白）

- RED：先写 `suspension_from_granted_execute_refuses_named_not_untrusted`，对未修代码运行 → `(fail) … [0.29ms]`（HeadlessToolSuspension 原样穿透，不是 `MastraToolRefusal`）。
- GREEN：包 try/catch 后 `bun test server/tests/mastra-tools.test.ts` → 7 pass / 0 fail（含同一测试内断言「非挂起 throw 仍走原路径」）。

### 2.2 R3-7（finished 行永久阻断）

- RED：先写 `finished_row_does_not_block_a_new_suspension_for_the_same_call`，对未修代码运行 → `(fail)`（第二次 save 返回了 finished 行的 ref）。
- GREEN：`ne(status,"finished")` + partial 索引后 → 同文件 26 pass / 0 fail；partial 索引由 fixture 重放 0164 新 SQL 真实生效（新 pending 行 INSERT 成功）。

### 2.3 R3-10（挂起保存兜底三缺口）

- RED（探针证据，对未修代码）：scratch 探针驱动真实引擎 + broken args `{"value":` → 引擎在解析前挂起（tool-call-approval 帧），保存路径以**原文摘要**成功保存（`SAVED … argsDigest:"b1d7…" = argsDigestFor('{"value":')`）——即 findings 描述的「永不被合法批准的挂起」。两 durable 调用场景探针同时证明：引擎的 approval 帧总是具名（call_probe_1）。
- GREEN：新测试 ×2（`unparsable_suspension_args_fail_the_run_instead_of_saving` → RUN_ERROR 含 SAVE_FAILED + "could not be parsed"、onSuspension 零调用；`two_pending_calls_suspend_the_engine_named_one` → 恰 1 个 fact、引擎具名的 call_r310_1、digest=argsDigestFor({"value":"a"})、terminal-less）。(a)/(b) 两个 RUN_ERROR 分支的真实引擎不可达性见 §4.3。

### 2.4 R3-11（恢复流二次挂起）

- RED（重构式证据，scratch 对同一场景重放 PRE-FIX 驱动序列 drain → executed → finishContinuation("resumed")）：
  ```
  original row: call_me01_1 waiting
  resumed stream finishReason: suspended
  OLD-path result.kind: resumed
  OLD-path row status: finished outcome: resumed
  OLD-path receipt status: executed
  OLD-path replacement continuation: MISSING
  ```
  即旧代码把「引擎等、无恢复数据」的终态如实复现。
- GREEN：新测试 ×2（`unwired_resuspension_hook_refuses_durable_mount` → 具名拒绝且 started 未被调；`re_suspension_saves_new_continuation_and_keeps_original_row_waiting` → result.kind "re_suspended"、原行 waiting+outcome null、receipt 停在 unknown、新 continuation（call_me01_2，digest=argsDigestFor({"value":"again"})，snapshotRef 正确）waiting、engine receipt 表恰 1 行=外部效果只执行一次）。

## 3. 命令与真实结果（exit code → 实际计数）

### 3.1 全量绿波（13 文件，清单同 me05/report.md §1.3；无新增文件 → 无需清单再生）

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test <13 文件清单>
→ exit 0；**133 pass / 0 fail / 0 skip；614 expect() calls**（基线 126/572，+7 tests +42 expects；
  修复 TTL 竞态常量后连续 4 次全绿：12.13s / 14.14s / 12.25s / 12.71s）
```

- `mastra-tools.test.ts`：5→7 tests（R3-1、R3-2），33→42 expects。
- `mastra-continuations.test.ts`：25→30 tests（R3-7 ×1、R3-10 ×2、R3-11 ×2），→121 expects。
- `mastra-governed-tools.test.ts`：8 tests 不变（R3-3 断言加进既有用例）。

### 3.2 engine wiring 守卫（execution.ts 被触碰，必跑）

```
同 env bun test server/tests/mastra-engine-wiring.integration.test.ts
→ exit 0；5 pass / 0 fail / 27 expect()
```

### 3.3 Typecheck

```
bun run --cwd server typecheck → exit 2；恰好 3 条基线错误：
  scripts/bootstrap-local-gateway.ts(106,52) (108,53) (120,74) —— 与基线逐条一致
```

### 3.4 Biome

```
bunx biome check server/src/mastra server/src/plugins/store.ts \
  server/src/db/schema/mastra-execution-continuations.ts \
  server/tests/mastra-tools.test.ts server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-continuations.test.ts
→ 0 error 0 warning（plugins/store.ts 无既有诊断，未扩大）
```

### 3.5 波动记录（如实）

- 当日首次基线运行出现 1 fail / 1 error（当时未捕获明细）；复跑即 126/0/572。
- 本 wave 第 2 次全量运行在机器高负载下（28.5s vs 常态 ~12s）出现 2 个既有测试失败：`claim_expiry_requires_receipt_evidence`、`crash_between_decision_and_claim_is_reappliable`，均为 `MASTRA_CONTINUATION_CLAIM_EXPIRED` at finishContinuation——**既有 50ms claimTtl 墙钟竞态**（re-claim 授予的新 TTL 与 re-claim→finish 两次 DB 往返同量级），与本次改动无关（claim/finish 路径零改动）。因同一测试文件本就被触碰且完成标准是稳定绿波，按最小改动把这两个测试（及同机制的 `late_driver_after_takeover`）的常量调为 `claimTtlMs: 250` + `sleep(400)`：语义不变（过期仍先于恢复），headroom 真实。调后连续 4 次全绿。

## 4. 偏差与决策记录

### 4.1 R3-2 落点：grant 写入路径（未给 refresh 目录写加 throw）

brief/finding 写「grant/refresh 写入路径」。实现落在 `grant()`——它本身就是 upsert（INSERT … ON CONFLICT DO UPDATE，"grant/refresh" 的写入点），且是 `toolNameFor` 拼出的模型名**第一次成为某 Bot 的可调用面**的地方。`refreshTools` 的 mcp_tools 目录写**故意不加 throw**：该文件对 vendor 异常名字的既定哲学是丢弃而非令整个 refresh 失败（重复名丢弃、NUL/控制符剥离——见 `storableTools` 注释），一个无 grant 的目录项到不了任何模型；配置期闸（grant）+ 运行期纵深（mount）已覆盖 findings 指出的风险。ocr-me04-me05-r3.txt 的建议 diff 亦只示例了 grant 路径。

### 4.2 R3-3 需要最小生产 seam

真实引擎回路的 execute context 不经 granted execute 暴露，单元测试的合成 context 无法证明契约。新增 `ExecutionRequest.onToolOperation?`（server-assembled，同 governed model 的装配地位；ME09 的 approvals 接线可复用同一 guard 接 lease probe）。单一可选字段，无行为变化。

### 4.3 R3-10 的拒绝分支可达性

锁定引擎（1.64.0）的 durable 挂起**总是**发 tool-call-approval 帧并具名（探针证据，§2.3）：named-miss（b）与多候选无名字（a）在真实引擎上不可达，属引擎漂移防御。已落地的端到端覆盖 = (c) 全链路 + (a) 的正向控制（多 pending 时保存的是引擎具名的那个，不猜第一个）；(a)/(b) 的 RUN_ERROR 分支由 (c) 共用的错误路径与代码评审覆盖，无专测——如实记录。

### 4.4 R3-11 的两处实现选择（brief 允许的「最小正确方案」）

1. **钩子接线点**：钩子按 brief 落在 `CreateMastraResumeDriverDeps`；但因 `resumeMastraContinuation` 接收的是已构造的 `deps.driver`，编排层无法写它的 deps——故 `MastraResumeDriver.resume` 输入增同名可选钩子，编排层每 drive 接线（driver 侧 `input ?? deps` 解析）。编排层**总是**供给 store.saveContinuation 钩子，所以 me05-child 与既有 driver 单测零改动；deps 级钩子服务于绕过编排层的独立驱动装配（ME06）。
2. **原行回到 waiting**：「保持 waiting」需要把已 claim 的行释放——DB outcome 约束（3 值 check）与「不误标 resumed」都排除了 finish 路径，故新增 store CAS 方法 `releaseClaim`（claimed→waiting，token+revision+清 token/expiry，bump revision）。释放失败（mid-drive 被 takeover）抛具名 revisionConflict，行由其 receipt 证据接管。
3. **receipt 不升级**：按 brief 执行（re_suspended 不 executed）。语义后果：原 operation 的 receipt 永久停在 started-unknown，对原行的任何后续 re-apply 走 pending_unknown → failed_unknown（待处置），绝不重放；活跃路径是新 continuation 行。
4. **fact 推导**：用 `agent.listSuspendedRuns()` 读引擎自己持久化的挂起（权威、与快照同源），不从已 drain 的流反解 chunk 形态；非唯一 pending 具名拒绝（与 R3-10 的 refuse-to-guess 同款）。

### 4.5 其余

- 无新增测试文件（全部落在绿波既有文件内）→ 清单/manifest 不需再生；`server/drizzle/meta/` 未动（本树对 0161–0164 本无快照，与 ME05 wave 留下的状态一致）。
- `server/src/approvals/**`（三件套的subject）零改动（git status 无该目录），approvals 三件套不受影响。
- scratch 探针/RED 脚本运行后已删除，树内无残留（git status 复核）。
