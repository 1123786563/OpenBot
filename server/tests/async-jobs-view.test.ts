import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  asyncJobDisplayStateOf,
  createAsyncJobsViewService,
} from "../src/billing/async-jobs-view";
import { createAsyncCancelService } from "../src/billing/async-cancel";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  createAsyncTerminalSettleService,
} from "../src/billing/async-terminal";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
import {
  createBillingAdminRoutes,
  createBillingCreditRoutes,
} from "../src/billing/routes";
import { createCredits } from "../src/billing/credits";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createDatabase, type Database } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
} from "../src/db/schema";
import { asyncJobs } from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.8 (#332) — the async jobs view's own contract, on a real PostgreSQL: the code
 * table 17.1–17.7's implementation holds, the amounts in the ledger's ×100 integers, the
 * attribution frozen at creation, and the two doors that read it (the person's own list and
 * the administrator's review) keeping their own rules.
 *
 *   AC-1  用户看到本人任务的状态、原因与金额 — each of the five row states renders with its
 *         reason and its cap/settled/pending amounts;
 *   AC-2  Key 到期后任务仍显示原归属账户 — a revoked grant changes nothing the view shows:
 *         the attribution is the job row's own frozen grant/payer;
 *   AC-3  待结算任务显示可理解原因 — the unknown hold's own reason (the money lane's word)
 *         rides the row;
 *   AC-4  他人任务不可见，管理员访问走审计路径 — the personal read is scoped to the session's
 *         own payer and writes nothing; the admin review is read-only, filtered by the task
 *         dimensions, and both its denial and its read land an audit row.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-332-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };
const deploymentKey = `openbot-personal-${prefix}`;

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});
const terminalService = createAsyncTerminalSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
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
  video_input: "0.002",
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

function makeAudit() {
  const events: {
    eventType: string;
    payload: Record<string, unknown>;
  }[] = [];
  return {
    events,
    store: {
      insert: async (event: { eventType: string; payload: Record<string, unknown> }) => {
        events.push({ eventType: event.eventType, payload: event.payload });
      },
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
  jobId: string;
  reservationId: string;
  maximumCredits: number;
};

let seedCounter = 0;

async function seedJobWorld(options: { dispatch?: "answer" | "lose" } = {}): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "video";
  const submitKey = `${prefix}-submit-${n}`;
  const providerJobId = `${prefix}-provjob-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `View Bot ${n}`,
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
    reason: "jobs-view fixture",
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
  if (outcome.status !== "submitted") {
    throw new Error(`seed submit failed: ${JSON.stringify(outcome)}`);
  }
  return {
    userId,
    grantId,
    jobId: outcome.jobId,
    reservationId: outcome.reservationId,
    maximumCredits: outcome.maximumCredits,
  };
}

/** Move a world's job to a terminal settle with 25 video seconds billed. */
async function settleWorld(world: World) {
  const usage = Object.fromEntries(
    Object.keys(V1_AMOUNTS).map((dimension) => [
      dimension,
      dimension === "video" ? 25 : dimension === "surcharge_per_request" ? 1 : 0,
    ]),
  );
  const settled = await terminalService.settleTerminal({
    jobId: world.jobId,
    terminal: { state: "completed", usage: usage as never },
    source: "poll",
  });
  expect(settled.status).toBe("settled");
}

/** Cancel a world's job through 17.7's own lane, with the scripted provider outcome. */
async function cancelWorld(world: World, outcome: unknown) {
  const service = createAsyncCancelService({
    database,
    cancelAtProvider: async () => outcome as never,
  });
  const result = await service.cancelJob({
    grantId: world.grantId,
    cancelIdempotencyKey: `${world.jobId}-view-cancel`,
    jobId: world.jobId,
  });
  expect(result.status).toBe("answered");
}

const view = createAsyncJobsViewService({ database });

/** The session guard as a switch: the given actor, or nobody. */
function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

function actorOf(world: World, role: "user" | "admin" = "user"): AuthenticatedActor {
  return {
    id: world.userId,
    email: `${world.userId}@example.test`,
    name: null,
    image: null,
    role: role === "admin" ? "admin" : "member",
  } as AuthenticatedActor;
}

afterAll(async () => {
  // The run's own rows go, cancellation rows first (the FK's order); the shared pool
  // stays for the process.
  await database.execute(
    sql`DELETE FROM async_settle_triggers WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM credit_async_settlement_details WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM async_job_cancellations WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.delete(asyncJobs).where(like(asyncJobs.grantId, `${prefix}%`));
});

