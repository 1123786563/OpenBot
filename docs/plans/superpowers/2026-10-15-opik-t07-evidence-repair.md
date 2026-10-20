# OpenBot Issue #13 / T07 evidence correction — R-07

> **For agentic workers:** Execute as a docs-only Orca Claude SDD task. The original T07 implementation is independently Spec-compliant and code-approved; this task corrects the evidence package and adds an omitted durable checkpoint. Do not change implementation, tests, migration, or config.

## Goal

Repair T07 review findings F1/F2 and make the T07 checkpoint part of the hash-bound, reproducible delivery package before integration.

## Source inputs

- T07 implementation Task `task_175815fd0e74` / Dispatch `ctx_4e6576ea17c7`, base `8b231692ddcd82c9fcfa4e0cb5b95dee63200080`.
- Candidate implementation `docs/plans/evidence/2026-10-15-issue4/T07/T07.patch` SHA256 `5c59b01e82ba83f71319709e74fa8d3ce000a179ade710cc930c2a55f30af8ef`.
- Independent review `docs/plans/evidence/2026-10-15-issue4/T07/T07-review.md` SHA256 `7890f8985f67f0ce6c1f253a996d0c35c0dbe2a77b0f314244d2296e22a67264`, findings F1/F2 and integration note F3.
- Worker report/logs/manifest and `docs/tickets/opik-4/checkpoints/T07.md` from implementation worktree, explicitly transferred by coordinator.

## Scope and ownership

Owned files: only the T07 evidence files `task-report.md`, `logs/gates.log`, `manifest.sha256`, the `docs/tickets/opik-4/checkpoints/T07.md` checkpoint, and new `evidence-repair-report.md`, `T07-evidence.patch`, `evidence-repair-package.json`. No production code, tests, migration/config, issue snapshot, or previous review report.

## Steps

1. Verify all transferred input hashes and inspect the exact old gates/log/report/checkpoint contents.
2. Correct F1: reconcile the aggregate test transcript with the per-command exit evidence. Record the combined test as nonzero because it includes the 3 failing pre-existing migration-journal cases; retain exact pass/fail counts and distinguish the implementation worktree's transferred T06 tests from base-only re-review counts. Do not label any failing aggregate gate as pass.
3. Correct F2: explicitly say the migration-journal test stops at missing `meta/0076_snapshot.json` and never reaches 0110. Attribute the proof of 0110 snapshot/SQL consistency to the reviewer's structural comparison and byte-for-byte generator reproduction, not to that failing test.
4. Add the already-authored `docs/tickets/opik-4/checkpoints/T07.md` byte-for-byte to the deliverable and to the SHA-256 manifest; verify it against source transfer. Clarify manifest scope so it covers all candidate source writes and ticket checkpoint, while package-level hashes bind worker report/log/review evidence without self-reference.
5. Produce a docs-only patch that applies cleanly after T07.patch to base `8b231692`, a package manifest with exact before/after hashes, and a concise correction report explaining F1/F2 resolution. Hash all transferred/new evidence artifacts and record exact commands/results.
6. Run structural checks: both patches apply; every manifest entry matches; exact candidate source hashes remain unchanged from the reviewed T07.patch; checkpoint content exact; gates.log and task-report agree on every exit/failure; no unrelated file changes.

## Verification and completion

No code tests are required for this documentation-only correction; use reproducible package/patch/hash and text consistency checks. Report failures without smoothing them over. Do not commit, stash, push, merge, publish, or self-review. An independent Claude reviewer will review this evidence repair before coordinator integration.
