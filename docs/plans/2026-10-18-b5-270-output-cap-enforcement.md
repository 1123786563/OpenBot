# Bifrost 07.7 Provider Output-Cap Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Output caps are not only carried per request (07.6) but enforced-and-verified per enabled model × call-method, with structured, reproducible evidence; cells without evidence are refused before dispatch, and a provider exceeding the cap can never book unreserved cost.

**Architecture:** A new evidence module (`outputcapevidence.go`) in the governance plugin defines the closed-vocabulary enforcement record (provider, model, call method, mechanism, environment, result, detail, verified-at, source), validates it fail-closed, gates the reserve path on it (the module's enforcement seam in `reserveBeforeDispatch`), exports a snapshot for 22.3 conformance, and clamps post-hook booked usage to the attested cap (AC4). The per-attempt cap rides `CreditReservation` from PreLLM to PostLLM.

**Tech Stack:** Go (governance plugin), testify; no schema/DB changes.

**Spec:** docs/tickets/bifrost-5/issues/07.7-provider-output-cap-enforcement.md (+ parent spec AC06, Q11/Q20; ADR 0001/0003; CONTEXT.md Provider Bounds)

## Global Constraints

- Fail-closed: absence of a verified record is refusal, never enablement; verification results are never fabricated (no real-provider environment → cells stay "unverified"/absent → refused).
- Estimates never become evidence; the only output mechanism in the closed vocabulary is `provider_max_tokens` (07.6 kinds, reused).
- Free work (explicitly-free pricing) is out of the credit gate's scope, exactly as in 07.6: no reserve, no evidence requirement, no cost to bound.
- Refusals reuse the existing short-circuit shape: `DecisionCreditReserveNotHeld` + `cap_not_provable`, naming the model and a caller-actionable cause, never credentials/account data.
- Write scope: the output-cap evidence module in `plugins/governance` + Go tests/fixtures; the module's enforcement seams (`reserveBeforeDispatch`, `CreditReservation`, `PostLLMHook`/`postHookWorker`) are part of the module.
- No git commit/push/stash; git status stays uncommitted; checkpoints recorded in the ticket + `.omc/reports/b5-270.md`.

## Review Focus

- A model verified for one call method must not be callable under another (cell = model × call method, not model alone).
- A record with any missing/unknown field is not evidence — it must refuse, not crash or pass.
- A provider reporting usage above the cap must book at most the capped cost, both on success and on BilledUsage-on-error; legitimate usage under the cap must still book in full (no under-billing of honest calls).
- The clamp must apply only to reserved (strict-path) attempts; free/unknown-keyless paths keep today's behavior byte-for-byte.
- Refusal messages must be visible causes (model + recorded detail), never leak `ServiceSecret` or account data.

---

### Task 1: RED — evidence module tests (refusal, structure, unverified cells, snapshot)

**Files:**
- Create: `bifrost/plugins/governance/outputcapevidence_test.go`

**Interfaces:**
- Consumes: `newReserveTestPlugin`, `admissionWithReserve`, `reserveTestCtx`, `reserveChatRequest`, `reservePaidModel`, `reserveUnknownModel`, `reserveNegativeModel` (creditreserve_test.go fixtures); `boundWellFormedRequest` (boundevidence_test.go).
- Produces: `OutputCapEnforcementRecord{Provider, Model, CallMethod, Mechanism, Environment, Result, Detail, VerifiedAt, Source}`, `outputCapEvidenceResultVerified/NotEnforced/Unverified` constants, `outputCapEnforcementMechanism = "provider_max_tokens"`, `(p) OutputCapEvidenceSnapshot()`, `(p) outputCapEnforcementProblem(provider, model, requestType) string`, `CreditAdmissionConfig.OutputCapEvidence`.

- [ ] **Step 1: Write the failing tests**

1. `TestOutputCapGateRefusesModelWithoutEvidence` — admission enabled + reserve door, `OutputCapEvidence` armed for OTHER models only → `PreLLMHook` on a well-formed paid-model request short-circuits with code `cap_not_provable`, message names the model and says no output-cap enforcement evidence is recorded; the fake door is called 0 times; refused mark set. Sub-tests: a model verified only for call method `embedding` is refused for a chat call; an unknown call-method mapping is refused.
2. `TestOutputCapEvidenceRecordStructureIsClosedAndComplete` — table over invalid records (missing provider/model/callMethod/mechanism/environment/result/verifiedAt/source; unknown mechanism; unknown result; non-verified result without detail): each `evidenceProblem()` non-empty, and the gate refuses a cell armed only with that record. A complete verified record passes `evidenceProblem() == ""`.
3. `TestOutputCapEvidenceUnverifiedAndFailedCellsAreRefusedWithRecordedReason` — `unverified` (detail: no real-provider environment available) and `not_enforced` records: refused, `cap_not_provable`, refusal message carries the recorded detail.
4. `TestOutputCapEvidenceSnapshotCarriesVerificationFacts` — `OutputCapEvidenceSnapshot()` returns every configured record with environment/result/verifiedAt/source intact (22.3 input), and reflects live config.

- [ ] **Step 2: Run — verify RED**

Run: `cd bifrost/plugins/governance && GOTOOLCHAIN=go1.27.0 GOPROXY=off <go> test -run OutputCap .`
Expected: compile failure — `OutputCapEnforcementRecord`/`OutputCapEvidenceSnapshot`/`outputCapEnforcementProblem` undefined (feature missing, not typo).

### Task 2: GREEN — evidence module

**Files:**
- Create: `bifrost/plugins/governance/outputcapevidence.go`

- [ ] **Step 1: Implement the record, closed vocabularies, validation, snapshot, gate** (signatures above; gate scans `p.openBotCreditAdmission.OutputCapEvidence` under `cfgMutex.RLock`, key = (provider, model, `creditCapabilityForRequestType(requestType)`); "unknown" capability refuses; only `Result == verified` with valid structure passes).

- [ ] **Step 2: Run — verify GREEN for Task 1 tests** (same command; still expect failures only where the seam isn't wired yet — refusal tests should pass now via direct gate calls; PreLLMHook-level tests wait for Task 3).

### Task 3: GREEN — enforcement seams (gate into the funnel, cap on the reservation)

**Files:**
- Modify: `bifrost/plugins/governance/creditadmission.go` — `CreditAdmissionConfig` gains `OutputCapEvidence []OutputCapEnforcementRecord`; `CreditReservation` gains `OutputCapTokens int64`; `reserveBeforeDispatch` inserts the evidence gate after door-wiring checks and before `deriveBoundEvidence`, and stamps the reservation with the `provider_max_tokens` ceiling from the derived evidence.

- [ ] **Step 1: Write the failing funnel test first** (in outputcapevidence_test.go): `TestOutputCapGateRunsBeforeTheReserveDoorIsAsked` — no evidence → door 0 calls, `cap_not_provable`; with evidence → door receives boundEvidence with the request's cap and the reservation carries `OutputCapTokens`.
- [ ] **Step 2: Run — verify RED** (gate not consulted: door gets called / field missing).
- [ ] **Step 3: Implement the seam.**
- [ ] **Step 4: Run all evidence tests — GREEN.**

### Task 4: GREEN — AC4 clamp (provider exceeds cap → no unreserved cost booked)

**Files:**
- Create: clamp helper in `outputcapevidence.go`; test in `outputcapevidence_test.go`
- Modify: `main.go` — `PostLLMHook` reads `CreditReservation.OutputCapTokens` from ctx and passes it to `postHookWorker` (new final param, 0 = no clamp); `postHookWorker` clamps the success-path `ChatResponse.Usage` and the `BilledUsage` path to the cap before costing (clamped copy, provider-reported `Cost` cleared in the violated copy so cost recomputes from tokens), logging the violation.

- [ ] **Step 1: Write the failing behavior test**: fixture VK with budget+rate-limit, catalog with input+output rates for the paid model, evidence armed, fake credit door 201 → PreLLM passes → PostLLMHook with a fake-provider response reporting completion tokens above the cap → booked budget cost equals input×rate_in + cap×rate_out (excess contributes exactly zero), token counter equals clamped total; control case: usage under the cap books in full; provider-cost-carrying violating response does not book provider cost.
- [ ] **Step 2: Run — verify RED.**
- [ ] **Step 3: Implement clamp.**
- [ ] **Step 4: Run — verify GREEN.**

### Task 5: Fixtures + full verification

**Files:**
- Modify: `creditreserve_test.go` (`admissionWithReserve` arms verified chat evidence for the four fixture models), `boundevidence_test.go` (`admissionWithInputBound` same).

- [ ] **Step 1: Arm the shared fixtures** so every existing reserve-path test keeps its semantics (door pricing refusals stay door refusals).
- [ ] **Step 2: Full verification:**

```bash
cd bifrost/plugins/governance && GOTOOLCHAIN=go1.27.0 GOPROXY=off <go> test -run OutputCap .   # targeted
cd bifrost/plugins/governance && GOTOOLCHAIN=go1.27.0 GOPROXY=off <go> test .                  # whole package
cd bifrost/plugins/governance && GOTOOLCHAIN=go1.27.0 GOPROXY=off <go> test ./...              # module
cd server && bun run typecheck                                                                  # unaffected, must pass
bunx biome lint --error-on-warnings <changed files>                                             # Go files: nothing to lint
```

- [ ] **Step 3: Checkpoint + report** — `.omc/reports/b5-270.md` with AC evidence, file list, command outputs, hashes; ticket Checkpoint section filled; git status stays uncommitted.

## Self-Review

- Spec coverage: AC1 (verified-evidence-only dispatch, Task 3), AC2 (refusal + visible reason, Tasks 1/3), AC3 (structured record + snapshot with environment/result, Tasks 1/2), AC4 (clamp, Task 4) — covered. Produces: evidence for 22.3 (snapshot), unavailable-cell marking with reason (records + refusals), conformance input (snapshot export).
- Step scan: each step writes one test or one seam; no TBDs.
- Type consistency: record field names and result/mechanism constants defined once in Task 1 and used everywhere.
- Review Focus: five failure modes each pinned to a test in Tasks 1/4.
