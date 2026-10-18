import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  createCreditReserveService,
  creditProtocolEndpoints,
} from "../src/billing/credit-reserve";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import {
  STATUS_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  createReservationStatusService,
} from "../src/billing/reservation-status";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  billingCustomers,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #258 (06.7): reservation Status queries and same-id recovery, on a real PostgreSQL
 * (TEST_DATABASE_URL; the dedicated 5590 verify database, never the live one).
 *
 * The reserve response can be lost between the hold and the caller; recovery must answer the
 * ORIGINAL reservation — a replay with the same idempotency key never creates a second hold,
 * and the attempt id every response carries is stable across replays, so a Status query by
 * attemptId or reservationId can find it. A replay against a terminal (settled/released) hold
 * is a conflict, never a fresh reservation. The Status query itself is read-only — it changes
 * no state and writes nothing — and it never reveals another account's reservation: the query
 * is scoped by the grant the caller is working under, and the server resolves the account from
 * that grant alone, never from a self-reported key.
 *
 * Isolation: gateway tables are append-only or shared state, so every scenario names its own
 * unique provider/bot/user prefixes instead of cleaning up; the credit, grant and payer
 * fixtures are deleted by prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-258-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds grants and drives holds to terminal states for the scenarios. */
const fixtureCreditWriter = createCreditWriter(database);
const encryptionKey = randomUUID().replaceAll("-", "");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

const FRESH_WINDOW_MS = 15 * 60 * 1000;

const service = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
});
const statusService = createReservationStatusService({ database });

/** The protocol surface under test: the 06.1 guard with Reserve AND Status inside. */
const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({
    authenticate,
    auditStore,
    endpoints: creditProtocolEndpoints({ service, statusService }),
  }),
);

const PRICED_RAW_ENTRY = {
  id: "fix/model",
  pricing: {
    prompt: "0.000001",
    completion: "0.000002",
    internal_reasoning: "0.000003",
    image: "0.01",
    input_cache_read: "0.0000001",
    input_cache_write: "0.0000015",
    web_search: "0.001",
    request: "0",
  },
};

type SeededWorld = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  request: Record<string, unknown>;
};

let seedCounter = 0;

/**
 * One complete world where a reserve SHOULD succeed: an active grant, a registered and
 * active bot, a personal payer account with credits, an open cataloged ref whose latest
 * price snapshot is fully known, and a fresh catalog sync.
 */
