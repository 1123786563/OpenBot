# OpenBot Opik Issue #4 — 37-ticket execution plan

> **For agentic workers:** Execute via Orca Superpowers SDD. Coordinator owns intake, DAG, task briefs, integration, review adjudication, validation and ledger. Claude workers own implementation and repairs; separate Claude workers own read-only reviews.

**Goal:** Deliver parent Issue #4 A1–A13 by implementing and independently verifying every formally contained child Issue #7–#43, then complete real self-hosted acceptance, full branch review and OCR.

**Architecture:** Approved Spec and ADRs govern design. Preserve T03 deployment, T04 verified upstream contract, T05 safe projections, T06 trusted workbench scope and downstream ownership boundaries. `contains` is not a dependency. Parent #4 aggregates child acceptance and does not duplicate child implementation.

**Sources:** `docs/specs/2026-10-14-opik-integration-design.md`; `CONTEXT.md`; ADR 0001–0004; `docs/plans/evidence/2026-10-15-issue4/issue-tree.json`; `docs/plans/2026-10-15-opik-issue4-dag.json`; per-Issue acceptance and confirmed decisions; per-ticket plans linked below. This plan supersedes the old 13-task grouping as the completeness index; the older plan remains historical context.

## Global Constraints

- Dispatch only after all DAG dependencies have been independently reviewed and exact checkpoint hashes integrated into the worker base.
- Each implementation flow uses an Orca Claude worktree; each reviewer uses a different Orca Claude worktree and is read-only. Never use shared stash.
- Enforce Task-specific file ownership and interfaces. Do not widen ownership without an Orca ruling.
- Use TDD RED → GREEN → REFACTOR for behavior changes. Dedicated isolated test databases, ports, Opik projects and Compose volumes are required.
- Never use production Opik, real user data, raw attachment content, credentials or unredacted diagnostics.
- No commits, push, merge, publish or external Issue edits are authorized. Integrate reviewed uncommitted contents with explicit file hashes.
- `verified` requires task-specific validation, independent Spec and code-quality review, integrated hashes and no unresolved critical/high/medium findings. Real-service gates cannot be replaced by fixtures or skips.

## Review Focus

- Map every #4 A1–A13 and every child #7–#43; parent-only aggregate work belongs to #43 and must not duplicate child slices.
- Current OpenBot ownership authorizes access; Opik IDs and metadata never confer ownership; unknown enterprise scope rejects rather than falling back.
- Apply safe projection before every write/export, with explicit policy version, bounded content, correct deletion evidence and truthful status.
- Preserve idempotent persistence, scope isolation, lifecycle state, credit guards, query/export controls and UI privacy.
- Verify real Opik collection/query/evaluation/ID mapping/deletion, exact versions/digests, and complete independent review coverage.

## Task DAG execution order

Topological order (machine-validated): `T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T37`. Each block is a Superpowers Task and is briefed/dispatched only when ready. Issue bodies remain business acceptance records.

### Task 01 — T01 / Issue #7: [Opik T01] 观测后端模块骨架与路由注册 seam

- **Depends on:** none. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `verified`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t01-observability-module-seam.md`.
- **Owned files:** `server/src/ai-observability/context.ts`, `server/src/ai-observability/routes/index.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/tests/opik-module-skeleton.test.ts`
- **Consumes:** []
- **Produces:** 路由注册约定 + 观测请求上下文的注入方式.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
建立观测后端模块的目录约定与单一注册入口，使后续每个 Ticket 只新增自己的路由模块即可挂载，不再编辑应用主入口；统一注入认证用户、可信 scope 与 Bot 归属。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 后续每个观测 Ticket 只新增自己的路由模块即可挂载，应用主入口只保留一处注册。
- [ ] 请求上下文（已认证用户、可信 scope、Bot 归属）以统一方式注入；未认证或无归属的请求在进入业务逻辑前被拒绝。
- [ ] 观测模块未启用时注册不产生任何行为变化，现有接口与 tracing 保持原样。
- [ ] 目录与命名约定写入模块说明，接手的 agent 只读该约定即可新增路由，不依赖父会话上下文。

**Published handoff:**
Produces: 路由注册约定 + 观测请求上下文的注入方式.
Covers parent acceptance: A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 02 — T02 / Issue #8: [Opik T02] 观测 UI 独立 i18n 子命名空间与路由约定

- **Depends on:** none. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `verified`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t02-observability-ui-i18n-seam.md`.
- **Owned files:** `app/src/lib/i18n/ai-observability.test.ts`, `app/src/lib/i18n/i18next.d.ts`, `app/src/lib/i18n/index.ts`, `app/src/locales/en/ai-observability-*.json`, `app/src/locales/zh-CN/ai-observability-*.json`
- **Consumes:** []
- **Produces:** 四个子命名空间的 key 约定与归属矩阵（哪条前端链写哪个文件）+ 路由命名约定.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
为观测界面建立 runs / datasets / evaluations / admin 四个双子语命名空间与路由约定，使四条前端链（运行、评测集、实验、管理）各自独占文案文件，既不争用既有共享文案文件，也不彼此争用。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 观测界面文案按运行、评测集、实验、管理拆成四个双子语命名空间，四条前端链各自独占文案文件，既不需要编辑既有共享文案文件，也不会彼此冲突。
- [ ] disabled、empty、forbidden、basic、omitted、truncated、syncing、unavailable 八类状态在英文与中文均有明确文案且语义不混用。
- [ ] Bot 维度与管理维度路由约定确定并可被后续页面直接复用；直接输入路由时仍执行权限校验。
- [ ] 四个子命名空间的归属矩阵（哪条前端链写哪个文件）写入交接说明，接手 agent 不会写错文件。

