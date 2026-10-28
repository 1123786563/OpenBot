/**
 * Shared MT026 fixture (Issue #69, per-company SSO/SCIM isolation).
 *
 * Builds on the MT002 isolation matrix (companies A/B, the §11 identities) and
 * opens the verified restricted-role connections the MT026 services run under.
 * Company admin contexts come from the REAL MT006 authorizer
 * (`createCompanyAdminAuthorizer`) — no test double issues a trusted context.
 * The SCIM/SSO services under test are the real production modules over the
 * verified operator role; nothing here mocks the authorization path.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../../../src/db/client";
import { createDatabase } from "../../../src/db/client";
import { users } from "../../../src/db/schema";
import {
  enterpriseMemberships,
  enterprisePrincipals,
} from "../../../src/db/schema/enterprise-tenancy";
import {
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";

async function openVerified<T extends object>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  return verify(createDatabase(url, { max: 2 }) as Database);
}

import {
  createIdentityBindingService,
  type IdentityBindingService,
} from "../../../src/enterprise/tenancy/identity-binding";
import {
  type CompanyScopedDirectoryReconciler,
  createCompanyScopedDirectoryReconciler,
} from "../../../src/enterprise/tenancy/scim-directory";
import {
  type CompanySsoScimConfigService,
  createCompanySsoScimConfigService,
} from "../../../src/enterprise/tenancy/sso-scim-config";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
} from "../../../src/enterprise/tenancy/workspace-admin";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import {
  createIsolationFixture,
  type FixtureIdentity,
  type IsolationFixture,
} from "./fixture";

export type SsoScimCompanyKey = "company-a" | "company-b";

/**
 * Identity accepted by `adminContextOf`. Besides the matrix identities, the
 * fixture provisions one dedicated company B admin (`b-admin`) — the §11
 * matrix has its only tenant_admin in company A, and the MT026 fences need a
 * second company's admin to prove cross-company invisibility.
 */
export type SsoScimAdminIdentity = FixtureIdentity | "b-admin";

export interface SsoScimFixture {
  readonly isolation: IsolationFixture;
  readonly operator: OperatorDatabase;
  readonly directory: DirectoryDatabase;
  /** The real MT026 config service over the verified operator role. */
  readonly configService: CompanySsoScimConfigService;
  /** The real MT026 company-scoped directory reconciler. */
  readonly reconciler: CompanyScopedDirectoryReconciler;
  /** The real MT026 identity binding service. */
  readonly bindingService: IdentityBindingService;
  /**
   * Issues a trusted CompanyAdminContext for a fixture identity over one of
   * the fixture companies, through the real MT006 authorizer (directory
   * transaction, tenant_admin revalidation, WeakSet trust marking).
   */
  adminContextOf(
    identity: SsoScimAdminIdentity,
    companyKey: SsoScimCompanyKey,
  ): Promise<CompanyAdminContext>;
  /**
   * Provisions one extra global user (+ principal) for SCIM-target scenarios,
   * with no membership anywhere. The isolation cleanup removes it (same id
   * prefix).
   */
  scimTargetUser(key: string): Promise<{ userId: string; principalId: string }>;
  dispose(): Promise<void>;
}

export async function createSsoScimFixture(): Promise<SsoScimFixture> {
  const isolation = await createIsolationFixture("memberships");

  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    verifyOperatorDatabase,
  );
  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    verifyDirectoryDatabase,
  );
  const configService = createCompanySsoScimConfigService(operator);
  const reconciler = createCompanyScopedDirectoryReconciler({
    operator,
    directory,
  });
  const bindingService = createIdentityBindingService(operator);

  // The real MT006 admin authorizer over the verified directory connection;
  // sessions are bound server-side (WeakMap), the header only selects.
  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string }
  >();
  const authorizer = createCompanyAdminAuthorizer(directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
  });

  const tenantIdOf = (companyKey: SsoScimCompanyKey) =>
    isolation.ids[companyKey];

  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  // The dedicated company B admin: owner-path user + principal rows (same
  // path the isolation fixture provisions the matrix with — same id prefix,
  // so cleanup removes them) and a company membership written through the
  // verified operator role under the tenant pin (the INSERT policy's gate).
  const bAdminUserId = `${isolation.idPrefix}-user-b-admin`;
  const bAdminPrincipalId = `${isolation.idPrefix}-principal-b-admin`;
  await setup.insert(users).values({
    id: bAdminUserId,
    email: `${bAdminUserId}@example.invalid`,
    name: "MT026 company B admin",
  });
  await setup.insert(enterprisePrincipals).values({
    id: bAdminPrincipalId,
    userId: bAdminUserId,
  });
  await operator.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${isolation.ids["company-b"]}, true), set_config('app.operator_principal_id', ${bAdminPrincipalId}, true)`,
    );
    await tx.insert(enterpriseMemberships).values({
      tenantId: isolation.ids["company-b"],
      principalId: bAdminPrincipalId,
      role: "tenant_admin",
      status: "active",
      epoch: 1,
    });
  });

  const userIdOf = (identity: SsoScimAdminIdentity): string | undefined =>
    identity === "b-admin"
      ? bAdminUserId
      : isolation.identities[identity].userId;
  return {
    isolation,
    operator,
    directory,
    configService,
    reconciler,
    bindingService,
    async adminContextOf(identity, companyKey) {
      const userId = userIdOf(identity);
      if (!userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${String(identity)}`);
      }
      const request = new Request("https://tests.invalid/admin-context", {
        headers: { "x-openbot-tenant": tenantIdOf(companyKey) },
      });
      sessions.set(request, { userId, tenantId: tenantIdOf(companyKey) });
      return authorizer.resolveAdminContext(request);
    },
    async scimTargetUser(key) {
      const userId = `${isolation.idPrefix}-scim-user-${key}`;
      const principalId = `${isolation.idPrefix}-scim-principal-${key}`;
      // Owner-path inserts, identical to the isolation fixture's own
      // provisioning of the matrix users/principals (same id prefix, so the
      // isolation cleanup removes them).
      await setup.insert(users).values({
        id: userId,
        email: `${userId}@example.invalid`,
        name: `MT026 scim target ${key}`,
      });
      await setup.insert(enterprisePrincipals).values({
        id: principalId,
        userId,
      });
      return { userId, principalId };
    },
    async dispose() {
      // Drizzle's Database exposes the underlying postgres client at $client.
      // The restricted operator/directory pools are closed too; isolation
      // cleanup still runs even when one of the closes throws.
      try {
        await operator.$client.close();
        await directory.$client.close();
        await setup.$client.close();
      } finally {
        await isolation.dispose();
      }
    },
  };
}
