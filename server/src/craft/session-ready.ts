/**
 * Bringing a session's runtime up, for whoever needs it — ported from onyx
 * `session/session_ready.py`, reduced to the warm-sandbox first phase.
 *
 * Provisioning the sandbox and rebuilding the session workspace are one operation: an opencode
 * instance caches the config of the directory it is created for, so a turn that touches a
 * session while its workspace is still being written stays pinned to a config that did not
 * exist yet, for the life of the sandbox. OpenBot's sandboxes are warm (agent-sandbox
 * service), so `ensureSessionReady` here = workspace present + opencode session minted +
 * session row ACTIVE; the sleep/snapshot/restore legs are the deferred phase.
 */

import type { Database } from "../db/client";
import type { CraftStore } from "./store";
import type { AgentSandboxFileApi, SandboxGateway } from "./sandbox-gateway";
import {
  sessionDirectory,
  sessionWorkspaceExists,
  setupSessionWorkspace,
} from "./workspace";
import type { CraftSessionRow } from "./store";
import { StaleProvisioningAttemptError } from "./errors";
import type { CraftConfig } from "./config";

/** The AGENTS.md template, read once per process (the port of onyx's file-read-at-import). */
let agentsTemplateCache: string | null = null;
export function setAgentsTemplate(template: string): void {
  agentsTemplateCache = template;
}
async function agentsTemplate(): Promise<string> {
  if (agentsTemplateCache !== null) return agentsTemplateCache;
  // Lazy read so the module stays importable without a filesystem hit.
  const { readFile } = await import("node:fs/promises");
  const path = new URL("./AGENTS.template.md", import.meta.url);
  agentsTemplateCache = await readFile(path, "utf8").catch(() => "");
  return agentsTemplateCache;
}

/** Whether the recorded state says this session can be prompted right now (DB-only fast path). */
export function sessionRuntimeIntact(
  session: CraftSessionRow | null,
  sandboxReady: boolean,
): boolean {
  return session !== null && session.status === "active" && sandboxReady;
}

export type EnsureSessionReadyInput = {
  db: Database;
  store: CraftStore;
  gateway: SandboxGateway;
  session: CraftSessionRow;
  /** The Bot whose sandbox hosts this session (OpenBot's sandbox scoping). */
  botId: string;
  /** The user's display name (AGENTS.md personalization). */
  userName?: string | null;
  organizationInstructions?: string | null;
  /** Resolves the LLM config for the workspace's opencode.json. */
  llmConfigFor: (session: CraftSessionRow) => Promise<
    import("./opencode-config").CraftLLMProviderConfig
  >;
  /** The craft runtime config — workspace generation reads it (explicit DI, no globals). */
  config: CraftConfig;
};

/**
 * Return the sandbox with `session`'s workspace in place and the session ACTIVE.
 *
 * The caller must already hold the user's session-flow lock: this writes into the sandbox, so
 * it must not interleave with a second restore or another turn doing the same thing. A failed
 * rebuild leaves the session FAILED (repairable under the same id).
 */
export async function ensureSessionReady(
  input: EnsureSessionReadyInput,
): Promise<void> {
  const { store, gateway, session, botId } = input;
  const directory = sessionDirectory(session.id);

  if (
    await sessionWorkspaceExists(gateway.fileApiFor(botId) ?? nullApi, session.id)
  ) {
    if (session.status !== "active") {
      await store.updateSession(session.id, { status: "active" });
    }
    return;
  }

  const fileApi = gateway.fileApiFor(botId);
  if (!fileApi) {
    throw new Error(`No sandbox configured for bot ${botId}`);
  }

  const llmConfig = await input.llmConfigFor(session);
  try {
    await setupSessionWorkspace(
      {
        writeFile: (path, content) => fileApi.writeFile(path, content),
        mkdir: async () => undefined,
      },
      {
        sessionId: session.id,
        config: input.config,
        llmConfig,
        userName: input.userName,
        organizationInstructions: input.organizationInstructions,
        agentsTemplate: await agentsTemplate(),
      },
    );

    // Mint the opencode session before flipping ACTIVE, so the first turn's
    // preflight hits an existing id.
    const client = gateway.serveClientFor({ botId, directory });
    if (!client) {
      throw new Error(`No sandbox serve client for bot ${botId}`);
    }
    const opencodeSessionId = await client.ensureSession(null, {
      directory,
      title: `craft-session-${session.id.slice(0, 8)}`,
    });

    const finalized = await store.finalizeSessionInitialization({
      sessionId: session.id,
      toStatus: "active",
      opencodeSessionId,
    });
    if (!finalized) {
      throw new StaleProvisioningAttemptError(
        `Session ${session.id} left initializing before this attempt finalized`,
      );
    }
  } catch (error) {
    // Durable FAILED for repair on retry; the error itself propagates.
    await store
      .finalizeSessionInitialization({
        sessionId: session.id,
        toStatus: "failed",
      })
      .catch(() => undefined);
    throw error;
  }
}

/** A null-object file API: every probe fails, so "workspace exists" answers false. */
const nullApi: AgentSandboxFileApi = {
  async listFiles() {
    throw new Error("no sandbox file api");
  },
  async writeFile() {
    throw new Error("no sandbox file api");
  },
  async deletePath() {
    throw new Error("no sandbox file api");
  },
  async readFile() {
    throw new Error("no sandbox file api");
  },
};
