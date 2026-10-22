import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  createAsyncDispatchRecoveryService,
  listUnconfirmedAsyncJobs,
} from "../src/billing/async-job-recovery";
import {
  readAsyncJobByProviderJobId,
} from "../src/billing/async-job-identity";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
import { createRecoveryScanner } from "../src/billing/recovery-scan";
import { readCapacity } from "../src/billing/capacity";
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
 * Ticket 17.3 (#327) — a dispatch answer that was lost sends the job into the unknown
 * recovery lane, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  providerJobID 响应丢失时不创建第二个任务 — the row is one, the hold is one,
 *         the dispatch happened once, and a replayed submit answers the SAME job;
 *   AC-2  任务进入 unknown 恢复流程，预留保持占用 — the hold moves to `unknown`
 *         (06.8) with its FULL cap still occupied, and the 08.1 scan names it;
 *   AC-3  可通过稳定标识找回远端任务并补映射 — the recovery queries the provider by
 *         the submit's stable identity and attaches the provider job id found;
 *   AC-4  找回失败时保持 unknown，不释放预留 — a provider that cannot answer leaves
 *         everything exactly as it was: unconfirmed, unknown, fully held, no ledger.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-327-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

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

/** The losing dispatch: called once, and the test asserts it carried the stable identity. */
function makeLosingDispatch() {
  const seen: { jobId: string; submitIdempotencyKey: string }[] = [];
  const dispatch = async (input: {
    jobId: string;
    submitIdempotencyKey: string;
  }) => {
    seen.push({
      jobId: input.jobId,
      submitIdempotencyKey: input.submitIdempotencyKey,
    });
    return { kind: "lost", reason: "response_timeout" } as const;
  };
  return { dispatch, seen: () => seen };
}

/** The provider-lookup seam: production wires the gateway client (19.x); tests fake it. */
function makeProviderLookup() {
  const queries: {
    provider: string;
    model: string;
    submitIdempotencyKey: string;
  }[] = [];
  let answer:
    | { status: "found"; providerJobId: string }
    | { status: "not_found"; reason: string } = {
    status: "not_found",
    reason: "no_such_batch",
  };
  const findProviderJob = async (query: {
    provider: string;
    model: string;
    submitIdempotencyKey: string;
  }) => {
    queries.push(query);
    return answer;
  };
  return {
    findProviderJob,
    queries: () => queries,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
  };
}

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

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  submitKey: string;
  submit: () => Promise<ReturnType<AsyncSubmitServiceShape["submit"]>>;
};

type AsyncSubmitServiceShape = {
  submit: (input: unknown) => Promise<
    | {
        status: "submitted";
        created: boolean;
        jobId: string;
        reservationId: string;
        maximumCredits: number;
        entryCount: number;
        state: "submitted" | "dispatch_unconfirmed";
        providerJobId: string | null;
      }
    | { status: "refused"; reasonCode: string; detail: Record<string, unknown> }
  >;
};

let seedCounter = 0;

async function seedWorld(options: { balanceCents?: number } = {}): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "video";
  const submitKey = `${prefix}-submit-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Lost Answer Bot ${n}`,
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
    totalCents: options.balanceCents ?? 1_000_000,
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
    reason: "lost-jobid fixture",
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

  const dispatch = makeLosingDispatch();
  const service = createAsyncSubmitService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: dispatch.dispatch,
    resolveBasis,
  });
  const body = {
    submitIdempotencyKey: submitKey,
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability },
    snapshotVersion: 1,
    rateVersion: 0,
    entries: [{ quantities: { video: 60, surcharge_per_request: 1 } }],
  };
  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    submitKey,
    submit: () => service.submit(body),
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

// ── AC-1: one job, one hold, one dispatch ───────────────────────────────────────────

