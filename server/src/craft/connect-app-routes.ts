/**
 * The connect-app decision endpoint — the port of onyx
 * `external_apps/api.py:436-472` (`POST /build/apps/connect/{request_id}/decision`).
 *
 * Answers a pending connect_app request: load the stashed context and answer
 * opencode on the user's sandbox — connected (allow) / declined (reject). The
 * branch table is onyx's, strings and statuses, plus two OpenBot honesty
 * branches (OCR r3) marked below:
 *
 * | pending expired/answered/missing | 200 no-op (silent)                            |
 * | KV unreadable (load/take)        | 502 "Could not check the connect request…"    |
 * | session not the caller's own     | 404 "Connect request not found."              |
 * | session's sandbox not running    | 503 "Sandbox is not running."                 |
 * | ask already resolved upstream    | 410, terminal — no re-stash (OpenBot, r3)     |
 * | sandbox answer fails             | 502 "...please try again.", pending RESTORED  |
 * | success                          | the one audit row (the take already cleared)  |
 *
 * Idempotency is structural, onyx's way, and now also race-proof AND
 * leak-proof: the pending record is only TAKEN (atomic GET+DEL) after the
 * ownership and status checks pass, so every early exit — a non-owner holding
 * a leaked requestId (they ride SSE cards, audit rows, and logs), a paused
 * sandbox, a KV blip — leaves the record intact for its owner. Of two
 * concurrent authorized replays only one wins the take: one answer to
 * opencode and one audit row — one approval attempt, one answer, ever. And
 * unlike the gated-tool approvals, the handshake keeps NO approval row (onyx
 * parity: two KV records, no DB), so the audit write below is the decision's
 * one durable record.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AuditStore } from "../audit";
import type { AppVariables } from "../auth/public";
import type { CraftConfig } from "./config";
import type {
  CraftConnectAppPending,
  CraftConnectAppSignals,
} from "./connect-app";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import { sessionDirectory } from "./workspace";

const logger = getLogger("server");

export type ConnectAppRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  botIdFor: (sessionId: string) => Promise<string | null>;
  /** The handshake's KV (pending stash + announce), shared with the turn consumer. */
  signals: CraftConnectAppSignals;
  /** The decision's audit row; null keeps the endpoint working without one. */
  audit?: Pick<AuditStore, "insert"> | null;
};

export function createConnectAppRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: ConnectAppRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.post("/apps/connect/:requestId/decision", async (context) => {
    const actor = context.var.actor;
    const requestId = context.req.param("requestId");
    const body = (await context.req.json().catch(() => ({}))) as {
      decision?: unknown;
    };
    if (body.decision !== "connected" && body.decision !== "declined") {
      return context.json(
        { error: "decision must be connected or declined" },
        400,
      );
    }

    // Branch 1: expired / already answered / unknown → 200 no-op, silent. Load
    // FIRST (read-only), authorize, THEN take: the destructive take must only
    // fire for the owner of a live session — any earlier exit leaves the
    // record intact, so a leaked requestId can no longer cancel someone's
    // decision (a non-owner's 404/503 consumed the record pre-fix). A KV
    // failure here is an honest 502, never the silent no-op: with the record
    // unreadable, a 200 would claim "already answered" without evidence.
    let pending: CraftConnectAppPending | null;
    try {
      pending = await deps.signals.loadPending(requestId);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "[craft] connect_app pending load failed",
      );
      return context.json(
        {
          error: "Could not check the connect request — please try again.",
          retryable: true,
        },
        502,
      );
    }
    if (pending === null) {
      return context.json({ ok: true });
    }

    // Branch 2: scope to the caller's own session BEFORE touching their sandbox.
    const session = await deps.store.getSession(
      pending.build_session_id,
      actor.id,
    );
    if (!session) {
      return context.json({ error: "Connect request not found." }, 404);
    }

    // Branch 3: the sandbox must be live to receive the answer. OpenBot's
    // lifecycle keeps no separate sandbox row — an ACTIVE session IS the
    // running sandbox (session-ready's CAS contract).
    if (session.status !== "active") {
      return context.json({ error: "Sandbox is not running." }, 503);
    }

    // The take stays the idempotency gate: of two concurrent replays only one
    // caller wins it; the loser lands here with null and no-ops. (A take that
    // fails mid-flight is retried the same way — the record is either still
    // there or the answer already happened.)
    let taken: CraftConnectAppPending | null;
    try {
      taken = await deps.signals.takePending(requestId);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "[craft] connect_app pending take failed",
      );
      return context.json(
        {
          error: "Could not check the connect request — please try again.",
          retryable: true,
        },
        502,
      );
    }
    if (taken === null) {
      return context.json({ ok: true });
    }

    // Branch 4: apply the choice on the sandbox the ask parked on.
    const botId = (await deps.botIdFor(session.id)) ?? "";
    const client = botId
      ? deps.gateway.serveClientFor({
          botId,
          directory: sessionDirectory(
            pending.build_session_id,
            deps.config.sessionDirectoryMode,
          ),
        })
      : null;
    const answered = client
      ? await client.answerPermission(
          pending.opencode_session_id,
          pending.perm_id,
          {
            allow: body.decision === "connected",
            directory: pending.directory,
          },
        )
      : { ok: false, permissionGone: false };
    if (answered.permissionGone) {
      // opencode pins the semantics (1.18.7, verified live): the first answer
      // deletes the pending entry and every re-answer 404s with
      // PermissionNotFoundError — a false-negative answer (applied but
      // response lost) makes every retry 404 forever. Terminal, then: do NOT
      // re-stash (a resurrected card could never be answered), no audit row
      // (this side cannot prove the choice took effect upstream) — the retry
      // loop's cap.
      return context.json(
        {
          error:
            "This connect request is no longer answerable — it was already " +
            "resolved or expired upstream.",
          retryable: false,
        },
        410,
      );
    }
    if (!answered.ok) {
      // The take already removed the record; put it back so the user can
      // retry (the pre-take posture: a failed answer retains its pending).
      let restored = true;
      try {
        await deps.signals.stashPending(requestId, pending);
      } catch (error) {
        restored = false;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "[craft] connect_app pending re-stash failed",
        );
      }
      return context.json(
        {
          error:
            "Could not reach the sandbox to apply your choice — please try again.",
          // The record could not be restored: a retry will silently no-op
          // (200), so the client must not treat this as retryable.
          retryable: restored,
        },
        502,
      );
    }

    // Success needs no explicit clear — the take removed the record the moment
    // this caller won it, so any replay lands in the no-op branch above.
    await deps.audit
      ?.insert({
        eventType: "craft.connect_app_decided",
        targetType: "craft_connect_app",
        targetId: requestId,
        actorUserId: actor.id,
        payload: {
          decision: body.decision,
          session: session.id,
          ...(pending.external_app_id !== undefined
            ? { external_app_id: pending.external_app_id }
            : {}),
        },
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "[craft] connect_app decision audit failed",
        );
      });
    return context.json({ ok: true });
  });

  return app;
}
