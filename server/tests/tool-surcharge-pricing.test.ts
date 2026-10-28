import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import {
  assertPriceSnapshotDims,
  mapPriceDims,
  PRICE_DIMENSIONS,
} from "../src/gateway/price-snapshot";
import {
  TOOL_IDENTITY_ENTRY_IDS,
  TOOL_SURCHARGE_BILLED_DIMENSIONS,
  TOOL_SURCHARGE_ENTRIES,
  assessToolSurchargeEnablement,
  toolSurchargeRegistryIssues,
} from "../src/billing/tool-surcharge-pricing";
import {
  TOOL_CHARGE_ID_PREFIX,
  listToolCallChargesByGrant,
  recordToolCallCharge,
} from "../src/billing/tool-call-charge";
import { createCreditReserveService } from "../src/billing/credit-reserve";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount } from "../src/billing/payer";
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
import { toolCallCharges } from "../src/db/schema/credit-reservations";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 20.1 (#341) — the tool/route surcharge map. Four things are pinned here:
 *
 *   AC-1  the enumeration is COMPLETE and derived from real seams: every registry entry's
 *         anchor names a file that exists (and a symbol that is in it), the registry is
 *         internally consistent, and the identity entry set is exactly what the table's
 *         CHECK accepts;
 *   AC-2  the two new dimensions enter the snapshot vocabulary: mapPriceDims records them
 *         unknown-with-reason when the wire is silent (never 0), a full 14-key dims
 *         object validates and a 12-key legacy one is refused, and the enablement verdict
 *         over a basis refuses naming each missing dimension;
 *   AC-3  every real tool call has an independent billing identity: the writer mints one
 *         row per call with its own hold's attempt id, resolves the payer off the grant,
 *         and converges a replay on the existing row;
 *   AC-4  tool fees and model fees are distinguishable in the data model: a charge's
 *         dimension is always a surcharge member — the database itself refuses a model
 *         dimension — and the tool call's attempt id is its own, not the model call's.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b20-341-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
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

/** The pre-0195 vocabulary — the shape every snapshot written before this ticket carries. */
const LEGACY_AMOUNTS = Object.fromEntries(
  Object.entries(V1_AMOUNTS).filter(
    ([dimension]) =>
      !dimension.startsWith("surcharge_tool") &&
      !dimension.startsWith("surcharge_a2a"),
  ),
);

describe("B20.1 (#341) tool surcharge pricing — enumeration (AC-1)", () => {
  test("the registry is internally consistent", () => {
    expect(toolSurchargeRegistryIssues()).toEqual([]);
    // The identity set is exactly the five entrances the table CHECK accepts.
    expect([...TOOL_IDENTITY_ENTRY_IDS].sort()).toEqual([
      "a2a.call",
      "injected.tool_call",
      "injected.web_search",
      "mcp.tool_call",
      "responses.tool_call",
    ]);
    // The billed set is exactly the three surcharge dimensions tool calls bill on.
    expect([...TOOL_SURCHARGE_BILLED_DIMENSIONS]).toEqual([
      "surcharge_web_search",
      "surcharge_tool_call",
      "surcharge_a2a_call",
    ]);
  });

  test("every entry's anchor names a real seam — a seam that moves breaks this, not 22.1", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    for (const entry of TOOL_SURCHARGE_ENTRIES) {
      const [path, symbol] = entry.anchor.split(" (");
      const file = join(repoRoot, path);
      expect(existsSync(file), `${entry.id}: anchor file ${path} exists`).toBe(
        true,
      );
      if (symbol !== undefined) {
        const needle = symbol.replace(/\)$/, "").split(" ")[0];
        const body = readFileSync(file, "utf8");
        expect(
          body.includes(needle),
          `${entry.id}: anchor symbol ${needle} is in ${path}`,
        ).toBe(true);
      }
    }
  });

  test("every entrance that can execute a tool bills an identity; non-entrances say why", () => {
    const entrances = TOOL_SURCHARGE_ENTRIES.filter(
      (entry) => entry.billsIdentity,
    );
    expect(entrances.length).toBe(5);
    for (const entry of TOOL_SURCHARGE_ENTRIES.filter(
      (e) => !e.billsIdentity,
    )) {
      expect(entry.notAnEntranceReason).toBeDefined();
      expect(entry.dimension).toBeNull();
    }
  });
});

