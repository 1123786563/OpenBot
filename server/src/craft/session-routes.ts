/**
 * Craft session management routes — ported from onyx `session/api.py`, Hono-shaped, first
 * phase (no snapshots/webapp-proxy/docx: those endpoints are phase 2 and the report's §五
 * table carries the reasoning).
 *
 * Endpoint set here: GET/POST /sessions, GET /sessions/:id, PUT /sessions/:id/name, PATCH
 * /sessions/:id/public, DELETE /sessions/:id, POST /sessions/:id/generate-name, GET
 * /sessions/:id/pre-provisioned-check, GET /sessions/:id/sandbox-status (the header chip's
 * poll), POST /sessions/:id/snapshot, POST /sessions/:id/restore (the wake: an idle session
 * replays its newest snapshot and returns active), POST /sessions/:id/skills/reload (the
 * explicit managed-content refresh: regenerate config + dispose + ack hashes).
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";

const logger = getLogger("server");

import type { CraftConfig } from "./config";
import type { SessionFlowLocks } from "./locks";
import type { CraftSessionManager } from "./manager";
import { generateSessionName } from "./naming";
import type { SandboxGateway } from "./sandbox-gateway";
import { sandboxScopeRefusalOf, scopeRefusalResponse } from "./scope-refusal";
import { sessionRuntimeStale } from "./skills";
import {
  deleteSnapshots,
  restoreLatestSnapshot,
  takeSnapshot,
} from "./snapshot";
import type { ObjectStore } from "./storage/object-store";
import type { CraftSessionRow, CraftStore } from "./store";
import type { TurnStateStore } from "./turn-state";

type Json = Record<string, unknown>;

/**
 * The sandbox lifecycle values the chip renders — onyx's SandboxStatus enum verbatim
 * (db/enums.py:489). "restoring" is client-derived (the wake fetch's in-flight window) and
 * "terminated" could only come from a future sandbox backend; neither is answered here, but
 * both belong to the wire union the chip consumes.
 */
export type CraftSandboxStatus =
  | "provisioning"
  | "running"
  | "sleeping"
  | "restoring"
  | "terminated"
  | "failed";

export type SessionRoutesDeps = {
  db: Database;
  config: CraftConfig;
  store: CraftStore;
  manager: CraftSessionManager;
  locks: SessionFlowLocks;
  gateway: SandboxGateway;
  objectStore: ObjectStore;
  /** Resolves the Bot whose sandbox hosts a session (snapshot/restore I/O routes through it). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** Optional one-shot LLM for name generation (deterministic fallback without it). */
  generateName?: (system: string, user: string) => Promise<string>;
  /** The user's display name (AGENTS.md personalization on session create). */
  userNameFor: (userId: string) => Promise<string | null>;
  /** The live-turn admission check the skills/reload endpoint borrows (onyx's prompt slot). */
  turnState: TurnStateStore;
  /**
   * The deployment's current managed-content fingerprints (skills payload + craft MCP set),
   * the seam the manager's staleness contract reads. The craft assembly derives it from the
   * managed-content resolver (or answers the stable null pair when none is wired) — every
   * `skills_stale` below derives through the real predicate, never a literal.
   */
  managedContentHashesFor?: (
    session: CraftSessionRow,
  ) => Promise<{ skillsHash: string | null; mcpConfigHash: string | null }>;
};

export function sessionResponse(
  session: CraftSessionRow,
  skillsStale: boolean,
  extra: Json = {},
): Json {
  return {
    id: session.id,
    user_id: session.userId,
    name: session.name,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    last_activity_at: session.lastActivityAt.toISOString(),
    nextjs_port: session.nextjsPort,
    sharing_scope: session.sharingScope,
    origin: session.origin,
    agent_provider: session.agentProvider,
    agent_model: session.agentModel,
    opencode_session_id: session.opencodeSessionId,
    skills_stale: skillsStale,
    ...extra,
  };
}

