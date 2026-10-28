import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import { createAsyncDispatchRecoveryService } from "../src/billing/async-job-recovery";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
import { createVideoSubmitService } from "../src/billing/video-submit";
import {
  createVideoSettlementService,
  createVideoArtifactQueryService,
  videoTerminalUsageOf,
} from "../src/billing/video-settlement";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
} from "../src/db/schema";
import {
  asyncJobs,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 19.4 (#340) — group 19's stitching point, on a real PostgreSQL: the video job
 * settles at its terminal's real usage through 17.6's lane, the artifact query is a
 * read that cannot move money no matter how often it runs, and a lost dispatch recovers
 * across a restart without a second job or a second charge.
 *
 *   AC-1  视频任务按真实终态 usage 结算，未使用额度释放 — the completed job charges
 *         exactly seconds × clips × rate (+ input seconds) at the LOCKED basis and the
 *         hold's unused share hands back with the settle;
 *   AC-2  重复查询产物不触发第二次结算 — the artifact query holds no money seam: N
 *         queries leave the ledger, the reservation and the settle-trigger counters
 *         byte-identical;
 *   AC-3  响应丢失或终态不可查时保持预留并可恢复 — a lost dispatch answer keeps the
 *         FULL cap occupied (06.8 unknown), the sweep attaches the provider job id under
 *         the submit's own identity, and an unreadable terminal refuses to settle at all;
 *   AC-4  重启后不重复派发、不重复扣费 — a fresh process's replay of the same submit key
 *         answers the SAME job with dispatch count unchanged, and the replayed terminal
 *         converges on the FIRST settlement's numbers.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b19-340-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };
const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** The video cell: $0.01/output-second, $0.002/input-second, everything else free. */
const AMOUNTS: Record<string, string> = {
  input: "0",
  output: "0",
  reasoning: "0",
  image: "0",
  image_output: "0",
  audio_input: "0",
  audio_output: "0",
  cache_read: "0",
  cache_write: "0",
  video: "0.01",
  video_input: "0.002",
  surcharge_web_search: "0",
  surcharge_per_request: "0",
  surcharge_tool_call: "0",
  surcharge_a2a_call: "0",
};

let dispatchCounter = 0;

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
};

let seedCounter = 0;

async function seedWorld(
  options: { balanceCents?: number } = {},
): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `${prefix}-veo-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Video Bot ${n}`,
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
    idempotencyKey: `${prefix}-seed-${n}`,
  });

  const snapshotStore = createEnterpriseGatewayPriceSnapshotStore(database);
  await database.insert(gatewayModelCatalogRefs).values({
    provider,
    model,
    capability: "video",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  const dims: Record<string, { status: "known"; amount: string }> = {};
  for (const [dimension, amount] of Object.entries(AMOUNTS)) {
    dims[dimension] = { status: "known", amount };
  }
  await snapshotStore.appendSnapshots([
    {
      ref: { provider, model, capability: "video" },
      dims: dims as never,
      fetchedAt: new Date().toISOString(),
      source: GATEWAY_PRICE_SNAPSHOT_SOURCE,
      configVersion: 1,
      rateVersion: null,
    },
  ]);
  await database.insert(gatewayModelOpenScopes).values({
    provider,
    model,
    capability: "video",
    state: "open",
    reason: "video-19.4 fixture",
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

  return { userId, grantId, provider, model };
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

/**
 * A video submit service over the REAL 17.2 submit service — the same composition the
 * deployment mounts, so the recovery and restart facts below are the submit service's
 * own contract, not a test double's.
 */
function makeVideoSubmit(world: World, behavior: "answer" | "lose") {
  let dispatchCalls = 0;
  const asyncSubmit = createAsyncSubmitService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: async () => {
      dispatchCalls += 1;
      return behavior === "answer"
        ? ({
            kind: "answered",
            providerJobId: `${prefix}-prov-${++dispatchCounter}`,
          } as const)
        : ({ kind: "lost", reason: "response_timeout" } as const);
    },
    resolveBasis,
  });
  const videoSubmit = createVideoSubmitService({
    resolveBasis,
    asyncSubmit: (request) => asyncSubmit.submit(request),
    tierTableFor: async (dims) =>
      dims.video.status === "known"
        ? [{ size: null, quality: null, amount: dims.video.amount }]
        : [],
  });
  return {
    dispatchCalls: () => dispatchCalls,
    submit: (
      submitIdempotencyKey: string,
      request: unknown,
      requestType?: "edit" | "remix",
    ) =>
      videoSubmit.submitVideo({
        submitIdempotencyKey,
        grantId: world.grantId,
        payer: { kind: "personal", id: world.userId },
        model: {
          provider: world.provider,
          model: world.model,
          capability: "video",
        },
        snapshotVersion: 1,
        rateVersion: 0,
        request,
        ...(requestType !== undefined ? { requestType } : {}),
      }),
  };
}

/**
 * The ledger rows a reservation wrote — the double-charge proof's own evidence, read by
 * the writer's own fence (`reservation:<id>`, the idempotency key every settle of this
 * hold rides): the row count is exactly the settle count, whatever else the account did.
 */
async function ledgerRowsOf(reservationId: string) {
  return database
    .select({ id: creditLedger.id, credits: creditLedger.credits })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
}

afterAll(async () => {
  // One shared pool for the file; closed once, after the last test.
  await TEST_POOL.end?.();
});

describe("Bifrost 19.4 (#340): the terminal usage conversion", () => {
  test("a completed report bills reported seconds × clips plus the frozen input seconds", () => {
    const converted = videoTerminalUsageOf({
      state: "completed",
      seconds: 6,
      outputCount: 2,
      inputSeconds: 14,
    });
    expect(converted.ok && converted.usage.video).toBe(12);
    expect(converted.ok && converted.usage.video_input).toBe(14);
    expect(converted.ok && converted.usage.input).toBe(0);
  });

  test("a failed or cancelled video settles at a real zero — a final answer, not a parked row", () => {
    for (const state of ["failed", "cancelled"] as const) {
      const converted = videoTerminalUsageOf({ state });
      expect(converted.ok && converted.usage.video).toBe(0);
      expect(converted.ok && converted.usage.video_input).toBe(0);
    }
  });

  test("a completed report nobody can read refuses — never a guessed zero", () => {
    for (const report of [
      {},
      { state: "completed" },
      { state: "completed", seconds: 6, outputCount: 0 },
      { state: "completed", seconds: 6, outputCount: 2, inputSeconds: -1 },
      { state: "completed", seconds: 6.5, outputCount: 2, inputSeconds: 0 },
      { state: "completed", seconds: "6", outputCount: 2, inputSeconds: 0 },
      { state: "running" },
    ]) {
      expect(videoTerminalUsageOf(report).ok).toBe(false);
    }
  });
});

describe("Bifrost 19.4 (#340): terminal settlement, artifact query, recovery (integration)", () => {
  test("AC-1: a completed video settles its real usage at the locked basis and releases the unused share", async () => {
    const world = await seedWorld();
    const submit = makeVideoSubmit(world, "answer");
    // Order 8s × 2 clips + 14s input: cap = (16×$0.01 + 14×$0.002) × 100 × 100 = 1880.
    const submitted = await submit.submit(
      `${prefix}-s1`,
      {
        seconds: 8,
        n: 2,
        input: [
          { video: "a", seconds: 10 },
          { video: "b", seconds: 4 },
        ],
      },
      "edit",
    );
    if (submitted.status !== "submitted") throw new Error("must submit");
    expect(submitted.maximumCredits).toBe(1880);

    const [hold0] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, submitted.reservationId));
    expect(hold0.status).toBe("reserved");

    const settlement = createVideoSettlementService({
      database,
      environmentRate: ENVIRONMENT_RATE,
    });
    const settled = await settlement.submitVideoTerminal({
      jobId: submitted.jobId,
      // The real terminal: the provider clamped to 6s and delivered 2 clips.
      report: {
        state: "completed",
        seconds: 6,
        outputCount: 2,
        inputSeconds: 14,
      },
      source: "poll",
    });
    if (settled.status !== "settled") throw new Error("must settle");
    // Real usage: 12 × $0.01 + 14 × $0.002 = $0.148 → 1480 scaled units charged.
    expect(settled.chargedCredits).toBe(1480);
    expect(settled.appliedCredits).toBe(1480);
    expect(settled.releasedCredits).toBe(400);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, submitted.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.applied).toBe(1480);
    expect(hold.released).toBe(400);
  });

  test("AC-2: repeated artifact queries never move money — ledger, hold and trigger counters byte-identical", async () => {
    const world = await seedWorld();
    const submit = makeVideoSubmit(world, "answer");
    const submitted = await submit.submit(`${prefix}-s2`, {
      seconds: 8,
      input: { video: "a", seconds: 10 },
    });
    if (submitted.status !== "submitted") throw new Error("must submit");

    let retrieverCalls = 0;
    const query = createVideoArtifactQueryService({
      database,
      retrieve: async () => {
        retrieverCalls += 1;
        return [{ artifactId: "clip-1", url: "https://provider/v/clip-1.mp4" }];
      },
    });

    // Before the terminal: the query is a read, the hold is untouched, artifacts list.
    for (let i = 0; i < 3; i += 1) {
      const answer = await query.queryArtifacts({
        grantId: world.grantId,
        jobId: submitted.jobId,
      });
      if (answer.kind !== "answered" || answer.outcome.status !== "found") {
        throw new Error("must find");
      }
      expect(answer.outcome.job.reservation.status).toBe("reserved");
      expect(answer.outcome.artifacts).toEqual([
        { artifactId: "clip-1", url: "https://provider/v/clip-1.mp4" },
      ]);
    }
    expect(retrieverCalls).toBe(3);

    const before = await ledgerRowsOf(submitted.reservationId);
    const settlement = createVideoSettlementService({
      database,
      environmentRate: ENVIRONMENT_RATE,
    });
    await settlement.submitVideoTerminal({
      jobId: submitted.jobId,
      report: {
        state: "completed",
        seconds: 8,
        outputCount: 1,
        inputSeconds: 10,
      },
      source: "notification",
    });

    // After the terminal: N more queries — the money state reads as the terminal lane
    // left it, and no query re-settles anything.
    for (let i = 0; i < 3; i += 1) {
      const answer = await query.queryArtifacts({
        grantId: world.grantId,
        jobId: submitted.jobId,
      });
      if (answer.kind !== "answered" || answer.outcome.status !== "found") {
        throw new Error("must find");
      }
      expect(answer.outcome.job.reservation.status).toBe("settled");
      expect(answer.outcome.job.reservation.appliedCredits).not.toBeNull();
    }
    const afterFirst = await ledgerRowsOf(submitted.reservationId);
    expect(afterFirst).toHaveLength(before.length + 1);

    const settledCount = afterFirst.length;
    for (let i = 0; i < 2; i += 1) {
      await query.queryArtifacts({
        grantId: world.grantId,
        jobId: submitted.jobId,
      });
    }
    const afterMore = await ledgerRowsOf(submitted.reservationId);
    expect(afterMore).toHaveLength(settledCount);

    // The replayed terminal converges on the first settlement — the reservation fence.
    const replay = await settlement.submitVideoTerminal({
      jobId: submitted.jobId,
      report: {
        state: "completed",
        seconds: 8,
        outputCount: 1,
        inputSeconds: 10,
      },
      source: "poll",
    });
    if (replay.status !== "settled") throw new Error("replay must converge");
    expect(replay.trigger.totalTriggers).toBe(2);
    expect(replay.chargedCredits).toBe(1000); // 8×0.01 + 10×0.002 = $0.10 → 1000.
    const afterReplay = await ledgerRowsOf(submitted.reservationId);
    expect(afterReplay).toHaveLength(settledCount);
  });

  test("AC-3: an unreadable terminal refuses to settle — the hold keeps its full cap, unknown", async () => {
    const world = await seedWorld();
    const submit = makeVideoSubmit(world, "answer");
    const submitted = await submit.submit(`${prefix}-s3`, {
      seconds: 8,
      input: { video: "a", seconds: 10 },
    });
    if (submitted.status !== "submitted") throw new Error("must submit");

    const settlement = createVideoSettlementService({
      database,
      environmentRate: ENVIRONMENT_RATE,
    });
    const refused = await settlement.submitVideoTerminal({
      jobId: submitted.jobId,
      report: { state: "completed", outputCount: 1, inputSeconds: 10 }, // seconds unreadable
      source: "poll",
    });
    expect(refused).toEqual({
      status: "refused",
      reasonCode: "video_usage_indeterminable",
      detail: { field: "seconds" },
    });

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, submitted.reservationId));
    // Nothing settled, nothing released: the full cap stays occupied for recovery.
    expect(hold.status).toBe("reserved");
    expect(hold.applied).toBeNull();
    expect(await ledgerRowsOf(submitted.reservationId)).toHaveLength(0);
  });

  test("AC-3/AC-4: a lost dispatch keeps the full cap, recovers under the submit's own identity, and a restart replays without a second job or charge", async () => {
    const world = await seedWorld();
    // Process A: the dispatch answer is lost.
    const submitA = makeVideoSubmit(world, "lose");
    const submitted = await submitA.submit(
      `${prefix}-s4`,
      { seconds: 8, input: { video: "a", seconds: 10 } },
      "edit",
    );
    if (submitted.status !== "submitted") throw new Error("must submit");
    expect(submitted.state).toBe("dispatch_unconfirmed");
    expect(submitted.providerJobId).toBeNull();
    expect(submitA.dispatchCalls()).toBe(1);

    const [holdLost] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, submitted.reservationId));
    expect(holdLost.status).toBe("unknown"); // 06.8: the answer's loss is not a no-cost.
    expect(holdLost.applied).toBeNull();

    // The restart: a fresh process (new service instances, same durable rows) replays
    // the SAME submit key — it must answer the same job and dispatch nothing.
    const submitB = makeVideoSubmit(world, "answer");
    const replayed = await submitB.submit(
      `${prefix}-s4`,
      { seconds: 8, input: { video: "a", seconds: 10 } },
      "edit",
    );
    if (replayed.status !== "submitted") throw new Error("replay must answer");
    expect(replayed.created).toBe(false);
    expect(replayed.jobId).toBe(submitted.jobId);
    expect(submitB.dispatchCalls()).toBe(0);

    // The recovery sweep: the provider answers under the submit's stable identity.
    let providerJobFound = 0;
    const recovery = createAsyncDispatchRecoveryService({
      database,
      findProviderJob: async (query) => {
        providerJobFound += 1;
        expect(query.submitIdempotencyKey).toBe(`${prefix}-s4`);
        return { status: "found", providerJobId: `${prefix}-prov-recovered-1` };
      },
    });
    const recovered = await recovery.recoverLostDispatch(submitted.jobId);
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") return;
    expect(recovered.job.providerJobId).toBe(`${prefix}-prov-recovered-1`);
    expect(providerJobFound).toBe(1);

    // The terminal settles ONCE under the recovered provider identity; the replay via
    // the notification lane (providerJobId) converges without a second charge.
    const settlement = createVideoSettlementService({
      database,
      environmentRate: ENVIRONMENT_RATE,
    });
    const settled = await settlement.submitVideoTerminal({
      providerJobId: `${prefix}-prov-recovered-1`,
      report: {
        state: "completed",
        seconds: 8,
        outputCount: 1,
        inputSeconds: 10,
      },
      source: "notification",
    });
    if (settled.status !== "settled") throw new Error("must settle");
    expect(settled.chargedCredits).toBe(1000);

    const convergent = await settlement.submitVideoTerminal({
      providerJobId: `${prefix}-prov-recovered-1`,
      report: {
        state: "completed",
        seconds: 8,
        outputCount: 1,
        inputSeconds: 10,
      },
      source: "poll",
    });
    if (convergent.status !== "settled") throw new Error("must converge");
    expect(convergent.chargedCredits).toBe(1000);
    expect(convergent.trigger.totalTriggers).toBe(2);

    // The whole stitched lane: exactly one charge row, one job row, no re-dispatch.
    expect(await ledgerRowsOf(submitted.reservationId)).toHaveLength(1);
    const [jobRow] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, submitted.jobId));
    expect(jobRow.state).toBe("submitted");
    const jobCount = await database
      .select({ jobId: asyncJobs.jobId })
      .from(asyncJobs)
      .where(eq(asyncJobs.submitIdempotencyKey, `${prefix}-s4`));
    expect(jobCount).toHaveLength(1);
  });

  test("AC-1: a failed video settles at a real zero — the whole hold hands back", async () => {
    const world = await seedWorld();
    const submit = makeVideoSubmit(world, "answer");
    const submitted = await submit.submit(`${prefix}-s5`, {
      seconds: 8,
      input: { video: "a", seconds: 10 },
    });
    if (submitted.status !== "submitted") throw new Error("must submit");

    const settlement = createVideoSettlementService({
      database,
      environmentRate: ENVIRONMENT_RATE,
    });
    const settled = await settlement.submitVideoTerminal({
      jobId: submitted.jobId,
      report: { state: "failed" },
      source: "poll",
    });
    if (settled.status !== "settled") throw new Error("must settle");
    expect(settled.chargedCredits).toBe(0);
    expect(settled.releasedCredits).toBe(submitted.maximumCredits);

    const [hold] = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, submitted.reservationId));
    expect(hold.status).toBe("settled");
    expect(hold.applied).toBe(0);
    expect(hold.released).toBe(submitted.maximumCredits);
  });

  test("the artifact query keeps 17.4's own boundary discipline", async () => {
    const world = await seedWorld();
    const submit = makeVideoSubmit(world, "answer");
    const submitted = await submit.submit(`${prefix}-s6`, { seconds: 5 });
    if (submitted.status !== "submitted") throw new Error("must submit");

    const query = createVideoArtifactQueryService({
      database,
      retrieve: async () => [],
    });

    // An account-naming field refuses on presence — the payer is the grant's own business.
    const refused = await query.queryArtifacts({
      grantId: world.grantId,
      jobId: submitted.jobId,
      userId: "someone-else",
    });
    expect(refused).toMatchObject({
      kind: "refused",
      reasonCode: "payer_conflict",
      detail: { field: "userId" },
    });

    // Another account's job answers the one uniform not_found.
    const other = await seedWorld();
    const foreign = await query.queryArtifacts({
      grantId: other.grantId,
      jobId: submitted.jobId,
    });
    expect(foreign).toEqual({
      kind: "answered",
      outcome: { status: "not_found" },
    });

    // A job whose dispatch never confirmed has no artifacts to list — the honest empty.
    const loseWorld = await seedWorld();
    const loseSubmit = makeVideoSubmit(loseWorld, "lose");
    const lost = await loseSubmit.submit(`${prefix}-s7`, { seconds: 5 });
    if (lost.status !== "submitted") throw new Error("must submit");
    let retrieverCalls = 0;
    const queryLost = createVideoArtifactQueryService({
      database,
      retrieve: async () => {
        retrieverCalls += 1;
        return [];
      },
    });
    const answer = await queryLost.queryArtifacts({
      grantId: loseWorld.grantId,
      jobId: lost.jobId,
    });
    if (answer.kind !== "answered" || answer.outcome.status !== "found") {
      throw new Error("must find");
    }
    expect(answer.outcome.artifacts).toEqual([]);
    expect(retrieverCalls).toBe(0); // no provider id: no read to make
  });
});
