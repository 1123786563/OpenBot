# OCR Round-8 Repair Implementation Plan

Source: reports/ocr-final-workspace-r4.txt (15 findings; 33/46 items lost to 429). Same Global Constraints as the R1 plan (uncommitted checkpoints, no git mutations, no DB access, TDD, scoped Biome/typecheck baseline).

## Adjudication

| ID | Severity | Validity | Disposition |
| --- | --- | --- | --- |
| R8-M1 | medium — prefix-internal `when` pairs unchecked; the first migrate pass is watermark-driven too, equal/regressed prefix whens are silently skipped | valid (semantics match the runner's own comment) | Task 1 |
| R8-M2 | medium — 0067 CHECK without NOT VALID scans enterprise_run_attempts under ACCESS EXCLUSIVE | valid, but OCR's fix location is wrong (VALIDATE in 0066 would run BEFORE the constraint exists); corrected: NOT VALID in 0067, VALIDATE appended to 0068's tail (after it, order-correct; snapshots unaffected — drizzle snapshots carry no notValid state) | Task 2 |
| R8-L1 migrate.ts double end() masking the original error | valid | Task 1 |
| R8-L2 0065 EXCEPTION swallows query_canceled | valid | Task 2 |
| R8-L3 hasOwn → in (prototype-inherited options/begin must trip the sentinel) | valid | Task 1 |
| R8-L4 zero coverage of sqlStateFromError/createMigrationLockTimeoutError/errorChainContains/isConnectionFailure | valid | Task 1 (tests) |
| R8-L5 0067 filename vs content mismatch | valid (unapplied; rename + journal tag) | Task 2 |
| R8-L6..L10 agent-resolver: redundant assertion, defense-in-depth comment, unavailable() factory, source-union derivation, resolveOneBot extraction | valid | Task 3 |
| R8-L11 runtime-agents delete no-op | valid | Task 3 |
| R8-L12 journalBoundaryOf still duplicates the validator's lookups | valid | Task 1 |
| R8-L13 0065 holder_counts unfiltered aggregation under SHARE ROW EXCLUSIVE | valid but DEFERRED — a CTE rewrite of applied-path SQL belongs with the DB-gated wave (needs EXPLAIN verification) | deferred |

## Tasks

1. migration-runner + migrate.ts: shared assertStrictlyIncreasing over prefix AND post-boundary; `in` sentinel; validator returns boundary positions for reuse; finally-guard on the second end(); unit tests for the four error-classification pure functions. RED: prefix-internal regression journal throws; hasOwn→in behavior locked; classify cases.
2. drizzle 0065/0067/0068 (+ journal tag): NOT VALID + VALIDATE pair; query_canceled re-raise; 0067 rename. RED: guards assert NOT VALID in 0067, VALIDATE in 0068, no VALIDATE-before-create ordering, renamed tag in journal + file.
3. agent-resolver + runtime-agents smalls: five small refactors with existing suites as behavior locks.
