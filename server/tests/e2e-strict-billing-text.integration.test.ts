import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import {
  createCreditReserveService,
  creditProtocolEndpoints,
  type CreditReserveRequest,
} from "../src/billing/credit-reserve";
import {
  createCreditSettleService,
  creditSettleEndpoints,
} from "../src/billing/credit-settle";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCredits } from "../src/billing/credits";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
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
import {
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost #275 (07.12): group 07's stitching acceptance, the OpenBot half. The full chain
 * a deployment runs, on a real PostgreSQL (TEST_DATABASE_URL, the dedicated bf6 database —
 * never the live one): an authenticated trusted caller (06.1's service credential) drives
 * the protocol surface over real routing — Reserve (06.2/06.5: bound evidence, locked
 * basis) → the dispatch admission admitted → Settle (06.9: exact actual through the locked
 * basis) → the SQL balances the ledger and the user view read.
 *
 * THE OTHER HALF lives in the bifrost submodule (`plugins/governance/endtoend_test.go`,
 * `go test -run EndToEnd ./...`): the pipeline's own gates and the deterministic provider
 * fake whose call count the five-refusal matrix asserts against. The two suites meet at the
 * wire contract: this file proves what the ACCOUNT must hold — a hold only where admission
 * succeeded, one charge per admitted attempt at the exact actual, nothing dangling, nothing
 * leaked across accounts — which is the SQL side of "供应商调用数为 0": no hold and no
 * ledger row is the only state an un-dispatched attempt can leave behind.
 *
 * Isolation mirrors #260's recipe: every scenario seeds its own bot/grant/provider prefixes
 * (price snapshots and rate versions are append-only), and the fixtures are deleted by the
 * DERIVED account-key prefix in afterAll.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b6-275-${randomUUID().slice(0, 8)}`;
/** Fixture-side writer: seeds grants, and drives holds to the unknown state (06.8's seam). */
const fixtureCreditWriter = createCreditWriter(database);

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

/** Version 1 prices: only the two dimensions the scenarios consume, everything else known. */
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
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
} as const;

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);

let seedCounter = 0;

type SeededWorld = {
  userId: string;
  botId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  request: CreditReserveRequest;
};

/**
 * One world where a reserve SHOULD succeed: a Bot, its model-access grant, a personal payer
 * account seeded with `totalCredits` scaled units, and a version-1 priced model cell. The
 * bound quantities (input truncation 60 000, output cap 1 024) certify a ceiling of ~6.2
 * credits, so an 8-credit hold covers everything the bounds admit.
 */
async function seedWorld(totalCredits = 1_000): Promise<SeededWorld> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Strict billing e2e Bot ${n}`,
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
    totalCents: totalCredits,
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
    reason: "strict-billing-e2e fixture",
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
    botId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    request: {
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [
        { kind: "self_enforced_input_truncation", maximumTokens: 60_000 },
        { kind: "provider_max_tokens", maximumTokens: 1_024 },
      ],
      maximumCredits: 800,
      idempotencyKey: `${prefix}-idem-${n}`,
    } satisfies CreditReserveRequest,
  };
}

/** All twelve dimensions, everything but the named ones zero — the settle usage shape. */
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
    surcharge_web_search: 0,
    surcharge_per_request: 0,
  };
  for (const [dimension, quantity] of Object.entries(named)) {
    usage[dimension] = quantity;
  }
  return usage;
}

async function reservationsOf(customerKey: string) {
  return database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
}

async function ledgerRowsOf(customerKey: string) {
  return database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
}

/** The account-side "provider was never called": no hold, no charge, nothing dangling. */
async function expectUntouchedAccount(customerKey: string, seeded: number) {
  expect(await reservationsOf(customerKey)).toHaveLength(0);
  expect(await ledgerRowsOf(customerKey)).toHaveLength(0);
  expect(await fixtureCreditWriter.availableBalance(customerKey)).toBe(seeded);
}

afterAll(async () => {
  // Credit-side columns carry the DERIVED account key (`openbot-personal-<prefix>…`).
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
  await database.$client.close();
});

// ── The wire: the whole protocol surface lives inside the 06.1 guard ────────────────

const encryptionKey = randomUUID().replaceAll("-", "");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

/** The protocol surface: the 06.1 guard with Reserve and Settle composed inside. */
const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({
    authenticate,
    auditStore,
    endpoints: (() => {
      const endpoints = new Hono<{ Variables: CreditServiceVariables }>();
      endpoints.route("/", creditProtocolEndpoints({ service: reserveService }));
      endpoints.route("/", creditSettleEndpoints({ service: settleService }));
      return endpoints;
    })(),
  }),
);

let gatewaySecret = "";

test("the deployment's trusted credential is issued for the protocol surface", async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  gatewaySecret = issued.secret;
  expect(gatewaySecret).toBeTruthy();
});

