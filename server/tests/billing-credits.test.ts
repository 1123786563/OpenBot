import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { deriveGrantStatus, type Credits } from "../src/billing/credits";
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

  const credits: Credits = {
    catalog: new Map([["advanced", CATALOG]]),
    summary: async () => ({
      plan: { total: 500, used: 100, remaining: 400 },
      rewards: { total: 100, used: 23.63, remaining: 76.37, grantCount: 2 },
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
      if (!actor) return context.json({ error: "Authentication required." }, 401);
      context.set("actor", actor);
      await next();
    };
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({ credits, requireUser }),
    );
  }

  test("a signed-out caller is refused", async () => {
    const response = await app(undefined).request("/api/billing/credits/summary");
    expect(response.status).toBe(401);
  });

  test("the summary splits plan and reward balances", async () => {
    const response = await app(MEMBER).request("/api/billing/credits/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plan: { remaining: number };
      rewards: { remaining: number; grantCount: number };
    };
    expect(body.plan.remaining).toBe(400);
    expect(body.rewards.grantCount).toBe(2);
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