**Published handoff:**
Produces: 四个子命名空间的 key 约定与归属矩阵（哪条前端链写哪个文件）+ 路由命名约定.
Covers parent acceptance: A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 03 — T03 / Issue #9: [Opik T03] Opik 可选部署与版本锁定清单

- **Depends on:** none. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `verified`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t03-opik-optional-deployment.md`.
- **Owned files:** `docker/compose/opik.yml`, `docker/opik/`, `docker-compose.yml`, `.env.example`, `docker/opik/versions.json`, `server/tests/opik-deployment.test.ts`, `reference/opik.md`
- **Consumes:** []
- **Produces:** 非浮动版本清单 + 启动/关闭/健康检查步骤.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
平台运维可用可选部署启动真实自托管 Opik，服务与 SDK 版本锁定为实际验证过的值；关闭集成时现有执行与 tracing 行为完全不变。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 可选部署能启动真实自托管实例；未部署或未启用时现有 Agent 执行与 tracing 行为完全不变。
- [ ] 服务镜像与 SDK 版本锁定为实际验证过的具体值（tag/digest），不使用浮动标签。
- [ ] 运维文档给出启动、关闭、健康检查与故障排查步骤，且不泄露凭据。
- [ ] 相关配置进入环境变量样例，缺省时集成保持关闭。

**Published handoff:**
Produces: 非浮动版本清单 + 启动/关闭/健康检查步骤.
Covers parent acceptance: A1.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 04 — T04 / Issue #10: [Opik T04] 上游契约冒烟与 VerifiedOpikContract manifest

- **Depends on:** T03. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `running`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t04-verified-contract.md`.
- **Owned files:** `server/scripts/opik-contract.ts`, `server/tests/opik-contract.test.ts`, `docs/plans/evidence/2026-10-15-issue4/opik-contract/`
- **Consumes:** ["T03"]
- **Produces:** VerifiedOpikContract manifest（版本、fixture、ID 映射、删除证据、正文上限）.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
对真实自托管实例验证 OTLP 写入、查询、项目、数据集、实验与删除契约，产出后续所有上游序列化唯一依据的 manifest。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 对真实实例逐项验证 OTLP 写入、查询、项目、数据集、实验与删除，全部 pass 后才产出 manifest。
- [ ] manifest 记录服务 tag/digest、SDK 精确版本、对应上游提交、实际请求响应 fixture、ID 映射、删除证据与支持的正文上限。
- [ ] canary 凭据、账号标识与原始附件不出现在任何实际写入或诊断输出中。
- [ ] 删除后记录在真实实例确实查不到；缺环境或跳过实测时不得报告验证成功。

**Published handoff:**
Produces: VerifiedOpikContract manifest（版本、fixture、ID 映射、删除证据、正文上限）.
Covers parent acceptance: A1, A11, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 05 — T05 / Issue #11: [Opik T05] 采集侧脱敏投影与安全内容策略

- **Depends on:** none. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `running`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t05-redaction-projection.md`.
- **Owned files:** `server/src/ai-observability/redaction.ts`, `shared/ai-observability.ts`, `server/tests/opik-redaction.test.ts`
- **Consumes:** []
- **Produces:** 安全投影接口 + 内容策略版本号.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
在任何写入或导出前对内容做语义白名单投影，排除凭据、内部能力、连接串、账号标识、reasoning 与原始附件；无法可靠处理的自由文本降级为仅指标。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件在任何写入或导出前被排除。
- [ ] 语义字段白名单驱动投影；无法可靠处理的自由文本降级为仅指标，而不是原样透传。
- [ ] 治理覆盖正文、metadata、异常、名称与 URL，不只覆盖输入输出两个字段。
- [ ] 内容策略带版本号并可被下游冻结引用；canary 测试证明无泄露。

**Published handoff:**
Produces: 安全投影接口 + 内容策略版本号.
Covers parent acceptance: A4.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 06 — T06 / Issue #12: [Opik T06] 可信 scope seam 与企业预留拒绝

- **Depends on:** none. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `verified`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t06-trusted-scope-seam.md`.
- **Owned files:** `server/src/ai-observability/contracts.ts`, `server/src/ai-observability/scope.ts`, `server/tests/opik-scope.test.ts`
- **Consumes:** []
- **Produces:** ObservationScope 解析接口 + 两个测试 scope 的构造方式.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
把授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器；未知企业 scope 拒绝且不回退，不提前固定租户模型。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 授权范围、存储定位与评测资格集中在可替换 seam，当前只实现工作台适配器。
- [ ] 两个测试 scope 使用相同资源 ID 时互相隔离，游标、缓存与任务不跨 scope。
- [ ] 未知企业 scope 被拒绝且不回退到工作台 scope。
- [ ] 不创建租户表、不伪造租户、不引入隐式租户头，不把 workspace/project 布局当作授权证明。

**Published handoff:**
Produces: ObservationScope 解析接口 + 两个测试 scope 的构造方式.
Covers parent acceptance: A5, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 07 — T07 / Issue #13: [Opik T07] 观测归属存储 schema 与可信绑定

- **Depends on:** T06. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `docs/plans/superpowers/2026-10-15-opik-t07-authoritative-bindings.md`.
- **Owned files:** `server/src/db/schema/ai-observation-bindings.ts`, `server/src/ai-observability/bindings.ts`, `server/tests/opik-bindings.test.ts`, `server/drizzle/`
- **Consumes:** ["T06"]
- **Produces:** 归属存储表结构 + 绑定/解析 API.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；绑定幂等且可在部分成功后恢复；Opik metadata 不能改变业务归属。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；Opik metadata 不能改变业务归属。
- [ ] 绑定建立幂等；远端成功但本地确认丢失时可恢复关联，不产生重复主体。
- [ ] scope 参与记录键与归属解析；归属缺失或伪造时拒绝。
- [ ] 使用专用 PostgreSQL 测试库验证唯一性、幂等与隔离；缺测试库不回退开发库、不记为通过。

