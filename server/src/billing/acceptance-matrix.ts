/*
 * The parent Spec's acceptance matrix (Bifrost 22.5, #356): AC01–AC19, each mapped to
 * the concrete scenario that proves it, the commands that reproduce the proof, and the
 * delivered suites that carry the assertions — every row bound to the code version that
 * ran it (the batch report records HEAD, the timestamp and each command's exit receipt).
 *
 * THE MATRIX IS EXECUTABLE OR IT IS NOTHING. Each row names at least one runnable
 * command and at least one suite file that exists in this repository; the test pins
 * that executability, so a row whose suite was renamed or deleted fails the matrix
 * before anyone can claim the AC. What the rows do NOT do is soften a result: a suite
 * that skips, or an environment a command needs but does not have, counts as NOT
 * PASSED — skip 不计为通过 is the accounting rule the test enforces on the runner's own
 * output shape (a skipped case is reported, never folded into the passed count).
 *
 * THE CROSS-PROCESS SCENARIOS ARE FIRST-CLASS. 重启、双 worker 并发、重复投递、时钟推
 * 进、断线 each appear on the rows that prove them (the recovery suites drive real
 * second processes over the same database; the replay suites drive duplicate delivery;
 * the expiry and scan suites advance the clock; the realtime recovery suite disconnects
 * and restores) — 22.5's run executes them all, and the matrix's own test checks the
 * five scenario tags are all claimed by at least one row.
 */

/** The cross-process fault scenarios the ticket names, as row tags. */
export const CROSS_PROCESS_SCENARIOS = [
  "restart",
  "concurrent-workers",
  "replay-delivery",
  "clock-advance",
  "client-disconnect",
] as const;
export type CrossProcessScenario = (typeof CROSS_PROCESS_SCENARIOS)[number];

/** One AC's row in the matrix. */
export type AcceptanceMatrixRow = {
  ac: "AC01" | "AC02" | "AC03" | "AC04" | "AC05" | "AC06" | "AC07" | "AC08" | "AC09" | "AC10" | "AC11" | "AC12" | "AC13" | "AC14" | "AC15" | "AC16" | "AC17" | "AC18" | "AC19";
  /** The observable result the AC requires, in the Spec's own words. */
  requirement: string;
  /** The concrete behavioral scenario this row executes to prove it. */
  scenario: string;
  /** Reproducible commands (cwd = repo root; <test-db> = the dedicated TEST_DATABASE_URL). */
  commands: readonly string[];
  /** The delivered suites whose assertions carry the proof (paths into server/tests/). */
  suites: readonly string[];
  /** The cross-process fault scenarios this row's suites drive. */
  crossProcess?: readonly CrossProcessScenario[];
};

