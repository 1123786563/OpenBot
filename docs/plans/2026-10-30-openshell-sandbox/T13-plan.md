# T13 Per-Sandbox Resource Hard Limits and Capacity Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project execution rules determine actual dispatch and authorization.

**Goal:** Give every OpenShell computer and coding sandbox independently enforced CPU, memory, and persistent-storage limits, and make capacity contention produce a bounded, visible, fair queue with explicit timeout and release behavior.

**Architecture:** OpenBot remains the capacity authority. A durable M09 ExecutionEnvironment coordinator owns queue and reservation facts in PostgreSQL, reconciles the actual T02/T03 runtime inventories, and admits both environment types against per-environment and deployment-wide budgets before any OpenShell start call. Kubernetes workload limits and a namespace ResourceQuota are defense in depth, while real hard-limit proof comes only from live CPU, memory, and write pressure on the selected stack.

**Tech Stack:** TypeScript/Bun, PostgreSQL/Drizzle, Kubernetes/OpenShell from verified T01, Helm, the T02/T03 adapters, e2e runner, isolated Kubernetes test cluster and isolated test database.

**Spec:** [D17](../../specs/2026-10-30-openshell-sandbox.md#L94), [D24](../../specs/2026-10-30-openshell-sandbox.md#L101), [A08](../../specs/2026-10-30-openshell-sandbox.md#L129), and [technical verification gates](../../specs/2026-10-30-openshell-sandbox.md#L132); [ADR 0013](../../adr/0013-openshell-sandbox-substrate.md); [ticket breakdown T13](ticket-breakdown.md#L105).

**Issue:** Published as [#747](https://github.com/1123786563/OpenBot/issues/747), parent [#734](https://github.com/1123786563/OpenBot/issues/734), state `open`, label `ready-for-agent`, and genuinely Blocked by [#736](https://github.com/1123786563/OpenBot/issues/736) and [#737](https://github.com/1123786563/OpenBot/issues/737). Both blockers were still `open` when read at 2026-10-30T13:44:00Z. This plan is not implementation authorization; execution must re-read #747, #736, #737, and the approved sources immediately before starting.

## Global Constraints

- Do not begin implementation until #736 and #737 are verified in this workspace. Inspect their actual computer and coding startup, stop/reset, scope, generation, provider-ID, and inventory contracts; if either interface differs from this plan, stop as blocked and request a plan revision rather than bypassing it.
- CPU, memory, and persistent storage must be proven by live pressure on the T01-selected OpenShell/controller/CNI/storage/kernel combination. A PVC storage request is capacity accounting, never proof of a write hard quota.
- Enforce separate `computer` and `coding` limits, separate per-environment aggregates, and one deployment-wide aggregate for each of CPU, memory, and storage. Admission checks all three levels and the actual runtime inventory before an OpenShell start.
- Insufficient capacity queues. Every queue is bounded, has a database-clock deadline, returns a visible position/status, and times out with a stable explicit failure. Fairness is two-lane round robin between eligible environment lanes; an ineligible lane never blocks the other lane.
- Never evict or stop an in-flight task to make room, lower isolation, share a Bot sandbox, or delete browser profiles, coding files, sessions, volumes, or other user data to free capacity. Only an explicitly requested reset may delete that environment's data.
- Production defaults for per-sandbox amounts, environment budgets, deployment budgets, queue wait, and queue depth come from Task 4 measurements and cite the archived evidence digest. Invalid, partial, or unmeasured values fail configuration/rendering rather than falling back to an invented number.
- Any start failure runs an idempotent failed-start cleanup, then releases compute and newly created storage reservation facts. An existing volume keeps its storage reservation until verified reset/delete; ambiguity moves the row to `pending_reconcile` and blocks reuse of those resources rather than guessing.
- Legacy `shared`, `docker`, existing Kubernetes `sandbox`, shared `agent-sandbox`, OpenMuse task, and billing-capacity behavior remains unchanged. This task must not replace `ComputerCapacity`, `TaskWorkerCapacity`, or billing credit admission.
- Use the e2e entry from ADR 0008 for every RED/GREEN command, isolated database/cluster resources only, record actual collected/failed/skipped counts, and archive the full T13 evidence, independent behavior/Spec/quality review, and applicable OCR under `.archive/runs/<run-key>/verification/`, `reviews/`, and `ocr/`.

## Review Focus

1. Memory is only accounted in a map and described as a hard limit: Task 1 rejects configurations without a Kubernetes memory limit, and Task 4 proves an actual allocation failure/OOM kill in both environments.
2. Storage exhaustion triggers cleanup or deletion: Task 2/Task 3 keep storage reservation until verified reset, and Task 4 writes past the quota with sentinel login/workspace files and asserts `EDQUOT`/`ENOSPC` without byte loss.
3. A queued newcomer causes an active task to be stopped: Task 2 proves ledger behavior, Task 3 proves no provider stop/reset is issued, and Task 4 keeps active CPU/SSE workloads running through another request's queue timeout.
4. The queue is unbounded, starves one environment, or briefly overshoots the budget: Task 2 tests queue-full, explicit timeout, weighted round robin, duplicate admission, and concurrent transactions; Task 4 repeats the race against real inventory and ResourceQuota.
5. A failed or crashed start leaks CPU, memory, or storage reservation: Task 2 tests release and pending reconciliation, Task 3 tests ordered cleanup/release, and Task 4 proves no workload, claim, or reservation remains after an injected start failure.

## File Map and Dependency Contract

- `server/src/openshell/resources.ts` — sole parser/validator of resource envelopes, aggregate budgets, queue bounds, timeout, fairness ID, and measured-default evidence reference. It emits immutable values and performs no I/O.
- `server/src/db/schema/openshell-capacity.ts` and `server/drizzle/0237_openshell_capacity.sql` — sole durable owner of queue/reservation rows and their unique idempotency/scope/provider constraints. They do not store OpenShell credentials or user files.
- `server/src/openshell/capacity.ts` — atomic admission, queue timeout, fair promotion, release, stop/reset accounting, reconciliation, status, and stable errors. It serializes multi-replica promotion with one PostgreSQL transaction/advisory lock and uses the database clock for deadlines.
- `server/src/openshell/runtime-inventory.ts` — normalizes the verified T02/T03 computer and coding adapters into read-only runtime facts. It may not start, stop, reset, or mutate a sandbox.
- `server/src/computer/openshell.ts` and `server/src/codesandbox/openshell.ts` — the only environment integration points. They request admission before a mutating OpenShell call, mark success, map queue/timeout errors to existing service responses, and perform failed-start cleanup before release. If #737 placed its coding adapter at another path, that mismatch is a blocking prerequisite error.
- `charts/openbot/templates/openshell/resource-quota.yaml`, `charts/openbot/templates/computer/sandbox-template.yaml`, and `charts/openbot/templates/openshell/coding-sandbox.yaml` — deployment budget backstop and separate per-sandbox CPU/memory limits plus the T01-verified storage-quota fields. Existing non-OpenShell computer templates remain byte-for-byte unchanged.
- `charts/openbot/values.yaml` and `charts/openbot/README.md` — explicit test values in early tasks and measured production defaults/documentation after Task 4.
- `scripts/openshell-capacity-acceptance.ts` and `tests/openshell/capacity-hard-limits.e2e.test.ts` — reproducible isolated-cluster pressure, budget, queue, timeout, release, and no-deletion evidence.
- `server/src/computer/capacity.ts`, `server/src/openmuse-tasks/capacity.ts`, `server/src/billing/capacity.ts`, and `server/src/enterprise/tenancy/resource-policy.ts` are reference implementations, not authorities to duplicate: current computer admission is process-local count/idle logic; task workers are process-local slots; billing capacity is credit capacity; resource policy is authorization, not kernel quota.
- Current coding facts are also non-authorities for OpenShell: `agent-sandbox/src/env.ts` parses `SANDBOX_DEVSERVER_MAX` default 8, `bot-runtimes.ts` exposes `getOrSpawn/markActivity/reapIdle/stopBot/listRuntimes/startDevServer`, and `devserver.ts` explicitly refuses rather than queues. Regression tests must keep that legacy behavior unchanged.

**Produced for T08/T16:**

- `OpenShellResourceAmount = { cpuMilli: number; memoryBytes: number; storageBytes: number }`.
- `OpenShellCapacityLimits = { perSandbox: Record<"computer" | "coding", OpenShellResourceAmount>; perEnvironment: Record<"computer" | "coding", OpenShellResourceAmount>; deployment: OpenShellResourceAmount; queue: { waitTimeoutMs: number; maxQueuedPerEnvironment: number; fairness: "two-lane-round-robin-v1" } }`.
- `OpenShellCapacityRequest = { idempotencyKey: string; scope: OpenShellScope; amount: OpenShellResourceAmount; waitTimeoutMs: number }`; the request amount must equal the configured envelope for `scope.environment`.
- `requestAdmission(request: OpenShellCapacityRequest): Promise<OpenShellReservationTicket>`, throwing typed `OpenShellCapacityQueueFullError` or `OpenShellCapacityTimeoutError`. A ticket contains `reservationId`, `admissionSequence`, `queueWaitedMs`, scope, and amount.
- `markStarted(reservationId: string, handle: { providerId: string; generation: string; storageVolumeId: string | null }): Promise<void>`.
- `markStopped(reservationId: string): Promise<void>` releases CPU/memory while retaining the storage reservation.
- `release(reservationId: string, reason: "start_failed" | "cancelled" | "reset" | "terminated", evidence?: { storageDeleted: boolean }): Promise<void>`.
- `reconcile(actual: readonly OpenShellRuntimeFact[]): Promise<void>`, where each fact contains scope, provider ID, generation, `running | stopped | absent`, amount, and storage volume ID.
- `status(query?: { scope?: OpenShellScope; environment?: "computer" | "coding" }): Promise<OpenShellCapacityStatus>` returns limits, aggregate and per-environment use, queue entries with position/deadline, reservation states, and fairness text. Status never wakes a sandbox.
- `describeOpenShellFairness(): { id: "two-lane-round-robin-v1"; rule: "Eligible starts alternate between computer and coding by oldest last-admission sequence; each lane is FIFO, and a non-fitting lane is skipped without losing its turn." }` is the stable rule consumed by T16 documentation and UI.

---

### Task 1: Resource Envelopes, Verified Storage Gate, and Chart Backstop

**Files:** Create `server/src/openshell/resources.ts`; create `server/tests/openshell-capacity-config.test.ts`; create `server/tests/openshell-chart-resources.test.ts`; modify `server/src/config.ts`; modify `charts/openbot/values.yaml`; create `charts/openbot/templates/openshell/resource-quota.yaml`; modify `charts/openbot/README.md`.

**Interfaces:** Produces `parseOpenShellCapacityConfig(input: unknown): OpenShellCapacityLimits`, `sameOpenShellResourceAmount(left: OpenShellResourceAmount, right: OpenShellResourceAmount): boolean`, and `describeOpenShellFairness()`. Configuration is required in OpenShell mode and absent in every legacy mode. Storage driver identity must match the verified T01 capability report; the parser rejects a PVC-only claim.

- [ ] **Step 1: Verify blocking interfaces and storage capability.** Re-read #736/#747/#737 and the verified T02/T03 run evidence. In an isolated cluster pinned to T01's OpenShell/controller/CNI/storage/kernel versions and digests, create small test workloads and prove CPU throttling, memory allocation failure, and a write refusal at the selected persistent-storage quota. Record commands, versions, image digests, storage class/driver, Pod cgroup and volume facts, sentinel bytes, owner labels, and failures under `.archive/runs/<run-key>/verification/T13-capability/`. If per-volume persistent write quota cannot be enforced, mark T13 blocked; do not render a PVC request as a hard quota.
- [ ] **Step 2: Write failing config/chart tests.** Add 12 named cases: four parse/aggregate validations, three invalid/partial/default-evidence refusals, two separate environment-envelope assertions, one ResourceQuota assertion, one assertion that PVC request alone cannot select the storage driver, and one legacy-render snapshot. Use test-only resource values, not production defaults.
- [ ] **Step 3: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T13-task1-red e2e run --config e2e.unit.config.ts server/tests/openshell-capacity-config.test.ts server/tests/openshell-chart-resources.test.ts` — expected 12 collected, 12 failed, 0 skipped because the module and OpenShell quota template do not exist.
- [ ] **Step 4: Implement the minimal pure parser and chart backstop.** Render one namespace ResourceQuota whose `requests.cpu`, `limits.cpu`, `limits.memory`, and `requests.storage` equal the deployment budget, plus separate exact workload CPU/memory limits and the verified storage-quota fields. Fail rendering when environment budgets exceed deployment budgets or the measured-default evidence reference is absent.
- [ ] **Step 5: Run GREEN and focused checks.** Repeat the e2e command with `T13-task1-green`; expected 12 collected, 12 passed, 0 skipped. Run `cd server && bun run typecheck`, `helm lint charts/openbot`, and `helm template charts/openbot --set computers.mode=shared` to prove legacy output is unchanged.
- [ ] **Step 6: Commit.** Commit only this task's files with `feat: add OpenShell capacity resource contracts`.

### Task 2: Durable Bounded Queue and Reservation Ledger

**Files:** Create `server/src/db/schema/openshell-capacity.ts`; create `server/drizzle/0237_openshell_capacity.sql`; create `server/src/openshell/capacity.ts`; create `server/tests/openshell-capacity.test.ts`; create `server/tests/openshell-capacity.integration.test.ts`; modify `server/src/db/schema` only through its existing export aggregation if required.

**Interfaces:** Consume `OpenShellCapacityLimits` from Task 1. Produce the `OpenShellCapacityCoordinator` methods listed in the dependency contract. Rows retain `queued`, `reserved`, `starting`, `active`, `stopped_storage_held`, `pending_reconcile`, and terminal `released` history; a unique idempotency key returns the same live ticket. Promotion expires due rows first, locks the capacity key, reads ledger plus supplied actual facts, and selects the oldest fitting request from the environment lane with the older last-admission sequence.

- [ ] **Step 1: Write failing unit/integration tests.** Use isolated `TEST_DATABASE_URL` data. Cover 12 cases: queue-full, timeout, per-lane FIFO, round-robin starvation prevention, concurrent multi-client admission, duplicate idempotency, environment aggregate, global aggregate, stop retaining storage, reset releasing storage, failed-start release, and pending reconcile/status visibility. Assert typed queue/timeout errors expose depth, position, deadline, environment, and fairness ID.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T13-task2-red e2e run --config e2e.unit.config.ts server/tests/openshell-capacity.test.ts server/tests/openshell-capacity.integration.test.ts` — expected 12 collected, 12 failed, 0 skipped for missing schema/coordinator.
- [ ] **Step 3: Implement schema and coordinator.** Use one transaction/advisory lock for check-and-promote, database time for deadlines, retained history for fair sequencing, and inventory-aware sums. No provider call belongs in this task. A reservation can be released only by its owner transition or reconciliation result; provider ambiguity is `pending_reconcile`, never success.
- [ ] **Step 4: Run GREEN and migration checks.** Repeat the e2e command with `T13-task2-green`; expected 12 collected, 12 passed, 0 skipped. Apply the migration to the isolated database, inspect the table/index/constraints, run `cd server && bun run typecheck`, and clean only rows/resources owned by this test run.
- [ ] **Step 5: Commit.** Commit only this task's files with `feat: add durable OpenShell capacity queue`.

### Task 3: Integrate Both Verified Environment Adapters

**Files:** Create `server/src/openshell/runtime-inventory.ts`; modify `server/src/computer/openshell.ts`; modify `server/src/codesandbox/openshell.ts`; modify `charts/openbot/templates/computer/sandbox-template.yaml`; modify `charts/openbot/templates/openshell/coding-sandbox.yaml`; test in `server/tests/openshell-capacity-integration.test.ts`, `server/tests/computer-capacity.test.ts`, `agent-sandbox/tests/env.test.ts`, `agent-sandbox/tests/bot-runtimes.test.ts`, and `agent-sandbox/tests/devserver.test.ts`.

**Interfaces:** Consume the actual verified #736 computer startup/stop/reset/list contract and #737 coding startup/stop/reset/event contract through `OpenShellRuntimeFact` and their existing scope/generation types. Produce `createOpenShellRuntimeInventory(computer: ComputerOpenShellAdapter, coding: CodingOpenShellAdapter): { list(): Promise<OpenShellRuntimeFact[]> }`. Both providers must call `requestAdmission` before OpenShell mutation, then `markStarted`; every caught start failure invokes idempotent cleanup limited to the new request and then `release(..., "start_failed")`.

- [ ] **Step 1: Write failing integration and regression tests.** Cover 14 new cases: computer and coding queue-before-start, no start after timeout, both inventories counted, untracked same-namespace workload blocks admission, active task receives no stop/reset during contention, failed-start cleanup/release order, duplicate startup idempotency, stopped storage retention, reset release, route-visible status/error, two-replica concurrency, old computer capacity behavior, legacy `SANDBOX_DEVSERVER_MAX` refusal behavior, and unchanged shared `agent-sandbox` startup.
- [ ] **Step 2: Run RED.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T13-task3-red e2e run --config e2e.unit.config.ts server/tests/openshell-capacity-integration.test.ts server/tests/computer-capacity.test.ts agent-sandbox/tests/env.test.ts agent-sandbox/tests/bot-runtimes.test.ts agent-sandbox/tests/devserver.test.ts` — expected 62 collected, 14 failed, 48 passed, 0 skipped: the 14 new cases fail and the current 25 computer-capacity, 4 env, 10 bot-runtime, and 9 devserver regression cases pass.
- [ ] **Step 3: Implement read-only inventory and provider wiring.** Normalize both actual adapters without exposing control-plane credentials. Reconcile before promotion, preserve existing volumes on stop, and release storage only after reset/delete evidence. Keep old modes and shared agent-sandbox behavior untouched.
- [ ] **Step 4: Run GREEN.** Repeat the e2e command with `T13-task3-green`; expected 62 collected, 62 passed, 0 skipped. Run `cd server && bun run typecheck`.
- [ ] **Step 5: Commit.** Commit only this task's files with `feat: enforce OpenShell capacity across sandboxes`.

### Task 4: Isolated-Cluster Hard-Limit, Budget, Queue, and Release Acceptance

**Files:** Create `scripts/openshell-capacity-acceptance.ts`; create `tests/openshell/capacity-hard-limits.e2e.test.ts`; modify `charts/openbot/values.yaml`; modify `charts/openbot/README.md`; add no product fallback beyond the measured values.

**Interfaces:** Exercise the authenticated T02 computer and T03 coding entries, not adapter-only methods. The acceptance script emits a machine-readable matrix containing source SHA/dirty check, cluster and namespace owner, Helm/chart/config identity, OpenShell/controller/CNI/storage/kernel/image digests, per-test resource observations, queue events, release result, cleanup receipt, and evidence hashes.

- [ ] **Step 1: Write the failing live suite.** Define exactly 16 cases: four CPU proofs, four memory proofs, four storage proofs, one two-environment aggregate, one deployment aggregate/ResourceQuota race, one queue timeout/fairness/no-eviction, one start-failure release, and one legacy-mode regression. Storage cases must create login/workspace sentinels before filling the volume and compare bytes afterward.
- [ ] **Step 2: Run RED in the isolated cluster.** `E2E_UNIT_OUTPUT=.e2e/<run-key>/T13-task4-red e2e run --config e2e.unit.config.ts tests/openshell/capacity-hard-limits.e2e.test.ts` — expected 16 collected, 16 failed, 0 skipped before measured defaults and full enforcement are applied. If the environment is unavailable, record the keyed blocker; do not replace it with mocks.
- [ ] **Step 3: Calibrate and apply measured values.** Choose values that leave safe headroom for Chromium/OpenCode/preview, prove each limit in both environments, set queue wait/depth from observed startup and contention, and write those exact values and archive evidence digest into chart defaults and documentation. Re-run RED if any production value changed after the first observation.
- [ ] **Step 4: Run GREEN and full affected verification.** Repeat the e2e command with `T13-task4-green`; expected 16 collected, 16 passed, 0 skipped. Also run Task 1–3 suites, `cd server && bun run typecheck`, `helm lint charts/openbot`, and both OpenShell/legacy `helm template` comparisons. Inspect every created Pod/PVC/ResourceQuota/namespace/test row and remove only resources owned by this run.
- [ ] **Step 5: Independent acceptance, Review, and OCR.** Copy the final live report, command/exit receipts, versions/digests, output manifest/hash, and cleanup receipts to `.archive/runs/<run-key>/verification/`. A fresh reviewer verifies #747 and A08 against that evidence and code; complete Spec/quality review and applicable OCR under `.archive/runs/<run-key>/reviews/` and `.archive/runs/<run-key>/ocr/`. Any valid medium-or-higher finding, skipped live case, storage-quota gap, budget overshoot, reservation leak, eviction, or data mutation fails T13.
- [ ] **Step 6: Commit.** Commit only this task's files with `test: prove OpenShell resource hard limits`.

## Independent Acceptance Mapping

| Gate | Evidence |
| --- | --- |
| #747 real write, CPU, and memory pressure prove hard limits | Task 1 capability gate plus Task 4 CPU/memory/storage cases for both environment types; Task 2/3 mocks never substitute. |
| #747 concurrent requests do not exceed total budget | Task 2 concurrent SQL admission, Task 3 two-replica/inventory integration, and Task 4 real aggregate plus ResourceQuota race. |
| #747 queue wait/timeout is visible and fairness is explicit | Task 2 typed errors/status and round-robin tests, Task 3 route-visible integration, Task 4 real queue/no-eviction case; rule is `two-lane-round-robin-v1`. |
| #747 startup failure releases reserved resources | Task 2 release/reconcile, Task 3 ordered cleanup/release, and Task 4 injected failed start with no remaining workload, claim, or reservation. |
| A08 hard limits actually work | Task 1 chart/config plus Task 4 live pressure; PVC-only output is explicitly rejected. |
| A08 two types and deployment total budget | Task 1 separate envelopes/aggregates, Task 2 admission math, Task 3 both adapters, Task 4 real two-environment test. |
| A08 queue/timeout without eviction, lower isolation, or deletion | Task 2/3 no-eviction and storage-retention tests plus Task 4 active-task and sentinel-byte cases. |

Blocked gates: #736/#737 not verified in the current workspace, a T02/T03 interface mismatch, unavailable isolated cluster/database, unverifiable per-volume storage quota, unmeasured defaults, or missing live/review/OCR evidence each keep #747 open. Do not close or relabel the Issue and do not perform GitHub writes without separate authorization.

## Self-Review

1. **Spec coverage:** D17 queue/budget/no-eviction and D24 hard limits/default evidence are each mapped to Tasks 1–4 and the acceptance table; A08 adds the explicit no-isolation-downgrade/no-data-deletion gate.
2. **Step scan:** Every task has a preflight or failing-test step, exact file responsibility, named behavior, exact e2e command, expected collected count, GREEN gate, and commit boundary; no step depends on inventing a default.
3. **Type consistency:** `OpenShellResourceAmount`, `OpenShellCapacityLimits`, request, ticket, handle, runtime fact, release reason, status, and fairness IDs use the same names across Tasks 1–4 and the T08/T16 contract.
4. **Review Focus:** All five failure modes map to at least one deterministic test and one live acceptance case, including storage sentinel preservation and active-task non-eviction.
5. **Proportion:** The plan fixes contracts, ownership, tests, and evidence rather than transcribing implementation; four tasks are each independently rejectable and separately verifiable.
