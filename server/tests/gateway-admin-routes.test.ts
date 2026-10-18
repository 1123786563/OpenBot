import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createEnterpriseStore,
  GATEWAY_ENDPOINT_KEY,
} from "../src/admin/settings-store";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  enterpriseSettings,
  userRoles,
  users,
} from "../src/db/schema";
import {
  createGatewayAdminCredentialService,
  GATEWAY_ADMIN_CREDENTIAL_KEY,
} from "../src/gateway/admin-credential";
import { gatewayAdminCredentialRoutes } from "../src/gateway/admin-credential-routes";
import {
  createEnterpriseGatewayNegotiationStore,
  createGatewayCapabilityNegotiationService,
  CREDIT_ADMISSION_EXTENSION_NAME,
} from "../src/gateway/capability-negotiation";
import {
  gatewayAdminRoutes,
  type GatewayAdminRouteDeps,
} from "../src/gateway/admin-routes";
import { createConversionRateStore } from "../src/gateway/conversion-rate-store";
import { createGatewayEndpointService } from "../src/gateway/endpoint-config";
import {
  createEnterpriseGatewayProbeStore,
  createGatewayProbeService,
} from "../src/gateway/probe";
import { createGatewayReadinessService } from "../src/gateway/readiness";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { startFakeGateway } from "./support/fake-gateway";

/*
 * Bifrost 01.8 (#214): the administrator's gateway surface — one read-only
 * status route plus the save/probe actions the screen drives — served over the
 * real services and the real PostgreSQL. What only this boundary can prove:
 *
 * - a member who is not an administrator is refused on every route here, and
 *   so is an unauthenticated request;
 * - the status answer carries the readiness verdict with EVERY blocking
 *   reason, the saved endpoint and its configVersion, the redacted credential
 *   status, the persisted probe and negotiation records, and the rate — and
 *   the credential's plaintext rides on none of it;
 * - the save actions answer the new server-assigned versions and refuse
 *   illegal input with the service's own sentences;
 * - the probe action dials the configured gateway, persists the classified
 *   result, and — only when the probe succeeded — runs the capability
 *   negotiation against the same snapshot, so an administrator can actually
 *   reach a ready gateway from this surface;
 * - a process whose wiring is missing answers tagged 503s, never a guessed
 *   status.
 */

const runId = randomUUID().slice(0, 8);
const ADMIN_KEY = `gateway-admin-routes-plain-key-${runId}`;
const admin = {
  userId: `gateway-routes-admin-${runId}`,
  email: `gateway-routes-admin-${runId}@openbot.test`,
};
const member = {
  userId: `gateway-routes-member-${runId}`,
  email: `gateway-routes-member-${runId}@openbot.test`,
};

const encryptionKey = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString("base64");

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const enterpriseStore = createEnterpriseStore(database);
const endpointService = createGatewayEndpointService({ store: enterpriseStore });
const credentialService = createGatewayAdminCredentialService({
  database,
  encryptionKey,
  member: (userId) => enterpriseStore.member(userId),
});
const rateStore = createConversionRateStore({ database });
const negotiationService = createGatewayCapabilityNegotiationService({
  store: createEnterpriseGatewayNegotiationStore(database),
  readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
  resolveGatewayAdminCredential: () =>
    credentialService.resolveGatewayAdminCredential(),
});
const probeService = createGatewayProbeService({
  store: createEnterpriseGatewayProbeStore(database),
  readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
  resolveGatewayAdminCredential: () =>
    credentialService.resolveGatewayAdminCredential(),
});
const gate = createGatewayReadinessService({
  readGatewayEndpoint: () => endpointService.readGatewayEndpoint(),
  resolveGatewayAdminCredential: () =>
    credentialService.resolveGatewayAdminCredential(),
  readLastGatewayProbe: () =>
    createEnterpriseGatewayProbeStore(database).readGatewayProbeResult(),
  readLastGatewayNegotiation: () =>
    negotiationService.readLastGatewayNegotiation(),
  readConversionRate: () => rateStore.readConversionRate(),
});

