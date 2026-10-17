import { and, eq, sql } from "drizzle-orm";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../../db/schema/core";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import { createAuthz } from "../authz/service";
import type {
  PlatformScope,
  ResourceReader,
  ResourceView,
  ScopeResolver,
} from "../contracts";
import {
  assertDataDatabase,
  assertDirectoryDatabase,
  type DataDatabase,
  type DirectoryDatabase,
} from "./connections";

/** A result supplied only by the server's existing authenticated-session layer. */
export interface AuthenticatedRequestIdentity {
  readonly actorId: string;
  readonly entrypoint: PlatformScope["entrypoint"];
}

export interface ScopeResolverOptions {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  /** Tenant/workspace values are selectors only; the database membership determines authority. */
  selectTenant?(request: Request): string | null;
  selectWorkspace?(request: Request): string | null;
  data?: DataDatabase;
}

const issuedScopes = new WeakSet<object>();

export function assertTrustedScope(scope: PlatformScope): void {
  if (!scope || typeof scope !== "object" || !issuedScopes.has(scope)) {
    throw new Error("UNVERIFIED_SCOPE");
  }
}

export function requireAuthenticatedIdentity<
  T extends AuthenticatedRequestIdentity,
>(identity: T | null): T {
  if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
  return identity;
}

async function mapStorageFaults<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "DATA_DATABASE_UNAVAILABLE")
      throw error;
    // Runtime driver/infrastructure faults on the storage hot path surface as
    // unavailability (503) rather than raw 500s; the original fault rides on
    // `cause` for diagnostics — and leaves one structured log, so real
    // faults (including authorization regressions) are never silent (OCR R10).
    console.error({
      error: "DATA_DATABASE_FAULT",
      cause:
        error instanceof Error
          ? ((error as { code?: unknown }).code ?? error.constructor.name)
          : typeof error,
    });
    throw Object.assign(new Error("DATA_DATABASE_UNAVAILABLE"), {
      cause: error,
    });
  }
}

