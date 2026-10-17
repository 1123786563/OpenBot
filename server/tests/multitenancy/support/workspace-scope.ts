/**
 * MT006 (Issue #49) workspace-scope fixture support.
 *
 * Builds on the MT002 isolation matrix and the MT005 scope-gate fixture and
 * adds what this ticket owns:
 *
 *  1. The MT006 operator DELETE policy on enterprise_workspace_memberships,
 *     provisioned once per test database through the dedicated setup
 *     connection (superuser). The MT004-era table ships read/insert/update
 *     operator policies only; this ticket's remove-member write path performs
 *     its DELETE through the restricted operator role, which needs the policy
 *     to exist. Production migration generation for the policy is schema-chain
 *     work outside this ticket (disclosed in reports/MT006.md); the write path
 *     itself is RLS-enforced against the real policy in this database.
 *  2. The real MT006 surface — lister, company-admin authorizer, admin
 *     service and the actual Hono routes — wired to the restricted directory /
 *     data / operator roles, driven through `routes.fetch` with a WeakMap
 *     request→identity session seam (no mocked authorization anywhere).
 *  3. A gate-transaction probe that proves the admin writes serialize against
 *     the MT005 gate on the shared workspace-membership advisory key.
 */

import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import { verifyOperatorDatabase } from "../../../src/enterprise/tenancy/connections";
import { createWorkspaceGate } from "../../../src/enterprise/tenancy/scope-gate";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
  createWorkspaceAdminService,
  createWorkspaceScopeLister,
  type WorkspaceAdminService,
} from "../../../src/enterprise/tenancy/workspace-admin";
import { createWorkspaceScopeRoutes } from "../../../src/enterprise/tenancy/workspace-scope-routes";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import { createScopeGateFixture, type ScopeGateFixture } from "./scope-gate";

export type { FixtureIdentity };

/** A signed-in user with zero company memberships (no default scope). */
type ScopelessUserIdentity = "scopeless-user";
export type WorkspaceScopeIdentity = FixtureIdentity | ScopelessUserIdentity;

export interface WorkspaceScopeRequestInput {
  method: string;
  path: string;
  body?: unknown;
  /** Ruling #1 tenant selector header; absent means the header is not sent. */
  tenantId?: string;
  /** Ruling #1 workspace selector header; absent means the header is not sent. */
  workspaceId?: string;
}

export interface GateTransactionProbe {
  /** Resolves with the operation's return value once the gate tx commits. */
  done: Promise<unknown>;
  /** Releases the in-transaction gate operation (locks are held until then). */
  release: () => void;
}

