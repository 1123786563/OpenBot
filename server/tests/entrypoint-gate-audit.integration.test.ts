import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  FAMILY_BYPASS_EVIDENCE,
  FAMILY_REFUSAL_EVIDENCE,
  PAYER_RESOLUTION,
  auditAllEntrypoints,
  auditFailures,
} from "../src/billing/entrypoint-gate-audit";
import { MODEL_ENTRYPOINTS } from "../src/billing/entrypoint-catalog";
import { admitImageEntrypoint } from "../src/billing/image-entrypoints";
import { imageTierPriceTableFromSnapshot } from "../src/billing/image-generation-pricing";
import { createOcrAdmission } from "../src/billing/ocr-admission";
import { createRerankAdmission } from "../src/billing/rerank-admission";
import { createToolAdmissionService } from "../src/billing/tool-admission";
import { createAsyncSubmitService } from "../src/billing/async-job-submit";
import { createBatchSubmitService } from "../src/billing/batch-submit";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import { resolveConsumptionPayerBinding, restorePayerBinding } from "../src/billing/payer-binding";
import { resolveWorkbenchPayerBinding } from "../src/billing/workbench-payer";
import { createRealtimeSessionService } from "../src/billing/realtime-session";
import { createRealtimeUnitService } from "../src/billing/realtime-unit";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  PRICE_DIMENSIONS,
  createEnterpriseGatewayPriceSnapshotStore,
  type PriceDimension,
  type PriceSnapshotDims,
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
  asyncJobs,
  batchJobs,
  creditReservations,
  realtimeSessions,
} from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import type { Database } from "../src/db/client";

/*
 * Ticket 22.2 (#353) — 每入口 gate 与 payer 核查, on the real test database for the
 * database-backed doors and on injected seams for the pure ones.
 *
 *   AC-1  每条入口都通过门禁、payer、拒绝与旁路四类核查 — the structural audit derives
 *         its verdicts from the catalog and binds every behavioral claim to the delivered
 *         suite that proves it; the audit table must be failure-free;
 *   AC-2  核查证据绑定代码版本且可独立复核 — every named suite exists in this repository,
 *         and the live drives below re-run the核心 refusal world (余额不足 → 供应商调用
 *         数 0) against the same services production wires;
 *   AC-3  发现的缺陷都有对应修复项 — a family without evidence fails the audit by name
 *         (the failure vocabulary), never silently;
 *   AC-4  任何入口都不存在直连供应商的旁路 — the payer segment proves the door side: a
 *         client-specified payer is refused (payer_conflict), the company scope binds the
 *         company account through the server-issued scope only, and the pure drives count
 *         the dispatch seam — it never fires on a refused world.
 */

const repoRoot = join(import.meta.dirname, "../..");

// ── the fixture vocabulary (the shape 11.5's own tests certify against) ──

const RATE: ConversionRate = { numerator: 100n, denominator: 1n };

const FULL_AMOUNTS: Record<PriceDimension, string> = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.0000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  video_input: "0.002",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.01",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

function dims(
  overrides: Partial<Record<PriceDimension, PriceSnapshotDims[PriceDimension]>> = {},
): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceSnapshotDims[PriceDimension]>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: FULL_AMOUNTS[dimension] };
  }
  for (const [dimension, state] of Object.entries(overrides)) {
    if (state !== undefined) base[dimension as PriceDimension] = state;
  }
  return base;
}

// ── AC-1: the four-way audit table, derived and failure-free ──

