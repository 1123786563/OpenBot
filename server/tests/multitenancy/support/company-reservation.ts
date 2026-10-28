// MT070（Issue #113）共享夹具：公司调用归属与同一余额的原子预扣。
//
// 契约：专用企业测试库（TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL，
// openbot_enterprise_* 命名、仅回环），缺显式 env 由调用方整套显式 skip，绝不回退
// 开发库、skipped 不计通过。billing_call_attributions 跟随 billing 域访问模型
// （MT069 D2 裁决：owner 通道、无 RLS）——夹具因此用 setup/owner 连接种身份与
// 计费事实（生产计费路径同款），并在套件内用 has_table_privilege 断言受限
// ob_ent_* 角色对新表零授权（结构隔离）。
//
// 种子（spec §11 最低测试身份的扩展）：公司 A（团队甲 a1 / 乙 a2）、公司 B（团队丙
// b1）承载越权/幂等/归属用例；公司 C（团队 c1/c2）与公司 D（团队 d1）专供并发
// 用例（全新余额，数字精确可断言）。仅属甲、仅属乙、甲乙双成员、跨公司、仅属 B
// 各有成员。两家公司 + C/D 各绑唯一计费 Customer + 注册公司账户；另留个人账户
// 对照（A13 邻接）。grant 金额由单个用例自行发放（隔离前缀 mt070-）。
// dispose 按依赖逆序级联清理，全部按前缀清扫、防种子以外的残留。