export interface WorkspaceScopeFixture {
  readonly gate: ScopeGateFixture;
  readonly isolation: ScopeGateFixture["isolation"];
  /** The real MT006 routes with real restricted-role dependencies. */
  readonly routes: Hono;
  /** Drives a Request through the real routes bound to a fixture identity. */
  request(
    identity: WorkspaceScopeIdentity,
    input: WorkspaceScopeRequestInput,
  ): Promise<Response>;
  /** Same, but with no session at all (anonymous). */
  requestAnonymous(input: WorkspaceScopeRequestInput): Promise<Response>;
  readonly ids: Readonly<Record<string, string>>;
  readonly identities: ReturnType<
    ScopeGateFixture["isolation"]["identities"]["valueOf"]
  >;
  principalIdOf(identity: FixtureIdentity): string;
  query(
    role: string,
    context:
      | { tenantId: string; principalId?: string; workspaceId?: string }
      | undefined,
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  /** The real admin service (for direct, unmapped-error assertions). */
  adminService(): WorkspaceAdminService;
  /** Resolves a real, trusted admin context for one identity. */
  adminContextOf(identity: FixtureIdentity): Promise<CompanyAdminContext>;
  /** Issues a context, then bumps the company epoch behind its back. */
  staleAdminContext(identity: FixtureIdentity): Promise<CompanyAdminContext>;
  /** Unique id for a team this test creates (cleaned up by the isolation fixture). */
  newTeamId(): string;
  registerCreatedTeam(workspaceId: string): void;
  /** Starts a gate transaction holding the shared membership lock. */
  gateTransactionProbe(scope: PlatformScope): Promise<GateTransactionProbe>;
  /** Resolves a business scope through the real resolver (ruling #1 headers). */
  resolveScope(
    identity: WorkspaceScopeIdentity,
    selectors: { tenantId?: string; workspaceId?: string },
  ): Promise<PlatformScope>;
  /**
   * Offline fact mutation through the dedicated setup connection: flips one
   * identity's company membership role. The operator role cannot update the
   * role column (MT004 grants cover status/epoch only), and no production
   * write path reassigns roles yet — this is the disclosed stand-in used to
   * pin the in-transaction revalidation against demoted admins.
   */
  setCompanyMembershipRole(
    identity: FixtureIdentity,
    role: "tenant_admin" | "member",
  ): Promise<void>;
  dispose(): Promise<void>;
}

const MT006_DELETE_POLICY = "enterprise_workspace_membership_operator_delete";

/**
 * Provisions the MT006 operator DELETE policy + grant once per database.
 * Idempotent via the pg_policies catalog; the grant itself is idempotent.
 */
async function provisionOperatorDeletePolicy(setup: Database): Promise<void> {
  const existing = await setup.execute(sql`
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'enterprise_workspace_memberships'
      and policyname = ${MT006_DELETE_POLICY}
  `);
  const rows = (Array.isArray(existing) ? existing : []) as unknown[];
  if (rows.length === 0) {
    await setup.execute(
      sql.raw(`
      CREATE POLICY "${MT006_DELETE_POLICY}" ON "enterprise_workspace_memberships"
        FOR DELETE TO ob_ent_operator
        USING ("enterprise_workspace_memberships"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')
          AND "enterprise_workspace_memberships"."principal_id" = nullif(current_setting('app.operator_principal_id', true), ''))
    `),
    );
  }
  await setup.execute(
    sql`grant delete on table "enterprise_workspace_memberships" to "ob_ent_operator"`,
  );
}

export async function createWorkspaceScopeFixture(): Promise<WorkspaceScopeFixture> {
  const gate = await createScopeGateFixture();
  const isolation = gate.isolation;

  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    verifyOperatorDatabase,
  );
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  await provisionOperatorDeletePolicy(setup);

  // A signed-in user with no company membership at all: the explicit empty
  // state's identity. Rows live inside the isolation prefix, so the
  // isolation fixture's cleanup removes them.
  const scopelessUserId = `${isolation.idPrefix}-user-scopeless`;
  const scopelessPrincipalId = `${isolation.idPrefix}-principal-scopeless`;
  await setup.execute(sql`
    insert into users (id, email, name)
    values (${scopelessUserId}, ${`${scopelessUserId}@example.invalid`}, 'MT006 scopeless user')
  `);
  await setup.execute(sql`
    insert into enterprise_principals (id, user_id)
    values (${scopelessPrincipalId}, ${scopelessUserId})
  `);
  const extraSessions = new Map<string, string>([
    ["scopeless-user", scopelessUserId],
  ]);

