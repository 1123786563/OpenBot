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

import { generateAgentInstructions } from "./agent-instructions";
import type { CraftConfig } from "./config";
import type { CraftLLMProviderConfig } from "./opencode-config";
import {
  buildProviderOpencodeConfig,
  opencodeConfigJson,
} from "./opencode-config";
import type { AgentSandboxFileApi } from "./sandbox-gateway";

export const SESSIONS_ROOT = "/workspace/sessions";

/** The session's directory inside the sandbox — also the `?directory=` anchor everywhere. */
export function sessionDirectory(sessionId: string): string {
  return `${SESSIONS_ROOT}/${sessionId}`;
}

export type SetupSessionWorkspaceInput = {
  sessionId: string;
  config: CraftConfig;
  llmConfig: CraftLLMProviderConfig;
  userName?: string | null;
  organizationInstructions?: string | null;
  agentsTemplate: string;
};

export type WorkspaceApi = {
  /** Write one text file, creating parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  /** Ensure a directory exists. */
  mkdir(path: string): Promise<void>;
};

/**
 * Materialize a session workspace: skeleton directories, AGENTS.md, opencode.json. Idempotent
 * — re-running after an interruption converges on the same completed workspace.
 */
export async function setupSessionWorkspace(
  api: WorkspaceApi,
  input: SetupSessionWorkspaceInput,
): Promise<void> {
  const root = sessionDirectory(input.sessionId);

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
  });
  await api.writeFile(`${root}/AGENTS.md`, agentsMd);

  const opencodeJson = opencodeConfigJson(
    buildProviderOpencodeConfig(input.llmConfig, {
      disabledTools: input.config.opencodeDisabledTools,
    }),
  );
  await api.writeFile(`${root}/opencode.json`, opencodeJson);
}

/**
 * Whether the workspace exists: the outputs directory is the completion marker (a
 * half-written workspace has attachments but not outputs, mirroring onyx's sentinel logic).
 */
export async function sessionWorkspaceExists(
  api: Pick<AgentSandboxFileApi, "listFiles">,
  sessionId: string,
): Promise<boolean> {
  const root = sessionDirectory(sessionId);
  try {
    const entries = await api.listFiles(`${root}/outputs`);
    return Array.isArray(entries);
  } catch {
    return false;
  }
}

/** Best-effort cleanup of a session's workspace (session deletion path). */
export async function cleanupSessionWorkspace(
  api: AgentSandboxFileApi,
  sessionId: string,
): Promise<void> {
  await api.deletePath(sessionDirectory(sessionId));
}