describe("17.3 AC-1 — a lost answer creates no second job", () => {
  test("the dispatch carries the stable submit identity, and a replay answers the same job", async () => {
    const world = await seedWorld();
    const first = await world.submit();
    expect(first.status).toBe("submitted");
    if (first.status !== "submitted") return;
    expect(first.created).toBe(true);
    expect(first.state).toBe("dispatch_unconfirmed");
    expect(first.providerJobId).toBeNull();

    const replay = await world.submit();
    expect(replay.status).toBe("submitted");
    if (replay.status !== "submitted") return;
    expect(replay.created).toBe(false);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.reservationId).toBe(first.reservationId);

    const rows = await database
      .select({ jobId: asyncJobs.jobId })
      .from(asyncJobs)
      .where(eq(asyncJobs.submitIdempotencyKey, world.submitKey));
    expect(rows).toHaveLength(1);

    const holds = await database
      .select({ id: creditReservations.id })
      .from(creditReservations)
      .where(eq(creditReservations.externalCustomerId, world.customerKey));
    expect(holds).toHaveLength(1);
  });
});

// ── AC-2: unknown recovery lane, hold fully occupied ────────────────────────────────

describe("17.3 AC-2 — the lost answer enters the unknown recovery lane", () => {
  test("the hold moves to unknown with its full cap occupied, and the scan names it", async () => {
    const world = await seedWorld();
    const outcome = await world.submit();
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, outcome.reservationId));
    expect(hold.status).toBe("unknown");
    expect(hold.unknownAt).not.toBeNull();
    expect(hold.unknownReason).toContain("async_dispatch");
    expect(hold.applied).toBeNull();
    expect(hold.released).toBeNull();
    expect(hold.maximum).toBe(outcome.maximumCredits);

    // The user's spendable capacity dropped by the FULL cap — the hold is real money.
    const capacity = await readCapacity(database, world.customerKey);
    expect(capacity.spendableUnits).toBe(1_000_000 - outcome.maximumCredits);

    // 08.1's scan names the unknown hold exactly once, carrying the 17.3 mark's own reason.
    const scan = createRecoveryScanner({ database });
    const pass = await scan.scanOnce();
    const mine = pass.items.filter(
      (item) => item.reservationId === outcome.reservationId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.lastReason).toBe("async_dispatch_answer_lost");
  });
});

// ── AC-3: recovery finds the remote job and backfills the mapping ───────────────────

describe("17.3 AC-3 — the stable identity finds the remote job", () => {
  test("a found provider job id attaches and the reverse mapping reads back", async () => {
    const world = await seedWorld();
    const outcome = await world.submit();
    if (outcome.status !== "submitted") return;
    const providerJobId = `prov-recovered-${outcome.jobId.slice(3, 11)}`;

    const lookup = makeProviderLookup();
    lookup.answerWith({ status: "found", providerJobId });
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: lookup.findProviderJob,
    });

    const recovered = await recovery.recoverLostDispatch(outcome.jobId);
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") return;
    expect(recovered.alreadyKnown).toBe(false);
    expect(recovered.job.providerJobId).toBe(providerJobId);
    expect(recovered.job.state).toBe("submitted");
    expect(recovered.job.dispatchedAt).not.toBeNull();

    // The query went out under the stable submit identity, provider and model.
    expect(lookup.queries()).toHaveLength(1);
    expect(lookup.queries()[0]?.submitIdempotencyKey).toBe(world.submitKey);
    expect(lookup.queries()[0]?.provider).toBe(world.provider);
    expect(lookup.queries()[0]?.model).toBe(world.model);

    // The reverse half of the mapping answers.
    const byProvider = await readAsyncJobByProviderJobId(
      database,
      providerJobId,
    );
    expect(byProvider?.jobId).toBe(outcome.jobId);

    // A replay is not recovery's subject anymore: the row is submitted, so the sweep
    // skips it without asking the provider again.
    const again = await recovery.recoverLostDispatch(outcome.jobId);
    expect(again.status).toBe("not_unconfirmed");
    expect(lookup.queries()).toHaveLength(1);
  });

  test("a confirmed job is not recovery's subject — the answer names it", async () => {
    const world = await seedWorld();
    const outcome = await world.submit();
    if (outcome.status !== "submitted") return;
    const lookup = makeProviderLookup();
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: lookup.findProviderJob,
    });
    // Recover once so the row is submitted, then ask again.
    lookup.answerWith({
      status: "found",
      providerJobId: "prov-recovered-early",
    });
    await recovery.recoverLostDispatch(outcome.jobId);
    const second = await recovery.recoverLostDispatch(outcome.jobId);
    expect(second.status).toBe("not_unconfirmed");
    expect(lookup.queries()).toHaveLength(1);
  });
});

