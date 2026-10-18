/**
 * MT060 fixture (Issue #103): OpenMuse task/plan/monitor ownership domain.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMuseTaskTenancyService` (the module under test)
 *     over verified restricted channels;
 *   - the real MT059 `createPersonalBotService` (consumed read-only: the
 *     private-bot binding a pinned task must name);
 *   - the real MT041 `createJobOwnershipService` (the lease system consumed
 *     by the ownership and execution faces);
 *   - the real MT005 workspace gate and the REAL schedule-entrypoint scope
 *     issuer (`createScopeResolver`, entrypoint="schedule" — MT042 shape);
 *   - the production row seam (`createOpenMuseTaskRows` on the platform
 *     channel) so every control CAS rides the exact legacy status matrices;
 *   - a legacy-root seeding seam (`openmuse_tasks` rows) for the AC3 backfill
 *     and scoped-operation tests.
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS and lease rows all execute against real rows under
 * the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { inArray, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import {
  type OpenMuseTaskRow,
  openmuseTasks,
} from "../../../src/db/schema/openmuse";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createMachineScanIdentity,
  type MachineScanIdentity,
} from "../../../src/enterprise/runs/scan-executor";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createJobOwnershipService,
  type JobOwnershipService,
} from "../../../src/enterprise/tenancy/job-ownership";
import { createOpenMuseTaskTenancyService } from "../../../src/enterprise/tenancy/openmuse-task-tenancy";
import {
  createPersonalBotService,
  type PersonalBotService,
} from "../../../src/enterprise/tenancy/personal-bot";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createWorkspaceGate } from "../../../src/enterprise/tenancy/scope-gate";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createOpenMuseTaskRows,
  createOpenMuseTaskStore,
  type OpenMuseTaskKind,
  type OpenMuseTaskStore,
  type StoredOpenMuseTask,
} from "../../../src/openmuse-tasks/store";
import { createWorkQueue } from "../../../src/work/queue";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT060 suite shares. */
export type OpenMuseTaskIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "a2-member"
  | "b1-member"
  | "multi-company"
  | "company-admin";

