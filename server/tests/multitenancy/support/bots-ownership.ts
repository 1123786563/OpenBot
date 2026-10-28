/**
 * Bots-ownership fixture (MT016 / Issue #59).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows for each
 * planned (company, team, principal), and hands the real
 * `createBotOwnershipService` the verified data + operator channels. Trusted
 * scopes come from the REAL `createScopeResolver` over the directory channel —
 * the same eligibility gate production requests pass — so an identity without
 * a team membership (the company admin) cannot even mint a scope for that
 * team. Nothing here mocks the authorization path: scope issuance, membership
 * checks, RLS and the restricted `ob_ent_*` roles all execute for real, and
 * the fixture records `current_user` for every restricted query so the suite
 * can prove restricted roles were in play.
 *
 * The two MT016 tables (`enterprise_bot_ownership`,
 * `enterprise_bot_preferences`) are touched through raw SQL under the
 * restricted roles (the MT009 precedent: the schema file belongs to the
 * producing ticket, the fixture reads facts through the database, not through
 * a barrel import).
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import {
  type BotOwnershipService,
  createBotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
} from "../../../src/enterprise/tenancy/workspace-admin";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT016 suite shares. */
export type BotsIdentity =
  | "a1-member"
  | "a1-other"
  | "a1-doomed"
  | "a2-member"
  | "a1a2-member"
  | "b1-member"
  | "multi-company"
  | "company-admin";

export type RestrictedCall = Readonly<{
  role: "data" | "operator" | "directory";
  currentUser: string;
}>;

export interface BotsOwnershipFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly service: BotOwnershipService;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: BotsIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<import("../../../src/enterprise/contracts").PlatformScope>;
  /** RLS probe: ownership rows visible to the data role under one tenant. */
  readOwnershipRowsAsData(
    tenantId: string,
  ): Promise<readonly Readonly<{ agentId: string; workspaceId: string }>[]>;
  /**
   * RLS probe: preference rows visible to the data role under one tenant AND
   * one principal (the restrictive self-read policy is part of the probe).
   */
  readPreferenceRowsAsData(
    tenantId: string,
    principalId: string,
  ): Promise<readonly Readonly<{ agentId: string; principalId: string }>[]>;
  /** Scaffold probe via the setup channel (superuser, no RLS): full table counts. */
  rawCounts(): Promise<{
    ownership: number;
    preferences: number;
  }>;
  restrictedCalls(): readonly RestrictedCall[];
  /**
   * Real MT006 revocation: suspend a company membership through the real
   * `provision.suspendMembership` on the operator channel (support/fixture.ts
   * precedent). The suspension writes a real security event and increments
   * the membership epoch, so already-issued scopes carry a stale epoch and
   * fail the service's in-transaction revalidation.
   */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  /**
   * Real MT007 restore: reinstate a suspended company membership through the
   * real company-admin surface (support/workspace-scope.ts precedent — the
   * authorizer mints the trusted context from a real tenant_admin). Restore
   * flips status back to active AND increments the epoch, so a pre-suspension
   * scope stays rejected by epoch policy even after restoration.
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
    companyName: "MT016 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT016 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `teams` lists are materialized as real workspace
 * membership rows; an empty list (company-admin) means a real company
 * membership WITHOUT any team — the Spec §4.1 rule that management identity
 * never implies content access.
 */