export function createSessionRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: SessionRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  /** The snapshot context hand all four sleep/wake operations need. */
  const snapshotCtx = () => ({
    config: deps.config,
    store: deps.store,
    gateway: deps.gateway,
    objectStore: deps.objectStore,
  });

  /**
   * Whether a session's runtime predates the deployment's managed content — derived through
   * the real predicate (skills.ts) against the hashes the wiring provides, never a literal.
   * onyx reads the pair off the sandbox row; the hashes fetch is best-effort (a transient
   * failure answers "not stale", the same safe direction a null hash answers).
   */
  const skillsStaleFor = async (session: CraftSessionRow): Promise<boolean> => {
    const hashes = await deps
      .managedContentHashesFor?.(session)
      .catch(() => null);
    return sessionRuntimeStale(
      session,
      hashes?.skillsHash ?? null,
      hashes?.mcpConfigHash ?? null,
    );
  };

  /**
   * The wake half of sleep/wake: an IDLE session is restored from its newest snapshot (when one
   * exists) and CASed back to active before it answers a detail fetch. A missing snapshot is not
   * an error — the sandbox is warm here, so the workspace is still intact and the next turn's
   * reconcile rebuilds whatever is missing.
   *
   * #618 (FR-F1): the scope refusal is the one wake failure that is not best-effort — but only
   * the restore entrance surfaces it (`surfaceScopeRefusal`), because the detail read must stay
   * available in a scopeless deployment (the turn face carries the refusal when the person
   * actually acts); silently degrading the WAKE itself into "no snapshot" was the mask T2 saw.
   *
   * #618 (OCR#11): a SWALLOWED refusal must not CAS the row active either — "200 + active +
   * nothing restored" was the same mask moved onto the detail face, and it stranded the restore
   * entrance's 503 behind the warm fast path. The row honestly stays idle (detail shows
   * sleeping), so POST restore — and the turn — keep their chance to surface the refusal.
   *
   * #618 (OCRFX-F4, info): non-refusal failures — the gateway's thrown restore 403 among
   * them — still fold to false here (rebuild, CAS active), the pre-#618 route-face answer;
   * OCR#5's honesty therefore lives at the gateway contract, not yet at the HTTP face.
   * Whether the routes should carry that verdict too is a registered later ruling.
   */
  const wakeIfIdle = async (
    session: CraftSessionRow,
    options: { surfaceScopeRefusal?: boolean } = {},
  ): Promise<CraftSessionRow> => {
    if (session.status !== "idle") return session;
    const botId = await deps.botIdFor(session.id);
    if (botId) {
      let scopeRefused = false;
      const restored = await restoreLatestSnapshot(snapshotCtx(), {
        botId,
        sessionId: session.id,
      }).catch((error) => {
        const refusal = sandboxScopeRefusalOf(error);
        if (refusal && options.surfaceScopeRefusal) throw refusal;
        if (refusal) scopeRefused = true;
        return false;
      });
      if (scopeRefused) return session; // not woken: keep idle, keep the entrances reachable
      // #618 (OCR r3 #4): a missing snapshot row (or an evicted blob) means
      // restoreLatestSnapshot never dialed — the refusal had no chance to throw,
      // and the surface entrance would CAS active behind a wake that ran nothing.
      // Assert the scope with ZERO dials before the CAS, so the restore entrance's
      // 503 does not depend on a snapshot existing.
      if (options.surfaceScopeRefusal && !restored) {
        deps.gateway.assertExecutionScope();
      }
    }
    const updated = await deps.store.updateSession(session.id, {
      status: "active",
    });
    return updated ?? session;
  };

  // ── GET /sessions — the sidebar list ────────────────────────────────────────
  app.get("/sessions", async (context) => {
    const actor = context.var.actor;
    const sessions = await deps.store.listUserSessions(actor.id);
    return context.json({
      sessions: await Promise.all(
        sessions.map(async (session) =>
          sessionResponse(session, await skillsStaleFor(session)),
        ),
      ),
    });
  });

  // ── POST /sessions — create or reuse the empty pre-provisioned session ─────
  app.post("/sessions", async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => ({}))) as {
      name?: unknown;
    };
    const name = typeof body.name === "string" ? body.name : null;
    try {
      const session = await deps.locks.withSessionCreationLock(
        actor.id,
        async () =>
          deps.manager.getOrCreateEmptySession(deps.db, {
            userId: actor.id,
            name,
            userName: await deps.userNameFor(actor.id),
          }),
      );
      return context.json(
        sessionResponse(session, await skillsStaleFor(session), {
          session_loaded_in_sandbox: true,
        }),
        201,
      );
    } catch (error) {
      // #618 (FR-F1): a scopeless deployment is an answerable, admin-fixable condition —
      // the fixed sentence as 503, not the generic 500 T2 saw swallow it. Like the file
      // face, no log line and no echoed value: the sentence IS the reason and names none.
      const refusalResponse = scopeRefusalResponse(context, error);
      if (refusalResponse) return refusalResponse;
      logger.error(
        { error: error instanceof Error ? error.stack : String(error) },
        "[craft] session creation failed",
      );
      return context.json({ error: "Session creation failed" }, 500);
    }
  });

  // ── GET /sessions/:sessionId ────────────────────────────────────────────────
  app.get("/sessions/:sessionId", async (context) => {
    const actor = context.var.actor;
    const session = await deps.store.getSession(
      context.req.param("sessionId"),
      actor.id,
    );
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const woken = await wakeIfIdle(session);
    return context.json(
      sessionResponse(woken, await skillsStaleFor(woken), {
        // #618 (OCR r3 #1): derive from the wake result — a refused wake kept the
        // row idle and loaded nothing into any sandbox, so a hardcoded true would
        // contradict the status: "sleeping" right beside it. (No app/src consumer
        // reads the flag today; create answers true after a real build, restore
        // only answers after a wake that ran.)
        session_loaded_in_sandbox: woken.status !== "idle",
      }),
    );
  });

  // ── PUT /sessions/:sessionId/name ───────────────────────────────────────────
  app.put("/sessions/:sessionId/name", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const body = (await context.req.json().catch(() => ({}))) as {
      name?: unknown;
    };
    if (typeof body.name !== "string" || body.name.length === 0) {
      return context.json({ error: "name is required" }, 400);
    }
    const updated = await deps.store.updateSession(sessionId, {
      name: body.name,
    });
    const row = updated ?? session;
    return context.json(sessionResponse(row, await skillsStaleFor(row)));
  });

  // ── POST /sessions/:sessionId/generate-name ────────────────────────────────
  app.post("/sessions/:sessionId/generate-name", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const name = await generateSessionName(
      { db: deps.db, store: deps.store, generateName: deps.generateName },
      sessionId,
    );
    const updated = await deps.store.updateSession(sessionId, { name });
    return context.json({ name: updated?.name ?? name });
  });

  // ── PATCH /sessions/:sessionId/public ──────────────────────────────────────
  app.patch("/sessions/:sessionId/public", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const body = (await context.req.json().catch(() => ({}))) as {
      sharing_scope?: unknown;
    };
    if (
      body.sharing_scope !== "private" &&
      body.sharing_scope !== "public_org"
    ) {
      return context.json(
        { error: "sharing_scope must be private or public_org" },
        400,
      );
    }
    const updated = await deps.store.updateSession(sessionId, {
      sharingScope: body.sharing_scope,
    });
    return context.json({
      session_id: sessionId,
      sharing_scope: updated?.sharingScope ?? body.sharing_scope,
    });
  });

  // ── DELETE /sessions/:sessionId ─────────────────────────────────────────────
  app.delete("/sessions/:sessionId", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const deleted = await deps.store.deleteSession(sessionId, actor.id);
    if (!deleted) {
      return context.json({ error: "Session not found" }, 404);
    }
    // Force-free the snapshot blobs before the row cascade drops their rows — the object store
    // has no FK, so an orphaned archive is otherwise permanent.
    await deleteSnapshots(snapshotCtx(), sessionId).catch(() => undefined);
    return context.body(null, 204);
  });

  // ── GET /sessions/:sessionId/sandbox-status — the header chip's one read ────
  app.get("/sessions/:sessionId/sandbox-status", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    // Deliberately findSession, NOT getSession: the detail read bumps lastActivityAt, and a chip
    // polling every 30s would reset the reaper's idle clock forever — the poll must be free.
    const session = await deps.store.findSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const botId = await deps.botIdFor(sessionId);
    const status = await sandboxStatusFor(deps, session, botId);
    return context.json({ status });
  });

  // ── GET /sessions/:sessionId/pre-provisioned-check ─────────────────────────
  app.get("/sessions/:sessionId/pre-provisioned-check", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ valid: false, session_id: null });
    }
    const hasMessages = await deps.store.sessionHasMessages(sessionId);
    return context.json(
      hasMessages
        ? { valid: false, session_id: null }
        : { valid: true, session_id: sessionId },
    );
  });

  // ── POST /sessions/:sessionId/snapshot — take a snapshot now ────────────────
  app.post("/sessions/:sessionId/snapshot", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    const botId = await deps.botIdFor(sessionId);
    if (!botId) {
      return context.json({ error: "Sandbox unavailable" }, 503);
    }
    try {
      const row = await takeSnapshot(snapshotCtx(), { botId, sessionId });
      return context.json(
        {
          snapshot_id: row.id,
          size_bytes: row.sizeBytes,
          created_at: row.createdAt.toISOString(),
        },
        201,
      );
    } catch (error) {
      // #618 (FR-F1): same recognizer, same 503, before the generic 502 — the snapshot
      // dial is an outbound request like any other and must not wear "Snapshot failed".
      const refusalResponse = scopeRefusalResponse(context, error);
      if (refusalResponse) return refusalResponse;
      logger.error({ error }, "[craft] snapshot failed");
      return context.json({ error: "Snapshot failed" }, 502);
    }
  });

  // ── POST /sessions/:sessionId/restore — wake from a snapshot ───────────────
  app.post("/sessions/:sessionId/restore", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    // The real sleep/wake chain: an idle session replays its newest snapshot and returns
    // active; an already-active session is the warm fast path (nothing to restore).
    // #618 (FR-F1): the wake's scope refusal surfaces here — this IS the lifecycle
    // entrance for waking, and "wake quietly degraded to a rebuild" is not an answer a
    // person can act on. Everything else keeps the route's original no-catch shape.
    try {
      const woken = await wakeIfIdle(session, { surfaceScopeRefusal: true });
      return context.json(
        sessionResponse(woken, await skillsStaleFor(woken), {
          session_loaded_in_sandbox: true,
        }),
      );
    } catch (error) {
      const refusalResponse = scopeRefusalResponse(context, error);
      if (refusalResponse) return refusalResponse;
      throw error;
    }
  });

  // ── POST /sessions/:sessionId/skills/reload — the explicit refresh ─────────
  app.post("/sessions/:sessionId/skills/reload", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    // onyx guards the reload with the prompt slot ("wait for the current turn to
    // finish", fail-closed); the active-turn pointer is this port's equivalent
    // admission check — rewriting opencode.json under a live turn is exactly what
    // it prevents, and a turn-state outage answers "try again", never "go ahead".
    const active = await deps.turnState
      .getActiveTurn({ sessionId, userId: actor.id })
      .catch(() => "unavailable" as const);
    if (active === "unavailable") {
      return context.json(
        { error: "Turn state is unavailable; retry the reload." },
        503,
      );
    }
    if (active !== null) {
      return context.json(
        {
          error: "Wait for the current turn to finish before reloading skills.",
        },
        409,
      );
    }
    try {
      const skillsStale = await deps.manager.reloadSessionSkills(
        session,
        await deps.userNameFor(actor.id),
      );
      return context.json({ skills_stale: skillsStale });
    } catch (error) {
      // #618 (OCR#1): reload is a person's explicit action, and its file writes route
      // through the gateway — a scopeless deployment answers the fixed 503 sentence
      // BEFORE the generic 502, the same contract create/snapshot/restore already
      // carry (the turn face carries the refusal when the person actually acts).
      const refusalResponse = scopeRefusalResponse(context, error);
      if (refusalResponse) return refusalResponse;
      logger.error({ error }, "[craft] skills reload failed");
      return context.json({ error: "Failed to reload session." }, 502);
    }
  });

  return app;
}

