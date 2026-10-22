import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import {
  createAsyncCancelService,
  type AsyncCancelOutcome,
  type ProviderCancelOutcome,
} from "../src/billing/async-cancel";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import {
  createAsyncJobStatusService,
} from "../src/billing/async-job-status";
import {
  createAsyncTerminalSettleService,
} from "../src/billing/async-terminal";
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
} from "../src/db/schema";
import {
  asyncJobCancellations,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 17.7 (#331) — the async cancellation's money semantics, on a real PostgreSQL
 * (TEST_DATABASE_URL): a cancel request is not a no-charge proof, and nothing but the
 * provider's own unbilled confirmation ever releases the hold.
 *
 *   AC-1  取消失败或结果未知时保持完整预留，不自动释放 — `unsupported`/`failed` leave the
 *         hold held untouched; a cancel whose RESULT is unknown moves the hold to 06.8's
 *         unknown with full capacity still occupied;
 *   AC-2  只有具备明确未计费证据时才释放 — the evidenced cancel releases through the
 *         Release protocol's `no_usage` evidence (the receipt as reference); "取消已接受"
 *         alone releases nothing;
 *   AC-3  Key 到期或客户端离开不触发释放 — a revoked grant changes nothing by itself (the
 *         status read still answers, 17.4's visibility rule), and a cancel whose caller is
 *         gone before the answer lands concludes on the evidence, not the connection;
 *   AC-4  取消动作与结论可审计 — one audit row per landed conclusion, never twice for the
 *         same one; the row and the cancellation record name the evidence the release stood
 *         on.
 *
 * Plus the seam pin: after a cancel-unknown, a real terminal usage report still settles
 * through 17.6's own lane (the writer allows unknown→settled) — the cancel lane never
 * wedges the job's money.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b17-331-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});
const terminalService = createAsyncTerminalSettleService({
  database,
  environmentRate: ENVIRONMENT_RATE,
});
const statusService = createAsyncJobStatusService({ database });

/** Every dimension priced known — video_input included (0202), so seeds never drift. */
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

/** The audit spy — cancellation trails, collected for counting and payload checks. */
function makeAudit() {
  const events: {
    eventType: string;
    targetId?: string;
    payload: Record<string, unknown>;
  }[] = [];
  return {
    events,
    store: {
      insert: async (event: {
        eventType: string;
        targetId?: string;
        payload: Record<string, unknown>;
      }) => {
        events.push({
          eventType: event.eventType,
          targetId: event.targetId,
          payload: event.payload,
        });
      },
    },
  };
}

/** The provider cancel client, answering one scripted outcome per call. */
function scriptedProvider(outcomes: ProviderCancelOutcome[]) {
  const calls: {
    provider: string;
    model: string;
    providerJobId: string | null;
    submitIdempotencyKey: string;
  }[] = [];
  let next = 0;
  return {
    calls,
    cancelAtProvider: async (input: {
      provider: string;
      model: string;
      providerJobId: string | null;
      submitIdempotencyKey: string;
    }) => {
      calls.push(input);
      const outcome = outcomes[Math.min(next, outcomes.length - 1)];
      next += 1;
      return outcome;
    },
  };
}

/** The locked-basis seam, exactly what the submit path resolves from. */
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
  submitKey: string;
  providerJobId: string;
  reservationId: string;
  maximumCredits: number;
};

let seedCounter = 0;

/** One world: one user with one submitted (answered, held) async job. */
async function seedJobWorld(): Promise<World> {
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
    displayName: `Cancel Bot ${n}`,
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
    reason: "cancel-semantics fixture",
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

  const providerJobId = `${prefix}-provjob-${n}`;
  const submitService = createAsyncSubmitService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: async () => ({ kind: "answered", providerJobId }),
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
    customerKey: payerKey({ kind: "personal", id: userId }),
    jobId: outcome.jobId,
    submitKey,
    providerJobId,
    reservationId: outcome.reservationId,
    maximumCredits: outcome.maximumCredits,
  };
}

async function holdOf(reservationId: string) {
  const [hold] = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId))
    .limit(1);
  expect(hold).toBeDefined();
  return hold!;
}

async function cancelRowOf(jobId: string) {
  const [row] = await database
    .select()
    .from(asyncJobCancellations)
    .where(eq(asyncJobCancellations.jobId, jobId))
    .limit(1);
  return row;
}

