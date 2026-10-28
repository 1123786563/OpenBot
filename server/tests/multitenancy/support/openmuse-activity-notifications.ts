/**
 * MT065 fixture (Issue #108): OpenMuse activity-stream / notification tenancy.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMuseActivityTenancyService` (the module under test)
 *     over verified restricted channels;
 *   - the REAL `createOpenMuseReviewedActionTenancyService` (MT064, delivered
 *     in this same tree) so the activity aggregation test pins reviewed
 *     actions through the real pin path — its decision seam throws here
 *     because the aggregation read never decides (honest boundary, not a
 *     stubbed dependency);
 *   - notification/binding seeding seams over the platform channel
 *     (`openmuse_notifications` rows; `delivery_bindings` rows on real
 *     `channels`/`agents` anchors);
 *   - the real MT006 revocation (`suspendMembership`).
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS and delivery gates all execute against real rows
 * under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { agents, channels, users } from "../../../src/db/schema/core";
import { deliveryBindings } from "../../../src/db/schema/delivery";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import type { BindingTransport } from "../../../src/delivery/types";
import { openmuseNotifications } from "../../../src/db/schema/openmuse";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import { createOpenMuseActivityTenancyService } from "../../../src/enterprise/tenancy/openmuse-activity-tenancy";
import {
  createOpenMuseReviewedActionTenancyService,
  type OpenMuseReviewedActionTenancyRows,
} from "../../../src/enterprise/tenancy/openmuse-reviewed-action-tenancy";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT065 suite shares. */
export type OpenMuseActivityIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "b1-member"
  | "multi-company";

export interface OpenMuseActivityFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<typeof createOpenMuseActivityTenancyService>;
  /** MT064 tenancy service (real pin path for the aggregation source). */
  readonly reviewedTenancy: ReturnType<
    typeof createOpenMuseReviewedActionTenancyService
  >;
  /** Seeded anchor ids the binding seam needs (one channel + one agent). */
  readonly anchor: { readonly channelId: string; readonly agentId: string };
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: OpenMuseActivityIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /** Seeds one `openmuse_notifications` row and returns its id. */
  seedNotification(input: {
    ownerUserId: string;
    title: string;
    detail?: string | null;
    // The column's own enumerated kind: a misspelled event must not typecheck.
    eventKind?: (typeof openmuseNotifications.$inferInsert)["eventKind"];
  }): Promise<string>;
  /** Seeds one `delivery_bindings` row (on the shared anchors) and returns its id. */
  seedBinding(input: {
    ownerUserId: string;
    transport?: BindingTransport;
    enabled?: boolean;
  }): Promise<string>;
  /** Seeds one real §6 proposal row (owner-scoped, no pin) and returns its id. */
  seedReviewedAction(ownerUserId: string): Promise<string>;
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
    companyName: "MT065 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT065 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC1 scope-switch person:
 * one human, two companies. `a1-other` is the same-team teammate whose reads
 * must never see a1-member's notifications (AC2/AC3).
 */
