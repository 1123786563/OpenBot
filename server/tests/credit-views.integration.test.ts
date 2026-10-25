import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  type CreditReserveRequest,
  createCreditReserveService,
} from "../src/billing/credit-reserve";
import { createCreditSettleService } from "../src/billing/credit-settle";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { createBillingCreditRoutes } from "../src/billing/routes";
import { createDatabase, type Database } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import {
  creditReservationAttribution,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { GATEWAY_PRICE_SNAPSHOT_SOURCE } from "../src/gateway/price-snapshot";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #263 (06.12): the reservation/pending-settlement/actual-charge USER VIEW, on the
 * dedicated PostgreSQL verify database (TEST_DATABASE_URL, never a live one).
 *
 * WHAT THE USER SEES. After this ticket the personal balance read answers four reconcilable
 * numbers — available, pending (reserved + unknown), consumed, expired — plus EVERY
 * reservation's status and reason, and the consumption ledger attributes each row to the Bot
 * and model that produced it. The three-phase lifecycle is the spine:
 *
 *   reserve  → pending rises, available falls by the same hold;
 *   settle   → pending converts to consumed, the amount equal to the ledger row;
 *   release  → pending falls away and (while nothing has expired) available is whole again.
 *
 * The views read the SAME facts the admission gate admits against (capacity.ts's occupying
 * set), so the page can never disagree with the gate: an unexpired `reserved` hold and every
 * `unknown` hold are pending (an unknown one no matter how far the clock runs past its
 * expiry, Q12), a lapsed plain hold is `expired`, and a settled hold's `charged` is what the
 * ledger wrote.
 *
 * Fixtures drive the REAL protocol paths (06.2 reserve, 06.9 settle) so attribution and view
 * are measured against what production writes — the fixture writer only marks unknown states
 * and releases, which are recovery-side actions with no user-facing door in this slice.
 * Isolation mirrors #260: unique per-world prefixes (price snapshots and rate versions are
 * append-only), credit-side rows deleted by the DERIVED account-key prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-263-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds grants, marks unknown, releases (recovery-side actions). */
const fixtureWriter = createCreditWriter(database);

/** The deployment's environment rate: version 0, 100 credits per USD. */
const ENVIRONMENT_RATE: ConversionRate = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});
const settleService = createCreditSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});

/** Version 1 prices: every dimension priced and known; input drives all the arithmetic. */
const V1_AMOUNTS = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
} as const;

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

let seedCounter = 0;

type SeededWorld = {
  userId: string;
  grantId: string;
  botId: string;
  botName: string;
  provider: string;
  model: string;
  customerKey: string;
  actor: AuthenticatedActor;
  request: CreditReserveRequest;
};

/** One world: registered Bot, active grant, funded personal payer, open priced model cell. */
async function seedWorld(planCents = 10_000): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const botName = `Credit-views Bot ${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: botName,
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
  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  await fixtureWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: planCents,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "chat",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  const snapshotStore = (
    await import("../src/gateway/price-snapshot")
  ).createEnterpriseGatewayPriceSnapshotStore(database);
  await snapshotStore.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: dimsOf(V1_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: 0,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "credit-views fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date() },
    });

  return {
    userId,
    grantId,
    botId,
    botName,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    actor: { id: userId, email: `${userId}@openbot.test`, role: "user" },
    request: {
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [
        { kind: "provider_max_tokens", maximumTokens: 1_500_000 },
        { kind: "self_enforced_input_truncation", maximumTokens: 3_000_000 },
      ],
      maximumCredits: 3_000, // 30.00 credits: the AC-1/AC-2 hold.
      idempotencyKey: `${prefix}-idem-${n}`,
    } satisfies CreditReserveRequest,
  };
}

/** All twelve dimensions, everything but the named ones zero. */
function usageOf(named: Record<string, number>): Record<string, number> {
  const usage: Record<string, number> = {
    input: 0,
    output: 0,
    reasoning: 0,
    image: 0,
    image_output: 0,
    audio_input: 0,
    audio_output: 0,
    cache_read: 0,
    cache_write: 0,
    video: 0,
    video_input: 0,
    surcharge_web_search: 0,
    surcharge_per_request: 0,
    surcharge_tool_call: 0,
    surcharge_a2a_call: 0,
  };
  for (const [dimension, quantity] of Object.entries(named)) {
    usage[dimension] = quantity;
  }
  return usage;
}

function settleRequestOf(reservationId: string, usage: Record<string, number>) {
  return {
    reservationId,
    actualUsage: usageOf(usage),
    evidence: {
      kind: "provider_usage_report",
      reference: `${prefix}-usage-${randomUUID().slice(0, 8)}`,
    },
    settledBy: `${prefix}-bifrost-admission`,
    idempotencyKey: `${prefix}-settle-${randomUUID().slice(0, 8)}`,
  };
}

async function reserveOrFail(world: SeededWorld): Promise<string> {
  const outcome = await reserveService.reserve(world.request);
  if (outcome.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.reservationId;
}

/** A second, independent hold in the same world (own idempotency key and ceiling). */
async function reserveAnother(
  world: SeededWorld,
  maximumCredits: number,
  expiresAt?: Date,
): Promise<string> {
  const outcome = await reserveService.reserve({
    ...world.request,
    maximumCredits,
    ...(expiresAt ? { expiresAt } : {}),
    idempotencyKey: `${world.request.idempotencyKey}-x-${++seedCounter}-${randomUUID().slice(0, 6)}`,
  });
  if (outcome.status !== "reserved") {
    throw new Error(`fixture reserve refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.reservationId;
}

