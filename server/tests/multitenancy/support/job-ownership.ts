/**
 * Shared MT041 fixture (Issue #84, job ownership / leases / config snapshots).
 *
 * Builds on the MT002 isolation matrix (companies A/B, the §11 identities) and
 * opens the verified restricted-role connections the job-ownership service runs
 * under. Viewer scopes come from the REAL scope resolver (`createScopeResolver`
 * over the verified directory connection — membership-checked at issuance);
 * admin contexts come from the REAL MT006 authorizer; the config basis is
 * resolved by the REAL MT014 runtime-config service over rows seeded through
 * the restricted operator role. Nothing here mocks the authorization path.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../src/db/client";
import { createDatabase } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createRuntimeConfigService,
  type RuntimeConfigService,
} from "../../../src/enterprise/tenancy/runtime-config";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
} from "../../../src/enterprise/tenancy/workspace-admin";
import { enterpriseRuntimeDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  createIsolationFixture,
  type FixtureIdentity,
  type IsolationFixture,
} from "./fixture";

async function openVerified<T extends object>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  return verify(createDatabase(url, { max: 2 }) as Database);
}

export type JobCompanyKey = "company-a" | "company-b";
export type JobTeamKey = "team-a1" | "team-a2" | "team-b1";

export interface JobOwnershipFixture {
  readonly isolation: IsolationFixture;
  readonly operator: OperatorDatabase;
  readonly data: DataDatabase;
  readonly directory: DirectoryDatabase;
  /** The real MT014 runtime-config service (basis resolution for AC3). */
  readonly configService: RuntimeConfigService;
  /**
   * Issues a trusted PlatformScope for a fixture identity over one company
   * team, through the real scope resolver (directory transaction, membership
   * facts, WeakSet trust marking).
   */
  scopeAs(
    identity: FixtureIdentity,
    companyKey: JobCompanyKey,
    teamKey: JobTeamKey,
  ): Promise<PlatformScope>;
  /**
   * Issues a trusted CompanyAdminContext through the real MT006 authorizer.
   */
  adminContextOf(
    identity: FixtureIdentity,
    companyKey: JobCompanyKey,
  ): Promise<CompanyAdminContext>;
  /**
   * Seeds (or resets) the company runtime config at a given revision through
   * the restricted operator role (the MT014 INSERT/UPDATE policy's gate).
   */
  seedCompanyConfig(companyKey: JobCompanyKey, revision: number): Promise<void>;
  /** Seeds the team-a1 override row at a given revision (operator channel). */
  seedTeamOverride(
    teamKey: "team-a1" | "team-a2",
    revision: number,
  ): Promise<void>;
  dispose(): Promise<void>;
}

const COMPANY_DOCUMENT = {
  model: {
    provider: "openai" as const,
    credentialRef: "mt041-company-credential",
    defaultModel: "mt041-model-a",
    allowedModels: ["mt041-model-a", "mt041-model-b"],
  },
  botDefaults: {
    availableAgentIds: ["mt041-agent-a"],
    defaultAgentId: "mt041-agent-a",
  },
  credentials: [
    {
      purpose: "model",
      ref: "mt041-company-credential",
      access: "company" as const,
    },
  ],
  planMapping: { billingExternalCustomerId: "mt041-customer-a", plan: "pro" },
};

const TEAM_OVERRIDE_DOCUMENT = {
  model: { allowedModels: ["mt041-model-a"], defaultModel: "mt041-model-a" },
};

