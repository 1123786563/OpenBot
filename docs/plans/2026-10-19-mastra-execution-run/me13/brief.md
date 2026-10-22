# ME13 (#485) Task Brief — 盘点并幂等导入旧会话与完整消息

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`；以派发时实际树为准，前置 ME06/ME08 已集成）。
Ticket: `docs/tickets/mastra-agent-execution/issues/me13.md`（6 条 AC）。Spec §9（迁移、版本与回滚）。ADR 0008（测试两层制）。旧 15-Task 计划 T11 仅作文件参考。

## 数据面事实（调研结论，实施时再核）

1. **源**：CopilotKit Intelligence 服务（远程部署，`config.runtime.intelligence.{apiUrl,wsUrl,apiKey}`；进程内经 `CopilotKitIntelligence`（`server/src/index.ts:2780`、`server/src/copilot.ts:4515-4528` `getThreadMessages` override）读写线程与消息）。导入只读：不得经导入向 Intelligence 写任何内容。
2. **归属证据**：OpenBot `enterprise_conversations` 行持有 `threadId`（`server/src/db/schema/enterprise-conversations.ts:32,95`）与 scope 字段——Intelligence thread → OpenBot scope 的映射以这些行为准；无映射/多义的 thread 隔离（quarantine），不猜默认公司/本人。#162 的既有外部归属迁移证据只作参考。
3. **目标**：OpenBot ConversationService 完整 parts 合同（ME03 交付：`server/src/mastra/message-parts.ts` 版本化完整 parts、`conversation-runtime.ts` 的写入/intent/幂等路径）。导入写入走 ConversationService 的受控写入面，不旁路开第二写入者。
4. **不迁**：仅存 Intelligence 的个人长期记忆（#376/#395 领域）；不重复外部线程归属迁移。

## 交付（6 AC 对应 → CLI 合同）

CLI：`server/scripts/mastra-agent-cutover.ts` 固定子命令 `inspect | dry-run | apply | verify | rollback`（T11 文件指引：Create `mastra/legacy-import.ts`、`mastra/cutover.ts`）。默认只读；apply 仅在显式授权的专用 fixture 上演练。

- AC1 inspect/dry-run 零写入：输出脱敏 manifest（来源清单、分页游标、数量/摘要、归属证据、无法迁入原因）。测试：`dry_run_writes_nothing`（对源与目标双侧断言零写入，含 DB 触发/行数快照）。
- AC2 全分页 + 稳定源 ID 去重 + 完整迁移：工具调用/结果对、附件引用、时间、顺序保留；迁入会话能被原客户端读取路径读到（conversation-runtime 读取面）。测试：多页/重复页 fixture、`tool_and_attachment_links_survive`。
- AC3 中断可续跑 + 幂等：游标持久化；同数据再导入不增重复消息（stable source id 映射表）。测试：`rerun_import_is_idempotent`、中断注入（进程中途退出再续）。
- AC4 归属不唯一/引用缺失/快照不兼容隔离：quarantine 清单带原因；源/目标摘要不符阻止 verify。测试：`ambiguous_owner_is_quarantined`。
- AC5 目标在验证前不是活跃 writer：staging 状态标记；verify 通过前不接执行读取（与 ME14 的写入 fence 衔接——本票只交付 fence 所需状态，不执行切换）。
- AC6 源与旧数据只读保留：不 drop、不删除对象/卷；全部写入只发生在明确授权的一次性 fixture。测试：断言源侧零 DDL/零 DELETE/零 UPDATE。

## 测试与环境

- 新测试建议：`server/tests/mastra-legacy-import.test.ts`（unit：manifest/游标/去重/quarantine 逻辑，源用确定性 fixture——本地构造 Intelligence 形状的线程/消息 fixture，不打真实远程）+ `server/tests/enterprise/mastra-import.integration.test.ts`（真实 PG 一次性库 + 中断/续跑/幂等；模式照 me05-fixture）。远程 Intelligence 真实环境缺失 → 相关验收记 UNVERIFIED（如真实 API 分页行为），不以 mock 冒充。
- 新文件入册：`node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`。
- 绿波基线 + typecheck 3 基线 + biome 干净（同前几轮标准）。
- 报告写 `docs/plans/2026-10-19-mastra-execution-run/me13/report.md`。不 commit/push；不执行生产 apply。

## 边界与上报

- 本票不处置在途暂停记录的切换（ME14）；不执行生产停机/切换。
- 源 API 能力不足以分页/取摘要时如实登记阻断，不把未读取页当无数据。
- 冲突升级：与 Spec §9 冲突时报告，不静默改设计。
