import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
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
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * Row-level security over the enterprise tenancy tables, per plan 02 §5 T1-B.
 *
 * Every assertion here runs on a RESTRICTED LOGIN connection (the `ob_ent_*` capability roles the
 * workflow's DBA provisioned), never on the migration owner: a superuser pass followed by "nothing
 * leaked" is not evidence. The migration owner connection exists only to plant the controlled
 * fixture and to prove the fixture is non-empty BEFORE any denial is trusted — an empty table
 * denies everything for free, which is exactly the false negative this suite refuses.
 *
 * Rejections are classified by driver SQLSTATE plus the object named in the message, so a table
 * privilege denial (42501 "permission denied for table"), an RLS WITH CHECK denial (42501 "new row
 * violates row-level security policy") and a composite foreign key denial (23503) are three
 * distinguishable answers, not one `toThrow()`.
 *
 * Dynamic values reach PostgreSQL exclusively through the query builder's bound parameters. The
 * statements that cannot take parameters — SET ROLE, DDL, TRUNCATE, and the set_config calls that
 * seed a transaction-local context — are static literals whose text is fixed in this file; every
 * identifier inside them is a compile-time constant, and most of them are statements the suite
 * expects to be REJECTED.
 */

const TENANT_A = "rls-t1b-tenant-a";
const TENANT_B = "rls-t1b-tenant-b";
const USER_A = "rls-t1b-user-a";
const USER_B = "rls-t1b-user-b";
const USER_C = "rls-t1b-user-c";
const PRINCIPAL_A = "rls-t1b-principal-a";
const PRINCIPAL_B = "rls-t1b-principal-b";
const PRINCIPAL_C = "rls-t1b-principal-c";
const WORKSPACE_A = "rls-t1b-workspace-a";
const WORKSPACE_B = "rls-t1b-workspace-b";
const RESOURCE_A = "rls-t1b-resource-a";
const RESOURCE_B = "rls-t1b-resource-b";

/*
 * `testDatabaseUrlFrom` throws when the variable is missing, refuses non-postgres URLs and refuses
 * the live `openbot` database. A missing restricted login is a failure, never a skipped test: the
 * denial suite must not degrade into "could not connect, so presumably nothing leaked".
 */
function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
/* Pinned to one connection: the same physical session must observe context-free results after a
 * transaction that carried a tenant context has ended, which only proves reuse when pooled
 * connections cannot rotate. */
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 1 },
);
const directoryDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  { max: 1 },
);
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);

/*
 * Transaction-local contexts, spelled as fixed literals. The fixture ids above appear here as
 * plain text on purpose: these statements are part of the test's own definition, not a channel for
 * outside input, and being literal makes that obvious to every reader and scanner.
 */
const dataContextTenantA = sql`select
  set_config('app.tenant_id', 'rls-t1b-tenant-a', true),
  set_config('app.principal_id', 'rls-t1b-principal-a', true),
  set_config('app.user_id', 'rls-t1b-user-a', true)`;
const dataContextTenantB = sql`select
  set_config('app.tenant_id', 'rls-t1b-tenant-b', true),
  set_config('app.principal_id', 'rls-t1b-principal-a', true),
  set_config('app.user_id', 'rls-t1b-user-a', true)`;
const dataContextMismatchedUser = sql`select
  set_config('app.tenant_id', 'rls-t1b-tenant-a', true),
  set_config('app.principal_id', 'rls-t1b-principal-a', true),
  set_config('app.user_id', 'rls-t1b-user-b', true)`;
const directoryContextUserA = sql`select set_config('app.user_id', 'rls-t1b-user-a', true)`;
const directoryContextUserB = sql`select set_config('app.user_id', 'rls-t1b-user-b', true)`;
const operatorContextTenantA = sql`select set_config('app.tenant_id', 'rls-t1b-tenant-a', true)`;
const operatorPrincipalContext = sql`select set_config('app.operator_principal_id', 'rls-t1b-principal-a', true)`;

type PgError = { code: string; message: string };

