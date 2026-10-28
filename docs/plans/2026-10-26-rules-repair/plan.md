# Agent Rules Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This documentation-only repair uses the repository's current-workspace documentation exception, with independent whole-change review and OCR; no Issue implementation pipeline is started.

**Goal:** Close RR-01–RR-13 while preserving authorization, independent review and current-target delivery gates.

**Architecture:** Separate frozen audit observations from current-target delivery; separate withdrawals from positive attestations; make queue fairness and adapter operations explicit. Upgrade the strict coordination contract to schema v2 without splitting the existing lock namespace or claiming a deployed adapter.

**Tech Stack:** Markdown, JSON Schema draft 2020-12, protocol fixtures; temporary Python validation tooling, no application runtime changes.

**Spec:** [Authorized audit](../../../.archive/runs/2026-10-26-rules-audit-365e6252/review.md), user request “按照上述进行修复”.

## Global Constraints

- Fix all 13 findings; no Issue/PR writes, commits, pushes, deployment, shared-state migration or production-code changes.
- Preserve complete independent review/OCR for each final delivery scope at its actual target SHA; an epoch does not authorize stale labels or closure.
- Use one serial workspace and uncommitted snapshots; reports and checkpoints go to this Run's absolute archive_root, recorded in its Ledger.
- Existing coordination_root remains unchanged during a schema upgrade. A v1 adapter cannot silently consume v2; migration requires all participants compatible and safe state conversion.
- Normative protocol examples are versioned under tests/config; test outputs and temporary reference checks are archived. Examples do not constitute a deployed adapter.

## Review Focus

- Daily main movement must not destroy frozen child progress; related changes still require new behavior evidence before delivery.
- Withdrawing a known invalid label must work with incomplete requirements, but must not overwrite a later human decision.
- Continuously available old tickets must not monopolize their class; retry deadlines must trigger probes without bypassing missing authorization.
- Different relation snapshots, duplicate logical keys and same request ID with different payloads must fail closed.
- v1 migration, raw canonical JSON bytes and pending human-review retention must be unambiguous.

### Task 1: Close audit, delivery and scheduling contracts

**Depends on:** none. **Owner:** current documentation editor. **Validator:** independent reviewer.
**Files:** .agents/rules/delivery-gates.md, closed-issue-audit.md, closed-issue-daily-run.md, execution.md, artifacts.md; synchronize review.md only where its references need clarification.
**Interfaces:** consumes RR-01–05, RR-11–13; produces audit_epoch, queue_turn/queue_tail, retry_count, pending-action set A, withdrawal intents and retention lifecycle.

- [ ] Define frozen epoch observations and final aggregate/current-target gates; carry forward only demonstrably unaffected behavior evidence, with fresh full final review/OCR and actual-target CI.
- [ ] Define minimal withdrawal preconditions and postconditions independently of positive attestation completeness.
- [ ] Add A for all pending close/label actions; use round-robin classes and monotonic per-ticket queue turns; separate hard waits, retry probes and meaningful condition changes.
- [ ] Replace temporal document exception with stable scope/risk rules; define pending/completed/reopened human-review retention.
- [ ] Verify original counterexamples against the new text and record per-finding mapping. Failure: reconcile contracts before proceeding.

### Task 2: Specify and encode coordination v2

**Depends on:** Task 1 field names frozen. **Owner:** current documentation editor. **Validator:** independent reviewer.
**Files:** .agents/rules/coordination-state.md, coordination-format.md, coordination-schema.json; create coordination-inputs.md and tests/config/agent-coordination-v2.json.
**Interfaces:** consumes Task 1 fields; produces schema_version=2, requirements-v2, daily-input-v2, openbot-json-v1, typed relation snapshot, claim updates and request hash binding.

- [ ] Define the single canonical byte algorithm, exact input shapes/order and fixed vectors; keep target SHA outside the waiting fingerprint but persist it for delivery checks.
- [ ] Add relationship snapshot contract, cross-version rejection, renew/update_claim operations, legal transitions and immutable ownership fields.
- [ ] Bind request IDs to canonical payload/owner/version; define stable-key uniqueness, file/repository binding and semantic checks beyond JSON Schema.
- [ ] Add queue/epoch/retry fields and explicit v1 migration rules; keep the same registry.guard and root. Unverifiable legacy fields remain blocked, never invented.
- [ ] Create valid examples and negative mutation cases, including distinct same-key records. Verify schema syntax and contracts using temporary validator/reference checks; no service implementation claim.

### Task 3: Validate and independently review the complete uncommitted change

**Depends on:** Tasks 1–2 integrated. **Owner:** current coordinator. **Validator:** fresh independent reviewer and OCR.
**Files:** authorized diff only; reports/checkpoints under the Run's archive_root.
**Interfaces:** consumes exact manifest/hash; produces verification evidence, RR acceptance mapping, independent Spec/quality verdict and OCR scope reconciliation.

- [ ] Validate schema and all fixture cases, canonical byte/hash vectors, scheduling/retry counterexamples and local Markdown links; run git diff --check. Expected: all targeted checks pass.
- [ ] Freeze complete manifest and uncommitted diff including new files; run sensitive-content review before provider input.
- [ ] Dispatch a clean-context independent reviewer using the audit, this plan and the frozen change; resolve all valid blocking findings and revalidate changed content.
- [ ] Run open-code-review workspace mode with --audience agent, business background and archived output; reconcile actual coverage with the manifest. Resolve findings within the authorized documentation scope and rerun as needed.
- [ ] Preserve changes uncommitted and report actual verification/review state, migration limits and any external-tool blocker. No cleanup of evidence or shared state.
