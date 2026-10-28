/**
 * Craft approval routes + helpers — wired into OpenBot's `approvals/*` system.
 *
 * onyx gates sandbox actions through its egress proxy and waits on a Redis announce/wake
 * channel, recording decisions in `action_approval`/`action_receipt` tables. OpenBot has no
 * egress proxy; the producer is opencode's own `permission.asked` instead (see
 * approval-gate.ts — gated tools get an "ask" rule, the waiting turn polls the wake signal).
 * What this file owns is the read/write surface the UI talks to:
 *
 *   - `approvalRequests.runId` doubles as the craft session id (a pure-text column, no schema
 *     change), so a pending request is "owned" by the session whose turn produced it.
 *   - The decision endpoint writes through the raw `ApprovalStore`'s quiet path (`decideQuiet`):
 *     the same row + audit as `decide`, but none of its orchestration effects — no
 *     `approval.resume` work item for the worker queue (craft's waiter is woken by the
 *     announce/wake signals above) and no always-rule (craft has no rule surface; allow_always
 *     behaves as allow_once, the sandbox answering the ask "once" either way). Like `open`, it
 *     is the raw store, not the coordination-wrapped `approvalService.store`.
 *   - Decide semantics follow onyx: the same decision replays idempotently, a different one
 *     is a 409; after the row is written the parked waiter is woken (a missed wake falls back
 *     to its wait window). EXPIRED stays derived — the shared status CHECK has no such value,
 *     so expiry is the producer's reject + the live read's window, never a row mutation.
 */

import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { ApprovalRecord, ApprovalStore } from "../approvals/types";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
} from "../approvals/types";
import type { AppVariables } from "../auth/guards";
import type { CraftApprovalSignals } from "./approval-signals";
import type { CraftConfig } from "./config";
import type { CraftStore } from "./store";

const logger = getLogger("server");

/** What identifies one craft action awaiting a decision. */
export type CraftApprovalCandidate = {
  /** The session whose turn produced the action — links both `runId` and `threadId`. */
  sessionId: string;
  /** The owner (actorId == ownerUserId == the person being asked). */
  userId: string;
  /** The Bot whose sandbox hosts the session (approval rule matching key). */
  botId: string;
  /** The approval id minted by the sandbox (`toolCallId` linkage). */
  approvalId: string;
  toolRef: string;
  effect: string;
  scope: string;
  args: unknown;
};

/** Stable digest over the action identity — the same shape `ApprovalRecord.actionDigest` holds. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function craftApprovalDigest(candidate: CraftApprovalCandidate): string {
  return createHash("sha256")
    .update(
      canonical({
        actorId: candidate.userId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        args: candidate.args,
      }),
    )
    .digest("hex");
}

/** Open a pending approval request through the raw store (the producer seam, no side effects). */
export async function openCraftApproval(
  approvals: ApprovalStore,
  candidate: CraftApprovalCandidate,
): Promise<ApprovalRecord> {
  return approvals.open({
    actorId: candidate.userId,
    botId: candidate.botId,
    toolRef: candidate.toolRef,
    effect: candidate.effect,
    scope: candidate.scope,
    args: candidate.args,
    runId: candidate.sessionId,
    threadId: candidate.sessionId,
    toolCallId: candidate.approvalId,
    actionDigest: craftApprovalDigest(candidate),
  });
}

/**
 * The pending requests a session is waiting on, still inside the approval window. Rows past
 * `maxAgeSeconds` are treated as orphans and dropped — onyx's live read expired them the same
 * way out of Redis.
 */
export async function listLiveApprovals(params: {
  approvals: ApprovalStore;
  sessionId: string;
  userId: string;
  maxAgeSeconds: number;
}): Promise<ApprovalRecord[]> {
  const all = await params.approvals.list(params.userId);
  const cutoff = Date.now() - params.maxAgeSeconds * 1000;
  return all.filter(
    (record) =>
      record.status === "pending" &&
      record.action.runId === params.sessionId &&
      record.createdAt.getTime() >= cutoff,
  );
}

