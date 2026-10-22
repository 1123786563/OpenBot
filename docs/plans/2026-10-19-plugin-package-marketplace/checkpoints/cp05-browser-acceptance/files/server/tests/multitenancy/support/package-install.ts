/**
 * PKG02 (Issue #461) plugin-package install fixture support.
 *
 * Builds on the MT008 resource-policy fixture (two companies, three teams,
 * real provisioning, real restricted roles) and adds exactly what the package
 * install suites need:
 *
 *   - the MT031 + PKG02 multitenancy tasks applied through the real
 *     `migrate-test.ts` three-step recipe (dry-run → manifest → apply);
 *   - trusted PlatformScope issuance and trusted CompanyAdminContext issuance
 *     through the REAL resolver/authorizer (no test double minted a context);
 *   - package service wiring over the REAL restricted operator/data channels;
 *   - two disclosed arrangement stand-ins: promoting a member to `tenant_admin`
 *     and suspending a company membership over the dedicated setup (superuser)
 *     connection. The decision paths never use them — every plan/apply runs
 *     through the restricted roles under real RLS.
 *
 * Nothing here mocks authorization: admin contexts come from
 * `createCompanyAdminAuthorizer`, scopes from `createScopeResolver`, and the
 * package service revalidates both inside every mutation transaction.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  runMigrateTest,
} from "../../../scripts/multitenancy/migrate-test";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import type {
  PackageMutationStore,
  PackageReadStore,
} from "../../../src/enterprise/plugin-packages/contracts";
import { createPackageMutationStore } from "../../../src/enterprise/plugin-packages/mutation-context";
import { createPackageReadStore } from "../../../src/enterprise/plugin-packages/store";
import type {
  DataDatabase,
  OperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
  type WorkspaceAdminService,
} from "../../../src/enterprise/tenancy/workspace-admin";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

export type CompanyKey = "company-a" | "company-b";

export interface PackageTaskOutcomes {
  readonly mt004: RunOutcome;
  readonly mt008: RunOutcome;
  readonly mt031: RunOutcome;
  readonly pkg02: RunOutcome;
}

/**
 * Applies MT004 (team memberships, required by the isolation fixture), MT008
 * (resource visibility, required by the isolation fixture),
 * MT031 (connector authority the package links reference) and PKG02 in order
 * through the real migration tool. `up-to-date` is a legitimate rerun;
 * `refused`/`failed` throws with the tool's own reason.
 */
export async function applyPackageTasks(): Promise<PackageTaskOutcomes> {
  const environment = { TEST_DATABASE_URL: enterpriseTestDatabaseUrlFrom() };
  const outcomes: RunOutcome[] = [];
  for (const taskId of ["MT004", "MT008", "MT031", "PKG02"]) {
    const dryRun = await runMigrateTest(["migrate", taskId], {
      environment,
      out: () => {},
    });
    if (dryRun.kind === "refused") {
      throw new Error(`${taskId} dry-run refused: ${dryRun.reason}`);
    }
    if (dryRun.kind !== "dry-run") {
      throw new Error(`${taskId} dry-run did not produce a plan`);
    }
    const manifestPath = `/tmp/${taskId.toLowerCase()}-manifest-${randomUUID()}.json`;
    await Bun.write(
      manifestPath,
      `${JSON.stringify(manifestFor(buildPlan(taskId)), null, 2)}\n`,
    );
    try {
      const applied = await runMigrateTest(
        ["migrate", taskId, "--apply", "--manifest", manifestPath],
        { environment, out: () => {} },
      );
      if (applied.kind !== "applied" && applied.kind !== "up-to-date") {
        throw new Error(
          `${taskId} apply did not land: ${JSON.stringify(applied).slice(0, 300)}`,
        );
      }
      outcomes.push(applied);
    } finally {
      await rm(manifestPath, { force: true });
    }
  }
  return {
    mt004: outcomes[0],
    mt008: outcomes[1],
    mt031: outcomes[2],
    pkg02: outcomes[3],
  };
}

