import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { count, eq, like, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  createRecoveryAlerting,
  decideAlertTransition,
  maskAccountRef,
  type RecoveryAlertConfig,
  type RecoveryAlertEvent,
} from "../src/billing/recovery-alerting";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import { createDatabase } from "../src/db/client";
import { accessGrants, botServices, usageOutbox } from "../src/db/schema";
import {
  creditRecoveryAlerts,
  creditRecoveryItems,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #281 (08.6): the persistent-anomaly alert, on a real PostgreSQL
 * (TEST_DATABASE_URL — the dedicated test database, never the live one). The file name
 * follows the recovery family's `.integration` suffix (08.1/08.2/08.5); the ticket's
 * `recovery-alerting.test.ts` names the same suite — it cannot run without the database
 * its dedup anchors live in.
 *
 * WHAT THIS FILE PINS — the ticket's acceptance criteria, one scenario each:
 *
 * - an item past the RETRY threshold (08.4's failureCount, 08.5's still-unknown counter)
 *   or past the DWELL limit alerts (first), and a young low-failure item alerts on
 *   neither axis;
 * - the alert content is redacted: the owning account arrives masked only, the recent
 *   reason as its stable code — never the full account key, never another account's key,
 *   never anything credential-shaped;
 * - re-crossings inside the repeat interval are DEDUPLICATED (no notification, no row
 *   movement) — including across a "restart" (a fresh alerting instance over the same
 *   database: the dedup anchor is the row, not memory) — and long-unhandled items
 *   ESCALATE exactly once, then never fire again;
 * - alerting changes NO ledger state: through the whole ladder the reservation stays
 *   unknown-occupied, the item row is byte-identical, and neither the ledger nor the
 *   usage outbox gains a row.
 *
 * The clock is the suite's own (`clockMs`), which is what makes 阈值/去重/升级 readable
 * as time arithmetic instead of sleeps.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const scanner = createRecoveryScanner({ database });
const prefix = `b8-281-${randomUUID().slice(0, 8)}`;

const GRANT_TOTAL = 10_000_00; // 10_000 credits, ×100

const CONFIG: RecoveryAlertConfig = {
  failureThreshold: 3,
  dwellLimitMs: 6 * 60 * 60 * 1000,
  repeatIntervalMs: 60 * 60 * 1000,
  escalationAfterMs: 24 * 60 * 60 * 1000,
};

type World = {
  userId: string;
  botId: string;
  grantId: string;
  customerKey: string;
};

let seedCounter = 0;

/** A customer with one live grant and nothing else (the recovery family's seeding shape). */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const customerKey = `openbot-personal-${userId}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Recovery Alert Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:ext:${n}`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });
  await writer.grantCredits({
    externalCustomerId: customerKey,
    source: "plan",
    totalCents: GRANT_TOTAL,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-grant-${n}`,
  });
  return { userId, botId, grantId, customerKey };
}

/** One unknown hold over the world's account, named by the scan — the alerting input. */
async function seedUnknownItem(world: World, options?: { failures?: number }) {
  const reserved = await writer.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-idem-${randomUUID().slice(0, 8)}`,
    maximumCents: 5_00,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!reserved.reserved) {
    throw new Error(`fixture reserve refused: ${JSON.stringify(reserved)}`);
  }
  await writer.markReservationUnknown(
    reserved.reservationId,
    "dispatch_result_unknown",
  );
  await scanner.scanOnce();
  const [item] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.reservationId, reserved.reservationId))
    .limit(1);
  if (!item) {
    throw new Error("fixture scan did not name the unknown hold");
  }
  scenarioItems.push(item.id);
  if (options?.failures) {
    // 08.4's counter, set the way its retry pass would leave it; the column is the
    // contract this module consumes, so the fixture writes it directly.
    await database
      .update(creditRecoveryItems)
      .set({ failureCount: options.failures })
      .where(eq(creditRecoveryItems.id, item.id));
  }
  return {
    reservationId: reserved.reservationId,
    itemId: item.id,
    attemptId: item.attemptId,
  };
}

