import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { AuditEventInput } from "../src/audit";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import { createAsyncTerminalSettleService } from "../src/billing/async-terminal";
import { readCapacity } from "../src/billing/capacity";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
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
  asyncJobs,
  creditAsyncSettlementDetails,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import {
  createEnterpriseGatewayPriceSnapshotStore,
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  PRICE_DIMENSIONS,
  type PriceDimension,
} from "../src/gateway/price-snapshot";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.6 (#330) — the async terminal settlement prices the REAL terminal usage at the
 * basis the reservation locked, releases the unused hold, records an over-cap terminal as
 * an anomaly out loud, and writes the line the charge is attributable by task through — on
 * a real PostgreSQL (TEST_DATABASE_URL).
 *
 *   AC-1  结算金额来自真实终态 usage 与锁定版本 — the numbers are the provider's terminal
 *         report priced at the LOCKED snapshot, never the latest prices, never an estimate;
 *   AC-2  未使用额度被释放，用户可用余额恢复 — the settle hands the unused share of the
 *         hold back and the spendable balance recovers;
 *   AC-3  实际超出预留上限时产生异常记录 — the ledger records the full cost, only the held
 *         capacity applies, and `billing.async_settle_over_cap` names the job, cap, exact
 *         cost and overage — nothing truncated, nothing silently appended;
 *   AC-4  消费明细可按任务归因 — the consumption entry shows the async job line: the jobId,
 *         the entries, the terminal state, beside the charge.
 *
 * The amounts are hand-checkable: video is priced at $0.01/unit and 1 credit = $0.01
 * (environment rate ×100, scale ×100), so N units = N credits = N×100 scaled units.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-330-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };
const SEED_BALANCE = 1_000_000;

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

const V1_AMOUNTS: Record<PriceDimension, string> = {
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
  video_input: "0",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

/**
 * The price and usage literals below are hand-written copies of the FULL dimension
 * vocabulary (`V1_AMOUNTS`, `TERMINAL_USAGE`): a complete basis prices every dimension, wire
 * or not. Check the copy against `PRICE_DIMENSIONS` in both directions — missing and
 * unexpected named — so a vocabulary expansion cannot leave this suite's constants behind
 * (R2-F1), silently turning a complete basis into an incomplete one.
 */
function assertFullVocabularyCoverage(
  covered: readonly string[],
  label: string,
): void {
  const coveredSet = new Set<string>(covered);
  const expected = new Set<string>(PRICE_DIMENSIONS);
  const missing = [...expected].filter((dim) => !coveredSet.has(dim)).sort();
  const unexpected = [...coveredSet].filter((dim) => !expected.has(dim)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} drifted from price-snapshot.ts's PRICE_DIMENSIONS: ` +
        `missing [${missing.join(", ")}], ` +
        `unexpected [${unexpected.join(", ")}]`,
    );
  }
}

function dimsOf(amounts: Record<string, string>) {
  assertFullVocabularyCoverage(Object.keys(amounts), "async fixture amounts");
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
  appendSnapshot: (amounts: Record<string, string>) => Promise<void>;
};

let seedCounter = 0;

/** One world: a user with one answered async job whose cap covers `certifiedUnits` video units. */
async function seedJobWorld(certifiedUnits: number): Promise<World> {
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
    displayName: `Terminal Settle Bot ${n}`,
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
    totalCents: SEED_BALANCE,
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
  const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
  const appendSnapshot = async (amounts: Record<string, string>) => {
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
  };
  await appendSnapshot(V1_AMOUNTS);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability,
    state: "open",
    reason: "terminal-settle fixture",
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
    entries: [{ quantities: { video: certifiedUnits } }],
  });
  if (outcome.status !== "submitted")
    throw new Error(`seed submit failed: ${JSON.stringify(outcome)}`);

  return {
    userId,
    grantId,
    customerKey: payerKey({ kind: "personal", id: userId }),
    jobId: outcome.jobId,
    providerJobId,
    reservationId: outcome.reservationId,
    maximumCredits: outcome.maximumCredits,
    appendSnapshot,
  };
}

