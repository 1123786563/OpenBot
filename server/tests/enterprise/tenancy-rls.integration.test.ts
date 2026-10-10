import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const prefix = `enterprise-rls-${randomUUID()}`;
const tenantA = `${prefix}-tenant-a`;
const tenantB = `${prefix}-tenant-b`;
const userA = `${prefix}-user-a`;
const userB = `${prefix}-user-b`;
const principalA = `${prefix}-principal-a`;
const principalB = `${prefix}-principal-b`;
const workspaceA = `${prefix}-workspace-a`;
const workspaceB = `${prefix}-workspace-b`;
const resourceA = `${prefix}-resource-a`;
const resourceB = `${prefix}-resource-b`;
const ungrantedResource = `${prefix}-resource-no-grant`;
let setup: Database | undefined;
let directory: DirectoryDatabase | undefined;
let data: DataDatabase | undefined;
let operator: OperatorDatabase | undefined;
let directlyGrantedDataLogin: string | undefined;
let temporarilyTransferredToDataLogin: string | undefined;
let originalResourceOwner: string | undefined;

function setupDb() {
  setup ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 2 });
  return setup;
}
async function directoryDb() {
  if (!directory) {
    const candidate = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("directory"),
      { max: 2 },
    );
    try {
      directory = await verifyDirectoryDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return directory;
}
async function dataDb() {
  if (!data) {
    const candidate = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
      max: 2,
    });
    try {
      data = await verifyDataDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return data;
}
async function operatorDb() {
  if (!operator) {
    const candidate = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("operator"),
      { max: 2 },
    );
    try {
      operator = await verifyOperatorDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return operator;
}

async function closeDatabase(database: Database | undefined) {
  await database?.$client.close();
}

async function runCleanupActions(actions: Array<() => Promise<void>>) {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      "Enterprise RLS fixture cleanup failed.",
    );
  }
}

test("runs every cleanup action after a failed action", async () => {
  const firstError = new Error("first cleanup failed");
  const ran: number[] = [];

  let rejection: unknown;
  try {
    await runCleanupActions([
      async () => {
        ran.push(1);
        throw firstError;
      },
      async () => {
        ran.push(2);
      },
      async () => {
        ran.push(3);
      },
    ]);
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AggregateError);
  expect((rejection as AggregateError).errors).toContain(firstError);
  expect(ran).toEqual([1, 2, 3]);
});

test("RLS migration and DBA role artifacts are role-scoped", () => {
  const migration = readFileSync(
    new URL("../../drizzle/0055_enterprise_tenancy_rls.sql", import.meta.url),
    "utf8",
  );
  const roleBootstrap = readFileSync(
    new URL("../../ops/enterprise/roles.sql", import.meta.url),
    "utf8",
  );
  expect(migration).not.toMatch(/\bTO\s+public\b/i);
  expect(migration).toMatch(
    /REVOKE ALL PRIVILEGES ON TABLE[\s\S]+FROM PUBLIC,/,
  );
  expect(migration).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  expect(migration).toContain("TO ob_ent_directory");
  expect(migration).toContain("TO ob_ent_data");
  expect(migration).toContain("TO ob_ent_operator");
  expect(migration).not.toMatch(/GRANT [^;]+ TO ob_ent_identity_operator/i);
  expect(roleBootstrap).not.toMatch(/\b(?:ENCRYPTED\s+)?PASSWORD\s*=/i);
  expect(roleBootstrap.match(/CREATE ROLE\s+\w+/gi)).toHaveLength(4);
});

