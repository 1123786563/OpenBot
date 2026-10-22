# ME13 Report — 盘点并幂等导入旧会话与完整消息 (#485)

- Date: 2026-10-20
- Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`, branch `1123786563/mastra-exec`
- HEAD: `bf64d0f2772766a7c0cdbc3e9831c9024400e165`（无 commit/push/stash；ME01–ME08 共享未提交树原样保留，本票增量叠加其上）
- Ticket: `docs/tickets/mastra-agent-execution/issues/me13.md`（6 条 AC）；Brief: `me13/brief.md`；Spec §9

## 0. 交付概要

旧会话导入工具以**只读源 seam + 受控目标写入面**落地。新模块：

- `server/src/mastra/legacy-import.ts`（约 1.3k 行）：`LegacyImportSource` 只读源接口（仅 `listThreads` 游标分页 + `getThreadMessages` 整线程读，类型层面不存在写方法）；`enterprise_conversations` 行为 thread→scope 归属证据（0/≥2 行隔离）；Intelligence 消息 → AG-UI → ME03 版本化完整 parts 的纯转换与逐条 quarantine 分类；canonical 指纹（排序键 canonical JSON → sha256）作为 verify 双侧对账合同；`inspect/dry-run/apply/verify/rollback` 五个编排函数；持久化 run state（游标 + 逐线程进度 + phase: staging→verified/blocked/rolled_back，供 ME14 fence 消费）。
- `server/src/mastra/cutover.ts`：真实 `CopilotKitIntelligence` 的只读适配器（恰好暴露两个读方法）；`conversationServiceWriter`（只走 `append`/`appendEngineMessage` 两个单写者 seam，无第二写入者）；`createAdminTxRunner`（operator 权限的归属证据/目标行序读取——data 角色 RLS 看不到跨租户行，而检测歧义映射正是其职责；写入仍走 per-principal 可信 scope）；`createPostgresTargetReader`（intents reservedSeq 排序 + tenant memory 读回）；`createFileRunStore`（tmp+rename 原子写）；CLI 参数解析 + apply 双重授权门（`--authorize-fixture` 且环境 `MASTRA_CUTOVER_FIXTURE_APPLY` 同值，另需 `--state-dir`）。
- `server/scripts/mastra-agent-cutover.ts`：薄 CLI 入口（固定 5 个子命令；默认只读；config → 模块接线；apply 拒绝一切未授权运行；**不含切换开关**）。

关键设计事实（数据面调研 + 实施核实）：
- 源 API：`listThreads({userId,agentId,cursor,limit})` 游标分页；`getThreadMessages({threadId,userId})` 整线程一次返回，**无逐消息分页游标**；`ThreadMessage` 无逐消息时间戳（仅 thread 级 createdAt/lastRunAt/updatedAt）。两者均登记进每个 manifest 的 `sourceCapabilityNotes`，不伪造时间保真。
- 稳定源身份：导入行 `clientMessageKey = legacy:<sourceMessageId>`（assistant/tool 行同时以源消息 id 作 `engineMessageId`，受 `MAX_ENGINE_MESSAGE_ID_LENGTH` 约束）；重导入按 finalized intent 预检收敛，永不重复。
- staging 目标规则：仅接受已 `storage_backend='mastra'` 且**无外来 finalized intent**（`client_message_key NOT LIKE 'legacy:%'`）的会话；自有旧导入行不算外来（重入收敛）；platform/intelligence 后端 → `backend_not_staging` 隔离（后端翻转属 ME14 fence）；已有外来行 → `target_not_empty`（避免 seq 倒序）。
- 工具对/附件/顺序：源顺序即导入顺序（intent 保留 seq 单调）；toolCalls `{id,name,args}` → AG-UI function 形状进 envelope 的 tool-call part；tool result 进 tool-result part（信封 role=tool，memory 行 role=assistant——ME03 存储不对称，读回由 envelope 复原）；附件经 `attachmentIdsIn`（`/api/attachments/<id>` source URL 唯一判据）保留 id 与顺序，导入前经 `attachments` 表存在性校验（缺失 → 逐条 `attachment_missing` 隔离）。

## 1. 命令与真实结果

### 1.1 RED（TDD 先证伪）
`bun test server/tests/mastra-legacy-import.test.ts` → `error: Cannot find module '../src/mastra/legacy-import'`（0 pass / 1 fail，实现文件尚不存在）。随后实现分四轮转绿（7 fail → 2 fail → 1 fail → 0），每轮失败均为真实行为差异（见 §5 修正记录）。

### 1.2 GREEN — 本票套件
- `bun test server/tests/mastra-legacy-import.test.ts` → **31 pass / 0 fail / 107 expect()**
- `ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test server/tests/enterprise/mastra-import.integration.test.ts` → **7 pass / 0 fail / 58 expect()**（真实 PG 一次性库，me03-fixture 模式；独跑两轮同计数）

### 1.3 全量绿波（基线 16 文件 + 本票 2 新套件 = 18 文件）
```
ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test \
bun test <16 基线文件（me08 §1.3 原单）+ server/tests/mastra-legacy-import.test.ts \
  + server/tests/enterprise/mastra-import.integration.test.ts>