/** The alerting stack under test: a scripted clock and a recording sink. */
function alertingWithClock(startMs: number) {
  let clockMs = startMs;
  const events: RecoveryAlertEvent[] = [];
  const alerting = createRecoveryAlerting({
    database,
    config: CONFIG,
    now: () => new Date(clockMs),
    sink: { name: "test-sink", emit: (event) => void events.push(event) },
    log: () => {},
  });
  return {
    alerting,
    events,
    advance: (ms: number) => {
      clockMs += ms;
    },
    set: (ms: number) => {
      clockMs = ms;
    },
    nowMs: () => clockMs,
  };
}

/*
 * SCENARIO ISOLATION. A pass evaluates the whole unresolved queue, so one scenario's
 * items must be invisible to the next scenario's passes — the family's park problem with
 * an alerting twist: alerting claims nothing, so parking (a claim) would not hide an
 * item from it; only `resolved` does. Each scenario's items are therefore finished
 * (claimed once, then resolved) in afterEach, failure or not: the ladder's rows survive
 * as the scenario's own evidence, and no later clock can re-fire them.
 */
const scenarioItems: string[] = [];
let finishCounter = 0;

async function finishItem(itemId: string): Promise<void> {
  const claimed = await scanner.claimRecoveryItem(
    itemId,
    `${prefix}-fin-${++finishCounter}`,
  );
  if (!claimed) {
    // Already claimed or resolved by the scenario itself: equally invisible.
    return;
  }
  await database
    .update(creditRecoveryItems)
    .set({ state: "resolved", updatedAt: new Date() })
    .where(eq(creditRecoveryItems.id, itemId));
}

afterEach(async () => {
  const pending = [...scenarioItems];
  scenarioItems.length = 0;
  for (const itemId of pending) {
    await finishItem(itemId);
  }
});

async function alertRow(itemId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryAlerts)
    .where(eq(creditRecoveryAlerts.itemId, itemId))
    .limit(1);
  return row ?? null;
}

async function itemRow(itemId: string) {
  const [row] = await database
    .select()
    .from(creditRecoveryItems)
    .where(eq(creditRecoveryItems.id, itemId))
    .limit(1);
  return row ?? null;
}

async function ledgerCount(customerKey: string): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
  return Number(row?.n ?? 0);
}

async function outboxCount(reservationId: string): Promise<number> {
  const [row] = await database
    .select({ n: count() })
    .from(usageOutbox)
    .where(eq(usageOutbox.reservationId, reservationId));
  return Number(row?.n ?? 0);
}

afterAll(async () => {
  // The cascade does the work: items take their alert rows, reservations take their
  // allocations; the rest is this suite's own rows, deleted by prefix (the family's
  // teardown, including the inside-the-key prefix match the family documents).
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `%${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}-%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}-%`));
});

test("a young item with few failures alerts on neither axis", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world, { failures: 1 });
  const stack = alertingWithClock(Date.now());

  const batch = await stack.alerting.evaluateAlerts();

  expect(batch.evaluated).toBeGreaterThanOrEqual(1);
  expect(batch.first).toBe(0);
  expect(stack.events).toHaveLength(0);
  expect(await alertRow(itemId)).toBeNull();
});

test("crossing the retry threshold alerts once, with the failure trigger", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world, {
    failures: CONFIG.failureThreshold,
  });
  const stack = alertingWithClock(Date.now());

  const batch = await stack.alerting.evaluateAlerts();

  expect(batch.first).toBe(1);
  expect(stack.events).toHaveLength(1);
  const row = await alertRow(itemId);
  expect(row?.level).toBe("first");
  expect(row?.lastTrigger).toBe("failure_threshold");
  expect(stack.events[0]?.level).toBe("first");
  expect(stack.events[0]?.trigger).toBe("failure_threshold");
});

test("dwelling past the limit alerts even with no failures, with the dwell trigger", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world, { failures: 0 });
  const stack = alertingWithClock(Date.now() + CONFIG.dwellLimitMs + 1000);

  const batch = await stack.alerting.evaluateAlerts();

  expect(batch.first).toBe(1);
  const row = await alertRow(itemId);
  expect(row?.lastTrigger).toBe("dwell_limit");
  expect(stack.events[0]?.trigger).toBe("dwell_limit");
});

