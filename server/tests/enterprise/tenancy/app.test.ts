import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import type { EnterpriseDependencies } from "../../../src/enterprise/app";
import { createEnterpriseApp } from "../../../src/enterprise/app";
import { createResourceReader } from "../../../src/enterprise/authz/repository";
import { createAuthz } from "../../../src/enterprise/authz/service";
import type { Membership } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createResource,
  createWorkspace,
  grantRead,
  provisionMember,
  suspendMember,
} from "../../../src/enterprise/tenancy/provision";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * The enterprise route assembly, per plan 02 §6 T3-A.
 *
 * The unit block proves the boundary without any database: no session is 401 (and business
 * resources are never touched), legacy and unapproved auth entry points are 404, the auth
 * allowlist forwards by EXACT method + pathname only, a deployment admin is still only their own
 * memberships, write requests need an allowed origin and JSON, draining spares only health, and
 * every error answer is redacted — server-generated request_id, stable code, no raw error text.
 *
 * The live block (run with the enterprise test env file) proves the same app over the real
 * directory/reader chain: a real granted resource reads green, an unknown policy revision is a
 * 503 for THAT tenant only, a suspended membership rejects the next request under the SAME
 * session (scope is rebuilt from the live directory every request), and a database outage answers
 * 503 with no resource payload while /health/live stays 200 and /health/ready fails.
 */

const ACTIVE_MEMBER: Membership = {
  tenantId: "a",
  principalId: "p",
  tenantName: "A",
  role: "member",
  epoch: 1,
  tenantStatus: "active",
  principalStatus: "active",
  memberStatus: "active",
};

const SESSION_USER = { id: "u", email: "test-only" };

function unitDeps(
  overrides: Partial<EnterpriseDependencies> = {},
): EnterpriseDependencies {
  return {
    auth: {
      handler: async () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    },
    directory: { listForUser: async () => [] },
    resources: {
      readAuthorizedResource: async () => {
        throw new Error("not reached");
      },
    },
    authz: { check: async () => false },
    /* The unit block never reaches a conversations route (the directory answers empty), so the
     * injected data-plane pool is a placeholder: the shape is the contract under test. */
    conversationsDatabase: null as unknown as Database,
    allowedOrigins: new Set<string>(),
    authRoutes: new Set<string>(),
    logRedactedSecurityError: () => {},
    isDraining: () => false,
    ready: async () => true,
    ...overrides,
  };
}

function sessionDeps(
  overrides: Partial<EnterpriseDependencies> = {},
): EnterpriseDependencies {
  return unitDeps({
    auth: {
      handler: async () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: SESSION_USER }) },
    },
    ...overrides,
  });
}

