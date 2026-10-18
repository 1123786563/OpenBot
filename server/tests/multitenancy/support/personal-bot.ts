/**
 * Personal-bot fixture (MT059 / Issue #102).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows for
 * each planned (company, team, principal), and hands the real
 * `createPersonalBotService`, the real MT016 `createBotOwnershipService`
 * (consumed read-only for the AC4 team-list assertions) and the real MT077
 * template-install reader/writer (consumed read-only for the AC3 template
 * facts) their verified channels. Trusted scopes come from the REAL
 * `createScopeResolver` over the directory channel — the same eligibility
 * gate production requests pass. Nothing here mocks the authorization path.
 *
 * The two MT059 tables (`enterprise_personal_bots`,
 * `enterprise_personal_bot_field_ownership`) are touched through raw SQL
 * under the restricted roles (MT009 precedent: the schema file belongs to
 * the producing ticket; the fixture reads facts through the database).
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import { createBotOwnershipService } from "../../../src/enterprise/tenancy/bots-ownership";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createPersonalBotService,
  type PersonalBotService,
} from "../../../src/enterprise/tenancy/personal-bot";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import {
  createTemplateInstallReader,
  createTemplateInstallWriter,
  type TemplateInstallReader,
  type TemplateInstallWriter,
} from "../../../src/enterprise/tenancy/routing-policy";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
} from "../../../src/enterprise/tenancy/workspace-admin";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT059 suite shares. */
export type PersonalBotIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "a2-member"
  | "b1-member"
  | "multi-company"
  | "company-admin";

export type RestrictedCall = Readonly<{
  role: "data" | "operator" | "directory";
  currentUser: string;
}>;

export interface PersonalBotFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly service: PersonalBotService;
  /** MT016 team-bot surface, consumed read-only for the AC4 assertions. */
  readonly teamBots: ReturnType<typeof createBotOwnershipService>;
  /** MT077 template-install surfaces, consumed read-only/write-by-fixture. */
  readonly installs: {
    readonly reader: TemplateInstallReader;
    readonly writer: TemplateInstallWriter;
  };
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: PersonalBotIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<import("../../../src/enterprise/contracts").PlatformScope>;
  /**
   * RLS probe: personal-bot rows visible to the data role under one tenant
   * AND one principal (the restrictive self-read policy is part of the probe).
   */
  readPersonalBotRowsAsData(
    tenantId: string,
    principalId: string,
  ): Promise<readonly Readonly<{ agentId: string; workspaceId: string }>[]>;
  /**
   * RLS probe: field-ownership rows visible to the data role under one
   * tenant AND one principal, with the explicit managed_by list.
   */
  readFieldOwnershipRowsAsData(
    tenantId: string,
    principalId: string,
  ): Promise<readonly Readonly<{ fieldName: string; managedBy: string }>[]>;
  /** Scaffold probe via the setup channel (superuser, no RLS): full counts. */
  rawCounts(): Promise<{
    personalBots: number;
    fieldOwnership: number;
    teamOwnershipRows: number;
    resourceRegistryRows: number;
  }>;
  restrictedCalls(): readonly RestrictedCall[];
  /**
   * Real MT006 revocation: suspend a company membership through the real
   * `provision.suspendMembership` on the operator channel (support/fixture.ts
   * precedent). The suspension writes a real security event and increments
   * the membership epoch, so already-issued scopes carry a stale epoch.
   */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  /**
   * Real MT007 restore through the real company-admin surface (a test double
   * can never mint the trusted context). Status flips back to active AND the
   * epoch increments — a pre-suspension scope stays rejected.
   */
  reinstateCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT059 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT059 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC2 person: one human,
 * two companies, two independent private bots. `company-admin` holds a real
 * company membership WITHOUT any team (management identity never implies
 * content access).
 */
const HUMAN_PLAN: readonly {
  identity: PersonalBotIdentity;
  memberships: readonly {
    companyKey: "company-a" | "company-b";
    role: "member" | "tenant_admin";
    teams: readonly string[];
  }[];
}[] = [
  {
    identity: "a1-member",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    identity: "a1-other",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    identity: "a2-member",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a2"] },
    ],
  },
  {
    // Same person in TWO teams of the SAME company: the scope's team pins
    // the triple — a team-a1 private bot is invisible from a team-a2 scope
    // even for its owner (acceptance AC2 cross-team leg).
    identity: "a1a2-member",
    memberships: [
      {
        companyKey: "company-a",
        role: "member",
        teams: ["team-a1", "team-a2"],
      },
    ],
  },
  {
    identity: "b1-member",
    memberships: [
      { companyKey: "company-b", role: "member", teams: ["team-b1"] },
    ],
  },
  {
    identity: "multi-company",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
      { companyKey: "company-b", role: "member", teams: ["team-b1"] },
    ],
  },
  {
    identity: "company-admin",
    memberships: [{ companyKey: "company-a", role: "tenant_admin", teams: [] }],
  },
];

