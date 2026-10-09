import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
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
import type { Scope } from "../../../src/enterprise/contracts";
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
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import {
  beginOperation,
  lockKey,
  lockShared,
  withTenant,
} from "../../../src/enterprise/tenancy/transaction";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * The scoped read transaction, per plan 02 §6 T2-B steps 1 and 3.
 *
 * The connection under test is the RESTRICTED `ob_ent_data` login: RLS pins every enterprise table
 * to `app.tenant_id`/`app.principal_id`/`app.user_id`, which `withTenant` sets as transaction-local
 * context — so a query answers only inside the scope's own transaction, on the very connection that
 * set the context. The `max: 1` pool makes every sequential test reuse ONE physical connection,
 * which is what makes "the context did not leak onto the next transaction" a meaningful claim; the
 * `max: 2` pool lets two scopes run genuinely interleaved, which is what would expose any global
 * "current tenant" state.
 *
 * The fixture is two tenants, one human in both, a workspace in each, and in tenant A one granted
 * plus one ungranted resource — all planted through the T1-C controlled functions, never by hand.
 * Before any denial is asserted, the fixture is proven non-empty and readable.
 */

const TENANT_A = "t2btx-tenant-a";
const TENANT_B = "t2btx-tenant-b";
const TENANT_NAME_A = "T2B Transaction Tenant A";
const TENANT_NAME_B = "T2B Transaction Tenant B";
const USER_A = "t2btx-user-a";
const PRINCIPAL_A = "t2btx-principal-a";
const WORKSPACE_A = "t2btx-workspace-a";
const WORKSPACE_B = "t2btx-workspace-b";
const RESOURCE_GRANTED = "t2btx-resource-granted";
const RESOURCE_NO_GRANT = "t2btx-resource-no-grant";
const OPERATOR = "t2btx-operator";
const IDENTITY_OPERATOR = "t2btx-identity-operator";

const SELECT_WORKSPACE_TENANTS = "select tenant_id from enterprise_workspaces";
const SELECT_RESOURCE_IDS = "select id from enterprise_resources";
const TENANT_CONTEXT_NOW =
  "select nullif(current_setting('app.tenant_id', true), '') as v";

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
  { max: 1 },
);
const directoryDatabase = createDirectory(
  createDatabase(restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"), {
    max: 2,
  }),
);
/* One physical connection for every sequential test: context leaks would land here. */
const dataSingle = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 1 },
);
/* Two connections for the interleaving test. */
const dataParallel = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 2 },
);

let scopeA: Scope;
let scopeB: Scope;

