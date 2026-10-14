# Opik vertical ticket breakdown — v2 (fine-grained)

Status: APPROVED by the user 2026-10-15 and PUBLISHED to GitHub. Child issues #7–#43 are native sub-issues of the parent Spec with native blocked-by edges. Verified by `publication-verification-v2.json` (PASS, 0 problems).
Supersedes: `ticket-breakdown.md` (v1, 10 coarse tickets) — kept for history, not deleted.

Parent Spec: https://github.com/1123786563/OpenBot/issues/4

## Why v2

用户要求：每个 Ticket 必须能在**单个 code agent 上下文**内完成；某个 agent 执行报错时，另一个 agent 能在很短时间内接手。

因此 v2 的切分规则：

1. **单一 owner role**：一个 Ticket 只碰一种语言/一层（Go/TS backend、frontend、infra、agent runtime 不混在一个 Ticket 里）。
2. **小 blast radius**：每个 Ticket 的 owned files ≤ 8，绝大多数 ≤ 6。
3. **显式交接物（Handoff）**：每个 Ticket 产出一个具名接口或证据文件，接手的 agent 只需读「父 Spec 的对应 A 条目 + 前置 Ticket 的 Handoff + 本 Ticket 的 owned files」，不需要读整个 v1 计划或父会话。
4. **无共享文件争用**：先做两个 prefactor（T01 backend 路由 seam、T02 frontend i18n 命名空间），使后续 Ticket 不会同时编辑同一个巨型文件。争用点在下文 Contention map 里显式列出并串行化。
5. **独立可验证**：每个 Ticket 有自己的 RED/GREEN 命令，不依赖后续 Ticket 才能证明。

前置的 13-Task 文件级计划（`2026-10-14-opik-integration-plan.md` / `-dag.json`）是草案，不作为 Ticket 边界；v2 已把 T05/T07/T09/T11/T12 这些 14–19 文件的大任务重新切开。

## Contention map（必须串行的共享文件）

| 共享文件 | 触碰顺序 | 处置 |
| --- | --- | --- |
| `server/src/index.ts` | T01 建立 `registerAiObservabilityRoutes()` 单行注册 | T11 依赖 T01，因此 T01 是所有路由类 Ticket 的祖先；之后只有 T24 加 worker 启动行（T24 亦为 T01 后代） |
| `server/src/copilot.ts` | T10 → T14 | 串行，不并行派发 |
| `server/src/ai-observability/routes/*` | T01 建骨架；每个后续 Ticket 只加自己的文件 | 无争用 |
| `app/src/locales/*` | T02 建四个子命名空间 `-runs` / `-datasets` / `-evaluations` / `-admin` | 运行链（T12→T13→T18）写 `-runs`；T21 写 `-datasets`；T30→T31 写 `-evaluations`；T36 写 `-admin`。四条链文件不相交，可并行；均不碰 `agents.json`/`errors.json` |
| `app/src/routeTree.gen.ts` | 生成物 | 每个前端 Ticket 各自重新生成；冲突时以生成为准 |
| `server/drizzle/*` | T07 → T19 → T22 各自独立 migration 编号 | 串行，不并行派发 |
| `server/src/ai-observability/opik-http.ts` | T08 建；T19/T22/T34/T35 只加自己的 endpoint 函数 | 通过 T04 的 contract manifest 驱动，避免重复发明序列化 |

## Tickets

编号即发布顺序（blockers first）。`A#` 指父 Spec 的验收表条目。

### Phase 0 — Prefactor 与地基（T01–T09）

**T01 观测后端模块骨架与路由注册 seam**
- Blocked by: None
- Delivers: 建立 `server/src/ai-observability/` 目录约定与单一 `registerAiObservabilityRoutes()`，使后续每个 Ticket 只新增自己的 route module 文件，不再编辑 `server/src/index.ts`。
- Owned: `server/src/ai-observability/routes/index.ts`、`server/src/ai-observability/context.ts`、`server/src/index.ts`、`server/tests/opik-module-skeleton.test.ts`
- Handoff: 路由注册约定 + 请求上下文（认证用户、scope、bot 归属）注入方式
- Covers: A5（骨架层）
- Size: ~4 files / 单 agent