describe("Bifrost 22.2 (#353): the four-way audit table", () => {
  test("every audited entrance passes all four checks", () => {
    const failures = auditFailures(auditAllEntrypoints());
    expect(failures).toEqual([]);
  });

  test("every audited family carries named refusal AND bypass evidence", () => {
    const auditedFamilies = new Set(
      MODEL_ENTRYPOINTS.filter((row) => row.admission.status !== "absent").map(
        (row) => row.family,
      ),
    );
    expect(auditedFamilies.size).toBeGreaterThanOrEqual(13);
    for (const family of auditedFamilies) {
      expect(FAMILY_REFUSAL_EVIDENCE[family], family).toBeDefined();
      expect(FAMILY_BYPASS_EVIDENCE[family], family).toBeDefined();
    }
  });

  test("every named evidence suite and payer module exists in this repository — the evidence is复核-able", () => {
    const paths = new Set<string>();
    for (const evidence of Object.values(FAMILY_REFUSAL_EVIDENCE)) paths.add(evidence.suite);
    for (const evidence of Object.values(FAMILY_BYPASS_EVIDENCE)) paths.add(evidence.suite);
    for (const resolution of Object.values(PAYER_RESOLUTION)) paths.add(resolution.module);
    expect(paths.size).toBeGreaterThanOrEqual(15);
    for (const path of paths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(true);
    }
  });

  test("every evidence row carries its suite's bound last-run result — a red suite is named red, never implied green", () => {
    // The audit does not run the named suites here (the live drives above carry the
    // four-way claims); what it refuses to do is let an evidence row imply a green that
    // the receipts contradict. Every family states its verdict; a baseline-red verdict
    // names what the audit's claim rests on instead.
    for (const [family, evidence] of Object.entries(FAMILY_REFUSAL_EVIDENCE)) {
      expect(["green", "baseline-red"], family).toContain(evidence.lastRun.verdict);
      expect(evidence.lastRun.note.length, family).toBeGreaterThan(10);
      if (evidence.lastRun.verdict === "baseline-red") {
        // The note names its cause — the fixture-drift class or another named class.
        expect(
          evidence.lastRun.note.includes("drift") || evidence.lastRun.note.includes("class"),
          family,
        ).toBe(true);
        // And the claim's real carrier is named — the live drive or a green sibling.
        expect(
          evidence.lastRun.note.includes("live") ||
            evidence.lastRun.note.includes("green") ||
            evidence.lastRun.note.includes("module"),
          family,
        ).toBe(true);
      }
    }
    for (const [family, evidence] of Object.entries(FAMILY_BYPASS_EVIDENCE)) {
      expect(["green", "baseline-red"], family).toContain(evidence.lastRun.verdict);
      expect(evidence.lastRun.note.length, family).toBeGreaterThan(3);
    }
  });
});

// ── AC-1/AC-4: the pure drives — refused worlds never reach the dispatch seam ──

