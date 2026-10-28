# 方案 — #4 Opik 收尾 Run：OCR 复审修复波（R6-FIX）

- 日期：2026-10-27。编排者起草。集成树 `/Users/wuyongjun/orca/workspaces/OpenBot/opik4-integration`（分支 1123786563/opik4-integration，BASE b117c3c3e）。
- 前置链：OCR 复审（a42b1835 + resume e6af6ba0，合并 64 findings = 5H/16M/43L）→ 21 条 H/M 候选独立核验（T-A/T-B/T-C，报告在 `reviews/ocr-rereview-triage-{a,b,c}.md`）→ **6 条 CONFIRMED 阻塞**。1 条 REFUTED（T-B #2，冻结资产实证）、14 条 DOWNGRADED（低/登记）。
- 授权边界：仅本地修复、集成分支安全提交；NO push / NO 远端合并 / NO GitHub 写入。

## 一、修复项（6 条，全部有独立核验的代码级证据与最小修复形状）

| # | 级别 | 锚点 | 缺陷 | 最小修复形状（源自核验报告） |
| --- | --- | --- | --- | --- |
| C1 | HIGH | model-span.ts:266-289 | FREV-02 门致 evaluation 路径 model span 全部静默丢弃（execution-runner report 的 base 无 trace；无 drop 计数） | evaluation case 入口捕获可信 run W3C trace 并纳入 observation base/report 透传；若运行形状确实无可证明 trace，则 drop 必须入有界计数/告警，禁止无声返回。两类测试：带 trace 入队 + 缺 trace 可观测 drop |
| C2 | HIGH | opik-e2e-ingest.ts:128-129 | observer run binding gate 创建未传 `{port:() => port}`，F5E1-F3 物化链零行使且断言不设防，脚本保真声明为假 | 一行修复传 port + 一条断言钉住物化链被真实行使（T-C 给出锚点） |
| C3 | MEDIUM | copilot.ts:4942-5227 | `events` 数组对协议事实无总量上限（REMOTE_TOOL_CELL_CAP=128 只限 tool cell；tool_proposed/tool_executed 等无条件 push） | events 独立硬上限；达限后保留协议/预算处理、不再保存逐条事实，置一次 `events_capped` 事实或 bounded warn；覆盖全部 push site；超限 run 内存/事实长度断言 |
| C4 | MEDIUM | opik-http.ts:887-915 | createTrace 对全部 4xx 进入歧义→存在性轮询；确定性 400/422 被误分类为 retryable OPIK_TIMEOUT | 仅对有"可能已存在"语义的状态（至少 409）走 presence readback；其余 4xx 直接 statusFailure 原状返回。测试：项目存在+400/422 不轮询不超时；409 readback 回归 |
| C5 | MEDIUM | opik-http.ts:967-987 | writeSpans 补全对已 materialized binding 的 span 无条件以 run root 覆盖携带的同链 W3C parentSpanId / opik.parentSpanId | 携带 parent 为同一 chain 合法 W3C span id 时保留，并以同 `spanUpstreamId(traceId, carriedParent)` 派生 opik parent；缺失/自指/非法/跨链才回退 root。三类测试：carried nested parent / missing fallback / cross-chain refusal |
| C6 | MEDIUM | queries/runs.ts:260-274 + exports.ts | adoptLocalState docblock 声称 export projection 与 query face 同投影；exports.ts 实际未接线（upstream unknown + local terminal state 时两输出面不一致） | export worker 取同 scope binding lifecycle map 并调用共用 helper（= FREV-R6-01② 移交项落地）；若裁决 export 只应反映 upstream，则改 docblock 为显式有权决定。加一致性测试（推荐前者，与既有契约一致） |

## 二、流划分与 owned 文件

| 流 | 修复项 | owned 文件 | 测试面 |
| --- | --- | --- | --- |
| G1 | C1 | server/src/ai-observability/{model-span.ts,execution-runner.ts,execution-billing.ts}、server/src/index.ts（observe 接线段） | server/tests/opik-model-span.test.ts（+按需 execution 系） |
| G2 | C4+C5 | server/src/ai-observability/opik-http.ts | server/tests/opik-port.test.ts、opik-retention*.test.ts（按需） |
| G3 | C3 | server/src/copilot.ts | server/tests/copilot-observation-decoupling.test.ts（+按需 tool-selection） |
| G4 | C6 | server/src/ai-observability/exports.ts（+queries/runs.ts 仅 docblock/导出微调） | server/tests/opik-export*.test.ts |
| G5 | C2 | server/scripts/opik-e2e-ingest.ts | 对应 e2e/ingest 断言面 |

- 无跨流 owned 文件交集；G1×G2 在 index.ts 接线语义上相邻但不重叠（G2 不改 index.ts）。
- 五流并行（各自 worktree 自 827045990），**串行集成顺序：G2 → G1 → G3 → G4 → G5**（先底层 HTTP 端口面，再观测面，再业务面）。

## 三、每流门禁（与 R5-FIX 波一致）

1. 实现自 827045990 起，改动限 owned 文件 + 对应测试；生产逻辑改动必须带真实行为钉住测试（RED→GREEN 或等价验证）。
2. 流内验证：`cd server && TEST_DATABASE_URL=… bun test tests/<owned 套件>` 全绿；按需 `E2E_UNIT_SCOPE=server e2e run --config e2e.unit.config.ts <files>`；agent-langgraph 不涉及。
3. 权威报告写 `workers/ocrfix2-{g1..g5}-report.md`（逐项 判/修/证据 + 披露）。
4. 独立审核（新会话，与实现者无关）写 `reviews/ocrfix2-{g1..g5}-review-r1.md`；valid critical/high/medium = 阻塞需整改轮。
5. 编排者串行集成 + 每流合并复验；全流毕跑组合验证（fresh 库，基线 1274/0/59 + 本波新增解释差值）。

## 四、范围外登记（不进本波）

- 14 条 DOWNGRADED（T-A #13/#15；T-B 10 条；T-C #17/#21）→ 终稿 risk-acceptance/后续票清单。
- 43 low（OCR 复审）+ S1 5 low + S2 3 low → 同上。
- T-B REFUTED #2：不予修复，登记核验证据指针。

## 五、后链

组合验证 → FREV R7（独立终审，核 6 项闭环 + 组合差值）→ 终轮 OCR（全范围 b117c3c3e..<新 HEAD>，规则含 include 全集；若 78 文件补审已完成且新 HEAD 未改其对象文件，可按文件集组合记账，须逐文件说明内容版本）→ 合本地 main（勿推送）→ 清理 → 终稿。

## 六、未决项（本方案落定前须闭合）

- OCR 78 文件补审（在途，session f45e120f）的 H/M 候选须同轮独立核验；若有 CONFIRMED 阻塞并入本波（新增流或并入 owned 最近流），无则按上表定稿。
