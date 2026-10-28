import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import {
  computeBatchCap,
  createBatchSubmitService,
} from "../src/billing/batch-submit";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
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
import {
  batchItems,
  batchJobs,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 18.1 (#333) — the batch's whole-cap reservation and parent/child identity, on a
 * real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  the whole-batch cap covers every item's worst case: each item priced on ITS OWN
 *         model cell at the batch's locked versions, the exact costs summed, ONE upward
 *         rounding at the end (mixed models means mixed unit prices — never one price × N);
 *   AC-2  an insufficient balance refuses the WHOLE batch — no batch row, no item rows, no
 *         reservation, and the provider dispatch count is ZERO;
 *   AC-3  the batch and every item share one payer (the grant's server-side resolution) and
 *         one hold;
 *   AC-4  a replayed submit answers the SAME batch — one hold, one dispatch, the cap never
 *         grows, and there is no path that reserves again after a partial dispatch.
 *
 * Plus the boundary discipline the credit protocol owns: account-identity and company-scope
 * fields refuse on presence, and a sibling cell's admission refusal refuses the whole batch
 * and hands the hold it had built back (no dangling capacity from a refused batch).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b18-333-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** Cell A's amounts — every dimension priced, exact decimals chosen to be checkable. */
const A_AMOUNTS = {
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

/** Cell B prices `video` at twice cell A's — the mixed-model fixture's whole point. */
const B_AMOUNTS = { ...A_AMOUNTS, video: "0.02", cache_read: "0.0000002" };

function dimsOf(amounts: Record<string, string>) {
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(amounts)) {
    dims[dimension] = { status: "known", amount };
  }
  return dims;
}

let dispatchCounter = 0;

/** The provider dispatch spy: production wires the gateway's batch client here (19.x). */
function makeDispatch(behavior: "answer" | "lose") {
  let calls = 0;
  const dispatch = async (input: { batchId: string }) => {
    calls += 1;
    void input;
    return behavior === "answer"
      ? ({
          kind: "answered",
          providerBatchId: `prov-batch-${++dispatchCounter}`,
        } as const)
      : ({ kind: "lost", reason: "response_timeout" } as const);
  };
  return { dispatch, calls: () => calls };
}

/** The locked-basis seam, exactly what the settle path will resolve from. */
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
  return createBatchSubmitService({
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
  modelA: string;
  modelB: string;
  customerKey: string;
  submitBody: (overrides?: Record<string, unknown>) => Record<string, unknown>;
};

let seedCounter = 0;

async function seedWorld(
  options: { balanceCents?: number; openB?: boolean } = {},
): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const modelA = `model-a-${n}`;
  const modelB = `model-b-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Batch Bot ${n}`,
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

  const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
  for (const [model, amounts, capability] of [
    [modelA, A_AMOUNTS, "video"],
    [modelB, B_AMOUNTS, "chat"],
  ] as const) {
    await database.insert(gatewayModelCatalogRefs).values({
      provider,
      model,
      capability,
      capabilitySource: "supported_methods",
      rawEntry: { id: `${provider}/${model}` },
      configVersion: 1,
      fetchedAt: new Date(),
    });
    await snapshotStore.appendSnapshots([
      {
        ref: { provider, model, capability },
        dims: dimsOf(amounts) as never,
        fetchedAt: new Date().toISOString(),
        source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
        configVersion: 1,
        rateVersion: null,
      },
    ]);
    if (model !== modelB || options.openB !== false) {
      await database.insert(gatewayModelOpenScopes).values({
        provider,
        model,
        capability,
        state: "open",
        reason: "batch-submit fixture",
        changedBy: "test",
      });
    }
  }
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
    modelA,
    modelB,
    customerKey: payerKey({ kind: "personal", id: userId }),
    submitBody: (overrides: Record<string, unknown> = {}) => ({
      submitIdempotencyKey: `${prefix}-submit-${n}`,
      grantId,
      payer: { kind: "personal", id: userId },
      snapshotVersion: 1,
      rateVersion: 0,
      items: [
        {
          customId: "req-1",
          model: { provider, model: modelA, capability: "video" },
          quantities: { video: 60, surcharge_per_request: 1 },
        },
        {
          customId: "req-2",
          model: { provider, model: modelB, capability: "chat" },
          quantities: { video: 30 },
        },
        {
          customId: "req-3",
          model: { provider, model: modelA, capability: "video" },
          quantities: { image: 2 },
        },
      ],
      ...overrides,
    }),
  };
}

afterAll(async () => {
  await database
    .delete(batchItems)
    .where(like(batchItems.batchId, `${prefix}%`));
  // batch_ids carry the `bj-` prefix, not the fixture prefix — clear by grant's batches.
  await database.execute(
    sql`DELETE FROM batch_items WHERE batch_id IN (SELECT batch_id FROM batch_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.delete(batchJobs).where(like(batchJobs.grantId, `${prefix}%`));
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

// ── AC-1: the whole-batch cap conversion ────────────────────────────────────────────

describe("18.1 AC-1 — the whole-batch cap conversion", () => {
  test("prices every item on its own cell, sums the exacts, rounds up once", async () => {
    const world = await seedWorld();
    const basisA = await resolveBasis({
      provider: world.provider,
      model: world.modelA,
      capability: "video",
      snapshotVersion: 1,
      rateVersion: 0,
    });
    const basisB = await resolveBasis({
      provider: world.provider,
      model: world.modelB,
      capability: "chat",
      snapshotVersion: 1,
      rateVersion: 0,
    });
    if (!basisA.ok || !basisB.ok)
      throw new Error("fixture bases did not resolve");
    const cap = computeBatchCap({
      items: [
        {
          quantities: { video: 60, surcharge_per_request: 1 },
          dims: basisA.dims,
          rate: basisA.rate,
        },
        { quantities: { video: 30 }, dims: basisB.dims, rate: basisB.rate },
        { quantities: { image: 2 }, dims: basisA.dims, rate: basisA.rate },
      ],
    });
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;
    // Item 1 (cell A): 60×$0.01 + 1×$0.0001 = $0.6001 → 6001 scaled.
    // Item 2 (cell B): 30×$0.02 = $0.60 → 6000 scaled (B's own price, not A's).
    // Item 3 (cell A): 2×$0.01 = $0.02 → 200 scaled. Whole sum 12201, already whole.
    expect(cap.maximumCredits).toBe(12_201);
    expect(cap.itemExact[0]).toEqual({ numerator: 6001n, denominator: 1n });
    expect(cap.itemExact[1]).toEqual({ numerator: 6000n, denominator: 1n });
    expect(cap.itemExact[2]).toEqual({ numerator: 200n, denominator: 1n });
  });

  test("two fractional items round up ONCE — never once per item", async () => {
    const world = await seedWorld();
    const basisA = await resolveBasis({
      provider: world.provider,
      model: world.modelA,
      capability: "video",
      snapshotVersion: 1,
      rateVersion: 0,
    });
    if (!basisA.ok) throw new Error("fixture basis did not resolve");
    // cache_read at $0.0000001/unit × rate 100 × scale 100: 3 units = 0.003 scaled exact.
    // Two such items sum to 0.006 exact → the ONE ceiling is 1. Per-item ceilings would
    // answer 1 + 1 = 2 — that is the single-rounding contract this test pins.
    const cap = computeBatchCap({
      items: [
        { quantities: { cache_read: 3 }, dims: basisA.dims, rate: basisA.rate },
        { quantities: { cache_read: 3 }, dims: basisA.dims, rate: basisA.rate },
      ],
    });
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;
    expect(cap.maximumCredits).toBe(1);
  });

  test("an unknown dimension on ANY item refuses the whole conversion", async () => {
    const world = await seedWorld();
    const basisA = await resolveBasis({
      provider: world.provider,
      model: world.modelA,
      capability: "video",
      snapshotVersion: 1,
      rateVersion: 0,
    });
    if (!basisA.ok) throw new Error("fixture basis did not resolve");
    const cap = computeBatchCap({
      items: [
        { quantities: { video: 1 }, dims: basisA.dims, rate: basisA.rate },
        {
          quantities: { not_a_dimension: 1 },
          dims: basisA.dims,
          rate: basisA.rate,
        },
      ],
    });
    expect(cap.ok).toBe(false);
    if (cap.ok) return;
    expect(cap.code).toBe("request_invalid");
  });
});

// ── AC-2: insufficient balance refuses the whole batch ──────────────────────────────

describe("18.1 AC-2 — the whole batch refuses when the balance cannot cover it", () => {
  test("no batch row, no item rows, no hold, provider dispatch count 0", async () => {
    // The mixed fixture's cap is 12201 scaled units; give the account far less.
    const world = await seedWorld({ balanceCents: 5_000 });
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const outcome = await service.submit(world.submitBody());
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("reserve_refused");

    expect(dispatch.calls()).toBe(0);
    const batches = await database
      .select()
      .from(batchJobs)
      .where(eq(batchJobs.grantId, world.grantId));
    expect(batches.length).toBe(0);
    const reservations = await database
      .select()
      .from(creditReservations)
      .where(
        like(
          creditReservations.externalCustomerId,
          `openbot-personal-${prefix}%`,
        ),
      );
    // No NEW hold for this account's submits — the seed grant is the only activity.
    const holds = reservations.filter((r) =>
      r.idempotencyKey.startsWith(prefix),
    );
    expect(holds.length).toBe(0);
  });
});

// ── AC-3: parent/child identity, one payer, one hold ────────────────────────────────

describe("18.1 AC-3 — parent and child identity share one payer and one hold", () => {
  test("the batch and every item row point at the same payer and reservation", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(world.submitBody());
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    expect(outcome.created).toBe(true);
    expect(outcome.itemCount).toBe(3);
    expect(outcome.state).toBe("submitted");
    expect(outcome.providerBatchId).toBe(`prov-batch-${dispatchCounter}`);

    const [batch] = await database
      .select()
      .from(batchJobs)
      .where(eq(batchJobs.batchId, outcome.batchId));
    expect(batch.payerKind).toBe("personal");
    expect(batch.payerId).toBe(world.userId);
    expect(batch.maximumCredits).toBe(12_201);
    expect(batch.itemCount).toBe(3);
    expect(batch.state).toBe("submitted");
    expect(batch.providerBatchId).toBe(outcome.providerBatchId);

    const items = await database
      .select()
      .from(batchItems)
      .where(eq(batchItems.batchId, outcome.batchId))
      .orderBy(batchItems.itemIndex);
    expect(items.length).toBe(3);
    const customIds = items.map((item) => item.customId);
    expect(customIds).toEqual(["req-1", "req-2", "req-3"]);
    // Every item binds the batch's own reservation — one payer, one hold, parent-owned.
    for (const item of items) {
      expect(item.batchId).toBe(outcome.batchId);
      expect(item.model).not.toBeNull();
    }
    // The item cells keep their own model facts (mixed models are the fixture's spine).
    expect(items[0].model).toBe(world.modelA);
    expect(items[1].model).toBe(world.modelB);
    expect(items[2].model).toBe(world.modelA);

    // The hold: exactly one reservation under the submit key, for the resolved payer.
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, batch.reservationId));
    expect(hold.idempotencyKey).toBe(`${prefix}-submit-${seedCounter}`);
    expect(hold.externalCustomerId).toBe(world.customerKey);
    expect(hold.maximum).toBe(12_201);
  });
});

// ── AC-4: replay answers the same batch; the cap never grows ────────────────────────

describe("18.1 AC-4 — one submit key, one batch, no top-up", () => {
  test("a replayed submit answers the SAME batch: one hold, one dispatch, same cap", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const first = await service.submit(world.submitBody());
    if (first.status !== "submitted") throw new Error("first submit failed");
    const second = await service.submit(world.submitBody());
    expect(second.status).toBe("submitted");
    if (second.status !== "submitted") return;
    expect(second.created).toBe(false);
    expect(second.batchId).toBe(first.batchId);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.maximumCredits).toBe(first.maximumCredits);
    // One dispatch for the batch that exists — the replay dispatched nothing.
    expect(dispatch.calls()).toBe(1);

    // Exactly one batch and one hold under the submit key — the replay created neither a
    // second batch nor a second reservation.
    const batchRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(batchJobs)
      .where(
        eq(
          batchJobs.submitIdempotencyKey,
          world.submitBody().submitIdempotencyKey as string,
        ),
      );
    expect(batchRows[0].count).toBe(1);
    const holdRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditReservations)
      .where(
        eq(
          creditReservations.idempotencyKey,
          world.submitBody().submitIdempotencyKey as string,
        ),
      );
    expect(holdRows[0].count).toBe(1);
  });

  test("a replay naming MORE items answers the original cap — no reservation is grown", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const service = serviceWith(dispatch);
    const first = await service.submit(world.submitBody());
    if (first.status !== "submitted") throw new Error("first submit failed");
    const replay = await service.submit(
      world.submitBody({
        items: [
          ...(world.submitBody().items as unknown[]),
          {
            customId: "req-4",
            model: {
              provider: world.provider,
              model: world.modelA,
              capability: "video",
            },
            quantities: { video: 1000 },
          },
        ],
      }),
    );
    expect(replay.status).toBe("submitted");
    if (replay.status !== "submitted") return;
    expect(replay.created).toBe(false);
    expect(replay.itemCount).toBe(first.itemCount);
    expect(replay.maximumCredits).toBe(first.maximumCredits);
    expect(dispatch.calls()).toBe(1);
  });
});

// ── Boundary: the protocol's closed request shape ───────────────────────────────────

describe("18.1 — boundary refusals", () => {
  test("an account-identity field refuses on presence — the payer is resolved, never named", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(
      world.submitBody({ externalCustomerId: "openbot-personal-someone-else" }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");
    expect(dispatch.calls()).toBe(0);
  });

  test("a company-scope field refuses on presence", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(
      world.submitBody({ organizationId: "org-123" }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("request_invalid");
  });

  test("a sibling cell the administrator closed refuses the WHOLE batch and hands the hold back", async () => {
    const world = await seedWorld({ openB: false });
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(world.submitBody());
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasonCode).toBe("reserve_refused");
    expect(dispatch.calls()).toBe(0);

    // No batch, no items…
    const batches = await database
      .select()
      .from(batchJobs)
      .where(eq(batchJobs.grantId, world.grantId));
    expect(batches.length).toBe(0);
    // …and no dangling hold: the reservation cell A's admission built is RELEASED, not
    // left occupying the account's capacity (the refused batch owns nothing).
    const holds = await database
      .select()
      .from(creditReservations)
      .where(
        and(
          like(
            creditReservations.externalCustomerId,
            `openbot-personal-${prefix}%`,
          ),
          eq(
            creditReservations.idempotencyKey,
            world.submitBody().submitIdempotencyKey,
          ),
        ),
      );
    expect(holds.length).toBe(1);
    expect(holds[0].status).toBe("released");
  });

  test("a lost dispatch answer keeps the FULL cap occupied (unknown, never released)", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("lose");
    const outcome = await serviceWith(dispatch).submit(world.submitBody());
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    expect(outcome.state).toBe("dispatch_unconfirmed");
    expect(outcome.providerBatchId).toBeNull();
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, outcome.reservationId));
    expect(hold.status).toBe("unknown");
    expect(hold.maximum).toBe(12_201);
  });
});
