import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  asyncTerminalSettleKey,
  createAsyncTerminalSettleService,
  readAsyncSettleTrigger,
} from "../src/billing/async-terminal";
import { createAsyncJobStatusService } from "../src/billing/async-job-status";
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
 * Ticket 17.5 (#329) — the duplicate GET and the completion notification settle exactly
 * once, on a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  重复查询不触发结算 — the status query (17.4) is SELECT-only; settlement fires
 *         only on the background terminal lane;
 *   AC-2  重复完成通知只结算一次 — three notifications of the same terminal produce ONE
 *         ledger row and one settlement;
 *   AC-3  通知与轮询两条路径收敛为同一笔结算 — ten polls and three notifications of the
 *         SAME terminal converge on ONE settlement under ONE unified idempotency key
 *         (jobId + terminal version), concurrent or sequential;
 *   AC-4  结算触发次数与来源可观测 — the trigger row counts total/poll/notification and
 *         records the unified key, readable per job.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-329-${randomUUID().slice(0, 8)}`;
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
  video_input: "0.0001",
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
  customerKey: string;
  jobId: string;
  providerJobId: string;
  reservationId: string;
  maximumCredits: number;
};

let seedCounter = 0;

/** One world: one user with one answered async job, hold fully occupied. */
async function seedJobWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "video";
  const providerJobId = `prov-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Settle Once Bot ${n}`,
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
    reason: "settle-once fixture",
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
    dispatch: async () => ({ kind: "answered", providerJobId }),
    resolveBasis,
  });
  const outcome = await submitService.submit({
    submitIdempotencyKey: `${prefix}-submit-${n}`,
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
    customerKey: payerKey({ kind: "personal", id: userId }),
    jobId: outcome.jobId,
    providerJobId,
    reservationId: outcome.reservationId,
    maximumCredits: outcome.maximumCredits,
  };
}

/** The terminal report the fake provider answers: completed, with real usage numbers. */
const TERMINAL_USAGE = {
  input: 0,
  output: 0,
  reasoning: 0,
  image: 0,
  image_output: 0,
  audio_input: 0,
  audio_output: 0,
  cache_read: 0,
  cache_write: 0,
  video: 60,
  video_input: 0,
  surcharge_web_search: 0,
  surcharge_per_request: 1,
  surcharge_tool_call: 0,
  surcharge_a2a_call: 0,
} as const;

function terminalOf(jobId: string, overrides: Record<string, number> = {}) {
  return {
    jobId,
    terminal: {
      state: "completed" as const,
      usage: { ...TERMINAL_USAGE, ...overrides },
      evidence: { kind: "provider_usage_report" as const, reference: undefined },
    },
  };
}

const terminal = createAsyncTerminalSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});
const status = createAsyncJobStatusService({ database });

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_async_settlement_details WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM async_settle_triggers WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
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

// ── AC-1: the query path never settles ──────────────────────────────────────────────

describe("17.5 AC-1 — repeated queries do not settle", () => {
  test("twenty status queries: no trigger row, no ledger row, hold unchanged", async () => {
    const world = await seedJobWorld();
    for (let i = 0; i < 20; i += 1) {
      const answer = await status.queryStatus({
        grantId: world.grantId,
        providerJobId: world.providerJobId,
      });
      expect(answer.kind).toBe("answered");
    }
    expect(await readAsyncSettleTrigger(database, world.jobId)).toBeUndefined();
    const ledger = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledger).toHaveLength(0);
    const [hold] = await database
      .select({ status: creditReservations.status })
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("reserved");
  });
});

// ── AC-2/AC-3: both lanes, one settlement, one key ──────────────────────────────────

describe("17.5 AC-2/AC-3 — ten polls and three notifications settle once", () => {
  test("concurrent triggers converge on one settlement with one unified key", async () => {
    const world = await seedJobWorld();
    const report = terminalOf(world.jobId);
    const expectedKey = asyncTerminalSettleKey(world.jobId, report.terminal);

    const calls = [
      ...Array.from({ length: 10 }, () =>
        terminal.settleTerminal({ ...report, source: "poll" as const }),
      ),
      ...Array.from({ length: 3 }, () =>
        terminal.settleTerminal({ ...report, source: "notification" as const }),
      ),
    ];
    const answers = await Promise.all(calls);

    for (const answer of answers) {
      expect(answer.status).toBe("settled");
      if (answer.status !== "settled") return;
      expect(answer.reservationId).toBe(world.reservationId);
    }

    // ONE ledger row: the settlement happened exactly once.
    const ledger = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledger).toHaveLength(1);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.applied).not.toBeNull();

    // The observability row: 13 triggers, 10 poll + 3 notification, the unified key.
    const trigger = await readAsyncSettleTrigger(database, world.jobId);
    expect(trigger).toBeDefined();
    if (trigger === undefined) return;
    expect(trigger.totalTriggers).toBe(13);
    expect(trigger.pollTriggers).toBe(10);
    expect(trigger.notificationTriggers).toBe(3);
    expect(trigger.idempotencyKey).toBe(expectedKey);
    expect(["poll", "notification"]).toContain(trigger.lastSource);
  });

  test("a trigger by providerJobId (the notification's own key) settles the same job", async () => {
    const world = await seedJobWorld();
    const byProvider = await terminal.settleTerminal({
      providerJobId: world.providerJobId,
      terminal: terminalOf(world.jobId).terminal,
      source: "notification",
    });
    expect(byProvider.status).toBe("settled");
    if (byProvider.status !== "settled") return;
    expect(byProvider.jobId).toBe(world.jobId);
    const notificationNumbers = {
      charged: byProvider.chargedCredits,
      applied: byProvider.appliedCredits,
      released: byProvider.releasedCredits,
    };

    // The poll lane arrives afterwards, by local id: the same settlement's first result,
    // answered again — same numbers, and the counters show BOTH lanes converged.
    const byJob = await terminal.settleTerminal({
      ...terminalOf(world.jobId),
      source: "poll",
    });
    expect(byJob.status).toBe("settled");
    if (byJob.status !== "settled") return;
    expect(byJob.chargedCredits).toBe(notificationNumbers.charged);
    expect(byJob.appliedCredits).toBe(notificationNumbers.applied);
    expect(byJob.releasedCredits).toBe(notificationNumbers.released);
    expect(byJob.trigger.totalTriggers).toBe(2);
    expect(byJob.trigger.notificationTriggers).toBe(1);
    expect(byJob.trigger.pollTriggers).toBe(1);

    const ledger = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledger).toHaveLength(1);
  });

  test("an amended terminal report (different usage) refuses, never tops up", async () => {
    const world = await seedJobWorld();
    const first = await terminal.settleTerminal({
      ...terminalOf(world.jobId),
      source: "poll",
    });
    expect(first.status).toBe("settled");

    const amended = await terminal.settleTerminal({
      ...terminalOf(world.jobId, { video: 120 }),
      source: "notification",
    });
    expect(amended.status).toBe("refused");
    if (amended.status !== "refused") return;
    expect(amended.reasonCode).toBe("settlement_conflict");

    // Still one ledger row — the first terminal fact stands.
    const ledger = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(ledger).toHaveLength(1);
  });
});

// ── AC-4: the counts are readable ───────────────────────────────────────────────────

describe("17.5 AC-4 — the trigger counts are observable", () => {
  test("the unified key is a pure function of the job and the terminal facts", async () => {
    const world = await seedJobWorld();
    const report = terminalOf(world.jobId);
    const key = asyncTerminalSettleKey(world.jobId, report.terminal);
    // Same terminal facts, same key — regardless of which lane computes it.
    expect(asyncTerminalSettleKey(world.jobId, report.terminal)).toBe(key);
    // A different job, or different terminal facts, is a different version.
    const otherWorld = await seedJobWorld();
    expect(asyncTerminalSettleKey(otherWorld.jobId, report.terminal)).not.toBe(key);
    expect(
      asyncTerminalSettleKey(world.jobId, terminalOf(world.jobId, { video: 30 }).terminal),
    ).not.toBe(key);

    // And the recorded key equals the computed one after a real settle.
    await terminal.settleTerminal({ ...report, source: "poll" });
    const trigger = await readAsyncSettleTrigger(database, world.jobId);
    expect(trigger?.idempotencyKey).toBe(key);
  });

  test("a job that never settled has no trigger row; a missing job refuses", async () => {
    const world = await seedJobWorld();
    expect(await readAsyncSettleTrigger(database, world.jobId)).toBeUndefined();
    const answer = await terminal.settleTerminal({
      ...terminalOf("aj-doesnotexist"),
      source: "poll",
    });
    expect(answer.status).toBe("refused");
    if (answer.status !== "refused") return;
    expect(answer.reasonCode).toBe("job_not_found");
  });
});