export function createScopeResolver(
  database: DirectoryDatabase,
  options: ScopeResolverOptions,
): ScopeResolver {
  assertDirectoryDatabase(database);
  return {
    async resolve(request) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      const tenantId = options.selectTenant?.(request);
      const workspaceId = options.selectWorkspace?.(request);
      // MT005 (issue #48): selectors are required and explicitly rejected when
      // missing — never defaulted to a first team or a default company, and
      // the two failure modes get distinct codes (was: TENANT_REQUIRED for
      // both, the dual meaning the seam report flags).
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");

      const scope = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true), set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
        );
        const [member] = await tx
          .select({
            principalId: enterprisePrincipals.id,
            tenantId: enterpriseTenants.id,
            tenantStatus: enterpriseTenants.status,
            principalStatus: enterprisePrincipals.status,
            memberStatus: enterpriseMemberships.status,
            memberEpoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(
            and(
              eq(enterprisePrincipals.userId, identity.actorId),
              eq(enterpriseMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (
          member?.tenantStatus !== "active" ||
          member.principalStatus !== "active" ||
          member.memberStatus !== "active"
        ) {
          throw new Error("TENANT_FORBIDDEN");
        }
        // MT005 (issue #48): team eligibility. The selected workspace must
        // carry an active workspace-membership row for this principal — the
        // server-side fact, not the header value, decides (acceptance 3/4/5).
        // A missing row, a suspended row, and a nonexistent workspace are
        // deliberately indistinguishable here: no existence leak.
        const [teamMembership] = await tx
          .select({ status: enterpriseWorkspaceMemberships.status })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
              eq(
                enterpriseWorkspaceMemberships.principalId,
                member.principalId,
              ),
            ),
          )
          .limit(1);
        if (teamMembership?.status !== "active") {
          throw new Error("WORKSPACE_FORBIDDEN");
        }
        return Object.freeze({
          tenantId,
          workspaceId,
          principalId: member.principalId,
          actorId: identity.actorId,
          memberEpoch: member.memberEpoch,
          aclEpoch: 1,
          entrypoint: identity.entrypoint,
        } satisfies PlatformScope);
      });
      issuedScopes.add(scope);
      return scope;
    },
    async resolveForThread(request, threadId) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("INVALID_THREAD_ID");
      }
      const data = options.data;
      if (!data) throw new Error("DATA_DATABASE_UNAVAILABLE");
      try {
        assertDataDatabase(data);
      } catch {
        throw new Error("DATA_DATABASE_UNAVAILABLE");
      }

      const candidates = await mapStorageFaults(() =>
        database.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          await tx.execute(
            sql`select set_config('app.user_id', ${identity.actorId}, true)`,
          );
          return tx
            .select({
              tenantId: enterpriseMemberships.tenantId,
              principalId: enterpriseMemberships.principalId,
              memberEpoch: enterpriseMemberships.epoch,
            })
            .from(enterpriseMemberships)
            .innerJoin(
              enterprisePrincipals,
              eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
            )
            .innerJoin(
              enterpriseTenants,
              eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
            )
            .where(
              and(
                eq(enterprisePrincipals.userId, identity.actorId),
                eq(enterprisePrincipals.status, "active"),
                eq(enterpriseMemberships.status, "active"),
                eq(enterpriseTenants.status, "active"),
              ),
            );
        }),
      );

      const matches: Array<{
        tenantId: string;
        workspaceId: string;
        principalId: string;
        candidate: (typeof candidates)[number];
      }> = [];
      // Per-request data-transaction fan-out is capped: a member of many
      // tenants must not hold one pool connection per tenant concurrently
      // (OCR R10 performance).
      const CANDIDATE_BATCH = 4;
      for (
        let batchStart = 0;
        batchStart < candidates.length;
        batchStart += CANDIDATE_BATCH
      ) {
        await Promise.all(
          candidates
            .slice(batchStart, batchStart + CANDIDATE_BATCH)
            .map(async (candidate) => {
              const found = await mapStorageFaults(() =>
                data.transaction(async (tx) => {
                  await tx.execute(
                    sql`set transaction isolation level read committed`,
                  );
                  await tx.execute(sql`set local lock_timeout = '2s'`);
                  await tx.execute(sql`set local statement_timeout = '5s'`);
                  await tx.execute(
                    sql`select set_config('app.tenant_id', ${candidate.tenantId}, true), set_config('app.principal_id', ${candidate.principalId}, true), set_config('app.user_id', ${identity.actorId}, true)`,
                  );
                  const conversations = await tx
                    .select({
                      tenantId: enterpriseConversations.tenantId,
                      workspaceId: enterpriseConversations.workspaceId,
                      principalId: enterpriseConversations.principalId,
                      tenantStatus: enterpriseTenants.status,
                    })
                    .from(enterpriseConversations)
                    .innerJoin(
                      enterpriseTenants,
                      eq(
                        enterpriseTenants.id,
                        enterpriseConversations.tenantId,
                      ),
                    )
                    .innerJoin(
                      enterpriseMemberships,
                      and(
                        eq(
                          enterpriseMemberships.tenantId,
                          enterpriseConversations.tenantId,
                        ),
                        eq(
                          enterpriseMemberships.principalId,
                          enterpriseConversations.principalId,
                        ),
                      ),
                    )
                    .innerJoin(
                      enterprisePrincipals,
                      eq(
                        enterprisePrincipals.id,
                        enterpriseMemberships.principalId,
                      ),
                    )
                    .innerJoin(
                      enterpriseWorkspaces,
                      and(
                        eq(
                          enterpriseWorkspaces.tenantId,
                          enterpriseConversations.tenantId,
                        ),
                        eq(
                          enterpriseWorkspaces.id,
                          enterpriseConversations.workspaceId,
                        ),
                      ),
                    )
                    .where(
                      and(
                        eq(enterpriseConversations.threadId, threadId),
                        eq(enterpriseTenants.status, "active"),
                        eq(enterpriseMemberships.status, "active"),
                        eq(enterpriseMemberships.epoch, candidate.memberEpoch),
                        eq(enterprisePrincipals.status, "active"),
                        eq(enterprisePrincipals.userId, identity.actorId),
                        eq(
                          enterpriseMemberships.principalId,
                          candidate.principalId,
                        ),
                      ),
                    )
                    .limit(2);
                  const legacy = await tx
                    .select({
                      actorId: intelligenceChannelMappings.userId,
                      threadId: intelligenceChannelMappings.threadId,
                      channelId: intelligenceChannelMappings.channelId,
                      memberId: channelMemberships.userId,
                      channelDeletedAt: channels.deletedAt,
                      tenantId: enterpriseResources.tenantId,
                      workspaceId: enterpriseResources.workspaceId,
                      principalId: enterpriseMemberships.principalId,
                      tenantStatus: enterpriseTenants.status,
                      principalStatus: enterprisePrincipals.status,
                      membershipStatus: enterpriseMemberships.status,
                      memberEpoch: enterpriseMemberships.epoch,
                      resourceKind: enterpriseResources.kind,
                      resourceStatus: enterpriseResources.status,
                      grantPrincipalId: enterpriseResourceGrants.principalId,
                      grantAction: enterpriseResourceGrants.action,
                    })
                    .from(intelligenceChannelMappings)
                    .innerJoin(
                      channels,
                      and(
                        eq(channels.id, intelligenceChannelMappings.channelId),
                        sql`${channels.deletedAt} is null`,
                      ),
                    )
                    .innerJoin(
                      channelMemberships,
                      and(
                        eq(channelMemberships.channelId, channels.id),
                        eq(channelMemberships.userId, identity.actorId),
                      ),
                    )
                    .innerJoin(
                      enterpriseResources,
                      and(
                        eq(enterpriseResources.tenantId, candidate.tenantId),
                        eq(
                          enterpriseResources.id,
                          intelligenceChannelMappings.channelId,
                        ),
                        eq(enterpriseResources.kind, "channel"),
                        eq(enterpriseResources.status, "active"),
                      ),
                    )
                    .innerJoin(
                      enterpriseResourceGrants,
                      and(
                        eq(
                          enterpriseResourceGrants.tenantId,
                          enterpriseResources.tenantId,
                        ),
                        eq(
                          enterpriseResourceGrants.resourceId,
                          enterpriseResources.id,
                        ),
                        eq(
                          enterpriseResourceGrants.principalId,
                          candidate.principalId,
                        ),
                        eq(enterpriseResourceGrants.action, "read"),
                      ),
                    )
                    .innerJoin(
                      enterpriseMemberships,
                      and(
                        eq(enterpriseMemberships.tenantId, candidate.tenantId),
                        eq(
                          enterpriseMemberships.principalId,
                          candidate.principalId,
                        ),
                      ),
                    )
                    .innerJoin(
                      enterprisePrincipals,
                      eq(
                        enterprisePrincipals.id,
                        enterpriseMemberships.principalId,
                      ),
                    )
                    .innerJoin(
                      enterpriseTenants,
                      eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
                    )
                    .innerJoin(
                      enterpriseWorkspaces,
                      and(
                        eq(
                          enterpriseWorkspaces.tenantId,
                          enterpriseResources.tenantId,
                        ),
                        eq(
                          enterpriseWorkspaces.id,
                          enterpriseResources.workspaceId,
                        ),
                      ),
                    )
                    .where(
                      and(
                        eq(
                          intelligenceChannelMappings.userId,
                          identity.actorId,
                        ),
                        eq(intelligenceChannelMappings.threadId, threadId),
                        eq(enterprisePrincipals.userId, identity.actorId),
                        eq(enterprisePrincipals.status, "active"),
                        eq(enterpriseMemberships.status, "active"),
                        eq(enterpriseMemberships.epoch, candidate.memberEpoch),
                        eq(enterpriseTenants.status, "active"),
                      ),
                    )
                    .limit(2);
                  return { conversations, legacy };
                }),
              );
              matches.push(
                ...found.conversations
                  .filter((match) => match.tenantStatus === "active")
                  .map((match) => ({ ...match, candidate })),
              );
              matches.push(
                ...found.legacy
                  .filter(
                    (match) =>
                      match.actorId === identity.actorId &&
                      match.threadId === threadId &&
                      match.memberId === identity.actorId &&
                      match.channelDeletedAt === null &&
                      match.tenantId === candidate.tenantId &&
                      match.principalId === candidate.principalId &&
                      match.tenantStatus === "active" &&
                      match.principalStatus === "active" &&
                      match.membershipStatus === "active" &&
                      match.memberEpoch === candidate.memberEpoch &&
                      match.resourceKind === "channel" &&
                      match.resourceStatus === "active" &&
                      match.grantPrincipalId === candidate.principalId &&
                      match.grantAction === "read",
                  )
                  .map((match) => ({ ...match, candidate })),
              );
            }),
        );
      }

      const matched = uniqueThreadMatch(matches);
      const scope = Object.freeze({
        tenantId: matched.tenantId,
        workspaceId: matched.workspaceId,
        principalId: matched.principalId,
        actorId: identity.actorId,
        memberEpoch: matched.candidate.memberEpoch,
        aclEpoch: 1,
        entrypoint: identity.entrypoint,
      } satisfies PlatformScope);
      issuedScopes.add(scope);
      return scope;
    },
  };
}

