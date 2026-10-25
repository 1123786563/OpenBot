/**
 * The craft HTTP surface: /api/craft/**, mounted by app.ts when the deployment enables it.
 *
 * `createCraftRoutes` is the assembly factory in the workshop's shape: the caller (boot file)
 * hands over the full wiring — config, db, store, manager, executor, state stores, gateway —
 * plus the auth pair, and receives one Hono app with the three route files merged. No global
 * singletons: two deployments can mount two independent craft trees.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { ExecutionScope } from "../../../shared/execution-scope";
import type { ApprovalStore } from "../approvals/types";
import { createAuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import type { RedisPort } from "../redis";
import { createCraftApprovalSignals } from "./approval-signals";
import { createCraftApprovalRoutes } from "./approvals";
import { createArtifactRoutes } from "./artifact-routes";
import type { CraftConfig } from "./config";
import { createCraftConnectAppSignals } from "./connect-app";
import { createConnectAppRoutes } from "./connect-app-routes";
import { createFileRoutes } from "./file-routes";
import { createInterruptFence } from "./interrupt";
import { createSessionFlowLocks } from "./locks";
import type { CraftManagedContentResolver } from "./managed-content";
import { CraftSessionManager } from "./manager";
import {
  type CraftMcpConnectionResolver,
  createCraftMcpRelayApp,
} from "./mcp-relay";
import { createMessageRoutes } from "./message-routes";
import type { CraftLLMProviderConfig } from "./opencode-config";
import type { PreviewTickets } from "./preview-ticket";
import { createSandboxGateway } from "./sandbox-gateway";
import {
  createCraftScheduledTaskStore,
  createScheduledRunRoutes,
  createScheduledTaskRoutes,
  fireAndForgetRun,
  startCraftScheduledTaskSweeper,
} from "./scheduled-tasks";
import { createSessionRoutes } from "./session-routes";
import { type CraftIdleReaper, startCraftIdleReaper } from "./snapshot";
import { createObjectStore } from "./storage/object-store";
import type { CraftSessionRow, CraftStore } from "./store";
import { createCraftStore } from "./store";
import { createSubagentRoutes } from "./subagent-routes";
import { createTurnExecutor } from "./turn-executor";
import { createTurnRoutes } from "./turn-routes";
import { createTurnStateStore } from "./turn-state";
import { generationGatedWebappBasePathFor } from "./webapp-generation";
import { createWebappProxyRoutes } from "./webapp-proxy";
import { sessionDirectory } from "./workspace";
import { createCraftWriteOriginGuard } from "./write-origin-guard";

export type CraftRoutesDeps = {
  config: CraftConfig;
  db: Database;
  redis: RedisPort | null;
  /**
   * The raw approval store craft's decision surface reads/writes through — NOT the
   * coordination-wrapped `approvalService.store` (its `open` runs orchestration side effects).
   */
  approvals: ApprovalStore;
  /** Resolves the Bot whose sandbox hosts a session (all sandbox routing flows through it). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Resolves a session's effective LLM config (the deployment's model catalog wiring). */
  llmConfigFor: (session: {
    agentProvider: string | null;
    agentModel: string | null;
  }) => Promise<CraftLLMProviderConfig>;
  /** Connection facts for a Bot's sandbox (gateway URL + token). */
  sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
  /**
   * The deployment's execution ownership every sandbox request states (#618, MT050):
   * the boot file threads the SAME lambda every craft gateway assembly consumes
   * (same-facts discipline); unset callers fall back to the config's parsed pair
   * inside the gateway — one source either way, never a per-request user value.
   */
  executionScopeFor?: () => ExecutionScope | null;
  /** The user's display name (AGENTS.md personalization). */
  userNameFor: (userId: string) => Promise<string | null>;
  /** Organization-level craft instructions; null when unset. */
  organizationInstructions?: string | null;
  /** Optional one-shot LLM call for session naming (deterministic fallback without it). */
  generateName?: (system: string, user: string) => Promise<string>;
  /**
   * The deployment's current managed-content fingerprints (skills payload + craft MCP set)
   * to compare a session's recorded hashes against — the seam the manager's staleness
   * contract and `skills_stale` derive through. onyx reads these off the sandbox row. When
   * unset, both derive from the resolver below instead; when neither is wired the answer is
   * the stable null pair (nothing pushed → nothing stale, the honest answer while no
   * managed-content pipeline is wired).
   */
  managedContentHashesFor?: (
    session: CraftSessionRow,
  ) => Promise<{ skillsHash: string | null; mcpConfigHash: string | null }>;
  /**
   * Resolves the session owner's managed content (connectable-apps section, skill
   * fileset, craft MCP set, fingerprints) — the real managed-content layer. When wired,
   * `skills_stale` derives from it unless an explicit hashes seam overrides, and the
   * reload path re-pushes the content it resolves.
   */
  managedContentFor?: CraftManagedContentResolver;
  /**
   * The connector domain's credential resolution for the MCP relay (the trusted
   * side): the vendor url + the owner's decrypted credential for one forwarded
   * call, or null. Unset = the relay answers 403 not_authorized for everything
   * (fail closed — the mcp set stays empty in that wiring anyway).
   */
  mcpConnectionFor?: CraftMcpConnectionResolver | null;
  /** The base the sandbox dials back on (the MCP relay). */
  mcpRelayBaseUrl?: string | null;
  /**
   * The store override: production leaves it unset and the assembly derives the standard
   * store from `db`; an alternate assembly (the tests' in-memory rows) hands over its own
   * so the factory's wiring — not a specific store — is what gets exercised.
   */
  store?: CraftStore;
  /**
   * The process's ONE preview-ticket table (#360): the issuing route mints through
   * this instance and the preview origin's entry redeems against the SAME one —
   * the boot file constructs it; unset leaves the routes' own in-memory default
   * (tests that exercise the primitive in isolation).
   */
  previewTickets?: PreviewTickets;
  /**
   * The preview origin's per-session address (#361's admission-aware derivation —
   * the replacement for #360's `defaultPreviewOrigin()` default, which the review
   * flagged for converging on serverPort's PORT/SERVER_PORT semantics).
   */
  previewOriginFor?: (sessionId: string) => string;
  /**
   * The preview origin's admission (#362): webapp-info surfaces the closed
   * reason (m-5) and the ticket route refuses to mint while it refuses — the
   * same gate the boot file's preview-origin dispatcher branch enforces.
   */
  previewOriginAdmission?: () => { ok: true } | { ok: false; reason: string };
  /**
   * The registry half of the same-origin liveness probe (fix-ocr13): the
   * preview origin's hasSession — false is the restart verdict (M-2).
   */
  previewOriginHas?: (sessionId: string) => boolean;
  /**
   * The session's dev-form /<label> mount (F-2, #365): the preview origin's
   * webappBasePathFor, threaded through the manager into the protected start
   * script so the dev-form preview's resource URLs carry the label. Unset =
   * root-path scripts (host form, closed origin — production unchanged).
   */
  webappBasePathFor?: (sessionId: string) => string | null;
  /**
   * #410: the origins the write-origin guard trusts alongside the request's own
   * host — CORS's own list (`TRUSTED_ORIGINS` + app URL), passed through so the
   * two surfaces can never disagree about who is trusted. Unset = the empty
   * list: Host same-origin only, fail closed.
   */
  previewWriteTrustedOrigins?: readonly string[];
  /**
   * #410: the preview origin's Origin-header claim (`PreviewOrigin.claimsOrigin`)
   * — the same host rule the dispatcher runs on the Host header. Unset = claims
   * nothing, which leaves the guard's allow-list as the only judgment.
   */
  previewOriginClaimsOrigin?: (origin: string) => boolean;
};