**T02 观测 UI 独立 i18n 子命名空间与路由约定**
- Blocked by: None
- Delivers: 新增 `ai-observability-runs` / `-datasets` / `-evaluations` / `-admin` 四个双子语命名空间与 `bots.$agentId.runs` / `.evaluations` 路由约定，使四条前端链（运行、评测集、实验、管理）各自独占文案文件，既不争用 `agents.json`、`errors.json`，也不彼此争用。
- Owned: `app/src/locales/en/ai-observability-runs.json`、`app/src/locales/en/ai-observability-datasets.json`、`app/src/locales/en/ai-observability-evaluations.json`、`app/src/locales/en/ai-observability-admin.json`、`app/src/locales/zh-CN/ai-observability-runs.json`、`app/src/locales/zh-CN/ai-observability-datasets.json`、`app/src/locales/zh-CN/ai-observability-evaluations.json`、`app/src/locales/zh-CN/ai-observability-admin.json`、`app/src/lib/i18n/index.ts`、`app/src/lib/i18n/i18next.d.ts`
- Handoff: 四个子命名空间的 key 约定与归属矩阵（哪条前端链写哪个文件）+ 路由命名约定
- Covers: A5、状态文案（disabled/empty/forbidden/basic/omitted/truncated/syncing/unavailable）
- Size: ~10 files / 单 agent（均为极小 JSON stub 与注册行，见 manifest 的 documented_deviations）

**T03 Opik 可选部署与版本锁定清单**
- Blocked by: None
- Delivers: 平台运维可用可选 compose 启动真实自托管 Opik，服务与 SDK 版本被锁定为实际验证过的值；关闭集成时现有执行与 tracing 行为不变。
- Owned: `docker/compose/opik.yml`、`docker/opik/versions.json`、`docs/opik.md`、`.env.example`
- Handoff: `versions.json`（非浮动版本清单）+ 启动/关闭步骤
- Covers: A1
- Size: ~4 files / 单 agent

**T04 上游契约冒烟与 VerifiedOpikContract manifest**
- Blocked by: T03
- Delivers: 对真实实例跑通 OTLP 写入、查询、项目、数据集、实验与删除，产出后续所有 HTTP 序列化唯一依据的 manifest；缺环境或跳过实测不得报告成功。
- Owned: `server/scripts/opik-contract.ts`、`server/tests/opik-contract.test.ts`、`server/package.json`、`bun.lock`
- Handoff: `VerifiedOpikContract` manifest（tag/digest、SDK 精确版本、请求响应 fixture、ID 映射、删除证据、正文上限）
- Covers: A1、A11、A13
- Size: ~4 files / 单 agent

**T05 采集侧脱敏投影与安全内容策略**
- Blocked by: None
- Delivers: 任何写入或导出前的语义字段白名单投影；凭据、内部能力、连接串、账号标识、reasoning、原始附件被排除；无法可靠处理的自由文本降级为仅指标。
- Owned: `server/src/ai-observability/redaction.ts`、`shared/ai-observability.ts`、`server/tests/opik-redaction.test.ts`
- Handoff: `projectSafe()` 接口 + 内容策略版本号
- Covers: A4
- Size: ~3 files / 单 agent

**T06 可信 scope seam 与企业预留拒绝**
- Blocked by: None
- Delivers: 授权范围、存储定位与评测资格集中在可替换 seam；当前只实现工作台适配器；未知企业 scope 拒绝且不回退，不创建租户表、不把 workspace 当授权。
- Owned: `server/src/ai-observability/scope.ts`、`server/src/ai-observability/contracts.ts`、`server/tests/opik-scope.test.ts`
- Handoff: `ObservationScope` 解析接口 + 两个测试 scope 的构造方式
- Covers: A12、A5
- Size: ~3 files / 单 agent