const HUMAN_PLAN: readonly {
  identity: BotsIdentity;
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
    // Throwaway identity used only by the revocation test: a real team-a1
    // member whose company membership gets suspended mid-suite.
    identity: "a1-doomed",
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
    // visibility — a team-a1 bot is invisible from a team-a2 scope even for
    // an a1 member (acceptance 2; the mutation harness caught this gap).
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

export async function createBotsOwnershipFixture(): Promise<BotsOwnershipFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt016-${randomUUID().slice(0, 8)}`;
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
  const principalOf = (identity: BotsIdentity) => ids[`principal-${identity}`];
  const userOf = (identity: BotsIdentity) => ids[`user-${identity}`];

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  const restricted: RestrictedCall[] = [];
  const recordRole = async (
    connection: Database,
    role: RestrictedCall["role"],
  ) => {
    const result = (await connection.execute(
      sql`select current_user as current_user`,
    )) as unknown;
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? []);
    const first = (rows as Readonly<{ current_user?: unknown }>[])[0];
    // current_user always answers exactly one row: a miss means the probe
    // itself broke, and an empty role must not silently pass the RLS proofs.
    if (typeof first?.current_user !== "string") {
      throw new Error(`RESTRICTED_ROLE_PROBE_FAILED:${role}`);
    }
    restricted.push({
      role,
      currentUser: first.current_user,
    });
  };

  const dispose = async (created: boolean) => {
    const failures: unknown[] = [];
    if (created) {
      try {
        // Children first (preferences → ownership), then the tenancy scaffold.
        await setupDatabase.execute(
          sql`delete from enterprise_bot_preferences where tenant_id like ${`${prefix}%`}`,
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
        "Bots ownership fixture disposal failed.",
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
        name: `MT016 ${planned.identity}`,
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
    // call as tenant_admin (a real company membership and a real operator
    // identity for provisioning) and materializes no workspace membership.
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
        const identity = request.headers.get("x-mt016-identity");
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
    const fixture: BotsOwnershipFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createBotOwnershipService({ data, operator }),

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt016-fixture.invalid/scope", {
          headers: {
            "x-mt016-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async readOwnershipRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select agent_id, workspace_id from enterprise_bot_ownership order by agent_id asc`,
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

      async readPreferenceRowsAsData(tenantId, principalId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.principal_id', ${principalId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select agent_id, principal_id from enterprise_bot_preferences order by agent_id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{ agent_id: string; principal_id: string }>[]
          ).map((row) =>
            Object.freeze({
              agentId: row.agent_id,
              principalId: row.principal_id,
            }),
          );
        });
      },

      async rawCounts() {
        const ownership = (await setupDatabase.execute(
          sql`select count(*)::int as count from enterprise_bot_ownership where tenant_id like ${`${prefix}%`}`,
        )) as unknown;
        const preferences = (await setupDatabase.execute(
          sql`select count(*)::int as count from enterprise_bot_preferences where tenant_id like ${`${prefix}%`}`,
        )) as unknown;
        const firstCount = (value: unknown) => {
          const list = Array.isArray(value)
            ? value
            : ((value as { rows?: unknown[] })?.rows ?? []);
          return Number(
            (list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0,
          );
        };
        return {
          ownership: firstCount(ownership),
          preferences: firstCount(preferences),
        };
      },

      restrictedCalls() {
        return [...restricted];
      },

      async suspendCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        // Real MT006 revocation path (support/fixture.ts precedent): the
        // security event + epoch bump happen for real on the restricted
        // operator role — a test double can never mint this. The suspended
        // principal's already-issued scopes fail in-transaction revalidation
        // (status flips to suspended AND the epoch no longer matches).
        return suspendMembership(operator, {
          operationId: id(`suspend-${principalId}`),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async reinstateCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        // Real MT007 restore path (support/workspace-scope.ts precedent): the
        // company-admin is a real tenant_admin; the authorizer re-verifies
        // that fact against the directory before minting the trusted context
        // (a test double can never mint one). Sessions are bound server-side
        // via WeakMap; the header only selects the company.
        const sessions = new WeakMap<Request, { userId?: string }>();
        const authorizer = createCompanyAdminAuthorizer(directory, {
          authenticate: async (request) => {
            const session = sessions.get(request);
            if (!session?.userId) return null;
            return { actorId: session.userId, entrypoint: "web" };
          },
          selectTenant: (request) => request.headers.get("x-openbot-tenant"),
        });
        const request = new Request("https://mt016.invalid/admin-context", {
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
      "Bots ownership fixture creation failed.",
    );
  }
}
