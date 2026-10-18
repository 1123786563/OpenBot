// Conversation-actions fixture (MT022 / Issue #65).
//
// Same discipline as support/conversations-list.ts (MT021): two real companies
// (A with teams A1/A2, B with team B1) provisioned through the real offline
// provisioning factory on the dedicated enterprise test database; real
// `enterprise_workspace_memberships` rows for every planned (company, team,
// principal); trusted scopes minted only by the REAL `createScopeResolver`
// over the directory channel. Nothing mocks the authorization path — scope
// issuance, membership facts, RLS and the restricted `ob_ent_*` roles all
// execute for real, and `restrictedCalls()` records `current_user` for every
// restricted query.
//
// Seeding path (MT021 precedent): conversation AND message rows are inserted
// through the restricted data role (real INSERT grant + RLS `withCheck` tenant
// policy from base migration 0057) — never through a superuser bypass. The
// only setup-channel helpers are the ones no restricted grant can produce and
// the service under test never uses:
//   - raw counts (probe only);
//   - the company-membership status flip WITHOUT an epoch bump (AC4's
//     "no epoch-bump dependency" pin — no real revocation path flips status
//     while keeping the epoch, by design);
//   - disposal deletes.
//
// Public-bot conversation shape (AC3) follows the MT018 precedent verbatim:
// `deriveThreadId` = `pubbot/<resourceId>/<principalId>/<threadKey>` and the
// conversation row is owned by the END USER's principal — the run admission
// contract from createPublicBotUsageService.

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
  type ConversationActionsService,
  createConversationActionsService,
} from "../../../src/enterprise/tenancy/conversation-actions";
import {
  type ConversationListService,
  createConversationListService,
} from "../../../src/enterprise/tenancy/conversations-list";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
} from "../../../src/enterprise/tenancy/workspace-admin";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT022 suite shares. */
export type ConversationActionsIdentity =
  | "a1-member"
  | "a1-other"
  | "a1-publisher"
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

export type SeededConversation = Readonly<{
  conversationId: string;
  tenantId: string;
  workspaceId: string;
  principalId: string;
  threadId: string;
  title: string | null;
  createdAt: Date;
  /** Defaults to 'platform'; 'mastra'/'intelligence' rows pin the backend gate. */
  storageBackend?: "platform" | "intelligence" | "mastra";
}>;

export type SeededMessage = Readonly<{
  tenantId: string;
  threadId: string;
  seq: number;
  clientMessageKey: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt?: Date;
}>;