// ── The user view under test: the session's own account, through the billing routes ──

type ReservationView = {
  id: string;
  status: string;
  maximum: number;
  charged: number | null;
  released: number | null;
  provider: string | null;
  model: string | null;
  capability: string | null;
  botId: string | null;
  botName: string | null;
  unknownReason: string | null;
  releaseReason: string | null;
  createdAt: string;
  expiresAt: string;
  terminalAt: string | null;
};

type SummaryResponse = {
  accountType: string;
  available: number;
  consumed: number;
  expired: number;
  held: number;
  pendingSettlement: {
    enabled: boolean;
    available: number;
    consumed: number;
    expired: number;
    reserved: number;
    unknown: number;
    reservations: ReservationView[];
  };
};

type ConsumptionResponse = {
  entries: {
    id: string;
    title: string;
    credits: number;
    applied: number;
    model: string | null;
    client: string | null;
    botId: string | null;
    botName: string | null;
    timestamp: string;
  }[];
  pagination: { totalCount: number; totalPages: number; currentPage: number };
};

/** The session guard as a switch: the given actor, or nobody. */
function requireUserAs(actor: AuthenticatedActor | undefined) {
  const middleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
  return middleware;
}

function app(actor: AuthenticatedActor) {
  const credits = createCredits({
    database,
    externalCustomerKey: `openbot-deployment-${prefix}`,
    catalog: new Map(),
  });
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/billing",
    createBillingCreditRoutes({ credits, requireUser: requireUserAs(actor) }),
  );
}

