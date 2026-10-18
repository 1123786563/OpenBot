// MT073（Issue #116）共享夹具：账务可见性——付款人订单、公司财务授权与团队用量视图。
//
// 契约：专用企业测试库（TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL，
// openbot_enterprise_* 命名、仅回环），缺显式 env 由调用方整套显式 skip，绝不回退
// 开发库、skipped 不计通过。billing_company_finance_grants 跟随 billing 域访问模型
// （MT069/MT070 D2 裁决：owner 通道、无 RLS）——夹具用 setup/owner 连接种身份与
// 计费事实（生产计费路径同款），并在套件内用 has_table_privilege 断言受限
// ob_ent_* 角色对新表零授权（结构隔离）。
//
// 种子（spec §11 最低测试身份的裁剪）：公司 A（团队甲 a1 / 乙 a2，含 tenant_admin
// 角色成员）承载授权/账务/订单互不可见语义；公司 B（团队丙 b1）承载跨公司反向；
// 公司 C（团队 c1）刻意**无计费映射**（授权读者看空账簿的边缘）。grant 金额由单个
// 用例自行发放（隔离前缀 mt073-）。dispose 按依赖逆序级联清理，全部按前缀清扫、
// 防种子以外的残留。

import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  type CreditWriter,
  createCreditWriter,
} from "../../../src/billing/credits-writer";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "../../../src/billing/payer-accounts";
import { createPaymentStore } from "../../../src/billing/payments/store";
import type {
  PaymentOrderRecord,
  PaymentStore,
} from "../../../src/billing/payments/types";
import { createDatabase, type Database } from "../../../src/db/client";
import { billingCustomers } from "../../../src/db/schema/billing";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../../src/db/schema/enterprise-tenancy";
import { paymentEvents, paymentOrders } from "../../../src/db/schema/payment";
import {
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probeBillingVisibilityEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const variable = enterpriseSetupDatabaseVariable();
  if (!process.env[variable]?.trim()) {
    return {
      ok: false,
      reason: `MT073 requires ${variable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

/** 一个可发起公司账务读取的主体：principal（经成员资格事实锚定到公司）。 */
export interface ReaderIdentity {
  readonly principalId: string;
  readonly userId: string;
}

type CompanyKey = "company-a" | "company-b" | "company-c";

export type BillingVisibilityFixture = Readonly<{
  db: Database;
  /** 既有 MT069 交付：映射/账户唯一写入面（本票只读消费）。 */
  payer: PayerAccountService;
  /** 既有扣费 writer（本票只读消费——余额/预扣/结算的权威）。 */
  writer: CreditWriter;
  /** 既有支付订单 store（AC1/AC4 回归的真实创建人过滤面，只读消费）。 */
  store: PaymentStore;
  ids: Readonly<{
    companyA: string;
    companyB: string;
    companyC: string;
    teamA1: string;
    teamA2: string;
    teamB1: string;
    teamC1: string;
    customerA: string;
    customerB: string;
    /** 个人账户对照（AC3：个人直连消费绝不进公司账簿）。 */
    personalCustomer: string;
  }>;
  /** 按稳定键取成员主体（成员资格事实见 HUMAN_PLAN）。 */
  caller(key: string): ReaderIdentity;
  /** 读一家公司计费 Customer 当前的可花余额（writer 权威口径）。 */
  balanceOf(
    companyKey: "company-a" | "company-b" | "personal",
  ): Promise<number>;
  /** 给一家公司的计费 Customer 发一笔 grant（×100 整数），返回 grant id。 */
  seedGrant(
    companyKey: "company-a" | "company-b" | "personal",
    totalCents: number,
    key: string,
  ): Promise<string>;
  /**
   * 种一笔订单并立即置为 canceled（释放部署唯一 pending 槽位，让多成员各持
   * 独立订单行）——列表/详情/计数回归的事实底座。
   */
  seedOrder(createdByUserId: string, tag: string): Promise<PaymentOrderRecord>;
  /** 种一笔保持 pending 的订单（同键只允许一笔——部署唯一 pending 槽位）。 */
  seedLiveOrder(
    createdByUserId: string,
    tag: string,
  ): Promise<PaymentOrderRecord>;
  /** 成员资格状态翻转（A5 邻接：停用/恢复；owner 通道，MT010 D5 同款披露）。 */
  setMembershipStatus(
    tenantId: string,
    principalId: string,
    status: "active" | "suspended",
  ): Promise<void>;
  dispose(): Promise<void>;
}>;

/** 谁（稳定键）在哪家公司是什么角色；团队资格对本票语义不另设门槛（spec §7）。 */
const HUMAN_PLAN: ReadonlyArray<{
  readonly key: string;
  readonly companies: ReadonlyArray<{
    readonly company: CompanyKey;
    readonly role: string;
  }>;
}> = [
  { key: "a1-member", companies: [{ company: "company-a", role: "member" }] },
  { key: "a1-mate", companies: [{ company: "company-a", role: "member" }] },
  { key: "a2-member", companies: [{ company: "company-a", role: "member" }] },
  {
    key: "a-admin",
    companies: [{ company: "company-a", role: "tenant_admin" }],
  },
  { key: "b-member", companies: [{ company: "company-b", role: "member" }] },
  {
    key: "both-companies",
    companies: [
      { company: "company-a", role: "member" },
      { company: "company-b", role: "member" },
    ],
  },
  { key: "c-member", companies: [{ company: "company-c", role: "member" }] },
];

export async function createBillingVisibilityFixture(): Promise<BillingVisibilityFixture> {
  const db = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 10 });
  const payer = createPayerAccountService(db);
  const writer = createCreditWriter(db);
  const store = createPaymentStore(db);

  const run = `mt073-${randomUUID().slice(0, 8)}`;
  const ids = {
    companyA: `${run}-company-a`,
    companyB: `${run}-company-b`,
    companyC: `${run}-company-c`,
    teamA1: `${run}-team-a1`,
    teamA2: `${run}-team-a2`,
    teamB1: `${run}-team-b1`,
    teamC1: `${run}-team-c1`,
    customerA: `${run}-cust-company-a`,
    customerB: `${run}-cust-company-b`,
    personalCustomer: `${run}-cust-personal`,
  };

  const principalOf = (key: string) => `${run}-principal-${key}`;
  const userIdOf = (key: string) => `${run}-user-${key}`;
  const personalUserKey = "personal-user";

  // ---- 全局身份：用户 + principal（User/Principal 全局，spec §4.1）。 ----
  await db.insert(users).values(
    [...HUMAN_PLAN.map((p) => p.key), personalUserKey].map((key) => ({
      id: userIdOf(key),
      email: `${principalOf(key)}@mt073.test`,
    })),
  );
  await db.insert(enterprisePrincipals).values(
    [...HUMAN_PLAN.map((p) => p.key), personalUserKey].map((key) => ({
      id: principalOf(key),
      userId: userIdOf(key),
    })),
  );

  // ---- 公司与团队（A：甲/乙；B：丙；C：c1，无计费映射的边缘公司）。 ----
  await db.insert(enterpriseTenants).values(
    (
      [
        ["company-a", ids.companyA],
        ["company-b", ids.companyB],
        ["company-c", ids.companyC],
      ] as const
    ).map(([key, id]) => ({ id, name: `MT073 ${key}` })),
  );
  await db.insert(enterpriseWorkspaces).values([
    { tenantId: ids.companyA, id: ids.teamA1, name: "MT073 Team A1" },
    { tenantId: ids.companyA, id: ids.teamA2, name: "MT073 Team A2" },
    { tenantId: ids.companyB, id: ids.teamB1, name: "MT073 Team B1" },
    { tenantId: ids.companyC, id: ids.teamC1, name: "MT073 Team C1" },
  ]);

  // ---- 公司成员资格（复合唯一 (tenant, principal)；a-admin 是 tenant_admin）。 ----
  const companyIdOf: Record<CompanyKey, string> = {
    "company-a": ids.companyA,
    "company-b": ids.companyB,
    "company-c": ids.companyC,
  };
  await db.insert(enterpriseMemberships).values(
    HUMAN_PLAN.flatMap((planned) =>
      planned.companies.map((planned0) => ({
        tenantId: companyIdOf[planned0.company],
        principalId: principalOf(planned.key),
        role: planned0.role,
      })),
    ),
  );

  // ---- 计费侧：A/B 各绑唯一计费 Customer + 公司账户；C 刻意不绑（空账簿边缘）。 ----
  await db
    .insert(billingCustomers)
    .values(
      [ids.customerA, ids.customerB, ids.personalCustomer].map(
        (externalId) => ({ externalId }),
      ),
    );
  await payer.bindCompanyCustomer({
    tenantId: ids.companyA,
    externalCustomerId: ids.customerA,
    actor: "mt073-fixture",
  });
  await payer.registerCompanyAccount({
    tenantId: ids.companyA,
    actor: "mt073-fixture",
  });
  await payer.bindCompanyCustomer({
    tenantId: ids.companyB,
    externalCustomerId: ids.customerB,
    actor: "mt073-fixture",
  });
  await payer.registerCompanyAccount({
    tenantId: ids.companyB,
    actor: "mt073-fixture",
  });
  await payer.registerPersonalAccount({
    userId: userIdOf(personalUserKey),
    externalCustomerId: ids.personalCustomer,
    actor: "mt073-fixture",
  });

  const customerOf = (companyKey: "company-a" | "company-b" | "personal") =>
    companyKey === "personal"
      ? ids.personalCustomer
      : companyKey === "company-a"
        ? ids.customerA
        : ids.customerB;

  const insertThenCancel = async (
    createdByUserId: string,
    tag: string,
  ): Promise<PaymentOrderRecord> => {
    const { order } = await store.insertOrder({
      planCode: `mt073-plan-${tag}`,
      provider: "alipay",
      amountCents: 1000,
      currency: "CNY",
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: createdByUserId,
      checkoutPayload: `mt073-qr-${tag}`,
    });
    await store.cancelOrder(order.id, order.version);
    return (await store.readOrder(order.id)) ?? order;
  };

  return {
    db,
    payer,
    writer,
    store,
    ids,
    caller(key) {
      if (![...HUMAN_PLAN.map((p) => p.key), personalUserKey].includes(key)) {
        throw new Error(`MT073 fixture: unknown caller key ${key}`);
      }
      return { principalId: principalOf(key), userId: userIdOf(key) };
    },
    async balanceOf(companyKey) {
      return writer.availableBalance(customerOf(companyKey));
    },
    async seedGrant(companyKey, totalCents, key) {
      const grant = await writer.grantCredits({
        externalCustomerId: customerOf(companyKey),
        source: "promo",
        totalCents,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        reason: `mt073 grant ${key}`,
        idempotencyKey: `${run}-grant-${key}`,
      });
      return grant.grant.id;
    },
    seedOrder(createdByUserId, tag) {
      return insertThenCancel(createdByUserId, tag);
    },
    async seedLiveOrder(createdByUserId, tag) {
      const { order } = await store.insertOrder({
        planCode: `mt073-plan-${tag}`,
        provider: "alipay",
        amountCents: 1000,
        currency: "CNY",
        expiresAt: new Date(Date.now() + 3600_000),
        createdBy: createdByUserId,
        checkoutPayload: `mt073-qr-${tag}`,
      });
      return order;
    },
    async setMembershipStatus(tenantId, principalId, status) {
      await db
        .update(enterpriseMemberships)
        .set({ status })
        .where(
          and(
            eq(enterpriseMemberships.tenantId, tenantId),
            eq(enterpriseMemberships.principalId, principalId),
          ),
        );
    },
    async dispose() {
      // 授权/归属/预扣/台账/grant/审计/订单随前缀级联清扫；逐表显式删一次，
      // 顺序满足外键（先事实后身份）。
      await db.execute(
        sql`delete from billing_company_finance_grants where tenant_id like ${`${run}%`} or granted_by like ${`${run}%`}`,
      );
      await db
        .delete(paymentEvents)
        .where(
          sql`${paymentEvents.orderId} in (select id from payment_orders where created_by like ${`${run}%`})`,
        );
      await db
        .delete(paymentOrders)
        .where(like(paymentOrders.createdBy, `${run}%`));
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
      await db.$client.close();
    },
  };
}
