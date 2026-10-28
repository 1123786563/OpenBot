# 方案 — #4 Opik 收尾 Run·delta2 修复批（R9-FIX，2026-10-27）

## 依据

微增量 OCR delta2（9 文件 @f5a78ba0d，首轮 32 findings 3C/8M/21L）经 T-L 独立核验（reviews/ocr-delta2-triage-l.md，11→9 归并）：**3 CONFIRMED（全 medium）/ 1 REFUTED（L-A 三条 critical 水印伪读合并）/ 5 DOWNGRADED**。L-A 字节级证伪（三位置码点数组尾字节 0x6e 合法 BigInt + 三文件 bun build exit 0）。delta2b 双文件补审（tool-steps/copilot）在途，其新确认项追加入本批 FIX-J 范围。

## 修复项与分流

### FIX-I — gate 谓词条款隔离 + 计数常量单源（L-F + L-G，同两文件）

owned：`server/scripts/opik-e2e-ingest.ts`、`server/scripts/opik-e2e-ingest-gate-check.ts`

- **L-G**：抽模块级常量（如 `EXPECTED_WRITES_PER_ROUND = 2`），三处同引：谓词 :91-92 两个 `>= 2`、`submitBoth()` 两笔 record（注释/断言引用常量说明「两笔=该常量」）、循环条件 :267 `< 2` 两处。
- **L-F**：gate-check 补三隔离 case：`{ ...clean, completed: 1 }`（钉 completed≥2 条款——#40 核心条款）、`{ ...clean, accepted: 1, completed: 1 }`（钉 accepted）、`{ ...clean, droppedFull: 1 }`（钉 droppedFull）；各断言 false。夹具中 submitted/accepted/completed 数值同步引用常量；`recoveredRound: Stats = clean` 改 `{ ...clean }` 解引用（一字之改，消同引用歧义）。
- **门禁**：`bun server/scripts/opik-e2e-ingest-gate-check.ts` 9/9 exit 0（原 6 + 新 3）；变异自证：临时把谓词 `completed>=2` 改 `>=1` 复跑应红（记录变异读数后还原）；`bun build --target bun server/scripts/opik-e2e-ingest.ts --outfile /dev/null` exit 0；tsc 基线差=0。
- 注意与 R1-G-01（fixture refused 应=2，low，tracking）同文件——**不顺手改**（R1-G-01 已裁决 low 登记，避免混入本波范围；若 worker 判断同 hunk 顺手成本为零可一并改并在报告披露）。

### FIX-J — 锚点 span 闭合（L-H；**已被下方终定形「五项合并流」节取代**）

owned：`server/src/copilot.ts`（+ 必要时 remote-dial-chain.test.ts）

- 首选形状：dial 关闭（settle/finalize 时机）对同一 OTLP traces 端点按同 traceId/spanId 补发带 `endTimeUnixNano` 的两根 span（OTLP upsert 语义；409 视同已闭合，沿用 :4538-4540 幂等先例）；remote-dial-chain 套件补「闭合批带 endTime」钉。
- 次选（仅当首选实现被实证侵入性过高，须在报告论证）：docblock 明示「刻意不闭合」+ 后端行为钉。
- delta2b 补审（pid 97652）若有新 CONFIRMED 且触 copilot.ts，并入本流。

## 执行序与门禁

1. FIX-I 先行（owned 与一切在途零交集）；FIX-J 待 delta2b 落地后派发。〔实际执行序=I→K→J，FIX-K 见下；T-O 候选 10 回填〕
2. 每流独立审核 r1 → 串行集成 → 组合复验（对照 1289 基线对账）。
3. 终轮微增量 OCR（R9 触面 @最终 HEAD）→ 新 H/M 同纪律 triage → FREV R8 → 合本地 main → 清理 → 终稿。

### FIX-J — copilot.ts 锚点域五项合并流（L-H + T-M #3 + T-N #3/#5/#4-sub；终定形于 T-N 落地后）

owned：`server/src/copilot.ts`、`server/src/ai-observability/shared/trace.ts`（helper 收敛）、`server/tests/remote-dial-chain.test.ts`（及受影响 copilot 系测试）

1. **L-H（M）**：settle/finalize 时对同一 OTLP traces 端点补发带 `endTimeUnixNano` 的两根锚点 span（同 traceId/spanId，OTLP upsert 语义；409 视同已闭合，沿 :4538-4540 幂等先例）；remote-dial-chain 补「闭合批带 endTime」钉。
2. **T-M #3（M）**：`deriveTracesTarget(env)` 共享 helper（trace.ts:115-119 与 copilot.ts:4473-4478 双处收敛）；headers `TRACES_HEADERS ?? HEADERS` 回退（复用 otel.ts:122 parseHeaders）；service.name 与 initProcessTracing 同源（消 openbot-server/server 分裂）；:4504 fetch 加 `AbortSignal.timeout(10_000)`。
3. **T-N #3（终级 M，波内首位）**：:5545 openbotBudget runId 入口 trim 纪律（内联 :4909 同式表达式——runWith 在中间件作用域不可引局部量，T-N 已纠 T-M 表述）；:5494 signRun 对齐须与验证侧同步，作为披露核对项处理。
4. **T-N #5（M）**：:5278 `} else {` → `} else if (!toolCells.has(toolCallId)) {`（重复 TOOL_CALL_START 保留累积 cell，builtin 复用语义对齐）；测试钉重复 START 不清空。
5. **T-N #4-sub（low，顺带）**：锚点 span 工厂 `openbot.run.id` 截断（slice(0,256) 或共享 MAX_RUN_ID_LENGTH）；remote-run.ts:264 同款未截断系范围外登记（主控 tracking）。

门禁：五项各自 RED/GREEN；focused fresh-DB 复跑（copilot 系套件）；tsc 基线差=0；biome 新增=0；`bun build --target bun` 可加载。

### FIX-K — chainGateDrops 运维出口（T-M #2，M）

owned：`server/src/ai-observability/tool-steps.ts`、`server/src/ai-observability/model-span.ts`、`server/src/ai-observability/health.ts`（投影）；受影响测试

- 首选形状：两计数器（toolStepChainGateDrops + modelSpanChainGateDrops）的 missingChain 并入 `writeStats()`/`snapshot()` 投影（镜像 idLinkStats 先例 health.ts:200-206），steps 与 model-span 必须同流落账（否则缺口在孪生处续存）。
- RED/GREEN：门控丢弃后 writeStats 投影含计数的新钉；路由对外供给（routes/health.ts:33 通道）读数验证。
- 门禁同上；docblock「counted here is its visibility」措辞随投影落地保持真实。