/**
 * Derive the chip's sandbox state. onyx reads a sandbox row; OpenBot has no sandbox rows — the
 * agent-sandbox gateway hosts every session in one shared Bot workspace, so the answer is
 * derived, never stored:
 *
 * - failed session → "failed" (provisioning could not complete for it)
 * - idle session   → "sleeping" (the reaper snapshotted it; wakeIfIdle restores on the next detail read)
 * - initializing   → "provisioning" (the workspace reconcile has not CASed the row active yet)
 * - active         → probe the gateway's opencode-serve: reachable = "running"; unreachable =
 *   "provisioning" — the closest onyx value, honest here because the gateway spawns a Bot's
 *   runtime lazily and reaps it idle, so "not answering yet" is a cold start, not a failure.
 *   A scopeless deployment's refusal is the one probe failure that is NOT a cold start (#618
 *   OCR#12): it answers "failed", the settled state the chip renders red. Note the order:
 *   an IDLE row answers "sleeping" before any probe, so with OCR#11's honest-idle CAS the
 *   chip shows "failed" only on active rows — an idle session's fail-closed display waits
 *   for the turn/restore entrance to surface the sentence (OCRFX-F5, info).
 *   A session whose Bot is not even configured has no sandbox to speak of: null (onyx's
 *   "no sandbox record" answer).
 *
 * "terminated" is never derived — in this topology no per-session sandbox exists to terminate
 * (the reaper's documented divergence); "restoring" stays client-owned, as in onyx.
 */
async function sandboxStatusFor(
  deps: Pick<SessionRoutesDeps, "gateway">,
  session: CraftSessionRow,
  botId: string | null,
): Promise<CraftSandboxStatus | null> {
  if (session.status === "failed") return "failed";
  if (session.status === "idle") return "sleeping";
  if (session.status === "initializing") return "provisioning";
  if (!botId) return null;
  try {
    const alive = await deps.gateway.healthCheck(botId);
    return alive ? "running" : "provisioning";
  } catch (error) {
    // #618 (OCR#12): a missing scope is an admin-level permanent failure, not a cold
    // start — the probe rethrows the displayable refusal, and the chip wears the
    // settled red "failed" instead of a "provisioning" that can never clear.
    // OCR r3 #2: recognize it the way every entrance's catch does — the bare
    // instanceof only matched while healthCheck's chain propagated bare errors;
    // any future wrap (bot context, an error enhancer) would silently fold back
    // into the eternal "provisioning" this branch exists to kill.
    if (sandboxScopeRefusalOf(error)) return "failed";
    return "provisioning"; // a probe outage stays a cold start, the pre-#618 answer
  }
}
