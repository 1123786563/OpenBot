/**
 * Public-bot-usage fixture (MT018 / Issue #61).
 *
 * Provisions two real companies (A with teams A1/A2, B with team B1) through
 * the real offline provisioning factory on the dedicated enterprise test
 * database, materializes real `enterprise_workspace_memberships` rows for
 * each planned (company, team, principal), and hands the suite the REAL
 * production surfaces under test — no stand-ins on any decision path:
 *
 *   - `ownership`: real MT016 `createBotOwnershipService` (bots are created
 *     through the accepted creation path, so ownership rows are real);
 *   - `publish`: real MT017 `createBotPublishService` (bots reach the
 *     team-public state through the accepted publication path);
 *   - `actions`: real MT009 `createTeamResourceActionService` — the run gate
 *     the MT018 entry composes (never re-implemented here);
 *   - `usage`: the MT018 `createPublicBotUsageService` (module under test);
 *   - `credentialsAdmin` / `credentialViews`: real MT027 admin (register,
 *     grant) and decision services over a memory vault — the personal
 *     credential faces the run entry must not cross;
 *   - `conversations`: real MT021 `createConversationListService` — the
 *     personal-conversation visibility face (creator vs runner);
 *   - `scopeAs`: real `createScopeResolver` over the directory channel — the
 *     same eligibility gate production requests pass, so an identity without
 *     a team membership (the company admin) cannot even mint a scope.
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout; every
 * restricted call records `current_user` so the suite can prove the roles
 * were in play. The only superuser stand-ins are the fixture's own
 * arrangement/probe channels (`setTenantPolicyRevision`, direct row probes),
 * both MT011/MT017-disclosed precedents; the decision side never uses them.
 */

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import { enterpriseResources } from "../../../src/db/schema/enterprise-tenancy";
import {
  type BotPublishAudience,
  type BotPublishService,
  createBotPublishService,
} from "../../../src/enterprise/tenancy/bot-publish";
import {
  type BotOwnershipService,
  createBotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  type ConversationListService,
  createConversationListService,
} from "../../../src/enterprise/tenancy/conversations-list";
import {
  type CredentialOwnershipAdminService,
  type CredentialOwnershipDecisionService,
  createCredentialOwnershipAdminService,
  createCredentialOwnershipDecisionService,
  type SecretVault,
} from "../../../src/enterprise/tenancy/credential-ownership";
import { provisionDeployment } from "../../../src/enterprise/tenancy/provision";
import {
  createPublicBotUsageService,
  type PublicBotUsageService,
} from "../../../src/enterprise/tenancy/public-bot-usage";
import { createScopeResolver } from "../../../src/enterprise/tenancy/store";
import {
  createTeamResourceActionService,
  type TeamResourceActionService,
} from "../../../src/enterprise/tenancy/team-public-rules";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** The named human identities the MT018 suite shares. */
export type PublicBotUsageIdentity =
  | "a1-owner"
  | "a1-member"
  | "a1-member2"
  | "a2-member"
  | "a1a2-member"
  | "b1-member"
  | "multi-company"
  | "company-admin";

export type RestrictedCall = Readonly<{
  role: "data" | "operator" | "directory";
  currentUser: string;
}>;

/** Memory vault: envelopes carry the plaintext verbatim (suite-local). */
export class MemoryVault implements SecretVault {
  async seal(plaintext: string): Promise<string> {
    return `sealed:${plaintext}`;
  }
  async open(envelope: string): Promise<string> {
    if (!envelope.startsWith("sealed:")) throw new Error("VAULT_ENVELOPE_BAD");
    return envelope.slice("sealed:".length);
  }
}