/** AC01–AC19, the whole Spec's acceptance in one table. */
export const ACCEPTANCE_MATRIX: readonly AcceptanceMatrixRow[] = [
  {
    ac: "AC01",
    requirement:
      "Two users have isolated personal balances; concurrent provisioning creates one effective personal Customer mapping.",
    scenario:
      "two personal accounts hold and spend separately; concurrent provisioning of the same user converges on one customer mapping row (the loser replays onto the winner's account, never a second one)",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/gateway-customer-provisioning.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/payer-account.integration.test.ts",
    ],
    suites: [
      "server/tests/gateway-customer-provisioning.integration.test.ts",
      "server/tests/payer-account.integration.test.ts",
    ],
    crossProcess: ["concurrent-workers"],
  },
  {
    ac: "AC02",
    requirement:
      "Two Bots have distinct Keys sharing one user's credits; issuing or rotating a Key cannot multiply allowance.",
    scenario:
      "two bot keys draw on the one personal balance; a rotation revokes the old key's paid-work rights without minting a second allowance",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/key-issuance.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/agent-key-rotation.integration.test.ts",
    ],
    suites: [
      "server/tests/key-issuance.integration.test.ts",
      "server/tests/agent-key-rotation.integration.test.ts",
    ],
  },
  {
    ac: "AC03",
    requirement:
      "Binding requires authenticated confirmation; forged user IDs, emails, replayed binding codes and Bot authentication alone cannot claim another user's credentials.",
    scenario:
      "a binding offer is claimed only by the authenticated owner: forged identifiers, replayed codes and bot-only authentication are all refused",
    commands: [
      "bun test server/tests/binding-code-issuance.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/binding-code-hardening.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/access-grant.integration.test.ts",
    ],
    suites: [
      "server/tests/binding-code-issuance.test.ts",
      "server/tests/binding-code-hardening.integration.test.ts",
      "server/tests/access-grant.integration.test.ts",
    ],
  },
  {
    ac: "AC04",
    requirement:
      "With balance 10, two concurrent requests each requiring a maximum of 8 result in only one reservation and one provider dispatch.",
    scenario:
      "the door's transaction serializes concurrent 8-credit holds against a 10-credit balance: exactly one hold commits, the loser refuses insufficient_credits, and only the winner dispatches",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/reserve-concurrency.integration.test.ts",
    ],
    suites: ["server/tests/reserve-concurrency.integration.test.ts"],
    crossProcess: ["concurrent-workers"],
  },
  {
    ac: "AC05",
    requirement:
      "Credit-service timeout/unavailability, missing admission enforcement and invalid grants never dispatch provider work; alternate endpoints and attempts cannot bypass admission.",
    scenario:
      "a down credit service, an ungated deployment and an invalid grant all answer refusal with zero provider dispatches; provider-session credentials and alternate endpoints are refused on presence",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/e2e-strict-billing-text.integration.test.ts",
      "bun test server/tests/credit-service-auth.test.ts",
      "bun test server/tests/realtime-bypass-audit.test.ts",
      "bun test server/tests/payer-no-fallback.test.ts",
    ],
    suites: [
      "server/tests/e2e-strict-billing-text.integration.test.ts",
      "server/tests/credit-service-auth.test.ts",
      "server/tests/realtime-bypass-audit.test.ts",
      "server/tests/payer-no-fallback.test.ts",
    ],
  },
  {
    ac: "AC06",
    requirement:
      "Missing prices, unreliable usage or unenforceable bounds reject execution with a visible reason; explicit free pricing is separate from unknown pricing.",
    scenario:
      "every enablement door refuses an unknown dimension naming it (rerank, ocr, audio, video); usage that never arrived is held, not zeroed; an explicitly-priced zero is executable and answers as free, never as unknown",
    commands: [
      "bun test server/tests/rerank-pricing.test.ts",
      "bun test server/tests/ocr-pricing.test.ts",
      "bun test server/tests/capability-availability.test.ts",
      "bunx e2e run --config e2e.unit.config.ts server/tests/billing-usage-evidence.test.ts",
      "bun test server/tests/audio-path-admission.test.ts",
      "bun test server/tests/video-pricing.test.ts",
    ],
    suites: [
      "server/tests/rerank-pricing.test.ts",
      "server/tests/ocr-pricing.test.ts",
      "server/tests/capability-availability.test.ts",
      "server/tests/billing-usage-evidence.test.ts",
      "server/tests/audio-path-admission.test.ts",
      "server/tests/video-pricing.test.ts",
    ],
  },
  {
    ac: "AC07",
    requirement:
      "Success, streaming completion, billable failures/cancellation, duplicate events and process restarts neither lose nor duplicate charges.",
    scenario:
      "the settlement idempotency fence answers duplicates and restarts with the first result; streaming completion, billable failure and cancellation each land exactly one settlement",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/async-settle-once.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/batch-settlement.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/billing-usage-outbox.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/settle-conflict-grant-expiry.integration.test.ts",
    ],
    suites: [
      "server/tests/async-settle-once.integration.test.ts",
      "server/tests/batch-settlement.integration.test.ts",
      "server/tests/billing-usage-outbox.integration.test.ts",
      "server/tests/settle-conflict-grant-expiry.integration.test.ts",
    ],
    crossProcess: ["restart", "replay-delivery"],
  },
  {
    ac: "AC08",
    requirement:
      "Default 15-minute expiry and valid-grant renewal work; revoked old Keys cannot start paid work; expiry does not erase outstanding liability.",
    scenario:
      "an unanswered hold releases at 15 minutes; a renewed grant extends; a revoked key refuses new paid work; an expired grant's outstanding holds settle or stay held — never erased",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/release-semantics.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/unknown-hold-no-reclaim.integration.test.ts",
      "bun test server/tests/key-expiry.test.ts",
      "bun test server/tests/key-renewal.test.ts",
      "bun test server/tests/key-revocation.test.ts",
    ],
    suites: [
      "server/tests/release-semantics.integration.test.ts",
      "server/tests/unknown-hold-no-reclaim.integration.test.ts",
      "server/tests/key-expiry.test.ts",
      "server/tests/key-renewal.test.ts",
      "server/tests/key-revocation.test.ts",
    ],
    crossProcess: ["clock-advance"],
  },
  {
    ac: "AC09",
    requirement:
      "Bot defaults and conversation overrides take effect; unavailable selection does not silently switch model.",
    scenario:
      "the effective model resolution honors defaults then overrides; a selection that cannot be served refuses (不切换), never falls back to another model silently",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/model-preference.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/model-scope.integration.test.ts",
    ],
    suites: [
      "server/tests/model-preference.integration.test.ts",
      "server/tests/model-scope.integration.test.ts",
    ],
  },
  {
    ac: "AC10",
    requirement:
      "Automatic/manual sync respects the default 5/15-minute timing, preserves approved scope and blocks affected stale-price calls without repricing existing reservations.",
    scenario:
      "catalog sync answers default windows; a stale catalog refuses new calls at the freshness gate while every existing reservation's locked basis keeps pricing its own settlement",
    commands: [
      "bun test server/tests/catalog-auto-sync.test.ts",
      "bun test server/tests/catalog-manual-sync.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/reserve-version-locking.integration.test.ts",
    ],
    suites: [
      "server/tests/catalog-auto-sync.test.ts",
      "server/tests/catalog-manual-sync.test.ts",
      "server/tests/reserve-version-locking.integration.test.ts",
    ],
    crossProcess: ["clock-advance"],
  },
  {
    ac: "AC11",
    requirement:
      "Deleted/disabled/drifted Keys are identified; manually created Keys do not acquire OpenBot authorization.",
    scenario:
      "drifted keys are flagged with their events; a manually created provider key never gains OpenBot's authorization — isolation holds both directions",
    commands: [
      "bun test server/tests/key-drift-handling.test.ts",
      "bun test server/tests/key-state-sync.test.ts",
      "bun test server/tests/personal-key-isolation.test.ts",
    ],
    suites: [
      "server/tests/key-drift-handling.test.ts",
      "server/tests/key-state-sync.test.ts",
      "server/tests/personal-key-isolation.test.ts",
    ],
  },
  {
    ac: "AC12",
    requirement:
      "Missing conversion configuration prevents enablement; changes affect new requests only; repeated small costs accumulate the correct remainder.",
    scenario:
      "no conversion rate means no enablement; a rate change locks from the next request; sub-cent costs accumulate remainders that eventually bill — the small-cost tail neither loses nor duplicates",
    commands: [
      "bun test server/tests/gateway-conversion-rate.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/credit-remainder.integration.test.ts",
    ],
    suites: [
      "server/tests/gateway-conversion-rate.test.ts",
      "server/tests/credit-remainder.integration.test.ts",
    ],
  },
  {
    ac: "AC13",
    requirement:
      "Company-workbench calls retain the trusted company payer and personal-authorized external calls retain the personal payer through admission, usage, settlement and remainder; neither insufficient balance nor workspace switching changes the payer, and personal Keys grant no company-content access. Subscription harnesses cannot become a balance-exhaustion fallback.",
    scenario:
      "the payer is fixed at binding and carried through reserve/usage/settlement/remainder; a short balance refuses on the bound account (no switch); a client-specified payer is refused; the subscription harness cannot fall back to a balance",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/company-payer-e2e.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/payer-company-resolution.integration.test.ts",
      "bun test server/tests/payer-no-fallback.test.ts",
      "bunx e2e run --config e2e.unit.config.ts server/tests/subscription-harness-boundary.test.ts",
      "bun test server/tests/personal-key-isolation.test.ts",
    ],
    suites: [
      "server/tests/company-payer-e2e.integration.test.ts",
      "server/tests/payer-company-resolution.integration.test.ts",
      "server/tests/payer-no-fallback.test.ts",
      "server/tests/subscription-harness-boundary.test.ts",
      "server/tests/personal-key-isolation.test.ts",
    ],
  },
  {
    ac: "AC14",
    requirement:
      "Personal grants, orders, subscriptions and callbacks use personal ownership; another user cannot read, mutate or redirect them.",
    scenario:
      "grants, orders, subscriptions and callbacks answer only their owner; cross-user reads, mutations and redirects refuse",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/subscription-ownership.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/order-ownership.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/payment-callback-ownership.integration.test.ts",
    ],
    suites: [
      "server/tests/subscription-ownership.integration.test.ts",
      "server/tests/order-ownership.integration.test.ts",
      "server/tests/payment-callback-ownership.integration.test.ts",
    ],
  },
  {
    ac: "AC15",
    requirement:
      "A Grant expiring mid-request still settles the admitted work; expired unused remainder stays expired; unknown holds stay unavailable.",
    scenario:
      "a grant that lapses after admission settles the work it admitted; its unused remainder dies expired; a hold whose outcome nobody knows stays occupied and unavailable",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/settle-conflict-grant-expiry.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/unknown-hold-no-reclaim.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/release-semantics.integration.test.ts",
    ],
    suites: [
      "server/tests/settle-conflict-grant-expiry.integration.test.ts",
      "server/tests/unknown-hold-no-reclaim.integration.test.ts",
      "server/tests/release-semantics.integration.test.ts",
    ],
    crossProcess: ["clock-advance"],
  },
  {
    ac: "AC16",
    requirement:
      "Realtime units reserve before processing and stop subsequent work on exhaustion/revocation; asynchronous tasks retain full reservations and repeated retrieval does not re-charge.",
    scenario:
      "per-unit reservation gates every realtime turn, exhaustion and revocation stop the session durably; async jobs hold the full cap and status retrieval never re-charges",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-unit-reservation.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-exhaustion.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-revocation.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/async-status-authz.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/async-lost-jobid.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/realtime-recovery.integration.test.ts",
    ],
    suites: [
      "server/tests/realtime-unit-reservation.integration.test.ts",
      "server/tests/realtime-exhaustion.integration.test.ts",
      "server/tests/realtime-revocation.integration.test.ts",
      "server/tests/async-status-authz.test.ts",
      "server/tests/async-lost-jobid.integration.test.ts",
      "server/tests/realtime-recovery.integration.test.ts",
    ],
    crossProcess: ["client-disconnect"],
  },
  {
    ac: "AC17",
    requirement:
      "Unknown-result recovery, alerts and audited evidence-based resolution work; disabling/deleting a user preserves necessary liability.",
    scenario:
      "the recovery scan surfaces unknown holds, alerts on them, and resolves them through audited evidence-based disposal; compensation preserves liability across user disablement",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/recovery-scan.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/recovery-alerting.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/recovery-unacked-replay.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/compensation-liability.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/recovery-ack-lost.integration.test.ts",
    ],
    suites: [
      "server/tests/recovery-scan.integration.test.ts",
      "server/tests/recovery-alerting.integration.test.ts",
      "server/tests/recovery-unacked-replay.integration.test.ts",
      "server/tests/compensation-liability.integration.test.ts",
      "server/tests/recovery-ack-lost.integration.test.ts",
    ],
    crossProcess: ["restart", "replay-delivery"],
  },
  {
    ac: "AC18",
    requirement:
      "Cleanup affects only enumerated and verified obsolete test billing data; users, Bots, conversations, knowledge and company financial history remain intact. Unknown-owner records are isolated; no legacy balance is duplicated into personal and company accounts.",
    scenario:
      "the cleanup pipeline classifies, enumerates, rehearses and executes with guards; unknown-owner records isolate; a legacy balance lands in exactly one account",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-classification.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-enumeration.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-dry-run.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-guards.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-rehearsal.integration.test.ts",
      "TEST_DATABASE_URL=<test-db> bun test server/tests/cleanup-execution.integration.test.ts",
    ],
    suites: [
      "server/tests/cleanup-classification.integration.test.ts",
      "server/tests/cleanup-enumeration.integration.test.ts",
      "server/tests/cleanup-dry-run.integration.test.ts",
      "server/tests/cleanup-guards.integration.test.ts",
      "server/tests/cleanup-rehearsal.integration.test.ts",
      "server/tests/cleanup-execution.integration.test.ts",
    ],
  },
  {
    ac: "AC19",
    requirement:
      "User/admin screens enforce their respective authorization and do not expose raw Keys in frontend responses, messages or ordinary logs.",
    scenario:
      "key status surfaces answer authorized readers with redacted status; admin screens enforce admin authz; raw keys never ride a response, message or ordinary log",
    commands: [
      "TEST_DATABASE_URL=<test-db> bun test server/tests/access-grant-key-status.integration.test.ts",
      "bun test server/tests/access-grant-revoke.test.ts",
      "bun test server/tests/gateway-admin-routes.test.ts",
      "bunx e2e run --config e2e.unit.config.ts server/tests/admin-people-credentials-validation.test.ts",
    ],
    suites: [
      "server/tests/access-grant-key-status.integration.test.ts",
      "server/tests/access-grant-revoke.test.ts",
      "server/tests/gateway-admin-routes.test.ts",
      "server/tests/admin-people-credentials-validation.test.ts",
    ],
  },
] as const;

/** The ACs the matrix carries — the Spec's own nineteen, exactly once each. */
export const MATRIX_ACS = [
  "AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08", "AC09", "AC10",
  "AC11", "AC12", "AC13", "AC14", "AC15", "AC16", "AC17", "AC18", "AC19",
] as const;

/**
 * The skip-does-not-pass accounting rule, as a function: a suite run's outcome counts as
 * passed only when at least one case PASSED and failures AND skips are both zero. Every
 * executor that reports a matrix row must fold its counts through this rule — a green
 * run with skips reports `passed: false` with the skipped count carried, never folded
 * away, and a run with zero cases of every kind (a suite that never executed anything)
 * is a named failure too: absence is not a pass.
 */
export function countsAsPassed(counts: {
  passed: number;
  failed: number;
  skipped: number;
}): { passed: boolean; reason?: string } {
  if (counts.failed > 0) return { passed: false, reason: `${counts.failed} failed` };
  if (counts.skipped > 0)
    return { passed: false, reason: `${counts.skipped} skipped — skip 不计为通过` };
  if (counts.passed === 0)
    return { passed: false, reason: "0 cases executed — absence is not a pass" };
  return { passed: true };
}