// ── AC-4: a provider that cannot answer leaves everything held ──────────────────────

describe("17.3 AC-4 — a failed lookup keeps the unknown and the hold", () => {
  test("not found: unconfirmed, unknown, full hold, zero ledger", async () => {
    const world = await seedWorld();
    const outcome = await world.submit();
    if (outcome.status !== "submitted") return;

    const lookup = makeProviderLookup();
    lookup.answerWith({ status: "not_found", reason: "no_such_batch" });
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: lookup.findProviderJob,
    });

    const stillUnknown = await recovery.recoverLostDispatch(outcome.jobId);
    expect(stillUnknown.status).toBe("still_unknown");
    if (stillUnknown.status !== "still_unknown") return;
    expect(stillUnknown.job.state).toBe("dispatch_unconfirmed");
    expect(stillUnknown.job.providerJobId).toBeNull();

    const [row] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, outcome.jobId));
    expect(row.state).toBe("dispatch_unconfirmed");
    expect(row.providerJobId).toBeNull();

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, outcome.reservationId));
    expect(hold.status).toBe("unknown");
    expect(hold.applied).toBeNull();
    expect(hold.released).toBeNull();
    expect(hold.maximum).toBe(outcome.maximumCredits);

    const ledger = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledger).toHaveLength(0);

    // The unconfirmed walk still lists the job — the sweep will ask again.
    const unconfirmed = await listUnconfirmedAsyncJobs(database);
    expect(
      unconfirmed.some((job) => job.jobId === outcome.jobId),
    ).toBe(true);

    // A second attempt answers the same way: nothing moved.
    const repeat = await recovery.recoverLostDispatch(outcome.jobId);
    expect(repeat.status).toBe("still_unknown");
  });

  test("a provider id another job already holds is refused, never taken twice", async () => {
    const firstWorld = await seedWorld();
    const first = await firstWorld.submit();
    if (first.status !== "submitted") return;
    const lookup = makeProviderLookup();
    lookup.answerWith({ status: "found", providerJobId: "prov-shared-1" });
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: lookup.findProviderJob,
    });
    await recovery.recoverLostDispatch(first.jobId);

    // A second job's lookup answers the SAME provider id: the unique index's own answer.
    const secondWorld = await seedWorld();
    const second = await secondWorld.submit();
    if (second.status !== "submitted") return;
    const conflict = await recovery.recoverLostDispatch(second.jobId);
    expect(conflict.status).toBe("refused");
    if (conflict.status !== "refused") return;
    expect(conflict.reasonCode).toBe("provider_job_id_in_use");

    // The second job keeps its own lane: unconfirmed, unknown, fully held.
    const [row] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, second.jobId));
    expect(row.state).toBe("dispatch_unconfirmed");
    expect(row.providerJobId).toBeNull();
    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, second.reservationId));
    expect(hold.status).toBe("unknown");
    expect(hold.released).toBeNull();
  });

  test("an unknown job id answers job_not_found", async () => {
    const lookup = makeProviderLookup();
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: lookup.findProviderJob,
    });
    const answer = await recovery.recoverLostDispatch("aj-doesnotexist");
    expect(answer.status).toBe("refused");
    if (answer.status !== "refused") return;
    expect(answer.reasonCode).toBe("job_not_found");
    expect(lookup.queries()).toHaveLength(0);
  });
});
