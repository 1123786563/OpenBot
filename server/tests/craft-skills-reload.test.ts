import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import { CraftSessionManager } from "../src/craft/manager";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import { createSessionRoutes } from "../src/craft/session-routes";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import type { InteractiveTurn, TurnStateStore } from "../src/craft/turn-state";

/**
 * The skills/reload endpoint's contract — onyx session/api.py's
 * `POST /sessions/{id}/skills/reload` → `SessionSkillsStateResponse`, plus the
 * `skills_stale` field of the session responses now DERIVED through
 * sessionRuntimeStale (the managed-content seam), never a hardcoded false.
 *
 * The deliberate divergence from onyx is pinned here too: onyx short-circuits
 * when the session is not stale; this port runs regenerate + dispose
 * unconditionally (an explicit refresh — otherwise, with no managed-content
 * push domain, the endpoint could never do anything).
 */

const SESSION_ID = "cs-reload";
const USER_ID = "u1";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;

const config = loadCraftConfig({});

const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
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
    ...overrides,
  };
}

const llmConfigFor = async () => llm;

function memoryGateway(input: { failWrites?: boolean } = {}) {
  const files = new Map<string, string>();
  const disposals: string[] = [];
  const writeFile = async (path: string, content: string) => {
    if (input.failWrites) throw new Error("sandbox down");
    files.set(path, content);
  };
  const gateway = {
    fileApiFor: () => ({
      async listFiles(path: string) {
        return [...files.keys()].filter((key) => key.startsWith(`${path}/`));
      },
      writeFile,
      async writeFileBytes() {},
      async deletePath() {
        return false;
      },
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes() {
        return null;
      },
    }),
    workspaceApiFor: () => ({
      writeFile,
      mkdir: async () => undefined,
    }),
    serveClientFor: ({ directory }: { directory: string }) => ({
      disposeInstance: async () => {
        disposals.push(directory);
      },
    }),
  } as unknown as SandboxGateway;
  return { gateway, files, disposals };
}

type Hashes = { skillsHash: string | null; mcpConfigHash: string | null };

function harness(input: {
  row?: CraftSessionRow | null;
  hashesFor?: (session: CraftSessionRow) => Promise<Hashes>;
  activeTurn?: InteractiveTurn | null;
  failTurnState?: boolean;
  failWrites?: boolean;
}) {
  const row = input.row === undefined ? sessionRow() : input.row;
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const store = {
    async getSession(id: string, userId: string) {
      return row && id === SESSION_ID && userId === USER_ID
        ? { ...row }
        : undefined;
    },
    async updateSession(id: string, patch: Record<string, unknown>) {
      updates.push({ id, patch });
      return { ...row, ...patch } as CraftSessionRow;
    },
    async listUserSessions(userId: string) {
      return row && userId === USER_ID ? [row] : [];
    },
  } as unknown as CraftStore;
  const sandbox = memoryGateway({ failWrites: input.failWrites });
  const manager = new CraftSessionManager({
    config,
    store,
    gateway: sandbox.gateway,
    llmConfigFor,
    botIdFor: async () => "craft",
    managedContentHashesFor: input.hashesFor,
  });
  const turnState = {
    mode: "memory",
    async getActiveTurn() {
      if (input.failTurnState) throw new Error("redis down");
      return input.activeTurn ?? null;
    },
  } as unknown as TurnStateStore;
  const app = createSessionRoutes(fakeRequireUser(), {
    db: {} as never,
    config,
    store,
    manager,
    locks: {} as never,
    gateway: sandbox.gateway,
    objectStore: {} as never,
    botIdFor: async () => "craft",
    userNameFor: async () => "Ada",
    turnState,
    managedContentHashesFor: input.hashesFor,
  });
  return { app, ...sandbox, updates };
}

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: USER_ID,
      email: "u1@example.com",
      role: "user",
    });
    await next();
  };
}

// ── POST /sessions/:sessionId/skills/reload ───────────────────────────────────