**Published handoff:**
Produces: 归属存储表结构 + 绑定/解析 API.
Covers parent acceptance: A1, A5, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 08 — T08 / Issue #14: [Opik T08] Opik HTTP 适配器与 port 抽象

- **Depends on:** T04, T05, T07. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/opik-port.ts`, `server/src/ai-observability/opik-http.ts`, `server/tests/opik-port.test.ts`
- **Consumes:** ["T04", "T05", "T07"]
- **Produces:** OpikPort 接口 + 对抗性 fixture 注入方式.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
全部上游调用经单一 port 抽象，序列化只由契约 manifest 驱动；对抗性故障可注入且不伪装成功，上游异常不阻塞正常 Agent 结果。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 全部上游调用经单一 port 抽象；序列化只由契约 manifest 驱动，不各自发明请求格式。
- [ ] 超时、5xx、部分成功与归属漂移可注入；失败如实返回，不伪装成功或空列表。
- [ ] 上游慢响应或离线时调用有界，不阻塞正常 Agent 结果。
- [ ] 归属漂移等关键异常暂停后续写入并可告警，不静默继续。

**Published handoff:**
Produces: OpikPort 接口 + 对抗性 fixture 注入方式.
Covers parent acceptance: A1, A4, A10, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 09 — T09 / Issue #15: [Opik T09] 配置开关与健康状态（禁用零影响）

- **Depends on:** T08. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/config.ts`, `server/src/ai-observability/health.ts`, `server/src/ai-observability/routes/health.ts`, `server/tests/opik-health.test.ts`
- **Consumes:** ["T08"]
- **Produces:** 就绪/健康查询接口 + 有界异步写入入口约定.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
集成关闭时现有执行与 tracing 完全不变；启用但故障时给出可解释状态；Opik 慢响应、离线或队列饱和不改变正常 Agent 结果。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 集成关闭时现有执行与 tracing 行为完全成立；启用但故障时给出可解释状态而非静默降级。
- [ ] 就绪条件统一：关闭、未配置、认证失败或缺必需能力时明确不可用，不启用任何观测写入。
- [ ] Opik 慢响应、离线或队列饱和不改变正常 Agent 执行结果；丢弃与延迟可被观察。
- [ ] 健康状态不含凭据或敏感响应内容。

**Published handoff:**
Produces: 就绪/健康查询接口 + 有界异步写入入口约定.
Covers parent acceptance: A1, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 10 — T10 / Issue #16: [Opik T10] run 终结语义与 basic 远程路径能力标记

- **Depends on:** T09. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/run-lifecycle.ts`, `server/src/ai-observability/routes/basic-run.ts`, `server/tests/opik-run-lifecycle.test.ts`
- **Consumes:** ["T09"]
- **Produces:** run/attempt 终结状态机 + capability（detailed/basic/unavailable）判定入口.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
run 记录在实际完成、失败、取消或明确未知状态时终结，HTTP 首帧不结束 run；内置与经过 OpenBot 的远程 AG-UI 执行都建立可信归属，远程路径只记录实际观察到的事件并标记 basic。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] HTTP 首帧不结束 run；run 记录在实际完成、失败、取消或明确未知状态时终结。
- [ ] 成功、错误、重试、确认取消、断连与未知结局正确区分，每个 attempt 唯一终结。
- [ ] 工具提议不冒充执行。
- [ ] 内置与经过 OpenBot 的远程 AG-UI 执行都建立可信 Bot/thread/run/attempt 关联。
- [ ] 远程路径只记录实际观察到的事件并明确标记 basic，不声称不可见的内部调用不存在。

**Published handoff:**
Produces: run/attempt 终结状态机 + capability（detailed/basic/unavailable）判定入口.
Covers parent acceptance: A2, A3, A5, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 11 — T11 / Issue #17: [Opik T11] 创建者只读查询接口

- **Depends on:** T07, T10, T01. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/reader.ts`, `server/src/ai-observability/routes/runs.ts`, `server/tests/opik-read-auth.test.ts`
- **Consumes:** ["T07", "T10", "T01"]
- **Produces:** 只读查询 REST 契约（请求/响应/错误语义/游标）.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者按当前管理权查询自己 Bot 的运行列表与安全详情；伪造归属、猜测 ID 与跨 scope 游标不能扩大访问；移交或撤权后历史、分页与缓存立即不可读。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 仅当前有管理权的创建者与范围内管理员可查询；public 聊天权、伪造归属、猜测 ID 与跨 scope 游标不能扩大访问。
- [ ] 列表与详情返回实际状态、耗时、安全内容与版本引用；provider usage 缺失时返回明确 unavailable。
- [ ] 移交或撤权后历史详情、分页与缓存立即不可读。
- [ ] 不暴露任意上游查询代理；两个测试 scope 的相同资源 ID 互相隔离。
- [ ] 上游不可用时返回可解释错误，不伪装为空列表。

**Published handoff:**
Produces: 只读查询 REST 契约（请求/响应/错误语义/游标）.
Covers parent acceptance: A2, A5, A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 12 — T12 / Issue #18: [Opik T12] 创建者运行列表页

