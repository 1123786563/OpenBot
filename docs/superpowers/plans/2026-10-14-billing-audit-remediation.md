# Billing Audit Remediation (2026-10-14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-10-14 · **Source:** the code-verified billing audit `2026-10-14-billing-code-audit.md` (baseline `main` @ `c0167c5c`; 471 billing unit tests passing, `cd server && bun run typecheck` exit 0).

**Goal:** Close the audit's P0–P3 defects — the two paths that lose usage facts, the credit-balance read that disagrees with the admission authority, the misleading refusals, and the money/ops hygiene items — without re-opening the verified reservation/outbox/payment/reconcile seams.

**Architecture:** Three structural moves, everything else is narrow. (1) One new module `server/src/billing/capacity.ts` becomes the single definition of "spendable credit capacity"; the credit writer (admission) and the credit reader (the page) both consume it, so the two can no longer disagree. (2) One new module `server/src/billing/usage-evidence.ts` becomes the single way an *unsettled* metered call leaves a durable trace, used by both the unknown-outcome failure path and the over-bound settlement path. (3) Refusal vocabulary splits: "you have no credits", "this deployment has no prices", "this model has no price" and "the gate itself broke" become four distinct sentinels instead of one. No seam is replaced; no new seam is added where nothing varies.

**Tech Stack:** TypeScript, Bun Test, Drizzle ORM, PostgreSQL, Hono, Zod, TanStack Query (frontend).

**Spec:** `docs/superpowers/specs/2026-10-11-billing-reliability-design.md` (the approved billing reliability design) · Audit: `2026-10-14-billing-code-audit.md` · ADRs: `docs/adr/0001-conservative-input-bound.md`, `docs/adr/0003-bifrost-openbot-credit-admission.md` · Domain language: `CONTEXT.md`.

## Global Constraints

- Keep integer/rational credit arithmetic end to end. No `Number()` between the database and a money/credit comparison. `CREDIT_SCALE = 100`; stored columns are 32-bit (`MAX_STORED_UNITS = 2_147_483_647`).
- Amounts and credit units stay integers in storage; never introduce binary floating-point accounting. Display-only division by 100 is allowed and must stay display-only.
- Append migrations; never edit an applied migration. Generate with `cd server && bun run db:generate`; the generated filename is drizzle's own (next journal slot after `0109_openmuse_final_hardening.sql`).
- Integration tests require an explicit, dedicated `TEST_DATABASE_URL`; never fall back to `DATABASE_URL` (`server/tests/support/database.ts` already refuses).
- The reconciler stays read-only. Recovery of a stuck hold or a blocked delivery is a writer-path or operator concern, never a reconcile-time mutation.
- No automatic refunds; duplicate collections remain operator-resolved.
- Database uniqueness/transactions and durable idempotency records are the correctness authority. Read-before-write checks stay optimizations only.
- Error messages crossing an HTTP boundary carry the sentinel code and nothing else — never a URL, status line, stack, or credential.
- Fail-closed stays fail-closed: an unreadable balance, an unpriced model and an unknown usage outcome all refuse. This plan makes refusals *honest and diagnosable*; it does not loosen any of them.
- Every task ends with `cd server && bun run typecheck` exit 0 and its named test files green.

## Scope Check

The audit spans four subsystems that ship independently. This plan keeps them as four phases so each phase is a reviewable, deployable unit; phases may be executed as separate branches/worktrees.

| Phase | Deliverable | Tasks |
| --- | --- | --- |
| A (P0) | No metered call can lose its usage fact; the balance the page shows is the balance admission enforces | T1–T3 |
| B (P1) | A refusal names its real cause; a paid order cannot strand on a config-range bug; a webhook storage failure is graded retryable | T4–T7 |
| C (P2) | Replay window, currency, delivery terminal states, projection retirement, code-run guard | T8–T12 |
| D (P3) | Dead code and lying comments removed; overdraw visible; reconciliation and sweepers operationally bounded | T13–T15 |

**Task-level parallelism:** T5, T6, T7 touch disjoint files and may run in parallel. T1 must land before T13 (both edit `credits.ts`) and before T12 (both edit `credits-writer.ts`). T2 must land before T3 (T3 consumes T2's module). T8 and T10 both add a migration — serialize them or coordinate journal slots.

## Decision gates (NOT tasks — resolve before the named task starts)

The audit found four items that are decisions, not defects. Per `AGENTS.md`, an implementation phase must not silently re-decide an approved Spec or ADR. Each gate names what to decide, who decides, and which task it blocks.

| Gate | Question | Blocks | Default if unanswered |
| --- | --- | --- | --- |
| **G1 — Credit ownership (audit B1)** | `CONTEXT.md` and ADR-0002/0003 make the **OpenBot user** the credit subject; the implementation has one deployment-wide customer key and no owner column on `credit_grants` / `credit_ledger` / `credit_reservations`, so every signed-in user reads the whole deployment's balance and consumption history. Decide: amend `CONTEXT.md` to "deployment is the subject, consumption history is visible to all members", or add per-user ownership (schema + customer key derivation). This is an ADR-level change. | Nothing in this plan (no task depends on it) — but it must be recorded before the Bifrost work in ADR-0003 starts. | Do not implement either side here. Raise via `matt:domain-modeling` → ADR update. |
| **G2 — Spec vs ADR-0001 (audit B2)** | The approved Spec (`…-billing-reliability-design.md`, "Billed admission per surface") still says every billed model call refuses `input_bound_unsupported` until a *provider* count-tokens contract lands. ADR-0001 and the code instead declare `bounds.input.enforced = "counted"` from a local byte-based estimate plus truncation. Decide which document is authoritative and update the other. | T3's doc-rewrite step (it must quote the winning document) | T3 rewrites the comments to describe **current verified behavior** and adds a dated note naming the unresolved conflict; it does not pick a side. |
| **G3 — Reservation sizing (audit A4)** | The hold is the worst-case ceiling: with the current `.env` (`GLM-5.3`, input 128000 @ 1/100, output 16384 @ 1/20) every call holds **21.00 credits**, so a balance under 21 credits admits nothing. Decide whether to keep worst-case holds (and accept the floor) or introduce a configured typical-case hold with an over-hold settlement path. | T4 (T4 only makes the refusal diagnosable; it does not resize holds) | Keep worst-case. T4 logs `available` vs `required` on every refusal so the floor is visible. |
| **G4 — Over-bound product behavior (audit A3)** | Today an over-bound finish tears down the completed answer (`controller.error`) *and* loses the usage fact. T3 fixes the lost fact. Whether the person should still lose a completed answer is a product decision. | T3's stream-behavior step (default: unchanged) | Unchanged: keep erroring the stream. T3 records the fact either way. |

## Finding ledger → task map

| Audit finding | Severity | Task |
| --- | --- | --- |
| A1 summary counts expired grants, ignores holds; read side untested | high | **T1** |
| A2 missing provider usage releases the hold and charges nothing | high | **T2** |
| A3 over-bound path destroys the usage fact | high | **T3** |
| A4 (part) three refusals share one sentinel; `issues` never logged; hold floor invisible | medium-high | **T4** |
| C2 `.env.example` missing the four `BILLING_*` keys | medium | **T4** |
| A6 no int32 range check on catalog `credits`/`priceCents` or `grantCredits` | medium | **T5** |
| A8 non-retryable persistence failure answered 400 on the webhook | medium | **T6** |
| C4 Alipay amount via float division; exact helper unused | low-medium | **T7** |
| A7 webhook replay: identity from an unsigned header, no `exp`/`iat` check | medium | **T8** |
| A5 currency never compared at settlement | medium | **T9** |
| C1 usage delivery has no terminal state for permanent failures | medium-high | **T10** |
| B6 subscription projection only ever grows | medium | **T11** |
| B3 code-run outbox row without reservation facts ⇒ permanently blocked | medium | **T12** |
| B4/B5/C5 dead code and comments describing deleted behavior | medium | **T13** |
| D1 overdraw invisible in UI and reconciliation | medium | **T14** |
| D2 `usage.tsx` renders `grantCount` and `remaining` from different filters | low-medium | **T1** (Step 9 makes both come from one filtered set, and surfaces `held`) |
| C3 reconcile loads whole tables; sweepers have no single-instance guard; `stop()` discarded | medium | **T15** |
| D3 display-layer float division (`format.ts`, `scaleDown`) | low | no task — display-only and never compared; T14 keeps it that way and the audit's note stands |
| B1 credit ownership, B2 Spec/ADR conflict, A4 sizing, A3 stream behavior | decision | **G1–G4** |

---

# Phase A — no metered call loses its facts (P0)

### Task 1: One definition of spendable capacity (`capacity.ts`), and a summary that agrees with admission

**Why:** `credits.ts:78-87` adds every grant's `remaining` into the summary regardless of expiry (`live` is computed and then used only for `grantCount`) and never subtracts active reservations, while the writer's `availableOf` does both. Verified: an expired 50-credit promo grant yields `rewards:{remaining:50, grantCount:0}`. The fix is not a patch to `summary` — it is moving "what is spendable" into one module both sides consume, so the two cannot drift again.

**Files:**
- Create: `server/src/billing/capacity.ts`
- Modify: `server/src/billing/credits-writer.ts` (replace the local `freeGrants`/`remainderOf`/`availableOf` with `capacity.ts`; `readBalance`/`availableBalance`/`reserveCredits`/`consumeCredits`/`settleReservation` keep their signatures)
- Modify: `server/src/billing/credits.ts:60-105` (`summary` becomes `liveGrants` + `summarizeCapacity`)
- Modify: `server/src/billing/types.ts:412-421` (`CreditSummary` gains `held`)
- Modify: `app/src/lib/billing/credits.ts:14-24` (`CreditSummary` mirror)
- Test: `server/tests/billing-capacity.test.ts` (new, pure-function unit tests)
- Test: `server/tests/billing-credits-summary.integration.test.ts` (new, real PostgreSQL)

**Interfaces:**
- Consumes: `creditGrants`, `creditChargeRemainders` schemas; `CreditSummary`, `CreditGrantSource` from `./types`; `Database` from `../db/client`.
- Produces (later tasks rely on these exact names):
  ```ts
  // server/src/billing/capacity.ts
  export type GrantCapacity = {
    id: string; source: CreditGrantSource; total: number; used: number;
    held: number; free: number; expiresAt: Date;
  };
  export type CapacityBreakdown = {
    grants: readonly GrantCapacity[]; freeUnits: number;
    owedUnit: 0 | 1; spendableUnits: number;
  };
  export function liveGrants(db: Reader, externalId: string, at: Date, lock: boolean): Promise<GrantCapacity[]>;
  export function carriedRemainder(db: Reader, externalId: string): Promise<{ numerator: bigint; denominator: bigint }>;
  export function readCapacity(db: Reader, externalId: string, at?: Date): Promise<CapacityBreakdown>;
  // server/src/billing/credits.ts
  export function summarizeCapacity(grants: readonly GrantCapacity[]): CreditSummary;
  ```

- [ ] **Step 1: Write the failing pure-function tests**

Create `server/tests/billing-capacity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { summarizeCapacity } from "../src/billing/credits";
import type { GrantCapacity } from "../src/billing/capacity";

const grant = (over: Partial<GrantCapacity> = {}): GrantCapacity => ({
  id: "cg-1",
  source: "plan",
  total: 10_000,
  used: 1_000,
  held: 0,
  free: 9_000,
  expiresAt: new Date(Date.now() + 86_400_000),
  ...over,
});

describe("summarizeCapacity", () => {
  test("held capacity is not spendable and is reported separately", () => {
    const summary = summarizeCapacity([grant({ held: 2_100, free: 6_900 })]);
    expect(summary.plan.total).toBe(100);
    expect(summary.plan.used).toBe(10);
    expect(summary.plan.held).toBe(21);
    expect(summary.plan.remaining).toBe(69);
  });

  test("a grant drawn to zero by a hold counts as held, not as remaining", () => {
    const summary = summarizeCapacity([grant({ held: 10_000, free: 0 })]);
    expect(summary.plan.remaining).toBe(0);
    expect(summary.plan.held).toBe(100);
  });

  test("reward grantCount counts exactly the grants that still have remaining", () => {
    const summary = summarizeCapacity([
      grant({ id: "cg-a", source: "promo", total: 5_000, used: 5_000, free: 0 }),
      grant({ id: "cg-b", source: "signin", total: 5_000, used: 0, free: 5_000 }),
      grant({ id: "cg-c", source: "promo", total: 5_000, used: 0, held: 5_000, free: 0 }),
    ]);
    expect(summary.rewards.grantCount).toBe(1);
    expect(summary.rewards.remaining).toBe(50);
    expect(summary.rewards.held).toBe(50);
  });

  test("an empty ledger is all zeros, never NaN", () => {
    expect(summarizeCapacity([])).toEqual({
      plan: { total: 0, used: 0, remaining: 0, held: 0 },
      rewards: { total: 0, used: 0, remaining: 0, held: 0, grantCount: 0 },
    });
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `cd server && bun test tests/billing-capacity.test.ts`
Expected: FAIL — `summarizeCapacity` is not exported, and `CreditSummary` has no `held`.

- [ ] **Step 3: Write `capacity.ts`**

Create `server/src/billing/capacity.ts`:

```ts
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditGrants } from "../db/schema/credits";
import { creditChargeRemainders } from "../db/schema/credit-reservations";
import type { CreditGrantSource } from "./types";

/**
 * The ONE definition of spendable credit capacity, shared by the writer's admission
 * (./credits-writer.ts) and the reader's page answer (./credits.ts).
 *
 * Before this module the two sides computed capacity separately and disagreed: the writer
 * excluded expired grants and subtracted active holds, the reader did neither, so the page
 * showed a balance admission would refuse (audit A1). Capacity is now a fact with one owner.
 *
 * One clock per computation: the grant-liveness filter and the hold-expiry filter are bound to
 * the SAME app-side instant passed in as `at`, never the database's `now()` — app and database
 * clocks skew, and a skewed pair would let a hold be admitted against capacity an expired hold
 * already vacated (or refuse one that is still live).
 */

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Reader = Pick<Database, "select"> | Tx;

/** One live grant's capacity, in scaled units (×100). `free` is what a new draw or hold may take. */
export type GrantCapacity = {
  id: string;
  source: CreditGrantSource;
  total: number;
  used: number;
  /** Sum of every active (reserved, unexpired) hold allocated against this grant. */
  held: number;
  /** max(total - used - held, 0) — per grant, so a clamp on one grant never hides capacity in another. */
  free: number;
  expiresAt: Date;
};

/** The customer's whole capacity picture: the grants, and the three sums a caller needs. */
export type CapacityBreakdown = {
  grants: readonly GrantCapacity[];
  /** Σ free over live grants. */
  freeUnits: number;
  /** A carried fractional charge keeps one whole unit occupied. */
  owedUnit: 0 | 1;
  /** What a new hold could take right now: max(freeUnits - owedUnit, 0). */
  spendableUnits: number;
};

/**
 * Live grants, soonest expiry first, with capacity left after used units and active holds.
 *
 * An "active" hold is reserved AND not yet expired (audit F4 in the 2026-10-13 remediation): a
 * hold whose expiry has passed no longer occupies capacity — reconciliation reports the stuck row
 * for an operator. `lock: true` takes `FOR UPDATE` on the grant rows and is only legal inside a
 * transaction that already holds the customer lock.
 */
export async function liveGrants(
  db: Reader,
  externalId: string,
  at: Date,
  lock: boolean,
): Promise<GrantCapacity[]> {
  const query = db
    .select({
      id: creditGrants.id,
      source: creditGrants.source,
      total: creditGrants.total,
      used: creditGrants.used,
      expiresAt: creditGrants.expiresAt,
      held: sql<number>`coalesce((
        select sum(a.amount)::int
        from credit_reservation_allocations a
        join credit_reservations r on r.id = a.reservation_id
        where a.grant_id = credit_grants.id and r.status = 'reserved' and r.expires_at > ${at}
      ), 0)`,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.externalCustomerId, externalId),
        gt(creditGrants.expiresAt, at),
      ),
    )
    .orderBy(
      asc(creditGrants.expiresAt),
      asc(creditGrants.grantedAt),
      asc(creditGrants.id),
    );
  const rows = await (lock ? query.for("update", { of: creditGrants }) : query);
  return rows.map((row) => {
    const held = Number(row.held);
    return {
      id: row.id,
      source: row.source,
      total: row.total,
      used: row.used,
      held,
      free: Math.max(row.total - row.used - held, 0),
      expiresAt: row.expiresAt,
    };
  });
}

/** The per-customer fraction of a scaled unit that exact-rational charges have accrued. */
export async function carriedRemainder(
  db: Reader,
  externalId: string,
): Promise<{ numerator: bigint; denominator: bigint }> {
  const [row] = await db
    .select({
      numerator: creditChargeRemainders.numerator,
      denominator: creditChargeRemainders.denominator,
    })
    .from(creditChargeRemainders)
    .where(eq(creditChargeRemainders.externalCustomerId, externalId))
    .limit(1);
  return row
    ? { numerator: BigInt(row.numerator), denominator: BigInt(row.denominator) }
    : { numerator: 0n, denominator: 1n };
}

/** The spendable answer, unlocked: a pre-call signal, never the admission authority. */
export async function readCapacity(
  db: Reader,
  externalId: string,
  at: Date = new Date(),
): Promise<CapacityBreakdown> {
  const grants = await liveGrants(db, externalId, at, false);
  const owed = await carriedRemainder(db, externalId);
  const freeUnits = grants.reduce((sum, grant) => sum + grant.free, 0);
  const owedUnit: 0 | 1 = owed.numerator > 0n ? 1 : 0;
  return {
    grants,
    freeUnits,
    owedUnit,
    spendableUnits: Math.max(freeUnits - owedUnit, 0),
  };
}
```

- [ ] **Step 4: Extend `CreditSummary` and implement `summarizeCapacity`**

In `server/src/billing/types.ts`, replace the `CreditSummary` type (currently at `:412-421`) with:

```ts
/**
 * The 套餐与积分 page's balance answer, over LIVE grants only (unexpired), in credits (×100
 * scaled units on the wire). `remaining` is what a draw or a new hold could take per grant, so it
 * already excludes `held`; `total`/`used` are the same live grants' lifetime figures, which is why
 * `remaining` is not `total - used`. Expired grants drop out of this answer entirely and stay
 * visible, with their derived `expired` status, in the grant list.
 *
 * Computed by `summarizeCapacity` in ./credits.ts over the SAME `liveGrants` read the credit
 * writer admits against (./capacity.ts) — one口径, so the page can no longer show a balance the
 * gate would refuse. The one deliberate difference: the writer also occupies a single extra unit
 * while a fractional remainder is owed (`owedUnit`, at most 0.01 credit), which this answer does
 * not subtract.
 */
export type CreditSummary = {
  plan: { total: number; used: number; remaining: number; held: number };
  rewards: {
    total: number;
    used: number;
    remaining: number;
    held: number;
    /** How many reward grants still have something to spend ("可用 N 个"). */
    grantCount: number;
  };
};
```

In `server/src/billing/credits.ts`, add the import and the pure function (keep `CREDIT_SCALE`, `scaleDown`, `grantOf`, `deriveGrantStatus` exactly as they are):

```ts
import {
  type GrantCapacity,
  liveGrants,
} from "./capacity";

/**
 * The page's balance answer, from the same per-grant capacity facts admission uses. Pure, so the
 * aggregation is testable without a database (audit A1: the previous version was reachable only
 * through a live query and had no test at all).
 */
