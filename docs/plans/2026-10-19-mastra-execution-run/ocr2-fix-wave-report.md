# OCR Fix Wave 2 Report — ME04+ME05 delivery-close round 2（findings R2-1..R2-13）

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`
- BASE: `bf64d0f2`（与 ME01–ME05 共享同一棵未提交树；本 wave 未 commit/push/stash，git 状态未动）
- OCR findings: `ocr-me04-me05-r2.txt`（13 条）；brief: `ocr2-fix-wave-brief.md`
- 结论：**12 项已修，R2-10 按 brief 第 4 次 defer（所有权落 ME06 起点）**；全部验证门保持基线。

## 1. 逐项 disposition

| # | 级别 | 判定 | 落点与做法 |
|---|---|---|---|
| R2-1 | L | **已修** | `scripts/e2e-bun-manifest.mjs`：`writeManifest()` 返回值变量 `groups` → `groupCount`（数值语义；调用与 console.log 结构不变，仅改名+消费点）。运行输出验证见 §3.5 |
| R2-2 | L | **已修** | 同文件 catch 分支：降级前 `console.warn("e2e-bun-manifest: existing manifest unreadable, dropping recorded causes (<error.message>)")`。实机演示：把 manifest 改成截断 JSON 后重跑，warn 行如期出现且重写结果与备份逐字节一致（§3.5） |
| R2-3 | bug·M | **已修** | `service.ts` appendEngineMessage：`legacyGuardInPrepare: false, legacyGuardInWrite: true`，注释改写为 finding 建议的「mirror the user paths' invariant」版本。测试：`mastra-conversation-runtime.integration.test.ts` legacy 拒绝断言保留（可观察行为不变仍绿），新增写事务落位 residue 断言（§2）；无既有测试锁定旧 prepare 侧布局，无需改写 |
| R2-4 | M | **已修** | 组合式落点收敛到 `server/src/mastra/conversation-runtime.ts`：新增导出 `engineAppendClientMessageKey(executionKey, engineMessageId)` 与 `MAX_ENGINE_MESSAGE_ID_LENGTH = 200 - (randomUUID().length + 1)`（=163，注释写明推导），`persistExecutionMessages` 的模板串改走 helper；`service.ts` 删除 163 字面量、import 该常量、注释改为指向组合点。全仓 `163` 字面量清零（grep 验证） |
| R2-5 | L | **已修** | `service.ts`：抽取 `finalizedMessageOrNull(scope, conversation, intent, messageId, digest)`（tenant store → listMessagesById → digest/seq 三重校验 → DTO+reservedSeq；任何不匹配返回 null），`readFinalizedMessage` 收敛读与写事务 `intent.state === "finalized"` 分支共同委托；调用方各自映射 null → 原契约（null / `MASTRA_MESSAGE_INTENT_MISMATCH`），两侧行为逐字节不变 |
| R2-6 | L | **已修** | `copilot.ts`：删除无消费方的 `mastraContinuationInstall()` 访问器（全库 grep 确认零消费方）；`setMastraContinuations` / `resumeFromApprovalDecision` 及其注释原样保留（ME06 文档化消费者） |
| R2-7 | L | **已修** | `me03-fixture.ts`：`new Response(migrated.stderr).text().catch(() => "")`，成功路径不再悬挂 stream rejection |
| R2-8 | L | **已修** | `me01-fixture.ts`：`body.includes('"tool_call_id"')` → 对已解析 `parsedBody.messages` 的结构化判定（存在 `role === "tool"`），附注释说明防误翻转 |
| R2-9 | L | **已修** | `me04-harness.ts`：import 改为 `{ type GrantedTool, REFUSAL_MARKER }`（biome 排序），拒绝文案 `` `${REFUSAL_MARKER} the grant for this tool was revoked.` ``——输出逐字节等价（生产 `REFUSAL_MARKER = "Refused."`），无测试锁定该字符串 |
| R2-10 | L | **defer（第 4 次）** | fixture 去重不修；**ME06 起点前置任务**：先抽 `server/tests/support/pg-container.ts`（container/psql 共享 helper）再加 computer fixture。ME06 实现前若 brief 缺该要求需补上 |
| R2-11 | bug·M | **已修** | `me03-fixture.ts`：spawn + stderr drain + `exited` 等待整体包进 try/catch → `dropDatabase(dbName)`（`DROP ... WITH (FORCE)` 幂等）→ rethrow，堵住「失败在共享容器遗留 `openbot_me03_*` 库」的窗口 |
| R2-12 | L | **已修** | `me04-harness.ts`：删除 `RunsHarness` 接口上从未被赋值的 `issueError?: Error` 死字段；构造期 `options.issueError` 与闭包消费保留（`mastra-governed-tools.test.ts` 等消费方均为构造期传参，已核对） |
| R2-13 | doc·L | **已修** | `contracts.ts` `EngineMessageAppendInput` 文档改为 finding 建议："(assistant text or tool call-result; activity content rides only as parts inside an assistant envelope, never as a role)" |

## 2. R2-3 的测试覆盖（计数变化说明）

- 既有断言 `appendEngineMessage(...).rejects.toThrow("LEGACY_HISTORY_READ_ONLY")` 不锁定事务布局（只断言可观察错误），新布局下原样通过，未改写。
- 新增 **落位 residue 断言**（同一测试尾部）：拒绝之后查询 `mastra_message_intents`，断言该 thread 存在 1 行 `state = "pending"` 的 prepare 侧意图行。这是唯一确定性的布局可观察量——旧 prepare 侧守卫对同一次拒绝留下 0 行；prepare 与写事务之间无注入 seam，无法直接翻转授权做窗口注入。
- 计数影响：**无新增 test case**（断言加在既有用例内）→ 126 pass 不变；`expect()` 570 → **572**（+2）。

## 3. 命令与真实结果（exit code → 实际计数）

### 3.1 全量绿波（13 文件，清单同 me05/report.md §1.3）

```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test <13 文件清单，同 me05 §1.3>
→ exit 0；126 pass / 0 fail / 0 skip；572 expect() calls（基线 126/570，+2 = R2-3 residue 断言）
```

### 3.2 engine wiring（service.ts 被触碰，必跑）

```
同 env bun test server/tests/mastra-engine-wiring.integration.test.ts
→ exit 0；5 pass / 0 fail / 27 expect()
```

被触碰 fixture 的全部消费套件均在绿波+wiring 内（me01-fixture ×4、me03-fixture ×3、me04-harness ×2，逐一核对）。

### 3.3 Typecheck

```
bun run --cwd server typecheck → exit 2；恰好 3 条基线错误：
  scripts/bootstrap-local-gateway.ts(106,52) (108,53) (120,74) —— 与基线逐条一致