describe("the pure-door refusal drives: 余额不足时供应商调用数为 0", () => {
  test("image: a door that refuses insufficient_credits is reached once, dispatch never", async () => {
    let reserveCalls = 0;
    let dispatchCalls = 0;
    const outcome = await admitImageEntrypoint({
      kind: "generation",
      request: { model: "m", prompt: "a cat", n: 2, size: "1024x1024" },
      dims: dims(),
      tierTable: imageTierPriceTableFromSnapshot(dims()),
      rate: RATE,
      grantId: "grant-audit-image",
      payer: { kind: "personal", id: "user-audit-image" },
      model: { provider: "prov-audit", model: "img-audit", capability: "image" },
      snapshotVersion: 1,
      rateVersion: 0,
      idempotencyKey: "idem-audit-image",
      reserve: async () => {
        reserveCalls += 1;
        return { status: "refused", reasonCode: "insufficient_credits", detail: {} };
      },
      dispatch: async () => {
        dispatchCalls += 1;
      },
    });
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
    });
    expect(reserveCalls).toBe(1);
    expect(dispatchCalls).toBe(0);
  });

  test("ocr: the door's insufficient-credits refusal passes through, dispatch never fires", async () => {
    let dispatchCalls = 0;
    const entry = createOcrAdmission({
      reserve: async () => ({
        status: "refused" as const,
        reasonCode: "insufficient_credits" as const,
        detail: { availableCredits: 1 },
      }),
      dispatch: async () => {
        dispatchCalls += 1;
        return { ok: true };
      },
    });
    const outcome = await entry.admit({
      request: {
        model: "m",
        document: { type: "document_url", document_url: "https://example.test/doc" },
        params: { pages: [1, 2, 3] },
      },
      grantId: "grant-audit-ocr",
      payer: { kind: "personal", id: "user-audit-ocr" },
      model: { provider: "prov-audit", model: "ocr-audit", capability: "ocr" },
      snapshotVersion: 1,
      rateVersion: 0,
      dims: dims(),
      rate: RATE,
      outputTokenCap: 20000,
      idempotencyKey: "idem-audit-ocr",
    });
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
    });
    expect(dispatchCalls).toBe(0);
  });

  test("rerank: a refused reserve passes through at the entry's own stage", async () => {
    const entry = createRerankAdmission({
      reserve: async () => ({
        status: "refused" as const,
        reasonCode: "insufficient_credits" as const,
        detail: {},
      }),
    });
    const outcome = await entry.admit({
      request: { model: "m", query: "q", documents: ["a", "b"], top_n: 2 },
      dims: dims(),
      rate: RATE,
      grantId: "grant-audit-rerank",
      payer: { kind: "personal", id: "user-audit-rerank" },
      model: { provider: "prov-audit", model: "rerank-audit", capability: "rerank" },
      snapshotVersion: 1,
      rateVersion: 0,
      idempotencyKey: "idem-audit-rerank",
    });
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
    });
  });

});

// ── the live database segment: the doors production wires, on TEST_DATABASE_URL ──

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b22-353-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** The account's whole balance: 500 cents, far below every hold this file asks for. */
const SEEDED_BALANCE_CENTS = 500;

let seedCounter = 0;

/**
 * One world: an active grant under a funded-with-500-cents personal payer and one open,
 * priced chat cell (realtime worlds reuse the same seeding with a realtime cell). The
 * holds the drives request are orders of magnitude above the balance, so the door's own
 * insufficient_credits is the only possible answer.
 */