/*
 * Rejects are recorded as the driver's SQLSTATE plus the message naming the object, so the suite
 * can tell privilege, policy and foreign-key denials apart. Drizzle wraps driver failures in
 * DrizzleQueryError (whose message is only "Failed query: …"), and Bun's PostgresError carries the
 * SQLSTATE in `errno` while `code` holds a driver-level string — so walk the cause chain for the
 * first five-character SQLSTATE. An error without one is itself a failure: it means the driver's
 * classification was never reached.
 */
async function rejectionOf(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    let candidate = error as Record<string, unknown> | undefined;
    for (let depth = 0; candidate !== undefined && depth < 5; depth += 1) {
      const sqlstate = [candidate.errno, candidate.code].find(
        (value) =>
          typeof value === "string" && /^[0-9A-Z]{5}$/.test(value as string),
      );
      if (
        typeof sqlstate === "string" &&
        typeof candidate.message === "string"
      ) {
        return { code: sqlstate, message: candidate.message as string };
      }
      candidate = candidate.cause as Record<string, unknown> | undefined;
    }
    throw new Error(
      `expected a PostgreSQL error with a SQLSTATE and message, got: ${String(error)}`,
    );
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

beforeAll(async () => {
  /* The fixture is planted by the migration owner, idempotently, in foreign-key order. */
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(inArray(enterpriseResourceGrants.tenantId, [TENANT_A, TENANT_B]));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(
      or(
        inArray(enterpriseSecurityEvents.tenantId, [TENANT_A, TENANT_B]),
        like(enterpriseSecurityEvents.id, "rls-t1b-%"),
      ),
    );
  await ownerDatabase
    .delete(enterpriseResources)
    .where(inArray(enterpriseResources.tenantId, [TENANT_A, TENANT_B]));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(inArray(enterpriseWorkspaces.tenantId, [TENANT_A, TENANT_B]));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(
      or(
        inArray(enterpriseMemberships.tenantId, [TENANT_A, TENANT_B]),
        inArray(enterpriseMemberships.principalId, [
          PRINCIPAL_A,
          PRINCIPAL_B,
          PRINCIPAL_C,
        ]),
      ),
    );
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(
      inArray(enterprisePrincipals.id, [PRINCIPAL_A, PRINCIPAL_B, PRINCIPAL_C]),
    );
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "rls-t1b-%"));
  await ownerDatabase
    .delete(users)
    .where(inArray(users.id, [USER_A, USER_B, USER_C]));

  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_A, email: "rls-t1b-a@enterprise-test.invalid" },
      { id: USER_B, email: "rls-t1b-b@enterprise-test.invalid" },
      { id: USER_C, email: "rls-t1b-c@enterprise-test.invalid" },
    ])
    .onConflictDoNothing();
  await ownerDatabase
    .insert(enterpriseTenants)
    .values([
      { id: TENANT_A, name: "RLS T1B Tenant A" },
      { id: TENANT_B, name: "RLS T1B Tenant B" },
    ])
    .onConflictDoNothing();
  /* PRINCIPAL_C is deliberately NOT planted here: the identity operator test must create it
   * itself, under its own role, to prove the global identity write path end to end. USER_C (the
   * users row it binds to) is planted, because principals reference the deployment's users. */
  await ownerDatabase
    .insert(enterprisePrincipals)
    .values([
      { id: PRINCIPAL_A, userId: USER_A },
      { id: PRINCIPAL_B, userId: USER_B },
    ])
    .onConflictDoNothing();
  await ownerDatabase
    .insert(enterpriseMemberships)
    .values([
      { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
      { tenantId: TENANT_B, principalId: PRINCIPAL_A, role: "member" },
      { tenantId: TENANT_B, principalId: PRINCIPAL_B, role: "member" },
    ])
    .onConflictDoNothing();
  await ownerDatabase
    .insert(enterpriseWorkspaces)
    .values([
      { tenantId: TENANT_A, id: WORKSPACE_A, name: "Workspace A" },
      { tenantId: TENANT_B, id: WORKSPACE_B, name: "Workspace B" },
    ])
    .onConflictDoNothing();
  await ownerDatabase
    .insert(enterpriseResources)
    .values([
      {
        tenantId: TENANT_A,
        id: RESOURCE_A,
        workspaceId: WORKSPACE_A,
        kind: "document",
      },
      {
        tenantId: TENANT_B,
        id: RESOURCE_B,
        workspaceId: WORKSPACE_B,
        kind: "document",
      },
    ])
    .onConflictDoNothing();
  await ownerDatabase
    .insert(enterpriseResourceGrants)
    .values([
      {
        tenantId: TENANT_A,
        resourceId: RESOURCE_A,
        principalId: PRINCIPAL_A,
        action: "read",
      },
      {
        tenantId: TENANT_B,
        resourceId: RESOURCE_B,
        principalId: PRINCIPAL_A,
        action: "read",
      },
      {
        tenantId: TENANT_B,
        resourceId: RESOURCE_B,
        principalId: PRINCIPAL_B,
        action: "read",
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    dataDatabase.$client.close(),
    directoryDatabase.$client.close(),
    operatorDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
  ]);
});

