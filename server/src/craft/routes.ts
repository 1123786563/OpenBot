/**
 * The craft HTTP surface: /api/craft/**, mounted by app.ts when the deployment enables it.
 *
 * `createCraftRoutes` is the assembly factory in the workshop's shape: the caller (boot file)
 * hands over the full wiring — config, db, store, manager, executor, state stores, gateway —
 * plus the auth pair, and receives one Hono app with the three route files merged. No global
 * singletons: two deployments can mount two independent craft trees.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import type { RedisPort } from "../redis";
import type { CraftConfig } from "./config";
import { createInterruptFence } from "./interrupt";
import { createSessionFlowLocks } from "./locks";
import { CraftSessionManager } from "./manager";
import { createMessageRoutes } from "./message-routes";
import type { CraftLLMProviderConfig } from "./opencode-config";
import { createSandboxGateway } from "./sandbox-gateway";
import { createSessionRoutes } from "./session-routes";
import { createCraftStore } from "./store";
import { createTurnExecutor } from "./turn-executor";
import { createTurnRoutes } from "./turn-routes";
import { createTurnStateStore } from "./turn-state";

export type CraftRoutesDeps = {
  config: CraftConfig;
  db: Database;
  redis: RedisPort | null;
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

export function createCraftRoutes(input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  deps: CraftRoutesDeps;
}): Hono<{ Variables: AppVariables }> {
  const { requireUser, deps } = input;
  const { config, db, redis } = deps;

  // ── the wiring (one assembly; everything below is dependency order) ──
  const store = createCraftStore(db);
  const gateway = createSandboxGateway({
    config,
    connectionFor: (botId) => {
      const conn = deps.sandboxConnectionFor(botId);
      return conn ? { botId, baseUrl: conn.baseUrl, token: conn.token } : null;
    },
  });
  const manager = new CraftSessionManager({
    config,
    store,
    gateway,
    llmConfigFor: async (session) => deps.llmConfigFor(session),
    botIdFor: (sessionId) => deps.botIdFor(sessionId),
    organizationInstructions: deps.organizationInstructions ?? null,
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
    }),
  );

  return app;
}
