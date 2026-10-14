import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The §3 lease matrix, route-level half.
 *
 * The fake computer below is the contract this server must hold: the take carries the signed-in
 * actor's id (never a client-supplied one), human input carries its sequence number, a revocation is
 * forwarded and audited with the lease it ended, and a refusal the computer gives reaches the caller
 * as the same status with nothing delivered past it. The state-machine half, which decides these
 * answers for real, lives in agent-computer's suite.
 */

type AuditRow = {
  eventType: string;
  payload: Record<string, unknown>;
};

/**
 * A computer that keeps just enough lease state to answer the way the real one does: one lease at a
 * time, held by the user who took it, revocable, with a monotonic input sequence and a delivery
 * count that only moves when input is actually admitted.
 */
function fakeComputer() {
  const state: {
    holder: "bot" | "human";
    lease?: { id: string; status: string; takenBy?: string };
    lastSeq?: number;
  } = { holder: "bot" };
  const deliveries: Record<string, unknown>[] = [];
  const requests: { path: string; body: unknown }[] = [];
  let minted = 0;
  const control = () => ({
    holder: state.holder,
    since: "2026-10-13T00:00:00Z",
    requested: state.lease?.status === "waiting",
    transitioning: false,
    resumeSnapshotRequired: false,
    ...(state.lease ? { request: { ...state.lease } } : {}),
  });
  const active = () =>
    state.lease?.status === "waiting" || state.lease?.status === "taken";
  function answer(path: string, body: Record<string, unknown> | null) {
    switch (path) {
      case "/control/request": {
        if (state.holder === "human" || active())
          return { status: 200, body: control() };
        minted += 1;
        state.lease = { id: `lease-${minted}`, status: "waiting" };
        return { status: 200, body: control() };
      }
      case "/control/take": {
        if (body?.requestId !== state.lease?.id)
          return {
            status: 409,
            body: { error: "Old request", controlRequestError: true },
          };
        if (
          state.holder === "human" &&
          state.lease.status === "taken" &&
          state.lease.takenBy !== undefined &&
          body?.userId !== undefined &&
          state.lease.takenBy !== body.userId
        )
          return {
            status: 409,
            body: {
              error: "Another person already holds this control request.",
              controlRequestError: true,
            },
          };
        if (state.lease.status !== "waiting") {
          // The holder rejoining their own held lease is the idempotent join, not a refusal.
          if (state.lease.status === "taken" && state.holder === "human")
            return { status: 200, body: control() };
          return {
            status: 409,
            body: { error: "Old request", controlRequestError: true },
          };
        }
        state.lease.status = "taken";
        if (body?.userId !== undefined) state.lease.takenBy = body.userId;
        state.holder = "human";
        return { status: 200, body: control() };
      }
      case "/control/release": {
        if (body?.requestId !== state.lease?.id || state.holder !== "human")
          return { status: 409, body: { error: "Not held." } };
        state.holder = "bot";
        if (state.lease.status === "taken") state.lease.status = "completed";
        return { status: 200, body: control() };
      }
      case "/control/revoke": {
        if (active()) state.lease.status = "refused";
        state.holder = "bot";
        return { status: 200, body: control() };
      }
      default: {
        if (path.startsWith("/human/")) {
          if (state.holder !== "human")
            return {
              status: 409,
              body: {
                error: "Take control before driving the computer yourself.",
              },
            };
          if (
            typeof body?.seq === "number" &&
            state.lastSeq !== undefined &&
            body.seq <= state.lastSeq
          )
            return {
              status: 409,
              body: { error: "That input is stale and was not delivered." },
            };
          if (typeof body?.seq === "number") state.lastSeq = body.seq;
          deliveries.push(body ?? {});
          return {
            status: 200,
            body: { action: "human_click", url: "https://example.com" },
          };
        }
        return { status: 200, body: control() };
      }
    }
  }
  return {
    state,
    deliveries,
    requests,
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: `${url.pathname}${url.search}`, body });
        const { status, body: reply } = answer(url.pathname, body);
        return Response.json(reply, { status });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  };
}

function fixture(initialActor = "user-1") {
  const computer = fakeComputer();
  const auditRows: AuditRow[] = [];
  let actorId = initialActor;
  const provider: ComputerProvider = {
    name: "fixture",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    // The fake computer answers, so the fleet says it runs: the revoke route asks the list
    // before the lease precisely so a NOT-running computer is answered as the no-op it is
    // (nothing to revoke, and asking would /ensure — start one to be told so).
    list: async () => [{ botId: "bot-1", status: "running" as const }],
  };
  const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };
  const gateway = createComputerGateway({
    provider,
    fetchImpl: computer.fetch,
    policy: () => policy,
    auditStore: { insert: async (row) => auditRows.push(row) },
  });
  const policyStore: PolicyStore = {
    get: () => policy,
    set: async () => {},
    reset: async () => {},
    load: async () => "configuration",
    refresh: async () => {},
  };
  const user: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@openbot.test`,
      role: "user",
    });
    await next();
  };
  const routes = createComputerRoutes(
    gateway,
    policyStore,
    user,
    async () => true,
  );
  const post = (path: string, body: unknown) =>
    routes.request(`http://app.test/bot-1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    setActor: (id: string) => (actorId = id),
    auditRows,
    computer,
    post,
  };
}

