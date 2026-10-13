/**
 * The craft SessionManager — ported from onyx `session/manager.py`, the per-request façade
 * over store + sandbox gateway + streaming.
 *
 * onyx's manager is bound to one SQLAlchemy session per request and holds a singleton sandbox
 * manager; here the DI factory pattern of the workshop layer applies instead: one manager
 * instance per craft wiring (the "db" travels with each method through the store, which owns
 * rows). The yield/persist/finalize layering that the headless scheduled-tasks path was built
 * to reuse (onyx §streaming docstring) is preserved verbatim — that split is the point.
 *
 * The artifact walk, md→docx/pptx export and webapp proxying live in their own modules
 * (artifacts.ts / export.ts / webapp-proxy.ts); the skills/MCP reload chain is the staleness
 * predicate in skills.ts plus reloadSessionSkills — the push/regenerate/dispose/ack tail both
 * the reconcile and the POST /sessions/:id/skills/reload route drive, over managed-content.ts's
 * resolver (the plugins-domain-backed app list + skill fileset + fingerprints).
 */

import { readFile } from "node:fs/promises";
import type { ApprovalStore } from "../approvals/types";
import type { Database } from "../db/client";
import type { CraftSessionOrigin } from "../db/schema/craft";
import { generateAgentInstructions } from "./agent-instructions";
import { createCraftPermissionGate } from "./approval-gate";
import type { CraftApprovalSignals } from "./approval-signals";
import type {
  CraftConnectAppRequest,
  CraftConnectAppSignals,
} from "./connect-app";

/** Parse one drained announce payload; null on an unparseable card (dropped, onyx parity). */
function parseConnectAppAnnounce(
  payload: string,
): CraftConnectAppRequest | null {
  try {
    const parsed = JSON.parse(payload) as Partial<CraftConnectAppRequest>;
    if (
      typeof parsed.request_id !== "string" ||
      typeof parsed.external_app_id !== "number"
    ) {
      return null;
    }
    return {
      request_id: parsed.request_id,
      external_app_id: parsed.external_app_id,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    return null;
  }
}

import type { CraftConfig } from "./config";
import { writeConnectAppPlugin } from "./connect-app-plugin";
import { StaleProvisioningAttemptError } from "./errors";
import {
  approvalRequestedPacket,
  type BuildPacket,
  connectAppRequestPacket,
  isBuildPacket,
} from "./events/packets";
import { isKeepalive, isSandboxError, type SandboxEvent } from "./events/types";
import {
  type CraftManagedContentResolver,
  companySearchSkillAvailable,
  materializeManagedContent,
  type ResolvedCraftManagedContent,
} from "./managed-content";
import { writeWebappBootstrapScript } from "./nextjs-dev";
import type { PromptAttachment } from "./opencode/serve-client";
import type { CraftLLMProviderConfig } from "./opencode-config";
import {
  buildProviderOpencodeConfig,
  opencodeConfigJson,
} from "./opencode-config";
import type { SandboxGateway } from "./sandbox-gateway";
import { SESSION_PLUGINS } from "./session-plugins";
import { ensureSessionReady } from "./session-ready";
import { sessionRuntimeStale } from "./skills";
import type { CraftSessionRow, CraftStore } from "./store";
import {
  type BuildStreamingState,
  finalizePersist,
  persistSandboxEvent,
} from "./streaming";
import { writeTurnBudgetPlugin } from "./turn-budget";
import { writeWebappPlugin } from "./webapp-plugin";
import { sessionDirectory } from "./workspace";

/** Redis-keyed marker: a config rewrite owes its running instance a dispose (24h TTL in onyx). */
export const DISPOSE_PENDING_TTL_SECONDS = 24 * 3600;
export const disposePendingKey = (sessionId: string) =>
  `craft:llm_config_dispose_pending:${sessionId}`;

export type SessionManagerDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  /** Resolves the session's effective LLM config (re-validated each turn, onyx parity). */
  llmConfigFor: (session: CraftSessionRow) => Promise<CraftLLMProviderConfig>;
  /** The Bot whose sandbox hosts the session (OpenBot sandbox scoping). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Organization-level craft instructions (AGENTS.md section); null when unset. */
  organizationInstructions?: string | null;
  /**
   * The raw approval store the gated-permission producer opens rows through, plus its
   * announce/wake signals. Either absent (or an empty gated-tools config) keeps the
   * auto-allow posture — no gate is built, no approvals are opened.
   */
  approvals?: ApprovalStore | null;
  approvalSignals?: CraftApprovalSignals | null;
  /**
   * The connect-app handshake's KV (pending stash + announce). Wired = connect_app
   * asks park for the decision endpoint; absent = they are denied like any
   * unknown category (nothing announced, nothing stashed).
   */
  connectAppSignals?: CraftConnectAppSignals | null;
  /**
   * The deployment's current managed-content fingerprints (skills payload + craft MCP set) to
   * compare a session's recorded hashes against. onyx reads these off the sandbox row; when only
   * this seam is wired the hashes are all the staleness contract sees. Unset + no resolver
   * below = the stable null pair (nothing pushed → nothing stale).
   */
  managedContentHashesFor?: (
    session: CraftSessionRow,
  ) => Promise<{ skillsHash: string | null; mcpConfigHash: string | null }>;
  /**
   * Resolves the session owner's managed content (connectable-apps section + skill fileset +
   * craft MCP set + fingerprints) — the port of onyx's build_managed_content_payload, answered
   * per user (never a deployment-wide id). The reload path pushes the content it resolves; a
   * failed resolution surfaces as null on the degrading paths and propagates on provisioning.
   */
  managedContentFor?: CraftManagedContentResolver;
  /** The base the sandbox dials back on (MCP relay + company-search CLI). */
  mcpRelayBaseUrl?: string | null;
};