/** The world's own charge lines — one customer per world, so the count is the world's. */
async function ledgerCountFor(customerKey: string) {
  const rows = await database
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
  return rows.length;
}

function cancelWith(
  provider: ReturnType<typeof scriptedProvider>,
  audit: ReturnType<typeof makeAudit>,
) {
  return createAsyncCancelService({
    database,
    cancelAtProvider: provider.cancelAtProvider,
    audit: audit.store as never,
  });
}

afterAll(async () => {
  // The pool lives for the process (TEST_POOL); nothing to close that the runner does not.
});

describe("17.7 AC-1 — a cancel that fails or cannot be confirmed keeps the full hold", () => {
  test("provider cannot cancel: the hold stays exactly as it was, the conclusion is audited", async () => {
    const world = await seedJobWorld();
    const provider = scriptedProvider([{ kind: "unsupported" }]);
    const audit = makeAudit();
    const service = cancelWith(provider, audit);

    const outcome: AsyncCancelOutcome = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      status: "answered",
      asked: true,
      providerCancelResult: "unsupported",
      conclusion: "hold_kept",
    });

    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("reserved");
    expect(hold.applied).toBeNull();
    expect(hold.released).toBeNull();
    expect(hold.unknownReason ?? null).toBeNull();
    expect(await ledgerCountFor(world.customerKey)).toBe(0);
    expect(provider.calls).toHaveLength(1);

    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      providerCancelResult: "unsupported",
      conclusion: "hold_kept",
      releasedCredits: null,
      evidenceKind: null,
      requests: 1,
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      eventType: "billing.async_job_cancelled",
      targetId: world.jobId,
      payload: { providerCancelResult: "unsupported", conclusion: "hold_kept" },
    });
  });

  test("cancel result unknown: the hold moves to 06.8's unknown — full capacity still occupied", async () => {
    const world = await seedJobWorld();
    const provider = scriptedProvider([
      { kind: "result_unknown", detail: "transport timeout" },
    ]);
    const audit = makeAudit();
    const service = cancelWith(provider, audit);

    const outcome = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      status: "answered",
      providerCancelResult: "result_unknown",
      conclusion: "hold_unknown",
    });

    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("unknown");
    expect(hold.unknownReason).toBe("async_cancel_result_unknown");
    expect(hold.unknownAt).not.toBeNull();
    // Full capacity occupied: nothing applied, nothing released, no charge line.
    expect(hold.applied).toBeNull();
    expect(hold.released).toBeNull();
    expect(await ledgerCountFor(world.customerKey)).toBe(0);

    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      providerCancelResult: "result_unknown",
      conclusion: "hold_unknown",
      releasedCredits: null,
    });
    expect(audit.events).toHaveLength(1);
  });
});