async function readSummary(world: SeededWorld): Promise<SummaryResponse> {
  const response = await app(world.actor).request(
    "/api/billing/credits/summary",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as SummaryResponse;
}

async function readConsumption(
  world: SeededWorld,
): Promise<ConsumptionResponse> {
  const response = await app(world.actor).request(
    "/api/billing/credits/consumption?page=1",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ConsumptionResponse;
}

afterAll(async () => {
  // Credit-side columns carry the DERIVED account key (`openbot-personal-<prefix>…`);
  // reservation attribution rows go with their reservations (FK cascade).
  await database
    .delete(creditReservations)
    .where(
      like(
        creditReservations.externalCustomerId,
        `openbot-personal-${prefix}%`,
      ),
    );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  // gateway_price_snapshots and gateway_rate_versions are append-only; per-world prefixes isolate.
  await database.$client.close();
});

// ── Replay safety: the attribution write is idempotent beside the replayed hold ──

test("a reserve replay answers the original reservation and writes exactly one attribution row", async () => {
  const world = await seedWorld();
  const first = await reserveService.reserve(world.request);
  if (first.status !== "reserved") throw new Error("fixture reserve refused");
  // The same idempotency key, the same message: the protocol's replay answer must stay
  // exactly the original reservation — the attribution write beside it cannot turn a replay
  // into an error (the row's primary key is the reservation id, so a naive insert would).
  const replay = await reserveService.reserve(world.request);
  expect(replay).toEqual(first);

  const attributionRows = await database
    .select()
    .from(creditReservationAttribution)
    .where(eq(creditReservationAttribution.reservationId, first.reservationId));
  expect(attributionRows).toHaveLength(1);
  expect(attributionRows[0]?.grantId).toBe(world.grantId);
  expect(attributionRows[0]?.botId).toBe(world.botId);
});

test("a replay against a terminal hold still conflicts and writes no attribution", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  await fixtureWriter.releaseReservation(reservationId, "no_charge_evidence");

  const replay = await reserveService.reserve(world.request);
  expect(replay.status).toBe("refused");
  if (replay.status === "refused") {
    expect(replay.reasonCode).toBe("reservation_conflict");
  }
  const attributionRows = await database
    .select()
    .from(creditReservationAttribution)
    .where(eq(creditReservationAttribution.reservationId, reservationId));
  expect(attributionRows).toHaveLength(1);
});

// ── AC-1: a reserved hold raises pending and lowers available by the same amount ──

test("after a reserve the user sees pending rise and available fall by the hold", async () => {
  const world = await seedWorld();
  const before = await readSummary(world);
  expect(before.accountType).toBe("personal");
  expect(before.available).toBeCloseTo(100, 2);
  expect(before.pendingSettlement.enabled).toBe(true);
  expect(before.pendingSettlement.available).toBeCloseTo(0, 2);

  await reserveOrFail(world);

  const after = await readSummary(world);
  expect(after.available).toBeCloseTo(70, 2);
  expect(after.held).toBeCloseTo(30, 2);
  expect(after.pendingSettlement.available).toBeCloseTo(30, 2);
  // reserved vs unknown, the split the page shows: this hold is a plain reserved one.
  expect(after.pendingSettlement.reserved).toBeCloseTo(30, 2);
  expect(after.pendingSettlement.unknown).toBeCloseTo(0, 2);
  expect(after.pendingSettlement.consumed).toBeCloseTo(0, 2);
  // The per-reservation list names the hold with its status and attribution.
  const entry = after.pendingSettlement.reservations.find(
    (row) => row.status === "reserved",
  );
  expect(entry).toBeDefined();
  expect(entry?.maximum).toBeCloseTo(30, 2);
  expect(entry?.model).toBe(world.model);
  expect(entry?.provider).toBe(world.provider);
  expect(entry?.capability).toBe("chat");
  expect(entry?.botId).toBe(world.botId);
  expect(entry?.botName).toBe(world.botName);
});

// ── AC-2: settlement converts pending to consumed, the amount equal to the ledger ──

test("after a settle pending converts to consumed and matches the ledger row", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);

  // 300 000 input tokens × $0.000001 = $0.30 → ×100 credits/USD = 30.00 credits
  // = the whole hold: charged 3 000 scaled, nothing released.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 300_000 }),
  );
  if (outcome.status !== "settled") {
    throw new Error(`fixture settle refused: ${JSON.stringify(outcome)}`);
  }
  expect(outcome.chargedCredits).toBe(3_000);

  const after = await readSummary(world);
  expect(after.pendingSettlement.available).toBeCloseTo(0, 2);
  expect(after.pendingSettlement.consumed).toBeCloseTo(30, 2);
  // consumed reconciles with the ledger: Σ charged over settled reservations == the
  // reservation-born ledger rows' credits.
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(sql`${creditLedger.externalCustomerId} = ${world.customerKey}`);
  const ledgerCharged = ledgerRows.reduce((sum, row) => sum + row.credits, 0);
  expect(after.pendingSettlement.consumed * 100).toBe(ledgerCharged);
  // The entry left the pending set and carries its settled facts.
  const entry = after.pendingSettlement.reservations.find(
    (row) => row.id === reservationId,
  );
  expect(entry?.status).toBe("settled");
  expect(entry?.charged).toBeCloseTo(30, 2);
  expect(entry?.terminalAt).not.toBeNull();
});

// ── AC-3: a release returns the amount to available (nothing expired) ──

test("after a release pending falls away and available is whole again", async () => {
  const world = await seedWorld();
  const reservationId = await reserveAnother(world, 2_000); // 20.00

  const held = await readSummary(world);
  expect(held.pendingSettlement.available).toBeCloseTo(20, 2);
  expect(held.available).toBeCloseTo(80, 2);

  await fixtureWriter.releaseReservation(reservationId, "no_charge_evidence");

  const after = await readSummary(world);
  expect(after.pendingSettlement.available).toBeCloseTo(0, 2);
  expect(after.available).toBeCloseTo(100, 2);
  const entry = after.pendingSettlement.reservations.find(
    (row) => row.id === reservationId,
  );
  expect(entry?.status).toBe("released");
  expect(entry?.releaseReason).toBe("no_charge_evidence");
  expect(entry?.terminalAt).not.toBeNull();
});

