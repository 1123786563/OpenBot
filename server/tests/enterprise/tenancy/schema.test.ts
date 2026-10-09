import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
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

/*
 * Enterprise tenancy schema, per plan 02 §5 T1-A.
 *
 * The tables live in their own files (`enterprise-tenancy.ts`, `enterprise-authz.ts`) and must be
 * reachable through the schema barrel, because both the Drizzle adapter and the generated
 * migrations resolve them from there. Composite keys, indexes and check constraints are asserted
 * in the exact combinations the plan lists; migration generation itself is deferred to T1-B's
 * isolated migration entry, never `db:generate`.
 */
describe("enterprise tenancy schema", () => {
  test("enterprise tenancy tables are exported", () => {
    expect(getTableName(enterpriseTenants)).toBe("enterprise_tenants");
    expect(getTableName(enterpriseWorkspaces)).toBe("enterprise_workspaces");
  });

  test("defines all eight enterprise tables", () => {
    expect(
      [
        enterpriseTenants,
        enterprisePrincipals,
        enterpriseMemberships,
        enterpriseWorkspaces,
        enterpriseResources,
        enterpriseResourceGrants,
        enterpriseSecurityEvents,
        enterpriseIdentityEvents,
      ].map(getTableName),
    ).toEqual([
      "enterprise_tenants",
      "enterprise_principals",
      "enterprise_memberships",
      "enterprise_workspaces",
      "enterprise_resources",
      "enterprise_resource_grants",
      "enterprise_security_events",
      "enterprise_identity_events",
    ]);
  });

  test("binds exactly one principal to each existing user, without touching users", () => {
    const config = getTableConfig(enterprisePrincipals);

    expect(
      config.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
      })),
    ).toEqual([
      { name: "id", sqlType: "text", notNull: true, hasDefault: false },
      { name: "user_id", sqlType: "text", notNull: true, hasDefault: false },
      {
        name: "status",
        sqlType: "text",
        notNull: true,
        hasDefault: true,
      },
      {
        name: "created_at",
        sqlType: "timestamp with time zone",
        notNull: true,
        hasDefault: true,
      },
    ]);

    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
      })),
    ).toEqual([
      {
        name: "enterprise_principal_user",
        columns: ["user_id"],
        unique: true,
      },
    ]);

    expect(config.checks.map((check) => check.name)).toEqual([
      "enterprise_principal_status",
    ]);

    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
          targetColumns: reference.foreignColumns.map((column) => column.name),
        };
      }),
    ).toEqual([
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
      },
    ]);

    /*
     * Tenancy is expressed through memberships, not by widening the global identity record:
     * `users` keeps no tenant column of any kind.
     */
    expect(
      getTableConfig(users)
        .columns.map((column) => column.name)
        .filter((name) => name.includes("tenant")),
    ).toEqual([]);
  });

  test("keys memberships by tenant and principal with a reverse lookup index", () => {
    const config = getTableConfig(enterpriseMemberships);

    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["tenant_id", "principal_id"]);

    expect(config.checks.map((check) => check.name)).toEqual([
      "enterprise_member_role",
      "enterprise_member_status",
      "enterprise_member_epoch",
    ]);

    const epoch = config.columns.find((column) => column.name === "epoch");
    expect(epoch?.notNull).toBe(true);
    expect(epoch?.hasDefault).toBe(true);

    /*
     * The primary key serves tenant-first scans; suspension and revocation lookups start from the
     * principal ("what does this person still hold"), so the plan adds a (principal_id, tenant_id)
     * index rather than duplicating the key.
     */
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
      })),
    ).toEqual([
      {
        name: "enterprise_memberships_principal_tenant_idx",
        columns: ["principal_id", "tenant_id"],
      },
    ]);

    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
        };
      }),
    ).toEqual([
      { sourceColumns: ["tenant_id"], targetTable: "enterprise_tenants" },
      { sourceColumns: ["principal_id"], targetTable: "enterprise_principals" },
    ]);
  });

  test("keys workspaces inside their tenant", () => {
    const config = getTableConfig(enterpriseWorkspaces);

    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["tenant_id", "id"]);

    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
        };
      }),
    ).toEqual([
      { sourceColumns: ["tenant_id"], targetTable: "enterprise_tenants" },
    ]);
  });

  test("keys resources by tenant and pins them to a same-tenant workspace", () => {
    const config = getTableConfig(enterpriseResources);

    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["tenant_id", "id"]);

    expect(config.checks.map((check) => check.name)).toEqual([
      "enterprise_resource_status",
      "enterprise_resource_versions",
    ]);

    /*
     * The workspace reference is composite: a resource cannot point across a tenant boundary at
     * another tenant's workspace, because (tenant_id, workspace_id) must exist as a workspace key.
     */
    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
          targetColumns: reference.foreignColumns.map((column) => column.name),
        };
      }),
    ).toEqual([
      {
        sourceColumns: ["tenant_id", "workspace_id"],
        targetTable: "enterprise_workspaces",
        targetColumns: ["tenant_id", "id"],
      },
    ]);
  });

  test("keys grants by the exact tenant-scoped tuple", () => {
    const config = getTableConfig(enterpriseResourceGrants);

    expect(
      config.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
      })),
    ).toEqual([
      { name: "tenant_id", notNull: true },
      { name: "resource_id", notNull: true },
      { name: "principal_id", notNull: true },
      { name: "action", notNull: true },
    ]);

    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["tenant_id", "resource_id", "principal_id", "action"]);

    expect(config.checks.map((check) => check.name)).toEqual([
      "enterprise_grant_action",
    ]);

    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
          targetColumns: reference.foreignColumns.map((column) => column.name),
        };
      }),
    ).toEqual([
      {
        sourceColumns: ["tenant_id", "resource_id"],
        targetTable: "enterprise_resources",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "principal_id"],
        targetTable: "enterprise_memberships",
        targetColumns: ["tenant_id", "principal_id"],
      },
    ]);
  });

  test("logs security events per tenant with a time-ordered index", () => {
    const config = getTableConfig(enterpriseSecurityEvents);

    expect(
      config.primaryKeys.flatMap((key) =>
        key.columns.map((column) => column.name),
      ),
    ).toEqual(["tenant_id", "id"]);

    expect(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          sourceColumns: reference.columns.map((column) => column.name),
          targetTable: getTableName(reference.foreignTable),
        };
      }),
    ).toEqual([
      { sourceColumns: ["tenant_id"], targetTable: "enterprise_tenants" },
    ]);

    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
      })),
    ).toEqual([
      {
        name: "enterprise_security_events_tenant_created_idx",
        columns: ["tenant_id", "created_at", "id"],
      },
    ]);

    const details = config.columns.find((column) => column.name === "details");
    /*
     * NOT drizzle's own jsonb: it serialises, and so does Bun's driver, and the event body lands
     * as a double-encoded string (see ./json.ts). Same custom column type as users.preferences.
     */
    expect(details?.columnType).toBe("PgCustomColumn");
    expect(details?.getSQLType()).toBe("jsonb");
    expect(details?.notNull).toBe(true);
  });

  test("keeps identity events global, outside any tenant", () => {
    const config = getTableConfig(enterpriseIdentityEvents);

    /*
     * The global identity audit domain is deliberately not tenant-scoped: no placeholder tenant
     * column, and the primary key is the event id alone.
     */
    expect(
      config.columns
        .map((column) => column.name)
        .filter((name) => name.includes("tenant")),
    ).toEqual([]);

    const id = config.columns.find((column) => column.name === "id");
    expect(id?.primary).toBe(true);

    const details = config.columns.find((column) => column.name === "details");
    expect(details?.columnType).toBe("PgCustomColumn");
    expect(details?.getSQLType()).toBe("jsonb");
  });
});
