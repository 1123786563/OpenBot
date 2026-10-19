/**
 * Bot-lifecycle fixture (MT019 / Issue #62).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the suite the REAL production surfaces under test — no stand-ins on
 * any decision path:
 *
 *   - `ownership`: real MT016 `createBotOwnershipService` (bots are created
 *     through the accepted creation path, so ownership rows are real);
 *   - `publish`: real MT017 `createBotPublishService` (the team-public state
 *     the lifecycle actions operate on is produced by the real publisher);
 *   - `lifecycle`: the MT019 module under test (data + operator + setup
 *     channels; setup is the disclosed callback-locator channel);
 *   - `actions`: real MT009 `createTeamResourceActionService` — the usage
 *     path (read/run) the deletion-cascade acceptance names is exercised
 *     through MT009 itself, never re-implemented here;
 *   - `scopeAs`: real `createScopeResolver` over the directory channel.
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout. Two disclosed
 * arrangement-side stand-ins (MT011 `setTenantPolicyRevision` precedent;
 * the decision side never uses either channel):
 *
 *   - `promoteToTenantAdmin` flips one membership row's role on the setup
 *     channel (the real people-lifecycle promotion surface belongs to
 *     MT076; here it is test arrangement only);
 *   - `seedSharedUseRows` inserts MT034 request/approval rows on the setup
 *     channel (their canonical producer is the MT034 state machine).
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
  type BotLifecycleService,
  createBotLifecycleService,
} from "../../../src/enterprise/tenancy/bot-lifecycle";
import {
  type BotPublishService,
  createBotPublishService,
} from "../../../src/enterprise/tenancy/bot-publish";
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
  createTeamResourceActionService,
  type TeamResourceActionService,
} from "../../../src/enterprise/tenancy/team-public-rules";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT019 suite shares. */
export type BotLifecycleIdentity =
  | "a1-owner"
  | "a1-member"
  | "a2-member"
  | "a1a2-member"
  | "b1-member"
  | "company-admin";

export type RestrictedCall = Readonly<{
  role: "data" | "operator" | "directory";
  currentUser: string;
}>;

export interface BotLifecycleFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly ownership: BotOwnershipService;
  readonly publish: BotPublishService;
  readonly lifecycle: BotLifecycleService;
  readonly actions: TeamResourceActionService;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: BotLifecycleIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<import("../../../src/enterprise/contracts").PlatformScope>;
  /**
   * Disclosed superuser stand-in (MT011/MT036/MT017 precedent): flips one
   * tenant's policy_revision. The decision side never uses this channel.
   */
  setTenantPolicyRevision(tenantId: string, revision: string): Promise<void>;
  /** Disclosed stand-in: flips one membership role to tenant_admin. */
  promoteToTenantAdmin(tenantId: string, principalId: string): Promise<void>;
  /** Real MT006 suspension path: epoch increments, scopes die on next check. */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<void>;
  /** Inserts one explicit read grant through the real operator INSERT policy. */
  seedReadGrant(input: {
    tenantId: string;
    resourceId: string;
    principalId: string;
  }): Promise<void>;
  /** RLS probe: explicit grant rows for one resource (restricted data role). */
  readGrantCountAsData(tenantId: string, resourceId: string): Promise<number>;
  /** Disclosed stand-in: seeds MT034 request/approval rows for one bot. */
  seedSharedUseRows(input: {
    tenantId: string;
    workspaceId: string;
    agentId: string;
    requestedBy: string;
    approvedBy: string;
  }): Promise<{ readonly requestId: string; readonly approvalId: string }>;
  /**
   * RLS probes (restricted data role): lifecycle-relevant rows under one
   * tenant — ownership rows, bot registration rows, grant count, shared-use
   * rows (status for requests; presence for approvals).
   */
  readOwnershipRowsAsData(
    tenantId: string,
  ): Promise<readonly Readonly<{ agentId: string; status: string }>[]>;
  readBotResourceRowsAsData(tenantId: string): Promise<
    readonly Readonly<{
      id: string;
      visibility: string | null;
      status: string;
    }>[]
  >;
  readSharedRowsAsData(tenantId: string): Promise<{
    readonly requests: readonly Readonly<{ agentId: string; status: string }>[];
    readonly approvals: readonly Readonly<{ agentId: string }>[];
  }>;
  restrictedCalls(): readonly RestrictedCall[];
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT019 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT019 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

