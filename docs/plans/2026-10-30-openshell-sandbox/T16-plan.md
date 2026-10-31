# T16 OpenShell Mode Overall Acceptance and Deployment Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository execution, issue, checkpoint, review, and delivery rules govern actual dispatch and authorization.

**Goal:** 在一个真实 Kubernetes OpenShell 部署上聚合验证 computer 与编码环境完整旅程，产出 A01–A09 可核对证据索引、可复现部署说明、旧模式实际回归和独立终验结论。

**Architecture:** T16 不新增产品能力，也不重做 T01–T15。它以同一源树、同一选定 OpenShell/controller/CRD/CNI/storage/image 组合和同一 Kubernetes 部署为边界，复用上游实际接口与验收证据，新增的只有证据索引、整体 live 验收、旧模式回归、部署说明和终验门禁。所有结论必须绑定源树与运行时身份；任何失败、阻塞、跳过或未运行都保持未通过。

**Tech Stack:** TypeScript/Bun、tester-army e2e、Kubernetes、OpenShell 选定版本栈、Helm、PostgreSQL、GitHub Checks/rulesets 只读 API。

**Spec:** [OpenShell Spec v1 全文](../../specs/2026-10-30-openshell-sandbox.md)，frontmatter `status: approved`、`approved_content_sha256: 18a9a030d6420887a10e15cbee946353a0e67e119fa730ddc9eff0694cbf458c`；重点逐项核对 [D1–D25](../../specs/2026-10-30-openshell-sandbox.md#已批准决定) 与 [A01–A09 验收映射](../../specs/2026-10-30-openshell-sandbox.md#验收映射)、[技术条件与尚待验证项](../../specs/2026-10-30-openshell-sandbox.md#技术条件与尚待验证项)、[范围与非目标](../../specs/2026-10-30-openshell-sandbox.md#范围与非目标)。架构边界见 [ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)，业务范围见 [ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)，测试入口见 [ADR 0008](../../adr/0008-test-runner-tester-army-e2e.md)。Ticket 事实见 [ticket-breakdown.md T16](ticket-breakdown.md#t16--openshell-模式整体验收与部署说明) 与 [技术验证门槛 1–7](design.md#技术验证门槛)。

**Issue:** [#750](https://github.com/1123786563/OpenBot/issues/750) `OpenShell T16: OpenShell 模式整体验收与部署说明`，父 Issue [#734](https://github.com/1123786563/OpenBot/issues/734)，标签 `ready-for-agent`。计划时只读核实 #750 为 open，其真实直接 Blocked by 为 [#738](https://github.com/1123786563/OpenBot/issues/738)、[#742](https://github.com/1123786563/OpenBot/issues/742)、[#745](https://github.com/1123786563/OpenBot/issues/745)、[#746](https://github.com/1123786563/OpenBot/issues/746)、[#747](https://github.com/1123786563/OpenBot/issues/747)、[#748](https://github.com/1123786563/OpenBot/issues/748)、[#749](https://github.com/1123786563/OpenBot/issues/749)，且上述 blockers 均为 open；父 #734 亦为 open。Issue、标签和父子关系都不是实施授权。

**Planning snapshot:** 本计划撰写时只读扫描到本地 HEAD `15cd81c13bb58bdeb9198215b2a2b103389a3421`、当前可见 `T01-plan.md`–`T15-plan.md` 快照，以及上述代码/产物。T13/T14/T15 可能来自并行 Worker且后续会变化；本计划不复制其细节。实施前必须重扫全部 T01–T15 计划、#734/#735–#750、上游 Review/OCR/CI/run 验证证据和批准事实源的当前有效版本、指纹与关系，再决定是否解除 blocked。

## Global Constraints

- 本票只允许聚合验收、证据索引、部署说明、旧模式回归和终验；不得新增产品功能、放宽 D1–D25/A01–A09、把 mock 当 live、或通过降低隔离、共享沙箱、删除用户数据或延长未验证时限换取通过。
- 直接阻塞项 #738/#742/#745/#746/#747/#748/#749 未全部以当前事实源 verified 前，T16 只能准备只读材料，不得宣称开始终验或可用；传递依赖也必须从 #735–#749 的实际证据链核实。
- 实施前重扫：Spec/ADR/design/ticket/root context、全部 T01–T15 当前计划、#734/#735–#750 正文评论状态关系、上游 run 报告、独立 Review、OCR、CI、源树检查点和资源声明；事实源或接口变化时先修订计划，不猜接口。
- 证据必须绑定同一源树 checkpoint（含 HEAD、授权 diff/untracked 清单和 SHA-256 manifest）与实际运行时身份：OpenShell/controller/CRD/CNI/storage/kernel、computer/coding/server image digest、Helm values、实际服务 revision、数据库迁移身份和测试输入。只写 tag、端口或旧日志不算绑定。
- T16 证据和可跨工作区核对的清单/哈希落在 `.archive/runs/<run-key>/verification/T16/`；Review 在 `reviews/`、OCR 在 `ocr/`、checkpoint 在 `checkpoints/`。原始 e2e 输出先用独立 `.e2e/<run-key>/.../`，最终归档命令、报告、退出码、实际收集数、失败/跳过、清理结果和 SHA-256。
- ADR 0008 的 `E2E_UNIT_OUTPUT=... e2e run --config e2e.unit.config.ts ...` 是唯一正式验收入口；直接 `bun test` 只能诊断。报告必须记录 executed/passed/failed/skipped，聚合 `verify` 绿灯不能掩盖单个 job skipped、cancelled、pending 或未运行。
- live Kubernetes、真实浏览器/OpenCode/SSE/WS/preview、网络、持久化、容量和失联注入不可用即 blocked；上游 unit/mock/dry-run 只能定位问题，不能替代 T16 live 组合证据。测试替身只允许用于可控外部副作用接收端，且必须在报告中明确其边界。
- 独占声明 Kubernetes 集群/namespace、数据库、端口、DNS/负载均衡、镜像仓库、run-key 和报告目录；记录 owner、准入/释放回执、清理前后资源清单。不清理、无法证明归属或清理失败均不得终验通过。
- 旧模式必须实际回归 `shared` computer、既有 Kubernetes `sandbox` computer 和共享编码环境的关键行为，不能只渲染 chart 或断言源码分支。旧模式保持各自既有语义，OpenShell 网络审批/默认拒绝能力不得泄漏成旧模式承诺。
- 部署说明中的版本、digest、controller/CRD/CNI/storage、RBAC/secret、资源、容量、闲置、宽限期和队列默认值必须引用当前 live 证据；未测能力、局限、故障恢复和数据保留边界如实写明。
- 终验包含独立行为验收、独立 Spec Review、独立质量 Review、适用 OCR 和目标 SHA Required Checks/标准 CI。任何有效 critical/high/medium、A0x `fail/blocked/untested`、必需证据缺失、版本漂移、旧模式实际回归缺失或 Required Checks 不可证明，均使 T16 保持 blocked。

## Review Focus

1. **Mock 冒充 live**：fake OpenShell client、假浏览器/假 OpenCode、mock policy 或本地替身不得作为 Kubernetes 隔离、网络、容量或失联证明；Task 2 preflight 和 12 个 live 场景逐一拒绝非 live 证据，Task 5 复核。
2. **聚合绿灯掩盖失败/跳过/未运行**：`verify`、summary exit 0 或上游 Issue 关闭不能证明 A0x；Task 1 逐条矩阵化状态与哈希，Task 2–4 记录 12/12/10 条实际结果，Task 5 重跑 42 条并查每个 CI job conclusion。
3. **证据与源树/版本漂移**：计划、测试、报告、部署 values、镜像 digest、controller/CNI/storage、实际 revision 或 target SHA 不一致；Task 1/4 强制 source-runtime binding，Task 5 在最终 SHA 上复核。
4. **A0x 票间落空**：上游单票绿灯但完整用户旅程中的组合交互失败，或 A01–A09 没有唯一 owner/entry；Task 1 拒绝缺行/重复/弱证据，Task 2 在同一部署连续执行 12 个组合场景，Task 5 独立复核。
5. **旧模式无实际回归**：只测 OpenShell 或只看 chart 输出而未运行旧模式；Task 3 对 shared、既有 sandbox 和共享编码执行真实回归，并核对管理员真实能力/配置/故障状态。

## Current Code Facts

- `server/src/computer/deployment-routes.ts` 当前保留 `policy`、`fleet`、`policy-dry-run` 三个 deployment route 名；真实 `/api/computers/fleet` 在 `server/src/computer/routes.ts` 并调用 `gateway.computers()`。执行时必须采用 T01–T15 完成后的实际路由和响应合同。
- `app/src/routes/_authed/admin/computers.tsx` 当前经 `scopedComputerFleetQueryOptions` 读取 fleet；`app/src/lib/computers/queries.ts` 当前 `ComputerFleet.isolation` 只有 `shared | per-bot` 语义。T16 不重设计 UI，只验收上游交付后的真实模式、能力、限制和故障状态。
- `charts/openbot/values.yaml` 当前 `computers.mode` 仅覆盖 `shared | sandbox | external`；chart 部署说明的规范位置是 `charts/openbot/README.md`，产品/运维入口是 `reference/deployment.md`。执行时以 T01–T15 后的实际 values/templates/README 为准。
- `.github/workflows/ci.yml` 当前 chart matrix 为 `self-hosted, eks, eks-sandbox, gke, aks`，且注释明确 skipped 对 `verify` 可当通过；T16 不能只看 `verify`。
- `scripts/craft-preview-acceptance.ts` 的既有样式是 fail-loud preflight、逐条 PASS/FAIL/SKIP、finally 留证和 `.archive/runs/.../verification/` 归档；T16 脚本沿用该诚实报告形态，但不复用其业务断言。

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `scripts/openshell-evidence-index.ts` | 读取上游 manifest、源树/运行时绑定、Review/OCR/CI 输入，生成 A01–A09 JSON/Markdown 矩阵和终验输入。 |
| Create | `scripts/openshell-overall-acceptance.ts` | 统一 preflight、live run 编排、报告/命令/计数/清理/哈希落盘；不实现产品行为。 |
| Create | `tests/openshell/openshell-evidence-index.test.ts` | 8 条矩阵 schema/完整性/哈希/状态/门禁用例。 |
| Create | `tests/openshell/overall-acceptance.e2e.test.ts` | 12 条同一 Kubernetes 部署的完整 live 用户旅程。 |
| Create | `tests/openshell/legacy-and-admin-regression.e2e.test.ts` | 12 条旧模式实际回归与 OpenShell 管理员状态用例。 |
| Create | `tests/openshell/openshell-deployment-docs.test.ts` | 10 条部署说明、版本依据、values/渲染一致性用例。 |
| Create | `reference/openshell-deployment.md` | 面向部署管理员的 OpenShell 复现说明、故障/恢复/局限和证据链接。 |
| Create | `charts/openbot/ci/openshell-values.yaml` | OpenShell chart CI/render 目标；只含经验证的可渲染配置，不承载秘密。 |
| Modify | `charts/openbot/README.md` | 加入 OpenShell 目标、入口、先决条件和不扩大承诺的说明。 |
| Modify | `reference/deployment.md` | 从通用部署文档链接 OpenShell 专用文档和适用边界。 |
| Modify | `scripts/lib/e2e-manifest.mjs` | 仅把新增 live suites 加入 `LIVE_SUITES`，默认无集群时不收集，`OPENBOT_LIVE_API=1` 时保持 e2e 唯一入口。 |
| Modify | `.github/workflows/ci.yml` | 将 `openshell` chart target 纳入 chart matrix，并保留逐 target 非 skipped 结论；不新增产品 job 语义。 |
| Archive | `.archive/runs/<run-key>/verification/T16/` | `upstream-manifest.json`、`evidence-matrix.json/md`、`source-runtime-binding.json`、各 live/report、`commands.jsonl`、`cleanup.json`、`ci/`、`cross-workspace-checklist.md`、`hash-manifest.sha256`、`final-verdict.md`。 |
| Archive | `.archive/runs/<run-key>/reviews/`、`ocr/`、`checkpoints/` | 独立行为/Spec/质量 Review、适用 OCR、可还原源树与跨工作区核对材料。 |

## Dependency Contract

执行前从当前有效计划和 run 归档解析下表的最小事实；T16 只消费这些接口/证据，不复制或重实现它们。若某行缺 report、接口漂移或源树不匹配，对应 A0x 保持 `blocked`。

| Upstream | Issue | T16 minimum consumed contract |
| --- | --- | --- |
| T01 | #735 | 选定 OpenShell/controller/CRD/CNI/storage/kernel/image digest、Helm values、workspace/namespace 映射、默认拒绝与隔离 preflight 证据。 |
| T02 | #736 | `ComputerProvider`/gateway 的 OpenShell computer 启动、scope、状态、停止/重置接口与浏览器 live 报告。 |
| T03 | #737 | OpenCode 会话、编码事件流、工作文件、生命周期与 coding 沙箱接口报告。 |
| T04 | #738 | computer/OpenCode/SSE/WS/preview 的 OpenBot 鉴权入口、不可直连证明和转发合同。 |
| T05 | #739 | durable intent/outcome、紧急处置、审计故障与恢复对账合同。 |
| T06 | #740 | computer 登录资料 stop/start/reset、状态查询不唤醒及崩溃/Pod/控制服务重启证据。 |
| T07 | #741 | coding 工作文件/会话 stop/start/reset 与异常重建证据。 |
| T08 | #742 | 有效预览活动、后台轮询不续期、按需唤醒和授权行为。 |
| T09 | #743 | computer 网络申请、部署管理员审批、策略生效回执和审计。 |
| T10 | #744 | coding 独立申请/审批、环境隔离和失败可申请路径。 |
| T11 | #745 | 到期/任务结束/人工撤销、既有长连接断开、并发与 provider 附加规则的最终有效策略证据。 |
| T12 | #746 | 双向受控文件传递、路径/链接/scope 防护、幂等与审计证据。 |
| T13 | #747 | CPU/内存/存储硬限制、两类与总预算、排队/超时/释放和实测默认值依据。 |
| T14 | #748 | 控制面停机/分区/约束组件故障、独立期限阻止执行、恢复重核与实测宽限期。 |
| T15 | #749 | 未知外部副作用待核对、人工处置、幂等重试和用户可见状态。 |

矩阵行必须使用统一字段：`acceptance: A0x`、`requirementsD: D...[]`、`owner: {ticket, issue}`、`entry: test or evidence entry`、`status: pass | fail | blocked | untested`、`evidence: {path, sha256}[]`。`pass` 只能来自当前绑定下的 live/独立验证；`blocked/untested/fail` 均不能转成通过。

### Task 1: A01–A09 Evidence Matrix and Index

**Files:**
- Create: `scripts/openshell-evidence-index.ts`
- Test: `tests/openshell/openshell-evidence-index.test.ts`
- Archive: `.archive/runs/<run-key>/verification/T16/upstream-manifest.json`, `evidence-matrix.json`, `evidence-matrix.md`, `source-runtime-binding.json`, `cross-workspace-checklist.md`, `hash-manifest.sha256`

**Interfaces:**
- Consumes: 上表 T01–T15 的当前有效计划、Issue 状态、run report、接口合同、Review/OCR/CI 证据和资源/cleanup 回执。
- Produces: `EvidenceIndex`/`EvidenceGateInput` with exactly A01–A09 rows, one primary owner per row, non-empty `entry`, honest status, and SHA-256-bound evidence. Task 2 may replace the preliminary runtime binding with the T16 live binding; only Task 5 renders the final verdict.

- [ ] **Step 1: Rescan and freeze inputs.** 只读重扫全部指定事实源、T01–T15 当前计划、#734/#735–#750 与上游归档；生成 `upstream-manifest.json`，记录每个输入的规范路径/Issue URL、读取时间、内容 SHA-256、源树 checkpoint 和缺口。任何直接 blocker 或传递依赖未 verified 时，矩阵先保持 `blocked`，继续本任务仅做可核对索引。
- [ ] **Step 2: Write the failing evidence-index tests.** 新增 8 条用例：`requires exactly A01 through A09`、`maps every row to approved D conditions`、`requires one current owner and issue`、`requires a concrete test or evidence entry`、`allows only pass fail blocked untested and never upgrades non-pass`、`requires live evidence path and sha256 match`、`binds source checkpoint and runtime identity`、`blocks on unresolved medium plus or missing review ocr ci evidence`。断言字段名与 Dependency Contract 完全一致。
- [ ] **Step 3: Run RED.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-evidence-red" \
  e2e run --config e2e.unit.config.ts tests/openshell/openshell-evidence-index.test.ts
```

Expected: exit non-zero with 0 executed and a collection error naming the missing `scripts/openshell-evidence-index.ts` export/module; if dynamic-import failures are collected instead, exactly 8 failed and 0 skipped. Archive the RED report only as development evidence, not acceptance.
- [ ] **Step 4: Implement the index.** 实现 `scripts/openshell-evidence-index.ts`：fail-loud 输入校验、A01–A09 唯一映射、D 条/owner/entry/status/evidence/hash、source-runtime binding、Review/OCR/CI 门禁、JSON+Markdown 输出。缺文件、坏哈希、mock 标成 live、空 entry、重复/缺 A0x、或 medium+ 未处置均非零退出。
- [ ] **Step 5: Run GREEN and generate the first honest matrix.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-evidence-green" \
  e2e run --config e2e.unit.config.ts tests/openshell/openshell-evidence-index.test.ts

bun scripts/openshell-evidence-index.ts \
  --spec docs/specs/2026-10-30-openshell-sandbox.md \
  --plans-dir docs/plans/2026-10-30-openshell-sandbox \
  --upstream-manifest ".archive/runs/$RUN_KEY/verification/T16/upstream-manifest.json" \
  --runtime-binding ".archive/runs/$RUN_KEY/verification/T16/source-runtime-binding.json" \
  --output-dir ".archive/runs/$RUN_KEY/verification/T16"
```

Expected: test exit 0 with 8 executed/8 passed/0 failed/0 skipped; index command exit 0 or a non-zero honest blocked/fail diagnosis. The initial matrix may use T01's verified runtime binding and remain `blocked` until Task 2 supplies the T16 live binding. It must contain exactly 9 A rows, one SHA-256 per referenced evidence file, `hash-manifest.sha256`, and a cross-workspace checklist that another workspace can re-read and verify from absolute archive roots plus relative paths/hashes.

### Task 2: One Kubernetes Live Aggregate User Journey

**Files:**
- Create: `scripts/openshell-overall-acceptance.ts`
- Test: `tests/openshell/overall-acceptance.e2e.test.ts`
- Modify: `scripts/lib/e2e-manifest.mjs`
- Archive: `.archive/runs/<run-key>/verification/T16/live/`, `commands.jsonl`, `cleanup.json`

**Interfaces:**
- Consumes: T01 runtime binding and selected Helm values; T02/T03 workload APIs; T04 authenticated HTTP/SSE/WS/preview routes; T05–T15 behavior contracts from their actual implementations.
- Produces: final `source-runtime-binding.json` and `overall-acceptance-report.json` with 12 case verdicts, source/runtime IDs, command logs, observed state, cleanup receipts, and per-case evidence hashes; consumed by Tasks 1, 4, and 5.

- [ ] **Step 1: Acquire exclusive resources and preflight.** 通过既有共享协调入口声明并取得同一 run 的集群/namespace、数据库、网络端点、镜像仓库和报告目录；记录 token、心跳和清理 owner。Preflight 必须证明 live Kubernetes、选定 OpenShell/controller/CRD/CNI/storage、真实 server/computer/coding image digest、迁移版本、资源余量、时钟和源树 checkpoint 全部匹配；任一项失败立即非零退出。
- [ ] **Step 2: Register and add 12 live journey cases.** 先把本 suite 和 Task 3 suite 加入 `LIVE_SUITES`，默认测试不因缺集群而失败，同时保留 ADR 0008 的 e2e 入口/覆盖对账。再用同一 Kubernetes OpenShell 部署连续执行：`deployment and runtime identity preflight`、`computer browser journey`、`coding and opencode session`、`authenticated sse ws and preview journey`、`controlled file transfer and profile exclusion`、`cross bot team and business-scope isolation`、`default deny and admin network grant`、`revocation closes existing and concurrent connections`、`stop start and separate reset across both environments`、`capacity hard limits queue and no data deletion`、`audit fault emergency containment and unknown external effect`、`control-plane loss partition guard fault and safe recovery`。第 11 条必须证明未知外部副作用进入用户可见的待核对状态且不自动重放；每条都必须真实调用 OpenBot 入口并核对残留状态。
- [ ] **Step 3: Run the live suite.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-live" \
OPENSHELL_RUN_KEY="$RUN_KEY" \
OPENSHELL_LIVE=1 \
OPENBOT_LIVE_API=1 \
  e2e run --config e2e.unit.config.ts tests/openshell/overall-acceptance.e2e.test.ts
```

Expected under a complete deployment: exit 0, 12 executed/12 passed/0 failed/0 skipped. Any required case failing or unable to run yields non-zero and status `fail` or `blocked`; it is never marked skipped. Preserve logs/report even when preflight fails.
- [ ] **Step 4: Verify report and cleanup.** 运行 `bun scripts/e2e-report-summary.mjs "$PWD/.e2e/$RUN_KEY/t16-live/report.json"`，期望输出 `12 executed · 12 passed · 0 failed` 且无 skipped；脚本按创建者 ID 清理本轮 Kubernetes/数据库/网络/文件资源，`cleanup.json` 记录前后资源清单与释放回执。清理失败时终验保持 blocked。

### Task 3: Legacy Regression and Administrator State

**Files:**
- Test: `tests/openshell/legacy-and-admin-regression.e2e.test.ts`
- Archive: `.archive/runs/<run-key>/verification/T16/legacy-admin/`

**Interfaces:**
- Consumes: current legacy `computers.mode: shared` and `sandbox` chart/runtime behavior, existing shared coding deployment behavior, and the OpenShell admin fleet/status contracts delivered upstream.
- Produces: `legacy-admin-regression-report.json` with 12 real regression verdicts and source/runtime/cleanup bindings; consumed by Tasks 1 and 5.

- [ ] **Step 1: Add 12 regression cases.** 覆盖 `legacy shared computer baseline`、`legacy sandbox computer baseline`、`legacy shared coding baseline`、`admin sees actual openshell mode and capabilities`、`admin sees selected versions and digest binding`、`admin sees resource and capacity limits`、`admin sees network policy and grant status`、`admin sees audit and pending reconciliation state`、`admin sees loss containment and recovery state`、`openshell guarantees do not leak into legacy mode`、`admin authorization and fleet failure states`、`legacy cleanup preserves preexisting data`。前三个必须是实际旧模式运行，不允许仅 template/render。
- [ ] **Step 2: Run legacy and admin suites.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-legacy-admin" \
OPENSHELL_RUN_KEY="$RUN_KEY" \
OPENSHELL_LIVE=1 \
OPENBOT_LIVE_API=1 \
  e2e run --config e2e.unit.config.ts tests/openshell/legacy-and-admin-regression.e2e.test.ts
```

Expected: exit 0, 12 executed/12 passed/0 failed/0 skipped. Missing legacy cluster/CRD/storage or inability to prove an existing deployment makes the command non-zero; at least A01 and #750's legacy-regression criterion remain blocked, with any affected A0x explicitly marked rather than inferred.
- [ ] **Step 3: Preserve data and record cleanup.** 只使用本轮专属测试数据，停止/删除本轮创建的 workload；对既有 volume/database/namespace 仅记录身份和未改动证明。`cleanup.json` 必须包含 before/after resource IDs and hashes；无法证明未改动既有数据时 blocked。

### Task 4: Reproducible Deployment Documentation and Defaults

**Files:**
- Create: `reference/openshell-deployment.md`, `charts/openbot/ci/openshell-values.yaml`
- Modify: `charts/openbot/README.md`, `reference/deployment.md`, `.github/workflows/ci.yml`
- Test: `tests/openshell/openshell-deployment-docs.test.ts`
- Archive: `.archive/runs/<run-key>/verification/T16/deployment-docs/`

**Interfaces:**
- Consumes: Task 2 `source-runtime-binding.json` and live report; T01 selected stack; T13 measured resource/capacity defaults; T14 measured grace mechanism; chart values/templates and README conventions.
- Produces: deployment guide plus render target/report that Task 1 and Task 5 can hash and compare against the live runtime.

- [ ] **Step 1: Write 10 failing documentation/render checks.** 用例覆盖 `prerequisites and cluster capabilities`、`immutable version and digest basis`、`controller crd and rbac installation`、`cni and effective network policy enforcement`、`storage class and hard quota evidence`、`credentials secret boundaries and rotation`、`resource capacity idle and grace defaults cite measurements`、`install upgrade rollback and data retention`、`observability fault recovery and known limitations`、`links live evidence hashes and rejects unmeasured advice`。
- [ ] **Step 2: Run RED.**

```bash
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-docs-red" \
  e2e run --config e2e.unit.config.ts tests/openshell/openshell-deployment-docs.test.ts
```

Expected: exit non-zero, 10 failed, 0 skipped, each failure names the absent doc/value/evidence link.
- [ ] **Step 3: Write docs, values, and chart CI without expanding claims.** `reference/openshell-deployment.md` 说明选型、安装/升级/回滚、最小权限、容量、监控、故障处置、数据保留、未验证边界和证据入口；`charts/openbot/ci/openshell-values.yaml` 只放可公开渲染默认值；`.github/workflows/ci.yml` 将 `openshell` 加入现有 chart matrix（若上游 T01 未已加入），保持每个 target 独立失败；两个通用文档仅增加准确链接，不重写整个部署体系。所有默认值必须逐项引用 T13/T14/Task 2 的实测哈希。
- [ ] **Step 4: Typecheck, test, lint, and render chart.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-docs-green" \
  e2e run --config e2e.unit.config.ts tests/openshell/openshell-deployment-docs.test.ts

bun run typecheck
bun run lint
helm dependency build charts/openbot
helm lint charts/openbot --values charts/openbot/ci/openshell-values.yaml
helm_args=()
while IFS= read -r version; do
  helm_args+=(--api-versions "$version")
done < <(jq -r '.helm.apiVersions[]' \
  ".archive/runs/$RUN_KEY/verification/T16/source-runtime-binding.json")
helm template t16 charts/openbot \
  --values charts/openbot/ci/openshell-values.yaml \
  --set-string secrets.keyEncryptionKey="$(openssl rand -base64 32)" \
  "${helm_args[@]}" \
  > ".archive/runs/$RUN_KEY/verification/T16/deployment-docs/rendered.yaml"
bun scripts/check-rendered-chart.ts \
  ".archive/runs/$RUN_KEY/verification/T16/deployment-docs/rendered.yaml"
```

Expected: e2e 10 executed/10 passed/0 failed/0 skipped; `typecheck`, `lint`, `helm dependency build`, `helm lint`, `helm template`, and rendered-chart checker all exit 0. Rendered workload/resource/RBAC values must equal the recorded live binding or documentation remains blocked.

### Task 5: Independent Terminal Acceptance, Review, OCR, and Required Checks

**Files:**
- Modify: only files already listed in Tasks 1–4 that review findings require, without expanding product scope.
- Archive: `.archive/runs/<run-key>/verification/T16/final/`, `reviews/`, `ocr/`, `checkpoints/`, `final-verdict.md`

**Interfaces:**
- Consumes: final source checkpoint, Tasks 1–4 reports, complete A01–A09 matrix, cleanup receipts, upstream evidence, independent reviewers, OCR output, and target SHA Checks/rulesets.
- Produces: immutable final verdict `pass` or `blocked/fail`; no partial pass language.

- [ ] **Step 1: Freeze and regenerate final evidence.** 在最终源树上重建 checkpoint/source-runtime binding，重新运行 `scripts/openshell-evidence-index.ts`，确认 A01–A09、#750 四项验收、上游报告、Review/OCR/CI、cleanup 和跨工作区清单全部绑定同一 SHA。源树、运行时或文档变化后必须重新生成并复审。
- [ ] **Step 2: Run the complete T16 suite.**

```sh
RUN_KEY="${OPENSHELL_RUN_KEY:?set a unique T16 run key}"
E2E_UNIT_OUTPUT="$PWD/.e2e/$RUN_KEY/t16-final" \
OPENSHELL_RUN_KEY="$RUN_KEY" \
OPENSHELL_LIVE=1 \
OPENBOT_LIVE_API=1 \
  e2e run --config e2e.unit.config.ts \
  tests/openshell/openshell-evidence-index.test.ts \
  tests/openshell/overall-acceptance.e2e.test.ts \
  tests/openshell/legacy-and-admin-regression.e2e.test.ts \
  tests/openshell/openshell-deployment-docs.test.ts
```

Expected for pass: exit 0, 42 executed/42 passed/0 failed/0 skipped. Counts must equal 8 + 12 + 12 + 10; any collection error, skip, blocked/untested case, or different count blocks final acceptance.
- [ ] **Step 3: Run standard repository gates.** 执行 `bun run typecheck`、`bun run lint`、`bun run test:ci` 和 Task 4 的 Helm lint/template/check-rendered sequence。期望全部 exit 0，并保存 stdout/stderr、实际 job/case counts、失败/跳过和报告路径；`test:ci` 的聚合成功不能替代逐项结果核对。
- [ ] **Step 4: Independent behavior, Spec, and quality review.** 由未实现 T16 的独立会话分三部分出具报告：行为复验收 Task 2/3 关键路径和清理；Spec Review 逐项核对 D1–D25、A01–A09、非目标和技术门槛 1–7；质量 Review 覆盖脚本、测试、文档、values、manifest 和证据完整性。报告中列出 reviewer 身份、输入 checkpoint、finding、复现、影响和结论；修复后受影响部分必须复审。
- [ ] **Step 5: Run applicable OCR.** 按 `.agents/rules/review.md` 先用 OCR preview 对账适用源码/脚本/测试范围，再执行完整适用 review/scan；保存工具配置、实际输入/处理/排除清单、checkpoint、报告、exit code、warnings、skipped/failed 和脱敏记录。工具或范围不可证明是阻塞，不得用独立 Review 或零 finding 冒充 OCR。
- [ ] **Step 6: Verify target SHA Checks and branch rules.** 对最终目标 SHA 只读调用 GitHub Checks、workflow runs、branch protection/rulesets API，逐个核对适用 job 的 `conclusion: success` 和 Required Checks 应用范围；记录查询时间、配置版本、check/run URL、head SHA、结论与 skipped/neutral 理由。pending/failure/cancelled/缺失、必要 job 被跳过、或目标没有 Required Checks 均为 blocked；计划时 `main` 未见保护/rulesets 不能在执行时当作通过。
- [ ] **Step 7: Render final verdict.** 汇总矩阵、42 条结果、Review/OCR finding、CI、版本绑定、旧模式回归、资源清理和跨工作区哈希清单。只有全部 A01–A09 `pass`、#750 四项验收满足、无有效 critical/high/medium、无未证实能力、无版本漂移、无未清理资源时，`final-verdict.md` 才能写 `pass`；否则明确列出每个 blocker 并保持 Issue/交付状态未通过。

## Independent Acceptance

### #750 acceptance mapping

| #750 criterion | Task/check | Evidence |
| --- | --- | --- |
| A01–A09 全部映射到最终代码和实测证据 | Task 1 exact matrix + Task 2 live journey + Task 5 independent review | `evidence-matrix.json/md`, `overall-acceptance-report.json`, `reviews/`, `final-verdict.md` |
| 失败/未测项保持未通过，不静默放宽要求 | Task 1 status/hash gate + Task 2–4 honest reports + Task 5 counts/CI/review | matrix statuses, 42-case report, `ci/`, `final-verdict.md` |
| 旧部署模式行为另作回归 | Task 3 actual shared/sandbox/shared-coding suites | `legacy-admin-regression-report.json`, `cleanup.json` |
| 所选版本、CNI、controller、存储和资源默认值有明确依据 | Task 4 docs/values/render + Task 1 runtime binding + Task 5 final SHA | `source-runtime-binding.json`, deployment guide, `rendered.yaml`, evidence hashes |

### A01–A09 owner mapping

| Acceptance | Primary owning checks |
| --- | --- |
| A01 部署与工作负载 | Task 4 deployment/default evidence；Task 2 case 1 and computer/coding journeys；upstream T01/T02/T03. |
| A02 隔离与归属 | Task 2 cases 1/2/3/6/8/12；Task 1 owner/hash matrix；upstream T01–T04, T10, T14. |
| A03 持久化与重置 | Task 2 case 9；Task 3 legacy data preservation；upstream T06/T07. |
| A04 预览和入口 | Task 2 cases 3/4；Task 1 authenticated-entry evidence；upstream T03/T04/T08. |
| A05 文件传递 | Task 2 case 5；upstream T12. |
| A06 网络授权与撤销 | Task 2 cases 7/8/12；Task 3 admin network state；upstream T09/T10/T11. |
| A07 审计与未知结果 | Task 2 case 11；Task 3 audit/pending state；upstream T05/T11/T12/T15. |
| A08 容量与资源 | Task 2 case 10；Task 4 measured defaults；Task 3 admin limits；upstream T13. |
| A09 失联约束 | Task 2 case 12；Task 3 loss/recovery state；upstream T14. |

### Blocked thresholds

T16 cannot pass while any condition holds: a real direct blocker remains open or unverified; any A01–A09 row is not `pass`; any required case/report/hash is missing, failed, skipped, blocked, or unrun; source/runtime/target SHA drift is unresolved; legacy regression is not actually exercised; default-value evidence is absent; cleanup or cross-workspace verification is incomplete; any effective medium-or-higher review/OCR finding remains; or target SHA Checks/Required Checks cannot be proven successful.

## Self-Review

- [x] **Spec coverage:** D1–D25 and every A01–A09 row maps to Task 1 plus the listed owning tasks; non-goals remain explicit and no acceptance is silently relaxed.
- [x] **Step scan:** All five required deliverables are separate tasks, every step has a checkable result and command/exit expectation where applicable, and no open placeholder remains.
- [x] **Type consistency:** Matrix/runtime/report paths and field names are consistent across Dependency Contract, Tasks 1–5, archive layout, and Independent Acceptance.
- [x] **Review Focus:** Each of the five named failure modes maps to explicit checks in Tasks 1–5 rather than a general review instruction.
- [x] **Proportion:** T16 references current upstream plans and consumes their interfaces/evidence; it does not reimplement T01–T15 product behavior or copy their implementation details.