test("re-crossings inside the repeat interval are deduplicated — across a restart too", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world, {
    failures: CONFIG.failureThreshold,
  });
  const first = alertingWithClock(Date.now());

  await first.alerting.evaluateAlerts();
  expect(first.events).toHaveLength(1);

  // Same clock, same process: nothing new.
  const again = await first.alerting.evaluateAlerts();
  expect(again.first).toBe(0);
  expect(again.deduplicated).toBeGreaterThanOrEqual(1);
  expect(first.events).toHaveLength(1);

  // A "restart": a fresh instance over the same database — the row is the anchor, memory
  // is nothing. Still nothing new.
  const restarted = alertingWithClock(first.nowMs());
  const afterRestart = await restarted.alerting.evaluateAlerts();
  expect(afterRestart.first).toBe(0);
  expect(restarted.events).toHaveLength(0);
  const row = await alertRow(itemId);
  expect(row?.alertCount).toBe(1);
});

test("still unresolved past the repeat interval repeats, then escalates exactly once, then goes quiet", async () => {
  const world = await seedWorld();
  const { itemId } = await seedUnknownItem(world, {
    failures: CONFIG.failureThreshold,
  });
  const stack = alertingWithClock(Date.now());

  await stack.alerting.evaluateAlerts(); // first
  const firstRow = await alertRow(itemId);
  expect(firstRow?.level).toBe("first");

  // Inside the escalation window but past the repeat interval: a repeat.
  stack.advance(CONFIG.repeatIntervalMs + 1000);
  await stack.alerting.evaluateAlerts();
  let row = await alertRow(itemId);
  expect(row?.level).toBe("repeat");
  expect(row?.alertCount).toBe(2);
  expect(row?.escalatedAt).toBeNull();

  // Escalation is measured from the FIRST alert: 24h + a little past it.
  stack.advance(
    CONFIG.escalationAfterMs - CONFIG.repeatIntervalMs - 1000 + 2000,
  );
  const escalated = await stack.alerting.evaluateAlerts();
  expect(escalated.escalated).toBeGreaterThanOrEqual(1);
  row = await alertRow(itemId);
  expect(row?.level).toBe("escalated");
  expect(row?.escalatedAt).not.toBeNull();

  // The terminal level never re-fires, however long the silence.
  stack.advance(10 * CONFIG.escalationAfterMs);
  const quiet = await stack.alerting.evaluateAlerts();
  expect(quiet.escalated).toBe(0);
  expect(quiet.suppressed).toBeGreaterThanOrEqual(1);
  const finalRow = await alertRow(itemId);
  expect(finalRow?.alertCount).toBe(3);

  const levels = stack.events.map((event) => event.level);
  expect(levels).toEqual(["first", "repeat", "escalated"]);
});

test("the alert content is redacted: masked account, stable reason, nothing else's data", async () => {
  const jia = await seedWorld();
  const yi = await seedWorld();
  await seedUnknownItem(jia, { failures: CONFIG.failureThreshold });
  await seedUnknownItem(yi, { failures: 0 });
  const stack = alertingWithClock(Date.now());

  const batch = await stack.alerting.evaluateAlerts();
  expect(batch.first).toBe(1); // only jia's item crossed a threshold

  const wire = JSON.stringify(stack.events);
  // The owning account key itself never appears — only its masked form.
  expect(wire).not.toContain(jia.customerKey);
  // The other account's key never appears (it has no business in jia's alert).
  expect(wire).not.toContain(yi.customerKey);
  expect(wire).toContain(maskAccountRef(jia.customerKey));
  // Nothing credential-shaped rides along.
  expect(wire).not.toContain("Bearer");
  expect(wire).not.toContain("sk-");
  // The recent reason is the stable code the item carries, not answer prose.
  expect(stack.events[0]?.reasonCode).toBe("dispatch_result_unknown");
  // The disposal facts are present: ceiling, dwell, failures.
  expect(stack.events[0]?.maximumCredits).toBe(5_00);
  expect(stack.events[0]?.dwellMilliseconds).toBeGreaterThanOrEqual(0);
  expect(stack.events[0]?.failureCount).toBe(CONFIG.failureThreshold);

  // The ROW keeps the same discipline (08.8 will read it).
  const [anyRow] = await database
    .select()
    .from(creditRecoveryAlerts)
    .where(
      eq(
        creditRecoveryAlerts.itemId,
        sql`(select id from ${creditRecoveryItems} where ${creditRecoveryItems.externalCustomerId} = ${jia.customerKey} limit 1)`,
      ),
    )
    .limit(1);
  expect(anyRow?.accountMasked).toBe(maskAccountRef(jia.customerKey));
  expect(anyRow?.accountMasked).not.toBe(jia.customerKey);
});