describe("the enterprise app boundary (no database)", () => {
  test("no session cannot select a tenant", async () => {
    const app = createEnterpriseApp(unitDeps());
    expect((await app.request("/api/enterprise/v1/tenants")).status).toBe(401);
  });

  test("legacy and unapproved auth routes are not mounted", async () => {
    const app = createEnterpriseApp(unitDeps());
    for (const path of [
      "/api/agents",
      "/api/agent-tools/call",
      "/api/admin/status",
      "/api/auth/scim/v2/Users",
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  test("an approved auth route forwards by exact method and pathname only", async () => {
    let handlerCalls = 0;
    const app = createEnterpriseApp(
      unitDeps({
        auth: {
          handler: async () => {
            handlerCalls += 1;
            return new Response(null, { status: 204 });
          },
          api: { getSession: async () => null },
        },
        authRoutes: new Set(["GET /api/auth/session"]),
      }),
    );
    expect((await app.request("/api/auth/session")).status).toBe(204);
    expect(handlerCalls).toBe(1);
    /* Same pathname, wrong method; and a sibling path never listed: both 404. */
    expect(
      (await app.request("/api/auth/session", { method: "POST" })).status,
    ).toBe(404);
    expect((await app.request("/api/auth/sign-out")).status).toBe(404);
    expect(handlerCalls).toBe(1);
  });

  test("the tenant list needs no selector and returns only fully active memberships", async () => {
    const app = createEnterpriseApp(
      sessionDeps({
        directory: {
          listForUser: async () => [
            ACTIVE_MEMBER,
            {
              ...ACTIVE_MEMBER,
              tenantId: "s",
              memberStatus: "suspended" as const,
            },
            {
              ...ACTIVE_MEMBER,
              tenantId: "t",
              tenantStatus: "suspended" as const,
            },
          ],
        },
      }),
    );
    const response = await app.request("/api/enterprise/v1/tenants");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: "a", name: "A", role: "member" }],
    });
  });

  test("a deployment admin is still confined to their own memberships", async () => {
    const adminAuth = {
      handler: async () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { id: "u", email: "test-only", role: "admin" as const },
        }),
      },
    };
    const app = createEnterpriseApp(
      unitDeps({
        auth: adminAuth,
        directory: { listForUser: async () => [ACTIVE_MEMBER] },
      }),
    );
    expect(
      (
        await app.request("/api/enterprise/v1/scope", {
          headers: { "x-openbot-tenant": "b" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/enterprise/v1/scope", {
          headers: { "x-openbot-tenant": "a" },
        })
      ).status,
    ).toBe(200);
  });

  test("write requests require an allowed origin and a JSON body", async () => {
    const origin = "https://app.example.com";
    const app = createEnterpriseApp(
      sessionDeps({ allowedOrigins: new Set([origin]) }),
    );
    /* A missing or unlisted origin is refused before anything else. */
    expect(
      (await app.request("/api/enterprise/v1/tenants", { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/enterprise/v1/tenants", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    /* An allowed origin without a JSON content type is a shape refusal. */
    expect(
      (
        await app.request("/api/enterprise/v1/tenants", {
          method: "POST",
          headers: { origin },
        })
      ).status,
    ).toBe(400);
    /* With both, the write gate passes: the refusal moves on to the scope check (no tenant
     * selected), which proves the origin/content-type gate let the request through. */
    const past = await app.request("/api/enterprise/v1/tenants", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
    });
    expect(past.status).toBe(400);
    const pastBody = (await past.json()) as { error: { code: string } };
    expect(pastBody.error.code).toBe("TENANT_REQUIRED");
  });

  test("draining answers 503 everywhere except health", async () => {
    const app = createEnterpriseApp(sessionDeps({ isDraining: () => true }));
    const response = await app.request("/api/enterprise/v1/tenants");
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe("SERVICE_DRAINING");
    expect((await app.request("/health/live")).status).toBe(200);
  });

  test("readiness reports unavailable as 503 and ready as 200", async () => {
    const unavailable = createEnterpriseApp(
      unitDeps({ ready: async () => false }),
    );
    const failing = await unavailable.request("/health/ready");
    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({ status: "unavailable" });

    const ready = createEnterpriseApp(unitDeps({ ready: async () => true }));
    const passing = await ready.request("/health/ready");
    expect(passing.status).toBe(200);
    expect(await passing.json()).toEqual({ status: "ready" });
  });

  test("errors are redacted, request-id stamped and logged", async () => {
    const logged: Array<{
      requestId: string;
      status: number;
      code: string;
    }> = [];
    const app = createEnterpriseApp(
      sessionDeps({
        directory: { listForUser: async () => [ACTIVE_MEMBER] },
        resources: {
          readAuthorizedResource: async () => {
            throw new Error("secret-token-never-leaks");
          },
        },
        logRedactedSecurityError: (event) => {
          logged.push(event);
        },
      }),
    );
    const response = await app.request("/api/enterprise/v1/resources/ok", {
      headers: { "x-openbot-tenant": "a" },
    });
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("secret-token-never-leaks");
    const body = JSON.parse(text) as {
      error: {
        code: string;
        request_id: string;
        retryable: boolean;
        summary: string;
      };
    };
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        request_id: expect.any(String) as string,
        retryable: false,
        summary: "服务暂不可用",
      },
    });
    expect(response.headers.get("x-request-id")).toBe(body.error.request_id);
    expect(logged).toEqual([
      {
        requestId: body.error.request_id,
        status: 500,
        code: "INTERNAL_ERROR",
      },
    ]);
  });

  test("an identified EnterpriseError keeps its own code and summary", async () => {
    const app = createEnterpriseApp(
      sessionDeps({
        directory: { listForUser: async () => [ACTIVE_MEMBER] },
        resources: {
          readAuthorizedResource: async () => {
            throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
          },
        },
      }),
    );
    const response = await app.request("/api/enterprise/v1/resources/ok", {
      headers: { "x-openbot-tenant": "a" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "RESOURCE_NOT_FOUND",
        request_id: expect.any(String) as string,
        retryable: false,
        summary: "请求未获允许",
      },
    });
  });

  test("an identified driver outage is a 503 that returns no resource", async () => {
    const app = createEnterpriseApp(
      sessionDeps({
        directory: { listForUser: async () => [ACTIVE_MEMBER] },
        resources: {
          readAuthorizedResource: async () => {
            throw Object.assign(new Error("connection dead"), {
              code: "ERR_POSTGRES_CONNECTION_CLOSED",
            });
          },
        },
      }),
    );
    const response = await app.request("/api/enterprise/v1/resources/ok", {
      headers: { "x-openbot-tenant": "a" },
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        request_id: expect.any(String) as string,
        retryable: false,
        summary: "服务暂不可用",
      },
    });
  });

  test("malformed resource ids never reach the reader", async () => {
    const app = createEnterpriseApp(
      sessionDeps({
        directory: { listForUser: async () => [ACTIVE_MEMBER] },
        resources: {
          readAuthorizedResource: async () => {
            throw new Error("not reached");
          },
        },
      }),
    );
    /* Ids that reach the handler but fail the pattern answer the closed 404 as JSON. */
    for (const id of ["bad%20id", "x".repeat(129)]) {
      const response = await app.request(`/api/enterprise/v1/resources/${id}`, {
        headers: { "x-openbot-tenant": "a" },
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    }
    /* A multi-segment id matches no route at all: plain 404, still never the reader. */
    expect(
      (
        await app.request("/api/enterprise/v1/resources/a/b", {
          headers: { "x-openbot-tenant": "a" },
        })
      ).status,
    ).toBe(404);
  });

  test("security headers are on every response", async () => {
    const app = createEnterpriseApp(unitDeps());
    for (const response of [
      await app.request("/api/enterprise/v1/tenants"),
      await app.request("/health/live"),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The live-database block, per plan 02 §6 T3-A steps 5–6: the same app over the real
 * directory + resource reader chain. Fixture discipline follows repository.test.ts: one owner
 * login for cleanup, the restricted logins the production roles use, and idempotent
 * prefix-scoped teardown.
 * ---------------------------------------------------------------------------
 */

const TENANT_A = "t3a-tenant-a";
const TENANT_B = "t3a-tenant-b";
const TENANT_NAME_A = "T3A App Tenant A";
const TENANT_NAME_B = "T3A App Tenant B";
const USER = "t3a-user";
const PRINCIPAL = "t3a-principal";
const WORKSPACE_A = "t3a-ws-a";
const WORKSPACE_B = "t3a-ws-b";
const RESOURCE_A = "t3a-res-a";
const RESOURCE_B = "t3a-res-b";
const OPERATOR = "t3a-operator";
const IDENTITY_OPERATOR = "t3a-idop";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 2 },
);
const directoryLoginDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  { max: 2 },
);
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 2 },
);

/* The fixed authenticated session the whole live block holds: same user, every request. */
const liveSessionAuth = {
  handler: async () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: USER, email: "t3a@enterprise-test.invalid" },
    }),
  },
};

