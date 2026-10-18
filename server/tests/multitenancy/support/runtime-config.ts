/**
 * Runtime-config fixture (MT014 / Issue #57).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, writes per-company runtime config documents and per-team override
 * documents through the restricted operator role (RLS-checked INSERT/UPDATE),
 * and hands the real `createRuntimeConfigService` over the verified data
 * channel to the suite. Nothing here mocks the read path: every config read
 * runs as `ob_ent_data` under transaction-local `app.tenant_id` with RLS
 * enforced, and the fixture records `current_user` for every restricted query
 * so the suite can prove restricted roles were in play.
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseRuntimeConfigOverrides,
  enterpriseRuntimeConfigs,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../../src/enterprise/tenancy/provision";
import {
  createRuntimeConfigService,
  type RuntimeConfigService,
} from "../../../src/enterprise/tenancy/runtime-config";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

export type RuntimeConfigRole = "data" | "operator";

export type RestrictedCall = Readonly<{
  role: RuntimeConfigRole;
  currentUser: string;
}>;

export interface RuntimeConfigFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly service: RuntimeConfigService;
  /** Real config writes through the restricted operator role (RLS-checked). */
  writeCompanyConfig(
    tenantId: string,
    document: unknown,
    revision: number,
  ): Promise<void>;
  writeTeamOverride(
    tenantId: string,
    workspaceId: string,
    document: unknown,
    revision: number,
  ): Promise<void>;
  clearTeamOverride(tenantId: string, workspaceId: string): Promise<void>;
  /** RLS probe on the verified data channel under one tenant context. */
  readConfigRowsAsData(
    tenantId: string,
  ): Promise<readonly Readonly<{ tenantId: string; revision: number }>[]>;
  restrictedCalls(): readonly RestrictedCall[];
  dispose(): Promise<void>;
}

export type CreateRuntimeConfigFixtureOptions = Readonly<{
  environment?: Record<string, string | undefined>;
}>;

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "Runtime Config Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "Runtime Config Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