**T07 观测归属存储 schema 与可信绑定**
- Blocked by: T06
- Delivers: OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；绑定可幂等恢复；Opik metadata 不能改变业务归属。
- Owned: `server/drizzle/00NN_opik_observability.sql` + snapshot/journal、`server/src/db/schema/ai-observability.ts`、`server/src/ai-observability/bindings.ts`、`server/tests/opik-bindings.integration.test.ts`、`server/scripts/opik-test-env.ts`
- Handoff: 表结构 + `bindings.ts` 的绑定/解析 API（专用 PostgreSQL 验证）
- Covers: A1、A5、A11、A12
- Size: ~6 files / 单 agent

**T08 Opik HTTP 适配器与 port 抽象**
- Blocked by: T04、T05、T07
- Delivers: 全部上游调用经单一 port；序列化只由 T04 manifest 驱动；对抗性故障（超时、5xx、部分成功、归属漂移）可注入且不伪装成功。
- Owned: `server/src/ai-observability/opik-port.ts`、`server/src/ai-observability/opik-http.ts`、`server/tests/support/opik-fixtures.ts`、`server/tests/opik-http.test.ts`
- Handoff: `OpikPort` 接口 + fixture 注入方式
- Covers: A1、A4、A10、A13
- Size: ~4 files / 单 agent

**T09 配置开关与健康状态（禁用零影响）**
- Blocked by: T08
- Delivers: 集成关闭时现有执行与 tracing 完全不变；启用但故障时给出可解释状态；Opik 慢响应、离线或队列饱和不改变正常 Agent 结果。
- Owned: `server/src/ai-observability/config.ts`、`server/src/ai-observability/health.ts`、`server/src/config.ts`、`shared/ai-trace.ts`、`server/tests/opik-health.test.ts`
- Handoff: 就绪/健康查询接口 + 有界异步导出入口约定
- Covers: A1、A10
- Size: ~5 files / 单 agent

### Phase 1 — 安全运行记录（T10–T13）

**T10 run 终结语义与 basic 远程路径能力标记**
- Blocked by: T09
- Delivers: HTTP 首帧不结束 run；成功、错误、重试、确认取消、断连与未知结局正确区分，每个 attempt 唯一终结；工具提议不冒充执行；经过 OpenBot 的远程 AG-UI 只记录实际观察到的事件并明确标记 basic。
- Owned: `server/src/ai-observability/run-agent.ts`、`server/src/agents/endpoint.ts`、`server/src/agents/agent-resolver.ts`、`server/src/agents/runtime-agents.ts`、`server/src/copilot.ts`、`server/tests/opik-run-agent.test.ts`
- Handoff: run/attempt 终结状态机 + capability（detailed/basic/unavailable）判定入口
- Covers: A2、A3、A5、A10
- Size: ~6 files / 单 agent（`copilot.ts` 争用点，与 T14 串行）

**T11 创建者只读查询接口**
- Blocked by: T01、T07、T10
- Delivers: 创建者按当前管理权查询自己 Bot 的运行列表与安全详情；public 聊天权、伪造归属、猜测 ID、跨 scope 游标不能扩大访问；移交或撤权后历史、分页与缓存立即不可读。
- Owned: `server/src/ai-observability/reader.ts`、`server/src/ai-observability/routes/reader-routes.ts`、`server/tests/opik-reader.test.ts`、`server/tests/opik-routes.test.ts`
- Handoff: 只读查询 REST 契约（请求/响应/错误语义/游标）
- Covers: A2、A5、A6、A10、A12
- Size: ~4 files / 单 agent

**T12 运行列表页**
- Blocked by: T02、T11
- Delivers: 创建者在 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记；覆盖空、禁用、无权限、同步中与上游不可用状态；键盘与窄屏可用。
- Owned: `app/src/routes/_authed/_app/bots.$agentId.runs.tsx`、`app/src/components/ai-observability/run-list.tsx`、`app/src/components/ai-observability/availability.tsx`、`app/src/lib/ai-observability/types.ts`、`app/src/lib/ai-observability/queries.ts`、`app/src/components/ai-observability/run-views.test.tsx`、`app/src/locales/en/ai-observability-runs.json`、`app/src/locales/zh-CN/ai-observability-runs.json`
- Handoff: 列表组件与查询 hook 契约
- Covers: A2、A5、A6、A10
- Size: ~5 files / 单 agent

