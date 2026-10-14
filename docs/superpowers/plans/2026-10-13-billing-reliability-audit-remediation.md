# Billing Reliability 2026-10-13 Audit Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-10-13 · **Source:** the 2026-10-13 code-verified audit of `2026-10-11-billing-reliability-00` … `05` (all plan tasks verified implemented; seven residual issues found by reading code and running the named test suites).

**Goal:** Close the seven residual findings from the 2026-10-13 audit without re-opening the verified six-plan delivery, and fold in the overlapping open items from `2026-10-12-billing-ocr-round5-repair.md`.

**Architecture:** Keep the reservation/outbox/payment/reconcile seams as they are. Fixes are narrow: exact-arithmetic reads in the reconciler, a targeted conflict target in payment confirm, an expired-hold recovery policy, a capability-gated opening of billed admission, accurate usage source attribution, and documentation that matches verified behavior.

**Tech Stack:** TypeScript, Bun Test, Drizzle ORM, PostgreSQL, OCR.

**Spec:** `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Do not reimplement work verified by the 2026-10-13 audit; touch only the seams named per task.
- Append migrations; never edit an applied migration.
- Integration tests require an explicit, dedicated `TEST_DATABASE_URL`; never fall back to `DATABASE_URL`.
- The reconciler stays read-only. Expired-hold recovery is a writer-path concern (sweep/reserve-time), never a reconcile-time mutation.
- Keep integer/rational credit arithmetic end to end; no `Number()` rounding between the database and a money/credit comparison.
- No automatic refunds; duplicate collections remain operator-resolved.

## Relationship to existing repair plans

- `2026-10-12-billing-ocr-round5-repair.md` remains the owner of its open Items 2–5, 7–9 and the non-overlapping parts of Item 10. This plan **absorbs** Item 1 (expired-hold capacity, Task 3 below), Item 6's decision half (code-run billing semantics, Task 4 below), and Item 10's `maintenance.ts` stale-comment and `"web"`-literal bullets (Tasks 5–6 below). Mark those items as absorbed when this plan lands; do not execute them twice.
- The two fail-closed states recorded in `2026-10-12-billing-reliability-remediation-verification.md` §6 are inputs to Task 4's decision gate, not defects to silently undo.

## Finding ledger (2026-10-13 audit)

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | medium | Credit-identity sums read via `sql<number>` + `Number(...)`; plan 05 Task 5 explicitly required decimal strings + BigInt. Above 2^53 scaled units the comparison can pass or fail on rounding. | `server/src/billing/reconcile.ts:360-379` | **Fixed** — sums read as `::bigint` strings, compared as BigInt, findings print exact decimals; 2^53+1 split test in `billing-reconcile.integration.test.ts` |
| F2 | low | `COUNT(*)::int` on `usage_outbox` target counts overflows past 2^31 rows. | `server/src/billing/reconcile.ts:517-527` | **Fixed** — `COUNT(*)::bigint` + safe-integer guard (`exactCount`) that throws rather than rounds |
| F3 | low | `confirmPaid`'s paid-fact insert uses an untargeted `onConflictDoNothing`; a random `pe-` primary-key collision would be misread as "transaction already known" (~2^-64, but it is an unknown conflict being classified as a duplicate). | `server/src/billing/payments/store.ts` `confirmPaid` | **Fixed** — targeted conflict on the channel-transaction partial index; `pe-` pkey collision redraws via the bounded-retry loop (`isPaymentEventIdConflict`); collision test in `payment-store.integration.test.ts` |
| F4 | medium | Expired `reserved` holds occupy capacity until manual SQL; no release path exists (OCR round-5 Item 1, still open). | `server/src/billing/credits-writer.ts` (`held` subquery ignores `expires_at`), `reconcile.ts:469-498` (finding only) | **Fixed (option a)** — `held` subquery gains `r.expires_at > now()`; `reserveCredits` rejects a past expiry; decision recorded in the design spec; late-settle clamp verified by test |
| F5 | decision | Billing enabled ⇒ every billed model call refuses (`input_bound_unsupported`) and every code run refuses (`billing-token-budget-unavailable`). Documented terminal states, but the product stays dark until the enabling capabilities exist. | `server/src/index.ts:3228-3241`, `server/src/codesandbox/client.ts:130-131`, `server/src/codesandbox/gateway.ts:163-166` | **Decided: stay fail-closed both surfaces** — decision + flip conditions in the design spec ("Billed admission per surface"); Lago-only code-run metering refused; `docs/configuration.md` states the refusals |
| F6 | low | Usage `client` field is hardcoded `"web"` on both write paths; CLI/API-originated usage is misattributed. | `server/src/index.ts` (model gate assembly), `server/src/workshop/metering.ts:146` | **Fixed** — `server/src/usage-origin.ts` (AsyncLocalStorage, vocabulary web/api/unknown); gate input carries `client` read at doStream; session middleware names `web`, worker dispatch names `api`; tests in `copilot-usage-meter.test.ts` / `workshop-metering.test.ts` |
| F7 | docs | Plan documents and comments lag verified behavior: plan 01 names `consumeCredits` + `usage:` delivery key (actual: `settleReservation`), pending ordering by `created_at` (actual: `updated_at`); plan 05 describes per-plan/scope paid-order counting (actual: `duplicate_paid` anomaly rows); `maintenance.ts` header claims the sweep is not started in production (it is, `server/src/index.ts`). | docs + `server/src/billing/maintenance.ts` header | **Fixed** — dated as-built notes appended to plans 01 and 05 naming the mechanisms and commits (`b616ccaa`, `195ca54b`, `c3c2a206`); `maintenance.ts` header names the production wiring; interfaces spot-check clean |

---

## Task 1: Exact arithmetic in the reconciler (F1, F2)

**Files:**
- Modify: `server/src/billing/reconcile.ts`
- Modify: `server/src/billing/types.ts` (only if a report field type widens)
- Test: `server/tests/billing-reconcile.integration.test.ts`

**Interfaces:**
- The grants/ledger identity sums must reach the comparison as exact integers: read `SUM(...)::text` (or `::bigint` into a `bigint`/string column type) and compare without passing through `Number`. Findings print the exact decimal strings.
- The usage-outbox target counts read as exact values (`COUNT(*)::bigint` → string/bigint); `checked.usageDeliveryTargets` may stay numeric only with an explicit safe-integer guard that cannot silently overflow.
- `ReconcileReport` shape changes must stay backward-readable for the admin route consumer.

- [x] **Step 1: Write failing precision tests.** Seed grants/ledger rows whose sums exceed `Number.MAX_SAFE_INTEGER` and differ by exactly 1 unit; assert the finding fires (and does not fire when equal at that magnitude). Seed nothing unusual and assert the counts path reports exact values. Run `TEST_DATABASE_URL=... bun test server/tests/billing-reconcile.integration.test.ts` — expected RED.
- [x] **Step 2: Implement the exact reads.** Change the four aggregate reads (two SUM, four COUNT) to exact representations; keep the in-memory join semantics unchanged.
- [x] **Step 3: Run GREEN + typecheck.** Same test file plus `bun run --filter server typecheck`; exit 0.
- [x] **Step 4: Review.** Verify no other reconciler read (reservation `maximum`/`allocated` are 32-bit-bounded by config validation — confirm that bound is still enforced at parse) can exceed safe-integer range.

## Task 2: Target the paid-fact conflict (F3)

**Files:**
- Modify: `server/src/billing/payments/store.ts`
- Test: `server/tests/payment-store.integration.test.ts`

**Interfaces:**
- `confirmPaid`'s paid-fact insert must treat only a conflict on the channel-transaction unique index as "already known". A primary-key (`pe-` id) collision must surface as an error (retry with a fresh id, as `insertOrder` already does for `po-` collisions).

- [x] **Step 1: Write the failing test.** Force a primary-key collision on the paid-fact insert (pre-seed the id) and assert the store raises/retries instead of reporting the transaction as known. Run RED.
- [x] **Step 2: Implement.** Add the explicit conflict target (transaction-id index) to `onConflictDoNothing`, and handle `23505` on the primary key with the existing bounded-retry idiom.
- [x] **Step 3: GREEN + regression.** `TEST_DATABASE_URL=... bun test server/tests/payment-store.integration.test.ts server/tests/payment-service.test.ts`; exit 0.

## Task 3: Expired-hold recovery policy (F4; absorbs OCR round-5 Item 1)

**Files:**
- Modify: `server/src/billing/credits-writer.ts`
- Modify: `server/src/billing/maintenance.ts` (if the sweep option is chosen)
- Modify: `server/src/index.ts` (wiring)
- Test: `server/tests/billing-credits-writer.integration.test.ts`

**Interfaces:**
- `reserveCredits` rejects an `expiresAt` in the past at admission.
- Capacity accounting must not count an expired hold as held. Choose and record one of: (a) `held` subquery gains `expires_at > now()`, (b) a sweep that terminally `release`s expired `reserved` rows with reason `expired`, or (c) both. Record the choice in the design spec before implementing.
- Recovery must be idempotent and leave the reconciliation finding vocabulary intact (a swept release and an operator release must be distinguishable in `release_reason`).

- [x] **Step 1: Record the decision** in `docs/superpowers/specs/2026-10-11-billing-reliability-design.md` (option a/b/c and the `release_reason` vocabulary).
- [x] **Step 2: Write failing tests.** Concurrent reserve against capacity that is fully held only by expired holds must succeed; `reserveCredits` with a past `expiresAt` rejects; if (b)/(c): the sweep releases exactly the expired `reserved` rows, once, and leaves settled/released rows untouched. Run RED.
- [x] **Step 3: Implement** the chosen option(s).
- [x] **Step 4: GREEN + regression.** `billing-credits-writer.integration.test.ts`, `billing-reconcile.integration.test.ts`, typecheck; exit 0.
- [x] **Step 5: Review.** Confirm reconcile's `expired_reserved_reservation` finding still means something after the policy (swept rows must not re-appear as findings).

## Task 4: Decision gate and capability path for billed admission (F5; absorbs the decision half of OCR round-5 Item 6)

**Files:**
- Record first: `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`
- Only if the decision is "enable": `server/src/copilot.ts`, `server/src/index.ts`, `server/src/codesandbox/client.ts`, `server/src/codesandbox/gateway.ts`, `server/src/workshop/metering.ts` and their tests.

**Interfaces:**
- The decision record must answer, per surface (model call / code run): stay fail-closed, or enable with which provable bound (exact pre-call input token count, provider-enforced input ceiling, sandbox-enforced token budget).
- Enabling a model adapter requires an input bound that is provable on the outgoing provider request — the bar set by the 2026-10-12 remediation Task 1 does not move.
- Enabling code-run billing requires the sandbox contract to enforce the configured token budget end to end; the `code_run` outbox row then either carries reservation facts or its credits target is explicitly skipped (the Lago-only metering decision from OCR round-5 Item 6 must be answered in the same record).

- [x] **Step 1: Record the go/no-go decision** per surface, with the capability evidence required to flip each one.
- [x] **Step 2: If "stay closed" for a surface:** add the missing product-facing documentation (`docs/configuration.md` must state that enabling hard-cap billing currently refuses billed model calls and code runs) and stop. Do not write enabling code.
- ~~**Step 3: If "enable" for a surface:**~~ *(not applicable — both surfaces stayed closed per Step 1's decision)*
- [x] **Step 4: Review.** Confirm no billed path admits a call whose bounds it cannot prove, and that `docs/configuration.md` matches behavior.

## Task 5: Accurate usage source attribution (F6)

**Files:**
- Modify: `server/src/index.ts` (gate assembly), `server/src/workshop/metering.ts`, and whichever request-context seam carries the caller's origin.
- Test: `server/tests/copilot-usage-meter.test.ts`, `server/tests/workshop-metering.test.ts`

**Interfaces:**
- `client` on a usage fact must come from the authenticated request context (web / CLI / API token), defaulting to a named `unknown` rather than a wrong `web`.
- No schema change expected; the column is text. If a controlled vocabulary is chosen, enforce it in code and document it.

- [x] **Step 1: Write failing tests** asserting a CLI-originated model call and code run record their real source. Run RED.
- [x] **Step 2: Thread the origin** from the route/auth context through the gate and reporter.
- [x] **Step 3: GREEN + typecheck**; exit 0.

## Task 6: Documentation and comment convergence (F7)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-11-billing-reliability-01-usage-events.md` (delivery mechanism, pending ordering)
- Modify: `docs/superpowers/plans/2026-10-11-billing-reliability-05-bills-reconciliation.md` (duplicate-detection mechanism)
- Modify: `server/src/billing/maintenance.ts` (stale "nothing starts this in production yet" header)