export interface PackageInstallFixture {
  readonly base: ResourcePolicyFixture;
  /** Dedicated superuser setup connection: arrangement stand-ins and probes only. */
  readonly setup: Database;
  readonly operator: OperatorDatabase;
  readonly data: DataDatabase;
  readonly workspaceAdmin: WorkspaceAdminService;
  readonly readStore: PackageReadStore;
  readonly mutation: PackageMutationStore;
  /** Issues a trusted PlatformScope for one identity in one team. */
  scopeFor(identity: FixtureIdentity, teamKey: TeamKey): Promise<PlatformScope>;
  /** Issues a trusted CompanyAdminContext through the real MT006 authorizer. */
  adminContextOf(
    identity: FixtureIdentity,
    companyKey: CompanyKey,
  ): Promise<CompanyAdminContext>;
  /**
   * The same real authorizer for an arbitrary signed-in actor (a platform
   * administrator with no company membership, for the refusal case).
   */
  adminContextForActor(
    actorId: string,
    companyKey: CompanyKey,
  ): Promise<CompanyAdminContext>;
  /** Adds an active team membership through the real MT006 admin service. */
  addTeamMember(
    adminIdentity: FixtureIdentity,
    companyKey: CompanyKey,
    memberIdentity: FixtureIdentity,
    teamKey: TeamKey,
  ): Promise<void>;
  /** Disclosed arrangement stand-in: grants the `tenant_admin` company role. */
  promoteToCompanyAdmin(
    identity: FixtureIdentity,
    companyKey: CompanyKey,
  ): Promise<void>;
  /** Disclosed arrangement stand-in: suspends a company membership (+epoch). */
  setCompanyMembershipStatus(
    identity: FixtureIdentity,
    companyKey: CompanyKey,
    status: "active" | "suspended",
  ): Promise<void>;
  principalOf(identity: FixtureIdentity, companyKey: CompanyKey): string;
  tenantOf(companyKey: CompanyKey): string;
  teamOf(companyKey: CompanyKey, teamKey: TeamKey): string;
  /** Structural privilege/RLS probes (superuser, read-only). */
  probes: {
    tableExists(table: string): Promise<boolean>;
    rlsFlags(
      table: string,
    ): Promise<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    hasPrivilege(
      table: string,
      role: string,
      privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
    ): Promise<boolean>;
    columnsOf(table: string): Promise<string[]>;
    indexColumns(indexName: string): Promise<string[]>;
  };
  dispose(): Promise<void>;
}