→ **216 pass / 0 fail / 1033 expect()**（基线 178 + 本票 38 = 216）
```

### 1.4 Typecheck / Biome / 清单
- `bun run --cwd server typecheck` → 恰 3 条基线错误（bootstrap-local-gateway.ts:106/108/120），本票 0 新增。
- `bunx biome check server/src/mastra` → clean（25 files）；本票 5 个新文件 → clean（0 error 0 warning）。
- `node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs` → exit 0；**473 files / 34 groups**（471→473：两个新套件入册）。新套件落组：`server/tests part 7`（unit）、`server/tests part 5`（integration）。audit "2 still ours to fix" 与 me08 基线一致（ai-observability-datasets / auth-client 收集错误，环境条件）。

### 1.5 Driven 组核查（ADR 0008 two-tier）
- `E2E_UNIT_OUTPUT=.e2e-me13-p4 E2E_BUN_ONLY="server/tests part 4"（+5433 PG env）bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` → **1 passed / 0 failed（exit 0，64.9s）**——含其余全部 me03-fixture 集成套件（continuations/conversation-runtime/frontend-tool），证明共享进程机制对本类套件成立。
- part 7（本票 unit 套件所在组）：driver 式直接复现 `bun test <part7 24 files> --reporter=junit --timeout=120000` → 362 pass / 3 fail，junit 证实失败全部在 memory-store、memory-sensitivity（`PluginRefusedError GRANT_TOOL_NAME_INVALID`，plugins/store.ts:5125 门 vs 记忆套件超长 tool ref，**red alone，基线既有**）与 openmuse-activity（duplicate key）；**本票文件 0 失败**。去本票文件对照组：331 pass / 3 fail——失败集合逐一相同，本票增量对该组红贡献为零。
- part 5（本票 integration 套件所在组）：组内 5 个邻居（runs/tenancy-rls/tenancy/gateway-admin-routes/gateway-readiness）需要完整官方企业测试环境（`ENTERPRISE_TEST_{SETUP,DIRECTORY,DATA,OPERATOR}_DATABASE_URL` + gateway 协商 env），本工作区未配置 → red alone（基线既有，与本票无关，e2e 驱动两次同因失败）。本票 integration 套件：独跑 7/0（两轮）；driver 式共享 24 文件运行中 0 失败（15 个失败全在上述 5 个邻居）。
- driver 在 e2e 进程环境内两次将本票 unit 套件归类 "failed only when sharing"；同一 bun 调用（同参数含 junit reporter）在 e2e 环境外两次复现均 0 失败（junit 逐条核验），直接共享运行亦 0 失败——登记为 e2e harness 环境差异类伪红（同 me06 §5 / me08 §1.5 已记录类别），直接证据全绿。

## 2. AC 逐条证据

- **AC1 inspect/dry-run 零写入 + 脱敏 manifest**：单测 `dry_run_writes_nothing`（source.stateHash 不动 + 调用日志仅 listThreads/getThreadMessages + 三张表行数快照不变）、`the manifest carries digests and ids, never content or titles`（manifest 序列化不含消息内容、digest 为 64 hex）、`inspect inventories and quarantines without reading messages`；集成 `dry_run_writes_nothing`（真实 PG：enterprise_conversations/mastra_message_intents/tenant memory 行数快照不变 + source 只读）。manifest 携带：来源清单（threadId + 所有权证据 + thread 级时间）、分页游标（scan.cursor/pagesRead）、数量/摘要（逐线程 plan.importable/skips + source.digest）、隔离原因（15 种 skip reason 枚举）。
- **AC2 全分页 + 稳定去重 + 保真 + 原客户端可读**：单测 `inventory walks every page and dedupes threads seen twice`（3 页 + 重复线程去重）、`inventory terminates on a repeated cursor`（游标自环：再证一页后停止并保留 cursor，不把未读取页当无数据）、`tool call/result pairs convert...`/`user attachment references keep their ids and order`/`source order is preserved...`；集成 `apply_imports_full_history_and_the_client_read_path_reads_it_back`（`service.history` seq 1..4 顺序/角色/附件 id；`runtime.loadExecutionInput` 重建 toolCalls/toolCallId/file part 全保真）。时间保真按源 API 实际能力登记（capability note）。
- **AC3 中断续跑 + 幂等 + 验证前非活跃 writer**：单测 `rerun_import_is_idempotent`（二次 apply written=0/alreadyPresent=4/digest 不变）、`an interrupted apply resumes...`（crash 后持久化状态存在，续跑补 2 条，身份集合恰好 4）、verify 门（staging→verified；外来 phase/rolled_back 拒绝）；集成 `rerun_import_is_idempotent`（真实 PG：intents/memory 行数不变）、`interrupted_import_resumes_without_duplicates`（第 3 条写入注入崩溃 → 2 条已 finalized → 同 run id 续跑 written=2/alreadyPresent=2 → 总 4 → verify match）。staging 语义：apply 完成 phase=`staging`，verify 全匹配才 `verified`（`stagingStatusOf` 为 ME14 fence 消费的状态函数；本票不实现切换）。
- **AC4 归属不唯一/引用缺失/快照不兼容隔离 + 摘要对账阻断**：单测 `ambiguous_owner_is_quarantined`（双行 → owner_ambiguous；0 行 → owner_missing）、`non-mastra backends and non-empty targets are quarantined`、`messages with missing attachment references or unsupported shapes are quarantined per record`（attachment_missing/unsupported_role/empty_message/unsupported_shape/source_id_too_long/source_id_missing 全枚举）、`duplicate source ids inside one thread read dedupe to the first occurrence`、`source reads that fail are recorded, never treated as no data`（503 → source_read_failed + readComplete=false）、`unresolvable scope quarantines the thread as owner_unauthorized`、`verify blocks when target digests diverge from the source`；集成 `unknown_owner_and_non_mastra_backends_are_quarantined`、`ambiguous_owner_is_quarantined`（真实双租户行）、`verify_passes_then_blocks_on_target_digest_mismatch`（真实存储行篡改 → mismatch + detail 指名 key + phase=blocked）。
- **AC5 不迁个人长期记忆 / 不重复外部归属迁移**：导入面只覆盖 `getThreadMessages`（聊天历史）；`listMemories`/memory 域无任何引用（legacy-import.ts/cutover.ts 零出现）；外部线程归属迁移（#162 的 intelligenceChannelMappings 路径）零触碰——导入目标仅 `storage_backend='mastra'` 的 `enterprise_conversations` 行，legacy channel 映射路径（`currentLegacyMapping`→backend `intelligence`）在 `backend_not_staging` 隔离。
- **AC6 源只读 + 旧数据只读保留**：类型层（source seam 无写方法）+ 单测 `the real client adapter exposes exactly the two read methods`（适配器对象恰 2 个键）+ 每个集成测试的 `source.readOnly()`/`source.stateHash()` 断言 + `rollback records the state without touching either side`；无任何 DROP/DELETE/UPDATE 代码路径作用于源与旧数据（apply 只写目标 fixture 的受控 seam；rollback 仅改 run state 文件）。

## 3. 文件清单（本票增量，全部未提交）

新增：
- `server/src/mastra/legacy-import.ts`
- `server/src/mastra/cutover.ts`
- `server/scripts/mastra-agent-cutover.ts`
- `server/tests/mastra-legacy-import.test.ts`
- `server/tests/enterprise/mastra-import.integration.test.ts`

再生（既有脏树文件按流程更新）：
- `archive/verification/e2e-file-audit.json`、`docs/verification/e2e-bun-suites.json`（新测试文件入册）

共享 ME01–ME08 未提交增量零触碰（无任何既有文件被本票修改）。

## 4. 偏差与边界

- **每条消息级时间不可保留**：源 API `ThreadMessage` 无时间戳字段， controlled append 亦不接受历史 createdAt。按 brief"源 API 能力不足如实登记"处理：manifest 记录 thread 级时间窗 + capability note；此点登记为**源能力限制**而非实现缺口。
- **目标限定 mastra 空线程**：后端翻转（platform/intelligence → mastra）不做，属 ME14 写入 fence；已有外来 finalized 行的线程拒绝导入（防 seq 倒序）。
- **CLI 真实接线 UNVERIFIED**：`server/scripts/mastra-agent-cutover.ts` 的 config→真实 Intelligence/企业库接线在本环境无法运行（无真实远程 Intelligence、无部署 config），其子命令语义/授权门/状态文件由单测与库层集成测试覆盖；见 §6。

## 5. 修正记录（实施期真实行为差异）

1. 归属歧义误报（测试 fixture 缺陷）：fixture resolver 以 actorId 推导 principalId，覆盖 actor 映射后与行 principal 失配 → 全部隔离。修 fixture（actor→principal 反查表）。
2. `source_id_too_long` fixture 误把长度放进 content 而非 id → 修 fixture。
3. resume 断言修正：崩溃 fixture 记录"尝试写入"（第 3 次 push 后抛出），7=3 次尝试+4 次续跑是真实语义；改为断言"续跑重放整个未完成线程 + 身份集合恰为源集合"。
4. **canonicalFromTargetRow 以行角色分支 tool 行**（真实缺陷，集成测试捕获）：tool 结果存储为 assistant memory 行，行 role 是 assistant——分支改以 **envelope role** 为准（ME03 存储不对称的正确读法）。
5. 篡改 SQL：tenant memory 表 `content` 列为 text，需 `::jsonb` 显式转型。
6. 设计修正（集成前推演发现）：`target_not_empty` 改为只计**外来** finalized intents（`NOT LIKE 'legacy:%'`），否则重入既有导入必然误隔离，与 AC3 幂等重入冲突。

## 6. UNVERIFIED（环境缺失，不以 mock 冒充）

- 真实远程 Intelligence 的实际分页行为（`listThreads` 游标语义、`getThreadMessages` 大线程行为、真实 404/5xx 形状）：本环境无真实远程。单测/集成用确定性 Intelligence 形状 fixture（按 pinned SDK `client.d.mts` 文档形状构造）；CLI 的真实接线未跑过真实 config。
- 生产部署形态下的 operator 归属扫描性能（全表 threadId 索引缺失时的行为）：未在真实规模库上验证。
- driven part 5 / part 7 组的红：均为基线既有环境/基线失败（§1.5 逐条列明），本票文件以 junit 级证据零贡献；但在官方企业测试环境齐备处复跑这两个 driven 组的最终确认不在本工作区能力内。

## 7. 边界确认

无生产 apply；无 cutover 切换（ME14 写入 fence 的切换动作不存在于本票代码）；在途暂停记录处置不在本票。工作树无 commit/push/stash。
