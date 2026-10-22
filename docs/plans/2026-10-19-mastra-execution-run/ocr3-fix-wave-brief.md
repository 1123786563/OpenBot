# OCR Fix Wave 3 — ME04+ME05 delivery-close round 3（findings R3-1..R3-14）

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（未提交树，BASE `bf64d0f2`）。OCR 报告：`docs/plans/2026-10-19-mastra-execution-run/ocr-me04-me05-r3.txt`（先读）。不 commit/push；只改本 brief 列出的文件。

基线：绿波 13 文件 126 pass / 0 fail / 572 expects；typecheck 恰 3 基线错误；biome `server/src/mastra` 干净。`openbot-test-pg`@:5433 运行中。

## 修复项（严重者优先）

1. **R3-1 [bug·M]** `server/src/mastra/tools.ts:187-191`：granted.execute 抛出的 `HeadlessToolSuspension`（governed 路径的审批等待，见 plugins/tools.ts:252、approvals/service.ts:363）不得落入引擎 tool-error 被 markUntrusted 洗成 vendor 拒绝。按 finding 建议包 try/catch：`instanceof HeadlessToolSuspension` → 抛 `MastraToolRefusal("MASTRA_TOOL_SUSPENSION_UNSUPPORTED: ...")`（具名 fail-closed）。注意 import 来源（plugins/computer headless-tools 的类型）。测试：挂一个抛 HeadlessToolSuspension 的 granted 工具 → 断言结果是指名 refusal、不是 untrusted vendor error 文本。
2. **R3-2 [maint·M，升级处理]** 工具名校验前移到配置期：在 `server/src/plugins/store.ts` 的 `toolNameFor` 使用点旁（grant/refresh 写入路径）加同规则校验（`/^[A-Za-z0-9_-]{1,64}$/`），非法即抛 `GRANT_TOOL_NAME_INVALID` 具名错误；mastra/tools.ts 的 VALID_TOOL_NAME 改为从共享处导出消费（选择落点：tools.ts 导出、plugins/store.ts 导入，或反之——避免循环依赖）。运行期挂载校验保留为纵深。测试：grant 时超长/非法名被拒。
3. **R3-3 [test·L]** 走真实引擎回路的集成测试（mastra-governed-tools.test.ts）断言 `guard.onOperation` 收到的 `operation.toolCallId` 非空（防 context 形态漂移静默退化为 unkeyed）。
4. **R3-4 [maint·L]** `server/src/mastra/governed-agent.ts:73`：`executionBinding` 用 typeof 判型后再调用（跨包畸形对象不得抛裸 TypeError，保持具名 EXECUTION_BINDING_UNBOUND 拒绝）。
5. **R3-5 [test·L]** `server/src/mastra/compatibility.ts:382-384`：`toolCallOnce`/`controlledModelSteps`/`providerRequests` 等不依赖 text 的字段在流消费完成后立即赋值；finalAnswerFromResult 从 chunk 遍历累积，去掉对第二次 await text 的依赖。
6. **R3-6 [maint·L]** `server/src/mastra/approvals.ts:310-314`：删除私有 decisionIdOf，复用 continuation-store.ts 的导出版本。
7. **R3-7 [bug·M]** `server/src/mastra/continuation-store.ts:415-416`：loadPendingRow 加 `ne(status, "finished")`；并把唯一索引 `mastra_continuations_run_call_idx` 改为 partial（`WHERE status <> 'finished'`），同步 0164 SQL 与 schema TS（drizzle uniqueIndex 第三参数 where）。测试：同 (run, call) 在 finished 后再次 saveContinuation → 不再返回旧行 ref；新行可正常挂起/恢复（或按实现走 SAVE_LOST fail-closed——以实际语义为准并在测试固化）。
8. **R3-8 [bug·L]** `server/src/mastra/continuation-store.ts:593-597`：F4 竞态复核集合补 `kind`、`toolName`（与插入前闸门对齐；snapshotRef 差异是否可比以实现为准——若 blob 引用不可比较，注释说明为何不比）。
9. **R3-9 [maint·M]** `server/src/mastra/execution.ts:257`：`durable`（new Mastra 实例）引用保留至流结束（runAndNormalize 的 finally 之后才可被回收），删除或消费 buildAgent 的死返回值按最小改动处理（保留引用 + 注释说明 ME01 装配先例）。
10. **R3-10 [bug·M]** `server/src/mastra/execution.ts:351-352` 挂起保存兜底三缺口：(a) normalizer 未给 suspendedToolCallId 且存在多个 pending 调用 → 拒绝猜测，按保存失败处理（RUN_ERROR `MASTRA_CONTINUATION_SAVE_FAILED: ... no single pending tool call ...`）；(b) 兜底未命中唯一 (toolCallId, call) → 同样 RUN_ERROR，不允许静默跳过；(c) argsText 不可解析 → 同样 RUN_ERROR（不得用原文摘要产生永不相等的 argsDigest）。单一 pending 且可解析时保持现有保存路径。测试：多 pending 场景 → RUN_ERROR 而非 terminal-less 等待态；不可解析 args → RUN_ERROR。
11. **R3-11 [bug·M]** `server/src/mastra/resume-driver.ts:131-136` 恢复中二次挂起：为 `CreateMastraResumeDriverDeps` 增加 `onSuspension` 保存钩子（镜像 ExecutionContinuationContext.onSuspension 的最小形状：toolCallId/toolName/argsDigest + 引擎快照已持久化的前提）；approvals.ts 编排处把 store.saveContinuation（或等价收敛保存）接上该钩子。未接线钩子而 loop.durableToolNames 非空时：拒绝挂载 requireApproval（fail-closed），不得出现"引擎等、无恢复数据"的状态。drainResume 后 finishReason 为 suspended → 不得 receiptSink.executed()、不得 finishContinuation("resumed")；以独立 outcome（如 `re_suspended`）返回并在编排层保持 waiting（新 continuation 已由钩子保存）。测试：恢复流中再次触发 durable 暂停 → 新 continuation 存在、原行不误标 resumed、receipt 不升级 executed；未接线钩子 + durable 工具 → 拒绝挂载。
12. **R3-12 [maint·L]** `server/src/mastra/resume-driver.ts:149-152`：new Mastra 实例引用保留至 drainResume 完成（与 R3-9 统一）。
13. **R3-13 [maint·L]** `server/src/mastra/compatibility.ts:329-332`：抽 `sseResponse(chunks)` helper（可加 chunk 收敛），两个 provider fetch handler 复用。
14. **R3-14 [maint·L]** `server/src/mastra/governed-agent.ts:42-50`：`SCOPE_IDENTITY_FIELDS as const satisfies readonly (keyof PlatformScope)[]` 键集驱动比较，新增字段自动进比较。

## 完成标准

1. 全量绿波 13 文件 0 fail 0 skip（计数如实；新增测试计入）。
2. typecheck 恰 3 基线；biome 触碰文件干净（plugins/store.ts 若有既有诊断如实记录不扩大）。
3. 报告写 `docs/plans/2026-10-19-mastra-execution-run/ocr3-fix-wave-report.md`：每项 disposition、diff 摘要、命令与真实计数、偏差。
4. 改动最小化；R3-11 若发现与现有 six-gate 编排冲突，选最小正确方案并在报告中说明。