export function summarizeCapacity(
  grants: readonly GrantCapacity[],
): CreditSummary {
  const plan = { total: 0, used: 0, remaining: 0, held: 0 };
  const rewards = { total: 0, used: 0, remaining: 0, held: 0, grantCount: 0 };
  for (const grant of grants) {
    const bucket = grant.source === "plan" ? plan : rewards;
    bucket.total += grant.total;
    bucket.used += grant.used;
    bucket.held += grant.held;
    bucket.remaining += grant.free;
    if (grant.source !== "plan" && grant.free > 0) rewards.grantCount += 1;
  }
  return {
    plan: {
      total: scaleDown(plan.total),
      used: scaleDown(plan.used),
      remaining: scaleDown(plan.remaining),
      held: scaleDown(plan.held),
    },
    rewards: {
      total: scaleDown(rewards.total),
      used: scaleDown(rewards.used),
      remaining: scaleDown(rewards.remaining),
      held: scaleDown(rewards.held),
      grantCount: rewards.grantCount,
    },
  };
}
```

and replace the body of `summary` (the whole `const rows = await database.select()…` loop, `credits.ts:60-105`) with:

```ts
    async summary(externalCustomerId) {
      // The same live-grant read admission uses, unlocked: expired grants drop out and active
      // holds are subtracted, so this answer and the gate's answer cannot disagree (audit A1).
      const grants = await liveGrants(
        database,
        keyOf(externalCustomerId),
        new Date(),
        false,
      );
      return summarizeCapacity(grants);
    },
```

- [ ] **Step 5: Run the pure tests green**

Run: `cd server && bun test tests/billing-capacity.test.ts tests/billing-credits.test.ts`
Expected: PASS. `billing-credits.test.ts` uses a hand-written `Credits` stub whose `summary` now needs the two `held` fields — update that stub in the same step:

```ts
    summary: async () => ({
      plan: { total: 500, used: 100, remaining: 400, held: 0 },
      rewards: { total: 100, used: 23.63, remaining: 76.37, held: 0, grantCount: 2 },
    }),
```

- [ ] **Step 6: Point the credit writer at `capacity.ts` (no behavior change, one owner)**

In `server/src/billing/credits-writer.ts`:
1. Add `import { type GrantCapacity, carriedRemainder, liveGrants, readCapacity, type Reader, type Tx } from "./capacity";`
2. Delete the local `freeGrants`, `remainderOf`, `availableOf`, and the local `type Tx` / `type Reader` declarations at the bottom of the file.
3. Replace every call site, keeping the one-clock discipline by hoisting a single `at`:
   - `readBalance` and `availableBalance` both become `return (await readCapacity(database, externalCustomerId)).spendableUnits;`
   - in `reserveCredits`: `const at = new Date();` before the transaction body, then `const grants = await liveGrants(tx, input.externalCustomerId, at, true);` and `const owed = await carriedRemainder(tx, input.externalCustomerId);`
   - in `consumeCredits`: same two calls with `liveGrants(tx, input.externalCustomerId, at, true)` / `carriedRemainder(tx, …)`, and the final `const after = await availableOf(tx, …)` becomes `const after = (await readCapacity(tx, input.externalCustomerId, at)).spendableUnits;`
4. `GrantCapacity` has `free` where the old local type had `free`, so the draw loops are unchanged; the `reserveCredits` allocation loop reads `grant.free` and `grant.id` exactly as before.

- [ ] **Step 7: Write the failing integration test (real PostgreSQL)**

Create `server/tests/billing-credits-summary.integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The read side of the ledger against a real database (audit A1): the summary must show only
 * what admission would actually let you spend — expired grants excluded, active holds subtracted
 * — and `grantCount` must count exactly the grants behind `remaining`.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const credits = createCredits({
  database,
  externalCustomerKey: "",
  catalog: new Map(),
});
const prefix = `sumtest-${randomUUID().slice(0, 8)}`;

// The same teardown discipline the other integration suites use: delete by the run's own prefix,
// children first, then close the pool. No shared fixture, no cross-test coupling.
afterAll(async () => {
  const { sql } = await import("drizzle-orm");
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_reservation_allocations WHERE reservation_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE idempotency_key LIKE ${`${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`${prefix}%`}`,
  );
  await database.$client.close();
});

test("an expired grant is not part of the balance, and a live hold is", async () => {
  const customer = `${prefix}-a`;
  const live = `${prefix}-live`;
  const expired = `${prefix}-expired`;

  await writer.grantCredits({
    externalCustomerId: customer,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: live,
  });
  await writer.grantCredits({
    externalCustomerId: customer,
    source: "promo",
    totalCents: 5_000,
    expiresAt: new Date(Date.now() - 1_000),
    idempotencyKey: expired,
  });

  const beforeHold = await credits.summary(customer);
  expect(beforeHold.plan).toEqual({ total: 100, used: 0, remaining: 100, held: 0 });
  expect(beforeHold.rewards.remaining).toBe(0);
  expect(beforeHold.rewards.grantCount).toBe(0);
  expect(beforeHold.rewards.total).toBe(0);

  const reserved = await writer.reserveCredits({
    externalCustomerId: customer,
    idempotencyKey: `${prefix}-hold`,
    maximumCents: 2_100,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(reserved.reserved).toBe(true);

  const held = await credits.summary(customer);
  expect(held.plan.held).toBe(21);
  expect(held.plan.remaining).toBe(79);

  if (reserved.reserved) {
    await writer.releaseReservation(reserved.reservationId, "test");
  }
  const released = await credits.summary(customer);
  expect(released.plan.remaining).toBe(100);
  expect(released.plan.held).toBe(0);

  // The page and the gate agree, to within the one unit a carried remainder occupies.
  const spendable = await writer.availableBalance(customer);
  expect(released.plan.remaining * 100 + released.rewards.remaining * 100 - spendable).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 8: Run it and verify it fails, then passes**

Run: `cd /Users/wuyongjun/trea/OpenBot && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-credits-summary.integration.test.ts`
Expected before Step 3–6: FAIL (`rewards.remaining` is 50, `held` is undefined). After: PASS.

- [ ] **Step 9: Update the frontend mirror and the one place that renders the pair**

`app/src/lib/billing/credits.ts` — replace the `CreditSummary` type with:

```ts
export type CreditSummary = {
  plan: { total: number; used: number; remaining: number; held: number };
  rewards: {
    total: number;
    used: number;
    remaining: number;
    held: number;
    grantCount: number;
  };
};
```

`app/src/routes/_authed/settings/usage.tsx:220-224` — pass `held` to the copy so a non-zero hold explains a smaller balance:

```tsx
            {t("creditsPage.rewardsSummary", {
              count: summary.data?.rewards.grantCount ?? 0,
              remaining: formatCredits(summary.data?.rewards.remaining ?? 0),
              held: formatCredits(summary.data?.rewards.held ?? 0),
            })}
```

Add the `held` interpolation to `creditsPage.rewardsSummary` in **both** `app/src/locales/en/settings.json` and `app/src/locales/zh-CN/settings.json` (keep the existing wording and append the hold clause):
- en: `"{{count}} rewards, {{remaining}} available ({{held}} held by in-progress calls)"`
- zh-CN: `"{{count}} 个奖励，可用 {{remaining}}（进行中调用占用 {{held}}）"`

`app/tests/billing-credits-ui.test.tsx` renders this page: if it asserts the old copy or a `summary` fixture without `held`, update the fixture and the expected string in the same commit. Do not weaken the assertion — restate it against the new copy.

- [ ] **Step 10: Typecheck, run the billing suites, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-capacity.test.ts server/tests/billing-credits.test.ts server/tests/billing-credits-writer.integration.test.ts server/tests/qa-batch2-credits-consume.integration.test.ts
cd /Users/wuyongjun/trea/OpenBot/app && bun test tests/billing-credits-ui.test.tsx
```
Expected: typecheck exit 0; all suites green.

```bash
git add server/src/billing/capacity.ts server/src/billing/credits.ts server/src/billing/credits-writer.ts server/src/billing/types.ts \
        server/tests/billing-capacity.test.ts server/tests/billing-credits-summary.integration.test.ts server/tests/billing-credits.test.ts \
        app/src/lib/billing/credits.ts app/src/routes/_authed/settings/usage.tsx app/src/locales/en/settings.json app/src/locales/zh-CN/settings.json
git commit -m "fix(billing): one capacity owner — summary excludes expired grants and subtracts holds (audit A1)"
```

---

### Task 2: An unknown usage outcome keeps its hold and leaves evidence (`usage_missing`)

**Why:** `copilot.ts` maps three different situations onto `settleFail("no_usage")`, which the gate turns into `releaseReservation`: a stream that ends with no finish part (`:777`), a finish part whose usage numbers are absent (`:823` → `billedInput = inputTokens ?? 0`), and a finish part that genuinely reports zero (`:875`). Only the third is "confirmed no cost". Per `CONTEXT.md` **Pending Settlement** and ADR-0003 ("结果未知时保留预留，直到可靠结算或确认无费用后释放"), the first two must retain the hold — and today they leave no trace at all: no outbox row, no Lago event, no anomaly.

**Files:**
- Create: `server/src/billing/usage-evidence.ts`
- Modify: `server/src/copilot.ts:390-395` (`ModelUsageFailureReason`), `:770-790` (`chunk.done`), `:815-880` (finish-part usage classification)
- Modify: `server/src/index.ts:3717-3730` (the gate's `fail` handler)
- Modify: `server/tests/qa-batch1-llm-meter-id.test.ts:29-39` (the source-text probe becomes a behavioral assertion)
- Test: `server/tests/copilot-usage-meter.test.ts` (new cases), `server/tests/billing-usage-evidence.test.ts` (new)

**Interfaces:**
- Consumes: `UsageOutbox.record` (`server/src/billing/usage-outbox.ts`), `UsageOutboxConflictError`.
- Produces:
  ```ts
  // server/src/billing/usage-evidence.ts
  export type UnsettledUsageInput = {
    eventId: string;
    source: "llm" | "code_run";
    externalCustomerId: string;
    model: string;
    client: string;
    occurredAt: Date;
    inputTokens: number;
    outputTokens: number;
    reason: string;
  };
  export function createUsageEvidenceRecorder(
    outbox: Pick<UsageOutbox, "record">,
    log?: (message: string) => void,
  ): (input: UnsettledUsageInput) => Promise<void>;
  // server/src/copilot.ts
  export type ModelUsageFailureReason =
    | "provider_error" | "stream_error" | "no_usage"
    | "usage_missing" | "cancelled" | "bound_refused";
  ```

- [ ] **Step 1: Write the failing evidence-recorder test**

Create `server/tests/billing-usage-evidence.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createUsageEvidenceRecorder,
  type UnsettledUsageInput,
} from "../src/billing/usage-evidence";
import { UsageOutboxConflictError } from "../src/billing/usage-outbox";

const input: UnsettledUsageInput = {
  eventId: "ev-1",
  source: "llm",
  externalCustomerId: "openbot-deployment-t1",
  model: "GLM-5.3",
  client: "web",
  occurredAt: new Date("2026-10-14T00:00:00.000Z"),
  inputTokens: 0,
  outputTokens: 0,
  reason: "usage_missing",
};

describe("the unsettled-usage evidence recorder", () => {
  test("writes a durable outbox row with no reservation facts, so both targets end in evidence", async () => {
    const rows: unknown[] = [];
    const record = createUsageEvidenceRecorder({
      record: async (row) => {
        rows.push(row);
        return { inserted: true };
      },
    });
    await record(input);
    expect(rows).toEqual([
      {
        eventId: "ev-1",
        source: "llm",
        externalCustomerId: "openbot-deployment-t1",
        transactionId: "ev-1",
        inputTokens: 0,
        outputTokens: 0,
        model: "GLM-5.3",
        client: "web",
        occurredAt: input.occurredAt,
        reservationId: null,
        actualCostNumerator: null,
        actualCostDenominator: null,
        status: "usage_missing",
      },
    ]);
  });

  test("a conflicting row (real facts already committed) is a superseded evidence write, not a failure", async () => {
    const messages: string[] = [];
    const record = createUsageEvidenceRecorder(
      {
        record: async () => {
          throw new UsageOutboxConflictError("ev-1");
        },
      },
      (message) => messages.push(message),
    );
    await record(input);
    expect(messages.join("\n")).toContain("usage_evidence_superseded");
  });

  test("a rejected write is logged with both stable ids and never throws into the run", async () => {
    const messages: string[] = [];
    const record = createUsageEvidenceRecorder(
      {
        record: async () => {
          throw new Error("connection reset");
        },
      },
      (message) => messages.push(message),
    );
    await record(input);
    expect(messages.join("\n")).toContain("usage_evidence_write_failed");
    expect(messages.join("\n")).not.toContain("connection reset");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd server && bun test tests/billing-usage-evidence.test.ts`
Expected: FAIL — cannot resolve `../src/billing/usage-evidence`.

- [ ] **Step 3: Implement `usage-evidence.ts`**

```ts
import { type UsageOutbox, UsageOutboxConflictError } from "./usage-outbox";

/**
 * The durable trace an UNSETTLED metered call leaves (audit A2/A3).
 *
 * A billed call whose cost could not be determined — the provider never reported usage, the
 * stream broke mid-answer, or the reported usage exceeded the configured bound — is not a free
 * call and is not a chargeable one. `CONTEXT.md` names the state: **Pending Settlement**, the
 * hold stays occupied until settlement or a confirmed no-cost. Retaining the hold is only half of
 * honest: the operator also needs a record that the call happened and what it looked like.
 *
 * The record rides the existing outbox rather than a new table. The row carries NO reservation
 * facts, so the credits target blocks it (`missing_reservation`, a terminal manual-review state)
 * and the Lago target still meters the tokens the provider did report. The reservation itself is
 * left `reserved`: it expires on its own clock and reconciliation reports it as
 * `expired_reserved_reservation`, naming this same event id (the reservation's idempotency key is
 * `usage:<eventId>`). One row, three existing findings, no new vocabulary.
 *
 * Never throws: this is evidence on a failure path, and a failed evidence write must not replace
 * the failure it describes. Both outcomes are logged by stable code, with no error message —
 * a driver error can carry connection details.
 */
export type UnsettledUsageInput = {
  eventId: string;
  source: "llm" | "code_run";
  externalCustomerId: string;
  model: string;
  client: string;
  occurredAt: Date;
  /** What the provider reported, when it reported anything; zero for an outcome we never learned. */
  inputTokens: number;
  outputTokens: number;
  /** The unsettled reason, stored in the outbox's free-text `status` column. */
  reason: string;
};

/**
 * The failure reasons that mean "confirmed no cost" — the only ones that may release a hold
 * (audit A2). Everything else is an unknown outcome: `CONTEXT.md` Pending Settlement and ADR-0003
 * both keep the reservation occupied until settlement or a confirmed no-cost. Lifted out of the
 * gate's closure into this module so the decision is a testable pure function, not a `Set` literal
 * buried in 4000 lines of assembly.
 */
export const CONFIRMED_NO_COST_REASONS: ReadonlySet<string> = new Set([
  "provider_error", // the provider refused before producing anything
  "bound_refused", // admission refused before the provider was called
  "no_usage", // the provider reported a finish with zero tokens
]);

export function isConfirmedNoCost(reason: string): boolean {
  return CONFIRMED_NO_COST_REASONS.has(reason);
}

export function createUsageEvidenceRecorder(
  outbox: Pick<UsageOutbox, "record">,
  log: (message: string) => void = (message) => console.warn(message),
): (input: UnsettledUsageInput) => Promise<void> {
  return async (input) => {
    try {
      await outbox.record({
        eventId: input.eventId,
        source: input.source,
        externalCustomerId: input.externalCustomerId,
        transactionId: input.eventId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        model: input.model,
        client: input.client,
        occurredAt: input.occurredAt,
        reservationId: null,
        actualCostNumerator: null,
        actualCostDenominator: null,
        status: input.reason,
      });
    } catch (error) {
      if (error instanceof UsageOutboxConflictError) {
        // The event already holds different (real) facts: the settlement wrote them first, so
        // this evidence is superseded by something better. Not a failure.
        log(
          `billing: usage_evidence_superseded event=${input.eventId} reason=${input.reason}`,
        );
        return;
      }
      log(
        `billing: usage_evidence_write_failed event=${input.eventId} reason=${input.reason} code=${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
    }
  };
}
```

- [ ] **Step 4: Run the evidence test green**

Run: `cd server && bun test tests/billing-usage-evidence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing copilot classification tests**

Append to `server/tests/copilot-usage-meter.test.ts` (inside the existing `describe("the model usage bound contract (pre-call admission)")` block's sibling — a new top-level describe; reuse that file's existing `fakeStream`/gate harness shapes exactly as the neighbouring tests do):

```ts
describe("an unknown usage outcome keeps the hold (audit A2)", () => {
  test("a stream that ends with no finish part reports usage_missing, not no_usage", async () => {
    const reasons: string[] = [];
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
    });
    setModelUsageGate(async () => ({
      fail: (input) => {
        reasons.push(input.reason);
      },
    }));
    await consume(model.doStream({} as never).then((r) => r.stream));
    expect(reasons).toEqual(["usage_missing"]);
  });

  test("a finish part with no usage numbers reports usage_missing", async () => {
    const reasons: string[] = [];
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({
        stream: streamOf([{ type: "finish", usage: { inputTokens: {}, outputTokens: {} } }]),
      }),
    });
    setModelUsageGate(async () => ({ fail: (i) => { reasons.push(i.reason); } }));
    await consume(model.doStream({} as never).then((r) => r.stream));
    expect(reasons).toEqual(["usage_missing"]);
  });

  test("a finish part that reports zero tokens is a confirmed no-cost and stays no_usage", async () => {
    const reasons: string[] = [];
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({
        stream: streamOf([
          { type: "finish", usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } },
        ]),
      }),
    });
    setModelUsageGate(async () => ({ fail: (i) => { reasons.push(i.reason); } }));
    await consume(model.doStream({} as never).then((r) => r.stream));
    expect(reasons).toEqual(["no_usage"]);
  });
});
```

Where `streamOf` and `consume` are the helpers the file already uses for chunk lists; if the file inlines them, inline them the same way here:

```ts
function streamOf(parts: unknown[]) {
  return new ReadableStream<Record<string, unknown>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part as Record<string, unknown>);
      controller.close();
    },
  });
}
async function consume(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}
```

- [ ] **Step 6: Run them and verify they fail**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: FAIL — the first two cases report `"no_usage"`.

- [ ] **Step 7: Implement the classification split in `copilot.ts`**

1. `:390-395` — add the reason:
```ts
export type ModelUsageFailureReason =
  | "provider_error"
  | "stream_error"
  /** The stream ended before any finish part: we never learned the cost. Retained, not free. */
  | "usage_missing"
  /** The provider reported a finish with zero tokens: a confirmed no-cost. Released. */
  | "no_usage"
  | "cancelled"
  | "bound_refused";
```
2. `:777` — the `chunk.done` branch: `await settleFail("usage_missing");` (was `"no_usage"`).
3. In the finish-part branch (`:815-880`), classify before the validity check:
```ts
            const reportedInput = usage?.inputTokens?.total;
            const reportedOutput = usage?.outputTokens?.total;
            /*
             * Absent usage numbers are NOT zero usage (audit A2): an OpenAI-compatible gateway
             * that ignores `stream_options.include_usage` reports nothing at all, and treating
             * that as a confirmed no-cost released the hold, metered nothing and charged nothing
             * — silently free. `CONTEXT.md` Pending Settlement: the hold stays until settlement
             * or a confirmed no-cost, so this reports an unknown outcome and the gate retains.
             */
            if (reportedInput === undefined && reportedOutput === undefined) {
              await settleFail("usage_missing");
              return;
            }
            const billedInput = reportedInput ?? 0;
            const billedOutput = reportedOutput ?? 0;
