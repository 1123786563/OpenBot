// MT074（波次 16 补位）共享夹具：供应商计费调用面与回调归属锁定。
//
// 契约：专用企业测试库（TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL，
// openbot_enterprise_* 命名、仅回环），缺显式 env 由调用方整套显式 skip，绝不回退
// 开发库、skipped 不计通过。billing_vendor_interactions 跟随 billing 域访问模型
// （MT069/MT070/MT073 D2 裁决：owner 通道、无 RLS）——夹具用 setup/owner 连接种
// 身份与计费事实（生产计费路径同款），并在套件内用 has_table_privilege 断言受限
// ob_ent_* 角色对新表零授权（结构隔离）。
//
// 种子：公司 A（customer-a 映射 + 公司账户，成员 a-member / a-mate / both-member）
// 与公司 B（customer-b 映射 + 公司账户，成员 b-member / both-member）承载调用面与
// 回调锁的正反两侧；公司 C 刻意**无计费映射**（绝不臆造客户的边缘）；公司 D 映射了
// customer-d 但**无账户行**；公司 E 映射了 customer-e 且账户被**隔离**（隔离行不是
// 付款人）；另有一名个人账户用户（个人客户键对公司回调零作用）。供应商客户端是
// fake（脚本化应答 + 调用记录——观测「供应商是否被调用」，绝不开真实 socket）。
// dispose 按依赖逆序级联清理，全部按前缀清扫。