async function seedWorld(capability: "chat" | "realtime" = "chat") {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Audit Bot ${n}`,
    kind: "external",
    capabilities: [capability],
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
    totalCents: SEEDED_BALANCE_CENTS,
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
      dims: dims() as never,
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
    reason: "gate-audit fixture",
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

  return { userId, grantId, provider, model, capability, n };
}

async function resolveBasis(basis: {
  provider: string;
  model: string;
  capability: string;
  snapshotVersion: number;
  rateVersion: number;
}) {
  const resolved = await resolveLockedReservationBasis(
    { database, environmentRate: RATE },
    basis,
  );
  return resolved.resolved
    ? { ok: true as const, dims: resolved.dims, rate: resolved.rate }
    : { ok: false as const, reason: resolved.reason };
}

describe("the live-door refusal matrix (TEST_DATABASE_URL)", () => {
  test("text: the reserve door itself refuses insufficient_credits on a real grant", async () => {
    const world = await seedWorld();
    // A hold of 100_00 scaled-credit-units-represented cents (boundCents-style) far above
    // the seeded 500 cents: maximumCredits 1_000_000 (=$10,000.00) against $5.00.
    const outcome = await reserveService.reserve({
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: { provider: world.provider, model: world.model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
      maximumCredits: 1_000_000,
      idempotencyKey: `${prefix}-reserve-${world.n}`,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reasonCode: "insufficient_credits",
    });
    // And the hold the door would have written does not exist — the account half of
    // 供应商调用数为 0 is 0 ledger writes.
    const holds = await database
      .select()
      .from(creditReservations)
      .where(like(creditReservations.externalCustomerId, `%${prefix}%`));
    expect(holds).toHaveLength(0);
  });

  test("async: a submit over the balance refuses — no job row, dispatch spy 0", async () => {
    const world = await seedWorld();
    let dispatchCalls = 0;
    const submit = createAsyncSubmitService({
      database,
      reserve: (request) => reserveService.reserve(request),
      dispatch: async () => {
        dispatchCalls += 1;
        return { kind: "answered" as const, providerJobId: `prov-${world.n}` };
      },
      resolveBasis,
    });
    const outcome = await submit.submit({
      submitIdempotencyKey: `${prefix}-async-${world.n}`,
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: { provider: world.provider, model: world.model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      entries: [
        {
          requestKey: "req-1",
          quantities: { input: 5_000_000, output: 5_000_000 },
        },
      ],
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reasonCode: "reserve_refused",
      detail: { reasonCode: "insufficient_credits" },
    });
    expect(dispatchCalls).toBe(0);
    const jobs = await database
      .select()
      .from(asyncJobs)
      .where(like(asyncJobs.grantId, `${prefix}%`));
    expect(jobs).toHaveLength(0);
  });

  test("batch: an insufficient balance refuses the WHOLE batch — no rows, dispatch spy 0", async () => {
    const world = await seedWorld();
    let dispatchCalls = 0;
    const submit = createBatchSubmitService({
      database,
      reserve: (request) => reserveService.reserve(request),
      dispatch: async () => {
        dispatchCalls += 1;
        return { kind: "answered" as const, providerBatchId: `prov-batch-${world.n}` };
      },
      resolveBasis,
    });
    const outcome = await submit.submit({
      submitIdempotencyKey: `${prefix}-batch-${world.n}`,
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: { provider: world.provider, model: world.model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      items: [
        {
          customId: "req-1",
          model: { provider: world.provider, model: world.model, capability: "chat" },
          quantities: { input: 5_000_000, output: 5_000_000 },
        },
      ],
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reasonCode: "reserve_refused",
      detail: { reasonCode: "insufficient_credits" },
    });
    expect(dispatchCalls).toBe(0);
    const batches = await database
      .select()
      .from(batchJobs)
      .where(like(batchJobs.grantId, `${prefix}%`));
    expect(batches).toHaveLength(0);
  });

  test("realtime: establishment is free; the first unit over the balance is refused and the session stops", async () => {
    const world = await seedWorld("realtime");
    const sessions = createRealtimeSessionService({
      database,
      readReadiness: async () => ({ ready: true as const }),
    });
    const units = createRealtimeUnitService({
      database,
      readReadiness: async () => ({ ready: true as const }),
      environmentRate: RATE,
    });

    const establishment = await sessions.establish({
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: { provider: world.provider, model: world.model, capability: "realtime" },
      snapshotVersion: 1,
      rateVersion: 0,
    });
    expect(establishment.status).toBe("established");
    if (establishment.status !== "established") return;
    const sessionId = establishment.session.sessionId;

    // One unit whose bound dwarfs the balance: the unit door refuses, and the session
    // stops — no provider turn happened for a session whose money ran out.
    const refused = await units.openUnit({
      sessionId,
      unitKey: `unit-${world.n}`,
      kind: "response",
      boundCents: 100_00,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
    });
    expect(refused).toMatchObject({
      status: "refused",
      reasonCode: "insufficient_credits",
    });

    // The stopped session admits no new unit — the stop is durable, not advisory.
    const afterStop = await units.openUnit({
      sessionId,
      unitKey: `unit-${world.n}-next`,
      kind: "response",
      boundCents: 100_00,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
    });
    expect(afterStop).toMatchObject({
      status: "refused",
      reasonCode: "session_stopped",
    });
    const rows = await database
      .select()
      .from(realtimeSessions)
      .where(like(realtimeSessions.sessionId, `${sessionId}%`));
    expect(rows[0]?.stoppedAt).not.toBeNull();
    expect(rows[0]?.stopReason).toBe("insufficient_credits");
  });

  test("tool: an insufficient balance refuses at the reserve stage — the dispatch seam never fires, the refused identity row is durable", async () => {
    // The tool door writes its identity row even on refusal (20.x's own design: a refused
    // tool call is a durable fact), so this drive runs over the seeded world's database.
    const world = await seedWorld();
    let dispatchCalls = 0;
    const service = createToolAdmissionService({
      database,
      reserve: async () => ({
        status: "refused" as const,
        reasonCode: "insufficient_credits" as const,
        detail: {},
      }),
      dispatch: async () => {
        dispatchCalls += 1;
        return { ok: true };
      },
      resolveBasis: async () => ({
        ok: true as const,
        dims: dims(),
        rate: RATE,
      }),
    });
    const outcome = await service.admit({
      toolCallIdempotencyKey: `${prefix}-tool-${world.n}`,
      entry: "mcp.tool_call",
      tool: "audit-tool",
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: { provider: world.provider, model: world.model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
    });
    expect(dispatchCalls).toBe(0);
    // The refused identity row carries no reservation (no hold formed) and its own refusal
    // reason — the durable fact, not a ledger write.
    const { toolCallCharges } = await import("../src/db/schema/credit-reservations");
    const rows = await database
      .select()
      .from(toolCallCharges)
      .where(like(toolCallCharges.grantId, `${prefix}%`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "refused",
      refusalReason: "insufficient_credits",
      reservationId: null,
    });
  });
});

// ── the payer segment: AC13's two mechanisms, driven on the same database ──

/**
 * Mint a genuinely trusted scope for a tenant: server-issued by the real
 * `createScopeResolver` against a controlled directory database answering one active
 * membership — the same technique company-payer-e2e uses.
 */
function controlledQuery(
  rows: (table?: unknown) => readonly Record<string, unknown>[],
) {
  let result = rows();
  const query = Promise.resolve(rows());
  const chain = () => query;
  return Object.assign(query, {
    from(value: unknown) {
      result = rows(value);
      return this;
    },
    innerJoin: chain,
    where: chain,
    limit() {
      return Promise.resolve(result);
    },
  });
}

function controlledDirectoryDatabase(
  rows: readonly Record<string, unknown>[],
): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  return {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => controlledQuery(() => rows),
      }),
  } as unknown as Database;
}

async function mintTrustedScope(input: { tenantId: string; actorId: string }) {
  const { verifyDirectoryDatabase } = await import("../src/enterprise/tenancy/connections");
  const { createScopeResolver } = await import("../src/enterprise/tenancy/store");
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase([
      {
        principalId: `prin_${input.actorId}`,
        tenantStatus: "active",
        principalStatus: "active",
        memberStatus: "active",
        memberEpoch: 3,
        status: "active",
      },
    ]),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: input.actorId, entrypoint: "web" as const }),
    selectTenant: () => input.tenantId,
    selectWorkspace: () => `${input.tenantId}-ws`,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

describe("the payer resolution audit (AC13: 付款账户来源正确且不可指定)", () => {
  test("a client-specified payer that is not the grant's own user is refused payer_conflict", async () => {
    const world = await seedWorld();
    const outcome = await reserveService.reserve({
      grantId: world.grantId,
      // The forged claim: someone else's account on a grant that is not theirs.
      payer: { kind: "personal", id: `${world.userId}-someone-else` },
      model: { provider: world.provider, model: world.model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 4096 }],
      maximumCredits: 100,
      idempotencyKey: `${prefix}-payerconflict-${world.n}`,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reasonCode: "payer_conflict",
    });
  });

  test("the company scope binds the COMPANY account — through the server-issued scope only", async () => {
    // The payer layer's own company resolution: the trusted scope arrives from the
    // tenancy middleware, and the account it answers is the company's, never the
    // principal's personal account. A hand-built scope (the bypass attempt) is refused
    // before any account is touched — 22.2's 旁路 half for the workbench lane.
    const { resolvePayerForCompanyContext } = await import("../src/billing/payer-company");
    const tenantId = `${prefix}-tenant`;
    // A hand-built scope is the bypass attempt: refused before any account is touched —
    // the company lane has no fallback at all.
    const handBuilt = {
      tenantId,
      workspaceId: `${prefix}-ws`,
      principalId: `${prefix}-prin`,
      actorId: `${prefix}-actor`,
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } as const;
    await expect(resolveWorkbenchPayerBinding(database, handBuilt)).rejects.toThrow();
    expect(() => resolvePayerForCompanyContext(handBuilt)).toThrow();
    // A GENUINELY trusted scope — server-issued by the real resolver over a controlled
    // directory answering one active membership — binds the company account (the same
    // technique company-payer-e2e uses).
    const scope = await mintTrustedScope({ tenantId, actorId: `${prefix}-actor` });
    const binding = await resolveWorkbenchPayerBinding(database, scope);
    expect(binding.payer).toEqual({ kind: "company", id: tenantId });
    const companyRef = resolvePayerForCompanyContext(scope);
    expect(companyRef).toEqual({ kind: "company", id: tenantId });
  });

  test("the consumption binding adopts the request binding when present, the deployment binding otherwise", async () => {
    const world = await seedWorld();
    const { account } = await createPayerAccount(database, {
      kind: "personal",
      id: world.userId,
    });
    const personal = restorePayerBinding(account);
    // No request binding (the personal-key lane's default): the deployment binding is
    // the payer — the account the grant resolution already fixed.
    expect(
      resolveConsumptionPayerBinding({ requestBinding: undefined, deploymentBinding: personal }),
    ).toEqual(personal);
    // A coherent request binding (the workbench middleware's own, established from a
    // trusted scope) wins: the company the scope named is the account the call bills.
    const { account: companyAccount } = await createPayerAccount(database, {
      kind: "company",
      id: `${prefix}-tenant-2`,
    });
    const company = restorePayerBinding(companyAccount);
    expect(
      resolveConsumptionPayerBinding({ requestBinding: company, deploymentBinding: personal }),
    ).toEqual(company);
    // The ambient binding discipline holds the fixity: inside the company binding the
    // current binding IS the company — a mid-flight switch is not a thing the seam offers.
    const { currentPayerBinding, withPayerBinding } = await import("../src/billing/payer-binding");
    expect(withPayerBinding(company, () => currentPayerBinding())).toEqual(company);
  });
});

afterAll(async () => {
  const { toolCallCharges } = await import("../src/db/schema/credit-reservations");
  await database.execute(
    sql`DELETE FROM realtime_units WHERE session_id IN (SELECT session_id FROM realtime_sessions WHERE grant_id LIKE ${`${prefix}%`})`,
  );
  await database
    .delete(realtimeSessions)
    .where(like(realtimeSessions.grantId, `${prefix}%`));
  await database.delete(asyncJobs).where(like(asyncJobs.grantId, `${prefix}%`));
  await database.delete(batchJobs).where(like(batchJobs.grantId, `${prefix}%`));
  await database
    .delete(creditReservations)
    .where(like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`));
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
  );
  // payer_accounts first: its selector reads billing_customers, which the next line deletes.
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE external_customer_id IN (SELECT external_id FROM billing_customers WHERE external_id LIKE ${`openbot-%${prefix}%`})`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`openbot-%${prefix}%`}`,
  );
  await database.delete(toolCallCharges).where(like(toolCallCharges.grantId, `${prefix}%`));
  await database.delete(accessGrants).where(like(accessGrants.grantId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database.delete(gatewayModelCatalogRefs).where(
    like(gatewayModelCatalogRefs.provider, `${prefix}%`),
  );
  await database.delete(gatewayModelOpenScopes).where(
    like(gatewayModelOpenScopes.provider, `${prefix}%`),
  );
  await database.$client.close();
});
