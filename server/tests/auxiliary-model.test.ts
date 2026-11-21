import { expect, test } from "bun:test";
import { createAuxiliaryModelCompleter } from "../src/billing/auxiliary-model";

const scope = {
  source: "routing" as const,
  personId: "person-1",
  conversationId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
};

function controlServer(options: { dispatch?: (body: any) => Response }) {
  const calls: { path: string; body: any }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json().catch(() => undefined);
      calls.push({ path, body });
      if (path === "/v1/reserve")
        return Response.json({ state: "reserved", permit: "permit-1" });
      if (path === "/v1/dispatch")
        return (
          options.dispatch?.(body) ??
          Response.json({ state: "completed", text: "routed" })
        );
      if (path === "/v1/reconcile") return Response.json({ state: "settled" });
      return new Response("missing", { status: 404 });
    },
  });
  return { server, calls };
}

test("an auxiliary call uses one stable managed operation and explicit user budget", async () => {
  const { server, calls } = controlServer({});
  try {
    const complete = createAuxiliaryModelCompleter({
      model: { url: server.url, token: "token" },
      route: "aux-route",
    });
    const result = await complete("Pick a coworker", undefined, {
      billing: {
        ...scope,
        step: "route",
        funding: { kind: "user", budget: { id: "budget-1", stepId: "route" } },
      },
    });
    expect(result).toBe("routed");
    expect(calls.map(({ path }) => path)).toEqual([
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
    ]);
    expect(calls[0]?.body).toMatchObject({
      route: "aux-route",
      budgetId: "budget-1",
      stepId: "route",
      scope,
      step: "route",
    });
    expect(calls[1]?.body.messages).toEqual([
      { role: "user", content: "Pick a coworker" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("a platform-funded auxiliary call requires an explicit bounded budget", async () => {
  const { server } = controlServer({});
  try {
    const complete = createAuxiliaryModelCompleter({
      model: { url: server.url, token: "token" },
      route: "aux-route",
    });
    await expect(
      complete("Pick", undefined, {
        billing: { ...scope, step: "route", funding: { kind: "platform" } },
      }),
    ).rejects.toThrow("bounded platform budget");
  } finally {
    await server.stop(true);
  }
});

test("missing auxiliary billing context is refused before any network call", async () => {
  const { server, calls } = controlServer({});
  try {
    const complete = createAuxiliaryModelCompleter({
      model: { url: server.url, token: "token" },
      route: "aux-route",
    });
    await expect(complete("Pick")).rejects.toThrow("billing context");
    expect(calls).toHaveLength(0);
  } finally {
    await server.stop(true);
  }
});