async function seedWorld(): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Status Bot ${n}`,
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
  await fixtureCreditWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 10_000_00,
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
  const store = createEnterpriseGatewayPriceSnapshotStore(database);
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: mapPriceDims(PRICED_RAW_ENTRY),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "chat",
    state: "open",
    reason: "reservation-status fixture",
    changedBy: "test",
  });
  await database
    .insert(gatewayCatalogSyncState)
    .values({
      id: GATEWAY_CATALOG_SYNC_STATE_ID,
      lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000),
    })
    .onConflictDoUpdate({
      target: gatewayCatalogSyncState.id,
      set: { lastSuccessfulSyncAt: new Date(Date.now() - 60 * 1000) },
    });

  const request: Record<string, unknown> = {
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability: "chat" },
    snapshotVersion: 1,
    rateVersion: 0,
    boundEvidence: [
      { kind: "provider_max_tokens", maximumTokens: 4096 },
      { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
    ],
    maximumCredits: 500, // 5 credits, ×100
    idempotencyKey: `${prefix}-idem-${n}`,
  };
  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request,
  };
}

/** Every reservation row (all columns) for one world's derived account key. */
async function reservationRows(customerKey: string) {
  return database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
}

/**
 * The full state a status query must leave untouched: the reservation rows themselves plus
 * the row counts of every table a lookup could wrongly write (a customer floor, a ledger row).
 */
async function worldState(customerKeys: string[]) {
  const reservations = await Promise.all(customerKeys.map(reservationRows));
  const [customers] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(billingCustomers)
    .where(like(billingCustomers.externalId, `openbot-personal-${prefix}%`));
  const [accounts] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
  return {
    reservations,
    customerCount: customers.count,
    accountCount: accounts.count,
  };
}

async function postReserve(
  secret: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  const response = await protocolApp.request("/api/credit-protocol/reserve", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function postStatus(
  secret: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  const response = await protocolApp.request("/api/credit-protocol/status", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

afterAll(async () => {
  // Credit-side rows are keyed by the DERIVED account key (`openbot-personal-<prefix>…`).
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
  // gateway_price_snapshots is append-only in the database (0133); scenarios isolate
  // themselves with unique provider names instead.
  await database.$client.close();
});

// ── The credential, once, for every HTTP scenario below ────────────────────────────

let gatewaySecret: string | null = null;

test("the deployment's trusted credential is issued for the protocol surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

// ── Lost-response recovery: replay answers the original, identity included ─────────

test("a reserve replay after a lost response returns the original reservation and the same attempt id, never a second hold", async () => {
  const world = await seedWorld();
  const first = await postReserve(gatewaySecret, world.request);
  expect(first.status).toBe(201);
  const second = await postReserve(gatewaySecret, world.request);
  expect(second.status).toBe(201);
  // The lost response's facts are recovered EXACTLY: same reservation, same attempt id.
  expect(second.json.reservationId).toBe(first.json.reservationId);
  expect(second.json.attemptId).toBe(first.json.attemptId);
  expect(second.json.maximumCredits).toBe(world.request.maximumCredits);
  const rows = await reservationRows(world.customerKey);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("reserved");
});

// ── Status answers, by either id, and its read-only guarantee ──────────────────────

test("the status query answers a held reservation by reservationId and changes nothing", async () => {
  const world = await seedWorld();
  const reserve = await postReserve(gatewaySecret, world.request);
  expect(reserve.status).toBe(201);
  const reservationId = reserve.json.reservationId as string;

  const before = await worldState([world.customerKey]);
  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId,
  });
  const after = await worldState([world.customerKey]);
  // 只读: the query is answered from what was already there and leaves every row as it was.
  expect(after).toEqual(before);
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("reserved");
  if (answer.outcome.status === "unknown") return;
  expect(answer.outcome.reservationId).toBe(reservationId);
  expect(answer.outcome.attemptId).toBe(reserve.json.attemptId);
  expect(answer.outcome.maximumCredits).toBe(world.request.maximumCredits);
  // 06.5's locked-basis persistence is not integrated on this worktree: the versions are
  // carried as null until a locked basis is actually stored, never a fabricated number.
  expect(answer.outcome.snapshotVersion).toBeNull();
  expect(answer.outcome.rateVersion).toBeNull();
  expect(typeof answer.outcome.createdAt).toBe("string");
  expect(typeof answer.outcome.expiresAt).toBe("string");
  expect(answer.outcome.terminalAt).toBeNull();
});

test("the status query by attemptId answers the same reservation", async () => {
  const world = await seedWorld();
  const reserve = await postReserve(gatewaySecret, world.request);
  expect(reserve.status).toBe(201);
  const attemptId = reserve.json.attemptId as string;
  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    attemptId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("reserved");
  if (answer.outcome.status === "unknown") return;
  expect(answer.outcome.attemptId).toBe(attemptId);
  expect(answer.outcome.reservationId).toBe(reserve.json.reservationId);
});

test("the status endpoint answers through the guarded surface", async () => {
  const world = await seedWorld();
  const reserve = await postReserve(gatewaySecret, world.request);
  expect(reserve.status).toBe(201);
  const held = await postStatus(gatewaySecret, {
    grantId: world.grantId,
    reservationId: reserve.json.reservationId,
  });
  expect(held.status).toBe(200);
  expect(held.json.status).toBe("reserved");
  expect(held.json.reservationId).toBe(reserve.json.reservationId);

  const nothing = await postStatus(gatewaySecret, {
    grantId: world.grantId,
    reservationId: "cr-0000000000000000",
  });
  expect(nothing.status).toBe(200);
  expect(nothing.json).toEqual({ status: "unknown" });
});

// ── Terminal holds: replay conflicts, status answers the terminal state ────────────

test("a settled hold replays as a conflict and its status answers settled", async () => {
  const world = await seedWorld();
  const first = await service.reserve(world.request);
  expect(first.status).toBe("reserved");
  if (first.status !== "reserved") return;
  await fixtureCreditWriter.settleReservation({
    reservationId: first.reservationId,
    actual: { numerator: 123n, denominator: 4n },
    title: "status fixture settlement",
  });

  const rows = await reservationRows(world.customerKey);
  expect(rows).toHaveLength(1);
  // The replay of a SETTLED hold is a conflict, never a fresh reservation (06.3's writer
  // semantics, proven here end to end through the protocol service).
  const replay = await service.reserve(world.request);
  expect(replay.status).toBe("refused");
  if (replay.status !== "refused") return;
  expect(replay.reasonCode).toBe("reservation_conflict");
  expect(await reservationRows(world.customerKey)).toHaveLength(1);

  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId: first.reservationId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("settled");
  if (answer.outcome.status === "unknown") return;
  expect(answer.outcome.terminalAt).not.toBeNull();
});

test("a released hold replays as a conflict and its status answers released", async () => {
  const world = await seedWorld();
  const first = await service.reserve(world.request);
  expect(first.status).toBe("reserved");
  if (first.status !== "reserved") return;
  await fixtureCreditWriter.releaseReservation(
    first.reservationId,
    "status fixture release",
  );

  const replay = await service.reserve(world.request);
  expect(replay.status).toBe("refused");
  if (replay.status !== "refused") return;
  expect(replay.reasonCode).toBe("reservation_conflict");
  expect(await reservationRows(world.customerKey)).toHaveLength(1);

  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId: first.reservationId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("released");
});

// ── Cross-account isolation: another account's reservation is only ever "unknown" ──

test("a status query under one grant never reveals another account's reservation", async () => {
  const worldA = await seedWorld();
  const worldB = await seedWorld();
  const reserve = await service.reserve(worldA.request);
  expect(reserve.status).toBe("reserved");
  if (reserve.status !== "reserved") return;

  const before = await worldState([worldA.customerKey, worldB.customerKey]);
  // B's grant scopes B's own account: A's reservation is invisible through it, by either id.
  const byReservation = await statusService.queryStatus({
    grantId: worldB.grantId,
    reservationId: reserve.reservationId,
  });
  const byAttempt = await statusService.queryStatus({
    grantId: worldB.grantId,
    attemptId: reserve.attemptId,
  });
  expect(byReservation).toEqual({
    kind: "answered",
    outcome: { status: "unknown" },
  });
  expect(byAttempt).toEqual({
    kind: "answered",
    outcome: { status: "unknown" },
  });
  // Nothing was read into being and A's own view is untouched by B's probes.
  expect(await worldState([worldA.customerKey, worldB.customerKey])).toEqual(
    before,
  );
  const own = await statusService.queryStatus({
    grantId: worldA.grantId,
    reservationId: reserve.reservationId,
  });
  expect(own.kind).toBe("answered");
  if (own.kind !== "answered") return;
  expect(own.outcome.status).toBe("reserved");
});

test("an unknown grant, unknown ids, and unparseable attempt ids all answer unknown, never an existence leak", async () => {
  const world = await seedWorld();
  const reserve = await service.reserve(world.request);
  expect(reserve.status).toBe("reserved");
  if (reserve.status !== "reserved") return;

  // An unknown grant scopes nothing, so even a REAL reservation id answers unknown.
  const noGrant = await statusService.queryStatus({
    grantId: `${prefix}-no-such-grant`,
    reservationId: reserve.reservationId,
  });
  expect(noGrant).toEqual({ kind: "answered", outcome: { status: "unknown" } });

  // Well-formed ids that do not exist answer unknown to their own grant too.
  const noReservation = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId: `cr-${"0".repeat(16)}`,
  });
  expect(noReservation).toEqual({
    kind: "answered",
    outcome: { status: "unknown" },
  });
  const noAttempt = await statusService.queryStatus({
    grantId: world.grantId,
    attemptId: `att-${"0".repeat(16)}`,
  });
  expect(noAttempt).toEqual({
    kind: "answered",
    outcome: { status: "unknown" },
  });

  // A shape that cannot be an attempt id is refused, not guessed into unknown.
  const garbage = await statusService.queryStatus({
    grantId: world.grantId,
    attemptId: "att-not-hex",
  });
  expect(garbage.kind).toBe("refused");
  if (garbage.kind !== "refused") return;
  expect(garbage.reasonCode).toBe("request_invalid");
});

test("a status query stays answerable after the grant is revoked", async () => {
  const world = await seedWorld();
  const reserve = await service.reserve(world.request);
  expect(reserve.status).toBe("reserved");
  if (reserve.status !== "reserved") return;
  await database
    .update(accessGrants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(accessGrants.grantId, world.grantId));

  // Visibility is not admission: the hold still occupies credit and its owner can still ask
  // what became of it (the same question 06.8's unknown-result protection rests on).
  const answer = await statusService.queryStatus({
    grantId: world.grantId,
    reservationId: reserve.reservationId,
  });
  expect(answer.kind).toBe("answered");
  if (answer.kind !== "answered") return;
  expect(answer.outcome.status).toBe("reserved");
});

// ── Wire shapes: malformed and tampered requests refuse; the guard holds ───────────

test("the status surface refuses malformed and tampered shapes with 422 and no writes", async () => {
  const world = await seedWorld();
  const before = await worldState([world.customerKey]);

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["neither id", { grantId: world.grantId }, "request_invalid"],
    [
      "both ids",
      {
        grantId: world.grantId,
        reservationId: "cr-0000000000000000",
        attemptId: "att-0000000000000000",
      },
      "request_invalid",
    ],
    ["no grant", { reservationId: "cr-0000000000000000" }, "request_invalid"],
    [
      "malformed reservation id",
      { grantId: world.grantId, reservationId: "cr-nothex" },
      "request_invalid",
    ],
    [
      "self-reported account key",
      {
        grantId: world.grantId,
        reservationId: "cr-0000000000000000",
        externalCustomerId: "openbot-personal-someone",
      },
      "payer_conflict",
    ],
  ];
  for (const [, body, code] of cases) {
    const { status, json } = await postStatus(gatewaySecret, body);
    expect(status).toBe(422);
    expect(json.code).toBe(code);
    expect(await worldState([world.customerKey])).toEqual(before);
  }
});

test("unparsable status JSON refuses as request_invalid", async () => {
  const response = await protocolApp.request("/api/credit-protocol/status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewaySecret}`,
    },
    body: "{not json",
  });
  expect(response.status).toBe(422);
  const json = (await response.json()) as Record<string, unknown>;
  expect(json.code).toBe("request_invalid");
});

test("the guarded status surface refuses a call without the billing credential", async () => {
  const world = await seedWorld();
  const { status, json } = await postStatus(null, {
    grantId: world.grantId,
    reservationId: "cr-0000000000000000",
  });
  expect(status).toBe(401);
  expect(json).toEqual({
    error: "Credit service authentication failed.",
    code: "credit_service_auth_failed",
  });
});

// ── The two boundary lists name the same account-key fields, so neither door drifts ─

test("the status boundary refuses exactly the account-key fields the reserve boundary refuses", () => {
  expect([...STATUS_FORBIDDEN_ACCOUNT_KEY_FIELDS].sort()).toEqual(
    [...RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS].sort(),
  );
});