export interface OpenMuseTasksFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<typeof createOpenMuseTaskTenancyService>;
  /** MT059 private-bot service (read-only consumption). */
  readonly personalBots: PersonalBotService;
  /** MT041 job ownership/lease service (lease consumption). */
  readonly jobs: JobOwnershipService;
  /** MT005 workspace gate over the verified data channel. */
  readonly gate: ReturnType<typeof createWorkspaceGate>;
  /** The platform machine identity issued once per fixture (AC4 driver). */
  readonly machine: MachineScanIdentity;
  /** Platform channel: openmuse_tasks/work_items rows (no enterprise RLS). */
  readonly platform: Database;
  /** The production row seam (legacy CAS matrices) — wait opening in tests. */
  readonly legacyRows: ReturnType<typeof createOpenMuseTaskRows>;
  /** The authoritative legacy task store (full matrices + queue re-offers). */
  readonly taskStore: OpenMuseTaskStore;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: OpenMuseTaskIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /**
   * Seeds one legacy-shape `openmuse_tasks` root row (owner_user_id only —
   * the AC3 "只有 user_id 的旧根记录" shape) and returns its id.
   */
  seedLegacyTask(input: {
    ownerUserId: string;
    botId: string;
    kind?: OpenMuseTaskKind;
    status?: StoredOpenMuseTask["status"];
    attempts?: number;
  }): Promise<string>;
  /** Setup-channel probe: the association row of one task, if any. */
  scopeRowOf(taskId: string): Promise<
    | {
        tenantId: string;
        workspaceId: string;
        principalId: string;
        userId: string;
        botId: string;
        attribution: string;
      }
    | undefined
  >;
  /** Setup-channel probe: raw association count for a tenant prefix. */
  countScopeRows(tenantPrefix: string): Promise<number>;
  /** Main-channel probe: the MT041 lease row of one task, if any. */
  leaseRowOf(taskId: string): Promise<
    | {
        tenantId: string;
        workspaceId: string;
        claimedByKind: string | null;
        claimedBy: string | null;
        attempts: number;
        finishedAt: Date | null;
        leaseUntil: Date | null;
      }
    | undefined
  >;
  /** Main-channel probe: the raw openmuse_tasks row status of one task. */
  taskStatusOf(taskId: string): Promise<string | undefined>;
  /** Real MT006 revocation (security event + epoch bump) on the operator channel. */
  suspendCompanyMembership(
    tenantId: string,
    principalId: string,
  ): Promise<unknown>;
  /** Executes the given migration statements on the setup channel (AC3 oracle). */
  runStatements(statements: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT060 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT060 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC2 person: one human,
 * two companies, two independent task sets. `company-admin` holds a real
 * company membership WITHOUT any team. The `backfill-solo` identity exists
 * only in the users/principals scaffolding with exactly one team membership —
 * the AC3 attributable backfill owner. `backfill-orphan` has a principal but
 * no memberships at all — the AC3 isolated owner.
 */
const HUMAN_PLAN: readonly {
  identity: OpenMuseTaskIdentity | "backfill-solo" | "backfill-orphan";
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
  // AC3 backfill owners: provisioned through the SAME loops as everyone else
  // (their membership rows are the backfill oracle); solo ends with exactly
  // one workspace membership, orphan with none.
  {
    identity: "backfill-solo",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  { identity: "backfill-orphan", memberships: [] },
];

export async function createOpenMuseTasksFixture(): Promise<OpenMuseTasksFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt060-${randomUUID().slice(0, 8)}`;
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
        // Children first (association rows → lease/pin rows via their own
        // cascades), then job/lease leftovers, then the tenancy scaffold,
        // then the legacy task roots this fixture seeded.
        await setupDatabase.execute(
          sql`delete from openmuse_task_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from job_leases where object_id like ${`openmuse-task-${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from job_ownership where object_id like ${`openmuse-task-${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_personal_bots where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(openmuseTasks)
          .where(like(openmuseTasks.id, `openmuse-task-${prefix}-%`));
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
        "OpenMuse tasks fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them —
    // the provisioning factory refuses unbound principals.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT060 ${planned.identity}`,
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
    // team). The company admin joins only company A's first provisioning
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

    // The real request path: session seam → trusted scope. authenticate maps
    // the fixture identity to its real user id; selectors come from the same
    // headers production reads.
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt060-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // The schedule-entrypoint issuer over the SAME resolver (AC4): the
    // execution path receives this seam, never a hand-built scope.
    const scheduleSessions = new WeakMap<
      Request,
      { userId: string; tenantId: string; workspaceId: string }
    >();
    const scheduleResolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const session = scheduleSessions.get(request);
        if (!session) return null;
        return { actorId: session.userId, entrypoint: "schedule" };
      },
      selectTenant: (request) => scheduleSessions.get(request)?.tenantId,
      selectWorkspace: (request) => scheduleSessions.get(request)?.workspaceId,
    });

    const legacyRows = createOpenMuseTaskRows(platform);
    const taskStore = createOpenMuseTaskStore({
      rows: legacyRows,
      queue: createWorkQueue(platform),
    });
    const rows = {
      get: (ownerUserId: string, taskId: string) =>
        taskStore.get(ownerUserId, taskId),
      listTasksByIds: async (taskIds: readonly string[]) => {
        if (taskIds.length === 0) return [];
        const found = await platform
          .select()
          .from(openmuseTasks)
          .where(inArray(openmuseTasks.id, [...taskIds]));
        const byId = new Map(found.map((row) => [row.id, row]));
        return [...taskIds].flatMap((taskId) => {
          const row = byId.get(taskId) as OpenMuseTaskRow | undefined;
          return row ? [rowToStoredTask(row)] : [];
        });
      },
      requestCancel: (ownerUserId: string, taskId: string) =>
        taskStore.requestCancel(ownerUserId, taskId),
      requestPause: (ownerUserId: string, taskId: string) =>
        taskStore.requestPause(ownerUserId, taskId),
      resumeTask: (ownerUserId: string, taskId: string) =>
        taskStore.resumeTask(ownerUserId, taskId),
      retryTask: (
        ownerUserId: string,
        taskId: string,
        retryKey: string | null,
      ) => taskStore.retryTask(ownerUserId, taskId, retryKey),
      answerWait: (
        ownerUserId: string,
        taskId: string,
        waitId: string,
        values: Record<string, unknown>,
      ) => taskStore.answerWait(ownerUserId, taskId, waitId, values),
    };

    let disposed = false;
    const fixture: OpenMuseTasksFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createOpenMuseTaskTenancyService({
        data,
        operator,
        platform,
        rows,
        jobs: createJobOwnershipService(operator, data),
        personalBots: createPersonalBotService({ data, operator }),
        gate: createWorkspaceGate(data),
        issueScheduleScope: async (facts) => {
          const request = new Request("https://mt060-fixture.invalid/schedule");
          // 服务面 facts 以 actorId 命名；schedule 会话缝按 userId 键存取。
          scheduleSessions.set(request, {
            userId: facts.actorId,
            tenantId: facts.tenantId,
            workspaceId: facts.workspaceId,
          });
          return scheduleResolver.resolve(request);
        },
      }),
      personalBots: createPersonalBotService({ data, operator }),
      jobs: createJobOwnershipService(operator, data),
      gate: createWorkspaceGate(data),
      machine: createMachineScanIdentity({ id: id("mt060-sweep") }),
      platform,
      legacyRows,
      taskStore,

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt060-fixture.invalid/scope", {
          headers: {
            "x-mt060-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedLegacyTask(input) {
        const taskId = `openmuse-task-${prefix}-${randomUUID().slice(0, 8)}`;
        await platform.insert(openmuseTasks).values({
          id: taskId,
          ownerUserId: input.ownerUserId,
          botId: input.botId,
          kind: input.kind ?? "agent",
          status: input.status ?? "queued",
          attempts: input.attempts ?? 1,
        });
        return taskId;
      },

      async scopeRowOf(taskId) {
        const rows = (await setupDatabase.execute(
          sql`select tenant_id, workspace_id, principal_id, user_id, bot_id, attribution from openmuse_task_scopes where task_id = ${taskId}`,
        )) as unknown;
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        const row = (
          list as Readonly<{
            tenant_id: string;
            workspace_id: string;
            principal_id: string;
            user_id: string;
            bot_id: string;
            attribution: string;
          }>[]
        )[0];
        return row
          ? {
              tenantId: row.tenant_id,
              workspaceId: row.workspace_id,
              principalId: row.principal_id,
              userId: row.user_id,
              botId: row.bot_id,
              attribution: row.attribution,
            }
          : undefined;
      },

      async countScopeRows(tenantPrefix) {
        const rows = (await setupDatabase.execute(
          sql`select count(*)::int as count from openmuse_task_scopes where tenant_id like ${`${tenantPrefix}%`}`,
        )) as unknown;
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        return Number((list as Readonly<{ count?: unknown }>[])[0]?.count ?? 0);
      },

      async leaseRowOf(taskId) {
        const rows = await platform.execute(
          sql`select tenant_id, workspace_id, claimed_by_kind, claimed_by, attempts, finished_at, lease_until from job_leases where kind = 'task' and object_id = ${taskId} limit 1`,
        );
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        const row = (
          list as Readonly<{
            tenant_id: string;
            workspace_id: string;
            claimed_by_kind: string | null;
            claimed_by: string | null;
            attempts: number;
            finished_at: Date | null;
            lease_until: Date | null;
          }>[]
        )[0];
        return row
          ? {
              tenantId: row.tenant_id,
              workspaceId: row.workspace_id,
              claimedByKind: row.claimed_by_kind,
              claimedBy: row.claimed_by,
              attempts: row.attempts,
              finishedAt: row.finished_at,
              leaseUntil: row.lease_until,
            }
          : undefined;
      },

      async taskStatusOf(taskId) {
        const rows = await platform.execute(
          sql`select status from openmuse_tasks where id = ${taskId}`,
        );
        const list = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: unknown[] })?.rows ?? []);
        return (list as Readonly<{ status?: string }>[])[0]?.status;
      },

      async suspendCompanyMembership(tenantId, principalId) {
        return suspendMembership(operator, {
          operationId: id(`suspend-${principalId}`),
          operator: principalId,
          tenantId,
          principalId,
        });
      },

      async runStatements(statements) {
        for (const statement of statements) {
          await setupDatabase.execute(sql.raw(statement));
        }
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
      "OpenMuse tasks fixture creation failed.",
    );
  }
}

/** Local row→stored mapping for the fixture's batch seam (openmuse_tasks). */
function rowToStoredTask(row: OpenMuseTaskRow): StoredOpenMuseTask {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    botId: row.botId,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    steps: row.steps ?? [],
    evidence: row.evidence ?? [],
    artifactIds: row.artifactIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    idempotencyKey: row.idempotencyKey,
    cancellationRequested: row.cancellationRequested,
    pauseRequested: row.pauseRequested,
    lastRetryKey: row.lastRetryKey,
    ...(row.wait ? { wait: row.wait } : {}),
    ...(row.monitorCondition ? { monitorCondition: row.monitorCondition } : {}),
    ...(row.nextCheckAt ? { nextCheckAt: row.nextCheckAt } : {}),
    ...(row.lastObservationHash
      ? { lastObservationHash: row.lastObservationHash }
      : {}),
    ...(row.lastObservationAt
      ? { lastObservationAt: row.lastObservationAt }
      : {}),
    monitorFailureStreak: row.monitorFailureStreak,
    prompt: row.prompt,
  };
}