**T13 运行详情页与可用性状态**
- Blocked by: T12
- Delivers: 创建者查看单次运行的安全详情：实际状态与耗时、脱敏内容、版本引用、provider usage 或明确的 unavailable；恶意正文只作为文本渲染。
- Owned: `app/src/routes/_authed/_app/bots.$agentId.runs.$bindingId.tsx`、`app/src/components/ai-observability/run-detail.tsx`、`app/src/components/bot-profile/manage.tsx`、`app/src/locales/en/ai-observability-runs.json`、`app/src/locales/zh-CN/ai-observability-runs.json`、`app/src/components/ai-observability/run-views.test.tsx`
- Handoff: 详情页组件契约（步骤树在 T18 扩展同一组件）
- Covers: A2、A3、A4、A5、A6
- Size: ~5 files / 单 agent

### Phase 2 — 详细运行步骤（T14–T18）

**T14 内置执行的模型调用记录**
- Blocked by: T05、T10
- Delivers: 内置路径的模型调用带实际 usage 或明确 unavailable；不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage；拒绝或结算失败不是成功 span。
- Owned: `server/src/ai-observability/model.ts`、`server/src/copilot.ts`、`server/tests/opik-model.test.ts`
- Handoff: 模型 span 记录接口 + usage 缺失语义
- Covers: A2、A3、A4、A8
- Size: ~3 files / 单 agent（`copilot.ts` 争用点，在 T10 之后）

**T15 工具提议 vs 真实执行与检索步骤**
- Blocked by: T14
- Delivers: 工具提议、真实 execute 与缺少回执三者分开；未知浏览器执行不显示成功；检索步骤与片段可定位且无秘密 canary。
- Owned: `server/src/ai-observability/retrieval.ts`、`server/src/ai-observability/steps.ts`、`server/src/knowledge/middleware.ts`、`server/tests/opik-step.test.ts`
- Handoff: 步骤类型枚举与「提议/执行/回执缺失」判定
- Covers: A2、A3、A4
- Size: ~4 files / 单 agent

**T16 LangGraph callback 接入同一受治理 OTel 路径**
- Blocked by: T14
- Delivers: 默认 LangGraph 路径的框架 callback 进入同一受治理路径，不另开未处理的自动上传；输入输出、错误与日志无 canary。
- Owned: `agent-langgraph/src/index.ts`、`agent-langgraph/package.json`、`agent-langgraph/bun.lock`、`agent-langgraph/tests/opik-tracing.test.ts`、`server/src/ai-observability/langgraph.ts`
- Handoff: LangGraph 侧 tracing 接入方式与版本约束
- Covers: A2、A4、A13
- Size: ~5 files / 单 agent（独立 Go/TS 模块边界内，可与 T15 并行）

**T17 跨服务与动态进程上下文传播与 ID 映射**
- Blocked by: T16
- Delivers: 宿主、容器与支持动态创建的进程真实传播 W3C 上下文；OTel 与 Opik 标识使用显式映射而不假定相等；父子关系在真实实例可验证。
- Owned: `supervisor/src/environment.ts`、`supervisor/tests/environment.test.ts`、`shared/ai-trace.ts`、`server/tests/opik-propagation.test.ts`
- Handoff: 传播环境变量约定 + ID 映射表位置
- Covers: A2、A13
- Size: ~4 files / 单 agent

**T18 详情页步骤树**
- Blocked by: T13、T15、T17
- Delivers: 创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作，并关联跨服务过程；basic 路径不显示不存在的内部步骤。
- Owned: `app/src/components/ai-observability/step-tree.tsx`、`app/src/components/ai-observability/run-detail.tsx`、`app/src/lib/ai-observability/steps.ts`、`app/src/locales/en/ai-observability-runs.json`、`app/src/locales/zh-CN/ai-observability-runs.json`、`app/src/components/ai-observability/run-views.test.tsx`
- Handoff: 步骤树组件与只读步骤查询契约
- Covers: A2、A3、A5
- Size: ~5 files / 单 agent

### Phase 3 — 版本化评测集（T19–T21）

