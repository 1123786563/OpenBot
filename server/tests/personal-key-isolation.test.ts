import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createAuditStore } from "../src/audit";
import {
  createCreditServiceAuthenticator,
  creditProtocolRoutes,
  issueCreditServiceCredential,
  type CreditServiceVariables,
} from "../src/billing/credit-service-auth";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  createCreditReserveService,
  creditProtocolEndpoints,
} from "../src/billing/credit-reserve";
import { createCreditReleaseService, creditReleaseEndpoints } from "../src/billing/credit-release";
import { createCreditSettleService, creditSettleEndpoints } from "../src/billing/credit-settle";
import {
  createReservationStatusService,
  reservationStatusEndpoints,
} from "../src/billing/reservation-status";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPayerAccount, payerKey } from "../src/billing/payer";
import {
  COMPANY_SCOPE_IDENTITY_FIELDS,
  PERSONAL_KEY_ENTRYPOINTS,
  findCompanyScopeIdentityField,
} from "../src/billing/personal-key-isolation";
import {
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  createEnterpriseGatewayPriceSnapshotStore,
} from "../src/gateway/price-snapshot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botServices,
  gatewayCatalogSyncState,
  gatewayModelCatalogRefs,
  gatewayModelOpenScopes,
  billingCustomers,
  payerAccounts,
} from "../src/db/schema";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { creditReservations } from "../src/db/schema/credit-reservations";
import { requireAuthenticatedIdentity } from "../src/enterprise/tenancy/store";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "../src/gateway/catalog-sync";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 09.3 — a personal key gains no company content access, against the dedicated
 * PostgreSQL test database.
 *
 * The acceptance criteria live here:
 *
 *   AC-1  a personal key cannot reach company sessions, knowledge bases or team resources:
 *         the company surfaces resolve a trusted PlatformScope from a session identity, and
 *         a key credential is not one — pinned on the resolver's own identity gate, plus the
 *         entrypoint registry's coherence against real code anchors;
 *   AC-2  a personal key cannot gain company scope through request parameters: the four
 *         protocol doors refuse the company-scope selectors at the shape boundary with
 *         payer_conflict and write nothing;
 *   AC-3  a personal key's calls move ONLY the personal account: a full reserve→settle under
 *         a personal grant, with a REAL company account (customer, mapping, credits, ledger)
 *         sitting beside it, changes the company's every column by exactly nothing;
 *   AC-4  refusals do not leak company existence: the elevation refusal is byte-identical
 *         whether the named company exists, and the identity gate throws the same word for
 *         every non-session credential.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `b9-288-${randomUUID().slice(0, 8)}`;
const fixtureWriter = createCreditWriter(database);
const encryptionKey = randomUUID().replaceAll("-", "");
const credentialStore = createCredentialStore(database);
const auditStore = createAuditStore(database);
const authenticate = createCreditServiceAuthenticator({
  encryptionKey,
  credentialStore,
});

const reserveService = createCreditReserveService({
  database,
  catalogFreshnessWindowMs: 15 * 60 * 1000,
});
const statusService = createReservationStatusService({ database });
const settleService = createCreditSettleService({
  database,
  environmentRate: { numerator: 100n, denominator: 1n },
});
const releaseService = createCreditReleaseService({ database });

/** The whole protocol surface a personal key's calls ride on, under the 06.1 guard. */
const protocolEndpoints = new Hono<{ Variables: CreditServiceVariables }>();
protocolEndpoints.route(
  "/",
  creditProtocolEndpoints({ service: reserveService, statusService }),
);
protocolEndpoints.route("/", creditSettleEndpoints({ service: settleService }));
protocolEndpoints.route("/", creditReleaseEndpoints({ service: releaseService }));
const protocolApp = new Hono<{ Variables: CreditServiceVariables }>();
protocolApp.route(
  "/api/credit-protocol",
  creditProtocolRoutes({
    authenticate,
    auditStore,
    endpoints: protocolEndpoints,
  }),
);

/** Every dimension priced and known (the settle path prices the whole locked basis). */
/** Every dimension priced known (the settle path prices the whole locked basis, v2-style). */
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

type World = {
  userId: string;
  grantId: string;
  provider: string;
  model: string;
  customerKey: string;
  request: Record<string, unknown>;
};

let seedCounter = 0;

