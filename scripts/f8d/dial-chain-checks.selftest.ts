/**
 * Minimal unit check for the exported dial-chain verdict helper (ocrfix-e).
 *
 * Run directly: bun scripts/f8d/dial-chain-checks.selftest.ts
 * Deliberately NOT named *.test.ts: SUITE_DIRS adopts scripts/** test files
 * into the e2e manifest partition, which this fix must not do.
 */
import { strict as assert } from "node:assert";
import { dialChainThreeStateLogged } from "./final-evidence";

// The r1 evidence shape: 10 derived dials, all sha-pinned → PASS.
assert.equal(
  dialChainThreeStateLogged({ totalDials: 10, derivedCount: 10, derivedPinned: 10 }).verdict,
  "PASS",
);

// An ambient dial among the driven set no longer breaks the verdict (the old
// predicate derivedPinned === totalDials was GAP forever once ambient appeared).
assert.equal(
  dialChainThreeStateLogged({ totalDials: 11, derivedCount: 10, derivedPinned: 10 }).verdict,
  "PASS",
);
assert.match(
  dialChainThreeStateLogged({ totalDials: 11, derivedCount: 10, derivedPinned: 10 }).detail,
  /1 ambient dials logged too/,
);

// A derived dial whose sha did not recompute → GAP.
assert.equal(
  dialChainThreeStateLogged({ totalDials: 10, derivedCount: 10, derivedPinned: 9 }).verdict,
  "GAP",
);

// Under-driven (default threads → 6 dials) cannot fake a PASS at the ≥10 floor.
assert.equal(
  dialChainThreeStateLogged({ totalDials: 6, derivedCount: 6, derivedPinned: 6 }).verdict,
  "GAP",
);

console.log("dial-chain-checks.selftest: 4/4 ok");