```

### 3.4 Biome

```
bunx biome check server/src/mastra scripts/e2e-bun-manifest.mjs → clean（21 files，0 诊断）
bunx biome check me01-fixture me03-fixture me04-harness integration-test contracts → clean（5 files，0 诊断）
```

触碰文件残留（全部**既有**，零新增）：

- `copilot.ts`：10 条文档化基线（noUnusedFunctionParameters ×4 / noUnusedVariables ×2 / noConsole ×4，行号随删除块平移）+ 1 条 `1:1 assist/source/organizeImports`。后者经 stdin 重建预改树验证为**本轮之前已存在**（重建文件上 biome 同样要求重排 `./enterprise/contracts` vs `./agents/plan-model` 及 `./mastra/approvals` 内一个 specifier——全部是本 wave 未触碰的 import 块；本轮对该文件唯一改动是删除 ~L2200 的 5 行函数体，不可能产生 import 排序诊断）。按最小改动原则不顺手修。
- `service.ts`：2 条 noConsole 警告（`MASTRA_FINALIZED_READ_FAILED` :488、`MASTRA_STORAGE_PROBE_FAILED` :924），均为 me03/report.md 明确记录的**既有基线**（前者为该 wave 批准的评审修复结构化日志），本轮未增删任何 console 调用。

### 3.5 清单再生 + R2-1/R2-2 运行验证

```
node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs → 双 exit 0
输出：1037 files audited · 468 kept on the Bun runtime, in 33 driven group(s) ·
      5 deliverable artifacts · 2 still ours to fix
```

- `groupCount` 正确渲染数值（R2-1）；`docs/verification/e2e-bun-suites.json` 33 groups。
- R2-2 实机演示：manifest 置为截断 JSON → warn 行出现（`Unterminated string in JSON at position 11`）→ 重写结果与备份逐字节一致。
- **与 me05 报告的 469→468 漂移说明（非本轮引入）**：`server/tests/multitenancy/bots-ownership.test.ts` 从 driven 落到 todo——其 collection 错误文本现为 `'readonly' type modifier is only permitted …`（`tests/multitenancy/support/bots-ownership.ts:97` 的既有 harness 缺口），不再匹配 LOADER_GAP/BUN_RUNTIME 签名。该文件及其 support 均不在本 wave 触碰集（最后提交 06e3c9bc，工作树无改动），错误文本漂移属环境/工具输出差异；再生物如实反映当前树。

## 4. 与 finding 建议 diff 的偏差

1. **R2-11**：未采用 `migrated: Awaited<ReturnType<typeof Bun.spawn>>` 显式类型（Bun.spawn 重载下 `ReturnType` 解析不可靠），改为把 spawn + stderr drain + exit 等待整体纳入 try/catch、用两个 `let` 绑定（`stderrText` / `migrateExit`，catch 必 rethrow，确定性赋值成立）。清理不变量与建议一致。
2. **R2-2**：warn 文案按建议，模板串因 biome 80 列换行（`error instanceof Error ? … : String(...)` 折行），语义不变。
3. **R2-3 测试**：如 §2，residue 断言替代不可实现的窗口注入。
4. 其余各项与 finding 建议 diff 逐字或近逐字一致。

## 5. 改动文件清单（9 个）

```
scripts/e2e-bun-manifest.mjs                                        R2-1, R2-2
server/src/mastra/conversation-runtime.ts                            R2-4（导出组合点）
server/src/enterprise/conversations/service.ts                       R2-3, R2-4, R2-5
server/src/copilot.ts                                                R2-6
server/src/enterprise/contracts.ts                                   R2-13
server/tests/support/me03-fixture.ts                                 R2-7, R2-11
server/tests/support/me01-fixture.ts                                 R2-8
server/tests/support/me04-harness.ts                                 R2-9, R2-12
server/tests/enterprise/mastra-conversation-runtime.integration.test.ts  R2-3 覆盖
```

R2-10 defer 不改文件；`server/tests/support/me05-fixture.ts` 未触碰。
