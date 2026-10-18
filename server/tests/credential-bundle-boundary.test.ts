import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import type { Logger } from "../../shared/logger";
import { createAuditStore } from "../src/audit";
import { botServiceRoutes } from "../src/bot-services/auth";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  credentials,
} from "../src/db/schema";
import { gatewayCustomers, gatewayVirtualKeys } from "../src/db/schema/gateway";
import {
  type CredentialBundleSources,
  credentialSecretVariants,
  gatewayKeyStatusView,
  redactCredentialSecrets,
  redactCredentialSecretsDeep,
} from "../src/gateway/credential-bundle";
import { createGatewayCustomerProvisioner } from "../src/gateway/customer";
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
 * Bifrost 05.4 (#245): the CredentialBundle plaintext boundary. The bundle —
 * { endpoint, modelRefs, secret, expiresAt, credentialVersion } — is the ONLY
 * shape the plaintext ever rides, and the authenticated Bot service channel
 * (`/api/bot-service/keys`, behind 04.2's guard) is the ONLY channel it rides.
 *
 * The method here is the ticket's own: mint a RECOGNIZABLE secret at the fake
 * gateway, then hunt that exact value and every reducible variant of it
 * (encodings, truncations) across every other surface the flow touches — the
 * claim answer's error paths, the process logs, the audit trail, the local
 * database record and the status view contract. The plaintext must appear
 * exactly once in exactly one place: the bundle on the authenticated channel.
 */

/** The recognizable marker the fake Bifrost mints into every key value. */
const MARKER = "b5-245-BOUNDARY-MARKER-0123456789abcdef";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const prefix = `b5-245-${run}`;

const encryptionKey = randomBase64Key();
const auditStore = createAuditStore(database);
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore,
});

function randomBase64Key(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The one model refs answer the bundle source serves in this file: two fixed
 * refs under 03.11's contract, so bundle completeness is assertable.
 */
const selectableRefs = [
  { provider: "fake-provider", model: "boundary-chat", capability: "chat" },
  {
    provider: "fake-provider",
    model: "boundary-embed",
    capability: "embedding",
  },
];

/** The fake Bifrost: mints the recognizable marker value into every key. */
const fake = startFakeBifrost();

const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};

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

function provisionerFor(gate: GatewayReadinessService = readyGate()) {
  return createGatewayCustomerProvisioner({
    database,
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
    gate,
  });
}

/**
 * A pino-shaped logger that remembers everything it is told, so the boundary
 * scan can read the whole flow's log output back.
 */
function captureLogger(): Logger & { dump: () => string[] } {
  const entries: unknown[][] = [];
  const record = (...args: unknown[]) => {
    entries.push(args);
  };
  return {
    info: record,
    warn: record,
    error: record,
    debug: record,
    trace: record,
    fatal: record,
    silent: record,
    child: () => captureLogger(),
    level: "info",
    dump: () =>
      entries.map((args) => {
        try {
          return JSON.stringify(args);
        } catch {
          return String(args);
        }
      }),
  } as unknown as Logger & { dump: () => string[] };
}

type BundleSources = Partial<CredentialBundleSources>;

/** The bot-facing app under test: the real 04.2 door, issuance + bundle mounted. */
function appFor(overrides?: {
  gate?: GatewayReadinessService;
  log?: Logger;
  bundle?: BundleSources;
}) {
  const sources: CredentialBundleSources = {
    readGatewayEndpoint:
      overrides?.bundle?.readGatewayEndpoint ?? (async () => endpoint),
    listSelectableModels:
      overrides?.bundle?.listSelectableModels ?? (async () => selectableRefs),
  };
  return botServiceRoutes({
    authenticate: registry.authenticate,
    keys: createKeyIssuanceRoutes({
      issue: issuerFor(overrides).issueKeyForGrant,
      bundle: sources,
    }),
  });
}

/** The claim app with NO bundle sources composed (a degraded deployment). */
function appWithoutBundleSources() {
  return botServiceRoutes({
    authenticate: registry.authenticate,
    keys: createKeyIssuanceRoutes({
      issue: issuerFor().issueKeyForGrant,
    }),
  });
}

afterAll(async () => {
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

/** The issuer under test, with the capture logger wired in. */
function issuerFor(overrides?: {
  gate?: GatewayReadinessService;
  log?: Logger;
  auditStore?: typeof auditStore;
}) {
  return createGatewayKeyIssuer({
    database,
    resolveForBot: registry.modelAccess.resolveForBot,
    // 05.5 made the TTL explicit at the seam; this 05.4 harness predates it and needs the same
    // short-lived default the newer suites pass.
    keyTtlMinutes: 15,
    provisionCustomer: provisionerFor(overrides?.gate).provisionCustomer,
    client: createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    }),
    auditStore: overrides?.auditStore ?? auditStore,
    log: overrides?.log,
  });
}

