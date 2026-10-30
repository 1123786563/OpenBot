# T15 中断任务的未知外部结果不自动重放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository authorization and review rules govern actual dispatch and authorization.

**Goal:** OpenShell 沙箱停止、崩溃、Pod 重建或控制服务重启后，结果未知的外部副作用保持待核对，不重复提交、不冒充成功；只有明确证明幂等的效果可安全恢复，用户可以查看并处置待核对项。

**Architecture:** 复用 T05 的 `openshell_operation_records` 作为唯一操作状态权威，为其增加 `external.effect` 操作类型和面向外部效果的窄协调器。computer 把会到达外部站点的动作纳入该合同：`intentOf` 判定为 `navigate | activate | run_command` 的动作、可能触发页面脚本提交的 `type`，以及私有登录提交；本地读文件、列文件和写工作区文件不当作外部效果。coding run 作为整次外部效果记录，因为任务内部可能发起不可识别的外部提交。恢复扫描只做状态收敛和已声明幂等效果的重试，绝不重放普通浏览器提交或代码任务。

**Tech Stack:** TypeScript、Bun、PostgreSQL、Drizzle、Hono、TanStack Query、tester-army e2e、本地 HTTP 替身。

**Spec:** [OpenShell Spec A07](../../specs/2026-10-30-openshell-sandbox.md#验收映射)、[D14–D15 与状态未知语义](../../specs/2026-10-30-openshell-sandbox.md#已批准决定)、[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)、[ticket breakdown T15](ticket-breakdown.md#t15--中断任务的未知外部结果不自动重放)。GitHub Issue [#749](https://github.com/1123786563/OpenBot/issues/749) 为 open 且 `ready-for-agent`；真实 Blocked by [#740](https://github.com/1123786563/OpenBot/issues/740) 与 [#741](https://github.com/1123786563/OpenBot/issues/741)，二者本轮只读核实均为 open。`ready-for-agent` 与 Issue 关系不是实施授权。

## Global Constraints

- T05、T06、T07 必须先在同一个受测树验证：#740/#741 未验证前 #749 保持 blocked；T05 的实际 ledger、scope、stop/start/reset 符号与本计划不一致时，先停下核对并修订计划，不得猜接口。
- 复用 T05 的 durable intent/outcome 与 `unknown | pending_reconciliation` 待对账合同；`openshell_operation_records` 仍是唯一操作状态权威，不建第二张 pending 表或第二套 audit 权威。
- 状态未知不是成功，也不是可重试许可。沙箱停止、崩溃、Pod 重建或控制服务重启后的外部副作用进入待核对；恢复扫描不得重新调用普通副作用 executor。
- 只有 `ExternalEffectIdempotencyDeclaration` 精确匹配 `effectType`、payload fingerprint 与已注册 executor 时才可自动重试；客户端 body、模型输出或宽泛的 action 名称不能证明幂等。
- 用户必须能按 Bot 看到待核对项，并通过外部证据或人工处置落终态；处置后后续动作才可继续。跨用户、跨团队、跨 Bot 的待核对项不可见或统一不可探测。
- 进程重启、Pod 重建、控制服务重启分别有测试证据；本地 HTTP 替身只模拟“外部已接收但回执丢失”，不得调用真实第三方支付、表单、邮件或消息服务。操作 ledger 必须使用真实隔离 PostgreSQL，持久化不得 mock。
- T15 只在 OpenShell 装配中启用外部效果协调器；`shared`、`docker`、既有 `sandbox` 模式的 computer/coding 行为、既有事件和现有 API 成功形状保持不变。
- 执行 ADR 0008 的 e2e 入口、输出目录、实际收集数与 skip 解释；完整档执行独立行为验收、Spec/质量 Review 和适用 OCR，并将命令、报告、源码检查点与结论归档到 `.archive/runs/<run-key>/`。

## Review Focus

1. 回执丢失后客户端或恢复器重复提交造成二次支付/表单/邮件：Task 1 `duplicate key returns the existing operation without a second executor` 与 Task 3 `lost receipt across control-service restart does not resubmit` 钉住。
2. 未知被当成失败并自动重试：Task 1 `undeclared effect is never auto-retried` 与 Task 2 `transport loss leaves an activation pending rather than failed` 钉住。
3. 未知被冒充成功：Task 2 `streaming timeout stores pending reconciliation instead of completed` 与 `activation stop returns no success and keeps the operation pending` 钉住。
4. 幂等标记被误套到非幂等动作：Task 1 declaration/payload mismatch 测试与 Task 3 `an unregistered idempotency claim remains pending and conflicts` 钉住。
5. 待核对没有用户入口而永久悬挂：Task 4 owner list、manual/evidence resolution、foreign-access 与 UI invalidation 测试钉住；Task 3 证明处置后下一效果能继续。

## File map and dependency contract

**Server persistence and reconciliation**

- Modify T05's actual `server/src/openshell/operation-ledger.ts` and `server/src/db/schema/openshell-operations.ts`: add `external.effect` to `SandboxOperationKind`, allow kind/actor filtering in pending reads, and keep T05's immutable idempotency and terminal-state rules.
- Create `server/src/openshell/external-effect-reconciliation.ts`: `ExternalEffectGate`, pending view projection, evidence/manual resolution, idempotency declaration validation, and the only registered retry path.
- Create `server/src/openshell/external-effect-recovery.ts`: expire/filter/recover scanner for process, Pod, and control-service restart; mark linked coding runs and project user-visible rows.
- Create `server/src/openshell/external-effect-routes.ts`: authenticated owner-scoped list, evidence reconciliation, and manual resolution endpoints.
- Modify `server/src/assembly/runtime.ts`: construct and boot the coordinator only for OpenShell; wire periodic recovery after T05 recovery.

**Task surfaces**

- Modify `server/src/computer/gateway.ts`: after policy approval and before an external-reaching executor, wrap navigation, click, typing, activating keypress, shell command, and private sign-in submission through the external-effect gate; call suspend on `stopComputer`/`resetComputer`.
- Modify `server/src/codesandbox/gateway.ts`, `store.ts`, `server/src/db/schema/code-runs.ts`, and the next Drizzle migration: link a run to its operation and add closed status `pending_reconciliation`; only a real terminal report may complete.
- Modify `server/src/computer/routes.ts` and `app/src/lib/copilot/computer-tools.tsx`/`code-tools.tsx`: pass the existing tool-call id as the stable effect request identity; do not accept a client claim of idempotency.
- Modify `app/src/lib/workshop/queries.ts` and `app/src/components/channels/workshop-turn.tsx` for a turn's pending state.
- Create `app/src/lib/external-effects/queries.ts` and `mutations.ts`; create `app/src/components/bot-profile/external-effects.tsx` and mount it through the existing Bot profile/activity layout. Follow `openbot-data-access`, `openbot-screen-layout`, and `openbot-copy`.
- Modify English and Chinese locale files for the new user-visible state and buttons. Copy must say what happened and what to do, must not expose internals, and must use OpenBot glossary terms.

**Consumes**

- T05: `SandboxOperationScope`, `SandboxOperationStatus`, `SandboxOperationView`, `SandboxOperationLedger.begin/markExecuting/recordOutcome/expireExecuting/reconcile/listNeedingReconciliation`, and `sandboxOperationPayloadFingerprint`.
- T06: trusted computer full-scope/generation resolver and verified stop/reset semantics.
- T07: trusted coding full-scope/generation resolver, verified stop/resume semantics, and `SandboxClient.createSession/sendMessage/abortSession/subscribeEvents/resetWorkspace` boundaries.
- Existing surfaces: `intentOf`, `ComputerGateway.stopComputer/resetComputer`, `CodeRunGateway.run/startStreaming/resetWorkspace`, `CodeRunStore.create/finish/get`, approval replay/complete, and `canUseBot` authorization.

**Produces for T16**

```ts
export type ExternalEffectSource =
  | {
      kind: "computer.external_action";
      botId: string;
      toolName:
        | "computer_navigate"
        | "computer_click"
        | "computer_type"
        | "computer_key"
        | "computer_run_command"
        | "computer_sign_in"
        | "computer_sign_in_code";
      toolCallId: string | null;
    }
  | { kind: "coding.run"; botId: string; runId: string; toolCallId: string | null };

export type PendingExternalEffectView = {
  operationId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
  source: ExternalEffectSource;
  effectType: ExternalEffectSource["kind"];
  status: "unknown" | "pending_reconciliation";
  unknownCause: string;
  createdAt: string;
  lastTransitionAt: string;
  canRetry: boolean;
};

export type ResolvedExternalEffectView = Omit<
  PendingExternalEffectView,
  "status" | "canRetry"
> & {
  status: "succeeded" | "failed";
  canRetry: false;
};

export type ExternalEffectExecution<T> =
  | { status: "succeeded"; value: T; operationId: string }
  | { status: "failed"; operationId: string; reason: string }
  | {
      status: "already_recorded";
      operationId: string;
      operationStatus:
        | "succeeded"
        | "failed"
        | "unknown"
        | "pending_reconciliation";
    }
  | {
      status: "pending_reconciliation";
      operationId: string;
      cause:
        | "lost_receipt"
        | "sandbox_stopped"
        | "sandbox_reset"
        | "sandbox_crash"
        | "pod_rebuilt"
        | "process_restart"
        | "control_service_restart"
        | "transport_unknown";
    };

export type ExternalEffectGate = {
  execute<T>(input: {
    scope: SandboxOperationScope;
    source: ExternalEffectSource;
    idempotencyKey: string;
    idempotency?: { declarationId: string };
    actorRef: string;
    actorUserId?: string;
    initiator: AuditInitiator;
    executor: (operation: SandboxOperationView) => Promise<T>;
  }): Promise<ExternalEffectExecution<T>>;
  suspend(input: {
    scope: SandboxOperationScope;
    reason: "sandbox_stopped" | "sandbox_reset" | "sandbox_crash";
  }): Promise<PendingExternalEffectView[]>;
};

export type ExternalEffectReconciler = {
  listPendingExternalEffects(input: {
    actorUserId: string;
    botId?: string;
    limit?: number;
  }): Promise<PendingExternalEffectView[]>;
  markExternalEffectReconciled(input: {
    operationId: string;
    actorUserId: string;
    evidence: { source: string; reference: string; detail: Record<string, unknown> };
    resolvedStatus: "succeeded" | "failed";
  }): Promise<ResolvedExternalEffectView>;
  markExternalEffectManuallyResolved(input: {
    operationId: string;
    actorUserId: string;
    resolvedStatus: "succeeded" | "failed";
    note: string;
  }): Promise<ResolvedExternalEffectView>;
};

export type ExternalEffectIdempotencyDeclaration = {
  declarationId: string;
  effectType: ExternalEffectSource["kind"];
  provider: string;
  idempotencyKeyField: string;
  proofReference: string;
  verifiedBy: string;
};

export type ExternalEffectRetryExecutor = {
  declarationId: string;
  retry(input: {
    operation: SandboxOperationView;
    idempotencyKey: string;
  }): Promise<{
    status: "succeeded" | "failed" | "pending_reconciliation";
    detail: Record<string, unknown>;
  }>;
};

export class ExternalEffectNotSentError extends Error;

export type ExternalEffectService = ExternalEffectGate &
  ExternalEffectReconciler & {
    retryPendingExternalEffects(input?: {
      limit?: number;
    }): Promise<{
      retried: string[];
      stillPending: string[];
      refused: string[];
    }>;
  };
```

`createExternalEffectReconciler` returns `ExternalEffectService`. Recovery retries only rows whose canonical payload contains a matching declaration and whose executor was registered at boot. A mismatch is `refused`, never a fallback retry.

### Task 1: Durable external-effect reconciliation contract

**Files:** Modify `server/src/openshell/operation-ledger.ts`, `server/src/db/schema/openshell-operations.ts`, `server/src/db/schema/index.ts`, and `server/drizzle.config.ts` only if the actual T05 migration needs a new file; create `server/src/openshell/external-effect-reconciliation.ts`; test `server/tests/openshell-external-effect-ledger.integration.test.ts`; update `tests/config/e2e-bun-suites.json`.

**Interfaces:** Consumes Task 1 of T05 and the `Produces for T16` contract above. Produces `ExternalEffectNotSentError` and `createExternalEffectReconciler(options: { ledger: SandboxOperationLedger; declarations?: readonly ExternalEffectIdempotencyDeclaration[]; retryExecutors?: readonly ExternalEffectRetryExecutor[]; now?: () => Date }): ExternalEffectService`.

- [ ] **Step 1: Write RED.** Add seven named cases: `intent precedes execution and records activation payload`, `lost receipt becomes pending reconciliation and remains listed`, `duplicate key returns the existing operation without a second executor`, `same key with a different payload conflicts`, `evidence reconciliation closes once`, `manual resolution records the user decision and unblocks the next effect`, and `undeclared effect is never auto-retried`. Use real `TEST_DATABASE_URL`/`TEST_POOL`, T05 migrations, and a recording executor; assert audit projection through the existing audit reader, not a parallel table.
- [ ] **Step 2: Register and run RED.** Register the suite with `node scripts/e2e-add-driven.mjs server/tests/openshell-external-effect-ledger.integration.test.ts "Bun SQL external effect reconciliation"` and run `node scripts/e2e-coverage-audit.mjs`. Then run `E2E_BUN_ONLY=server/tests/openshell-external-effect-ledger.integration.test.ts E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task1-red ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`. Expected: 1 driven case containing 7 failing inner Bun cases, with no unexplained skip.
- [ ] **Step 3: Implement the narrow coordinator.** Extend T05's kind union and pending query filters; canonical external payload stores only source metadata, action/run fingerprint, scope-safe actor identity, unknown cause, and optional declaration. `execute` performs `begin → markExecuting → executor → recordOutcome`; duplicate admission never invokes the executor; all non-`ExternalEffectNotSentError` executor failures become `pending_reconciliation`. Evidence and manual paths both call T05 `reconcile` and cannot change a different terminal result.
- [ ] **Step 4: Run GREEN.** Repeat the Task 1 command with `.e2e/<run-key>/T15-task1-green`; require 1 driven case and 7 inner cases passed, zero unexpected skip. Run `cd server && bun run typecheck` and the coverage audit.
- [ ] **Step 5: Commit.** After the repository review gate, commit only this task's authorized files with `feat(#749): add external effect reconciliation`.

### Task 2: Computer external actions and coding run interruption semantics

**Files:** Modify `server/src/computer/gateway.ts`, `server/src/computer/routes.ts`, `server/src/codesandbox/gateway.ts`, `server/src/codesandbox/store.ts`, `server/src/db/schema/code-runs.ts`, the next Drizzle migration, `server/src/assembly/runtime.ts`, `app/src/lib/copilot/computer-tools.tsx`, and `app/src/lib/copilot/code-tools.tsx`; test `server/tests/openshell-external-effect-gateways.test.ts`.

**Interfaces:** Consume Task 1 gate plus T06/T07 trusted scope resolvers. Add optional OpenShell-only gateway dependencies `externalEffects?: ExternalEffectGate` and `scopeForEnvironment?: (botId: string, environment: "computer" | "coding") => Promise<SandboxOperationScope | null>`; absent dependencies preserve legacy behavior. Extend `ClickInput`, `TypeInput`, `KeyInput`, and `CodeRunRunOptions` with server-derived `toolCallId?: string`.

- [ ] **Step 1: Write RED.** Add eight named cases: `external actions are recorded but local reads and workspace writes are not`, `duplicate approved tool call replays without a second side effect`, `interrupted sign-in or command returns no success and stays pending`, `transport loss leaves an external action pending rather than failed`, `stop and reset suspend active effects without provider replay`, `streaming timeout stores pending reconciliation instead of completed`, `successful coding run records one succeeded operation`, and `absent external gate preserves legacy computer and coding outcomes`. Include navigation, click, typing, key, command, sign-in, policy refusal, and approval replay paths.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-external-effect-gateways.test.ts`; expect all 8 named cases to fail on missing wiring, with no unexplained skip.
- [ ] **Step 3: Implement both surfaces.** Computer wraps the external-reaching set named in the architecture after approval and before the transport action; its fingerprint excludes passwords, one-time codes, typed text, command text, and file contents, and uses snapshot/ref/key/page metadata plus a digest. Coding wraps the run after its row/audit intent and before sandbox calls; its payload stores a task digest rather than task text. A pending run gets `code_runs.status = "pending_reconciliation"` plus `operation_id`; only a real terminal response or reconciliation can finish it. Stable tool-call ids reach the server where the caller already has one, but only the server derives idempotency keys and scope.
- [ ] **Step 4: Run GREEN and regressions.** Repeat to `.e2e/<run-key>/T15-task2-green` and require 8 cases passed. Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task2-regression e2e run --config e2e.unit.config.ts server/tests/computer-gateway.test.ts server/tests/codesandbox-gateway.test.ts server/tests/approvals-interactive.integration.test.ts`; require existing cases passed and no old-mode result-shape regression, then run server typecheck.
- [ ] **Step 5: Commit.** Commit the reviewed increment with `feat(#749): gate interrupted sandbox effects`.

### Task 3: Real restart recovery and controlled lost receipt

**Files:** Create `server/src/openshell/external-effect-recovery.ts`, `server/tests/support/external-effect-worker.ts`, and `server/tests/openshell-external-effect-recovery.integration.test.ts`; modify `server/src/assembly/runtime.ts` and `tests/config/e2e-bun-suites.json`.

**Interfaces:** Consume Tasks 1–2 and T05 `expireExecuting`. Produce boot wiring `startExternalEffectRecovery(...)` internal to runtime, plus the public `retryPendingExternalEffects` contract. The test double exposes `POST /submissions` and `GET /receipts/:key`, persists accepted keys in a task-owned file under `.e2e/<run-key>/`, and can destroy the response socket after recording receipt.

- [ ] **Step 1: Write RED with real persistence.** Add six named cases: `lost receipt across control-service restart does not resubmit`, `pod rebuild leaves pending and binds the new generation`, `process restart expires executing without executor replay`, `manual resolution allows the next controlled effect`, `declared idempotency retries once after restart`, and `an unregistered idempotency claim remains pending and conflicts`. Parent starts the local HTTP replacement and a child OpenShell coordinator against isolated PostgreSQL; kill or reconnect the child only after the external endpoint has recorded the key. Assert external submission count, ledger status, coding/computer surface state, and generation binding from persisted rows, not memory.
- [ ] **Step 2: Register and run RED.** Register with `node scripts/e2e-add-driven.mjs server/tests/openshell-external-effect-recovery.integration.test.ts "Bun SQL and process restart external effect recovery"` and audit coverage. Run `E2E_BUN_ONLY=server/tests/openshell-external-effect-recovery.integration.test.ts E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task3-red ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`; expect 1 driven case and 6 failing inner cases, with no unexplained skip.
- [ ] **Step 3: Implement recovery.** Startup runs T05 emergency import/lease expiry, then external recovery. It projects only `external.effect` rows, marks interrupted coding runs pending, retries only exact declared idempotency matches under a new lease, and leaves every undeclared effect pending. The local test declaration exists only in test assembly; production starts with no generic browser/code-task declaration.
- [ ] **Step 4: Run GREEN.** Repeat to `.e2e/<run-key>/T15-task3-green`; require 1 driven case and 6 inner cases passed. For the three non-idempotent restart scenarios, external receipt count must remain 1; for the declared idempotent retry, the replacement must deduplicate to one accepted submission. Run server typecheck and coverage audit.
- [ ] **Step 5: Commit.** Commit only after preserving worker exit/output receipts, with `feat(#749): recover external effects without replay`.

### Task 4: Owner-visible disposition, acceptance, review, and OCR

**Files:** Create `server/src/openshell/external-effect-routes.ts`, `app/src/lib/external-effects/queries.ts`, `app/src/lib/external-effects/mutations.ts`, `app/src/components/bot-profile/external-effects.tsx`, `app/tests/external-effects-review.test.tsx`, and `server/tests/external-effect-routes.test.ts`; modify assembly/route mounting, Bot profile/activity mounting, workshop turn display, and both locales; archive evidence under `.archive/runs/<run-key>/`.

**Interfaces:** Consume `listPendingExternalEffects` and both resolution methods. Routes are `GET /api/external-effects?botId=...`, `POST /api/external-effects/:operationId/reconcile`, and `POST /api/external-effects/:operationId/manual-resolution`; every path uses `requireUser` plus the actual `canUseBot`. Browser reads use an entity key factory and `client`; writes invalidate the external-effects and bot-activity roots; no component calls `fetch`.

- [ ] **Step 1: Write RED.** Server cases: owner lists only their Bot's pending rows, foreign/missing Bot is uniformly forbidden without existence leakage, valid evidence resolves once, manual note resolves and audits through T05, and an already terminal operation is an idempotent no-op rather than a second terminal fact. UI cases cover pending/error/empty/rows, both manual buttons, mutation invalidation, and the workshop `pending_reconciliation` label.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task4-red e2e run --config e2e.unit.config.ts server/tests/external-effect-routes.test.ts app/tests/external-effects-review.test.tsx`; expect 10 named cases total, no unexplained skip.
- [ ] **Step 3: Implement the entry.** Use `PageSection`/`PageRows`/`Item` in the Bot profile. Copy: EN title “Needs checking”, empty “No external results need checking.”, description “This action may have reached another service. Check it before continuing.”, buttons “Mark as done” and “Mark as not sent”; ZH-CN respectively “待核对”、“暂无需要核对的外部结果。”、“这个操作可能已经提交到另一个服务。请先核对，再继续。”、“标记已完成”、“标记未发送”。 Never show typed text, task text, secrets, URLs with credentials, or provider internals.
- [ ] **Step 4: Run GREEN and affected regressions.** Repeat to `.e2e/<run-key>/T15-task4-green`; require 10 cases passed. Run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T15-task4-regression e2e run --config e2e.unit.config.ts server/tests/bot-lifecycle-routes.test.ts server/tests/multitenancy/computer-allocation.test.ts server/tests/multitenancy/workshop-scope.test.ts server/tests/multitenancy/approval-resume-public.test.ts`, then server and app typecheck/lint as applicable. Require actual case counts and no unexplained skip.
- [ ] **Step 5: Independent acceptance, review, OCR, and commit.** A fresh reviewer maps #749 and A07 to Tasks 1–4, including the three restart scenarios, duplicate count, manual continuation, and idempotency proof. Run full applicable OCR after independent review, resolve every critical/high/medium finding, archive reports, and commit with `feat(#749): surface and resolve interrupted external effects`.

## Independent acceptance

- **#749 AC1 / A07 no duplicate after lost receipt:** Task 3 proves the local external replacement accepted exactly one submission, the response was lost, control service restarted, and recovery made no second submission. Task 1 duplicate-key and Task 2 approval-replay tests reinforce the same boundary.
- **#749 AC2 / A07 reconcile or manual disposition before continuation:** Task 1 evidence/manual terminal tests and Task 3 manual-continuation test prove pending is not success and not retry permission; Task 4 proves the authorized owner can see and dispose of it.
- **#749 AC3 / A07 declared idempotent effect safely recovers:** Task 3 proves an exact declaration and payload match retry once under a new lease, while the local endpoint deduplicates to one accepted submission; an unregistered or mismatched declaration remains pending/refused.
- **D14 unknown is neither success nor retry:** Tasks 1–3 cover activation stop, transport loss, streaming timeout, process restart, Pod rebuild, and control-service restart; none may call an undeclared executor or return a completed/cleared shape while pending.
- **D15 one durable authority and audit projection:** Task 1 uses T05 transactional intent/outcome and audit projection; no second pending authority is introduced.

Blocked gates: #740 or #741 not verified in the same tree; T05/T06/T07 interfaces differ from their approved contracts; isolated PostgreSQL or child-process restart cannot be exercised; any unexplained or zero-count suite; any duplicate external submission; any old-mode behavior/result regression; missing owner entry or authorization evidence; missing independent review/OCR archive. These conditions keep #749 blocked rather than weakening A07.

## Plan self-review

- **Spec coverage:** A07 and #749's three AC map to Tasks 1–4; D14's unknown/not-retry rule, D15's single ledger, user visibility, three restart modes, and idempotent-only recovery are all named.
- **Step scan:** Every task has exact files, named tests, RED/GREEN commands, expected counts, implementation boundary, and commit; no step delegates an undefined decision.
- **Type consistency:** `ExternalEffectSource`, `PendingExternalEffectView`, list/mark/declaration/retry signatures, T05 status names, and `SandboxOperationScope` are used consistently across Tasks 1–4 and T16 output.
- **Review focus coverage:** Each of the five stated failure modes names its owning test and scenario.
- **Proportion:** The plan records the decisions implementers cannot infer and leaves idiomatic implementation details to four bounded tasks; test code is represented by names and assertions rather than large fixtures.
