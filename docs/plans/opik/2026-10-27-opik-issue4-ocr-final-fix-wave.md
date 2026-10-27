# 方案 — #4 Opik 收尾 Run·OCR 终轮修复批（R7-FIX，2026-10-27）

## 依据

终轮全范围 OCR（b117c3c3e..6b8a63dfa，session 6ee41328 + resume e80298c7，127/127 覆盖闭合，权威报告 `ocr/final-full-scope.md` sha256 fcd135959d02…）产出 126 findings（0C/13H/53M/60L）。H/M 候选 66 条经三路独立核验（reviews/ocr-final-triage-{g,h,i}.md）：**12 CONFIRMED**（T-I 11 + T-G 1）/ 6 REFUTED / 28 DOWNGRADED / 10 DUPLICATE-OF-PRIOR / 6 MOOT-AT-MERGE（合计 62，按三报告末行认证 JSON 重算）；余 4 条（final-hm-candidates.md #10–#13，docs/plans 面，首轮派发缺口）由 R8-FIX H 流补裁：#11 DUPLICATE-OF-PRIOR（=T-G #16）、#10/#13 DOWNGRADED（→low）、#12 CONFIRMED（上报主控另立）——12+6+28+10+6+4=66 闭合。本批按最小形状修复 12 项，不扩大范围。

## 修复项与分流

### FIX-A — ingest 脚本证据完整性（2 项）
owned：`server/scripts/opik-e2e-ingest.ts`（及配套测试如需）
- **A1（#40）**：writeAccepted 门槛（:217-223 重试累加语境）补 `Object.values(stats.failed).every(c=>c===0) && stats.refusedNotReady===0`；断言不再被跨轮累加与 failed 静默穿透。测试：failed.unavailable>0 时门槛拒绝（可注入 fake 端口/统计面）。
- **A2（#54）**：:305 `settleObservedWindow(scope, runChain, "terminal")` 改 `settleObservedRun`（携带 startedAt/ending/endedAt），与生产装配 index.ts:8014 同形；(c) 项断言随 settle 形状更新。
- 集成后由主控重跑真实栈验收（脚本行为已变，R7-02 同配方；证据落 `verification/e2e/ingest-rerun-final/`）。

### FIX-B — server 生产观测面（5 项）
owned：`server/src/ai-observability/tool-steps.ts`、`server/src/ai-observability/queries/runs.ts`、`server/src/ai-observability/opik-http.ts`、`server/src/copilot.ts`、`server/src/ai-observability/model-span.ts` 及其单测（opik-tool-steps / opik-runs-query / opik-port / copilot-observation-decoupling / opik-model-span）
- **B1（#49）**：tool-steps.ts 模块级 `chainGateDrops` 计数镜像 model-span.ts:260-292（record/recordRetrieval 共用；只读导出副本不可重置；文件头「counted, never exported」声明兑现）。
- **B2（#59）**：导出共享 `MAX_TOOL_CALL_ID_LENGTH=256`（放 tool-steps 或相邻共享模块），写侧投影超限拒绝/裁剪至同界，读侧引用同常量。测试：257 字符 id 读侧不再「从未提供」。
- **B3（#61）**：opik-http.ts writeSpans 在任何 drift 判定前先做形状校验（HEX32/HEX16/UUIDV7，镜像 createTrace :826 顺序）。测试：已 reconcile binding + 畸形显式上游 id → OPERATION_INPUT_INVALID，非 drift/suspendedWrites。
- **B4（#62）**：copilot.ts:4903-4905 gate 调用包 race 超时（同 resolveObservationScopeBounded :5799-5850 结构），超时 fail-closed 拒绝，finally 清 timer。测试：注入永挂 gate → 预算拒绝路径在超时内落定（RED/GREEN 复现）。
- **B5（#57）**：model-span.ts :96-98 docblock 更新为「计数后整条丢弃，绝不导出新根」；:182-183 fresh-root 回退删除或标注纯防御（worker 须以不可达性证明择形）。

### FIX-C — 测试与 manifest（4 项）
owned：`server/tests/remote-budget-smoke.test.ts`、`server/tests/opik-migration-0209.integration.test.ts`、`server/tests/opik-retention.integration.test.ts`、`tests/config/e2e-bun-suites.json`
- **C1（#45）**：:299-341 与 :361-398 两处 `provider.start()` 主体包 try/finally，finally 中 `provider.stop()`。
- **C2（#52）**：S1 rewrite（:241-245）SET 列表补 `opik_trace_id` 赋值（`case id when w2 then 'mig-trace-2' else 'mig-trace-9' end`），使嵌套 secondary ranking 路径真实执行并被断言。
- **C3（#64）**：:2103 用例 reconcile 移到 discover 之后（与用例名/注释一致；保留 legacy-key collision-loser 覆盖）。
- **C4（#46）**：tests/config/e2e-bun-suites.json 登记第三件 opik-migration-0209.integration.test.ts（连同披露 2 的 observer-binding / builtin-terminal-states 共三件全部登记）；e2e 入口驱动三套件全绿；e2e-coverage-audit 谓词（bunLayer ∧ ¬driven gap）通过。

### FIX-D — 收口文档（1 项）
owned：`docs/plans/opik/2026-10-24-opik-issue4-acceptance-map.md`
- **D1（T-G #17）**：「覆盖子票」列按 DAG 的 A 映射列逐行重算为纯 Issue 号（A1 补 #10/#13 核实后定；A7→#25,#26,#27,#28,#32,#33,#34,#36；A8→#29,#31,#33,#36；A9→#28,#32,#34,#35,#37；A10→#14,#15,#16,#18,#19,#30,#39,#40），表注声明口径=Issue 号（T-G 报告 §#17 原文）。

## 执行序与门禁

1. 四流并行（owned 面零交集）；每流：实现→自验（RED/GREEN 复现）→流内报告 `workers/r7fix-{a,b,c,d}-report.md`。
2. 每流独立审核 r1（新会话）：Spec 逐项 + 质量门（focused fresh-DB 复跑；diff 零越界；tsc 基线差=0=存量 3 条 bootstrap-local-gateway；biome 存量基线对照）。
3. 串行集成（交付节奏定序，ledger 披露）→ 每步 fresh-DB 聚焦复验。
4. 组合验证：`tests/opik-*.test.ts tests/copilot-observation-decoupling.test.ts` 全量 fresh-DB；门禁对照基线（1283/0/59 @R6-FIX 波后 + 本波新增用例数对账）；e2e-coverage-audit 通过。
5. FIX-A 集成后主控真实栈复跑（ingest-rerun-final）。
6. 增量终审 OCR：include=本波改动文件全集（~12 文件）@最终 HEAD，exclude=其余（127 集已在其 6b8a63dfa 内容下完成）→ 新 H/M 走同一 triage 纪律（码点核验强制）。
7. FREV R8（独立终审：12 项闭环 + 覆盖链审计 + 组合对账）→ 合本地 main → 清理 → 终稿。

## 范围外登记（不并入本批）

- DOWNGRADED 18 条 + DUPLICATE 10 条按各自既有归属（R5-F2 族 low / 规则资产修订后续票 / Run 资产后续票 / 合并日必办清单）。
- #41 部署纪律一行文档、#47 运维排序注记、#48 budget_exceeded 硬化、#60 日志卫生——并入终稿 future-ticket 清单。
- S2-L2（规则快照 main 侧消解）、0209_opik→0216 重编号——合并日 checklist。