/**
 * What app.ts mounts — the workshop's factory shape (requireUser only: craft's sandbox
 * routing is deployment-level, so there is no canUseBot question to answer here).
 */
export type CraftRoutesFactory = (input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) => Hono<{ Variables: AppVariables }>;

/**
 * The process's one idle reaper, started by the first craft assembly and replaced by any later
 * one (a second mount stops the first — the interval is process-global, the route tree is not).
 * Held at module scope so `stopCraftIdleReaper` can give the boot file's shutdown hook the off
 * switch; the timer itself is unref'd, so a stop-less exit never hangs on it either.
 */
let runningIdleReaper: CraftIdleReaper | null = null;

/** Stop the assembled idle reaper (boot-file shutdown hook). Idempotent. */
export function stopCraftIdleReaper(): void {
  runningIdleReaper?.stop();
  runningIdleReaper = null;
}

export function createCraftRoutes(input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  deps: CraftRoutesDeps;
}): Hono<{ Variables: AppVariables }> {
  const { requireUser, deps } = input;
  const { config, db, redis } = deps;

  // ── the wiring (one assembly; everything below is dependency order) ──
  const store = deps.store ?? createCraftStore(db);
  const objectStore = createObjectStore(config.storage);
  const gateway = createSandboxGateway({
    config,
    connectionFor: (botId) => {
      const conn = deps.sandboxConnectionFor(botId);
      return conn ? { botId, baseUrl: conn.baseUrl, token: conn.token } : null;
    },
    // #618: the boot file's scope lambda when it wired one (same facts as every other
    // craft gateway assembly); otherwise the gateway reads the config's parsed pair.
    executionScopeFor: deps.executionScopeFor,
  });
  // The approval rendezvous signals (announce + wake), Redis-backed when the
  // deployment runs multi-replica, in-process otherwise — turn-state's shape.
  const approvalSignals = createCraftApprovalSignals({ redis });
  // The connect-app handshake's KV (pending stash + announce), same shape.
  const connectAppSignals = createCraftConnectAppSignals({ redis });
  /**
   * The ONE hashes derivation the whole assembly shares — the manager's staleness
   * contract (reload/reconcile) and `skills_stale` both read through it, so the two can
   * never disagree: an explicit hashes function wins (cheap reads), a full resolver is
   * derived from, and neither wired is the stable null pair (nothing pushed → nothing
   * stale). Forcing a null pair here instead would freeze `skills/reload` into a
   * permanent no-op while `skills_stale` kept answering true — no convergence.
   */
  const resolver = deps.managedContentFor ?? null;
  const managedContentHashesFor = async (
    session: CraftSessionRow,
  ): Promise<{ skillsHash: string | null; mcpConfigHash: string | null }> => {
    if (deps.managedContentHashesFor) {
      return deps.managedContentHashesFor(session);
    }
    const content = resolver ? await resolver(session).catch(() => null) : null;
    return content
      ? {
          skillsHash: content.skillsHash,
          mcpConfigHash: content.mcpConfigHash,
        }
      : { skillsHash: null, mcpConfigHash: null };
  };
  const manager = new CraftSessionManager({
    config,
    store,
    gateway,
    llmConfigFor: async (session) => deps.llmConfigFor(session),
    botIdFor: (sessionId) => deps.botIdFor(sessionId),
    organizationInstructions: deps.organizationInstructions ?? null,
    approvals: deps.approvals,
    approvalSignals,
    connectAppSignals,
    managedContentFor: deps.managedContentFor,
    managedContentHashesFor,
    mcpRelayBaseUrl: deps.mcpRelayBaseUrl ?? config.mcpRelayBaseUrl,
    /*
     * #367 (D10): the mount the start script injects is GENERATION-gated — a
     * legacy session's script stays root-path so the app's old cwd-fallback
     * template keeps mounting the same-origin prefix the legacy preview path
     * serves. One gate here feeds every script write (provisioning, repair,
     * LLM-config regenerate, skills reload), so the script and webapp-info can
     * never disagree about where a session's app lives.
     */
    webappBasePathFor: deps.webappBasePathFor
      ? generationGatedWebappBasePathFor({
          webappBasePathFor: deps.webappBasePathFor,
          fileApiFor: (botId) => gateway.fileApiFor(botId),
          botIdFor: (sessionId) => deps.botIdFor(sessionId),
          sessionDirectoryFor: (sessionId) =>
            sessionDirectory(sessionId, config.sessionDirectoryMode),
        })
      : undefined,
  });
  const turnState = createTurnStateStore({ redis, config });
  const fence = createInterruptFence(redis);
  const locks = createSessionFlowLocks(redis);
  const executor = createTurnExecutor({
    db,
    config,
    store,
    manager,
    turnState,
    fence,
    botIdFor: deps.botIdFor,
    gateway,
  });

  const app = new Hono<{ Variables: AppVariables }>();

  // The MCP relay mounts BEFORE requireUser: its caller is the sandbox's
  // opencode MCP client, which authenticates with the session-tag header the
  // relay itself validates (an unattributable tag is a 403, never a dial).
  // Registered first so Hono's registration-order matching lets it answer
  // without the user guard ever running for these paths.
  app.route(
    "/",
    createCraftMcpRelayApp({
      store,
      sessionMcpServersFor: async (session) => {
        const content = resolver
          ? await resolver(session).catch(() => null)
          : null;
        return content?.mcpServers ?? [];
      },
      resolveConnection: deps.mcpConnectionFor ?? (async () => null),
    }),
  );

  // #410: the cookie-authenticated write surface refuses a foreign browser Origin
  // — a production preview is a subdomain of the main site, so SameSite never
  // withholds the platform cookie there and CSP is only the browser-side half.
  // Registered on the pre-guard tier's edge: AFTER the two relays above (their
  // caller is the sandbox, authenticating by session tag and sending no Origin),
  // BEFORE requireUser (a cross-site write is refused on its Origin alone, with
  // no store lookup and no session answered). See write-origin-guard.ts.
  app.use(
    "*",
    createCraftWriteOriginGuard({
      trustedOrigins: deps.previewWriteTrustedOrigins ?? [],
      isPreviewOrigin: deps.previewOriginClaimsOrigin ?? (() => false),
    }),
  );

  app.use("*", requireUser);

  // Enabled-gate: everything below 503s (not 404s) when the flag is off mid-flight,
  // so a misconfigured mount is legible. (app.ts normally avoids mounting at all.)
  app.use("*", async (context, next) => {
    if (!config.enabled) {
      return context.json({ error: "Craft is not available." }, 503);
    }
    await next();
  });

  app.route(
    "/",
    createSessionRoutes(requireUser, {
      db,
      config,
      store,
      manager,
      locks,
      gateway,
      objectStore,
      botIdFor: deps.botIdFor,
      generateName: deps.generateName,
      userNameFor: deps.userNameFor,
      turnState,
      managedContentHashesFor,
    }),
  );
  app.route(
    "/",
    createMessageRoutes(requireUser, {
      config,
      store,
      manager,
      turnState,
      executor,
      botIdFor: deps.botIdFor,
      fence,
    }),
  );
  app.route(
    "/",
    createSubagentRoutes(requireUser, {
      store,
      manager,
      botIdFor: deps.botIdFor,
    }),
  );
  app.route(
    "/",
    createTurnRoutes(requireUser, {
      config,
      store,
      manager,
      turnState,
      executor,
      botIdFor: deps.botIdFor,
      approvalSignals,
      connectAppSignals,
    }),
  );
  app.route(
    "/",
    createArtifactRoutes(requireUser, {
      config,
      store,
      gateway,
      botIdFor: deps.botIdFor,
    }),
  );
  app.route(
    "/",
    createFileRoutes(requireUser, {
      config,
      store,
      gateway,
      botIdFor: deps.botIdFor,
    }),
  );
  app.route(
    "/",
    createCraftApprovalRoutes(requireUser, {
      config,
      store,
      approvals: deps.approvals,
      signals: approvalSignals,
    }),
  );
  app.route(
    "/",
    createConnectAppRoutes(requireUser, {
      config,
      store,
      gateway,
      botIdFor: deps.botIdFor,
      signals: connectAppSignals,
      audit: {
        insert: (event) => recordAuditEvent(createAuditStore(db), event),
      },
    }),
  );
  if (config.webappProxyEnabled) {
    app.route(
      "/",
      createWebappProxyRoutes(requireUser, {
        config,
        store,
        gateway,
        botIdFor: deps.botIdFor,
        sandboxConnectionFor: deps.sandboxConnectionFor,
        previewTickets: deps.previewTickets,
        previewOriginFor: deps.previewOriginFor,
        previewOriginAdmission: deps.previewOriginAdmission,
        previewOriginHas: deps.previewOriginHas,
      }),
    );
  }
  if (config.idleReaperEnabled) {
    // The sleep half of sleep/wake, started at assembly beside the routes it serves. The sweep
    // snapshots each quiet session then flips it idle through the guarded CAS — never touching
    // the shared Bot sandbox itself (the divergence snapshot.ts documents). A live interactive
    // turn keeps a session awake even when its row is quiet; an errored check does too
    // (fail-closed), so `hasActiveTurn` throws are "still busy", not "skip the check".
    runningIdleReaper?.stop();
    runningIdleReaper = startCraftIdleReaper(
      { config, store, gateway, objectStore },
      {
        botIdFor: deps.botIdFor,
        hasActiveTurn: async ({ id, userId }) =>
          (await turnState.getActiveTurn({ sessionId: id, userId })) !== null,
      },
    );
  }
  if (config.enableScheduledTasks) {
    // The scheduled-task seam, all assembled here (the store owns the rows, the fire-and-forget
    // runner drives the headless turn through `manager`, and the sweeper is the single-process
    // cron dispatcher — unref'd, owned by this boot, mirroring the idle reaper's shape).
    const tasks = createCraftScheduledTaskStore(db);
    const enqueueRun = fireAndForgetRun({
      db,
      config,
      store,
      tasks,
      manager,
      botIdFor: deps.botIdFor,
    });
    startCraftScheduledTaskSweeper({ tasks, enqueueRun });
    app.route(
      "/",
      createScheduledTaskRoutes(requireUser, {
        tasks,
        enqueueRun,
      }),
    );
    app.route(
      "/",
      createScheduledRunRoutes(requireUser, {
        tasks,
        store,
        config,
        manager,
        botIdFor: deps.botIdFor,
      }),
    );
  }

  return app;
}