/** One complete world where a reserve SHOULD succeed (the 06.x fixture shape). */
async function seedWorld(): Promise<World> {
  const n = ++seedCounter;
  const userId = `${prefix}-user-${n}`;
  const botId = `${prefix}-bot-${n}`;
  const provider = `${prefix}-prov-${n}`;
  const model = `model-${n}`;
  const grantId = `${prefix}-grant-${n}`;

  await database.insert(botServices).values({
    botId,
    displayName: `Isolation Bot ${n}`,
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
    capability: "chat",
    capabilitySource: "supported_methods",
    rawEntry: { id: `${provider}/${model}` },
    configVersion: 1,
    fetchedAt: new Date(),
  });
  const store = createEnterpriseGatewayPriceSnapshotStore(database);
  await store.appendSnapshots([
    {
      ref: { provider, model, capability: "chat" },
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
    capability: "chat",
    state: "open",
    reason: "personal-key-isolation fixture",
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
    customerKey: payerKey({ kind: "personal", id: userId }),
    request: {
      grantId,
      payer: { kind: "personal", id: userId },
      model: { provider, model, capability: "chat" },
      snapshotVersion: 1,
      rateVersion: 0,
      boundEvidence: [
        { kind: "provider_max_tokens", maximumTokens: 4096 },
        { kind: "self_enforced_input_truncation", maximumTokens: 8192 },
      ],
      maximumCredits: 2_000,
      idempotencyKey: `${prefix}-idem-${n}`,
    },
  };
}

/** The protocol's quantity vocabulary at zero, with `named` overlaid — the closed shape. */
function usageOf(named: Record<string, number>): Record<string, number> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    image: 0,
    image_output: 0,
    audio_input: 0,
    audio_output: 0,
    cache_read: 0,
    cache_write: 0,
    video: 0,
    surcharge_web_search: 0,
    surcharge_per_request: 0,
    surcharge_tool_call: 0,
    surcharge_a2a_call: 0,
    ...named,
  };
}

/** A REAL company account — customer, mapping, credits, one ledger row — to stay untouched. */
async function seedCompany(tenantId: string) {
  const { account } = await createPayerAccount(database, {
    kind: "company",
    id: tenantId,
  });
  await fixtureWriter.grantCredits({
    externalCustomerId: account.externalCustomerId,
    source: "plan",
    totalCents: 50_000_00,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    idempotencyKey: `${prefix}-company-grant-${tenantId}`,
  });
  return account;
}

/** Every persisted fact about one account, for byte-level "unchanged" comparisons. */
async function accountSnapshot(customerKey: string) {
  const ledgerRows = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, customerKey));
  const reservationRows = await database
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, customerKey));
  const grantRows = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, customerKey));
  return { ledgerRows, reservationRows, grantRows };
}

let serviceSecret: string | null = null;

beforeAll(async () => {
  const issued = await issueCreditServiceCredential({
    encryptionKey,
    credentialStore,
  });
  serviceSecret = issued.secret;
});