- **Depends on:** T02, T11. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/routes/bot/$botId/observability/runs.tsx`, `app/src/components/ai-observability/run-list.tsx`, `app/src/components/ai-observability/run-list.test.tsx`
- **Consumes:** ["T02", "T11"]
- **Produces:** 列表组件与查询 hook 契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者在自己的 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记，覆盖各类可用性与故障状态。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 创建者在 Bot 页面筛选并查看运行列表，看到真实状态、耗时与能力标记。
- [ ] 覆盖空、禁用、无权限、同步中与上游不可用状态；文案双语且语义不混用。
- [ ] 键盘与窄屏可完成筛选并进入详情；直接输入路由仍执行权限校验。
- [ ] 恶意正文只作为文本渲染，不产生可执行内容。
- [ ] 前端共享类型位置确定，后端契约变化时只需改一处类型定义（该职责由 T02 移入本 Ticket）。

**Published handoff:**
Produces: 列表组件与查询 hook 契约.
Covers parent acceptance: A2, A5, A6, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 13 — T13 / Issue #19: [Opik T13] 创建者运行详情页与可用性状态

- **Depends on:** T12. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/routes/bot/$botId/observability/runs/$runId.tsx`, `app/src/components/ai-observability/run-detail.tsx`, `app/src/components/ai-observability/run-detail.test.tsx`
- **Consumes:** ["T12"]
- **Produces:** 详情页组件契约（步骤树在后续 Ticket 扩展同一组件）.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者查看单次运行的安全详情：实际状态与耗时、脱敏内容、版本引用、provider usage 或明确的 unavailable；basic 与 unavailable 明确标注。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 展示单次运行的实际状态与耗时、脱敏内容、版本引用，以及 provider usage 或明确 unavailable。
- [ ] basic 与 unavailable 明确标注，不显示不可观察的内部步骤。
- [ ] 撤权、移交与跨 scope 访问在页面与接口两侧都被拒绝。
- [ ] Opik 故障时页面如实展示同步/缺失/故障状态，不影响用户已获得的正常回答。

**Published handoff:**
Produces: 详情页组件契约（步骤树在后续 Ticket 扩展同一组件）.
Covers parent acceptance: A2, A3, A4, A5, A6.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 14 — T14 / Issue #20: [Opik T14] 内置执行的模型调用记录

- **Depends on:** T05, T10. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/runtime/builtin-model.ts`, `server/tests/opik-builtin-model.test.ts`
- **Consumes:** ["T05", "T10"]
- **Produces:** 模型 span 记录接口 + usage 缺失语义.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
内置路径的模型调用带实际 provider usage 或明确 unavailable；不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 内置路径的模型调用带实际 provider usage；缺失时明确 unavailable，不当 0。
- [ ] 不重复调用 provider、不改变已有 metered finish 与 Settlement 顺序、不重复计算 usage。
- [ ] 拒绝或结算失败不记录为成功 span。
- [ ] 模型 span 的输入输出经脱敏投影；canary 不出现在真实实例。

**Published handoff:**
Produces: 模型 span 记录接口 + usage 缺失语义.
Covers parent acceptance: A2, A3, A4, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 15 — T15 / Issue #21: [Opik T15] 工具提议 vs 真实执行与检索步骤

- **Depends on:** T14. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/runtime/tool-retrieval.ts`, `server/tests/opik-tool-retrieval.test.ts`
- **Consumes:** ["T14"]
- **Produces:** 步骤类型枚举 + 提议/执行/回执缺失判定.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
工具提议、真实 execute 与缺少回执三者分开记录与展示；未知浏览器执行不显示成功；检索步骤与片段可定位且无秘密 canary。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 工具提议、真实 execute 与缺少回执三者分开记录与展示。
- [ ] 未知浏览器执行不显示成功。
- [ ] 检索步骤与片段可定位；输入输出、错误与日志无秘密 canary。
- [ ] 步骤类型判定不依赖框架内部实现细节。

**Published handoff:**
Produces: 步骤类型枚举 + 提议/执行/回执缺失判定.
Covers parent acceptance: A2, A3, A4.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 16 — T16 / Issue #22: [Opik T16] LangGraph callback 接入同一受治理 OTel 路径

- **Depends on:** T14. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `agent-langgraph/src/opik-callbacks.ts`, `agent-langgraph/tests/opik-callbacks.test.ts`
- **Consumes:** ["T14"]
- **Produces:** LangGraph 侧 tracing 接入方式与版本约束.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传；模型、工具与检索父子关系正确后才标记 detailed。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 默认 LangGraph 路径的框架 callback 进入同一受治理 OTel 路径，不另开未处理的自动上传。
- [ ] 模型、工具与检索父子关系在真实实例验证正确后才标记 detailed。
- [ ] 输入输出、错误与日志无秘密 canary。
- [ ] 其他远程路径保持 basic 与原协议，不因该接入被改变。
- [ ] agent runtime 模块自身测试通过，不依赖服务端未完成能力。

**Published handoff:**
Produces: LangGraph 侧 tracing 接入方式与版本约束.
Covers parent acceptance: A2, A4, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 17 — T17 / Issue #23: [Opik T17] 跨服务与动态进程上下文传播与 ID 映射

- **Depends on:** T16. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/runtime/propagation.ts`, `agent-langgraph/src/opik-propagation.ts`, `server/tests/opik-id-mapping.test.ts`
- **Consumes:** ["T16"]
- **Produces:** 传播环境变量约定 + ID 映射位置.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
宿主、容器与支持动态创建的进程真实传播 W3C 上下文；OTel 与 Opik 标识使用显式映射而不假定相等。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 宿主、容器与支持动态创建的进程真实传播 W3C 上下文。
- [ ] OTel 与 Opik 标识使用显式映射，不假定相等。
- [ ] 跨服务父子关系在真实实例可验证。
- [ ] loopback 地址与凭据不混淆、不泄露。

**Published handoff:**
Produces: 传播环境变量约定 + ID 映射位置.
Covers parent acceptance: A2, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 18 — T18 / Issue #24: [Opik T18] 运行详情页步骤树

- **Depends on:** T13, T15, T17. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/components/ai-observability/step-tree.tsx`, `app/src/components/ai-observability/step-tree.test.tsx`
- **Consumes:** ["T13", "T15", "T17"]
- **Produces:** 步骤树组件与只读步骤查询契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作并关联跨服务过程；basic 路径不显示不存在的内部步骤。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 创建者在既有详情页展开可信步骤树，定位具体模型、工具与检索操作。
- [ ] 跨服务过程可关联；ID 映射不暴露内部实现。
- [ ] basic 路径不显示不存在的内部步骤；能力标记与列表一致。
- [ ] 键盘、窄屏与双语成立；恶意内容只作文本渲染。