describe("B20.1 (#341) tool surcharge pricing — dimensions (AC-2)", () => {
  test("the wire's silence is unknown with a reason, never a 0", () => {
    const dims = mapPriceDims({
      id: "prov/tool-model",
      pricing: {
        prompt: "0.000001",
        completion: "0.000002",
        web_search: "0.001",
        request: "0",
      },
    });
    // The one tool family the v1 wire prices is known.
    expect(dims.surcharge_web_search).toEqual({
      status: "known",
      amount: "0.001",
    });
    // The two the wire cannot price are unknown with the fixed reason — never 0.
    expect(dims.surcharge_tool_call).toEqual({
      status: "unknown",
      reason: "price_dim_no_source",
    });
    expect(dims.surcharge_a2a_call).toEqual({
      status: "unknown",
      reason: "price_dim_no_source",
    });
    expect("amount" in dims.surcharge_tool_call).toBe(false);
    // And both are members of the closed vocabulary the snapshot carries.
    expect(PRICE_DIMENSIONS).toContain("surcharge_tool_call");
    expect(PRICE_DIMENSIONS).toContain("surcharge_a2a_call");
  });

  test("the full 14-key dims validate; the 12-key legacy shape is refused", () => {
    expect(() =>
      assertPriceSnapshotDims(dimsOf(V1_AMOUNTS), "test"),
    ).not.toThrow();
    expect(() =>
      assertPriceSnapshotDims(dimsOf(LEGACY_AMOUNTS), "test"),
    ).toThrow(/closed dimension set/);
  });

  test("the enablement verdict refuses an unpriced basis naming every missing dimension", () => {
    // A basis with the tool dimensions unknown: the verdict refuses with BOTH missing
    // members and their reasons — never "known except", never a 0.
    const refused = assessToolSurchargeEnablement(
      mapPriceDims({ id: "prov/m", pricing: { prompt: "0.000001" } }),
    );
    expect(refused).toMatchObject({
      status: "refused",
      code: "tool_price_unknown",
    });
    if (refused.status === "refused") {
      expect(refused.missing).toEqual([
        { dimension: "surcharge_web_search", reason: "price_dim_no_source" },
        { dimension: "surcharge_tool_call", reason: "price_dim_no_source" },
        { dimension: "surcharge_a2a_call", reason: "price_dim_no_source" },
      ]);
    }

    // All known and non-zero: enabled, priced.
    const enabled = assessToolSurchargeEnablement(
      dimsOf({ ...V1_AMOUNTS, surcharge_web_search: "0.001" }) as never,
    );
    expect(enabled).toEqual({ status: "enabled", free: false });

    // All known and exactly zero: enabled, free — free is a price, not a gap.
    const free = assessToolSurchargeEnablement(
      dimsOf({
        ...V1_AMOUNTS,
        surcharge_web_search: "0",
        surcharge_tool_call: "0",
        surcharge_a2a_call: "0",
      }) as never,
    );
    expect(free).toEqual({ status: "enabled", free: true });
  });
});

/*
 * The identity half (AC-3/AC-4) runs on the real PostgreSQL: a hold is a real reserve,
 * because the attempt id the row carries is the hold's own — faking one would test the
 * fake, not the bijection.
 */
let seedCounter = 0;

