# OCR Fix Wave 1 Report — ME04+ME05 delivery-close round 1（O1–O18）

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`，branch `1123786563/mastra-exec`，BASE `bf64d0f2`（未提交树；本轮零 commit/push，git 状态除工作区文件内容外未动）
- 依据：`docs/plans/2026-10-19-mastra-execution-run/ocr-fix-wave-brief.md` + `ocr-me04-me05.txt`

## 1. 每项处置（O1–O18）

| 项 | 处置 | 位置与说明 |
|---|---|---|
| O1 | **fixed** | `scripts/e2e-bun-manifest.mjs`：`readManifest()` 包 try/catch，解析失败（截断/半写 JSON）回退空默认，兑现注释承诺。注释扩为 "missing, wiped, or half-written … the parse is guarded, not just the stat"。 |
| O2 | **fixed** | 同文件：兜底精简为 `{ causes: {} }`；注释说明 "Only `causes` is read off `existing`"。 |
| O3 | **fixed** | `server/src/db/schema/mastra-execution-continuations.ts`：receipts 表补 `index("mastra_receipts_tenant_operation_idx").on(tenantId, operationId)`，带 why 注释（findReceiptRow/recordOperationExecuted 谓词）。未采纳 OCR diff 里给唯一索引追加 operationId 的写法——brief 只要求补查询索引。 |
| O4 | **fixed** | `server/drizzle/0164_mastra_execution_continuations.sql`：同一索引补进 DDL（`CREATE INDEX "mastra_receipts_tenant_operation_idx" … USING btree ("tenant_id","operation_id")`），与 schema TS 一致；补同一 why 注释。me05-fixture 按文件现应用迁移，无需独立迁移步骤；integration 绿波即验证。 |
| O5 | **fixed** | schema TS：两张新表各补一行授权姿态注释 `/** Control-plane … ledger. Runtime identities receive no grants on this table. */`，风格照 `mastra_tenant_storage_registry` 先例。 |
| O6 | **fixed** | `me03-fixture.ts`：`const stderrText = new Response(migrated.stderr).text();` 提前并发启动，失败分支再 `await stderrText`；注释说明 64KB 管道缓冲挂起风险（psql NOTICE 堆积）与 stdout "ignore" 同源。 |
| O7 | **fixed** | `me03-fixture.ts`：CREATE ROLE 密码改回 `$$…$$` dollar-quoting，注释引用 me01-fixture 同源约定（psql -c 无参数绑定，引号风格是密码方案变更的唯一防线）。 |
| O9 | **fixed**（校验前移 deferred） | `server/src/mastra/tools.ts`：`VALID_TOOL_NAME` 上限 128→64（OpenAI 工具名上限，最严 provider；Anthropic 128 不构成放宽理由），注释说明 64 来源。授权期前移校验不改：`tools.ts` 留 `TODO(ME09+)` 注释（跨模块、归 approvals-integration 切片），测试注释同义注明。新增边界测试：64 字符通过、65 字符 `MASTRA_TOOL_NAME_INVALID`。 |
| O10 | **fixed** | `tools.ts` 模块头第 2 点改为如实描述：abort signal 是本切片唯一生产装配（`execution.ts`）接线；lease-current 探针已组合、由 approvals-integration（ME09）接线。 |
| O12 | **fixed**（机制见 §3 偏差说明） | `instructions.ts`：组合顺序改为 legacy 精确序列 `[head(systemPrompt, standing), PROVENANCE_GUIDANCE, UNTRUSTED_GUIDANCE, tail(grantedToolGuidance)]`；注释声明 "The order is legacy-mandated; never re-weight it by moving the guidance to the end"。copilot.ts `mastraAgentConfiguration` 把 grantedToolGuidance 从 instructions 移入新 tail 组；execution-contracts/ag-ui-agent/execution/resume-driver 同步携带该组。断言更新为三元顺序（standing < PROVENANCE < UNTRUSTED < grantedToolGuidance）。 |
| O11 | **deferred**（brief 明确） | 归 ME06：真实 drive 端到端踩到 pinned @mastra/core execute-context 后再补 toolCallId 形状探测。未改任何代码。 |
| O13 | **fixed**（保留+注释） | 0164 SQL :45-46 两个 continuations 二级索引保留不动，SQL 注释写明预留意图（ME06：workspace 级挂起列表走 scope+status；operation_id 走证据关联）。仅注释 SQL 侧（brief 指名 SQL 行）；schema TS 索引不动。 |
| O14 | **fixed** | `tools.ts`：删除本地 `canonicalJson`（第 5 份手抄），改 `import { canonicalJson } from "../ai-observability/datasets"`；循环依赖已核实不存在（datasets.ts 及其传递依赖 db/client、db/schema/ai-observability-datasets、./contracts、./redaction、./retention、./scope、shared/ai-observability* 均不引用 `mastra/`），无需抽共享 util。import 处注释说明身份不变式不分叉的理由。 |
| O15 | **fixed** | `me05-fixture.ts` 导出 `ME05_STORE_SECRET = "me05-integration-secret"` 与 `ME05_AGENT_ID = "me05-agent"`（注释：生产跨进程同 secret）；`me05-child.ts` 与 `mastra-continuations.integration.test.ts`（两处）统一引用常量；`buildMe05Stack` 默认 agentId 与 child `loopFor` 同引 `ME05_AGENT_ID`。字面量分叉清零（grep 验证）。 |
| O16 | **fixed** | `me05-child.ts` finally：`await stack?.store.close().catch(() => undefined)`，注释说明防清理错误覆盖真实失败证据（与 database.end 约定一致）。 |
| O17 | **fixed** | `me03-fixture.ts`：spawn 改 `["bun", "--no-env-file", "scripts/migrate.ts"]`，注释引用 learning-mastra.test.ts 先例与文件头声明（Bun 否则会自动加载 server/.env 覆盖显式 env，迁移静默指向开发库）。 |
| O18 | **fixed** | `me01-child.ts` finally：同 O16 加 `.catch(() => undefined)`，注释同义。 |
| O8 | **deferred**（brief 明确） | fixture 三份 bootstrap 去重——第三次 defer，维持 "noted"。未改。 |

## 2. 每文件 diff 摘要

| 文件 | 变更 |
|---|---|
| `scripts/e2e-bun-manifest.mjs` | O1+O2：try/catch 包 readManifest、兜底 `{ causes: {} }`、注释更新；另将该文件既有多行 import 收成单行（纯 biome 格式，见 §3 偏差 2）。再生验证输出与改前逐字节一致。 |
| `server/src/db/schema/mastra-execution-continuations.ts` | O3：receipts 补 `mastra_receipts_tenant_operation_idx`（tenant_id, operation_id）+ why 注释；O5：两表各一行授权姿态注释。 |
| `server/drizzle/0164_mastra_execution_continuations.sql` | O4：`--> statement-breakpoint` 后补同款 `CREATE INDEX`（tenant_id, operation_id）+ why 注释；O13：两个 continuations 二级索引前补预留注释（ME06 消费意图），索引本身不动。 |
| `server/tests/support/me03-fixture.ts` | O17：spawn 参数加 `--no-env-file`（选项对象随之缩进）；O6：stderr 并发预读；O7：密码 dollar-quoting + 约定注释。 |
| `server/src/mastra/tools.ts` | O10：模块头第 2 点如实化（signal-only 本切片、lease 探针 ME09 接线）；O9：正则 `{1,64}` + 64 来源注释 + `TODO(ME09+)` 前移 deferred；O14：本地 canonicalJson 删除、改 import ai-observability/datasets（带身份不分叉注释）。 |
| `server/src/mastra/instructions.ts` | O12：签名加 `trailingParts = []`；组合 `[head, PROVENANCE, UNTRUSTED, tail]`；注释声明顺序即 legacy、不得末位加权；unconditional 语义保留。 |
| `server/src/mastra/execution-contracts.ts` | O12：`ExecutionRequest` 增可选 `trailingInstructions?: readonly string[]`（冻结名只扩展不重命名）。 |
| `server/src/mastra/ag-ui-agent.ts` | O12：`MastraExecutionCompletion` 增同名可选字段；`run()` 透传 `?? []`。 |
| `server/src/mastra/execution.ts` | O12：`buildInstructions(request.instructions, request.trailingInstructions)`。 |
| `server/src/copilot.ts` | O12：`mastraAgentConfiguration` 中 grantedToolGuidance 从 `instructionParts`（现仅 [systemPrompt, standing]）移入 `trailingInstructions: grantedGuidanceText ? [grantedGuidanceText] : []`，注释说明 tail 组即 legacy 顺序。legacy 非 mastra 分支未动。 |
| `server/src/mastra/resume-driver.ts` | O12：`MastraResumeLoop` 增可选 `trailingInstructions`，`buildInstructions(loop.instructions ?? [], loop.trailingInstructions ?? [])`——resume 侧可复现同一 legacy 序列（当前生产 loopFor 未接线，ME09 落地即用）。 |
| `server/tests/mastra-governed-execution.test.ts` | O12：`instructions_are_the_trusted_server_composition` 传入 tail 组并断言 grantedToolGuidance 在 UNTRUSTED 之后；注释声明顺序 legacy-mandated。 |
| `server/tests/mastra-tools.test.ts` | O9：`reserved_name_collision_refused` 内补 64 通过 / 65 拒绝边界两条断言 + deferred 注释。 |
| `server/tests/support/me05-fixture.ts` | O15：导出 `ME05_STORE_SECRET`、`ME05_AGENT_ID`；`buildMe05Stack` 默认 agentId 用常量。 |
| `server/tests/support/me05-child.ts` | O15：secret 与 agentId 改引常量（secret 处注明跨进程同 secret 姿态）；O16：finally close 加 `.catch(() => undefined)` + 注释。 |
| `server/tests/support/me01-child.ts` | O18：finally close 加 `.catch(() => undefined)` + 注释。 |
| `server/tests/enterprise/mastra-continuations.integration.test.ts` | O15：两处 secret 字面量改引 `ME05_STORE_SECRET`。 |
| `docs/verification/e2e-bun-suites.json` | **无内容变化**：manifest 生成器跑了一遍做等价验证，输出与改前逐字节一致（git diff 里的差异是本树既有未提交变更，非本轮产生）。 |

## 3. 命令与真实计数

```
# 1) 全量绿波（me05/report.md §1.3 原命令，13 文件）
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test server/tests/mastra-continuations.test.ts server/tests/enterprise/mastra-continuations.integration.test.ts \
  server/tests/mastra-stream-events.test.ts server/tests/mastra-ag-ui-agent.test.ts \
  server/tests/mastra-governed-execution.test.ts server/tests/mastra-governed-tools.test.ts \
  server/tests/mastra-browser-runner.test.ts server/tests/mastra-agent-resume-process.test.ts \
  server/tests/enterprise/mastra-compatibility.test.ts server/tests/mastra-tools.test.ts \
  server/tests/mastra-message-parts.test.ts server/tests/enterprise/mastra-conversation-runtime.integration.test.ts \
  app/tests/mastra-runtime-compat.test.tsx