**Published handoff:**
Produces: 步骤树组件与只读步骤查询契约.
Covers parent acceptance: A2, A3, A5.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 19 — T19 / Issue #25: [Opik T19] 数据集 schema 与不可变版本冻结

- **Depends on:** T07, T11. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/db/schema/ai-evaluation-datasets.ts`, `server/src/ai-observability/evaluation/datasets.ts`, `server/tests/opik-datasets.test.ts`, `server/drizzle/`
- **Consumes:** ["T07", "T11"]
- **Produces:** 数据集版本读取 API + 冻结字段清单.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位；候选与后续修改不改变已保存版本；部分成功可恢复或清理。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 版本冻结安全输入、参考结果、工具 fixture、hash、策略版本、来源与上游定位。
- [ ] 候选与后续修改不改变已保存版本。
- [ ] 上游与本地引用部分成功可恢复或清理；pending/syncing 不冒充成功。
- [ ] scope 参与版本键与读取；使用专用 PostgreSQL 验证隔离与幂等。
- [ ] 真实实例证明独立快照与固定 hash。

**Published handoff:**
Produces: 数据集版本读取 API + 冻结字段清单.
Covers parent acceptance: A4, A7, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 20 — T20 / Issue #26: [Opik T20] 案例审查与保存接口

- **Depends on:** T05, T19. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/case-review.ts`, `server/src/ai-observability/routes/cases.ts`, `server/tests/opik-case-review.test.ts`
- **Consumes:** ["T05", "T19"]
- **Produces:** 案例审查/保存 REST 契约 + 脱敏语义限制说明.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
候选只来自有权访问的安全运行；仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例；拒绝原始附件与任意生产工具。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 候选只来自有权访问的安全运行；越权或猜测 ID 不能成为候选。
- [ ] 仅指标的记录不能被自动伪造为文本样本，必须提供审查后的合成或脱敏案例。
- [ ] 拒绝原始附件与任意生产工具进入数据集。
- [ ] 跨 Bot 复用需要显式授权复制，不隐式共享。
- [ ] 已保存案例采用评测保留引用；未保存候选随源追踪生命周期。

**Published handoff:**
Produces: 案例审查/保存 REST 契约 + 脱敏语义限制说明.
Covers parent acceptance: A4, A5, A6.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 21 — T21 / Issue #27: [Opik T21] 数据集页面（审查 / 保存 / 版本）

- **Depends on:** T02, T20. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/components/ai-observability/dataset-pages/`, `app/src/routes/bot/$botId/observability/datasets/`
- **Consumes:** ["T02", "T20"]
- **Produces:** 数据集页面组件与查询 hook 契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者在页面检查候选输入、参考结果与工具 fixture，看到脱敏语义提示后保存，并查看冻结版本历史。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 创建者在页面检查候选输入、参考结果与工具 fixture，并看到脱敏语义限制提示后保存。
- [ ] 可查看冻结版本历史；已保存版本不因后续编辑变化。
- [ ] 覆盖空、故障、同步中与审查提示状态；双语、键盘与窄屏可用。
- [ ] 越权访问与直接路由输入被拒绝。

**Published handoff:**
Produces: 数据集页面组件与查询 hook 契约.
Covers parent acceptance: A4, A5, A7.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 22 — T22 / Issue #28: [Opik T22] 实验 schema 与冻结配置幂等提交

- **Depends on:** T19. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/db/schema/ai-evaluation-experiments.ts`, `server/src/ai-observability/evaluation/submit.ts`, `server/tests/opik-experiment-submit.test.ts`, `server/drizzle/`
- **Consumes:** ["T19"]
- **Produces:** 实验记录结构 + 幂等键约定.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本；幂等重试不产生第二个实验。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 提交时冻结数据集版本、Bot 配置、Prompt、模型参数、fixture 与评分器版本。
- [ ] 幂等重试不产生第二个实验。
- [ ] scope 参与实验键；猜测 ID 或撤权不能读取。
- [ ] 配置版本引用可追溯到具体冻结来源。

**Published handoff:**
Produces: 实验记录结构 + 幂等键约定.
Covers parent acceptance: A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 23 — T23 / Issue #29: [Opik T23] 隔离执行与生产写工具拒绝

- **Depends on:** T10, T14, T22. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/isolated-executor.ts`, `server/tests/opik-isolated-executor.test.ts`
- **Consumes:** ["T10", "T14", "T22"]
- **Produces:** 隔离执行入口 + 工具白名单/拒绝策略.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据；未知生产写工具被拒绝。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 隔离 thread 与测试工具复用公共执行路径，不写生产会话、memory、learning 或业务数据。
- [ ] 未知生产写工具被拒绝，而不是静默跳过。
- [ ] 被测执行保持公共行为语义；评测不改变生产执行路径。
- [ ] 执行失败与外部未知结局如实记录。

**Published handoff:**
Produces: 隔离执行入口 + 工具白名单/拒绝策略.
Covers parent acceptance: A8, A10.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 24 — T24 / Issue #30: [Opik T24] 持久任务编排：有界并发、每样本重授权、取消与 lease

- **Depends on:** T23. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/jobs.ts`, `server/tests/opik-evaluation-jobs.test.ts`
- **Consumes:** ["T23"]
- **Produces:** 任务状态机 + 取消/lease 语义.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
复用现有持久任务能力实现有界并发评测；每个样本执行前重新授权；取消停止新调度；结果未知或 lease 恢复不自动重复调用或扣费。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 持久任务有界并发；进程重启或 lease 恢复后继续而不重复执行已完成样本。
- [ ] 每个样本执行前重新授权；撤权后停止读取与消费。
- [ ] 取消停止新调度；结果未知或 lease 丢失不自动重复调用或扣费。
- [ ] 双 worker 并发认领测试成立；任务状态可解释。