beforeAll(async () => {
  /* Idempotent teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "t2btx-%"));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, "t2btx-%"));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, "t2btx-%"));
  await ownerDatabase.delete(users).where(like(users.id, "t2btx-%"));

  await ownerDatabase
    .insert(users)
    .values([{ id: USER_A, email: "t2btx-a@enterprise-test.invalid" }])
    .onConflictDoNothing();

  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL_A,
    userId: USER_A,
    operator: IDENTITY_OPERATOR,
    operationId: "t2btx-op-idp-a",
  });

  for (const input of [
    {
      tenantId: TENANT_A,
      tenantName: TENANT_NAME_A,
      operationId: "t2btx-op-open-a-in-a",
    },
    {
      tenantId: TENANT_B,
      tenantName: TENANT_NAME_B,
      operationId: "t2btx-op-open-a-in-b",
    },
  ]) {
    await provisionMember(operatorDatabase, {
      ...input,
      principalId: PRINCIPAL_A,
      userId: USER_A,
      role: "member",
      operator: OPERATOR,
    });
  }

  for (const [tenantId, workspaceId] of [
    [TENANT_A, WORKSPACE_A],
    [TENANT_B, WORKSPACE_B],
  ] as const) {
    await createWorkspace(operatorDatabase, {
      tenantId,
      workspaceId,
      name: `T2B Transaction Workspace ${workspaceId}`,
      operator: OPERATOR,
      operationId: `t2btx-op-ws-${workspaceId}`,
    });
  }

  for (const resourceId of [RESOURCE_GRANTED, RESOURCE_NO_GRANT]) {
    await createResource(operatorDatabase, {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      resourceId,
      kind: "document",
      operator: OPERATOR,
      operationId: `t2btx-op-res-${resourceId}`,
    });
  }
  await grantRead(operatorDatabase, {
    tenantId: TENANT_A,
    resourceId: RESOURCE_GRANTED,
    principalId: PRINCIPAL_A,
    operator: OPERATOR,
    operationId: "t2btx-op-grant-granted",
  });

  scopeA = await resolveScope(directoryDatabase, USER_A, TENANT_A);
  scopeB = await resolveScope(directoryDatabase, USER_A, TENANT_B);
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
    directoryDatabase.listForUser(USER_A).catch(() => undefined),
    dataSingle.$client.close(),
    dataParallel.$client.close(),
  ]);
});

/** Captures the EnterpriseError a rejected call throws, failing the test on any other outcome. */
async function enterpriseErrorOf(
  run: () => Promise<unknown>,
): Promise<EnterpriseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return error;
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

describe("the fixture is real before anything is asserted", () => {
  test("two tenants, two workspaces, two resources and one real grant exist", async () => {
    expect(
      await ownerDatabase
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants)
        .where(like(enterpriseTenants.id, "t2btx-%")),
    ).toHaveLength(2);
    expect(
      await ownerDatabase
        .select({ id: enterpriseWorkspaces.id })
        .from(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, "t2btx-%")),
    ).toHaveLength(2);
    expect(
      await ownerDatabase
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources)
        .where(like(enterpriseResources.tenantId, "t2btx-%")),
    ).toHaveLength(2);
    expect(
      await ownerDatabase
        .select({ resourceId: enterpriseResourceGrants.resourceId })
        .from(enterpriseResourceGrants)
        .where(like(enterpriseResourceGrants.tenantId, "t2btx-%")),
    ).toEqual([{ resourceId: RESOURCE_GRANTED }]);
  });

  test("the data login reads the granted and the ungranted resource inside tenant A's scope", async () => {
    const rows = await withTenant(dataSingle, scopeA, (tx) =>
      tx.unsafe<{ id: string }[]>(SELECT_RESOURCE_IDS),
    );
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [RESOURCE_GRANTED, RESOURCE_NO_GRANT].sort(),
    );
  });
});

