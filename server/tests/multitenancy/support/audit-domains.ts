// MT078（Issue #121）共享夹具：审计分域与计费管理授权。
//
// 契约：专用企业测试库（TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL，
// openbot_enterprise_* 命名、仅回环），缺显式 env 由调用方整套显式 skip，绝不
// 回退开发库、skipped 不计通过。两张新表按各自访问模型置备：
//
//   - enterprise_audit_events 走受限 operator 通道 + RLS（本票主表）——夹具
//     提供已验证的 directory/data/operator 三条受限通道与
//     queryRestricted seam（事务本地 app.* pin），正反用例都跑真实角色。
//   - billing_company_manage_grants 跟随 billing 域 owner 通道（与 MT073
//     同款）；套件内用 has_table_privilege 断言受限角色对两张新表的授权
//     形状（audit 表：operator 有 SELECT/INSERT、directory/data 零授权；
//     manage 表：三角色全零授权）。
//
// 种子（spec §11 最低测试身份的裁剪）：公司 A（auditor / tenant_admin /
// member / 被授计费管理的 manager）；公司 B（tenant_admin）承载跨公司反向；
// A/B 各绑唯一计费 Customer + 公司账户（计费管理动作的真实账面）。平台主体
// 是合成身份（{kind:"platform"}），不需要数据库行。dispose 按前缀级联清扫。

