# ME05 (#477) Fix Round 1 — 评审 F1/F3-F7 修复

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`）。评审文件：`docs/plans/2026-10-19-mastra-execution-run/me05/review-findings.md`（先完整读一遍）。禁止 commit/push；不改 `server/src/approvals/**`；不动 `server/src/computer/**`。

环境：测试 PG 容器 `openbot-test-pg` 已运行（:5433）。绿波基线命令与文件清单见 `me05/report.md` §1.3（当前 119 pass / 0 fail / 539 expects）。typecheck 基线 = 恰好 3 个 `scripts/bootstrap-local-gateway.ts` 错误。新文件需入册：`node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`。

## F1 [Important] claim 过期 ↔ 迟到 driver 缺围栏

问题（评审原文）：`recordOperationStarted` 是 onConflictDoNothing（`server/src/mastra/continuation-store.ts`），迟到/失速的 resumer 在 claim 被接管后无法察觉，仍调用 `resumeStream`（`server/src/mastra/resume-driver.ts:160-168`），引擎会重复执行工具（外部副作用重复）。

修复要求（行为契约，实现方式自定但须最小）：
- `recordOperationStarted` 改为可区分"我是记录者"与"行已存在"（如 `INSERT … ON CONFLICT DO NOTHING RETURNING` + 冲突时读现状），返回判别结果（如 `{ started: true } | { started: false; status: "unknown" | "executed" }`）。
- resume 驱动路径把 `receiptSink.started()` 当作围栏：非记录者一律在 `resumeStream` **之前**拒绝（具名 refusal，如 `MASTRA_CONTINUATION_CLAIM_LOST` 或等价命名，沿用现有 `MASTRA_CONTINUATION_REFUSALS` 风格），engine drive 计数为 0、receipt 状态不变。
- 既有语义不得回退：正常单恢复者照常驱动；`crash_between_decision_and_claim_is_reappliable` 与 receipt 复用/待处置规则全部保持绿。
- 新测试（mastra-continuations.test.ts，命名固定）：`late_driver_after_takeover_refused_before_drive`（claim 过期→接管者完成→原 driver 迟到恢复被拒且引擎零驱动）；若可行加 `concurrent_started_fences_exactly_one_driver`（两个并发 started()，恰一个成为记录者，另一个拒绝）。

## F3 [Minor] 三个未测面（同文件补测试，命名固定）

- `foreign_actor_cannot_approve`：他人（scope 不匹配）批准被拒（实现已双重防护，补行为证据）。
- `declined_drive_never_records_receipt`：decline 路径不产生 started/executed receipt、不调用引擎 resume（declineToolCall 路径）。
- `lease_not_current_blocks_resume`：恢复链路的 lease 探测不通过时拒绝（沿用六门编排里已有的 lease-probe slot 注入方式）。

## F4 [Minor] saveContinuation 重放竞态跳过载荷一致性

`saveContinuation` 撞唯一键 `(run_id, tool_call_id)` 时直接 no-op，不校验新载荷与存量一致（args 变化的重放会造成存量 snapshot 与新 digest 分歧）。改为冲突时复核关键身份（operationId/argsDigest/package_fingerprint 至少三者），不一致具名拒绝。新测试：`save_replay_with_changed_args_refuses`。

## F5 [Minor] ref.revision 建议性

并入 F1：围栏落地后，在代码注释中写明 caller 侧 revision 为建议性、围栏以 store 侧判别结果为准；不另做机制。

## F6 [Minor] operationId 公式重复

`continuation-store.ts:185-194` 与其重复处（评审指 tools.ts 侧）抽取单一 helper，两处消费；不改变公式本身（sha256 over executionKey+toolCallId+argsDigest，跨进程稳定是验收点）。

## F7 [Minor] 报告计数过期

`me05/report.md` 中 15/17/116/529 更正为实际 18/20/119/539（本轮修复后的新实际数以你重跑为准），并注明修正记录；不改其他段落结论。

## 完成标准

1. 绿波全量重跑（13 文件 + 修改的套件）：全绿，0 fail 0 skip，报告真实计数。
2. `bun run --cwd server typecheck` 仍恰好 3 个基线错误；`bunx biome check server/src/mastra server/tests/mastra-continuations.test.ts` 干净。
3. 若新增文件：入册脚本跑过并把结果写入报告。
4. 修复记录写 `docs/plans/2026-10-19-mastra-execution-run/me05/fix-round-1-report.md`：每个 finding 的处置（fixed/superseded/deferred+理由）、diff 摘要（文件+行数）、命令与真实计数、UNVERIFIED 项。
5. 遇到与本 brief 冲突的事实（如机制已部分存在），如实记录并选最小改动，不扩大范围。