function craftApprovalResponse(
  record: ApprovalRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    decision: record.decision,
    created_at: record.createdAt.toISOString(),
    action: {
      bot_id: record.action.botId,
      tool_ref: record.action.toolRef,
      effect: record.action.effect,
      scope: record.action.scope,
      args: record.action.args,
    },
  };
}

export type CraftApprovalRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  approvals: ApprovalStore;
  /** Announce/wake signals; decide wakes the parked waiter through these. */
  signals?: CraftApprovalSignals | null;
};

export function createCraftApprovalRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: CraftApprovalRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  // ── GET /sessions/:sessionId/approvals/live ────────────────────────────────
  app.get("/sessions/:sessionId/approvals/live", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const session = await deps.store.getSession(sessionId, actor.id);
    if (!session) {
      return context.json({ error: "Session not found" }, 404);
    }
    const live = await listLiveApprovals({
      approvals: deps.approvals,
      sessionId,
      userId: actor.id,
      maxAgeSeconds: deps.config.approvalWaitTimeoutSeconds,
    });
    return context.json({ approvals: live.map(craftApprovalResponse) });
  });

  // ── POST /approvals/:approvalId/decision ───────────────────────────────────
  app.post("/approvals/:approvalId/decision", async (context) => {
    const actor = context.var.actor;
    const approvalId = context.req.param("approvalId");
    const body = ((await context.req.json().catch(() => ({}))) ?? {}) as {
      decision?: unknown;
    };
    if (
      body.decision !== "allow_once" &&
      body.decision !== "allow_always" &&
      body.decision !== "deny"
    ) {
      return context.json(
        { error: "decision must be allow_once, allow_always, or deny" },
        400,
      );
    }
    try {
      // onyx parity: same decision → idempotent; different decision → conflict.
      const current = await deps.approvals.get(actor.id, approvalId);
      // Craft-origin only: rows the generic gate opens carry `action.policy`; the rows
      // `openCraftApproval` mints never do. A policy row must go through the generic decide
      // — whose hand_off guard ("handled"/"deny" only, never an allow) and always-rule write
      // this quiet path skips — so it is not found here, whatever its status.
      if (current.action?.policy) {
        return context.json(
          { error: "This endpoint only decides craft approvals." },
          404,
        );
      }
      if (current.status !== "pending") {
        if (current.decision === body.decision) {
          // Idempotent replay still re-fires the wake: the first one may have been
          // lost (it is best-effort) or the process may have died between the row
          // write and the wake, and the parked waiter is the reason this exists.
          await deps.signals
            ?.sendWake(approvalId, body.decision)
            .catch((error: unknown) => {
              logger.warn({ error }, "[craft] approval decision wake failed");
            });
          return context.json({ ok: true });
        }
        return context.json(
          { error: "This request was already decided." },
          409,
        );
      }
      // Craft's own write path: the row lands (approved/denied + audit) without the generic
      // decide's worker resume item or always-rule write — both are noise for craft rows (no
      // continuation to resume; no rule surface to grant), and the wake below is the real
      // unparker. allow_always lands verbatim and replays idempotently, but behaves as
      // allow_once: no persistent grant is written.
      await deps.approvals.decideQuiet(actor.id, approvalId, body.decision);
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) {
        return context.json({ error: "Approval not found" }, 404);
      }
      if (error instanceof ApprovalRefusedError) {
        // The store's own guard: a decide race between two writers.
        return context.json(
          { error: "This request was already decided." },
          409,
        );
      }
      logger.error({ error }, "[craft] approval decision failed");
      return context.json({ error: "Decision failed" }, 500);
    }
    // Wake the parked waiter (best-effort; a miss falls back to its wait window).
    await deps.signals
      ?.sendWake(approvalId, body.decision)
      .catch((error: unknown) => {
        logger.warn({ error }, "[craft] approval decision wake failed");
      });
    return context.json({ ok: true });
  });

  return app;
}
