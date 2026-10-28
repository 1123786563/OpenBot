import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono, type MiddlewareHandler } from "hono";
import { createCodeSandboxRoutes } from "../src/codesandbox/routes";
import type { AppVariables } from "../src/auth/guards";
import type { AgentActor } from "../src/agents/profile-types";
import type {
  CodeRunGateway,
  CodeRunOutcome,
} from "../src/codesandbox/gateway";

function gatewayWith(outcome: CodeRunOutcome): CodeRunGateway {
  return {
    run: async () => outcome,
    resetWorkspace: async () => ({ ok: true }),
  };
}

function requireUserAs(actor: AgentActor): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function buildApp(
  gateway: CodeRunGateway,
  canUseBot: (
    actor: AgentActor,
    botId: string,
  ) => Promise<boolean> = async () => true,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }> = requireUserAs({
    id: "user-1",
    role: "user",
  }),
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/codesandbox",
    createCodeSandboxRoutes(requireUser, canUseBot, () => gateway),
  );
  return app;
}

describe("POST /api/codesandbox/runs", () => {
  test("returns the completed outcome", async () => {
    const app = buildApp(
      gatewayWith({
        kind: "completed",
        runId: "cr-1",
        text: "done",
        artifacts: [],
      }),
    );
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: "算个东西" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "completed",
      text: "done",
    });
  });

  test("a task that is not a string is 400 without reaching the gateway", async () => {
    let calls = 0;
    const app = buildApp({
      run: async () => {
        calls += 1;
        return { kind: "refused", reason: "x" };
      },
      resetWorkspace: async () => ({ ok: true }),
    });
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: 42 }),
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("timeoutSeconds outside 1-600 is 400 without reaching the gateway", async () => {
    let calls = 0;
    const app = buildApp({
      run: async () => {
        calls += 1;
        return { kind: "refused", reason: "x" };
      },
      resetWorkspace: async () => ({ ok: true }),
    });
    for (const timeoutSeconds of [0, 601]) {
      const response = await app.request("/api/codesandbox/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot-1", task: "t", timeoutSeconds }),
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("timeoutSeconds reaches the gateway run options", async () => {
    let received: { timeoutSeconds?: number; toolCallId?: string } | undefined;
    const app = buildApp({
      run: async (_task, opts) => {
        received = opts;
        return {
          kind: "completed",
          runId: "cr-1",
          text: "done",
          artifacts: [],
        };
      },
      resetWorkspace: async () => ({ ok: true }),
    });
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: "t", timeoutSeconds: 60 }),
    });
    expect(response.status).toBe(200);
    expect(received).toEqual({ timeoutSeconds: 60, toolCallId: undefined });
  });

  test("a caller who may not use the bot is 403", async () => {
    const app = buildApp(
      gatewayWith({ kind: "refused", reason: "x" }),
      async () => false,
      requireUserAs({ id: "user-2", role: "user" }),
    );
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: "t" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("POST /api/codesandbox/reset", () => {
  test("resets the bot workspace and answers ok", async () => {
    let resets = 0;
    const app = buildApp({
      run: async () => ({ kind: "refused", reason: "x" }),
      resetWorkspace: async () => {
        resets += 1;
        return { ok: true };
      },
    });
    const response = await app.request("/api/codesandbox/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(resets).toBe(1);
  });

  test("a refused reset is 409 with the reason", async () => {
    const app = buildApp({
      run: async () => ({ kind: "refused", reason: "x" }),
      resetWorkspace: async () => ({ ok: false, reason: "not-configured" }),
    });
    const response = await app.request("/api/codesandbox/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      reason: "not-configured",
    });
  });

  test("a missing botId is 400 without reaching the gateway", async () => {
    let resets = 0;
    const app = buildApp({
      run: async () => ({ kind: "refused", reason: "x" }),
      resetWorkspace: async () => {
        resets += 1;
        return { ok: true };
      },
    });
    const response = await app.request("/api/codesandbox/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "no bot" }),
    });
    expect(response.status).toBe(400);
    expect(resets).toBe(0);
  });

  test("a caller who may not use the bot is 403", async () => {
    const app = buildApp(
      gatewayWith({ kind: "refused", reason: "x" }),
      async () => false,
      requireUserAs({ id: "user-2", role: "user" }),
    );
    const response = await app.request("/api/codesandbox/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(response.status).toBe(403);
  });
});
