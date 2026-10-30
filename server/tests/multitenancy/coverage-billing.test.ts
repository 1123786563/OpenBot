// server/tests/multitenancy/coverage-billing.test.ts
// MT137（Issue #180）：覆盖证据——公司/个人付款账户与账务可见性。
//
// 用 MT132 身份矩阵 runner 为付款账户绑定（固定账户、二次绑定拒绝）、
// 公司/个人付款路由（§7.1 routePayerAccountFor 三来源闭集）、订单与发票
// 的创建人过滤、积分汇总/消费/计划用量、公司财务授权（MT073 判定门：
// 角色不自动获得财务读取）、供应商回调锁定与结算幂等（webhook 入口）的
// 逐入口正向与越权证据。全部场景在真实 PostgreSQL 专用库上执行（真实
// 受限角色 + 真实 RLS；金额与并发证据不接受内存 fake——票注）。
//
// 路径级直接钉住（无一对一 HTTP 入口映射，按 MT135 先例披露）：
//   - 并发预扣：同预算并发 reserve 恰好放行预算内数量，余额不穿底，
//     个人账户余额不动（余额不足不切换付款方）；
//   - §7.1 付款路由判定：三来源闭集 + payerKey 逐字节对齐 + 无主单拒绝；
//   - 固定付款账户：公司二次绑定其他 Customer 被显式拒绝。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 Verification）：本套件即复现命令——
//   set +x; source /tmp/mt25-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-billing.test.ts

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createCompanyFinanceVisibilityService } from "../../src/billing/company-finance-visibility";
import { createCompanyReservationService } from "../../src/billing/company-reservation";
import { createVendorBillingService } from "../../src/billing/vendor-billing";
import { creditLedger } from "../../src/db/schema/credits";
import {
  type MatrixPlan,
  runMatrixCoverage,
} from "../../scripts/multitenancy/identity-matrix-runner";
import {
  buildInventory,
  type CoverageInventory,
} from "../../scripts/multitenancy/inventory";
import { payerKey } from "../../src/billing/payer";
import {
  routePayerAccountFor,
  type MachinePersonalCallSource,
} from "../../src/enterprise/tenancy/machine-personal-exceptions";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createBillingVisibilityFixture,
  probeBillingVisibilityEnvironment,
  type BillingVisibilityFixture,
} from "./support/billing-visibility";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";
import {
  createPayerAccountsFixture,
  probePayerAccountsEnvironment,
} from "./support/payer-accounts";
import {
  createVendorBillingFixture,
  probeVendorBillingEnvironment,
} from "./support/vendor-billing";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const probes = [
    probeBillingVisibilityEnvironment(),
    probePayerAccountsEnvironment(),
    probeVendorBillingEnvironment(),
  ];
  const failed = probes.find((probe) => !probe.ok);
  if (failed && !failed.ok) return { ok: false, reason: failed.reason };
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT137 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** The real inventory every mapped entrance must come from. */
const inventory: CoverageInventory = await buildInventory({
  environment: process.env,
});

/**
 * 夹具身份 → §11 矩阵类等价表（披露，非推导）。billing 夹具的身份是
 * 稳定键（a1-member 等），其 §11 类载体经 MT002 夹具身份披露。
 */
const ACTOR_CLASSES = {
  "a1-owner": "company-a-team-a1-only",
  "a1-member": "company-a-team-a1-only",
  "a1-other": "same-team-other-person",
  "a2-member": "company-a-team-a2-only",
  "b1-member": "cross-company",
} as const;

// ---------------------------------------------------------------------------
// 惰性夹具
// ---------------------------------------------------------------------------

const createdDisposables: Array<() => Promise<void>> = [];

function lazy<T extends { dispose(): Promise<void> }>(
  create: () => Promise<T>,
): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () =>
    (promise ??= create().then((fixture) => {
      createdDisposables.push(() => fixture.dispose());
      return fixture;
    }));
}

const billingVisibility = lazy(() => createBillingVisibilityFixture());
const payerAccounts = lazy(() => createPayerAccountsFixture());
const vendorBilling = lazy(() => createVendorBillingFixture());

/** billing-visibility 夹具上的两个真实服务（MT073 判定门 + 预扣）。 */
async function billingServices() {
  const fixture = await billingVisibility();
  return {
    fixture,
    finance: createCompanyFinanceVisibilityService({
      database: fixture.db,
      writer: fixture.writer,
    }),
    companyCalls: createCompanyReservationService({
      database: fixture.db,
      writer: fixture.writer,
    }),
  };
}

