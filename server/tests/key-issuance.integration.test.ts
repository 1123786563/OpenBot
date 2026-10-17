import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { payerKey } from "../src/billing/payer";
import { botServiceRoutes } from "../src/bot-services/auth";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botBindingOffers,
  botServices,
  credentials,
  creditGrants,
  creditLedger,
  creditReservations,
} from "../src/db/schema";
import { gatewayCustomers, gatewayVirtualKeys } from "../src/db/schema/gateway";
import {
  createGatewayCustomerProvisioner,
  type GatewayCustomerProvisioner,
} from "../src/gateway/customer";
import {
  createGatewayKeyIssuer,
  createGatewayVirtualKeyClient,
  createKeyIssuanceRoutes,
} from "../src/gateway/key-issuance";
import {
  GatewayNotReadyError,
  type GatewayReadiness,
  type GatewayReadinessService,
} from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost 05.3 (#244): one independent virtual key per (user × Bot) authorization, on a real
 * PostgreSQL and a fake Bifrost management surface (Bun.serve, test-only — production dials the
 * configured endpoint with the resolved admin credential, exactly what 01.1/01.2 installed and
 * what 05.1's provisioner already integrates against).
 *
 * The questions here are the ticket's own: two different Bots claiming keys for the same user
 * get two different keys that bill the SAME gateway Customer (AC02 — all keys share one
 * balance); issuing a key adds no credit quota, creates no grant and copies no budget; a Bot
 * using another authorization's grantId — another Bot's, or a revoked one — is refused without
 * creating anything; and the local record never holds the plaintext (only its sha256) while
 * credentialVersion starts at 1 and only ever grows.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);

/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const auditStore = createAuditStore(database);
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});

/** The fake Bifrost this file integrates against: customers and virtual-keys surfaces. */
const fake = startFakeBifrost();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

/** A gate that passes, the way 01.7's installed service answers on a ready deployment. */
function readyGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: true,
    blockingReasons: [],
    configVersion: endpoint.configVersion,
    checkedAt: new Date().toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => readiness,
    assertGatewayReadyForBilling: async () => readiness,
  };
}

/** A gate that refuses, the way 01.7's service answers when a condition is unmet. */
function refusingGate(): GatewayReadinessService {
  const readiness: GatewayReadiness = {
    ready: false,
    blockingReasons: ["gateway_readiness_probe_missing"],
    configVersion: endpoint.configVersion,
    checkedAt: new Date().toISOString(),
  };
  return {
    evaluateGatewayReadiness: async () => {
      throw new Error("not called");
    },
    assertGatewayReadyForBilling: async () => {
      throw new GatewayNotReadyError(readiness, [
        {
          reason: "gateway_readiness_probe_missing",
          message: "No successful probe is on file (test gate).",
        },
      ]);
    },
  };
}

/** The 05.1 provisioner seam, pointed at the fake Bifrost. */
function provisionerFor(gate: GatewayReadinessService = readyGate()) {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    gate,
  });
}

/** The issuer under test: real grant seam, real provisioner seam, real client adapter, fake gateway. */
function issuerFor(overrides?: {
  gate?: GatewayReadinessService;
  provisionCustomer?: GatewayCustomerProvisioner["provisionCustomer"];
}) {
  return createGatewayKeyIssuer({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    provisionCustomer:
      overrides?.provisionCustomer ??
      provisionerFor(overrides?.gate).provisionCustomer,
    // The production HTTP adapter, dialed at the fake Bifrost: the classification under test
    // (timeout, unauthenticated, unexpected status) is this adapter's, not the fake's.
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
  });
}

/** The bot-facing app under test: the real 04.2 door with the issuance router mounted.
 *
 * 05.4 made the claim answer `{ key, bundle }` and made the bundle sources a required
 * composition (a deployment that cannot complete the bundle refuses BEFORE minting —
 * fail-closed). This file's concern is still 05.3's, so the sources are wired the way the
 * production registry wires them: the same fake-Bifrost endpoint for the base URL and a
 * fixed selectable-refs answer for the Bot's model set; every 05.3 assertion below reads
 * `body.key`, which the added bundle does not disturb.
 */
function appFor(overrides?: Parameters<typeof issuerFor>[0]) {
  return botServiceRoutes({
    authenticate: registry.authenticate,
    keys: createKeyIssuanceRoutes({
      issue: issuerFor(overrides).issueKeyForGrant,
      bundle: {
        readGatewayEndpoint: async () => endpoint,
        listSelectableModels: async () => [
          {
            provider: "fake-provider",
            model: "issuance-chat",
            capability: "chat",
          },
        ],
      },
    }),
  });
}