import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "../../../src/billing/payer-accounts";
import type { BillingVendorClient } from "../../../src/billing/vendor-billing";
import { createDatabase, type Database } from "../../../src/db/client";
import { billingCustomers } from "../../../src/db/schema/billing";
import { users } from "../../../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
} from "../../../src/db/schema/enterprise-tenancy";
import {
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";

/** 环境探针：调用方据此显式 skip（缺 env 绝不回退开发库）。 */
export function probeVendorBillingEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const variable = enterpriseSetupDatabaseVariable();
  if (!process.env[variable]?.trim()) {
    return {
      ok: false,
      reason: `MT074 requires ${variable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

/** fake 供应商客户端的调用记录（观测「供应商是否被调用」与收到的确切字段）。 */
export interface VendorCallRecord {
  readonly externalId: string;
  readonly name: string;
}

/** 脚本化供应商：默认 200；可改写为任意状态码或传输异常。 */
export interface VendorScript {
  readonly client: BillingVendorClient;
  readonly calls: readonly VendorCallRecord[];
  replyWith(status: number): void;
  failWith(error: unknown): void;
  /** 清空调用记录（用例自清理——记录跨用例累积，断言空调用的用例先清）。 */
  forgetCalls(): void;
}

export function createFakeVendor(): VendorScript {
  const calls: VendorCallRecord[] = [];
  let mode:
    | { kind: "status"; status: number }
    | { kind: "throw"; error: unknown } = {
    kind: "status",
    status: 200,
  };
  return {
    client: {
      async postCustomer(input) {
        calls.push({ externalId: input.externalId, name: input.name });
        if (mode.kind === "throw") {
          throw mode.error;
        }
        return { status: mode.status };
      },
    },
    calls,
    replyWith(status) {
      mode = { kind: "status", status };
    },
    failWith(error: unknown) {
      mode = { kind: "throw", error };
    },
    forgetCalls() {
      calls.length = 0;
    },
  };
}

/** 一个可发起公司计费调用/承接回调的主体（principal 经成员资格锚定到公司）。 */
export interface ActingIdentity {
  readonly principalId: string;
  readonly userId: string;
}

type CompanyKey =
  | "company-a"
  | "company-b"
  | "company-c"
  | "company-d"
  | "company-e";

export type VendorBillingFixture = Readonly<{
  db: Database;
  /** 既有 MT069 交付：映射/账户唯一写入面（本票只读消费）。 */
  payer: PayerAccountService;
  script: VendorScript;
  ids: Readonly<{
    companyA: string;
    companyB: string;
    companyC: string;
    companyD: string;
    companyE: string;
    customerA: string;
    customerB: string;
    customerD: string;
    customerE: string;
    /** 个人账户对照（个人客户键绝不解锁公司回调）。 */
    personalCustomer: string;
    personalUserId: string;
  }>;
  /** 供应商收到的调用记录（fake 客户端观测面）。 */
  vendorCalls(): readonly VendorCallRecord[];
  /** 按稳定键取成员主体（成员资格事实见 HUMAN_PLAN）。 */
  caller(key: string): ActingIdentity;
  /** 成员资格状态翻转（A5 停用/恢复；owner 通道，MT010 D5 同款披露）。 */
  setMembershipStatus(
    tenantId: string,
    principalId: string,
    status: "active" | "suspended",
  ): Promise<void>;
  /** 成员资格行删除（回调存活门的最严酷形态：行都没有了）。 */
  deleteMembership(tenantId: string, principalId: string): Promise<void>;
  /** 交互审计行计数（owner 通道读回）。 */
  interactionCount(): Promise<number>;
  dispose(): Promise<void>;
}>;

/** 谁（稳定键）在哪家公司是什么角色；团队资格对本票语义不另设门槛。 */
const HUMAN_PLAN: ReadonlyArray<{
  readonly key: string;
  readonly companies: ReadonlyArray<{
    readonly company: CompanyKey;
    readonly role: string;
  }>;
}> = [
  { key: "a-member", companies: [{ company: "company-a", role: "member" }] },
  { key: "a-mate", companies: [{ company: "company-a", role: "member" }] },
  { key: "b-member", companies: [{ company: "company-b", role: "member" }] },
  { key: "c-member", companies: [{ company: "company-c", role: "member" }] },
  { key: "d-member", companies: [{ company: "company-d", role: "member" }] },
  { key: "e-member", companies: [{ company: "company-e", role: "member" }] },
  {
    key: "both-member",
    companies: [
      { company: "company-a", role: "member" },
      { company: "company-b", role: "member" },
    ],
  },
];

const PERSONAL_KEY = "personal-user";

export async function createVendorBillingFixture(): Promise<VendorBillingFixture> {
  const db = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 10 });
  const payer = createPayerAccountService(db);
  const script = createFakeVendor();

  const run = `mt074-${randomUUID().slice(0, 8)}`;
  const ids = {
    companyA: `${run}-company-a`,
    companyB: `${run}-company-b`,
    companyC: `${run}-company-c`,
    companyD: `${run}-company-d`,
    companyE: `${run}-company-e`,
    customerA: `${run}-cust-company-a`,
    customerB: `${run}-cust-company-b`,
    customerD: `${run}-cust-company-d`,
    customerE: `${run}-cust-company-e`,
    personalCustomer: `${run}-cust-personal`,
    personalUserId: `${run}-user-${PERSONAL_KEY}`,
  };

  const principalOf = (key: string) => `${run}-principal-${key}`;
  const userIdOf = (key: string) => `${run}-user-${key}`;
  const companyIdOf: Record<CompanyKey, string> = {
    "company-a": ids.companyA,
    "company-b": ids.companyB,
    "company-c": ids.companyC,
    "company-d": ids.companyD,
    "company-e": ids.companyE,
  };

  // ---- 全局身份：用户 + principal（User/Principal 全局）。 ----
  const planKeys = [...HUMAN_PLAN.map((p) => p.key), PERSONAL_KEY];
  await db.insert(users).values(
    planKeys.map((key) => ({
      id: userIdOf(key),
      email: `${principalOf(key)}@mt074.test`,
    })),
  );
  await db.insert(enterprisePrincipals).values(
    planKeys.map((key) => ({
      id: principalOf(key),
      userId: userIdOf(key),
    })),
  );

  // ---- 公司（A/B/C/D/E；C 无映射、D 映射无账户、E 映射+隔离账户）。 ----
  await db.insert(enterpriseTenants).values(
    (
      [
        ["company-a", ids.companyA],
        ["company-b", ids.companyB],
        ["company-c", ids.companyC],
        ["company-d", ids.companyD],
        ["company-e", ids.companyE],
      ] as const
    ).map(([key, id]) => ({ id, name: `MT074 ${key}` })),
  );

  // ---- 公司成员资格（复合唯一 (tenant, principal)）。 ----
  await db.insert(enterpriseMemberships).values(
    HUMAN_PLAN.flatMap((planned) =>
      planned.companies.map((planned0) => ({
        tenantId: companyIdOf[planned0.company],
        principalId: principalOf(planned.key),
        role: planned0.role,
      })),
    ),
  );

  // ---- 计费侧（全部经 MT069 交付的唯一写入面；映射外键要求 billing_customers
  // 先有对应客户行——生产开通流同序）。 ----
  await db
    .insert(billingCustomers)
    .values(
      [
        ids.customerA,
        ids.customerB,
        ids.customerD,
        ids.customerE,
        ids.personalCustomer,
      ].map((externalId) => ({ externalId })),
    );
  await payer.bindCompanyCustomer({
    tenantId: ids.companyA,
    externalCustomerId: ids.customerA,
    actor: "mt074-fixture",
  });
  await payer.registerCompanyAccount({
    tenantId: ids.companyA,
    actor: "mt074-fixture",
  });
  await payer.bindCompanyCustomer({
    tenantId: ids.companyB,
    externalCustomerId: ids.customerB,
    actor: "mt074-fixture",
  });
  await payer.registerCompanyAccount({
    tenantId: ids.companyB,
    actor: "mt074-fixture",
  });
  await payer.bindCompanyCustomer({
    tenantId: ids.companyD,
    externalCustomerId: ids.customerD,
    actor: "mt074-fixture",
  });
  await payer.bindCompanyCustomer({
    tenantId: ids.companyE,
    externalCustomerId: ids.customerE,
    actor: "mt074-fixture",
  });
  await payer.quarantineUnknownAccount({
    externalCustomerId: ids.customerE,
    reason: "mt074 fixture: quarantined before classification",
    actor: "mt074-fixture",
  });
  await payer.registerPersonalAccount({
    userId: ids.personalUserId,
    externalCustomerId: ids.personalCustomer,
    actor: "mt074-fixture",
  });

  return {
    db,
    payer,
    script,
    ids,
    vendorCalls() {
      return [...script.calls];
    },
    caller(key) {
      if (!planKeys.includes(key)) {
        throw new Error(`MT074 fixture: unknown caller key ${key}`);
      }
      return { principalId: principalOf(key), userId: userIdOf(key) };
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
    async deleteMembership(tenantId, principalId) {
      await db
        .delete(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, tenantId),
            eq(enterpriseMemberships.principalId, principalId),
          ),
        );
    },
    async interactionCount() {
      const rows = await db.execute(
        sql`select count(*)::int as count from billing_vendor_interactions where coalesce(tenant_id, '') like ${`${run}%`} or external_customer_id like ${`${run}%`}`,
      );
      return (rows[0] as { count: number }).count;
    },
    async dispose() {
      // 交互审计/账户审计/账户/映射随前缀清扫；顺序满足外键（先事实后身份）。
      await db.execute(
        sql`delete from billing_vendor_interactions where coalesce(tenant_id, '') like ${`${run}%`} or external_customer_id like ${`${run}%`}`,
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