export interface PublicBotUsageFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** Real MT016 ownership service (the creation path). */
  readonly ownership: BotOwnershipService;
  /** Real MT017 publish service (bots reach team-public through it). */
  readonly publish: BotPublishService;
  /** Real MT009 team-public action rules (the composed run gate). */
  readonly actions: TeamResourceActionService;
  /** The module under test. */
  readonly usage: PublicBotUsageService;
  /** Real MT027 admin service (register credentials, grant actions). */
  readonly credentialsAdmin: CredentialOwnershipAdminService;
  /** Real MT027 decision service (personal credential faces). */
  readonly credentialViews: CredentialOwnershipDecisionService;
  /** Real MT021 conversation list service (personal session faces). */
  readonly conversations: ConversationListService;
  /** Real scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: PublicBotUsageIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<import("../../../src/enterprise/contracts").PlatformScope>;
  /** The team audience object the MT017 publish path expects. */
  teamAudience(tenantId: string, workspaceId: string): BotPublishAudience;
  /**
   * Seeds one resource registration row through the real operator INSERT
   * policy (MT017-support precedent) — used for the non-bot published
   * resource (run is bot-only per MT009) comparison state.
   */
  seedResourceRow(input: {
    tenantId: string;
    workspaceId: string;
    id: string;
    kind: "bot" | "knowledge_base" | "document";
    displayName: string;
    visibility?: "workspace";
  }): Promise<void>;
  /** Inserts one dependency row through the real operator INSERT policy. */
  addDependency(input: {
    tenantId: string;
    resourceId: string;
    kind: "model" | "credential" | "knowledge";
    ref: string;
    status?: "active" | "invalid";
  }): Promise<void>;
  /**
   * Disclosed superuser stand-in (MT011/MT017 precedent): flips one tenant's
   * policy_revision. The decision side never uses this channel.
   */
  setTenantPolicyRevision(tenantId: string, revision: string): Promise<void>;
  /**
   * RLS probe: conversation rows visible to the restricted data role under
   * one tenant (the ownership facts the run entry must bind correctly).
   */
  readConversationRowsAsData(tenantId: string): Promise<
    readonly Readonly<{
      id: string;
      workspaceId: string;
      principalId: string;
      threadId: string;
      storageBackend: string;
    }>[]
  >;
  /**
   * RLS probe: credential rows visible to the restricted data role under one
   * tenant (id/target/owner facts — never the envelope column).
   */
  readCredentialRowsAsData(tenantId: string): Promise<
    readonly Readonly<{
      id: string;
      target: string;
      classification: string;
      ownerPrincipalId: string | null;
      status: string;
    }>[]
  >;
  /**
   * Count dependency rows for one resource through the restricted data role
   * (zero-write pins after refused run entries).
   */
  countDependenciesAsData(
    tenantId: string,
    resourceId: string,
  ): Promise<{ readonly total: number }>;
  restrictedCalls(): readonly RestrictedCall[];
  dispose(): Promise<void>;
}

const PLANNED_COMPANIES = [
  {
    companyKey: "company-a",
    companyName: "MT018 Company A",
    teams: [
      { teamKey: "team-a1", teamName: "Company A / Team A1" },
      { teamKey: "team-a2", teamName: "Company A / Team A2" },
    ],
  },
  {
    companyKey: "company-b",
    companyName: "MT018 Company B",
    teams: [{ teamKey: "team-b1", teamName: "Company B / Team B1" }],
  },
] as const;

/**
 * Planned human identities. `teams` lists are materialized as real workspace
 * membership rows; an empty list (company-admin) means a real company
 * membership WITHOUT any team — management identity never implies content
 * access (Spec §4.1).
 */
