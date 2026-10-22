import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  createAsyncSubmitService,
  computeAsyncSubmitCap,
} from "../src/billing/async-job-submit";
import {
  createCreditReserveService,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  resolveLockedReservationBasis,
} from "../src/billing/reserve-bound";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  payerAccounts,
} from "../src/db/schema";
import { asyncJobs, creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.2 — the async submit's full-cap reservation and idempotency, on a real
 * PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  the cap covers the whole job's worst case: every entry's certified quantities,
 *         every billing dimension, one upward rounding at the end (06.5's own arithmetic);
 *   AC-2  a refused reserve refuses the submit — no job row, no reservation, and the
 *         provider dispatch count is ZERO;
 *   AC-3  a replayed submit answers the SAME job: one row, one reservation, one dispatch;
 *   AC-4  the cap conversion covers all entries and spec dimensions — an unknown dimension
 *         refuses, and the stored cap is ≥ the exact worst-case cost of the entries.
 *
 * Plus the attribution pin: the job row freezes grant/payer/model/versions at creation.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-326-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** Every dimension priced known, exact decimals chosen so the cap arithmetic is checkable. */
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
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

let dispatchCounter = 0;

/** The provider dispatch spy: production wires the gateway client here (19.x). */
function makeDispatch(behavior: "answer" | "lose") {
  let calls = 0;
  const dispatch = async (input: { jobId: string }) => {
    calls += 1;
    void input;
    return behavior === "answer"
      ? ({ kind: "answered", providerJobId: `prov-job-${++dispatchCounter}` } as const)
      : ({ kind: "lost", reason: "response_timeout" } as const);
  };
  return { dispatch, calls: () => calls };
}

/** The locked-basis seam, exactly what the settle path resolves from. */
async function resolveBasis(basis: {
  provider: string;
  model: string;
  capability: string;
  snapshotVersion: number;
  rateVersion: number;
}) {
  const resolved = await resolveLockedReservationBasis(
    { database, environmentRate: ENVIRONMENT_RATE },
    basis,
  );
  return resolved.resolved
    ? { ok: true as const, dims: resolved.dims, rate: resolved.rate }
    : { ok: false as const, reason: resolved.reason };
}

function serviceWith(dispatch: ReturnType<typeof makeDispatch>) {
  return createAsyncSubmitService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: dispatch.dispatch,
    resolveBasis,
  });
}

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  submitBody: (overrides?: Record<string, unknown>) => Record<string, unknown>;
};

let seedCounter = 0;

async function seedWorld(
  options: { balanceCents?: number } = {},
): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "video";

  await database.insert(botServices).values({
    botId,
    displayName: `Async Bot ${n}`,
    kind: "external",
    capabilities: ["async"],
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
    totalCents: options.balanceCents ?? 10_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-seed-grant-${n}`,
  });

  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability,
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  await createEnterpriseGatewayPriceSnapshotStore(database).appendSnapshots([
    {
      ref: { provider, model, capability },
      dims: dimsOf(V1_AMOUNTS) as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability,
    state: "open",
    reason: "async-submit fixture",
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

  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    submitBody: (overrides: Record<string, unknown> = {}) => ({
      submitIdempotencyKey: `${prefix}-submit-${n}`,
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability },
      snapshotVersion: 1,
      rateVersion: 0,
      // Three entries with per-entry worst-case quantities across several dimensions —
      // the cap must cover ALL entries × ALL dimensions.
      entries: [
        { quantities: { video: 60, surcharge_per_request: 1 } },
        { quantities: { video: 30, surcharge_per_request: 1 } },
        { quantities: { video: 10, image: 2 } },
      ],
      ...overrides,
    }),
  };
}

afterAll(async () => {
  await database
    .delete(asyncJobs)
    .where(like(asyncJobs.grantId, `${prefix}%`));
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`));
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

// ── AC-1 / AC-4: the cap conversion ─────────────────────────────────────────────────

