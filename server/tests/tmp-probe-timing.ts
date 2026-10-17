// Throwaway probe (delete after): time each phase of one claim cycle.
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
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
} from "../src/db/schema";
import { gatewayCustomers, gatewayVirtualKeys } from "../src/db/schema/gateway";
import { createGatewayCustomerProvisioner } from "../src/gateway/customer";
import { createGatewayKeyIssuer, createGatewayVirtualKeyClient, createKeyIssuanceRoutes } from "../src/gateway/key-issuance";
import type { GatewayReadiness, GatewayReadinessService } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const t0 = Date.now();
const at = (label: string) => console.log(`+${Date.now() - t0}ms ${label}`);

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
at("db opened");
const run = randomUUID().slice(0, 8);
const prefix = `probe-${run}`;
const encryptionKey = randomBase64Key();
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore: createCredentialStore(database),
  auditStore: { record: async () => {} } as never,
}, timeout: 0 }); const fake = { server: fakeServer };
function randomBase64Key(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
const fakeServer = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (request.headers.get("authorization") !== "Bearer test-admin-key") {
      return new Response("{}", { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/governance/customers") {
      return new Response(JSON.stringify({ message: "ok", customer: { id: "c1", name: "n" } }), { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/api/governance/customers") {
      return new Response(JSON.stringify({ customers: [], count: 0 }), { status: 200 });
    }
    if (request.method === "POST" && url.pathname === "/api/governance/virtual-keys") {
      return new Response(JSON.stringify({ message: "ok", virtual_key: { id: "vk1", value: "sk-bf-x" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  },
}, timeout: 0 }); const fake = { server: fakeServer };
const endpoint = {
  baseUrl: `http://127.0.0.1:${fake.server.port}`,
  requestTimeoutMs: 2_000,
  configVersion: 1,
};
const readiness: GatewayReadiness = {
  ready: true,
  blockingReasons: [],
  configVersion: 1,
  checkedAt: new Date().toISOString(),
};
const gate: GatewayReadinessService = {
  evaluateGatewayReadiness: async () => readiness,
  assertGatewayReadyForBilling: async () => readiness,
};
const provisioner = createGatewayCustomerProvisioner({
  database,
  readGatewayEndpoint: async () => endpoint,
  resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
  gate,
}, timeout: 0 }); const fake = { server: fakeServer };
at("helpers built");
const botId = `${prefix}-bot`;
await registry.register({ botId, displayName: "probe", kind: "external", capabilities: ["chat"] });
at("registry.register");
const issued = await registry.credentials.issue(botId);
at("credentials.issue");
const offerIssuer = createBindingOfferIssuer({ database, auditStore: { record: async () => {} } as never });
const offer = await offerIssuer.issue({ botId, status: "active" }, { externalIdentityHint: "slack:u1" });
at("offer.issue");
const { grant } = await registry.modelAccess.confirm("probe-user", offer.bindingCode);
at("grant.confirm");
const issuer = createGatewayKeyIssuer({
  database,
  resolveForBot: registry.modelAccess.resolveForBot,
  provisionCustomer: provisioner.provisionCustomer,
  client: createGatewayVirtualKeyClient({
    readGatewayEndpoint: async () => endpoint,
    resolveGatewayAdminCredential: async () => ({ adminKey: "test-admin-key" }),
  }),
  auditStore: { record: async () => {} } as never,
}, timeout: 0 }); const fake = { server: fakeServer };
const app = botServiceRoutes({
  authenticate: registry.authenticate,
  keys: createKeyIssuanceRoutes({
    issue: issuer.issueKeyForGrant,
    bundle: {
      readGatewayEndpoint: async () => endpoint,
      listSelectableModels: async () => [{ provider: "p", model: "m", capability: "chat" }],
    },
  }),
}, timeout: 0 }); const fake = { server: fakeServer };
at("app built");
const response = await app.request("/keys", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${issued.secret}` },
  body: JSON.stringify({ grantId: grant.grantId }),
}, timeout: 0 }); const fake = { server: fakeServer };
at("claim done");
console.log("status:", response.status);
const second = await app.request("/keys", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${issued.secret}` },
  body: JSON.stringify({ grantId: grant.grantId }),
}, timeout: 0 }); const fake = { server: fakeServer };
at("second claim done");
console.log("second status:", second.status);
await database.delete(gatewayVirtualKeys).where(like(gatewayVirtualKeys.botId, `${prefix}%`));
await database.delete(gatewayCustomers).where(like(gatewayCustomers.payerId, `${prefix}%`));
await database.delete(accessGrants).where(like(accessGrants.userId, `${prefix}%`));
await database.delete(botBindingOffers).where(like(botBindingOffers.botId, `${prefix}%`));
await database.delete(credentials).where(like(credentials.keyId, `${prefix}%`));
await database.delete(botServices).where(like(botServices.botId, `${prefix}%`));
await database.$client.close();
fake.stop(true);
at("cleaned up");
