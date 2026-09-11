import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { BotAccessCheck } from "../src/plugins/routes";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";

function appWith(calls: { grants: unknown[]; toolCalls: unknown[] }) {
  const store = {
    grant: async (kind: unknown, ref: unknown, agentId: unknown) => {
      calls.grants.push({ kind, ref, agentId });
      return { ok: true };
    },
    callTool: async (input: unknown) => {
      calls.toolCalls.push(input);
      return { ok: true };
    },
  } as unknown as PluginStore;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "user@openbot.test",
      role: "admin",
    });
    await next();
  };
  const canUseBot: BotAccessCheck = async () => true;
  return createPluginRoutes(store, requireUser, canUseBot);
}

/**
 * The body is JSON, so the annotation is a wish.
 *
 * `{"ref":123,"agentId":[]}` is truthy and used to pass the presence check, then reach the store
 * where Drizzle compares a text column against a number and the request answers 500. A ref and a
 * Bot id are non-empty strings; anything else is a 400 before any grant, call, or audit row.
 */
describe("POST /api/plugins/grants", () => {
  test.each([
    ["a number ref", { kind: "mcp", ref: 123, agentId: "bot-1" }],
    ["an object ref", { kind: "mcp", ref: {}, agentId: "bot-1" }],
    ["a number agentId", { kind: "mcp", ref: "tool", agentId: 456 }],
    ["an array agentId", { kind: "mcp", ref: "tool", agentId: [] }],
    ["a whitespace ref", { kind: "mcp", ref: "   ", agentId: "bot-1" }],
    ["a whitespace agentId", { kind: "mcp", ref: "tool", agentId: "  " }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const calls = { grants: [] as unknown[], toolCalls: [] as unknown[] };
    const response = await appWith(calls).request(
      "http://openbot.test/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A kind, a ref and a Bot are required.",
    });
    expect(calls.grants).toEqual([]);
  });
});

describe("POST /api/plugins/call", () => {
  test.each([
    ["a number ref", { ref: 123, agentId: "bot-1" }],
    ["an object ref", { ref: {}, agentId: "bot-1" }],
    ["a number agentId", { ref: "tool", agentId: 456 }],
    ["a whitespace ref", { ref: "  ", agentId: "bot-1" }],
  ])("refuses %s with 400 and never reaches the store", async (_n, body) => {
    const calls = { grants: [] as unknown[], toolCalls: [] as unknown[] };
    const response = await appWith(calls).request("http://openbot.test/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A tool and a Bot are required.",
    });
    expect(calls.toolCalls).toEqual([]);
  });
});