// ── Unknown holds: pending forever until recovery disposes them (Q12/AC15) ──

test("an unknown hold stays pending past its expiry and shows its reason; recovery settles it", async () => {
  const world = await seedWorld();
  // A hold whose expiry the clock runs past WHILE it is unknown.
  const reservationId = await reserveAnother(
    world,
    500, // 5.00
    new Date(Date.now() + 120),
  );
  await fixtureWriter.markReservationUnknown(reservationId, "usage_missing");
  await Bun.sleep(400); // expiresAt has passed

  const view = await readSummary(world);
  // The unknown hold occupies no matter the clock: pending, and only in the unknown bucket.
  expect(view.pendingSettlement.available).toBeCloseTo(5, 2);
  expect(view.pendingSettlement.unknown).toBeCloseTo(5, 2);
  expect(view.pendingSettlement.reserved).toBeCloseTo(0, 2);
  expect(view.pendingSettlement.expired).toBeCloseTo(0, 2);
  const entry = view.pendingSettlement.reservations.find(
    (row) => row.id === reservationId,
  );
  expect(entry?.status).toBe("unknown");
  expect(entry?.unknownReason).toBe("usage_missing");

  // Recovery's settlement (06.8): the same reservation id settles, and the view follows.
  const outcome = await settleService.settle(
    settleRequestOf(reservationId, { input: 25_000 }), // 2.50 credits
  );
  if (outcome.status !== "settled") {
    throw new Error(`recovery settle refused: ${JSON.stringify(outcome)}`);
  }
  const after = await readSummary(world);
  expect(after.pendingSettlement.available).toBeCloseTo(0, 2);
  expect(after.pendingSettlement.consumed).toBeCloseTo(2.5, 2);
  expect(
    after.pendingSettlement.reservations.find((row) => row.id === reservationId)
      ?.status,
  ).toBe("settled");
});

// ── A lapsed plain hold: no longer pending, visible as expired, available restored ──

test("a plain reserved hold past its expiry leaves pending, counts as expired, and frees capacity", async () => {
  const world = await seedWorld();
  await reserveAnother(world, 800, new Date(Date.now() + 120)); // 8.00
  await Bun.sleep(400);

  const view = await readSummary(world);
  expect(view.pendingSettlement.available).toBeCloseTo(0, 2);
  expect(view.pendingSettlement.expired).toBeCloseTo(8, 2);
  // Capacity is free again: the gate would admit against the full 100.00.
  expect(view.available).toBeCloseTo(100, 2);
});

// ── AC-4: consumption attribution — Bot and model, without anyone else's data ──

