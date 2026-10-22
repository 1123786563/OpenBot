/**
 * MT064 fixture (Issue #107): OpenMuse reviewed-action proposal/receipt
 * tenancy.
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows, and
 * hands the test suite:
 *   - the real `createOpenMuseReviewedActionTenancyService` (the module under
 *     test) over verified restricted channels;
 *   - the REAL `createOpenMuseReviewedActionService` (the authority the tenancy
 *     face delegates decide/cancel/receiptOf to — zero decision semantics in
 *     the fixture) over the production drizzle rows on the platform channel,
 *     with a counting fake executor so AC4 can pin zero provider dials;
 *   - the REAL MT078 `recordTenantAuditEvent` bound to the operator channel as
 *     the audit seam (business domain);
 *   - a propose seam through the real service (proposals get real §6 rows);
 *   - the real MT006 revocation (`suspendMembership`).
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association RLS, the §6 decision claim and audit writes all execute
 * against real rows under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import { openmuseReviewedActions } from "../../../src/db/schema/openmuse";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  recordTenantAuditEvent,
  type TenantAuditEventInput,
} from "../../../src/enterprise/tenancy/audit-domains";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createOpenMuseReviewedActionTenancyService,
  type OpenMuseReviewedActionTenancyRows,
  type ScopedReviewedActionRecord,
  type ScopedReviewedReceipt,
} from "../../../src/enterprise/tenancy/openmuse-reviewed-action-tenancy";
import {
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createOpenMuseReviewedActionService,
  type OpenMuseReviewedActionService,
} from "../../../src/openmuse-reviewed-actions/service";
import { createOpenMuseReviewedActionRows } from "../../../src/openmuse-reviewed-actions/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT064 suite shares. */
export type OpenMuseReviewedIdentity =
  | "a1-member"
  | "a1-other"
  | "a1a2-member"
  | "b1-member"
  | "multi-company";

export interface OpenMuseReviewedActionsFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The module under test, over verified restricted channels. */
  readonly service: ReturnType<
    typeof createOpenMuseReviewedActionTenancyService
  >;
  /** The real reviewed-actions authority (propose happens here, decide is delegated). */
  readonly reviewed: OpenMuseReviewedActionService;
  /** The fake executor's live dial count (AC4's zero-dial probe). */
  readonly executorDials: () => number;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: OpenMuseReviewedIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /** Proposes a real §6 awaiting_review row for this owner and returns its id. */
  proposeFor(
    ownerUserId: string,
    input?: { readonly kind?: "mail" | "calendar"; readonly payload?: unknown },
  ): Promise<string>;
  /** Setup-channel probe: the action row's live status (null = gone). */
  actionStatus(actionId: string): Promise<string | null>;
  /** Setup-channel read of the tenant audit rows for one target. */
  auditEventsFor(
    tenantId: string,
    targetId: string,
  ): Promise<
    Array<{
      domain: string;
      eventType: string;
      actorId: string;
      payload: Record<string, unknown>;
    }>
  >;
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
    companyName: "MT064 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT064 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `multi-company` is the AC1 cross-company person:
 * one human, two companies. `a1-other` is the same-team teammate whose reads
 * must never see a1-member's proposals (AC1).
 */