const deps: GatewayAdminRouteDeps = {
  endpointService: () => endpointService,
  credentialService: () => credentialService,
  rateStore: () => rateStore,
  probeService: () => probeService,
  negotiationService: () => negotiationService,
  readinessService: () => gate,
};

/** A requireUser stand-in that answers like the real guard: anonymous is refused. */
function actorAs(role: "admin" | "user" | "anonymous") {
  const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (role === "anonymous") {
      return context.json({ error: "Authentication required." }, 401);
    }
    const actor: AuthenticatedActor = {
      id: role === "admin" ? admin.userId : member.userId,
      email: role === "admin" ? admin.email : member.email,
      role,
    };
    context.set("actor", actor);
    await next();
  };
  return guard;
}

const adminApp = gatewayAdminRoutes(actorAs("admin"), deps);
const memberApp = gatewayAdminRoutes(actorAs("user"), deps);
const anonymousApp = gatewayAdminRoutes(actorAs("anonymous"), deps);

const SETTING_KEYS = [
  GATEWAY_ENDPOINT_KEY,
  GATEWAY_ADMIN_CREDENTIAL_KEY,
  "gateway_probe_result",
  "gateway_negotiation_result",
  "gateway_conversion_rate",
];

async function cleanSlate() {
  await database
    .delete(enterpriseSettings)
    .where(inArray(enterpriseSettings.key, SETTING_KEYS));
  await database
    .delete(credentials)
    .where(eq(credentials.kind, "gateway_admin"));
}

async function establishReady() {
  const gateway = await startFakeGateway(
    {
      kind: "response",
      status: 200,
      body: '{"authConfig":{"admin":{"exists":true}}}',
    },
    {
      "/api/plugins": {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          plugins: [
            { name: "bifrost-anthropic", version: "1.2.3" },
            { name: CREDIT_ADMISSION_EXTENSION_NAME, version: "1.0.0" },
          ],
        }),
      },
    },
  );
  const credential = await credentialService.saveGatewayAdminCredential(
    { adminKey: ADMIN_KEY },
    { userId: admin.userId, email: admin.email },
  );
  expect(credential.ok).toBe(true);
  const rate = await rateStore.save(
    { numerator: "100", denominator: "1" },
    admin.email,
  );
  expect(rate.ok).toBe(true);
  const saved = await endpointService.saveGatewayEndpoint(
    { baseUrl: gateway.baseUrl, requestTimeoutMs: 5_000 },
    { userId: admin.userId, email: admin.email },
  );
  expect(saved.ok).toBe(true);
  // The verification branches, through the same services the routes drive.
  const run = await probeService.probeGateway();
  expect(run.ready && run.result.status).toBe("ok");
  const verdict = await negotiationService.negotiateGatewayCapabilities();
  expect(verdict.negotiated).toBe(true);
  return gateway;
}

test("setup: an administrator, a member, and clean gateway rows", async () => {
  await cleanSlate();
  await database
    .insert(users)
    .values([
      { id: admin.userId, email: admin.email },
      { id: member.userId, email: member.email },
    ])
    .onConflictDoNothing();
  await database
    .insert(userRoles)
    .values([
      { userId: admin.userId, role: "admin" },
      { userId: member.userId, role: "user" },
    ])
    .onConflictDoNothing();
});

test("a member and an anonymous caller are refused on every route here", async () => {
  for (const app of [memberApp, anonymousApp]) {
    expect((await app.request("/status")).status).toBe(
      app === memberApp ? 403 : 401,
    );
    expect(
      (
        await app.request("/endpoint", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl: "https://bifrost.internal" }),
        })
      ).status,
    ).toBe(app === memberApp ? 403 : 401);
    expect(
      (
        await app.request("/rate", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ numerator: "1", denominator: "1" }),
        })
      ).status,
    ).toBe(app === memberApp ? 403 : 401);
    expect((await app.request("/probe", { method: "POST" })).status).toBe(
      app === memberApp ? 403 : 401,
    );
  }
});

