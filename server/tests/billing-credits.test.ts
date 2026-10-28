import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { type Credits, deriveGrantStatus } from "../src/billing/credits";
import { createBillingCreditRoutes } from "../src/billing/routes";
import type { PlanCatalogEntry } from "../src/billing/types";

const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};

describe("deriveGrantStatus", () => {
  const grant = (total: number, used: number, expiresAtMs: number) => ({
    total,
    used,
    expiresAt: new Date(expiresAtMs),
  });
  const NOW = 1_800_000_000_000; // some fixed instant

  test("a grant with balance and time left is active", () => {
    expect(deriveGrantStatus(grant(100, 20, NOW + 1000), NOW)).toBe("active");
  });

  test("a grant with no balance is exhausted, even before it expires", () => {
    expect(deriveGrantStatus(grant(100, 100, NOW + 1000), NOW)).toBe(
      "exhausted",
    );
  });

  test("a grant past its expiry is expired, even with balance left", () => {
    expect(deriveGrantStatus(grant(100, 0, NOW - 1), NOW)).toBe("expired");
  });

  test("expiry wins over exhaustion when both are true", () => {
    expect(deriveGrantStatus(grant(100, 100, NOW - 1), NOW)).toBe("expired");
  });
});

describe("credit routes", () => {
  const CATALOG: PlanCatalogEntry = {
    name: "高级版",
    credits: 9000,
    features: ["每月基础积分"],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 14000,
        originalCents: 19900,
        discountLabel: "7折",
        unit: "month",
      },
    ],
  };

  // BP07/#375：账户级能力状态（隔离=能力不可用+原因）随余额一并作答；默认普通账户，
  // 隔离变体由用例翻转。
  let accountStatus: {
    status: "active" | "quarantined";
    quarantineReason: string | null;
  } = {
    status: "active",
    quarantineReason: null,
  };

  const credits: Credits = {
    catalog: new Map([["advanced", CATALOG]]),
    // The summary route answers the personal balance read (ticket 02.6) with the ref the route
    // resolved from the session; the fake records it, so the tests can pin the resolution.
    personalBalance: async (payer) => {
      resolvedPayers.push(payer);
      return {
        accountType: "personal",
        account: accountStatus,
        available: 476.37,
        consumed: 123.63,
        expired: 0,
        held: 0,
        grants: [],
        pendingSettlement: {
          enabled: false,
          available: 0,
          consumed: 0,
          expired: 0,
        },
      };
    },
    summary: async () => ({
      plan: { total: 500, used: 100, remaining: 400, held: 0 },
      rewards: {
        total: 100,
        used: 23.63,
        remaining: 76.37,
        held: 0,
        grantCount: 2,
      },
    }),
    grants: async () => [
      {
        id: "g1",
        source: "promo",
        reason: "官方活动发放",
        total: 100,
        used: 23.63,
        remaining: 76.37,
        grantedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-11T18:48:21.000Z",
        status: "active",
        expiringSoon: true,
      },
    ],
    consumption: async () => ({
      entries: [
        {
          id: "c1",
          title: "写周报",
          requestId: "req-abc",
          credits: 1.2,
          model: "gpt-4",
          client: "web",
          timestamp: "2026-10-11T00:00:00.000Z",
        },
      ],
      pagination: {
        totalCount: 1,
        totalPages: 1,
        currentPage: 1,
        nextPage: null,
      },
    }),
  };

  function app(actor: AuthenticatedActor | undefined) {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      if (!actor)
        return context.json({ error: "Authentication required." }, 401);
      context.set("actor", actor);
      await next();
    };
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({ credits, requireUser }),
    );
  }

  const resolvedPayers: { kind: string; id: string }[] = [];

  test("a signed-out caller is refused", async () => {
    const response = await app(undefined).request(
      "/api/billing/credits/summary",
    );
    expect(response.status).toBe(401);
  });

  test("the summary is the personal balance read, for the session's own account", async () => {
    const response = await app(MEMBER).request("/api/billing/credits/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accountType: string;
      available: number;
      consumed: number;
      pendingSettlement: { enabled: boolean; available: number };
    };
    expect(body.accountType).toBe("personal");
    expect(body.available).toBe(476.37);
    expect(body.consumed).toBe(123.63);
    expect(body.pendingSettlement).toEqual({
      enabled: false,
      available: 0,
      consumed: 0,
      expired: 0,
    });
    // The account came from the session, not from the request: the ref the service received is
    // the signed-in member's own personal payer.
    expect(resolvedPayers).toEqual([{ kind: "personal", id: MEMBER.id }]);
  });

  // BP07/#375：能力不可用原因随个人余额面作答——隔离账户带着行上必留的原因原样到 wire，
  // 页面据此渲染「能力不可用」，而不是把冻结账户画成普通余额。
  test("the summary carries the account capability status, quarantine reason and all (BP07)", async () => {
    accountStatus = {
      status: "quarantined",
      quarantineReason: "legacy key with unknown attribution",
    };
    try {
      const response = await app(MEMBER).request(
        "/api/billing/credits/summary",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        account: { status: string; quarantineReason: string | null };
      };
      expect(body.account).toEqual({
        status: "quarantined",
        quarantineReason: "legacy key with unknown attribution",
      });
    } finally {
      accountStatus = { status: "active", quarantineReason: null };
    }
  });

  test("the grants list carries the soon-to-expire cue", async () => {
    const response = await app(MEMBER).request("/api/billing/credits/grants");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grants: { reason: string; expiringSoon: boolean }[];
    };
    expect(body.grants[0].reason).toBe("官方活动发放");
    expect(body.grants[0].expiringSoon).toBe(true);
  });

  test("the consumption read answers the window and pagination", async () => {
    const response = await app(MEMBER).request(
      "/api/billing/credits/consumption?page=1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: unknown[];
      pagination: { totalCount: number };
    };
    expect(body.entries).toHaveLength(1);
    expect(body.pagination.totalCount).toBe(1);
  });

  test("a malformed window is a 400", async () => {
    const response = await app(MEMBER).request(
      "/api/billing/credits/consumption?from=last-wednesday",
    );
    expect(response.status).toBe(400);
  });

  test("the catalog serializes the plan map into a plain object", async () => {
    const response = await app(MEMBER).request("/api/billing/catalog");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      advanced: { name: string; credits: number };
    };
    expect(body.advanced.name).toBe("高级版");
    expect(body.advanced.credits).toBe(9000);
  });
});
