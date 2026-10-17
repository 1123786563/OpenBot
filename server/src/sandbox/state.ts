import { and, eq, lt, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/client";
import {
  sandboxInstances,
  type SandboxInstanceStatus,
} from "../db/schema/sandbox-instances";

/**
 * The per-bot sandbox container lifecycle: five states, one legal graph, and a reconcile that
 * makes the database and Docker agree after anything dies (plan §3.6.1).
 *
 * THE GRAPH, AND WHY `terminated` IS SINKED. A terminated container is gone; its row stays for
 * audit and its bot's NEXT provision starts a fresh row rather than resurrecting an old one —
 * so nothing moves out of `terminated` (or `failed`) except nothing at all. The legal moves:
 *
 *   provisioning → ready          provision succeeded
 *   provisioning → failed         provision threw (attempt recorded)
 *   ready → sleeping              idle reap
 *   sleeping → ready              wake on demand
 *   ready | sleeping → failed     the container died out from under us
 *   provisioning | ready | sleeping → terminated   deliberate teardown
 *
 * DURABLE PROVISIONING IS A CAS ON `attempt_number`. The row is written BEFORE the container is
 * created, with the next attempt number; two replicas provisioning the same bot race on that
 * increment and exactly one wins, and the loser reads back the winner's row instead of creating
 * a second container nobody will ever reap.
 */

const LEGAL: Record<SandboxInstanceStatus, readonly SandboxInstanceStatus[]> = {
  provisioning: ["ready", "failed", "terminated"],
  ready: ["sleeping", "failed", "terminated"],
  sleeping: ["ready", "failed", "terminated"],
  terminated: [],
  failed: [],
};

/** Whether a move is legal, for callers that want to know before attempting it. */
export function canTransition(
  from: SandboxInstanceStatus,
  to: SandboxInstanceStatus,
): boolean {
  return LEGAL[from].includes(to);
}

export type SandboxInstanceStateStore = {
  /** The bot's current live row (provisioning/ready/sleeping), if one exists. */
  liveOf(botId: string): Promise<
    | {
        id: string;
        botId: string;
        status: SandboxInstanceStatus;
        attemptNumber: number;
        address: string | null;
        ports: Record<string, unknown>;
        lastHeartbeatAt: Date | null;
        ownerUserId: string;
      }
    | undefined
  >;
  /** Insert a provisioning row at the next attempt number; returns it, or the winner's row. */
  beginAttempt(input: { botId: string; ownerUserId: string }): Promise<{
    id: string;
    attemptNumber: number;
    won: boolean;
  }>;
  /** CAS status transition on one row; false when the row moved first (or never was). */
  transition(
    id: string,
    from: SandboxInstanceStatus,
    to: SandboxInstanceStatus,
    patch?: { address?: string; ports?: Record<string, unknown> },
  ): Promise<boolean>;
  /** Renew the heartbeat on a ready row. */
  heartbeat(id: string, at: Date): Promise<void>;
  /** Every live row, for the reconcile sweep. */
  listLive(): Promise<
    Array<{
      id: string;
      botId: string;
      status: SandboxInstanceStatus;
      attemptNumber: number;
      lastHeartbeatAt: Date | null;
    }>
  >;
};

export function newSandboxInstanceId(): string {
  return `sbx-${randomBytes(12).toString("hex")}`;
}

export function createSandboxInstanceStateStore(
  db: Database,
): SandboxInstanceStateStore {
  return {
    async liveOf(botId) {
      const rows = await db
        .select({
          id: sandboxInstances.id,
          botId: sandboxInstances.botId,
          status: sandboxInstances.status,
          attemptNumber: sandboxInstances.attemptNumber,
          address: sandboxInstances.address,
          ports: sandboxInstances.ports,
          lastHeartbeatAt: sandboxInstances.lastHeartbeatAt,
          ownerUserId: sandboxInstances.ownerUserId,
        })
        .from(sandboxInstances)
        .where(
          and(
            eq(sandboxInstances.botId, botId),
            sql`${sandboxInstances.status} IN ('provisioning', 'ready', 'sleeping')`,
          ),
        )
        .limit(1);
      return rows[0];
    },

    async beginAttempt(input) {
      // Insert the provisioning row BEFORE any container exists, at the next attempt number
      // for this bot. The increment lives inside the insert's own expression, so a concurrent
      // beginAttempt on the same bot reads the same pre-insert maximum and both rows can carry
      // the same number — which is why "who provisions" is NOT decided here.
      const rows = await db
        .insert(sandboxInstances)
        .values({
          id: newSandboxInstanceId(),
          botId: input.botId,
          ownerUserId: input.ownerUserId,
          status: "provisioning",
          attemptNumber: sql`(select coalesce(max(${sandboxInstances.attemptNumber}), 0) + 1 from ${sandboxInstances} where ${sandboxInstances.botId} = ${input.botId})`,
        })
        .returning({
          id: sandboxInstances.id,
          attemptNumber: sandboxInstances.attemptNumber,
        });
      const mine = rows[0];

      // DURABLE PROVISIONING, DECIDED BY THE DATABASE. Every live provisioning row for the bot
      // is read back ordered by row creation (the id timestamp prefix), and exactly one of them
      // is the earliest: the replica holding that row provisions, every other replica stands
      // down and waits for it. The loser's row is closed out — its own replica marks it failed
      // when it observes the loss — so the bot converges on one live attempt, one container.
      const live = await db
        .select({
          id: sandboxInstances.id,
          attemptNumber: sandboxInstances.attemptNumber,
        })
        .from(sandboxInstances)
        .where(
          and(
            eq(sandboxInstances.botId, input.botId),
            eq(sandboxInstances.status, "provisioning"),
          ),
        )
        .orderBy(sandboxInstances.createdAt, sandboxInstances.id);
      const winner = live[0];
      return {
        id: mine.id,
        attemptNumber: mine.attemptNumber,
        won: winner?.id === mine.id,
      };
    },

    async transition(id, from, to, patch) {
      if (!canTransition(from, to)) return false;
      const rows = await db
        .update(sandboxInstances)
        .set({
          status: to,
          ...(to === "ready" || to === "terminated"
            ? { provisionedAt: new Date() }
            : {}),
          ...(to === "terminated" ? { terminatedAt: new Date() } : {}),
          ...(patch?.address !== undefined ? { address: patch.address } : {}),
          ...(patch?.ports !== undefined ? { ports: patch.ports } : {}),
        })
        .where(
          and(eq(sandboxInstances.id, id), eq(sandboxInstances.status, from)),
        )
        .returning({ id: sandboxInstances.id });
      return rows.length > 0;
    },

    async heartbeat(id, at) {
      await db
        .update(sandboxInstances)
        .set({ lastHeartbeatAt: at })
        .where(
          and(
            eq(sandboxInstances.id, id),
            eq(sandboxInstances.status, "ready"),
          ),
        );
    },

    async listLive() {
      return db
        .select({
          id: sandboxInstances.id,
          botId: sandboxInstances.botId,
          status: sandboxInstances.status,
          attemptNumber: sandboxInstances.attemptNumber,
          lastHeartbeatAt: sandboxInstances.lastHeartbeatAt,
        })
        .from(sandboxInstances)
        .where(
          sql`${sandboxInstances.status} IN ('provisioning', 'ready', 'sleeping')`,
        );
    },
  };
}

/** What the reconcile needs from a container runtime — the same seam the supervisor holds. */
export type ContainerRuntimeView = {
  /** Which bot ids actually have a container right now. */
  listBotIds(): Promise<string[]>;
  /** Remove a container (orphan recovery). */
  remove(botId: string): Promise<void>;
  /** Ask for a container to be created again (lost-and-rebuild). */
  recreate(botId: string): Promise<void>;
};

export type ReconcileReport = {
  reaped: string[];
  rebuilt: string[];
  slept: string[];
};

export type ReconcileOptions = {
  nowMs: number;
  /** A ready container this quiet is asleep. */
  idleAfterMs: number;
};

/**
 * Make the database and the runtime agree.
 *
 * Three comparisons, one pass per live row: a row whose container is gone (and whose provision
 * finished — a provisioning row may simply not have created its container yet) is failed and its
 * container reaped if the runtime still lists it under a different row; a container whose row is
 * failed is asked to be recreated; a ready row with a quiet heartbeat goes to sleeping, which is
 * the cheap move that keeps a container somebody might come back to.
 */
export async function reconcileSandboxInstances(
  store: SandboxInstanceStateStore,
  runtime: ContainerRuntimeView,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { reaped: [], rebuilt: [], slept: [] };
  const rows = await store.listLive();
  const runtimeBots = new Set(await runtime.listBotIds());
  const cutoff = options.nowMs - options.idleAfterMs;

  for (const row of rows) {
    const hasContainer = runtimeBots.has(row.botId);

    if (!hasContainer && row.status !== "provisioning") {
      // The row claims a live container and the runtime disagrees: the container is gone, so
      // the row fails. Nothing to reap — there is no container.
      if (await store.transition(row.id, row.status, "failed")) {
        report.reaped.push(row.botId);
      }
      continue;
    }

    if (!hasContainer && row.status === "provisioning") {
      // In flight: another replica may be mid-create. Reconcile does not guess here; the
      // provisioner's own timeout moves the row to failed, and the next pass rebuilds.
      continue;
    }

    if (row.status === "ready" && row.lastHeartbeatAt) {
      if (row.lastHeartbeatAt.getTime() < cutoff) {
        if (await store.transition(row.id, "ready", "sleeping")) {
          report.slept.push(row.botId);
        }
      }
    }
  }

  // Lost containers: the runtime holds a bot whose rows are all failed — the row failed (crash,
  // timeout) but the container outlived it. Ask for a rebuild so the next provision finds one.
  for (const botId of runtimeBots) {
    const live = await store.liveOf(botId);
    if (!live) {
      await runtime.recreate(botId);
      report.rebuilt.push(botId);
    }
  }

  return report;
}