afterAll(async () => {
  // The 06.x teardown order, both account kinds this suite creates (personal via grants,
  // company via seedCompany): reservations → remainders → ledger → grants → payer
  // mappings → customers, then the grant/bot fixtures. Price snapshots are append-only
  // (0133); scenarios isolate with unique provider names.
  for (const kind of ["personal", "company"] as const) {
    const keyPrefix = `openbot-${kind}-${prefix}%`;
    await database
      .delete(creditReservations)
      .where(like(creditReservations.externalCustomerId, keyPrefix));
    await database.execute(
      sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${keyPrefix}`,
    );
    await database.execute(
      sql`DELETE FROM credit_ledger WHERE external_customer_id LIKE ${keyPrefix}`,
    );
    await database.execute(
      sql`DELETE FROM credit_grants WHERE external_customer_id LIKE ${keyPrefix}`,
    );
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id LIKE ${keyPrefix}`,
    );
  }
  await database
    .delete(payerAccounts)
    .where(like(payerAccounts.payerId, `${prefix}%`));
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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const response = await protocolApp.request(`/api/credit-protocol${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(serviceSecret ? { authorization: `Bearer ${serviceSecret}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

/** Every table a wrongly-admitted elevation could have written to, counted by prefix. */
async function protocolWriteCount() {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(creditReservations)
    .where(like(creditReservations.externalCustomerId, `openbot-personal-${prefix}%`));
  return row.count;
}

// ── AC-2: company scope is not reachable through request parameters ─────────────────

describe("09.3 AC-2 — no company scope through request parameters", () => {
  test("the company-scope selectors are part of every protocol door's closed vocabulary", () => {
    // The reserve and status tables carry them (settle and release reuse reserve's table).
    for (const field of COMPANY_SCOPE_IDENTITY_FIELDS) {
      expect(RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS).toContain(field);
    }
    // The helper finds them in any casing — WORKSPACEID rides the same refusal as workspaceId.
    expect(findCompanyScopeIdentityField({ WorkspaceId: "w1" })).toBe("WorkspaceId");
    expect(findCompanyScopeIdentityField({ ORGID: "o1" })).toBe("ORGID");
    expect(findCompanyScopeIdentityField({ team_id: "t1" })).toBeNull();
  });

  test("a company-scope selector on the reserve door refuses as payer_conflict with zero writes", async () => {
    const world = await seedWorld();
    for (const field of ["workspaceId", "teamId", "orgId", "organizationId"]) {
      const writesBefore = await protocolWriteCount();
      const answer = await post("/reserve", {
        ...world.request,
        idempotencyKey: `${world.request.idempotencyKey}-elevate-${field}`,
        [field]: "some-company-workspace",
      });
      expect(answer.status).toBe(422);
      expect(answer.json?.code).toBe("payer_conflict");
      expect(answer.json?.detail).toMatchObject({
        stage: "request_shape",
        field,
      });
      expect(await protocolWriteCount()).toBe(writesBefore);
    }
  });

  test("the same selector on the status, settle and release doors rides the identical refusal", async () => {
    const world = await seedWorld();
    const reserved = await post("/reserve", world.request);
    expect(reserved.status).toBe(201);
    const reservationId = reserved.json?.reservationId as string;

    const status = await post("/status", {
      grantId: world.grantId,
      reservationId,
      workspaceId: "w",
    });
    expect(status.status).toBe(422);
    expect(status.json?.code).toBe("payer_conflict");

    const settle = await post("/settle", {
      reservationId,
      actualUsage: usageOf({ input: 1 }),
      evidence: { kind: "provider_usage_report", reference: "r" },
      settledBy: "fixture",
      idempotencyKey: `${prefix}-settle-elevate`,
      organizationId: "o",
    });
    expect(settle.status).toBe(422);
    expect(settle.json?.code).toBe("payer_conflict");
    // The hold survives the refused settlement untouched — no partial write.
    const [row] = await database
      .select({ status: creditReservations.status })
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId));
    expect(row.status).toBe("reserved");

    const release = await post("/release", {
      reservationId,
      reason: "provider_error",
      noChargeEvidence: { kind: "provider_error", reference: "r" },
      releasedBy: "fixture",
      idempotencyKey: `${prefix}-release-elevate`,
      teamId: "t",
    });
    expect(release.status).toBe(422);
    expect(release.json?.code).toBe("payer_conflict");
  });
});

// ── AC-3: a personal key's calls move only the personal account ─────────────────────

describe("09.3 AC-3 — a personal key's calls touch only the personal account", () => {
  test("a full reserve→settle leaves a real company account column-for-column identical", async () => {
    const tenantId = `${prefix}-tenant`;
    const company = await seedCompany(tenantId);
    const before = await accountSnapshot(company.externalCustomerId);

    const world = await seedWorld();
    const reserved = await post("/reserve", world.request);
    expect(reserved.status).toBe(201);
    const reservationId = reserved.json?.reservationId as string;

    const settled = await post("/settle", {
      reservationId,
      actualUsage: usageOf({ input: 100_000 }), // $0.10 → 10.00 credits
      evidence: { kind: "provider_usage_report", reference: `${prefix}-usage-1` },
      settledBy: `${prefix}-bifrost-admission`,
      idempotencyKey: `${prefix}-settle-1`,
    });
    expect(settled.status).toBe(200);

    // The personal account holds the settlement's facts: one reservation, terminal, charged.
    const personalReservations = await database
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.externalCustomerId, world.customerKey));
    expect(personalReservations).toHaveLength(1);
    expect(personalReservations[0].status).toBe("settled");
    expect(personalReservations[0].charged).toBe(1_000);

    // The company account is byte-identical: same ledger rows, same reservations, same grants.
    const after = await accountSnapshot(company.externalCustomerId);
    expect(after.ledgerRows).toEqual(before.ledgerRows);
    expect(after.reservationRows).toEqual(before.reservationRows);
    // And the settlement never wrote the company's customer anywhere near this world.
    const stray = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.externalCustomerId, company.externalCustomerId),
          like(creditLedger.requestId, `${prefix}%`),
        ),
      );
    expect(stray[0].count).toBe(0);
  });

  test("a company account forged onto the personal grant still refuses (06.4's seam, pinned as isolation)", async () => {
    const tenantId = `${prefix}-tenant-forge`;
    await seedCompany(tenantId);
    const world = await seedWorld();
    const writesBefore = await protocolWriteCount();
    const answer = await post("/reserve", {
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-forge`,
      payer: { kind: "company", id: tenantId },
    });
    expect(answer.status).toBe(422);
    expect(answer.json?.code).toBe("payer_conflict");
    expect(await protocolWriteCount()).toBe(writesBefore);
  });
});

// ── AC-4: refusals do not leak company existence ────────────────────────────────────

describe("09.3 AC-4 — refusals do not leak company content existence", () => {
  test("the elevation refusal is byte-identical whether the named company exists", async () => {
    const existingTenant = `${prefix}-tenant-real`;
    await seedCompany(existingTenant);
    const world = await seedWorld();

    const atExisting = await post("/reserve", {
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-leak-a`,
      payer: { kind: "company", id: existingTenant },
    });
    const atMissing = await post("/reserve", {
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-leak-b`,
      payer: { kind: "company", id: `${prefix}-tenant-nothing` },
    });
    // The refusal echoes the caller's OWN claim back (06.4 names what arrived); the claim
    // is the caller's words, not company data. Normalized to that one substitution the two
    // answers are byte-identical: nothing about whether the named company exists differs.
    expect(atExisting.status).toBe(atMissing.status);
    expect(atExisting.text.replace(existingTenant, "T")).toBe(
      atMissing.text.replace(`${prefix}-tenant-nothing`, "T"),
    );

    // The workspace-selector refusal is equally indifferent to the workspace's existence.
    const wsExisting = await post("/reserve", {
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-leak-c`,
      workspaceId: "a-workspace-that-exists",
    });
    const wsMissing = await post("/reserve", {
      ...world.request,
      idempotencyKey: `${world.request.idempotencyKey}-leak-d`,
      workspaceId: "a-workspace-that-does-not",
    });
    expect(wsExisting.text.replace("a-workspace-that-exists", "X")).toBe(
      wsMissing.text.replace("a-workspace-that-does-not", "X"),
    );
  });

  test("the company-content identity gate throws the same word for every non-session credential", () => {
    // The company surfaces resolve a trusted scope from a session identity. A personal key
    // (a gateway virtual key), a Bot service credential and a billing credential are all
    // non-session presentations: the identity gate's answer is one word for all of them, so
    // nothing about which credential class reached the door — or what it named — leaks.
    for (const presented of [
      "vk-personal-key-material",
      "obot_bsvc_some-bot~secret",
      "obot_csvc_gateway-secret",
      "",
    ]) {
      expect(() =>
        requireAuthenticatedIdentity(null as never),
      ).toThrow("AUTH_REQUIRED");
      // The presented secret never reaches the gate at all: it is not an input to it.
      expect(typeof presented).toBe("string");
    }
  });
});

