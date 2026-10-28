/**
 * Routing-policy fixture (MT077 / Issue #120).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, writes per-company governance policy documents and per-team
 * override documents through the restricted operator role (RLS-checked
 * INSERT/UPDATE), and hands the real `createRoutingPolicyService`,
 * `createTemplateInstallReader` and `createTemplateInstallWriter` over the
 * verified data/operator channels to the suite. Nothing here mocks the read
 * path: every policy or install read runs as `ob_ent_data` under a
 * transaction-local `app.tenant_id` with RLS enforced, and the fixture
 * records `current_user` for every restricted query so the suite can prove
 * restricted roles were in play.
 */

import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseGovernanceOverrides,
  enterpriseGovernancePolicies,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTemplateInstalls,
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
  createRoutingPolicyService,
  createTemplateInstallReader,
  createTemplateInstallWriter,
  type RoutingPolicyService,
  type TemplateInstallReader,
  type TemplateInstallWriter,
} from "../../../src/enterprise/tenancy/routing-policy";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

export type RoutingPolicyRole = "data" | "operator";

export type RestrictedCall = Readonly<{
  role: RoutingPolicyRole;
  currentUser: string;
}>;

export interface RoutingPolicyFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly policyService: RoutingPolicyService;
  readonly installReader: TemplateInstallReader;
  readonly installWriter: TemplateInstallWriter;
  /** Real policy/override writes through the restricted operator role (RLS-checked). */
  writeCompanyPolicy(
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
  /**
   * Raw install row insert (operator channel, RLS-checked) used to simulate
   * installs made by an older catalog revision — sync's refresh input.
   */
  writeInstallRow(input: {
    tenantId: string;
    workspaceId: string;
    templateRef: string;
    sourceRevision: number;
    document: unknown;
    revision: number;
  }): Promise<void>;
  /** RLS probe on the verified data channel under one tenant context. */
  readPolicyRowsAsData(
    tenantId: string,
  ): Promise<readonly Readonly<{ tenantId: string; revision: number }>[]>;
  readRawInstall(
    tenantId: string,
    workspaceId: string,
    templateRef: string,
  ): Promise<Record<string, unknown> | null>;
  /**
   * Cross-tenant write probe: runs an UPDATE targeting another company's
   * install row while the operator context pins this company's tenant.
   * RLS must make the foreign row invisible — zero rows updated.
   */
  attemptCrossTenantInstallWrite(input: {
    contextTenantId: string;
    targetTenantId: string;
    workspaceId: string;
    templateRef: string;
  }): Promise<number>;
  restrictedCalls(): readonly RestrictedCall[];
  dispose(): Promise<void>;
}

export type CreateRoutingPolicyFixtureOptions = Readonly<{
  environment?: Record<string, string | undefined>;
}>;

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "Routing Policy Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "Routing Policy Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