```
   (Keep the existing `validInput`/`validOutput` check, the `overBound` check and the `billedInput > 0 || billedOutput > 0` branch below it exactly as they are; the final `else` keeps `settleFail("no_usage")`, which now means "the provider said zero".)

- [ ] **Step 8: Run the copilot tests green**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: PASS.

- [ ] **Step 9: Make the gate's `fail` handler decide release-vs-retain by reason**

In `server/src/index.ts`, replace the gate's `fail` handler (`:3717-3730`) with:

```ts
      fail: async (failure) => {
        /*
         * Release only on a CONFIRMED no-cost (audit A2 / CONTEXT.md Pending Settlement /
         * ADR-0003): the provider refused before any token (`provider_error`), admission refused
         * before the provider (`bound_refused`), or the provider reported zero usage (`no_usage`).
         * Everything else is an unknown outcome — `usage_missing`, `stream_error`, `cancelled`:
         * the provider may have produced billable work we never learned about. Those keep the
         * hold (it expires on its own clock and reconciliation reports it) and leave a durable
         * evidence row naming the event and the reason.
         */
        if (isConfirmedNoCost(failure.reason)) {
          try {
            await billing.creditWriter.releaseReservation(
              reservation.reservationId,
              failure.reason,
            );
          } catch (error) {
            logReservationReleaseFailure({
              source: "llm",
              eventId: input.eventId,
              reservationId: reservation.reservationId,
              reason: failure.reason,
              error,
            });
          }
          return;
        }
        await recordUnsettledUsage({
          eventId: input.eventId,
          source: "llm",
          externalCustomerId: billing.externalCustomerKey,
          model: modelId,
          client: input.client,
          occurredAt: input.occurredAt,
          inputTokens: 0,
          outputTokens: 0,
          reason: failure.reason,
        });
      },
```

and, in the same `if (billing !== undefined && usageOutbox !== undefined)` block above `setModelUsageGate`, add the recorder binding:

```ts
  const recordUnsettledUsage = createUsageEvidenceRecorder(usageOutbox, (message) =>
    log.warn(message),
  );
```

Add the import beside the other billing imports at the top of `index.ts`:

```ts
import {
  createUsageEvidenceRecorder,
  isConfirmedNoCost,
} from "./billing/usage-evidence";
```

- [ ] **Step 10: Replace the source-text probe with a behavioral assertion**

`server/tests/qa-batch1-llm-meter-id.test.ts:29-39` currently asserts on the literal text of `index.ts` (`expect(SOURCE).not.toMatch(/releaseReservation\(\s*\n\s*reservation\.reservationId,\s*\n\s*"no_usage",/)`). Replace that one test body with an assertion on the reason vocabulary instead of its spelling:

```ts
  test("an unusable finish writes nothing and KEEPS the reservation for reconciliation", () => {
    // The reservation-first contract after the remediation: an invalid or over-bound usage
    // report is a distinct settlement failure. Nothing is written, the hold is never
    // released as no_usage, and the failure is thrown so the run cannot report success.
    expect(SOURCE).toMatch(/logUsageOutboxWriteFailure\(\s*\n\s*"llm",\s*\n\s*input\.eventId,\s*\n\s*error,\s*\n\s*reservation\.reservationId,/);
    expect(SOURCE).toMatch(/throw new ModelUsageSettlementError\(/);
    // Audit A2: release is now a decision over an explicit confirmed-no-cost vocabulary, so the
    // probe asserts the vocabulary rather than the literal argument of one call site.
    expect(SOURCE).toMatch(
      /if \(isConfirmedNoCost\(failure\.reason\)\)/,
    );
    expect(SOURCE).toMatch(/await recordUnsettledUsage\(\{/);
  });
```

- [ ] **Step 11: Pin the release-vs-retain decision with a behavioral test**

`isConfirmedNoCost` was defined in Step 3 and consumed in Step 9; this step only tests it, so the vocabulary cannot be edited silently later. Append to `server/tests/billing-usage-evidence.test.ts`, adding `isConfirmedNoCost` to that file's import from `../src/billing/usage-evidence`:

```ts
describe("which failure reasons may release a hold", () => {
  test.each([
    ["provider_error", true],
    ["bound_refused", true],
    ["no_usage", true],
    ["usage_missing", false],
    ["stream_error", false],
    ["cancelled", false],
  ])("%s releases the reservation: %s", (reason, releases) => {
    expect(isConfirmedNoCost(reason)).toBe(releases);
  });
});
```

Run: `cd server && bun test tests/billing-usage-evidence.test.ts` — expected PASS (6 cases).

- [ ] **Step 12: Typecheck, run, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/copilot-usage-meter.test.ts server/tests/billing-usage-evidence.test.ts server/tests/qa-batch1-llm-meter-id.test.ts server/tests/billing-usage-outbox.integration.test.ts
```
Expected: exit 0, all green.

```bash
git add server/src/billing/usage-evidence.ts server/src/copilot.ts server/src/index.ts \
        server/tests/billing-usage-evidence.test.ts server/tests/copilot-usage-meter.test.ts server/tests/qa-batch1-llm-meter-id.test.ts
git commit -m "fix(billing): an unknown usage outcome keeps its hold and leaves durable evidence (audit A2)"
```

---

### Task 3: The over-bound path records the tokens it refuses to charge

**Why:** `copilot.ts:834-846` errors the stream *before* `settleFinish`, so `index.ts`'s `finish` (and its `usageOutbox.record`) never runs: the provider's real token counts are lost, Lago never sees the event, and the only residue is one log line plus an `expired_reserved_reservation` finding that carries no token numbers. Three documents claim otherwise (`billing/input-bound.ts:16`, the gate comment in `index.ts:3636-3646`, `docs/configuration.md:56-61`).

**Files:**
- Modify: `server/src/copilot.ts:440-453` (`ModelUsageGateLifecycle` gains `recordUnsettled`), `:834-846` (over-bound branch), `:800-812` (`failSettlement`)
- Modify: `server/src/index.ts:3660-3716` (the gate's `finish` charge-refusal branch and the new lifecycle member)
- Modify: `server/src/billing/input-bound.ts:6-18` (header claim), `docs/configuration.md:56-61`
- Test: `server/tests/copilot-usage-meter.test.ts` (new cases)

**Interfaces:**
- Consumes: T2's `createUsageEvidenceRecorder`.
- Produces:
  ```ts
  export type ModelUsageGateLifecycle = {
    bounds?: ModelUsageProviderBounds;
    finish?: (usage: ModelUsageReport) => Promise<void> | void;
    /**
     * Durable evidence for work the provider produced that this deployment will not charge:
     * usage above a configured bound, or a charge the pricing refused. The hold is retained.
     */
    recordUnsettled?: (input: {
      eventId: string;
      occurredAt: Date;
      inputTokens: number;
      outputTokens: number;
      reason: string;
    }) => Promise<void> | void;
    fail?: (input: { eventId: string; occurredAt: Date; reason: ModelUsageFailureReason }) => Promise<void> | void;
  };
  ```

- [ ] **Step 1: Write the failing test**

Append to `server/tests/copilot-usage-meter.test.ts`:

```ts
describe("an over-bound finish leaves its tokens behind (audit A3)", () => {
  test("the settlement failure records the real usage before the stream errors", async () => {
    const evidence: { inputTokens: number; outputTokens: number; reason: string }[] = [];
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({
        stream: streamOf([
          { type: "finish", usage: { inputTokens: { total: 900 }, outputTokens: { total: 10 } } },
        ]),
      }),
    });
    setModelUsageGate(async () => ({
      bounds: {
        input: {
          enforced: "counted",
          maximumTokens: 100n,
          countInputTokens: async () => 10,
        },
        output: { enforced: "provider_cap", maximumTokens: 100n },
      },
      recordUnsettled: (input) => {
        evidence.push({
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          reason: input.reason,
        });
      },
    }));

    const stream = (await model.doStream({} as never)).stream;
    await expect(consume(stream)).rejects.toThrow(/usage_over_bound/);
    expect(evidence).toEqual([
      { inputTokens: 900, outputTokens: 10, reason: "usage_over_bound" },
    ]);
  });

  test("malformed usage records what arrived and names the reason", async () => {
    const evidence: string[] = [];
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({
        stream: streamOf([
          { type: "finish", usage: { inputTokens: { total: -1 }, outputTokens: { total: 5 } } },
        ]),
      }),
    });
    setModelUsageGate(async () => ({
      recordUnsettled: (input) => { evidence.push(input.reason); },
    }));
    await expect(consume((await model.doStream({} as never)).stream)).rejects.toThrow(/usage_invalid/);
    expect(evidence).toEqual(["usage_invalid"]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: FAIL — `evidence` is empty; `recordUnsettled` is never called.

- [ ] **Step 3: Add the lifecycle member and call it from the one settlement-failure exit**

In `server/src/copilot.ts`:
1. Extend `ModelUsageGateLifecycle` (`:440-453`) with the `recordUnsettled` member spelled in **Interfaces** above.
2. In `failSettlement` (`:800-812`), record before tearing the stream down. The helper already receives the log type and an optional detail; give it the usage numbers:

```ts
          const failSettlement = (
            logType: string,
            error: Error,
            detail?: Record<string, unknown>,
          ) => {
            settled = true;
            log.error({ type: logType, eventId, ...detail }, logType);
            /*
             * Evidence before the tear-down (audit A3): the provider already produced this work,
             * the hold is retained, and without a durable row the token counts existed only in
             * this log line — reconciliation would find an expired hold with no usage to reconcile.
             * Best-effort by contract: a failed evidence write must not mask the settlement error.
             */
            const tokens = detail as
              | { inputTokens?: number; outputTokens?: number }
              | undefined;
            void Promise.resolve(
              lifecycle?.recordUnsettled?.({
                eventId,
                occurredAt,
                inputTokens: tokens?.inputTokens ?? 0,
                outputTokens: tokens?.outputTokens ?? 0,
                reason:
                  error instanceof ModelUsageSettlementError
                    ? error.code
                    : "usage_unsettled",
              }),
            ).catch(() => {});
            reader.cancel("settlement_failed").catch(() => {});
            controller.error(error);
          };
```
3. Pass the token counts into the two `failSettlement` calls that have them (`:830-846`):
```ts
            if (!validInput || !validOutput) {
              failSettlement(
                "billing-model-usage-invalid",
                new ModelUsageSettlementError("usage_invalid"),
                { inputTokens: billedInput, outputTokens: billedOutput },
              );
              return;
            }
```
   (the `overBound` call already passes both counts — leave it as is.)

- [ ] **Step 4: Run the copilot tests green**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `recordUnsettled` in the gate assembly**

In `server/src/index.ts`, add to the object returned by `setModelUsageGate(async (input) => { … })`, beside `finish` and `fail`:

```ts
      recordUnsettled: async (unsettled) => {
        await recordUnsettledUsage({
          eventId: unsettled.eventId,
          source: "llm",
          externalCustomerId: billing.externalCustomerKey,
          model: modelId,
          client: input.client,
          occurredAt: unsettled.occurredAt,
          inputTokens: unsettled.inputTokens,
          outputTokens: unsettled.outputTokens,
          reason: unsettled.reason,
        });
      },
```

and in the `finish` charge-refusal branch (`:3673-3690`, the `catch` around `calculateExactModelUsageCharge`), record the real usage before rethrowing:

```ts
          await recordUnsettledUsage({
            eventId: input.eventId,
            source: "llm",
            externalCustomerId: billing.externalCustomerKey,
            model: modelId,
            client: input.client,
            occurredAt: input.occurredAt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reason: code,
          });
          throw new ModelUsageSettlementError(code);
```

- [ ] **Step 6: Correct the three claims that promised this and did not deliver it**

1. `server/src/billing/input-bound.ts:6-18` — replace the sentence "A tokenizer that beats the calibration shows up at settlement as `usage_over_bound` — a held reservation for reconciliation, never a silent charge." with:
```
 * A tokenizer that beats the calibration shows up at settlement as `usage_over_bound`: the stream
 * fails, the hold is RETAINED, and one durable outbox row (billing/usage-evidence.ts) keeps the
 * provider's real token counts with both delivery targets in a terminal-evidence state. That row —
 * not the log line — is what reconciliation and an operator read.
```
2. The gate comment in `server/src/index.ts` (the `bounds:` block, currently "…surfaces at settlement as usage_over_bound for reconciliation") — same correction, naming `usage-evidence.ts`.
3. `docs/configuration.md:56-61` — replace "surfaces at settlement as an over-bound hold for operator reconciliation rather than a silent charge" with: "surfaces at settlement as `usage_over_bound`: the run fails, the hold is retained until it expires into an `expired_reserved_reservation` finding, and a durable `usage_outbox` row keeps the provider's real token counts (both targets terminal-evidence) so an operator can price the call by hand."
4. If decision gate **G2** has been resolved, quote the winning document here; otherwise append to all three: `（G2 未决：Spec「Billed admission per surface」仍写 input_bound_unsupported，与 ADR-0001 冲突，待回写。）`

- [ ] **Step 7: Typecheck, run, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/copilot-usage-meter.test.ts server/tests/billing-usage-evidence.test.ts server/tests/billing-input-bound.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/copilot.ts server/src/index.ts server/src/billing/input-bound.ts docs/configuration.md server/tests/copilot-usage-meter.test.ts
git commit -m "fix(billing): over-bound and unpriceable usage keeps a durable token record (audit A3)"
```

---

# Phase B — honest refusals and range-safe money (P1)

### Task 4: Four refusal sentinels, logged policy issues, and the missing `.env.example` keys

**Why:** `index.ts:3611` (policy unconfigured), `:3614` (model has no price) and `:3631` (insufficient balance) all throw `CreditGateError`, whose message is "This deployment has no credits left. Ask an administrator to grant credits or upgrade the plan." One typo in one model's rate makes `configured:false` for the whole deployment (`config.ts:1600-1620` collects issues globally) and tells every user they are broke. `creditPolicy.issues` has **no consumer anywhere** (`grep -rn "\.issues" server/src` finds only producers). And `.env.example` — the file every new deployment copies — contains 16 `LAGO_*` keys and **zero** `BILLING_*` keys, so a template deployment lands in exactly this state.

**Files:**
- Modify: `server/src/copilot.ts:531-556` (new error classes, gate catch)
- Modify: `server/src/index.ts:3608-3635` (which sentinel each refusal throws; log `available` vs `required`), and the billing assembly block (`:3520-3600`) for the boot-time issues log
- Modify: `.env.example` (add the four keys after the `LAGO_*` block, ~line 745)
- Modify: `docs/configuration.md` (point at `.env.example`)
- Test: `server/tests/copilot-usage-meter.test.ts`, `server/tests/billing-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // server/src/copilot.ts — all three carry a stable `code` and a message built from the code alone.
  export class CreditGateError extends Error { readonly code = "credits_exhausted"; }              // unchanged
  export class CreditPolicyUnconfiguredError extends Error {
    override name = "CreditPolicyUnconfiguredError";
    readonly code = "credit_policy_unconfigured";
    readonly issues: readonly { key: string; reason: string }[];
    constructor(issues: readonly { key: string; reason: string }[]);
  }
  export class ModelNotPricedError extends Error {
    override name = "ModelNotPricedError";
    readonly code = "model_not_priced";
    readonly modelId: string;
    constructor(modelId: string);
  }
  export class CreditGateFailureError extends Error {
    override name = "CreditGateFailureError";
    readonly code = "credit_gate_failed";
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/copilot-usage-meter.test.ts`:

```ts
describe("a refusal names its real cause (audit A4)", () => {
  test("an unconfigured credit policy is not 'no credits left'", async () => {
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({ stream: streamOf([]) }),
    });
    setModelUsageGate(async () => {
      throw new CreditPolicyUnconfiguredError([
        { key: "BILLING_MODEL_CREDIT_RATES", reason: "missing" },
      ]);
    });
    await expect(model.doStream({} as never)).rejects.toMatchObject({
      name: "CreditPolicyUnconfiguredError",
      code: "credit_policy_unconfigured",
    });
    await expect(model.doStream({} as never)).rejects.not.toMatchObject({
      code: "credits_exhausted",
    });
  });

  test("an unpriced model names the model, not the balance", async () => {
    const model = meteredModelForTests({
      modelId: "gpt-4o-mini",
      doStream: async () => ({ stream: streamOf([]) }),
    });
    setModelUsageGate(async () => {
      throw new ModelNotPricedError("gpt-4o-mini");
    });
    await expect(model.doStream({} as never)).rejects.toMatchObject({
      code: "model_not_priced",
      modelId: "gpt-4o-mini",
    });
  });

  test("a gate that broke for an unknown reason stays fail-closed under its own name", async () => {
    const model = meteredModelForTests({
      modelId: "GLM-5.3",
      doStream: async () => ({ stream: streamOf([]) }),
    });
    setModelUsageGate(async () => {
      throw new Error("select 1: connection reset by peer");
    });
    await expect(model.doStream({} as never)).rejects.toMatchObject({
      code: "credit_gate_failed",
    });
    await expect(model.doStream({} as never)).rejects.toThrow(
      /^(?!.*connection reset).*$/,
    );
  });
});
```

Append to `server/tests/billing-config.test.ts` (the file that already drives `billingCreditPolicyConfig` through `loadConfig`):

```ts
test("one model's bad rate leaves the policy unconfigured and names the offending key", () => {
  const config = loadConfig({
    ...baseEnvironment,
    LAGO_API_URL: "https://lago.stub.test",
    LAGO_API_KEY: "stub-key",
    BILLING_MODEL_CREDIT_RATES:
      '{"GLM-5.3":{"input":{"numerator":"1","denominator":"100"},"output":{"numerator":"1","denominator":"0"}}}',
    BILLING_MODEL_MAX_RESERVATION_TOKENS: '{"GLM-5.3":{"input":"128000","output":"16384"}}',
    BILLING_CODE_RUN_CREDIT_RATE: '{"numerator":"1","denominator":"100"}',
    BILLING_CODE_RUN_MAX_RESERVATION_TOKENS: "100000",
  });
  expect(config.billing?.creditPolicy.configured).toBe(false);
  expect(config.billing?.creditPolicy.mode).toBe("hard_cap");
  expect(
    (config.billing?.creditPolicy as { issues: readonly { key: string }[] }).issues.map((i) => i.key),
  ).toContain("BILLING_MODEL_CREDIT_RATES.GLM-5.3.output.denominator");
});
```

(This file's fixture is `baseEnvironment` at `tests/billing-config.test.ts:10`; it carries no Lago keys, so the two `LAGO_*` lines above are what turn the billing block on. Follow the file's existing spread-and-override idiom for the other two tests in this task.)

- [ ] **Step 2: Run them and verify they fail**

Run: `cd server && bun test tests/copilot-usage-meter.test.ts tests/billing-config.test.ts`
Expected: FAIL — the three new error classes do not exist.

- [ ] **Step 3: Implement the sentinels and the gate catch**

In `server/src/copilot.ts`, below the existing `CreditGateError` (`:531-541`), add the three classes exactly as spelled in **Interfaces**. Each message is built from its code alone:

```ts
/**
 * This deployment has no credit PRICES (audit A4). Distinct from `CreditGateError`: the balance is
 * not the problem, `BILLING_MODEL_CREDIT_RATES` / `BILLING_MODEL_MAX_RESERVATION_TOKENS` /
 * `BILLING_CODE_RUN_*` are. Telling an administrator to buy credits would send them to the wrong
 * fix; the `issues` field carries the config keys to the log, never to a person-facing message.
 */
export class CreditPolicyUnconfiguredError extends Error {
  override name = "CreditPolicyUnconfiguredError";
  readonly code = "credit_policy_unconfigured";
  constructor(
    readonly issues: readonly { key: string; reason: string }[] = [],
  ) {
    super(
      "Billing credit prices are not configured on this deployment, so no metered call can be admitted. An administrator must supply the BILLING_* rate and maximum-reservation keys.",
    );
  }
}

/** This model has no price in an otherwise configured policy. */
export class ModelNotPricedError extends Error {
  override name = "ModelNotPricedError";
  readonly code = "model_not_priced";
  constructor(readonly modelId: string) {
    super(
      `This model has no configured credit price, so calls to it cannot be admitted. An administrator must add it to BILLING_MODEL_CREDIT_RATES and BILLING_MODEL_MAX_RESERVATION_TOKENS.`,
    );
  }
}

/**
 * The gate itself failed for a reason no sentinel names (a store error, a driver timeout).
 * Fail-closed like every other refusal, but under its own name: "the balance could not be read"
 * is a different repair from "the balance is empty", and the raw cause is logged, never rethrown.
 */
export class CreditGateFailureError extends Error {
  override name = "CreditGateFailureError";
  readonly code = "credit_gate_failed";
  constructor() {
    super(
      "Credit admission could not be completed. Try again; if it persists an administrator must check the billing ledger connection.",
    );
  }
}
```

Then in `meteredModel.doStream`'s gate catch (`:600-615`), rethrow every named admission sentinel and fold everything else into `CreditGateFailureError`:

```ts
        } catch (error) {
          if (
            error instanceof CreditGateError ||
            error instanceof CreditPolicyUnconfiguredError ||
            error instanceof ModelNotPricedError ||
            error instanceof CreditGateFailureError
          ) {
            throw error;
          }
          // The gate's own failure reason stays out of the person-facing sentinel; the
          // name alone is logged (a message could carry connection details from a store).
          log.error(
            {
              type: "billing-model-gate-failed",
              eventId,
              name: (error as Error | null | undefined)?.name,
            },
            "billing-model-gate-failed",
          );
          throw new CreditGateFailureError();
        }
```

- [ ] **Step 4: Throw the right sentinel from the gate assembly, and log the hold floor**

In `server/src/index.ts` (`:3608-3635`):

```ts
  setModelUsageGate(async (input) => {
    if (!creditPolicy?.configured) {
      // `configured === false` narrows the union to the variant that carries `issues`, so the
      // offending keys reach the error (and the log) without a cast. `creditPolicy === undefined`
      // cannot happen inside this block, but the guard is on `?.` so answer it as "no issues known".
      throw new CreditPolicyUnconfiguredError(
        creditPolicy?.configured === false ? creditPolicy.issues : [],
      );
    }
    const modelId = input.modelId ?? runtimeModel.defaultModel;
    const modelPolicy = creditPolicy.models.get(modelId);
    if (!modelPolicy) throw new ModelNotPricedError(modelId);

    let reservation: Awaited<
      ReturnType<typeof billing.creditWriter.reserveCredits>
    >;
    try {
      reservation = await billing.creditWriter.reserveCredits({
        externalCustomerId: billing.externalCustomerKey,
        idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}${input.eventId}`,
        maximumCents: Number(modelPolicy.maximumReservationUnits),
        expiresAt: new Date(
          input.occurredAt.getTime() + MODEL_RESERVATION_WINDOW_MS,
        ),
      });
    } catch (error) {
      log.error(
        {
          type: "billing-credit-gate-failed",
          eventId: input.eventId,
          model: modelId,
          name: (error as Error | null)?.name,
        },
        "billing-credit-gate-failed",
      );
      throw new CreditGateFailureError();
    }
    if (!reservation.reserved) {
      /*
       * The hold is the WORST-CASE ceiling (config.ts derives it from the configured token maxima),
       * so this refusal has two very different causes and the log is the only place they are
       * distinguishable: a balance that is genuinely empty, and a balance that is fine but smaller
       * than one call's maximum (decision gate G3). `available` and `required` in scaled units.
       */
      log.warn(
        {
          type: "billing-credit-reservation-refused",
          eventId: input.eventId,
          model: modelId,
          available: reservation.availableCents,
          required: Number(modelPolicy.maximumReservationUnits),
        },
        "billing-credit-reservation-refused",
      );
      throw new CreditGateError();
    }
```

Add the three new imports beside `CreditGateError` at `index.ts:183`:

```ts
  CreditGateFailureError,
  CreditPolicyUnconfiguredError,
  ModelNotPricedError,
```

- [ ] **Step 5: Log the policy issues once at boot**

In the billing assembly block in `server/src/index.ts`, immediately after `const billingSettings = config.billing;` (and before `const billing = …`), add:

```ts
/*
 * A deployment that configured the billing provider but not the hard-cap price block refuses
 * every metered call (index.ts's model gate). Say so at boot, with the offending keys, instead of
 * letting it surface as a user-facing "no credits left" on the first request (audit A4/C2).
 */
if (
  billingSettings !== undefined &&
  billingSettings.creditPolicy.configured === false
) {
  log.error(
    {
      type: "billing-credit-policy-unconfigured",
      issues: billingSettings.creditPolicy.issues.map((issue) => `${issue.key}:${issue.reason}`),
    },
    "billing-credit-policy-unconfigured: metered work will refuse until these keys are fixed",
  );
}
```

- [ ] **Step 6: Add the four keys to `.env.example`**

Insert after the `LAGO_PLAN_CATALOG` block (`.env.example`, ~line 745):

```bash
# ── Billing hard-cap credit policy ─────────────────────────────────────────────────────────────
# All FOUR keys are required together. If any is missing, malformed, negative, or has a zero
# denominator, the policy resolves to `configured: false` and EVERY metered model call and code
# run is refused before the provider is invoked — the server logs
# `billing-credit-policy-unconfigured` with the offending keys at boot, and the refusal reaches
# the caller as `credit_policy_unconfigured` (not "no credits left").
# Rates are exact rationals in scaled credit units per token (CREDIT_SCALE = 100): one credit per
# 100 tokens is {"numerator":"1","denominator":"100"}. Integers may be JSON numbers or quoted
# decimal strings; quote anything outside the safe-integer range.
# The maximum reservation for one call is DERIVED, not configured: the server computes
#   ceil(input_max_tokens × input_rate) + ceil(output_max_tokens × output_rate)
# with integer ceiling arithmetic, so a call always holds its own worst case. With the example
# values below one call holds 21.00 credits (128000/100 + ceil(16384/20) = 1280 + 820 = 2100
# scaled units) — a balance below that admits no call at all. Size the token maxima with that
# floor in mind.
# BILLING_MODEL_CREDIT_RATES={"GLM-5.3":{"input":{"numerator":"1","denominator":"100"},"output":{"numerator":"1","denominator":"20"}}}
# BILLING_MODEL_MAX_RESERVATION_TOKENS={"GLM-5.3":{"input":"128000","output":"16384"}}
# BILLING_CODE_RUN_CREDIT_RATE={"numerator":"1","denominator":"100"}
# BILLING_CODE_RUN_MAX_RESERVATION_TOKENS="100000"
```

In `docs/configuration.md`, after the four-row table, add one sentence:

```markdown
`.env.example` carries the same four keys with these worked examples; a deployment copied from the
template with the billing provider configured but these four commented out refuses every metered
call at boot with `billing-credit-policy-unconfigured` in the log.
```

- [ ] **Step 7: Run everything, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/copilot-usage-meter.test.ts server/tests/billing-config.test.ts server/tests/qa-batch1-llm-meter-id.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/copilot.ts server/src/index.ts server/tests/copilot-usage-meter.test.ts server/tests/billing-config.test.ts .env.example docs/configuration.md
git commit -m "fix(billing): refusals name their cause — unpriced policy vs unpriced model vs empty balance (audit A4/C2)"
```

---

### Task 5: Range-check money and credit inputs against the int32 columns

**Why:** `config.ts:1999-2007` validates the catalog's `credits` as "whole and ≥ 0" with no upper bound, and `credits-writer.ts:205-213` validates `grantCredits.totalCents` the same way — while `credit_grants.total` is a 32-bit `integer`. A catalog entry of `credits: 30000000` (×100 = 3e9) passes config, collects money, then fails the insert with SQLSTATE 22003 inside `grantPlanCreditsFor`, which catches and returns `false`, leaving the paid order in `activationState: 'pending'` and retried every 60 seconds forever.

**Files:**
- Modify: `server/src/config.ts:1999-2007` (credits), `:2041-2048` (priceCents), `:2055-2062` (originalCents)
- Modify: `server/src/billing/credits-writer.ts:205-213` (`grantCredits` upper bound)
- Test: `server/tests/billing-config.test.ts`, `server/tests/billing-credits-writer.integration.test.ts`

**Interfaces:**
- Produces: `MAX_STORED_CREDIT_UNITS` is already `2_147_483_647n` in `config.ts:1339`; export it and reuse it, and reuse `credits-writer.ts`'s existing `MAX_STORED_UNITS = 2_147_483_647`.

- [ ] **Step 1: Write the failing config test**

Append to `server/tests/billing-config.test.ts`:

```ts
test("a plan allowance that cannot fit the ledger's 32-bit column refuses to start", () => {
  expect(() =>
    loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://lago.stub.test",
      LAGO_API_KEY: "stub-key",
      LAGO_PLAN_CATALOG:
        '{"standard":{"name":"标准版","credits":30000000,"features":["a"],"pricing":[{"code":"monthly","priceCents":4900,"unit":"month"}]}}',
    }),
  ).toThrow(/credits must fit the credit ledger's 32-bit column/);
});

test("a price that cannot fit the order table's 32-bit column refuses to start", () => {
  expect(() =>
    loadConfig({
      ...baseEnvironment,
      LAGO_API_URL: "https://lago.stub.test",
      LAGO_API_KEY: "stub-key",
      LAGO_PLAN_CATALOG:
        '{"standard":{"name":"标准版","credits":100,"features":["a"],"pricing":[{"code":"monthly","priceCents":99999999999,"unit":"month"}]}}',
    }),
  ).toThrow(/priceCents must fit the payment order table's 32-bit column/);
});

test("the largest representable allowance is accepted exactly", () => {
  const config = loadConfig({
    ...baseEnvironment,
    LAGO_API_URL: "https://lago.stub.test",
    LAGO_API_KEY: "stub-key",
    LAGO_PLAN_CATALOG:
      '{"standard":{"name":"标准版","credits":21474836,"features":["a"],"pricing":[{"code":"monthly","priceCents":2147483647,"unit":"month"}]}}',
  });
  expect(config.billing?.planCatalog.get("standard")?.credits).toBe(21474836);
});
```

(`21474836 × 100 = 2147483600 ≤ 2147483647`; `21474837 × 100` overflows and must be refused.)

- [ ] **Step 2: Run it and verify it fails**

Run: `cd server && bun test tests/billing-config.test.ts`
Expected: FAIL — the first two do not throw.

- [ ] **Step 3: Implement the config bounds**

In `server/src/config.ts`, export the constant (`:1339`) and add a helper next to `billingPlanCatalog`:

```ts
export const MAX_STORED_CREDIT_UNITS = 2_147_483_647n;

/** The largest whole-credit allowance the ledger's 32-bit `total` column can hold at ×100 scale. */
const MAX_CATALOG_CREDITS = Number(MAX_STORED_CREDIT_UNITS / BigInt(CREDIT_SCALE_FOR_CONFIG));
/** The largest integer cent amount a 32-bit `amount_cents` column can hold. */
const MAX_STORED_CENTS = Number(MAX_STORED_CREDIT_UNITS);
```

with, at the top of the file beside the other billing imports:

```ts
/** The ledger's scale, restated as a config-layer constant: config must not import the read module. */
const CREDIT_SCALE_FOR_CONFIG = 100;
```

Then in the catalog parse, replace the credits validation (`:1999-2007`):

```ts
    if (
      typeof record.credits !== "number" ||
      !Number.isInteger(record.credits) ||
      record.credits < 0
    ) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" credits must be a whole non-negative number`,
      );
    }
    // A paid order pays this allowance out through credit_grants.total, a 32-bit column at ×100
    // scale. An allowance that does not fit is refused HERE, at boot, rather than after the
    // money lands: the payout insert would fail inside activation and strand a paid order in a
    // permanent retry (audit A6).
    if (record.credits > MAX_CATALOG_CREDITS) {
      throw new Error(
        `PLAN_CATALOG plan "${planCode}" credits must fit the credit ledger's 32-bit column (at most ${MAX_CATALOG_CREDITS} whole credits at ×100 scale)`,
      );
    }
```

and in the cycle loop, after each of the two integer validations for `priceCents` (`:2041-2048`) and `originalCents` (`:2055-2062`):

```ts
      if (c.priceCents > MAX_STORED_CENTS) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" priceCents must fit the payment order table's 32-bit column (at most ${MAX_STORED_CENTS})`,
        );
      }
