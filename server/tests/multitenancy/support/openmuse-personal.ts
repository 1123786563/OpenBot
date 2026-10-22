/**
 * MT062 fixture (Issue #105): OpenMuse personal-domain (goals/ideas/memories)
 * and finance-artifact tenancy.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMusePersonalTenancyService` (the module under test)
 *     over verified restricted channels;
 *   - the REAL MT073 finance-visibility service as the AC2 reader gate
 *     (`assertCompanyFinanceReader`/`grantCompanyFinanceReader` on the
 *     platform channel — the same service, the same rules);
 *   - the production row seam over the platform channel: live/tombstoned
 *     reads, batch reads, tombstone and revive for goals/ideas/memories and
 *     finance-artifact file rows (exactly the projection the tenancy
 *     service's `rows` seam names — the revive half is the documented
 *     assembly seam, implemented here over the same drizzle tables the
 *     production rows objects use);
 *   - a legacy-shape seeding seam (goal/idea/memory/file rows with
 *     owner_user_id only) for scoped-operation tests;
 *   - the real MT006 revocation (`suspendCompanyMembership`).
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS and finance-grant rows all execute against real
 * rows under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import {
  openmuseGoals,
  openmuseIdeas,
  openmuseMemories,
  openmuseFiles,
} from "../../../src/db/schema/openmuse";
import type { OpenMusePersonalObjectType } from "../../../src/db/schema/openmuse-personal-tenancy";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  type OpenMusePersonalTenancyRows,
  type PersonalObjectRecord,
  createOpenMusePersonalTenancyService,
} from "../../../src/enterprise/tenancy/openmuse-personal-tenancy";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createCompanyFinanceVisibilityService,
  type CompanyFinanceVisibilityService,
} from "../../../src/billing/company-finance-visibility";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT062 suite shares. */
export type OpenMusePersonalIdentity =
  | "a1-member"
  | "a1-other"
  | "a2-member"
  | "b1-member"
  | "multi-company"
  | "finance-reader";

export interface OpenMusePersonalFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<typeof createOpenMusePersonalTenancyService>;
  /** The real MT073 service (AC2 gate + grant provisioning in tests). */
  readonly finance: CompanyFinanceVisibilityService;
  /** Platform channel: openmuse_* rows (no enterprise RLS). */
  readonly platform: Database;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: OpenMusePersonalIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /**
   * Seeds one legacy-shape root row (owner_user_id only) of the given kind
   * and returns its id.
   */
  seedObject(
    objectType: "goal" | "idea" | "memory" | "finance_artifact",
    input: { ownerUserId: string; title?: string },
  ): Promise<string>;
  /** Setup-channel probe: the raw root row's tombstone state. */
  objectTombstoned(
    objectType: "goal" | "idea" | "memory" | "finance_artifact",
    objectId: string,
  ): Promise<boolean>;
  /** Real MT006 revocation (security event + epoch bump) on the operator channel. */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT062 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT062 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `a1-other` is the same-team teammate (AC1);
 * `finance-reader` holds an explicit MT073 finance grant (AC2) and nothing
 * else; `multi-company` is the cross-company person; `company-admin` is a
 * tenant_admin WITHOUT a finance grant (AC2: 角色不自动获得财务读取).
 */
const HUMAN_PLAN: readonly {
  identity: OpenMusePersonalIdentity | "company-admin";
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
    identity: "finance-reader",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    // tenant_admin WITH a team membership and WITHOUT a finance grant: the
    // AC2 case that a role never auto-grants finance reads.
    identity: "company-admin",
    memberships: [
      { companyKey: "company-a", role: "tenant_admin", teams: ["team-a1"] },
    ],
  },
];

