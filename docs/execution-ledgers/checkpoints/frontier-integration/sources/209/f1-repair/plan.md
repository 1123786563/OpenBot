# F1 Repair Plan — #209 concurrent `saveConversionRate` duplicate versions

> **For agentic workers:** This plan remediates review finding **F1 [Medium]** from
> `docs/execution-ledgers/checkpoints/209/review.md` only. Execute task-by-task with
> TDD RED→GREEN→REFACTOR. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Successful concurrent `saveConversionRate` calls commit unique, strictly
increasing `rateVersion` values atomically (F1: plain SELECT → client-side `+1` → upsert
lets two concurrent saves both read vN and both commit vN+1).

**Architecture:** Serialize the save's read-modify-write with a transaction-scoped
PostgreSQL advisory lock (`pg_advisory_xact_lock(hashtext(...))`) taken as the
transaction's first statement — the same idiom `server/src/memory/defaults.ts` uses for
its check-then-write races. The lock is held until commit, so the SELECT → compute →
upsert sequence inside the transaction is atomic across all writers; concurrent saves
queue instead of duplicating a version. No schema change, no migration (F1's suggested
row-lock alternative cannot lock a not-yet-existing row for the first-save race; the
immutable version table remains #210's job, as the review itself notes).

**Tech Stack:** TypeScript, drizzle-orm 0.45 (`bun-sql` driver), bun:test, PostgreSQL 17.

**Spec:** `docs/execution-ledgers/checkpoints/209/review.md` §F1; task brief from the
coordinator (task_4172be01cac4); module contract in
`server/src/gateway/conversion-rate.ts` L20-21 ("admin saves start at 1 and strictly
increment").

## Global Constraints

- Edit only: `server/src/gateway/conversion-rate-store.ts`,
  `server/tests/gateway-conversion-rate.integration.test.ts`, and new files under
  `docs/execution-ledgers/checkpoints/209/f1-repair/`.
- Original `docs/execution-ledgers/checkpoints/209/{report,review,checkpoint}.md`
  stay unchanged (historical).
- No commit, no push, no deploy, no gateway enablement, no schema/migration change
  (if one becomes necessary: STOP and ask the coordinator via `orca orchestration`).
- Integration tests only against `TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test`
  (never dev/prod; `tests/support/database.ts` refuses anything else named `openbot`).
- Unit + integration tests, `bun run --filter server typecheck`, and
  `bunx biome lint --error-on-warnings` (+ `format` check) for changed files must pass
  before the checkpoint report.
- No Ledger updates except through the coordinator.

## Determinism design (why the test is deterministic)

The un-fixed code parks, in order, on the target row's lock: SELECT (no lock) →
INSERT … ON CONFLICT (parks on a conflicting row lock). The test holds that row lock
from a third transaction (`SELECT … FOR UPDATE`, uncommitted) so BOTH competing saves
are guaranteed to have finished their read before either writes:

- Against the **current (buggy) code**: both saves read v1, park on the holder's lock;
  releasing the holder lets save 1 commit v2 and save 2's waiting upsert re-applies its
  client-computed constant v2 under READ COMMITTED (EvalPlanQual re-check against a SET
  constant) → duplicate version 2 → test FAILS (RED, deterministic).
- Against the **fixed code**: save 2 parks on save 1's advisory lock *before* its SELECT;
  after save 1 commits, it re-reads v2 and commits v3 → versions {2, 3} (order between
  the two calls is not fixed, distinctness and the persisted max are) → test PASSES.

Blocked-state observation uses the repo's established idiom
(`server/tests/agent-profile-store.integration.test.ts`): a dedicated
`application_name` on the savers' pool + polling `pg_stat_activity` /
`pg_blocking_pids` from the file's shared database until both save sessions are blocked.

---

### Task 1: RED — deterministic concurrency test

**Files:**
- Modify: `server/tests/gateway-conversion-rate.integration.test.ts` (append test + helpers)

**Interfaces:**
- Consumes: `saveConversionRate`, `readStoredConversionRate`,
  `CONVERSION_RATE_SETTING_KEY` (unchanged signatures), `createDatabase`,
  `TEST_POOL`, `testDatabaseUrl`, `enterpriseSettings`, `eq`, `sql`.
- Produces: test `competing concurrent saves commit distinct, strictly increasing versions`.

- [ ] **Step 1: Write the failing test** — add `sql` to the drizzle-orm import; add a
  `deferred()` helper; add a `waitForBlockedSaves(applicationName, savesSettled)` poller
  using `pg_stat_activity` + `pg_blocking_pids`; add the test (body below): seed v1 via
  `saveConversionRate(database, "7.5", "admin-seed")`; open a holder transaction that
  takes `SELECT … FOR UPDATE` on the row and parks on a deferred promise; start two
  `saveConversionRate` calls on a separate `application_name`-tagged database
  (`"12.34"` by `admin-first`, `"0.5"` by `admin-second`); wait until both are blocked;
  release the holder; then assert: both results `ok`, their two `rateVersion`s are
  exactly `[2, 3]`, and the persisted row has `rateVersion` 3 with the numerator/
  denominator/savedBy of whichever save returned 3. Timeout 10 s.

```ts
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForBlockedSaves(
  applicationName: string,
  aSettled: () => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await database.execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    if (([...rows][0]?.blocked ?? 0) >= 2) return;
    if (aSettled()) {
      throw new Error(
        "A competing save settled before both parked on the row lock; the F1 interleaving did not happen.",
      );
    }
    await new Promise((sleep) => setTimeout(sleep, 25));
  }
  throw new Error(`Timed out waiting for two blocked saves (${applicationName}).`);
}
```

Test body (inside the existing `describe`, after the tampered-row test):

```ts
test(
  "competing concurrent saves commit distinct, strictly increasing versions",
  async () => {
    await saveConversionRate(database, "7.5", "admin-seed");

    const saversUrl = new URL(testDatabaseUrl());
    saversUrl.searchParams.set(
      "application_name",
      "conversion_rate_f1_savers",
    );
    const savers = createDatabase(saversUrl.toString(), TEST_POOL);
    const holderUrl = new URL(testDatabaseUrl());
    holderUrl.searchParams.set(
      "application_name",
      "conversion_rate_f1_holder",
    );
    const holderDatabase = createDatabase(holderUrl.toString(), TEST_POOL);

    const rowLocked = deferred();
    const releaseRow = deferred();
    let held: Promise<unknown> = Promise.resolve();
    try {
      // Another writer parks on the target row, exactly like an in-flight save:
      // both competing saves must finish their read and then queue behind it.
      held = holderDatabase.transaction(async (tx) => {
        await tx
          .select()
          .from(enterpriseSettings)
          .where(eq(enterpriseSettings.key, CONVERSION_RATE_SETTING_KEY))
          .for("update");
        rowLocked.resolve();
        await releaseRow.promise;
      });
      await rowLocked.promise;

      const first = saveConversionRate(savers, "12.34", "admin-first");
      const second = saveConversionRate(savers, "0.5", "admin-second");
      const settled = { a: false, b: false };
      void first.then(
        () => {
          settled.a = true;
        },
        () => {
          settled.a = true;
        },
      );
      void second.then(
        () => {
          settled.b = true;
        },
        () => {
          settled.b = true;
        },
      );

      await waitForBlockedSaves("conversion_rate_f1_savers", () =>
        settled.a || settled.b,
      );
      releaseRow.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await held;

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      if (firstResult.ok && secondResult.ok) {
        expect(
          [firstResult.config.rateVersion, secondResult.config.rateVersion].sort(
            (a, b) => a - b,
          ),
        ).toEqual([2, 3]);
        const winner =
          firstResult.config.rateVersion === 3 ? firstResult : secondResult;
        const stored = await readStoredConversionRate(database);
        expect(stored.configured).toBe(true);
        if (stored.configured) {
          expect(stored.config.rateVersion).toBe(3);
          expect(stored.config.numerator).toBe(winner.config.numerator);
          expect(stored.config.denominator).toBe(winner.config.denominator);
          expect(stored.savedBy).toBe(
            winner === firstResult ? "admin-first" : "admin-second",
          );
        }
      }
    } finally {
      releaseRow.resolve();
      await held.catch(() => undefined);
      await holderDatabase.$client.close();
      await savers.$client.close();
    }
  },
  10_000,
);
```

- [ ] **Step 2: Run it to verify it fails (RED)**

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
```

Expected: the new test FAILS — sorted versions received `[2, 2]` (duplicate), expected
`[2, 3]` — while the 12 pre-existing tests still pass. Record output to `red.md`.

### Task 2: GREEN — serialize saves with a transaction-scoped advisory lock

**Files:**
- Modify: `server/src/gateway/conversion-rate-store.ts` (`saveConversionRate` only)

**Interfaces:**
- Consumes: `sql` (already imported), `pg_advisory_xact_lock(hashtext(key))`.
- Produces: unchanged public signatures; new module-private
  `CONVERSION_RATE_SAVE_LOCK_KEY = "openbot:gateway:conversion-rate-save"`.

- [ ] **Step 1: Take the advisory lock as the transaction's first statement**

Inside `saveConversionRate`'s `database.transaction(async (tx) => { ... })`, before the
SELECT:

```ts
// One writer at a time for this key (review F1): the transaction-scoped lock is held
// until commit, so the read-compute-write below cannot interleave with another save and
// hand out the same rateVersion twice. Same idiom as memory defaults' check-then-write.
await tx.execute(
  sql`select pg_advisory_xact_lock(hashtext(${CONVERSION_RATE_SAVE_LOCK_KEY}))`,
);
```

with the constant defined next to `CONVERSION_RATE_SETTING_KEY`:

```ts
/** Advisory-lock key serializing concurrent saves; xact-scoped, released on commit. */
const CONVERSION_RATE_SAVE_LOCK_KEY = "openbot:gateway:conversion-rate-save";
```

- [ ] **Step 2: Run the failing test to verify it passes (GREEN)**

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
```

Expected: 13 pass / 0 fail. Record to `green.md`.

### Task 3: REFACTOR + full targeted verification

- [ ] Update the module doc comment: note saves are serialized by an advisory lock so
  versions are unique and strictly increasing under concurrency (do not change
  contracts or the historical narrative elsewhere).
- [ ] Re-run BOTH ticket test files (unit + integration) — expect 45 pass and 13 pass.
- [ ] `bun run --filter server typecheck` — expect exit 0.
- [ ] `bunx biome lint --error-on-warnings` + `biome format` check on the two changed
  files — expect clean.
- [ ] Run the new concurrency test 3× to check for flakes.

### Task 4: Checkpoint + report (no commit)

- [ ] Capture `git rev-parse HEAD`, `git status`, full `git diff` (staged/unstaged),
  untracked file inventory with `shasum -a 256` for every file this repair touched or
  created.
- [ ] Write `docs/execution-ledgers/checkpoints/209/f1-repair/report.md` (what changed,
  test evidence, hashes, scope statement: F1 only; F2/F4 untouched per brief).
- [ ] Send `worker_done` with summary; coordinator owns the parent Ledger update.

## Self-Review

- Spec coverage: F1's requirement ("concurrent admin saves cannot commit duplicate
  versions"; task: "both succeed, distinct sequential versions, persisted latest = max")
  → Task 1 test asserts exactly that; Task 2 makes it true. ✓
- No placeholders; exact code given for test and fix. ✓
- Type consistency: `SaveConversionRateResult` union consumed via `.ok` narrowing;
  `database.execute<T>` generic matches `memory/defaults.ts` usage; `.for("update")`
  matches existing drizzle usage. ✓
- Scope: no schema/migration touched; `enterprise_settings` shape unchanged. ✓
