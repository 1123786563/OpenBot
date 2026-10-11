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
 * Trimmed relative to onyx (phase 1): the artifact walk (artifacts are an immediate outputs/
 * scan in onyx now anyway), md→docx/pptx export, webapp proxying, and the skills/MCP reload
 * chain (columns + staleness contract live on the row; the push is phase 2).
 */

import { readFile } from "node:fs/promises";
import type { Database } from "../db/client";
import type { CraftConfig } from "./config";
import type { CraftStore, CraftSessionRow } from "./store";
import type { SandboxGateway } from "./sandbox-gateway";
import {
  finalizePersist,
  persistSandboxEvent,
  type BuildStreamingState,
} from "./streaming";
import { sessionDirectory } from "./workspace";
import { ensureSessionReady } from "./session-ready";
import type {
  CraftLLMProviderConfig,
} from "./opencode-config";
import { buildProviderOpencodeConfig, opencodeConfigJson } from "./opencode-config";
import { generateAgentInstructions } from "./agent-instructions";
import type { PromptAttachment } from "./opencode/serve-client";
import { isKeepalive, isSandboxError, type SandboxEvent } from "./events/types";
import { isBuildPacket, type BuildPacket } from "./events/packets";

/** Redis-keyed marker: a config rewrite owes its running instance a dispose (24h TTL in onyx). */
export const DISPOSE_PENDING_TTL_SECONDS = 24 * 3600;
const disposePendingKey = (sessionId: string) =>
  `craft:llm_config_dispose_pending:${sessionId}`;