describe("17.7 AC-2 — only the provider's own unbilled evidence releases", () => {
  test("evidenced cancel releases through the Release protocol; the balance is restored", async () => {
    const world = await seedJobWorld();
    const receipt = `cancel-receipt-${world.jobId}`;
    const provider = scriptedProvider([
      { kind: "succeeded_unbilled_evidenced", evidenceReference: receipt },
    ]);
    const audit = makeAudit();
    const service = cancelWith(provider, audit);

    const outcome = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      status: "answered",
      providerCancelResult: "succeeded_unbilled_evidenced",
      conclusion: "released_on_evidence",
      releasedCredits: world.maximumCredits,
      evidenceReference: receipt,
    });

    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("released");
    expect(hold.released).toBe(world.maximumCredits);
    expect(hold.terminalAt).not.toBeNull();
    // A release is a handback, not a charge: no ledger line exists for it.
    expect(await ledgerCountFor(world.customerKey)).toBe(0);

    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      providerCancelResult: "succeeded_unbilled_evidenced",
      conclusion: "released_on_evidence",
      releasedCredits: world.maximumCredits,
      evidenceKind: "no_usage",
      evidenceReference: receipt,
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].payload).toMatchObject({
      conclusion: "released_on_evidence",
      releasedCredits: world.maximumCredits,
      evidenceReference: receipt,
    });
  });

  test("\"取消已接受\" without billing confirmation releases nothing", async () => {
    const world = await seedJobWorld();
    const provider = scriptedProvider([{ kind: "succeeded_no_evidence" }]);
    const service = cancelWith(provider, makeAudit());

    const outcome = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      providerCancelResult: "succeeded_no_evidence",
      conclusion: "hold_kept",
      releasedCredits: null,
    });
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("reserved");
    expect(hold.released).toBeNull();
    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      providerCancelResult: "succeeded_no_evidence",
      conclusion: "hold_kept",
      evidenceKind: null,
    });
  });

  test("a replay answers the record without a second provider ask; a retry with evidence releases", async () => {
    const world = await seedJobWorld();
    const receipt = `cancel-receipt-retry-${world.jobId}`;
    const provider = scriptedProvider([
      { kind: "unsupported" },
      { kind: "succeeded_unbilled_evidenced", evidenceReference: receipt },
    ]);
    const audit = makeAudit();
    const service = cancelWith(provider, audit);

    await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    // The SAME key replays: no provider ask, same conclusion, the counter moves.
    const replay = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-1`,
      jobId: world.jobId,
    });
    expect(replay).toMatchObject({ status: "answered", asked: false, conclusion: "hold_kept" });
    expect(provider.calls).toHaveLength(1);

    // A NEW key is a genuine retry; the evidenced answer moves the conclusion to released.
    const retry = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-2`,
      jobId: world.jobId,
    });
    expect(retry).toMatchObject({
      status: "answered",
      asked: true,
      conclusion: "released_on_evidence",
    });
    expect(provider.calls).toHaveLength(2);
    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      conclusion: "released_on_evidence",
      releasedCredits: world.maximumCredits,
      requests: 3,
    });
    // Two conclusions landed (kept, then released): two audit rows, not three.
    expect(audit.events).toHaveLength(2);
    // A release is terminal on the money's own terms: a later cancel answers
    // nothing_to_cancel (the hold is released), and the provider is never asked again.
    const afterRelease = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-3`,
      jobId: world.jobId,
    });
    expect(afterRelease).toMatchObject({
      status: "nothing_to_cancel",
      reason: "reservation_released",
    });
    expect(provider.calls).toHaveLength(2);
  });
});

describe("17.7 AC-3 — key expiry and client departure are not conclusions", () => {
  test("a revoked grant changes nothing by itself: the read still answers, the hold stands", async () => {
    const world = await seedJobWorld();
    await database
      .update(accessGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(accessGrants.grantId, world.grantId));

    // Visibility is not admission (17.4's rule): the revoked grant still reads its job.
    const answer = await statusService.queryStatus({
      grantId: world.grantId,
      jobId: world.jobId,
    });
    expect(answer.kind).toBe("answered");
    if (answer.kind !== "answered") return;
    expect(answer.outcome.status).toBe("found");

    // And nothing released: expiry alone moves no money, on any timescale.
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("reserved");
    expect(hold.released).toBeNull();
    expect(await cancelRowOf(world.jobId)).toBeUndefined();
  });

  test("a cancel whose caller left before the answer lands concludes on the evidence", async () => {
    const world = await seedJobWorld();
    const receipt = `cancel-receipt-gone-${world.jobId}`;
    const provider = scriptedProvider([
      { kind: "succeeded_unbilled_evidenced", evidenceReference: receipt },
    ]);
    const service = cancelWith(provider, makeAudit());

    // The caller does not await: the handler still runs to its conclusion.
    const pending = service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-cancel-gone`,
      jobId: world.jobId,
    });
    await pending;
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("released");
    expect(hold.released).toBe(world.maximumCredits);
  });
});

