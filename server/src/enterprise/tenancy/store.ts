import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
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
  selectTenant(request: Request): string | null;
  selectWorkspace(request: Request): string | null;
}

const issuedScopes = new WeakSet<object>();

export function assertTrustedScope(scope: PlatformScope): void {
  if (!scope || typeof scope !== "object" || !issuedScopes.has(scope)) {
    throw new Error("UNVERIFIED_SCOPE");
  }
}

export function createScopeResolver(
  database: DirectoryDatabase,
  options: ScopeResolverOptions,
): ScopeResolver {
  assertDirectoryDatabase(database);
  return {
    async resolve(request) {
      const identity = await options.authenticate(request);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const tenantId = options.selectTenant(request);
      const workspaceId = options.selectWorkspace(request);
      if (!tenantId || !workspaceId) throw new Error("TENANT_REQUIRED");

      const scope = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true), set_config('app.tenant_id', ${tenantId}, true)`,
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
  };
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