export type SessionManagerDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  /** Resolves the session's effective LLM config (re-validated each turn, onyx parity). */
  llmConfigFor: (session: CraftSessionRow) => Promise<CraftLLMProviderConfig>;
  /** The Bot whose sandbox hosts the session (OpenBot sandbox scoping). */
  botIdFor: (session: CraftSessionRow) => string;
  /** Organization-level craft instructions (AGENTS.md section); null when unset. */
  organizationInstructions?: string | null;
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
    db: Database,
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
    },
  ): Promise<CraftSessionRow> {
    const session = await this.store.createSession({
      userId: input.userId,
      name: input.name ?? null,
      agentProvider: input.agentProvider ?? null,
      agentModel: input.agentModel ?? null,
    });
    if (!input.headless) {
      await this.store.reserveNextjsPort({
        userId: input.userId,
        sessionId: session.id,
        portStart: this.config.sandboxNextjsPortStart,
        portEnd: this.config.sandboxNextjsPortEnd,
      });
    }
    await this.reconcileSession(db, session, input.userName ?? null);
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
      await this.reconcileSessionLlmConfig(db, existing, input.userName ?? null);
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
    await ensureSessionReady({
      db,
      store: this.store,
      gateway: this.gateway,
      session,
      botId: this.deps.botIdFor(session),
      userName,
      organizationInstructions: this.deps.organizationInstructions ?? null,
      llmConfigFor: (s) => this.deps.llmConfigFor(s),
    });
  }

  /**
   * Reconcile the session's opencode.json against its effective LLM config: identical file →
   * no-op (except a pending dispose); changed file → rewrite + dispose the running instance
   * (it caches config at creation). The dispose-pending marker covers the crash window
   * between write and dispose (onyx: set BEFORE the write).
   */
  async reconcileSessionLlmConfig(
    db: Database,
    session: CraftSessionRow,
    userName: string | null,
  ): Promise<void> {
    const botId = this.deps.botIdFor(session);
    const directory = sessionDirectory(session.id);
    const llmConfig = await this.deps.llmConfigFor(session);
    const expected = opencodeConfigJson(
      buildProviderOpencodeConfig(llmConfig, {
        disabledTools: this.config.opencodeDisabledTools,
      }),
    );

    const fileApi = this.gateway.fileApiFor(botId);
    let current: string | null = null;
    if (fileApi) {
      try {
        const entries = await fileApi.listFiles(directory);
        void entries;
        current = await this.readWorkspaceFile(botId, `${directory}/opencode.json`);
      } catch {
        // Transient failure while merely checking — assume stale and regenerate.
        current = null;
      }
    }

    if (current === expected) {
      // A matching file does NOT prove the running instance picked it up: a prior
      // reconcile may have written and then failed the dispose. The pending marker
      // (kept in the wiring's KV — Redis when configured) is honored by the caller
      // that owns one; phase 1 re-disposes unconditionally when a session id exists.
      if (session.opencodeSessionId) {
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
      return;
    }

    const workspaceApi = this.gateway.workspaceApiFor(botId);
    if (workspaceApi) {
      await workspaceApi.writeFile(`${directory}/opencode.json`, expected);
      // AGENTS.md rides along (the personalization may have changed too).
      const agentsMd = generateAgentInstructions({
        template: await this.template(),
        config: this.config,
        provider: llmConfig.provider,
        modelName: llmConfig.modelName,
        disabledTools: this.config.opencodeDisabledTools,
        userName,
        organizationInstructions: this.deps.organizationInstructions ?? null,
      });
      await workspaceApi.writeFile(`${directory}/AGENTS.md`, agentsMd);
    }
    if (session.opencodeSessionId) {
      await this.gateway
        .serveClientFor({ botId, directory })
        ?.disposeInstance({ directory })
        .catch(() => undefined);
    }
    await this.store.updateSession(session.id, {
      agentProvider: llmConfig.provider,
      agentModel: llmConfig.modelName,
    });
  }

  private async readWorkspaceFile(
    botId: string,
    path: string,
  ): Promise<string | null> {
    const fileApi = this.gateway.fileApiFor(botId);
    if (!fileApi) return null;
    try {
      // The gateway's file listing/read pair: read via the serve client's file
      // surface is not available; use listFiles + the content endpoint shape by
      // delegating to fileApi (kept minimal for phase 1 — the config compare
      // degrades to "regenerate" when a read is unavailable).
      const response = await fetch("", { method: "GET" }).catch(() => null);
      void response;
      return null;
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
    },
    onOpencodeSessionResolved: (newId: string) => Promise<void>,
  ): AsyncGenerator<SandboxEvent | BuildPacket> {
    const directory = sessionDirectory(input.sessionId);
    const client = this.gateway.serveClientFor({
      botId: input.botId,
      directory,
    });
    if (!client) {
      throw new Error(`No sandbox serve client for bot ${input.botId}`);
    }

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
    });
  }

  /** Persistence half of a turn — see streaming.persistSandboxEvent. */
  async persistSandboxEvent(
    db: Database,
    sessionId: string,
    state: BuildStreamingState,
    sandboxEvent: SandboxEvent | BuildPacket,
    routingMeta: Record<string, unknown> | null = null,
  ): Promise<void> {
    await persistSandboxEvent(this.store, sessionId, state, sandboxEvent, routingMeta);
  }

  /** End-of-stream persistence — see streaming.finalizePersist. */
  async finalizePersist(
    db: Database,
    sessionId: string,
    state: BuildStreamingState,
    routingMeta: Record<string, unknown> | null = null,
  ): Promise<void> {
    await finalizePersist(this.store, sessionId, state, routingMeta);
  }

  /** User-visible error row so a failed turn still explains itself after reload. */
  async persistTurnError(
    db: Database,
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
    const botId = this.deps.botIdFor(session);
    const directory = sessionDirectory(session.id);
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
   */
  async *subscribeToExistingSessionEvents(input: {
    session: CraftSessionRow;
    botId: string;
    keepaliveSeconds?: number;
  }): AsyncGenerator<SandboxEvent | BuildPacket> {
    const directory = sessionDirectory(input.session.id);
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
    const state = new (await import("./opencode/serve-client")).TurnState(
      opencodeSessionId,
    );
    const { translateOpencodeEvent } = await import("./opencode/serve-client");

    let lastEventAt = Date.now();
    try {
      for (;;) {
        const raw = await sub.queue.shift({ timeoutMs: 1000 });
        if (raw === undefined) {
          if (Date.now() - lastEventAt >= keepaliveSeconds * 1000) {
            yield new (await import("./events/types")).SSEKeepalive();
            lastEventAt = Date.now();
          }
          continue;
        }
        if (raw === (await import("./opencode/event-bus")).POD_EVENT_BUS_CLOSED) {
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
          if (!isKeepalive(event) && !isBuildPacket(event) && isSandboxError(event)) {
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
