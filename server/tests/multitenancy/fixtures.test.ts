/**
 * MT002 / Issue #45 — the shared multitenancy identity fixture and the
 * restricted-role transaction harness it hands to every later ticket.
 *
 * Verification target (Ticket): `bun test server/tests/multitenancy/fixtures.test.ts`
 * including the pooled-connection reuse leak cases. Every database case runs
 * against the dedicated enterprise test PostgreSQL through the restricted
 * `ob_ent_*` business roles; nothing here may be skipped and counted green.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "../../../tests/support/bun-test-compat";
import {
  runMigrateTest,
  resolveTestDatabaseTarget,
} from "../../scripts/multitenancy/migrate-test";
import {
  createIsolationFixture,
  FIXTURE_IDENTITIES,
  type FixtureIdentity,
  type FixtureIdentityFact,
  type IsolationFixture,
  SPEC_IDENTITY_MATRIX,
} from "./support/fixture";
import {
  clearIsolationDomainRegistrations,
  registerIsolationDomain,
  runIsolationScenario,
} from "./support/scenarios";

let fixturePromise: Promise<IsolationFixture> | undefined;
function isolationFixture(): Promise<IsolationFixture> {
  fixturePromise ??= createIsolationFixture("memberships");
  return fixturePromise;
}

// The shared fixture reads tables later tickets migrate in: team membership
// rows live in the MT004 table and resource inserts carry MT008's visibility
// column. Bootstrap both through the real MT003 tool so the ticket's
// verification command passes on any dedicated database that has only the
// main journal, not just one pre-warmed by other tickets' suites
// (generate → apply → replay is convergent, like every MT ticket's own test).
const generatedMigrationDirs: string[] = [];
beforeAll(async () => {
  if (!resolveTestDatabaseTarget(process.env).ok) {
    // No dedicated test database: keep the per-test behavior — the database
    // cases fail loudly below instead of being skipped or counted green.
    return;
  }
  for (const taskId of ["MT004", "MT008"]) {
    const dir = join("/tmp", `mt002-migration-${randomUUID().slice(0, 8)}`);
    generatedMigrationDirs.push(dir);
    const generation = await runMigrateTest(
      ["generate", taskId, "--out", dir],
      { environment: process.env, out: () => {} },
    );
    if (generation.kind !== "generated") {
      throw new Error(`MT002 bootstrap generate failed: ${JSON.stringify(generation)}`);
    }
    const applied = await runMigrateTest(
      ["migrate", taskId, "--apply", "--manifest", join(dir, taskId, "manifest.json")],
      { environment: process.env, out: () => {} },
    );
    if (!["applied", "up-to-date"].includes(applied.kind)) {
      throw new Error(`MT002 bootstrap apply failed: ${JSON.stringify(applied)}`);
    }
  }
}, 60000);

afterAll(async () => {
  for (const dir of generatedMigrationDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  try {
    await (await fixturePromise)?.dispose();
  } catch {
    // Dispose failures surface in the dedicated dispose test; afterAll only
    // guarantees the connections are returned.
  }
});

test("createIsolationFixture refuses to run without a dedicated test database", async () => {
  await expect(
    createIsolationFixture("memberships", { environment: {} }),
  ).rejects.toThrow(/TEST_DATABASE_URL/);
  // A development DATABASE_URL never substitutes for the test URL.
  await expect(
    createIsolationFixture("memberships", {
      environment: {
        DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      },
    }),
  ).rejects.toThrow(/TEST_DATABASE_URL/);
  // The live application database name is refused even through TEST_DATABASE_URL.
  await expect(
    createIsolationFixture("memberships", {
      environment: {
        TEST_DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:5432/openbot",
      },
    }),
  ).rejects.toThrow(/openbot_enterprise_/);
  // Restricted business roles are mandatory: no fallback to the setup login.
  await expect(
    createIsolationFixture("memberships", {
      environment: {
        TEST_DATABASE_URL:
          "postgres://postgres@127.0.0.1:55432/openbot_enterprise_issue6_test",
      },
    }),
  ).rejects.toThrow(/ENTERPRISE_TEST_DIRECTORY_DATABASE_URL/);
});

test("createIsolationFixture refuses unknown isolation domains", async () => {
  await expect(
    createIsolationFixture("not-a-domain" as never, { environment: {} }),
  ).rejects.toThrow(/UNKNOWN_ISOLATION_DOMAIN/);
});

test("fixture covers every Spec §11 minimum identity matrix class", async () => {
  const fixture = await isolationFixture();
  expect(Object.keys(fixture.identities).sort()).toEqual(
    [...FIXTURE_IDENTITIES].sort(),
  );
  for (const [matrixClass, representatives] of Object.entries(
    SPEC_IDENTITY_MATRIX,
  )) {
    expect(representatives.length, matrixClass).toBeGreaterThan(0);
    for (const identity of representatives) {
      expect(fixture.identities[identity], matrixClass).toBeDefined();
    }
  }

  const ids = fixture.ids;
  const fact = (identity: FixtureIdentity): FixtureIdentityFact =>
    fixture.identities[identity];
  const teamIdsOf = (identity: FixtureIdentity, companyKey: string) =>
    fact(identity)
      .companies.find((company) => company.companyKey === companyKey)
      ?.teams.map((team) => team.workspaceId) ?? [];

  // Company / team / member-status combinations from the matrix.
  expect(fact("a1-member").companies.map((c) => c.companyKey)).toEqual([
    "company-a",
  ]);
  expect(teamIdsOf("a1-member", "company-a")).toEqual([ids["team-a1"]]);
  expect(fact("a2-member").companies.map((c) => c.companyKey)).toEqual([
    "company-a",
  ]);
  expect(teamIdsOf("a2-member", "company-a")).toEqual([ids["team-a2"]]);
  expect(teamIdsOf("a1a2-member", "company-a")).toEqual([
    ids["team-a1"],
    ids["team-a2"],
  ]);
  expect(teamIdsOf("a1-other", "company-a")).toEqual([ids["team-a1"]]);
  expect(fact("b1-member").companies.map((c) => c.companyKey)).toEqual([
    "company-b",
  ]);
  expect(teamIdsOf("b1-member", "company-b")).toEqual([ids["team-b1"]]);
  // The multi-company identity really holds both companies at once.
  expect(
    fact("multi-company")
      .companies.map((c) => c.companyKey)
      .sort(),
  ).toEqual(["company-a", "company-b"]);
  expect(teamIdsOf("multi-company", "company-a")).toEqual([ids["team-a1"]]);
  expect(teamIdsOf("multi-company", "company-b")).toEqual([ids["team-b1"]]);
  // Company administrator: management role, no team content.
  const adminCompany = fact("company-admin").companies[0];
  expect(adminCompany.companyKey).toBe("company-a");
  expect(adminCompany.role).toBe("tenant_admin");
  expect(adminCompany.teams).toEqual([]);
  // Machine identities hold no company membership at all.
  expect(fact("platform-operator").companies).toEqual([]);
  expect(fact("worker").companies).toEqual([]);
});

test("identity facts come from real database rows under the directory role", async () => {
  const fixture = await isolationFixture();
  for (const identity of FIXTURE_IDENTITIES) {
    const fact = fixture.identities[identity];
    if (fact.kind !== "human") continue;
    for (const company of fact.companies) {
      const rows = await fixture.queryRestricted(
        "directory",
        { tenantId: company.tenantId, principalId: company.principalId },
        "select role, status, epoch from enterprise_memberships where tenant_id = $1 and principal_id = $2",
        [company.tenantId, company.principalId],
      );
      expect(rows, identity).toHaveLength(1);
      expect(rows[0].role, identity).toBe(company.role);
      expect(rows[0].status, identity).toBe(company.status);
      expect(Number(rows[0].epoch), identity).toBe(company.epoch);
    }
  }
});

test("fixture data was created by the real provisioning factory, not by mocks", async () => {
  const fixture = await isolationFixture();
  const provisions = fixture
    .externalEffects()
    .filter((effect) => effect.kind === "deployment.provisioned");
  expect(provisions).toHaveLength(3);

  const companyA = fixture.ids["company-a"];
  const companyB = fixture.ids["company-b"];
  // Operator reads of security events are operation-scoped by RLS — exactly
  // the context the real factory writes with — so each receipt is checked
  // under its own operation id.
  for (const [tenantId, operationId] of [
    [companyA, fixture.ids["provision-a1"]],
    [companyA, fixture.ids["provision-a2"]],
    [companyB, fixture.ids["provision-b1"]],
  ] as const) {
    const rows = await fixture.queryRestricted(
      "operator",
      { tenantId, operationId },
      "select event_type, actor_id from enterprise_security_events where tenant_id = $1 and id = $2",
      [tenantId, operationId],
    );
    expect(rows, operationId).toEqual([
      { event_type: "deployment.provisioned", actor_id: expect.any(String) },
    ]);
  }
  // Without an operation context the operator cannot even enumerate the
  // audit trail — the restricted role has no blanket read.
  const unscoped = await fixture.queryRestricted(
    "operator",
    { tenantId: companyA },
    "select count(*)::int as n from enterprise_security_events",
    [],
  );
  expect(Number(unscoped[0]?.n)).toBe(0);

  // Explicit read grants are real rows, scoped to the provisioned principals.
  const grants = await fixture.queryRestricted(
    "data",
    {
      tenantId: companyA,
      principalId: fixture.ids["principal-a1-member"],
    },
    "select resource_id from enterprise_resource_grants where principal_id = $1",
    [fixture.ids["principal-a1-member"]],
  );
  expect(grants.map((row) => row.resource_id)).toEqual([
    fixture.ids["resource-a1"],
  ]);
});

test("restricted business roles are the real restricted capabilities", async () => {
  const fixture = await isolationFixture();
  for (const role of ["directory", "data", "operator"] as const) {
    const rows = await fixture.queryRestricted(
      role,
      undefined,
      "select current_user as current_user, session_user as session_user",
      [],
    );
    expect(rows[0]?.current_user, role).toBe(`ob_ent_${role}`);
    expect(rows[0]?.session_user, role).not.toBe(rows[0]?.current_user);
    expect(fixture.restrictedRoles[role].capability).toBe(`ob_ent_${role}`);
  }
  await expect(
    fixture.queryRestricted("postgres", undefined, "select 1", []),
  ).rejects.toThrow(/UNKNOWN_RESTRICTED_ROLE/);
});

test("data-role business transactions are tenant-scoped by RLS", async () => {
  const fixture = await isolationFixture();
  const companyA = fixture.ids["company-a"];
  const companyB = fixture.ids["company-b"];
  const contextA = {
    tenantId: companyA,
    principalId: fixture.ids["principal-a1-member"],
  };
  const contextB = {
    tenantId: companyB,
    principalId: fixture.ids["principal-b1-member"],
  };

  const inA = await fixture.queryRestricted(
    "data",
    contextA,
    "select id from enterprise_resources order by id",
    [],
  );
  expect(inA.map((row) => row.id)).toEqual([
    fixture.ids["resource-a1"],
    fixture.ids["resource-a1-other"],
    fixture.ids["resource-a2"],
  ]);
  const inB = await fixture.queryRestricted(
    "data",
    contextB,
    "select id from enterprise_resources order by id",
    [],
  );
  expect(inB.map((row) => row.id)).toEqual([fixture.ids["resource-b1"]]);
  // No context at all: the restricted role sees nothing (no default tenant).
  const unscoped = await fixture.queryRestricted(
    "data",
    undefined,
    "select id from enterprise_resources",
    [],
  );
  expect(unscoped).toEqual([]);
});

test("worker identity runs tenant/workspace-scoped reads without principal powers", async () => {
  const fixture = await isolationFixture();
  const companyA = fixture.ids["company-a"];
  const teamA1 = fixture.ids["team-a1"];
  const workerContext = { tenantId: companyA, workspaceId: teamA1 };

  const visible = await fixture.queryRestricted(
    "data",
    workerContext,
    "select count(*)::int as n from enterprise_resources",
    [],
  );
  expect(Number(visible[0]?.n)).toBe(3);
  // Principal-scoped tables stay closed to a principal-less machine identity.
  const grants = await fixture.queryRestricted(
    "data",
    workerContext,
    "select count(*)::int as n from enterprise_resource_grants",
    [],
  );
  expect(Number(grants[0]?.n)).toBe(0);
});

test("transaction context is cleared after commit and pooled reuse carries no scope", async () => {
  const fixture = await isolationFixture();
  const companyA = fixture.ids["company-a"];
  const companyB = fixture.ids["company-b"];
  const contextA = {
    tenantId: companyA,
    principalId: fixture.ids["principal-a1-member"],
    workspaceId: fixture.ids["team-a1"],
  };
  const contextB = {
    tenantId: companyB,
    principalId: fixture.ids["principal-b1-member"],
    workspaceId: fixture.ids["team-b1"],
  };

  // The dedicated one-connection pools make consecutive transactions share one
  // backend; prove it, because the leak assertions only mean something when
  // the same connection is really being reused.
  const pidA = await fixture.queryRestricted(
    "data",
    contextA,
    "select pg_backend_pid() as pid",
    [],
  );
  const pidB = await fixture.queryRestricted(
    "data",
    contextB,
    "select pg_backend_pid() as pid",
    [],
  );
  expect(pidB[0]?.pid).toBe(pidA[0]?.pid);

  // After two committed context-scoped transactions, the next transaction on
  // the same connection sees no tenant, principal or workspace setting.
  const leak = await fixture.queryRestricted(
    "data",
    undefined,
    "select nullif(current_setting('app.tenant_id', true), '') as tenant_id, nullif(current_setting('app.principal_id', true), '') as principal_id, nullif(current_setting('app.workspace_id', true), '') as workspace_id, (select count(*)::int from enterprise_resources) as resource_rows",
    [],
  );
  expect(leak[0]?.tenant_id ?? "").toBe("");
  expect(leak[0]?.principal_id ?? "").toBe("");
  expect(leak[0]?.workspace_id ?? "").toBe("");
  expect(Number(leak[0]?.resource_rows)).toBe(0);
});

test("transaction context is cleared after rollback", async () => {
  const fixture = await isolationFixture();
  const context = {
    tenantId: fixture.ids["company-a"],
    principalId: fixture.ids["principal-a1-member"],
  };
  // The context is set before the statement runs, so this transaction really
  // rolls back with a live scope in place.
  await expect(
    fixture.queryRestricted("data", context, "select 1 / 0 as boom", []),
  ).rejects.toThrow();
  const afterRollback = await fixture.queryRestricted(
    "data",
    undefined,
    "select nullif(current_setting('app.tenant_id', true), '') as tenant_id, (select count(*)::int from enterprise_resources) as resource_rows",
    [],
  );
  expect(afterRollback[0]?.tenant_id ?? "").toBe("");
  expect(Number(afterRollback[0]?.resource_rows)).toBe(0);
});

test("requestAs positive control: each team member reads their own team resource", async () => {
  const fixture = await isolationFixture();
  const ids = fixture.ids;
  const read = (
    identity: FixtureIdentity,
    resourceId: string,
    tenantId: string,
    workspaceId: string,
  ) =>
    fixture.requestAs(identity, {
      method: "GET",
      path: `/resources/${resourceId}`,
      tenantId,
      workspaceId,
    });

  for (const [identity, tenantId, workspaceId, resourceId] of [
    ["a1-member", ids["company-a"], ids["team-a1"], ids["resource-a1"]],
    ["a2-member", ids["company-a"], ids["team-a2"], ids["resource-a2"]],
    ["a1a2-member", ids["company-a"], ids["team-a1"], ids["resource-a1"]],
    ["a1a2-member", ids["company-a"], ids["team-a2"], ids["resource-a2"]],
    ["multi-company", ids["company-a"], ids["team-a1"], ids["resource-a1"]],
    ["multi-company", ids["company-b"], ids["team-b1"], ids["resource-b1"]],
    ["b1-member", ids["company-b"], ids["team-b1"], ids["resource-b1"]],
  ] as const) {
    const response = await read(identity, resourceId, tenantId, workspaceId);
    expect(response.status, identity).toBe(200);
    const body = (await response.json()) as { resourceId: string };
    expect(body.resourceId, identity).toBe(resourceId);
  }
});

test("requestAs demands explicit company and team selectors", async () => {
  const fixture = await isolationFixture();
  const ids = fixture.ids;
  const missingTenant = await fixture.requestAs("a1-member", {
    method: "GET",
    path: `/resources/${ids["resource-a1"]}`,
    workspaceId: ids["team-a1"],
  });
  expect(missingTenant.status).toBe(400);
  expect(await missingTenant.json()).toEqual({ error: "TENANT_REQUIRED" });

  const missingWorkspace = await fixture.requestAs("a1-member", {
    method: "GET",
    path: `/resources/${ids["resource-a1"]}`,
    tenantId: ids["company-a"],
  });
  expect(missingWorkspace.status).toBe(400);
  expect(await missingWorkspace.json()).toEqual({
    error: "WORKSPACE_REQUIRED",
  });
});

test("requestAs denies cross-company, cross-team and personal-resource access invisibly", async () => {
  const fixture = await isolationFixture();
  const ids = fixture.ids;
  const read = (
    identity: FixtureIdentity,
    resourceId: string,
    tenantId: string,
    workspaceId: string,
  ) =>
    fixture
      .requestAs(identity, {
        method: "GET",
        path: `/resources/${resourceId}`,
        tenantId,
        workspaceId,
      })
      .then(async (response) => ({
        status: response.status,
        body: (await response.json()) as { error?: string },
      }));

  // Cross-company: a company A member cannot act in company B, and vice versa.
  expect(
    await read(
      "a1-member",
      ids["resource-b1"],
      ids["company-b"],
      ids["team-b1"],
    ),
  ).toEqual({ status: 403, body: { error: "TENANT_FORBIDDEN" } });
  expect(
    await read(
      "b1-member",
      ids["resource-a1"],
      ids["company-a"],
      ids["team-a1"],
    ),
  ).toEqual({ status: 403, body: { error: "TENANT_FORBIDDEN" } });

  // Cross-team inside one company: MT005 refuses the team selection at the
  // eligibility gate (company member, but not a member of that team). The
  // code is identical for a nonexistent workspace — no existence leak; the
  // resource-level 404 invisibility below still holds within one's own team.
  expect(
    await read(
      "a1-member",
      ids["resource-a2"],
      ids["company-a"],
      ids["team-a2"],
    ),
  ).toEqual({ status: 403, body: { error: "WORKSPACE_FORBIDDEN" } });
  // A wrong team selector makes even an accessible resource invisible.
  expect(
    await read(
      "a1a2-member",
      ids["resource-a1"],
      ids["company-a"],
      ids["team-a2"],
    ),
  ).toEqual({ status: 404, body: { error: "RESOURCE_NOT_FOUND" } });
  // Same team, someone else's resource: no grant, no visibility, no hint.
  expect(
    await read(
      "a1-member",
      ids["resource-a1-other"],
      ids["company-a"],
      ids["team-a1"],
    ),
  ).toEqual({ status: 404, body: { error: "RESOURCE_NOT_FOUND" } });
  // Company administration is not content access: an admin without a team
  // membership row is refused at the MT005 eligibility gate.
  expect(
    await read(
      "company-admin",
      ids["resource-a1"],
      ids["company-a"],
      ids["team-a1"],
    ),
  ).toEqual({ status: 403, body: { error: "WORKSPACE_FORBIDDEN" } });
});

test("machine identities have no authenticated session and unknown routes are invisible", async () => {
  const fixture = await isolationFixture();
  const ids = fixture.ids;
  for (const identity of ["platform-operator", "worker"] as const) {
    const response = await fixture.requestAs(identity, {
      method: "GET",
      path: `/resources/${ids["resource-a1"]}`,
      tenantId: ids["company-a"],
      workspaceId: ids["team-a1"],
    });
    expect(response.status, identity).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_REQUIRED" });
  }
  const unknownRoute = await fixture.requestAs("a1-member", {
    method: "GET",
    path: "/no-such-business-route",
    tenantId: ids["company-a"],
    workspaceId: ids["team-a1"],
  });
  expect(unknownRoute.status).toBe(404);
  const wrongMethod = await fixture.requestAs("a1-member", {
    method: "POST",
    path: `/resources/${ids["resource-a1"]}`,
    tenantId: ids["company-a"],
    workspaceId: ids["team-a1"],
    body: {},
  });
  expect(wrongMethod.status).toBe(404);
  await expect(
    fixture.requestAs("no-such-identity" as never, {
      method: "GET",
      path: "/",
    }),
  ).rejects.toThrow(/UNKNOWN_FIXTURE_IDENTITY/);
});

test("membership status combinations: suspending one company leaves the other intact", async () => {
  const fixture = await isolationFixture();
  const ids = fixture.ids;

  const receipt = await fixture.suspendCompanyMembership(
    "multi-company",
    ids["company-a"],
  );
  expect(receipt).toEqual({ changed: true, epoch: 2 });

  // Company A eligibility is gone immediately...
  const inA = await fixture.requestAs("multi-company", {
    method: "GET",
    path: `/resources/${ids["resource-a1"]}`,
    tenantId: ids["company-a"],
    workspaceId: ids["team-a1"],
  });
  expect(inA.status).toBe(403);
  // ...while company B keeps working and its epoch is untouched.
  const inB = await fixture.requestAs("multi-company", {
    method: "GET",
    path: `/resources/${ids["resource-b1"]}`,
    tenantId: ids["company-b"],
    workspaceId: ids["team-b1"],
  });
  expect(inB.status).toBe(200);

  const epochA = await fixture.queryRestricted(
    "directory",
    { tenantId: ids["company-a"], principalId: ids["principal-multi-company"] },
    "select status, epoch from enterprise_memberships where tenant_id = $1 and principal_id = $2",
    [ids["company-a"], ids["principal-multi-company"]],
  );
  expect(epochA[0]).toEqual({ status: "suspended", epoch: 2 });
  const epochB = await fixture.queryRestricted(
    "directory",
    { tenantId: ids["company-b"], principalId: ids["principal-multi-company"] },
    "select status, epoch from enterprise_memberships where tenant_id = $1 and principal_id = $2",
    [ids["company-b"], ids["principal-multi-company"]],
  );
  expect(epochB[0]).toEqual({ status: "active", epoch: 1 });

  const suspension = fixture
    .externalEffects()
    .filter((effect) => effect.kind === "membership.suspended");
  expect(suspension).toHaveLength(1);
});

test("scenario registry runs registered adapters and refuses everything else", async () => {
  clearIsolationDomainRegistrations();
  await expect(runIsolationScenario("memberships", "smoke")).rejects.toThrow(
    /ISOLATION_DOMAIN_NOT_REGISTERED/,
  );

  registerIsolationDomain("memberships", {
    run: async (scenarioId) => ({
      positiveControlPassed: scenarioId === "smoke",
      denied: true,
      leakedRecords: [],
      forbiddenEffects: [],
    }),
  });
  const observation = await runIsolationScenario("memberships", "smoke");
  expect(observation).toEqual({
    positiveControlPassed: true,
    denied: true,
    leakedRecords: [],
    forbiddenEffects: [],
  });
  // A scenario that actually failed reports its facts; it is not an error.
  const failed = await runIsolationScenario("memberships", "negative-control");
  expect(failed.positiveControlPassed).toBe(false);

  // Adapter failures propagate; they never become a preset success.
  registerIsolationDomain("inventory", {
    run: async () => {
      throw new Error("adapter exploded");
    },
  });
  await expect(runIsolationScenario("inventory", "smoke")).rejects.toThrow(
    /ISOLATION_SCENARIO_FAILED/,
  );

  // Skip-shaped garbage is refused.
  registerIsolationDomain("telemetry", {
    run: async () => ({ denied: true }) as Awaited<ReturnType<never>> as never,
  });
  await expect(runIsolationScenario("telemetry", "smoke")).rejects.toThrow(
    /ISOLATION_OBSERVATION_INVALID/,
  );

  // Duplicate and unknown registrations are refused.
  expect(() =>
    registerIsolationDomain("memberships", {
      run: async () => ({
        positiveControlPassed: true,
        denied: false,
        leakedRecords: [],
        forbiddenEffects: [],
      }),
    }),
  ).toThrow(/ISOLATION_DOMAIN_ALREADY_REGISTERED/);
  expect(() =>
    registerIsolationDomain("bogus" as never, {
      run: async () => ({
        positiveControlPassed: true,
        denied: false,
        leakedRecords: [],
        forbiddenEffects: [],
      }),
    }),
  ).toThrow(/UNKNOWN_ISOLATION_DOMAIN/);
});

test("dispose cleans up fixture rows and refuses further use", async () => {
  const fixture = await isolationFixture();
  await fixture.dispose();

  await expect(
    fixture.queryRestricted("data", undefined, "select 1", []),
  ).rejects.toThrow(/FIXTURE_DISPOSED/);
  await expect(
    fixture.requestAs("a1-member", {
      method: "GET",
      path: "/",
      tenantId: "t",
      workspaceId: "w",
    }),
  ).rejects.toThrow(/FIXTURE_DISPOSED/);
  // Idempotent: a second dispose is a no-op, not an error.
  await fixture.dispose();
});