describe("restricted logins carry no owner powers", () => {
  test("data login is not superuser, cannot bypass rls and is not a table owner member", async () => {
    const roles = await dataDatabase.execute(
      sql`select r.rolsuper, r.rolbypassrls, r.rolcreaterole
          from pg_roles r where r.rolname = current_user`,
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]?.rolsuper).toBe(false);
    expect(roles[0]?.rolbypassrls).toBe(false);
    expect(roles[0]?.rolcreaterole).toBe(false);

    /* Static identifier list: the enterprise tables this suite guards, spelled out. */
    const ownership = await dataDatabase.execute(
      sql`select c.relname,
            pg_has_role(current_user, c.relowner, 'MEMBER') as can_assume_owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in (
            'enterprise_tenants', 'enterprise_principals', 'enterprise_memberships',
            'enterprise_workspaces', 'enterprise_resources', 'enterprise_resource_grants',
            'enterprise_security_events', 'enterprise_identity_events'
          )`,
    );
    /* TEN-16: if any enterprise table's owner were assumbable, SET ROLE would cross every policy. */
    expect(ownership).toHaveLength(8);
    for (const row of ownership) {
      expect(row.can_assume_owner).toBe(false);
    }
  });

  test("restricted logins cannot set role to the owner or another capability role", async () => {
    /* Fixed literal statements: the role targets are a compile-time list, and each is expected to
     * be denied. A role name is an identifier and cannot be a bound parameter. */
    const targets: ReadonlyArray<{
      statement: ReturnType<typeof sql>;
      name: string;
    }> = [
      { statement: sql`set role openbot`, name: "openbot" },
      { statement: sql`set role ob_ent_operator`, name: "ob_ent_operator" },
      {
        statement: sql`set role ob_ent_identity_operator`,
        name: "ob_ent_identity_operator",
      },
    ];
    for (const target of targets) {
      const error = await rejectionOf(() =>
        dataDatabase.execute(target.statement),
      );
      expect(error.code).toBe("42501");
      expect(error.message).toContain("role");
      expect(error.message).toContain(target.name);
    }
  });
});