afterAll(async () => {
  const actions: Array<() => Promise<void>> = [];
  const setupHandle = setup;
  if (setupHandle) {
    const resourceOwner = originalResourceOwner;
    if (temporarilyTransferredToDataLogin && resourceOwner) {
      actions.push(async () => {
        await setupHandle.execute(sql`
          ALTER TABLE enterprise_resources OWNER TO ${sql.identifier(resourceOwner)}
        `);
        temporarilyTransferredToDataLogin = undefined;
        originalResourceOwner = undefined;
      });
    }
    const dataLogin = directlyGrantedDataLogin;
    if (dataLogin) {
      actions.push(async () => {
        await setupHandle.execute(sql`
          REVOKE SELECT ON TABLE enterprise_resources FROM ${sql.identifier(dataLogin)}
        `);
        directlyGrantedDataLogin = undefined;
      });
    }
    actions.push(
      () =>
        setupHandle
          .delete(enterpriseSecurityEvents)
          .where(sql`${enterpriseSecurityEvents.tenantId} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterpriseResourceGrants)
          .where(sql`${enterpriseResourceGrants.tenantId} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterpriseResources)
          .where(sql`${enterpriseResources.tenantId} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterpriseWorkspaces)
          .where(sql`${enterpriseWorkspaces.tenantId} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterpriseMemberships)
          .where(sql`${enterpriseMemberships.tenantId} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterprisePrincipals)
          .where(sql`${enterprisePrincipals.id} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(enterpriseTenants)
          .where(sql`${enterpriseTenants.id} like ${`${prefix}%`}`)
          .then(() => undefined),
      () =>
        setupHandle
          .delete(users)
          .where(sql`${users.id} like ${`${prefix}%`}`)
          .then(() => undefined),
    );
  }
  actions.push(
    () => closeDatabase(operator),
    () => closeDatabase(data),
    () => closeDatabase(directory),
    () => closeDatabase(setup),
  );
  await runCleanupActions(actions);
});

function expectPostgresError(
  error: unknown,
  expected: { code: string; table_name?: string; constraint_name?: string },
) {
  expect(error).toBeInstanceOf(Error);
  let cursor: unknown = error;
  let sqlState: string | undefined;
  let message = "";
  const seen = new Set<object>();
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as {
      code?: unknown;
      errno?: unknown;
      sqlState?: unknown;
      sqlstate?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    message += ` ${String(candidate.message ?? "")}`;
    for (const value of [
      candidate.errno,
      candidate.sqlState,
      candidate.sqlstate,
      candidate.code,
    ]) {
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) {
        sqlState = value;
        break;
      }
    }
    if (sqlState) break;
    cursor = candidate.cause;
  }
  expect(sqlState).toBe(expected.code);
  if (expected.table_name) expect(message).toContain(expected.table_name);
  if (expected.constraint_name)
    expect(message).toContain(expected.constraint_name);
}

async function expectSqlFailure(
  action: () => Promise<unknown>,
  expected: { code: string; table_name?: string; constraint_name?: string },
) {
  try {
    await action();
    throw new Error("Expected PostgreSQL to reject the statement.");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected PostgreSQL to reject the statement."
    )
      throw error;
    expectPostgresError(error, expected);
  }
}

