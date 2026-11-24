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

const credentials = new Map([[scope.personId, "test-token"]]);
const priceVersion = "a6000000-0000-4000-8000-000000000001";

test("reserves on the quoted Price Version using the billing execution contract", async () => {
  const paths: string[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      if (path === "/v1/quote") {
        expect(request.method).toBe("GET");
        return Response.json({ route, priceVersion });
      }
      if (path === "/v1/reserve") {
        const body = await request.json();
        expect(body).toEqual({
          operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          route,
          priceVersion,
          creditType: "test",
          applicationId: "openbot",
          resumable: false,
        });
        return Response.json({ state: "reserved", permit: "fixture-permit" });
      }
      if (path === "/v1/dispatch")
        return Response.json({ state: "completed", text: "Answer" });
      return Response.json({ state: "settled" });
    },
  });
  try {
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
    expect(
      await model.complete({ scope, step: "answer", route, messages }),
    ).toEqual({
      state: "completed",
      text: "Answer",
    });
    expect(paths).toEqual([
      "/v1/quote",
      "/v1/reserve",
      "/v1/dispatch",
      "/v1/reconcile",
    ]);
  } finally {
    await control.stop(true);
  }
});

test.each([
  new Response(null, { status: 503 }),
  Response.json({ route, priceVersion: "invalid" }),
])(
  "fails closed before reservation when the quote is unusable",
  async (quote) => {
    const paths: string[] = [];
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return path === "/v1/quote"
          ? quote
          : new Response(null, { status: 503 });
      },
    });
    try {
      const model = createManagedModel({
        url: control.url,
        credentials,
      });
      expect(
        await model.complete({ scope, step: "answer", route, messages }),
      ).toEqual({
        state: "unavailable",
      });
      expect(paths).toEqual(["/v1/quote"]);
    } finally {
      await control.stop(true);
    }
  },
);

test("a product model call requires a confirmed Test Credit reservation", async () => {
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/quote") return Response.json({ route, priceVersion });
      if (path === "/v1/reserve") {
        return Response.json({
          state: "denied",
          reason: "insufficient_credits",
        });
      }
      throw new Error("An unfunded call must never dispatch or reconcile.");
    },
  });
  try {
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
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
      if (path === "/v1/quote") return Response.json({ route, priceVersion });
      const { operationId } = await request.json();
      calls.push({ path, operationId });
      if (path === "/v1/reserve") return new Response(null, { status: 503 });
      expect(path).toBe("/v1/reconcile");
      return Response.json({ state: "released" });
    },
  });
  try {
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
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
        if (path === "/v1/quote") return Response.json({ route, priceVersion });
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
      const config = {
        url: control.url,
        credentials,
      };
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

test("retry returns the verified reply after losing the dispatch response", async () => {
  let dispatchedOperation: string | undefined;
  let recovered = false;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/quote") return Response.json({ route, priceVersion });
      const { operationId } = await request.json();
      if (path === "/v1/reserve") {
        return Response.json(
          dispatchedOperation
            ? { state: "existing" }
            : { state: "reserved", permit: "pilot-permit" },
        );
      }
      if (path === "/v1/dispatch") {
        expect(dispatchedOperation).toBeUndefined();
        dispatchedOperation = operationId;
        return new Response(null, { status: 504 });
      }
      expect(path).toBe("/v1/reconcile");
      expect(operationId).toBe(dispatchedOperation);
      return Response.json(
        recovered
          ? {
              state: "settled",
              operation: {
                operationId,
                state: "settled",
                outcome: "completed",
                dispatchedAt: "2026-11-23T00:00:00.000Z",
                resultText: "Original answer",
              },
            }
          : { state: "pending" },
      );
    },
  });
  try {
    const config = { url: control.url, credentials };
    const input = { scope, step: "answer", route, messages };
    expect(await createManagedModel(config).complete(input)).toEqual({
      state: "reconciling",
    });
    recovered = true;
    expect(
      await createManagedModel(config).complete({
        ...input,
        beforeDispatch: async () => false,
      }),
    ).toEqual({ state: "not_authorized" });
    expect(await createManagedModel(config).complete(input)).toEqual({
      state: "completed",
      text: "Original answer",
    });
  } finally {
    await control.stop(true);
  }
});

test("a lost authorization at dispatch returns a refusal and reconciles the reservation", async () => {
  const paths: string[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/quote") return Response.json({ route, priceVersion });
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
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
    expect(
      await model.complete({ scope, step: "answer", route, messages }),
    ).toEqual({ state: "not_authorized" });
    expect(paths).toEqual(["/v1/reserve", "/v1/dispatch", "/v1/reconcile"]);
  } finally {
    await control.stop(true);
  }
});

test("a receipt for a dispatched or different operation cannot clear the Run hold", async () => {
  let dispatchedAt: string | null = "2026-11-23T00:00:00.000Z";
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { operationId } = await request.json();
      return Response.json({
        state: "released",
        operation: {
          operationId: dispatchedAt ? operationId : "a-different-operation",
          state: "released",
          outcome: dispatchedAt ? "unknown" : null,
          dispatchedAt,
          resultText: null,
        },
      });
    },
  });
  try {
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
    expect(
      await model.reconcileOutcome({ scope, step: "answer" }),
    ).toStrictEqual({
      state: "released",
      outcome: undefined,
    });
    dispatchedAt = null;
    expect(
      await model.reconcileOutcome({ scope, step: "answer" }),
    ).toStrictEqual({
      state: "released",
      outcome: undefined,
    });
  } finally {
    await control.stop(true);
  }
});

test("a Person without a bound credential cannot reserve or reconcile another account's credits", async () => {
  let requests = 0;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json({ route, priceVersion, state: "absent" });
    },
  });
  try {
    const model = createManagedModel({
      url: control.url,
      credentials,
    });
    const operation = {
      scope: {
        ...scope,
        personId: "other-person",
        source: "learning" as const,
      },
      step: "analysis",
    };
    expect(await model.complete({ ...operation, route, messages })).toEqual({
      state: "not_authorized",
    });
    await expect(model.reconcile(operation)).rejects.toThrow(
      "identity required",
    );
    expect(requests).toBe(0);
  } finally {
    await control.stop(true);
  }
});

test("retry uses the existing unsent permit after a lost reservation response", async () => {
  const ids: string[] = [];
  let reserved = false;
  let dispatches = 0;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      const path = new URL(request.url).pathname;
      if (path === "/api/billing/v1/quote")
        return Response.json({ route, priceVersion });
      const { operationId, permit } = await request.json();
      ids.push(operationId);
      if (path === "/api/billing/v1/reserve") {
        if (reserved)
          return Response.json({
            state: "existing",
            permit: "original-permit",
          });
        reserved = true;
        return new Response(null, { status: 502 });
      }
      if (path === "/api/billing/v1/dispatch") {
        expect(permit).toBe("original-permit");
        dispatches++;
        return Response.json({ state: "completed", text: "Answer" });
      }
      expect(path).toBe("/api/billing/v1/reconcile");
      return Response.json({ state: dispatches ? "settled" : "pending" });
    },
  });
  try {
    const config = { url: new URL("/api/billing/", control.url), credentials };
    const input = { scope, step: "answer", route, messages };
    expect(await createManagedModel(config).complete(input)).toEqual({
      state: "unavailable",
    });
    expect(dispatches).toBe(0);
    expect(await createManagedModel(config).complete(input)).toEqual({
      state: "completed",
      text: "Answer",
    });
    expect(dispatches).toBe(1);
    expect(new Set(ids).size).toBe(1);
  } finally {
    await control.stop(true);
  }
});
