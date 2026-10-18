# GREEN evidence — final (2026-10-15T04:44:10Z)

## Ticket verification commands

### 1. TEST_DATABASE_URL=... bun test server/tests/payer-account.integration.test.ts + bun test server/tests/payer-ref.test.ts
Run together, and repeated 8x consecutively for race stability after the cross-index ON CONFLICT fix:
 18 pass  0 fail Ran 18 tests across 2 files. [587.00ms] 
 18 pass  0 fail Ran 18 tests across 2 files. [786.00ms] 
 18 pass  0 fail Ran 18 tests across 2 files. [626.00ms] 

### 2. bun run --filter server typecheck
server typecheck: Exited with code 0

### 3. bunx biome lint --error-on-warnings <changed files>
Checked 7 files in 31ms. No fixes applied.

### 4. bunx biome format <changed files>
Checked 7 files in 14ms. No fixes applied.

### 5. neighbouring credits suites (regression)
 90 pass
 0 fail
Ran 90 tests across 8 files. [1013.00ms]

### 6. mutation check (tests can fail)
Removing onConflictDoNothing from createPayerAccount made 2 tests fail (idempotency + 6-connection concurrency) before revert — recorded during the run.

### 7. teardown leaves the shared test DB clean
     0