export async function createPersonalBotFixture(): Promise<PersonalBotFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt059-${randomUUID().slice(0, 8)}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids: Record<string, string> = {};
  for (const company of PLANNED_COMPANIES) {
    ids[company.companyKey] = id(company.companyKey);
    for (const team of company.teams) ids[team.teamKey] = id(team.teamKey);
    ids[`provision-${company.companyKey}`] = id(
      `provision-${company.companyKey}`,
    );
  }
  for (const planned of HUMAN_PLAN) {
    ids[`user-${planned.identity}`] = id(`user-${planned.identity}`);
    ids[`principal-${planned.identity}`] = id(`principal-${planned.identity}`);
  }
  const principalOf = (identity: PersonalBotIdentity) =>
    ids[`principal-${identity}`];
  const userOf = (identity: PersonalBotIdentity) => ids[`user-${identity}`];

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  const restricted: RestrictedCall[] = [];
  const recordRole = async (
    connection: Awaited<ReturnType<typeof createDatabase>>,
    role: RestrictedCall["role"],
  ) => {
    const result = (await connection.execute(
      sql`select current_user as current_user`,
    )) as unknown;
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? []);
    const first = (rows as Readonly<{ current_user?: unknown }>[])[0];
    restricted.push({
      role,
      currentUser:
        typeof first?.current_user === "string" ? first.current_user : "",
    });
  };

  const dispose = async (created: boolean) => {
    const failures: unknown[] = [];
    if (created) {
      try {
        // Children first (field ownership → personal bots), then the tenancy
        // scaffold, then the MT077 install rows this fixture created.
        await setupDatabase.execute(
          sql`delete from enterprise_personal_bot_field_ownership where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_personal_bots where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_template_installs where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_ownership where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(enterpriseWorkspaces)
          .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseMemberships)
          .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseTenants)
          .where(like(enterpriseTenants.id, `${prefix}%`));
        await setupDatabase
          .delete(enterprisePrincipals)
          .where(like(enterprisePrincipals.id, `${prefix}%`));
        await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const closeable of closeables.reverse()) {
      try {
        await closeable.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Personal bot fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding (same order as support/fixture.ts): users,
    // then principals bound to them — the provisioning factory refuses
    // unbound principals.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT059 ${planned.identity}`,
      })),
    );
    await setupDatabase.insert(enterprisePrincipals).values(
      HUMAN_PLAN.map((planned) => ({
        id: principalOf(planned.identity),
        userId: userOf(planned.identity),
      })),
    );

    const directory = (await verifyDirectoryDatabase(
      createDatabase(directoryUrl, { max: 1 }),
    )) as DirectoryDatabase;
    const operator = (await verifyOperatorDatabase(
      createDatabase(operatorUrl, { max: 1 }),
    )) as OperatorDatabase;
    const data = (await verifyDataDatabase(
      createDatabase(dataUrl, { max: 1 }),
    )) as DataDatabase;
    closeables.push(directory.$client, operator.$client, data.$client);

    // Real provisioning path: one provisionDeployment call per (company,
    // team). The company admin joins only the company's FIRST provisioning
    // call as tenant_admin and materializes no workspace membership.
    const operatorPrincipalFor = (companyKey: string) =>
      companyKey === "company-a"
        ? principalOf("company-admin")
        : principalOf("b1-member");
    for (const company of PLANNED_COMPANIES) {
      for (const team of company.teams) {
        const isFirstTeamOfCompany =
          company.teams.findIndex(
            (candidate) => candidate.teamKey === team.teamKey,
          ) === 0;
        const members = HUMAN_PLAN.flatMap((planned) =>
          planned.memberships
            .filter(
              (membership) =>
                membership.companyKey === company.companyKey &&
                (membership.teams.includes(team.teamKey) ||
                  (planned.identity === "company-admin" &&
                    isFirstTeamOfCompany)),
            )
            .map((membership) => ({
              principalId: principalOf(planned.identity),
              userId: userOf(planned.identity),
              role: membership.role,
            })),
        );
        await provisionDeployment(operator, {
          operationId: id(`provision-${company.companyKey}-${team.teamKey}`),
          operator: operatorPrincipalFor(company.companyKey),
          tenant: { id: ids[company.companyKey], name: company.companyName },
          workspace: { id: ids[team.teamKey], name: team.teamName },
          members,
        });
      }
    }

    // MT005 precedent: materialize each planned team membership as a real
    // workspace-membership row through the restricted operator role
    // (RLS-checked). Company-admin is deliberately absent.
    const materializeTeamMembership = async (
      tenantId: string,
      workspaceId: string,
      principalId: string,
    ) => {
      await recordRole(operator, "operator");
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${principalOf("company-admin")}, true)`,
        );
        await tx.execute(
          sql`insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values (${tenantId}, ${workspaceId}, ${principalId})`,
        );
      });
    };
    for (const planned of HUMAN_PLAN) {
      for (const membership of planned.memberships) {
        for (const teamKey of membership.teams) {
          await materializeTeamMembership(
            ids[membership.companyKey],
            ids[teamKey],
            principalOf(planned.identity),
          );
        }
      }
    }

    // The real request path: session seam → trusted scope. authenticate maps
    // the fixture identity to its real user id; selectors come from the same
    // headers production reads.
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt059-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    let disposed = false;
    const fixture: PersonalBotFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createPersonalBotService({ data, operator }),
      teamBots: createBotOwnershipService({ data, operator }),
      installs: {
        reader: createTemplateInstallReader(data),
        writer: createTemplateInstallWriter(operator),
      },

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt059-fixture.invalid/scope", {
          headers: {
            "x-mt059-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async readPersonalBotRowsAsData(tenantId, principalId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.principal_id', ${principalId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select agent_id, workspace_id from enterprise_personal_bots order by agent_id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{ agent_id: string; workspace_id: string }>[]
          ).map((row) =>
            Object.freeze({
              agentId: row.agent_id,
              workspaceId: row.workspace_id,
            }),
          );
        });
      },

      async readFieldOwnershipRowsAsData(tenantId, principalId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.principal_id', ${principalId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select field_name, managed_by from enterprise_personal_bot_field_ownership order by field_name asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{ field_name: string; managed_by: string }>[]
          ).map((row) =>
            Object.freeze({
              fieldName: row.field_name,
              managedBy: row.managed_by,
            }),
          );
        });
      },

      async rawCounts() {
        const countOf = async (table: string) => {
          const value = (await setupDatabase.execute(
            sql.raw(
              `select count(*)::int as count from ${table} where tenant_id like '${prefix}%'`,
            ),
          )) as unknown;
          const list = Array.isArray(value)
            ? value
            : ((value as { rows?: unknown[] })?.rows ?? []);
          return Number(
            (list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0,
          );
        };
        const registry = (await setupDatabase.execute(
          sql`select count(*)::int as count from enterprise_resources where tenant_id like ${`${prefix}%`}`,
        )) as unknown;
        const registryList = Array.isArray(registry)
          ? registry
          : ((registry as { rows?: unknown[] })?.rows ?? []);
        return {
          personalBots: await countOf("enterprise_personal_bots"),
          fieldOwnership: await countOf(
            "enterprise_personal_bot_field_ownership",
          ),
          teamOwnershipRows: await countOf("enterprise_bot_ownership"),
          resourceRegistryRows: Number(
            (registryList as Readonly<{ count?: unknown }>[])[0]?.count ?? 0,
          ),
        };
      },

      restrictedCalls() {
        return [...restricted];
      },

      async suspendCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        // Real MT006 revocation path: security event + epoch bump happen for
        // real on the restricted operator role; the suspended principal's
        // already-issued scopes fail in-transaction revalidation.
        return suspendMembership(operator, {
          operationId: id(`suspend-${principalId}`),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async reinstateCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        // Real MT007 restore path: the company-admin is a real tenant_admin;
        // the authorizer re-verifies that fact against the directory before
        // minting the trusted context.
        const sessions = new WeakMap<Request, { userId?: string }>();
        const authorizer = createCompanyAdminAuthorizer(directory, {
          authenticate: async (request) => {
            const session = sessions.get(request);
            if (!session?.userId) return null;
            return { actorId: session.userId, entrypoint: "web" };
          },
          selectTenant: (request) => request.headers.get("x-openbot-tenant"),
        });
        const request = new Request("https://mt059.invalid/admin-context", {
          headers: { "x-openbot-tenant": tenantId },
        });
        sessions.set(request, { userId: userOf("company-admin") });
        const context = await authorizer.resolveAdminContext(request);
        const admin = createWorkspaceAdminService(operator);
        return admin.restoreCompanyMember(context, { principalId });
      },

      async dispose() {
        disposed = true;
        await dispose(true);
      },
    };
    return fixture;
  } catch (error) {
    const cleanupFailures: unknown[] = [error];
    try {
      await dispose(false);
    } catch (disposeError) {
      cleanupFailures.push(disposeError);
    }
    throw new AggregateError(
      cleanupFailures,
      "Personal bot fixture creation failed.",
    );
  }
}
