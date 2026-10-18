// MT122（Issue #165）入口上下文夹具：真实 PostgreSQL（专用库三受限角色 +
// RLS），零授权 mock；缺专用库 env 由调用方整套显式 skip，绝不静默 pass。
//
// 组成（只读消费既有交付，零改动）：
//   - MT014 createRuntimeConfigFixture：公司 A（teams a1/a2）+ 公司 B（b1）
//     的真实离线供给、operator 受限通道配置写入、真实 data 受限通道；
//   - directory/data 受限通道（与企业入口同一 verifyDirectoryDatabase /
//     verifyDataDatabase 校验面），交给 createDeploymentEntryContextFactory；
//   - 会话解析闭包：x-mt122-session 头 → 已认证身份（web），与
//     index.ts 的 authenticateEnterpriseRequest 同形（无会话 → null）。
// 本票新增：
//   - 公司 A 配置 + team-a2 覆盖（operator 通道写）；公司 B 刻意不写配置行
//     （RUNTIME_CONFIG_NOT_FOUND 用例的事实源）；
//   - 机器身份：users + principals 行存在、无任何成员资格（机器上下文拒绝
//     用例的事实源）；随 rc 前缀一并清理。

import { sql } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import { enterprisePrincipals } from "../../../src/db/schema";
import { users } from "../../../src/db/schema/core";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import { createRuntimeConfigFixture } from "./runtime-config";