describe("withTenant pins every statement of one transaction to the scope's tenant", () => {
  test("one reused connection serves tenant A then tenant B without bleed (max 1)", async () => {
    const rowsA = await withTenant(dataSingle, scopeA, (tx) =>
      tx.unsafe<{ tenant_id: string }[]>(SELECT_WORKSPACE_TENANTS),
    );
    const rowsB = await withTenant(dataSingle, scopeB, (tx) =>
      tx.unsafe<{ tenant_id: string }[]>(SELECT_WORKSPACE_TENANTS),
    );
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsA.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    expect(rowsB.every((row) => row.tenant_id === TENANT_B)).toBe(true);
  });

  test("the tenant context does not outlive its transaction on the reused connection (max 1)", async () => {
    await withTenant(dataSingle, scopeA, (tx) => tx.unsafe("select 1"));
    await expect(
      withTenant(dataSingle, scopeB, async (tx) => {
        await tx.unsafe("select 1");
        throw new Error("rollback-test");
      }),
    ).rejects.toThrow("rollback-test");
    const leaked = await beginOperation(dataSingle, async (tx) => {
      const rows = await tx.unsafe<{ v: string | null }[]>(TENANT_CONTEXT_NOW);
      return rows[0]?.v ?? null;
    });
    expect(leaked).toBeNull();
  });

  test("a rolled-back transaction leaves nothing behind on the reused connection (max 1)", async () => {
    /* The committed probe proves the observation window works: a temp table created and committed
     * on this connection stays visible to the next transaction on the same connection. */
    await withTenant(dataSingle, scopeA, async (tx) => {
      await tx.unsafe("create temp table t2btx_probe_commit(id int)");
      await tx.unsafe("insert into t2btx_probe_commit values (1)");
    });
    const committed = await beginOperation(dataSingle, async (tx) => {
      const rows = await tx.unsafe<{ n: number }[]>(
        "select count(*)::int as n from t2btx_probe_commit",
      );
      return rows[0].n;
    });
    expect(committed).toBe(1);

    await expect(
      withTenant(dataSingle, scopeA, async (tx) => {
        await tx.unsafe("create temp table t2btx_probe_rollback(id int)");
        await tx.unsafe("insert into t2btx_probe_rollback values (1)");
        throw new Error("rollback-test");
      }),
    ).rejects.toThrow("rollback-test");
    const surviving = await beginOperation(dataSingle, async (tx) => {
      const rows = await tx.unsafe<{ n: number }[]>(
        "select count(*)::int as n from pg_class where relname = 't2btx_probe_rollback'",
      );
      return rows[0].n;
    });
    expect(surviving).toBe(0);
  });

  test("two scopes interleave in parallel without cross-tenant bleed (max 2)", async () => {
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const aSelected = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bSelected = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const [sideA, sideB] = await Promise.all([
      withTenant(dataParallel, scopeA, async (tx) => {
        const first = await tx.unsafe<{ tenant_id: string }[]>(
          SELECT_WORKSPACE_TENANTS,
        );
        releaseA();
        await bSelected;
        const second = await tx.unsafe<{ tenant_id: string }[]>(
          SELECT_WORKSPACE_TENANTS,
        );
        return { first, second };
      }),
      withTenant(dataParallel, scopeB, async (tx) => {
        const first = await tx.unsafe<{ tenant_id: string }[]>(
          SELECT_WORKSPACE_TENANTS,
        );
        releaseB();
        await aSelected;
        const second = await tx.unsafe<{ tenant_id: string }[]>(
          SELECT_WORKSPACE_TENANTS,
        );
        return { first, second };
      }),
    ]);

    for (const side of [sideA, sideB]) {
      expect(side.first.length).toBeGreaterThan(0);
      expect(side.second.length).toBeGreaterThan(0);
    }
    expect(sideA.first.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    expect(sideA.second.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    expect(sideB.first.every((row) => row.tenant_id === TENANT_B)).toBe(true);
    expect(sideB.second.every((row) => row.tenant_id === TENANT_B)).toBe(true);
  });
});

describe("only genuinely issued scopes may open a transaction", () => {
  test("a forged copy of a real scope is refused before any query runs", async () => {
    const forged: Scope = { ...scopeA };
    const error = await enterpriseErrorOf(() =>
      withTenant(dataSingle, forged, (tx) => tx.unsafe("select 1")),
    );
    expect(error.code).toBe("UNVERIFIED_SCOPE");
    expect(error.status).toBe(403);
  });
});

describe("the transaction re-checks the live membership", () => {
  test("a scope minted before a suspension is revoked inside the transaction", async () => {
    await suspendMember(operatorDatabase, {
      tenantId: TENANT_B,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "t2btx-op-suspend-b",
    });

    const error = await enterpriseErrorOf(() =>
      withTenant(dataSingle, scopeB, (tx) => tx.unsafe("select 1")),
    );
    expect(error.code).toBe("SCOPE_REVOKED");
    expect(error.status).toBe(403);

    /* The untouched tenant keeps answering on the same connection. */
    const stillA = await withTenant(dataSingle, scopeA, (tx) =>
      tx.unsafe<{ tenant_id: string }[]>(SELECT_WORKSPACE_TENANTS),
    );
    expect(stillA.length).toBeGreaterThan(0);
    expect(stillA.every((row) => row.tenant_id === TENANT_A)).toBe(true);
  });

  test("the shared resource lock taken inside one transaction is gone after it ends", async () => {
    /* Advisory locks are transaction-scoped: after commit (and after rollback) the same key is
     * immediately takeable again on another connection — the reader path depends on that. */
    await withTenant(dataSingle, scopeA, (tx) =>
      lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_GRANTED)),
    );
    await withTenant(dataParallel, scopeA, (tx) =>
      lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_GRANTED)),
    );
    await expect(
      withTenant(dataSingle, scopeA, async (tx) => {
        await lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_NO_GRANT));
        throw new Error("rollback-test");
      }),
    ).rejects.toThrow("rollback-test");
    await withTenant(dataParallel, scopeA, (tx) =>
      lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_NO_GRANT)),
    );
  });
});