export interface ConversationActionsFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly service: ConversationActionsService;
  /** The frozen MT021 surface, consumed read-only for the AC3 list pins. */
  readonly listService: ConversationListService;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: ConversationActionsIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /** Seeds one conversation row through the restricted data role. */
  seedConversation(conversation: SeededConversation): Promise<void>;
  /**
   * Seeds one message row through the restricted data role under the row's
   * own tenant context and keeps the conversation's `last_seq` at least at
   * the seeded seq (the production append path maintains the same invariant).
   */
  seedMessage(message: SeededMessage): Promise<void>;
  /** RLS probe: message rows visible to the data role under one tenant. */
  listMessageRowsAsData(tenantId: string): Promise<
    readonly Readonly<{
      threadId: string;
      seq: number;
      content: string;
    }>[]
  >;
  /** Fail-closed probe: the same read with NO tenant context must see 0 rows. */
  countMessagesWithoutContext(): Promise<number>;
  /** Fail-closed probe: conversations with NO tenant context must see 0 rows. */
  countConversationsWithoutContext(): Promise<number>;
  /** Scaffold probes via the setup channel (superuser, no RLS). */
  rawConversationCount(): Promise<number>;
  rawMessageCount(): Promise<number>;
  restrictedCalls(): readonly RestrictedCall[];
  /** Real MT006 company revocation (security event + epoch bump, operator channel). */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  /** Real MT007 company restore (status back to active AND epoch+1). */
  reinstateCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  /** Real MT007 team-level suspension (workspace membership status+epoch, operator channel). */
  suspendTeamMembership(
    tenantId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<unknown>;
  /** Real MT007 team-level restore. */
  restoreTeamMembership(
    tenantId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<unknown>;
  /**
   * Setup-channel status flip WITHOUT an epoch bump (AC4's no-epoch-dependency
   * pin). No real path produces this state by design; the service must deny on
   * the status fact alone. Disclosed in the report; the service never uses it.
   */
  flipCompanyMembershipStatusViaSetup(
    tenantId: string,
    principalId: string,
    status: "active" | "suspended",
  ): Promise<void>;
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT022 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT022 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. Empty `teams` (company-admin) = real company
 * membership WITHOUT any team (Spec §4.1: management identity never implies
 * content access).
 */
const HUMAN_PLAN: readonly {
  identity: ConversationActionsIdentity;
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
    // The publisher of the public bot a1-member uses (AC3): publishing never
    // grants access to the user's own session.
    identity: "a1-publisher",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    // Throwaway identity used only by the revocation tests.
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

/** The exact MT018 public-bot thread id shape (deriveThreadId, verbatim). */
export function publicBotThreadId(
  botResourceId: string,
  userPrincipalId: string,
  threadKey: string,
): string {
  return `pubbot/${botResourceId}/${userPrincipalId}/${threadKey}`;
}

export async function createConversationActionsFixture(): Promise<ConversationActionsFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt022-${randomUUID().slice(0, 8)}`;
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
  const principalOf = (identity: ConversationActionsIdentity) =>
    ids[`principal-${identity}`];
  const userOf = (identity: ConversationActionsIdentity) =>
    ids[`user-${identity}`];

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
        // Children first (messages, conversations), then the tenancy scaffold.
        await setupDatabase.execute(
          sql`delete from enterprise_message_parts where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_messages where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_conversations where tenant_id like ${`${prefix}%`}`,
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
        "Conversation-actions fixture disposal failed.",
      );
    }
  };

  try {
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT022 ${planned.identity}`,
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

    // MT005 precedent: materialize each planned team membership as a real
    // workspace-membership row through the restricted operator role.
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

    // The real request path: session seam → trusted scope.
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt022-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    const adminSession = async (
      tenantId: string,
    ): Promise<CompanyAdminContext> => {
      const sessions = new WeakMap<Request, { userId?: string }>();
      const authorizer = createCompanyAdminAuthorizer(directory, {
        authenticate: async (request) => {
          const session = sessions.get(request);
          if (!session?.userId) return null;
          return { actorId: session.userId, entrypoint: "web" };
        },
        selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      });
      const request = new Request("https://mt022.invalid/admin-context", {
        headers: { "x-openbot-tenant": tenantId },
      });
      sessions.set(request, { userId: userOf("company-admin") });
      return authorizer.resolveAdminContext(request);
    };

    const seedViaData = async (
      tenantId: string,
      statement: ReturnType<typeof sql>,
    ) => {
      await recordRole(data, "data");
      await data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(statement);
      });
    };

    let disposed = false;
    // MT006 suspendMembership 对 operationId 幂等（同 ID + 同 digest 重放历史
    // 结果，不再改状态）；撤权/恢复测试要跑多个真实周期，操作 ID 必须每次
    // 唯一——否则第二个周期被静默去重为 no-op，deny 靶面失真。
    let revocationSeq = 0;
    const fixture: ConversationActionsFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createConversationActionsService(data),
      listService: createConversationListService(data),

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt022-fixture.invalid/scope", {
          headers: {
            "x-mt022-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedConversation(conversation) {
        await seedViaData(
          conversation.tenantId,
          sql`insert into enterprise_conversations (id, tenant_id, workspace_id, principal_id, thread_id, title, storage_backend, created_at, updated_at) values (${conversation.conversationId}::uuid, ${conversation.tenantId}, ${conversation.workspaceId}, ${conversation.principalId}, ${conversation.threadId}, ${conversation.title}, ${conversation.storageBackend ?? "platform"}, ${conversation.createdAt.toISOString()}::timestamptz, ${conversation.createdAt.toISOString()}::timestamptz)`,
        );
      },

      async seedMessage(message) {
        const createdAtText = (message.createdAt ?? new Date()).toISOString();
        await seedViaData(
          message.tenantId,
          sql`insert into enterprise_messages (tenant_id, thread_id, seq, client_message_key, digest, role, content, created_at) values (${message.tenantId}, ${message.threadId}, ${message.seq}, ${message.clientMessageKey}, 'seed', ${message.role}, ${message.content}, ${createdAtText}::timestamptz)`,
        );
        await seedViaData(
          message.tenantId,
          sql`update enterprise_conversations set last_seq = greatest(last_seq, ${message.seq}) where tenant_id = ${message.tenantId} and thread_id = ${message.threadId}`,
        );
      },

      async listMessageRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select thread_id, seq, content from enterprise_messages order by thread_id asc, seq asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{
              thread_id: string;
              seq: number;
              content: string;
            }>[]
          ).map((row) =>
            Object.freeze({
              threadId: row.thread_id,
              seq: Number(row.seq),
              content: row.content,
            }),
          );
        });
      },

      async countMessagesWithoutContext() {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          // Deliberately NO app.* context: RLS must fail closed to 0 rows.
          const rows = (await tx.execute(
            sql`select count(*)::int as count from enterprise_messages`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return Number(
            (list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0,
          );
        });
      },

      async countConversationsWithoutContext() {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          const rows = (await tx.execute(
            sql`select count(*)::int as count from enterprise_conversations`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return Number(
            (list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0,
          );
        });
      },

      async rawConversationCount() {
        const result = (await setupDatabase.execute(
          sql`select count(*)::int as count from enterprise_conversations where tenant_id like ${`${prefix}%`}`,
        )) as unknown;
        const list = Array.isArray(result)
          ? result
          : ((result as { rows?: unknown[] })?.rows ?? []);
        return Number((list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0);
      },

      async rawMessageCount() {
        const result = (await setupDatabase.execute(
          sql`select count(*)::int as count from enterprise_messages where tenant_id like ${`${prefix}%`}`,
        )) as unknown;
        const list = Array.isArray(result)
          ? result
          : ((result as { rows?: unknown[] })?.rows ?? []);
        return Number((list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0);
      },

      restrictedCalls() {
        return [...restricted];
      },

      async suspendCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        revocationSeq += 1;
        return suspendMembership(operator, {
          operationId: id(`suspend-${principalId}-${revocationSeq}`),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async reinstateCompanyMembership(tenantId, principalId) {
        await recordRole(operator, "operator");
        const context = await adminSession(tenantId);
        const admin = createWorkspaceAdminService(operator);
        return admin.restoreCompanyMember(context, { principalId });
      },

      async suspendTeamMembership(tenantId, workspaceId, principalId) {
        await recordRole(operator, "operator");
        const context = await adminSession(tenantId);
        const admin = createWorkspaceAdminService(operator);
        return admin.suspendTeamMember(context, { workspaceId, principalId });
      },

      async restoreTeamMembership(tenantId, workspaceId, principalId) {
        await recordRole(operator, "operator");
        const context = await adminSession(tenantId);
        const admin = createWorkspaceAdminService(operator);
        return admin.restoreTeamMember(context, { workspaceId, principalId });
      },

      async flipCompanyMembershipStatusViaSetup(tenantId, principalId, status) {
        await setupDatabase.execute(
          sql`update enterprise_memberships set status = ${status} where tenant_id = ${tenantId} and principal_id = ${principalId}`,
        );
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
      cleanupFailures.push(error, disposeError);
    }
    throw new AggregateError(
      cleanupFailures,
      "Conversation-actions fixture creation failed.",
    );
  }
}
