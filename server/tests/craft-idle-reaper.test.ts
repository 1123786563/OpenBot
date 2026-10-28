import {
  afterEach,
  describe,
  expect,
  jest,
  test,
} from "../../tests/support/bun-test-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import { createSessionRoutes } from "../src/craft/session-routes";
import { startCraftIdleReaper } from "../src/craft/snapshot";
import type { ObjectStore } from "../src/craft/storage/object-store";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

/**
 * The idle reaper's sweep decisions and the sandbox-status contract. Scheduling is pinned with
 * bun's fake timers; every sweep decision is pinned through sweepOnce (the interval's own body)
 * against fakes whose calls are recorded, so each test names the exact order it asserts:
 * active-turn check → snapshot → guarded idle flip, fail-closed at each leg.

 * The reaper's release divergence (no sandbox termination in the agent-sandbox topology) is
 * asserted implicitly everywhere: no test can observe a sandbox call other than the snapshot.
 */
const fakeGateway = (overrides: Partial<SandboxGateway> = {}): SandboxGateway =>
  overrides as unknown as SandboxGateway;

const fakeStore = (overrides: Partial<CraftStore> = {}): CraftStore =>
  overrides as unknown as CraftStore;

function memStore(): ObjectStore & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    async put(key, bytes) {
      values.set(key, bytes);
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async has(key) {
      return values.has(key);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

const bytes = new TextEncoder().encode("archive-bytes");

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
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
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

/** Records every leg of one candidate's sweep, so tests assert the order and the skip reasons. */
function recordingStore(session: CraftSessionRow) {
  const calls: string[] = [];
  const store = fakeStore({
    listIdleSessions: async () => {
      calls.push("list");
      return [session];
    },
    createSnapshot: async () => {
      calls.push("snapshot");
      return {
        id: "csn-1",
        sessionId: session.id,
        storagePath: "sandbox-snapshots/craft/csn-1.tar.gz",
        sizeBytes: bytes.byteLength,
        createdAt: new Date(),
      };
    },
    markSessionIdleIfStillIdle: async () => {
      calls.push("flip");
      return true;
    },
  });
  return { store, calls };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("reaper configuration", () => {
  test("the reaper gate and interval default to on / 60s and read their env", () => {
    const defaults = loadCraftConfig({});
    expect(defaults.idleReaperEnabled).toBe(true);
    expect(defaults.idleReaperIntervalSeconds).toBe(60);
    expect(defaults.sandboxIdleTimeoutSeconds).toBe(3600);

    const off = loadCraftConfig({ OPENBOT_CRAFT_IDLE_REAPER_ENABLED: "false" });
    expect(off.idleReaperEnabled).toBe(false);

    const tuned = loadCraftConfig({
      OPENBOT_CRAFT_IDLE_REAPER_INTERVAL_SECONDS: "120",
    });
    expect(tuned.idleReaperIntervalSeconds).toBe(120);
  });
});

describe("reaper scheduling (fake clock)", () => {
  const sweepCountingStore = () => {
    let sweeps = 0;
    const store = fakeStore({
      listIdleSessions: async () => {
        sweeps += 1; // incremented synchronously, before the sweep's first await settles
        return [];
      },
    });
    return { store, count: () => sweeps };
  };

  test("sweeps at the configured 60s cadence", () => {
    const config = loadCraftConfig({});
    const { store, count } = sweepCountingStore();
    jest.useFakeTimers();
    const reaper = startCraftIdleReaper(
      { config, store, gateway: fakeGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft" },
    );
    jest.advanceTimersByTime(180_000);
    expect(count()).toBe(3); // 60s, 120s, 180s
    reaper.stop();
  });

  test("never sweeps faster than the 30s floor", () => {
    const config = loadCraftConfig({
      OPENBOT_CRAFT_IDLE_REAPER_INTERVAL_SECONDS: "1",
    });
    const { store, count } = sweepCountingStore();
    jest.useFakeTimers();
    const reaper = startCraftIdleReaper(
      { config, store, gateway: fakeGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft" },
    );
    jest.advanceTimersByTime(90_000);
    expect(count()).toBe(3); // floored to 30s, not the configured 1s
    reaper.stop();
  });

  test("stop() clears the interval", () => {
    const config = loadCraftConfig({});
    const { store, count } = sweepCountingStore();
    jest.useFakeTimers();
    const reaper = startCraftIdleReaper(
      { config, store, gateway: fakeGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft" },
    );
    jest.advanceTimersByTime(60_000);
    const atStop = count();
    reaper.stop();
    jest.advanceTimersByTime(600_000);
    expect(count()).toBe(atStop);
  });
});

describe("idle determination boundary", () => {
  test("the sweep's cutoff is exactly now - sandboxIdleTimeoutSeconds", async () => {
    const config = loadCraftConfig({});
    let captured: Date | undefined;
    const store = fakeStore({
      listIdleSessions: async (before) => {
        captured = before;
        return [];
      },
    });
    jest.useFakeTimers();
    const frozen = new Date("2026-01-01T12:00:00Z");
    jest.setSystemTime(frozen);
    const reaper = startCraftIdleReaper(
      { config, store, gateway: fakeGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft" },
    );
    await reaper.sweepOnce();
    reaper.stop();
    expect(captured).toEqual(new Date(frozen.getTime() - 3600 * 1000));
  });
});

describe("sweep decisions (manual tick)", () => {
  const config = loadCraftConfig({});
  const archiveGateway = () =>
    fakeGateway({ snapshotArchiveFor: async () => bytes });

  test("happy path: turn check → snapshot → guarded flip", async () => {
    const { store, calls } = recordingStore(sessionRow());
    const reaper = startCraftIdleReaper(
      { config, store, gateway: archiveGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft", hasActiveTurn: async () => false },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(1);
    expect(calls).toEqual(["list", "snapshot", "flip"]);
  });

  test("a live turn keeps the session awake, before any snapshot I/O", async () => {
    const { store, calls } = recordingStore(sessionRow());
    const reaper = startCraftIdleReaper(
      { config, store, gateway: archiveGateway(), objectStore: memStore() },
      { botIdFor: async () => "craft", hasActiveTurn: async () => true },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(0);
    expect(calls).toEqual(["list"]);
  });

  test("an errored turn check fails closed: the session stays active", async () => {
    const { store, calls } = recordingStore(sessionRow());
    const reaper = startCraftIdleReaper(
      { config, store, gateway: archiveGateway(), objectStore: memStore() },
      {
        botIdFor: async () => "craft",
        hasActiveTurn: async () => {
          throw new Error("redis down");
        },
      },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(0);
    expect(calls).toEqual(["list"]);
  });

  test("an errored botIdFor skips only that session, not the rest of the sweep", async () => {
    const calls: string[] = [];
    const store = fakeStore({
      listIdleSessions: async () => [
        sessionRow({ id: "cs-boom" }),
        sessionRow({ id: "cs-fine" }),
      ],
      createSnapshot: async () => {
        calls.push("snapshot");
        return {
          id: "csn-1",
          sessionId: "cs-fine",
          storagePath: "sandbox-snapshots/craft/csn-1.tar.gz",
          sizeBytes: bytes.byteLength,
          createdAt: new Date(),
        };
      },
      markSessionIdleIfStillIdle: async () => {
        calls.push("flip");
        return true;
      },
    });
    const reaper = startCraftIdleReaper(
      { config, store, gateway: archiveGateway(), objectStore: memStore() },
      {
        botIdFor: async (sessionId) => {
          if (sessionId === "cs-boom") throw new Error("bot resolver down");
          return "craft";
        },
      },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(1); // the sweep survived the first session's resolver failure
    expect(calls).toEqual(["snapshot", "flip"]); // ...and slept the second
  });

  test("a failed snapshot fails closed: no idle flip, retry next sweep", async () => {
    const { store, calls } = recordingStore(sessionRow());
    let archiveAttempts = 0;
    const gateway = fakeGateway({
      snapshotArchiveFor: async () => {
        archiveAttempts += 1;
        return null; // the sandbox produced nothing — takeSnapshot throws before any row
      },
    });
    const reaper = startCraftIdleReaper(
      { config, store, gateway, objectStore: memStore() },
      { botIdFor: async () => "craft" },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(0);
    expect(archiveAttempts).toBe(1); // the snapshot was attempted
    expect(calls).toEqual(["list"]); // ...and nothing past it — no idle flip, no row
  });

  test("a refused CAS (activity landed mid-sweep) keeps the session awake", async () => {
    const objectStore = memStore();
    const store = fakeStore({
      listIdleSessions: async () => [sessionRow()],
      createSnapshot: async () => ({
        id: "csn-1",
        sessionId: "cs-sess",
        storagePath: "sandbox-snapshots/craft/csn-1.tar.gz",
        sizeBytes: bytes.byteLength,
        createdAt: new Date(),
      }),
      // The user touched the session between the list read and the flip.
      markSessionIdleIfStillIdle: async () => false,
    });
    const reaper = startCraftIdleReaper(
      { config, store, gateway: archiveGateway(), objectStore },
      { botIdFor: async () => "craft" },
    );
    const slept = await reaper.sweepOnce();
    reaper.stop();
    expect(slept).toBe(0);
    // The snapshot row stays — a newer backup is harmless; only the flip was refused.
    expect(objectStore.values.size).toBe(1);
  });
});

// ── GET /sessions/:sessionId/sandbox-status ───────────────────────────────────

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

const routesWith = (input: {
  session?: CraftSessionRow;
  gateway?: Partial<SandboxGateway>;
  botIdFor?: (sessionId: string) => Promise<string | null>;
}) => {
  const gateway = fakeGateway({
    healthCheck: async () => true,
    ...input.gateway,
  });
  // Whole-object cast, the suite's idiom: only the legs this endpoint reaches are real, and
  // getSession deliberately throws so a future edit that reaches for the activity-bumping read
  // fails this suite instead of silently resetting the reaper's idle clock every 30s.
  const deps = {
    db: {},
    config: loadCraftConfig({}),
    store: fakeStore({
      findSession: async (id: string, userId: string) =>
        input.session && id === input.session.id && userId === "u1"
          ? input.session
          : undefined,
      async getSession() {
        throw new Error("sandbox-status must not use getSession");
      },
    }),
    manager: null,
    locks: null,
    objectStore: null,
    gateway,
    botIdFor: input.botIdFor ?? (async () => "craft"),
    userNameFor: async () => null,
  } as unknown as Parameters<typeof createSessionRoutes>[1];
  return createSessionRoutes(fakeRequireUser(), deps);
};

const statusOf = async (
  app: ReturnType<typeof routesWith>,
  sessionId = "cs-sess",
) => {
  const response = await app.request(`/sessions/${sessionId}/sandbox-status`);
  return { code: response.status, body: await response.json() };
};

describe("GET /sessions/:sessionId/sandbox-status", () => {
  test("an active session on a reachable gateway is running", async () => {
    const app = routesWith({ session: sessionRow() });
    expect(await statusOf(app)).toEqual({
      code: 200,
      body: { status: "running" },
    });
  });

  test("an active session on an unreachable gateway is provisioning (cold start, not failed)", async () => {
    const app = routesWith({
      session: sessionRow(),
      gateway: { healthCheck: async () => false },
    });
    expect(await statusOf(app)).toEqual({
      code: 200,
      body: { status: "provisioning" },
    });
  });

  /** A gateway whose probe counts itself; the no-probe assertions below read the counter. */
  const probingGateway = (): Partial<SandboxGateway> & {
    probes: () => number;
  } => {
    let probed = 0;
    return {
      probes: () => probed,
      healthCheck: async () => {
        probed += 1;
        return true;
      },
    };
  };

  test("an initializing session is provisioning without probing the gateway", async () => {
    const probe = probingGateway();
    const app = routesWith({
      session: sessionRow({ status: "initializing" }),
      gateway: probe,
    });
    expect(await statusOf(app)).toEqual({
      code: 200,
      body: { status: "provisioning" },
    });
    expect(probe.probes()).toBe(0);
  });

  test("a slept session is sleeping without probing the gateway", async () => {
    const probe = probingGateway();
    const app = routesWith({
      session: sessionRow({ status: "idle" }),
      gateway: probe,
    });
    expect(await statusOf(app)).toEqual({
      code: 200,
      body: { status: "sleeping" },
    });
    expect(probe.probes()).toBe(0);
  });

  test("a failed session is failed without probing the gateway", async () => {
    const probe = probingGateway();
    const app = routesWith({
      session: sessionRow({ status: "failed" }),
      gateway: probe,
    });
    expect(await statusOf(app)).toEqual({
      code: 200,
      body: { status: "failed" },
    });
    expect(probe.probes()).toBe(0);
  });

  test("a session whose Bot is not configured answers null (no sandbox record)", async () => {
    const app = routesWith({
      session: sessionRow(),
      botIdFor: async () => null,
    });
    expect(await statusOf(app)).toEqual({ code: 200, body: { status: null } });
  });

  test("another user's session is a 404, and ownership is checked without the bump", async () => {
    const app = routesWith({ session: sessionRow() });
    expect(await statusOf(app, "cs-other")).toEqual({
      code: 404,
      body: { error: "Session not found" },
    });
  });
});
