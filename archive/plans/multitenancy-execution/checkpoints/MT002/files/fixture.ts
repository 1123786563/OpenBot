/**
 * Shared multitenancy isolation fixture (MT002 / Issue #45).
 *
 * Contract source: `docs/plans/2026-10-15-company-team-multitenancy/interfaces.md`
 * (T01). One call provisions the Spec §11 minimum identity matrix — company A
 * with teams A1/A2, company B with team B1, and all eight identity classes —
 * through the real offline provisioning factory (`provisionDeployment`) on a
 * dedicated enterprise test database, and hands back restricted-role business
 * transactions plus an HTTP-shaped request seam that runs the real scope
 * resolver and resource reader. Nothing in here mocks the authorization path:
 * scope issuance, membership checks, grants and RLS all execute against real
 * rows under the restricted `ob_ent_*` PostgreSQL roles.
 *
 * Current-shape note: workspace (team) membership rows do not exist yet — they
 * arrive with MT004. Until then an identity's team membership is a fixture
 * fact materialized through per-team resource grants created by the real
 * factory; `identities[*].companies[*].teams` records exactly that fact.
 */

import { randomUUID } from "node:crypto";
import { like, type SQL, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  type ProvisioningReceipt,
  provisionDeployment,
  suspendMembership,
} from "../../../src/enterprise/tenancy/provision";
import {
  createResourceReader,
  createScopeResolver,
} from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import { ISOLATION_DOMAINS, type IsolationDomain } from "./scenarios";

/** The named identities every positive and negative multitenancy test shares. */
export type FixtureIdentity =
  | "a1-member"
  | "a2-member"
  | "a1a2-member"
  | "a1-other"
  | "b1-member"
  | "multi-company"
  | "company-admin"
  | "platform-operator"
  | "worker";

export const FIXTURE_IDENTITIES: readonly FixtureIdentity[] = [
  "a1-member",
  "a2-member",
  "a1a2-member",
  "a1-other",
  "b1-member",
  "multi-company",
  "company-admin",
  "platform-operator",
  "worker",
];

/**
 * How the fixture identities cover the Spec §11 minimum matrix ("最低测试身份"
 * in docs/specs/2026-10-14-company-team-multitenancy-design.md). The matrix has
 * eight classes; `multi-company` is a ninth identity that additionally holds
 * memberships in both companies at once.
 */
export const SPEC_IDENTITY_MATRIX: Readonly<
  Record<string, readonly FixtureIdentity[]>
> = Object.freeze({
  "company-a-team-a1-only": ["a1-member"],
  "company-a-team-a2-only": ["a2-member"],
  "company-a-both-teams": ["a1a2-member"],
  "same-team-other-person": ["a1-other"],
  "cross-company": ["b1-member", "multi-company"],
  "company-admin": ["company-admin"],
  "platform-operator": ["platform-operator"],
  "restricted-worker": ["worker"],
});

/** The restricted business database roles a query can run under. */
export const RESTRICTED_ROLES = ["directory", "data", "operator"] as const;
export type RestrictedRole = (typeof RESTRICTED_ROLES)[number];

/** Transaction-local business context; `undefined` means "no context at all". */
export type RestrictedQueryContext = Readonly<{
  tenantId: string;
  principalId?: string;
  workspaceId?: string;
  /** Operation-scoped reads (e.g. security events) pin `app.operation_id`. */
  operationId?: string;
}>;

export type FixtureRequestInput = Readonly<{
  method: string;
  path: string;
  body?: unknown;
  tenantId?: string;
  workspaceId?: string;
}>;

export type FixtureTeamFact = Readonly<{
  /** Team (workspace) id inside the parent company. */
  workspaceId: string;
  /** Stable `ids` key of the team, e.g. "team-a1". */
  teamKey: string;
}>;

export type FixtureCompanyMembershipFact = Readonly<{
  tenantId: string;
  /** Stable `ids` key of the company, e.g. "company-a". */
  companyKey: string;
  /** The global principal this membership belongs to (one per human identity). */
  principalId: string;
  role: "tenant_admin" | "member" | "auditor";
  status: "active" | "suspended";
  epoch: number;
  teams: readonly FixtureTeamFact[];
}>;

