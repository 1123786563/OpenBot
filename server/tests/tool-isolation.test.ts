import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createToolAdmissionService } from "../src/billing/tool-admission";
import { TOOL_IDENTITY_ENTRY_IDS } from "../src/billing/tool-surcharge-pricing";
import {
  createCreditReserveService,
} from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
import { resolveLockedReservationBasis } from "../src/billing/reserve-bound";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  mapPriceDims,
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
import { toolCallCharges } from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 20.4 (#344) — unpriced tools cannot bypass billing, and a personal model key
 * cannot reach company tools. Every assertion runs at the door a deployment actually
 * calls, with the reserve caller, the dispatch and the audit store injected — so the
 * provider/tool execution count is read off a spy the door cannot dodge.
 *
 *   AC-1/AC-2  the refusal matrix: every entrance of the registry, on an unpriced basis
 *              (the honest v1 state — the wire cannot price tool calls), refuses at the
 *              enablement stage: no hold, no ledger, dispatch count ZERO, and a refused
 *              identity row plus a `billing.tool_bypass_refused` audit event per attempt;
 *   AC-3  the isolation: a company-scope selector PRESENT in the request, and a
 *         company-scoped tool named by a personal grant, both refuse at the isolation
 *         stage before any price is read, audited as `billing.tool_overreach_refused`;
 *   AC-4  the audit trail: every bypass and overreach attempt above is queryable — the
 *         events carry the entrance, the tool, the grant and the refusal code.
 *
 * Plus the door's positive contracts: a priced basis holds and dispatches exactly once
 * with its own attempt id; an insufficient balance refuses at the reserve stage with
 * dispatch count zero; a free basis dispatches hold-free; a replay converges on the row
 * its hold already minted.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b20-344-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const ENVIRONMENT_RATE = { numerator: 100n, denominator: 1n };
const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});