describe("17.2 AC-1/AC-4 — the full-cap conversion", () => {
  test("sums every entry × every dimension and rounds up once, at least the exact worst case", async () => {
    const world = await seedWorld();
    const basis = await resolveBasis({
      provider: world.provider,
      model: world.model,
      capability: "video",
      snapshotVersion: 1,
      rateVersion: 0,
    });
    if (!basis.ok) throw new Error("fixture basis did not resolve");
    const cap = computeAsyncSubmitCap({
      entries: [
        { quantities: { video: 60, surcharge_per_request: 1 } },
        { quantities: { video: 30, surcharge_per_request: 1 } },
        { quantities: { video: 10, image: 2 } },
      ],
      dims: basis.dims,
      rate: basis.rate,
    });
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;
    expect(cap.totals.video).toBe(100);
    expect(cap.totals.image).toBe(2);
    expect(cap.totals.surcharge_per_request).toBe(2);
    // 100×$0.01 + 2×$0.01 + 2×$0.0001 = $1.0202 exactly → ×100 credits/USD ×100 scale
    // = 10202 scaled units, already whole: the ceiling equals the exact cost.
    expect(cap.maximumCredits).toBe(10_202);

    // The single rounding step, and it is upward: cache_read at $0.0000001/unit gives
    // 3 units → 0.003 scaled exactly → the least whole scaled unit ≥ it is 1.
    const fractional = computeAsyncSubmitCap({
      entries: [{ quantities: { cache_read: 3 } }],
      dims: basis.dims,
      rate: basis.rate,
    });
    expect(fractional.ok).toBe(true);
    if (fractional.ok) expect(fractional.maximumCredits).toBe(1);
  });

  test("an unknown dimension refuses the submit before any hold or dispatch", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    // Tamper the locked basis by naming a dimension the vocabulary does not know.
    const outcome = await service.submit(
      world.submitBody({
        entries: [{ quantities: { not_a_dimension: 1 } }],
      }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");
    expect(dispatch.calls()).toBe(0);
    const rows = await database
      .select()
      .from(asyncJobs)
      .where(like(asyncJobs.grantId, world.grantId));
    expect(rows).toHaveLength(0);
  });

  test("an unresolvable locked basis refuses with price_unknown", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const outcome = await service.submit(
      world.submitBody({ snapshotVersion: 99 }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("price_unknown");
    expect(outcome.detail).toMatchObject({ reason: "snapshot_not_found" });
    expect(dispatch.calls()).toBe(0);
  });
});

// ── AC-2: a refused reserve refuses the submit, provider dispatch 0 ─────────────────

describe("17.2 AC-2 — reservation failure refuses the submit", () => {
  test("insufficient balance: submit refused, no job row, dispatch spy 0", async () => {
    const world = await seedWorld({ balanceCents: 50 }); // $0.50 — far under the $1.03 job
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const outcome = await service.submit(world.submitBody());
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("reserve_refused");
    expect(outcome.detail).toMatchObject({ reasonCode: "insufficient_credits" });
    expect(dispatch.calls()).toBe(0);
    const jobRows = await database
      .select()
      .from(asyncJobs)
      .where(like(asyncJobs.grantId, world.grantId));
    expect(jobRows).toHaveLength(0);
    const holds = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.externalCustomerId, world.customerKey));
    expect(holds).toHaveLength(0);
  });

  test("the reserve door's own refusals ride through (payer conflict on a company claim)", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const outcome = await service.submit(
      world.submitBody({
        payer: { kind: "company", id: "some-tenant" },
      }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.detail).toMatchObject({ reasonCode: "payer_conflict" });
    expect(dispatch.calls()).toBe(0);
  });
});

// ── AC-3: submit idempotency ────────────────────────────────────────────────────────

describe("17.2 AC-3 — submit idempotency", () => {
  test("a replayed submit answers the same job: one row, one reservation, one dispatch", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const body = world.submitBody();

    const first = await service.submit(body);
    expect(first.status).toBe("submitted");
    if (first.status !== "submitted") return;
    expect(first.created).toBe(true);
    expect(first.providerJobId).not.toBeNull();
    expect(first.state).toBe("submitted");

    const second = await service.submit(body);
    expect(second.status).toBe("submitted");
    if (second.status !== "submitted") return;
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.providerJobId).toBe(first.providerJobId);

    const jobRows = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.submitIdempotencyKey, body.submitIdempotencyKey));
    expect(jobRows).toHaveLength(1);
    const holds = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.externalCustomerId, world.customerKey));
    expect(holds).toHaveLength(1);
    expect(dispatch.calls()).toBe(1);
  });

  test("a lost dispatch answer leaves the row unconfirmed with the hold occupied", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("lose");
    const service = serviceWith(dispatch);
    const body = world.submitBody();
    const outcome = await service.submit(body);
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    expect(outcome.providerJobId).toBeNull();
    expect(outcome.state).toBe("dispatch_unconfirmed");

    const [row] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.submitIdempotencyKey, body.submitIdempotencyKey));
    expect(row.providerJobId).toBeNull();
    expect(row.state).toBe("dispatch_unconfirmed");

    // The hold stays occupied — 17.3 moved it to 06.8's `unknown` the moment the loss was
    // known: terminal nothing, full cap still held, and the recovery scan owns it now.
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, outcome.reservationId));
    expect(hold.status).toBe("unknown");
    expect(hold.applied).toBeNull();
    expect(hold.released).toBeNull();
    expect(hold.maximum).toBe(outcome.maximumCredits);

    // A replay still answers the same job and does NOT re-dispatch.
    const replay = await service.submit(body);
    expect(replay.status).toBe("submitted");
    if (replay.status !== "submitted") return;
    expect(replay.created).toBe(false);
    expect(replay.jobId).toBe(outcome.jobId);
    expect(dispatch.calls()).toBe(1);
  });

  test("the job row freezes the attribution it was born under", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const body = world.submitBody();
    const outcome = await service.submit(body);
    expect(outcome.status).toBe("submitted");
    const [row] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, (outcome as { jobId: string }).jobId));
    // The payer is the one the door RESOLVED (the grant's user), not the request's spelling;
    // the model cell and both versions are the submit's own, frozen at creation.
    expect(row.payerKind).toBe("personal");
    expect(row.payerId).toBe(world.userId);
    expect(row.grantId).toBe(world.grantId);
    expect(row.provider).toBe(world.provider);
    expect(row.model).toBe(world.model);
    expect(row.capability).toBe("video");
    expect(row.snapshotVersion).toBe(1);
    expect(row.rateVersion).toBe(0);
    expect(row.entryCount).toBe(3);
    // The cap stored is the computed full cap: $1.0202 exact → 10202 scaled.
    expect(row.maximumCredits).toBe(10_202);
  });
});

// The ledger stays untouched by submits alone — the hold is the only money fact (17.5/17.6
// own settlement). Pinned so a future wiring that charges at submit fails HERE first.
test("a submit writes no ledger row — the hold is the only money fact", async () => {
  const world = await seedWorld();
  const dispatch = makeDispatch("answer");
  await serviceWith(dispatch).submit(world.submitBody());
  const ledger = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, world.customerKey));
  expect(ledger).toHaveLength(0);
});