const HUMAN_PLAN: readonly {
  identity: BotLifecycleIdentity;
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
    identity: "a1-member",
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
    identity: "company-admin",
    memberships: [{ companyKey: "company-a", role: "tenant_admin", teams: [] }],
  },
];

export async function createBotLifecycleFixture(): Promise<BotLifecycleFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt019-${randomUUID().slice(0, 8)}`;
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
  const principalOf = (identity: BotLifecycleIdentity) =>
    ids[`principal-${identity}`];
  const userOf = (identity: BotLifecycleIdentity) => ids[`user-${identity}`];

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
          sql`delete from enterprise_shared_use_approvals where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_plugin_installs where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_plugin_catalog where id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_shared_use_requests where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resource_grants where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resources where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_preferences where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_ownership where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(enterpriseMemberships)
          .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
        await setupDatabase
          .delete(enterpriseWorkspaces)
          .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
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
        "Bot lifecycle fixture disposal failed.",
      );
    }
  };

  try {
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT019 ${planned.identity}`,
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
        const identity = request.headers.get("x-mt019-identity");
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
    const fixture: BotLifecycleFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      ownership: createBotOwnershipService({ data, operator }),
      publish: createBotPublishService({ operator }),
      lifecycle: createBotLifecycleService({
        data,
        operator,
        setup: setupDatabase,
      }),
      actions: createTeamResourceActionService(data),

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt019-fixture.invalid/scope", {
          headers: {
            "x-mt019-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async setTenantPolicyRevision(tenantId, revision) {
        await setupDatabase.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          const updated = await tx.execute(sql`
            update enterprise_tenants
            set policy_revision = ${revision}
            where id = ${tenantId}
          `);
          const changed = Number(
            (updated as unknown as { count?: number }).count ?? 0,
          );
          if (changed !== 1) {
            throw new Error(
              `TENANT_POLICY_REVISION_FAILED:${tenantId}:${revision}:${changed}`,
            );
          }
        });
      },

      async promoteToTenantAdmin(tenantId, principalId) {
        // Disclosed stand-in (MT011 precedent): the real promotion surface is
        // MT076 people-lifecycle; this channel is arrangement-only.
        await setupDatabase.execute(
          sql`update enterprise_memberships set role = 'tenant_admin' where tenant_id = ${tenantId} and principal_id = ${principalId}`,
        );
      },

      async suspendCompanyMembership(tenantId, principalId) {
        await suspendMembership(operator, {
          operationId: id(`suspend-${principalId}`),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async seedReadGrant({ tenantId, resourceId, principalId }) {
        // The grants table's INSERT policy is tenant-scoped (MT017 precedent).
        await recordRole(operator, "operator");
        await operator.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.execute(sql`
            insert into enterprise_resource_grants
              (tenant_id, resource_id, principal_id, action)
            values (${tenantId}, ${resourceId}, ${principalId}, 'read')
            on conflict do nothing
          `);
        });
      },

      async readGrantCountAsData(tenantId, resourceId, principalId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.principal_id', ${principalId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select count(*)::int as count from enterprise_resource_grants where tenant_id = ${tenantId} and resource_id = ${resourceId} and principal_id = ${principalId}`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          const first = (list as Readonly<{ count?: number }>[])[0];
          return Number(first?.count ?? 0);
        });
      },

      async seedSharedUseRows({
        tenantId,
        workspaceId,
        agentId,
        requestedBy,
        approvedBy,
      }) {
        // Disclosed stand-in (MT011 precedent): canonical producer is the
        // MT034 state machine; the suite only needs the rows to exist so the
        // deletion cascade has something real to invalidate.
        const requestId = id(`req-${agentId}`);
        const approvalId = id(`apr-${agentId}`);
        const installId = id(`install-${agentId}`);
        const catalogId = id(`catalog-${agentId}`);
        // 回执行钉到一行真实目录条目 + 一行真实安装（FK 要求；目录闭形
        // 只有 summary，安装配置闭形非机密——与 MT031 存储面约定一致）。
        await setupDatabase.execute(sql`
          insert into enterprise_plugin_catalog (id, kind, title, vendor, source, metadata)
          values (${catalogId}, 'mcp', ${`MT019 arrangement ${catalogId}`}, 'openbot-test', 'first-party', '{"summary":"MT019 test arrangement"}'::jsonb)
          on conflict do nothing
        `);
        await setupDatabase.execute(sql`
          insert into enterprise_plugin_installs
            (tenant_id, id, catalog_id, workspace_id, installed_by, config)
          values
            (${tenantId}, ${installId}, ${catalogId}, ${workspaceId}, ${requestedBy}, '{}'::jsonb)
          on conflict do nothing
        `);
        await setupDatabase.execute(sql`
          insert into enterprise_shared_use_requests
            (tenant_id, id, workspace_id, agent_id, install_id, requested_by,
             proposed_audience, proposed_outside_input, proposed_members,
             proposed_params_digest, reason, status)
          values
            (${tenantId}, ${requestId}, ${workspaceId}, ${agentId},
             ${installId}, ${requestedBy}, 'team', false,
             '[]'::jsonb, ${"0".repeat(64)}, 'publish', 'pending')
        `);
        await setupDatabase.execute(sql`
          insert into enterprise_shared_use_approvals
            (tenant_id, id, workspace_id, agent_id, install_id, request_id,
             params_digest, audience, outside_input, members, approved_by)
          values
            (${tenantId}, ${approvalId}, ${workspaceId}, ${agentId},
             ${installId}, ${requestId},
             ${"0".repeat(64)}, 'team', false, '[]'::jsonb,
             ${approvedBy})
        `);
        return { requestId, approvalId };
      },

      async readOwnershipRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select agent_id, status from enterprise_bot_ownership order by agent_id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (list as Readonly<{ agent_id: string; status: string }>[]).map(
            (row) =>
              Object.freeze({ agentId: row.agent_id, status: row.status }),
          );
        });
      },

      async readBotResourceRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select id, visibility, status from enterprise_resources where kind = 'bot' order by id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{
              id: string;
              visibility: string | null;
              status: string;
            }>[]
          ).map((row) =>
            Object.freeze({
              id: row.id,
              visibility: row.visibility,
              status: row.status,
            }),
          );
        });
      },

      async readSharedRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const requestRows = (await tx.execute(
            sql`select agent_id, status from enterprise_shared_use_requests order by id asc`,
          )) as unknown;
          const approvalRows = (await tx.execute(
            sql`select agent_id from enterprise_shared_use_approvals order by id asc`,
          )) as unknown;
          const toList = (value: unknown) =>
            Array.isArray(value)
              ? value
              : ((value as { rows?: unknown[] })?.rows ?? []);
          return {
            requests: (
              toList(requestRows) as Readonly<{
                agent_id: string;
                status: string;
              }>[]
            ).map((row) =>
              Object.freeze({ agentId: row.agent_id, status: row.status }),
            ),
            approvals: (
              toList(approvalRows) as Readonly<{ agent_id: string }>[]
            ).map((row) => Object.freeze({ agentId: row.agent_id })),
          };
        });
      },

      restrictedCalls() {
        return Object.freeze([...restricted]);
      },

      async dispose() {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
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
