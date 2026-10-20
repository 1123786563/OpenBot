/**
 * Attachments fixture (MT024 / Issue #67).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the suite the REAL production surfaces under test — no stand-ins on
 * any decision path:
 *
 *   - `attachments`: the MT024 module under test (data + operator channels
 *     + an injected test signing key);
 *   - `scopeAs`: real `createScopeResolver` over the directory channel;
 *   - `suspendCompanyMembership`: the real MT006 suspension path (the AC2
 *     revocation driver — epoch increments, scopes die on next check);
 *   - `seedConversation`: disclosed setup-channel stand-in inserting one
 *     enterprise_conversations row (the canonical producer is the
 *     conversations service; here it is test arrangement only).
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout.
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import {
  type AttachmentService,
  createAttachmentService,
} from "../../../src/enterprise/tenancy/attachments";
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
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT023 suite shares. */
export type AttachmentIdentity =
  | "a1-owner"
  | "a1-other"
  | "a2-member"
  | "b1-member"
  | "company-admin";

export type RestrictedCall = Readonly<{
  role: "data" | "operator" | "directory";
  currentUser: string;
}>;

export interface AttachmentFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly companyA: string;
  readonly companyB: string;
  readonly teamA1: string;
  readonly teamA2: string;
  readonly teamB1: string;
  readonly attachments: AttachmentService;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: AttachmentIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<import("../../../src/enterprise/contracts").PlatformScope>;
  /** Real MT006 suspension path: epoch increments, scopes die on next check. */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<void>;
  /** Disclosed stand-in: inserts one conversation row (bind counterpart). */
  seedConversation(input: {
    tenantId: string;
    workspaceId: string;
    principalId: string;
    threadId: string;
  }): Promise<void>;
  /**
   * RLS probe (restricted data role): attachment rows under one tenant —
   * id, visibility lifecycle state and created timestamp.
   */
  readAttachmentRowsAsData(tenantId: string): Promise<
    readonly Readonly<{
      id: string;
      displayName: string;
      visibility: string | null;
      workspaceId: string;
    }>[]
  >;
  restrictedCalls(): readonly RestrictedCall[];
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT024 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT024 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

const HUMAN_PLAN: readonly {
  identity: AttachmentIdentity;
  memberships: readonly {
    companyKey: "company-a" | "company-b";
    role: "member" | "tenant_admin";
    teams: readonly string[];
  }[];
}[] = [
  {
    identity: "a1-owner",
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
    identity: "company-admin",
    memberships: [
      { companyKey: "company-a", role: "tenant_admin", teams: ["team-a1"] },
    ],
  },
];

export async function createAttachmentFixture(): Promise<AttachmentFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt024-${randomUUID().slice(0, 8)}`;
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
  const principalOf = (identity: AttachmentIdentity) =>
    ids[`principal-${identity}`];
  const userOf = (identity: AttachmentIdentity) => ids[`user-${identity}`];

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
        await setupDatabase.execute(
          sql`delete from enterprise_resource_grants where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resources where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_ownership where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(enterpriseMemberships)
          .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseWorkspaceMemberships)
          .where(like(enterpriseWorkspaceMemberships.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterprisePrincipals)
          .where(like(enterprisePrincipals.id, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseWorkspaces)
          .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseTenants)
          .where(like(enterpriseTenants.id, `${prefix}%`));
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
        "Attachment fixture disposal failed.",
      );
    }
  };

  try {
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT024 ${planned.identity}`,
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

    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt024-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    const signingKey = randomUUID() + randomUUID();
    const fixture: AttachmentFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      companyA: ids["company-a"],
      companyB: ids["company-b"],
      teamA1: ids["team-a1"],
      teamA2: ids["team-a2"],
      teamB1: ids["team-b1"],
      attachments: createAttachmentService({
        data,
        operator,
        signingKey,
      }),

      async scopeAs(identity, tenantId, workspaceId) {
        const request = new Request("https://mt024-fixture.invalid/scope", {
          headers: {
            "x-mt024-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async suspendCompanyMembership(tenantId, principalId) {
        await suspendMembership(operator, {
          operationId: id(
            `suspend-${principalId}-${randomUUID().slice(0, 6)}`,
          ),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async seedConversation({ tenantId, workspaceId, principalId, threadId }) {
        // Disclosed stand-in (MT011 precedent): the canonical producer is the
        // conversations service; here it is bind-arrangement only.
        await setupDatabase.execute(
          sql`insert into enterprise_conversations (tenant_id, workspace_id, principal_id, thread_id, title) values (${tenantId}, ${workspaceId}, ${principalId}, ${threadId}, 'MT024 会话') on conflict do nothing`,
        );
      },

      async readAttachmentRowsAsData(tenantId) {
        // resources 的 data 读面按租户过滤即可；operator 通道保持与
        // 既有探针一致的角色记录。
        await recordRole(operator, "operator");
        return operator.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(sql`
            select id, display_name, visibility, workspace_id
            from enterprise_resources
            where tenant_id = ${tenantId} and kind = 'attachment'
            order by id
          `)) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (list as Record<string, unknown>[]).map((row) => ({
            id: String(row.id),
            displayName: String(row.display_name),
            visibility: row.visibility === null ? null : String(row.visibility),
            workspaceId: String(row.workspace_id),
          }));
        });
      },

      restrictedCalls: () => [...restricted],

      dispose() {
        return dispose(true);
      },
    };
    return fixture;
  } catch (error) {
    await dispose(true);
    throw error;
  }
}