**Published handoff:**
Produces: 任务状态机 + 取消/lease 语义.
Covers parent acceptance: A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 25 — T25 / Issue #31: [Opik T25] 评测调用的计费准入与结算接线

- **Depends on:** T24. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/billing.ts`, `server/tests/opik-evaluation-billing.test.ts`
- **Consumes:** ["T24"]
- **Produces:** 评测侧计费准入接口 + 预算不足时的调用前拒绝语义.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则；缺失 usage 不当 0；计费台账保持权威。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 被测调用遵守适用 Credit Gate、Admission、Reservation 与 Settlement 规则。
- [ ] 缺失 usage 不当 0；计费台账保持权威，观测侧成本只作分析用途。
- [ ] 预算不足或准入失败在调用前拒绝，不产生供应商调用。
- [ ] 结算幂等，重放不重扣。

**Published handoff:**
Produces: 评测侧计费准入接口 + 预算不足时的调用前拒绝语义.
Covers parent acceptance: A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 26 — T26 / Issue #32: [Opik T26] 规则评分器

- **Depends on:** T22. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/rule-scorers.ts`, `server/tests/opik-rule-scorers.test.ts`
- **Consumes:** ["T22"]
- **Produces:** Scorer 接口 + 规则版本化约定.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
确定性检查输出格式、必需字段与工具名称/参数；结果与规则版本可追溯到安全运行；不依赖模型 Judge 即可完整运行。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 确定性检查输出格式、必需字段与工具名称/参数。
- [ ] 结果与规则版本可追溯到具体安全运行。
- [ ] 缺失评分不伪造为 0；评分失败与执行失败分开。
- [ ] 不依赖模型 Judge 即可完整运行。

**Published handoff:**
Produces: Scorer 接口 + 规则版本化约定.
Covers parent acceptance: A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 27 — T27 / Issue #33: [Opik T27] 受控模型 Judge 评分

- **Depends on:** T25, T26. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/model-judge.ts`, `server/tests/opik-model-judge.test.ts`
- **Consumes:** ["T25", "T26"]
- **Produces:** Judge 准入清单 + 理由安全投影.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；Judge 遵守预算与访问范围；只有已审查安全样本送给 Judge，理由经安全投影。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 仅允许显式批准的模型入口、凭证与 rubric/scorer 版本；不接受任意 provider 地址，不自动使用 Opik 默认模型。
- [ ] Judge 遵守适用 Credit Gate、Admission、Reservation/Settlement；预算不足或不受控时调用前拒绝，规则评测仍可用。
- [ ] 只有已审查的安全样本、参考与 context 送给 Judge；SDK 自动追踪与理由经安全投影，canary 不进入上游或页面。
- [ ] 逐样本显示分数、理由、版本、usage 与评分失败；Judge 故障不混入成功平均分。
- [ ] 撤权、取消与外部未知结果沿用任务规则，不增加自动重跑或跨范围读取。
- [ ] 受控假 provider 与真实实验验证门控、调用次数与账本；SDK 返回 score 不能代替预算证据。

**Published handoff:**
Produces: Judge 准入清单 + 理由安全投影.
Covers parent acceptance: A4, A7, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 28 — T28 / Issue #34: [Opik T28] 实验结果查询接口与失败分类

- **Depends on:** T26. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/results.ts`, `server/src/ai-observability/routes/results.ts`, `server/tests/opik-results.test.ts`
- **Consumes:** ["T26"]
- **Produces:** 结果查询 REST 契约 + 失败分类枚举.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
逐样本返回分数、理由、版本、usage 与结果链接；执行失败、评分失败、取消、待协调与同步故障分别展示，平均分不掩盖缺失或失败样本。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 逐样本返回分数、理由、版本、usage 与结果链接。
- [ ] 执行失败、评分失败、取消、待协调与同步故障分别展示；平均分不掩盖缺失或失败样本。
- [ ] 实验与结果读取遵守 scope/Bot 授权；猜测 ID 或撤权不能跨范围读取。
- [ ] 结果可回链到安全执行记录。

**Published handoff:**
Produces: 结果查询 REST 契约 + 失败分类枚举.
Covers parent acceptance: A5, A7, A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 29 — T29 / Issue #35: [Opik T29] 实验对比接口与兼容性判定