describe("17.7 AC-4 — the seam stays honest around the cancel lane", () => {
  test("a stranger's grant learns nothing: the uniform not-found answer", async () => {
    const world = await seedJobWorld();
    const n = ++seedCounter;
    const strangerGrant = `${prefix}-stranger-${n}`;
    const strangerUser = `${prefix}-strangeruser-${n}`;
    await database.insert(botServices).values({
      botId: `${prefix}-strangerbot-${n}`,
      displayName: `Stranger Bot ${n}`,
      kind: "external",
      capabilities: ["async"],
      status: "active",
    });
    await database.insert(accessGrants).values({
      grantId: strangerGrant,
      userId: strangerUser,
      botId: `${prefix}-strangerbot-${n}`,
      externalIdentity: `${prefix}:stranger:${n}`,
      scope: "model-access",
      status: "active",
      revokedAt: null,
    });
    const provider = scriptedProvider([
      { kind: "succeeded_unbilled_evidenced", evidenceReference: "should-not-release" },
    ]);
    const service = cancelWith(provider, makeAudit());

    const outcome = await service.cancelJob({
      grantId: strangerGrant,
      cancelIdempotencyKey: `${world.jobId}-stranger`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      status: "nothing_to_cancel",
      reason: "job_not_found",
      jobId: null,
    });
    expect(provider.calls).toHaveLength(0);
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("reserved");
  });

  test("a job the money already settled answers nothing_to_cancel; a later terminal usage after a cancel-unknown still settles", async () => {
    // Settled: a cancel on a finished job has nothing to do.
    const settledWorld = await seedJobWorld();
    const settledUsage = Object.fromEntries(
      Object.keys(V1_AMOUNTS).map((dimension) => [
        dimension,
        dimension === "video" ? 25 : dimension === "surcharge_per_request" ? 1 : 0,
      ]),
    );
    const settled = await terminalService.settleTerminal({
      jobId: settledWorld.jobId,
      terminal: { state: "completed", usage: settledUsage as never },
      source: "poll",
    });
    expect(settled.status).toBe("settled");
    const provider = scriptedProvider([
      { kind: "succeeded_unbilled_evidenced", evidenceReference: "late" },
    ]);
    const service = cancelWith(provider, makeAudit());
    const outcome = await service.cancelJob({
      grantId: settledWorld.grantId,
      cancelIdempotencyKey: `${settledWorld.jobId}-late`,
      jobId: settledWorld.jobId,
    });
    expect(outcome).toMatchObject({
      status: "nothing_to_cancel",
      reason: "reservation_settled",
    });
    expect(provider.calls).toHaveLength(0);

    // Cancel-unknown then real usage: the terminal lane settles the hold the cancel moved
    // to unknown — the cancel never wedges the job's money.
    const world = await seedJobWorld();
    const unknownProvider = scriptedProvider([
      { kind: "result_unknown", detail: "timeout" },
    ]);
    const unknownService = cancelWith(unknownProvider, makeAudit());
    await unknownService.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-unknown`,
      jobId: world.jobId,
    });
    expect((await holdOf(world.reservationId)).status).toBe("unknown");

    const usage = Object.fromEntries(
      Object.keys(V1_AMOUNTS).map((dimension) => [
        dimension,
        dimension === "video" ? 25 : dimension === "surcharge_per_request" ? 1 : 0,
      ]),
    );
    const terminal = await terminalService.settleTerminal({
      jobId: world.jobId,
      terminal: { state: "completed", usage: usage as never },
      source: "poll",
    });
    expect(terminal.status).toBe("settled");
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("settled");
    expect(hold.applied).not.toBeNull();
    expect(hold.released).toBe(world.maximumCredits - (hold.applied ?? 0));
    expect(await ledgerCountFor(world.customerKey)).toBe(1);
  });

  test("an evidenced cancel against an already-unknown hold does not force a release", async () => {
    // The hold is unknown (17.3's lane: dispatch answer lost); the provider later confirms
    // nothing ran — but 06.11 refuses releasing an unknown hold (recovery's to dispose),
    // and the refusal passes through as the conclusion instead of a forced second door.
    const n0 = ++seedCounter;
    const world = await seedJobWorld();
    void n0;
    await fixtureWriter.markReservationUnknown(
      world.reservationId,
      "async_dispatch_answer_lost",
    );
    const receipt = `cancel-receipt-unknown-hold-${world.jobId}`;
    const provider = scriptedProvider([
      { kind: "succeeded_unbilled_evidenced", evidenceReference: receipt },
    ]);
    const service = cancelWith(provider, makeAudit());
    const outcome = await service.cancelJob({
      grantId: world.grantId,
      cancelIdempotencyKey: `${world.jobId}-evidenced`,
      jobId: world.jobId,
    });
    expect(outcome).toMatchObject({
      status: "answered",
      conclusion: "hold_unknown",
      releasedCredits: null,
    });
    const hold = await holdOf(world.reservationId);
    expect(hold.status).toBe("unknown");
    const row = await cancelRowOf(world.jobId);
    expect(row).toMatchObject({
      providerCancelResult: "succeeded_unbilled_evidenced",
      conclusion: "hold_unknown",
      evidenceReference: receipt,
    });
  });
});