**T19 数据集 schema 与不可变版本冻结**
- Blocked by: T07、T11
- Delivers: 版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位；候选与后续修改不改变已保存版本；上游与本地引用部分成功可恢复或清理，pending/syncing 不冒充成功。
- Owned: `server/drizzle/00NN_opik_datasets.sql` + snapshot/journal、`server/src/db/schema/ai-observability.ts`、`server/src/ai-observability/evaluation/contracts.ts`、`server/src/ai-observability/evaluation/datasets.ts`、`server/tests/opik-datasets.test.ts`、`server/tests/opik-datasets.integration.test.ts`
- Handoff: 数据集版本读取 API + 冻结字段清单
- Covers: A4、A7、A11、A12
- Size: ~6 files / 单 agent

**T20 案例审查与保存接口**
- Blocked by: T05、T19
- Delivers: 候选只来自有权访问的安全运行；仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例；拒绝原始附件与任意生产工具；跨 Bot 复用需显式授权复制。
- Owned: `server/src/ai-observability/evaluation/cases.ts`、`server/src/ai-observability/routes/dataset-routes.ts`、`server/tests/opik-dataset-cases.test.ts`
- Handoff: 案例审查/保存 REST 契约 + 脱敏语义限制说明
- Covers: A4、A5、A6
- Size: ~3 files / 单 agent

**T21 数据集页面（审查 / 保存 / 版本）**
- Blocked by: T02、T20
- Delivers: 创建者在页面检查候选输入、参考结果与工具 fixture，看到脱敏语义提示后保存，并查看冻结版本历史；覆盖空、故障、同步中与审查提示。
- Owned: `app/src/components/ai-observability/dataset-editor.tsx`、`app/src/routes/_authed/_app/bots.$agentId.evaluations.tsx`、`app/src/lib/ai-observability/evaluations.ts`、`app/src/locales/en/ai-observability-datasets.json`、`app/src/locales/zh-CN/ai-observability-datasets.json`、`app/src/components/ai-observability/evaluation-views.test.tsx`
- Handoff: 数据集页面组件与查询 hook 契约
- Covers: A4、A5、A7
- Size: ~5 files / 单 agent

### Phase 4 — 隔离评测、评分与对比（T22–T31）

**T22 实验 schema 与冻结配置幂等提交**
- Blocked by: T19
- Delivers: 提交冻结数据集、Bot 配置、Prompt、模型参数、fixture 与评分器版本；幂等重试不产生第二个实验。
- Owned: `server/drizzle/00NN_opik_evaluations.sql` + snapshot/journal、`server/src/ai-observability/evaluation/contracts.ts`、`server/src/ai-observability/evaluation/experiments.ts`、`server/tests/opik-experiments.test.ts`
- Handoff: 实验记录结构 + 幂等键约定
- Covers: A7、A9
- Size: ~4 files / 单 agent

**T23 隔离执行与生产写工具拒绝**
- Blocked by: T10、T14、T22
- Delivers: 隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据；未知生产写工具被拒绝。
- Owned: `server/src/ai-observability/evaluation/execution.ts`、`server/src/copilot.ts`、`server/tests/opik-evaluation-execution.test.ts`
- Handoff: 隔离执行入口 + 工具白名单/拒绝策略
- Covers: A8、A10
- Size: ~3 files / 单 agent（`copilot.ts` 争用点，在 T14 之后）

**T24 持久任务编排：有界并发、每样本重授权、取消与 lease**
- Blocked by: T23
- Delivers: 复用现有 WorkQueue 的有界并发持久任务；每个样本执行前重新授权；取消停止新调度；结果未知或 lease 恢复不自动重复调用或扣费。
- Owned: `server/src/ai-observability/evaluation/jobs.ts`、`server/src/ai-observability/evaluation/worker.ts`、`server/src/index.ts`、`server/tests/opik-evaluation-jobs.test.ts`
- Handoff: 任务状态机 + 取消/lease 语义
- Covers: A6、A10、A12
- Size: ~4 files / 单 agent