const HUMAN_PLAN: readonly {
  identity: OpenMuseReviewedIdentity;
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

export async function createOpenMuseReviewedActionsFixture(): Promise<OpenMuseReviewedActionsFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt064-${randomUUID().slice(0, 8)}`;
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
        // Children first (association rows cascade on the action FK), then the
        // audit rows, then the tenancy scaffold, then the users.
        await setupDatabase.execute(
          sql`delete from openmuse_reviewed_action_scopes where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from openmuse_reviewed_actions where owner_user_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_audit_events where tenant_id like ${`${prefix}%`}`,
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
        "OpenMuse reviewed-actions fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding: users, then principals bound to them.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT064 ${planned.identity}`,
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
        const identity = request.headers.get("x-mt064-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    // The production row seam: openmuse_reviewed_actions rows on the platform
    // channel, exactly the projection the tenancy service's rows interface
    // names.
    const actionViewOf = (
      row: typeof openmuseReviewedActions.$inferSelect,
    ): ScopedReviewedActionRecord => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      accountEmail: row.accountEmail,
      createdAt: row.createdAt,
    });
    const rows: OpenMuseReviewedActionTenancyRows = {
      async findOwnedAction(ownerUserId, actionId) {
        const [row] = await platform
          .select()
          .from(openmuseReviewedActions)
          .where(
            and(
              eq(openmuseReviewedActions.id, actionId),
              eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            ),
          )
          .limit(1);
        return row ? actionViewOf(row) : null;
      },
      async listActionsByIds(ownerUserId, actionIds) {
        if (actionIds.length === 0) return [];
        const found = await platform
          .select()
          .from(openmuseReviewedActions)
          .where(
            and(
              inArray(openmuseReviewedActions.id, [...actionIds]),
              eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            ),
          );
        const byId = new Map(found.map((row) => [row.id, actionViewOf(row)]));
        return [...actionIds].flatMap((actionId) => {
          const view = byId.get(actionId);
          return view ? [view] : [];
        });
      },
    };

    // The §6 authority over its production drizzle rows, with a counting fake
    // executor: decision semantics are the real service's, only the provider
    // dial is fake (R01's own reference shape).
    let dials = 0;
    const reviewed = createOpenMuseReviewedActionService({
      rows: createOpenMuseReviewedActionRows(platform),
      executor: {
        async execute() {
          dials += 1;
          return {
            outcome: "succeeded",
            providerRef: `fake-${randomUUID()}`,
            fingerprint: `fp-${randomUUID()}`,
          };
        },
      },
    });
    // The tenancy service delegates decide/cancel/receiptOf to the authority
    // and audit to the real MT078 writer (business domain).
    const service = createOpenMuseReviewedActionTenancyService({
      data,
      operator,
      rows,
      decisions: {
        decide: async (ownerUserId, actionId, decision) =>
          (await reviewed.decide(ownerUserId, actionId, decision)) ?? null,
        cancel: async (ownerUserId, actionId) =>
          (await reviewed.cancel(ownerUserId, actionId)) ?? null,
        receiptOf: async (actionId): Promise<ScopedReviewedReceipt | null> => {
          const receipt = await reviewed.receiptOf(actionId);
          return receipt
            ? {
                attemptId: receipt.attemptId,
                providerRef: receipt.providerRef,
                decidedAt: receipt.decidedAt,
                attemptedAt: receipt.attemptedAt,
                completedAt: receipt.completedAt,
              }
            : null;
        },
      },
      audit: async (event) =>
        recordTenantAuditEvent(operator, {
          tenantId: event.tenantId,
          domain: "business",
          eventType: event.eventType,
          actorId: event.actorId,
          targetId: event.targetId,
          payload: event.payload,
        } satisfies TenantAuditEventInput),
    });

    let disposed = false;
    const fixture: OpenMuseReviewedActionsFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service,
      reviewed,
      executorDials: () => dials,
      proposeFor: async (ownerUserId, input) => {
        const proposal = await reviewed.propose(ownerUserId, {
          kind: input?.kind ?? "mail",
          payload: input?.payload ?? {
            to: `${ownerUserId}@example.invalid`,
            subject: `MT064 proposal ${randomUUID()}`,
            body: "tenancy fixture proposal",
          },
          accountEmail: `${ownerUserId}@example.invalid`,
          connectionGeneration: 1,
        });
        return proposal.id;
      },
      async actionStatus(actionId) {
        const [row] = await platform
          .select({ status: openmuseReviewedActions.status })
          .from(openmuseReviewedActions)
          .where(eq(openmuseReviewedActions.id, actionId))
          .limit(1);
        return row?.status ?? null;
      },
      async auditEventsFor(tenantId, targetId) {
        // bun-sql 的 execute 直接返回行数组（无 .rows 包装）。
        const found = (await setupDatabase.execute(
          sql`select domain, event_type, actor_id, payload from enterprise_audit_events where tenant_id = ${tenantId} and target_id = ${targetId} order by created_at`,
        )) as unknown as Array<{
          domain: string;
          event_type: string;
          actor_id: string;
          payload: Record<string, unknown>;
        }>;
        return found.map((row) => ({
          domain: row.domain,
          eventType: row.event_type,
          actorId: row.actor_id,
          payload: row.payload,
        }));
      },

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt064-fixture.invalid/scope", {
          headers: {
            "x-mt064-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
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
