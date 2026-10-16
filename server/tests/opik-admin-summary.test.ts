// Issue #39 / DAG T33 — the admin-scope summary surface and the epic's wiring seams.
//
// Part 1: the summary route authorizes FIRST (the manage gate, then the T06 scope
// with its enterprise-refusal-before-ownership order) and only then aggregates;
// a caller's query string may name a bot and a time window and nothing else, so
// no forged actor, scope or filter can steer the summary.
//
// Part 2: the mount seam (runs query 503-when-portless, the export-route and
// summary mounts appearing only with their deps), the background reauthorization
// seam the export worker boots with, and the control-plane cancel seam the admin
// people-revocation route calls.
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type {
  AdminSummary,
  AdminSummaryService,
} from "../src/ai-observability/admin-summary";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type { ExportReauthorization } from "../src/ai-observability/exports";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import {
  createActorResolver,
  createExportReauthorization,
} from "../src/ai-observability/wiring";
import { createApp } from "../src/app";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const owner = { id: "user-owner", role: "user" } as const;
const admin = { id: "user-admin", role: "admin" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;

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
    ...overrides,
  } as AgentProfile;
}

/** 管理级 check：与 canManageAgent 同语义，测试里用它替代真实 store。 */
function managementCheck(rows: AgentProfile[]) {
  return async (actor: { id: string; role: string }, botId: string) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    if (!found) return null;
    if (found.systemOwned || found.deletedAt !== null) return null;
    return found.ownerUserId === actor.id || actor.role === "admin"
      ? found
      : null;
  };
}

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
  return context.json({ error: "Authentication required." }, 401);
};

/** A service that records the scopes it was handed and answers a fixed shape. */
function recordingSummary() {
  const calls: Array<{
    scopes: readonly ObservationScope[];
    window: { from: Date | null; to: Date | null };
    botId: string | null;
  }> = [];
  const fixed: AdminSummary = {
    window: { from: null, to: null, botId: null },
    collection: {
      readiness: { ready: false, reason: "capability_missing" },
      dropped: { queueFull: 0, notReady: 0 },
    },
    bots: [
      {
        botId: "agent-1",
        runs: {
          total: 0,
          byState: {
            running: 0,
            completed: 0,
            failed: 0,
            canceled: 0,
            interrupted: 0,
            unknown: 0,
          },
          pendingSync: 0,
          capabilities: { basic: 0, detailed: 0, unavailable: 0 },
          unboundUpstream: null,
          usage: null,
        },
        experiments: { draft: 0, frozen: 0 },
        exports: {
          byState: {
            queued: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          lastFailedErrorCode: null,
        },
        collection: { lastCollectedAt: null },
      },
    ],
    botsTruncated: false,
  };
  const service: AdminSummaryService = {
    summarize: async (input) => {
      calls.push(input);
      return fixed;
    },
  };
  return { service, calls, fixed };
}

function summaryApp(
  rows: AgentProfile[],
  _actor: AuthenticatedActor = owner as unknown as AuthenticatedActor,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = actorVariables(
    owner as unknown as AuthenticatedActor,
  ),
) {
  const recorder = recordingSummary();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: middleware,
      canManageBot: managementCheck(rows),
      scopeEpoch: async () => 3,
      listBots: async () => rows,
      summary: recorder.service,
    }),
  );
  return { app, recorder };
}