/** The status answer, as the tests read it — field names, not a loose any. */
type StatusBody = {
  readiness: {
    ready: boolean;
    blockingReasons: string[];
    configVersion: number;
    checkedAt: string;
  };
  endpoint: Record<string, unknown> | null;
  credential: Record<string, unknown> | null;
  probe: Record<string, unknown> | null;
  extension: Record<string, unknown> | null;
  rate: Record<string, unknown>;
};

test("status on a fresh deployment names every blocking reason and no credential", async () => {
  const response = await adminApp.request("/status");
  expect(response.status).toBe(200);
  const body = (await response.json()) as StatusBody;
  expect(body.readiness.ready).toBe(false);
  expect(body.readiness.blockingReasons).toEqual([
    "gateway_readiness_endpoint_not_configured",
    "gateway_readiness_credential_not_configured",
    "gateway_readiness_probe_missing",
    "gateway_readiness_extension_not_negotiated",
    "gateway_readiness_rate_not_configured",
  ]);
  expect(body.readiness.configVersion).toBe(0);
  expect(body.endpoint).toBeNull();
  expect(body.credential).toMatchObject({ state: "unconfigured" });
  expect(body.probe).toBeNull();
  expect(body.extension).toBeNull();
  expect(body.rate.configured).toBe(false);
});

test("after the full configuration the status is ready and carries no key material", async () => {
  const gateway = await establishReady();
  const response = await adminApp.request("/status");
  expect(response.status).toBe(200);
  const raw = await response.text();
  const body = JSON.parse(raw) as StatusBody;
  expect(body.readiness.ready).toBe(true);
  expect(body.readiness.blockingReasons).toEqual([]);
  expect(body.endpoint.baseUrl).toBe(gateway.baseUrl);
  expect(body.endpoint.configVersion).toBeGreaterThanOrEqual(1);
  expect(body.credential.state).toBe("configured");
  expect(body.credential.fingerprint).toBeTruthy();
  expect(body.probe.status).toBe("ok");
  expect(body.extension.creditAdmissionExtension).toBe("present");
  expect(body.rate).toMatchObject({
    configured: true,
    numerator: "100",
    denominator: "1",
  });
  // The plaintext key never rides on any response, in any encoding.
  expect(raw).not.toContain(ADMIN_KEY);
  expect(raw).not.toContain(Buffer.from(ADMIN_KEY).toString("base64"));
});

test("saving the endpoint answers the new server-assigned configVersion", async () => {
  const first = await adminApp.request("/endpoint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://bifrost.example.internal" }),
  });
  expect(first.status).toBe(200);
  const saved = (await first.json()) as { endpoint: { configVersion: number } };
  expect(saved.endpoint.configVersion).toBeGreaterThanOrEqual(1);

  const second = await adminApp.request("/endpoint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://bifrost2.example.internal" }),
  });
  const resaved = (await second.json()) as {
    endpoint: { configVersion: number };
  };
  expect(resaved.endpoint.configVersion).toBe(saved.endpoint.configVersion + 1);

  const illegal = await adminApp.request("/endpoint", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://bifrost.example.internal/v1" }),
  });
  expect(illegal.status).toBe(400);
  const problem = (await illegal.json()) as { error: string };
  expect(problem.error).toContain("origin");
});

test("saving the rate answers the new rateVersion and refuses illegal input", async () => {
  const saved = await adminApp.request("/rate", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ numerator: "7", denominator: "1" }),
  });
  expect(saved.status).toBe(200);
  const body = (await saved.json()) as { rate: { rateVersion: number } };
  expect(body.rate.rateVersion).toBeGreaterThanOrEqual(1);

  const illegal = await adminApp.request("/rate", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ numerator: "1", denominator: "0" }),
  });
  expect(illegal.status).toBe(400);
  const problem = (await illegal.json()) as { error: string };
  expect(problem.error.length).toBeGreaterThan(0);

  const status = await adminApp.request("/status");
  const view = (await status.json()) as { rate: Record<string, unknown> };
  expect(view.rate).toMatchObject({ numerator: "7", denominator: "1" });
});