import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
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
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probeCompanyReservationEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const variable = enterpriseSetupDatabaseVariable();
  if (!process.env[variable]?.trim()) {
    return {
      ok: false,
      reason: `MT070 requires ${variable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

/** 一个可发起公司调用的主体：principal（经成员资格事实锚定到公司）。 */
export interface CallerIdentity {
  readonly principalId: string;
  readonly userId: string;
}

type CompanyKey =
  | "company-a"
  | "company-b"
  | "company-c"
  | "company-d"
  | "company-s";

export type CompanyReservationFixture = Readonly<{
  db: Database;
  /** 既有 MT069 交付：映射/账户唯一写入面（本票只读消费）。 */
  payer: PayerAccountService;
  /** 既有扣费 writer（本票只读消费——预扣路径零修改的权威）。 */
  writer: CreditWriter;
  ids: Readonly<{
    companyA: string;
    companyB: string;
    companyC: string;
    companyD: string;
    companyS: string;
    teamA1: string;
    teamA2: string;
    teamB1: string;
    teamC1: string;
    teamC2: string;
    teamD1: string;
    teamS1: string;
    teamS2: string;
    customerA: string;
    customerB: string;
    customerC: string;
    customerD: string;
    customerS: string;
    /** 个人账户对照（A13：公司调用绝不碰个人余额）。 */
    personalCustomer: string;
  }>;
  /** 按稳定键取成员主体（成员资格事实见 HUMAN_PLAN）。 */
  caller(key: string): CallerIdentity;
  /** 读一家公司计费 Customer 当前的可花余额（writer 权威口径）。 */
  balanceOf(companyKey: CompanyKey | "personal"): Promise<number>;
  /** 给一家公司的计费 Customer 发一笔 grant（×100 整数），返回 grant id。 */
  seedGrant(
    companyKey: CompanyKey | "personal",
    totalCents: number,
    key: string,
  ): Promise<string>;
  dispose(): Promise<void>;
}>;

/** 谁（稳定键）在哪家公司是成员；团队资格对本票语义不另设门槛（spec §7）。 */
const HUMAN_PLAN: ReadonlyArray<{
  readonly key: string;
  readonly companies: readonly CompanyKey[];
}> = [
  { key: "a1-member", companies: ["company-a"] },
  { key: "a2-member", companies: ["company-a"] },
  { key: "a1a2-member", companies: ["company-a"] },
  { key: "b1-member", companies: ["company-b"] },
  { key: "both-companies", companies: ["company-a", "company-b"] },
  { key: "c1-member", companies: ["company-c"] },
  { key: "c2-member", companies: ["company-c"] },
  { key: "d-member", companies: ["company-d"] },
  { key: "s1-member", companies: ["company-s"] },
  { key: "s2-member", companies: ["company-s"] },
];

export async function createCompanyReservationFixture(): Promise<CompanyReservationFixture> {
  const db = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    // 并发用例要真实并行：池容量必须 ≥ 同时在飞的预扣数（14 并发）。
    max: 18,
  });
  const payer = createPayerAccountService(db);
  const writer = createCreditWriter(db);

  const run = `mt070-${randomUUID().slice(0, 8)}`;
  const ids = {
    companyA: `${run}-company-a`,
    companyB: `${run}-company-b`,
    companyC: `${run}-company-c`,
    companyD: `${run}-company-d`,
    companyS: `${run}-company-s`,
    teamA1: `${run}-team-a1`,
    teamA2: `${run}-team-a2`,
    teamB1: `${run}-team-b1`,
    teamC1: `${run}-team-c1`,
    teamC2: `${run}-team-c2`,
    teamD1: `${run}-team-d1`,
    teamS1: `${run}-team-s1`,
    teamS2: `${run}-team-s2`,
    customerA: `${run}-cust-company-a`,
    customerB: `${run}-cust-company-b`,
    customerC: `${run}-cust-company-c`,
    customerD: `${run}-cust-company-d`,
    customerS: `${run}-cust-company-s`,
    personalCustomer: `${run}-cust-personal`,
  };

  const principalOf = (key: string) => `${run}-principal-${key}`;
  const userIdOf = (key: string) => `${run}-user-${key}`;
  const personalUserKey = "personal-user";

  // ---- 全局身份：用户 + principal（User/Principal 全局，spec §4.1）。 ----
  await db.insert(users).values(
    [...HUMAN_PLAN.map((p) => p.key), personalUserKey].map((key) => ({
      id: userIdOf(key),
      email: `${principalOf(key)}@mt070.test`,
    })),
  );
  await db.insert(enterprisePrincipals).values(
    [...HUMAN_PLAN.map((p) => p.key), personalUserKey].map((key) => ({
      id: principalOf(key),
      userId: userIdOf(key),
    })),
  );

  // ---- 公司与团队（A：甲/乙；B：丙；C：c1/c2；D：d1；S：s1/s2 汇总专用）。 ----
  await db.insert(enterpriseTenants).values(
    (
      [
        ["company-a", ids.companyA],
        ["company-b", ids.companyB],
        ["company-c", ids.companyC],
        ["company-d", ids.companyD],
        ["company-s", ids.companyS],
      ] as const
    ).map(([key, id]) => ({ id, name: `MT070 ${key}` })),
  );
  await db.insert(enterpriseWorkspaces).values([
    { tenantId: ids.companyA, id: ids.teamA1, name: "MT070 Team A1" },
    { tenantId: ids.companyA, id: ids.teamA2, name: "MT070 Team A2" },
    { tenantId: ids.companyB, id: ids.teamB1, name: "MT070 Team B1" },
    { tenantId: ids.companyC, id: ids.teamC1, name: "MT070 Team C1" },
    { tenantId: ids.companyC, id: ids.teamC2, name: "MT070 Team C2" },
    { tenantId: ids.companyD, id: ids.teamD1, name: "MT070 Team D1" },
    { tenantId: ids.companyS, id: ids.teamS1, name: "MT070 Team S1" },
    { tenantId: ids.companyS, id: ids.teamS2, name: "MT070 Team S2" },
  ]);

  // ---- 公司成员资格（复合唯一 (tenant, principal)）。 ----
  const companyIdOf: Record<CompanyKey, string> = {
    "company-a": ids.companyA,
    "company-b": ids.companyB,
    "company-c": ids.companyC,
    "company-d": ids.companyD,
    "company-s": ids.companyS,
  };
  await db.insert(enterpriseMemberships).values(
    HUMAN_PLAN.flatMap((planned) =>
      planned.companies.map((companyKey) => ({
        tenantId: companyIdOf[companyKey],
        principalId: principalOf(planned.key),
        role: "member",
      })),
    ),
  );

  // ---- 计费侧：各公司 Customer + 个人对照 Customer。 ----
  await db
    .insert(billingCustomers)
    .values(
      [
        ids.customerA,
        ids.customerB,
        ids.customerC,
        ids.customerD,
        ids.customerS,
        ids.personalCustomer,
      ].map((externalId) => ({ externalId })),
    );

  // ---- 公司付款账户（MT069 唯一写入面）：映射 + 公司账户注册。 ----
  const bindings: ReadonlyArray<[CompanyKey, string]> = [
    ["company-a", ids.customerA],
    ["company-b", ids.customerB],
    ["company-c", ids.customerC],
    ["company-d", ids.customerD],
    ["company-s", ids.customerS],
  ];
  for (const [companyKey, customer] of bindings) {
    await payer.bindCompanyCustomer({
      tenantId: companyIdOf[companyKey],
      externalCustomerId: customer,
      actor: "mt070-fixture",
    });
    await payer.registerCompanyAccount({
      tenantId: companyIdOf[companyKey],
      actor: "mt070-fixture",
    });
  }
  await payer.registerPersonalAccount({
    userId: userIdOf(personalUserKey),
    externalCustomerId: ids.personalCustomer,
    actor: "mt070-fixture",
  });

  const customerOf = (companyKey: CompanyKey | "personal") =>
    companyKey === "personal"
      ? ids.personalCustomer
      : ids[
          companyKey === "company-a"
            ? "customerA"
            : companyKey === "company-b"
              ? "customerB"
              : companyKey === "company-c"
                ? "customerC"
                : companyKey === "company-d"
                  ? "customerD"
                  : "customerS"
        ];

  return {
    db,
    payer,
    writer,
    ids,
    caller(key) {
      if (!HUMAN_PLAN.some((planned) => planned.key === key)) {
        throw new Error(`MT070 fixture: unknown caller key ${key}`);
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
        reason: `mt070 grant ${key}`,
        idempotencyKey: `${run}-grant-${key}`,
      });
      return grant.grant.id;
    },
    async dispose() {
      // 预扣/台账/grant/归属/审计随 customer 或 tenant 前缀级联清扫；
      // 逐表显式删一次，顺序满足外键（先事实后身份）。清扫放 try、关池放
      // finally：任一 delete 抛错也不漏关连接池。
      try {
        await db.execute(
          sql`delete from billing_call_attributions where tenant_id like ${`${run}%`}`,
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
        await db.$client.close();
      }
    },
  };
}
