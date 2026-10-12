/**
 * The craft HTTP surface: /api/craft/**, mounted by app.ts when the deployment enables it.
 *
 * `createCraftRoutes` is the assembly factory in the workshop's shape: the caller (boot file)
 * hands over the full wiring — config, db, store, manager, executor, state stores, gateway —
 * plus the auth pair, and receives one Hono app with the three route files merged. No global
 * singletons: two deployments can mount two independent craft trees.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { ApprovalStore } from "../approvals/types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import type { RedisPort } from "../redis";
import { createCraftApprovalSignals } from "./approval-signals";
import { createCraftApprovalRoutes } from "./approvals";
import { createArtifactRoutes } from "./artifact-routes";
import type { CraftConfig } from "./config";
import { createFileRoutes } from "./file-routes";
import { createInterruptFence } from "./interrupt";
import { createSessionFlowLocks } from "./locks";
import { CraftSessionManager } from "./manager";
import { createMessageRoutes } from "./message-routes";
import type { CraftLLMProviderConfig } from "./opencode-config";
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
import { createCraftStore } from "./store";
import { createTurnExecutor } from "./turn-executor";
import { createTurnRoutes } from "./turn-routes";
import { createTurnStateStore } from "./turn-state";
import { createWebappProxyRoutes } from "./webapp-proxy";

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
  /** The user's display name (AGENTS.md personalization). */
  userNameFor: (userId: string) => Promise<string | null>;
  /** Organization-level craft instructions; null when unset. */
  organizationInstructions?: string | null;
  /** Optional one-shot LLM call for session naming (deterministic fallback without it). */
  generateName?: (system: string, user: string) => Promise<string>;
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
  const store = createCraftStore(db);
  const objectStore = createObjectStore(config.storage);
  const gateway = createSandboxGateway({
    config,
    connectionFor: (botId) => {
      const conn = deps.sandboxConnectionFor(botId);
      return conn ? { botId, baseUrl: conn.baseUrl, token: conn.token } : null;
    },
  });
  // The approval rendezvous signals (announce + wake), Redis-backed when the
  // deployment runs multi-replica, in-process otherwise — turn-state's shape.
  const approvalSignals = createCraftApprovalSignals({ redis });
  const manager = new CraftSessionManager({
    config,
    store,
    gateway,
    llmConfigFor: async (session) => deps.llmConfigFor(session),
    botIdFor: (sessionId) => deps.botIdFor(sessionId),
    organizationInstructions: deps.organizationInstructions ?? null,
    approvals: deps.approvals,
    approvalSignals,
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
  });

  const app = new Hono<{ Variables: AppVariables }>();
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
    createTurnRoutes(requireUser, {
      config,
      store,
      manager,
      turnState,
      executor,
      gateway,
      botIdFor: deps.botIdFor,
      approvalSignals,
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
  if (config.webappProxyEnabled) {
    app.route(
      "/",
      createWebappProxyRoutes(requireUser, {
        config,
        store,
        gateway,
        botIdFor: deps.botIdFor,
        sandboxConnectionFor: deps.sandboxConnectionFor,
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