const liveApp = createEnterpriseApp({
  auth: liveSessionAuth,
  directory: createDirectory(directoryLoginDatabase),
  resources: createResourceReader(dataDatabase, createAuthz()),
  authz: createAuthz(),
  conversationsDatabase: dataDatabase,
  allowedOrigins: new Set<string>(),
  authRoutes: new Set<string>(),
  logRedactedSecurityError: () => {},
  isDraining: () => false,
  ready: async () => {
    try {
      await directoryLoginDatabase.$client.unsafe("select 1");
      return true;
    } catch {
      return false;
    }
  },
});

beforeAll(async () => {
  /* Idempotent teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "t3a-%"));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, "t3a-%"));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, "t3a-%"));
  await ownerDatabase.delete(users).where(like(users.id, "t3a-%"));

  await ownerDatabase
    .insert(users)
    .values([{ id: USER, email: "t3a@enterprise-test.invalid" }])
    .onConflictDoNothing();

  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL,
    userId: USER,
    operator: IDENTITY_OPERATOR,
    operationId: "t3a-op-idp",
  });
  for (const [tenantId, tenantName] of [
    [TENANT_A, TENANT_NAME_A],
    [TENANT_B, TENANT_NAME_B],
  ] as const) {
    await provisionMember(operatorDatabase, {
      tenantId,
      tenantName,
      principalId: PRINCIPAL,
      userId: USER,
      role: "member",
      operator: OPERATOR,
      operationId: `t3a-op-open-${tenantId}`,
    });
    await createWorkspace(operatorDatabase, {
      tenantId,
      workspaceId: tenantId === TENANT_A ? WORKSPACE_A : WORKSPACE_B,
      name: `T3A App Workspace ${tenantId}`,
      operator: OPERATOR,
      operationId: `t3a-op-ws-${tenantId}`,
    });
  }
  for (const [tenantId, resourceId, workspaceId] of [
    [TENANT_A, RESOURCE_A, WORKSPACE_A],
    [TENANT_B, RESOURCE_B, WORKSPACE_B],
  ] as const) {
    await createResource(operatorDatabase, {
      tenantId,
      workspaceId,
      resourceId,
      kind: "document",
      operator: OPERATOR,
      operationId: `t3a-op-res-${resourceId}`,
    });
    await grantRead(operatorDatabase, {
      tenantId,
      resourceId,
      principalId: PRINCIPAL,
      operator: OPERATOR,
      operationId: `t3a-op-grant-${resourceId}`,
    });
  }
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
    directoryLoginDatabase.$client.close(),
    dataDatabase.$client.close(),
  ]);
});

describe("the enterprise app over the live database", () => {
  test("serves the tenant list, the scope and one authorized resource", async () => {
    const tenants = await liveApp.request("/api/enterprise/v1/tenants");
    expect(tenants.status).toBe(200);
    const body = (await tenants.json()) as {
      items: Array<{ id: string; name: string; role: string }>;
    };
    expect([...body.items].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: TENANT_A, name: TENANT_NAME_A, role: "member" },
      { id: TENANT_B, name: TENANT_NAME_B, role: "member" },
    ]);

    const scope = await liveApp.request("/api/enterprise/v1/scope", {
      headers: { "x-openbot-tenant": TENANT_A },
    });
    expect(scope.status).toBe(200);
    expect(await scope.json()).toEqual({
      tenantId: TENANT_A,
      principalId: PRINCIPAL,
      role: "member",
    });

    const resource = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_A}`,
      { headers: { "x-openbot-tenant": TENANT_A } },
    );
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual({
      id: RESOURCE_A,
      workspaceId: WORKSPACE_A,
      kind: "document",
      revision: 1,
    });
  });

  test("an unsupported policy revision is a 503 for that tenant only", async () => {
    try {
      await ownerDatabase.$client.unsafe(
        "update enterprise_tenants set policy_revision = $1 where id = $2",
        ["tenancy-v9-unknown", TENANT_A],
      );
      const affected = await liveApp.request(
        `/api/enterprise/v1/resources/${RESOURCE_A}`,
        { headers: { "x-openbot-tenant": TENANT_A } },
      );
      expect(affected.status).toBe(503);
      const body = (await affected.json()) as { error: { code: string } };
      expect(body.error.code).toBe("POLICY_REVISION_UNSUPPORTED");

      /* The other tenant, on a supported revision, is unaffected. */
      const other = await liveApp.request(
        `/api/enterprise/v1/resources/${RESOURCE_B}`,
        { headers: { "x-openbot-tenant": TENANT_B } },
      );
      expect(other.status).toBe(200);
    } finally {
      await ownerDatabase.$client.unsafe(
        "update enterprise_tenants set policy_revision = $1 where id = $2",
        ["tenancy-v1", TENANT_A],
      );
    }
    const restored = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_A}`,
      { headers: { "x-openbot-tenant": TENANT_A } },
    );
    expect(restored.status).toBe(200);
  });

  test("a suspended membership rejects the next request under the same session", async () => {
    await suspendMember(operatorDatabase, {
      tenantId: TENANT_A,
      principalId: PRINCIPAL,
      operator: OPERATOR,
      operationId: "t3a-op-suspend-a",
    });
    /* Same session (same getSession answer), next request: the scope is rebuilt from the live
     * directory and the suspended membership is a 403 — not a logout, not a stale allow. */
    const rejected = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_A}`,
      { headers: { "x-openbot-tenant": TENANT_A } },
    );
    expect(rejected.status).toBe(403);
    const body = (await rejected.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TENANT_FORBIDDEN");

    /* The suspended tenant also disappears from the chooser. */
    const tenants = await liveApp.request("/api/enterprise/v1/tenants");
    const list = (await tenants.json()) as {
      items: Array<{ id: string }>;
    };
    expect(list.items.map((item) => item.id)).toEqual([TENANT_B]);

    /* The untouched tenant keeps working. */
    const other = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_B}`,
      { headers: { "x-openbot-tenant": TENANT_B } },
    );
    expect(other.status).toBe(200);
  });

  test("a database outage is a 503 with no resource while live stays 200", async () => {
    /* Prove the wiring is real first, then break the data plane connections. */
    const before = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_B}`,
      { headers: { "x-openbot-tenant": TENANT_B } },
    );
    expect(before.status).toBe(200);

    await directoryLoginDatabase.$client.close();
    await dataDatabase.$client.close();

    const outage = await liveApp.request(
      `/api/enterprise/v1/resources/${RESOURCE_B}`,
      { headers: { "x-openbot-tenant": TENANT_B } },
    );
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        request_id: expect.any(String) as string,
        retryable: false,
        summary: "服务暂不可用",
      },
    });

    expect((await liveApp.request("/health/live")).status).toBe(200);
    const ready = await liveApp.request("/health/ready");
    expect(ready.status).toBe(503);
  });
});