const authedHeaders = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${gatewaySecret}`,
});

async function reserveOnTheWire(
  request: CreditReserveRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await protocolApp.request("/api/credit-protocol/reserve", {
    method: "POST",
    headers: authedHeaders(),
    body: JSON.stringify(request),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function settleOnTheWire(
  reservationId: string,
  usage: Record<string, number>,
  idempotencyKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await protocolApp.request("/api/credit-protocol/settle", {
    method: "POST",
    headers: authedHeaders(),
    body: JSON.stringify({
      reservationId,
      actualUsage: usageOf(usage),
      evidence: {
        kind: "provider_usage_report",
        reference: `${prefix}-usage-${idempotencyKey}`,
      },
      settledBy: `${prefix}-bifrost-admission`,
      idempotencyKey,
    }),
  });
  return { status: response.status, body: (await response.json()) as never };
}

// ── AC01: the success path — balance 10, cap 8, actual 3 → 7, nothing dangling ──────

test("an admitted call settles at its exact actual and leaves no dangling hold", async () => {
  const world = await seedWorld(1_000);

  // 余额 10、上限 8：the hold takes 800 scaled units; available drops to 200.
  const reserved = await reserveOnTheWire(world.request);
  expect(reserved.status).toBe(201);
  expect(reserved.body.status).toBeUndefined(); // a 201 carries the hold's identity, not a status word
  const reservationId = reserved.body.reservationId as string;
  expect(typeof reservationId).toBe("string");
  expect(reserved.body.attemptId).toBe(
    `att-${reservationId.slice("cr-".length)}`,
  );
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    200,
  );

  // 实际 3：20 000 input + 5 000 output at version-1 prices — $0.03 at 100 credits/USD,
  // exactly 300 scaled units. The settle carries no price: the locked basis prices it.
  const settled = await settleOnTheWire(
    reservationId,
    { input: 20_000, output: 5_000 },
    `${prefix}-settle-success`,
  );
  expect(settled.status).toBe(200);
  expect(settled.body.status).toBe("settled");
  expect(settled.body.chargedCredits).toBe(300);
  expect(settled.body.appliedCredits).toBe(300);
  expect(settled.body.releasedCredits).toBe(500);

  // 最终余额为 7，无悬挂余量：the terminal hold carries its whole arithmetic.
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    700,
  );
  const [row] = await reservationsOf(world.customerKey);
  expect(row.status).toBe("settled");
  expect(row.charged).toBe(300);
  expect(row.applied).toBe(300);
  expect(row.released).toBe(500);
  expect(row.terminalAt).not.toBeNull();

  const ledgerRows = await ledgerRowsOf(world.customerKey);
  expect(ledgerRows).toHaveLength(1);
  expect(ledgerRows[0]?.credits).toBe(300);
  expect(ledgerRows[0]?.idempotencyKey).toBe(`reservation:${reservationId}`);

  // The user view (06.12): the charge is attributed to the Bot and the model.
  const credits = createCredits({
    database,
    externalCustomerKey: world.customerKey,
    catalog: new Map(),
  });
  const balance = await credits.personalBalance({
    kind: "personal",
    id: world.userId,
  });
  expect(balance.available).toBe(7);
  expect(balance.pendingSettlement.reserved).toBe(0);
  expect(balance.pendingSettlement.unknown).toBe(0);
  const page = await credits.consumption(
    { from: null, to: null, page: 1 },
    { kind: "personal", id: world.userId },
  );
  expect(page.pagination.totalCount).toBe(1);
  expect(page.entries[0]?.credits).toBe(3);
  expect(page.entries[0]?.botId).toBe(world.botId);
  expect(page.entries[0]?.botName).toBe(`Strict billing e2e Bot ${seedCounter}`);
  expect(page.entries[0]?.model).toBe(world.model);
});

// ── AC02: the five refusal classes leave the account untouched ──────────────────────

test("insufficient balance refuses the hold before any work is admitted", async () => {
  const world = await seedWorld(500); // 5 credits available

  const refused = await reserveOnTheWire({
    ...world.request,
    maximumCredits: 800, // the 8-credit ceiling cannot be held against 5
  });

  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe("insufficient_credits");
  await expectUntouchedAccount(world.customerKey, 500);
});

test("a reserve whose answer never arrived holds the credit and charges nothing", async () => {
  const world = await seedWorld(1_000);

  // 超时, the account-side truth: the hold landed, the caller never learned its fate.
  // Driven through the service (the wire's response is the thing that was lost).
  const outcome = await reserveService.reserve(world.request);
  expect(outcome.status).toBe("reserved");
  if (outcome.status !== "reserved") return;

  // The unconfirmed hold keeps occupying credit (Q12: a timeout is not release evidence).
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    200,
  );
  expect(await ledgerRowsOf(world.customerKey)).toHaveLength(0);

  // 06.7's recovery: re-sending the SAME idempotency key answers the ORIGINAL hold —
  // the caller that timed out recovers the identity instead of admitting the work twice.
  const recovered = await reserveOnTheWire(world.request);
  expect(recovered.status).toBe(201);
  expect(recovered.body.reservationId).toBe(outcome.reservationId);
  const holds = await reservationsOf(world.customerKey);
  expect(holds).toHaveLength(1);
});

test("a revoked grant refuses the reserve", async () => {
  const world = await seedWorld(1_000);

  await database
    .update(accessGrants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(accessGrants.grantId, world.grantId));

  const refused = await reserveOnTheWire(world.request);
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe("grant_invalid");
  await expectUntouchedAccount(world.customerKey, 1_000);
});

test("a request without enforceable bound evidence refuses the reserve", async () => {
  const world = await seedWorld(1_000);

  // 缺上限证据：an estimate-shaped entry proves nothing enforceable (ADR 0001).
  const refused = await reserveOnTheWire({
    ...world.request,
    boundEvidence: [
      {
        kind: "conservative_estimate" as never,
        maximumTokens: 100_000,
      },
    ],
  });

  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe("bound_evidence_not_enforceable");
  await expectUntouchedAccount(world.customerKey, 1_000);
});

test("a caller without the deployment's service credential reserves nothing", async () => {
  const world = await seedWorld(1_000);

  // 扩展缺失, the account-side posture: no trusted credential, no protocol surface.
  const response = await protocolApp.request("/api/credit-protocol/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(world.request),
  });

  expect(response.status).toBe(401);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("credit_service_auth_failed");
  await expectUntouchedAccount(world.customerKey, 1_000);
});

// ── AC03: a billed failure still charges; an unknown result keeps the hold ───────────

test("a failed call the provider billed still charges its actual usage", async () => {
  const world = await seedWorld(1_000);

  const reserved = await reserveOnTheWire(world.request);
  expect(reserved.status).toBe(201);
  const reservationId = reserved.body.reservationId as string;

  // 07.11: the tokens were processed before the call failed, so the actual is real —
  // the settle the pipeline sends for a billed failure is a settle like any other.
  const settled = await settleOnTheWire(
    reservationId,
    { input: 20_000 },
    `${prefix}-settle-billed-failure`,
  );
  expect(settled.status).toBe(200);
  expect(settled.body.chargedCredits).toBe(200);
  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    800,
  );
});

test("a result that never confirmed keeps the reservation occupying credit", async () => {
  const world = await seedWorld(1_000);

  const reserved = await reserveOnTheWire(world.request);
  expect(reserved.status).toBe(201);
  const reservationId = reserved.body.reservationId as string;

  // Q12/06.8: no usable report arrived, so the hold moves to unknown and STAYS.
  await fixtureCreditWriter.markReservationUnknown(
    reservationId,
    "stream_error_no_usage_report",
  );

  expect(await fixtureCreditWriter.availableBalance(world.customerKey)).toBe(
    200,
  );
  expect(await ledgerRowsOf(world.customerKey)).toHaveLength(0);
  const [row] = await reservationsOf(world.customerKey);
  expect(row.status).toBe("unknown");
  expect(row.unknownReason).toBe("stream_error_no_usage_report");

  // The user view says so too: the pending unknown bucket, not a charge.
  const credits = createCredits({
    database,
    externalCustomerKey: world.customerKey,
    catalog: new Map(),
  });
  const balance = await credits.personalBalance({
    kind: "personal",
    id: world.userId,
  });
  expect(balance.available).toBe(2);
  expect(balance.pendingSettlement.unknown).toBe(8);
});

// ── AC04: the consumption view is scoped to the account that paid ───────────────────

test("another account's view shows nothing of this one's consumption", async () => {
  const paying = await seedWorld(1_000);
  const bystander = await seedWorld(1_000);

  const reserved = await reserveOnTheWire(paying.request);
  expect(reserved.status).toBe(201);
  const settled = await settleOnTheWire(
    reserved.body.reservationId as string,
    { input: 20_000, output: 5_000 },
    `${prefix}-settle-privacy`,
  );
  expect(settled.status).toBe(200);

  const bystanderCredits = createCredits({
    database,
    externalCustomerKey: bystander.customerKey,
    catalog: new Map(),
  });
  const page = await bystanderCredits.consumption(
    { from: null, to: null, page: 1 },
    { kind: "personal", id: bystander.userId },
  );
  expect(page.pagination.totalCount).toBe(0);
  expect(page.entries).toHaveLength(0);
  expect(await bystanderCredits.personalBalance({
    kind: "personal",
    id: bystander.userId,
  }).then((balance) => balance.available)).toBe(10);
});