export function uniqueThreadMatch<T>(rows: readonly T[]): T {
  if (rows.length === 0) throw new Error("THREAD_SCOPE_NOT_FOUND");
  if (rows.length !== 1) throw new Error("THREAD_SCOPE_AMBIGUOUS");
  return rows[0] as T;
}

export function createResourceReader(database: DataDatabase): ResourceReader {
  assertDataDatabase(database);
  const authz = createAuthz();
  return {
    async readAuthorizedResource(scope, resourceId): Promise<ResourceView> {
      assertTrustedScope(scope);
      return database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        for (const key of readLockKeys(scope, resourceId)) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );
        const [membership] = await tx
          .select({
            epoch: enterpriseMemberships.epoch,
            role: enterpriseMemberships.role,
            memberStatus: enterpriseMemberships.status,
            principalStatus: enterprisePrincipals.status,
            tenantStatus: enterpriseTenants.status,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
              eq(enterprisePrincipals.userId, scope.actorId),
            ),
          )
          .limit(1);
        if (
          membership?.memberStatus !== "active" ||
          membership.principalStatus !== "active" ||
          membership.tenantStatus !== "active" ||
          membership.epoch !== scope.memberEpoch
        ) {
          throw new Error("SCOPE_REVOKED");
        }
        const [row] = await tx
          .select({
            id: enterpriseResources.id,
            tenantId: enterpriseResources.tenantId,
            workspaceId: enterpriseResources.workspaceId,
            kind: enterpriseResources.kind,
            displayName: enterpriseResources.displayName,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            status: enterpriseResources.status,
            policyRevision: enterpriseTenants.policyRevision,
            granted: enterpriseResourceGrants.principalId,
          })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseResources.tenantId),
          )
          .leftJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
        if (row?.status !== "active" || !row.granted) {
          throw new Error("RESOURCE_NOT_FOUND");
        }
        const allowed = await authz.check({
          scope,
          action: "read",
          resource: {
            id: row.id,
            tenantId: row.tenantId,
            workspaceId: row.workspaceId,
            principalId: scope.principalId,
            revision: row.revision,
            aclEpoch: row.aclEpoch,
            policyRevision: row.policyRevision,
            active: row.status === "active",
            locallyAllowed: Boolean(row.granted),
          },
        });
        if (!allowed) throw new Error("RESOURCE_NOT_FOUND");
        return {
          resourceId: row.id,
          resourceType: row.kind,
          revision: row.revision,
          displayName: row.displayName,
        };
      });
    },
  };
}

function readLockKeys(scope: PlatformScope, resourceId: string): string[] {
  const key = (kind: string, ...ids: string[]) =>
    JSON.stringify(["enterprise", kind, ...ids]);
  return [
    key("tenant", scope.tenantId),
    key("principal", scope.principalId),
    key("membership", scope.tenantId, scope.principalId),
    key("resource", scope.tenantId, resourceId),
  ];
}