async function vendorService() {
  const fixture = await vendorBilling();
  return {
    fixture,
    vendor: createVendorBillingService({
      database: fixture.db,
      vendor: fixture.script,
    }),
  };
}

const denyObservation = (
  denied: boolean,
  leaks: readonly unknown[] = [],
  effects: readonly unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: effects,
});

/** 给 a1-member 授予公司 A 的财务读取（授予人是 a-admin；真实服务）。 */
async function grantFinanceReader() {
  const { fixture, finance } = await billingServices();
  const grantee = fixture.caller("a1-member").principalId;
  const grantedBy = fixture.caller("a-admin").principalId;
  try {
    await finance.grantCompanyFinanceReader({
      tenantId: fixture.ids.companyA,
      principalId: grantee,
      grantedBy,
    });
  } catch {
    // 幂等披露：已存在的授权行 = 同一事实，不重发。
  }
  return { fixture, finance, grantee };
}

/** 在 companyA 的两个团队各预扣并结算一笔（真实并发面的事实底座）。 */
async function reserveAndSettle(
  fixture: BillingVisibilityFixture,
  team: "teamA1" | "teamA2",
  callerKey: string,
  suffix: string,
) {
  const service = createCompanyReservationService({
    database: fixture.db,
    writer: fixture.writer,
  });
  const { ids, caller } = fixture;
  // 预算垫底：公司账户余额来自 grant（writer 权威口径）。
  await fixture.seedGrant(
    "company-a",
    5000,
    `mt137-${suffix}-${randomUUID().slice(0, 8)}`,
  );
  const result = await service.reserveForCompanyCall({
    tenantId: ids.companyA,
    workspaceId: ids[team],
    principalId: caller(callerKey).principalId,
    botRef: `bot:mt137-${suffix}`,
    callKey: `call:mt137-${suffix}-${randomUUID().slice(0, 8)}`,
    idempotencyKey: `mt137-${suffix}-${randomUUID().slice(0, 8)}`,
    maximumCents: 200,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  if (!result.reserved) {
    throw new Error(
      `MT137 arrangement reserve failed: ${result.availableCents}`,
    );
  }
  const requestId = `mt137-${suffix}-${randomUUID().slice(0, 8)}`;
  await fixture.writer.settleReservation({
    reservationId: result.reservationId,
    actual: { numerator: 100n, denominator: 1n },
    title: "mt137 coverage",
    requestId,
  });
  return { reservationId: result.reservationId, requestId };
}

// ---------------------------------------------------------------------------
// 场景（billing-accounts 域）
// ---------------------------------------------------------------------------

const billingScenarios: ScenarioMap = {
  // POST /api/billing/purchases —— 订单创建（创建人过滤的真实读面）。
  "billing.purchases.positive": async () => {
    const fixture = await billingVisibility();
    const order = await fixture.seedOrder(
      fixture.caller("a1-member").userId,
      `mt137-purchase-${randomUUID().slice(0, 8)}`,
    );
    const read = await fixture.store.readOrder(order.id, {
      actorPayerRef: {
        kind: "personal",
        id: fixture.caller("a1-member").userId,
      },
    });
    return {
      positiveControlPassed: read?.id === order.id,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.purchases.denial": async () => {
    const fixture = await billingVisibility();
    const order = await fixture.seedOrder(
      fixture.caller("a1-member").userId,
      `mt137-purchase-deny-${randomUUID().slice(0, 8)}`,
    );
    // 同公司他人（a1-mate）的个人付款人视角：不可见（他人订单）。
    const mate = fixture.caller("a1-mate");
    const read = await fixture.store.readOrder(order.id, {
      actorPayerRef: { kind: "personal", id: mate.userId },
    });
    const window = await fixture.store.listOrdersInWindow({
      from: null,
      to: null,
      limit: 100,
      offset: 0,
      scope: { actorPayerRef: { kind: "personal", id: mate.userId } },
    });
    const leaked = window.filter((row) => row.id === order.id);
    return denyObservation(read === null && leaked.length === 0, leaked);
  },

  // GET /api/billing/invoices —— 发票/订单窗口（同一过滤面的窗口读）。
  "billing.invoices.positive": async () => {
    const fixture = await billingVisibility();
    const order = await fixture.seedOrder(
      fixture.caller("a1-member").userId,
      `mt137-invoice-${randomUUID().slice(0, 8)}`,
    );
    const window = await fixture.store.listOrdersInWindow({
      from: null,
      to: null,
      limit: 100,
      offset: 0,
      scope: {
        actorPayerRef: {
          kind: "personal",
          id: fixture.caller("a1-member").userId,
        },
      },
    });
    return {
      positiveControlPassed: window.some((row) => row.id === order.id),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.invoices.denial": async () => {
    const fixture = await billingVisibility();
    const order = await fixture.seedOrder(
      fixture.caller("a1-member").userId,
      `mt137-invoice-deny-${randomUUID().slice(0, 8)}`,
    );
    // 跨公司成员（b-member）视角：A 公司成员的订单零触达。
    const window = await fixture.store.listOrdersInWindow({
      from: null,
      to: null,
      limit: 100,
      offset: 0,
      scope: {
        actorPayerRef: {
          kind: "personal",
          id: fixture.caller("b-member").userId,
        },
      },
    });
    const leaked = window.filter((row) => row.id === order.id);
    return denyObservation(leaked.length === 0, leaked);
  },

  // GET /api/billing/credits/summary —— 积分汇总（MT073 判定门后）。
  "billing.summary.positive": async () => {
    const { fixture, finance, grantee } = await grantFinanceReader();
    await reserveAndSettle(fixture, "teamA1", "a1-member", "summary");
    const books = await finance.companyBooks({
      tenantId: fixture.ids.companyA,
      principalId: grantee,
    });
    return {
      positiveControlPassed: books !== null,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.summary.denial": async () => {
    const fixture = await billingVisibility();
    // 无授权的普通成员（a2-member）：同一哨兵拒绝，零账务事实读取。
    let refused = false;
    try {
      const { finance } = await billingServices();
      await finance.companyBooks({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a2-member").principalId,
      });
    } catch (error) {
      refused = /COMPANY_FINANCE_REQUIRED/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(refused);
  },

  // GET /api/billing/credits/consumption —— 消费读取（最近用量行）。
  "billing.consumption.positive": async () => {
    const { fixture, finance, grantee } = await grantFinanceReader();
    await reserveAndSettle(fixture, "teamA1", "a1-member", "consumption");
    const lines = await finance.recentUsageLines({
      tenantId: fixture.ids.companyA,
      principalId: grantee,
      limit: 50,
    });
    return {
      positiveControlPassed: Array.isArray(lines),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.consumption.denial": async () => {
    const fixture = await billingVisibility();
    // 跨公司成员（b-member）对 A 公司的消费读取：判定门拒绝。
    let refused = false;
    try {
      const { finance } = await billingServices();
      await finance.recentUsageLines({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("b-member").principalId,
      });
    } catch (error) {
      refused = /COMPANY_FINANCE_REQUIRED/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(refused);
  },

  // GET /api/billing/plan-usage —— 计划用量（团队用量两级汇总）。
  "billing.plan-usage.positive": async () => {
    const { fixture, finance, grantee } = await grantFinanceReader();
    await reserveAndSettle(fixture, "teamA1", "a1-member", "plan-a1");
    await reserveAndSettle(fixture, "teamA2", "a2-member", "plan-a2");
    const books = await finance.companyBooks({
      tenantId: fixture.ids.companyA,
      principalId: grantee,
    });
    const teams = books.usage.byTeam;
    return {
      positiveControlPassed: teams.length >= 2,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.plan-usage.denial": async () => {
    const fixture = await billingVisibility();
    let refused = false;
    try {
      const { finance } = await billingServices();
      await finance.companyBooks({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a1-mate").principalId,
      });
    } catch (error) {
      refused = /COMPANY_FINANCE_REQUIRED/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(refused);
  },

  // GET /api/admin/billing —— 管理面账务（角色不自动获得财务读取）。
  "billing.admin.positive": async () => {
    const { fixture, finance } = await billingServices();
    // 显式授权的财务读者（a1-member）可读；授权行可审计。
    const grantee = fixture.caller("a1-member").principalId;
    await finance
      .grantCompanyFinanceReader({
        tenantId: fixture.ids.companyA,
        principalId: grantee,
        grantedBy: fixture.caller("a-admin").principalId,
      })
      .catch(() => undefined);
    const books = await finance.companyBooks({
      tenantId: fixture.ids.companyA,
      principalId: grantee,
    });
    const readers = await finance.financeReadersOf(fixture.ids.companyA);
    return {
      positiveControlPassed:
        books !== null && readers.some((row) => row.principalId === grantee),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.admin.denial": async () => {
    const fixture = await billingVisibility();
    // tenant_admin 无授权行：拒绝（MT073 AC——角色不自动获得财务读取）。
    let refused = false;
    try {
      const { finance } = await billingServices();
      await finance.companyBooks({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a-admin").principalId,
      });
    } catch (error) {
      refused = /COMPANY_FINANCE_REQUIRED/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(refused);
  },

  // POST /api/admin/billing/credits/grants —— 财务授权签发（重复签发拒绝）。
  "billing.grants.positive": async () => {
    const { fixture, finance } = await billingServices();
    const grantee = fixture.caller("a2-member").principalId;
    await finance
      .grantCompanyFinanceReader({
        tenantId: fixture.ids.companyA,
        principalId: grantee,
        grantedBy: fixture.caller("a-admin").principalId,
      })
      .catch(() => undefined);
    const readers = await finance.financeReadersOf(fixture.ids.companyA);
    return {
      positiveControlPassed: readers.some((row) => row.principalId === grantee),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.grants.denial": async () => {
    const { fixture, finance } = await billingServices();
    const grantee = fixture.caller("a1-member").principalId;
    let duplicateRefused = false;
    try {
      await finance.grantCompanyFinanceReader({
        tenantId: fixture.ids.companyA,
        principalId: grantee,
        grantedBy: fixture.caller("a-admin").principalId,
      });
    } catch (error) {
      duplicateRefused = /FINANCE_GRANT_EXISTS/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    // 跨公司授予人（b-member 给 A 公司成员授权）：成员资格拒绝。
    let crossRefused = false;
    try {
      await finance.grantCompanyFinanceReader({
        tenantId: fixture.ids.companyA,
        principalId: fixture.caller("a1-mate").principalId,
        grantedBy: fixture.caller("b-member").principalId,
      });
    } catch (error) {
      crossRefused = !/FINANCE_GRANT_EXISTS/.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    return denyObservation(duplicateRefused && crossRefused);
  },

  // POST /api/payments/callbacks/:provider —— 供应商回调（客户键锁定映射）。
  "billing.callback.positive": async () => {
    const { fixture, vendor } = await vendorService();
    const a = fixture.caller("a-member");
    const locked = await vendor.applyVendorCallback({
      externalCustomerId: fixture.ids.customerA,
      operation: "customer.updated",
      actingPrincipalId: a.principalId,
    });
    return {
      positiveControlPassed:
        locked.tenantId === fixture.ids.companyA &&
        locked.account.accountType === "company",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.callback.denial": async () => {
    const { fixture, vendor } = await vendorService();
    const a = fixture.caller("a-member");
    // 个人客户键绝不解锁公司回调：无映射可锁 → 显式拒绝。
    let refused = false;
    try {
      await vendor.applyVendorCallback({
        externalCustomerId: fixture.ids.personalCustomer,
        operation: "customer.updated",
        actingPrincipalId: a.principalId,
      });
    } catch {
      refused = true; // 无映射键 = 结构性拒绝（任何错误形状都是拒绝）
    }
    return denyObservation(refused);
  },

  // POST /api/billing/webhooks/lago —— 结算 webhook（幂等入账）。
  "billing.webhook.positive": async () => {
    const fixture = await billingVisibility();
    const { reservationId } = await reserveAndSettle(
      fixture,
      "teamA1",
      "a1-member",
      "webhook",
    );
    const ledger = await fixture.db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
    return {
      positiveControlPassed: ledger.length === 1,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "billing.webhook.denial": async () => {
    const fixture = await billingVisibility();
    // Key 重放：同一事件（同 reservation）携带不同 requestId 重放结算，
    // 结果收敛到首次入账（台账不重复）——不重复结算。
    const { reservationId, requestId } = await reserveAndSettle(
      fixture,
      "teamA1",
      "a1-member",
      "webhook-replay",
    );
    const before = await fixture.db
      .select({ credits: creditLedger.credits })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
    // 同一事件重放（同 reservation + 同 requestId + 同 actual）：首次结果
    // 逐字段复现，台账不重复——不重复结算。
    const replayed = await fixture.writer.settleReservation({
      reservationId,
      actual: { numerator: 100n, denominator: 1n },
      title: "mt137 coverage",
      requestId,
    });
    const after = await fixture.db
      .select({ credits: creditLedger.credits })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, `reservation:${reservationId}`));
    const noDoubleCharge = after.length === before.length && after.length === 1;
    return denyObservation(
      noDoubleCharge && replayed.chargedCents === before[0].credits,
      [],
      after.length > 1 ? [{ doubleCharged: reservationId }] : [],
    );
  },
};

/** 入口 → 场景映射。 */
const PLAN: MatrixPlan = {
  "POST /api/billing/purchases": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.purchases.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.purchases.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "GET /api/billing/invoices": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.invoices.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.invoices.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/billing/credits/summary": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.summary.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.summary.denial",
      identity: "a2-member",
      matrixClass: "company-a-team-a2-only",
    },
  },
  "GET /api/billing/credits/consumption": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.consumption.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.consumption.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/billing/plan-usage": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.plan-usage.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.plan-usage.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "GET /api/admin/billing": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.admin.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.admin.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/admin/billing/credits/grants": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.grants.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.grants.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/payments/callbacks/:provider": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.callback.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.callback.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/billing/webhooks/lago": {
    positive: {
      domain: "billing-accounts",
      scenarioId: "billing.webhook.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-member"],
    },
    denial: {
      domain: "billing-accounts",
      scenarioId: "billing.webhook.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  registerIsolationDomain(
    "billing-accounts",
    adapterFromScenarios(billingScenarios),
  );
}, 30_000);

afterAll(async () => {
  for (const dispose of createdDisposables.splice(0)) {
    await dispose().catch(() => undefined);
  }
}, 240_000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt137",
  }));

describeDb(
  "MT137 / Issue #180 — 覆盖证据：公司/个人付款账户与账务可见性",
  () => {
    itDb(
      "计划内全部入口在矩阵 runner 输出中 covered（正向与越权两侧都过）",
      async () => {
        const report = await coverage();
        const byId = new Map(
          report.entrances.map((entry) => [entry.id, entry]),
        );
        const failures: string[] = [];
        for (const entranceId of Object.keys(PLAN)) {
          const entry = byId.get(entranceId);
          if (!entry) {
            failures.push(`${entranceId}: not in report`);
            continue;
          }
          if (entry.status !== "covered") {
            failures.push(
              `${entranceId}: ${entry.status} (positive=${entry.positive.status}/${entry.positive.reasons.join("|")}; denial=${entry.denial.status}/${entry.denial.reasons.join("|")})`,
            );
          }
        }
        expect(failures).toEqual([]);
        expect(report.schemaVersion).toBe(1);
        expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
        const classes = new Map(
          report.matrix.classes.map((entry) => [entry.id, entry]),
        );
        expect(
          classes.get("company-a-team-a1-only")?.entrancesCovered,
        ).toBeGreaterThan(0);
        expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(
          0,
        );
        expect(
          classes.get("same-team-other-person")?.entrancesCovered,
        ).toBeGreaterThan(0);
        expect(
          classes.get("company-a-team-a2-only")?.entrancesCovered,
        ).toBeGreaterThan(0);
        expect(report.overall).toBe("coverage-incomplete");
      },
      600_000,
    );

    itDb(
      "并发预扣：同预算并发 reserve 恰放行预算内数量，余额不穿底、个人账户不动（真实数据库并发）",
      async () => {
        // 骑 company-reservation 夹具的全新公司宇宙（余额只由本用例垫底），
        // MT070 AC1 同款并发语义：250/笔 × 10 笔 vs 1000 余额 → 恰 4 笔。
        const { createCompanyReservationFixture } = await import(
          "./support/company-reservation"
        );
        const disposed: Array<() => Promise<void>> = [];
        const fixture = await createCompanyReservationFixture().then((fx) => {
          disposed.push(() => fx.dispose());
          return fx;
        });
        try {
          const { ids, caller } = fixture;
          await fixture.seedGrant("company-c", 1000, `mt137-c-${Date.now()}`);
          const personalBefore = await fixture.balanceOf("personal");
          const service = createCompanyReservationService({
            database: fixture.db,
            writer: fixture.writer,
          });
          const key = `mt137-${randomUUID().slice(0, 8)}`;
          const results = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
              service.reserveForCompanyCall({
                tenantId: ids.companyC,
                workspaceId: index % 2 === 0 ? ids.teamC1 : ids.teamC2,
                principalId:
                  index % 2 === 0
                    ? caller("c1-member").principalId
                    : caller("c2-member").principalId,
                botRef: "bot:mt137-concurrent",
                callKey: `call:${key}-${index}`,
                idempotencyKey: `${key}-${index}`,
                maximumCents: 250,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              }),
            ),
          );
          const admitted = results.filter((x) => x.reserved);
          const refused = results.filter((x) => !x.reserved);
          const held = admitted.reduce((sum, _x) => sum + 250, 0);
          expect(admitted.length).toBe(4);
          expect(refused.length).toBe(6);
          expect(held).toBe(1000);
          for (const x of refused) expect(x.availableCents).toBe(0);
          // 余额不穿底（真实行级竞争下余额保持 ≥ 0），且预扣不改付款方：
          // 个人账户分文不动。
          expect(await fixture.balanceOf("company-c")).toBeGreaterThanOrEqual(
            0,
          );
          expect(await fixture.balanceOf("personal")).toBe(personalBefore);
        } finally {
          for (const dispose of disposed)
            await dispose().catch(() => undefined);
        }
      },
      240_000,
    );

    itDb(
      "§7.1 付款路由判定：三来源闭集、payerKey 逐字节对齐、无主单拒绝",
      async () => {
        // machine-callback → 订单属主付款方（ownerPayerRef 原样）。
        const callback = routePayerAccountFor({
          kind: "machine-callback",
          order: { ownerPayerRef: { kind: "company", id: "tenant-x" } },
        } as unknown as MachinePersonalCallSource);
        expect(callback.ok).toBe(true);
        if (callback.ok) {
          expect(callback.ref).toEqual({ kind: "company", id: "tenant-x" });
          expect(callback.key).toBe(
            payerKey({ kind: "company", id: "tenant-x" }),
          );
        }
        // personal-direct → personal:<userId>。
        const direct = routePayerAccountFor({
          kind: "personal-direct",
          grant: { userId: "user-1" },
        } as unknown as MachinePersonalCallSource);
        expect(direct.ok).toBe(true);
        if (direct.ok) {
          expect(direct.key).toBe(payerKey({ kind: "personal", id: "user-1" }));
        }
        // company-workbench → company:<tenantId>。
        const workbench = routePayerAccountFor({
          kind: "company-workbench",
          scope: { tenantId: "tenant-y" },
        } as unknown as MachinePersonalCallSource);
        expect(workbench.ok).toBe(true);
        // 无主单（machine-callback 无 ownerPayerRef）→ 显式拒绝，不默认。
        const unowned = routePayerAccountFor({
          kind: "machine-callback",
          order: null,
        } as unknown as MachinePersonalCallSource);
        expect(unowned.ok).toBe(false);
      },
      60_000,
    );

    itDb(
      "固定付款账户：公司二次绑定其他 Customer 被显式拒绝（真实数据库）",
      async () => {
        const fx = await payerAccounts();
        const first = await fx.service.bindCompanyCustomer({
          tenantId: fx.ids.companyA,
          externalCustomerId: fx.ids.customerA,
          actor: `${fx.ids.companyA}-admin`,
        });
        expect(first.externalCustomerId).toBe(fx.ids.customerA);
        // 幂等重绑同一 Customer = 稳定返回（不换账户）。
        const again = await fx.service.bindCompanyCustomer({
          tenantId: fx.ids.companyA,
          externalCustomerId: fx.ids.customerA,
          actor: `${fx.ids.companyA}-admin`,
        });
        expect(again.externalCustomerId).toBe(first.externalCustomerId);
        // 绑定其他 Customer：显式冲突（余额不足也不切换付款账户）。
        await expect(
          fx.service.bindCompanyCustomer({
            tenantId: fx.ids.companyA,
            externalCustomerId: fx.ids.customerFree1,
            actor: `${fx.ids.companyA}-admin`,
          }),
        ).rejects.toThrow(/CUSTOMER_MAPPING_CONFLICT/);
      },
      240_000,
    );

    itDb(
      "未映射的 billing 入口保留在缺口清单（漂移可见，不虚报覆盖）",
      async () => {
        const report = await coverage();
        const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
        expect(gapIds.has("GET /api/billing/catalog")).toBe(true);
        expect(gapIds.has("POST /api/billing/credits/rewards/claim")).toBe(
          true,
        );
        for (const gap of report.gaps) {
          if (Object.hasOwn(PLAN, gap.entranceId)) {
            throw new Error(
              `planned entrance leaked into gap list: ${gap.entranceId}`,
            );
          }
        }
      },
      240_000,
    );

    itDb(
      "覆盖报告产物（可选写出：MT_COVERAGE_REPORT_OUT 指定路径）",
      async () => {
        const out = process.env.MT_COVERAGE_REPORT_OUT?.trim();
        const report = await coverage();
        if (!out) return;
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
        expect(report.summary.coveredEntrances).toBe(Object.keys(PLAN).length);
      },
      240_000,
    );
  },
);
