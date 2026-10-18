# RED → GREEN evidence (MT069 / Issue #112)

Pre-change baseline (claim time, before any edit): **577 pass / 0 fail / 22 files / 0 skip**
— reproduced exactly as the brief states (`bun --no-env-file test tests/multitenancy/`, all
dedicated-database env set incl. `MT003_ASSIGNED_TEST_DATABASE_URL`, so no skips).
The first archived run landed after the RED-1 assertion edit, so it shows 577 total with that
single assertion failing; the pristine 577/0/22 output is quoted in the session record and the
same total is re-proven below (RED-1 run = 577 total, 1 fail).

## RED-1 — migration registry allowlist (ruling #5, 7th precedent)
Command: `bun --no-env-file test tests/multitenancy/migration-tool.test.ts`
Assertion appended FIRST (allowlist += "MT069" + ruling comment); registry had no MT069 yet.

Full multitenancy suite at this state (`verification/` claim-time run + `red-green/RED-1-allowlist.txt`):

```
 576 pass
 1 fail
Ran 577 tests across 22 files.
(fail) issue #46 criterion 3: deterministic names and increasing numbers > the allowlist is exactly the registry and the shipped self-check task
```

Failure reason: expected allowlist contains "MT069", actual registry does not — the feature
(task registration) was missing. Correct RED.

## GREEN-1 — registry appended (pure append to migrate-test.ts)
Same command after appending PAYER_ACCOUNT_TASK + TASKS entry (`red-green/GREEN-1-registry.txt`):

```
 42 pass
 0 fail
Ran 42 tests across 1 file.
```

## RED-2 — domain module + tests (TDD, new files)
Tests + support fixture written FIRST (22 cases); production modules absent:

```
error: Cannot find module '../../../src/billing/payer-accounts' from '.../support/payer-accounts.ts'
 0 pass
 1 fail
 1 error
```

Failure reason: the MT069 service module does not exist (feature missing, not a typo). Correct RED.
(`red-green/RED-2-modules.txt`)

## GREEN-2 — schema + service implemented
`src/db/schema/payer-accounts.ts` (3 tables, mirroring the MT069 task migration SQL) +
`src/billing/payer-accounts.ts` (single write surface) + one barrel line in
`src/db/schema/index.ts`. Iterations: 4 test-side assertion fixes (drizzle `execute` returns rows
directly, not `.toArray()`; glibc sort order of `released` vs `remainder_*`; settlement result
field is `chargedCents`; settled ledger key is the derived `reservation:<id>`) — production code
unchanged through those fixes. Final focused run (`red-green/GREEN-2-final.txt`, re-archived at
`verification/01-focused-final.txt` after the conflict-message assertions were added):

```
 22 pass
 0 fail
Ran 22 tests across 1 file.
```

## Post-GREEN full regression
`bun --no-env-file test tests/multitenancy/` → **599 pass / 0 fail / 23 files / 0 skip**
(577 baseline + 22 new; `verification/02-full-regression-final.txt`). Re-run after the last test
edit and after all mutation restores: identical 599/0/23.
