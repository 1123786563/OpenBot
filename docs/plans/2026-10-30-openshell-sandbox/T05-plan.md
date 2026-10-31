# T05 关键沙箱操作意图审计与紧急处置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking progress. Repository authorization and review rules govern actual dispatch and authorization.

**Goal:** OpenShell 的关键沙箱操作先落 durable intent，再执行并落 outcome；中央审计不可用时普通破坏性操作拒绝，紧急 containment 放行并留下可恢复证据。

**Architecture:** 新增 OpenShell operation ledger 作为关键操作状态与幂等权威，保存 intent、payload fingerprint、执行租约和 `succeeded | failed | unknown | pending_reconciliation` 状态。`server/src/audit.ts` 的 `audit_events` 仍是安全审计权威；ledger 与对应 audit event 在同一数据库事务提交，并用窄状态机补足 append-only audit 不能表达的幂等冲突、执行占位和对账状态。紧急操作在中央审计不可用时先写 fsync 的本地 emergency record，再执行 containment；恢复后导入 ledger 并只允许证据化补齐结果，不重放副作用。

**Tech Stack:** TypeScript、Bun、PostgreSQL、Drizzle migration、Hono gateway、tester-army e2e、Helm。

**Spec:** [OpenShell Spec A07](../../specs/2026-10-30-openshell-sandbox.md#验收映射)、[D14–D15 与行为边界](../../specs/2026-10-30-openshell-sandbox.md#已批准决定)、[ADR 0013](../../adr/0013-openshell-sandbox-substrate.md)、[ADR 0006](../../adr/0006-logical-private-bot-scoped-execution.md)、[ticket breakdown T05](ticket-breakdown.md#t05--关键沙箱操作具备意图审计与紧急处置)。GitHub Issue [#739](https://github.com/1123786563/OpenBot/issues/739) 为 open 且 `ready-for-agent`；真实 Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736)（T02，open）。

## Global Constraints

- 本计划、草案和 Issue 不是实施授权；实施前重读 Issue #739/#736、当前 Spec/ADR、T02 实际产物和 Git 状态。#736 未验证前 T05 保持 blocked。
- T05 只在 OpenShell 模式接入新协调器；`shared`、`docker`、既有 `sandbox` 模式的 stop/reset 行为和既有 audit 事件保持不变。
- 关键操作包含本票的 computer stop/reset、coding reset，以及合同预留给 T09–T12 的 network grant/revoke 和 file transfer。普通操作必须先在同一 Postgres 事务内落 operation intent 与 audit intent，再执行副作用，最后落 outcome。
- 中央审计/ledger 写入失败时，普通破坏性操作在副作用前拒绝；紧急 containment 和权限收紧不得被该失败阻断，必须先写可恢复 emergency record，再执行，并尽可能补写本地 outcome。
- `unknown` 和 `pending_reconciliation` 都不是成功，也不是可重试许可；只有外部状态证据或人工处置可以补成 `succeeded`/`failed`。重启扫描不得重新调用副作用 executor。
- 执行归属必须是 `tenantId + workspaceId + botId + environment + generation`，不能以全局 Bot ID 作唯一键；scope 由服务器侧 T02/T03 resolver 提供，客户端 header/body 不产生信任。
- 不新建第二个安全审计权威：`audit_events` 及 `server/src/audit.ts` 的 `AuditStore`/`AuditSink`/redaction/initiator 体系仍是审计读入口。`openshell_operation_records` 是操作状态权威，原因是 append-only audit 无法唯一约束幂等键、CAS 执行占位或表达待对账状态；每个状态迁移仍投影为 audit event。
- 数据库用例必须使用 `server/tests/support/database.ts` 的 `testDatabaseUrl()` 与 `TEST_POOL`，先迁移隔离 `TEST_DATABASE_URL`；持久化与重启用例不得 mock 落库。
- 完整档执行独立行为验收、Spec/质量 Review 和适用 OCR；命令、实际收集数、失败/跳过、源码与版本检查点存 `.archive/runs/<run-key>/verification/`。

## Review Focus

- 意图已落但执行失败后重复提交造成二次删除：`SandboxOperationLedger.begin` 必须返回既有 operation，Task 1 `same idempotency key and fingerprint converges without a second row` 与 Task 3 `duplicate computer request performs one provider side effect` 钉住。
- 同一幂等键绑定不同 payload 被当作重试：payload fingerprint 必须冲突，Task 1 `same idempotency key with a different payload conflicts` 钉住。
- 审计库故障时普通 reset 仍执行且无记录：audit insert 失败必须回滚 ledger 并阻止 provider/client 调用，Task 1 `audit insert failure rolls back intent` 与 Task 3 `central audit failure refuses computer and coding reset before provider` 钉住。
- 紧急停止被中央审计故障阻塞或证据未先落本地：emergency intent 必须先 fsync 再 stop，Task 2 `emergency containment writes durable local intent before stop` 钉住。
- 进程在“已执行未记结果”间重启后被误报成功或自动重放：过期 `executing` 只能变 `unknown`，随后按 operation ID 证据化补齐，Task 2 `restart leaves executing operation unknown rather than successful` 与 `reconciliation completes by evidence without replaying side effect` 钉住。

## File map and dependency contract

**Owned files**

- Create `server/src/openshell/operation-ledger.ts`：scope/kind/fingerprint、幂等 admission、状态 CAS、audit 同事务投影、到期扫描与待对账列表。
- Create `server/src/openshell/operation-coordinator.ts`：普通/紧急操作编排、audit-unavailable 分类、emergency recovery 导入。
- Create `server/src/openshell/emergency-operation-store.ts`：按 record 原子写 intent/outcome 文件并 fsync；只存脱敏 payload 与 fingerprint。
- Create `server/src/db/schema/openshell-operations.ts`；modify `server/src/db/schema/index.ts` 与 `server/drizzle.config.ts`；生成下一条 `server/drizzle/0237_*.sql` 与 meta journal。
- Modify `server/src/audit.ts` 仅新增 literal event types；modify `server/src/computer/gateway.ts`、`server/src/computer/routes.ts`、`server/src/codesandbox/gateway.ts`、`server/src/codesandbox/routes.ts`、`server/src/assembly/runtime.ts` 与 T02 实际 OpenShell 配置装配点。
- Modify `charts/openbot/values.yaml` 与 `charts/openbot/templates/server/deployment.yaml`，只为 OpenShell 增加 durable emergency spool volume；旧渲染不变。
- Tests/support：`server/tests/sandbox-operation-ledger.integration.test.ts`、`server/tests/sandbox-operation-emergency.integration.test.ts`、`server/tests/support/sandbox-operation-worker.ts`、`server/tests/openshell-sandbox-operation-gateways.test.ts`、`server/tests/openshell-operation-recovery-wiring.test.ts`；按 ADR 0008 更新 driven manifest。

**Produces: durable operation contract**

```ts
export type SandboxOperationKind =
  | "computer.stop"
  | "computer.reset"
  | "coding.stop"
  | "coding.reset"
  | "network.grant"
  | "network.revoke"
  | "file.transfer";

export type SandboxOperationScope = {
  tenantId: string;
  workspaceId: string;
  botId: string;
  environment: "computer" | "coding";
  generation: string;
};

export type SandboxOperationStatus =
  | "intent_recorded"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "pending_reconciliation";

export type BeginSandboxOperationInput = {
  idempotencyKey: string;
  scope: SandboxOperationScope;
  kind: SandboxOperationKind;
  payload: Record<string, unknown>;
  actorRef: string;
  actorUserId?: string;
  initiator: AuditInitiator;
};

export type SandboxOperationAdmission =
  | { admission: "new"; operation: SandboxOperationView }
  | { admission: "already_recorded"; operation: SandboxOperationView }
  | { admission: "conflict"; reason: "payload_mismatch"; existing: SandboxOperationView };

export type SandboxOperationView = {
  operationId: string;
  idempotencyKey: string;
  scope: SandboxOperationScope;
  kind: SandboxOperationKind;
  payload: Record<string, unknown>;
  payloadFingerprint: string;
  actorRef: string;
  actorUserId: string | null;
  initiatorKind: string;
  initiatorId: string | null;
  status: SandboxOperationStatus;
  origin: "primary" | "emergency_local";
  emergencyRecordId: string | null;
  createdAt: string;
  lastTransitionAt: string;
  settledAt: string | null;
};

export type SandboxOperationLedger = {
  begin(input: BeginSandboxOperationInput): Promise<SandboxOperationAdmission>;
  markExecuting(input: {
    operationId: string;
    executorId: string;
    leaseMs: number;
  }): Promise<
    | { transition: "claimed"; operation: SandboxOperationView }
    | { transition: "already_executing"; operation: SandboxOperationView }
    | { transition: "terminal"; operation: SandboxOperationView }
  >;
  recordOutcome(input: {
    operationId: string;
    status: "succeeded" | "failed" | "unknown" | "pending_reconciliation";
    detail?: Record<string, unknown>;
  }): Promise<
    | { transition: "recorded"; operation: SandboxOperationView }
    | { transition: "already_same"; operation: SandboxOperationView }
    | { transition: "conflict"; existing: SandboxOperationView }
  >;
  expireExecuting(input?: { now?: Date; limit?: number }): Promise<SandboxOperationView[]>;
  reconcile(input: {
    operationId: string;
    evidence: { source: string; detail: Record<string, unknown> };
    resolvedStatus: "succeeded" | "failed";
  }): Promise<SandboxOperationView>;
  listNeedingReconciliation(input?: { limit?: number }): Promise<SandboxOperationView[]>;
};

export function createSandboxOperationLedger(options: {
  database: Database;
  auditStoreFor?: (database: Database) => AuditStore;
  now?: () => Date;
}): SandboxOperationLedger;

export const SANDBOX_OPERATION_EXECUTION_LEASE_MS = 300_000;

export function sandboxOperationIdempotencyKey(input: {
  actorRef: string;
  actorUserId?: string;
  initiator: AuditInitiator;
  scope: SandboxOperationScope;
  kind: SandboxOperationKind;
  requestId: string;
}): string;

export function sandboxOperationPayloadFingerprint(
  payload: Record<string, unknown>,
): string;
```

State machine: `intent_recorded → executing → succeeded | failed | unknown | pending_reconciliation`; `unknown | pending_reconciliation → succeeded | failed` only through `reconcile`; no state may return to `executing`. Same terminal outcome is idempotent; a different terminal outcome is a conflict. `listNeedingReconciliation` returns only `unknown` and `pending_reconciliation`, default limit 100 and maximum 500. Both digest helpers return 64-character lowercase hex; `requestId` is non-empty and at most 200 characters. Ledger payload is redacted for storage, while its fingerprint is computed from the server-side original payload before redaction.

**Produces: audit-unavailable and emergency contract**

```ts
export class SandboxOperationAuditUnavailableError extends Error;
export function isSandboxOperationAuditUnavailable(error: unknown): boolean;

export type EmergencySandboxOperationRecord = {
  recordId: string;
  operationId: string;
  idempotencyKey: string;
  scope: SandboxOperationScope;
  kind: SandboxOperationKind;
  payload: Record<string, unknown>;
  payloadFingerprint: string;
  actorRef: string;
  actorUserId?: string;
  initiatorKind: string;
  initiatorId: string | null;
  reason: "central_audit_unavailable" | "containment_required";
  intentRecordedAt: string;
  outcome?: {
    status: "succeeded" | "failed" | "unknown" | "pending_reconciliation";
    detail: Record<string, unknown>;
    recordedAt: string;
  };
};

export type EmergencySandboxOperationStore = {
  appendIntent(input: {
    recordId: string;
    operationId: string;
    intentRecordedAt: string;
    reason: EmergencySandboxOperationRecord["reason"];
    begin: BeginSandboxOperationInput;
  }): Promise<EmergencySandboxOperationRecord>;
  appendOutcome(input: {
    recordId: string;
    status: "succeeded" | "failed" | "unknown" | "pending_reconciliation";
    detail: Record<string, unknown>;
  }): Promise<EmergencySandboxOperationRecord>;
  listUnreconciled(): Promise<EmergencySandboxOperationRecord[]>;
};

export function createEmergencySandboxOperationStore(directory: string): EmergencySandboxOperationStore;

export type SandboxOperationCoordinator = {
  startEmergency(input: BeginSandboxOperationInput & {
    reason: EmergencySandboxOperationRecord["reason"];
  }): Promise<{
    record: EmergencySandboxOperationRecord;
    mode: "primary" | "local_fallback";
  }>;
  finishEmergency(input: {
    recordId: string;
    status: "succeeded" | "failed" | "unknown" | "pending_reconciliation";
    detail: Record<string, unknown>;
  }): Promise<EmergencySandboxOperationRecord>;
  recoverEmergency(): Promise<{
    imported: SandboxOperationView[];
    alreadyImported: SandboxOperationView[];
  }>;
};

export function createSandboxOperationCoordinator(options: {
  ledger: SandboxOperationLedger;
  emergencyStore: EmergencySandboxOperationStore;
  now?: () => Date;
}): SandboxOperationCoordinator;
```

`SandboxOperationCoordinator.startEmergency` first tries the primary transaction. Only `SandboxOperationAuditUnavailableError` may fall back to `appendIntent`; input validation, payload conflict, or executor failure must not. The local file is complete, atomically renamed, file and directory fsynced before the executor runs. Recovery imports each record as `pending_reconciliation` (or preserves a locally observed non-success outcome as `unknown`) and projects `openshell_operation.emergency_recovered`; import is idempotent by `emergencyRecordId`.

**Audit projection**

- Add literal types: `openshell_operation.intent_recorded`, `.executing`, `.outcome_recorded`, `.reconciled`, and `.emergency_recovered`.
- Every event uses `targetType: "openshell_operation"` and `targetId: operationId`; payload carries only scope/kind/status/fingerprint/evidence source after `redactAuditPayload`, never secret values or raw file content.
- Normal intent and ledger row commit atomically. An audit insert failure rolls back the operation row; therefore an unrecorded normal side effect is structurally impossible when the coordinator is wired.

**Downstream alignment**

- T06/T07 consume `begin → markExecuting → recordOutcome/reconcile`; success keeps each gateway's existing result shape, uncertainty adds `operationId` and never reports cleared/copied/revoked.
- T09–T11 consume `network.grant`/`network.revoke` and `SandboxOperationCoordinator.startEmergency → finishEmergency → recoverEmergency` for audit-outage tightening.
- T12 consumes `file.transfer`, `sandboxOperationIdempotencyKey`, `(scope, kind, idempotencyKey)` uniqueness plus `sandboxOperationPayloadFingerprint`, and `listNeedingReconciliation` for lost receipts.
- T15 consumes `expireExecuting` and `listNeedingReconciliation`; its scanner performs no side-effect replay.

---

### Task 1: Durable intent/outcome ledger

**Files:** Create `server/src/openshell/operation-ledger.ts`, `server/src/db/schema/openshell-operations.ts`, migration `server/drizzle/0237_*.sql`; modify `server/src/audit.ts`, `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `tests/config/e2e-bun-suites.json`; test `server/tests/sandbox-operation-ledger.integration.test.ts`.

**Interfaces:** Consumes existing `Database`, `AuditStore`, `createAuditStore`, `recordAuditEvent`, `redactAuditPayload`, and `AuditInitiator`. Produces `SandboxOperationLedger`, `createSandboxOperationLedger`, `sandboxOperationIdempotencyKey`, `sandboxOperationPayloadFingerprint`, the status/scope/kind types above, and table `openshell_operation_records`.

- [ ] **Step 1: Write failing integration tests.** Add the six named cases: `intent and audit commit atomically`, `same idempotency key and fingerprint converges without a second row`, `same idempotency key with a different payload conflicts`, `outcome transitions preserve unknown and reconciliation semantics`, `reconciliation listing returns only unsettled operations`, and `audit insert failure rolls back intent`. Read projected rows through `createAuditReader` as well as the ledger. This task declares and writes only `openshell_operation.intent_recorded`, `.outcome_recorded`, and `.reconciled`.
- [ ] **Step 2: Register and run RED.** Register the suite with `node scripts/e2e-add-driven.mjs server/tests/sandbox-operation-ledger.integration.test.ts "Bun SQL database integration"` and run `node scripts/e2e-coverage-audit.mjs`. Then run `E2E_BUN_ONLY=server/tests/sandbox-operation-ledger.integration.test.ts E2E_UNIT_OUTPUT=.e2e/<run-key>/T05-task1-red ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`. Expected: the driven case fails on missing exports/table, reports one selected group and more than zero inner Bun cases, with no unexplained skip.
- [ ] **Step 3: Implement the minimal schema and ledger.** Add unique `(scope columns, kind, idempotency_key)`, immutable identity/actor/fingerprint columns, closed status CHECK, executor lease columns, terminal timestamp shape CHECK, unique `emergency_record_id`, and pending-state index. Implement transactional admission/CAS transitions and SHA-256 fingerprints over canonical JSON; pass the transaction to `createAuditStore(tx as unknown as Database)` so operation and audit commit together. Generate/apply migration only to isolated test PostgreSQL.
- [ ] **Step 4: Run GREEN.** Repeat the Task 1 command with `.e2e/<run-key>/T05-task1-green`; require the named six cases collected and passed, zero unexpected skip. Run `cd server && bun run typecheck` and the coverage audit.
- [ ] **Step 5: Commit.** After the repository review gate, commit only Task 1 files with `feat(#739): add OpenShell operation ledger`.

### Task 2: Emergency containment and real restart recovery

**Files:** Create `server/src/openshell/operation-coordinator.ts`, `server/src/openshell/emergency-operation-store.ts`, `server/tests/support/sandbox-operation-worker.ts`; modify `server/src/audit.ts`; test `server/tests/sandbox-operation-emergency.integration.test.ts` and manifest.

**Interfaces:** Consumes Task 1 ledger. Produces `SandboxOperationAuditUnavailableError`, `isSandboxOperationAuditUnavailable`, `EmergencySandboxOperationStore`, `createEmergencySandboxOperationStore`, `SandboxOperationCoordinator`, and `createSandboxOperationCoordinator`.

- [ ] **Step 1: Write failing tests with real persistence.** Add `normal operation is refused before execution when central audit insert fails`, `audit unavailable classification gates only emergency fallback`, `emergency containment writes durable local intent before stop`, `emergency store failure blocks containment executor`, `emergency local outcome is fsynced and recoverable`, `restart leaves executing operation unknown rather than successful`, `reconciliation completes by evidence without replaying side effect`, and `emergency import is idempotent`. Add the `openshell_operation.emergency_recovered` writer and literal in this task. Use real `TEST_DATABASE_URL` and a real temporary emergency directory under the task's `.e2e` output; do not mock database or file persistence.
- [ ] **Step 2: Register and run RED.** Register with `node scripts/e2e-add-driven.mjs server/tests/sandbox-operation-emergency.integration.test.ts "Bun SQL and fsync recovery integration"` and run the coverage audit. Run `E2E_BUN_ONLY=server/tests/sandbox-operation-emergency.integration.test.ts E2E_UNIT_OUTPUT=.e2e/<run-key>/T05-task2-red ./node_modules/.bin/e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`. Expected: missing coordinator/store failures with non-zero inner cases and no unexplained skip.
- [ ] **Step 3: Implement fail-closed/fail-open split and worker.** `SandboxOperationCoordinator.startEmergency` only falls back on the classified audit-unavailable error. The store writes one complete checksummed JSON file per record/outcome via temporary file, rename, file fsync, and directory fsync; duplicate operation ID is idempotent only for byte-equivalent intent, and an invalid checksum is an explicit recovery blocker rather than a skipped file. Log audit-store failure only as error name plus trusted Postgres SQLSTATE, following `server/src/identity/audit-failure.ts` and never query/message/subject text. Add the single-operation Bun worker so a fresh process can expire, list, and reconcile against the same database; parent tests assert its JSON result.
- [ ] **Step 4: Run GREEN.** Repeat with `.e2e/<run-key>/T05-task2-green`; require all named cases passed and the child process used the same isolated database URL. Run server typecheck and coverage audit.
- [ ] **Step 5: Commit.** Commit only reviewed Task 2 files with `feat(#739): preserve emergency sandbox operations`.

### Task 3: Computer and coding gateway wiring plus legacy regression

**Files:** Modify `server/src/computer/gateway.ts`, `server/src/computer/routes.ts`, `server/src/codesandbox/gateway.ts`, `server/src/codesandbox/routes.ts`, `server/src/config.ts` and the actual T02 OpenShell assembly point in `server/src/assembly/runtime.ts`; create `server/tests/openshell-sandbox-operation-gateways.test.ts`; extend existing computer/coding route regression tests only where needed.

**Interfaces:** Consumes Task 1/2 contracts and trusted full-scope resolvers: T02 supplies computer; coding uses an injected full-scope resolver and refuses in OpenShell mode when generation is unavailable (T07 later owns the real stop lifecycle). Produces OpenShell-only optional gateway parameters and request IDs: `stopComputer(botId, actor, requestId?: string)`, `resetComputer(botId, actor, requestId?: string)`, internal `emergencyStopComputer(botId, actor, requestId: string, reason: string)`, and `resetWorkspace(requestId?: string)`. Successful legacy shapes remain unchanged; unknown returns carry `status: "pending_reconciliation"` and `operationId`.

- [ ] **Step 1: Write failing gateway/route tests.** Add `computer stop and reset pass through intent outcome coordinator`, `duplicate computer request performs one provider side effect`, `payload mismatch under one request key returns conflict`, `provider timeout leaves operation pending reconciliation`, `coding reset maps unknown to pending reconciliation`, `central audit failure refuses computer and coding reset before provider`, `emergency stop records local intent before provider`, and `legacy modes preserve behavior without coordinator`. Add the `openshell_operation.executing` writer and literal in this task.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T05-task3-red e2e run --config e2e.unit.config.ts server/tests/openshell-sandbox-operation-gateways.test.ts`; expect missing-parameter/interface failures, all named cases collected, no unexplained skip.
- [ ] **Step 3: Implement minimum wiring.** Routes parse a non-empty request ID of at most 200 characters; OpenShell mode requires it and derives the idempotency key with `sandboxOperationIdempotencyKey` from authenticated actor plus full scope/kind. Gateways claim only an admitted `new` operation before provider/client execution, record explicit failure or unknown, and preserve old modes when coordinator/scope are absent. Do not expose `criticality` or emergency choice through client JSON.
- [ ] **Step 4: Run GREEN and regressions.** Repeat to `.e2e/<run-key>/T05-task3-green`, then run `E2E_UNIT_OUTPUT=.e2e/<run-key>/T05-task3-regression e2e run --config e2e.unit.config.ts server/tests/computer-routes.test.ts server/tests/codesandbox-gateway.test.ts server/tests/codesandbox-routes.test.ts`. Require new and existing cases passed; run server typecheck.
- [ ] **Step 5: Commit.** Commit only reviewed Task 3 files with `feat(#739): guard critical sandbox operations`.

### Task 4: Boot recovery, durable deployment spool, and independent acceptance

**Files:** Modify `server/src/assembly/runtime.ts`, `server/src/config.ts`, `charts/openbot/values.yaml`, and the actual server deployment template under `charts/openbot/templates/server/`; test `server/tests/openshell-operation-recovery-wiring.test.ts`; archive evidence under `.archive/runs/<run-key>/verification/`.

**Interfaces:** Consumes Tasks 1–3. Produces boot wiring `createSandboxOperationServices(...)` and `startSandboxOperationRecovery(...)` internal to `server/src/assembly/runtime.ts`; configuration requires `OPENBOT_SANDBOX_EMERGENCY_SPOOL_DIR` and a durable volume only in OpenShell mode.

- [ ] **Step 1: Write failing wiring/chart tests.** Assert boot imports emergency records once, expires stale executing rows to unknown without executor invocation, exposes pending operations, rejects a missing/non-durable spool configuration in OpenShell mode, and leaves legacy chart output unchanged. Chart policy must refuse multiple server replicas with a non-RWX emergency volume.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T05-task4-red e2e run --config e2e.unit.config.ts server/tests/openshell-operation-recovery-wiring.test.ts`; expect missing boot/chart behavior, non-zero named cases, no unexplained skip.
- [ ] **Step 3: Implement minimum boot/deployment wiring.** Construct one ledger/emergency store/coordinator from the boot database and audit store; run recovery at startup and periodic `expireExecuting`. Mount the configured durable volume only for OpenShell; do not use `emptyDir` or a path on container-local storage.
- [ ] **Step 4: Run GREEN and deployment checks.** Repeat to `.e2e/<run-key>/T05-task4-green`; run `helm lint charts/openbot`, legacy `helm template`, and OpenShell render with T02's verified values. Run affected Task 1–3 suites and `cd server && bun run typecheck`; record actual counts, migration state, source checkpoint, and chart manifest.
- [ ] **Step 5: Independent acceptance and commit.** A fresh reviewer maps #739/A07 to actual tests and live persisted behavior, then run applicable OCR. Resolve all critical/high/medium findings before commit `feat(#739): complete sandbox operation audit recovery`; retain reports in the run archive.

## Independent acceptance

- **#739 AC1 normal, duplicate, unknown, audit failure are inspectable:** Task 1 atomic intent/outcome tests; Task 3 `computer stop and reset pass through intent outcome coordinator`, `duplicate computer request performs one provider side effect`, and `coding reset maps unknown to pending reconciliation`; Task 2 audit-failure and restart tests. Audit reader must show intent and terminal/reconciliation events, and ledger status must match the external result.
- **#739 AC2 audit failure creates no unrecorded ordinary reset:** Task 1 rollback test proves no operation row; Task 3 proves no computer/coding provider or client call before refusal. Any observed reset call during injected audit failure blocks acceptance.
- **#739 AC3 emergency stop is not blocked and can be reconciled after recovery:** Task 2 proves local intent precedes stop and outcome/recovery survives a separate process; Task 4 proves automatic boot import without replay. Recovery without a durable spool receipt or with duplicate import is blocked.
- **A07 ordinary destructive operation fails closed under audit outage:** Task 3 computer/coding refusal tests and Task 2 classification test.
- **A07 emergency tightening still executes with recoverable evidence:** Task 2 local fallback/outcome tests; T11 will extend the same contract to network revocation.
- **A07 unknown side effect is not automatically replayed:** Task 2 restart/reconciliation tests and Task 3 duplicate request test; no test path may call the executor from `expireExecuting`, `listNeedingReconciliation`, or emergency import.

Blocked gates: #736 not verified in the same tree; inability to prove transactional intent-before-execution on the selected PostgreSQL; inability to fsync and retain the emergency spool across process restart; missing migration/chart evidence; any unexplained skipped or zero-count suite; any old-mode regression. These are blocking conditions, not permission to weaken D14/D15.
