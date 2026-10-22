import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  createAsyncJobStatusService,
  asyncJobStatusEndpoints,
} from "../src/billing/async-job-status";
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
import { asyncJobs, creditReservations } from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.4 (#328) — the async job status/result query is a READ-ONLY, ownership-scoped
 * door, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  只有归属账户可查询任务状态与结果 — the grant resolves the payer server-side
 *         and only the owning account's job answers;
 *   AC-2  越权查询被拒绝且不泄露任务存在性 — another account's job, a missing job and
 *         an unresolvable scope all answer the SAME bare not_found;
 *   AC-3  查询不触发预留、结算或供应商派发 — the query is SELECT-only: no ledger row,
 *         no reservation change, no job-row change, ever;
 *   AC-4  管理员访问走既有审计路径 — this surface offers no admin bypass: an
 *         account-naming field is the tamper shape and refuses at the shape boundary.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-328-${randomUUID().slice(0, 8)}`;
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
  jobId: string;
  submitKey: string;
  providerJobId: string;
  reservationId: string;
};

let seedCounter = 0;

/** One world: one user with one submitted (answered) async job. */
async function seedJobWorld(options: { dispatch?: "answer" | "lose" } = {}): Promise<World> {
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
    displayName: `Status Bot ${n}`,
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
    totalCents: 1_000_000,
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
    reason: "status-authz fixture",
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

  const providerJobId = `prov-${n}`;
  const submitService = createAsyncSubmitService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: async () =>
      (options.dispatch ?? "answer") === "answer"
        ? { kind: "answered", providerJobId }
        : { kind: "lost", reason: "response_timeout" },
    resolveBasis,
  });
  const outcome = await submitService.submit({
    submitIdempotencyKey: submitKey,
    grantId,
    payer: { kind: "personal", id: userId },
    model: { provider, model, capability },
    snapshotVersion: 1,
    rateVersion: 0,
    entries: [{ quantities: { video: 60, surcharge_per_request: 1 } }],
  });
  if (outcome.status !== "submitted") throw new Error(`seed submit failed: ${JSON.stringify(outcome)}`);

  return {
    userId,
    grantId,
    provider,
    model,
    customerKey: payerKey({ kind: "personal", id: userId }),
    jobId: outcome.jobId,
    submitKey,
    providerJobId,
    reservationId: outcome.reservationId,
  };
}

/** A second user's grant — a stranger to every seedJobWorld job. */
async function seedStrangerGrant(): Promise<{ grantId: string; userId: string }> {
  const n = ++seedCounter;
  const userId = `${prefix}-stranger-${n}`;
  const botId = `${prefix}-strangerbot-${n}`;
  const grantId = `${prefix}-strangergrant-${n}`;
  await database.insert(botServices).values({
    botId,
    displayName: `Stranger Bot ${n}`,
    kind: "external",
    capabilities: ["async"],
    status: "active",
  });
  await database.insert(accessGrants).values({
    grantId,
    userId,
    botId,
    externalIdentity: `${prefix}:strext:${n}`,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });
  await createPayerAccount(database, { kind: "personal", id: userId });
  return { grantId, userId };
}

const status = createAsyncJobStatusService({ database });

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

// ── AC-1: the owning account reads its job ──────────────────────────────────────────

describe("17.4 AC-1 — the owner reads the job", () => {
  test("answers by jobId, by submitIdempotencyKey and by providerJobId, all three the same job", async () => {
    const world = await seedJobWorld();
    for (const selector of [
      { jobId: world.jobId },
      { submitIdempotencyKey: world.submitKey },
      { providerJobId: world.providerJobId },
    ]) {
      const answer = await status.queryStatus({ grantId: world.grantId, ...selector });
      expect(answer.kind).toBe("answered");
      if (answer.kind !== "answered") return;
      expect(answer.outcome.status).toBe("found");
      if (answer.outcome.status !== "found") return;
      expect(answer.outcome.job.jobId).toBe(world.jobId);
      expect(answer.outcome.job.providerJobId).toBe(world.providerJobId);
      expect(answer.outcome.job.state).toBe("submitted");
      expect(answer.outcome.job.model.provider).toBe(world.provider);
      expect(answer.outcome.job.reservation.status).toBe("reserved");
      expect(answer.outcome.job.reservation.maximumCredits).toBeGreaterThan(0);
      expect(answer.outcome.job.entryCount).toBe(1);
    }
  });

  test("a lost-dispatch job reads as dispatch_unconfirmed with the hold unknown", async () => {
    const world = await seedJobWorld({ dispatch: "lose" });
    const answer = await status.queryStatus({
      grantId: world.grantId,
      jobId: world.jobId,
    });
    expect(answer.kind).toBe("answered");
    if (answer.kind !== "answered") return;
    expect(answer.outcome.status).toBe("found");
    if (answer.outcome.status !== "found") return;
    expect(answer.outcome.job.state).toBe("dispatch_unconfirmed");
    expect(answer.outcome.job.providerJobId).toBeNull();
    expect(answer.outcome.job.reservation.status).toBe("unknown");
  });

  test("a revoked grant still reads — visibility is not admission (06.7's rule)", async () => {
    const world = await seedJobWorld();
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    const answer = await status.queryStatus({
      grantId: world.grantId,
      jobId: world.jobId,
    });
    expect(answer.kind).toBe("answered");
    if (answer.kind !== "answered") return;
    expect(answer.outcome.status).toBe("found");
  });
});

// ── AC-2: the refusal does not leak existence ───────────────────────────────────────

describe("17.4 AC-2 — a foreign query cannot tell what exists", () => {
  test("another account's job, a missing job and a stranger's unknown key answer identically", async () => {
    const world = await seedJobWorld();
    const stranger = await seedStrangerGrant();

    const foreign = await status.queryStatus({
      grantId: stranger.grantId,
      jobId: world.jobId,
    });
    const foreignBySubmitKey = await status.queryStatus({
      grantId: stranger.grantId,
      submitIdempotencyKey: world.submitKey,
    });
    const missing = await status.queryStatus({
      grantId: stranger.grantId,
      jobId: "aj-doesnotexist",
    });
    const noGrant = await status.queryStatus({
      grantId: "grant-doesnotexist",
      jobId: world.jobId,
    });

    // All four answers are the SAME bare refusal — no field differs, so nothing about
    // which jobs exist under another account can be inferred from the answer's shape.
    expect(foreign).toEqual({ kind: "answered", outcome: { status: "not_found" } });
    expect(foreignBySubmitKey).toEqual(foreign);
    expect(missing).toEqual(foreign);
    expect(noGrant).toEqual(foreign);
  });

  test("two selectors at once, or none, refuse at the shape boundary", async () => {
    const world = await seedJobWorld();
    const both = await status.queryStatus({
      grantId: world.grantId,
      jobId: world.jobId,
      submitIdempotencyKey: world.submitKey,
    });
    expect(both.kind).toBe("refused");
    if (both.kind !== "refused") return;
    expect(both.reasonCode).toBe("request_invalid");

    const neither = await status.queryStatus({ grantId: world.grantId });
    expect(neither.kind).toBe("refused");
  });
});

// ── AC-3: the query moves nothing ───────────────────────────────────────────────────

describe("17.4 AC-3 — the query is read-only", () => {
  test("twenty queries leave no ledger row, no reservation change, no job-row change", async () => {
    const world = await seedJobWorld();
    const stranger = await seedStrangerGrant();

    const ledgerBefore = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    const reservationBefore = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    const jobBefore = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, world.jobId));

    for (let i = 0; i < 20; i += 1) {
      await status.queryStatus({ grantId: world.grantId, jobId: world.jobId });
      await status.queryStatus({
        grantId: stranger.grantId,
        jobId: world.jobId,
      });
    }

    const ledgerAfter = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    const reservationAfter = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    const jobAfter = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, world.jobId));

    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(reservationAfter).toEqual(reservationBefore);
    expect(jobAfter).toEqual(jobBefore);
  });
});

// ── AC-4: no admin bypass on this surface ───────────────────────────────────────────

describe("17.4 AC-4 — an account-naming field is the tamper shape", () => {
  test("a self-reported account key refuses as payer_conflict before any read", async () => {
    const world = await seedJobWorld();
    const answer = await status.queryStatus({
      grantId: world.grantId,
      jobId: world.jobId,
      userId: `${prefix}-someone-else`,
    });
    expect(answer.kind).toBe("refused");
    if (answer.kind !== "refused") return;
    expect(answer.reasonCode).toBe("payer_conflict");
  });

  test("the endpoint answers a found job 200 and a refusal 422, uniform", async () => {
    const world = await seedJobWorld();
    const stranger = await seedStrangerGrant();
    const app = asyncJobStatusEndpoints({ service: status });

    const own = await app.request("/async/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantId: world.grantId, jobId: world.jobId }),
    });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { status: string };
    expect(ownBody.status).toBe("found");

    const foreign = await app.request("/async/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantId: stranger.grantId, jobId: world.jobId }),
    });
    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as { status: string };
    expect(foreignBody).toEqual({ status: "not_found" });

    const tamper = await app.request("/async/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId: world.grantId,
        jobId: world.jobId,
        accountId: "someone-else",
      }),
    });
    expect(tamper.status).toBe(422);
    const tamperBody = (await tamper.json()) as { code: string };
    expect(tamperBody.code).toBe("payer_conflict");
  });
});