const HUMAN_PLAN: readonly {
  identity: OpenMuseActivityIdentity;
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

export async function createOpenMuseActivityFixture(): Promise<OpenMuseActivityFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt065-${randomUUID().slice(0, 8)}`;
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
        // then the anchors, then the tenancy scaffold, then the users.
        await setupDatabase.execute(
          sql`delete from openmuse_notification_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from openmuse_delivery_binding_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from openmuse_reviewed_action_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from openmuse_reviewed_actions where owner_user_id like ${`${prefix}%`}`,
        );
        await setupDatabase
          .delete(openmuseNotifications)
          .where(like(openmuseNotifications.userId, `${prefix}%`));
        await setupDatabase
          .delete(deliveryBindings)
          .where(like(deliveryBindings.ownerUserId, `${prefix}%`));
        await setupDatabase
          .delete(channels)
          .where(like(channels.id, `${prefix}%`));
        await setupDatabase.delete(agents).where(like(agents.id, `${prefix}%`));
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
        "OpenMuse activity fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT065 ${planned.identity}`,
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
        const identity = request.headers.get("x-mt065-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // Delivery anchors: one real agent + one real channel the seeded
    // delivery_bindings rows hang on (FK-faithful, no orphan shortcuts).
    const agentId = id("agent-anchor");
    const channelId = id("channel-anchor");
    await platform.insert(agents).values({
      id: agentId,
      name: `MT065 ${prefix} anchor agent`,
      type: "built_in",
      configuration: {},
    });
    await platform.insert(channels).values({
      id: channelId,
      name: `MT065 ${prefix} anchor channel`,
      description: "MT065 fixture delivery anchor",
    });

    // The production row seam: openmuse_notifications / delivery_bindings
    // rows on the platform channel, exactly the projection the service's rows
    // interface names.
    const rows = {
      async findOwnedNotification(ownerUserId, notificationId) {
        const [row] = await platform
          .select()
          .from(openmuseNotifications)
          .where(
            and(
              eq(openmuseNotifications.id, notificationId),
              eq(openmuseNotifications.userId, ownerUserId),
            ),
          )
          .limit(1);
        return row
          ? {
              id: row.id,
              eventKind: row.eventKind,
              title: row.title,
              detail: row.detail,
              createdAt: row.createdAt,
            }
          : null;
      },
      async listNotificationsByIds(ownerUserId, notificationIds) {
        if (notificationIds.length === 0) return [];
        const found = await platform
          .select()
          .from(openmuseNotifications)
          .where(
            and(
              inArray(openmuseNotifications.id, [...notificationIds]),
              eq(openmuseNotifications.userId, ownerUserId),
            ),
          );
        return found.map((row) => ({
          id: row.id,
          eventKind: row.eventKind,
          title: row.title,
          detail: row.detail,
          createdAt: row.createdAt,
        }));
      },
      async findOwnedBinding(ownerUserId, bindingId) {
        const [row] = await platform
          .select()
          .from(deliveryBindings)
          .where(
            and(
              eq(deliveryBindings.id, bindingId),
              eq(deliveryBindings.ownerUserId, ownerUserId),
            ),
          )
          .limit(1);
        return row
          ? {
              id: row.id,
              transport: row.transport,
              enabled: row.enabled,
            }
          : null;
      },
    };

    // MT064 pin path for the aggregation source: the real service over the
    // same platform rows; its decision seam is unreachable on the pin path
    // (honest boundary — this suite never decides through it).
    const reviewedRows: OpenMuseReviewedActionTenancyRows = {
      async findOwnedAction(ownerUserId, actionId) {
        const rowsFound = (await platform.execute(
          sql`select id, kind, status, account_email, created_at from openmuse_reviewed_actions where id = ${actionId} and owner_user_id = ${ownerUserId} limit 1`,
        )) as unknown as Array<{
          id: string;
          kind: string;
          status: string;
          account_email: string;
          created_at: Date;
        }>;
        const row = rowsFound[0];
        return row
          ? {
              id: row.id,
              kind: row.kind,
              status: row.status,
              accountEmail: row.account_email,
              createdAt: new Date(row.created_at),
            }
          : null;
      },
      async listActionsByIds() {
        throw new Error("MT065 fixture: reviewed list is not wired here");
      },
    };
    const reviewedTenancy = createOpenMuseReviewedActionTenancyService({
      data,
      operator,
      rows: reviewedRows,
      decisions: {
        decide: async () => {
          throw new Error("MT065 fixture: decide is not wired here");
        },
        cancel: async () => {
          throw new Error("MT065 fixture: cancel is not wired here");
        },
        receiptOf: async () => {
          throw new Error("MT065 fixture: receiptOf is not wired here");
        },
      },
      audit: async () => {
        throw new Error("MT065 fixture: audit is not wired here");
      },
    });

    let disposed = false;
    const fixture: OpenMuseActivityFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createOpenMuseActivityTenancyService({
        data,
        operator,
        rows,
      }),
      reviewedTenancy,
      anchor: { channelId, agentId },

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt065-fixture.invalid/scope", {
          headers: {
            "x-mt065-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      async seedNotification(input) {
        const notificationId = `${prefix}-notif-${randomUUID().slice(0, 8)}`;
        await platform.insert(openmuseNotifications).values({
          id: notificationId,
          userId: input.ownerUserId,
          taskId: `${prefix}-task`,
          eventKind: input.eventKind ?? "task.succeeded",
          attemptKey: `att-${notificationId}`,
          title: input.title,
          detail: input.detail ?? null,
        });
        return notificationId;
      },

      async seedBinding(input) {
        const bindingId = `${prefix}-binding-${randomUUID().slice(0, 8)}`;
        await platform.insert(deliveryBindings).values({
          id: bindingId,
          ownerUserId: input.ownerUserId,
          channelId,
          agentId,
          threadId: `${prefix}-thread`,
          transport: input.transport ?? "sms",
          identity: `identity-${bindingId}`,
          realm: "test",
          address: `+1000000${bindingId.length}`,
          enabled: input.enabled ?? true,
        });
        return bindingId;
      },

      async seedReviewedAction(ownerUserId) {
        // A real §6 row shape (awaiting_review mail proposal) — the pin face
        // (MT064) is what binds it to a scope.
        const actionId = `openmuse-reviewed-action-${randomUUID()}`;
        await platform.execute(
          sql`insert into openmuse_reviewed_actions (id, owner_user_id, kind, canonical_payload, payload_hash, account_email, connection_generation, status, expires_at, attachment_version_ids) values (${actionId}, ${ownerUserId}, 'mail', ${JSON.stringify({ to: "x@example.invalid" })}, ${`hash-${actionId}`}, ${`${ownerUserId}@example.invalid`}, 1, 'awaiting_review', now() + interval '30 minutes', '[]'::jsonb)`,
        );
        return actionId;
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
