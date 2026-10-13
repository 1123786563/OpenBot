import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { loadCraftConfig } from "../src/craft/config";
import type { ResolvedCraftManagedContent } from "../src/craft/managed-content";
import { CraftSessionManager } from "../src/craft/manager";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import { createSessionRoutes } from "../src/craft/session-routes";
import {
  computeSkillRuntimeHash,
  craftMcpFingerprint,
} from "../src/craft/skills";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import type { InteractiveTurn, TurnStateStore } from "../src/craft/turn-state";

/**
 * The skills/reload endpoint's contract — onyx session/api.py's
 * `POST /sessions/{id}/skills/reload` → `SessionSkillsStateResponse`, plus the
 * `skills_stale` field of the session responses now DERIVED through
 * sessionRuntimeStale (the managed-content seam), never a hardcoded false.
 *
 * onyx's non-stale short-circuit (manager.py:367-368) is restored now that the
 * managed-content resolver supplies real hashes: an up-to-date runtime reloads
 * nothing. A stale one re-materializes the managed skills into the session
 * workspace, regenerates the config + AGENTS.md, disposes the running instance,
 * and only then acknowledges the new hashes — the skills hash only after the
 * push landed (onyx records it solely on push success).
 */

const SESSION_ID = "cs-reload";
const USER_ID = "u1";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;

const config = loadCraftConfig({});

const encoder = new TextEncoder();

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

/** A live managed-content payload with one skill and one connectable app. */
function liveContent(
  overrides: Partial<ResolvedCraftManagedContent> = {},
): ResolvedCraftManagedContent {
  const skillFiles = new Map([
    ["search/SKILL.md", encoder.encode("do a search")],
  ]);
  const section = "- External app ID `7`: **Slack**";
  return {
    connectableAppsSection: section,
    skillFiles,
    mcpServers: [],
    skillsHash: computeSkillRuntimeHash(
      Object.fromEntries(skillFiles),
      section,
    ),
    mcpConfigHash: craftMcpFingerprint([]),
    libraryFiles: new Map(),
    webTemplateFiles: new Map(),    ...overrides,
  };
}

const llmConfigFor = async () => llm;

