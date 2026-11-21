import { expect, test } from "bun:test";
import { createManagedModel } from "../src/managed-model-trial";

const scope = {
  source: "direct-chat" as const,
  personId: "authenticated-person",
  runId: "run-1",
  conversationId: "conversation-1",
  botId: "bot-1",
};
const route = "pilot-text-v1";
const messages = [{ role: "user", content: "One question" }] as const;

test("a product model call requires a confirmed Test Credit reservation", async () => {
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/v1/reserve") {
        return Response.json({
          state: "denied",
          reason: "insufficient_credits",
        });
      }
      throw new Error("An unfunded call must never dispatch or reconcile.");
    },
  });
  try {
    const model = createManagedModel({ url: control.url, token: "test-token" });
    expect(
      await model.complete({ scope, step: "answer", route, messages }),
    ).toEqual({
      state: "insufficient_credits",
    });
  } finally {
    await control.stop(true);
  }
});

test("losing a reservation response fails closed and reconciles only the original operation", async () => {
  const calls: { path: string; operationId: string }[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const { operationId } = await request.json();
      calls.push({ path, operationId });
      if (path === "/v1/reserve") return new Response(null, { status: 503 });
      expect(path).toBe("/v1/reconcile");
      return Response.json({ state: "released" });
    },
  });
  try {
    const model = createManagedModel({ url: control.url, token: "test-token" });
    expect(
      await model.complete({ scope, step: "answer", route, messages }),
    ).toEqual({ state: "unavailable" });
    expect(calls).toEqual([
      { path: "/v1/reserve", operationId: expect.any(String) },
      { path: "/v1/reconcile", operationId: calls[0]?.operationId },
    ]);
  } finally {
    await control.stop(true);
  }
});

test.each(["settled", "released"] as const)(
  "uncertain dispatch reaches %s from a fresh caller without a second supplier attempt",
  async (terminal) => {
    const calls: { path: string; operationId: string }[] = [];
    let ledgerState: "pending" | "settled" | "released" = "pending";
    let dispatches = 0;
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const { operationId } = await request.json();
        calls.push({ path, operationId });
        if (path === "/v1/reserve") {
          return Response.json(
            dispatches === 0
              ? { state: "reserved", permit: "pilot-permit" }
              : { state: "existing" },
          );
        }
        if (path === "/v1/dispatch") {
          dispatches++;
          return new Response(null, { status: 504 });
        }
        expect(path).toBe("/v1/reconcile");
        return Response.json({ state: ledgerState });
      },
    });
    try {
      const config = { url: control.url, token: "test-token" };
      const input = { scope, step: "answer", route, messages };
      expect(await createManagedModel(config).complete(input)).toEqual({
        state: "reconciling",
      });
      ledgerState = terminal;
      const restarted = createManagedModel(config);
      expect(await restarted.complete(input)).toEqual({ state: terminal });
      expect(await restarted.reconcile(input)).toBe(terminal);
      expect(dispatches).toBe(1);
      expect(new Set(calls.map((call) => call.operationId)).size).toBe(1);
      expect(calls.map((call) => call.path)).toEqual([
        "/v1/reserve",
        "/v1/dispatch",
        "/v1/reconcile",
        "/v1/reserve",
        "/v1/reconcile",
        "/v1/reconcile",
      ]);
    } finally {
      await control.stop(true);
    }
  },
);

test("a lost authorization at dispatch returns a refusal and reconciles the reservation", async () => {
  const paths: string[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/v1/reserve") {
        return Response.json({ state: "reserved", permit: "trial-permit" });
      }
      if (path === "/v1/dispatch") {
        return Response.json({ state: "denied", reason: "not_authorized" });
      }
      return Response.json({ state: "released" });
    },
  });
  try {
    const model = createManagedModel({ url: control.url, token: "test-token" });
    expect(
      await model.complete({ scope, step: "answer", route, messages }),
    ).toEqual({ state: "not_authorized" });
    expect(paths).toEqual(["/v1/reserve", "/v1/dispatch", "/v1/reconcile"]);
  } finally {
    await control.stop(true);
  }
});