const prefix = `b5-244-${run}`;

afterAll(async () => {
  // Children before parents; audit rows stay (append-only by design, ids are per-run).
  // Key rows are found by their botId (grant ids are UUIDs, not prefixed).
  await database
    .delete(gatewayVirtualKeys)
    .where(like(gatewayVirtualKeys.botId, `${prefix}%`));
  await database
    .delete(gatewayCustomers)
    .where(like(gatewayCustomers.payerId, `${prefix}%`));
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
  fake.stop();
});

/** A registered, credentialed bot under this file's prefix. */
async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: `Key Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

const offerIssuer = createBindingOfferIssuer({ database, auditStore });

/** One confirmed grant via the real 04.5 flow: issue a code at the bot, confirm as the user. */
async function confirmGrant(userId: string, botId: string, identity: string) {
  const offer = await offerIssuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await registry.modelAccess.confirm(
    userId,
    offer.bindingCode,
  );
  return grant;
}

/** A claim request through the route: the bot's credential names the caller. */
function claimKey(
  app: ReturnType<typeof botServiceRoutes>,
  secret: string,
  grantId: unknown,
) {
  return app.request("/keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ grantId }),
  });
}

describe("05.3 key issuance", () => {
  test("two bots issuing for the same user get two different keys billing the same customer", async () => {
    const app = appFor();
    const botA = await credentialedBot("a");
    const botB = await credentialedBot("b");
    const userId = `${prefix}-shared-user`;

    const grantA = await confirmGrant(userId, botA.botId, `slack:${userId}-a`);
    const grantB = await confirmGrant(userId, botB.botId, `slack:${userId}-b`);

    const responseA = await claimKey(app, botA.secret, grantA.grantId);
    expect(responseA.status).toBe(200);
    const bodyA = (await responseA.json()) as {
      key: { secret: string; customerId: string; keyId: string };
    };
    const responseB = await claimKey(app, botB.secret, grantB.grantId);
    expect(responseB.status).toBe(200);
    const bodyB = (await responseB.json()) as {
      key: { secret: string; customerId: string; keyId: string };
    };

    // Two different keys, each a real Bifrost virtual key value…
    expect(bodyA.key.keyId).not.toBe(bodyB.key.keyId);
    expect(bodyA.key.secret).not.toBe(bodyB.key.secret);
    expect(bodyA.key.secret.startsWith("sk-bf-")).toBe(true);
    expect(bodyB.key.secret.startsWith("sk-bf-")).toBe(true);

    // …billing the SAME customer: one mapping row for the user, both keys carry its id.
    const mapping = await database
      .select()
      .from(gatewayCustomers)
      .where(like(gatewayCustomers.payerId, `${prefix}-shared-user%`));
    expect(mapping).toHaveLength(1);
    expect(bodyA.key.customerId).toBe(mapping[0]!.gatewayCustomerId);
    expect(bodyB.key.customerId).toBe(mapping[0]!.gatewayCustomerId);

    // The remote holds two distinct virtual keys, both owned by that customer.
    const rows = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(inArray(gatewayVirtualKeys.botId, [botA.botId, botB.botId]))
      .orderBy(gatewayVirtualKeys.credentialVersion);
    expect(rows).toHaveLength(2);
    const remoteCustomerIds = new Set(
      fake
        .virtualKeysForCustomer(mapping[0]!.gatewayCustomerId)
        .map((vk) => vk.customerId),
    );
    expect(remoteCustomerIds).toEqual(new Set([mapping[0]!.gatewayCustomerId]));
    expect(
      fake.virtualKeysForCustomer(mapping[0]!.gatewayCustomerId),
    ).toHaveLength(2);
  }, 30_000);

  test("issuing a key adds no credit quota, no grant and no budget copy", async () => {
    const app = appFor();
    const bot = await credentialedBot("quota");
    const userId = `${prefix}-quota-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    // Counts are scoped to THIS user's payer key (the string credit_grants, credit_ledger and
    // credit_reservations key on): the suite shares one database, so a whole-table count would
    // race other files' writes and answer nothing about this issuance.
    const payer = payerKey({ kind: "personal", id: userId });
    const countOf = async (
      table:
        | typeof creditGrants
        | typeof creditLedger
        | typeof creditReservations,
    ) => {
      const [row] = await database
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.externalCustomerId, payer));
      return Number(row?.n ?? 0);
    };
    const grantsBefore = await countOf(creditGrants);
    const ledgerBefore = await countOf(creditLedger);
    const reservationsBefore = await countOf(creditReservations);
    const userGrantsBefore = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(eq(accessGrants.userId, userId));

    const response = await claimKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    await response.json();

    expect(await countOf(creditGrants)).toBe(grantsBefore);
    expect(await countOf(creditLedger)).toBe(ledgerBefore);
    expect(await countOf(creditReservations)).toBe(reservationsBefore);
    const userGrantsAfter = await database
      .select({ n: sql<number>`count(*)` })
      .from(accessGrants)
      .where(eq(accessGrants.userId, userId));
    expect(Number(userGrantsAfter[0]?.n)).toBe(Number(userGrantsBefore[0]?.n));

    // The remote create carried ownership, not governance: no budgets, no rate
    // limit, no provider configs — the customer's own budget governs (scope=customer).
    for (const body of fake.virtualKeyCreateBodies(run)) {
      expect(body).not.toHaveProperty("budgets");
      expect(body).not.toHaveProperty("rate_limit");
      expect(body).not.toHaveProperty("provider_configs");
      expect(body.allow_all_providers).toBe(true);
    }
  }, 30_000);

  test("a bot using another authorization's grantId is refused and nothing is created", async () => {
    const app = appFor();
    const botA = await credentialedBot("xbot-a");
    const botB = await credentialedBot("xbot-b");
    const userA = `${prefix}-xbot-user-a`;
    const userB = `${prefix}-xbot-user-b`;

    const grantA = await confirmGrant(userA, botA.botId, `slack:${userA}`);
    const grantB = await confirmGrant(userB, botB.botId, `slack:${userB}`);

    const createsBefore = fake.virtualKeyCreateCount();

    // The wrong Bot claims the grant…
    const crossBot = await claimKey(app, botB.secret, grantA.grantId);
    expect(crossBot.status).toBe(403);
    expect(await crossBot.json()).toEqual({
      error: "That model access grant cannot be used.",
      code: "model_access_grant_refused",
    });

    // …and so does a revoked grant, refused the same uniform way.
    await registry.modelAccess.revokeForUser(grantB.grantId, userB);
    const revoked = await claimKey(app, botB.secret, grantB.grantId);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({
      error: "That model access grant cannot be used.",
      code: "model_access_grant_refused",
    });

    // An unknown grantId reads as the same refusal — existence is not probeable.
    const unknown = await claimKey(app, botA.secret, randomUUID());
    expect(unknown.status).toBe(403);

    // No key row and no remote create answered any of those refusals.
    expect(fake.virtualKeyCreateCount()).toBe(createsBefore);
    const rows = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.botId, `${prefix}-xbot%`));
    expect(rows).toHaveLength(0);
  }, 30_000);

  test("the local record holds no plaintext and credentialVersion grows monotonically", async () => {
    const app = appFor();
    const bot = await credentialedBot("crypto");
    const userId = `${prefix}-crypto-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const first = await claimKey(app, bot.secret, grant.grantId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      key: { secret: string; credentialVersion: number };
    };
    const second = await claimKey(app, bot.secret, grant.grantId);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      key: { secret: string; credentialVersion: number };
    };

    expect(firstBody.key.credentialVersion).toBe(1);
    expect(secondBody.key.credentialVersion).toBe(2);
    expect(firstBody.key.secret).not.toBe(secondBody.key.secret);

    const rows = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.grantId, grant.grantId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // No column anywhere carries the plaintext (or a reducible piece of it).
      for (const [column, value] of Object.entries(row)) {
        expect(`${column}=${String(value)}`).not.toContain("sk-bf-");
      }
      expect(JSON.stringify(row)).not.toContain("sk-bf-");
      // The hash identifies the exact secret it was drawn from — sha256, not the value.
      const secret =
        row.credentialVersion === 1
          ? firstBody.key.secret
          : secondBody.key.secret;
      expect(row.valueHash).toBe(
        createHash("sha256").update(secret).digest("hex"),
      );
    }
  }, 30_000);

  test("failures refuse without a half-issued key: unauthenticated, malformed, not-ready gateway, gateway 500", async () => {
    // No credential: the door's own uniform 401, before the service is asked.
    const app = appFor();
    const bot = await credentialedBot("fail");
    const userId = `${prefix}-fail-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const anon = await app.request("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantId: grant.grantId }),
    });
    expect(anon.status).toBe(401);

    const malformed = await claimKey(app, bot.secret, undefined);
    expect(malformed.status).toBe(400);

    // A gateway that is not ready: refusal before anything is dialed or stored.
    const gated = appFor({ gate: refusingGate() });
    const notReady = await claimKey(gated, bot.secret, grant.grantId);
    expect(notReady.status).toBe(503);
    const notReadyBody = (await notReady.json()) as { code: string };
    expect(notReadyBody.code).toBe("gateway_not_ready");

    // The gateway answering 500: a typed 502, and NO local row (the transaction rolled back).
    fake.stage({ vkRespondWith: "status-500" });
    try {
      const failing = await claimKey(app, bot.secret, grant.grantId);
      expect(failing.status).toBe(502);
      const failingBody = (await failing.json()) as { code: string };
      expect(failingBody.code).toBe("gateway_vk_unexpected_status");
    } finally {
      fake.stage({ vkRespondWith: "valid" });
    }
    const rows = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.botId, `${prefix}-fail%`));
    expect(rows).toHaveLength(0);
  }, 30_000);
});