/** 公司 A 的运行配置（与 MT014 用例同形；只含引用，绝不含凭据值）。 */
const COMPANY_A_DOCUMENT = Object.freeze({
  model: {
    provider: "openai",
    credentialRef: "secret-ref://company-a/model-key",
    defaultModel: "gpt-4o",
    allowedModels: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  botDefaults: {
    availableAgentIds: ["agent-a-support", "agent-a-finance"],
    defaultAgentId: "agent-a-support",
  },
  credentials: [
    {
      purpose: "model",
      ref: "secret-ref://company-a/model-key",
      access: "company",
    },
  ],
  planMapping: {
    billingExternalCustomerId: "openbot-company-a-customer",
    plan: "enterprise-2026",
  },
});

/** team-a2 的收窄覆盖（AC2 双上下文差异的事实源）。 */
const TEAM_A2_NARROWING_OVERRIDE = Object.freeze({
  model: {
    allowedModels: ["gpt-4o-mini"],
    defaultModel: "gpt-4o-mini",
  },
  botDefaults: {
    defaultAgentId: "agent-a-finance",
  },
});

export interface EntryContextFixture {
  readonly ids: Readonly<Record<string, string>>;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly teamA1: string;
  readonly teamA2: string;
  readonly teamB1: string;
  /** 公司 A 管理员的登录用户 id（会话 actorId 的事实源）。 */
  readonly userA: string;
  /** 公司 B 管理员的登录用户 id。 */
  readonly userB: string;
  /** 已持久化（users+principals）但无任何成员资格的机器身份。 */
  readonly machineUserId: string;
  readonly directory: DirectoryDatabase;
  readonly data: DataDatabase;
  /** 与 index.ts authenticateEnterpriseRequest 同形的会话解析闭包。 */
  authenticate(request: Request): Promise<{
    actorId: string;
    entrypoint: "web";
  } | null>;
  /** 公司配置写入（operator 受限通道，RLS 校验）。 */
  writeCompanyConfig(
    tenantId: string,
    document: unknown,
    revision: number,
  ): Promise<void>;
  /** 团队覆盖写入。 */
  writeTeamOverride(
    tenantId: string,
    workspaceId: string,
    document: unknown,
    revision: number,
  ): Promise<void>;
  /** 团队成员资格状态翻转（setup 披露 stand-in，同 MT011 口径；判定侧从不使用）。 */
  setWorkspaceMembershipStatus(
    tenantId: string,
    workspaceId: string,
    principalId: string,
    status: "active" | "suspended",
  ): Promise<void>;
  /** 受限通道身份探针（current_database/current_user，证实专用库 + 受限角色）。 */
  probeIdentity(): Promise<{ database: string; currentUser: string }>;
  dispose(): Promise<void>;
}

export type CreateEntryContextFixtureOptions = Readonly<{
  environment?: Record<string, string | undefined>;
}>;

export async function createEntryContextFixture(
  options: CreateEntryContextFixtureOptions = {},
): Promise<EntryContextFixture> {
  const environment = options.environment ?? process.env;
  const rc = await createRuntimeConfigFixture({ environment });
  const prefix = rc.idPrefix;

  const directoryUrl = enterpriseRuntimeDatabaseUrlFrom(
    "directory",
    environment,
  );
  const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", environment);
  const operatorUrl = enterpriseRuntimeDatabaseUrlFrom("operator", environment);
  const setupUrl = enterpriseTestDatabaseUrlFrom(environment);
  const setupDatabase = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];

  try {
    // 机器身份：持久化身份存在（users + principals），无任何成员资格行。
    const machineUserId = `${prefix}-machine-user`;
    await setupDatabase.insert(users).values({
      id: machineUserId,
      email: `${machineUserId}@example.invalid`,
      name: "MT122 machine identity",
    });
    await setupDatabase.insert(enterprisePrincipals).values({
      id: `${prefix}-machine-principal`,
      userId: machineUserId,
    });

    const directory = (await verifyDirectoryDatabase(
      createDatabase(directoryUrl, { max: 1 }),
    )) as DirectoryDatabase;
    const data = (await verifyDataDatabase(
      createDatabase(dataUrl, { max: 1 }),
    )) as DataDatabase;
    const operator = (await verifyOperatorDatabase(
      createDatabase(operatorUrl, { max: 1 }),
    )) as OperatorDatabase;
    closeables.push(directory.$client, data.$client, operator.$client);

    // MT005 同款事实源：每个成员在其公司各团队的真实
    // enterprise_workspace_memberships 行（受限 operator 角色，RLS 校验；
    // MT004 迁移授予的 INSERT——供给工厂不建团队资格，同 MT004 夹具口径）。
    const insertWorkspaceMembership = async (
      tenantId: string,
      workspaceId: string,
      principalId: string,
    ) => {
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${rc.ids["principal-company-a"]}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id)
          values (${tenantId}, ${workspaceId}, ${principalId})
        `);
      });
    };
    await insertWorkspaceMembership(
      rc.ids["company-a"],
      rc.ids["team-a1"],
      rc.ids["principal-company-a"],
    );
    await insertWorkspaceMembership(
      rc.ids["company-a"],
      rc.ids["team-a2"],
      rc.ids["principal-company-a"],
    );
    await insertWorkspaceMembership(
      rc.ids["company-b"],
      rc.ids["team-b1"],
      rc.ids["principal-company-b"],
    );

    // 配置事实源：公司 A 有配置 + a2 团队覆盖；公司 B 刻意无配置行。
    await rc.writeCompanyConfig(rc.ids["company-a"], COMPANY_A_DOCUMENT, 3);
    await rc.writeTeamOverride(
      rc.ids["company-a"],
      rc.ids["team-a2"],
      TEAM_A2_NARROWING_OVERRIDE,
      1,
    );

    const sessionUsers = new Set([
      rc.ids["admin-company-a"],
      rc.ids["admin-company-b"],
    ]);

    const fixture: EntryContextFixture = {
      ids: rc.ids,
      tenantA: rc.ids["company-a"],
      tenantB: rc.ids["company-b"],
      teamA1: rc.ids["team-a1"],
      teamA2: rc.ids["team-a2"],
      teamB1: rc.ids["team-b1"],
      userA: rc.ids["admin-company-a"],
      userB: rc.ids["admin-company-b"],
      machineUserId,
      directory,
      data,

      async authenticate(request) {
        const userId = request.headers.get("x-mt122-session");
        if (!userId || !sessionUsers.has(userId)) return null;
        return { actorId: userId, entrypoint: "web" };
      },

      writeCompanyConfig: (tenantId, document, revision) =>
        rc.writeCompanyConfig(tenantId, document, revision),
      writeTeamOverride: (tenantId, workspaceId, document, revision) =>
        rc.writeTeamOverride(tenantId, workspaceId, document, revision),

      async setWorkspaceMembershipStatus(
        tenantId,
        workspaceId,
        principalId,
        status,
      ) {
        // 精确条件更新（setup 披露 stand-in；判定侧从不使用，同 MT011 口径）。
        await setupDatabase.execute(sql`
          update enterprise_workspace_memberships
             set status = ${status}
           where tenant_id = ${tenantId}
             and workspace_id = ${workspaceId}
             and principal_id = ${principalId}
        `);
      },

      async probeIdentity() {
        const result = (await data.execute(
          sql`select current_database() as database, current_user as current_user`,
        )) as unknown;
        const rows = Array.isArray(result)
          ? result
          : ((result as { rows?: unknown[] })?.rows ?? []);
        const first = (
          rows as Readonly<{
            database?: unknown;
            current_user?: unknown;
          }>[]
        )[0];
        return {
          database: typeof first?.database === "string" ? first.database : "",
          currentUser:
            typeof first?.current_user === "string" ? first.current_user : "",
        };
      },

      async dispose() {
        const failures: unknown[] = [];
        // 本夹具新增的团队资格行先清（引用 tenant/workspace/principal，须在
        // rc.dispose 级联删除之前移除）。
        try {
          await setupDatabase.execute(sql`
            delete from enterprise_workspace_memberships
             where tenant_id like ${`${prefix}%`}
          `);
        } catch (error) {
          failures.push(error);
        }
        try {
          await rc.dispose();
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
            "Entry context fixture disposal failed.",
          );
        }
      },
    };
    return fixture;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await rc.dispose();
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
      "Entry context fixture setup failed; partial state discarded.",
    );
  }
}