export class CraftSessionManager {
  readonly config: CraftConfig;
  private readonly store: CraftStore;
  private readonly gateway: SandboxGateway;
  private readonly deps: SessionManagerDeps;
  private agentsTemplate: string | null = null;

  constructor(deps: SessionManagerDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.deps = deps;
  }

  private async template(): Promise<string> {
    if (this.agentsTemplate === null) {
      this.agentsTemplate = await readFile(
        new URL("./AGENTS.template.md", import.meta.url),
        "utf8",
      ).catch(() => "");
    }
    return this.agentsTemplate;
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  /**
   * The session by id (ownership-checked), bumping lastActivityAt — the port of onyx's
   * get_session + update_session_activity pair.
   */
  async getSession(
    _db: Database,
    sessionId: string,
    userId: string,
  ): Promise<CraftSessionRow | undefined> {
    return this.store.getSession(sessionId, userId);
  }

  /**
   * Create a session row (INITIALIZING) and materialize its workspace. The reserve →
   * reconcile → finalize shape of onyx: identity committed before external work, CAS to
   * ACTIVE only once the workspace and opencode session exist.
   */
  async createSession(
    db: Database,
    input: {
      userId: string;
      name?: string | null;
      userName?: string | null;
      agentProvider?: string | null;
      agentModel?: string | null;
      headless?: boolean;
      origin?: CraftSessionOrigin;
    },
  ): Promise<CraftSessionRow> {
    const session = await this.store.createSession({
      userId: input.userId,
      name: input.name ?? null,
      agentProvider: input.agentProvider ?? null,
      agentModel: input.agentModel ?? null,
      origin: input.origin,
    });
    if (!input.headless) {
      await this.store.reserveNextjsPort({
        userId: input.userId,
        sessionId: session.id,
        portStart: this.config.sandboxNextjsPortStart,
        portEnd: this.config.sandboxNextjsPortEnd,
      });
    }
    // The reservation persists nextjsPort on the row AFTER the snapshot above
    // was taken — re-read so the initial provisioning envelope sees the
    // reserved port and start-webapp.sh lands now, not only on a later
    // repair/reload reconcile (F-D).
    const toProvision =
      (await this.store.getSession(session.id, input.userId)) ?? session;
    await this.reconcileSession(db, toProvision, input.userName ?? null);
    const fresh = await this.store.getSession(session.id, input.userId);
    return fresh ?? session;
  }

  /**
   * Get or create the user's empty (pre-provisioned) session — the port of onyx's
   * get_or_create_empty_session. Callers hold the user's session-flow lock (the route layer
   * acquires it); here the user-level dedup is the empty-session lookup itself.
   */
  async getOrCreateEmptySession(
    db: Database,
    input: { userId: string; name?: string | null; userName?: string | null },
  ): Promise<CraftSessionRow> {
    const existing = await this.store.getEmptySessionForUser(input.userId);
    if (!existing) {
      return this.createSession(db, {
        userId: input.userId,
        name: input.name ?? null,
        userName: input.userName ?? null,
      });
    }
    if (input.name != null && input.name !== existing.name) {
      await this.store.updateSession(existing.id, { name: input.name });
    }
    // Light path: workspace intact + ACTIVE → reconcile the config and hand back.
    if (existing.status === "active") {
      await this.reconcileSessionLlmConfig(
        db,
        existing,
        input.userName ?? null,
      );
      return existing;
    }
    // Repair: rebuild under the same committed id.
    if (existing.nextjsPort === null) {
      await this.store.reserveNextjsPort({
        userId: input.userId,
        sessionId: existing.id,
        portStart: this.config.sandboxNextjsPortStart,
        portEnd: this.config.sandboxNextjsPortEnd,
      });
    }
    await this.reconcileSession(db, existing, input.userName ?? null);
    return (await this.store.getSession(existing.id, input.userId)) ?? existing;
  }

  /** Build the workspace + opencode session for a committed session, then CAS it ACTIVE. */
  private async reconcileSession(
    db: Database,
    session: CraftSessionRow,
    userName: string | null,
  ): Promise<void> {
    // A failed row repairs under the same committed id, but the provisioning
    // envelope's finalize CAS only matches `initializing` — reset FIRST so the
    // repair can succeed (F-F: otherwise every reconcile of a failed row
    // throws Stale and the session stays bricked). The reset is itself a CAS:
    // a lost race means another repair attempt owns this rebuild, and this
    // one must not provision over it.
    if (session.status === "failed") {
      const claimed = await this.store.resetFailedSessionForRepair(session.id);
      if (!claimed) {
        throw new StaleProvisioningAttemptError(
          `Session ${session.id} was claimed by a concurrent repair attempt`,
        );
      }
    }
    await ensureSessionReady({
      db,
      store: this.store,
      gateway: this.gateway,
      session,
      botId: (await this.deps.botIdFor(session.id)) ?? "",
      config: this.config,
      userName,
      organizationInstructions: this.deps.organizationInstructions ?? null,
      llmConfigFor: (s) => this.deps.llmConfigFor(s),
      mcpRelayBaseUrl: this.deps.mcpRelayBaseUrl ?? this.config.mcpRelayBaseUrl,
      // Managed content resolves inside the provisioning envelope: a failed
      // resolution fails the session (nothing is built off a payload the
      // deployment could not stand behind), and the push acks only on success.
      managedContentResolver: this.deps.managedContentFor,
    });
  }

  /**
   * Reconcile the session's opencode.json against its effective LLM config: identical file →
   * no-op (except a pending dispose); changed file → rewrite + dispose the running instance
   * (it caches config at creation). The dispose-pending marker covers the crash window
   * between write and dispose (onyx: set BEFORE the write). The tail also reconciles the
   * managed-content fingerprints (skills/MCP) — the reload half of the same converge story.
   *
   * Snapshot rule (the plan's binding constraint): when a managed-content resolver
   * is wired, ONE resolution feeds both the byte-compare's expected config and
   * any regeneration — workspace creation and reconcile can never disagree about
   * the session's MCP set. A resolution failure means the expected bytes are
   * UNKNOWN: the compare is skipped (never answered "mismatched"), so a
   * transient outage cannot strip a session's mcp block by regenerating from
   * an empty snapshot.
   */
  async reconcileSessionLlmConfig(
    _db: Database,
    session: CraftSessionRow,
    userName: string | null,
  ): Promise<void> {
    const botId = (await this.deps.botIdFor(session.id)) ?? "";
    const directory = sessionDirectory(
      session.id,
      this.config.sessionDirectoryMode,
    );
    const llmConfig = await this.deps.llmConfigFor(session);
    // onyx re-resolves the managed content for the reconcile (manager.py:288-302
    // reads connectable_apps + mcp_servers fresh); this is that one read, reused
    // for expected AND regenerate so the two cannot disagree.
    const content = this.deps.managedContentFor
      ? await this.deps.managedContentFor(session).catch(() => null)
      : null;
    // A WIRED resolver that failed leaves the expected bytes unknown — compare
    // nothing (the staleness tail retries the convergence later). An UNWIRED
    // resolver still compares: its expected config has no managed-content face.
    const expected =
      content !== null || !this.deps.managedContentFor
        ? opencodeConfigJson(
            buildProviderOpencodeConfig(llmConfig, {
              disabledTools: this.config.opencodeDisabledTools,
              gatedTools: this.config.approvalGatedTools,
              plugins: SESSION_PLUGINS,
              mcpServers: content?.mcpServers ?? [],
              sessionId: session.id,
            }),
          )
        : null;

    const fileApi = this.gateway.fileApiFor(botId);
    let current: string | null = null;
    if (fileApi) {
      try {
        const entries = await fileApi.listFiles(directory);
        void entries;
        current = await this.readWorkspaceFile(
          botId,
          `${directory}/opencode.json`,
        );
      } catch {
        // Transient failure while merely checking — assume stale and regenerate.
        current = null;
      }
    }

    if (expected !== null && current !== expected) {
      // onyx rebuilds the section for the regenerate (manager.py:346-348): the
      // app list may have changed under the session even though the model did not.
      await this.regenerateSessionConfig(
        botId,
        directory,
        session,
        llmConfig,
        userName,
        content,
      );
    } else if (expected !== null && session.opencodeSessionId) {
      // A matching file does NOT prove the running instance picked it up: a prior
      // reconcile may have written and then failed the dispose. The pending marker
      // (kept in the wiring's KV — Redis when configured) is honored by the caller
      // that owns one; phase 1 re-disposes unconditionally when a session id exists.
      await this.gateway
        .serveClientFor({ botId, directory })
        ?.disposeInstance({ directory })
        .catch(() => undefined);
    }

    if (
      session.agentProvider !== llmConfig.provider ||
      session.agentModel !== llmConfig.modelName
    ) {
      await this.store.updateSession(session.id, {
        agentProvider: llmConfig.provider,
        agentModel: llmConfig.modelName,
      });
    }

    // Managed-content staleness: a runtime that predates a skills/MCP change reloads.
    const hashes = await this.currentHashesFor(session);
    if (
      sessionRuntimeStale(
        session,
        hashes?.skillsHash ?? null,
        hashes?.mcpConfigHash ?? null,
      )
    ) {
      await this.regenerateAndAckSkills(
        session,
        botId,
        directory,
        userName,
        content,
        hashes,
      );
    }
  }

  /**
   * The session's current managed-content fingerprints, whichever seam the wiring
   * provided: an explicit hashes seam wins (cheap reads), a full resolver is
   * derived from, and neither wired answers the stable null pair.
   */
  private async currentHashesFor(session: CraftSessionRow): Promise<{
    skillsHash: string | null;
    mcpConfigHash: string | null;
  } | null> {
    if (this.deps.managedContentHashesFor) {
      return this.deps.managedContentHashesFor(session).catch(() => null);
    }
    if (this.deps.managedContentFor) {
      const content = await this.deps
        .managedContentFor(session)
        .catch(() => null);
      return content
        ? {
            skillsHash: content.skillsHash,
            mcpConfigHash: content.mcpConfigHash,
          }
        : null;
    }
    return null;
  }

  /**
   * Write the session's opencode.json + AGENTS.md into the workspace and dispose any running
   * instance (it caches config at creation). The shared "regenerate" half of the two paths
   * that make a live runtime stale: the LLM-config reconcile and the skills/MCP reload.
   */
  private async regenerateSessionConfig(
    botId: string,
    directory: string,
    session: CraftSessionRow,
    llmConfig: CraftLLMProviderConfig,
    userName: string | null,
    managedContent: ResolvedCraftManagedContent | null = null,
  ): Promise<void> {
    const expected = opencodeConfigJson(
      buildProviderOpencodeConfig(llmConfig, {
        disabledTools: this.config.opencodeDisabledTools,
        gatedTools: this.config.approvalGatedTools,
        plugins: SESSION_PLUGINS,
        mcpServers: managedContent?.mcpServers ?? [],
        sessionId: session.id,
      }),
    );
    const workspaceApi = this.gateway.workspaceApiFor(botId);
    if (workspaceApi) {
      await workspaceApi.writeFile(`${directory}/opencode.json`, expected);
      // AGENTS.md rides along (the personalization or app list may have changed too).
      const agentsMd = generateAgentInstructions({
        template: await this.template(),
        config: this.config,
        provider: llmConfig.provider,
        modelName: llmConfig.modelName,
        disabledTools: this.config.opencodeDisabledTools,
        userName,
        organizationInstructions: this.deps.organizationInstructions ?? null,
        connectableAppsSection: managedContent?.connectableAppsSection ?? null,
        companySearchSkillAvailable: managedContent
          ? companySearchSkillAvailable(managedContent)
          : false,
      });
      await workspaceApi.writeFile(`${directory}/AGENTS.md`, agentsMd);
      // The plugins the config now references must be present for sessions
      // whose workspace predates them (onyx's image bake, workspace-born).
      await writeTurnBudgetPlugin(workspaceApi, session.id, this.config);
      await writeConnectAppPlugin(workspaceApi, session.id, this.config);
      // The webapp tool refreshes the same way: plugin always, the protected
      // bootstrap script when the session holds a reserved port (the plugin
      // list change flips the byte-compare, so this regenerate is exactly the
      // dispose-on-tool-change ride-along).
      await writeWebappPlugin(workspaceApi, session.id, this.config);
      if (session.nextjsPort != null) {
        await writeWebappBootstrapScript(
          workspaceApi,
          session.id,
          this.config,
          session.nextjsPort,
        );
      }
    }
    if (session.opencodeSessionId) {
      await this.gateway
        .serveClientFor({ botId, directory })
        ?.disposeInstance({ directory })
        .catch(() => undefined);
    }
  }

  /**
   * Reload a session whose runtime predates the deployment's managed content (skills/MCP).
   * onyx's non-stale short-circuit (manager.py:367-368) is restored now that a real
   * resolver supplies hashes: an up-to-date runtime reloads nothing. A stale one
   * re-pushes the managed skills into the session workspace, rewrites the session
   * config + AGENTS.md, disposes the running instance (it caches config at
   * creation), and only then acknowledges the current hashes on the row — the
   * skills hash solely after the push landed (onyx records it on push success
   * only). Reports whether the runtime is STILL stale afterwards (a failed push
   * leaves it honestly behind; a fresh push may also have raced the read).
   */
  async reloadSessionSkills(
    session: CraftSessionRow,
    userName: string | null,
  ): Promise<boolean> {
    const botId = (await this.deps.botIdFor(session.id)) ?? "";
    const directory = sessionDirectory(
      session.id,
      this.config.sessionDirectoryMode,
    );
    const hashes = await this.currentHashesFor(session);
    if (
      !sessionRuntimeStale(
        session,
        hashes?.skillsHash ?? null,
        hashes?.mcpConfigHash ?? null,
      )
    ) {
      return false;
    }
    const content =
      (await this.deps.managedContentFor?.(session).catch(() => null)) ?? null;
    return this.regenerateAndAckSkills(
      session,
      botId,
      directory,
      userName,
      content,
      hashes,
    );
  }

  /**
   * The shared reload tail: push managed content, regenerate + dispose, ack the
   * hashes, re-derive staleness. The ack is push-gated (onyx records the skills
   * hash only when the push landed; the MCP fingerprint rides along regardless)
   * — a content-bearing reload that failed its skills push acks the mcp hash and
   * leaves the skills hash untouched, so the row honestly stays stale.
   */
  private async regenerateAndAckSkills(
    session: CraftSessionRow,
    botId: string,
    directory: string,
    userName: string | null,
    content: ResolvedCraftManagedContent | null,
    hashes: { skillsHash: string | null; mcpConfigHash: string | null } | null,
  ): Promise<boolean> {
    // A wired resolver that answered null must not drive the regenerate: the
    // rewrite would carry no managed face (the mcp block stripped, AGENTS.md
    // without its sections) while the resolver is merely down, and with the
    // hashes seam fresh the degraded bytes would ack as current. Skip — the
    // row honestly stays stale and the next pass self-heals once the resolver
    // answers again. (A hashes-only wiring has no resolver to fail and still
    // takes its contentless regenerate below.)
    if (content === null && this.deps.managedContentFor) {
      return true;
    }
    const llmConfig = await this.deps.llmConfigFor(session);
    let skillsHydrated: boolean | null = null;
    if (content) {
      const fileApi = this.gateway.fileApiFor(botId);
      skillsHydrated = fileApi
        ? await materializeManagedContent(fileApi, directory, content)
        : false;
    }
    await this.regenerateSessionConfig(
      botId,
      directory,
      session,
      llmConfig,
      userName,
      content,
    );
    const ackMcp = content?.mcpConfigHash ?? hashes?.mcpConfigHash ?? null;
    // The skills-hash ack is push-gated: a content-bearing reload acks only what
    // landed, and a WIRED resolver that failed this reload pushes nothing and so
    // acks nothing — hashes-only acks belong to wirings with no content to push.
    const ackSkills = content
      ? skillsHydrated
        ? content.skillsHash
        : undefined // push failed: keep the row's old skills hash
      : this.deps.managedContentFor
        ? undefined // resolver failed: keep the row's old skills hash too
        : (hashes?.skillsHash ?? null);
    const acked: Pick<
      CraftSessionRow,
      "status" | "origin" | "opencodeSessionId" | "skillsHash" | "mcpConfigHash"
    > = {
      ...session,
      mcpConfigHash: ackMcp,
      ...(ackSkills !== undefined ? { skillsHash: ackSkills } : {}),
    };
    await this.store.updateSession(session.id, {
      mcpConfigHash: ackMcp,
      ...(ackSkills !== undefined ? { skillsHash: ackSkills } : {}),
    });
    return sessionRuntimeStale(
      acked,
      content?.skillsHash ?? hashes?.skillsHash ?? null,
      ackMcp,
    );
  }

  private async readWorkspaceFile(
    botId: string,
    path: string,
  ): Promise<string | null> {
    // Phase-2 real read via the gateway's `/file/content` (see sandbox-gateway.ts
    // readFile). Absent/non-text → null, which degrades the opencode.json compare
    // to "regenerate" — the same safe fallback the phase-1 stub used.
    const fileApi = this.gateway.fileApiFor(botId);
    if (!fileApi) return null;
    try {
      return await fileApi.readFile(path);
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Turn driving — the yield / persist / finalize layering (headless reuse point)
  // =========================================================================

  /**
   * Drive the agent to completion, yielding raw sandbox events. No DB writes, no SSE
   * formatting — callers compose with persistSandboxEvent and (for SSE) eventToSse. The
   * events include keepalive markers; interactive callers pass them through, headless ones
   * drop them.
   */
  async *yieldSandboxEvents(
    input: {
      sessionId: string;
      botId: string;
      userMessageContent: string;
      opencodeSessionId: string | null;
      agentProvider?: string | null;
      agentModel?: string | null;
      attachments?: PromptAttachment[];
      shouldInterrupt?: (() => boolean) | null;
      shouldAbortOnTeardown?: (() => boolean) | null;
      turnTimeoutMs?: number | null;
      /**
       * The person whose turn this is — required to build the permission gate (approval rows
       * are owner-scoped). Headless callers (scheduled tasks) leave it unset and get the
       * auto-allow posture: nobody is there to ask.
       */
      userId?: string | null;
    },
    onOpencodeSessionResolved: (newId: string) => Promise<void>,
  ): AsyncGenerator<SandboxEvent | BuildPacket> {
    const directory = sessionDirectory(
      input.sessionId,
      this.config.sessionDirectoryMode,
    );
    const client = this.gateway.serveClientFor({
      botId: input.botId,
      directory,
    });
    if (!client) {
      throw new Error(`No sandbox serve client for bot ${input.botId}`);
    }

    // The permission gate only exists when gating is configured AND someone can
    // be asked: no gated tools, no store wiring, or no user → auto-allow.
    const permissionGate =
      this.deps.approvals && this.deps.approvalSignals && input.userId
        ? createCraftPermissionGate({
            config: this.config,
            approvals: this.deps.approvals,
            signals: this.deps.approvalSignals,
            sessionId: input.sessionId,
            userId: input.userId,
            botId: input.botId,
          })
        : null;
    // The connect-app rendezvous exists whenever its KV is wired — onyx wires
    // it for every turn too: a headless ask announces a card nobody sees and
    // the window's expiry declines it (the plugin's declined string), so the
    // tool stays honest about there being nobody to ask.
    const connectApp = this.deps.connectAppSignals
      ? {
          sessionId: input.sessionId,
          signals: this.deps.connectAppSignals,
        }
      : null;

    // Preflight the opencode session id: avoids one orphan session per turn, and
    // a stale persisted id (404 after a sandbox recycle) is re-minted + written
    // back via the callback so conversation history survives.
    const resolved = await client.ensureSession(input.opencodeSessionId, {
      directory,
      title: `craft-session-${input.sessionId.slice(0, 8)}`,
    });
    if (resolved !== input.opencodeSessionId) {
      await onOpencodeSessionResolved(resolved);
    }

    yield* client.sendMessage(resolved, input.userMessageContent, {
      directory,
      modelProvider: input.agentProvider ?? null,
      modelId: input.agentModel ?? null,
      attachments: input.attachments,
      timeoutMs: this.config.opencodePromptInactivityTimeoutSeconds * 1000,
      absoluteTimeoutMs: input.turnTimeoutMs ?? null,
      shouldInterrupt: input.shouldInterrupt ?? null,
      shouldAbortOnTeardown: input.shouldAbortOnTeardown ?? null,
      permissionGate,
      connectApp,
    });
  }

  /**
   * Drive one direct-to-subagent prompt to completion, yielding sandbox events — the sync-SSE
   * backing of POST /sessions/:id/subagents/:ocSessionId/send-message (onyx messages.py's
   * subagent route reusing yield_sandbox_events). No InteractiveTurn, no runner, no persistence:
   * the caller streams the events straight to the client.
   *
   * Deliberate divergence from the shared path: no ensureSession preflight. The subagent id is
   * caller-supplied; a stale one (sandbox recycled) surfaces as an opencode 404 → error frame,
   * rather than silently minting a fresh unrelated session the way ensureSession would.
   */
  async *yieldSubagentSandboxEvents(input: {
    session: CraftSessionRow;
    botId: string;
    opencodeSessionId: string;
    content: string;
    /** The requester — gates permission.asked through the session's approval rendezvous. */
    userId?: string | null;
  }): AsyncGenerator<SandboxEvent | BuildPacket> {
    const directory = sessionDirectory(
      input.session.id,
      this.config.sessionDirectoryMode,
    );
    const client = this.gateway.serveClientFor({
      botId: input.botId,
      directory,
    });
    if (!client) {
      throw new Error(`No sandbox serve client for bot ${input.botId}`);
    }

    // Same gate construction as yieldSandboxEvents: approvals ride the session's
    // announce list either way (the live list is polled independently of streams).
    const permissionGate =
      this.deps.approvals && this.deps.approvalSignals && input.userId
        ? createCraftPermissionGate({
            config: this.config,
            approvals: this.deps.approvals,
            signals: this.deps.approvalSignals,
            sessionId: input.session.id,
            userId: input.userId,
            botId: input.botId,
          })
        : null;
    const connectApp = this.deps.connectAppSignals
      ? {
          sessionId: input.session.id,
          signals: this.deps.connectAppSignals,
        }
      : null;

    yield* client.sendMessage(input.opencodeSessionId, input.content, {
      directory,
      timeoutMs: this.config.opencodePromptInactivityTimeoutSeconds * 1000,
      permissionGate,
      connectApp,
    });
  }

  /** Persistence half of a turn — see streaming.persistSandboxEvent. */
  async persistSandboxEvent(
    sessionId: string,
    state: BuildStreamingState,
    sandboxEvent: SandboxEvent | BuildPacket,
    routingMeta: Record<string, unknown> | null = null,
  ): Promise<void> {
    await persistSandboxEvent(
      this.store,
      sessionId,
      state,
      sandboxEvent,
      routingMeta,
    );
  }

  /** End-of-stream persistence — see streaming.finalizePersist. */
  async finalizePersist(
    sessionId: string,
    state: BuildStreamingState,
    routingMeta: Record<string, unknown> | null = null,
  ): Promise<void> {
    await finalizePersist(this.store, sessionId, state, routingMeta);
  }

  /** User-visible error row so a failed turn still explains itself after reload. */
  async persistTurnError(
    sessionId: string,
    turnIndex: number,
    message: string,
  ): Promise<void> {
    await this.store.createMessage({
      sessionId,
      type: "assistant",
      turnIndex,
      messageMetadata: {
        type: "error",
        message,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // =========================================================================
  // Interrupt
  // =========================================================================

  /**
   * Best-effort direct abort of the session's in-flight opencode prompt. Lock-agnostic by
   * design: any process may stop running work (abort is idempotent upstream); only *starting*
   * work is serialized by the prompt slot. The interrupt fence (turn executor) is the other
   * half of the story — it covers the window before the opencode session id exists.
   */
  async interruptMessage(session: CraftSessionRow): Promise<boolean> {
    const botId = (await this.deps.botIdFor(session.id)) ?? "";
    const directory = sessionDirectory(
      session.id,
      this.config.sessionDirectoryMode,
    );
    if (!botId) return false;
    if (!session.opencodeSessionId) return false;
    const client = this.gateway.serveClientFor({ botId, directory });
    if (!client) return false;
    await client.abort(session.opencodeSessionId, { directory });
    return true;
  }

  // =========================================================================
  // Live attach (SSE replay path)
  // =========================================================================

  /**
   * Attach to an existing opencode session and stream translated events without driving a
   * prompt — the turn executor is the durable writer; this path only observes. Emits
   * keepalive markers on the same cadence; the SSE serializer turns them into comment lines.
   *
   * `announceDrain` (onyx's merge_events_with_announces): polled once per loop iteration
   * (the loop wakes every ≤1s), each pending approval announce becomes an
   * approval_requested packet interleaved with the translated events. Keepalive semantics
   * are unchanged — announces ride between events, never in place of them.
   */
  async *subscribeToExistingSessionEvents(input: {
    session: CraftSessionRow;
    botId: string;
    keepaliveSeconds?: number;
    /** Drains the session's approval announces; null when gating is off. */
    announceDrain?: (() => Promise<string[]>) | null;
    /**
     * Drains the session's connect-app announce payloads (JSON strings, onyx's
     * ConnectAppRequest model_dump_json); each becomes a connect_app_request
     * card on this stream. Null when the handshake's KV is not wired.
     */
    connectAppAnnounceDrain?: (() => Promise<string[]>) | null;
  }): AsyncGenerator<SandboxEvent | BuildPacket> {
    const directory = sessionDirectory(
      input.session.id,
      this.config.sessionDirectoryMode,
    );
    const opencodeSessionId = input.session.opencodeSessionId;
    if (!opencodeSessionId) {
      throw new Error("Session live stream is not ready yet.");
    }
    const bus = this.gateway.eventBusFor({ botId: input.botId, directory });
    if (!bus) {
      throw new Error("No sandbox event bus configured.");
    }
    const client = this.gateway.serveClientFor({
      botId: input.botId,
      directory,
    });
    if (!client) {
      throw new Error("No sandbox serve client configured.");
    }
    const keepaliveSeconds =
      input.keepaliveSeconds ?? this.config.sseKeepaliveIntervalSeconds;

    const sub = bus.subscribe(opencodeSessionId);
    const { translateOpencodeEvent, turnStateForStream } = await import(
      "./opencode/serve-client"
    );
    const state = turnStateForStream(opencodeSessionId, this.config);

    let lastEventAt = Date.now();
    try {
      for (;;) {
        // Announce merge first: a fresh approval card goes out immediately, not
        // behind the next bus event (which may be a whole approval window away).
        if (input.announceDrain) {
          for (const approvalId of await input
            .announceDrain()
            .catch(() => [] as string[])) {
            yield approvalRequestedPacket(approvalId, input.session.id);
          }
        }

        // The connect-app cards ride the same merge (onyx's live worker pops
        // craft:connect_app:announce exactly like the approval announce list).
        if (input.connectAppAnnounceDrain) {
          for (const payload of await input
            .connectAppAnnounceDrain()
            .catch(() => [] as string[])) {
            const card = parseConnectAppAnnounce(payload);
            if (card !== null) {
              yield connectAppRequestPacket(
                card.request_id,
                card.external_app_id,
                card.reason,
              );
            }
          }
        }

        const raw = await sub.queue.shift({ timeoutMs: 1000 });
        if (raw === undefined) {
          if (Date.now() - lastEventAt >= keepaliveSeconds * 1000) {
            yield new (await import("./events/types")).SSEKeepalive();
            lastEventAt = Date.now();
          }
          continue;
        }
        if (
          raw === (await import("./opencode/event-bus")).POD_EVENT_BUS_CLOSED
        ) {
          return;
        }
        lastEventAt = Date.now();
        if (raw.type === "server.connected") continue;
        for (const event of translateOpencodeEvent(raw, state, {
          fetchMessage: null,
          parentResolver: (id) => bus.parentOf(id),
          childrenResolver: (id) => bus.listChildren(id),
          fetchMessageBySession: null,
        })) {
          if (
            !isKeepalive(event) &&
            !isBuildPacket(event) &&
            isSandboxError(event)
          ) {
            // fallthrough: errors pass through to the consumer; the route layer
            // treats `error` as terminal for the attach stream.
          }
          yield event;
        }
      }
    } finally {
      bus.unsubscribe(sub);
    }
  }
}