export type FixtureIdentityFact = Readonly<{
  identity: FixtureIdentity;
  /** "human" identities have a real user session; machine identities do not. */
  kind: "human" | "platform-operator" | "worker";
  userId?: string;
  principalId?: string;
  companies: readonly FixtureCompanyMembershipFact[];
}>;

export type FixtureExternalEffect = Readonly<{
  kind: "deployment.provisioned" | "membership.suspended";
  detail: unknown;
}>;

export interface IsolationFixture {
  /** The domain this fixture was created for. */
  readonly domain: IsolationDomain;
  /** Unique id namespace every generated row id starts with. */
  readonly idPrefix: string;
  /** Every generated id by stable key ("company-a", "team-a1", "user-a1-member", ...). */
  readonly ids: Readonly<Record<string, string>>;
  /** Creation-time identity facts; live status stays queryable via queryRestricted. */
  readonly identities: Readonly<Record<FixtureIdentity, FixtureIdentityFact>>;
  /** Verified login/capability pair actually backing each restricted role. */
  readonly restrictedRoles: Readonly<
    Record<RestrictedRole, Readonly<{ capability: string; login: string }>>
  >;
  requestAs(
    identity: FixtureIdentity,
    input: FixtureRequestInput,
  ): Promise<Response>;
  queryRestricted(
    role: string,
    context: RestrictedQueryContext | undefined,
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  externalEffects(): readonly FixtureExternalEffect[];
  /** Real offline revocation (epoch bump + audit event) of one company membership. */
  suspendCompanyMembership(
    identity: FixtureIdentity,
    tenantId: string,
  ): Promise<{ readonly changed: boolean; readonly epoch: number }>;
  dispose(): Promise<void>;
}

export type CreateIsolationFixtureOptions = Readonly<{
  /** Environment the database URLs are resolved from; defaults to process.env. */
  environment?: Record<string, string | undefined>;
}>;

const TEAM_KEYS = ["team-a1", "team-a2", "team-b1"] as const;
type TeamKey = (typeof TEAM_KEYS)[number];

interface PlannedHuman {
  readonly identity: FixtureIdentity;
  readonly memberships: ReadonlyArray<{
    companyKey: "company-a" | "company-b";
    role: "tenant_admin" | "member";
    teams: readonly TeamKey[];
  }>;
}

/** Who exists: the §11 matrix as one declarative plan. */
const HUMAN_PLAN: readonly PlannedHuman[] = [
  {
    identity: "a1-member",
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
    identity: "a1-other",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
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
];

/**
 * Creates the shared fixture for one isolation domain. All database URLs are
 * resolved (and refused, when misconfigured) before any connection opens:
 * `TEST_DATABASE_URL` (or `ENTERPRISE_TEST_SETUP_DATABASE_URL`) must name the
 * dedicated `openbot_enterprise_*` test database and the three
 * `ENTERPRISE_TEST_*_DATABASE_URL` role logins must exist — there is no
 * fallback to any development database anywhere in this path.
 */
export async function createIsolationFixture(
  domain: IsolationDomain,
  options: CreateIsolationFixtureOptions = {},
): Promise<IsolationFixture> {
  if (
    !ISOLATION_DOMAINS.includes(domain as (typeof ISOLATION_DOMAINS)[number])
  ) {
    throw new Error(
      `UNKNOWN_ISOLATION_DOMAIN:${domain}: expected one of ${ISOLATION_DOMAINS.join(", ")}`,
    );
  }
  const environment = options.environment ?? process.env;
  // Resolve every URL up front: a missing or mispointed variable must fail
  // before the first socket opens, never halfway through provisioning.
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const roleUrls = {
    directory: enterpriseRuntimeDatabaseUrlFrom("directory", environment),
    data: enterpriseRuntimeDatabaseUrlFrom("data", environment),
    operator: enterpriseRuntimeDatabaseUrlFrom("operator", environment),
  } as const;

  const prefix = `mt002-${domain}-${randomUUID().slice(0, 8)}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids: Record<string, string> = {
    "company-a": id("company-a"),
    "company-b": id("company-b"),
    "team-a1": id("team-a1"),
    "team-a2": id("team-a2"),
    "team-b1": id("team-b1"),
    "resource-a1": id("resource-a1"),
    "resource-a2": id("resource-a2"),
    "resource-a1-other": id("resource-a1-other"),
    "resource-b1": id("resource-b1"),
    "provision-a1": id("provision-a1"),
    "provision-a2": id("provision-a2"),
    "provision-b1": id("provision-b1"),
  };
  for (const planned of HUMAN_PLAN) {
    ids[`user-${planned.identity}`] = id(planned.identity);
    ids[`principal-${planned.identity}`] = id(`principal-${planned.identity}`);
  }
  const teamOf = (key: TeamKey) => ids[key];

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  try {
    // Global identity rows: User/Principal are global (Spec §4.1) and the
    // provisioning factory refuses unbound principals, so binding happens
    // here exactly once per human identity.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: ids[`user-${planned.identity}`],
        email: `${id(planned.identity)}@example.invalid`,
        name: `MT002 ${planned.identity}`,
      })),
    );
    await setupDatabase.insert(enterprisePrincipals).values(
      HUMAN_PLAN.map((planned) => ({
        id: ids[`principal-${planned.identity}`],
        userId: ids[`user-${planned.identity}`],
      })),
    );

    // Restricted business roles, verified against the live catalog before use.
    const directory = await openVerified(
      roleUrls.directory,
      verifyDirectoryDatabase,
    );
    const data = await openVerified(roleUrls.data, verifyDataDatabase);
    const operator = await openVerified(
      roleUrls.operator,
      verifyOperatorDatabase,
    );
    closeables.push(directory.$client, data.$client, operator.$client);

    const principalUserIds = new Map<string, string>();
    for (const planned of HUMAN_PLAN) {
      principalUserIds.set(
        ids[`principal-${planned.identity}`],
        ids[`user-${planned.identity}`],
      );
    }

    /**
     * The restricted business-transaction seam shared by queryRestricted and
     * the fixture's own fact reads. The pool for each role holds exactly one
     * connection, so consecutive calls reuse the same backend — the property
     * the connection-reuse leak tests rely on. Context settings are
     * transaction-local (`set_config(..., true)`), so commit and rollback both
     * clear them; nothing session-level is ever written.
     */
    const runRestrictedQuery = async (
      role: RestrictedRole,
      context: RestrictedQueryContext | undefined,
      text: string,
      values: readonly unknown[],
    ) => {
      const connection =
        role === "directory" ? directory : role === "data" ? data : operator;
      return connection.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        if (context) {
          const settings: SQL[] = [
            sql`set_config('app.tenant_id', ${context.tenantId}, true)`,
          ];
          if (context.principalId) {
            settings.push(
              sql`set_config('app.principal_id', ${context.principalId}, true)`,
            );
            const userId = principalUserIds.get(context.principalId);
            if (userId) {
              settings.push(sql`set_config('app.user_id', ${userId}, true)`);
            }
          }
          if (context.workspaceId) {
            settings.push(
              sql`set_config('app.workspace_id', ${context.workspaceId}, true)`,
            );
          }
          if (context.operationId) {
            settings.push(
              sql`set_config('app.operation_id', ${context.operationId}, true)`,
            );
          }
          await tx.execute(sql`select ${sql.join(settings, sql`, `)}`);
        }
        const result = (await tx.execute(
          parameterized(text, values),
        )) as unknown;
        return normalizeRows(result);
      });
    };

    // ---- Real-factory provisioning (three deployment operations). ----------
    const member = (identity: FixtureIdentity) => ({
      principalId: ids[`principal-${identity}`],
      userId: ids[`user-${identity}`],
    });
    const effects: FixtureExternalEffect[] = [];
    const provisions = [
      {
        operationId: ids["provision-a1"],
        companyKey: "company-a" as const,
        companyName: "Company A",
        teamKey: "team-a1" as const,
        teamName: "Company A / Team A1",
        operator: "company-admin" as const,
        members: (
          [
            ["a1-member", "member"],
            ["a1a2-member", "member"],
            ["a1-other", "member"],
            ["multi-company", "member"],
            ["company-admin", "tenant_admin"],
          ] as const
        ).map(([identity, role]) => ({
          ...member(identity),
          role,
        })),
        resources: [
          {
            id: ids["resource-a1"],
            kind: "document",
            displayName: "Team A1 shared document",
            readers: ["a1-member", "a1a2-member", "multi-company"],
          },
          {
            id: ids["resource-a1-other"],
            kind: "document",
            displayName: "A1 other member's own document",
            readers: ["a1-other"],
          },
        ],
      },
      {
        operationId: ids["provision-a2"],
        companyKey: "company-a" as const,
        companyName: "Company A",
        teamKey: "team-a2" as const,
        teamName: "Company A / Team A2",
        operator: "company-admin" as const,
        members: (["a2-member", "a1a2-member"] as const).map((identity) => ({
          ...member(identity),
          role: "member" as const,
        })),
        resources: [
          {
            id: ids["resource-a2"],
            kind: "document",
            displayName: "Team A2 shared document",
            readers: ["a2-member", "a1a2-member"],
          },
        ],
      },
      {
        operationId: ids["provision-b1"],
        companyKey: "company-b" as const,
        companyName: "Company B",
        teamKey: "team-b1" as const,
        teamName: "Company B / Team B1",
        operator: "b1-member" as const,
        members: (["b1-member", "multi-company"] as const).map((identity) => ({
          ...member(identity),
          role: "member" as const,
        })),
        resources: [
          {
            id: ids["resource-b1"],
            kind: "document",
            displayName: "Team B1 shared document",
            readers: ["b1-member", "multi-company"],
          },
        ],
      },
    ];
    for (const provision of provisions) {
      const receipt: ProvisioningReceipt = await provisionDeployment(operator, {
        operationId: provision.operationId,
        operator: ids[`principal-${provision.operator}`],
        tenant: {
          id: ids[provision.companyKey],
          name: provision.companyName,
        },
        workspace: {
          id: ids[provision.teamKey],
          name: provision.teamName,
        },
        members: provision.members.map((entry) => ({
          principalId: entry.principalId,
          userId: entry.userId,
          role: entry.role,
        })),
        resources: provision.resources.map((resource) => ({
          id: resource.id,
          kind: resource.kind,
          displayName: resource.displayName,
          readers: resource.readers.map(
            (identity) => ids[`principal-${identity}`],
          ),
        })),
      });
      effects.push({ kind: "deployment.provisioned", detail: receipt });
    }

    // ---- Identity facts read back through the real directory role. --------
    const identities = {} as Record<FixtureIdentity, FixtureIdentityFact>;
    for (const planned of HUMAN_PLAN) {
      const companies: FixtureCompanyMembershipFact[] = [];
      for (const plannedMembership of planned.memberships) {
        const tenantId = ids[plannedMembership.companyKey];
        const principalId = ids[`principal-${planned.identity}`];
        const rows = await runRestrictedQuery(
          "directory",
          { tenantId, principalId },
          "select role, status, epoch from enterprise_memberships where tenant_id = $1 and principal_id = $2",
          [tenantId, principalId],
        );
        const row = rows[0];
        if (!row) {
          throw new Error(
            `FIXTURE_MEMBERSHIP_MISSING:${planned.identity}:${plannedMembership.companyKey}`,
          );
        }
        companies.push({
          tenantId,
          companyKey: plannedMembership.companyKey,
          principalId,
          role: row.role as FixtureCompanyMembershipFact["role"],
          status: row.status as FixtureCompanyMembershipFact["status"],
          epoch: Number(row.epoch),
          teams: plannedMembership.teams.map((teamKey) => ({
            workspaceId: teamOf(teamKey),
            teamKey,
          })),
        });
      }
      identities[planned.identity] = Object.freeze({
        identity: planned.identity,
        kind: "human",
        userId: ids[`user-${planned.identity}`],
        principalId: ids[`principal-${planned.identity}`],
        companies: Object.freeze(companies),
      });
    }
    identities["platform-operator"] = Object.freeze({
      identity: "platform-operator",
      kind: "platform-operator",
      companies: [],
    });
    identities.worker = Object.freeze({
      identity: "worker",
      kind: "worker",
      companies: [],
    });

    const restrictedRoles = {} as Record<
      RestrictedRole,
      { capability: string; login: string }
    >;
    for (const role of RESTRICTED_ROLES) {
      const rows = await runRestrictedQuery(
        role,
        undefined,
        "select current_user as current_user, session_user as session_user",
        [],
      );
      const row = rows[0];
      if (!row || typeof row.current_user !== "string") {
        throw new Error(`RESTRICTED_ROLE_IDENTITY_UNREADABLE:${role}`);
      }
      restrictedRoles[role] = Object.freeze({
        capability: row.current_user,
        login: String(row.session_user ?? ""),
      });
    }

    // ---- The real request path: session seam -> trusted scope -> reader. --
    const actorSessions = new WeakMap<Request, FixtureIdentity>();
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = actorSessions.get(request);
        if (!identity) return null;
        const fact = identities[identity];
        if (fact.kind !== "human" || !fact.userId) return null;
        return { actorId: fact.userId, entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });
    const reader = createResourceReader(data);

    let disposed = false;
    let disposePromise: Promise<void> | undefined;
    let suspendCounter = 0;
    const assertUsable = () => {
      if (disposed) throw new Error("FIXTURE_DISPOSED");
    };

    const fixture: IsolationFixture = {
      domain,
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      identities: Object.freeze({ ...identities }),
      restrictedRoles: Object.freeze({ ...restrictedRoles }),

      async requestAs(identity, input) {
        assertUsable();
        if (!FIXTURE_IDENTITIES.includes(identity)) {
          throw new Error(`UNKNOWN_FIXTURE_IDENTITY:${String(identity)}`);
        }
        if (
          !input ||
          typeof input.method !== "string" ||
          typeof input.path !== "string"
        ) {
          throw new Error("REQUEST_INPUT_INVALID");
        }
        const url = new URL(input.path, "https://mt002-fixture.invalid");
        const headers: Record<string, string> = {};
        if (input.tenantId !== undefined)
          headers["x-openbot-tenant"] = input.tenantId;
        if (input.workspaceId !== undefined)
          headers["x-openbot-workspace"] = input.workspaceId;
        const init: RequestInit = { method: input.method, headers };
        if (
          input.body !== undefined &&
          input.method !== "GET" &&
          input.method !== "HEAD"
        ) {
          headers["content-type"] = "application/json";
          init.body = JSON.stringify(input.body);
        }
        const request = new Request(url.href, init);
        actorSessions.set(request, identity);
        try {
          // Session first, then selectors, then real membership checks — the
          // same order the request layer guarantees (Spec §5.2).
          const fact = identities[identity];
          if (fact.kind !== "human" || !fact.userId) {
            throw new FixtureHttpError(401, "AUTH_REQUIRED");
          }
          if (!String(input.tenantId ?? "").trim()) {
            throw new FixtureHttpError(400, "TENANT_REQUIRED");
          }
          if (!String(input.workspaceId ?? "").trim()) {
            throw new FixtureHttpError(400, "WORKSPACE_REQUIRED");
          }
          const scope = await resolver.resolve(request);
          const match = /^\/resources\/([^/]+)$/.exec(url.pathname);
          if (input.method !== "GET" || !match) {
            throw new FixtureHttpError(404, "ROUTE_NOT_FOUND");
          }
          const view = await reader.readAuthorizedResource(
            scope,
            decodeURIComponent(match[1]),
          );
          return jsonResponse(200, { ...view });
        } catch (error) {
          const mapped = mapRouteError(error);
          return jsonResponse(mapped.status, { error: mapped.code });
        }
      },

      async queryRestricted(role, context, text, values) {
        assertUsable();
        if (!RESTRICTED_ROLES.includes(role as RestrictedRole)) {
          throw new Error(
            `UNKNOWN_RESTRICTED_ROLE:${String(role)}: expected one of ${RESTRICTED_ROLES.join(", ")}`,
          );
        }
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("RESTRICTED_QUERY_TEXT_REQUIRED");
        }
        if (!Array.isArray(values)) {
          throw new Error("RESTRICTED_QUERY_VALUES_REQUIRED");
        }
        if (context && !String(context.tenantId ?? "").trim()) {
          throw new Error("RESTRICTED_CONTEXT_TENANT_REQUIRED");
        }
        return runRestrictedQuery(
          role as RestrictedRole,
          context ?? undefined,
          text,
          values,
        );
      },

      externalEffects() {
        return [...effects];
      },

      async suspendCompanyMembership(identity, tenantId) {
        assertUsable();
        const fact = identities[identity];
        if (fact?.kind !== "human" || !fact?.principalId) {
          throw new Error(
            `FIXTURE_IDENTITY_NOT_SUSPENDABLE:${String(identity)}`,
          );
        }
        if (!String(tenantId ?? "").trim()) {
          throw new Error("SUSPEND_TENANT_REQUIRED");
        }
        const receipt = await suspendMembership(operator, {
          operationId: id(`suspend-${identity}-${suspendCounter++}`),
          operator: fact.principalId,
          tenantId,
          principalId: fact.principalId,
        });
        effects.push({
          kind: "membership.suspended",
          detail: { identity, tenantId, receipt },
        });
        return receipt;
      },

      dispose() {
        disposePromise ??= (async () => {
          const failures: unknown[] = [];
          if (!disposed) {
            disposed = true;
            try {
              await cleanupFixtureRows(setupDatabase, prefix);
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
              "Isolation fixture disposal failed.",
            );
          }
        })();
        return disposePromise;
      },
    };
    return fixture;
  } catch (error) {
    // Never leak connections — or half-provisioned rows — when creation fails.
    const failures: unknown[] = [error];
    try {
      await cleanupFixtureRows(setupDatabase, prefix);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    for (const closeable of closeables.reverse()) {
      try {
        await closeable.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    throw new AggregateError(failures, "Isolation fixture creation failed.");
  }
}

class FixtureHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const ROUTE_ERROR_STATUS: ReadonlyMap<string, number> = new Map([
  ["AUTH_REQUIRED", 401],
  ["TENANT_REQUIRED", 400],
  ["WORKSPACE_REQUIRED", 400],
  ["TENANT_FORBIDDEN", 403],
  ["SCOPE_REVOKED", 403],
  ["RESOURCE_NOT_FOUND", 404],
  ["THREAD_SCOPE_NOT_FOUND", 404],
  ["ROUTE_NOT_FOUND", 404],
  ["DATA_DATABASE_UNAVAILABLE", 503],
]);

function mapRouteError(error: unknown): { status: number; code: string } {
  if (error instanceof FixtureHttpError) {
    return { status: error.status, code: error.code };
  }
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  const status = ROUTE_ERROR_STATUS.get(code);
  // Business failures carry their code only; unknown faults report nothing
  // beyond "internal" so error text cannot leak existence or internals.
  return status ? { status, code } : { status: 500, code: "INTERNAL_ERROR" };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function openVerified<T extends Database>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  // max: 1 on purpose — see runRestrictedQuery.
  const candidate = createDatabase(url, { max: 1 });
  try {
    return await verify(candidate);
  } catch (error) {
    await candidate.$client.close();
    throw error;
  }
}

/**
 * Builds a parameterized statement from `$1..$n` placeholders. Values only ever
 * travel as bound parameters; the raw text is never string-interpolated.
 */
function parameterized(text: string, values: readonly unknown[]): SQL {
  const pattern = /\$(\d{1,4})\b/g;
  const parts: SQL[] = [];
  const used = new Set<number>();
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      parts.push(sql.raw(text.slice(cursor, match.index)));
    }
    const position = Number(match[1]);
    if (position < 1 || position > values.length) {
      throw new Error(
        `RESTRICTED_QUERY_PARAMETER_OUT_OF_RANGE:$${position} (bind values: ${values.length})`,
      );
    }
    used.add(position);
    const value = values[position - 1];
    // `sql`${undefined}`` silently drops the chunk and produces truncated SQL;
    // refuse it loudly instead. Use SQL NULL (not undefined) for null binds.
    if (value === undefined) {
      throw new Error(
        `RESTRICTED_QUERY_VALUE_INVALID:$${position} is undefined`,
      );
    }
    parts.push(sql`${value}`);
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) {
    parts.push(sql.raw(text.slice(cursor)));
  }
  if (used.size !== values.length) {
    throw new Error(
      `RESTRICTED_QUERY_PARAMETER_UNUSED:${values.length - used.size} bind value(s) never referenced`,
    );
  }
  return sql.join(parts, sql.raw(""));
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  return result.map((row) =>
    row !== null && typeof row === "object"
      ? { ...(row as Record<string, unknown>) }
      : { value: row },
  );
}

async function cleanupFixtureRows(
  setupDatabase: Database,
  prefix: string,
): Promise<void> {
  // Children first, then principals and their users; every filter is the
  // fixture's own unique prefix so nothing outside the fixture is touched.
  await setupDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
  await setupDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, `${prefix}%`));
  await setupDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, `${prefix}%`));
  await setupDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
  await setupDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
  await setupDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, `${prefix}%`));
  await setupDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${prefix}%`));
  await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
}