test("the probe action classifies, persists, and on success negotiates", async () => {
  // Nothing configured: the probe refuses to run and names why.
  await cleanSlate();
  const refused = await adminApp.request("/probe", { method: "POST" });
  expect(refused.status).toBe(409);
  const refusal = (await refused.json()) as { code: string };
  expect(refusal.code).toBe("gateway_probe_endpoint_not_configured");

  // A healthy gateway: the probe answers ok and the negotiation completes.
  const gateway = await establishReady();
  const ok = await adminApp.request("/probe", { method: "POST" });
  expect(ok.status).toBe(200);
  const ran = (await ok.json()) as {
    probe: { status: string; configVersion: number };
    negotiation: { negotiated: boolean; negotiation: { configVersion: number } } | null;
  };
  expect(ran.probe.status).toBe("ok");
  expect(ran.negotiation?.negotiated).toBe(true);
  expect(ran.negotiation?.negotiation.configVersion).toBe(ran.probe.configVersion);

  // The extension vanished upstream: the probe still succeeds, the negotiation
  // verdict honestly turns "absent", and the status read carries it.
  gateway.routes["/api/plugins"] = {
    kind: "response",
    status: 200,
    body: JSON.stringify({
      plugins: [{ name: "bifrost-anthropic", version: "1.2.3" }],
    }),
  };
  const absent = await adminApp.request("/probe", { method: "POST" });
  expect(absent.status).toBe(200);
  const verdict = (await absent.json()) as {
    negotiation: { negotiated: boolean; negotiation: { creditAdmissionExtension: string } };
  };
  expect(verdict.negotiation.negotiated).toBe(true);
  expect(verdict.negotiation.negotiation.creditAdmissionExtension).toBe("absent");

  const status = await adminApp.request("/status");
  const view = (await status.json()) as {
    readiness: { ready: boolean; blockingReasons: string[] };
    extension: { creditAdmissionExtension: string } | null;
  };
  expect(view.extension?.creditAdmissionExtension).toBe("absent");
  expect(view.readiness.ready).toBe(false);
  expect(view.readiness.blockingReasons).toContain(
    "gateway_readiness_extension_absent",
  );
  await gateway.stop();
});

test("a deployment without the wiring reads tagged 503s, never a guessed status", async () => {
  const unwired = gatewayAdminRoutes(actorAs("admin"), {
    endpointService: () => undefined,
    credentialService: () => undefined,
    rateStore: () => undefined,
    probeService: () => undefined,
    negotiationService: () => undefined,
    readinessService: () => undefined,
  });
  const status = await unwired.request("/status");
  expect(status.status).toBe(503);
  expect(((await status.json()) as { code: string }).code).toBe(
    "gateway_readiness_gate_unavailable",
  );
  expect(
    (
      await unwired.request("/endpoint", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://bifrost.internal" }),
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await unwired.request("/rate", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numerator: "1", denominator: "1" }),
      })
    ).status,
  ).toBe(503);
  expect((await unwired.request("/probe", { method: "POST" })).status).toBe(503);
});

test("the combined mount never shadows 01.2's credential route", async () => {
  // app.ts mounts the credential routes at the deeper path and this surface at
  // the parent; the parent's middleware must pass /credential through to the
  // sibling handler, not answer 404 from its own route table.
  const combined = new Hono<{ Variables: AppVariables }>();
  combined.route(
    "/api/admin/gateway/credential",
    gatewayAdminCredentialRoutes(actorAs("admin"), credentialService),
  );
  combined.route("/api/admin/gateway", gatewayAdminRoutes(actorAs("admin"), deps));
  const status = await combined.request("/api/admin/gateway/credential");
  expect(status.status).toBe(200);
  const body = (await status.json()) as { status: { state: string } };
  expect(body.status.state).toBe("configured");
});

afterAll(async () => {
  await cleanSlate();
  await database.delete(users).where(inArray(users.id, [admin.userId, member.userId]));
  await database.$client.close();
});