describe("GET /admin/summary authorization and filters", () => {
  test("an unauthenticated caller is refused before any summary work", async () => {
    const { app, recorder } = summaryApp(
      [profile()],
      owner as unknown as AuthenticatedActor,
      rejectingUser,
    );
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1",
    );
    expect(response.status).toBe(401);
    expect(recorder.calls).toEqual([]);
  });

  test("a bot the caller cannot manage answers 404 and the summary never runs", async () => {
    const { app, recorder } = summaryApp(
      [profile()],
      stranger as unknown as AuthenticatedActor,
      actorVariables(stranger as unknown as AuthenticatedActor),
    );
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1",
    );
    expect(response.status).toBe(404);
    expect(recorder.calls).toEqual([]);
  });

  test("a malformed time window is refused with 400 before any lookup", async () => {
    const { app, recorder } = summaryApp([profile()]);
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1&timeFrom=not-a-date",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "ADMIN_SUMMARY_INPUT_INVALID",
    });
    expect(recorder.calls).toEqual([]);
  });

  test("an inverted time window is refused with 400", async () => {
    const { app } = summaryApp([profile()]);
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1&timeFrom=2026-10-16T10:00:00.000Z&timeTo=2026-10-15T10:00:00.000Z",
    );
    expect(response.status).toBe(400);
  });

  test("the filtered summary runs on one scope minted from the live epoch", async () => {
    const { app, recorder } = summaryApp([profile()]);
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1&timeFrom=2026-10-15T10:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(recorder.calls.length).toBe(1);
    const call = recorder.calls[0];
    expect(call.scopes.length).toBe(1);
    expect(call.scopes[0].botId).toBe("agent-1");
    expect(call.scopes[0].actorId).toBe(owner.id);
    expect(call.scopes[0].epoch).toBe(3);
    expect(call.botId).toBe("agent-1");
    expect(call.window.from).toEqual(new Date("2026-10-15T10:00:00.000Z"));
    expect(call.window.to).toBe(null);
    const body = await response.json();
    expect(body.window.botId).toBe("agent-1");
    expect(body.bots[0].botId).toBe("agent-1");
  });

  test("the unfiltered summary enumerates only manageable bots", async () => {
    const rows = [
      profile(),
      profile({ id: "agent-foreign", ownerUserId: "user-b" }),
    ];
    const { app, recorder } = summaryApp(rows);
    const response = await app.request("http://openbot.test/admin/summary");
    expect(response.status).toBe(200);
    expect(recorder.calls.length).toBe(1);
    // The foreign bot fails the manage gate and never reaches the summary.
    expect(recorder.calls[0].scopes.map((scope) => scope.botId)).toEqual([
      "agent-1",
    ]);
    expect(recorder.calls[0].botId).toBe(null);
  });

  test("an administrator's enumeration includes every manageable bot", async () => {
    const rows = [profile(), profile({ id: "agent-2", ownerUserId: "user-b" })];
    const { app, recorder } = summaryApp(
      rows,
      admin as unknown as AuthenticatedActor,
      actorVariables(admin as unknown as AuthenticatedActor),
    );
    const response = await app.request("http://openbot.test/admin/summary");
    expect(response.status).toBe(200);
    expect(recorder.calls[0].scopes.map((scope) => scope.botId).sort()).toEqual(
      ["agent-1", "agent-2"],
    );
    expect(
      recorder.calls[0].scopes.every((scope) => scope.actorId === admin.id),
    ).toBe(true);
  });

  test("forged actor/scope query parameters steer nothing", async () => {
    const { app, recorder } = summaryApp([profile()]);
    const response = await app.request(
      "http://openbot.test/admin/summary?botId=agent-1&actor=user-b&scope=wb%7Cuser-b%7Cagent-1%7C0&ownership=owner&epoch=99",
    );
    expect(response.status).toBe(200);
    expect(recorder.calls[0].scopes[0].actorId).toBe(owner.id);
    expect(recorder.calls[0].scopes[0].epoch).toBe(3);
  });

  test("a failed listing answers 500, never an empty 200 (T33-rev3 M-3, server side)", async () => {
    // The boot wiring used to swallow listBots failures into an empty array,
    // so the store failing to list read as "no bots in scope" — the page's
    // explicit unavailable fault could never trigger. A failure propagates
    // now, and the page maps the 500 to that fault.
    const recorder = recordingSummary();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createAiObservabilityRoutes({
        requireUser: actorVariables(owner as unknown as AuthenticatedActor),
        canManageBot: managementCheck([profile()]),
        scopeEpoch: async () => 3,
        listBots: async () => {
          throw new Error("listing store down");
        },
        summary: recorder.service,
      }),
    );
    const response = await app.request("http://openbot.test/admin/summary");
    expect(response.status).toBe(500);
    expect(recorder.calls).toEqual([]);
  });
});

describe("the T01 mount seam (Part 2 wiring)", () => {
  test("without their deps the runs, exports and summary routes do not exist", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createAiObservabilityRoutes({
        requireUser: actorVariables(owner as unknown as AuthenticatedActor),
        canManageBot: managementCheck([profile()]),
      }),
    );
    for (const path of [
      "/bots/agent-1/runs",
      "/bots/agent-1/runs/run-1",
      "/bots/agent-1/exports",
      "/admin/summary",
    ]) {
      expect(
        (await app.request(`http://openbot.test${path}`)).status,
        path,
      ).toBe(404);
    }
  });

  test("the T12 leftover: mounted runs query answers an honest 503 when no verified port backs the deployment", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createAiObservabilityRoutes({
        requireUser: actorVariables(owner as unknown as AuthenticatedActor),
        canManageBot: managementCheck([profile()]),
        scopeEpoch: async () => 3,
        bindings: {
          latestAttempt: async () => null,
        },
        config: () => ({
          enabled: true,
          baseUrl: "http://opik.test",
          apiKey: null,
          workspaceName: null,
          port: 5174,
          otlpHttpPort: 5418,
          otlpGrpcPort: 5417,
        }),
        port: null,
      }),
    );
    const list = await app.request("http://openbot.test/bots/agent-1/runs");
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({ error: "capability_missing" });
    const detail = await app.request(
      "http://openbot.test/bots/agent-1/runs/run-1",
    );
    expect(detail.status).toBe(503);
    expect(await detail.json()).toEqual({ error: "capability_missing" });
  });
});