/** Request help and take it as the fixture's actor, returning the lease id. */
async function heldLease(
  post: (path: string, body: unknown) => Promise<Response>,
) {
  const request = await post("/control/request", {
    reason: "Sign in",
    toolCallId: "call-1",
  });
  const lease = ((await request.json()) as { request: { id: string } }).request
    .id;
  expect((await post("/control/take", { requestId: lease })).status).toBe(200);
  return lease;
}

describe("§3 lease matrix — the server routes", () => {
  test("take carries the signed-in actor's id; a client-supplied one does not travel", async () => {
    const { post, computer } = fixture("user-1");
    const lease = await heldLease(post);
    await post("/control/take", { requestId: lease, userId: "spoofed-user" });
    const sent = computer.requests.find((r) => r.path === "/control/take");
    // The actor who is authenticated, not the id the body offered.
    expect(sent?.body).toEqual({ requestId: lease, userId: "user-1" });
  });

  test("a second user's take of the held lease reaches the caller as the refusal it is", async () => {
    const { post, setActor } = fixture("user-1");
    const lease = await heldLease(post);
    setActor("user-b");
    const refused = await post("/control/take", { requestId: lease });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ controlRequestError: true });
    // The holder rejoining is not a refusal.
    setActor("user-1");
    expect((await post("/control/take", { requestId: lease })).status).toBe(
      200,
    );
  });

  test("human input carries its sequence, and a malformed one never travels", async () => {
    const { post, computer } = fixture("user-1");
    await heldLease(post);
    const delivered = await post("/human/click", { x: 10, y: 20, seq: 4 });
    expect(delivered.status).toBe(200);
    const sent = computer.requests.find((r) => r.path === "/human/click");
    expect(sent?.body).toMatchObject({ seq: 4 });
    for (const seq of [1.5, 0, -2, "4", null])
      expect((await post("/human/click", { x: 1, y: 2, seq })).status).toBe(
        400,
      );
    expect(computer.deliveries).toHaveLength(1);
  });

  test("stale and lease-less input is refused and delivers nothing", async () => {
    const { post, computer } = fixture("user-1");
    // No lease at all.
    const early = await post("/human/click", { x: 1, y: 2, seq: 1 });
    expect(early.status).toBe(409);
    expect(computer.deliveries).toHaveLength(0);
    await heldLease(post);
    expect((await post("/human/click", { x: 1, y: 2, seq: 5 })).status).toBe(
      200,
    );
    // The replay of 5 is stale and is not delivered.
    expect((await post("/human/click", { x: 1, y: 2, seq: 5 })).status).toBe(
      409,
    );
    expect(computer.deliveries).toHaveLength(1);
  });

  test("revocation is forwarded, audited with actor, Bot and lease, and later input delivers nothing", async () => {
    const { post, computer, auditRows } = fixture("user-1");
    const lease = await heldLease(post);
    const revoked = await post("/control/revoke", {
      reason: "Signed out elsewhere.",
    });
    expect(revoked.status).toBe(200);
    expect(
      computer.requests.find((r) => r.path === "/control/revoke")?.body,
    ).toEqual({
      reason: "Signed out elsewhere.",
      // The lease this authorization was read from, sent as the computer's precondition: a
      // wheel that changed hands between the read and the revoke is refused, not ended.
      requestId: "lease-1",
      takenBy: "user-1",
    });
    const late = await post("/human/click", { x: 1, y: 2, seq: 9 });
    expect(late.status).toBe(409);
    expect(computer.deliveries).toHaveLength(0);
    const revocation = auditRows.find(
      (row) => row.eventType === "computer.control_revoked",
    );
    expect(revocation?.payload).toMatchObject({
      bot: "bot-1",
      actor: "user-1",
      lease,
    });
    // The claim names the lease it was about.
    expect(
      auditRows.find((row) => row.eventType === "computer.control_taken")
        ?.payload,
    ).toMatchObject({ lease });
  });

  test("release then a fresh lease works for the next person", async () => {
    const { post, auditRows } = fixture("user-1");
    const lease = await heldLease(post);
    expect((await post("/control/release", { requestId: lease })).status).toBe(
      200,
    );
    const second = await post("/control/request", {
      reason: "Next",
      toolCallId: "call-2",
    });
    expect(second.status).toBe(200);
    // The released lease is not a way back in.
    expect((await post("/control/take", { requestId: lease })).status).toBe(
      409,
    );
    // The release names the lease it ended.
    expect(
      auditRows.find((row) => row.eventType === "computer.control_released")
        ?.payload,
    ).toMatchObject({ lease });
  });
});