test("restricted catalog identities and RLS enforce separate directory, data, and operator capabilities", async () => {
  const setupDbHandle = setupDb();
  const directoryDbHandle = await directoryDb();
  const dataDbHandle = await dataDb();
  const operatorDbHandle = await operatorDb();

  const [databaseIdentity] = (await setupDbHandle.execute(sql`
    SELECT current_database() AS database_name,
      session_user AS setup_session, current_user AS setup_current,
      actor.rolsuper OR actor.rolbypassrls AS setup_is_privileged
    FROM pg_roles actor WHERE actor.rolname = current_user
  `)) as unknown as Array<Record<string, unknown>>;
  expect(databaseIdentity).toMatchObject({
    database_name: "openbot_enterprise_r2_codex_20261009",
    setup_is_privileged: true,
  });
  expect(["ob_ent_directory", "ob_ent_data", "ob_ent_operator"]).not.toContain(
    databaseIdentity?.setup_current,
  );

  const [dataLoginIdentity] = (await dataDbHandle.execute(sql`
    SELECT session_user AS login_name
  `)) as unknown as Array<{ login_name: string }>;
  const dataLoginName = dataLoginIdentity?.login_name;
  expect(dataLoginName).toBeString();

  directlyGrantedDataLogin = dataLoginName;
  try {
    await setupDbHandle.execute(sql`
      GRANT SELECT ON TABLE enterprise_resources TO ${sql.identifier(dataLoginName!)}
    `);
    await expect(verifyDataDatabase(dataDbHandle)).rejects.toThrow(
      "DATABASE_CAPABILITY_MISMATCH",
    );
  } finally {
    await setupDbHandle.execute(sql`
      REVOKE SELECT ON TABLE enterprise_resources FROM ${sql.identifier(dataLoginName!)}
    `);
    directlyGrantedDataLogin = undefined;
  }
  expect(await verifyDataDatabase(dataDbHandle)).toBe(dataDbHandle);

  const [resourceOwner] = (await setupDbHandle.execute(sql`
    SELECT pg_get_userbyid(relation.relowner) AS owner_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'enterprise_resources'
  `)) as unknown as Array<{ owner_name: string }>;
  originalResourceOwner = resourceOwner?.owner_name;
  expect(originalResourceOwner).toBeString();
  temporarilyTransferredToDataLogin = dataLoginName;
  try {
    await setupDbHandle.execute(sql`
      ALTER TABLE enterprise_resources OWNER TO ${sql.identifier(dataLoginName!)}
    `);
    await expect(verifyDataDatabase(dataDbHandle)).rejects.toThrow(
      "DATABASE_CAPABILITY_MISMATCH",
    );
  } finally {
    await setupDbHandle.execute(sql`
      ALTER TABLE enterprise_resources OWNER TO ${sql.identifier(originalResourceOwner!)}
    `);
    temporarilyTransferredToDataLogin = undefined;
    originalResourceOwner = undefined;
  }
  expect(await verifyDataDatabase(dataDbHandle)).toBe(dataDbHandle);

  for (const [handle, capability] of [
    [directoryDbHandle, "ob_ent_directory"],
    [dataDbHandle, "ob_ent_data"],
    [operatorDbHandle, "ob_ent_operator"],
  ] as const) {
    const [role] = (await handle.execute(sql`
      SELECT current_user AS current_user, session_user AS session_user,
        role.rolsuper AS rolsuper, role.rolbypassrls AS rolbypassrls,
        role.rolcanlogin AS rolcanlogin,
        NOT EXISTS (
          SELECT 1 FROM pg_roles inherited
          WHERE inherited.rolname <> role.rolname
            AND pg_has_role(current_user, inherited.oid, 'MEMBER')
        ) AS no_capability_escalation
      FROM pg_roles role WHERE role.rolname = current_user
    `)) as unknown as Array<Record<string, unknown>>;
    expect(role).toMatchObject({
      current_user: capability,
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
      no_capability_escalation: true,
    });
    expect(role?.session_user).not.toBe(databaseIdentity?.setup_session);
  }

  await setupDbHandle.insert(users).values([
    { id: userA, email: `${userA}@example.invalid`, name: "Synthetic RLS A" },
    { id: userB, email: `${userB}@example.invalid`, name: "Synthetic RLS B" },
  ]);
  await setupDbHandle.insert(enterpriseTenants).values([
    { id: tenantA, name: "Synthetic RLS tenant A" },
    { id: tenantB, name: "Synthetic RLS tenant B" },
  ]);
  await setupDbHandle.insert(enterprisePrincipals).values([
    { id: principalA, userId: userA },
    { id: principalB, userId: userB },
  ]);
  await setupDbHandle.insert(enterpriseMemberships).values([
    { tenantId: tenantA, principalId: principalA, role: "member" },
    { tenantId: tenantA, principalId: principalB, role: "member" },
    { tenantId: tenantB, principalId: principalB, role: "member" },
  ]);
  await setupDbHandle.insert(enterpriseWorkspaces).values([
    { tenantId: tenantA, id: workspaceA, name: "Synthetic RLS workspace A" },
    { tenantId: tenantB, id: workspaceB, name: "Synthetic RLS workspace B" },
  ]);
  await setupDbHandle.insert(enterpriseResources).values([
    {
      tenantId: tenantA,
      id: resourceA,
      workspaceId: workspaceA,
      kind: "document",
      displayName: "A visible",
    },
    {
      tenantId: tenantB,
      id: resourceB,
      workspaceId: workspaceB,
      kind: "document",
      displayName: "B foreign",
    },
    {
      tenantId: tenantA,
      id: ungrantedResource,
      workspaceId: workspaceA,
      kind: "document",
      displayName: "A ungranted",
    },
  ]);
  await setupDbHandle.insert(enterpriseResourceGrants).values([
    {
      tenantId: tenantA,
      resourceId: resourceA,
      principalId: principalA,
      action: "read",
    },
    {
      tenantId: tenantA,
      resourceId: resourceA,
      principalId: principalB,
      action: "read",
    },
  ]);

  const directoryRows = await directoryDbHandle.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userA}, true)`);
    const principals = await tx.execute(sql`
      SELECT id FROM enterprise_principals ORDER BY id
    `);
    const memberships = await tx.execute(sql`
      SELECT tenant_id, principal_id
      FROM enterprise_memberships
      ORDER BY tenant_id, principal_id
    `);
    const tenants = await tx.execute(sql`
      SELECT id FROM enterprise_tenants ORDER BY id
    `);
    return { principals, memberships, tenants };
  });
  expect(directoryRows.principals).toEqual([{ id: principalA }]);
  expect(directoryRows.memberships).toEqual([
    { tenant_id: tenantA, principal_id: principalA },
  ]);
  expect(directoryRows.tenants).toEqual([{ id: tenantA }]);

  const withoutContext = await dataDbHandle.execute(sql`
    SELECT id FROM enterprise_resources WHERE tenant_id = ${tenantA}
  `);
  expect(withoutContext).toHaveLength(0);
  const grantsWithoutContext = await dataDbHandle.execute(sql`
    SELECT principal_id FROM enterprise_resource_grants
    WHERE tenant_id = ${tenantA} AND resource_id = ${resourceA}
  `);
  expect(grantsWithoutContext).toHaveLength(0);

  const validRead = await dataDbHandle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.tenant_id', ${tenantA}, true),
        set_config('app.principal_id', ${principalA}, true),
        set_config('app.user_id', ${userA}, true)
    `);
    return tx.execute(sql`
      SELECT id FROM enterprise_resources WHERE tenant_id = ${tenantA} AND id = ${resourceA}
    `);
  });
  expect(validRead).toHaveLength(1);
  const visibleGrants = await dataDbHandle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.tenant_id', ${tenantA}, true),
        set_config('app.principal_id', ${principalA}, true),
        set_config('app.user_id', ${userA}, true)
    `);
    return tx.execute(sql`
      SELECT principal_id FROM enterprise_resource_grants
      WHERE tenant_id = ${tenantA} AND resource_id = ${resourceA}
      ORDER BY principal_id
    `);
  });
  expect(visibleGrants).toEqual([{ principal_id: principalA }]);
  const foreignTenantRead = await dataDbHandle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.tenant_id', ${tenantA}, true),
        set_config('app.principal_id', ${principalA}, true),
        set_config('app.user_id', ${userA}, true)
    `);
    return tx.execute(sql`
      SELECT id FROM enterprise_resources WHERE tenant_id = ${tenantB} AND id = ${resourceB}
    `);
  });
  expect(foreignTenantRead).toHaveLength(0);

  await expectSqlFailure(
    () =>
      dataDbHandle.execute(
        sql`UPDATE enterprise_resources SET display_name = 'blocked' WHERE tenant_id = ${tenantA} AND id = ${resourceA}`,
      ),
    { code: "42501", table_name: "enterprise_resources" },
  );
  await expectSqlFailure(
    () => dataDbHandle.execute(sql`TRUNCATE enterprise_resources`),
    { code: "42501", table_name: "enterprise_resources" },
  );
  await expectSqlFailure(
    () =>
      dataDbHandle.execute(
        sql`INSERT INTO enterprise_memberships (tenant_id, principal_id, role) VALUES (${tenantA}, ${principalB}, 'member')`,
      ),
    { code: "42501", table_name: "enterprise_memberships" },
  );
  await expectSqlFailure(
    () =>
      dataDbHandle.execute(
        sql`INSERT INTO enterprise_resource_grants (tenant_id, resource_id, principal_id, action) VALUES (${tenantA}, ${resourceA}, ${principalA}, 'read')`,
      ),
    { code: "42501", table_name: "enterprise_resource_grants" },
  );

  await operatorDbHandle.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.tenant_id', ${tenantA}, true),
        set_config('app.operator_principal_id', ${principalA}, true),
        set_config('app.resource_id', ${ungrantedResource}, true)
    `);
    await tx.execute(sql`
      INSERT INTO enterprise_resource_grants (tenant_id, resource_id, principal_id, action)
      VALUES (${tenantA}, ${ungrantedResource}, ${principalA}, 'read')
    `);
    const changed = await tx.execute(sql`
      UPDATE enterprise_memberships SET epoch = epoch + 1
      WHERE tenant_id = ${tenantA} AND principal_id = ${principalA}
      RETURNING epoch
    `);
    expect(changed).toHaveLength(1);
  });
  const operatorGrant = await setupDbHandle
    .select({ principalId: enterpriseResourceGrants.principalId })
    .from(enterpriseResourceGrants)
    .where(
      sql`${enterpriseResourceGrants.tenantId} = ${tenantA} and ${enterpriseResourceGrants.resourceId} = ${ungrantedResource}`,
    );
  expect(operatorGrant).toEqual([{ principalId: principalA }]);

  await expectSqlFailure(
    () =>
      operatorDbHandle.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`,
        );
        await tx.execute(sql`
          INSERT INTO enterprise_resources (tenant_id, id, workspace_id, kind, display_name)
          VALUES (${tenantB}, ${`${prefix}-bad-operator-tenant`}, ${workspaceB}, 'document', 'Rejected tenant scope')
        `);
      }),
    { code: "42501", table_name: "enterprise_resources" },
  );
  await expectSqlFailure(
    () =>
      operatorDbHandle.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`,
        );
        await tx.execute(sql`
        INSERT INTO enterprise_resources (tenant_id, id, workspace_id, kind, display_name)
        VALUES (${tenantA}, ${`${prefix}-bad-cross-tenant-fk`}, ${workspaceB}, 'document', 'Rejected cross tenant')
      `);
      }),
    {
      code: "23503",
      table_name: "enterprise_resources",
      constraint_name:
        "enterprise_resources_tenant_id_workspace_id_enterprise_workspac",
    },
  );
});