→ exit 0；**126 pass / 0 fail / 0 skip**，13 files，570 expect() calls（11.36s）
  （基线 126/567：+3 = tools 边界 2 条 + instructions 顺序 1 条，无测试增删）

# 2) me03-fixture 波外消费者（brief 完成标准 3）
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=… bun test server/tests/mastra-engine-wiring.integration.test.ts
→ exit 0；5 pass / 0 fail / 27 expect() calls
（mastra-conversation-runtime.integration 在 13 文件波内已绿）

# 3) typecheck
bun run --cwd server typecheck
→ 恰 3 个错误，全部 scripts/bootstrap-local-gateway.ts（基线不变；
  注意 server/tsconfig.json 明确不含 tests/——测试文件以绿波为验证）

# 4) biome（brief 完成标准 2）
bunx biome check server/src/mastra scripts/e2e-bun-manifest.mjs
→ exit 0，clean（21 files）
（其余既有诊断如实记录、未扩大：server/src/copilot.ts 10 条 lint——
 noUnusedFunctionParameters/noUnusedVariables/noConsole，全部位于 2853–3519 行
 remote-transport 区域，远离本轮两处编辑；三个测试文件各有 1 处既有格式漂移
 —— me05-child.ts:141、me01-child.ts:90、mastra-governed-execution.test.ts:890，
 均在本轮未触碰的行上）

