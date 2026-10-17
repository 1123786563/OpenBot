/**
 * Session-workspace materialization — ported from onyx `sandbox/session_workspace.py`,
 * adapted to the agent-sandbox service: instead of `exec`-ing a shell script inside a pod,
 * the files are written through the sandbox gateway's file API. The product shape is the
 * same: a per-session directory under `/workspace/sessions/{id}` with the outputs /
 * attachments skeleton, AGENTS.md, and opencode.json.
 *
 * The replay-safety story (onyx's flock + in-progress marker) becomes idempotent writes:
 * every operation here is a mkdir/write that converges on the same completed workspace.
 */

import { getLogger } from "../../../shared/logger";
import {
  appendAttachmentsSectionIfMissing,
  generateAgentInstructions,
} from "./agent-instructions";
import type { CraftConfig } from "./config";
import { writeConnectAppPlugin } from "./connect-app-plugin";
import { writeWebappBootstrapScript } from "./nextjs-dev";
import type { CraftLLMProviderConfig } from "./opencode-config";
import {
  buildProviderOpencodeConfig,
  opencodeConfigJson,
} from "./opencode-config";
import type { AgentSandboxFileApi } from "./sandbox-gateway";
import { SESSION_PLUGINS } from "./session-plugins";
import { writeTurnBudgetPlugin } from "./turn-budget";
import { writeWebappPlugin } from "./webapp-plugin";

export const SESSIONS_ROOT = "/workspace/sessions";

const logger = getLogger("server");

/**
 * The session's directory anchor — the `?directory=` scope key for opencode-serve AND the
 * path prefix for file-API calls. Mode-dependent (see config.sessionDirectoryMode):
 *
 * - "absolute" (onyx-native, the default): `/workspace/sessions/{id}` — a real absolute path
 *   inside a session-dedicated pod, where opencode's cwd IS this directory.
 * - "bot-relative" (agent-sandbox): the bare `{sessionId}` — relative to the Bot's workspace
 *   root, which is opencode's cwd there; the file API only accepts relative paths.
 */
export function sessionDirectory(
  sessionId: string,
  mode: "absolute" | "bot-relative" = "absolute",
): string {
  return mode === "bot-relative" ? sessionId : `${SESSIONS_ROOT}/${sessionId}`;
}

export type SetupSessionWorkspaceInput = {
  sessionId: string;
  config: CraftConfig;
  llmConfig: CraftLLMProviderConfig;
  userName?: string | null;
  organizationInstructions?: string | null;
  agentsTemplate: string;
  /**
   * The resolved managed content's AGENTS.md face. The caller resolves BEFORE
   * setup begins (onyx reads the payload up front, commits, then builds), so
   * AGENTS.md is only ever written after resolution succeeded. Null for a
   * wiring without managed content.
   */
  managedContent?: {
    connectableAppsSection: string;
    companySearchSkillAvailable: boolean;
    /** The session owner's craft MCP set — same snapshot the reconcile compares against. */
    mcpServers?: readonly import("./opencode-config").CraftMCPServerConfig[];
  } | null;
  /**
   * The session's reserved webapp port (`craft_sessions.nextjs_port`). Non-null →
   * the protected `start-webapp.sh` lands at the session root (the webapp tool's
   * target). Null (headless sessions, onyx parity) → no script; the tool answers
   * the unavailable observation. The plugin ships either way.
   */
  webappPort?: number | null;
  /**
   * The base url the sandbox's tools dial back on (the MCP relay's own base —
   * same fallback chain the boot file resolves). Non-null → the company-search
   * CLI's two non-secret identity files land under .opencode/: the session tag
   * (the same value the opencode.json mcp block stamps) and this base. No
   * credential ever enters the workspace — the relay resolves the owner from
   * the tag alone.
   */
  mcpRelayBaseUrl?: string | null;
};

export type WorkspaceApi = {
  /** Write one text file, creating parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  /** Ensure a directory exists. */
  mkdir(path: string): Promise<void>;
  /** List a directory (the attachments-section probe); absent on write-only views. */
  listFiles?(path: string): Promise<string[]>;
  /** Read a text file's contents, or null when absent; absent on write-only views. */
  readFile?(path: string): Promise<string | null>;
};

/**
 * Materialize a session workspace: skeleton directories, AGENTS.md, opencode.json. Idempotent
 * — re-running after an interruption converges on the same completed workspace.
 */