```
```ts
      if (
        typeof c.originalCents === "number" &&
        c.originalCents > MAX_STORED_CENTS
      ) {
        throw new Error(
          `PLAN_CATALOG plan "${planCode}" cycle "${code}" originalCents must fit the payment order table's 32-bit column (at most ${MAX_STORED_CENTS})`,
        );
      }
```

- [ ] **Step 4: Write the failing writer test**

Append to `server/tests/billing-credits-writer.integration.test.ts`:

```ts
test("grantCredits refuses an amount the 32-bit column cannot hold, before touching the database", async () => {
  await expect(
    writer.grantCredits({
      externalCustomerId: `${prefix}-overflow`,
      source: "promo",
      totalCents: 2_147_483_648,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: `${prefix}-overflow-key`,
    }),
  ).rejects.toThrow(/32-bit/);
});
```

- [ ] **Step 5: Run it, verify it fails, implement, verify it passes**

Run: `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-credits-writer.integration.test.ts`
Expected: FAIL (the insert throws a Postgres 22003 instead).

In `server/src/billing/credits-writer.ts`, extend the `grantCredits` guard (`:205-213`):

```ts
      if (
        !Number.isInteger(input.totalCents) ||
        input.totalCents < 0 ||
        input.totalCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime())
      ) {
        throw new TypeError(
          "grantCredits needs a whole non-negative scaled amount that fits the 32-bit credit column, and a real expiry.",
        );
      }
```

Re-run: Expected PASS.

- [ ] **Step 6: Typecheck, run the payment suites (they build catalogs), commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-config.test.ts server/tests/payment-config.test.ts server/tests/qa-batch2-cycle-config-qr.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/config.ts server/src/billing/credits-writer.ts server/tests/billing-config.test.ts server/tests/billing-credits-writer.integration.test.ts
git commit -m "fix(billing): refuse catalog amounts the 32-bit money columns cannot hold (audit A6)"
```

---

### Task 6: A webhook storage failure is graded 500, not 400

**Why:** `service.ts:handleWebhook`'s catch answers 503 only for `BillingPersistenceError` and retryable `BillingError`; everything else — including a non-retryable Postgres error the store deliberately does *not* wrap (`store.ts:withPersistenceError` wraps only when `isRetryableDatabaseError`) — falls to `return json(400, …)`. A 400 tells Lago "your delivery is bad, stop", so the projection is lost and no inbox row records it.

**Files:**
- Modify: `server/src/billing/service.ts` (`handleWebhook` catch block)
- Modify: `server/src/billing/store.ts` (wrap **every** persistence failure, retryable or not, with a `retryable` flag on the error)
- Modify: `server/src/billing/types.ts:52-70` (`BillingPersistenceError` gains `retryable`)
- Test: `server/tests/billing-webhook.test.ts`, `server/tests/billing-store.test.ts`

**Interfaces:**
- Produces: `class BillingPersistenceError extends Error { readonly operation: BillingPersistenceOperation; readonly retryable: boolean; }` — constructed as `new BillingPersistenceError(operation, retryable)`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/billing-webhook.test.ts`. That file's harness is `webhookFixture(store?, log?)` → `{ stub, store, service }` and `signedDelivery(eventId, webhookType, object, headers)` → a signed `Request`; both are already imported/defined there, and `BillingPersistenceError` is already in its import list.

```ts
test("a non-retryable storage failure is answered 500 so the provider retries, and nothing is recorded", async () => {
  const store = memoryBillingStore();
  const { service } = webhookFixture(store);
  store.applyWebhookProjection = async () => {
    // What the real store now throws for a constraint violation or a value-too-long: our data
    // problem, graded non-retryable. It is still not the provider's fault, so it is still 5xx.
    throw new BillingPersistenceError("webhook_apply", false);
  };
  const response = await service.handleWebhook(
    signedDelivery("evt-data-failure", "subscription.created", {
      external_customer_id: "deployment-1",
    }),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "Billing webhook could not be applied.",
  });
  expect(store.inbox.size).toBe(0);
});

test("a retryable storage failure stays 503", async () => {
  const store = memoryBillingStore();
  const { service } = webhookFixture(store);
  store.applyWebhookProjection = async () => {
    throw new BillingPersistenceError("webhook_apply", true);
  };
  const response = await service.handleWebhook(
    signedDelivery("evt-transient", "subscription.created", {
      external_customer_id: "deployment-1",
    }),
  );
  expect(response.status).toBe(503);
  expect(store.inbox.size).toBe(0);
});