**T25 评测调用的计费准入与结算接线**
- Blocked by: T24
- Delivers: 被测调用遵守适用 Credit Gate、Admission、Reservation/Settlement；缺失 usage 不当 0；计费台账保持权威。
- Owned: `server/src/ai-observability/evaluation/billing.ts`、`server/tests/opik-evaluation-billing.test.ts`
- Handoff: 评测侧计费准入接口 + 预算不足时的调用前拒绝语义
- Covers: A8
- Size: ~2 files / 单 agent

**T26 规则评分器**
- Blocked by: T22
- Delivers: 确定性检查输出格式、必需字段与工具名称/参数；结果与规则版本可追溯到安全运行；缺失评分不伪造为 0。
- Owned: `server/src/ai-observability/evaluation/scorers.ts`、`server/tests/opik-scorers-rules.test.ts`
- Handoff: `Scorer` 接口 + 规则版本化约定
- Covers: A7、A9
- Size: ~2 files / 单 agent

**T27 受控模型 Judge 评分**
- Blocked by: T25、T26
- Delivers: 仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；不接受任意 provider 地址，不自动使用 Opik 默认模型；预算不足或不受控时调用前拒绝而规则评测仍可用；只有已审查安全样本送给 Judge，理由经安全投影。
- Owned: `server/src/ai-observability/evaluation/judge.ts`、`server/tests/opik-scorers-judge.test.ts`
- Handoff: Judge 准入清单 + 理由安全投影
- Covers: A4、A7、A8
- Size: ~2 files / 单 agent

**T28 实验结果查询接口与失败分类**
- Blocked by: T26
- Delivers: 逐样本分数、理由、版本、usage 与结果查询；执行失败、评分失败、取消、待协调与同步故障分别展示，平均分不掩盖缺失或失败样本。
- Owned: `server/src/ai-observability/evaluation/results.ts`、`server/src/ai-observability/routes/evaluation-routes.ts`、`server/tests/opik-evaluation-results.test.ts`
- Handoff: 结果查询 REST 契约 + 失败分类枚举
- Covers: A5、A7、A9
- Size: ~3 files / 单 agent

**T29 实验对比接口与兼容性判定**
- Blocked by: T28
- Delivers: 仅对冻结样本集与评分定义兼容的实验给出结论，否则明确解释不兼容；输出有效样本数、逐案例分数、耗时、实际 usage、退化案例与回链安全运行。
- Owned: `server/src/ai-observability/evaluation/comparison.ts`、`server/tests/opik-comparison.test.ts`
- Handoff: 对比 REST 契约 + 兼容性判定规则
- Covers: A9
- Size: ~2 files / 单 agent

**T30 实验页面（提交 / 逐样本结果 / 取消）**
- Blocked by: T21、T28
- Delivers: 创建者在双语可访问页面提交实验、查看逐样本分数与理由、区分失败类型并取消；Judge 故障不混入成功平均分。
- Owned: `app/src/components/ai-observability/experiment-list.tsx`、`app/src/components/ai-observability/experiment-detail.tsx`、`app/src/lib/ai-observability/evaluations.ts`、`app/src/locales/en/ai-observability-evaluations.json`、`app/src/locales/zh-CN/ai-observability-evaluations.json`、`app/src/components/ai-observability/evaluation-views.test.tsx`
- Handoff: 实验页面组件契约
- Covers: A5、A7、A8
- Size: ~5 files / 单 agent

**T31 对比页面**
- Blocked by: T29、T30
- Delivers: 创建者比较两次实验的配置差异、有效样本与退化案例，并从退化案例回到相关安全执行详情；不兼容时不声称质量赢家。
- Owned: `app/src/components/ai-observability/experiment-comparison.tsx`、`app/src/locales/en/ai-observability-evaluations.json`、`app/src/locales/zh-CN/ai-observability-evaluations.json`、`app/src/components/ai-observability/evaluation-views.test.tsx`
- Handoff: 对比页面组件契约
- Covers: A9
- Size: ~3 files / 单 agent

### Phase 5 — 运维、导出与生命周期（T32–T37）

