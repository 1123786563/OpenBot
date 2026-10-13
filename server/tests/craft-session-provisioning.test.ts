import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import { StaleProvisioningAttemptError } from "../src/craft/errors";
import { CraftSessionManager } from "../src/craft/manager";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";

/**
 * The manager's session-lifecycle seams the live verification found broken:
 *
 * - F-D — createSession passed the row snapshot taken BEFORE the port
 *   reservation into the reconcile, so session-ready saw nextjsPort=null and
 *   never wrote start-webapp.sh at initial provisioning (2 of 3 live
 *   server-created sessions lacked the script).
 * - F-F — a FAILED row that re-entered provisioning (getOrCreateEmptySession's
 *   repair path) never got reset to initializing, so the finalize CAS
 *   (WHERE status='initializing') matched 0 rows and every reconcile threw
 *   StaleProvisioningAttemptError — the session was bricked until its row was
 *   deleted by hand.
 *
 * The harness is a manager over an in-memory store with the real store's CAS
 * semantics and a gateway whose file API answers "no workspace" (the initial
 * provisioning path — not the light/repair-intact one).
 */

const config = loadCraftConfig({});
const db = {} as never;

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
    id: "cs-seed",
    userId: "u1",
    name: null,
    status: "initializing",
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

/**
 * An in-memory store with the real CAS semantics: finalize only moves an
 * `initializing` row, the repair reset only moves a `failed` row, and the
 * port reservation persists on the row (the createSession snapshot problem
 * F-D describes is a real one: the row object the caller holds goes stale).
 */
function provisioningHarness(input?: {
  seed?: CraftSessionRow;
  /** Simulates a repair race: the failed→initializing CAS loses. */
  loseRepairRace?: boolean;
  /** The workspace probe answers "present" — the light path runs, not setup. */
  workspaceExists?: boolean;
  /** Managed content the manager's resolver answers (the light path's input). */
  managedContentFor?: (
    session: CraftSessionRow,
  ) => Promise<
    import("../src/craft/managed-content").ResolvedCraftManagedContent
  >;
}) {
  const files = new Map<string, string>();
  const rows = new Map<string, CraftSessionRow>();
  const messages = new Set<string>();
  const disposals: string[] = [];
  let seq = 0;
  let portOffset = 0;
  if (input?.seed) rows.set(input.seed.id, { ...input.seed });

  const store = {
    async createSession(creation: {
      userId: string;
      name?: string | null;
      origin?: CraftSessionRow["origin"];
    }) {
      const row = sessionRow({
        id: `cs-new-${seq++}`,
        userId: creation.userId,
        name: creation.name ?? null,
        origin: creation.origin ?? "INTERACTIVE",
      });
      rows.set(row.id, row);
      return { ...row };
    },
    async reserveNextjsPort(reservation: {
      userId: string;
      sessionId: string;
      portStart: number;
      portEnd: number;
    }) {
      const row = rows.get(reservation.sessionId);
      if (!row) throw new Error("no row");
      const port = reservation.portStart + portOffset++;
      row.nextjsPort = port;
      return port;
    },
    async getSession(sessionId: string, userId: string) {
      const row = rows.get(sessionId);
      return row && row.userId === userId ? { ...row } : undefined;
    },
    async getEmptySessionForUser(userId: string) {
      for (const row of rows.values()) {
        if (row.userId === userId && !messages.has(row.id)) {
          return { ...row };
        }
      }
      return undefined;
    },
    async updateSession(sessionId: string, patch: Partial<CraftSessionRow>) {
      const row = rows.get(sessionId);
      if (!row) return undefined;
      Object.assign(row, patch);
      return { ...row };
    },
    async finalizeSessionInitialization(finalize: {
      sessionId: string;
      toStatus: "active" | "failed";
      opencodeSessionId?: string | null;
    }) {
      const row = rows.get(finalize.sessionId);
      if (row?.status !== "initializing") return false;
      row.status = finalize.toStatus;
      if (finalize.opencodeSessionId != null) {
        row.opencodeSessionId = finalize.opencodeSessionId;
      }
      return true;
    },
    async resetFailedSessionForRepair(sessionId: string) {
      if (input?.loseRepairRace) return false;
      const row = rows.get(sessionId);
      if (row?.status !== "failed") return false;
      row.status = "initializing";
      return true;
    },
  } as unknown as CraftStore;

  const gateway = {
    // Fresh session: the workspace probe answers "not found" so the manager
    // takes the full initial-provisioning path (setupSessionWorkspace);
    // `workspaceExists` flips it to the light path (repair under a live
    // workspace).
    fileApiFor: () => ({
      async listFiles(path: string) {
        if (input?.workspaceExists) return [`${path}/opencode.json`];
        throw new Error("ENOENT: no workspace yet");
      },
      async writeFile(path: string, content: string) {
        files.set(path, content);
      },
      async deletePath(path: string) {
        files.delete(path);
        return true;
      },
      async readFile() {
        return null;
      },
    }),
    serveClientFor: ({ directory }: { directory: string }) => ({
      ensureSession: async () => "ses_new",
      disposeInstance: async () => {
        disposals.push(directory);
      },
    }),
  } as unknown as SandboxGateway;

  const manager = new CraftSessionManager({
    config,
    store,
    gateway,
    llmConfigFor: async () => llm,
    botIdFor: async () => "craft",
    ...(input?.managedContentFor
      ? { managedContentFor: input.managedContentFor }
      : {}),
  });
  return { files, rows, manager, disposals };
}