export async function createOpenMusePersonalFixture(): Promise<OpenMusePersonalFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt062-${randomUUID().slice(0, 8)}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids: Record<string, string> = {};
  for (const company of PLANNED_COMPANIES) {
    ids[company.companyKey] = id(company.companyKey);
    for (const team of company.teams) ids[team.teamKey] = id(team.teamKey);
  }
  for (const planned of HUMAN_PLAN) {
    ids[`user-${planned.identity}`] = id(`user-${planned.identity}`);
    ids[`principal-${planned.identity}`] = id(`principal-${planned.identity}`);
  }
  const principalOf = (identity: string) => ids[`principal-${identity}`];
  const userOf = (identity: string) => ids[`user-${identity}`];

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];

  const dispose = async (created: boolean) => {
    const failures: unknown[] = [];
    if (created) {
      try {
        await setupDatabase.execute(
          sql`delete from openmuse_personal_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from billing_company_finance_grants where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(openmuseGoals)
          .where(like(openmuseGoals.id, `${prefix}-%`));
        await setupDatabase
          .delete(openmuseIdeas)
          .where(like(openmuseIdeas.id, `${prefix}-%`));
        await setupDatabase
          .delete(openmuseMemories)
          .where(like(openmuseMemories.id, `${prefix}-%`));
        await setupDatabase
          .delete(openmuseFiles)
          .where(like(openmuseFiles.id, `${prefix}-%`));
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
        "OpenMuse personal fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT062 ${planned.identity}`,
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

    const platform = createDatabase(setupUrl, { max: 4 }) as Database;
    closeables.push(platform.$client);

    // Real provisioning path: one provisionDeployment call per (company,
    // team); company-admin joins company A's first call as tenant_admin.
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
    // workspace-membership row through the restricted operator role.
    const materializeTeamMembership = async (
      tenantId: string,
      workspaceId: string,
      principalId: string,
    ) => {
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

    // The real request path: session seam → trusted scope.
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt062-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // The production row seam over the platform channel. The four root
    // tables share the (id, owner_user_id, deleted_at) spine but disagree on
    // the rest (memories and files have no updated_at), so the seam speaks
    // parameterized SQL against a CLOSED table-name map keyed by the CHECK'd
    // object-type vocabulary — the same raw-SQL-over-platform-channel shape
    // the MT060 fixture uses for cross-table probes.
    const TABLE_NAMES: Record<OpenMusePersonalObjectType, string> = {
      goal: "openmuse_goals",
      idea: "openmuse_ideas",
      memory: "openmuse_memories",
      finance_artifact: "openmuse_files",
    };
    const HAS_UPDATED_AT: Record<OpenMusePersonalObjectType, boolean> = {
      goal: true,
      idea: true,
      memory: false,
      finance_artifact: false,
    };
    const rowsOf = async (
      query: ReturnType<typeof sql>,
    ): Promise<Record<string, unknown>[]> => {
      const answer = (await platform.execute(query)) as unknown;
      return (
        Array.isArray(answer)
          ? answer
          : ((answer as { rows?: unknown[] })?.rows ?? [])
      ) as Record<string, unknown>[];
    };
    const recordOf = (row: Record<string, unknown>): PersonalObjectRecord => ({
      id: row.id as string,
      createdAt: row.created_at as Date,
      updatedAt:
        (row.updated_at as Date | undefined) ?? (row.created_at as Date),
      deletedAt: (row.deleted_at as Date | null) ?? null,
      snapshot: row,
    });
    const rows: OpenMusePersonalTenancyRows = {
      async findOwnedObject(ownerUserId, objectType, objectId) {
        const found = await rowsOf(
          sql`select * from ${sql.identifier(TABLE_NAMES[objectType])} where id = ${objectId} and owner_user_id = ${ownerUserId} and deleted_at is null`,
        );
        return found[0] ? recordOf(found[0]) : null;
      },
      async findOwnedObjectIncludingTombstoned(
        ownerUserId,
        objectType,
        objectId,
      ) {
        const found = await rowsOf(
          sql`select * from ${sql.identifier(TABLE_NAMES[objectType])} where id = ${objectId} and owner_user_id = ${ownerUserId}`,
        );
        return found[0] ? recordOf(found[0]) : null;
      },
      async listOwnedObjectsByIds(ownerUserId, objectType, objectIds) {
        if (objectIds.length === 0) return [];
        const found = await rowsOf(
          sql`select * from ${sql.identifier(TABLE_NAMES[objectType])} where owner_user_id = ${ownerUserId} and deleted_at is null and id in (${sql.join(
            [...objectIds].map((objectId) => sql`${objectId}`),
            sql`, `,
          )})`,
        );
        const byId = new Map(
          found.map((row) => [row.id as string, recordOf(row)]),
        );
        return [...objectIds].flatMap((objectId) => {
          const record = byId.get(objectId);
          return record ? [record] : [];
        });
      },
      async tombstoneOwnedObject(ownerUserId, objectType, objectId) {
        const updated = await rowsOf(
          sql`update ${sql.identifier(TABLE_NAMES[objectType])} set deleted_at = now()${
            HAS_UPDATED_AT[objectType] ? sql`, updated_at = now()` : sql``
          } where id = ${objectId} and owner_user_id = ${ownerUserId} and deleted_at is null returning *`,
        );
        return updated[0] ? recordOf(updated[0]) : null;
      },
      async reviveOwnedObject(ownerUserId, objectType, objectId) {
        const updated = await rowsOf(
          sql`update ${sql.identifier(TABLE_NAMES[objectType])} set deleted_at = null${
            HAS_UPDATED_AT[objectType] ? sql`, updated_at = now()` : sql``
          } where id = ${objectId} and owner_user_id = ${ownerUserId} and deleted_at is not null returning *`,
        );
        return updated[0] ? recordOf(updated[0]) : null;
      },
    };

    // The REAL MT073 service on the platform channel (AC2: 同一规则，不是
    // 复刻)。companyBooks/credits 不在消费面——writer 只被那两个方法用，
    // 判定门与授权行只读/写 database。financeFacts 是账务域通道上的归属
    // 三元组查找（服务接口注释里的纪律），同一通道。
    const finance = createCompanyFinanceVisibilityService({
      database: platform,
      writer: {
        availableBalance: async () => {
          throw new Error("MT062 fixture: credits writer is not consumed");
        },
      } as never,
    });
    const financeGate = {
      assertCompanyFinanceReader:
        finance.assertCompanyFinanceReader.bind(finance),
      async lookupFinanceArtifactOwnership(objectId: string) {
        const found = await rowsOf(
          sql`select tenant_id, workspace_id, principal_id, user_id from openmuse_personal_scopes where object_type = 'finance_artifact' and object_id = ${objectId}`,
        );
        const row = found[0];
        return row
          ? {
              tenantId: row.tenant_id as string,
              workspaceId: row.workspace_id as string,
              principalId: row.principal_id as string,
              userId: row.user_id as string,
            }
          : null;
      },
    };

    let disposed = false;
    const fixture: OpenMusePersonalFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createOpenMusePersonalTenancyService({
        data,
        operator,
        rows,
        financeReaders: financeGate,
      }),
      finance,
      platform,

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt062-fixture.invalid/scope", {
          headers: {
            "x-mt062-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedObject(objectType, input) {
        const objectId = `${prefix}-${randomUUID().slice(0, 8)}`;
        if (objectType === "goal") {
          await platform.insert(openmuseGoals).values({
            id: objectId,
            ownerUserId: input.ownerUserId,
            title: input.title ?? "A goal",
          });
        } else if (objectType === "idea") {
          await platform.insert(openmuseIdeas).values({
            id: objectId,
            ownerUserId: input.ownerUserId,
            title: input.title ?? "An idea",
          });
        } else if (objectType === "memory") {
          await platform.insert(openmuseMemories).values({
            id: objectId,
            ownerUserId: input.ownerUserId,
            text: input.title ?? "A memory",
          });
        } else {
          await platform.insert(openmuseFiles).values({
            id: objectId,
            ownerUserId: input.ownerUserId,
            name: input.title ?? "export.csv",
            mimeType: "text/csv",
            size: 5,
            sha256: `sha-${objectId}`,
          });
        }
        return objectId;
      },

      async objectTombstoned(objectType, objectId) {
        const found = await rowsOf(
          sql`select deleted_at from ${sql.identifier(TABLE_NAMES[objectType])} where id = ${objectId}`,
        );
        return found[0]?.deleted_at != null;
      },

      suspendCompanyMembership: (tenantId, principalId) =>
        // MT060 fixture precedent: the suspension's operator is the suspended
        // principal itself (the security event + epoch bump is what matters).
        suspendMembership(operator, {
          operationId: id(`suspend-${principalId}`),
          operator: principalId,
          tenantId,
          principalId,
        }),

      async dispose() {
        if (disposed) return;
        disposed = true;
        await dispose(true);
      },
    };
    return fixture;
  } catch (error) {
    await dispose(false);
    throw error;
  }
}