describe("17.8 — the code table is derived from the facts 17.1–17.7 hold", () => {
  test("every display state names the facts that produce it", () => {
    expect(
      asyncJobDisplayStateOf({
        dispatchState: "submitted",
        holdStatus: "reserved",
        unknownReason: null,
        cancelConclusion: null,
      }),
    ).toEqual({ status: "running", statusReason: null });

    expect(
      asyncJobDisplayStateOf({
        dispatchState: "dispatch_unconfirmed",
        holdStatus: "unknown",
        unknownReason: "async_dispatch_answer_lost",
        cancelConclusion: null,
      }),
    ).toEqual({ status: "queued", statusReason: "async_dispatch_answer_lost" });

    expect(
      asyncJobDisplayStateOf({
        dispatchState: "submitted",
        holdStatus: "unknown",
        unknownReason: "async_cancel_result_unknown",
        cancelConclusion: "hold_unknown",
      }),
    ).toEqual({
      status: "pending-settlement",
      statusReason: "async_cancel_result_unknown",
    });

    expect(
      asyncJobDisplayStateOf({
        dispatchState: "submitted",
        holdStatus: "settled",
        unknownReason: null,
        cancelConclusion: null,
      }),
    ).toEqual({ status: "settled", statusReason: null });

    expect(
      asyncJobDisplayStateOf({
        dispatchState: "submitted",
        holdStatus: "released",
        unknownReason: null,
        cancelConclusion: "released_on_evidence",
      }),
    ).toEqual({
      status: "cancelled",
      statusReason: "released on the provider's unbilled cancellation confirmation",
    });
  });
});

describe("17.8 AC-1/AC-3 — the person's own jobs: state, reason, amounts", () => {
  test("running, queued, pending-settlement, settled and cancelled all render from real rows", async () => {
    const running = await seedJobWorld();
    const queued = await seedJobWorld({ dispatch: "lose" });
    const pending = await seedJobWorld();
    await cancelWorld(pending, { kind: "result_unknown", detail: "timeout" });
    const settled = await seedJobWorld();
    await settleWorld(settled);
    const cancelled = await seedJobWorld();
    await cancelWorld(cancelled, {
      kind: "succeeded_unbilled_evidenced",
      evidenceReference: `${cancelled.jobId}-receipt`,
    });

    const byState = new Map(
      (await view.asyncJobsForPayer({ kind: "personal", id: running.userId })).map(
        (row) => [row.jobId, row],
      ),
    );
    // The five states share one payer (distinct worlds per state but one read): read each
    // world's payer separately to keep the ownership story simple, then assert by jobId.
    for (const world of [running, queued, pending, settled, cancelled]) {
      const rows = await view.asyncJobsForPayer({
        kind: "personal",
        id: world.userId,
      });
      expect(rows).toHaveLength(1);
      byState.set(world.jobId, rows[0]);
    }

    const runningRow = byState.get(running.jobId)!;
    expect(runningRow.status).toBe("running");
    expect(runningRow.statusReason).toBeNull();
    expect(runningRow.maximumCents).toBe(running.maximumCredits);
    expect(runningRow.settledCents).toBe(0);
    expect(runningRow.pendingCents).toBe(running.maximumCredits);

    const queuedRow = byState.get(queued.jobId)!;
    expect(queuedRow.status).toBe("queued");
    expect(queuedRow.statusReason).toBe("async_dispatch_answer_lost");
    expect(queuedRow.pendingCents).toBe(queued.maximumCredits);

    const pendingRow = byState.get(pending.jobId)!;
    expect(pendingRow.status).toBe("pending-settlement");
    expect(pendingRow.statusReason).toBe("async_cancel_result_unknown");
    expect(pendingRow.pendingCents).toBe(pending.maximumCredits);

    const settledRow = byState.get(settled.jobId)!;
    expect(settledRow.status).toBe("settled");
    expect(settledRow.settledCents).toBeGreaterThan(0);
    expect(settledRow.settledCents).toBeLessThan(settled.maximumCredits);
    expect(settledRow.pendingCents).toBe(0);

    const cancelledRow = byState.get(cancelled.jobId)!;
    expect(cancelledRow.status).toBe("cancelled");
    expect(cancelledRow.settledCents).toBe(0);
    expect(cancelledRow.pendingCents).toBe(0);
  });

  test("the amounts are the ledger's ×100 integers and the model rides the row", async () => {
    const world = await seedJobWorld();
    const [row] = await view.asyncJobsForPayer({
      kind: "personal",
      id: world.userId,
    });
    expect(row.model).toMatchObject({ capability: "video" });
    expect(Number.isInteger(row.maximumCents)).toBe(true);
    expect(row.createdAt).toEqual(expect.any(String));
    expect(row.dispatchedAt).toEqual(expect.any(String));
  });
});

describe("17.8 AC-2 — a key that died after the submit changes nothing the view shows", () => {
  test("a revoked grant keeps the original attribution", async () => {
    const world = await seedJobWorld();
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));
    const [row] = await view.asyncJobsForPayer({
      kind: "personal",
      id: world.userId,
    });
    expect(row.attribution).toEqual({
      grantId: world.grantId,
      payerKind: "personal",
      payerId: world.userId,
    });
    expect(row.status).toBe("running");
    expect(row.pendingCents).toBe(world.maximumCredits);
  });
});