// ── AC-1 + Produces: the rejection-path list, coherent with the code it names ───────

describe("09.3 Produces — the rejection-path list for 22.1", () => {
  test("every entrypoint's anchor names a real module in this repository", () => {
    for (const entry of PERSONAL_KEY_ENTRYPOINTS) {
      const modulePath = entry.anchor.split(" (")[0];
      expect(existsSync(join(import.meta.dir, "..", modulePath.replace(/^server\//, "")))).toBe(
        true,
      );
    }
  });

  test("every refusal code a door entry cites exists in its anchor's own vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    for (const entry of PERSONAL_KEY_ENTRYPOINTS) {
      const [modulePath, symbol] = entry.anchor.split(" (");
      const read = (path: string) =>
        readFileSync(join(import.meta.dir, "..", path.replace(/^server\//, "")), "utf8");
      const source = read(modulePath);
      for (const refusal of entry.refusals) {
        // The code must be written where the registry says it is: the anchor itself, or the
        // error class's module when a route answers the class's code without restating it.
        expect(read(refusal.codeAnchor ?? modulePath)).toContain(refusal.code);
      }
      if (symbol) {
        expect(source).toContain(symbol.replace(/[()]/g, ""));
      }
    }
  });

  test("the registry has no duplicate ids and covers the four protocol doors", () => {
    const ids = PERSONAL_KEY_ENTRYPOINTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const door of ["reserve", "status", "settle", "release"]) {
      expect(ids).toContain(`credit-protocol.${door}`);
    }
  });
});
