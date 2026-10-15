import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  OBSERVATION_ACCESS_DENIED,
  OBSERVATION_BOT_REQUIRED,
  resolveObservationBot,
  type BotManagementCheck,
} from "../src/ai-observability/context";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;
const admin = { id: "user-admin", role: "admin" } as const;

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Expense Manager",
    title: "Finance",
    roleDescription: "Reviews receipts.",
    avatarSeed: "expense-manager",
    visibility: "private",
    ownerUserId: owner.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

/** 管理级 check：与 canManageAgent 同语义，测试里用它替代真实 store。 */
function managementCheck(rows: AgentProfile[]): BotManagementCheck {
  return async (actor, botId) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    if (!found) return null;
    if (found.systemOwned || found.deletedAt !== null) return null;
    return found.ownerUserId === actor.id || actor.role === "admin"
      ? found
      : null;
  };
}

describe("resolveObservationBot", () => {
  test("a missing bot id is refused before any lookup", async () => {
    let called = 0;
    const result = await resolveObservationBot(async () => {
      called += 1;
      return null;
    }, owner, undefined);
    expect(result).toEqual({ ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED });
    expect(called).toBe(0);
  });

  test("the owner gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), owner, "agent-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe("agent-1");
  });

  test("an administrator gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), admin, "agent-1");
    expect(result.ok).toBe(true);
  });

  test("a stranger is refused even though the Bot exists", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("public visibility does NOT grant observation access", async () => {
    const rows = [profile({ visibility: "public" })];
    const result = await resolveObservationBot(managementCheck(rows), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("an unknown bot id is refused without leaking existence", async () => {
    const result = await resolveObservationBot(managementCheck([]), owner, "agent-nope");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("a system-owned or deleted Bot is refused even for its owner", async () => {
    const rows = [profile({ systemOwned: true }), profile({ id: "agent-2", deletedAt: new Date() })];
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-1")).ok).toBe(false);
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-2")).ok).toBe(false);
  });
});

function actorVariables(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

const rejectingUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => {
  // `return` is load-bearing: without it the middleware does not short-circuit, Hono reports
  // "Context is not finalized" and a correct implementation answers 500 instead of 401.
  // The real guard (auth/guards.ts createRequireUser) returns too.
  return await context.json({ error: "Authentication required." }, 401);
};

function appFor(
  rows: AgentProfile[],
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = actorVariables(
    owner as unknown as AuthenticatedActor,
  ),
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: middleware,
      canManageBot: managementCheck(rows),
    }),
  );
  return app;
}

describe("GET /bots/:botId/access", () => {
  test("an unauthenticated caller is refused before business logic", async () => {
    const app = appFor([profile()], rejectingUser);
    const response = await app.request("http://openbot.test/bots/agent-1/access");
    expect(response.status).toBe(401);
  });

  test("the owner sees observation access granted and no capability yet", async () => {
    const response = await appFor([profile()]).request(
      "http://openbot.test/bots/agent-1/access",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: "agent-1",
      observationAccess: true,
      capability: "none",
    });
  });

  test("a stranger is refused with 403 and the store is never asked for runs", async () => {
    const app = appFor(
      [profile()],
      actorVariables(stranger as unknown as AuthenticatedActor),
    );
    const response = await app.request("http://openbot.test/bots/agent-1/access");
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(OBSERVATION_ACCESS_DENIED);
  });

  test("a public Bot the caller cannot manage is still refused", async () => {
    const app = appFor(
      [profile({ visibility: "public" })],
      actorVariables(stranger as unknown as AuthenticatedActor),
    );
    expect((await app.request("http://openbot.test/bots/agent-1/access")).status).toBe(403);
  });

  test("a missing bot id answers 404 with an explainable error", async () => {
    const response = await appFor([profile()]).request(
      "http://openbot.test/bots//access",
    );
    expect([404]).toContain(response.status);
  });
});