**T32 采集入口认证与控制台/私有 API 保护**
- Blocked by: T09
- Delivers: 采集入口要求内部生产者认证；整个 Opik 控制面（含私有 API）受保护，私有 API 不能绕过应用角色检查；使用现有身份系统而非第二套 Opik 用户库；普通用户不能读取连接配置、管理诊断或凭据。
- Owned: `server/src/ai-observability/console-auth.ts`、`docker/compose/opik.yml`、`docker/opik/collector.yaml`、`server/tests/opik-console-auth.test.ts`
- Handoff: 控制面访问规则 + 内部生产者凭据发放方式
- Covers: A4、A5、A13
- Size: ~4 files / 单 agent

**T33 管理员范围汇总与采集故障排查**
- Blocked by: T11、T32
- Delivers: 管理员按授权范围汇总 Bot 运行与评测；筛选故障、丢弃、延迟与未绑定记录；区分业务失败、采集不可用与尚未具备的能力；控制台访问遵守管理员范围。
- Owned: `server/src/ai-observability/admin-routes.ts`、`server/src/ai-observability/admin-summary.ts`、`server/tests/opik-admin-routes.test.ts`
- Handoff: 管理汇总 REST 契约 + 故障分类枚举
- Covers: A5、A6、A10、A12
- Size: ~3 files / 单 agent

**T34 有界异步导出与下载即时撤权**
- Blocked by: T05、T11
- Delivers: 有权用户请求运行/实验的机器可读导出并查看状态；导出不能改变正常 Agent 结果；无法建立可信绑定时不导出该 run 的业务内容；每次下载重新校验当前权限，移交或撤权后旧链接立即失效。
- Owned: `server/src/ai-observability/exports.ts`、`server/src/ai-observability/routes/export-routes.ts`、`server/tests/opik-exports.test.ts`
- Handoff: 导出任务与下载鉴权契约
- Covers: A4、A6、A10、A11
- Size: ~3 files / 单 agent

**T35 保留期与真实删除验证**
- Blocked by: T19、T22、T34
- Delivers: 默认 7 天 trace、30 天数据集/实验且可运维调整；到期先撤销可见性、停止受影响任务、失效缓存与下载，再按可信定位清理上游与导出；上游失败保留定位与 pending/failed，仅验证实际查不到后才报告完成；不跨项目或范围影响其他 Bot。
- Owned: `server/src/ai-observability/lifecycle.ts`、`server/tests/opik-lifecycle.test.ts`、`server/tests/opik-lifecycle.integration.test.ts`、`docs/opik.md`
- Handoff: 清理状态机 + 删除证据格式
- Covers: A6、A11、A12
- Size: ~4 files / 单 agent

**T36 管理员汇总页面与创建者导出状态页**
- Blocked by: T13、T33、T34
- Delivers: 管理员在后台查看范围内汇总、健康与故障排查；创建者查看导出状态与下载；权限变化即时反映在页面上。
- Owned: `app/src/routes/_authed/admin/ai-observability.tsx`、`app/src/components/ai-observability/admin-overview.tsx`、`app/src/components/ai-observability/export-status.tsx`、`app/src/lib/ai-observability/admin.ts`、`app/src/components/admin/admin-sidebar.tsx`、`app/src/components/ai-observability/admin-views.test.tsx`、`app/src/locales/en/ai-observability-admin.json`、`app/src/locales/zh-CN/ai-observability-admin.json`
- Handoff: 管理页面组件契约
- Covers: A5、A6、A10、A11
- Size: ~7 files / 单 agent

**T37 端到端验收与真实实例证据闭环**
- Blocked by: T01–T36（全部）
- Delivers: 对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除的全范围验收，汇总 13 条 A 条目的证据；完成独立 Spec/代码质量 review 与全范围 OCR，无有效 critical/high/medium findings。
- Owned: `server/scripts/opik-acceptance.ts`、`tests/e2e/opik-observability.e2e.ts`、`docs/plans/evidence/2026-10-14-opik/final/`
- Handoff: 验收证据索引
- Covers: A1–A13
- Size: ~3 files / 单 agent（协调性质，不含新功能）

## Coverage