import { randomUUID } from "node:crypto";
import { like, type SQL, sql } from "drizzle-orm";
import {
  type CreditWriter,
  createCreditWriter,
} from "../../../src/billing/credits-writer";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "../../../src/billing/payer-accounts";
import { createDatabase, type Database } from "../../../src/db/client";
import { billingCustomers } from "../../../src/db/schema/billing";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
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
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
  ROLE_DATABASE_VARIABLES,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probeAuditDomainsEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const variable = enterpriseSetupDatabaseVariable();
  if (!process.env[variable]?.trim()) {
    return {
      ok: false,
      reason: `MT078 requires ${variable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  // The fixture depends on all three restricted channels, not just the setup URL:
  // a missing channel env must skip up front instead of failing mid-provision.
  for (const [role, channelVariable] of Object.entries(
    ROLE_DATABASE_VARIABLES,
  )) {
    if (!process.env[channelVariable]?.trim()) {
      return {
        ok: false,
        reason: `MT078 requires ${channelVariable} (the ${role} restricted channel) — no dev-database fallback`,
      };
    }
  }
  return { ok: true };
}

/** 受限业务查询上下文；`undefined` = 不带任何 pin（RLS 地板的负例）。 */
export type RestrictedContext =
  | Readonly<{ tenantId: string; principalId?: string }>
  | undefined;

export type AuditDomainsFixture = Readonly<{
  /** owner 通道：身份/计费事实置备与清理。 */
  db: Database;
  payer: PayerAccountService;
  writer: CreditWriter;
  /** 已验证的受限三通道（capability 校验通过的真实角色连接）。 */
  operator: OperatorDatabase;
  data: DataDatabase;
  directory: DirectoryDatabase;
  /** 受限角色事务内参数化查询（事务本地 app.* pin，与生产同纪律）。 */
  queryRestricted(
    role: "directory" | "data" | "operator",
    context: RestrictedContext,
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  ids: Readonly<{
    companyA: string;
    companyB: string;
    teamA1: string;
    teamB1: string;
    customerA: string;
    customerB: string;
  }>;
  /** 按稳定键取主体（成员资格事实见 HUMAN_PLAN）。 */
  caller(key: AuditIdentityKey): { principalId: string; userId: string };
  /** 平台主体名（合成，无数据库行）。 */
  readonly platformSubject: string;
  balanceOf(companyKey: "company-a" | "company-b"): Promise<number>;
  dispose(): Promise<void>;
}>;

export type AuditIdentityKey =
  | "a-auditor"
  | "a-admin"
  | "a-member"
  | "a-manager"
  | "b-admin";

/** 谁（稳定键）在哪家公司是什么角色。 */
const HUMAN_PLAN: ReadonlyArray<{
  readonly key: AuditIdentityKey;
  readonly company: "company-a" | "company-b";
  readonly role: "auditor" | "tenant_admin" | "member";
}> = [
  { key: "a-auditor", company: "company-a", role: "auditor" },
  { key: "a-admin", company: "company-a", role: "tenant_admin" },
  { key: "a-member", company: "company-a", role: "member" },
  { key: "a-manager", company: "company-a", role: "member" },
  { key: "b-admin", company: "company-b", role: "tenant_admin" },
];

export async function createAuditDomainsFixture(): Promise<AuditDomainsFixture> {
  const db = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 10 });
  const payer = createPayerAccountService(db);
  const writer = createCreditWriter(db);

  const run = `mt078-${randomUUID().slice(0, 8)}`;
  const ids = {
    companyA: `${run}-company-a`,
    companyB: `${run}-company-b`,
    teamA1: `${run}-team-a1`,
    teamB1: `${run}-team-b1`,
    customerA: `${run}-cust-company-a`,
    customerB: `${run}-cust-company-b`,
  };
  const principalOf = (key: string) => `${run}-principal-${key}`;
  const userIdOf = (key: string) => `${run}-user-${key}`;

  // ---- 全局身份：用户 + principal（User/Principal 全局，spec §4.1）。 ----
  await db.insert(users).values(
    HUMAN_PLAN.map((planned) => ({
      id: userIdOf(planned.key),
      email: `${principalOf(planned.key)}@mt078.test`,
    })),
  );
  await db.insert(enterprisePrincipals).values(
    HUMAN_PLAN.map((planned) => ({
      id: principalOf(planned.key),
      userId: userIdOf(planned.key),
    })),
  );

  // ---- 公司与团队（A：a1；B：b1）。 ----
  await db.insert(enterpriseTenants).values([
    { id: ids.companyA, name: "MT078 Company A" },
    { id: ids.companyB, name: "MT078 Company B" },
  ]);
  await db.insert(enterpriseWorkspaces).values([
    { tenantId: ids.companyA, id: ids.teamA1, name: "MT078 Team A1" },
    { tenantId: ids.companyB, id: ids.teamB1, name: "MT078 Team B1" },
  ]);

  // ---- 成员资格（a-auditor 是 auditor；a-admin 是 tenant_admin）。 ----
  await db.insert(enterpriseMemberships).values(
    HUMAN_PLAN.map((planned) => ({
      tenantId: planned.company === "company-a" ? ids.companyA : ids.companyB,
      principalId: principalOf(planned.key),
      role: planned.role,
    })),
  );

  // ---- 计费侧：A/B 各绑唯一计费 Customer + 公司账户（计费管理动作的账面）。 ----
  await db
    .insert(billingCustomers)
    .values(
      [ids.customerA, ids.customerB].map((externalId) => ({ externalId })),
    );
  for (const [tenantId, externalCustomerId] of [
    [ids.companyA, ids.customerA],
    [ids.companyB, ids.customerB],
  ] as const) {
    await payer.bindCompanyCustomer({
      tenantId,
      externalCustomerId,
      actor: "mt078-fixture",
    });
    await payer.registerCompanyAccount({ tenantId, actor: "mt078-fixture" });
  }

  // ---- 受限三通道（真实角色，capability 校验通过后才可用）。 ----
  const openVerified = async <T extends Database>(
    verify: (database: Database) => Promise<T>,
  ): Promise<T> => {
    // max: 1：受限查询复用同一后端连接，事务本地 pin 不会跨连接泄漏。
    const candidate = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom(
        verify === verifyDirectoryDatabase
          ? "directory"
          : verify === verifyDataDatabase
            ? "data"
            : "operator",
      ),
      { max: 1 },
    );
    try {
      return await verify(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  };
  const directory = await openVerified(verifyDirectoryDatabase);
  const data = await openVerified(verifyDataDatabase);
  const operator = await openVerified(verifyOperatorDatabase);

  const runRestrictedQuery = async (
    role: "directory" | "data" | "operator",
    context: RestrictedContext,
    text: string,
    values: readonly unknown[],
  ) => {
    const connection =
      role === "directory" ? directory : role === "data" ? data : operator;
    return connection.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      if (context) {
        const settings: SQL[] = [
          sql`set_config('app.tenant_id', ${context.tenantId}, true)`,
        ];
        if (context.principalId) {
          settings.push(
            sql`set_config('app.principal_id', ${context.principalId}, true)`,
          );
        }
        await tx.execute(sql`select ${sql.join(settings, sql`, `)}`);
      }
      const pattern = /\$(\d{1,4})\b/g;
      const parts: SQL[] = [];
      let cursor = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        if (match.index > cursor) {
          parts.push(sql.raw(text.slice(cursor, match.index)));
        }
        parts.push(sql`${values[Number(match[1]) - 1]}`);
        cursor = match.index + match[0].length;
        match = pattern.exec(text);
      }
      if (cursor < text.length) parts.push(sql.raw(text.slice(cursor)));
      const result = (await tx.execute(
        sql.join(parts, sql.raw("")),
      )) as unknown;
      // A shape drift must fail loudly: [] would let every RLS assertion pass
      // against a probe that never actually returned rows.
      if (!Array.isArray(result)) {
        throw new Error("RESTRICTED_QUERY_SHAPE_DRIFT");
      }
      return result as Record<string, unknown>[];
    });
  };

  return {
    db,
    payer,
    writer,
    operator,
    data,
    directory,
    queryRestricted: runRestrictedQuery,
    ids,
    caller(key) {
      if (!HUMAN_PLAN.some((planned) => planned.key === key)) {
        throw new Error(`MT078 fixture: unknown identity key ${key}`);
      }
      return { principalId: principalOf(key), userId: userIdOf(key) };
    },
    platformSubject: `${run}-platform-operator`,
    async balanceOf(companyKey) {
      return writer.availableBalance(
        companyKey === "company-a" ? ids.customerA : ids.customerB,
      );
    },
    async dispose() {
      // 先事实后身份，前缀级联清扫；审计/授权/账面全在清扫面内。
      // 清扫放 try、关池放 finally：任一 delete 抛错也不漏关四个连接池。
      try {
        await db.execute(
          sql`delete from enterprise_audit_events where tenant_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from billing_company_manage_grants where tenant_id like ${`${run}%`} or granted_by like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from credit_reservations where external_customer_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from credit_ledger where external_customer_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from credit_grants where external_customer_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from billing_account_audit where tenant_id like ${`${run}%`} or external_customer_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from billing_credit_accounts where external_customer_id like ${`${run}%`}`,
        );
        await db.execute(
          sql`delete from billing_customer_mappings where tenant_id like ${`${run}%`} or external_customer_id like ${`${run}%`}`,
        );
        await db
          .delete(billingCustomers)
          .where(like(billingCustomers.externalId, `${run}%`));
        await db
          .delete(enterpriseMemberships)
          .where(like(enterpriseMemberships.tenantId, `${run}%`));
        await db
          .delete(enterpriseWorkspaces)
          .where(like(enterpriseWorkspaces.tenantId, `${run}%`));
        await db
          .delete(enterpriseTenants)
          .where(like(enterpriseTenants.id, `${run}%`));
        await db
          .delete(enterprisePrincipals)
          .where(like(enterprisePrincipals.id, `${run}%`));
        await db.delete(users).where(like(users.id, `${run}%`));
      } finally {
        for (const connection of [operator, data, directory]) {
          await connection.$client.close();
        }
        await db.$client.close();
      }
    },
  };
}

/** 直查一家公司审计事件行数（owner 通道，绕过 RLS 的对照读数）。 */
export async function auditRowCount(
  db: Database,
  tenantId: string,
  domain: string,
): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as count from enterprise_audit_events where tenant_id = ${tenantId} and domain = ${domain}`,
  )) as unknown as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}