export async function setupSessionWorkspace(
  api: WorkspaceApi,
  input: SetupSessionWorkspaceInput,
): Promise<void> {
  const root = sessionDirectory(
    input.sessionId,
    input.config.sessionDirectoryMode,
  );

  await api.mkdir(`${root}/outputs`);
  await api.mkdir(`${root}/attachments`);
  await api.mkdir(`${root}/.opencode`);

  const agentsMd = generateAgentInstructions({
    template: input.agentsTemplate,
    config: input.config,
    provider: input.llmConfig.provider,
    modelName: input.llmConfig.modelName,
    disabledTools: input.config.opencodeDisabledTools,
    userName: input.userName,
    organizationInstructions: input.organizationInstructions,
    connectableAppsSection:
      input.managedContent?.connectableAppsSection ?? null,
    companySearchSkillAvailable:
      input.managedContent?.companySearchSkillAvailable ?? false,
  });
  await api.writeFile(`${root}/AGENTS.md`, agentsMd);

  // onyx's post-write step (docker_sandbox_manager.py:1585-1589): a session that already
  // has attachments gets the priority section appended. Best-effort — a failed append must
  // not fail the workspace setup (the next setup/upload retry converges it).
  if (api.listFiles && api.readFile) {
    try {
      await appendAttachmentsSectionIfMissing(
        {
          listFiles: api.listFiles,
          readFile: api.readFile,
          writeFile: api.writeFile,
        },
        root,
        input.config.attachmentsDirectory,
      );
    } catch (error) {
      logger.warn(
        {
          sessionId: input.sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "[craft] attachments section append failed during workspace setup",
      );
    }
  }

  // The managed plugins ship in the workspace itself (agent-sandbox's image
  // cannot carry them); the opencode.json below points opencode at them.
  await writeTurnBudgetPlugin(api, input.sessionId, input.config);
  await writeConnectAppPlugin(api, input.sessionId, input.config);
  await writeWebappPlugin(api, input.sessionId, input.config);
  // The webapp tool's protected bootstrap script — written BEFORE opencode.json
  // so the workspace never carries a config referencing an absent tool target.
  // Headless sessions (no reserved port) get no script (onyx parity: the tool
  // answers the unavailable observation there).
  if (input.webappPort != null) {
    await writeWebappBootstrapScript(
      api,
      input.sessionId,
      input.config,
      input.webappPort,
    );
  }

  const opencodeJson = opencodeConfigJson(
    buildProviderOpencodeConfig(input.llmConfig, {
      disabledTools: input.config.opencodeDisabledTools,
      gatedTools: input.config.approvalGatedTools,
      plugins: SESSION_PLUGINS,
      mcpServers: input.managedContent?.mcpServers ?? [],
      sessionId: input.sessionId,
    }),
  );
  await api.writeFile(`${root}/opencode.json`, opencodeJson);

  // The sandbox-side CLI identity (onyx-cli of the company-search skill): the
  // session tag the relay authenticates, and the base it dials. Both non-secret
  // — the tag names a row, and the base is the deployment's public address —
  // so the workspace carries no credential (the relay resolves the owner from
  // the tag, the same trust model as the MCP relay).
  if (input.mcpRelayBaseUrl) {
    await api.writeFile(`${root}/.opencode/craft-session`, input.sessionId);
    await api.writeFile(
      `${root}/.opencode/craft-api-base`,
      input.mcpRelayBaseUrl,
    );
  }
}

/**
 * Whether the workspace exists: the outputs directory is the completion marker (a
 * half-written workspace has attachments but not outputs, mirroring onyx's sentinel logic).
 */
export async function sessionWorkspaceExists(
  api: Pick<AgentSandboxFileApi, "listFiles">,
  sessionId: string,
  mode: "absolute" | "bot-relative" = "absolute",
): Promise<boolean> {
  const root = sessionDirectory(sessionId, mode);
  try {
    const entries = await api.listFiles(`${root}/outputs`);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of a session's workspace (session deletion path). The gateway's delete
 * verb is files-only (onyx's endpoint semantics), so a whole-session tree never deletes through
 * it — the same honest no-op it has always been against agent-sandbox; workspace teardown is the
 * Bot workspace reset/sweeper's job, not the session row's.
 */
export async function cleanupSessionWorkspace(
  api: AgentSandboxFileApi,
  sessionId: string,
  mode: "absolute" | "bot-relative" = "absolute",
): Promise<void> {
  await api.deletePath(sessionDirectory(sessionId, mode)).catch(() => false);
}