- 13 条验收标准 A1–A13 全部被至少一个 Ticket 覆盖；A4/A5/A6/A12 由多个 Ticket 分层覆盖。
- 38 条 user story 继承父 Spec，未新增或缩减范围；企业租户保持预留（T06），不是任何工作台 Ticket 的阻塞条件。
- 依赖图无环（发布顺序即拓扑序）。
- 并行机会：T01/T02/T03/T05/T06 可同时开始；T15 与 T16 可并行；T26 与 T23/T24/T25 可并行；T32/T33 与 Phase 4 可并行。
- 必须串行：`copilot.ts`（T10→T14→T23）、drizzle migration（T07→T19→T22）。

## Not tickets

- Bifrost 设计（父 Spec 的 Out of Scope）不作为任何 Ticket 的阻塞条件。
- 父 Spec #4 的正文与状态不修改。
- v1 的 10 个粗粒度 Ticket 与 13-Task 文件级计划保留为历史草案，不逐一发布。


## Published issue map

Parent Spec: #4 (body and status unmodified; sha256 verified after publication).

| Ticket | Issue | Title | Blocked by (native) |
| --- | --- | --- | --- |
| T01 | #7 | 观测后端模块骨架与路由注册 seam | — |
| T02 | #8 | 观测 UI 独立 i18n 命名空间与路由约定 | — |
| T03 | #9 | Opik 可选部署与版本锁定清单 | — |
| T04 | #10 | 上游契约冒烟与 VerifiedOpikContract manifest | #9 |
| T05 | #11 | 采集侧脱敏投影与安全内容策略 | — |
| T06 | #12 | 可信 scope seam 与企业预留拒绝 | — |
| T07 | #13 | 观测归属存储 schema 与可信绑定 | #12 |
| T08 | #14 | Opik HTTP 适配器与 port 抽象 | #10, #11, #13 |
| T09 | #15 | 配置开关与健康状态（禁用零影响） | #14 |
| T10 | #16 | run 终结语义与 basic 远程路径能力标记 | #15 |
| T11 | #17 | 创建者只读查询接口 | #13, #16 |
| T12 | #18 | 创建者运行列表页 | #8, #17 |
| T13 | #19 | 创建者运行详情页与可用性状态 | #18 |
| T14 | #20 | 内置执行的模型调用记录 | #11, #16 |
| T15 | #21 | 工具提议 vs 真实执行与检索步骤 | #20 |
| T16 | #22 | LangGraph callback 接入同一受治理 OTel 路径 | #20 |
| T17 | #23 | 跨服务与动态进程上下文传播与 ID 映射 | #22 |
| T18 | #24 | 运行详情页步骤树 | #19, #21, #23 |
| T19 | #25 | 数据集 schema 与不可变版本冻结 | #13, #17 |
| T20 | #26 | 案例审查与保存接口 | #11, #25 |
| T21 | #27 | 数据集页面（审查 / 保存 / 版本） | #8, #26 |
| T22 | #28 | 实验 schema 与冻结配置幂等提交 | #25 |
| T23 | #29 | 隔离执行与生产写工具拒绝 | #16, #20, #28 |
| T24 | #30 | 持久任务编排：有界并发、每样本重授权、取消与 lease | #29 |
| T25 | #31 | 评测调用的计费准入与结算接线 | #30 |
| T26 | #32 | 规则评分器 | #28 |
| T27 | #33 | 受控模型 Judge 评分 | #31, #32 |
| T28 | #34 | 实验结果查询接口与失败分类 | #32 |
| T29 | #35 | 实验对比接口与兼容性判定 | #34 |
| T30 | #36 | 实验页面（提交 / 逐样本结果 / 取消） | #27, #34 |
| T31 | #37 | 实验对比页面 | #35, #36 |
| T32 | #38 | 采集入口认证与控制台/私有 API 保护 | #15 |
| T33 | #39 | 管理员范围汇总与采集故障排查 | #17, #38 |
| T34 | #40 | 有界异步导出与下载即时撤权 | #11, #17 |
| T35 | #41 | 保留期与真实删除验证 | #25, #28, #40 |
| T36 | #42 | 管理员汇总页面与创建者导出状态页 | #19, #39, #40 |
| T37 | #43 | 端到端验收与真实实例证据闭环 | #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #28, #29, #30, #31, #32, #33, #34, #35, #36, #37, #38, #39, #40, #41, #42 |
