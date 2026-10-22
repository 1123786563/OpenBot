# ME07 (#479) Task Brief — Mastra 对话与后台只消费已确认且获授权的个人记忆

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`（分支 `1123786563/mastra-exec2-2`，未提交树，BASE `bcf51633f` = origin/main 含 #395）。ME01–ME06/08/13 增量已集成于本树（绿波 216/0/1033，18 文件）。
Ticket: `docs/tickets/mastra-agent-execution/issues/me07.md`（6 条 AC）。Spec §7。ADR 0005/0006/0010。

## 前置事实（已核验）

**#395 已交付于本树**（原外部阻塞已解除，2026-10-22 核验）：`server/src/hindsight/personal-memory-context.ts` 是单一权威 Bot 消费面，文档明示 ME07 为消费者。接口：
- `createPersonalMemoryContext({ recall, preferenceSearch, sourceBoundSearch, authorizations, pause?, recovery?, now? })` → 两模式：查询式 recall（经 DegradedRecallFacade，#385 降级在缝内）与无查询 `personalMemoryContext(scope, askingAgentId?)`（同谓词读权威行，上限每半 20 条）。
- `renderPersonalMemoryContext(memories)` → 注入块（引述、归属、untrusted-data 纪律、用户当前指示优先）。
- `RecalledPersonalMemory` = general-preference | source-bound（id/kind/provenance/content；不携带 bank id/远端 doc id）。
- 全部门（审核、tombstone、时间有效、来源与 Bot 授权、暂停开关 #392、恢复门 #391）在缝内；本模块不新增策略。
- 配套：`server/tests/hindsight-personal-memory-context.integration.test.ts`（4 用例）与 `server/tests/memory-exit-single-authority.integration.test.ts`（退出契约）已绿。

## 交付（6 AC → 行为）

本票**只做装配与验证，不重实现任何门**。落点：
1. **AC1 消费 #395 合同**：Mastra 执行路径（execution/copilot 装配）把 `personalMemoryContext(scope, agentId)` 的渲染块注入可信 prompt（服务端组装；复用 ME08 catalog 的 trailing 位置模式——具体位置对齐 legacy 引擎注入记忆上下文的相对位置，不重排序）；不向 Agent/客户端暴露 bank 或可选 scope。生产装配在 index.ts 以与 #395 相同的缝构造 PersonalMemoryContext（真实 seams）。
2. **AC2 未审核/遗忘/来源失权/Intelligence-only 不进上下文**：消费面已保证；本票用测试证明——同一数据集（已确认/候选/已遗忘/来源撤权）经 Mastra 路径网页+headless 读取，断言模型实际收到的 system prompt 内容（含/不含对应记录）。故障降级路径同样断言（Hindsight 不可用 → 只有本地已确认且当前有权记录）。
3. **AC3 跨公司/跨团队不串**：同一全局用户双公司、同公司双团队的 scope 矩阵跑注入，断言互不可见；通用偏好 vs 来源受限分别按现有授权。
4. **AC4 暂停语义**：usage-paused → 注入立即为空（缝保证；测试证明）；learning-paused 只影响新候选（不属于本票装配面，断言不误伤注入）。
5. **AC5 记忆工具与来源说明保留**：legacy 受控记忆工具（memory recall 工具）在 Mastra 路径经 ME04 包装挂载（若 legacy 有此工具——先核对 `plugins/tools.ts` 与 copilot 装配中的记忆工具名，如实登记）；渲染块的 provenance 保留。**不引入** Mastra 原生 resource 级长期记忆/Memory（不配置 Mastra memory）。
6. **AC6 Hindsight 故障降级**：DegradedRecallFacade 的降级语义（#385）经消费面原样透传；不因故障恢复 Intelligence 双权威（代码已无该路径，测试断言）。

## 测试（票面 Verification 合同）

新测试建议：`server/tests/mastra-personal-memory.test.ts`（unit/装配）+ `server/tests/enterprise/mastra-memory-context.integration.test.ts`（真实 PG，数据集矩阵：confirmed/candidate/forgotten/source-revoked × browser/headless × 双公司/双团队；模式照 me05/me06 fixture，用 `server/tests/support/pg-container.ts`）。核对"模型实际收到内容"：断言 system prompt 的记忆块（含 renderPersonalMemoryContext 的 untrusted 声明前缀）逐记录包含/排除。

环境：`openbot-test-pg`@:5433（openbot_test 已重建至 0207 链，250 表）；一次性库模式用 pg-container。基线：18 文件绿波 216/0/1033；typecheck 恰 3 基线（scripts/bootstrap-local-gateway.ts）；biome `server/src/mastra` 干净。新文件入册 `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`（archive/verification/ 目录已补）。

## 边界与上报

- 不重做 #395/#385/#392/#391 的任何门；出现"需要改缝才能工作"即停下报告（升级到控制器，可能要回 #395 侧）。
- 不改 OpenMuse 子模块；不动 `server/src/hindsight/**` 既有文件（消费不改缝；若必须改，报告）。
- 后台（headless）注入 = 同一装配面（ME09 会消费同一合同；本票在测试中用 browser+headless 两种执行入口形态验证）。
- 报告写 `docs/plans/2026-10-19-mastra-execution-run/me07/report.md`（若写权限受阻，全文返回由控制器落盘）。不 commit/push。
