# T12 Controlled File Transfer Between Sandboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy one authorized file between the same execution owner's computer and coding sandboxes without mounting a shared directory or exposing browser credentials.

**Architecture:** An OpenBot transfer service authenticates the user, resolves both environment generations under the same full execution scope, writes a T05 intent, streams through a bounded server-side staging object, and verifies a destination receipt. The adapters provide confined file reads/writes; they never accept a client-supplied sandbox URL or raw host path.

**Tech Stack:** Bun/TypeScript, OpenBot routes and audit store, OpenShell adapters from T02/T03, e2e runner, isolated Kubernetes deployment.

**Spec:** [approved Spec v1](../../specs/2026-10-30-openshell-sandbox.md) D7, D10, D13, D15, A02, A05, A07; [ADR 0013](../../adr/0013-openshell-sandbox-substrate.md); [ticket breakdown](ticket-breakdown.md) T12.

**Issue:** published as [#746](https://github.com/1123786563/OpenBot/issues/746) (parent Spec [#734](https://github.com/1123786563/OpenBot/issues/734), label `ready-for-agent`, Blocked by [#738](https://github.com/1123786563/OpenBot/issues/738), [#739](https://github.com/1123786563/OpenBot/issues/739), [#740](https://github.com/1123786563/OpenBot/issues/740) and [#741](https://github.com/1123786563/OpenBot/issues/741)). Its three acceptance items map to Task 3 (same-owner file transfers successfully in both directions), Task 1/Task 2 (traversal, link bypass and cross-Bot/team/environment authorization refused) and Task 2 (retry idempotency; audit result matches the actual file state). `ready-for-agent` is not implementation authorization; re-ingest #746 and the approved fact sources first.

## Global Constraints

- T04, T05, T06 and T07 must be verified first. Resolve their current execution handle, authenticated route, audit intent, stop/start and reset contracts before implementation; do not invent a direct OpenShell user entry.
- Execution identity is tenant + workspace + Bot + environment + generation, not `botId` alone. Recheck both ends immediately before commit of a copied file; stale generations fail.
- Computer profile, cookies, browser state, control files, symlinks and special files are excluded from ordinary transfer. The source must be a regular file beneath a designated export root; the destination must be beneath a designated import root.
- Authorize both direction and paths; use no shared mount. Keep the existing modes' behavior and all browser sign-in stores unchanged.
- No transfer is successful on intent or upload alone; it requires a durable result and matching destination content. Preserve source; partial destination must be absent or visibly pending.

## Review Focus

1. `../` and absolute path attempts must be refused before any sandbox file access; Task 1 tests them.
2. Symlink, hardlink, mount or path swap after validation must not escape the confined root; Task 2 tests actual filesystem behavior.
3. A computer profile path disguised as an export must fail; Task 1 and Task 3 test it.
4. Concurrent reset or generation change must leave no successful cross-generation copy; Task 2 tests it.
5. Retry after a lost response must return one stable result without duplicate or partial file; Task 2 tests it.

---

### Task 1: Transfer request and scope contract

**Files:** Create `server/src/openshell/file-transfer.ts` and `server/tests/openshell-file-transfer.test.ts`; add a route in the authenticated route owner established by T04 (likely `server/src/computer/routes.ts` or the coding service route, decided by the current T04 contract). Do not attach this to `server/src/codesandbox/gateway.ts` if T03 uses the Craft OpenCode path instead.

**Interfaces:** Produce `TransferRequest = { source: "computer" | "coding"; destination: "computer" | "coding"; sourcePath: string; destinationPath: string; idempotencyKey: string }` and `transferFile(actor: AuthenticatedActor, execution: ExecutionTarget, request: TransferRequest): Promise<TransferResult>`. `AuthenticatedActor` and `ExecutionTarget` must be the actual T04/M09 types; map at the route, never trust body identity. `TransferResult` has `status: "copied" | "pending_reconciliation"` and `transferId: string`.

- [ ] **Step 1: Write failing route tests** for authorized same-scope request, other Bot, other workspace, other tenant, mismatched direction, absolute/`..`/encoded traversal, and profile/cookie path. Assert every refusal leaves both filesystem adapters untouched and returns a stable forbidden/invalid response without leaking real paths.
- [ ] **Step 2: Run RED:** `e2e run --config e2e.unit.config.ts server/tests/openshell-file-transfer.test.ts`. Expect the named tests to fail for the missing route/service.
- [ ] **Step 3: Implement request parsing and dual-end authorization** using T04's real actor resolution and M09's scope-bound handles. Define fixed export/import roots for each environment; use path components rather than string prefix checks. Add the route without exposing adapter URLs/tokens.
- [ ] **Step 4: Run GREEN** with the same command, count collected cases, then commit this task's files.

### Task 2: Atomic confined copy and idempotent outcome

**Files:** Extend `server/src/openshell/file-transfer.ts`; modify T02/T03's confined file adapters at their actual paths; add `server/tests/openshell-file-transfer-atomic.test.ts`. Reuse T05's durable operation ledger instead of creating a second audit authority.

**Interfaces:** Each adapter must offer a generation-bound `readRegularFile` stream and `writeAtomicFile` operation confined to its own root; expose size, SHA-256 and generation receipts, not arbitrary host filesystem methods. The transfer service uses `(execution scope, idempotencyKey)` as its stable operation key; same key with different request is conflict.

- [ ] **Step 1: Write failing tests** for symlink/hardlink/TOCTOU swap, special file, oversized file, content hash mismatch, reset during transfer, retry with same key, retry with different payload, destination write failure and audit failure. Assert no final destination after any failure or unknown; source remains untouched. For audit outage ordinary transfer refuses before reading.
- [ ] **Step 2: Run RED:** `e2e run --config e2e.unit.config.ts server/tests/openshell-file-transfer-atomic.test.ts`. Expected: named boundary/idempotency cases fail.
- [ ] **Step 3: Implement bounded streaming** with descriptor-relative or equivalent container-confined file APIs verified on the selected filesystem. Never follow links; stage under destination root, verify digest and generation, then atomically rename. Persist T05 intent before side effects and result after receipt; after lost receipt reconcile destination by operation ID/hash before retry. A platform lacking safe confined file operations is a stop condition, not permission to use `realpath` once and hope.
- [ ] **Step 4: Run GREEN** and inspect report cases/skips. Commit only authorized files.

### Task 3: Live two-environment acceptance

**Files:** Add `tests/openshell/file-transfer.e2e.test.ts` in the T04 live harness; update user-facing copy at the route/UI location only if T04's established flow requires it, following `openbot-copy`.

**Interfaces:** Test through the authenticated OpenBot entry, with two actual isolated sandboxes. The computer profile and coding workspace remain on separate volumes.

- [ ] **Step 1: Write the live test** that copies a known file coding→computer and computer→coding, compares byte hash and scope/generation receipts, then tries cross-Bot, cross-team, profile, traversal and symlink paths. Reset one environment during a transfer and assert no success/foreign data; repeat the same operation key after a simulated lost response.
- [ ] **Step 2: Run RED and GREEN** in the isolated Kubernetes harness, setting `E2E_UNIT_OUTPUT=.e2e/<run-key>/T12-<attempt>`; require actual collected cases and no unexplained skip. Verify no shared writable mount by inspecting both Pod specs and runtime mount namespaces, not only configuration text.
- [ ] **Step 3: Run the T04/T06/T07 affected regression suites, server typecheck and focused lint.** Obtain independent behavior/Spec/quality review and OCR. Keep T12 blocked if file confinement, idempotency or actual isolation cannot be proved; archive evidence under the current run.