test("alerting changes no ledger state: reservation, item, ledger and outbox are untouched", async () => {
  const world = await seedWorld();
  const { reservationId, itemId } = await seedUnknownItem(world, {
    failures: CONFIG.failureThreshold,
  });
  const stack = alertingWithClock(Date.now());

  const reservationBefore = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  const itemBefore = await itemRow(itemId);
  const ledgerBefore = await ledgerCount(world.customerKey);
  const outboxBefore = await outboxCount(reservationId);

  // Drive the whole ladder — first, repeat, escalation.
  await stack.alerting.evaluateAlerts();
  stack.advance(CONFIG.repeatIntervalMs + 1000);
  await stack.alerting.evaluateAlerts();
  stack.advance(CONFIG.escalationAfterMs);
  await stack.alerting.evaluateAlerts();
  stack.advance(CONFIG.repeatIntervalMs);
  await stack.alerting.evaluateAlerts();

  const reservationAfter = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  const itemAfter = await itemRow(itemId);
  const ledgerAfter = await ledgerCount(world.customerKey);
  const outboxAfter = await outboxCount(reservationId);

  // The hold is byte-identical — unknown-occupied, released nothing, terminal never
  // written (Q12: only recovery's evidenced disposal, 08.9, moves it).
  expect(reservationAfter).toEqual(reservationBefore);
  expect(reservationAfter[0]?.status).toBe("unknown");
  expect(reservationAfter[0]?.released).toBeNull();
  expect(reservationAfter[0]?.terminalAt).toBeNull();
  // The item row is byte-identical: alerting does not even bump its own bookkeeping there.
  expect(itemAfter).toEqual(itemBefore);
  expect(ledgerAfter).toBe(ledgerBefore);
  expect(outboxAfter).toBe(outboxBefore);
});

test("the ladder itself is a pure function over the facts (clock arithmetic, no sleeps)", () => {
  const detectedAt = new Date(0);
  const young = { failureCount: 0, detectedAt };
  const failing = { failureCount: CONFIG.failureThreshold, detectedAt };
  const now = (ms: number) => new Date(ms);

  expect(decideAlertTransition(young, null, CONFIG, now(1000)).action).toBe(
    "none",
  );
  expect(decideAlertTransition(failing, null, CONFIG, now(1000))).toEqual({
    action: "first",
    trigger: "failure_threshold",
  });
  expect(
    decideAlertTransition(young, null, CONFIG, now(CONFIG.dwellLimitMs)),
  ).toEqual({ action: "first", trigger: "dwell_limit" });

  const ladder = {
    level: "first" as const,
    firstAlertedAt: new Date(1000),
    lastAlertedAt: new Date(1000),
  };
  expect(
    decideAlertTransition(
      failing,
      ladder,
      CONFIG,
      now(1000 + CONFIG.repeatIntervalMs - 1),
    ).action,
  ).toBe("deduplicated");
  expect(
    decideAlertTransition(
      failing,
      ladder,
      CONFIG,
      now(1000 + CONFIG.repeatIntervalMs),
    ).action,
  ).toBe("repeat");
  expect(
    decideAlertTransition(
      failing,
      ladder,
      CONFIG,
      now(1000 + CONFIG.escalationAfterMs),
    ).action,
  ).toBe("escalate");
  const escalated = {
    level: "escalated" as const,
    firstAlertedAt: new Date(1000),
    lastAlertedAt: new Date(2000),
  };
  expect(
    decideAlertTransition(
      failing,
      escalated,
      CONFIG,
      now(10 * CONFIG.escalationAfterMs),
    ).action,
  ).toBe("suppressed");
});

test("a non-positive threshold refuses to build the pass (misconfiguration is loud)", () => {
  expect(() =>
    createRecoveryAlerting({
      database,
      config: { failureThreshold: 0 },
      log: () => {},
    }),
  ).toThrow(TypeError);
});
