import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { ApprovalRecord, ApprovalStore } from "../src/approvals/types";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
} from "../src/approvals/types";
import type { AppVariables } from "../src/auth/guards";
import {
  createCraftPermissionGate,
  isToolGated,
} from "../src/craft/approval-gate";
import { createInProcessApprovalSignals } from "../src/craft/approval-signals";
import {
  createCraftApprovalRoutes,
  openCraftApproval,
} from "../src/craft/approvals";
import { loadCraftConfig } from "../src/craft/config";
import { isBuildPacket } from "../src/craft/events/packets";
import { CraftSessionManager } from "../src/craft/manager";
import {
  type PodEventBus,
  type PodSubscription,
  SubscriberQueue,
} from "../src/craft/opencode/event-bus";
import { OpencodeServeClient } from "../src/craft/opencode/serve-client";
import { buildProviderOpencodeConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const gatedConfig = loadCraftConfig({
  OPENBOT_CRAFT_APPROVAL_GATED_TOOLS: "bash",
});
const fastConfig = loadCraftConfig({
  OPENBOT_CRAFT_APPROVAL_GATED_TOOLS: "bash",
  OPENBOT_CRAFT_APPROVAL_WAIT_TIMEOUT_SECONDS: "1",
});
const fastConfigPlain = loadCraftConfig({
  OPENBOT_CRAFT_APPROVAL_WAIT_TIMEOUT_SECONDS: "1",
});

const llm = {
  provider: "gw",
  modelName: "m1",
  apiKey: "k",
  apiBase: null,
  displayName: null,
  models: [
    {
      id: "m1",
      displayName: "M1",
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsReasoning: false,
      supportsToolCalls: true,
      supportsTemperature: false,
      supportsInterleavedReasoning: false,
    },
  ],
};

/** In-memory approval store mirroring the methods craft's surface touches. */
function fakeApprovals(initial: ApprovalRecord[] = []): ApprovalStore & {
  records: ApprovalRecord[];
} {
  const records = [...initial];
  return {
    records,
    async enabled() {
      return true;
    },
    async setEnabled() {},
    async open(action) {
      const record: ApprovalRecord = {
        id: crypto.randomUUID(),
        ownerUserId: action.actorId,
        action,
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      records.push(record);
      return record;
    },
    async get(owner, id) {
      const found = records.find(
        (record) => record.ownerUserId === owner && record.id === id,
      );
      if (!found) throw new ApprovalNotFoundError();
      return found;
    },
    async list(owner) {
      return records.filter((record) => record.ownerUserId === owner);
    },
    async decide(owner, id, decision) {
      const found = records.find(
        (record) => record.ownerUserId === owner && record.id === id,
      );
      if (!found) throw new ApprovalNotFoundError();
      if (found.status !== "pending")
        throw new ApprovalRefusedError("This request was already decided.");
      found.decision = decision;
      found.status = decision === "deny" ? "denied" : "approved";
      found.decidedAt = new Date();
      return found;
    },
    async consume() {
      return false;
    },
    async saveResult() {
      return false;
    },
    async finish() {},
    async rules() {
      return [];
    },
    async revoke() {},
  };
}

/** A PodEventBus stand-in: readiness faked, items pushed by the test. */
function fakeBus(): PodEventBus & { sub: PodSubscription } {
  let sub: PodSubscription | null = null;
  const bus = {
    streamReady: true,
    isClosed: () => false,
    subscribe(sessionId: string) {
      sub = { sessionId, queue: new SubscriberQueue(500) };
      return sub;
    },
    unsubscribe: () => undefined,
    parentOf: () => null,
    listChildren: () => [],
  } as unknown as PodEventBus;
  Object.defineProperty(bus, "sub", {
    get: () => {
      if (sub === null) throw new Error("bus not subscribed yet");
      return sub;
    },
  });
  return bus as PodEventBus & { sub: PodSubscription };
}

type Posted = { url: string; body: string };

/** fetch mock: everything answers 200; permission-answer POST bodies are recorded. */
function recordingFetch(posts: Posted[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/permissions/")) {
      posts.push({ url, body: String(init?.body ?? "") });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const waitFor = async (
  probe: () => boolean,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// ---------------------------------------------------------------------------
// ① gated tool → "ask" in the permissions template
// ---------------------------------------------------------------------------

describe("gated permissions template", () => {
  test("gated bash flips the catch-all to ask, keeps named denies", () => {
    const gated = buildProviderOpencodeConfig(llm, { gatedTools: ["bash"] })
      .permission as Record<string, Record<string, string>>;
    expect(gated.bash["*"]).toBe("ask");
    expect(gated.bash.rm).toBe("deny");
    expect(gated.bash.ssh).toBe("deny");
  });

  test("ungated (default) keeps the phase-1 all-allow posture", () => {
    const plain = buildProviderOpencodeConfig(llm).permission as Record<
      string,
      Record<string, string>
    >;
    expect(plain.bash["*"]).toBe("allow");
  });

  test("gated file tool flips its protected-rules catch-all; template-absent tool gets a bare ask", () => {
    const config = buildProviderOpencodeConfig(llm, {
      gatedTools: ["write", "task"],
    }).permission as Record<string, Record<string, string>>;
    expect(config.write["*"]).toBe("ask");
    expect(config.write["opencode.json"]).toBe("deny");
    expect(config.task).toBe("ask");
  });

  test("disabled wins over gated", () => {
    const config = buildProviderOpencodeConfig(llm, {
      disabledTools: ["bash"],
      gatedTools: ["bash"],
    }).permission as Record<string, unknown>;
    expect(config.bash).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// ② permission.asked routing (mocked answerPermission via recorded fetch)
// ---------------------------------------------------------------------------

describe("permission.asked routing", () => {
  test("gated ask: no immediate answer; decision wakes → once", async () => {
    const approvals = fakeApprovals();
    const signals = createInProcessApprovalSignals();
    const gate = createCraftPermissionGate({
      config: gatedConfig,
      approvals,
      signals,
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
    });
    const posts: Posted[] = [];
    const bus = fakeBus();
    const client = new OpencodeServeClient({
      baseUrl: "http://sandbox",
      config: gatedConfig,
      token: null,
      botId: "craft",
      eventBus: bus,
      fetchImpl: recordingFetch(posts),
    });

    const events: unknown[] = [];
    const runner = (async () => {
      for await (const event of client.sendMessage("ses_1", "hi", {
        directory: "/w",
        permissionGate: gate,
      })) {
        events.push(event);
      }
    })();

    // A beat for the prompt POST + subscription to settle before dispatching.
    await new Promise((resolve) => setTimeout(resolve, 50));

    bus.sub.queue.push({
      type: "permission.asked",
      properties: {
        sessionID: "ses_1",
        id: "perm_1",
        permission: "bash",
        patterns: ["npm install"],
      },
    });

    await waitFor(() => approvals.records.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Not answered yet — the decision hasn't landed.
    expect(
      posts.filter((post) => post.url.includes("/permissions/")),
    ).toHaveLength(0);
    // And the announce list carries the card.
    expect(await signals.drainAnnouncements("cs-sess")).toEqual([
      approvals.records[0].id,
    ]);

    // Decide + wake.
    const record = approvals.records[0];
    record.decision = "allow_once";
    record.status = "approved";
    await signals.sendWake(record.id, "allow_once");

    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_1")),
    );
    const answer = JSON.parse(
      posts.find((post) => post.url.includes("/permissions/perm_1"))!.body,
    );
    expect(answer).toEqual({ response: "once" });

    // The approval_requested packet rode the runner's stream.
    expect(
      events.some(
        (event) => isBuildPacket(event) && event.type === "approval_requested",
      ),
    ).toBe(true);

    // End the turn.
    bus.sub.queue.push({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await runner;
  });

  test("ungated ask: auto-allowed immediately (default posture)", async () => {
    const approvals = fakeApprovals();
    const signals = createInProcessApprovalSignals();
    const gate = createCraftPermissionGate({
      config: gatedConfig, // bash gated; read is not
      approvals,
      signals,
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
    });
    const posts: Posted[] = [];
    const bus = fakeBus();
    const client = new OpencodeServeClient({
      baseUrl: "http://sandbox",
      config: gatedConfig,
      token: null,
      botId: "craft",
      eventBus: bus,
      fetchImpl: recordingFetch(posts),
    });

    const runner = (async () => {
      for await (const _event of client.sendMessage("ses_1", "hi", {
        directory: "/w",
        permissionGate: gate,
      })) {
        void _event;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));

    bus.sub.queue.push({
      type: "permission.asked",
      properties: {
        sessionID: "ses_1",
        id: "perm_read",
        permission: "read",
        patterns: ["**"],
      },
    });
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/perm_read")),
    );
    expect(approvals.records).toHaveLength(0); // no approval row opened

    bus.sub.queue.push({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await runner;
  });

  test("no gate configured: every ask auto-allowed (phase-1 default)", async () => {
    const posts: Posted[] = [];
    const bus = fakeBus();
    const client = new OpencodeServeClient({
      baseUrl: "http://sandbox",
      config: loadCraftConfig({}),
      token: null,
      botId: "craft",
      eventBus: bus,
      fetchImpl: recordingFetch(posts),
    });
    const runner = (async () => {
      for await (const _event of client.sendMessage("ses_1", "hi", {
        directory: "/w",
      })) {
        void _event;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.sub.queue.push({
      type: "permission.asked",
      properties: { sessionID: "ses_1", id: "p9", permission: "bash" },
    });
    await waitFor(() =>
      posts.some((post) => post.url.includes("/permissions/p9")),
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "once" });
    bus.sub.queue.push({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await runner;
  });
});

// ---------------------------------------------------------------------------
// ③ timeout → auto reject + derived EXPIRED
// ---------------------------------------------------------------------------

describe("approval wait timeout", () => {
  test("no decision inside the window → reject answered upstream, row ages out of live", async () => {
    const approvals = fakeApprovals();
    const signals = createInProcessApprovalSignals();
    const gate = createCraftPermissionGate({
      config: fastConfig, // 1s window
      approvals,
      signals,
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
    });
    const posts: Posted[] = [];
    const bus = fakeBus();
    const client = new OpencodeServeClient({
      baseUrl: "http://sandbox",
      config: fastConfig,
      token: null,
      botId: "craft",
      eventBus: bus,
      fetchImpl: recordingFetch(posts),
    });

    const runner = (async () => {
      for await (const _event of client.sendMessage("ses_1", "hi", {
        directory: "/w",
        permissionGate: gate,
      })) {
        void _event;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));

    bus.sub.queue.push({
      type: "permission.asked",
      properties: {
        sessionID: "ses_1",
        id: "perm_slow",
        permission: "bash",
        patterns: ["rm -rf /"],
      },
    });
    await waitFor(() => approvals.records.length === 1);
    expect(posts).toHaveLength(0); // nothing answered yet

    await waitFor(
      () => posts.some((post) => post.url.includes("/permissions/perm_slow")),
      8000,
    );
    expect(JSON.parse(posts[0].body)).toEqual({ response: "reject" });
    // EXPIRED is derived: the row stays pending (shared CHECK has no expired
    // value) but the live read drops it once the window passes.
    expect(approvals.records[0].status).toBe("pending");

    bus.sub.queue.push({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    await runner;
  });

  test("gate.poll reports expired only past the window, decision only when recorded", async () => {
    const approvals = fakeApprovals();
    const signals = createInProcessApprovalSignals();
    const gate = createCraftPermissionGate({
      config: loadCraftConfig({
        OPENBOT_CRAFT_APPROVAL_WAIT_TIMEOUT_SECONDS: "0",
      }),
      approvals,
      signals,
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
    });
    const record = await openCraftApproval(approvals, {
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
      approvalId: "perm_x",
      toolRef: "bash",
      effect: "execute",
      scope: "*",
      args: {},
    });
    // Window 0 → aged immediately, row pending → expired.
    expect(await gate.poll(record.id)).toBe("expired");

    // A decided row with a wake reads back its decision.
    record.decision = "deny";
    record.status = "denied";
    await signals.sendWake(record.id, "deny");
    expect(await gate.poll(record.id)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// ④ decide endpoint → wake
// ---------------------------------------------------------------------------

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

const fakeStore = (overrides: Partial<CraftStore> = {}): CraftStore =>
  overrides as unknown as CraftStore;

function sessionRow(): CraftSessionRow {
  return {
    id: "cs-sess",
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

describe("decide endpoint wakes the waiter", () => {
  test("decision lands → wake carries it; idempotent replay; conflict 409", async () => {
    const approvals = fakeApprovals();
    const signals = createInProcessApprovalSignals();
    const app = createCraftApprovalRoutes(fakeRequireUser(), {
      config: fastConfigPlain,
      store: fakeStore({ getSession: async () => sessionRow() }),
      approvals,
      signals,
    });

    const record = await openCraftApproval(approvals, {
      sessionId: "cs-sess",
      userId: "u1",
      botId: "craft",
      approvalId: "perm_w",
      toolRef: "bash",
      effect: "execute",
      scope: "*",
      args: {},
    });

    const decision = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(decision.status).toBe(200);

    // The parked waiter sees the decision through the wake signal.
    expect(await signals.takeWake(record.id)).toBe("allow_once");

    // Same decision again → idempotent; different → conflict.
    const replay = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(replay.status).toBe(200);
    const conflict = await app.request(`/approvals/${record.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(conflict.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// ⑤ SSE announce merge (attach stream)
// ---------------------------------------------------------------------------

describe("SSE announce merge", () => {
  test("subscribeToExistingSessionEvents interleaves approval_requested packets", async () => {
    const signals = createInProcessApprovalSignals();
    await signals.announce("cs-sess", "appr-1");
    await signals.announce("cs-sess", "appr-2");

    const bus = fakeBus();
    const gateway: SandboxGateway = {
      eventBusFor: () => bus,
      serveClientFor: () =>
        ({}) as unknown as ReturnType<SandboxGateway["serveClientFor"]>,
    } as unknown as SandboxGateway;
    const manager = new CraftSessionManager({
      config: loadCraftConfig({}),
      store: fakeStore(),
      gateway,
      llmConfigFor: async () => llm,
      botIdFor: async () => "craft",
    });

    const stream = manager.subscribeToExistingSessionEvents({
      session: sessionRow(),
      botId: "craft",
      keepaliveSeconds: 3600,
      announceDrain: () => signals.drainAnnouncements("cs-sess"),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    const packets = [first.value, second.value];
    expect(
      packets.map((packet) =>
        isBuildPacket(packet) && packet.type === "approval_requested"
          ? packet.approval_id
          : null,
      ),
    ).toEqual(["appr-1", "appr-2"]);
    expect(
      packets.every(
        (packet) =>
          isBuildPacket(packet) &&
          packet.type === "approval_requested" &&
          packet.session_id === "cs-sess",
      ),
    ).toBe(true);
    // Drained — a second pass sees nothing (announce once, like onyx's BLPOP).
    expect(await signals.drainAnnouncements("cs-sess")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// misc: isToolGated + unused-import guards
// ---------------------------------------------------------------------------

describe("isToolGated", () => {
  test("exact match only", () => {
    expect(isToolGated("bash", ["bash", "write"])).toBe(true);
    expect(isToolGated("read", ["bash", "write"])).toBe(false);
    expect(isToolGated(null, ["bash"])).toBe(false);
  });
});