- **Depends on:** T28. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/evaluation/compare.ts`, `server/src/ai-observability/routes/compare.ts`, `server/tests/opik-compare.test.ts`
- **Consumes:** ["T28"]
- **Produces:** 对比 REST 契约 + 兼容性判定规则.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
仅对冻结样本集、hash 与评分定义兼容的实验给出结论；输出有效样本数、逐项 delta、退化案例与回链运行，不兼容时解释差异而不宣称赢家。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 仅对冻结样本集、hash 与评分定义兼容的实验给出结论；不兼容时解释差异而不宣称质量赢家。
- [ ] 输出完成率、有效评分数、执行/评分失败、逐项 delta、耗时与实际 usage；缺失值不当 0 或静默剔除。
- [ ] 退化样本链接到安全案例与执行记录；unknown/basic/metrics-only 保持明确，不捏造解释。
- [ ] 两次实验都通过当前 scope/Bot 授权；规则实验即可完成对比，不依赖模型 Judge。

**Published handoff:**
Produces: 对比 REST 契约 + 兼容性判定规则.
Covers parent acceptance: A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 30 — T30 / Issue #36: [Opik T30] 实验页面（提交 / 逐样本结果 / 取消）

- **Depends on:** T21, T28. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/components/ai-observability/experiment-pages/`, `app/src/routes/bot/$botId/observability/experiments/`
- **Consumes:** ["T21", "T28"]
- **Produces:** 实验页面组件契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者在双语可访问页面提交实验、查看逐样本分数与理由、区分失败类型并取消；结果可回链到运行详情。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 创建者在双语可访问页面提交实验、查看逐样本分数与理由并取消。
- [ ] 失败类型分别展示；Judge 故障不混入成功平均分。
- [ ] 键盘、窄屏与直接路由越权校验成立。
- [ ] 结果可回链到运行详情。

**Published handoff:**
Produces: 实验页面组件契约.
Covers parent acceptance: A5, A7, A8.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 31 — T31 / Issue #37: [Opik T31] 实验对比页面

- **Depends on:** T29, T30. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/components/ai-observability/comparison-page.tsx`, `app/src/components/ai-observability/comparison-page.test.tsx`
- **Consumes:** ["T29", "T30"]
- **Produces:** 对比页面组件契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
创建者比较两次实验的配置差异、有效样本与退化案例，并从退化案例回到相关安全执行详情；不兼容时不显示误导性赢家结论。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 展示两次实验的配置差异、有效样本数、逐项 delta 与退化案例。
- [ ] 从退化案例回到相关安全执行详情。
- [ ] 不兼容时明确解释，不显示误导性赢家结论。
- [ ] 双语、键盘与窄屏成立；机器可读安全结果可用。

**Published handoff:**
Produces: 对比页面组件契约.
Covers parent acceptance: A9.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 32 — T32 / Issue #38: [Opik T32] 采集入口认证与控制台/私有 API 保护

- **Depends on:** T09. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/control-plane-auth.ts`, `server/tests/opik-control-plane-auth.test.ts`
- **Consumes:** ["T09"]
- **Produces:** 控制面访问规则 + 内部生产者凭据发放方式.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
采集入口要求内部生产者认证；整个 Opik 控制面（含私有 API）受保护，不能绕过应用角色检查；复用现有身份系统而非第二套用户库。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 采集入口要求内部生产者认证；未认证写入被拒绝。
- [ ] 整个 Opik 控制面（含私有 API）受保护，私有 API 不能绕过应用角色检查。
- [ ] 使用现有身份系统或平台私有访问，不建立第二套 Opik 用户库。
- [ ] 普通用户不能读取连接配置、管理诊断或凭据；整实例控制台仅限相应平台资格。

**Published handoff:**
Produces: 控制面访问规则 + 内部生产者凭据发放方式.
Covers parent acceptance: A4, A5, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 33 — T33 / Issue #39: [Opik T33] 管理员范围汇总与采集故障排查

- **Depends on:** T11, T32. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/admin-summary.ts`, `server/src/ai-observability/routes/admin.ts`, `server/tests/opik-admin-summary.test.ts`
- **Consumes:** ["T11", "T32"]
- **Produces:** 管理汇总 REST 契约 + 故障分类枚举.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
管理员按授权范围汇总 Bot 运行与评测，筛选故障、丢弃、延迟与未绑定记录，并区分业务失败、采集不可用与尚未具备的能力。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 先限定授权 scope 再汇总运行、实验与状态；相同 ID 或受限管理角色不能跨范围。
- [ ] 按 Bot 与时间筛选，显示 pending、失败、丢弃、最近采集与未绑定状态。
- [ ] 缺失 usage 或 basic 内部缺失不算 0 或健康；区分业务失败、采集不可用与能力未具备。
- [ ] Opik 故障保留真实同步/缺失状态且正常 Agent 继续执行；汇总不进入运行关键路径。
- [ ] 无需先完成模型 Judge 或对比 Ticket 即可验证。

**Published handoff:**
Produces: 管理汇总 REST 契约 + 故障分类枚举.
Covers parent acceptance: A5, A6, A10, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 34 — T34 / Issue #40: [Opik T34] 有界异步导出与下载即时撤权

- **Depends on:** T05, T11. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/exports.ts`, `server/src/ai-observability/routes/exports.ts`, `server/tests/opik-exports.test.ts`
- **Consumes:** ["T05", "T11"]
- **Produces:** 导出任务与下载鉴权契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
有权用户请求运行/实验的机器可读导出并查看状态；导出有界异步且不改变正常 Agent 结果；每次下载重新校验当前权限，撤权后旧链接立即失效。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 导出仅使用授权安全 DTO，不含原文附件、凭证、未处理正文、可执行 HTML 或私有原文 URL。
- [ ] 任务、文件与分页引用绑定 scope/Bot；客户端不能指定上游项目或用 export ID 跨范围读取。
- [ ] 页面区分 queued、running、ready、failed、revoked；仅 ready 且当前有权才可下载。
- [ ] 移交或撤权后旧链接立即失效；下载经受控接口，不产生绕过授权的长期公开链接。
- [ ] 导出有界异步，不改变正常 Agent 结果；无法建立可信绑定时不导出该 run 的业务内容。

**Published handoff:**
Produces: 导出任务与下载鉴权契约.
Covers parent acceptance: A4, A6, A10, A11.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 35 — T35 / Issue #41: [Opik T35] 保留期与真实删除验证

