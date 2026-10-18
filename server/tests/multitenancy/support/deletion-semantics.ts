/**
 * MT067 fixture (Issue #110): the dual-track deletion-semantics domain.
 *
 * Reuses the MT076 people-lifecycle fixture base (isolation matrix, verified
 * restricted channels, the REAL MT006 admin authorizer, extra target users)
 * and adds the seams this suite needs:
 *   - the real §9 account-deletion store (`createOpenMuseAccountDeletionStore`)
 *     over the platform channel — Track B's fence is the production store,
 *     never a test double;
 *   - platform-channel §9 marker probes (Track A must never write one);
 *   - restricted-channel seeding for the scoped facts a cleanup invalidates:
 *     MT060 task-scope associations, MT027 personal credentials, resource
 *     grants over real resources (workspace membership rows seed like the
 *     isolation fixture materializes the matrix);
 *   - ongoing-access probes through the REAL scope resolver + resource
 *     reader (`requestAs`), so AC3's invalidation is observed on the
 *     production gate, not asserted.
 *
 * Nothing here mocks the authorization path: scope issuance, membership
 * checks, association/grant/credential RLS all execute against real rows
 * under the restricted `ob_ent_*` PostgreSQL roles.
 */

import { eq, sql } from "drizzle-orm";
import type { Database } from "../../../src/db/client";
import { createDatabase } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import { enterprisePrincipals } from "../../../src/db/schema/enterprise-tenancy";
import { openmuseTasks } from "../../../src/db/schema/openmuse";
import { openmuseAccountDeletions } from "../../../src/db/schema/openmuse-deletion";
import { openmuseTaskScopes } from "../../../src/db/schema/openmuse-task-tenancy";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
} from "../../../src/enterprise/tenancy/workspace-admin";
import { createOpenMuseAccountDeletionStore } from "../../../src/openmuse-deletion/store";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  createPeopleLifecycleFixture,
  type PeopleLifecycleAdminIdentity,
} from "./people-lifecycle";

export type DeletionCompanyKey = "company-a" | "company-b";

/** Identity accepted by `adminContextOf` (matrix + the base's `b-admin`). */
export type DeletionAdminIdentity = PeopleLifecycleAdminIdentity;

type PeopleLifecycleBase = Awaited<
  ReturnType<typeof createPeopleLifecycleFixture>
>;

export interface DeletionSemanticsFixture {
  readonly isolation: PeopleLifecycleBase["isolation"];
  readonly operator: PeopleLifecycleBase["operator"];
  readonly directory: PeopleLifecycleBase["directory"];
  /** Platform channel: §9 marker rows (no enterprise RLS on that table). */
  readonly platform: Database;
  /** The REAL §9 account-deletion store (Track B's fence primitive). */
  readonly deletionStore: ReturnType<typeof createOpenMuseAccountDeletionStore>;
  /**
   * Issues a trusted CompanyAdminContext through the real MT006 authorizer
   * (directory transaction, tenant_admin revalidation, WeakSet trust).
   */
  adminContextOf(
    identity: DeletionAdminIdentity,
    companyKey: DeletionCompanyKey,
  ): Promise<CompanyAdminContext>;
  /** One extra global user (+ principal) with no membership anywhere. */
  targetUser(key: string): Promise<{ userId: string; principalId: string }>;
  /**
   * Seeds one openmuse_tasks root row (platform channel) plus its MT060
   * association row through the REAL restricted operator channel (pins
   * tenant + principal — the association INSERT policy's gate).
   */
  seedTaskScope(input: {
    taskId: string;
    tenantId: string;
    workspaceId: string;
    principalId: string;
    userId: string;
  }): Promise<void>;
  /** Seeds one personal credential owned by the principal (operator channel). */
  seedPersonalCredential(input: {
    tenantId: string;
    credentialId: string;
    ownerPrincipalId: string;
    target: string;
  }): Promise<void>;
  /**
   * Seeds one resource row + a read grant to the principal (operator
   * channel) — the stand-in for any grant-gated scope fact (files, KB).
   */
  seedResourceGrant(input: {
    tenantId: string;
    workspaceId: string;
    resourceId: string;
    principalId: string;
  }): Promise<void>;
  /** Setup-channel probe: the association row of one task, if any. */
  taskScopeRowOf(
    taskId: string,
  ): Promise<
    { tenantId: string; workspaceId: string; principalId: string } | undefined
  >;
  /** Setup-channel probe: §9 marker row count for one user. */
  deletionMarkerCountOf(userId: string): Promise<number>;
  /** Setup-channel probe: the raw users row of one user id. */
  userRowOf(
    userId: string,
  ): Promise<{ id: string; email: string; name: string } | undefined>;
  /** Setup-channel probe: the principal row status (global identity fact). */
  principalStatusOf(principalId: string): Promise<string | undefined>;
  /**
   * Offline fact mutation through the dedicated setup connection: restores a
   * suspended company membership to active with an exact epoch — the
   * disclosed stand-in (workspace-scope's setCompanyMembershipRole
   * precedent) used to re-arm a fixture identity after a drift test.
   */
  restoreCompanyMembership(
    tenantId: string,
    principalId: string,
    epoch: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createDeletionSemanticsFixture(): Promise<DeletionSemanticsFixture> {
  const base = await createPeopleLifecycleFixture();
  const isolation = base.isolation;

  // Platform channel for the §9 fence store + marker probes (the same
  // database; openmuse_account_deletions carries no enterprise RLS).
  const platform = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 2 });
  const deletionStore = createOpenMuseAccountDeletionStore(platform);