const HUMAN_PLAN: readonly {
  identity: PublicBotUsageIdentity;
  memberships: readonly {
    companyKey: "company-a" | "company-b";
    role: "member" | "tenant_admin";
    teams: readonly string[];
  }[];
}[] = [
  {
    // Owns (authors) every bot the suite creates in team A1.
    identity: "a1-owner",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    // The primary runner in team A1.
    identity: "a1-member",
    memberships: [
      { companyKey: "company-a", role: "member", teams: ["team-a1"] },
    ],
  },
  {
    // A second runner in team A1 (concurrency acceptance).
    identity: "a1-member2",
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
    // Same person in TWO teams of the SAME company: the scope's team pins
    // binding (the MT016/MT017 precedent: this identity class catches
    // scope-pinning gaps).
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
  {
    identity: "company-admin",
    memberships: [{ companyKey: "company-a", role: "tenant_admin", teams: [] }],
  },
];

export async function createPublicBotUsageFixture(): Promise<PublicBotUsageFixture> {
  const environment = process.env;
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);

  const prefix = `mt018-${randomUUID().slice(0, 8)}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids: Record<string, string> = {};
  for (const company of PLANNED_COMPANIES) {
    ids[company.companyKey] = id(company.companyKey);
    for (const team of company.teams) ids[team.teamKey] = id(team.teamKey);
    ids[`provision-${company.companyKey}`] = id(
      `provision-${company.companyKey}`,
    );
  }
  for (const planned of HUMAN_PLAN) {
    ids[`user-${planned.identity}`] = id(`user-${planned.identity}`);
    ids[`principal-${planned.identity}`] = id(`principal-${planned.identity}`);
  }
  const principalOf = (identity: PublicBotUsageIdentity) =>
    ids[`principal-${identity}`];
  const userOf = (identity: PublicBotUsageIdentity) => ids[`user-${identity}`];

  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  const restricted: RestrictedCall[] = [];
  const recordRole = async (
    connection: Database,
    role: RestrictedCall["role"],
  ) => {
    const result = (await connection.execute(
      sql`select current_user as current_user`,
    )) as unknown;
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

  const dispose = async (created: boolean) => {
    const failures: unknown[] = [];
    if (created) {
      try {
        // Registration-side rows first (no FK from these back into the
        // tenancy scaffold), then the scaffold order. Conversations and
        // messages cascade from their tenant rows.
        await setupDatabase.execute(
          sql`delete from enterprise_resource_dependencies where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resource_grants where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resource_shares where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_resources where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_credential_actions where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_credentials where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_messages where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_conversations where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_preferences where tenant_id like ${`${prefix}%`}`,
        );
        await setupDatabase.execute(
          sql`delete from enterprise_bot_ownership where tenant_id like ${`${prefix}%`}`,
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
        "Public bot usage fixture disposal failed.",
      );
    }
  };

  try {
    // Global identity scaffolding (same order as support/bot-publish.ts):
    // users, then principals bound to them — the provisioning factory
    // refuses unbound principals.
    await setupDatabase.insert(users).values(
      HUMAN_PLAN.map((planned) => ({
        id: userOf(planned.identity),
        email: `${userOf(planned.identity)}@example.invalid`,
        name: `MT018 ${planned.identity}`,
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

    // Real provisioning path: one provisionDeployment call per (company,
    // team). The company admin joins only the company's FIRST provisioning
    // call as tenant_admin and materializes no workspace membership.
    const operatorPrincipalFor = (companyKey: string) =>
      companyKey === "company-a"
        ? principalOf("company-admin")
        : principalOf("b1-member");
    for (const company of PLANNED_COMPANIES) {
      for (const team of company.teams) {
        const isFirstTeamOfCompany =
          company.teams.findIndex(
            (candidate) => candidate.teamKey === team.teamKey,
          ) === 0;
        const members = HUMAN_PLAN.flatMap((planned) =>
          planned.memberships
            .filter(
              (membership) =>
                membership.companyKey === company.companyKey &&
                (membership.teams.includes(team.teamKey) ||
                  (planned.identity === "company-admin" &&
                    isFirstTeamOfCompany)),
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
    // workspace-membership row through the restricted operator role
    // (RLS-checked). Company-admin is deliberately absent.
    const materializeTeamMembership = async (
      tenantId: string,
      workspaceId: string,
      principalId: string,
    ) => {
      await recordRole(operator, "operator");
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${principalOf("company-admin")}, true)`,
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

    // The real request path: session seam → trusted scope. authenticate maps
    // the fixture identity to its real user id; selectors come from the same
    // headers production reads.
    const resolver = createScopeResolver(directory, {
      authenticate: async (request) => {
        const identity = request.headers.get("x-mt018-identity");
        const planned = HUMAN_PLAN.find(
          (candidate) => candidate.identity === identity,
        );
        if (!planned) return null;
        return { actorId: userOf(planned.identity), entrypoint: "web" };
      },
      selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
    });

    const vault = new MemoryVault();

    let disposed = false;
    const fixture: PublicBotUsageFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      ownership: createBotOwnershipService({ data, operator }),
      publish: createBotPublishService({ operator }),
      actions: createTeamResourceActionService(data),
      usage: createPublicBotUsageService(data),
      credentialsAdmin: createCredentialOwnershipAdminService(operator, vault),
      credentialViews: createCredentialOwnershipDecisionService(data, vault),
      conversations: createConversationListService(data),

      async scopeAs(identity, tenantId, workspaceId) {
        if (disposed) throw new Error("FIXTURE_DISPOSED");
        const request = new Request("https://mt018-fixture.invalid/scope", {
          headers: {
            "x-mt018-identity": identity,
            "x-openbot-tenant": tenantId,
            "x-openbot-workspace": workspaceId,
          },
        });
        return resolver.resolve(request);
      },

      teamAudience(tenantId, workspaceId) {
        return Object.freeze({
          type: "team" as const,
          tenantId,
          workspaceId,
        });
      },

      async seedResourceRow({
        tenantId,
        workspaceId,
        id: resourceId,
        kind,
        displayName,
        visibility,
      }) {
        // The operator role's INSERT policy on enterprise_resources requires
        // app.tenant_id to match the row — arrangement stays policy-legal
        // (MT017-support precedent).
        await recordRole(operator, "operator");
        await operator.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.insert(enterpriseResources).values({
            tenantId,
            workspaceId,
            id: resourceId,
            kind,
            displayName,
            visibility: visibility ?? null,
          });
        });
      },

      async addDependency({ tenantId, resourceId, kind, ref, status }) {
        // The MT009 migration grants operator INSERT on the dependency table
        // (tenant-scoped policy). Raw SQL because the dependency table has
        // no drizzle schema file (MT009 precedent).
        await recordRole(operator, "operator");
        await operator.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.execute(sql`
            insert into enterprise_resource_dependencies
              (tenant_id, resource_id, dependency_kind, dependency_ref, status)
            values (${tenantId}, ${resourceId}, ${kind}, ${ref}, ${status ?? "active"})
          `);
        });
      },

      async setTenantPolicyRevision(tenantId, revision) {
        // Disclosed superuser stand-in: enterprise_tenants ships no UPDATE
        // policy for any restricted role; policy_revision is chosen at
        // provisioning time in this tree. Never used on the decision side.
        await setupDatabase.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          const updated = await tx.execute(sql`
            update enterprise_tenants
            set policy_revision = ${revision}
            where id = ${tenantId}
          `);
          const changed = Number(
            (updated as unknown as { count?: number }).count ?? 0,
          );
          if (changed !== 1) {
            throw new Error(
              `TENANT_POLICY_REVISION_FAILED:${tenantId}:${revision}:${changed}`,
            );
          }
        });
      },

      async readConversationRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select id, workspace_id, principal_id, thread_id, storage_backend from enterprise_conversations order by thread_id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{
              id: string;
              workspace_id: string;
              principal_id: string;
              thread_id: string;
              storage_backend: string;
            }>[]
          ).map((row) =>
            Object.freeze({
              id: row.id,
              workspaceId: row.workspace_id,
              principalId: row.principal_id,
              threadId: row.thread_id,
              storageBackend: row.storage_backend,
            }),
          );
        });
      },

      async readCredentialRowsAsData(tenantId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select id, target, classification, owner_principal_id, status from enterprise_credentials order by id asc`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          return (
            list as Readonly<{
              id: string;
              target: string;
              classification: string;
              owner_principal_id: string | null;
              status: string;
            }>[]
          ).map((row) =>
            Object.freeze({
              id: row.id,
              target: row.target,
              classification: row.classification,
              ownerPrincipalId: row.owner_principal_id,
              status: row.status,
            }),
          );
        });
      },

      async countDependenciesAsData(tenantId, resourceId) {
        await recordRole(data, "data");
        return data.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          const rows = (await tx.execute(
            sql`select count(*)::int as total from enterprise_resource_dependencies where resource_id = ${resourceId}`,
          )) as unknown;
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: unknown[] })?.rows ?? []);
          const first = (list as Readonly<{ total?: number }>[])[0];
          return Object.freeze({ total: Number(first?.total ?? 0) });
        });
      },

      restrictedCalls() {
        return [...restricted];
      },

      async dispose() {
        disposed = true;
        await dispose(true);
      },
    };
    return fixture;
  } catch (error) {
    const cleanupFailures: unknown[] = [error];
    try {
      await dispose(false);
    } catch (disposeError) {
      cleanupFailures.push(disposeError);
    }
    throw new AggregateError(
      cleanupFailures,
      "Public bot usage fixture creation failed.",
    );
  }
}
