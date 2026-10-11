import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import type { CreditWriter, CreditGrantResult } from "../src/billing/credits-writer";
import { createBillingAdminRoutes } from "../src/billing/routes";
import type { BillingService } from "../src/billing/types";

/*
 * QA batch-1 probe (e): the admin credit-grant route's guards and audit, driven the way
 * app.ts mounts it — requireUser in front, requireAdmin inside the handler. Independently
 * pinned: source vocabulary (plan refused), totalCents grammar (zero/negative/fractional/
 * oversized), unknown-key rejection, audit payload shape, and that a non-admin NEVER reaches
 * the writer even with a valid body.
 */
const DEPLOYMENT_KEY = "qa-deployment-key";

const ADMIN: AuthenticatedActor = {
  id: "user-admin",
  email: "admin@openbot.test",
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};
const NOBODY: AuthenticatedActor | undefined = undefined;

function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

function grantResult(id: string): CreditGrantResult {
  return {
    id,
    externalCustomerId: DEPLOYMENT_KEY,
    source: "promo",
    reason: null,
    total: 1000,
    used: 0,
    grantedAt: "2026-10-11T00:00:00.000Z",
    expiresAt: "2027-10-11T00:00:00.000Z",
  };
}

/** Records every call; a test asserts what the route actually handed the writer. */
function recordingWriter() {
  const calls: unknown[] = [];
  const writer: CreditWriter = {
    async grantCredits(input: {
      externalCustomerId: string;
      source: "promo" | "signin" | "plan";
      totalCents: number;
      expiresAt: Date;
      reason?: string | null;
      idempotencyKey?: string | null;
    }) {
      calls.push(input);
      return { inserted: true, grant: grantResult(`cg-${calls.length}`) };
    },
  };
  return { writer, calls };
}

function recordingAudit() {
  const events: Array<Record<string, unknown>> = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event as Record<string, unknown>);
    },
  };
  return { store, events };
}

/** The smallest BillingService stand-in: the grant route never calls it, so it can throw. */
const THROWING_SERVICE = {
  async snapshot() {
    throw new Error("the grant route must not touch the snapshot");
  },
} as unknown as BillingService;

function grantApp(
  actor: AuthenticatedActor | undefined,
  writer?: CreditWriter,
) {
  const audit = recordingAudit();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/billing",
    createBillingAdminRoutes({
      service: THROWING_SERVICE,
      requireUser: requireUserAs(actor),
      requireAdmin,
      audit: audit.store,
      externalCustomerKey: DEPLOYMENT_KEY,
      customerName: "QA deployment",
      ...(writer ? { creditWriter: writer } : {}),
    }),
  );
  return { app, audit };
}

const GRANT = "/api/admin/billing/credits/grants";

describe("probe e: the admin grant route", () => {
  test("a non-administrator is refused 403 and the writer is never reached", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(MEMBER, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "promo", totalCents: 1000 }),
    });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("an unsigned-in request is refused 401, not 500", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(NOBODY, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "promo", totalCents: 1000 }),
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("source=plan is refused 400 — the plan allowance is never handed out manually", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(ADMIN, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "plan", totalCents: 1000 }),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("totalCents grammar: zero, negative, fractional, oversized are all refused 400", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(ADMIN, writer);
    for (const totalCents of [0, -100, 10.5, 1_000_000_001]) {
      const response = await app.request(GRANT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "promo", totalCents }),
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("an unknown extra key in the body is refused (strictObject), not ignored", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(ADMIN, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "promo",
        totalCents: 1000,
        idempotencyKey: "attacker-chosen-key",
      }),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a valid signin grant lands, is keyless by design, and audits its row", async () => {
    const { writer, calls } = recordingWriter();
    const { app, audit } = grantApp(ADMIN, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "signin",
        totalCents: 500,
        reason: "QA 签到",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { grant: { id: string } };
    expect(body.grant.id).toBe("cg-1");

    // The writer saw the deployment's customer, the signin source, and NO caller-chosen key:
    // two presses must mean two grants, so the key must be null here.
    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      externalCustomerId: string;
      source: string;
      totalCents: number;
      idempotencyKey: string | null | undefined;
      expiresAt: Date;
    };
    expect(call.externalCustomerId).toBe(DEPLOYMENT_KEY);
    expect(call.source).toBe("signin");
    expect(call.totalCents).toBe(500);
    expect(call.idempotencyKey).toBeNull();

    // Default expiry: no expiresAt in the body → about a year out, never the epoch.
    expect(call.expiresAt.getTime()).toBeGreaterThan(Date.now() + 364 * 24 * 3600_000);

    // The audit row names the actor, the type, and the grant id.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      eventType: "billing.credits.granted",
      actorUserId: ADMIN.id,
      targetType: "billing",
      payload: {
        source: "signin",
        totalCents: 500,
        grantId: "cg-1",
        reason: "QA 签到",
      },
    });
  });

  test("an explicit expiry is honoured and carried into the audit-free zone (writer only)", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(ADMIN, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "promo",
        totalCents: 1000,
        expiresAt: "2026-12-31T23:59:59Z",
      }),
    });
    expect(response.status).toBe(200);
    const call = calls[0] as { expiresAt: Date };
    expect(call.expiresAt.toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });

  test("a nonsense expiry string is refused 400, not a NaN grant", async () => {
    const { writer, calls } = recordingWriter();
    const { app } = grantApp(ADMIN, writer);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "promo",
        totalCents: 1000,
        expiresAt: "not-a-date",
      }),
    });
    // The zod datetime gate refuses it before the NaN guard is even needed.
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("without a credit writer the route answers 503 and audits nothing", async () => {
    const { app, audit } = grantApp(ADMIN, undefined);
    const response = await app.request(GRANT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "promo", totalCents: 1000 }),
    });
    expect(response.status).toBe(503);
    expect(audit.events).toHaveLength(0);
  });
});