/**
 * A fake of the Bifrost management surfaces this ticket integrates with: customers (05.1's
 * seam) and virtual-keys (this ticket's create). Unique names, bearer-authenticated, and a
 * `stage` for the failure modes the adapter must classify. Test-only: production dials the
 * configured endpoint, and nothing here is a fallback for it.
 */
function startFakeBifrost() {
  const customers = new Map<string, { id: string }>();
  type VkBody = {
    name?: unknown;
    customer_id?: unknown;
    allow_all_providers?: unknown;
  };
  const virtualKeys = new Map<
    string,
    { id: string; value: string; customerId: string | null }
  >();
  const vkCreateBodies: { body: VkBody; customerName: string | null }[] = [];
  const calls = { vkCreate: 0 };
  let vkRespondWith: "valid" | "status-500" | "not-json" = "valid";

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== "Bearer test-admin-key") {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/customers"
      ) {
        const name = ((await request.json()) as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) {
          return json(400, { error: "Customer name is required" });
        }
        if (customers.has(name)) {
          return json(409, {
            error: "A customer with this name already exists",
          });
        }
        const id = crypto.randomUUID();
        customers.set(name, { id });
        return json(200, { message: "ok", customer: { id, name } });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        const search = url.searchParams.get("search") ?? "";
        const matched = [...customers.entries()]
          .filter(([name]) => name.includes(search))
          .map(([name, entry]) => ({ id: entry.id, name }));
        return json(200, { customers: matched, count: matched.length });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/virtual-keys"
      ) {
        calls.vkCreate += 1;
        let body: VkBody;
        try {
          body = (await request.json()) as VkBody;
        } catch {
          return json(400, { error: "Invalid JSON" });
        }
        if (typeof body.name !== "string" || body.name.length === 0) {
          return json(400, { error: "Virtual key name is required" });
        }
        if (vkRespondWith === "status-500") {
          return json(500, { error: "failed to create virtual key" });
        }
        if (vkRespondWith === "not-json") {
          return new Response("<html>not the management api</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        vkCreateBodies.push({
          body,
          // Remember which run the body belongs to, via its customer's (run-prefixed) name.
          customerName:
            typeof body.customer_id === "string"
              ? ([...customers.entries()].find(
                  ([, entry]) => entry.id === body.customer_id,
                )?.[0] ?? null)
              : null,
        });
        const id = crypto.randomUUID();
        const value = `sk-bf-${crypto.randomUUID()}`;
        virtualKeys.set(body.name, {
          id,
          value,
          customerId:
            typeof body.customer_id === "string" ? body.customer_id : null,
        });
        return json(200, {
          message: "Virtual key created successfully",
          virtual_key: { id, name: body.name, value },
        });
      }
      return json(404, { error: "not found" });
    },
  });

  return {
    server,
    calls,
    stage(next: { vkRespondWith?: typeof vkRespondWith }) {
      if (next.vkRespondWith !== undefined) vkRespondWith = next.vkRespondWith;
    },
    virtualKeyCreateCount() {
      return calls.vkCreate;
    },
    /** The create bodies this run caused, via each body's customer's run-prefixed name. */
    virtualKeyCreateBodies(runTag: string) {
      return vkCreateBodies
        .filter((entry) => entry.customerName?.includes(runTag) === true)
        .map((entry) => entry.body);
    },
    /** The virtual keys the fake created for one remote customer. */
    virtualKeysForCustomer(customerId: string) {
      return [...virtualKeys.entries()]
        .filter(([, vk]) => vk.customerId === customerId)
        .map(([name, vk]) => ({ name, ...vk }));
    },
    stop() {
      void server.stop(true);
    },
  };
}