export async function createRuntimeConfigFixture(
  options: CreateRuntimeConfigFixtureOptions = {},
): Promise<RuntimeConfigFixture> {
  const environment = options.environment ?? process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt014-${randomUUID().slice(0, 8)}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids: Record<string, string> = {};
  for (const company of PLANNED_COMPANIES) {
    ids[company.companyKey] = id(company.companyKey);
    for (const team of company.teams) ids[team.teamKey] = id(team.teamKey);
    ids[`admin-${company.companyKey}`] = id(`admin-${company.companyKey}`);
    ids[`principal-${company.companyKey}`] = id(
      `principal-${company.companyKey}`,
    );
  }

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  const restricted: RestrictedCall[] = [];
  const recordRole = async (connection: Database, role: RuntimeConfigRole) => {
    const result = (await connection.execute(
      sql`select current_user as current_user`,
    )) as unknown;
    // drizzle/postgres-js execute yields a row list (array-like); tolerate
    // both the bare list and a { rows } envelope.
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? []);
    const first = (rows as Readonly<{ current_user?: unknown }>[])[0];
    restricted.push({
      role,
      currentUser:
        typeof first?.current_user === "string" ? first.current_user : "",
    });
  };

  try {
    // Global identity scaffolding for the two company admins (the provisioning
    // factory refuses unbound principals — same order as support/fixture.ts).
    const adminRows = PLANNED_COMPANIES.map((company) => ({
      id: ids[`admin-${company.companyKey}`],
      email: `${id(`admin-${company.companyKey}`)}@example.invalid`,
      name: `MT014 admin ${company.companyKey}`,
    }));
    await setupDatabase.insert(users).values(adminRows);
    await setupDatabase.insert(enterprisePrincipals).values(
      PLANNED_COMPANIES.map((company) => ({
        id: ids[`principal-${company.companyKey}`],
        userId: ids[`admin-${company.companyKey}`],
      })),
    );

    const operator = (await verifyOperatorDatabase(
      createDatabase(operatorUrl, { max: 1 }),
    )) as OperatorDatabase;
    const data = (await verifyDataDatabase(
      createDatabase(dataUrl, { max: 1 }),
    )) as DataDatabase;
    closeables.push(operator.$client, data.$client);

    // Real provisioning path for both companies and their teams.
    for (const company of PLANNED_COMPANIES) {
      for (const team of company.teams) {
        await provisionDeployment(operator, {
          operationId: id(`provision-${company.companyKey}-${team.teamKey}`),
          operator: ids[`principal-${company.companyKey}`],
          tenant: { id: ids[company.companyKey], name: company.companyName },
          workspace: { id: ids[team.teamKey], name: team.teamName },
          members: [
            {
              principalId: ids[`principal-${company.companyKey}`],
              userId: ids[`admin-${company.companyKey}`],
              role: "tenant_admin",
            },
          ],
        });
      }
    }

    const runOperator = async (
      tenantId: string,
      statement: ReturnType<typeof sql>,
      workspaceId?: string,
    ) => {
      await recordRole(operator, "operator");
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const settings = [
          sql`set_config('app.tenant_id', ${tenantId}, true)`,
          sql`set_config('app.operator_principal_id', ${ids["principal-company-a"]}, true)`,
          // Override 行的 UPDATE/DELETE 策略要求团队上下文（行级收窄到该团队）。
          sql`set_config('app.workspace_id', ${workspaceId ?? ""}, true)`,
        ];
        await tx.execute(sql`select ${sql.join(settings, sql`, `)}`);
        return tx.execute(statement);
      });
    };

    const fixture: RuntimeConfigFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      service: createRuntimeConfigService(data),

      async writeCompanyConfig(tenantId, document, revision) {
        await runOperator(
          tenantId,
          sql`insert into enterprise_runtime_configs (tenant_id, document, revision, updated_at) values (${tenantId}, ${JSON.stringify(document)}::jsonb, ${revision}, now())
              on conflict (tenant_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
        );
      },

      async writeTeamOverride(tenantId, workspaceId, document, revision) {
        await runOperator(
          tenantId,
          sql`insert into enterprise_runtime_config_overrides (tenant_id, workspace_id, document, revision, updated_at) values (${tenantId}, ${workspaceId}, ${JSON.stringify(document)}::jsonb, ${revision}, now())
              on conflict (tenant_id, workspace_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
          workspaceId,
        );
      },

      async clearTeamOverride(tenantId, workspaceId) {
        await runOperator(
          tenantId,
          sql`delete from enterprise_runtime_config_overrides where tenant_id = ${tenantId} and workspace_id = ${workspaceId}`,
          workspaceId,
        );
      },

      async readConfigRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = await tx
            .select({
              tenantId: enterpriseRuntimeConfigs.tenantId,
              revision: enterpriseRuntimeConfigs.revision,
            })
            .from(enterpriseRuntimeConfigs);
          return rows.map((row) =>
            Object.freeze({ tenantId: row.tenantId, revision: row.revision }),
          );
        });
      },

      restrictedCalls() {
        return [...restricted];
      },

      async dispose() {
        const failures: unknown[] = [];
        try {
          await setupDatabase
            .delete(enterpriseRuntimeConfigOverrides)
            .where(
              like(enterpriseRuntimeConfigOverrides.tenantId, `${prefix}%`),
            );
          await setupDatabase
            .delete(enterpriseRuntimeConfigs)
            .where(like(enterpriseRuntimeConfigs.tenantId, `${prefix}%`));
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
            "Runtime config fixture disposal failed.",
          );
        }
      },
    };
    return fixture;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await setupDatabase
        .delete(enterpriseRuntimeConfigOverrides)
        .where(like(enterpriseRuntimeConfigOverrides.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseRuntimeConfigs)
        .where(like(enterpriseRuntimeConfigs.tenantId, `${prefix}%`));
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
    throw new AggregateError(
      failures,
      "Runtime config fixture creation failed.",
    );
  }
}