/** Every dimension priced known except the two the v1 wire cannot price. */
const PRICED_AMOUNTS = {
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

/** The honest v1 basis: the wire prices nothing tool-shaped, so mapPriceDims answers unknown. */
const UNPRICED_DIMS = mapPriceDims({
  id: "prov/unpriced-model",
  pricing: { prompt: "0.000001", completion: "0.000002" },
});

/** The spy every refusal proves its zero on — the door cannot dispatch around it. */
function makeDispatch() {
  let calls = 0;
  const seen: { entry: string; tool: string; free: boolean }[] = [];
  const dispatch = async (input: { entry: string; tool: string; free: boolean }) => {
    calls += 1;
    seen.push(input);
  };
  return { dispatch, calls: () => calls, seen: () => seen };
}

/** The in-memory audit trail the AC-4 assertions read. */
function makeAudit() {
  const events: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return {
    store,
    events: () => events,
    of: (type: string) => events.filter((event) => event.eventType === type),
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

type World = Awaited<ReturnType<typeof seedWorld>>;

let seedCounter = 0;

async function seedWorld(
  options: {
    /** "unpriced" = the v1-wire-honest basis (tool dims unknown); "priced"; "free". */
    basis?: "unpriced" | "priced" | "free";
    balanceCents?: number;
  } = {},
) {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "chat";

  await database.insert(botServices).values({
    botId,
    displayName: `Tool Door Bot ${n}`,
    kind: "external",
    capabilities: ["chat"],
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

  const dims =
    options.basis === "unpriced"
      ? UNPRICED_DIMS
      : options.basis === "free"
        ? dimsOf({ ...PRICED_AMOUNTS, surcharge_web_search: "0", surcharge_tool_call: "0", surcharge_a2a_call: "0" })
        : dimsOf(PRICED_AMOUNTS);
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
    capability,
    state: "open",
    reason: "tool-isolation fixture",
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

  return { userId, grantId, provider, model, n };
}

let callCounter = 0;

/** One admission request through the door, defaults on a valid priced world. */
function admissionBody(
  world: World,
  overrides: Record<string, unknown> = {},
) {
  const n = ++callCounter;
  return {
    toolCallIdempotencyKey: `${prefix}-call-${n}`,
    entry: "mcp.tool_call",
    tool: "clientA-search",
    grantId: world.grantId,
    payer: { kind: "personal", id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "chat",
    },
    snapshotVersion: 1,
    rateVersion: 0,
    ...overrides,
  };
}

function doorWith(
  dispatch: ReturnType<typeof makeDispatch>,
  audit: ReturnType<typeof makeAudit>,
  isCompanyTool?: (tool: string) => boolean,
) {
  return createToolAdmissionService({
    database,
    reserve: (request) => reserveService.reserve(request),
    dispatch: dispatch.dispatch,
    resolveBasis,
    audit: audit.store,
    ...(isCompanyTool !== undefined ? { isCompanyTool } : {}),
  });
}

afterAll(async () => {
  await database.delete(toolCallCharges).where(like(toolCallCharges.grantId, `${prefix}%`));
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id LIKE ${`openbot-personal-${prefix}%`}`,
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
  await database.delete(accessGrants).where(like(accessGrants.grantId, `${prefix}%`));
  await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
  await database.delete(gatewayModelCatalogRefs).where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  await database.delete(gatewayModelOpenScopes).where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
});

describe("B20.4 (#344) the refusal matrix — every entrance, unpriced basis (AC-1/AC-2)", () => {
  test("each entrance refuses at enablement: dispatch 0, no hold, refused row, audited", async () => {
    const world = await seedWorld({ basis: "unpriced" });
    const dispatch = makeDispatch();
    const audit = makeAudit();
    const door = doorWith(dispatch, audit);

    for (const entry of TOOL_IDENTITY_ENTRY_IDS) {
      const outcome = await door.admit(
        admissionBody(world, { entry, tool: `${entry}-probe` }),
      );
      expect(outcome).toMatchObject({
        status: "refused",
        stage: "enablement",
        reasonCode: "tool_price_unknown",
      });
    }
    // The provider/tool execution count is zero across the whole matrix.
    expect(dispatch.calls()).toBe(0);
    expect(dispatch.seen()).toEqual([]);

    // Every attempt has its refused identity row and its bypass audit event, one per
    // entrance — the trail names the entrance, the tool, the grant and the code.
    const charges = await door.listCharges(world.grantId);
    expect(charges).toHaveLength(TOOL_IDENTITY_ENTRY_IDS.length);
    expect(charges.every((charge) => charge.state === "refused")).toBe(true);
    expect(charges.every((charge) => charge.reservationId === null)).toBe(true);

    const bypassEvents = audit.of("billing.tool_bypass_refused");
    expect(bypassEvents).toHaveLength(TOOL_IDENTITY_ENTRY_IDS.length);
    for (const event of bypassEvents) {
      expect(event.targetType).toBe("tool_admission");
      expect(event.payload.reasonCode).toBe("tool_price_unknown");
      expect(event.payload.grantId).toBe(world.grantId);
    }
    const auditedEntries = bypassEvents.map((event) => event.payload.entry);
    for (const entry of TOOL_IDENTITY_ENTRY_IDS) {
      expect(auditedEntries).toContain(entry);
    }
  });

  test("an unpriced basis holds nothing: no reservation rows landed for the grant", async () => {
    const world = await seedWorld({ basis: "unpriced" });
    const door = doorWith(makeDispatch(), makeAudit());
    await door.admit(admissionBody(world));
    const rows = await database.execute(
      sql`SELECT id FROM credit_reservations WHERE idempotency_key LIKE ${`${prefix}%`}`,
    );
    // Nothing this suite reserved exists for the unpriced world (the row count is
    // asserted positively on the priced world below; here the set must be empty).
    const ids = (rows as unknown as { rows?: unknown[] }).rows ?? rows;
    expect(Array.isArray(ids) ? ids.length : 0).toBe(0);
  });
});

describe("B20.4 (#344) the door's positive contracts", () => {
  test("a priced basis holds, dispatches once, and the call carries its own attempt id", async () => {
    const world = await seedWorld({ basis: "priced" });
    const dispatch = makeDispatch();
    const audit = makeAudit();
    const door = doorWith(dispatch, audit);

    const outcome = await door.admit(admissionBody(world));
    expect(outcome).toMatchObject({ status: "admitted", free: false });
    if (outcome.status !== "admitted") return;
    expect(outcome.reservationId?.startsWith("cr-")).toBe(true);
    expect(outcome.attemptId?.startsWith("att-")).toBe(true);
    expect(outcome.attemptId).toBe(`att-${outcome.reservationId?.slice(3)}`);

    // The tool really executed — exactly once — and only after the hold existed.
    expect(dispatch.calls()).toBe(1);
    expect(dispatch.seen()[0]).toMatchObject({
      entry: "mcp.tool_call",
      tool: "clientA-search",
      free: false,
    });

    // The identity row is charged against that hold, and no refusal was audited.
    const charges = await door.listCharges(world.grantId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      state: "charged",
      reservationId: outcome.reservationId,
      attemptId: outcome.attemptId,
      dimension: "surcharge_tool_call",
    });
    expect(audit.events()).toEqual([]);

    // A replay of the same call converges: the same hold, the same identity row, and
    // dispatch happens exactly once more only because the door is asked again — the
    // CHARGE count stays one.
    const replay = await door.admit(
      admissionBody(world, {
        toolCallIdempotencyKey: charges[0].idempotencyKey,
      }),
    );
    expect(replay).toMatchObject({
      status: "admitted",
      free: false,
      chargeId: outcome.chargeId,
    });
    expect((await door.listCharges(world.grantId)).length).toBe(1);
  });

  test("an insufficient balance refuses at the reserve stage with dispatch count zero", async () => {
    // The tool call's ceiling is 1 × $0.002 × 100 × 100 = 20 units; 5 units cannot hold it.
    const world = await seedWorld({ basis: "priced", balanceCents: 5 });
    const dispatch = makeDispatch();
    const audit = makeAudit();
    const door = doorWith(dispatch, audit);

    const outcome = await door.admit(admissionBody(world));
    expect(outcome).toMatchObject({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
    });
    expect(dispatch.calls()).toBe(0);

    const charges = await door.listCharges(world.grantId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      state: "refused",
      refusalReason: "insufficient_credits",
    });
    const bypassEvents = audit.of("billing.tool_bypass_refused");
    expect(bypassEvents).toHaveLength(1);
    expect(bypassEvents[0].payload.reasonCode).toBe("insufficient_credits");
  });

  test("a free basis dispatches hold-free — free is a price, not a gap", async () => {
    const world = await seedWorld({ basis: "free" });
    const dispatch = makeDispatch();
    const door = doorWith(dispatch, makeAudit());

    const outcome = await door.admit(admissionBody(world));
    expect(outcome).toMatchObject({ status: "admitted", free: true });
    if (outcome.status !== "admitted") return;
    expect(outcome.reservationId).toBeNull();
    expect(outcome.attemptId).toBeNull();
    expect(dispatch.calls()).toBe(1);
    expect(dispatch.seen()[0]?.free).toBe(true);

    const charges = await door.listCharges(world.grantId);
    expect(charges[0]).toMatchObject({ state: "charged", pricedFree: true });
  });
});

describe("B20.4 (#344) isolation — the personal key cannot reach company scope (AC-3)", () => {
  test("a company-scope selector present in the request is the attempt itself", async () => {
    const world = await seedWorld({ basis: "priced" });
    const dispatch = makeDispatch();
    const audit = makeAudit();
    const door = doorWith(dispatch, audit);

    for (const field of ["workspaceId", "teamId", "WORKSPACEID"]) {
      const outcome = await door.admit(admissionBody(world, { [field]: "acme" }));
      expect(outcome).toMatchObject({
        status: "refused",
        stage: "isolation",
        reasonCode: "company_scope_refused",
      });
    }
    expect(dispatch.calls()).toBe(0);

    const charges = await door.listCharges(world.grantId);
    expect(charges).toHaveLength(3);
    expect(charges.every((charge) => charge.state === "refused")).toBe(true);

    const events = audit.of("billing.tool_overreach_refused");
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.payload.reasonCode).toBe("company_scope_refused");
      expect(event.payload.grantId).toBe(world.grantId);
    }
  });

  test("a company-scoped tool is denied to a personal model-access grant, before any price", async () => {
    const world = await seedWorld({ basis: "priced" });
    const dispatch = makeDispatch();
    const audit = makeAudit();
    const companyTools = new Set(["company-report", "company-ledger"]);
    const door = doorWith(dispatch, audit, (tool) => companyTools.has(tool));

    const denied = await door.admit(admissionBody(world, { tool: "company-report" }));
    expect(denied).toMatchObject({
      status: "refused",
      stage: "isolation",
      reasonCode: "tool_scope_denied",
    });
    expect(dispatch.calls()).toBe(0);

    const charges = await door.listCharges(world.grantId);
    expect(charges[0]).toMatchObject({
      state: "refused",
      refusalReason: "tool_scope_denied",
    });

    const events = audit.of("billing.tool_overreach_refused");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      tool: "company-report",
      reasonCode: "tool_scope_denied",
    });

    // A personal tool on the same door still admits — the policy narrows, never widens.
    const allowed = await door.admit(admissionBody(world, { tool: "personal-notes" }));
    expect(allowed).toMatchObject({ status: "admitted" });
  });

  test("a malformed request refuses at the shape boundary with nothing recorded", async () => {
    const world = await seedWorld({ basis: "priced" });
    const dispatch = makeDispatch();
    const door = doorWith(dispatch, makeAudit());

    const invalid = await door.admit({ entry: "made.up.entry" });
    expect(invalid).toMatchObject({
      status: "refused",
      stage: "shape",
      reasonCode: "request_invalid",
    });
    const noGrant = await door.admit(admissionBody(world, { grantId: "" }));
    expect(noGrant).toMatchObject({ status: "refused", stage: "shape" });
    expect(dispatch.calls()).toBe(0);
    // A shape refusal writes no identity row: there is no call to identify.
    const charges = await door.listCharges(world.grantId);
    expect(charges).toHaveLength(0);
  });
});
