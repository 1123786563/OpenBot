/**
 * MT061 fixture (Issue #104): OpenMuse files/documents/workspace tenancy.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMuseFileTenancyService` (the module under test)
 *     over verified restricted channels;
 *   - the real MT059 `createPersonalBotService` (consumed by the AC3 transfer
 *     destination resolution);
 *   - the REAL schedule-entrypoint scope issuer (`createScopeResolver`,
 *     entrypoint="schedule" — MT042 shape) wired as `issueScheduleScope`;
 *   - the production row seam over the platform channel: live-file reads by
 *     id / by ids / by idempotency key (`openmuse_files` rows, exactly the
 *     projection the tenancy service's `rows` seam names);
 *   - a legacy-shape seeding seam (`openmuse_files` rows with owner_user_id
 *     only) for scoped-operation and external-reference tests;
 *   - the real MT006 revocation (`suspendCompanyMembership`).
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS and private-bot rows all execute against real rows
 * under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import { openmuseFiles } from "../../../src/db/schema/openmuse";
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
  createOpenMuseFileTenancyService,
  type OpenMuseFileTenancyRows,
} from "../../../src/enterprise/tenancy/openmuse-file-tenancy";
import {
  createPersonalBotService,
  type PersonalBotService,
} from "../../../src/enterprise/tenancy/personal-bot";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT061 suite shares. */
export type OpenMuseFileIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "a2-member"
  | "b1-member"
  | "multi-company";

export interface OpenMuseFilesFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<typeof createOpenMuseFileTenancyService>;
  /** MT059 private-bot service (AC3 destination resolution). */
  readonly personalBots: PersonalBotService;
  /** The platform machine identity issued once per fixture (AC2 driver). */
  readonly machine: MachineScanIdentity;
  /** Platform channel: openmuse_files rows (no enterprise RLS). */
  readonly platform: Database;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: OpenMuseFileIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /**
   * Seeds one legacy-shape `openmuse_files` row (owner_user_id only — the
   * user-level ownership the tenancy face pins on top of) and returns its id.
   */
  seedFile(input: {
    ownerUserId: string;
    name?: string;
    mimeType?: string;
    idempotencyKey?: string | null;
  }): Promise<string>;
  /** Setup-channel probe: does the file row exist and is it live? */
  fileLive(fileId: string): Promise<boolean>;
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
    companyName: "MT061 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT061 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC3/AC4 person: one
 * human, two companies. `a1-other` is the same-team teammate whose reads
 * must never see a1-member's files (AC1).
 */
const HUMAN_PLAN: readonly {
  identity: OpenMuseFileIdentity;
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
];

export async function createOpenMuseFilesFixture(): Promise<OpenMuseFilesFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt061-${randomUUID().slice(0, 8)}`;
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
        // Children first (actions → scopes → files via cascades), then the
        // private bots, then the tenancy scaffold, then the users.
        await setupDatabase.execute(
          sql`delete from openmuse_document_actions where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from openmuse_file_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(openmuseFiles)
          .where(like(openmuseFiles.id, `${prefix}-%`));
        await setupDatabase.execute(
          sql`delete from enterprise_personal_bots where tenant_id like ${`${prefix}%`}`,
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
        "OpenMuse files fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT061 ${planned.identity}`,
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
    // team); b1-member administers company B.
    const operatorPrincipalFor = (companyKey: string) =>
      companyKey === "company-a"
        ? principalOf("a1-member")
        : principalOf("b1-member");
    for (const company of PLANNED_COMPANIES) {
      for (const team of company.teams) {
        const members = HUMAN_PLAN.flatMap((planned) =>
          planned.memberships
            .filter(
              (membership) =>
                membership.companyKey === company.companyKey &&
                membership.teams.includes(team.teamKey),
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
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${principalOf("a1-member")}, true)`,
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
        const identity = request.headers.get("x-mt061-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // The schedule-entrypoint issuer over the SAME resolver (AC2): the
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

    // The production row seam: openmuse_files rows on the platform channel,
    // exactly the projection the service's rows interface names.
    const fileViewOf = (row: typeof openmuseFiles.$inferSelect) => ({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt,
    });
    const rows: OpenMuseFileTenancyRows = {
      async findOwnedFile(ownerUserId, fileId) {
        const [row] = await platform
          .select()
          .from(openmuseFiles)
          .where(
            and(
              eq(openmuseFiles.id, fileId),
              eq(openmuseFiles.ownerUserId, ownerUserId),
              isNull(openmuseFiles.deletedAt),
            ),
          )
          .limit(1);
        return row ? fileViewOf(row) : null;
      },
      async listFilesByIds(ownerUserId, fileIds) {
        if (fileIds.length === 0) return [];
        const found = await platform
          .select()
          .from(openmuseFiles)
          .where(
            and(
              inArray(openmuseFiles.id, [...fileIds]),
              eq(openmuseFiles.ownerUserId, ownerUserId),
              isNull(openmuseFiles.deletedAt),
            ),
          );
        const byId = new Map(found.map((row) => [row.id, fileViewOf(row)]));
        return [...fileIds].flatMap((fileId) => {
          const view = byId.get(fileId);
          return view ? [view] : [];
        });
      },
      async findFileByIdempotencyKey(ownerUserId, sourceKey) {
        const [row] = await platform
          .select()
          .from(openmuseFiles)
          .where(
            and(
              eq(openmuseFiles.ownerUserId, ownerUserId),
              eq(openmuseFiles.idempotencyKey, sourceKey),
              isNull(openmuseFiles.deletedAt),
            ),
          )
          .limit(1);
        return row ? fileViewOf(row) : null;
      },
    };

    let disposed = false;
    const fixture: OpenMuseFilesFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createOpenMuseFileTenancyService({
        data,
        operator,
        rows,
        personalBots: createPersonalBotService({ data, operator }),
        issueScheduleScope: async (facts) => {
          const request = new Request("https://mt061-fixture.invalid/schedule");
          scheduleSessions.set(request, {
            userId: facts.actorId,
            tenantId: facts.tenantId,
            workspaceId: facts.workspaceId,
          });
          return scheduleResolver.resolve(request);
        },
      }),
      personalBots: createPersonalBotService({ data, operator }),
      machine: createMachineScanIdentity({ id: id("mt061-sweep") }),
      platform,

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt061-fixture.invalid/scope", {
          headers: {
            "x-mt061-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedFile(input) {
        const fileId = `${prefix}-${randomUUID().slice(0, 8)}`;
        await platform.insert(openmuseFiles).values({
          id: fileId,
          ownerUserId: input.ownerUserId,
          name: input.name ?? "notes.txt",
          mimeType: input.mimeType ?? "text/plain",
          size: 5,
          sha256: `sha-${fileId}`,
          ...(input.idempotencyKey !== undefined
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        });
        return fileId;
      },

      async fileLive(fileId) {
        const [row] = await platform
          .select({ id: openmuseFiles.id })
          .from(openmuseFiles)
          .where(
            and(eq(openmuseFiles.id, fileId), isNull(openmuseFiles.deletedAt)),
          )
          .limit(1);
        return row !== undefined;
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
