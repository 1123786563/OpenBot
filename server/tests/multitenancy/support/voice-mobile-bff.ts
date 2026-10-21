/**
 * MT066 fixture (Issue #109): voice / dictation / mobile-aggregate tenancy.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMuseVoiceMobileTenancyService` (the module under
 *     test) over verified restricted channels;
 *   - voice-session / push-device seeding seams over the platform channel
 *     (`voice_sessions` rows on a real `channels` anchor; `push_devices`
 *     rows);
 *   - the real MT006 revocation (`suspendMembership`).
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS, usage freezing and device gates all execute
 * against real rows under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { channels, users } from "../../../src/db/schema/core";
import { pushDevices } from "../../../src/db/schema/delivery";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import { voiceSessions } from "../../../src/db/schema/voice";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import { createOpenMuseVoiceMobileTenancyService } from "../../../src/enterprise/tenancy/openmuse-voice-mobile-tenancy";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT066 suite shares. */
export type VoiceMobileIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "b1-member"
  | "multi-company";

export interface VoiceMobileFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<typeof createOpenMuseVoiceMobileTenancyService>;
  /** Seeded anchor id the voice-session seam needs (one channel). */
  readonly anchor: { readonly channelId: string };
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: VoiceMobileIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /** Seeds one `voice_sessions` row (real transcript shape) and returns its id. */
  seedVoiceSession(input: {
    ownerUserId: string;
    durationSeconds?: number;
  }): Promise<string>;
  /** Seeds one `push_devices` row and returns its id. */
  seedPushDevice(input: {
    ownerUserId: string;
    enabled?: boolean;
  }): Promise<string>;
  /** Setup-channel probe: does the push-device root row still exist? */
  deviceLive(deviceId: string): Promise<boolean>;
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
    companyName: "MT066 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT066 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC4 scope-switch person:
 * one human, two companies. `a1-other` is the same-team teammate whose reads
 * must never see a1-member's sessions (AC1).
 */
const HUMAN_PLAN: readonly {
  identity: VoiceMobileIdentity;
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

export async function createVoiceMobileFixture(): Promise<VoiceMobileFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt066-${randomUUID().slice(0, 8)}`;
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
        // Children first (association rows cascade), then the seeded roots,
        // then the anchor, then the tenancy scaffold, then the users.
        await setupDatabase.execute(
          sql`delete from voice_session_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from dictation_usage_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from push_device_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(voiceSessions)
          .where(like(voiceSessions.userId, `${prefix}%`));
        await setupDatabase
          .delete(pushDevices)
          .where(like(pushDevices.ownerUserId, `${prefix}%`));
        await setupDatabase
          .delete(channels)
          .where(like(channels.id, `${prefix}%`));
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
        "Voice/mobile fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT066 ${planned.identity}`,
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
        const identity = request.headers.get("x-mt066-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // Voice anchor: one real channel the seeded voice_sessions rows hang on
    // (FK-faithful, no orphan shortcuts).
    const channelId = id("channel-anchor");
    await platform.insert(channels).values({
      id: channelId,
      name: `MT066 ${prefix} anchor channel`,
      description: "MT066 fixture voice anchor",
    });

    // The production row seam: voice_sessions / push_devices rows on the
    // platform channel, exactly the projection the service's rows interface
    // names.
    const rows = {
      async findOwnedSession(ownerUserId, sessionId) {
        const [row] = await platform
          .select()
          .from(voiceSessions)
          .where(
            and(
              eq(voiceSessions.id, sessionId),
              eq(voiceSessions.userId, ownerUserId),
            ),
          )
          .limit(1);
        return row
          ? {
              id: row.id,
              channelId: row.channelId,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              durationSeconds: row.durationSeconds,
            }
          : null;
      },
      async listSessionsByIds(ownerUserId, sessionIds) {
        if (sessionIds.length === 0) return [];
        const found = await platform
          .select()
          .from(voiceSessions)
          .where(
            and(
              inArray(voiceSessions.id, [...sessionIds]),
              eq(voiceSessions.userId, ownerUserId),
            ),
          );
        return found.map((row) => ({
          id: row.id,
          channelId: row.channelId,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          durationSeconds: row.durationSeconds,
        }));
      },
      async findOwnedDevice(ownerUserId, deviceId) {
        const [row] = await platform
          .select()
          .from(pushDevices)
          .where(
            and(
              eq(pushDevices.id, deviceId),
              eq(pushDevices.ownerUserId, ownerUserId),
            ),
          )
          .limit(1);
        return row
          ? { id: row.id, platform: row.platform, enabled: row.enabled }
          : null;
      },
    };

    let disposed = false;
    const fixture: VoiceMobileFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createOpenMuseVoiceMobileTenancyService({
        data,
        operator,
        rows,
      }),
      anchor: { channelId },

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt066-fixture.invalid/scope", {
          headers: {
            "x-mt066-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedVoiceSession(input) {
        const sessionId = `${prefix}-voice-${randomUUID().slice(0, 8)}`;
        const duration = input.durationSeconds ?? 120;
        const started = new Date(Date.now() - (duration + 60) * 1000);
        await platform.insert(voiceSessions).values({
          id: sessionId,
          channelId,
          userId: input.ownerUserId,
          anchorMessageId: null,
          startedAt: started,
          endedAt: new Date(started.getTime() + duration * 1000),
          durationSeconds: duration,
          transcript: {
            entries: [{ id: `${sessionId}-e1`, role: "user", text: "hello" }],
          },
        });
        return sessionId;
      },

      async seedPushDevice(input) {
        const deviceId = `${prefix}-device-${randomUUID().slice(0, 8)}`;
        await platform.insert(pushDevices).values({
          id: deviceId,
          ownerUserId: input.ownerUserId,
          token: `ExponentPushToken[${deviceId}]`,
          projectId: "mt066-fixture",
          platform: "ios",
          enabled: input.enabled ?? true,
        });
        return deviceId;
      },

      async deviceLive(deviceId) {
        const [row] = await platform
          .select({ id: pushDevices.id })
          .from(pushDevices)
          .where(eq(pushDevices.id, deviceId))
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