**Interfaces:**
- Historical plan documents keep their original intent; add a dated "as-built note" per divergence instead of rewriting history, naming the verified mechanism (`settleReservation` + per-target idempotency, `updated_at` retry rotation, `duplicate_paid` anomaly rows) and the commit that introduced it.

- [x] **Step 1: Apply the as-built notes and the comment fix.**
- [x] **Step 2: Verify** no other plan-doc interface claim diverges from code (spot-check the six plans' "Interfaces" sections against the audited anchors).

## Task 7: Integrated verification and review

**Files:**
- Create: `docs/superpowers/plans/2026-10-13-billing-remediation-verification.md` during execution.

- [x] **Step 1: Database evidence.** Dedicated `TEST_DATABASE_URL`; apply appended migrations (Tasks 1–5 add none unless Task 3's sweep needs an index — if so, a new migration only); record commands and versions.
- [x] **Step 2: Full targeted suite.** All billing/payment/credit/usage/webhook/statement test files plus typecheck; record counts, skips, exit codes. Baseline at audit time: 533 pass / 0 fail across the plan-named files; the run must not regress.
- [x] **Step 3: OCR review** over the remediation diff (`ocr review --audience agent ... --from <BASE> --to <HEAD>` and workspace mode if uncommitted files exist); validate and disposition every finding.
- [x] **Step 4: Ledger close-out.** Mark the absorbed items in `2026-10-12-billing-ocr-round5-repair.md` (Items 1, 6-decision-half, and the two Item-10 bullets) as absorbed; update the finding ledger above with status and evidence links.

## Completion gate

The remediation is complete only when: F1–F3 are fixed with precision/collision tests passing on a dedicated database; F4 has a recorded decision and a tested recovery path; F5 has a recorded per-surface decision with either enabling capability tests or explicit stay-closed documentation; F6 records true caller origin; F7's documents match verified behavior; and Task 7's suite, typecheck, and OCR report are on file with no unresolved blocking findings.
