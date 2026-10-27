// r7fix-a A1 (#40) standalone gate check — run with `bun server/scripts/opik-e2e-ingest-gate-check.ts`.
// Asserts the ingest evidence's writeAccepted predicate cannot be passed by the
// vacuous shape the retry loop makes reachable: the safe observation completing
// twice while the credential-bearing one kept failing at perform time. Not a
// bun:test suite (plain asserts, nonzero exit on the first failure count), so it
// enters no test manifest and is driven directly by whoever changes the gate.
import { writesEstablished } from "./opik-e2e-ingest";

type Stats = Parameters<typeof writesEstablished>[0];

const clean: Stats = {
  capacity: 8,
  depth: 0,
  submitted: 2,
  accepted: 2,
  droppedFull: 0,
  refusedNotReady: 0,
  completed: 2,
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

const cases: ReadonlyArray<{ label: string; stats: Stats; expected: boolean }> = [
  { label: "both writes landed cleanly", stats: clean, expected: true },
  {
    // The #40 hole: safe completed on two retry rounds (completed >= 2) while
    // the sensitive write failed at perform — counts alone clear the gate and
    // forbiddenCanariesAbsent proves nothing.
    label: "perform failure voids the gate (sensitive write failed twice)",
    stats: withFailed({ unavailable: 2 }),
    expected: false,
  },
  {
    label: "a readiness refusal behind the probe flip voids the gate",
    stats: { ...clean, refusedNotReady: 1 },
    expected: false,
  },
  {
    label: "an ownership drift failure voids the gate",
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
