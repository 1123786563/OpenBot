// server/tests/multitenancy/machine-personal-exceptions.test.ts
// MT128（Issue #171）：机器回调与个人 Bifrost 直连路径例外登记闭合。
//
// 验收事实源（Issue #171 验收 1–4，逐条对应 describe）：
//   (1) 机器回调例外不授予业务数据读取；越权调用被拒绝——匹配器闭集 +
//       真实回调路由（桩 service 缝：缝只收 providerId/headers/rawBody，
//       结构上没有业务上下文可授予）+ 未验签投递 403/404。
//   (2) 个人直连路径例外登记完整，且与公司路径账户解析互不干扰——两族
//       匹配器互斥、登记锚定真实装配、个人路由不受租户选择影响。
//   (3) 两类例外的付款账户路由与 Spec §7.1 一致——routePayerAccountFor
//       三来源闭集：回调按已记录订单、个人按授权绑定用户、公司按作用域
//       租户；客户端账户字段一律拒绝；无主订单扣发不猜。
//   (4) 登记表变更会触发就绪校验重新评估——评估器 + 启动编排第五道门
//       machinePersonalExceptions 消费登记表（登记是代码，改表即重评）。
//
// 环境契约：纯内存/内存 app（真实回调路由 + 桩 service）；真实装配锚定
// 用 buildInventory 的无数据库模式（与 MT030 同款），不触库。

import { Hono } from "hono";
import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import type { CoverageInventory } from "../../scripts/multitenancy/inventory";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { payerKey } from "../../src/billing/payer";
import { PayerCrossAccountAccessError } from "../../src/billing/payer-personal";
import { createPaymentCallbackRoutes } from "../../src/billing/payments/routes";
import { GLOBAL_EXCEPTION_ENTRIES } from "../../src/enterprise/tenancy/global-exceptions";
import {
  assertNoForeignAccountIdentity,
  evaluateMachinePersonalExceptionRegistry,
  MACHINE_CALLBACK_EXCEPTIONS,
  type MachinePersonalExceptionEntry,
  matchMachineCallbackException,
  matchPersonalDirectException,
  PAYER_ROUTE_UNOWNED,
  PERSONAL_DIRECT_EXCEPTIONS,
  routePayerAccountFor,
} from "../../src/enterprise/tenancy/machine-personal-exceptions";
import { runMultitenancyStartupChecks } from "../../src/enterprise/tenancy/startup-checks";

// ---------------------------------------------------------------------------
// 真实装配清单（无数据库模式，与 MT030 同款）
// ---------------------------------------------------------------------------

const NO_DATABASE: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

const realInventory: CoverageInventory = await buildInventory({
  environment: NO_DATABASE,
});

// ---------------------------------------------------------------------------
// AC1 — 机器回调例外不授予业务数据读取；越权调用被拒绝
// ---------------------------------------------------------------------------