test("the 500 carries no detail from the failure", async () => {
  const store = memoryBillingStore();
  const { service } = webhookFixture(store);
  store.applyWebhookProjection = async () => {
    throw new BillingPersistenceError("webhook_apply", false);
  };
  const response = await service.handleWebhook(
    signedDelivery("evt-leak", "subscription.created", {
      external_customer_id: "deployment-1",
    }),
  );
  const body = await response.text();
  expect(body).not.toContain("webhook_apply");
  expect(body).not.toContain("BillingPersistenceError");
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `cd server && bun test tests/billing-webhook.test.ts`
Expected: FAIL — `BillingPersistenceError` takes one argument today, so the new tests do not typecheck; and once they do, the non-retryable case answers **400**, which is the bug.

- [ ] **Step 3: Add the flag to the error and the classification to the store**

`server/src/billing/types.ts` — extend `BillingPersistenceError`:

```ts
export class BillingPersistenceError extends Error {
  override name = "BillingPersistenceError";
  /**
   * Whether the same delivery could succeed a moment later (a deadlock, a failover, a refused
   * connection) or is a fact about the data (a constraint violation, a value too long). Both are
   * OURS, so both are answered 5xx and the provider retries: a 4xx would tell the provider its
   * delivery was bad and lose the projection permanently (audit A8). The flag only grades the log
   * line and the operator's expectation.
   */
  readonly retryable: boolean;
  constructor(
    readonly operation: BillingPersistenceOperation,
    retryable = true,
    options?: { cause?: unknown },
  ) {
    super(`Billing persistence failed (${operation}).`);
    this.retryable = retryable;
    // The driver's own error, kept for a debugger. It is never serialised into a response or into
    // a log message: a driver error can quote a connection string.
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
```

`server/src/billing/store.ts` — make `withPersistenceError` wrap every failure:

```ts
async function withPersistenceError<T>(
  operation: BillingPersistenceOperation,
  query: PromiseLike<T>,
): Promise<T> {
  try {
    return await query;
  } catch (error) {
    // Every persistence failure becomes the typed sentinel, graded by retryability. The caller's
    // HTTP answer is 5xx either way: a non-retryable constraint violation is our data problem,
    // not the provider's delivery problem, and answering it 400 would stop the retry that a manual
    // fix later makes worthwhile (audit A8). A synchronous throw from query CONSTRUCTION never
    // reaches here — it happens while the argument is evaluated, before this try — and stays the
    // programming error it is.
    throw new BillingPersistenceError(operation, isRetryableDatabaseError(error), {
      cause: error,
    });
  }
}
```

`server/src/billing/service.ts` — the `handleWebhook` catch becomes (**corrected 2026-10-15 during execution**: the first draft of this step answered 500 for *every* persistence failure, which contradicted Step 1's "a retryable storage failure stays 503" test and would have forced three established assertions in `billing-webhook.test.ts` to be restated for no reliability gain. The grade now reaches the status code, which is what makes the new `retryable` field load-bearing rather than a log word):

```ts
      } catch (error) {
        if (error instanceof BillingPersistenceError) {
          (deps.log ?? console.warn)(
            `billing: webhook failed — ${error.operation}${error.retryable ? " (retryable)" : " (non-retryable data failure)"}`,
          );
          // 5xx either way, never 400: this is our storage, not the provider's delivery, and a 4xx
          // would tell the provider to stop retrying a projection we simply failed to write. The
          // grade still reaches the status code, because 503 (transient, will converge on its own)
          // and 500 (our data needs a human) are different facts for whoever reads the provider's
          // delivery dashboard. Nothing is recorded either way, so the retry re-reads and
          // re-applies the whole projection.
          return json(error.retryable ? 503 : 500, {
            error: "Billing webhook could not be applied.",
          });
        }
        if (error instanceof BillingError && error.retryable) {
          (deps.log ?? console.warn)(`billing: webhook failed — ${error.code}`);
          return json(503, { error: "Billing webhook could not be applied." });
        }
        return json(400, { error: "Billing webhook could not be applied." });
      }
```

Note `BillingPersistenceError` has no `code` member — the log line uses `error.operation` alone.

Also update the `handleWebhook` docblock in `service.ts` (the paragraph beginning "Retryable provider and typed persistence failures answer 503") to:

```
 * Retryable provider failures and retryable persistence failures answer 503; a non-retryable
 * persistence failure — our own data, a constraint violation or a value too long — answers 500.
 * Both are ours and both are 5xx, so the provider retries the whole delivery and a manual fix
 * later still converges. A 4xx is reserved for a delivery we verified and then could not make
 * sense of; our own storage is never the provider's fault.
```

- [ ] **Step 4: Restate the one store test that pinned the old contract**

`server/tests/billing-store.test.ts` has a test named `"wrapped constraints and unknown errors retain their original identity"` (~`:74-125`) that feeds six non-retryable failures (a cyclic `DrizzleQueryError`, a `23503` constraint violation, a wrapped `TypeError`, a non-Postgres error wearing errno `40001`, an untrusted wrapper, an unknown `XX000` SQLSTATE) and asserts each propagates as itself. That is exactly the behavior this task changes. Rename it and restate the assertion against the new contract — do not delete it:

```ts
test("a non-retryable failure becomes the typed sentinel, graded, with the cause preserved", async () => {
  // …the same six `failures` array, unchanged…
  for (const failure of failures) {
    const database = {
      transaction() {
        return Promise.reject(failure);
      },
    } as unknown as Database;
    const error = await createBillingStore(database)
      .applyWebhookProjection({
        event: { provider: "test", eventId: "event-1", webhookType: "invoice.created" },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(BillingPersistenceError);
    expect(error).toMatchObject({ operation: "webhook_apply", retryable: false });
    expect((error as { cause?: unknown }).cause).toBe(failure);
  }
});
```

Leave the two neighbours alone: `"a synchronous programming error from query construction is not retryable"` still passes (see the comment in Step 3 — a synchronous throw never reaches `withPersistenceError`), and the retryable-errno tests now additionally satisfy `retryable: true`; add that to their `toMatchObject` so the grade is pinned, not incidental.

- [ ] **Step 5: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-webhook.test.ts server/tests/billing-store.test.ts server/tests/billing-routes.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/billing/service.ts server/src/billing/store.ts server/src/billing/types.ts server/tests/billing-webhook.test.ts server/tests/billing-store.test.ts
git commit -m "fix(billing): grade a webhook storage failure as ours (5xx), never the provider's (400) (audit A8)"
```

---

### Task 7: The Alipay request amount uses the exact helper that already exists

**Why:** `alipay.ts:197` builds the amount with `(input.amountCents / 100).toFixed(2)` — binary float division on a payment amount — while `crypto.ts:110 centsToAmountString` is the exact digit-wise implementation whose own docblock says "a payment amount is one place a rounding error is theft". The helper has no production caller.

**Files:**
- Modify: `server/src/billing/payments/alipay.ts:197`
- Test: `server/tests/payment-alipay.test.ts`

**Interfaces:**
- Consumes: `centsToAmountString(cents: number): string` from `./crypto` (throws `BillingError("invalid_response")` on a non-integer or negative input).

- [ ] **Step 1: Write the failing test**

Append to `server/tests/payment-alipay.test.ts` (reuse the file's existing stub-SDK harness that captures the `bizContent` passed to `run`):

```ts
test("the precreate amount is the exact decimal, not a float division", async () => {
  const calls: Record<string, unknown>[] = [];
  const provider = createAlipayProvider({
    ...ALIPAY_CONFIG,
    sdk: {
      run: async (_method, params) => {
        calls.push(params.bizContent as Record<string, unknown>);
        return { code: "10000", qr_code: "https://qr.alipay.com/x" };
      },
    },
  });
  for (const [cents, expected] of [
    [1, "0.01"],
    [1099, "10.99"],
    [12850, "128.50"],
    [4900, "49.00"],
    [2147483647, "21474836.47"],
  ] as const) {
    await provider.createSession({
      outTradeNo: `po-${cents}`,
      description: "test",
      amountCents: cents,
      currency: "CNY",
      notifyUrl: "https://example.test/cb",
      expiresAt: new Date(Date.now() + 900_000),
    });
  }
  expect(calls.map((call) => call.total_amount)).toEqual([
    "0.01",
    "10.99",
    "128.50",
    "49.00",
    "21474836.47",
  ]);
});

test("a non-integer cent amount is refused rather than rounded onto the wire", async () => {
  const provider = createAlipayProvider({
    ...ALIPAY_CONFIG,
    sdk: { run: async () => ({ code: "10000", qr_code: "x" }) },
  });
  await expect(
    provider.createSession({
      outTradeNo: "po-1",
      description: "test",
      amountCents: 10.5,
      currency: "CNY",
      notifyUrl: "https://example.test/cb",
      expiresAt: new Date(Date.now() + 900_000),
    }),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
```

- [ ] **Step 2: Run and verify the second test fails**

Run: `cd server && bun test tests/payment-alipay.test.ts`
Expected: the exact-decimal cases pass by luck at these magnitudes; the non-integer case FAILS (`(10.5/100).toFixed(2)` yields `"0.11"` and no throw). That is the point: the float path silently rounds.

- [ ] **Step 3: Implement**

`server/src/billing/payments/alipay.ts` — change the import and the one call site:

```ts
import { amountStringToCents, centsToAmountString, rsaVerify } from "./crypto";
```
```ts
          // Exact digit-wise conversion (./crypto), never a float division: this is the amount the
          // channel is asked to collect, and `toFixed` on a binary double is the one place a
          // rounding error is theft (audit C4). A non-integer cent value throws instead of rounding.
          total_amount: centsToAmountString(input.amountCents),
```

- [ ] **Step 4: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/payment-alipay.test.ts server/tests/payment-crypto.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/billing/payments/alipay.ts server/tests/payment-alipay.test.ts
git commit -m "fix(payments): build the Alipay amount with the exact decimal helper (audit C4)"
```

---

# Phase C — replay, currency, terminal states, projection truth (P2)

### Task 8: Bound the webhook replay window

**Why:** the delivery's identity is `X-Lago-Unique-Key` (`webhook-signature.ts:108`), a header the signature does **not** cover, and the JWT's own time claims are never read (`grep -n "exp\|iat" webhook-signature.ts` → nothing). One captured delivery replayed with fresh unique keys passes verification indefinitely, writes a new inbox row each time, and triggers a fresh authoritative re-read from Lago on every replay. Content cannot be forged and the projection is re-read from the provider, so this is amplification and unbounded inbox growth, not state corruption — but the dedupe guarantee rests on attacker-chosen data.

**Files:**
- Modify: `server/src/billing/webhook-signature.ts` (`verify`: enforce `exp`/`iat` when the token carries them; expose the body hash)
- Modify: `server/src/billing/types.ts` (`VerifiedWebhook` gains `bodyHash`)
- Modify: `server/src/db/schema/billing.ts:65-86` (`billing_webhook_events` gains `body_hash`)
- Create: migration via `cd server && bun run db:generate`
- Modify: `server/src/billing/store.ts` (`recordWebhookEvent` persists the hash; a new read counts prior deliveries of the same hash)
- Modify: `server/src/billing/reconcile.ts` (new finding `webhook_body_replay`)
- Test: `server/tests/billing-webhook-signature.test.ts`, `server/tests/billing-reconcile.integration.test.ts`

**Interfaces:**
- Produces: `VerifiedWebhook` gains `bodyHash: string` (lowercase hex sha256 of the raw body). `createWebhookVerifier({ key, now?, maxSkewSeconds? })` — `maxSkewSeconds` defaults to `300`, matching the WeChat adapter's skew.

- [ ] **Step 1: Spike — confirm which time claims a real delivery carries**

Before enforcing anything, capture one real delivery. Add a temporary debug log inside `verify` after the payload parse:

```ts
        // TEMPORARY SPIKE (remove in Step 6): which time claims does this provider instance sign?
        console.warn(
          `billing: webhook jwt claims ${JSON.stringify(
            Object.keys(signedData as object).filter((k) => k !== "data"),
          )}`,
        );
```

Run against the sandbox (`docker compose up lago` per `docker/lago/init-db.sql`, trigger any subscription change), and record the observed claim names in the commit message of Step 6. **Enforcement below is written "when present" precisely because this spike may show the self-hosted provider signs no time claim at all** — in that case the body-hash evidence in Steps 3–5 is the whole defense and Step 2's test documents that.

- [ ] **Step 2: Write the failing signature tests**

Append to `server/tests/billing-webhook-signature.test.ts` (that file already has `signDeliveryLikeProvider` and a key pair fixture):

```ts
describe("the replay window (audit A7)", () => {
  test("an expired token is refused even though its signature and body are valid", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem: PUBLIC_KEY_PEM },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
    });
    const signature = signDeliveryLikeProvider(
      PAYLOAD,
      PRIVATE_KEY_PEM,
      { alg: "RS256" },
      { exp: Math.floor(Date.parse("2026-10-14T11:00:00Z") / 1000) },
    );
    const result = await verifier.verify(headersWith(signature), RAW_BODY);
    expect(result.ok).toBe(false);
  });

  test("a token inside its lifetime is accepted", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem: PUBLIC_KEY_PEM },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
    });
    const signature = signDeliveryLikeProvider(
      PAYLOAD,
      PRIVATE_KEY_PEM,
      { alg: "RS256" },
      { exp: Math.floor(Date.parse("2026-10-14T13:00:00Z") / 1000) },
    );
    const result = await verifier.verify(headersWith(signature), RAW_BODY);
    expect(result.ok).toBe(true);
  });

  test("an iat further in the past than the skew window is refused", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem: PUBLIC_KEY_PEM },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
      maxSkewSeconds: 300,
    });
    const signature = signDeliveryLikeProvider(
      PAYLOAD,
      PRIVATE_KEY_PEM,
      { alg: "RS256" },
      { iat: Math.floor(Date.parse("2026-10-14T11:00:00Z") / 1000) },
    );
    expect((await verifier.verify(headersWith(signature), RAW_BODY)).ok).toBe(false);
  });

  test("a token with no time claims is still accepted, and its body hash is the evidence", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem: PUBLIC_KEY_PEM },
    });
    const result = await verifier.verify(
      headersWith(signDeliveryLikeProvider(PAYLOAD, PRIVATE_KEY_PEM)),
      RAW_BODY,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delivery.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the same body under two unique keys produces the same hash", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "hmac", key: "secret" },
    });
    const first = await verifier.verify(hmacHeaders("key-1"), RAW_BODY);
    const second = await verifier.verify(hmacHeaders("key-2"), RAW_BODY);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.delivery.eventId).not.toBe(second.delivery.eventId);
      expect(first.delivery.bodyHash).toBe(second.delivery.bodyHash);
    }
  });
});
```

- [ ] **Step 3: Run them and verify they fail**

Run: `cd server && bun test tests/billing-webhook-signature.test.ts`
Expected: FAIL — `signDeliveryLikeProvider` takes three arguments, `createWebhookVerifier` takes no `now`/`maxSkewSeconds`, and `delivery.bodyHash` does not exist.

- [ ] **Step 4: Implement the verifier changes**

`server/src/billing/webhook-signature.ts`:

```ts
import { createHmac, createSign, createVerify, timingSafeEqual, createHash } from "node:crypto";
```

Extend the test-only signer so it can carry time claims (its docblock already says it reproduces the provider's shape):

```ts
export function signDeliveryLikeProvider(
  payload: unknown,
  privateKeyPem: string,
  header: { alg: string } = { alg: "RS256" },
  timeClaims: { iat?: number; exp?: number; nbf?: number } = {},
): string {
  // `data` last is not required — the verifier reads the claim by name — but keeping it last makes
  // a test token's shape readable: time claims, then the double-encoded payload.
  const claims = { ...timeClaims, data: JSON.stringify(payload) };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  );
  const signature = createSign("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(privateKeyPem)
    .toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
```

Change the factory signature and add the two checks plus the hash:

```ts
export function createWebhookVerifier(config: {
  key: WebhookKeyConfig;
  /** Injectable clock, in Unix seconds. */
  now?: () => number;
  /** How far a signed `iat` may sit in the past. Defaults to 300, the WeChat adapter's skew. */
  maxSkewSeconds?: number;
}): WebhookVerifier {
  const key = config.key;
  const nowSeconds = config.now ?? (() => Math.floor(Date.now() / 1000));
  const maxSkewSeconds = config.maxSkewSeconds ?? 300;
  const pem = key.mode === "jwt" ? normalisePem(key.publicKeyPem) : null;
  const hmacKey = key.mode === "hmac" ? key.key : null;
  const bodyHashOf = (rawBody: string) =>
    createHash("sha256").update(rawBody).digest("hex");
```

In the jwt branch, immediately after the `jsonEqual(payload, parseJson(rawBody))` check and before `deliveryOf`:

```ts
        /*
         * The replay window (audit A7). The event identity rides in an UNSIGNED header, so the
         * signature alone cannot stop one captured delivery from being replayed under fresh
         * unique keys forever. The token's own time claims can: enforce them when the provider
         * signs them, and leave a body hash behind as evidence when it does not. Enforced
         * "when present" on purpose — a self-hosted provider that signs no time claim must keep
         * delivering, and the hash plus the reconcile finding is what bounds that case.
         */
        const claims = signedData as { exp?: unknown; iat?: unknown; nbf?: unknown };
        const seconds = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const exp = seconds(claims.exp);
        const iat = seconds(claims.iat);
        const nbf = seconds(claims.nbf);
        const now = nowSeconds();
        if (exp !== undefined && now > exp) return { ok: false };
        if (nbf !== undefined && now + maxSkewSeconds < nbf) return { ok: false };
        if (iat !== undefined && now - iat > maxSkewSeconds) return { ok: false };
        if (iat !== undefined && iat - now > maxSkewSeconds) return { ok: false };
```

Both return sites (`jwt` and `hmac`) then carry the hash:

```ts
        const delivery = deliveryOf(headers, payload);
        return delivery
          ? { ok: true, delivery: { ...delivery, bodyHash: bodyHashOf(rawBody) } }
          : { ok: false };
```

`server/src/billing/types.ts` — `VerifiedWebhook` gains:

```ts
  /**
   * sha256 of the raw body, lowercase hex. The signature does not cover the delivery's identity
   * header, so this is the evidence that ties "same content, different event id" together for
   * reconciliation (audit A7). Not a dedupe key: identical bodies under distinct event ids are
   * legitimate, if rare.
   */
  bodyHash: string;
```

- [ ] **Step 5: Persist the hash and surface replays in reconciliation**

`server/src/db/schema/billing.ts` — add to `billingWebhookEvents`:

```ts
    /** sha256 of the raw delivery body; the replay-evidence key (audit A7). Nullable: rows written before it exist. */
    bodyHash: text("body_hash"),
```
and an index beside the existing ones:
```ts
    index("billing_webhook_events_body_hash_idx").on(table.bodyHash),
```

Generate the migration: `cd server && bun run db:generate` (accept the generated name), then `cd server && bun run db:migrate` against the development database.

`server/src/billing/store.ts` — `recordWebhookEvent` inserts `bodyHash: input.bodyHash ?? null`, and add to the `BillingStore` interface in `types.ts`:

```ts
  /** How many distinct event ids carried this exact body; >1 is replay evidence (audit A7). */
  countDeliveriesOfBody(bodyHash: string): Promise<number>;
```
implemented in `store.ts` as:
```ts
    async countDeliveriesOfBody(bodyHash) {
      const [row] = await withPersistenceError(
        "webhook_lookup",
        database
          .select({ value: count() })
          .from(billingWebhookEvents)
          .where(eq(billingWebhookEvents.bodyHash, bodyHash)),
      );
      return row?.value ?? 0;
    },
```
`service.ts:handleWebhook` passes `bodyHash: delivery.bodyHash` into the `event` object, and — after a successful apply — logs when the same body has been seen under more than one event id:

```ts
        const priorDeliveries = await store
          .countDeliveriesOfBody(delivery.bodyHash)
          .catch(() => 1);
        if (priorDeliveries > 1) {
          (deps.log ?? console.warn)(
            `billing: webhook_body_replay event=${delivery.eventId} deliveries=${priorDeliveries}`,
          );
        }
```
(the count runs after the inbox insert, so it includes this delivery).

Add the memory-store twin in `server/tests/support/billing.ts` (`countDeliveriesOfBody` counting rows in `inbox` by a stored `bodyHash`) so the unit suites still compile.

`server/src/billing/reconcile.ts` — one more read-only finding, beside the usage-backlog block:

```ts
      const replayedBodies = await database.execute(sql<{
        bodyHash: string; deliveries: string;
      }>`
        SELECT body_hash AS "bodyHash", COUNT(*)::bigint AS deliveries
        FROM billing_webhook_events
        WHERE body_hash IS NOT NULL
        GROUP BY body_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT ${usageFindingLimit}
      `);
      for (const row of replayedBodies) {
        findings.push({
          category: "payment",
          code: "webhook_body_replay",
          subject: row.bodyHash,
          detail: `deliveries=${row.deliveries} distinct event ids carried this exact body — either the provider retried with fresh identity or somebody is replaying a captured delivery`,
        });
      }
```
Add `"webhook_body_replay"` to the finding-code vocabulary in `types.ts` where the other codes are listed.

- [ ] **Step 6: Run, typecheck, remove the spike log, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-webhook-signature.test.ts server/tests/billing-webhook.test.ts server/tests/billing-store.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-reconcile.integration.test.ts
```
Expected: exit 0, green. Delete the Step-1 spike `console.warn` before committing and record the observed claim names in the commit body.

```bash
git add server/src/billing/webhook-signature.ts server/src/billing/types.ts server/src/billing/store.ts server/src/billing/service.ts \
        server/src/db/schema/billing.ts server/drizzle server/tests/support/billing.ts server/tests/billing-webhook-signature.test.ts server/src/billing/reconcile.ts
git commit -m "fix(billing): bound the webhook replay window and record body-hash evidence (audit A7)"
```

---

### Task 9: The channel's currency is compared against the order snapshot

**Why:** `settlePaidFact` compares `fact.amountCents` to `order.amountCents` and never looks at currency. `alipay.ts:alipayFact` hardcodes `currency: "CNY"`; `wechat.ts:wechatFact` keeps the field only when it already equals `"CNY"`, silently dropping anything else. `reconcile.ts` assumes "currency is database-enforced CNY on both sides" — true of the local column, false of the channel's report.

**Files:**
- Modify: `server/src/billing/payments/provider.ts:52-58` (`PaymentFact.currency?: string`)
- Modify: `server/src/billing/payments/alipay.ts` (`alipayFact` reads the wire field)
- Modify: `server/src/billing/payments/wechat.ts` (`wechatFact` keeps whatever the wire said)
- Modify: `server/src/billing/payments/types.ts:151-158` (`PaymentAnomalyCode` gains `currency_mismatch`; `PaymentSettlementResult` refusal reasons gain `currency-mismatch`; `PaymentOrderRecord.currency: string`)
- Modify: `server/src/billing/payments/service.ts:480-520` (`settlePaidFact`)
- Modify: `server/src/billing/payments/store.ts:36-56` and `:96-116` (`rowOf`/`lockedRowOf` read the column)
- Modify: `app/src/lib/billing/payments.ts:41` and `app/src/lib/billing/invoices.ts:26` (`currency: string`)
- Test: `server/tests/payment-service.test.ts`, `server/tests/payment-alipay.test.ts`, `server/tests/payment-wechat.test.ts`

**Interfaces:**
- Produces: `PaymentFact.currency?: string`; `PaymentAnomalyCode` includes `"currency_mismatch"`; `PaymentSettlementResult` refusal includes `{ kind: "refused"; reason: "currency-mismatch" }`.

- [ ] **Step 1: Write the failing service test**

Append to `server/tests/payment-service.test.ts`. That file's harness is `memoryStore()` (an in-memory `PaymentStore`), `buildService({ store, providers, … })` → `{ service, store, providers, lago }`, and `fakeProvider(id, overrides)` whose `verifyNotification` defaults to `{ ok: false }` — so a callback test overrides it to return the fact under test. Orders are created with `store.insertOrder({ planCode: "pro", provider: "alipay", amountCents: 8800, currency: "CNY", expiresAt, createdBy, checkoutPayload })`.

```ts
test("a paid fact in another currency is refused and recorded, not settled", async () => {
  const store = memoryStore();
  const { order } = await store.insertOrder({
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(clockMs + 15 * 60_000),
    createdBy: "admin-1",
    checkoutPayload: null,
  });
  const { service } = buildService({
    store,
    providers: [
      fakeProvider("alipay", {
        verifyNotification: async () => ({
          ok: true as const,
          fact: {
            outTradeNo: order.id,
            state: "paid" as const,
            channelTransactionId: "tx-usd-1",
            amountCents: 8800,
            currency: "USD",
          },
        }),
      }),
    ],
  });

  const outcome = await service.handleCallback("alipay", new Headers(), "body");

  expect(outcome).toEqual({
    kind: "settlement-refused",
    settlement: { kind: "refused", reason: "currency-mismatch" },
  });
  expect((await store.readOrder(order.id))?.status).toBe("pending");
  expect(await store.countAnomalies(order.id, "currency_mismatch")).toBe(1);
});

test("a fact that names no currency still settles — the channel's silence is not a mismatch", async () => {
  const store = memoryStore();
  const { order } = await store.insertOrder({
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(clockMs + 15 * 60_000),
    createdBy: "admin-1",
    checkoutPayload: null,
  });
  const { service } = buildService({
    store,
    providers: [
      fakeProvider("alipay", {
        verifyNotification: async () => ({
          ok: true as const,
          fact: {
            outTradeNo: order.id,
            state: "paid" as const,
            channelTransactionId: "tx-cny-1",
            amountCents: 8800,
          },
        }),
      }),
    ],
  });

  expect((await service.handleCallback("alipay", new Headers(), "body")).kind).toBe(
    "success",
  );
  expect((await store.readOrder(order.id))?.status).toBe("paid");
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd server && bun test tests/payment-service.test.ts`
Expected: FAIL — the first settles as `success` (the fact's currency is dropped by the adapter and never compared).

- [ ] **Step 3: Implement**

`provider.ts`:
```ts
export type PaymentFact = {
  outTradeNo: string;
  state: "pending" | "paid" | "closed";
  channelTransactionId?: string;
  amountCents?: number;
  /**
   * The currency the CHANNEL states, verbatim, when it states one. Absent means the wire was
   * silent — not "CNY": the service compares this against the order snapshot and silence must
   * not be laundered into a match (audit A5).
   */
  currency?: string;
};
```

`alipay.ts:alipayFact` — replace the hardcoded field:
```ts
  // Read the wire's own word rather than asserting ours: a cross-border trade can state a
  // settlement currency, and a fact that claims CNY without reading it is a fact nobody checked.
  const wireCurrency = anyField(record, "currency") ?? anyField(record, "trans_currency");
  return {
    outTradeNo,
    state,
    channelTransactionId: anyField(record, "trade_no"),
    ...(amountCents !== null && amountCents !== undefined ? { amountCents } : {}),
    ...(wireCurrency ? { currency: wireCurrency } : {}),
  };
```

`wechat.ts:wechatFact` — keep whatever arrived:
```ts
  const currency = stringField(amount ?? {}, "currency");
  return {
    outTradeNo: stringField(record, "out_trade_no") ?? "",
    state,
    channelTransactionId: stringField(record, "transaction_id"),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
```

`types.ts` — add `"currency_mismatch"` to `PaymentAnomalyCode`, `"currency-mismatch"` to the `refused` reason union, and widen `PaymentOrderRecord.currency` to `string`.

`store.ts` — `rowOf` and `lockedRowOf` return `currency: order.currency` (the column) instead of the literal `"CNY"`, and `PaymentOrderLockedRow.currency` is already `string`.

`service.ts:settlePaidFact` — insert **before** the amount comparison (`:492`):

```ts
    /*
     * Currency before amount (audit A5): "49.00 USD" and "49.00 CNY" are the same integer and
     * different money. The channel's silence is not a mismatch — plenty of domestic notifications
     * carry no currency member — but a stated currency that disagrees with the order snapshot is
     * an operator case, never a settlement.
     */
    if (fact.currency !== undefined && fact.currency !== order.currency) {
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "currency_mismatch",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents ?? null,
        detail: `channel reports ${fact.currency}, order snapshot says ${order.currency}`,
      });
      return recorded
        ? { kind: "refused", reason: "currency-mismatch" }
        : { kind: "retryable-failure" };
    }
```

`statements.ts:invoiceOf` and the view types: widen `currency` from `"CNY"` to `string` in `PaymentOrderView` (`payments/types.ts`) and in `toView` (`payments/service.ts`, which currently hardcodes `currency: "CNY"` — pass `order.currency` through instead), plus `app/src/lib/billing/payments.ts:41` and `app/src/lib/billing/invoices.ts:26`. Display code is unchanged (it formats with whatever code arrives).

The `payment_orders_currency_check` constraint stays exactly as it is (`= 'CNY'`): widening the TypeScript types removes a hardcoded lie, it does not widen what the database accepts.

- [ ] **Step 4: Update the schema comment that claimed the check was unnecessary**

`server/src/billing/reconcile.ts` — in the `fact_amount_mismatch` detail string, replace "currency is database-enforced CNY on both sides, only the amount can drift" with "the order's currency is database-enforced CNY; the channel's stated currency is compared at settlement and a disagreement is recorded as a `currency_mismatch` anomaly".

- [ ] **Step 5: Run the adapter tests, fix the fixtures, typecheck**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/payment-alipay.test.ts server/tests/payment-wechat.test.ts server/tests/payment-service.test.ts server/tests/qa-batch1-payment-service.test.ts server/tests/billing-statements.test.ts
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
```
Expected: adapter tests whose fixtures asserted `currency: "CNY"` for a body that named no currency now expect the field absent — update those expectations to the new contract (do not delete them). Exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/billing/payments server/src/billing/reconcile.ts server/src/billing/statements.ts \
        app/src/lib/billing/payments.ts app/src/lib/billing/invoices.ts server/tests
git commit -m "fix(payments): compare the channel's stated currency against the order snapshot (audit A5)"
```

---

### Task 10: Permanent usage-delivery failures reach a terminal state

**Why:** `usage-delivery.ts:176` blocks only on `missing_reservation`. Lago's 404/422 (`provider_refused` — an unknown metric or subscription, permanent), a long-absent subscription (`no_active_subscription`), and a `CreditReservationConflictError` (a released hold or a mismatched actual cost, deterministic) all fall through to `recordDeliveryFailure`, which leaves the row `pending` forever. There is no attempts column, so nothing ever gives up: the sweeper retries every 30 seconds indefinitely and the only symptom is a growing `usage_target_pending` count.

**Files:**
- Modify: `server/src/db/schema/usage-outbox.ts` (two attempts columns)
- Create: migration via `cd server && bun run db:generate`
- Modify: `server/src/billing/usage-outbox.ts` (`recordDeliveryFailure` increments; `blockDelivery` unchanged)
- Modify: `server/src/billing/usage-delivery.ts` (non-retryable code set; block at the attempt ceiling)
- Modify: `server/src/billing/credits-writer.ts` (`CreditReservationConflictError` gains a stable `code`)
- Test: `server/tests/billing-usage-delivery.test.ts`, `server/tests/billing-usage-outbox.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // usage-outbox.ts
  recordDeliveryFailure(eventId: string, target: "lago" | "credits", failureCode: string): Promise<{ attempts: number }>;
  // usage-delivery.ts
  const MAX_DELIVERY_ATTEMPTS = 8;
  const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
    "missing_reservation", "provider_refused", "reservation_conflict", "usage_outbox_conflict",
  ]);
  // credits-writer.ts
  export class CreditReservationConflictError extends Error { readonly code = "reservation_conflict"; }
  ```

- [ ] **Step 1: Write the failing delivery tests**

Append to `server/tests/billing-usage-delivery.test.ts`:

```ts
describe("a permanent delivery failure ends in a terminal state (audit C1)", () => {
  test("a provider refusal blocks on the first attempt", async () => {
    const outbox = memoryOutbox([pendingRow({ eventId: "ev-1" })]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => { throw new UsageDeliveryError("provider_refused"); },
      chargeCredits: async () => {},
    });
    await delivery.runBatch(10);
    expect(outbox.rows.get("ev-1")?.lagoStatus).toBe("blocked");
    expect(outbox.rows.get("ev-1")?.lagoLastErrorCode).toBe("provider_refused");
  });

  test("a reservation conflict blocks the credits target instead of retrying forever", async () => {
    const outbox = memoryOutbox([pendingRow({ eventId: "ev-2", reservationId: "cr-1" })]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => {},
      chargeCredits: async () => {
        throw new CreditReservationConflictError("already released");
      },
    });
    await delivery.runBatch(10);
    expect(outbox.rows.get("ev-2")?.creditsStatus).toBe("blocked");
  });

  test("a transient failure stays pending until the attempt ceiling, then blocks", async () => {
    const outbox = memoryOutbox([pendingRow({ eventId: "ev-3" })]);
    const delivery = createUsageDelivery({
      outbox,
      sendToLago: async () => { throw new UsageDeliveryError("unreachable"); },
      chargeCredits: async () => {},
    });
    for (let pass = 0; pass < MAX_DELIVERY_ATTEMPTS - 1; pass += 1) {
      await delivery.runBatch(10);
      expect(outbox.rows.get("ev-3")?.lagoStatus).toBe("pending");
    }
    await delivery.runBatch(10);
    expect(outbox.rows.get("ev-3")?.lagoStatus).toBe("blocked");
    expect(outbox.rows.get("ev-3")?.lagoAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  test("a delivered target never counts attempts", async () => {
    const outbox = memoryOutbox([pendingRow({ eventId: "ev-4" })]);
    const delivery = createUsageDelivery({
      outbox, sendToLago: async () => {}, chargeCredits: async () => {},
    });
    await delivery.runBatch(10);
    expect(outbox.rows.get("ev-4")?.lagoStatus).toBe("delivered");
    expect(outbox.rows.get("ev-4")?.lagoAttempts).toBe(0);
  });
});
```

(`memoryOutbox` / `pendingRow` are that file's existing doubles; extend `pendingRow` with `lagoAttempts: 0, creditsAttempts: 0` and make `memoryOutbox.recordDeliveryFailure` increment and return `{ attempts }`. Add `MAX_DELIVERY_ATTEMPTS` and `CreditReservationConflictError` to the file's imports — the latter from `../src/billing/credits-writer`, the former from `../src/billing/usage-delivery`.)

- [ ] **Step 2: Run them and verify they fail**

Run: `cd server && bun test tests/billing-usage-delivery.test.ts`
Expected: FAIL — rows stay `pending`.

- [ ] **Step 3: Add the columns and generate the migration**

`server/src/db/schema/usage-outbox.ts`:

```ts
    /** Delivery attempts per target, so a permanent failure has somewhere to end (audit C1). */
    lagoAttempts: integer("lago_attempts").notNull().default(0),
    creditsAttempts: integer("credits_attempts").notNull().default(0),
```
with checks beside the existing ones:
```ts
    check("usage_outbox_lago_attempts_check", sql`${table.lagoAttempts} >= 0`),
    check("usage_outbox_credits_attempts_check", sql`${table.creditsAttempts} >= 0`),
```

Run `cd server && bun run db:generate && bun run db:migrate`.

- [ ] **Step 4: Implement the counting and the terminal classification**

`server/src/billing/usage-outbox.ts` — `recordDeliveryFailure` increments and answers the new count (both branches of the ternary gain `lagoAttempts: sql\`${usageOutbox.lagoAttempts} + 1\`` / `creditsAttempts: …`), and returns:

```ts
      .returning({
        eventId: usageOutbox.eventId,
        attempts: target === "lago" ? usageOutbox.lagoAttempts : usageOutbox.creditsAttempts,
      });

    if (rows.length === 0) {
      await assertRecordExists(eventId);
      return { attempts: 0 };
    }
    return { attempts: rows[0]!.attempts };
```

Update the `UsageOutbox` interface signature accordingly.

`server/src/billing/credits-writer.ts` — give the conflict error a stable code so `failureCodeOf` can classify it (it currently reads `.code` and finds nothing, degrading to `delivery_failed`):

```ts
export class CreditReservationConflictError extends Error {
  /** Stable, snake_case, matched by the delivery worker's non-retryable set (audit C1). */
  readonly code = "reservation_conflict";
  constructor(message: string) {
    super(message);
    this.name = "CreditReservationConflictError";
  }
}
```

`server/src/billing/usage-delivery.ts`:

```ts
/** A target gives up after this many attempts: the row becomes evidence, not a hot loop. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * Failures a retry cannot fix (audit C1): no reservation facts to settle, a provider that says the
 * metric or subscription does not exist, a hold that is already terminal or was settled with a
 * different cost, and an event whose recorded facts contradict this one. Each ends the target in
 * `blocked` — the manual-review state reconciliation already reports — instead of retrying every
 * 30 seconds until somebody notices the pending count.
 */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "missing_reservation",
  "provider_refused",
  "reservation_conflict",
  "usage_outbox_conflict",
]);
```

and in the failure branch replace the current `if (code === "missing_reservation")` with:

```ts
            if (NON_RETRYABLE_CODES.has(code)) {
              await target.block(code);
            } else {
              const { attempts } = await outbox.recordDeliveryFailure(
                record.eventId,
                target.name,
                code,
              );
              if (attempts >= MAX_DELIVERY_ATTEMPTS) {
                log(
                  `billing: usage delivery exhausted event=${record.eventId} target=${target.name} attempts=${attempts} code=${code}`,
                );
                await target.block(code);
              }
            }
```

- [ ] **Step 5: Report exhaustion where an operator reads it**

`server/src/billing/reconcile.ts` — the existing `usage_target_blocked` finding detail gains the attempt count. Change the inner select to carry `lago_attempts` / `credits_attempts` as `attempts`, and the detail string to:

```ts
        detail: `target=${target} state=${status} attempts=${row.attempts} attempt_age_seconds=${ageSeconds} last_failure_code=${failureCode}`,
```

- [ ] **Step 6: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-usage-delivery.test.ts server/tests/billing-usage-outbox.integration.test.ts server/tests/billing-credits-writer.integration.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-reconcile.integration.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/db/schema/usage-outbox.ts server/drizzle server/src/billing/usage-outbox.ts server/src/billing/usage-delivery.ts \
        server/src/billing/credits-writer.ts server/src/billing/reconcile.ts server/tests
git commit -m "fix(billing): permanent usage-delivery failures reach a terminal blocked state (audit C1)"
```

---

### Task 11: The subscription projection retires what the provider no longer returns

**Why:** `writeSubscriptionProjections` only upserts. A subscription Lago stops returning (deleted, or moved to a status outside the four requested — `lago.ts:167` does not ask for `pending`) leaves the local row `active` forever: `entitlements()` keeps answering `active: true`, and `createPurchase` keeps refusing with `active-subscription`. `reconcile.ts` only checks the opposite direction (`applied_without_subscription`) and by design never calls the provider, so this drift is invisible.

**Files:**
- Modify: `server/src/billing/types.ts` (`BillingStore` gains `retireAbsentSubscriptions`)
- Modify: `server/src/billing/store.ts` (implementation)
- Modify: `server/src/billing/service.ts` (`writeSubscriptionProjections` and the `subscription.*` webhook projection call it)
- Modify: `server/tests/support/billing.ts` (memory twin)
- Test: `server/tests/billing-store.integration.test.ts`, `server/tests/billing-sync.test.ts`, `server/tests/billing-webhook.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /**
   * Retire the local rows for one customer that the provider's own list no longer contains:
   * status → `terminated`, `updatedAt` → now. Returns how many rows moved. Never deletes —
   * the row is the audit of what this deployment believed.
   */
  retireAbsentSubscriptions(
    externalCustomerId: string,
    presentExternalSubscriptionIds: readonly string[],
  ): Promise<number>;
  ```

- [ ] **Step 1: Write the failing store test**

Append to `server/tests/billing-store.integration.test.ts`. That file already holds a real `database`, a real `store = createBillingStore(database)` and a `prefix` at module scope, with an `afterAll` that deletes by prefix — use them; the read-after-write this task needs cannot be faked.

```ts
test("a subscription the provider no longer lists is retired, not left active", async () => {
  const customer = `${prefix}-retire`;
  await store.upsertCustomer({ externalId: customer, name: null });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-old`,
    planCode: "standard",
    status: "active",
  });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-new`,
    planCode: "pro",
    status: "active",
  });

  const retired = await store.retireAbsentSubscriptions(customer, [
    `${prefix}-s-new`,
  ]);

  expect(retired).toBe(1);
  const rows = await store.readSubscriptions(customer);
  expect(rows.find((row) => row.externalSubscriptionId === `${prefix}-s-old`)?.status).toBe(
    "terminated",
  );
  expect(rows.find((row) => row.externalSubscriptionId === `${prefix}-s-new`)?.status).toBe(
    "active",
  );
});

test("retiring is idempotent and never touches another customer", async () => {
  const customer = `${prefix}-retire-a`;
  const other = `${prefix}-retire-b`;
  await store.upsertCustomer({ externalId: customer, name: null });
  await store.upsertCustomer({ externalId: other, name: null });
  await store.upsertSubscription({
    externalCustomerId: customer,
    externalSubscriptionId: `${prefix}-s-a`,
    planCode: "standard",
    status: "active",
  });
  await store.upsertSubscription({
    externalCustomerId: other,
    externalSubscriptionId: `${prefix}-s-b`,
    planCode: "standard",
    status: "active",
  });

  expect(await store.retireAbsentSubscriptions(customer, [])).toBe(1);
  expect(await store.retireAbsentSubscriptions(customer, [])).toBe(0);
  expect((await store.readSubscriptions(other))[0]?.status).toBe("active");
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `cd /Users/wuyongjun/trea/OpenBot && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-store.integration.test.ts`
Expected: FAIL — `retireAbsentSubscriptions` is not a member of `BillingStore`.

- [ ] **Step 3: Implement**

`server/src/billing/store.ts`:

```ts
    async retireAbsentSubscriptions(externalCustomerId, presentExternalSubscriptionIds) {
      const now = new Date();
      // One UPDATE, guarded by the customer and by "not in the list the provider just returned".
      // `terminated` rather than a delete: the row is the record of what this deployment believed,
      // and a later delivery can still move it back through upsertSubscription.
      const conditions = [
        eq(billingSubscriptions.externalCustomerId, externalCustomerId),
        ne(billingSubscriptions.status, "terminated"),
      ];
      if (presentExternalSubscriptionIds.length > 0) {
        conditions.push(
          notInArray(
            billingSubscriptions.externalSubscriptionId,
            [...presentExternalSubscriptionIds],
          ),
        );
      }
      const rows = await withPersistenceError(
        "subscription_retire",
        database
          .update(billingSubscriptions)
          .set({ status: "terminated", updatedAt: now })
          .where(and(...conditions))
          .returning({ id: billingSubscriptions.externalSubscriptionId }),
      );
      return rows.length;
    },
```

with `notInArray` added to the `drizzle-orm` import and `"subscription_retire"` added to `BillingPersistenceOperation` in `types.ts`.

`server/src/billing/service.ts` — `writeSubscriptionProjections` becomes the one place a full provider list is folded locally:

```ts
  async function writeSubscriptionProjections(
    subscriptions: readonly LagoSubscriptionBody[],
  ): Promise<void> {
    for (const subscription of subscriptions) {
      await store.upsertSubscription({
        externalCustomerId: subscription.externalCustomerId,
        externalSubscriptionId: subscription.externalSubscriptionId,
        planCode: subscription.planCode,
        status: subscription.status,
      });
    }
    /*
     * The list the provider just returned is the whole truth about what it holds, so a local row
     * it does not name is stale — and a stale `active` row is an entitlement that never ends and a
     * purchase guard that never opens (audit B6). Retire rather than delete: the row stays as the
     * record, and a later delivery can move it back.
     */
    const byCustomer = new Map<string, string[]>();
    for (const subscription of subscriptions) {
      const present = byCustomer.get(subscription.externalCustomerId) ?? [];
      present.push(subscription.externalSubscriptionId);
      byCustomer.set(subscription.externalCustomerId, present);
    }
    for (const [externalCustomerId, present] of byCustomer) {
      const retired = await store.retireAbsentSubscriptions(
        externalCustomerId,
        present,
      );
      if (retired > 0) {
        (deps.log ?? console.warn)(
          `billing: retired ${retired} subscription projection(s) the provider no longer lists for ${externalCustomerId}`,
        );
      }
    }
  }
```

Guard the empty-list case explicitly — an empty list means "the provider holds nothing for this customer", which is exactly when everything must be retired, but only when the read itself succeeded. `readSubscriptions` already throws on a malformed body, so an empty array here is a real answer; add a comment saying so.

Call it from the `subscription.*` webhook branch too (`readProjectionFor` currently maps subscriptions into the projection without retiring): add `subscriptionsPresentFor: delivery.externalCustomerId` to the projection input, and have `store.applyWebhookProjection` call `retireAbsentSubscriptions(input.customer.externalId, ids)` inside its transaction after the upserts.

- [ ] **Step 4: Update the memory store and run**

`server/tests/support/billing.ts` — implement `retireAbsentSubscriptions` over the `subscriptions` Map with the same semantics (and the same rollback registration the other writes use).

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-sync.test.ts server/tests/billing-webhook.test.ts server/tests/billing-entitlement.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-store.integration.test.ts
```
Expected: exit 0, green. Any existing test that asserted "a row the provider stopped returning stays active" is asserting the bug — restate it against the new contract.

- [ ] **Step 5: Document the remaining gap**

Append to the `readSubscriptions` docblock in `service.ts` and to `docs/configuration.md`'s billing section:

```markdown
The provider list is requested for four statuses (`active`, `incomplete`, `canceled`,
`terminated`); a subscription in Lago's `pending` state is therefore invisible to the sync and to
the purchase guard. Adding it needs a `billing_subscriptions_status_check` migration and a
`BillingSubscriptionStatus` widening, and is deliberately not part of this change.
```

- [ ] **Step 6: Commit**

```bash
git add server/src/billing/store.ts server/src/billing/service.ts server/src/billing/types.ts server/tests/support/billing.ts server/tests docs/configuration.md
git commit -m "fix(billing): retire subscription projections the provider no longer lists (audit B6)"
```

---

### Task 12: A code-run usage row may not exist without reservation facts

**Why:** `workshop/metering.ts:reportCodeRunUsage` writes an outbox row with no `reservationId`. Today that is unreachable — `codesandbox/gateway.ts:163-166` refuses every code run when billing is on because `client.ts:131` hardcodes `enforceableTokenBudget: false`. The moment somebody flips that capability without adding a reservation to the code-run path, every run produces a row the credits target immediately blocks (`missing_reservation`): Lago meters it, credits never charge, and reconciliation fills with `usage_target_blocked`. Make the trap impossible instead of documented.

**Files:**
- Modify: `server/src/workshop/metering.ts:127-160` (`reportCodeRunUsage`)
- Modify: `server/src/index.ts:3980-4000` (the reporter's assembly passes the policy state)
- Test: `server/tests/workshop-metering.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function reportCodeRunUsage(
    outbox: Pick<UsageOutbox, "record"> | null | undefined,
    input: CodeRunUsageInput & {
      externalCustomerId: string;
      /**
       * The reservation facts a billed code run must carry. Absent while the sandbox contract
       * cannot enforce a token budget — and then no row is written at all, because a code-run
       * row without reservation facts is a permanently blocked credits target.
       */
      reservation?: {
        reservationId: string;
        actualCostNumerator: string;
        actualCostDenominator: string;
      };
      /** True when this deployment meters code runs to credits at all. */
      creditMeteringEnabled?: boolean;
    },
  ): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/workshop-metering.test.ts`. That file already defines a `RUN` fixture (`:27`) and calls `reportCodeRunUsage(outbox, RUN as never)`; keep the `as never` cast idiom so the extra fields do not fight the fixture's type.

```ts
describe("a code-run usage row must carry its reservation facts (audit B3)", () => {
  const recording = (rows: unknown[]) => ({
    record: async (row: unknown) => {
      rows.push(row);
      return { inserted: true };
    },
  });

  test("credit metering on with no reservation writes nothing and says why", async () => {
    const rows: unknown[] = [];
    const messages: string[] = [];
    const written = await reportCodeRunUsage(
      recording(rows),
      {
        ...RUN,
        externalCustomerId: "c1",
        creditMeteringEnabled: true,
      } as never,
      (message) => messages.push(message),
    );
    expect(written).toBe(false);
    expect(rows).toEqual([]);
    expect(messages.join("\n")).toContain("billing-code-run-reservation-missing");
  });

  test("credit metering on with reservation facts writes them through", async () => {
    const rows: { reservationId?: string | null }[] = [];
    const written = await reportCodeRunUsage(recording(rows) as never, {
      ...RUN,
      externalCustomerId: "c1",
      creditMeteringEnabled: true,
      reservation: {
        reservationId: "cr-1",
        actualCostNumerator: "120",
        actualCostDenominator: "100",
      },
    } as never);
    expect(written).toBe(true);
    expect(rows[0]?.reservationId).toBe("cr-1");
  });

  test("Lago-only metering (no credit metering) still writes its row", async () => {
    const rows: { reservationId?: string | null }[] = [];
    const written = await reportCodeRunUsage(recording(rows) as never, {
      ...RUN,
      externalCustomerId: "c1",
    } as never);
    expect(written).toBe(true);
    expect(rows[0]?.reservationId).toBeNull();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `cd server && bun test tests/workshop-metering.test.ts`
Expected: FAIL — `reportCodeRunUsage` takes two arguments and always writes.

- [ ] **Step 3: Implement**

`server/src/workshop/metering.ts`:

```ts
export async function reportCodeRunUsage(
  outbox: Pick<UsageOutbox, "record"> | null | undefined,
  input: CodeRunUsageInput & {
    externalCustomerId: string;
    reservation?: {
      reservationId: string;
      actualCostNumerator: string;
      actualCostDenominator: string;
    };
    creditMeteringEnabled?: boolean;
  },
  log: (message: string) => void = (message) => console.warn(message),
): Promise<boolean> {
  if (!outbox) return false; // Unconfigured: silent, and the code_runs row already stands.
  if (input.inputTokens <= 0 && input.outputTokens <= 0) return false; // Nothing meterable.
  /*
   * A code-run row without reservation facts is a permanently blocked credits target: the
   * delivery worker's credit effect needs the hold and the exact cost to settle against, and
   * `missing_reservation` is terminal by design (audit B3). Writing it anyway would meter the run
   * to the provider while silently never charging it — so while the sandbox contract cannot
   * enforce a token budget (the gateway refuses billed runs for the same reason), the honest
   * answer is no row at all, loudly.
   */
  if (input.creditMeteringEnabled === true && input.reservation === undefined) {
    log(
      `billing: billing-code-run-reservation-missing run=${input.runId} tokens=${input.inputTokens}+${input.outputTokens} — no credit hold exists for this run, so no usage row is written`,
    );
    return false;
  }
  await outbox.record({
    eventId: `code-run:${input.runId}`,
    source: "code_run",
    externalCustomerId: input.externalCustomerId,
    transactionId: `code-run:${input.runId}`,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    model: input.modelId,
    client: currentUsageOrigin(),
    occurredAt: input.occurredAt,
    reservationId: input.reservation?.reservationId ?? null,
    actualCostNumerator: input.reservation?.actualCostNumerator ?? null,
    actualCostDenominator: input.reservation?.actualCostDenominator ?? null,
    runId: input.runId,
    botId: input.botId,
    ownerUserId: input.ownerUserId,
    sessionId: input.sessionId,
    status: input.status,
  });
  return true;
}
```

`server/src/index.ts` (~`:3987`) — pass the policy state through:

```ts
        await reportCodeRunUsage(
          usageOutbox,
          {
            ...usage,
            externalCustomerId: billing.externalCustomerKey,
            // True only when the hard-cap policy actually prices code runs; the gateway refuses
            // billed runs until the sandbox can enforce a budget, so this stays false today and
            // the guard inside reportCodeRunUsage is what makes flipping it safe.
            creditMeteringEnabled: billingSettings?.creditPolicy.configured === true,
          },
          (message) => log.warn(message),
        );
```

- [ ] **Step 4: Record the flip condition where the capability lives**

`server/src/codesandbox/client.ts:125-135` — extend the comment above `enforceableTokenBudget: false`:

```ts
      /**
       * Flipping this to `true` is a billing decision, not a capability flag: the code-run path
       * holds no credit reservation today, so `reportCodeRunUsage` refuses to write a usage row
       * while `creditMeteringEnabled` is true and no reservation is supplied (audit B3). Land the
       * reservation first — see `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`,
       * "Billed admission per surface".
       */
      enforceableTokenBudget: false,
```

- [ ] **Step 5: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/workshop-metering.test.ts server/tests/billing-usage-outbox.integration.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/workshop/metering.ts server/src/index.ts server/src/codesandbox/client.ts server/tests/workshop-metering.test.ts
git commit -m "fix(billing): a code-run usage row must carry reservation facts or not exist (audit B3)"
```

---

# Phase D — hygiene, visibility, operational bounds (P3)

### Task 13: Delete the dead seams and the comments that describe them

**Why:** three interface members have no production caller and one comment describes a check that was removed two commits ago. In a billing module, a comment claiming a protection exists is worse than no comment.
- `CreditWriter.consumeCredits` (`credits-writer.ts:556`) — the POST-PAID withdrawal, superseded by reserve/settle; `server/tests/qa-batch1-llm-meter-id.test.ts` actively asserts `index.ts` must **not** call it. Its docblock contradicts the approved hard-cap policy.
- `CreditWriter.readBalance` (`:268`) — identical body to `availableBalance` (`:272`); two names, one behaviour.
- `PaymentStore.readLatestPaidOrder` (`payments/store.ts:295`) — its only caller was replaced by `resolveActivationOwnership` in `88664e88`.
- `BillingService.recordUsage` (`service.ts:427`) — superseded by `deliverUsage` + the outbox.
- `payments/service.ts:620-626` — a truncated comment ("…instead of hiding inside a second") describing the deleted duplicate check.

**Files:**
- Modify: `server/src/billing/credits-writer.ts`, `server/src/billing/payments/store.ts`, `server/src/billing/payments/types.ts`, `server/src/billing/service.ts`, `server/src/billing/types.ts`, `server/src/billing/payments/service.ts:618-628`, `server/src/billing/credits.ts` (module docblock still narrates post-paid draws)
- Delete tests: the `consumeCredits` describes in `server/tests/billing-credits-writer.integration.test.ts:128-270` and `server/tests/qa-batch2-credits-consume.integration.test.ts`
- Modify test doubles: `server/tests/payment-service.test.ts:103`, `server/tests/qa-batch1-payment-service.test.ts:162`, `server/tests/billing-statements.test.ts:142`

**Interfaces:**
- Produces: `CreditWriter` = `{ grantCredits, availableBalance, reserveCredits, settleReservation, releaseReservation }`. `PaymentStore` loses `readLatestPaidOrder`. `BillingService` loses `recordUsage`.

- [ ] **Step 1: Prove they are dead before deleting**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot
grep -rn "consumeCredits\|readBalance\|readLatestPaidOrder\|recordUsage" server/src app/src shared worker supervisor --include="*.ts" | grep -v "billing/credits-writer.ts\|billing/payments/store.ts\|billing/payments/types.ts\|billing/service.ts\|billing/types.ts\|billing/reconcile.ts"
```
Expected: no output other than comments. **If any call site appears, stop and re-scope this task** — the finding is wrong and the code is live.

- [ ] **Step 2: Delete `consumeCredits` and `readBalance`, and the tests that only exercise them**

Remove from `credits-writer.ts`: the `consumeCredits` and `readBalance` members of the `CreditWriter` type, their docblocks, and their implementations; drop the now-unused `remainderOf`-based "post-paid" narrative from the file header (the header's "both halves" framing becomes "the deposit and the hold/settle/release trio"). Remove the `consumeCredits` describes named above.

In `credits.ts`'s module docblock and in `db/schema/credits.ts`'s `applied` column comment, replace the post-paid explanation with the settlement one:

```
 * `applied` is what the grants absorbed of `credits`. Equal except when the charge exceeded the
 * capacity behind it (an over-bound settlement clamped to its hold, or a hold whose grants lapsed):
 * the ledger keeps the whole truth, this column records how much of it the grants could fund, and
 * `credits - applied` is the shortfall — surfaced by the reconciler's `overdraw_total` (Task 14).
```

- [ ] **Step 3: Delete `readLatestPaidOrder` and fix the comment that misses it**

Remove the member from `PaymentStore` (`payments/types.ts:220-228`) and its implementation (`payments/store.ts:295-320`). Remove it from the three test doubles. Replace `payments/service.ts:618-628` with an accurate one:

```ts
    /*
     * The confirm stands on its own evidence: the paid fact's partial unique index makes one
     * channel transaction claimable by exactly one order, and cross-order duplicates are settled
     * by `resolveActivationOwnership` inside `activateOrder` below (which records the
     * `duplicate_paid` anomaly and withholds the second entitlement). An earlier revision compared
     * `readLatestPaidOrder` here as well; that check was folded into the ownership resolution in
     * 88664e88, and this comment is the record of why nothing here looks like it.
     */
    const fresh = await deps.store.readOrder(order.id).catch(() => null);
    if (fresh) await activateOrder(fresh);
    return { kind: "claimed" };
```

- [ ] **Step 4: Delete `recordUsage`**

Remove the member from `BillingService` (`types.ts:557-568`) and its implementation (`service.ts:427-462`), plus the `describe("the usage meter (recordUsage)")` block in `server/tests/billing-routes.test.ts` and any double that implements it. Keep `deliverUsage` and its docblock; in `deliverUsage`'s comment, drop the "twin of recordUsage" framing and state the contract on its own terms.

- [ ] **Step 5: Fix the `remaining: 0` lie if `consumeCredits` deletion did not remove it**

If Step 1 showed `consumeCredits` is live in some assembly this audit missed, do **not** delete it; instead change its replay answers (`credits-writer.ts:582`, `:615`) from `remaining: 0` to `remaining: null` and widen the return type to `remaining: number | null`, so a caller can no longer read "not computed" as "empty".

- [ ] **Step 6: Run everything, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-credits.test.ts server/tests/billing-routes.test.ts server/tests/payment-service.test.ts server/tests/qa-batch1-payment-service.test.ts server/tests/billing-statements.test.ts server/tests/billing-store.test.ts server/tests/qa-batch1-llm-meter-id.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-credits-writer.integration.test.ts server/tests/qa-batch1-payment-store.integration.test.ts
```
Expected: exit 0, green.

```bash
git add -A server/src server/tests
git commit -m "refactor(billing): remove dead seams and the comments describing deleted behavior (audit B4/B5/C5)"
```

---

### Task 14: Overdraw becomes visible in the ledger read and in reconciliation

**Why:** `db/schema/credits.ts` promises "`credits - applied` is the overdraw, visible instead of rounded away", but `credits.ts:consumption()` returns only `credits`, the frontend type has no `applied`, and `reconcile.ts` compares `Σ used` to `Σ applied` without ever summing the shortfall. A deployment that has been consuming more than its grants can fund has no way to see it short of hand-written SQL.

**Files:**
- Modify: `server/src/billing/types.ts:381-396` (`CreditConsumptionEntry` gains `applied`)
- Modify: `server/src/billing/credits.ts` (`consumption` returns it)
- Modify: `server/src/billing/reconcile.ts` (`checked.overdraw` + a finding when non-zero)
- Modify: `app/src/lib/billing/credits.ts`, `app/src/components/billing/consumption-table.tsx`, `app/src/locales/{en,zh-CN}/settings.json`
- Test: `server/tests/billing-capacity.test.ts` (or a new `billing-credits-consumption.integration.test.ts`), `server/tests/billing-reconcile.integration.test.ts`, `app/tests/billing-format.test.tsx`

**Interfaces:**
- Produces: `CreditConsumptionEntry.applied: number`; `ReconcileReport.checked.overdraw: { entries: number; units: string }` (exact decimal string, matching the reconciler's BigInt discipline); finding code `"credit_overdraw"`.

- [ ] **Step 1: Write the failing reconcile test**

Append to `server/tests/billing-reconcile.integration.test.ts`. That file already opens `database` from `testDatabaseUrl()`, builds `const reconciler = createReconciler(database, prefix)` (`:42`), and seeds with direct `database.insert(billingCustomers | creditGrants | creditLedger)` calls; use the same idiom with this test's own customer id so it cannot collide with `agreeingWorld()`.

```ts
describe("overdraw is reported exactly (audit D1)", () => {
  const customer = `${prefix}-overdraw`;

  test("a ledger the grants could not fund totals the shortfall in exact scaled units", async () => {
    await database
      .insert(billingCustomers)
      .values({ externalId: customer, name: null })
      .onConflictDoNothing({ target: billingCustomers.externalId });
    await database.insert(creditGrants).values({
      id: `${customer}-g1`,
      externalCustomerId: customer,
      source: "promo",
      reason: "overdraw-audit",
      total: 100,
      used: 100,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      status: "active",
      idempotencyKey: `${customer}-gk1`,
    });
    // credits > applied is the overdraw shape the settle path writes when a charge exceeds the
    // capacity behind its hold. The grant identity still holds: used 100 == applied 100.
    await database.insert(creditLedger).values({
      id: `${customer}-l1`,
      externalCustomerId: customer,
      title: "over-bound settlement",
      requestId: null,
      idempotencyKey: `${customer}-lk1`,
      credits: 250,
      applied: 100,
    });

    const report = await reconciler.reconcile();

    expect(report.checked.overdraw.units).not.toBe("0");
    const finding = report.findings.find(
      (item) => item.code === "credit_overdraw" && item.subject === customer,
    );
    expect(finding?.category).toBe("credits");
    expect(finding?.detail).toContain("entries=1");
    expect(finding?.detail).toContain("units=150");
    // The identity invariant must NOT fire for this customer: overdraw is not divergence.
    expect(
      report.findings.some(
        (item) =>
          item.code === "grants_ledger_divergence" && item.subject === customer,
      ),
    ).toBe(false);
  });

  test("a customer that never overdraws produces no credit_overdraw finding", async () => {
    const report = await reconciler.reconcile();
    expect(
      report.findings.some(
        (item) => item.code === "credit_overdraw" && item.subject === prefix,
      ),
    ).toBe(false);
  });
});
```

(`report.checked.overdraw` is the whole-report total, so the first test asserts it is non-zero rather than an exact number — other suites in this file seed their own rows. The per-customer exact figure is asserted on the finding's `units=150`.)

- [ ] **Step 2: Run and verify it fails**

Run: `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-reconcile.integration.test.ts`
Expected: FAIL — `checked.overdraw` is undefined.

- [ ] **Step 3: Implement the reconciler half**

In `reconcile.ts`, beside the existing exact BigInt sums (the `usedByCustomer` / `appliedByCustomer` block), add:

```ts
      /*
       * The shortfall the ledger already records per row (`credits - applied`): what the grants
       * could not fund. Exact decimal strings and BigInt, the same discipline as the identity sums
       * above — an overdraw total is a money figure and must not be rounded on the way into a
       * report that audits somebody else's arithmetic (audit D1).
       */
      const overdrawByCustomer = await database
        .select({
          customer: creditLedger.externalCustomerId,
          entries: sql<string>`COUNT(*)::bigint`,
          units: sql<string>`COALESCE(SUM(${creditLedger.credits} - ${creditLedger.applied}), 0)::bigint`,
        })
        .from(creditLedger)
        .where(sql`${creditLedger.credits} > ${creditLedger.applied}`)
        .groupBy(creditLedger.externalCustomerId);

      let overdrawEntries = 0n;
      let overdrawUnits = 0n;
      for (const row of overdrawByCustomer) {
        const entries = BigInt(row.entries);
        const units = BigInt(row.units);
        overdrawEntries += entries;
        overdrawUnits += units;
        findings.push({
          category: "credits",
          code: "credit_overdraw",
          subject: row.customer,
          detail: `entries=${entries} units=${units} — consumption the grants could not fund; the ledger recorded the full cost and applied what the balance allowed. Remediation is an operator decision (grant, invoice, or accept)`,
        });
      }
```

and in the returned `checked` object:

```ts
          overdraw: {
            entries: Number(overdrawEntries),
            units: overdrawUnits.toString(),
          },
```

Add `overdraw: { entries: number; units: string }` to `ReconcileReport["checked"]` in `types.ts` and `"credit_overdraw"` to the finding-code vocabulary.

- [ ] **Step 4: Write the failing read-side test, then implement**

Append to the consumption integration test (create `server/tests/billing-credits-consumption.integration.test.ts` if Task 1's file does not cover consumption):

```ts
test("a consumption entry carries what the grants absorbed beside what the call cost", async () => {
  const customer = `${prefix}-consumption`;
  await writer.grantCredits({
    externalCustomerId: customer, source: "promo", totalCents: 100,
    expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: `${customer}-g`,
  });
  const reserved = await writer.reserveCredits({
    externalCustomerId: customer, idempotencyKey: `${customer}-r`,
    maximumCents: 100, expiresAt: new Date(Date.now() + 60_000),
  });
  if (!reserved.reserved) throw new Error("test setup: the hold should fit");
  await writer.settleReservation({
    reservationId: reserved.reservationId,
    actual: { numerator: 250n, denominator: 1n },
    title: "over-bound settlement",
  });

  const page = await credits.consumption({ from: null, to: null, page: 1 }, customer);
  expect(page.entries[0]).toMatchObject({ credits: 2.5, applied: 1 });
});
```

Implement in `credits.ts:consumption()` — the entry mapping gains `applied: scaleDown(row.applied)` — and in `types.ts:381-396`:

```ts
  /** How many credits this call cost, in full. */
  credits: number;
  /**
   * How much of that cost the grants absorbed. Equal to `credits` except when the balance came up
   * short; `credits - applied` is the shortfall the reconciler totals as `overdraw`.
   */
  applied: number;
```

- [ ] **Step 5: Surface it in the table**

`app/src/lib/billing/credits.ts` — `CreditConsumptionEntry` gains `applied: number`.

`app/src/components/billing/consumption-table.tsx` — in the credits cell, when `entry.applied < entry.credits`, render the shortfall as a muted suffix and give the row a `title` explaining it:

```tsx
              <span className="tabular-nums">
                −{formatCredits(entry.credits)}
                {entry.applied < entry.credits ? (
                  <span
                    className="text-muted-foreground ml-1 text-xs"
                    title={t("creditsPage.overdrawHint", {
                      shortfall: formatCredits(entry.credits - entry.applied),
                    })}
                  >
                    {t("creditsPage.overdrawBadge", {
                      shortfall: formatCredits(entry.credits - entry.applied),
                    })}
                  </span>
                ) : null}
              </span>
```

Add both keys to `app/src/locales/en/settings.json` and `app/src/locales/zh-CN/settings.json`:
- en: `"overdrawBadge": "({{shortfall}} unfunded)"`, `"overdrawHint": "This call cost more than the balance could fund. The ledger records the full cost; {{shortfall}} was not covered by any grant."`
- zh-CN: `"overdrawBadge": "（未覆盖 {{shortfall}}）"`, `"overdrawHint": "本次消费超出可用余额。台账记录全部费用，其中 {{shortfall}} 无积分覆盖。"`

- [ ] **Step 6: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-reconcile.integration.test.ts server/tests/billing-credits-consumption.integration.test.ts
cd /Users/wuyongjun/trea/OpenBot/app && bun test tests/billing-format.test.tsx tests/billing-invoice-shared.test.tsx
```
Expected: exit 0, green.

```bash
git add server/src/billing app/src server/tests
git commit -m "feat(billing): surface credit overdraw in the ledger read and reconciliation (audit D1)"
```

---

### Task 15: Bound reconciliation memory, make sweepers single-instance, and stop them on shutdown

**Why:** `reconcile.ts` loads `paidOrders`, `paidFacts`, `duplicateAnomalies` and the `reservedRows` join into memory with no limit (the usage-outbox block right below it *does* bound itself with `usageFindingLimit` — two standards in one file). Both sweepers are per-process `setInterval`s with no lock, so every replica scans the same rows. And `index.ts:3748` / `:3914` discard the `stop()` handles, so a shutdown can land mid-batch.

**Files:**
- Modify: `server/src/billing/reconcile.ts` (keyset paging for the four unbounded reads)
- Modify: `server/src/billing/maintenance.ts`, `server/src/billing/payments/maintenance.ts` (advisory-lock guarded pass)
- Modify: `server/src/index.ts:3748`, `:3914`, `:5481-5490` (keep the handles, stop them on signal)
- Test: `server/tests/billing-reconcile.integration.test.ts`, `server/tests/billing-usage-delivery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // reconcile.ts — a module-level constant, referenced by name in the report so a reader can tell
  // a complete scan from a truncated one.
  const RECONCILE_PAGE_SIZE = 500;
  // maintenance.ts + payments/maintenance.ts
  export type SweepLock = {
    /** True when this process holds the advisory lock for one pass. */
    tryAcquire(): Promise<boolean>;
    release(): Promise<void>;
  };
  export const NO_LOCK: SweepLock;
  export function createPostgresSweepLock(
    database: { execute(query: unknown): Promise<unknown> },
    key: number,
  ): SweepLock;
  ```

- [ ] **Step 1: Write the failing paging test**

Append to `server/tests/billing-reconcile.integration.test.ts`:

```ts
test("a table larger than one page still audits every row", async () => {
  const customer = `${prefix}-paged`;
  const ROWS = 1200; // > RECONCILE_PAGE_SIZE (500), so the keyset loop must walk three pages
  await database
    .insert(billingCustomers)
    .values({ externalId: customer, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  // Seeded server-side in one round trip, the way this file's precision suite does it: a
  // client-side row-by-row loop would turn a paging test into a load test.
  await database.execute(sql`
    INSERT INTO credit_ledger
      (id, external_customer_id, title, idempotency_key, credits, applied)
    SELECT
      ${customer} || '-l-' || g::text, ${customer}, 'paging-audit',
      ${customer} || '-lk-' || g::text, 1, 1
    FROM generate_series(1, ${ROWS}) g
  `);
  await database.insert(creditGrants).values({
    id: `${customer}-g1`,
    externalCustomerId: customer,
    source: "promo",
    reason: "paging-audit",
    total: ROWS,
    // One unit short of the ledger's sum: the divergence is exactly 1, which is only detectable
    // if the LAST page was read.
    used: ROWS - 1,
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    status: "active",
    idempotencyKey: `${customer}-gk1`,
  });

  const report = await reconciler.reconcile();

  const finding = report.findings.find(
    (item) =>
      item.code === "grants_ledger_divergence" && item.subject === customer,
  );
  expect(finding?.detail).toContain("off by 1");
  expect(report.checked.scanned.pageSize).toBe(500);
});
```

- [ ] **Step 2: Run it (it may already pass) and then make the paging explicit**

Run: `TEST_DATABASE_URL=… bun test server/tests/billing-reconcile.integration.test.ts`
This test asserts the *outcome* (no row silently skipped). It passes today because the reads are unbounded; after the paging change it must still pass — that is the point of writing it first.

Replace each unbounded read with a keyset loop, using the module-level `RECONCILE_PAGE_SIZE` (500) as `PAGE_SIZE`. For `paidOrders`:

```ts
      const PAGE_SIZE = RECONCILE_PAGE_SIZE;
      const paidOrders: PaidOrderRow[] = [];
      for (;;) {
        const lastId = paidOrders.at(-1)?.id ?? "";
        const page = await database
          .select({
            id: paymentOrders.id,
            planCode: paymentOrders.planCode,
            amountCents: paymentOrders.amountCents,
            channelTransactionId: paymentOrders.channelTransactionId,
            activationState: paymentOrders.activationState,
            paidAt: paymentOrders.paidAt,
            terminalAt: paymentOrders.terminalAt,
          })
          .from(paymentOrders)
          .where(
            and(
              eq(paymentOrders.status, "paid"),
              sql`${paymentOrders.id} > ${lastId}`,
            ),
          )
          .orderBy(asc(paymentOrders.id))
          .limit(PAGE_SIZE);
        paidOrders.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
```

with `type PaidOrderRow = Awaited<ReturnType<typeof database.select>>[number]` avoided in favour of an explicit local type so the four loops stay readable:

```ts
      type PaidOrderRow = {
        id: string;
        planCode: string;
        amountCents: number;
        channelTransactionId: string | null;
        activationState: PaymentOrderRecord["activationState"];
        paidAt: Date | null;
        terminalAt: Date | null;
      };
```

Apply the same shape to `paidFacts` (keyset on `paymentEvents.id`), `duplicateAnomalies` (keyset on `paymentEvents.id`, filtered), and `reservedRows` (keyset on `creditReservations.id`, keeping the existing `orderBy(reservationId, allocationId)` by paging on the reservation id and re-sorting each page's allocations in memory). The two `SUM(...)::bigint` aggregate reads need no paging — they are already single-row exact reads.

Add a `checked` counter so a reader can see the scan was complete, and widen `ReconcileReport["checked"]` in `server/src/billing/types.ts` to match (the admin route returns the report verbatim, so the new member is additive and backward-readable):

```ts
          scanned: {
            paidOrders: paidOrders.length,
            paidFacts: paidFacts.length,
            reservedRows: reservedRows.length,
            pageSize: PAGE_SIZE,
          },
```

```ts
// types.ts, inside ReconcileReport["checked"]
  /** How many rows the pass walked, and the page size it walked them in (audit C3). */
  scanned: {
    paidOrders: number;
    paidFacts: number;
    reservedRows: number;
    pageSize: number;
  };
```

- [ ] **Step 3: Write the failing sweep-lock test**

Append to `server/tests/billing-usage-delivery.test.ts`:

```ts
describe("a sweep pass is single-instance (audit C3)", () => {
  test("a pass is skipped when the advisory lock is held elsewhere", async () => {
    let passes = 0;
    const delivery = { runBatch: async () => { passes += 1; return { examined: 0, delivered: 0, failed: 0 }; } };
    const lock = { tryAcquire: async () => false, release: async () => {} };
    const sweeps = startUsageDeliverySweeps(delivery, {
      firstRunMs: 0, intervalMs: 5, lock,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sweeps.stop();
    expect(passes).toBe(0);
  });

  test("a pass that holds the lock releases it, and a throwing pass still releases it", async () => {
    const released: number[] = [];
    let attempt = 0;
    const lock = {
      tryAcquire: async () => true,
      release: async () => { released.push(attempt); },
    };
    const delivery = {
      runBatch: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
        return { examined: 0, delivered: 0, failed: 0 };
      },
    };
    const sweeps = startUsageDeliverySweeps(delivery, { firstRunMs: 0, intervalMs: 5, lock });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sweeps.stop();
    expect(released.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Run, verify failure, implement the lock**

Run: `cd server && bun test tests/billing-usage-delivery.test.ts`
Expected: FAIL — `startUsageDeliverySweeps` takes no `lock`.

`server/src/billing/maintenance.ts`:

```ts
/**
 * One pass at a time, across replicas (audit C3). Every replica runs the same interval, and
 * although both delivery targets are idempotent, N replicas means N times the provider calls and
 * N times the row contention for the same work. A Postgres session-level advisory lock is the
 * cheapest single-instance guard this deployment already has a database for; a replica that does
 * not get it skips the pass and tries again on its next tick.
 */
export type SweepLock = {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
};

/** Always-true lock for a single-replica deployment and for tests that do not care. */
export const NO_LOCK: SweepLock = {
  tryAcquire: async () => true,
  release: async () => {},
};

export function createPostgresSweepLock(
  database: { execute(query: unknown): Promise<unknown> },
  key: number,
): SweepLock {
  let held = false;
  return {
    async tryAcquire() {
      if (held) return true;
      const result = await database.execute(
        sql`select pg_try_advisory_lock(${key}) as acquired`,
      );
      const rows = Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] }).rows ?? []);
      held = (rows[0] as { acquired?: boolean } | undefined)?.acquired === true;
      return held;
    },
    async release() {
      if (!held) return;
      held = false;
      await database.execute(sql`select pg_advisory_unlock(${key})`);
    },
  };
}
```

and wrap the pass:

```ts
  const run = () => {
    if (running) return;
    running = true;
    void (async () => {
      if (!(await lock.tryAcquire())) return;
      try {
        await delivery.runBatch(limit);
      } catch (error) {
        log(`billing: usage delivery pass failed error=${error instanceof Error ? error.name : "unknown"}`);
      } finally {
        await lock.release().catch(() => {});
      }
    })().finally(() => { running = false; });
  };
```

with `options.lock?: SweepLock` defaulting to `NO_LOCK`. Mirror the whole shape in `payments/maintenance.ts` (`startPaymentSweeps` gains the same `lock` option around its two sweep calls) — keep the two files' lock handling textually identical so they cannot drift.

Lock keys: `7401` for usage delivery, `7402` for payments. Both are arbitrary and must be documented as reserved in the two files' headers.

- [ ] **Step 5: Wire the locks and the stop handles**

`server/src/index.ts`:

```ts
import { createPostgresSweepLock, startUsageDeliverySweeps } from "./billing/maintenance";
```
```ts
  const usageSweeps = startUsageDeliverySweeps(usageDelivery, {
    log: (message) => log.warn(message),
    lock: createPostgresSweepLock(database, 7401),
  });
  billingSweepStops.push(usageSweeps.stop);
```
```ts
        const paymentSweeps = startPaymentSweeps(paymentService, {
          lock: createPostgresSweepLock(database, 7402),
        });
        billingSweepStops.push(paymentSweeps.stop);
```

Declare `const billingSweepStops: (() => void)[] = [];` beside the billing assembly, and in the existing signal handler (`index.ts:5481-5490`) stop them before the server closes:

```ts
  process.on(signal, () => {
    for (const stop of billingSweepStops) {
      try { stop(); } catch { /* a stop that throws must not block the rest of the shutdown */ }
    }
    // …the existing shutdown body…
  });
```

- [ ] **Step 6: Run, typecheck, commit**

Run:
```bash
cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck
cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-usage-delivery.test.ts server/tests/payment-service.test.ts
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-reconcile.integration.test.ts
```
Expected: exit 0, green.

```bash
git add server/src/billing/reconcile.ts server/src/billing/maintenance.ts server/src/billing/payments/maintenance.ts server/src/billing/types.ts server/src/index.ts server/tests
git commit -m "fix(billing): page reconciliation, single-instance sweeps, stop them on shutdown (audit C3)"
```

---

## Verification before completion

The whole plan is done only when all of this is true, run in this order, with the output pasted into the completion report (evidence over claims):

1. `cd /Users/wuyongjun/trea/OpenBot/server && bun run typecheck` → exit 0.
2. `cd /Users/wuyongjun/trea/OpenBot && bun test server/tests/billing-*.test.ts server/tests/payment-*.test.ts server/tests/qa-batch*.test.ts server/tests/copilot-usage-meter.test.ts server/tests/workshop-metering.test.ts` → 0 fail, and the pass count is **≥ 471 + the tests this plan added** (name the new count).
3. `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_test bun test server/tests/billing-*.integration.test.ts server/tests/payment-*.integration.test.ts server/tests/qa-batch*.integration.test.ts` → 0 fail. If no dedicated test database exists, say so explicitly in the report rather than skipping silently.
4. `cd /Users/wuyongjun/trea/OpenBot/app && bun test tests/billing-*.test.ts tests/billing-*.test.tsx` → 0 fail.
5. `cd /Users/wuyongjun/trea/OpenBot && bunx biome check server/src/billing server/src/copilot.ts app/src/lib/billing app/src/components/billing` → clean (or only pre-existing findings, listed).
6. Manual, against a sandbox Lago + Alipay sandbox: buy a plan, confirm the grant lands with the catalog amount, spend credits on one model call, and verify (a) the summary's `remaining` drops by the hold during the call and by the settled cost after it, (b) `usage_outbox` shows `delivered/delivered` for that event, (c) `POST /api/admin/billing/reconcile` returns zero findings.
7. Re-run the audit's own reproduction for A1 (the stub script in `2026-10-14-billing-code-audit.md` §A1) and confirm the expired grant no longer appears in `remaining`.
8. `git log --oneline` shows one commit per task, each naming its audit finding.

## Out of scope (tracked elsewhere)

- **G1** credit ownership (deployment vs user) — ADR-level; raises via `matt:domain-modeling`.
- **G2** Spec/ADR-0001 reconciliation — document decision; T3 Step 6 records the conflict inline until it is resolved.
- **G3** reservation sizing (worst-case vs typical-case holds) — policy decision; T4 makes the current floor diagnosable in the log.
- **G4** whether an over-bound finish should still tear down a completed answer — product decision; T3 preserves the current behavior and only adds the durable record.
- Webhook inbound rate limiting (no general limiter exists in this server today); A7's fix bounds the replay window and records evidence instead.
- Display-layer float division (audit D3: `app/src/lib/billing/format.ts` `money`/`credits`, `server/src/billing/credits.ts` `scaleDown`). Every use is presentation-only and none feeds a comparison, so this plan leaves the arithmetic alone; T1 and T14 keep it that way by never routing a scaled-down number back into a decision.
- Adding Lago's `pending` subscription status to the projection vocabulary (needs a `billing_subscriptions_status_check` migration and a `BillingSubscriptionStatus` widening) — documented as a known gap in T11 Step 5. **Escalated 2026-10-15 after T11's fix round:** the early fold makes this gap slightly sharper, because a provider list that omits a `pending` subscription is now empty for a single-subscription customer, and an empty list retires. Judged acceptable and left to a follow-up decision: Lago's own lifecycle reports `canceled`/`terminated` (both requested), so the ordinary cancellation path upserts correctly without needing retirement at all; the ambiguous case is only a record that vanishes from the list entirely. Retiring on that signal catches a real revenue leak, while refusing to would risk nothing new — the same `pending` invisibility already made `ensureSubscription` liable to create a duplicate subscription before this task existed. The trade is recorded here rather than re-litigated in code.