async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: `Boundary Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat", "embedding"],
  });
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

const offerIssuer = createBindingOfferIssuer({ database, auditStore });

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

/**
 * The boundary oracle: every variant of the secret whose appearance anywhere
 * user-visible would be a leak — the exact value, its URL/base64/hex encodings,
 * and any prefix or suffix truncation long enough to be a reducible fragment.
 */
function assertNoLeak(text: string, secret: string, where: string) {
  for (const variant of credentialSecretVariants(secret)) {
    expect(text.includes(variant), `${where} leaks variant of the secret`).toBe(
      false,
    );
  }
  expect(text.includes(MARKER), `${where} leaks the marker`).toBe(false);
}

describe("05.4 credential bundle boundary", () => {
  test("the authenticated bot server receives the complete bundle exactly once", async () => {
    const app = appFor();
    const bot = await credentialedBot("bundle");
    const userId = `${prefix}-bundle-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const response = await claimKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: {
        secret: string;
        credentialVersion: number;
        expiresAt: string | null;
      };
      bundle: {
        endpoint: string;
        modelRefs: { provider: string; model: string; capability: string }[];
        secret: string;
        expiresAt: string | null;
        credentialVersion: number;
      };
    };

    // The frozen contract: five fields, nothing else riding with the secret.
    expect(Object.keys(body.bundle).sort()).toEqual([
      "credentialVersion",
      "endpoint",
      "expiresAt",
      "modelRefs",
      "secret",
    ]);
    expect(body.bundle.endpoint).toBe(endpoint.baseUrl);
    expect(body.bundle.modelRefs).toEqual(selectableRefs);
    expect(body.bundle.secret).toBe(body.key.secret);
    expect(body.bundle.secret.startsWith("sk-bf-")).toBe(true);
    expect(body.bundle.secret).toContain(MARKER);
    expect(body.bundle.credentialVersion).toBe(1);
    expect(body.bundle.expiresAt).toBe(body.key.expiresAt);
  });

  test("callers without a bot service credential get the uniform 401 and no secret", async () => {
    const app = appFor();
    const bot = await credentialedBot("door");
    const userId = `${prefix}-door-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    // Mint once, so the 401 oracles below hunt a real, existing plaintext.
    const minted = await claimKey(app, bot.secret, grant.grantId);
    expect(minted.status).toBe(200);
    const secret = fake.lastMintedValue()!;
    expect(secret).toContain(MARKER);

    const anon = await app.request("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantId: grant.grantId }),
    });
    expect(anon.status).toBe(401);
    assertNoLeak(JSON.stringify(await anon.json()), secret, "401 body");

    const impostor = await claimKey(app, `${bot.secret}-wrong`, grant.grantId);
    expect(impostor.status).toBe(401);
    assertNoLeak(
      JSON.stringify(await impostor.json()),
      secret,
      "impostor 401 body",
    );
  }, 30_000);

  test("no log line on any path carries the secret or a reducible variant", async () => {
    const log = captureLogger();
    const app = appFor({ log });
    const bot = await credentialedBot("logs");
    const userId = `${prefix}-logs-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    // The success path logs.
    const ok = await claimKey(app, bot.secret, grant.grantId);
    expect(ok.status).toBe(200);
    const secret = fake.lastMintedValue()!;
    expect(secret).toContain(MARKER);

    // Error paths log too: cross-bot refusal, not-ready gate, remote 500.
    const otherBot = await credentialedBot("logs-other");
    const crossBot = await claimKey(app, otherBot.secret, grant.grantId);
    expect(crossBot.status).toBe(403);

    const gated = appFor({ gate: refusingGate(), log });
    const gateBot = await credentialedBot("logs-gate");
    const gateGrant = await confirmGrant(
      `${prefix}-logs-gate-user`,
      gateBot.botId,
      `slack:${prefix}-logs-gate-user`,
    );
    const gateRefusal = await claimKey(
      gated,
      gateBot.secret,
      gateGrant.grantId,
    );
    expect(gateRefusal.status).toBe(503);

    fake.stage({ vkRespondWith: "status-500" });
    const remoteBot = await credentialedBot("logs-remote");
    const remoteGrant = await confirmGrant(
      `${prefix}-logs-remote-user`,
      remoteBot.botId,
      `slack:${prefix}-logs-remote-user`,
    );
    // Through the READY app: the remote 500 is the path under test, not the gate.
    const remoteRefusal = await claimKey(
      app,
      remoteBot.secret,
      remoteGrant.grantId,
    );
    expect(remoteRefusal.status).toBe(502);
    fake.stage({ vkRespondWith: "valid" });

    const dump = log.dump().join("\n");
    expect(dump.length).toBeGreaterThan(0);
    assertNoLeak(dump, secret, "captured logs");
  }, 60_000);

  test("no audit row carries the secret; the fingerprint is not a reducible fragment", async () => {
    const app = appFor();
    const bot = await credentialedBot("audit");
    const userId = `${prefix}-audit-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const response = await claimKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    const secret = fake.lastMintedValue()!;

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.eventType} = ${"gateway.key_issued"} AND ${auditEvents.payload} ->> ${"botId"} LIKE ${`${prefix}%`}`,
      );
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    assertNoLeak(dump, secret, "audit rows");

    // The audit names the key by a four-hex fingerprint: present, and NOT the
    // secret, nor any long-enough piece of it.
    for (const row of rows) {
      const fingerprint = (row.payload as Record<string, unknown>).fingerprint;
      expect(typeof fingerprint).toBe("string");
      expect((fingerprint as string).length).toBe(4);
      expect(secret.endsWith(fingerprint as string)).toBe(false);
    }
  });

  test("the status view and the stored row never carry the plaintext", async () => {
    const app = appFor();
    const bot = await credentialedBot("status");
    const userId = `${prefix}-status-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const response = await claimKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(200);
    const secret = fake.lastMintedValue()!;

    const rows = await database
      .select()
      .from(gatewayVirtualKeys)
      .where(like(gatewayVirtualKeys.botId, `${prefix}-status%`));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // The whole local record is plaintext-free; the hash identifies, never redeems.
    assertNoLeak(JSON.stringify(row), secret, "stored row");
    expect(row.valueHash).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );

    // The status view contract: expiry, version and status — nothing else.
    const view = gatewayKeyStatusView(row);
    expect(Object.keys(view).sort()).toEqual([
      "credentialVersion",
      "expiresAt",
      "keyId",
      "status",
    ]);
    expect(view.status).toBe("active");
    expect(view.credentialVersion).toBe(1);
    expect(view.keyId).toBe(row.id);
    assertNoLeak(JSON.stringify(view), secret, "status view");
  });

  test("error responses are fixed refusals that never quote the secret", async () => {
    const app = appFor();
    const bot = await credentialedBot("errors");
    const userId = `${prefix}-errors-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    // A first successful claim mints the marker secret…
    const ok = await claimKey(app, bot.secret, grant.grantId);
    expect(ok.status).toBe(200);
    const secret = fake.lastMintedValue()!;

    // …then every refusal path answers without it.
    const otherBot = await credentialedBot("errors-other");
    const crossBot = await claimKey(app, otherBot.secret, grant.grantId);
    expect(crossBot.status).toBe(403);
    assertNoLeak(JSON.stringify(await crossBot.json()), secret, "403 body");

    const gated = appFor({ gate: refusingGate() });
    const gateBot = await credentialedBot("errors-gate");
    const gateGrant = await confirmGrant(
      `${prefix}-errors-gate-user`,
      gateBot.botId,
      `slack:${prefix}-errors-gate-user`,
    );
    const gateRefusal = await claimKey(
      gated,
      gateBot.secret,
      gateGrant.grantId,
    );
    expect(gateRefusal.status).toBe(503);
    assertNoLeak(
      JSON.stringify(await gateRefusal.json()),
      secret,
      "503 gate body",
    );

    fake.stage({ vkRespondWith: "status-500" });
    const remoteBot = await credentialedBot("errors-remote");
    const remoteGrant = await confirmGrant(
      `${prefix}-errors-remote-user`,
      remoteBot.botId,
      `slack:${prefix}-errors-remote-user`,
    );
    // Through the READY app: the remote 500 is the path under test, not the gate.
    const remoteRefusal = await claimKey(
      app,
      remoteBot.secret,
      remoteGrant.grantId,
    );
    expect(remoteRefusal.status).toBe(502);
    assertNoLeak(
      JSON.stringify(await remoteRefusal.json()),
      secret,
      "502 remote body",
    );
    fake.stage({ vkRespondWith: "valid" });

    // The bundle cannot be completed without an endpoint: refuse, plaintext-free.
    const noEndpoint = appFor({
      bundle: { readGatewayEndpoint: async () => undefined },
    });
    const endpointRefusal = await claimKey(
      noEndpoint,
      bot.secret,
      (
        await confirmGrant(
          `${prefix}-errors-endpoint-user`,
          bot.botId,
          `slack:${prefix}-errors-endpoint-user`,
        )
      ).grantId,
    );
    expect(endpointRefusal.status).toBe(503);
    const endpointBody = JSON.stringify(await endpointRefusal.json());
    assertNoLeak(endpointBody, secret, "503 endpoint body");

    // The bundle cannot be completed without the model refs: refuse, plaintext-free.
    const modelsFail = appFor({
      bundle: {
        listSelectableModels: async () => {
          throw new Error("catalog exploded");
        },
      },
    });
    const modelsRefusal = await claimKey(
      modelsFail,
      bot.secret,
      (
        await confirmGrant(
          `${prefix}-errors-models-user`,
          bot.botId,
          `slack:${prefix}-errors-models-user`,
        )
      ).grantId,
    );
    expect(modelsRefusal.status).toBe(502);
    assertNoLeak(
      JSON.stringify(await modelsRefusal.json()),
      secret,
      "502 models body",
    );
  }, 60_000);

  test("a deployment with no bundle sources refuses before minting anything", async () => {
    const app = appWithoutBundleSources();
    const bot = await credentialedBot("degraded");
    const userId = `${prefix}-degraded-user`;
    const grant = await confirmGrant(userId, bot.botId, `slack:${userId}`);

    const createsBefore = fake.virtualKeyCreateCount();
    const response = await claimKey(app, bot.secret, grant.grantId);
    expect(response.status).toBe(503);
    assertNoLeak(
      JSON.stringify(await response.json()),
      MARKER,
      "503 degraded body",
    );
    expect(fake.virtualKeyCreateCount()).toBe(createsBefore);
  });

  test("the redaction tool scrubs every variant and keeps short fingerprints", () => {
    const secret = `sk-bf-${MARKER}-zzzz`;
    const variants = credentialSecretVariants(secret);

    // Exact, base64, base64url, hex, URL-escaped, and long truncations.
    const base64 = Buffer.from(secret, "utf8").toString("base64");
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const encoded = encodeURIComponent(secret);
    const prefixCut = secret.slice(0, 12);
    const suffixCut = secret.slice(-12);

    for (const form of [secret, base64, hex, encoded, prefixCut, suffixCut]) {
      const line = `request failed for ${form} (see trace)`;
      expect(redactCredentialSecrets(line, secret).includes(form)).toBe(false);
      expect(redactCredentialSecrets(line, secret)).toContain(
        "[REDACTED:gateway-key]",
      );
    }

    // The four-hex fingerprint discipline survives: short fragments are not
    // scrubbed, so audit fingerprints stay readable.
    expect(redactCredentialSecrets("fingerprint abcd end", secret)).toBe(
      "fingerprint abcd end",
    );

    // Deep scrubbing walks nested structures without disturbing their shape.
    const payload = {
      ok: true,
      nested: { list: ["a", { deeper: `value ${secret} end` }] },
    };
    const scrubbed = redactCredentialSecretsDeep(
      payload,
      secret,
    ) as typeof payload;
    expect(JSON.stringify(scrubbed).includes(secret)).toBe(false);
    expect(scrubbed.nested.list[1]).toHaveProperty("deeper");
    expect(variants.length).toBeGreaterThan(4);
  });
});

/** The fake Bifrost this file integrates against: customers and virtual-keys surfaces. */
function startFakeBifrost() {
  const customers = new Map<string, { id: string }>();
  type VkBody = { name?: unknown; customer_id?: unknown };
  const virtualKeys = new Map<string, { id: string; value: string }>();
  let minted: string | null = null;
  let vkRespondWith: "valid" | "status-500" = "valid";
  const calls = { vkCreate: 0 };

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
        const body = (await request.json()) as VkBody;
        if (vkRespondWith === "status-500") {
          return json(500, { error: "failed to create virtual key" });
        }
        const id = crypto.randomUUID();
        const value = `sk-bf-${MARKER}-${crypto.randomUUID()}`;
        minted = value;
        virtualKeys.set(String(body.name), { id, value });
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
    lastMintedValue(): string | null {
      return minted;
    },
    stop() {
      server.stop(true);
    },
  };
}