  // ---- The real MT006 surface over the restricted roles. -------------------
  const lister = createWorkspaceScopeLister(gate.directory, gate.data);
  const sessions = new WeakMap<Request, WorkspaceScopeIdentity>();
  const authenticate = async (request: Request) => {
    const identity = sessions.get(request);
    if (!identity) return null;
    const extraUserId = extraSessions.get(identity);
    if (extraUserId) return { actorId: extraUserId, entrypoint: "web" };
    const fact = isolation.identities[identity as FixtureIdentity];
    if (fact.kind !== "human" || !fact.userId) return null;
    return { actorId: fact.userId, entrypoint: "web" };
  };
  const authorizer = createCompanyAdminAuthorizer(gate.directory, {
    authenticate,
    // Ruling #1: the tenant header selects which company is administered.
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
  });
  // The selection-proof resolver over the same directory: the MT005 gate
  // fixture's own resolver cannot know the scopeless session, so this one
  // carries the same authenticate seam with the extra session map.
  const selectionResolver = createScopeResolver(gate.directory, {
    authenticate,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  const adminService = createWorkspaceAdminService(operator);

  const routes = createWorkspaceScopeRoutes({
    authenticate: authorizer.authenticate,
    lister,
    admin: { authorizer, service: adminService },
  });

  const requestUrl = "https://mt006-workspace-scope.invalid";
  let teamCounter = 0;
  const createdTeams = new Set<string>();

  const buildRequest = (
    identity: WorkspaceScopeIdentity | null,
    input: WorkspaceScopeRequestInput,
  ): Request => {
    const headers: Record<string, string> = {};
    if (input.tenantId !== undefined) {
      headers["x-openbot-tenant"] = input.tenantId;
    }
    if (input.workspaceId !== undefined) {
      headers["x-openbot-workspace"] = input.workspaceId;
    }
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }
    const request = new Request(new URL(input.path, requestUrl), init);
    if (identity !== null) sessions.set(request, identity);
    return request;
  };

  let disposed = false;
  return {
    gate,
    isolation,
    routes,

    async request(identity, input) {
      return routes.fetch(buildRequest(identity, input));
    },

    async requestAnonymous(input) {
      return routes.fetch(buildRequest(null, input));
    },

    ids: isolation.ids,
    identities: isolation.identities,
    principalIdOf: (identity) => {
      const fact = isolation.identities[identity];
      if (!fact?.principalId) {
        throw new Error(`IDENTITY_HAS_NO_PRINCIPAL:${identity}`);
      }
      return fact.principalId;
    },

    query: (role, context, text, values) =>
      isolation.queryRestricted(role, context, text, values),

    adminService: () => adminService,

    async adminContextOf(identity) {
      const fact = isolation.identities[identity];
      const companyKey = fact.companies[0]?.companyKey;
      if (!companyKey) {
        throw new Error(`IDENTITY_HAS_NO_COMPANY:${identity}`);
      }
      const request = buildRequest(identity, {
        method: "POST",
        path: "/admin/teams",
        tenantId: isolation.ids[companyKey],
      });
      return authorizer.resolveAdminContext(request);
    },

    async staleAdminContext(identity) {
      const context = await this.adminContextOf(identity);
      const fact = isolation.identities[identity];
      const companyKey = fact.companies[0]?.companyKey;
      if (!companyKey) {
        throw new Error(`IDENTITY_HAS_NO_COMPANY:${identity}`);
      }
      await gate.bumpCompanyMembershipEpoch(identity, companyKey);
      return context;
    },

    newTeamId: () => {
      teamCounter += 1;
      return `${isolation.idPrefix}-team-created-${teamCounter}`;
    },

    registerCreatedTeam(workspaceId) {
      createdTeams.add(workspaceId);
    },

    async resolveScope(identity, selectors) {
      return selectionResolver.resolve(
        buildRequest(identity, {
          method: "GET",
          path: "/",
          tenantId: selectors.tenantId,
          workspaceId: selectors.workspaceId,
        }),
      );
    },

    async setCompanyMembershipRole(identity, role) {
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.principalId) {
        throw new Error(`IDENTITY_NOT_DEMOTABLE:${identity}`);
      }
      const companyKey = fact.companies[0]?.companyKey;
      if (!companyKey) {
        throw new Error(`IDENTITY_HAS_NO_COMPANY:${identity}`);
      }
      await setup.execute(
        sql`update enterprise_memberships set role = ${role} where tenant_id = ${isolation.ids[companyKey]} and principal_id = ${fact.principalId}`,
      );
    },

    async gateTransactionProbe(scope) {
      let releaseGate: (() => void) | undefined;
      const released = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let signalInside: (() => void) | undefined;
      const inside = new Promise<void>((resolve) => {
        signalInside = resolve;
      });
      const gateDb = createWorkspaceGate(gate.data);
      const done = gateDb.transaction(scope, async () => {
        // Running here means trust, revalidation and every shared advisory
        // lock have been acquired — the exact serialization point.
        signalInside?.();
        await released;
        return "done";
      });
      await inside;
      return {
        done: done as Promise<unknown>,
        release: () => releaseGate?.(),
      };
    },

    async dispose() {
      if (disposed) return gate.dispose();
      disposed = true;
      const failures: unknown[] = [];
      // Teams this test created are inside the isolation prefix, but their
      // memberships are deleted first so workspace cleanup cannot hit FK
      // conflicts on databases without cascade-safe ordering.
      for (const workspaceId of createdTeams) {
        try {
          await setup.execute(
            sql`delete from enterprise_workspace_memberships where workspace_id = ${workspaceId}`,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await setup.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await operator.$client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await gate.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "MT006 fixture disposal failed.");
      }
    },
  };
}

async function openVerified<T extends Database>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  const candidate = createDatabase(url, { max: 1 });
  try {
    return await verify(candidate);
  } catch (error) {
    await candidate.$client.close();
    throw error;
  }
}