export async function createJobOwnershipFixture(): Promise<JobOwnershipFixture> {
  const isolation = await createIsolationFixture("jobs");

  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    verifyOperatorDatabase,
  );
  const data = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("data"),
    verifyDataDatabase,
  );
  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    verifyDirectoryDatabase,
  );
  const configService = createRuntimeConfigService(data);

  // The real scope resolver over the verified directory connection; sessions
  // are bound server-side (WeakMap), headers only select.
  const sessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string; workspaceId: string }
  >();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const session = sessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) =>
      sessions.get(request)?.tenantId ??
      request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) =>
      sessions.get(request)?.workspaceId ??
      request.headers.get("x-openbot-workspace"),
  });

  // The real MT006 admin authorizer over the same directory connection.
  const adminSessions = new WeakMap<
    Request,
    { userId?: string; tenantId: string }
  >();
  const authorizer = createCompanyAdminAuthorizer(directory, {
    authenticate: async (request) => {
      const session = adminSessions.get(request);
      if (!session?.userId) return null;
      return { actorId: session.userId, entrypoint: "web" };
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
  });

  const tenantIdOf = (companyKey: JobCompanyKey) => isolation.ids[companyKey];
  const workspaceIdOf = (teamKey: JobTeamKey) => isolation.ids[teamKey];

  const runOperator = async (
    tenantId: string,
    work: (
      tx: Parameters<Parameters<OperatorDatabase["transaction"]>[0]>,
    ) => Promise<void>,
    workspaceId?: string,
  ) =>
    operator.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const settings = workspaceId
        ? sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true)`
        : sql`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.execute(settings);
      await work(tx);
    });

  return {
    isolation,
    operator,
    data,
    directory,
    configService,

    async scopeAs(identity, companyKey, teamKey) {
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${String(identity)}`);
      }
      const membership = fact.companies.find(
        (entry) => entry.companyKey === companyKey,
      );
      if (!membership) {
        throw new Error(
          `FIXTURE_IDENTITY_NOT_MEMBER:${identity}:${companyKey}`,
        );
      }
      const request = new Request("https://tests.invalid/job-scope");
      sessions.set(request, {
        userId: fact.userId,
        tenantId: tenantIdOf(companyKey),
        workspaceId: workspaceIdOf(teamKey),
      });
      return resolver.resolve(request);
    },

    async adminContextOf(identity, companyKey) {
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_HUMAN:${String(identity)}`);
      }
      const request = new Request("https://tests.invalid/job-admin-context", {
        headers: { "x-openbot-tenant": tenantIdOf(companyKey) },
      });
      adminSessions.set(request, {
        userId: fact.userId,
        tenantId: tenantIdOf(companyKey),
      });
      return authorizer.resolveAdminContext(request);
    },

    async seedCompanyConfig(companyKey, revision) {
      const tenantId = tenantIdOf(companyKey);
      // Raw-SQL upsert（MT014 夹具同款）：operator 只被授 SELECT/INSERT/UPDATE，
      // 没有 DELETE——配置行的变更是版本前进，不是删除。
      await runOperator(tenantId, async (tx) => {
        await tx.execute(
          sql`insert into enterprise_runtime_configs (tenant_id, document, revision, updated_at) values (${tenantId}, ${JSON.stringify(COMPANY_DOCUMENT)}::jsonb, ${revision}, now())
              on conflict (tenant_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
        );
      });
    },

    async seedTeamOverride(teamKey, revision) {
      const tenantId = tenantIdOf("company-a");
      const workspaceId = workspaceIdOf(teamKey);
      await runOperator(
        tenantId,
        async (tx) => {
          await tx.execute(
            sql`insert into enterprise_runtime_config_overrides (tenant_id, workspace_id, document, revision, updated_at) values (${tenantId}, ${workspaceId}, ${JSON.stringify(TEAM_OVERRIDE_DOCUMENT)}::jsonb, ${revision}, now())
                on conflict (tenant_id, workspace_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
          );
        },
        workspaceId,
      );
    },

    async dispose() {
      const failures: unknown[] = [];
      for (const closeable of [operator, data, directory]) {
        try {
          await closeable.$client.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await isolation.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Job ownership fixture disposal failed.",
        );
      }
    },
  };
}

/** A fresh business-object id with the fixture's unique prefix (cleanup-safe). */
export function jobObjectId(
  fixture: JobOwnershipFixture,
  label: string,
): string {
  return `${fixture.isolation.idPrefix}-job-${label}-${randomUUID().slice(0, 8)}`;
}
