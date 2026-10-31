# T11 Temporary Network Grant Expiry and Strong Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End temporary grants at the earlier of task completion or expiry and prove that revocation closes established connections in both OpenShell environments.

**Architecture:** OpenBot remains the grant authority. A serialized, generation-bound reconciliation operation removes a grant from the desired policy, obtains a receipt for the *final effective* OpenShell policy, and checks established connections. If either proof fails, stop and quarantine the affected sandbox before reporting containment; never report a successful in-place revocation on a policy write alone.

**Tech Stack:** Bun/TypeScript server, Postgres, OpenShell Kubernetes adapter from T09/T10, e2e test runner, isolated Kubernetes test cluster.

**Spec:** [approved Spec v1](../../specs/2026-10-30-openshell-sandbox.md) D5, D11–D12, D15–D16, A06–A07; [ADR 0013](../../adr/0013-openshell-sandbox-substrate.md); [ticket breakdown](ticket-breakdown.md) T11.

**Issue:** published as [#745](https://github.com/1123786563/OpenBot/issues/745) (parent Spec [#734](https://github.com/1123786563/OpenBot/issues/734), label `ready-for-agent`, Blocked by [#743](https://github.com/1123786563/OpenBot/issues/743) and [#744](https://github.com/1123786563/OpenBot/issues/744)). Its four acceptance items map to Task 3 (TCP keep-alive and WebSocket/stream connections actually cut; no bytes on old sockets after revocation), Task 1 (`min(taskEndedAt, expiresAt)` wins), Task 2 (final effective policy and audit result checked), and Task 2/Task 3 (old connections cannot keep transferring after revocation completes). `ready-for-agent` is not implementation authorization; re-ingest #745 and the approved fact sources first.

## Global Constraints

- T09 and T10 must be verified in the execution workspace first. Inspect their actual grant, approval, policy adapter and audit interfaces before editing; update this plan's proposed names to those contracts without changing the Spec.
- OpenShell mode only; do not change the old deployment's network behavior. Scope keys include tenant, workspace, Bot, environment (`computer` or `coding`) and sandbox generation.
- An expiration timer is a prompt to reconcile, not evidence that access ended. Task end and expiry use the earlier timestamp; restart and clock drift must not revive an expired grant.
- T05's durable intent and emergency containment record are mandatory; network tightening must run during central audit failure and reconcile its result later.
- Existing `server/src/computer/policy-network.ts` pushes an asynchronous computer policy and `NO_NETWORK_POLICY` allows all; neither is a strong-revocation proof for OpenShell.
- Use the e2e runner as the canonical test entry. Live evidence must identify source tree, OpenShell/controller/CNI versions and actual service revisions; store results under `.archive/runs/<run-key>/`.

## Review Focus

1. A concurrent grant update must not reintroduce a revoked destination; Task 2 tests serialized policy generation and final effective rules.
2. A provider-added allow rule must not override revocation; Task 2 tests the loaded *effective* policy, not only OpenBot's desired document.
3. A WebSocket or TCP keep-alive opened before revocation must stop transferring bytes; Task 3 tests both environments.
4. A lost control-plane reply must leave outcome unknown and contain the sandbox; Task 2 tests this failure.
5. Process restart between task completion and timer firing must still revoke; Task 1 tests durable due-grant scanning.

---

### Task 1: Durable expiry and task-end state

**Files:** Modify T09/T10's actual grant repository and task lifecycle hook after inspecting their contracts; add `server/tests/openshell-network-expiry.test.ts`. Avoid a second grant table or parallel authority. The final file map belongs in the run Ledger.

**Interfaces:** Consume T09/T10's durable grant ID, scope, expiry, task ID and status; produce `endTemporaryGrant(grantId: string, cause: "task_end" | "expired", now: Date): Promise<"due" | "already_ended" | "not_due">` and `listDueTemporaryGrants(now: Date): Promise<string[]>`. The return `due` means reconciliation is required, not that network access is gone.

- [ ] **Step 1: Write failing tests** asserting `min(taskEndedAt, expiresAt)` wins, a duplicate end is idempotent, an unrelated task cannot end another scope's grant, and a new process lists a persisted overdue grant. Use the real T09/T10 repository fixture; do not mock persistence for the restart case.
- [ ] **Step 2: Run RED:** `e2e run --config e2e.unit.config.ts server/tests/openshell-network-expiry.test.ts`. Expected: the named due/restart tests fail because the interface or durable transition is absent.
- [ ] **Step 3: Add the smallest durable transition and scanner** at the existing grant owner. Serialize status changes with its existing transaction/unique key; reject invalid scope and expired extensions unless a new approved grant exists. Wire task completion and a restart-safe due scanner to request Task 2 reconciliation.
- [ ] **Step 4: Run GREEN:** the same e2e command; require all named cases collected and passed, with zero unexpected skips.
- [ ] **Step 5: Commit only this task's authorized files** with a message identifying temporary grant expiry.

### Task 2: Reconcile final policy and contain uncertainty

**Files:** Modify T09/T10 policy orchestration and their OpenShell adapter; add `server/tests/openshell-network-revoke.test.ts`. Reuse T05 audit intent/outcome rather than `server/src/audit.ts` as a substitute for durable operation state.

**Interfaces:** Produce `revokeTemporaryGrant(grantId: string, reason: "task_end" | "expired" | "admin", operationId: string): Promise<{ status: "revoked" | "contained" | "pending_reconciliation"; policyGeneration: string }>`; the OpenShell adapter must expose loaded policy generation, final effective destinations and established-connection outcome. If it cannot, Task 3's proof gate determines whether stop is the only valid implementation.

- [ ] **Step 1: Write failing tests** for concurrent approve/revoke, provider-added allow, duplicate operation ID, policy timeout, stale loaded generation, central audit outage, and a failed emergency stop. Assert `revoked` only after the target is absent from final effective rules and old connections are closed; `contained` only after verified stop; otherwise `pending_reconciliation` with access blocked at OpenBot.
- [ ] **Step 2: Run RED:** `e2e run --config e2e.unit.config.ts server/tests/openshell-network-revoke.test.ts`. Expected: explicit failed assertions for final-policy/containment behavior.
- [ ] **Step 3: Implement generation-serialized reconciliation** against the actual T09/T10 authority, write T05 intent before normal operation, and use T05's recoverable emergency record when audit is down. A stale receipt cannot complete a newer generation. If final-policy or connection evidence is unavailable, stop the affected generation, verify stopped state, and retain unknown outcome until evidence exists.
- [ ] **Step 4: Run GREEN:** same command, inspect report counts and skipped cases. Commit this task's authorized files.

### Task 3: Prove established connection termination on the selected stack

**Files:** Add `tests/openshell/network-revocation.e2e.test.ts` or the live harness path established by T09/T10; add only the test fixtures needed for a controlled TCP echo server and WebSocket server. Keep secrets and raw traces in the run archive.

**Interfaces:** Exercise OpenBot's authorized network approval/revoke entry and the actual OpenShell sandbox; no direct adapter-only assertion counts as acceptance.

- [ ] **Step 1: Before product code, spike the selected OpenShell/controller/CNI combination.** Hold TCP keep-alive, WebSocket and streaming HTTP sessions from *each* environment. Remove the allow, inspect `Loaded` and final effective policy, and attempt further bytes on the same sockets. Also race an additional provider rule. Record commands, version/digest, packet evidence and deadline in the run archive.
- [ ] **Step 2: Stop condition:** if the selected stack cannot reliably prove old sockets closed, choose verified stop of the affected sandbox generation as the revocation mechanism. If neither old-socket closure nor verified stop is possible, mark T11 blocked and do not implement/report strong revocation. A guessed OpenShell API or policy-setter success is not evidence.
- [ ] **Step 3: Write the failing live test** through OpenBot for both environments, expiry, task end, manual revoke, concurrent rule and audit outage. Require connection refusal or confirmed stop *before* the API returns `revoked`/`contained`; assert the UI reports interruption, never success on unknown.
- [ ] **Step 4: Run RED then GREEN** with the isolated cluster and T09/T10's actual live e2e command, supplying an `E2E_UNIT_OUTPUT` under `.e2e/<run-key>/T11-<attempt>/`; RED must expose the missing behavior, GREEN must show actual collected cases and packet result. Never use a shared cluster/project without the testing-rule ownership check.
- [ ] **Step 5: Run related T09/T10 network suites, server typecheck and focused lint; obtain independent behavior/Spec/quality review and full-scope OCR** under `review.md`, then commit authorized files. Any unresolved medium-or-higher finding or unproven old connection keeps T11 unverified.
