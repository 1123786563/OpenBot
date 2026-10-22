# OCR Fix Wave 2 — ME04+ME05 delivery-close round 2（findings R2-1..R2-13）

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（未提交树，BASE `bf64d0f2`）。OCR 报告：`docs/plans/2026-10-19-mastra-execution-run/ocr-me04-me05-r2.txt`（先读对应段落）。不 commit/push；只改下列文件。

基线：绿波 13 文件 126 pass / 0 fail / 570 expects；typecheck 恰 3 基线错误；biome `server/src/mastra` + `scripts/e2e-bun-manifest.mjs` 干净。`openbot-test-pg`@:5433 运行中。

## 修复项

1. **R2-1 [L]** `scripts/e2e-bun-manifest.mjs:103`：writeManifest 返回值变量改名 `groupCount`（明确数值语义）。
2. **R2-2 [L]** 同文件 :84-86：catch 分支降级前 `console.warn` 一行（含 error.message），不静默清空已记录 causes。
3. **R2-3 [bug·M]** `server/src/enterprise/conversations/service.ts:1280-1285`：engine 路径的 legacy 只读守卫改为写事务内评估（`legacyGuardInPrepare: false, legacyGuardInWrite: true`），对齐同文件用户 mastra 分支与 platform 分支的不变量；按 finding 建议更新注释。补/调整测试覆盖 prepare→write 窗口语义（若既有测试锁定旧布局，按新不变量改写并在报告记录）。
4. **R2-4 [M]** `server/src/enterprise/conversations/service.ts:1232-1234`：163 字面量改为导出常量。落点：在组合式所在模块（`server/src/mastra/conversation-runtime.ts` ~L464 附近）导出 `MAX_ENGINE_MESSAGE_ID_LENGTH`（由 200 - (UUID 长度 + 1) 推导，附注释）与（若不存在）`engineAppendClientMessageKey(executionKey, engineMessageId)`；service 与 runtime 共同消费同一来源。
5. **R2-5 [L]** 同文件 :413-416：抽取 `finalizedMessageOrNull(...)` 共享校验/组装函数，`readFinalizedMessage` 与写事务 finalized 分支共用。
6. **R2-6 [L]** `server/src/copilot.ts:2200-2204`：移除无消费方的 `mastraContinuationInstall()` 访问器（保留 `setMastraContinuations`/`resumeFromApprovalDecision`——有文档化的 ME06 消费者）。
7. **R2-7 [L]** `server/tests/support/me03-fixture.ts:163-166`：`new Response(migrated.stderr).text()` 挂 `.catch(() => "")`，消除成功路径悬空 rejection。
8. **R2-8 [L]** `server/tests/support/me01-fixture.ts:183`：`body.includes('"tool_call_id"')` 改为对 `parsedBody.messages` 的结构化判定（存在 `role === "tool"`）。
9. **R2-9 [L]** `server/tests/support/me04-harness.ts:313-315`：硬编码 `"Refused. "` 改为 `import { REFUSAL_MARKER } from "../../src/plugins/tools"` 拼装（该文件已从此模块导入类型）。
10. **R2-11 [bug·M]** `server/tests/support/me03-fixture.ts:141-144`：迁移 spawn/exited 抛错路径补 try/catch → `dropDatabase(dbName)` → rethrow（DROP ... WITH (FORCE) 幂等），守住"失败不在共享容器遗留库"的不变量。
11. **R2-12 [L]** `server/tests/support/me04-harness.ts:108-110`：删除接口上从未生效的 `issueError?: Error` 死字段（消费方均为构造期传参）。
12. **R2-13 [doc·L]** `server/src/enterprise/contracts.ts:257-260`：接口文档改为与类型一致（assistant text / tool call-result；activity 仅作为 assistant 信封内 part，不能作为 role）。

## 明确 defer（不修，报告记录）

- R2-10 fixture 去重（container/psql/bootstrap 三份拷贝）——第 4 次 defer；**所有权落到 ME06 起点**：ME06 实现前先抽 `server/tests/support/pg-container.ts` 共享 helper，再加 computer fixture（ME06 brief 已有该要求，若无则补上）。

## 完成标准

1. 全量绿波 13 文件 0 fail 0 skip（计数如实记录；R2-3 若新增/改写测试，计数变化如实说明）。
2. `mastra-engine-wiring.integration.test.ts` 与 conversations 相关套件重跑绿（service.ts 改动）。
3. typecheck 恰 3 基线；biome 触碰文件干净。
4. 报告写 `docs/plans/2026-10-19-mastra-execution-run/ocr2-fix-wave-report.md`：每项 disposition、diff 摘要、命令与真实计数。
5. 改动最小化，不顺手重构。