describe("POST /sessions/:id/skills/reload", () => {
  test("unknown session answers 404", async () => {
    const { app } = harness({ row: null });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(404);
  });

  test("regenerates opencode.json + AGENTS.md + the plugin, disposes, acks hashes, answers false", async () => {
    const { app, files, disposals, updates } = harness({});
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills_stale: false });

    // Regenerate: the rewritten config carries the turn-budget plugin entry...
    const opencodeJson = files.get(`${DIRECTORY}/opencode.json`);
    expect(opencodeJson).toBeDefined();
    expect(JSON.parse(opencodeJson!).plugin).toEqual([
      "./.opencode/plugin/turn-budget.ts",
    ]);
    // ...the plugin file itself rides along (onyx bakes it into the image; this
    // port ships it in the workspace)...
    expect(files.get(`${DIRECTORY}/.opencode/plugin/turn-budget.ts`)).toContain(
      "[Onyx turn budget]",
    );
    // ...and AGENTS.md is rewritten.
    expect(files.get(`${DIRECTORY}/AGENTS.md`)).toBeDefined();
    // The running instance is disposed so a fresh one re-reads the config.
    expect(disposals).toEqual([DIRECTORY]);
    // The row acknowledges the (null) current hashes.
    expect(updates).toEqual([
      {
        id: SESSION_ID,
        patch: { skillsHash: null, mcpConfigHash: null },
      },
    ]);
  });

  test("a live managed-content push acks its hashes and converges the stale flag", async () => {
    const { app, updates } = harness({
      row: sessionRow({ skillsHash: "old", mcpConfigHash: "old-mcp" }),
      hashesFor: async () => ({
        skillsHash: "new",
        mcpConfigHash: "new-mcp",
      }),
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    // The reload acked the current hashes, so the re-derived flag is false.
    expect(await response.json()).toEqual({ skills_stale: false });
    expect(updates).toEqual([
      {
        id: SESSION_ID,
        patch: { skillsHash: "new", mcpConfigHash: "new-mcp" },
      },
    ]);
  });

  test("a live turn answers 409 (onyx's prompt-slot conflict)", async () => {
    const { app } = harness({
      activeTurn: {
        turnId: "turn-1",
        sessionId: SESSION_ID,
        userId: USER_ID,
        prompt: "busy",
        status: "RUNNING",
        turnIndex: 0,
        attachments: [],
        lastHeartbeatAt: new Date().toISOString(),
        errorDetail: null,
        runnerId: "r1",
        reclaimed: false,
      },
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "Wait for the current turn",
    );
  });

  test("a turn-state outage answers 503, fail-closed like onyx's slot", async () => {
    const { app, updates } = harness({ failTurnState: true });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(503);
    expect(updates).toEqual([]); // refused before any regenerate/ack
  });

  test("a sandbox failure answers 502 without touching the row", async () => {
    const { app, updates } = harness({ failWrites: true });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(502);
    expect(updates).toEqual([]);
  });
});

// ── skills_stale derivation on the session responses ─────────────────────────

describe("session response skills_stale (derived, not hardcoded)", () => {
  test("default wiring (no managed content) derives false through the predicate", async () => {
    const { app } = harness({});
    const response = await app.request(`/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { skills_stale: boolean }).skills_stale,
    ).toBe(false);
  });

  test("a runtime predating a live skills push derives true", async () => {
    const { app } = harness({
      row: sessionRow({ skillsHash: "old" }),
      hashesFor: async () => ({ skillsHash: "new", mcpConfigHash: null }),
    });
    const response = await app.request(`/sessions/${SESSION_ID}`);
    expect(
      ((await response.json()) as { skills_stale: boolean }).skills_stale,
    ).toBe(true);
  });

  test("the list endpoint derives per session too", async () => {
    const { app } = harness({
      row: sessionRow({ skillsHash: "old" }),
      hashesFor: async () => ({ skillsHash: "new", mcpConfigHash: null }),
    });
    const response = await app.request(`/sessions`);
    const body = (await response.json()) as {
      sessions: Array<{ skills_stale: boolean }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].skills_stale).toBe(true);
  });

  test("only an active interactive runtime with an opencode id can be stale", async () => {
    // Same mismatched hashes, but the session predates its runtime → not stale.
    const initializing = harness({
      row: sessionRow({
        status: "initializing",
        opencodeSessionId: null,
        skillsHash: "old",
      }),
      hashesFor: async () => ({ skillsHash: "new", mcpConfigHash: null }),
    });
    const response = await initializing.app.request(`/sessions/${SESSION_ID}`);
    expect(
      ((await response.json()) as { skills_stale: boolean }).skills_stale,
    ).toBe(false);
  });
});