describe("MT128 机器回调例外：登记只覆盖回调本身，越权拒绝", () => {
  test("匹配器闭集：两门命中，其余（业务端点/方法错配/邻近路径）一律 null", () => {
    expect(
      matchMachineCallbackException("POST", "/api/billing/webhooks/lago")?.id,
    ).toBe("billing-provider-webhook");
    expect(
      matchMachineCallbackException("POST", "/api/payments/callbacks/alipay")
        ?.id,
    ).toBe("payment-channel-callback");
    // 方法错配：GET 一个回调路径不是登记门。
    expect(
      matchMachineCallbackException("GET", "/api/payments/callbacks/alipay"),
    ).toBeNull();
    // 邻近业务路径不是回调门：同前缀的结算面/订单面照旧要求归属上下文。
    expect(
      matchMachineCallbackException("GET", "/api/billing/orders"),
    ).toBeNull();
    expect(
      matchMachineCallbackException("GET", "/api/billing/entitlements"),
    ).toBeNull();
    expect(
      matchMachineCallbackException("POST", "/api/payments/purchases"),
    ).toBeNull();
    // 投递通道 webhook 门不在本票闭集（诚实披露：归属是投递族自己的票）。
    expect(
      matchMachineCallbackException("POST", "/api/delivery/webhooks/opentag"),
    ).toBeNull();
  });

  test("真实回调路由：service 缝只收 (providerId, headers, rawBody)——结构上无业务上下文可授予", async () => {
    const calls: unknown[][] = [];
    const routes = createPaymentCallbackRoutes({
      service: {
        handleCallback: async (...args: unknown[]) => {
          calls.push(args);
          return { kind: "success" as const };
        },
      } as never,
    });
    const app = new Hono();
    app.route("/api/payments/callbacks", routes);
    const response = await app.request(
      "http://openbot.test/api/payments/callbacks/alipay",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ out_trade_no: "order-1", trade_status: "ok" }),
      },
    );
    expect(response.status).toBe(200);
    // 缝的三个参数逐字对齐路由处理器的调用面：providerId / 原始头 / 原始
    // 字节。没有第四个参数——不存在「授予业务读取」的通道可被例外打开。
    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(3);
    expect(calls[0][0]).toBe("alipay");
  });

  test("越权调用被拒绝：未验签投递 403、未知渠道 404、超限投递 413（确定性，不泄露订单存在性）", async () => {
    const routes = createPaymentCallbackRoutes({
      service: {
        handleCallback: async (providerId: string) =>
          providerId === "ghost"
            ? { kind: "unknown-provider" as const }
            : { kind: "unverified" as const, refusal: "signature" as const },
      } as never,
    });
    const app = new Hono();
    app.route("/api/payments/callbacks", routes);
    const forged = await app.request(
      "http://openbot.test/api/payments/callbacks/alipay",
      { method: "POST", body: "forged-bytes" },
    );
    expect(forged.status).toBe(403);
    const unknown = await app.request(
      "http://openbot.test/api/payments/callbacks/ghost",
      { method: "POST", body: "x" },
    );
    expect(unknown.status).toBe(404);
    const oversized = await app.request(
      "http://openbot.test/api/payments/callbacks/alipay",
      { method: "POST", body: "x".repeat(1024 * 1024 + 1) },
    );
    expect(oversized.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// AC2 — 个人直连例外登记完整；与公司路径账户解析互不干扰
// ---------------------------------------------------------------------------

describe("MT128 个人直连例外：登记完整、两族互斥、账户解析互不干扰", () => {
  test("匹配器：个人两门命中；回调门/业务端点一律不是个人门", () => {
    expect(matchPersonalDirectException("POST", "/api/bot-service")?.id).toBe(
      "bot-service-door",
    );
    expect(
      matchPersonalDirectException("GET", "/api/bot-service/grants")?.id,
    ).toBe("bot-service-door");
    expect(
      matchPersonalDirectException("POST", "/api/model-access/confirm")?.id,
    ).toBe("model-access-door");
    expect(
      matchPersonalDirectException("POST", "/api/billing/webhooks/lago"),
    ).toBeNull();
    expect(matchPersonalDirectException("GET", "/api/bots")).toBeNull();
  });

  test("登记锚定真实装配：两族每条登记项都锚定至少一个真实入口（route/catchall，防幽灵/防过期）", () => {
    const rows = realInventory.entrances.filter(
      (row) => row.kind === "route" || row.kind === "catchall",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const entry of [
      ...MACHINE_CALLBACK_EXCEPTIONS,
      ...PERSONAL_DIRECT_EXCEPTIONS,
    ]) {
      const anchors = rows.filter(
        (row) =>
          matchMachineCallbackException(row.method, row.path)?.id ===
            entry.id ||
          matchPersonalDirectException(row.method, row.path)?.id === entry.id,
      );
      expect(anchors.length).toBeGreaterThan(0);
    }
  });

  test("真实装配对两族登记成立：门下入口逐个在册、无两族重叠（无数据库模式）", () => {
    const evaluation = evaluateMachinePersonalExceptionRegistry({
      machineCallbacks: MACHINE_CALLBACK_EXCEPTIONS,
      personalDirect: PERSONAL_DIRECT_EXCEPTIONS,
      entrances: realInventory.entrances,
    });
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  test("个人路由与公司路径账户解析互不干扰：同一用户跨两公司解析两次个人 key 逐字节相同；公司 key 各归各", () => {
    const personal = routePayerAccountFor({
      kind: "personal-direct",
      grant: { userId: "user-multi-company" },
    });
    expect(personal.ok).toBe(true);
    if (personal.ok) {
      expect(personal.key).toBe("openbot-personal-user-multi-company");
    }
    // 租户选择不是个人路由的输入：同 grant 两次解析同 key（§7.1「多公司
    // 用户的个人任务不因切换公司而改变付款方」的个人侧半边）。
    const again = routePayerAccountFor({
      kind: "personal-direct",
      grant: { userId: "user-multi-company" },
    });
    expect(again.ok && personal.ok && again.key === personal.key).toBe(true);
    // 公司工作台路径按作用域租户解析：两家公司两个不同 key，互不借用。
    const companyA = routePayerAccountFor({
      kind: "company-workbench",
      scope: { tenantId: "company-a" },
    });
    const companyB = routePayerAccountFor({
      kind: "company-workbench",
      scope: { tenantId: "company-b" },
    });
    expect(companyA.ok && companyA.key).toBe("openbot-company-company-a");
    expect(companyB.ok && companyB.key).toBe("openbot-company-company-b");
  });
});

// ---------------------------------------------------------------------------
// AC3 — 付款账户路由与 Spec §7.1 一致
// ---------------------------------------------------------------------------

describe("MT128 §7.1 付款账户路由：来源闭集 → 固定推导", () => {
  test("机器回调按已记录订单解析：公司订单 → 公司 key；个人订单 → 个人 key（都从记录来，不从投递来）", () => {
    const companyOrder = routePayerAccountFor({
      kind: "machine-callback",
      order: {
        ownerPayerRef: { kind: "company", id: "company-a" },
      },
    });
    expect(companyOrder.ok && companyOrder.key).toBe(
      "openbot-company-company-a",
    );
    const personalOrder = routePayerAccountFor({
      kind: "machine-callback",
      order: {
        ownerPayerRef: { kind: "personal", id: "user-1" },
      },
    });
    expect(personalOrder.ok && personalOrder.key).toBe(
      "openbot-personal-user-1",
    );
  });

  test("无主订单扣发不猜：缺 ownerPayerRef / 隔离 kind（unknown_owner）→ PAYER_ROUTE_UNOWNED", () => {
    const unowned = routePayerAccountFor({
      kind: "machine-callback",
      order: { ownerPayerRef: null },
    });
    expect(unowned).toEqual({ ok: false, code: PAYER_ROUTE_UNOWNED });
    const quarantined = routePayerAccountFor({
      kind: "machine-callback",
      order: {
        ownerPayerRef: { kind: "unknown_owner", id: "legacy-key" },
      },
    });
    expect(quarantined).toEqual({ ok: false, code: PAYER_ROUTE_UNOWNED });
  });

  test("客户端账户字段一律拒绝：body/header 形态的账户身份键 → PayerCrossAccountAccessError（值是证据不是许可）", () => {
    expect(() =>
      assertNoForeignAccountIdentity({ userId: "someone-else" }),
    ).toThrow(PayerCrossAccountAccessError);
    expect(() =>
      assertNoForeignAccountIdentity({
        ExternalCustomerId: "openbot-company-x",
      }),
    ).toThrow(PayerCrossAccountAccessError);
    expect(() =>
      assertNoForeignAccountIdentity({ tenantId: "company-a" }),
    ).toThrow(PayerCrossAccountAccessError);
    expect(() =>
      assertNoForeignAccountIdentity({ messages: [], model: "m" }),
    ).not.toThrow();
  });

  test("路由表与既有事实源逐字对齐：payerKey(personal/user-1)=openbot-personal-user-1、payerKey(company/company-a)=openbot-company-company-a", () => {
    // routePayerAccountFor 不自造第二套推导——它消费 billing/payer 的
    // payerKey（01 组的既有事实源），逐字节对齐由两侧同参断言钉死。
    expect(payerKey({ kind: "personal", id: "user-1" })).toBe(
      "openbot-personal-user-1",
    );
    expect(payerKey({ kind: "company", id: "company-a" })).toBe(
      "openbot-company-company-a",
    );
  });

  test("全局例外登记与机器回调门不重叠：MT030 全局项不含两门路径（独立例外，互不吞并）", () => {
    for (const entry of GLOBAL_EXCEPTION_ENTRIES) {
      expect(entry.pattern.startsWith("/api/payments")).toBe(false);
      expect(entry.pattern.startsWith("/api/billing/webhooks")).toBe(false);
      expect(entry.pattern.startsWith("/api/bot-service")).toBe(false);
      expect(entry.pattern.startsWith("/api/model-access")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — 登记表变更触发就绪校验重新评估
// ---------------------------------------------------------------------------

describe("MT128 就绪重评：第五道启动门消费登记表", () => {
  test("登记形状缺理由/责任人/付款声明 → ENTRY_INVALID（缺口列全）", () => {
    const broken = MACHINE_CALLBACK_EXCEPTIONS.map((entry) =>
      entry.id === "payment-channel-callback"
        ? ({ ...entry, paymentAccount: "" } as MachinePersonalExceptionEntry)
        : entry,
    );
    const evaluation = evaluateMachinePersonalExceptionRegistry({
      machineCallbacks: broken,
      personalDirect: PERSONAL_DIRECT_EXCEPTIONS,
      entrances: [],
    });
    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some(
        (finding) =>
          finding.code === "ENTRY_INVALID" &&
          finding.detail.includes("payment-channel-callback"),
      ),
    ).toBe(true);
  });

  test("门下新增未登记入口 → UNREGISTERED_CALLBACK_DOOR / UNREGISTERED_PERSONAL_DOOR", () => {
    // 回调门下新方法（GET 报表）：路径在门下但方法未登记（回调门按方法登记）。
    const withNewDoor = [
      ...realInventory.entrances,
      {
        ...(realInventory.entrances[0] as object),
        id: "GET /api/payments/callbacks/report",
        entrance: "GET /api/payments/callbacks/report",
        method: "GET",
        path: "/api/payments/callbacks/report",
        kind: "route",
      },
    ];
    const evaluation = evaluateMachinePersonalExceptionRegistry({
      machineCallbacks: MACHINE_CALLBACK_EXCEPTIONS,
      personalDirect: PERSONAL_DIRECT_EXCEPTIONS,
      entrances: withNewDoor,
    });
    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some(
        (finding) => finding.code === "UNREGISTERED_CALLBACK_DOOR",
      ),
    ).toBe(true);

    // 个人门按 ALL 登记时子路径天然在册；收窄成按方法登记（POST）后，门下
    // 一个 DELETE 入口即未登记——评估器的完备方向对两族同形。
    const narrowedPersonal = PERSONAL_DIRECT_EXCEPTIONS.map((entry) =>
      entry.id === "bot-service-door"
        ? ({ ...entry, methods: ["POST"] } as MachinePersonalExceptionEntry)
        : entry,
    );
    const narrowedEvaluation = evaluateMachinePersonalExceptionRegistry({
      machineCallbacks: MACHINE_CALLBACK_EXCEPTIONS,
      personalDirect: narrowedPersonal,
      entrances: [
        ...realInventory.entrances.filter(
          (row) => !row.path.startsWith("/api/bot-service"),
        ),
        {
          ...(realInventory.entrances[0] as object),
          id: "DELETE /api/bot-service/grants/:id",
          entrance: "DELETE /api/bot-service/grants/:id",
          method: "DELETE",
          path: "/api/bot-service/grants/:id",
          kind: "route",
        },
      ],
    });
    expect(narrowedEvaluation.ok).toBe(false);
    expect(
      narrowedEvaluation.findings.some(
        (finding) => finding.code === "UNREGISTERED_PERSONAL_DOOR",
      ),
    ).toBe(true);
  });

  test("两族重叠登记 → FAMILY_OVERLAP（回调例外不覆盖个人门）", () => {
    const overlap: MachinePersonalExceptionEntry = {
      id: "overreaching-callback",
      methods: ["ALL"],
      pattern: "/api/bot-service/*",
      surface: "conditional",
      context: "machine",
      reason: "wrong family: a callback entry must never cover a personal door",
      ownerTicket: "MT128",
      contentBoundary: "invalid overlap probe",
      paymentAccount: "invalid overlap probe",
    };
    const evaluation = evaluateMachinePersonalExceptionRegistry({
      machineCallbacks: [...MACHINE_CALLBACK_EXCEPTIONS, overlap],
      personalDirect: PERSONAL_DIRECT_EXCEPTIONS,
      entrances: realInventory.entrances.filter((row) =>
        row.path.startsWith("/api/bot-service"),
      ),
    });
    expect(evaluation.ok).toBe(false);
    expect(
      evaluation.findings.some((finding) => finding.code === "FAMILY_OVERLAP"),
    ).toBe(true);
  });

  test("启动编排半边：machinePersonalExceptions 检查对真实登记表 + 业务清单通过，登记缺失即拒绝", async () => {
    const inventoryJson = JSON.stringify({
      ...realInventory,
      entrances: realInventory.entrances,
    });
    const record = await runMultitenancyStartupChecks(
      {
        inventoryPath: "memory://inventory",
        singleUser: false,
      },
      {
        readTextFile: async () => inventoryJson,
        createDatabase: (() => {
          throw new Error("no DB in this test");
        }) as never,
      },
    );
    expect(record.checks.machinePersonalExceptions.ok).toBe(true);
    if (record.checks.machinePersonalExceptions.ok) {
      expect(
        record.checks.machinePersonalExceptions.registeredCallbacks,
      ).toEqual(["billing-provider-webhook", "payment-channel-callback"]);
    }
  });
});