describe("controlled fixture is present before denials are trusted", () => {
  test("both tenants' resources, grants and memberships exist and are non-empty", async () => {
    const resources = await ownerDatabase
      .select({
        tenantId: enterpriseResources.tenantId,
        id: enterpriseResources.id,
      })
      .from(enterpriseResources)
      .where(inArray(enterpriseResources.tenantId, [TENANT_A, TENANT_B]));
    expect(resources).toHaveLength(2);

    const grants = await ownerDatabase
      .select({
        tenantId: enterpriseResourceGrants.tenantId,
        principalId: enterpriseResourceGrants.principalId,
      })
      .from(enterpriseResourceGrants)
      .where(inArray(enterpriseResourceGrants.tenantId, [TENANT_A, TENANT_B]));
    expect(grants).toHaveLength(3);

    const memberships = await ownerDatabase
      .select({
        tenantId: enterpriseMemberships.tenantId,
        principalId: enterpriseMemberships.principalId,
      })
      .from(enterpriseMemberships)
      .where(inArray(enterpriseMemberships.tenantId, [TENANT_A, TENANT_B]));
    expect(memberships).toHaveLength(3);
  });

  test("all enterprise tables carry ENABLE and FORCE row level security", async () => {
    const flags = await ownerDatabase.execute(
      sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in (
            'enterprise_tenants', 'enterprise_principals', 'enterprise_memberships',
            'enterprise_workspaces', 'enterprise_resources', 'enterprise_resource_grants',
            'enterprise_security_events', 'enterprise_identity_events'
          )`,
    );
    expect(flags).toHaveLength(8);
    for (const row of flags) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("no enterprise table grants PUBLIC any privilege", async () => {
    const grants = await ownerDatabase.execute(
      sql`select grantee, table_name, privilege_type
          from information_schema.role_table_grants
          where table_schema = 'public' and table_name like 'enterprise_%' and grantee = 'PUBLIC'`,
    );
    expect(grants).toHaveLength(0);
  });

  test("migrations dropped nothing: pre-existing identity tables are still readable", async () => {
    const tables = await ownerDatabase.execute(
      sql`select tablename from pg_tables
          where schemaname = 'public' and tablename in ('users', 'accounts', 'sessions', 'verifications')`,
    );
    expect(tables).toHaveLength(4);
    await ownerDatabase.execute(sql`select id from users limit 0`);
  });
});

describe("data role reads only inside a local tenant context", () => {
  test("with tenant A context the data role reads the A resource, with B the B resource", async () => {
    const rowsA = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantA);
      return tx
        .select({
          tenantId: enterpriseResources.tenantId,
          id: enterpriseResources.id,
        })
        .from(enterpriseResources);
    });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.id).toBe(RESOURCE_A);

    const rowsB = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantB);
      return tx
        .select({
          tenantId: enterpriseResources.tenantId,
          id: enterpriseResources.id,
        })
        .from(enterpriseResources);
    });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.id).toBe(RESOURCE_B);
  });

  test("the restrictive self-grant policy hides other principals' grants in the same tenant", async () => {
    /* Tenant B holds grants for principal A and principal B. The permissive tenant policy would
     * show both; the RESTRICTIVE self_grant policy must reduce that to the caller's own grant. */
    const grants = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantB);
      return tx
        .select({ principalId: enterpriseResourceGrants.principalId })
        .from(enterpriseResourceGrants);
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.principalId).toBe(PRINCIPAL_A);
  });

  test("membership, tenant and principal reads follow the same context boundary", async () => {
    const memberships = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantB);
      return tx
        .select({ principalId: enterpriseMemberships.principalId })
        .from(enterpriseMemberships);
    });
    /* (tenant B, principal B) exists but the data policy requires principal_id = the caller. */
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.principalId).toBe(PRINCIPAL_A);

    const tenants = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantA);
      return tx.select({ id: enterpriseTenants.id }).from(enterpriseTenants);
    });
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.id).toBe(TENANT_A);

    /* data_self requires BOTH the principal id and the user id to match; one alone sees nothing. */
    const mismatched = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextMismatchedUser);
      return tx
        .select({ id: enterprisePrincipals.id })
        .from(enterprisePrincipals);
    });
    expect(mismatched).toHaveLength(0);
  });

  test("a tenant context does not outlive its transaction on the same connection", async () => {
    const inside = await dataDatabase.transaction(async (tx) => {
      await tx.execute(dataContextTenantA);
      return tx
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources);
    });
    expect(inside).toHaveLength(1);

    /* Same pool of one connection, so this is the same session the transaction ran on. */
    const outside = await dataDatabase
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources);
    expect(outside).toHaveLength(0);
  });
});

describe("no context is deny-by-default, not an error", () => {
  test("data role raw selects see no rows anywhere", async () => {
    expect(
      await dataDatabase
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources),
    ).toHaveLength(0);
    expect(
      await dataDatabase
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships),
    ).toHaveLength(0);
    expect(
      await dataDatabase
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants),
    ).toHaveLength(0);
    expect(
      await dataDatabase
        .select({ id: enterprisePrincipals.id })
        .from(enterprisePrincipals),
    ).toHaveLength(0);
    expect(
      await dataDatabase
        .select({ resourceId: enterpriseResourceGrants.resourceId })
        .from(enterpriseResourceGrants),
    ).toHaveLength(0);
    expect(
      await dataDatabase
        .select({ id: enterpriseWorkspaces.id })
        .from(enterpriseWorkspaces),
    ).toHaveLength(0);
  });

  test("security events stay unreadable to the data role: table privilege, not a policy gap", async () => {
    /* The tenant_data policy covers enterprise_security_events on purpose; the SELECT grant is
     * deliberately withheld. The denial must be a table privilege rejection. */
    const error = await rejectionOf(() =>
      dataDatabase
        .select({ id: enterpriseSecurityEvents.id })
        .from(enterpriseSecurityEvents),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("permission denied for table");
    expect(error.message).toContain("enterprise_security_events");
  });
});

describe("directory role lists only the authenticated user", () => {
  test("user A sees their principal, both memberships and both tenants; user B sees only B", async () => {
    const forA = await directoryDatabase.transaction(async (tx) => {
      await tx.execute(directoryContextUserA);
      const principals = await tx
        .select({ id: enterprisePrincipals.id })
        .from(enterprisePrincipals);
      const memberships = await tx
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships);
      const tenants = await tx
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants);
      return { principals, memberships, tenants };
    });
    expect(forA.principals).toHaveLength(1);
    expect(forA.principals[0]?.id).toBe(PRINCIPAL_A);
    expect(forA.memberships).toHaveLength(2);
    expect(forA.memberships.map((row) => row.tenantId).sort()).toEqual([
      TENANT_A,
      TENANT_B,
    ]);
    expect(forA.tenants).toHaveLength(2);

    const forB = await directoryDatabase.transaction(async (tx) => {
      await tx.execute(directoryContextUserB);
      const principals = await tx
        .select({ id: enterprisePrincipals.id })
        .from(enterprisePrincipals);
      const memberships = await tx
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships);
      const tenants = await tx
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants);
      return { principals, memberships, tenants };
    });
    expect(forB.principals).toHaveLength(1);
    expect(forB.principals[0]?.id).toBe(PRINCIPAL_B);
    expect(forB.memberships).toHaveLength(1);
    expect(forB.memberships[0]?.tenantId).toBe(TENANT_B);
    expect(forB.tenants).toHaveLength(1);
    expect(forB.tenants[0]?.id).toBe(TENANT_B);
  });

  test("directory role without a user context sees nothing, and cannot read business tables", async () => {
    expect(
      await directoryDatabase
        .select({ id: enterprisePrincipals.id })
        .from(enterprisePrincipals),
    ).toHaveLength(0);
    expect(
      await directoryDatabase
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships),
    ).toHaveLength(0);

    const error = await rejectionOf(() =>
      directoryDatabase
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("enterprise_resources");
  });
});

describe("data role cannot write, truncate or run DDL", () => {
  test("UPDATE is rejected by the table privilege", async () => {
    const error = await rejectionOf(() =>
      dataDatabase
        .update(enterpriseResources)
        .set({ kind: "tampered" })
        .where(eq(enterpriseResources.tenantId, TENANT_A)),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("permission denied for table");
    expect(error.message).toContain("enterprise_resources");
  });

  test("TRUNCATE is rejected by the table privilege", async () => {
    const error = await rejectionOf(() =>
      dataDatabase.execute(sql`truncate enterprise_resources`),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("permission denied for table");
    expect(error.message).toContain("enterprise_resources");
  });

  test("INSERT is rejected by the table privilege", async () => {
    const error = await rejectionOf(() =>
      dataDatabase.insert(enterpriseResources).values({
        tenantId: TENANT_A,
        id: "rls-t1b-illegal-insert",
        workspaceId: WORKSPACE_A,
        kind: "document",
      }),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("permission denied for table");
    expect(error.message).toContain("enterprise_resources");
  });

  test("ALTER TABLE and CREATE TABLE are rejected", async () => {
    const alter = await rejectionOf(() =>
      dataDatabase.execute(
        sql`alter table enterprise_resources add column rls_probe text`,
      ),
    );
    expect(alter.code).toBe("42501");
    expect(alter.message).toContain("must be owner of table");
    expect(alter.message).toContain("enterprise_resources");

    const create = await rejectionOf(() =>
      dataDatabase.execute(sql`create table public.rls_t1b_probe (id text)`),
    );
    expect(create.code).toBe("42501");
    expect(create.message).toContain("permission denied for schema");
    expect(create.message).toContain("public");
  });
});

describe("operator writes stay inside the tenant the context names", () => {
  test("operator with tenant A context sees only A rows and can append audit events", async () => {
    const visible = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorContextTenantA);
      return tx
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships);
    });
    expect(visible).toHaveLength(1);

    await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorContextTenantA);
      await tx.insert(enterpriseSecurityEvents).values({
        tenantId: TENANT_A,
        id: "rls-t1b-op-audit-1",
        operationId: "rls-t1b-op-audit-1",
        actor: "rls-t1b-operator",
        kind: "membership.created",
        details: { fixture: "rls-t1b" },
      });
      await tx
        .update(enterpriseResources)
        .set({ kind: "document-v2" })
        .where(
          and(
            eq(enterpriseResources.tenantId, TENANT_A),
            eq(enterpriseResources.id, RESOURCE_A),
          ),
        );
      await tx
        .update(enterpriseResources)
        .set({ kind: "document" })
        .where(
          and(
            eq(enterpriseResources.tenantId, TENANT_A),
            eq(enterpriseResources.id, RESOURCE_A),
          ),
        );
    });
  });

  test("moving an A resource into real tenant B is rejected by WITH CHECK, not by FK", async () => {
    /* The row is visible and updatable under tenant A; the destination (tenant B, its workspace)
     * genuinely exists, so the composite FK is satisfied and the ONLY thing refusing the move is
     * the operator_scope WITH CHECK. */
    const error = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorContextTenantA);
      const visible = await tx
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, TENANT_A),
            eq(enterpriseResources.id, RESOURCE_A),
          ),
        );
      expect(visible).toHaveLength(1);
      return rejectionOf(() =>
        tx
          .update(enterpriseResources)
          .set({ tenantId: TENANT_B, workspaceId: WORKSPACE_B })
          .where(
            and(
              eq(enterpriseResources.tenantId, TENANT_A),
              eq(enterpriseResources.id, RESOURCE_A),
            ),
          ),
      );
    });
    expect(error.code).toBe("42501");
    expect(error.message).toContain("row-level security policy");
    expect(error.message).toContain("enterprise_resources");
  });

  test("referencing a workspace that exists only in tenant B is rejected by the composite FK", async () => {
    /* WITH CHECK is satisfied here (tenant_id stays A); the refusal must be the composite
     * foreign key on (tenant_id, workspace_id) -> enterprise_workspaces. */
    const error = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorContextTenantA);
      return rejectionOf(() =>
        tx.insert(enterpriseResources).values({
          tenantId: TENANT_A,
          id: "rls-t1b-resource-foreign",
          workspaceId: WORKSPACE_B,
          kind: "document",
        }),
      );
    });
    expect(error.code).toBe("23503");
    expect(error.message).toContain("enterprise_resources");
  });

  test("operator without a tenant context reads nothing", async () => {
    expect(
      await operatorDatabase
        .select({ tenantId: enterpriseMemberships.tenantId })
        .from(enterpriseMemberships),
    ).toHaveLength(0);
    expect(
      await operatorDatabase
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources),
    ).toHaveLength(0);
  });

  test("principal lookup is column-limited and requires the operator principal context", async () => {
    const visible = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorPrincipalContext);
      return tx
        .select({
          id: enterprisePrincipals.id,
          userId: enterprisePrincipals.userId,
          status: enterprisePrincipals.status,
        })
        .from(enterprisePrincipals);
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(PRINCIPAL_A);

    const withoutContext = await operatorDatabase
      .select({ id: enterprisePrincipals.id })
      .from(enterprisePrincipals);
    expect(withoutContext).toHaveLength(0);

    /* created_at is outside the granted column set (id, user_id, status). */
    const error = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(operatorPrincipalContext);
      return rejectionOf(() =>
        tx
          .select({ createdAt: enterprisePrincipals.createdAt })
          .from(enterprisePrincipals),
      );
    });
    expect(error.code).toBe("42501");
    expect(error.message).toContain("enterprise_principals");
  });
});

describe("tenant operator and identity operator stay separated (TEN-21)", () => {
  test("tenant operator cannot write global principals or read identity audit", async () => {
    const insert = await rejectionOf(() =>
      operatorDatabase
        .insert(enterprisePrincipals)
        .values({ id: "rls-t1b-illegal-principal", userId: USER_C }),
    );
    expect(insert.code).toBe("42501");
    expect(insert.message).toContain("permission denied for table");
    expect(insert.message).toContain("enterprise_principals");

    const update = await rejectionOf(() =>
      operatorDatabase
        .update(enterprisePrincipals)
        .set({ status: "suspended" })
        .where(eq(enterprisePrincipals.id, PRINCIPAL_A)),
    );
    expect(update.code).toBe("42501");
    expect(update.message).toContain("enterprise_principals");

    const audit = await rejectionOf(() =>
      operatorDatabase
        .select({ id: enterpriseIdentityEvents.id })
        .from(enterpriseIdentityEvents),
    );
    expect(audit.code).toBe("42501");
    expect(audit.message).toContain("enterprise_identity_events");
  });

  test("identity operator creates and suspends a principal and writes global identity audit", async () => {
    await identityOperatorDatabase
      .insert(enterprisePrincipals)
      .values({ id: PRINCIPAL_C, userId: USER_C });
    await identityOperatorDatabase
      .update(enterprisePrincipals)
      .set({ status: "suspended" })
      .where(eq(enterprisePrincipals.id, PRINCIPAL_C));
    const suspended = await identityOperatorDatabase
      .select({ status: enterprisePrincipals.status })
      .from(enterprisePrincipals)
      .where(eq(enterprisePrincipals.id, PRINCIPAL_C));
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.status).toBe("suspended");

    /* Binding repairs stay out of this role's reach: only the status column is updatable. */
    const rebind = await rejectionOf(() =>
      identityOperatorDatabase
        .update(enterprisePrincipals)
        .set({ userId: USER_A })
        .where(eq(enterprisePrincipals.id, PRINCIPAL_C)),
    );
    expect(rebind.code).toBe("42501");
    expect(rebind.message).toContain("enterprise_principals");

    await identityOperatorDatabase.insert(enterpriseIdentityEvents).values({
      id: "rls-t1b-identity-event-1",
      operationId: "rls-t1b-identity-event-1",
      actor: "rls-t1b-identity-operator",
      principalId: PRINCIPAL_C,
      kind: "principal.suspended",
      details: { principalId: PRINCIPAL_C },
    });
    const events = await identityOperatorDatabase
      .select({ id: enterpriseIdentityEvents.id })
      .from(enterpriseIdentityEvents)
      .where(like(enterpriseIdentityEvents.id, "rls-t1b-%"));
    expect(events).toHaveLength(1);
  });

  test("identity operator cannot read tenant business tables; data/directory cannot read identity audit", async () => {
    const resources = await rejectionOf(() =>
      identityOperatorDatabase
        .select({ id: enterpriseResources.id })
        .from(enterpriseResources),
    );
    expect(resources.code).toBe("42501");
    expect(resources.message).toContain("enterprise_resources");

    const tenants = await rejectionOf(() =>
      identityOperatorDatabase
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants),
    );
    expect(tenants.code).toBe("42501");
    expect(tenants.message).toContain("enterprise_tenants");

    const dataAudit = await rejectionOf(() =>
      dataDatabase
        .select({ id: enterpriseIdentityEvents.id })
        .from(enterpriseIdentityEvents),
    );
    expect(dataAudit.code).toBe("42501");
    expect(dataAudit.message).toContain("enterprise_identity_events");

    const directoryAudit = await rejectionOf(() =>
      directoryDatabase
        .select({ id: enterpriseIdentityEvents.id })
        .from(enterpriseIdentityEvents),
    );
    expect(directoryAudit.code).toBe("42501");
    expect(directoryAudit.message).toContain("enterprise_identity_events");
  });
});