describe("createExportReauthorization (the worker's T11-style seam)", () => {
  const epochFor = async (actor: { id: string }, botId: string) =>
    actor.id === "user-owner" && botId === "agent-1" ? 7 : 0;

  function reauthorize(
    roles: readonly string[],
    rows: AgentProfile[],
  ): ExportReauthorization {
    return createExportReauthorization({
      canManageBot: managementCheck(rows),
      scopeEpoch: epochFor,
      resolveActor: createActorResolver(async () => roles),
    });
  }

  test("an actor with no role answers null — the job is cancelled, not guessed at", async () => {
    expect(
      await reauthorize(
        [],
        [profile()],
      )({ actorId: "user-owner", botId: "agent-1" }),
    ).toBe(null);
  });

  test("an actor failing the manage gate answers null", async () => {
    expect(
      await reauthorize(
        ["user"],
        [profile()],
      )({
        actorId: "user-stranger",
        botId: "agent-1",
      }),
    ).toBe(null);
  });

  test("the owner's live authorization re-derives their scope", async () => {
    const scope = await reauthorize(
      ["user"],
      [profile()],
    )({
      actorId: "user-owner",
      botId: "agent-1",
    });
    expect(scope).not.toBe(null);
    expect(scope?.actorId).toBe("user-owner");
    expect(scope?.botId).toBe("agent-1");
    expect(scope?.epoch).toBe(7);
  });

  test("an administrator who is not the owner gets the admin ownership answer", async () => {
    const scope = await reauthorize(
      ["admin"],
      [profile()],
    )({
      actorId: "user-admin",
      botId: "agent-1",
    });
    expect(scope?.actorId).toBe("user-admin");
  });
});

describe("the control-plane cancel seam (T32 wiring)", () => {
  function adminApp(cancel: (actorId: string) => Promise<unknown>) {
    const cancelled: string[] = [];
    const peopleStore = {
      list: async () => ({ people: [], nextCursor: null }),
      setRole: async () => {},
      revoke: async (userId: string) => {
        cancelled.push(`revoke:${userId}`);
      },
      retireOwned: async (userId: string) => {
        cancelled.push(`retire:${userId}`);
      },
      restore: async () => {},
      find: async (userId: string) => ({
        id: userId,
        email: "gone@openbot.test",
        name: null,
        image: null,
        role: "user",
        providers: [],
        lastSignedInAt: null,
        revoked: false,
        configuredAdmin: false,
      }),
      isRevoked: async () => false,
    };
    // createApp's stores are positional; peopleStore is the 18th argument and
    // openMuseSeams the 46th. Built by index so an appended store cannot
    // silently shift the seam.
    const args: never[] = Array.from({ length: 46 }) as never[];
    args[0] = loadConfig(testEnvironment()) as never;
    args[1] = {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { id: "admin-1", email: "admin@openbot.test" },
        }),
      },
    } as never;
    args[2] = { rolesForUser: async () => ["admin"] } as never;
    args[17] = peopleStore as never;
    args[45] = {
      aiObservabilityCancelForActor: async (actorId: string) => {
        await cancel(actorId);
      },
    } as never;
    return { app: createApp(...args), cancelled };
  }

  test("revoking a person's access cancels their queued observation exports", async () => {
    const cancelled: string[] = [];
    const { app } = adminApp(async (actorId) => {
      cancelled.push(actorId);
    });
    const response = await app.request(
      "http://openbot.test/api/admin/people/user-gone/access",
      { method: "POST", body: JSON.stringify({ revoked: true }) },
    );
    expect(response.status).toBe(200);
    expect(cancelled).toEqual(["user-gone"]);
  });

  test("restoring access never touches the cancel seam", async () => {
    const cancelled: string[] = [];
    const { app } = adminApp(async (actorId) => {
      cancelled.push(actorId);
    });
    const response = await app.request(
      "http://openbot.test/api/admin/people/user-gone/access",
      { method: "POST", body: JSON.stringify({ revoked: false }) },
    );
    expect(response.status).toBe(200);
    expect(cancelled).toEqual([]);
  });
});