describe("17.8 AC-4 — the doors keep their own rules", () => {
  function writeCountingDatabase(target: Database): { database: Database; writes: string[] } {
    const writes: string[] = [];
    const proxy = new Proxy(target, {
      get(object, property) {
        if (
          property === "insert" ||
          property === "update" ||
          property === "delete" ||
          property === "insertOnConflict"
        ) {
          return (...args: unknown[]) => {
            writes.push(String(property));
            return (object as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[property](...args);
          };
        }
        const value = Reflect.get(object, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { database: proxy as Database, writes };
  }

  test("the personal route answers the session's own jobs only, and writes nothing", async () => {
    const mine = await seedJobWorld();
    const theirs = await seedJobWorld();
    const counted = writeCountingDatabase(database);
    const credits = createCredits({
      database: counted.database,
      externalCustomerKey: deploymentKey,
      catalog: new Map(),
    });
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({
        credits,
        requireUser: requireUserAs(actorOf(mine)),
        asyncJobsView: createAsyncJobsViewService({ database: counted.database }),
      }),
    );
    const response = await app.request("/api/billing/credits/async-jobs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: { jobId: string }[] };
    expect(body.jobs.map((job) => job.jobId)).toEqual([mine.jobId]);
    expect(counted.writes).toEqual([]);
    void theirs;
  });

  test("an account-naming query parameter is refused, never filtered", async () => {
    const mine = await seedJobWorld();
    const credits = createCredits({
      database,
      externalCustomerKey: deploymentKey,
      catalog: new Map(),
    });
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({
        credits,
        requireUser: requireUserAs(actorOf(mine)),
        asyncJobsView: view,
      }),
    );
    const response = await app.request(
      "/api/billing/credits/async-jobs?userId=someone-else",
    );
    expect(response.status).toBe(400);
  });

  test("the admin review: read-only, task-dimension filters, denial and read audited", async () => {
    const running = await seedJobWorld();
    const cancelled = await seedJobWorld();
    await cancelWorld(cancelled, {
      kind: "succeeded_unbilled_evidenced",
      evidenceReference: `${cancelled.jobId}-receipt`,
    });
    const adminActor = actorOf(running, "admin");
    const audit = makeAudit();
    // requireAdmin's own shape: takes the context, answers a denial or nothing — the
    // route continues itself, so an allowed answer is simply undefined.
    const requireAdmin =
      (allowed: boolean) =>
      (
        context: Context<{ Variables: AppVariables }>,
      ): Context<{ Variables: AppVariables }>["res"] | undefined =>
        allowed ? undefined : context.json({ error: "Administrator access required." }, 403);
    const adminApp = (allowed: boolean) =>
      new Hono<{ Variables: AppVariables }>().route(
        "/api/admin/billing",
        createBillingAdminRoutes({
          service: { entitlements: async () => ({ active: [], codes: [] }) } as never,
          requireUser: requireUserAs(adminActor),
          requireAdmin: requireAdmin(allowed),
          externalCustomerKey: deploymentKey,
          customerName: "view-test",
          asyncJobsView: view,
          audit: audit.store as never,
        }),
      );

    // A non-administrator probe: denied, audited, nothing shown.
    const denied = await adminApp(false).request("/api/admin/billing/async-jobs");
    expect(denied.status).toBe(403);
    expect(audit.events.map((event) => event.eventType)).toEqual([
      "billing.async_jobs.review_denied",
    ]);

    // The admin read: cross-payer rows, the task filters answer, the read is audited.
    const all = await adminApp(true).request("/api/admin/billing/async-jobs");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      jobs: { jobId: string; attribution: { payerId: string } }[];
    };
    expect(allBody.jobs.map((job) => job.jobId)).toContain(running.jobId);
    expect(allBody.jobs.map((job) => job.jobId)).toContain(cancelled.jobId);

    // The status filter narrows within the cancelled world's own payer — the review is
    // cross-payer by design, so the assertion scopes itself instead of assuming an
    // otherwise-empty database (other suites' rows live here too).
    const byStatus = await adminApp(true).request(
      `/api/admin/billing/async-jobs?payerId=${cancelled.userId}&status=cancelled`,
    );
    const statusBody = (await byStatus.json()) as { jobs: { jobId: string; status: string }[] };
    expect(statusBody.jobs).toHaveLength(1);
    expect(statusBody.jobs[0]).toMatchObject({
      jobId: cancelled.jobId,
      status: "cancelled",
    });

    const byJob = await adminApp(true).request(
      `/api/admin/billing/async-jobs?jobId=${running.jobId}`,
    );
    const jobBody = (await byJob.json()) as { jobs: { jobId: string }[] };
    expect(jobBody.jobs.map((job) => job.jobId)).toEqual([running.jobId]);

    const invalid = await adminApp(true).request(
      "/api/admin/billing/async-jobs?status=finished",
    );
    expect(invalid.status).toBe(400);

    expect(audit.events.map((event) => event.eventType)).toEqual([
      "billing.async_jobs.review_denied",
      "billing.async_jobs.review_read",
      "billing.async_jobs.review_read",
      "billing.async_jobs.review_read",
    ]);
    expect(audit.events[1].payload).toMatchObject({
      path: "/api/admin/billing/async-jobs",
      filters: {},
    });
    expect(audit.events[2].payload).toMatchObject({
      filters: { payerId: cancelled.userId, status: "cancelled" },
      resultCount: 1,
    });
  });
});
