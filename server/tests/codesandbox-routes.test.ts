import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createCodeSandboxRoutes } from "../src/codesandbox/routes";
import type { AppVariables } from "../src/auth/guards";
import type { AgentActor } from "../src/agents/profile-types";
import type { CodeRunGateway, CodeRunOutcome } from "../src/codesandbox/gateway";

function gatewayWith(outcome: CodeRunOutcome): CodeRunGateway {
  return { run: async () => outcome };
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
  requireUser = requireUserAs({ id: "user-1", role: "user" }),
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/codesandbox",
    createCodeSandboxRoutes(requireUser, async () => true, () => gateway),
  );
  return app;
}

describe("POST /api/codesandbox/runs", () => {
  test("returns the completed outcome", async () => {
    const app = buildApp(
      gatewayWith({ kind: "completed", runId: "cr-1", text: "done", artifacts: [] }),
    );
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: "算个东西" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "completed", text: "done" });
  });

  test("a task that is not a string is 400 without reaching the gateway", async () => {
    let calls = 0;
    const app = buildApp({
      run: async () => {
        calls += 1;
        return { kind: "refused", reason: "x" };
      },
    });
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: 42 }),
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("a caller who may not use the bot is 403", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/codesandbox",
      createCodeSandboxRoutes(
        requireUserAs({ id: "user-2", role: "user" }),
        async () => false,
        () => gatewayWith({ kind: "refused", reason: "x" }),
      ),
    );
    const response = await app.request("/api/codesandbox/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", task: "t" }),
    });
    expect(response.status).toBe(403);
  });
});