export async function createRoutingPolicyFixture(
  options: CreateRoutingPolicyFixtureOptions = {},
): Promise<RoutingPolicyFixture> {
  const environment = options.environment ?? process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt077-${randomUUID().slice(0, 8)}`;
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
  const recordRole = async (connection: Database, role: RoutingPolicyRole) => {
    const result = (await connection.execute(
      sql`select current_user as current_user`,
    )) as unknown;
    // drizzle/postgres-js execute yields a row list (array-like); tolerate
    // both the bare list and a { rows } envelope.
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? []);
    const first = (rows as Readonly<{ current_user?: unknown }>[])[0];
    // current_user always answers exactly one row: a miss means the probe
    // itself broke, and an empty role must not silently pass the RLS proofs.
    if (typeof first?.current_user !== "string") {
      throw new Error(`RESTRICTED_ROLE_PROBE_FAILED:${role}`);
    }
    restricted.push({
      role,
      currentUser: first.current_user,
    });
  };

  try {
    // Global identity scaffolding for the two company admins (the provisioning
    // factory refuses unbound principals — same order as support/fixture.ts).
    const adminRows = PLANNED_COMPANIES.map((company) => ({
      id: ids[`admin-${company.companyKey}`],
      email: `${id(`admin-${company.companyKey}`)}@example.invalid`,
      name: `MT077 admin ${company.companyKey}`,
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
          // Override/install 行的 UPDATE 策略要求团队上下文（行级收窄到该团队）。
          sql`set_config('app.workspace_id', ${workspaceId ?? ""}, true)`,
        ];
        await tx.execute(sql`select ${sql.join(settings, sql`, `)}`);
        return tx.execute(statement);
      });
    };

    const fixture: RoutingPolicyFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      policyService: createRoutingPolicyService(data),
      installReader: createTemplateInstallReader(data),
      installWriter: createTemplateInstallWriter(operator),

      async writeCompanyPolicy(tenantId, document, revision) {
        await runOperator(
          tenantId,
          sql`insert into enterprise_governance_policies (tenant_id, document, revision, updated_at) values (${tenantId}, ${JSON.stringify(document)}::jsonb, ${revision}, now())
              on conflict (tenant_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
        );
      },

      async writeTeamOverride(tenantId, workspaceId, document, revision) {
        await runOperator(
          tenantId,
          sql`insert into enterprise_governance_overrides (tenant_id, workspace_id, document, revision, updated_at) values (${tenantId}, ${workspaceId}, ${JSON.stringify(document)}::jsonb, ${revision}, now())
              on conflict (tenant_id, workspace_id) do update set document = excluded.document, revision = excluded.revision, updated_at = now()`,
          workspaceId,
        );
      },

      async writeInstallRow(input) {
        await runOperator(
          input.tenantId,
          sql`insert into enterprise_template_installs (tenant_id, workspace_id, template_ref, source_revision, document, revision, updated_at) values (${input.tenantId}, ${input.workspaceId}, ${input.templateRef}, ${input.sourceRevision}, ${JSON.stringify(input.document)}::jsonb, ${input.revision}, now())
              on conflict (tenant_id, workspace_id, template_ref) do update set source_revision = excluded.source_revision, document = excluded.document, revision = excluded.revision, updated_at = now()`,
          input.workspaceId,
        );
      },

      async readPolicyRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = await tx
            .select({
              tenantId: enterpriseGovernancePolicies.tenantId,
              revision: enterpriseGovernancePolicies.revision,
            })
            .from(enterpriseGovernancePolicies);
          return rows.map((row) =>
            Object.freeze({ tenantId: row.tenantId, revision: row.revision }),
          );
        });
      },

      async readRawInstall(tenantId, workspaceId, templateRef) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const [row] = await tx
            .select()
            .from(enterpriseTemplateInstalls)
            .where(
              and(
                eq(enterpriseTemplateInstalls.tenantId, tenantId),
                eq(enterpriseTemplateInstalls.workspaceId, workspaceId),
                eq(enterpriseTemplateInstalls.templateRef, templateRef),
              ),
            )
            .limit(1);
          return row ? { ...row } : null;
        });
      },

      async attemptCrossTenantInstallWrite(input) {
        await recordRole(operator, "operator");
        const result = (await operator.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '10s'`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${input.contextTenantId}, true)`,
          );
          return tx.execute(
            sql`update enterprise_template_installs set document = '{"tampered":true}'::jsonb, revision = revision + 1 where tenant_id = ${input.targetTenantId} and workspace_id = ${input.workspaceId} and template_ref = ${input.templateRef}`,
          );
        })) as unknown;
        // An UPDATE without RETURNING yields no rows; the affected-row count is
        // the only signal that the RLS did (0) or did not (≥1) block the write.
        const rows = Array.isArray(result)
          ? result
          : ((result as { rows?: unknown[] })?.rows ?? []);
        const count = (result as { count?: unknown }).count;
        return typeof count === "number" ? count : rows.length;
      },

      restrictedCalls() {
        return [...restricted];
      },

      async dispose() {
        const failures: unknown[] = [];
        try {
          await setupDatabase
            .delete(enterpriseTemplateInstalls)
            .where(like(enterpriseTemplateInstalls.tenantId, `${prefix}%`));
          await setupDatabase
            .delete(enterpriseGovernanceOverrides)
            .where(like(enterpriseGovernanceOverrides.tenantId, `${prefix}%`));
          await setupDatabase
            .delete(enterpriseGovernancePolicies)
            .where(like(enterpriseGovernancePolicies.tenantId, `${prefix}%`));
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
            "Routing policy fixture disposal failed.",
          );
        }
      },
    };
    return fixture;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await setupDatabase
        .delete(enterpriseTemplateInstalls)
        .where(like(enterpriseTemplateInstalls.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseGovernanceOverrides)
        .where(like(enterpriseGovernanceOverrides.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseGovernancePolicies)
        .where(like(enterpriseGovernancePolicies.tenantId, `${prefix}%`));
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
      "Routing policy fixture creation failed.",
    );
  }
}
