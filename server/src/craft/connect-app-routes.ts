/**
 * The connect-app decision endpoint — the port of onyx
 * `external_apps/api.py:436-472` (`POST /build/apps/connect/{request_id}/decision`).
 *
 * Answers a pending connect_app request: load the stashed context and answer
 * opencode on the user's sandbox — connected (allow) / declined (reject). The
 * branch table is onyx's, strings and statuses:
 *
 * | pending expired/answered/missing | 200 no-op (silent)                            |
 * | session not the caller's own     | 404 "Connect request not found."              |
 * | session's sandbox not running    | 503 "Sandbox is not running."                 |
 * | sandbox answer fails             | 502 "...please try again.", pending RESTORED  |
 * | success                          | the one audit row (the take already cleared)  |
 *
 * Idempotency is structural, onyx's way, and now also race-proof: the pending
 * record is TAKEN atomically (GET+DEL), so even two concurrent replays of the
 * same requestId produce exactly one answer to opencode and one audit row —
 * one approval attempt, one answer, ever. And unlike the gated-tool approvals,
 * the handshake keeps NO approval row (onyx parity: two KV records, no DB), so
 * the audit write below is the decision's one durable record.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { CraftConfig } from "./config";
import type { CraftConnectAppSignals } from "./connect-app";
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

    // Branch 1: expired / already answered / unknown / LOST THE RACE → 200
    // no-op, silent. The take (atomic GET+DEL) is the idempotency itself: of
    // two concurrent replays of the same requestId only one caller ever sees
    // the record, so only one answer to opencode and one audit row can exist.
    const pending = await deps.signals.takePending(requestId).catch(() => null);
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
      : false;
    if (!answered) {
      // The take already removed the record; put it back so the user can
      // retry (the pre-take posture: a failed answer retains its pending).
      await deps.signals
        .stashPending(requestId, pending)
        .catch((error: unknown) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "[craft] connect_app pending re-stash failed",
          );
        });
      return context.json(
        {
          error:
            "Could not reach the sandbox to apply your choice — please try again.",
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
