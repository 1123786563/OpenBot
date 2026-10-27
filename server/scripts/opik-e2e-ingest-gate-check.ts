// r7fix-a A1 (#40) standalone gate check, reworked by r8fix-G (T-J #4) — run with
// `bun server/scripts/opik-e2e-ingest-gate-check.ts`.
// Asserts the ingest evidence's writeAccepted predicate judges the LAST retry
// round's increment: a transient refusal recovered by a clean resubmit round is a
// real pass, while a refusal or perform failure in the judged round voids the gate
// — the safe observation completing across rounds while the credential-bearing one
// kept failing proves nothing (the #40 hole, in per-round shape). Not a bun:test
// suite (plain asserts, nonzero exit on the first failure count), so it enters no
// test manifest and is driven directly by whoever changes the gate.
import { EXPECTED_WRITES_PER_ROUND, writesEstablished } from "./opik-e2e-ingest";

type Stats = Parameters<typeof writesEstablished>[0];

const clean: Stats = {
  capacity: 8,
  depth: 0,
  submitted: EXPECTED_WRITES_PER_ROUND,
  accepted: EXPECTED_WRITES_PER_ROUND,
  droppedFull: 0,
  refusedNotReady: 0,
  completed: EXPECTED_WRITES_PER_ROUND,
  failed: {
    unavailable: 0,
    upstream_error: 0,
    malformed: 0,
    ownership_drift: 0,
    unexpected: 0,
  },
  idLinks: { chain_broken: 0, divergent: 0, error: 0 },
};

const withFailed = (patch: Partial<Stats["failed"]>): Stats => ({
  ...clean,
  failed: { ...clean.failed, ...patch },
});

// One round that refused both submits behind a probe flip (the round's increment).
const refusedRound: Stats = {
  ...clean,
  submitted: EXPECTED_WRITES_PER_ROUND,
  accepted: 0,
  completed: 0,
  refusedNotReady: 1,
};

// The increment of the round that recovered it: both resubmits accepted and
// completed cleanly — identical in shape to `clean`.
const recoveredRound: Stats = { ...clean };

// The cumulative totals the pre-r8fix-G gate was fed for that same recovered run:
// round one refused, round two landed. Counts say accepted=2/completed=2, but the
// round-one refusal stays in the tally — the recovery dead-end this rework removes.
const cumulativeRecoveredRun: Stats = {
  ...clean,
  submitted: EXPECTED_WRITES_PER_ROUND * 2,
  refusedNotReady: 1,
};

const cases: ReadonlyArray<{ label: string; stats: Stats; expected: boolean }> = [
  { label: "both writes landed cleanly (the judged round's increment)", stats: clean, expected: true },
  {
    // r8fix-G: round 1 refused both behind a probe flip, round 2 resubmitted both
    // cleanly. The gate judges the last round's increment — the recovery path the
    // retry loop promises is real again.
    label: "a transient refusal recovers on a clean resubmit round",
    stats: recoveredRound,
    expected: true,
  },
  {
    // RED pin: the same recovered run judged on cumulative totals (the pre-r8fix-G
    // input) stays voided by the round-one refusal — reverting to cumulative
    // judgment kills the recovery path again.
    label: "the same run judged cumulatively stays voided by the earlier refusal",
    stats: cumulativeRecoveredRun,
    expected: false,
  },
  {
    label: "a readiness refusal in the judged round voids the gate",
    stats: refusedRound,
    expected: false,
  },
  {
    // L-F clause isolation: each fixture below removes exactly ONE count clause
    // from `clean`, so that clause alone has to flip the verdict — deleting it
    // from the predicate turns the matching case green.
    // The #40 core clause: two writes accepted but only one performed, i.e. the
    // credential-bearing write queued but never landed.
    label: "a round with an accepted write left unperformed voids the gate",
    stats: { ...clean, completed: EXPECTED_WRITES_PER_ROUND - 1 },
    expected: false,
  },
  {
    // The acceptance clause, on its own: one observation submitted, accepted and
    // completed — the round is one write short of both observations.
    label: "a round that accepted fewer writes than the round carries voids the gate",
    stats: {
      ...clean,
      submitted: EXPECTED_WRITES_PER_ROUND - 1,
      accepted: EXPECTED_WRITES_PER_ROUND - 1,
      completed: EXPECTED_WRITES_PER_ROUND - 1,
    },
    expected: false,
  },
  {
    // The queue-full clause: both writes landed, but a third submit was dropped
    // on the floor — a dropped write is never an absent write.
    label: "a dropped-full submit in the judged round voids the gate",
    stats: {
      ...clean,
      submitted: EXPECTED_WRITES_PER_ROUND + 1,
      droppedFull: 1,
    },
    expected: false,
  },
  {
    // The #40 hole in per-round shape: the safe observation completed on earlier
    // rounds while the sensitive write failed at perform time again in the FINAL
    // round — the judged round's own failure voids the gate.
    label: "a perform failure in the final round voids the gate",
    stats: withFailed({ unavailable: 1 }),
    expected: false,
  },
  {
    label: "an ownership drift failure in the judged round voids the gate",
    stats: withFailed({ ownership_drift: 1 }),
    expected: false,
  },
];

let failures = 0;
for (const { label, stats, expected } of cases) {
  const got = writesEstablished(stats);
  if (got !== expected) {
    failures += 1;
    console.error(`FAIL ${label}: writesEstablished=${got} expected=${expected}`);
  } else {
    console.log(`ok   ${label}: writesEstablished=${got}`);
  }
}
if (failures > 0) {
  console.error(`${failures}/${cases.length} gate checks FAILED`);
  process.exit(1);
}
console.log(`${cases.length}/${cases.length} gate checks passed`);
