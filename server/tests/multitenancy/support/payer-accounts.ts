// MT069（Issue #112）共享夹具：公司计费 Customer 映射与公司/个人账户类型。
//
// 契约：专用企业测试库（TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL，
// openbot_enterprise_* 命名、仅回环），缺显式 env 由调用方整套显式 skip，绝不回退
// 开发库。三张新表跟随 billing 域访问模型（owner 通道、无 RLS）——夹具因此用
// owner 连接（生产计费路径同款），并在套件内用 has_table_privilege 断言受限
// ob_ent_* 角色对三表零授权（结构隔离）。
//
// 种子：公司 A/B（enterprise_tenants）+ 两个用户（users）+ 四个计费 Customer
// （billing_customers，前缀 mt069- 隔离）。dispose 按依赖逆序级联清理。

import { randomUUID } from "node:crypto";
import { inArray, like, sql } from "drizzle-orm";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "../../../src/billing/payer-accounts";
import { createDatabase, type Database } from "../../../src/db/client";
import { billingCustomers } from "../../../src/db/schema/billing";
import { users } from "../../../src/db/schema/core";
import { enterpriseTenants } from "../../../src/db/schema/enterprise-tenancy";
import {
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probePayerAccountsEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const variable = enterpriseSetupDatabaseVariable();
  if (!process.env[variable]?.trim()) {
    return {
      ok: false,
      reason: `MT069 requires ${variable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

export type PayerAccountsFixture = Readonly<{
  db: Database;
  service: PayerAccountService;
  /** 种子身份：两家公司、两个用户、四个计费 Customer。 */
  ids: Readonly<{
    companyA: string;
    companyB: string;
    user1: string;
    user2: string;
    /** companyA 的映射 Customer。 */
    customerA: string;
    customerFree1: string;
    customerFree2: string;
    customerFree3: string;
  }>;
  dispose(): Promise<void>;
}>;

export async function createPayerAccountsFixture(): Promise<PayerAccountsFixture> {
  const db = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 4,
  });
  const run = `mt069-${randomUUID().slice(0, 8)}`;
  const ids = {
    companyA: `${run}-company-a`,
    companyB: `${run}-company-b`,
    user1: `${run}-user-1`,
    user2: `${run}-user-2`,
    customerA: `${run}-cust-a`,
    customerFree1: `${run}-cust-free-1`,
    customerFree2: `${run}-cust-free-2`,
    customerFree3: `${run}-cust-free-3`,
  };

  await db.insert(enterpriseTenants).values([
    { id: ids.companyA, name: "MT069 Company A" },
    { id: ids.companyB, name: "MT069 Company B" },
  ]);
  await db.insert(users).values([
    { id: ids.user1, email: `${ids.user1}@mt069.test` },
    { id: ids.user2, email: `${ids.user2}@mt069.test` },
  ]);
  await db
    .insert(billingCustomers)
    .values(
      [
        ids.customerA,
        ids.customerFree1,
        ids.customerFree2,
        ids.customerFree3,
      ].map((externalId) => ({ externalId })),
    );

  return {
    db,
    service: createPayerAccountService(db),
    ids,
    async dispose() {
      // 级联清理：audit/mappings/accounts 随 tenant/customer/users 级联消失；
      // 显式再删一次隔离前缀行，防种子以外的残留。清扫放 try、关池放
      // finally：任一 delete 抛错也不漏关连接池。
      try {
        await db.execute(
          // account_id is `bca-<hex>` with no run prefix (generateAccountId), so an
          // account_id clause can never match; tenant_id/external_customer_id carry the run.
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
        await db.delete(users).where(inArray(users.id, [ids.user1, ids.user2]));
        await db
          .delete(enterpriseTenants)
          .where(inArray(enterpriseTenants.id, [ids.companyA, ids.companyB]));
      } finally {
        await db.$client.close();
      }
    },
  };
}
