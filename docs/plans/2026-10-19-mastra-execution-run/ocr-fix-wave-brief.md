# OCR Fix Wave — ME04+ME05 delivery-close round 1（findings O1–O18）

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（未提交树，BASE `bf64d0f2`）。OCR 报告：`docs/plans/2026-10-19-mastra-execution-run/ocr-me04-me05.txt`（先读）。不 commit/push；不动 git 状态；只改本 brief 列出的文件。

环境：`openbot-test-pg`@:5433 运行中。基线：绿波 13 文件 126 pass / 0 fail / 567 expects；typecheck 恰 3 个 `scripts/bootstrap-local-gateway.ts` 基线错误；`bunx biome check server/src/mastra` 干净。

## 修复项（每项给出 OCR 原文位置与要求）

1. **O1 [bug·M]** `scripts/e2e-bun-manifest.mjs:84-86`：existsSync 守卫不覆盖"文件存在但损坏/被截断"。readManifest() 的 JSON.parse 抛 SyntaxError 使生成器在任何写入前崩溃。修复：对 readManifest() 调用包 try/catch，解析失败回退空默认（保持注释承诺）。
2. **O2 [maint·L]** 同文件 :86：兜底对象精简为 `{ causes: {} }`（files/artifacts 从未被读取；readManifest 内部已有 `?? []`/`?? {}` 回退）。
3. **O3 [perf·M]** `server/src/db/schema/mastra-execution-continuations.ts:125-129`：receipts 表补 `(tenant_id, operation_id)` 查询索引（现有读取路径 findReceiptRow / recordOperationExecuted 都以 operation_id+tenant_id 为谓词，仅有的 run_id 打头唯一索引服务不了）。
4. **O4 [perf·M]** `server/drizzle/0164_mastra_execution_continuations.sql:64`：同一索引同步补进 DDL（`CREATE INDEX "mastra_receipts_tenant_operation_idx" ON "mastra_execution_receipts" USING btree ("tenant_id","operation_id");`），与 schema TS 一致。0164 尚未进入任何已部署环境（只有一次性测试库按文件现应用），原地补齐安全。
5. **O5 [maint·L]** schema 两张新表补授权姿态注释（控制面台账，runtime identities 无 grants；风格照 `mastra_tenant_storage_registry` 的注释先例）。
6. **O6 [test·L]** `server/tests/support/me03-fixture.ts:153-155`：stderr 管道在 `await exited` 前先并发读取（`const stderrText = new Response(migrated.stderr).text();` 提前启动，失败分支再 await），防 64KB 管道缓冲挂起。
7. **O7 [maint·L]** `server/tests/support/me03-fixture.ts:195`：CREATE ROLE 密码改回 `$$...$$` dollar-quoting（与 me01-fixture 同源约定一致）。
8. **O9 [bug·M]** `server/src/mastra/tools.ts:71`：`VALID_TOOL_NAME` 长度上限 128→64（OpenAI 工具名上限 64，交集安全；Anthropic 128 不构成放宽理由），同步更新相邻注释说明 64 的来源；补/改测试覆盖 64 边界（64 通过、65 拒绝）。**不做**授权期前移校验（需改 plugins/store.ts，跨模块——deferred，在测试注释或 TODO 注明归后续集成切片）。
9. **O10 [doc·L]** `server/src/mastra/tools.ts:21-23` 模块头注释改为如实描述：本切片生产装配只接 abort signal；lease-current 探针已组合、由后续 approvals-integration/ME09 装配接线（ME04 报告 §6.1 同义）。
10. **O12 [doc·L，实际行为漂移风险]** `server/src/mastra/instructions.ts`：组合顺序必须与 legacy 完全一致：`[systemPrompt, standing, PROVENANCE_GUIDANCE, UNTRUSTED_GUIDANCE, grantedToolGuidance]`（legacy 参照 `server/src/copilot.ts` ~L2577-2587）。当前无条件把两段指引追加到 grantedToolGuidance 之后。修复顺序并加注释说明"顺序即 legacy、不得加权重排"；受影响的断言同步更新。
11. **O13 [保留+注释]** 0164 SQL :45-46 两个 continuations 二级索引（`(tenant_id,workspace_id,status)`、`operation_id`）当前无读取方：**保留**并补注释（ME06 将消费：workspace 级挂起列表 + operation_id 证据关联），不改索引本身。
12. **O14 [maint·L]** `server/src/mastra/tools.ts:79-80`：删除本地 canonicalJson，改 `import { canonicalJson } from "../ai-observability/datasets"`（已导出、语义相同；argsDigest 是恰好一次账本的身份基础，五份手抄有分叉风险）。确认 import 无循环依赖问题。
13. **O15 [test·M]** `server/tests/support/me05-fixture.ts` 导出 `ME05_STORE_SECRET = "me05-integration-secret"`；`me05-child.ts` 与父测试（mastra-continuations.integration.test.ts）统一引用该常量（消除 "me05-child-claim-secret" 字面量分叉；生产是跨进程同 secret，测试应对齐该事实）。`agentId: "me05-agent"` 等重复字面量一并以常量引用。
14. **O16 [test·L]** `server/tests/support/me05-child.ts:143-146`：finally 中 `store.close()` 加 `.catch(() => undefined)`（与 database.end 约定一致，防清理错误覆盖真实失败证据）。
15. **O17 [bug·L]** `server/tests/support/me03-fixture.ts:138-139`：spawn 改 `["bun", "--no-env-file", "scripts/migrate.ts"]`（防 Bun 自动加载 server/.env 指向开发库；仓库先例 learning-mastra.test.ts）。
16. **O18 [test·L]** `server/tests/support/me01-child.ts:74-76`：同 O16 加 `.catch(() => undefined)`。

## 明确 defer（不修，报告里记录）

- O8 fixture 三份 bootstrap 去重（me01/me03/me05）——第三次 defer，维持"noted"。
- O11 针对 pinned @mastra/core 的 execute-context toolCallId 形状探测——归 ME06（真实 drive 会端到端踩到该上下文）。

## 完成标准

1. 受影响测试全绿；**全量绿波 13 文件重跑** 0 fail 0 skip（计数如实记录；fixture 变化可能影响文件数外的计数不变）。
2. `bun run --cwd server typecheck` 恰 3 基线错误；`bunx biome check server/src/mastra scripts/e2e-bun-manifest.mjs` 干净（scripts 目录若有既有诊断，如实记录不扩大）。
3. me03-fixture 改动后，其消费者（mastra-conversation-runtime.integration 等）必须重跑绿。
4. 报告写 `docs/plans/2026-10-19-mastra-execution-run/ocr-fix-wave-1-report.md`：每项 fixed/deferred + 理由、diff 摘要、命令与真实计数。
5. 改动最小化：不顺手重构、不改无关文件。
