import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { createAuditStore } from "../src/audit";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import {
  RESERVE_BOUND_EVIDENCE_KINDS,
  createCreditReserveService,
  creditProtocolEndpoints,
  reserveCreditInTransaction,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { classifyPriceDims } from "../src/gateway/price-status";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
  mapPriceDims,
} from "../src/gateway/price-snapshot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
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
 * Bifrost #253 (06.2): the Reserve protocol's in-transaction revalidation, on a real
 * PostgreSQL (TEST_DATABASE_URL; the dedicated 5590 verify database, never the live one).
 *
 * The ticket's five refusals — revoked authorization, model not open, unknown price,
 * stale catalog, unenforceable bound evidence — must each refuse with a reason code and
 * write NOTHING. The reservation write must happen inside the SAME transaction as the
 * revalidation reads: the concurrent-revoke cases below hold the transaction open and
 * prove a revocation lands only after the reservation commits (never between the
 * revalidation and the write), and that a revocation that committed first refuses the
 * reserve. The conservative token estimate (input-bound) must never pass as evidence.
 *
 * Isolation: gateway tables are append-only (price snapshots) or shared state, so every
 * scenario names its own unique provider/bot/user prefixes instead of cleaning up; the
 * credit, grant and payer fixtures are deleted by prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b5-253-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds credit grants only; the unit under test builds its own over the transaction. */
const fixtureCreditWriter = createCreditWriter(database);
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

const FRESH_WINDOW_MS = 15 * 60 * 1000;

/** The one service under test; each scenario builds its request on a seeded world. */
const service = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: FRESH_WINDOW_MS,
});

/** The protocol surface under test: the 06.1 guard with 06.2's Reserve endpoints inside. */
const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({
    authenticate,
    auditStore,
    endpoints: creditProtocolEndpoints({ service }),
  }),
);

/** A priced catalog entry fixture: every wire-priced dimension carries an exact amount. */
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

/** An explicitly free entry: every wire-priced dimension priced at exactly zero. */
const FREE_RAW_ENTRY = {
  id: "fix/model",
  pricing: Object.fromEntries(
    Object.entries(PRICED_RAW_ENTRY.pricing).map(([key]) => [key, "0"]),
  ),
};

/** An unknown entry: the completion (output) price has no source on the wire object. */
const UNKNOWN_RAW_ENTRY = {
  id: "fix/model",
  pricing: { prompt: "0.000001" },
};

type SeedOptions = {
  /** `past` minutes subtracted from now for the sync state; null writes never-synced. */
  syncedMinutesAgo?: number | null;
  grantStatus?: "active" | "revoked";
  scopeState?: "open" | "closed" | "absent";
  cataloged?: boolean;
  rawEntry?: Record<string, unknown>;
  credits?: number;
};

type SeededWorld = {
  userId: string;
  botId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  request: CreditReserveRequest;
};

let seedCounter = 0;

/**
 * One complete world where a reserve SHOULD succeed: an active grant, a registered and
 * active bot, a personal payer account with credits, an open cataloged ref whose latest
 * price snapshot is fully known, and a fresh catalog sync. Scenarios break one spoke at
 * a time through the options.
 */