  // The real MT006 admin authorizer over the verified directory connection
  // (same wiring as the base fixture — sessions bound server-side).
  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string }
  >();
  const authorizer = createCompanyAdminAuthorizer(base.directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
  });

  const tenantIdOf = (companyKey: DeletionCompanyKey) =>
    isolation.ids[companyKey];
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  return {
    isolation,
    operator: base.operator,
    directory: base.directory,
    platform,
    deletionStore,
    async adminContextOf(identity, companyKey) {
      const fact =
        identity === "b-admin"
          ? undefined
          : isolation.identities[
              identity as Exclude<DeletionAdminIdentity, "b-admin">
            ];
      const userId =
        identity === "b-admin"
          ? // The base fixture's company B admin id is deterministic from the
            // isolation prefix (see the people-lifecycle fixture).
            `${isolation.idPrefix}-user-b-admin`
          : fact?.userId;
      if (!userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${String(identity)}`);
      }
      const request = new Request("https://tests.invalid/admin-context", {
        headers: { "x-openbot-tenant": tenantIdOf(companyKey) },
      });
      sessions.set(request, { userId, tenantId: tenantIdOf(companyKey) });
      return authorizer.resolveAdminContext(request);
    },
    targetUser(key) {
      return base.lifecycleTargetUser(key);
    },
    async seedTaskScope(input) {
      // Root row: platform channel (openmuse_tasks has no enterprise RLS).
      await platform.insert(openmuseTasks).values({
        id: input.taskId,
        ownerUserId: input.userId,
        botId: "agent-legacy-mt067",
        kind: "agent",
      });
      // Association row: REAL restricted operator channel, pins tenant +
      // principal (the MT060 INSERT policy's gate) — not the setup channel.
      await isolation.queryRestricted(
        "operator",
        { tenantId: input.tenantId, principalId: input.principalId },
        "insert into openmuse_task_scopes (task_id, tenant_id, workspace_id, principal_id, user_id, bot_id, attribution) values ($1, $2, $3, $4, $5, 'agent-legacy-mt067', 'created')",
        [
          input.taskId,
          input.tenantId,
          input.workspaceId,
          input.principalId,
          input.userId,
        ],
      );
    },
    async seedPersonalCredential(input) {
      await isolation.queryRestricted(
        "operator",
        { tenantId: input.tenantId },
        "insert into enterprise_credentials (tenant_id, id, kind, classification, owner_principal_id, target, display, envelope, status) values ($1, $2, 'connection', 'personal', $3, $4, '{\"label\":\"MT067 test connection\"}', 'sealed-envelope-mt067', 'active')",
        [
          input.tenantId,
          input.credentialId,
          input.ownerPrincipalId,
          input.target,
        ],
      );
    },
    async seedResourceGrant(input) {
      await isolation.queryRestricted(
        "operator",
        { tenantId: input.tenantId },
        "insert into enterprise_resources (tenant_id, id, workspace_id, kind, display_name) values ($1, $2, $3, 'file', 'MT067 scoped file')",
        [input.tenantId, input.resourceId, input.workspaceId],
      );
      await isolation.queryRestricted(
        "operator",
        { tenantId: input.tenantId },
        "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values ($1, $2, $3, 'read')",
        [input.tenantId, input.resourceId, input.principalId],
      );
    },
    async taskScopeRowOf(taskId) {
      const [row] = await setup
        .select({
          tenantId: openmuseTaskScopes.tenantId,
          workspaceId: openmuseTaskScopes.workspaceId,
          principalId: openmuseTaskScopes.principalId,
        })
        .from(openmuseTaskScopes)
        .where(eq(openmuseTaskScopes.taskId, taskId))
        .limit(1);
      return row;
    },
    async deletionMarkerCountOf(userId) {
      const rows = await setup
        .select({ userId: openmuseAccountDeletions.userId })
        .from(openmuseAccountDeletions)
        .where(eq(openmuseAccountDeletions.userId, userId));
      return rows.length;
    },
    async userRowOf(userId) {
      const [row] = await setup
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row;
    },
    async principalStatusOf(principalId) {
      // Setup-channel oracle: the provisioned row's status (the directory
      // self-read visibility path is exercised by the MT002 suite).
      const [row] = await setup
        .select({ status: enterprisePrincipals.status })
        .from(enterprisePrincipals)
        .where(eq(enterprisePrincipals.id, principalId))
        .limit(1);
      return row?.status;
    },
    async restoreCompanyMembership(tenantId, principalId, epoch) {
      await setup.execute(sql`
        update enterprise_memberships
        set status = 'active', epoch = ${epoch}
        where tenant_id = ${tenantId} and principal_id = ${principalId}
      `);
    },
    async dispose() {
      await setup.$client.close();
      await platform.$client.close();
      await base.dispose();
    },
  };
}
