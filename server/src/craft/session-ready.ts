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
import { generateAgentInstructions } from "./agent-instructions";
import type { CraftConfig } from "./config";
import { writeConnectAppPlugin } from "./connect-app-plugin";
import { StaleProvisioningAttemptError } from "./errors";
import {
  type CraftManagedContentResolver,
  companySearchSkillAvailable,
  materializeManagedContent,
} from "./managed-content";
import { writeWebappBootstrapScript } from "./nextjs-dev";
import {
  buildProviderOpencodeConfig,
  opencodeConfigJson,
} from "./opencode-config";
import type { SandboxGateway } from "./sandbox-gateway";
import { SESSION_PLUGINS } from "./session-plugins";
import type { CraftSessionRow, CraftStore } from "./store";
import { writeTurnBudgetPlugin } from "./turn-budget";
import { writeWebappPlugin } from "./webapp-plugin";
import {
  sessionDirectory,
  sessionWorkspaceExists,
  setupSessionWorkspace,
} from "./workspace";

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
  llmConfigFor: (
    session: CraftSessionRow,
  ) => Promise<import("./opencode-config").CraftLLMProviderConfig>;
  /**
   * Resolves the session owner's managed content BEFORE anything is built: a
   * failed resolution fails provisioning (AGENTS.md is only ever written after
   * resolution succeeded — onyx reads the payload up front and builds after).
   */
  managedContentResolver?: CraftManagedContentResolver;
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
  const directory = sessionDirectory(
    session.id,
    input.config.sessionDirectoryMode,
  );
  const fileApi = gateway.fileApiFor(botId);

  try {
    // Managed content resolves BEFORE anything is built: a failed resolution
    // fails provisioning here, so no AGENTS.md ever names apps or skills the
    // deployment could not stand behind (onyx reads the payload up front, then
    // commits before any external work).
    const managedContent = input.managedContentResolver
      ? await input.managedContentResolver(session)
      : null;

    // The push half (onyx push_managed_content): failures are logged, never
    // raised — the workspace still builds, and because the skills hash is only
    // acked on a successful push the next create/reload retries.
    const pushManagedContent = async (): Promise<boolean> => {
      if (!managedContent || !fileApi) return false;
      return materializeManagedContent(fileApi, directory, managedContent);
    };

    if (
      fileApi !== null &&
      (await sessionWorkspaceExists(
        fileApi,
        session.id,
        input.config.sessionDirectoryMode,
      ))
    ) {
      // Light path: the workspace is intact, but the managed content may
      // predate it (a repair under the same id, a pre-managed-content session)
      // — push again and record the hashes the push actually landed.
      const hydrated = await pushManagedContent();
      if (managedContent) {
        // AGENTS.md is rewritten from the resolved content BEFORE the ack: the
        // skills hash fingerprints the connectable-apps section the file renders,
        // so acking it over a pre-section AGENTS.md would mark a stale prompt
        // current (and the ack would suppress every later reconcile). Written at
        // the workspace-setup write point; a failed write fails provisioning
        // through the envelope below, so the hash is only ever acked after the
        // render landed.
        const llmConfig = await input.llmConfigFor(session);
        const agentsMd = generateAgentInstructions({
          template: await agentsTemplate(),
          config: input.config,
          provider: llmConfig.provider,
          modelName: llmConfig.modelName,
          disabledTools: input.config.opencodeDisabledTools,
          userName: input.userName,
          organizationInstructions: input.organizationInstructions,
          connectableAppsSection: managedContent.connectableAppsSection,
          companySearchSkillAvailable:
            companySearchSkillAvailable(managedContent),
        });
        await fileApi.writeFile(`${directory}/AGENTS.md`, agentsMd);
        // opencode.json rides along on the light path too: the workspace is
        // intact but its config may predate a resolved MCP set (a repaired
        // session, a pre-managed-content runtime). Same snapshot, same bytes
        // the reconcile computes — one builder, one ordering.
        await fileApi.writeFile(
          `${directory}/opencode.json`,
          opencodeConfigJson(
            buildProviderOpencodeConfig(llmConfig, {
              disabledTools: input.config.opencodeDisabledTools,
              gatedTools: input.config.approvalGatedTools,
              plugins: SESSION_PLUGINS,
              mcpServers: managedContent.mcpServers,
              sessionId: session.id,
            }),
          ),
        );
        await writeTurnBudgetPlugin(
          { writeFile: (path, content) => fileApi.writeFile(path, content) },
          session.id,
          input.config,
        );
        await writeConnectAppPlugin(
          { writeFile: (path, content) => fileApi.writeFile(path, content) },
          session.id,
          input.config,
        );
        // The webapp tool's refresh (the workspace may predate it) — plugin
        // always, bootstrap script when the session holds a reserved port.
        await writeWebappPlugin(
          { writeFile: (path, content) => fileApi.writeFile(path, content) },
          session.id,
          input.config,
        );
        if (session.nextjsPort != null) {
          await writeWebappBootstrapScript(
            { writeFile: (path, content) => fileApi.writeFile(path, content) },
            session.id,
            input.config,
            session.nextjsPort,
          );
        }
        await store.updateSession(session.id, {
          ...(session.status !== "active" ? { status: "active" } : {}),
          mcpConfigHash: managedContent.mcpConfigHash,
          ...(hydrated ? { skillsHash: managedContent.skillsHash } : {}),
        });
      } else if (session.status !== "active") {
        await store.updateSession(session.id, { status: "active" });
      }
      return;
    }

    if (!fileApi) {
      throw new Error(`No sandbox configured for bot ${botId}`);
    }

    const llmConfig = await input.llmConfigFor(session);
    const skillsHydrated = await pushManagedContent();
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
        webappPort: session.nextjsPort,
        managedContent: managedContent
          ? {
              connectableAppsSection: managedContent.connectableAppsSection,
              companySearchSkillAvailable:
                companySearchSkillAvailable(managedContent),
              mcpServers: managedContent.mcpServers,
            }
          : null,
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
      // onyx finalize carries the sandbox row's hashes: the MCP fingerprint
      // regardless (the config is written per session), the skills hash only
      // when the push landed — a failed push leaves the row behind the content
      // so the next reconcile/reload retries it.
      ...(managedContent
        ? { mcpConfigHash: managedContent.mcpConfigHash }
        : {}),
      ...(managedContent && skillsHydrated
        ? { skillsHash: managedContent.skillsHash }
        : {}),
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