/** The audit spy: the anomaly write must land, with its facts. */
function makeAuditSpy() {
  const events: AuditEventInput[] = [];
  return {
    events: () => events,
    store: {
      insert: async (event: AuditEventInput) => {
        events.push(event);
      },
    },
  };
}

const TERMINAL_USAGE: Record<PriceDimension, number> = {
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
  surcharge_per_request: 0,
  surcharge_tool_call: 0,
  surcharge_a2a_call: 0,
};

function terminalOf(
  jobId: string,
  overrides: {
    state?: "completed" | "failed" | "cancelled";
    usage?: Record<string, number>;
  } = {},
): {
  jobId: string;
  terminal: {
    state: "completed" | "failed" | "cancelled";
    usage: Record<string, number>;
    evidence: { kind: "provider_usage_report" };
  };
} {
  assertFullVocabularyCoverage(
    Object.keys(TERMINAL_USAGE),
    "async TERMINAL_USAGE",
  );
  return {
    jobId,
    terminal: {
      state: overrides.state ?? "completed",
      usage: { ...TERMINAL_USAGE, ...(overrides.usage ?? {}) },
      evidence: { kind: "provider_usage_report" },
    },
  };
}

function terminalService(audit?: ReturnType<typeof makeAuditSpy>["store"]) {
  return createAsyncTerminalSettleService({
    database,
    environmentRate: ENVIRONMENT_RATE,
    ...(audit !== undefined ? { audit } : {}),
  });
}

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_async_settlement_details WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM async_settle_triggers WHERE job_id IN (SELECT job_id FROM async_jobs WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database.delete(asyncJobs).where(like(asyncJobs.grantId, `${prefix}%`));
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

// ── AC-1/AC-2: real terminal usage, locked version, unused released ─────────────────

describe("17.6 AC-1/AC-2 — the real terminal usage at the locked version", () => {
  test("cap 100, terminal 60: settles 60 exactly, releases the rest, balance recovers", async () => {
    const world = await seedJobWorld(100);
    expect(world.maximumCredits).toBe(10_000); // 100 units × $0.01 = $1 = 100 credits

    // A v2 snapshot with DOUBLED video prices lands before the settle: the lock wins.
    await world.appendSnapshot({ ...V1_AMOUNTS, video: "0.02" });

    const before = await readCapacity(database, world.customerKey);
    expect(before.spendableUnits).toBe(SEED_BALANCE - 10_000);

    const outcome = await terminalService().settleTerminal({
      ...terminalOf(world.jobId),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;

    // 60 units at the LOCKED $0.01 (not v2's $0.02): 60 credits = 6000 scaled, exact.
    expect(outcome.chargedCredits).toBe(6_000);
    expect(outcome.appliedCredits).toBe(6_000);
    expect(outcome.releasedCredits).toBe(4_000);
    expect(outcome.actualCost).toEqual({ numerator: "6000", denominator: "1" });
    expect(outcome.overCap).toBeUndefined();

    // The unused share returned: spendable = seed − applied charge.
    const after = await readCapacity(database, world.customerKey);
    expect(after.spendableUnits).toBe(SEED_BALANCE - 6_000);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.applied).toBe(6_000);
    expect(hold.released).toBe(4_000);

    const [line] = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(line.credits).toBe(6_000);
    expect(line.requestId).toBe(world.jobId);
  });

  test("a failed terminal with real partial usage settles that usage, not zero, not the cap", async () => {
    const world = await seedJobWorld(100);
    const outcome = await terminalService().settleTerminal({
      ...terminalOf(world.jobId, { state: "failed", usage: { video: 10 } }),
      source: "notification",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;
    expect(outcome.chargedCredits).toBe(1_000);
    expect(outcome.releasedCredits).toBe(9_000);
  });
});

// ── AC-3: over the cap is an anomaly, out loud ──────────────────────────────────────

describe("17.6 AC-3 — a terminal over the cap records the anomaly", () => {
  test("cap 100, terminal 250: full cost in the ledger, applied capped, audit names it", async () => {
    const world = await seedJobWorld(100);
    const audit = makeAuditSpy();

    const outcome = await terminalService(audit.store).settleTerminal({
      ...terminalOf(world.jobId, { usage: { video: 250 } }),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    if (outcome.status !== "settled") return;

    // The ledger records the REAL cost in full (250 credits)… but only the held capacity
    // applies (100 credits) — nothing silently truncated, nothing charged beyond the hold.
    expect(outcome.chargedCredits).toBe(25_000);
    expect(outcome.appliedCredits).toBe(10_000);
    expect(outcome.releasedCredits).toBe(0);
    expect(outcome.overCap).toBeDefined();
    if (outcome.overCap === undefined) return;
    expect(outcome.overCap.maximumCredits).toBe(10_000);
    expect(outcome.overCap.actualCost).toEqual({
      numerator: "25000",
      denominator: "1",
    });
    expect(outcome.overCap.overBy).toEqual({
      numerator: "15000",
      denominator: "1",
    });

    // The anomaly row: one closed-vocabulary event with the job's own facts.
    expect(audit.events()).toHaveLength(1);
    const event = audit.events()[0];
    expect(event?.eventType).toBe("billing.async_settle_over_cap");
    expect(event?.targetType).toBe("async_job");
    expect(event?.targetId).toBe(world.jobId);
    expect(event?.payload).toMatchObject({
      jobId: world.jobId,
      reservationId: world.reservationId,
      maximumCredits: 10_000,
      overBy: { numerator: "15000", denominator: "1" },
    });

    const [line] = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.externalCustomerId, world.customerKey));
    expect(line.credits).toBe(25_000);
    expect(line.applied).toBe(10_000);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, world.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.applied).toBe(10_000);
    expect(hold.released).toBe(0);

    // A convergent replay of the SAME terminal answers the first result and does not
    // re-anomaly: the trail already names it.
    const replay = await terminalService(audit.store).settleTerminal({
      ...terminalOf(world.jobId, { usage: { video: 250 } }),
      source: "notification",
    });
    expect(replay.status).toBe("settled");
    expect(audit.events()).toHaveLength(1);
  });

  test("a within-cap settle writes no anomaly", async () => {
    const world = await seedJobWorld(100);
    const audit = makeAuditSpy();
    const outcome = await terminalService(audit.store).settleTerminal({
      ...terminalOf(world.jobId),
      source: "poll",
    });
    expect(outcome.status).toBe("settled");
    expect(audit.events()).toHaveLength(0);
  });
});

// ── AC-4: the consumption detail is attributable by task ────────────────────────────

describe("17.6 AC-4 — the consumption entry names its job", () => {
  test("the detail row and the consumption view both carry the job attribution", async () => {
    const world = await seedJobWorld(100);
    await terminalService().settleTerminal({
      ...terminalOf(world.jobId),
      source: "poll",
    });

    const [detail] = await database
      .select()
      .from(creditAsyncSettlementDetails)
      .where(eq(creditAsyncSettlementDetails.jobId, world.jobId));
    expect(detail).toBeDefined();
    expect(detail.reservationId).toBe(world.reservationId);
    expect(detail.capability).toBe("video");
    expect(detail.providerJobId).toBe(world.providerJobId);
    expect(detail.entryCount).toBe(1);
    expect(detail.terminalState).toBe("completed");
    // The usage map stored as the object it is (the driver's string-scalar trap fenced).
    const usage = detail.actualUsage as Record<string, unknown>;
    expect(typeof usage).toBe("object");
    expect(usage.video).toBe(60);

    // The public boundary: the user's own consumption read shows the async line.
    const credits = createCredits({
      database,
      externalCustomerKey: world.customerKey,
      catalog: new Map(),
    });
    const page = await credits.consumption(
      { from: null, to: null, page: 1 },
      { kind: "personal", id: world.userId },
    );
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    expect(entry.requestId).toBe(world.jobId);
    expect(entry.lineDetail).toMatchObject({
      kind: "async_job",
      capability: "video",
      asyncJob: {
        jobId: world.jobId,
        providerJobId: world.providerJobId,
        entryCount: 1,
        terminalState: "completed",
      },
    });
  });
});