export async function createPackageInstallFixture(): Promise<PackageInstallFixture> {
  const base = await createResourcePolicyFixture();
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });
  const workspaceAdmin = createWorkspaceAdminService(base.operator);

  // Real MT006 authorizer over the verified directory channel.
  const adminSessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string }
  >();
  const authorizer = createCompanyAdminAuthorizer(base.directory, {
    authenticate: async (request) => {
      const session = adminSessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
  });

  const tenantOf = (companyKey: CompanyKey) => base.isolation.ids[companyKey];
  const TEAM_COMPANY: Record<TeamKey, CompanyKey> = {
    "team-a1": "company-a",
    "team-a2": "company-a",
    "team-b1": "company-b",
  };
  const teamOf = (companyKey: CompanyKey, teamKey: TeamKey) => {
    if (TEAM_COMPANY[teamKey] !== companyKey) {
      throw new Error(`TEAM_COMPANY_MISMATCH:${teamKey}:${companyKey}`);
    }
    return base.isolation.ids[teamKey];
  };

  const principalOf = (
    identity: FixtureIdentity,
    companyKey: CompanyKey,
  ): string => {
    for (const company of base.isolation.identities[identity].companies) {
      if (company.companyKey === companyKey) return company.principalId;
    }
    throw new Error(`PRINCIPAL_MISSING:${identity}:${companyKey}`);
  };

  const readStore = createPackageReadStore(base.data);
  const mutation = createPackageMutationStore(base.operator);

  const fixture: PackageInstallFixture = {
    base,
    setup,
    operator: base.operator,
    data: base.data,
    workspaceAdmin,
    readStore,
    mutation,

    async scopeFor(identity, teamKey) {
      const fact = base.isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${identity}`);
      }
      // The scope resolver authorizes against live rows; the caller is
      // responsible for the membership existing (addTeamMember first).
      const companyKey = TEAM_COMPANY[teamKey];
      return base.scopeFor(identity, {
        tenantId: tenantOf(companyKey),
        workspaceId: base.isolation.ids[teamKey],
      });
    },

    async adminContextOf(identity, companyKey) {
      const fact = base.isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${identity}`);
      }
      return fixture.adminContextForActor(fact.userId, companyKey);
    },

    async adminContextForActor(actorId, companyKey) {
      const request = new Request("https://pkg02.invalid/admin", {
        headers: { "x-openbot-tenant": tenantOf(companyKey) },
      });
      adminSessions.set(request, {
        userId: actorId,
        tenantId: tenantOf(companyKey),
      });
      return authorizer.resolveAdminContext(request);
    },

    async addTeamMember(adminIdentity, companyKey, memberIdentity, teamKey) {
      const admin = await fixture.adminContextOf(adminIdentity, companyKey);
      await workspaceAdmin.addTeamMember(admin, {
        workspaceId: teamOf(companyKey, teamKey),
        principalId: principalOf(memberIdentity, companyKey),
      });
    },

    async promoteToCompanyAdmin(identity, companyKey) {
      const tenantId = tenantOf(companyKey);
      const principalId = principalOf(identity, companyKey);
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "membership",
            tenantId,
            principalId,
          ])}, 0))`,
        );
        await tx.execute(sql`
          update enterprise_memberships
          set role = 'tenant_admin'
          where tenant_id = ${tenantId} and principal_id = ${principalId}
        `);
      });
    },

    async setCompanyMembershipStatus(identity, companyKey, status) {
      const tenantId = tenantOf(companyKey);
      const principalId = principalOf(identity, companyKey);
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "membership",
            tenantId,
            principalId,
          ])}, 0))`,
        );
        await tx.execute(sql`
          update enterprise_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_memberships
                     where tenant_id = ${tenantId}
                       and principal_id = ${principalId})
          where tenant_id = ${tenantId} and principal_id = ${principalId}
        `);
      });
    },

    principalOf,
    tenantOf,
    teamOf,

    probes: {
      async tableExists(table) {
        const rows = (await setup.$client.unsafe(
          `select 1 from pg_class
           where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        )) as Array<Record<string, unknown>>;
        return rows.length > 0;
      },
      async rlsFlags(table) {
        const rows = (await setup.$client.unsafe(
          `select relrowsecurity, relforcerowsecurity from pg_class
           where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        )) as Array<Record<string, unknown>>;
        const row = rows[0];
        if (!row) throw new Error(`TABLE_MISSING:${table}`);
        return {
          relrowsecurity: Boolean(row.relrowsecurity),
          relforcerowsecurity: Boolean(row.relforcerowsecurity),
        };
      },
      async hasPrivilege(table, role, privilege) {
        const rows = (await setup.$client.unsafe(
          "select has_table_privilege($1, $2, $3) as allowed",
          [role, table, privilege],
        )) as Array<Record<string, unknown>>;
        return Boolean(rows[0]?.allowed);
      },
      async columnsOf(table) {
        const rows = (await setup.$client.unsafe(
          `select column_name from information_schema.columns
           where table_schema = 'public' and table_name = $1
           order by ordinal_position`,
          [table],
        )) as Array<Record<string, unknown>>;
        return rows.map((row) => String(row.column_name));
      },
      async indexColumns(indexName) {
        const rows = (await setup.$client.unsafe(
          `select a.attname
           from pg_index i
           join pg_class t on t.oid = i.indexrelid
           join unnest(i.indkey) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
           where t.relname = $1
           order by k.ord`,
          [indexName],
        )) as Array<Record<string, unknown>>;
        return rows.map((row) => String(row.attname));
      },
    },

    async dispose() {
      const tenants = [tenantOf("company-a"), tenantOf("company-b")];
      // Package rows cascade from the tenant; this best-effort delete keeps a
      // failed base dispose from leaving them behind under a reused database.
      for (const table of [
        "enterprise_package_changes",
        "enterprise_package_resource_links",
        "enterprise_package_plans",
        "enterprise_package_revisions",
        "enterprise_package_installs",
      ]) {
        await setup.$client
          .unsafe(`delete from ${table} where tenant_id = any($1)`, [tenants])
          .catch(() => {});
      }
      await setup.$client.close().catch(() => {});
      await base.dispose();
    },
  };
  return fixture;
}

/** Resolves to the first SQLSTATE in the error chain ("" when it did not throw). */
export async function thrownSqlState(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      const code = (e as Error & { code?: unknown }).code;
      const errno = (e as Error & { errno?: unknown }).errno;
      if (typeof code === "string" && /^\d{5}$/.test(code)) return code;
      if (typeof errno === "string" && /^\d{5}$/.test(errno)) return errno;
    }
    return "UNKNOWN";
  }
}

/** Error message + SQLSTATE chain (for CHECK-name assertions). */
export async function thrownMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const parts: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      parts.push(e.message);
      const code = (e as Error & { code?: unknown }).code;
      const errno = (e as Error & { errno?: unknown }).errno;
      if (typeof code === "string") parts.push(code);
      if (typeof errno === "string") parts.push(errno);
    }
    return parts.join(" | ");
  }
}