- **Depends on:** T19, T22, T34. **Implementation role:** `backend_implementer`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `server/src/ai-observability/retention.ts`, `server/src/ai-observability/deletion.ts`, `server/tests/opik-deletion.test.ts`
- **Consumes:** ["T19", "T22", "T34"]
- **Produces:** 清理状态机 + 删除证据格式.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
默认 7 天 trace、30 天数据集/实验且可运维调整；先撤销可见性再按可信定位清理上游与导出；仅验证实际查不到后才报告完成。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 默认 trace 7 天、数据集与实验 30 天，可运维调整；到期先撤销可见性、停止受影响任务、失效缓存与下载。
- [ ] 按可信定位清理上游 trace/span、样本、实验与导出文件；隐藏条目不等于删除。
- [ ] 上游失败保留定位与 pending/failed 以重试；仅验证实际查不到后才报告完成。
- [ ] 清理不跨项目或范围影响其他 Bot；未知归属需受控处理，不猜测。
- [ ] 删除 Bot、数据集或范围后账务与审计不被级联删除。
- [ ] 实际存储、文件与备份保留策略有证据和操作说明；真实实例证明清理效果与故障恢复。

**Published handoff:**
Produces: 清理状态机 + 删除证据格式.
Covers parent acceptance: A6, A11, A12.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 36 — T36 / Issue #42: [Opik T36] 管理员汇总页面与创建者导出状态页

- **Depends on:** T13, T33, T34. **Implementation role:** `frontend_implementer`. **Validator:** `frontend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `app/src/components/ai-observability/admin-page.tsx`, `app/src/components/ai-observability/export-status.tsx`
- **Consumes:** ["T13", "T33", "T34"]
- **Produces:** 管理页面组件契约 + 导出状态组件契约.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
管理员在后台查看范围内汇总、健康与故障排查；创建者查看导出状态与下载；权限变化即时反映在页面上。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 管理员在后台查看范围内汇总、健康与故障排查；受限管理角色看不到范围外数据。
- [ ] 创建者查看导出状态与下载；权限变化即时反映。
- [ ] 双语、键盘与窄屏成立；直接路由越权被拒绝。
- [ ] 故障、同步中与未启用状态明确区分。

**Published handoff:**
Produces: 管理页面组件契约 + 导出状态组件契约.
Covers parent acceptance: A5, A6, A10, A11.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

### Task 37 — T37 / Issue #43: [Opik T37] 端到端验收与真实实例证据闭环

- **Depends on:** T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T26. **Implementation role:** `coordinator+validators`. **Validator:** `backend_validator`. **Current status:** `pending`. **Plan/spec:** `Issue snapshot + approved parent plan`.
- **Owned files:** `docs/plans/evidence/2026-10-15-issue4/acceptance/`, `docs/plans/evidence/2026-10-15-issue4/reviews/`
- **Consumes:** ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20", "T21", "T22", "T23", "T24", "T25", "T27", "T28", "T29", "T30", "T31", "T32", "T33", "T34", "T35", "T36", "T26"]
- **Produces:** 验收证据索引.
- **Verification:** Issue acceptance plus targeted test, typecheck, lint; #43 requires real self-hosted Opik and full gates
- **Steps:** verify predecessor review/hash transfer and record initial state; add failing acceptance tests and demonstrate RED; implement only this ticket slice; refactor without behavior change; run targeted tests plus relevant typecheck/lint/format/build and real DB/service gate; create hash-bound checkpoint; obtain separate Spec and code-quality review; repair findings in a Claude worktree, re-review, transfer and validate integration.
- **Failure handling:** preserve exact errors and evidence; never skip required real gates, fabricate a handoff, broaden ownership or release dependents.

**What to build (Issue text):**
对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除的全范围验收，汇总 13 条验收标准的证据，并完成独立 review 与全范围 OCR 闭环。

This slice inherits the parent Spec's safety, authorization, tenancy-reservation, billing, and real-verification constraints and does not expand its non-goals.

**Issue acceptance:**
- [ ] 对真实自托管 Opik 跑通采集、查询、评测、ID 映射与删除，逐项形成证据。
- [ ] 父 Spec 的 A1–A13 每条都有可核验证据或明确缺口说明；跳过与缺环境不记为通过。
- [ ] 完成独立 Spec 合规与代码质量 review，并跑全范围 OCR，无有效 critical/high/medium findings。
- [ ] 适用测试、类型检查、Lint 与前端构建全部通过；受影响的 agent runtime 模块测试通过。
- [ ] 交付实际变更范围、接口契约、迁移与回退说明、验证命令与结果、检查点哈希。

**Published handoff:**
Produces: 验收证据索引.
Covers parent acceptance: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13.
A resuming agent needs only: the parent Spec items listed above, the Handoff of each blocking ticket, and this ticket's acceptance criteria.

## Shared-file / interface preflight

- Migration journals, snapshots and migrations are serialized; assign one active owner and recalculate the current index at dispatch.
- T03/T04 share one isolated Opik instance at a time; never overlap integration probes or mutate another Task’s synthetic resources.
- T05 handoff uses actual named projection functions and policy version; no downstream task may infer an umbrella API name.
- T06 scope/cursor rules are the trusted source for binding identity; project/workspace metadata cannot authorize access.
- Before each dispatch, compare file ownership and runtime resources; concurrent work requires stable interfaces and disjoint writes/state.

## Ledger and completion

Record every Run/Task/Dispatch, effective agent/model/effort, worker_done/escalation/ruling, checkpoint/hash, exact verification and review report in `.archive/runs/legacy-plans/ledgers/2026-10-15-opik-issue4-ledger.md` and update the DAG. Completion requires all 37 children and A1–A13 verified, full-range independent Claude Spec/security/quality review, full OCR pass over committed and uncommitted delivery content, and final diff/finishing-branch review. Do not push, merge or publish.