function memoryGateway(
  input: { failWrites?: boolean; failSkillWrites?: boolean } = {},
) {
  const files = new Map<string, string | Uint8Array>();
  const disposals: string[] = [];
  const writeFile = async (path: string, content: string) => {
    if (input.failWrites) throw new Error("sandbox down");
    files.set(path, content);
  };
  const writeFileBytes = async (path: string, bytes: Uint8Array) => {
    if (input.failWrites || input.failSkillWrites) {
      throw new Error("sandbox down");
    }
    files.set(path, bytes);
  };
  const gateway = {
    fileApiFor: () => ({
      async listFiles(path: string) {
        return [...files.keys()].filter((key) => key.startsWith(`${path}/`));
      },
      writeFile,
      writeFileBytes,
      async deletePath(path: string) {
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
        return true;
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
  contentFor?: (
    session: CraftSessionRow,
  ) => Promise<ResolvedCraftManagedContent | null>;
  activeTurn?: InteractiveTurn | null;
  failTurnState?: boolean;
  failWrites?: boolean;
  /** Only the binary skill-file writes fail — the push lands, nothing else. */
  failSkillWrites?: boolean;
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
  const sandbox = memoryGateway({
    failWrites: input.failWrites,
    failSkillWrites: input.failSkillWrites,
  });
  const manager = new CraftSessionManager({
    config,
    store,
    gateway: sandbox.gateway,
    llmConfigFor,
    botIdFor: async () => "craft",
    managedContentFor: input.contentFor,
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

  test("an up-to-date runtime is a no-op (onyx's non-stale short-circuit)", async () => {
    const { app, files, disposals, updates } = harness({});
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills_stale: false });
    // Nothing pushed, nothing regenerated, nothing disposed, nothing acked.
    expect(files.size).toBe(0);
    expect(disposals).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a stale runtime re-pushes skills, regenerates config + AGENTS.md, disposes, acks", async () => {
    const content = liveContent();
    const { app, files, disposals, updates } = harness({
      row: sessionRow({ skillsHash: "old", mcpConfigHash: "old-mcp" }),
      contentFor: async () => content,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills_stale: false });

    // The managed skill file is delivered into the session workspace...
    expect(files.get(`${DIRECTORY}/.opencode/skills/search/SKILL.md`)).toEqual(
      encoder.encode("do a search"),
    );
    // ...AGENTS.md renders the resolved connectable-apps section...
    const agentsMd = files.get(`${DIRECTORY}/AGENTS.md`);
    expect(typeof agentsMd).toBe("string");
    expect(agentsMd).toContain("- External app ID `7`: **Slack**");
    // ...the rewritten config carries the managed plugins (Task 4 added the
    // webapp tool beside the budget steer and the connect-app handshake)...
    const opencodeJson = files.get(`${DIRECTORY}/opencode.json`);
    expect(opencodeJson).toBeDefined();
    expect(JSON.parse(opencodeJson as string).plugin).toEqual([
      "./.opencode/plugin/turn-budget.ts",
      "./.opencode/plugin/connect-app.ts",
      "./.opencode/plugin/webapp.ts",
    ]);
    // The running instance is disposed so a fresh one re-reads the config.
    expect(disposals).toEqual([DIRECTORY]);
    // The row acknowledges the pushed hashes.
    expect(updates).toEqual([
      {
        id: SESSION_ID,
        patch: {
          skillsHash: content.skillsHash,
          mcpConfigHash: content.mcpConfigHash,
        },
      },
    ]);
  });

  test("hashes-only wiring regenerates + acks without a skills push", async () => {
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

  test("a wired resolver that fails mid-reload regenerates nothing — the config keeps its mcp block", async () => {
    // currentHashesFor succeeded (the hashes seam answered "new"), then the
    // resolver went down between the two calls: content is null — a regenerate
    // from the empty snapshot would strip the session's mcp block while the
    // resolver is merely down, and acking the seam's fresh fingerprints would
    // call the degraded bytes current. The reload skips instead: nothing
    // written, nothing disposed, nothing acked; the row honestly stays stale
    // and the next pass self-heals once the resolver answers again. (Hashes-
    // only wirings have no resolver to fail and keep their contentless ack.)
    const seeded = JSON.stringify({
      mcp: {
        "acme-tools-42": {
          type: "remote",
          url: "https://openbot.example/api/craft/mcp/42",
          enabled: true,
          oauth: false,
        },
      },
    });
    const { app, files, disposals, updates } = harness({
      row: sessionRow({ skillsHash: "old", mcpConfigHash: "old-mcp" }),
      hashesFor: async () => ({
        skillsHash: "new",
        mcpConfigHash: "new-mcp",
      }),
      contentFor: async () => {
        throw new Error("app store down");
      },
    });
    files.set(`${DIRECTORY}/opencode.json`, seeded);
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills_stale: true });
    // The workspace config is untouched — the mcp block survives the outage...
    expect(files.get(`${DIRECTORY}/opencode.json`)).toBe(seeded);
    expect(files.has(`${DIRECTORY}/AGENTS.md`)).toBe(false);
    // ...and no disposal, no ack: the row keeps its old hashes and stays stale.
    expect(disposals).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a failed skills push acks the mcp hash but never the skills hash", async () => {
    const content = liveContent();
    const { app, files, updates } = harness({
      row: sessionRow({ skillsHash: "old", mcpConfigHash: "old-mcp" }),
      contentFor: async () => content,
      failSkillWrites: true,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    // The push failed but the config regenerated — the reload completes, the
    // mcp hash rides along (onyx records it regardless), the skills hash does
    // NOT: acking it would claim content the workspace never received.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skills_stale: true });
    expect(files.get(`${DIRECTORY}/AGENTS.md`)).toBeDefined();
    expect(updates).toEqual([
      { id: SESSION_ID, patch: { mcpConfigHash: content.mcpConfigHash } },
    ]);
  });

  test("a dead sandbox answers 502 and acks nothing (onyx's BAD_GATEWAY)", async () => {
    const content = liveContent();
    const { app, files, updates } = harness({
      row: sessionRow({ skillsHash: "old", mcpConfigHash: "old-mcp" }),
      contentFor: async () => content,
      failWrites: true,
    });
    const response = await app.request(
      `/sessions/${SESSION_ID}/skills/reload`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(502);
    expect(files.size).toBe(0);
    expect(updates).toEqual([]);
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
    const { app, updates } = harness({
      row: sessionRow({ skillsHash: "old" }),
      hashesFor: async () => ({ skillsHash: "new", mcpConfigHash: null }),
      failWrites: true,
    });
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
