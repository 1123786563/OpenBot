import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  attachAsyncJobProviderId,
  listAsyncJobsByGrant,
  readAsyncJob,
  readAsyncJobByProviderJobId,
} from "../src/billing/async-job-identity";
import {
  createCreditReserveService,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
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
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.1 (#325) — the async job's durable identity, on a real PostgreSQL
 * (TEST_DATABASE_URL). The row is 17.2's (0188); this suite pins THIS ticket's own
 * additions: the identity reads (local, reverse, per-grant) and the late-answer attach.
 *
 *   AC-1  every async job has a stable local identity and fixed attribution: the submit
 *         path freezes grant/payer/model/versions and the identity read answers them;
 *   AC-2  providerJobID ↔ local jobId maps both ways, absence tolerated: a lost dispatch
 *         answer leaves the row unconfirmed with the hold occupied, and a late answer
 *         attaches without moving anything else;
 *   AC-3  attribution survives the surroundings: a revoked grant (the key-expiry lane)
 *         and a replay under a different caller leave the job's facts byte-identical;
 *   AC-4  the row carries what recovery needs: reservation id, locked versions and the
 *         certified cap — resolvable against the same locked basis.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-325-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** Every dimension priced known (the closed set as of this suite's basis). */
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

/** The dispatch seam: `answer` names a provider job id, `lose` drops the answer. */
function makeDispatch(behavior: "answer" | "lose") {
  let calls = 0;
  const dispatch = async (_input: { jobId: string }) => {
    calls += 1;
    return behavior === "answer"
      ? ({ kind: "answered", providerJobId: `prov-job-325-${++dispatchCounter}` } as const)
      : ({ kind: "lost", reason: "response_timeout" } as const);
  };
  return { dispatch, calls: () => calls };
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
  submitKey: string;
};

let seedCounter = 0;

async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "video";

  await database.insert(botServices).values({
    botId,
    displayName: `Identity Bot ${n}`,
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
    totalCents: 10_000_00,
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
    reason: "identity fixture",
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
    submitKey: `${prefix}-submit-${n}`,
  };
}

function submitBody(world: World, overrides: Record<string, unknown> = {}) {
  return {
    submitIdempotencyKey: world.submitKey,
    grantId: world.grantId,
    payer: { kind: "personal", id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "video",
    },
    snapshotVersion: 1,
    rateVersion: 0,
    entries: [{ quantities: { video: 60, surcharge_per_request: 1 } }],
    ...overrides,
  };
}

afterAll(async () => {
  await database.delete(asyncJobs).where(like(asyncJobs.grantId, `${prefix}%`));
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
  await database.delete(accessGrants).where(like(accessGrants.grantId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database.delete(gatewayModelCatalogRefs).where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  await database.delete(gatewayModelOpenScopes).where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
});

describe("B17.1 (#325) async job identity", () => {
  test("AC-1 a submitted job has a stable local identity with frozen attribution", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(submitBody(world));
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;

    const view = await readAsyncJob(database, outcome.jobId);
    expect(view).toBeDefined();
    if (view === undefined) return;
    // The local identity's own shape — recognisable on sight, like the reservation's cr-.
    expect(view.jobId.startsWith("aj-")).toBe(true);
    // The attribution facts are the RESOLVED ones, frozen at creation: the payer is the
    // grant's own user (never the request's spelling), the grant and model cell as
    // submitted, both locked versions carried.
    expect(view.payer).toEqual({ kind: "personal", id: world.userId });
    expect(view.grantId).toBe(world.grantId);
    expect(view.model).toEqual({
      provider: world.provider,
      model: world.model,
      capability: "video",
    });
    expect(view.providerJobId).not.toBeNull();
    expect(view.state).toBe("submitted");
    expect(view.dispatchedAt).not.toBeNull();

    // The reverse mapping answers the same row.
    const reverse = await readAsyncJobByProviderJobId(
      database,
      view.providerJobId as string,
    );
    expect(reverse?.jobId).toBe(view.jobId);
    expect(reverse?.payer).toEqual(view.payer);

    // The per-grant read (the recovery sweep's walk) finds it too.
    const byGrant = await listAsyncJobsByGrant(database, world.grantId);
    expect(byGrant.map((job) => job.jobId)).toContain(view.jobId);
  });

  test("AC-2 a lost dispatch answer tolerates a missing providerJobID, and a late answer attaches", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("lose");
    const outcome = await serviceWith(dispatch).submit(submitBody(world));
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;

    const before = await readAsyncJob(database, outcome.jobId);
    expect(before).toBeDefined();
    if (before === undefined) return;
    expect(before.providerJobId).toBeNull();
    expect(before.state).toBe("dispatch_unconfirmed");
    expect(before.dispatchedAt).toBeNull();

    // Absence is a state, not an error: the reverse lookup answers undefined, and the
    // reservation is still there, still occupied — a missing provider id is never
    // evidence of no cost.
    expect(
      await readAsyncJobByProviderJobId(database, "prov-job-325-never-minted"),
    ).toBeUndefined();
    const [reservation] = await database
      .select({
        id: creditReservations.id,
        charged: creditReservations.charged,
      })
      .from(creditReservations)
      .where(eq(creditReservations.id, before.reservationId))
      .limit(1);
    expect(reservation).toBeDefined();
    expect(reservation?.charged).toBeNull();

    // The late answer (the recovery scan's finding): the attach flips the row to
    // submitted, and both mapping directions answer.
    const attached = await attachAsyncJobProviderId(database, {
      jobId: before.jobId,
      providerJobId: "prov-job-325-late-answer",
      now: () => new Date("2026-10-21T12:00:00Z"),
    });
    expect(attached.status).toBe("attached");
    if (attached.status === "attached") {
      expect(attached.alreadyKnown).toBe(false);
      expect(attached.job.state).toBe("submitted");
      expect(attached.job.providerJobId).toBe("prov-job-325-late-answer");
      expect(attached.job.dispatchedAt).toEqual(new Date("2026-10-21T12:00:00Z"));
    }
    expect(
      (await readAsyncJobByProviderJobId(database, "prov-job-325-late-answer"))
        ?.jobId,
    ).toBe(before.jobId);

    // Re-attaching the same id is idempotent and writes nothing new.
    const again = await attachAsyncJobProviderId(database, {
      jobId: before.jobId,
      providerJobId: "prov-job-325-late-answer",
    });
    expect(again.status).toBe("attached");
    if (again.status === "attached") {
      expect(again.alreadyKnown).toBe(true);
    }

    // A DIFFERENT id on a row that already knows one is a conflict surfaced, never a
    // re-point — the mapping is stable once known.
    const conflict = await attachAsyncJobProviderId(database, {
      jobId: before.jobId,
      providerJobId: "prov-job-325-someone-elses",
    });
    expect(conflict).toMatchObject({
      status: "refused",
      reasonCode: "provider_job_id_conflict",
    });
    const after = await readAsyncJob(database, before.jobId);
    expect(after?.providerJobId).toBe("prov-job-325-late-answer");

    // And an attach for a job that never existed names exactly that.
    expect(
      await attachAsyncJobProviderId(database, {
        jobId: "aj-does-not-exist",
        providerJobId: "prov-job-325-orphan",
      }),
    ).toMatchObject({ status: "refused", reasonCode: "job_not_found" });
  });

  test("AC-3 attribution does not move when the grant is revoked or the caller changes", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(submitBody(world));
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    const frozen = await readAsyncJob(database, outcome.jobId);
    expect(frozen).toBeDefined();
    if (frozen === undefined) return;

    // The key-expiry lane: the grant that created the job is revoked (04.7's status
    // transition — revocation is a status, never a deletion). The job's identity is a
    // fact about the past, and reads answer it unchanged.
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    const afterRevoke = await readAsyncJob(database, frozen.jobId);
    expect(afterRevoke).toEqual(frozen);

    // The caller lane: a replay of the SAME submit key under a different payer claim
    // answers the original job (the idempotency read wins), never re-attributing it.
    const replay = await serviceWith(makeDispatch("answer")).submit(
      submitBody(world, {
        payer: { kind: "personal", id: `${prefix}-someone-else` },
      }),
    );
    expect(replay.status).toBe("submitted");
    if (replay.status !== "submitted") return;
    expect(replay.created).toBe(false);
    expect(replay.jobId).toBe(frozen.jobId);
    const afterReplay = await readAsyncJob(database, frozen.jobId);
    expect(afterReplay?.payer).toEqual(frozen.payer);
    expect(afterReplay?.grantId).toBe(frozen.grantId);

    // The recovery walk still finds the job under its original grant.
    const byGrant = await listAsyncJobsByGrant(database, world.grantId);
    expect(byGrant.map((job) => job.jobId)).toContain(frozen.jobId);
  });

  test("AC-4 the identity carries what recovery needs: reservation, versions, cap", async () => {
    const world = await seedWorld();
    const dispatch = makeDispatch("answer");
    const outcome = await serviceWith(dispatch).submit(submitBody(world));
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    const view = await readAsyncJob(database, outcome.jobId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    // The reservation the job holds exists and carries the SAME locked versions — the
    // version lock is the promise a recovery read re-prices on the original basis.
    expect(view.reservationId.startsWith("cr-")).toBe(true);
    const [reservation] = await database
      .select({
        snapshotVersion: creditReservations.snapshotVersion,
        rateVersion: creditReservations.rateVersion,
        maximum: creditReservations.maximum,
      })
      .from(creditReservations)
      .where(eq(creditReservations.id, view.reservationId))
      .limit(1);
    expect(reservation?.snapshotVersion).toBe(view.snapshotVersion);
    expect(reservation?.rateVersion).toBe(view.rateVersion);
    // The cap the row froze is the hold the reservation actually carries.
    expect(reservation?.maximum).toBe(view.maximumCredits);
    expect(view.maximumCredits).toBeGreaterThan(0);
    expect(view.entryCount).toBe(1);

    // And the locked basis the versions name still resolves — the recovery input set is
    // complete: identity row + reservation + resolvable basis.
    const basis = await resolveBasis({
      provider: view.model.provider,
      model: view.model.model,
      capability: view.model.capability,
      snapshotVersion: view.snapshotVersion,
      rateVersion: view.rateVersion,
    });
    expect(basis.ok).toBe(true);
  });
});