async function seedWorld(options: { freeBasis?: boolean } = {}) {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;
  const capability = "chat";

  await database.insert(botServices).values({
    botId,
    displayName: `Tool Fee Bot ${n}`,
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
      dims: (options.freeBasis === true
        ? dimsOf({
            ...V1_AMOUNTS,
            surcharge_web_search: "0",
            surcharge_tool_call: "0",
            surcharge_a2a_call: "0",
          })
        : dimsOf(V1_AMOUNTS)) as never,
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
    reason: "tool-surcharge fixture",
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

/** Reserve one chat call through the real door — the model call's own hold. */
async function reserveModelCall(world: {
  grantId: string;
  userId: string;
  provider: string;
  model: string;
  n: number;
}) {
  return reserveService.reserve({
    grantId: world.grantId,
    payer: { kind: "personal", id: world.userId },
    model: {
      provider: world.provider,
      model: world.model,
      capability: "chat",
    },
    snapshotVersion: 1,
    rateVersion: 0,
    maximumCredits: 100,
    idempotencyKey: `${prefix}-model-reserve-${world.n}`,
    boundEvidence: [{ kind: "provider_max_tokens", maximumTokens: 1000 }],
  });
}

afterAll(async () => {
  await database
    .delete(toolCallCharges)
    .where(like(toolCallCharges.grantId, `${prefix}%`));
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
  await database
    .delete(accessGrants)
    .where(like(accessGrants.grantId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database
    .delete(gatewayModelCatalogRefs)
    .where(like(gatewayModelCatalogRefs.provider, `${prefix}%`));
  await database
    .delete(gatewayModelOpenScopes)
    .where(like(gatewayModelOpenScopes.provider, `${prefix}%`));
});

describe("B20.1 (#341) tool surcharge pricing — identity (AC-3)", () => {
  test("a charged tool call carries its own hold's attempt id and the grant's resolved payer", async () => {
    const world = await seedWorld();
    const modelCall = await reserveModelCall(world);
    expect(modelCall.status).toBe("reserved");
    if (modelCall.status !== "reserved") return;

    const toolCall = await reserveService.reserve({
      grantId: world.grantId,
      payer: { kind: "personal", id: world.userId },
      model: {
        provider: world.provider,
        model: world.model,
        capability: "chat",
      },
      snapshotVersion: 1,
      rateVersion: 0,
      maximumCredits: 5,
      idempotencyKey: `${prefix}-tool-reserve-${world.n}`,
      boundEvidence: [
        { kind: "self_enforced_input_refusal", maximumTokens: 1 },
      ],
    });
    expect(toolCall.status).toBe("reserved");
    if (toolCall.status !== "reserved") return;

    const recorded = await recordToolCallCharge(database, {
      idempotencyKey: `${prefix}-charge-${world.n}`,
      entry: "mcp.tool_call",
      tool: "clientA-search",
      dimension: "surcharge_tool_call",
      grantId: world.grantId,
      outcome: { kind: "charged", reservationId: toolCall.reservationId },
    });
    expect(recorded.status).toBe("recorded");
    if (recorded.status === "recorded" || recorded.status === "already") {
      const charge = recorded.charge;
      expect(charge.chargeId.startsWith(TOOL_CHARGE_ID_PREFIX)).toBe(true);
      expect(charge.state).toBe("charged");
      // The attempt is the tool call's OWN hold's — not the model call's.
      expect(charge.attemptId).not.toBeNull();
      expect(charge.attemptId?.startsWith("att-")).toBe(true);
      expect(charge.attemptId).not.toBe(
        `att-${modelCall.reservationId.slice(3)}`,
      );
      // The payer is resolved off the grant, never the input's spelling.
      expect(charge.payer).toEqual({ kind: "personal", id: world.userId });
      expect(charge.entry).toBe("mcp.tool_call");
      expect(charge.dimension).toBe("surcharge_tool_call");
    }

    // A replay of the same call converges on the existing row, whatever it now claims.
    const replay = await recordToolCallCharge(database, {
      idempotencyKey: `${prefix}-charge-${world.n}`,
      entry: "mcp.tool_call",
      tool: "clientA-search",
      dimension: "surcharge_tool_call",
      grantId: world.grantId,
      outcome: { kind: "refused", reason: "price_unknown" },
    });
    expect(replay.status).toBe("already");
    if (replay.status === "already") {
      expect(replay.charge.state).toBe("charged");
    }
  });

  test("a refused call records the refusal with no reservation; a free call charges hold-free", async () => {
    const world = await seedWorld();
    const refused = await recordToolCallCharge(database, {
      idempotencyKey: `${prefix}-refused-${world.n}`,
      entry: "a2a.call",
      tool: "agent-b",
      dimension: "surcharge_a2a_call",
      grantId: world.grantId,
      outcome: { kind: "refused", reason: "tool_price_unknown" },
    });
    expect(refused.status).toBe("recorded");
    if (refused.status === "recorded" || refused.status === "already") {
      expect(refused.charge.state).toBe("refused");
      expect(refused.charge.reservationId).toBeNull();
      expect(refused.charge.attemptId).toBeNull();
      expect(refused.charge.refusalReason).toBe("tool_price_unknown");
      expect(refused.charge.pricedFree).toBe(false);
    }

    const free = await recordToolCallCharge(database, {
      idempotencyKey: `${prefix}-free-${world.n}`,
      entry: "injected.web_search",
      tool: "web_search",
      dimension: "surcharge_web_search",
      grantId: world.grantId,
      outcome: { kind: "charged-free" },
    });
    expect(free.status).toBe("recorded");
    if (free.status === "recorded" || free.status === "already") {
      expect(free.charge.state).toBe("charged");
      expect(free.charge.pricedFree).toBe(true);
      expect(free.charge.reservationId).toBeNull();
    }

    const byGrant = await listToolCallChargesByGrant(database, world.grantId);
    expect(byGrant.map((charge) => charge.state).sort()).toEqual([
      "charged",
      "refused",
    ]);
  });

  test("a grant that does not exist refuses before any row", async () => {
    const outcome = await recordToolCallCharge(database, {
      idempotencyKey: `${prefix}-orphan`,
      entry: "mcp.tool_call",
      tool: "x",
      dimension: "surcharge_tool_call",
      grantId: `${prefix}-no-such-grant`,
      outcome: { kind: "refused", reason: "price_unknown" },
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reasonCode: "grant_invalid",
    });
  });
});

describe("B20.1 (#341) tool surcharge pricing — distinguishability (AC-4)", () => {
  test("the database itself refuses a model dimension on a tool charge", async () => {
    const world = await seedWorld();
    // A model dimension on a tool-fee row would blur exactly the line this table is;
    // the catch is manual because the driver's rejection is not always an Error.
    let refused = false;
    try {
      await database.insert(toolCallCharges).values({
        chargeId: `${TOOL_CHARGE_ID_PREFIX}bad`,
        idempotencyKey: `${prefix}-bad-dim-${world.n}`,
        entry: "mcp.tool_call",
        tool: "x",
        // A model dimension on a tool-fee row would blur exactly the line this table is.
        dimension: "input",
        grantId: world.grantId,
        payerKind: "personal",
        payerId: world.userId,
        state: "refused",
        refusalReason: "shape_probe",
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    const rows = await database
      .select({ chargeId: toolCallCharges.chargeId })
      .from(toolCallCharges)
      .where(like(toolCallCharges.grantId, world.grantId));
    expect(rows).toEqual([]);
  });
});