# 5) O1/O2 正常路径等价验证
node scripts/e2e-bun-manifest.mjs && diff /tmp/e2e-manifest-before.json docs/verification/e2e-bun-suites.json
→ 1037 files audited / 469 driven / 33 groups；输出与改前逐字节一致（MANIFEST IDENTICAL）
```

## 4. 偏差说明

1. **O12 机制（唯一超 brief 文件清单的改动）**：brief 要求"修复顺序"，但平铺数组内无法既保留"无条件注入两段指引"（instructions.ts 的存在理由，也是 resume 路径 `[ME05_INSTRUCTIONS]` 这类 head-only 调用方继续获得指引的前提）又把 grantedToolGuidance 插回指引之前——那需要按位置猜的魔法或放弃无条件注入（后者会让 resume 回放静默丢失指引块）。因此采用显式 head/tail 分组：`buildInstructions(parts, trailingParts = [])`，`ExecutionRequest`/`MastraExecutionCompletion`/`MastraResumeLoop` 各加一个可选 `trailingInstructions`。执行链（contracts → ag-ui-agent → execution）与 resume 链同步，均向后兼容（缺省 `[]`，现有 harness/fixture 构造全部无需改动——已在 me04-harness、mastra-continuations.test 的 request 构造上验证）。涉及的 6 个文件均为 brief/任务指示点名的 instructions.ts 消费面。
2. **e2e-bun-manifest.mjs import 收行**：biome 对该文件既有 `import { MANIFEST, … }` 多行写法报 format 错，而 brief 完成标准要求该文件 check 干净；仅格式化该 import，未动逻辑。
3. **O3 未采纳 OCR diff 的唯一索引扩列**：OCR 建议同时给 `mastra_receipts_operation_idx` 追加 `operation_id` 列；brief 只要求补 `(tenant_id, operation_id)` 查询索引，唯一索引保持原样（diff 最小化）。
4. **O13 注释只落 SQL 侧**：brief 指名 `0164 SQL :45-46`；schema TS 的两个索引未加注释（如需 TS/SQL 注释一一对应，属后续 drizzle 注释同步惯例问题）。
5. **O9 前移校验**：未改 plugins/store.ts（brief 明确 deferred）；`tools.ts` 源码 `TODO(ME09+)` + 测试注释两处标注归 approvals-integration 切片。

## 5. 结论

O1–O7、O9–O10、O12–O18 共 16 项 fixed，O8/O11 按 brief deferred。基线全部保持：绿波 126/0/0（13 文件）+ 波外 me03 消费者 5/0、typecheck 恰 3 基线错误、biome 指定范围干净。零 commit、零 push、零 stash。