test("consumption entries attribute to the reserving Bot and model; non-protocol rows stay unattributed", async () => {
  const world = await seedWorld();
  // Protocol path: reserve → settle; the ledger row must carry the Bot and model.
  const reservationId = await reserveOrFail(world);
  await settleService.settle(
    settleRequestOf(reservationId, { input: 300_000 }),
  );
  // Writer-direct path (no protocol, no attribution): a legacy row with a model but no Bot.
  const direct = await fixtureWriter.reserveCredits({
    externalCustomerId: world.customerKey,
    idempotencyKey: `${prefix}-direct-${randomUUID().slice(0, 8)}`,
    maximumCents: 1_000,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  if (!direct.reserved) throw new Error("fixture direct reserve should fit");
  await fixtureWriter.settleReservation({
    reservationId: direct.reservationId,
    actual: { numerator: 1_000n, denominator: 1n },
    title: "direct call",
  });

  const page = await readConsumption(world);
  expect(page.entries).toHaveLength(2);
  const protocolRow = page.entries.find((row) => row.model === world.model);
  expect(protocolRow?.botId).toBe(world.botId);
  expect(protocolRow?.botName).toBe(world.botName);
  const directRow = page.entries.find((row) => row.model === null);
  expect(directRow?.title).toBe("direct call");
  expect(directRow?.botId).toBeNull();
  expect(directRow?.botName).toBeNull();
});

test("a stranger's session sees none of this account's reservations or consumption", async () => {
  const self = await seedWorld();
  const stranger = await seedWorld();
  await reserveOrFail(self); // self holds 30.00 pending and a reservation entry

  const strangerView = await readSummary(stranger);
  expect(strangerView.pendingSettlement.available).toBeCloseTo(0, 2);
  expect(strangerView.pendingSettlement.reservations).toHaveLength(0);
  expect(
    strangerView.pendingSettlement.reservations.some(
      (row) => row.botId === self.botId,
    ),
  ).toBe(false);

  const strangerPage = await readConsumption(stranger);
  expect(strangerPage.entries).toHaveLength(0);

  // And the stranger's own hold never lands in the self view either.
  await reserveOrFail(stranger);
  const selfView = await readSummary(self);
  expect(selfView.pendingSettlement.reserved).toBeCloseTo(30, 2);
  expect(selfView.pendingSettlement.available).toBeCloseTo(30, 2);
  expect(
    selfView.pendingSettlement.reservations.every(
      (row) => row.botId === self.botId,
    ),
  ).toBe(true);
});

// ── Shape and read-only discipline ──

test("an account with no activity answers enabled with true zeros and an empty list", async () => {
  const world = await seedWorld();
  const view = await readSummary(world);
  expect(view.pendingSettlement).toEqual({
    enabled: true,
    available: 0,
    consumed: 0,
    expired: 0,
    reserved: 0,
    unknown: 0,
    reservations: [],
  });
  // The top-level contract keys stay as 02.6 fixed them, plus BP07/#375's `account` — the
  // account-level capability status every personal view now answers with.
  const response = await app(world.actor).request(
    "/api/billing/credits/summary",
  );
  expect(Object.keys((await response.json()) as object).sort()).toEqual([
    "account",
    "accountType",
    "available",
    "consumed",
    "expired",
    "grants",
    "held",
    "pendingSettlement",
  ]);
});

test("the reservation list is bounded to the newest twenty and scoped to the account", async () => {
  const world = await seedWorld();
  for (let i = 0; i < 25; i += 1) {
    await reserveAnother(world, 100);
  }
  const view = await readSummary(world);
  expect(view.pendingSettlement.reservations).toHaveLength(20);
  // Newest first: the first entry is the account's latest reservation row.
  const latest = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(sql`${creditReservations.externalCustomerId} = ${world.customerKey}`)
    .orderBy(sql`${creditReservations.createdAt} desc`)
    .limit(1);
  expect(view.pendingSettlement.reservations[0]?.id).toBe(latest[0]?.id);
  // Every listed row is the account's own.
  const ownIds = new Set(
    (
      await database
        .select({ id: creditReservations.id })
        .from(creditReservations)
        .where(
          sql`${creditReservations.externalCustomerId} = ${world.customerKey}`,
        )
    ).map((row) => row.id),
  );
  expect(
    view.pendingSettlement.reservations.every((row) => ownIds.has(row.id)),
  ).toBe(true);
});

test("the extended reads stay read-only: no insert, update, delete or transaction on the view path", async () => {
  const world = await seedWorld();
  const reservationId = await reserveOrFail(world);
  await settleService.settle(settleRequestOf(reservationId, { input: 10_000 }));

  const writes: string[] = [];
  const counting: Database = new Proxy(database, {
    get(object, property) {
      if (
        property === "insert" ||
        property === "update" ||
        property === "delete"
      ) {
        return (...args: unknown[]) => {
          writes.push(property);
          return (object[property] as (...callArguments: unknown[]) => unknown)(
            ...args,
          );
        };
      }
      if (property === "transaction") {
        return (scope: unknown) => {
          writes.push("transaction");
          return object.transaction(
            scope as Parameters<Database["transaction"]>[0],
          );
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function"
        ? (value as (...callArguments: unknown[]) => unknown).bind(object)
        : value;
    },
  });
  const credits = createCredits({
    database: counting,
    externalCustomerKey: `openbot-deployment-${prefix}`,
    catalog: new Map(),
  });
  const viewApp = new Hono<{ Variables: AppVariables }>().route(
    "/api/billing",
    createBillingCreditRoutes({
      credits,
      requireUser: requireUserAs(world.actor),
    }),
  );
  expect((await viewApp.request("/api/billing/credits/summary")).status).toBe(
    200,
  );
  expect(
    (await viewApp.request("/api/billing/credits/consumption?page=1")).status,
  ).toBe(200);
  expect(writes).toEqual([]);
});

// ── Grant facts still visible (02.6 regression guard on the shared fixture path) ──

test("the summary still answers the grant life beside the new pending view", async () => {
  const world = await seedWorld();
  const view = await readSummary(world);
  expect(view.grants).toHaveLength(1);
  expect(view.grants[0]?.total).toBeCloseTo(100, 2);
  expect(view.grants[0]?.remaining).toBeCloseTo(100, 2);
  expect(view.consumed).toBeCloseTo(0, 2);
  expect(view.expired).toBeCloseTo(0, 2);
});