async function seedWorld(options: SeedOptions = {}): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Reserve Bot ${n}`,
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
    status: options.grantStatus ?? "active",
    revokedAt: options.grantStatus === "revoked" ? new Date() : null,
  });

  const { account } = await createPayerAccount(database, {
    kind: "personal",
    id: userId,
  });
  const credits = options.credits ?? 10_000_00; // 10 000 credits, ×100
  if (credits > 0) {
    await fixtureCreditWriter.grantCredits({
      externalCustomerId: account.externalCustomerId,
      source: "plan",
      totalCents: credits,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idempotencyKey: `${prefix}-seed-grant-${n}`,
    });
  }

  if (options.cataloged ?? true) {
    await database.insert(gatewayModelCatalogRefs).values({
      provider,
      model,
      capability: "chat",
      capabilitySource: "supported_methods",
      rawEntry: { id: `${provider}/${model}` },
      configVersion: 1,
      fetchedAt: new Date(),
    });
  }
  const rawEntry = options.rawEntry ?? PRICED_RAW_ENTRY;
  const store = createEnterpriseGatewayPriceSnapshotStore(database);
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
      dims: mapPriceDims(rawEntry),
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  if ((options.scopeState ?? "open") !== "absent") {
    await database.insert(gatewayModelOpenScopes).values({
      provider,
      model,
      capability: "chat",
      state: options.scopeState ?? "open",
      reason: "reserve-revalidation fixture",
      changedBy: "test",
    });
  }

  // The sync state is a deployment singleton; every scenario states the freshness it
  // needs, and the scenario's own assertions follow from exactly what it wrote here.
  // `undefined` means a fresh sync (the common case); explicit `null` means never synced.
  const syncedMinutesAgo =
    options.syncedMinutesAgo === undefined ? 1 : options.syncedMinutesAgo;
  if (syncedMinutesAgo === null) {
    await database
      .delete(gatewayCatalogSyncState)
      .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID));
  } else {
    await database
      .insert(gatewayCatalogSyncState)
      .values({
        id: GATEWAY_CATALOG_SYNC_STATE_ID,
        lastSuccessfulSyncAt: new Date(
          Date.now() - syncedMinutesAgo * 60 * 1000,
        ),
      })
      .onConflictDoUpdate({
        target: gatewayCatalogSyncState.id,
        set: {
          lastSuccessfulSyncAt: new Date(
            Date.now() - syncedMinutesAgo * 60 * 1000,
          ),
        },
      });
  }

  const request: CreditReserveRequest = {
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
    botId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request,
  };
}

/** The reservation rows that exist for a world's customer. */
async function reservationCount(customerKey: string): Promise<number> {
  const rows = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
  return rows.length;
}

/** Post a request body to the guarded protocol surface with the trusted credential. */
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

/**
 * Assert one refusal outcome end to end: the given reason code, and the two write tables
 * a reserve could touch are exactly as they were (拒绝不写库 — no reservation, no
 * customer floor, no partial state of any kind).
 */
async function expectRefusal(
  outcome: CreditReserveOutcome,
  code: string,
  customerKey: string,
  reservationsBefore: number,
): Promise<void> {
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe(code);
  expect(await reservationCount(customerKey)).toBe(reservationsBefore);
  const customers = await database
    .select({ externalId: payerAccounts.externalCustomerId })
    .from(payerAccounts)
    .where(eq(payerAccounts.payerId, customerKey));
  expect(customers.length).toBeLessThanOrEqual(1);
}

afterAll(async () => {
  // Credit-side rows are keyed by the DERIVED account key (`openbot-personal-<prefix>…`,
  // review-253 F1): a raw `<prefix>%` pattern matches none of those columns and silently
  // leaves residue behind, so every credit-side cleanup uses the derived-key prefix.
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
  // gateway_price_snapshots is append-only in the database (0133): rows are never deleted;
  // every scenario above isolates itself with its own unique provider name instead.
  await database.$client.close();
});

// ── The ticket's five refusals, each with its reason code and zero writes ──────────

test("a revoked authorization refuses the reserve and writes nothing", async () => {
  const world = await seedWorld({ grantStatus: "revoked" });
  const before = await reservationCount(world.customerKey);
  const outcome = await service.reserve(world.request);
  await expectRefusal(outcome, "grant_invalid", world.customerKey, before);
});

test("an unknown grant refuses the reserve", async () => {
  const world = await seedWorld();
  const before = await reservationCount(world.customerKey);
  const outcome = await service.reserve({
    ...world.request,
    grantId: `${prefix}-no-such-grant`,
  });
  await expectRefusal(outcome, "grant_invalid", world.customerKey, before);
});

test("a bot disabled after the grant refuses the reserve", async () => {
  const world = await seedWorld();
  await database
    .update(botServices)
    .set({ status: "disabled" })
    .where(eq(botServices.botId, world.botId));
  const before = await reservationCount(world.customerKey);
  const outcome = await service.reserve(world.request);
  await expectRefusal(outcome, "grant_invalid", world.customerKey, before);
});

test("a closed or absent open scope refuses the reserve", async () => {
  const closed = await seedWorld({ scopeState: "closed" });
  const outcome = await service.reserve(closed.request);
  await expectRefusal(
    outcome,
    "model_not_open",
    closed.customerKey,
    await reservationCount(closed.customerKey),
  );

  const absent = await seedWorld({ scopeState: "absent" });
  const outcome2 = await service.reserve(absent.request);
  await expectRefusal(
    outcome2,
    "model_not_open",
    absent.customerKey,
    await reservationCount(absent.customerKey),
  );
});

test("a delisted ref (not in the last-good catalog) refuses as not open", async () => {
  const world = await seedWorld({ cataloged: false });
  const outcome = await service.reserve(world.request);
  await expectRefusal(
    outcome,
    "model_not_open",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

test("an unknown price refuses with the classification's own reason and dimensions", async () => {
  const world = await seedWorld({ rawEntry: UNKNOWN_RAW_ENTRY });
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("price_unknown");
  expect(outcome.detail).toMatchObject({ priceStatus: "unknown" });
  expect(
    (outcome.detail.missingDimensions as unknown[]).length,
  ).toBeGreaterThan(0);
  expect(await reservationCount(world.customerKey)).toBe(0);
});

test("a locked snapshot version that does not exist refuses as a missing basis", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve({
    ...world.request,
    snapshotVersion: 99,
  });
  await expectRefusal(
    outcome,
    "price_basis_not_found",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

test("a stale catalog refuses with a freshness reason, never model-not-found", async () => {
  const world = await seedWorld({ syncedMinutesAgo: 16 });
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("catalog_stale");
  // The reason points at freshness: the model IS open and priced; the answer may not
  // be model_not_open or price_basis_not_found.
  expect(outcome.reasonCode).not.toBe("model_not_open");
  expect(await reservationCount(world.customerKey)).toBe(0);
});

test("a deployment that never synced refuses as never fresh", async () => {
  const world = await seedWorld({ syncedMinutesAgo: null });
  const outcome = await service.reserve(world.request);
  await expectRefusal(
    outcome,
    "catalog_never_synced",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

test("a catalog synced inside the window admits the reserve (14 minutes passes)", async () => {
  const world = await seedWorld({ syncedMinutesAgo: 14 });
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("reserved");
});

test("missing or estimate-shaped bound evidence refuses; the conservative estimate is not evidence", async () => {
  const world = await seedWorld();
  const before = await reservationCount(world.customerKey);

  // Absent evidence: nothing proves an enforceable ceiling.
  const absent = await service.reserve({
    ...world.request,
    boundEvidence: [],
  });
  await expectRefusal(
    absent,
    "bound_evidence_not_enforceable",
    world.customerKey,
    before,
  );

  // A conservative token estimate is NOT enforceable evidence (ADR 0001): any kind
  // outside the closed enforceable set is refused, estimate-shaped or not.
  const estimate = await service.reserve({
    ...world.request,
    boundEvidence: [
      // @ts-expect-error — an estimate kind is exactly what the contract refuses
      { kind: "conservative_input_estimate", maximumTokens: 8192 },
    ],
  });
  await expectRefusal(
    estimate,
    "bound_evidence_not_enforceable",
    world.customerKey,
    before,
  );

  // Malformed evidence: a kind from the set without a usable ceiling.
  const malformed = await service.reserve({
    ...world.request,
    boundEvidence: [
      // @ts-expect-error — a non-positive ceiling proves nothing enforceable
      { kind: "provider_max_tokens", maximumTokens: 0 },
    ],
  });
  await expectRefusal(
    malformed,
    "bound_evidence_not_enforceable",
    world.customerKey,
    before,
  );
});

test("the reserve module never imports the conservative input-bound estimator", () => {
  const source = readFileSync(
    new URL("../src/billing/credit-reserve.ts", import.meta.url),
    "utf8",
  );
  // No import or require may name the estimator module: the estimate can reject a
  // request, never prove one's ceiling (ADR 0001).
  expect(/from\s+"[^"]*input-bound/.test(source)).toBe(false);
  expect(/require\("[^"]*input-bound"\)/.test(source)).toBe(false);
  // The enforceable kinds are exactly the two mechanisms; the estimate is structurally outside.
  expect([...RESERVE_BOUND_EVIDENCE_KINDS].sort()).toEqual([
    "provider_max_tokens",
    "self_enforced_input_truncation",
  ]);
});

// ── The accepted path, free-vs-unknown, and the insufficient balance ───────────────

let gatewaySecret: string | null = null;

test("the deployment's trusted credential is issued for the protocol surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

test("the guarded endpoint refuses a call without the billing credential", async () => {
  const world = await seedWorld();
  const { status, json } = await postReserve(null, world.request);
  expect(status).toBe(401);
  expect(json).toEqual({
    error: "Credit service authentication failed.",
    code: "credit_service_auth_failed",
  });
  expect(await reservationCount(world.customerKey)).toBe(0);
});

test("a valid reserve returns attempt and reservation ids and holds the capacity", async () => {
  const world = await seedWorld();
  const { status, json } = await postReserve(gatewaySecret, world.request);
  expect(status).toBe(201);
  expect(json.code).toBeUndefined();
  expect(typeof json.attemptId).toBe("string");
  expect((json.attemptId as string).startsWith("att-")).toBe(true);
  expect(typeof json.reservationId).toBe("string");
  expect(json.maximumCredits).toBe(world.request.maximumCredits);
  expect(json.snapshotVersion).toBe(1);
  expect(json.rateVersion).toBe(world.request.rateVersion);

  const rows = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, world.request.idempotencyKey));
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("reserved");
  expect(rows[0].maximum).toBe(world.request.maximumCredits);
  expect(json.reservationId).toBe(rows[0].id);
});

test("a retry with the same idempotency key answers the original reservation", async () => {
  const world = await seedWorld();
  const first = await service.reserve(world.request);
  expect(first.status).toBe("reserved");
  const second = await service.reserve(world.request);
  expect(second.status).toBe("reserved");
  if (first.status !== "reserved" || second.status !== "reserved") return;
  expect(second.reservationId).toBe(first.reservationId);
  const rows = await database
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, world.request.idempotencyKey));
  expect(rows).toHaveLength(1);
});

test("an explicitly free price passes the price gate; unknown never reads as free", async () => {
  const free = await seedWorld({ rawEntry: FREE_RAW_ENTRY });
  const outcome = await service.reserve(free.request);
  expect(outcome.status).toBe("reserved");

  // Sanity on the fixture itself: the free entry classifies free, the unknown one does not.
  const freeDims = mapPriceDims(FREE_RAW_ENTRY);
  expect(classifyPriceDims(freeDims).status).toBe("free");
  expect(classifyPriceDims(mapPriceDims(UNKNOWN_RAW_ENTRY)).status).toBe(
    "unknown",
  );
});

test("an insufficient balance refuses with the available amount and no reservation", async () => {
  const world = await seedWorld({ credits: 0 });
  const outcome = await service.reserve(world.request);
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") return;
  expect(outcome.reasonCode).toBe("insufficient_credits");
  expect(outcome.detail).toMatchObject({ availableCredits: 0 });
  expect(await reservationCount(world.customerKey)).toBe(0);
});

test("a payer ref with no account mapping refuses without writing", async () => {
  const world = await seedWorld();
  const before = await reservationCount(world.customerKey);
  const outcome = await service.reserve({
    ...world.request,
    payer: { kind: "personal", id: `${prefix}-nobody` },
  });
  // Since 06.4, a payer that differs from the grant's own server-side resolution is a
  // CONFLICT (tampering), not a mere unresolved mapping — the nobody ref never matches
  // the grant's user, so the conflict fires before any mapping lookup.
  await expectRefusal(outcome, "payer_conflict", world.customerKey, before);
});

test("a quarantined unknown_owner payer ref refuses as a conflict with the resolved payer", async () => {
  const world = await seedWorld();
  const outcome = await service.reserve({
    ...world.request,
    payer: { kind: "unknown_owner", id: `${prefix}-quarantined` },
  });
  await expectRefusal(
    outcome,
    "payer_conflict",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

test("a matching payer whose account mapping was deleted refuses as unresolved", async () => {
  const world = await seedWorld();
  await database
    .delete(payerAccounts)
    .where(
      and(
        eq(payerAccounts.kind, "personal"),
        eq(payerAccounts.payerId, world.userId),
      ),
    );
  const outcome = await service.reserve(world.request);
  await expectRefusal(
    outcome,
    "payer_unresolved",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

test("a malformed request refuses as request_invalid without touching the database", async () => {
  const world = await seedWorld();
  const before = await reservationCount(world.customerKey);
  const outcome = await service.reserve({
    ...world.request,
    maximumCredits: 0, // a hold of nothing is not a hold
  });
  await expectRefusal(outcome, "request_invalid", world.customerKey, before);

  const noKey = await service.reserve({
    ...world.request,
    idempotencyKey: "",
  });
  await expectRefusal(noKey, "request_invalid", world.customerKey, before);
});

// ── Same-transaction revalidation: the concurrent-revoke injections ────────────────

test("the reservation write lands inside the caller's transaction: invisible until commit", async () => {
  const world = await seedWorld();
  const seen: { before: number; after: number } = { before: -1, after: -1 };
  await database.transaction(async (tx) => {
    const outcome = await reserveCreditInTransaction(tx, world.request, {
      now: () => new Date(),
      catalogFreshnessWindowMs: FRESH_WINDOW_MS,
    });
    expect(outcome.status).toBe("reserved");
    // A second connection must not see the uncommitted reservation: the write rode the
    // caller's transaction, not an autocommit of its own.
    const outside = await reservationCount(world.customerKey);
    seen.before = outside;
  });
  seen.after = await reservationCount(world.customerKey);
  expect(seen.before).toBe(0);
  expect(seen.after).toBe(1);
});

test("a revocation racing the reserve lands only after the reservation commits; the hold stays", async () => {
  const world = await seedWorld();
  let revokeSettled = false;
  const revokePromise = (async () => {
    // The audit store is not wired: this exercise is the row transition, not the trail.
    return revokeForUserDirect(world.grantId, world.userId);
  })().then((result) => {
    revokeSettled = true;
    return result;
  });

  await database.transaction(async (tx) => {
    const outcome = await reserveCreditInTransaction(tx, world.request, {
      now: () => new Date(),
      catalogFreshnessWindowMs: FRESH_WINDOW_MS,
    });
    expect(outcome.status).toBe("reserved");
    // While the reserve transaction holds the grant row, the revocation cannot have
    // landed: the revalidation and the write are one unit against the revoke.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(revokeSettled).toBe(false);
  });

  const revoked = await revokePromise;
  expect(revoked.revoked).toBe(true);
  // Admission-bound revocation: the grant is dead for NEW requests, the committed hold stays.
  const rows = await database
    .select({ status: creditReservations.status })
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, world.request.idempotencyKey));
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("reserved");
  const [grant] = await database
    .select({ status: accessGrants.status })
    .from(accessGrants)
    .where(eq(accessGrants.grantId, world.grantId));
  expect(grant.status).toBe("revoked");
});

test("a revocation that committed before the reserve refuses it", async () => {
  const world = await seedWorld();
  await revokeForUserDirect(world.grantId, world.userId);
  const outcome = await service.reserve(world.request);
  await expectRefusal(
    outcome,
    "grant_invalid",
    world.customerKey,
    await reservationCount(world.customerKey),
  );
});

/** The revocation act, through the 04.7 service (the same door a user's revoke uses). */
async function revokeForUserDirect(grantId: string, userId: string) {
  const { createAccessGrantService } = await import(
    "../src/bot-services/access-grants"
  );
  const { createBotServiceStore } = await import("../src/bot-services/store");
  const grantService = createAccessGrantService({
    database,
    botServices: createBotServiceStore(database),
    auditStore,
  });
  return grantService.revokeForUser(grantId, userId);
}

// ── HTTP-shape refusals through the mounted endpoints ───────────────────────────────

test("the endpoint maps a refusal to a 422 with its reason code", async () => {
  const world = await seedWorld({ grantStatus: "revoked" });
  const { status, json } = await postReserve(gatewaySecret, world.request);
  expect(status).toBe(422);
  expect(json.code).toBe("grant_invalid");
  expect(await reservationCount(world.customerKey)).toBe(0);
});

test("the endpoint answers unparsable JSON with request_invalid and no state", async () => {
  const response = await protocolApp.request("/api/credit-protocol/reserve", {
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