describe("createSession initial provisioning (F-D)", () => {
  test("writes start-webapp.sh with the reserved port at initial provisioning", async () => {
    const { files, manager } = provisioningHarness();
    const created = await manager.createSession(db, { userId: "u1" });

    expect(created.status).toBe("active");
    expect(created.nextjsPort).toBe(config.sandboxNextjsPortStart);
    // The script the webapp tool drives must land on the FIRST provisioning,
    // not only on a later repair reconcile.
    const script = files.get(
      `/workspace/sessions/${created.id}/start-webapp.sh`,
    );
    expect(script).toBeDefined();
    expect(script).toContain(`PORT=${config.sandboxNextjsPortStart}`);
  });

  test("headless session: no port reserved, no script (onyx parity guard)", async () => {
    const { files, manager } = provisioningHarness();
    const created = await manager.createSession(db, {
      userId: "u1",
      headless: true,
    });
    expect(created.status).toBe("active");
    expect(created.nextjsPort).toBeNull();
    expect(files.has(`/workspace/sessions/${created.id}/start-webapp.sh`)).toBe(
      false,
    );
  });
});

describe("failed-session repair (F-F)", () => {
  test("a failed row repairs under the same id: provisions, script written, status active — no Stale throw", async () => {
    const { files, manager } = provisioningHarness({
      seed: sessionRow({
        id: "cs-failed",
        status: "failed",
        nextjsPort: 3012,
      }),
    });

    const repaired = await manager.getOrCreateEmptySession(db, {
      userId: "u1",
    });

    expect(repaired.status).toBe("active");
    expect(repaired.id).toBe("cs-failed");
    expect(repaired.opencodeSessionId).toBe("ses_new");
    expect(
      files.get("/workspace/sessions/cs-failed/start-webapp.sh"),
    ).toContain("PORT=3012");
  });

  test("a lost repair race (failed→initializing CAS miss) throws Stale, never double-provisions", async () => {
    const { manager } = provisioningHarness({
      seed: sessionRow({
        id: "cs-raced",
        status: "failed",
        nextjsPort: 3013,
      }),
      loseRepairRace: true,
    });
    await expect(
      manager.getOrCreateEmptySession(db, { userId: "u1" }),
    ).rejects.toBeInstanceOf(StaleProvisioningAttemptError);
  });
});

describe("light-path config rewrite disposes the running instance (OCR r2)", () => {
  test("workspace intact + instance minted pre-crash: rewrite → dispose BEFORE the hash ack", async () => {
    const content = {
      connectableAppsSection: "No connectable apps available.",
      skillFiles: new Map<string, Uint8Array>(),
      mcpServers: [],
      skillsHash: "skills-v2",
      mcpConfigHash: "mcp-v2",
      libraryFiles: new Map<string, Uint8Array>(),
      webTemplateFiles: new Map<string, Uint8Array>(),    };
    const { files, rows, manager, disposals } = provisioningHarness({
      seed: sessionRow({
        id: "cs-light",
        status: "failed",
        nextjsPort: 3014,
        // An opencode instance was minted before the provisioning attempt
        // crashed (finalize never ran) — it caches the OLD directory config.
        opencodeSessionId: "ses_old",
        skillsHash: "skills-v1",
        mcpConfigHash: "mcp-v1",
      }),
      workspaceExists: true,
      managedContentFor: async () => content,
    });

    const repaired = await manager.getOrCreateEmptySession(db, {
      userId: "u1",
    });

    expect(repaired.status).toBe("active");
    // The light path rewrote the config from the resolved snapshot...
    const rewritten = files.get("/workspace/sessions/cs-light/opencode.json");
    expect(rewritten).toContain('"connect_app":"ask"');
    // ...and acked the new fingerprints...
    expect(rows.get("cs-light")?.mcpConfigHash).toBe("mcp-v2");
    // ...so it OWED the still-alive instance a dispose: without it the ack
    // marks the row synced forever while the old instance keeps serving the
    // cached pre-rewrite config (sessionRuntimeStale never fires again).
    expect(disposals).toContain("/workspace/sessions/cs-light");
  });

  test("no instance minted yet: the light path disposes nothing", async () => {
    const content = {
      connectableAppsSection: "No connectable apps available.",
      skillFiles: new Map<string, Uint8Array>(),
      mcpServers: [],
      skillsHash: "skills-v2",
      mcpConfigHash: "mcp-v2",
      libraryFiles: new Map<string, Uint8Array>(),
      webTemplateFiles: new Map<string, Uint8Array>(),    };
    const { manager, disposals } = provisioningHarness({
      seed: sessionRow({
        id: "cs-light-fresh",
        status: "failed",
        nextjsPort: 3015,
        opencodeSessionId: null,
      }),
      workspaceExists: true,
      managedContentFor: async () => content,
    });

    const repaired = await manager.getOrCreateEmptySession(db, {
      userId: "u1",
    });
    expect(repaired.status).toBe("active");
    expect(disposals).toEqual([]);
  });
});
