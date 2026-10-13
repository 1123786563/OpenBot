/**
 * The craft approval producer — the OpenBot answer to onyx's parked-proxy rendezvous.
 *
 * onyx gates sandbox actions inside its egress proxy: the proxy opens an `action_approval`
 * row, announces it, and parks on `approval:wake:{id}` until the decide endpoint answers or
 * SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS (180s) passes, then rejects. OpenBot has no egress
 * proxy, so the producer hooks the same rendezvous onto opencode's own `permission.asked`:
 * a tool in `OPENBOT_CRAFT_APPROVAL_GATED_TOOLS` gets an "ask" rule in opencode.json, and
 * when opencode asks, the turn's event consumer (serve-client) opens a craft approval row,
 * announces it, and polls the wake signal every 0.5s inside its loop — never blocking the
 * event translation, keepalive cadence, or interrupt checks (see serve-client's PermissionGate).
 *
 * The wait resolves three ways, onyx's exact semantics:
 * - decision recorded → the waiter answers opencode `once` (allow_once/allow_always) or
 *   `reject` (deny);
 * - window expires → the waiter answers `reject`; the row itself stays pending in the shared
 *   store (its status CHECK has no EXPIRED value — expiry is derived: the live read drops it
 *   once the window passes, and a late decide on it still lands harmlessly, as in onyx);
 * - turn dies/aborts first → the pending permission is left unanswered upstream, same as onyx
 *   discarding its `_TurnState`.
 */

import { getLogger } from "../../../shared/logger";
import type { ApprovalStore } from "../approvals/types";
import type { CraftApprovalSignals } from "./approval-signals";
import { openCraftApproval } from "./approvals";
import type { CraftConfig } from "./config";
import type {
  PermissionAskedInfo,
  PermissionGate,
  PermissionGateDecision,
} from "./opencode/serve-client";

const logger = getLogger("server");

/** Exact-match against the configured gated set (trim handled at config load). */
export function isToolGated(
  permission: string | null,
  gatedTools: readonly string[],
): boolean {
  return permission !== null && gatedTools.includes(permission);
}

export type CreateCraftPermissionGateInput = {
  config: CraftConfig;
  approvals: ApprovalStore;
  signals: CraftApprovalSignals;
  /** The craft session whose turn produced the ask — owns the approval rows. */
  sessionId: string;
  /** The owner being asked (the approval store is owner-scoped). */
  userId: string;
  /** The Bot whose sandbox hosts the session. */
  botId: string;
};

/**
 * Bind one turn's permission gate: `isGated` routes the ask, `open` registers + announces the
 * row, `poll` is the 0.5s heartbeat the serve-client loop calls for each pending permission.
 * A new gate per turn (per `yieldSandboxEvents` call) — openedAt bookkeeping is turn-local.
 */
export function createCraftPermissionGate(
  input: CreateCraftPermissionGateInput,
): PermissionGate {
  const { config, approvals, signals, sessionId, userId, botId } = input;
  const windowMs = config.approvalWaitTimeoutSeconds * 1000;
  const openedAt = new Map<string, number>();

  return {
    sessionId,
    isGated(info: PermissionAskedInfo): boolean {
      return isToolGated(info.permission, config.approvalGatedTools);
    },
    async open(info: PermissionAskedInfo): Promise<string> {
      const record = await openCraftApproval(approvals, {
        sessionId,
        userId,
        botId,
        approvalId: info.permissionId,
        toolRef: info.permission ?? "unknown",
        effect: "execute",
        scope: info.patterns[0] ?? "*",
        args: { permission: info.permission, patterns: info.patterns },
      });
      openedAt.set(record.id, Date.now());
      // Best-effort, onyx parity: a missed announce degrades to the frontend's
      // next live-approvals refetch, never to a lost approval.
      await signals.announce(sessionId, record.id).catch((error: unknown) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "[craft] approval announce failed",
        );
      });
      return record.id;
    },
    async poll(approvalId: string): Promise<PermissionGateDecision | null> {
      const startedAt = openedAt.get(approvalId) ?? Date.now();
      // Wake first (cheap KV read); the row is only fetched once a wake landed or
      // the window passed — a missed wake falls back to the window, never a DB poll.
      const wake = await signals
        .takeWake(approvalId)
        .catch(() => null as string | null);
      const aged = Date.now() - startedAt >= windowMs;
      if (wake === null && !aged) return null;
      let decision: PermissionGateDecision | null = null;
      try {
        const record = await approvals.get(userId, approvalId);
        if (record.status !== "pending" && record.decision !== null) {
          decision =
            record.decision === "allow_once" ||
            record.decision === "allow_always"
              ? record.decision
              : "deny"; // deny | handled both mean "don't run it"
        }
      } catch {
        // Row vanished (FK cascade, store failure): let the window expire it.
      }
      if (decision !== null) return decision;
      return aged ? "expired" : null; // spurious wake, row still pending → keep waiting
    },
  };
}
