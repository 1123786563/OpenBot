/**
 * Snapshot sleep/wake — the OpenBot port of onyx `sandbox/snapshot_manager.py`, re-expressed
 * against two OpenBot facts: the archive bytes come from the agent-sandbox gateway (its
 * `/workspace/snapshot` packs the Bot's whole workspace, exactly as agent-sandbox/src/snapshot.ts
 * writes them), and the durable store is the object-store seam below this module rather than
 * onyx's in-process FileStore.
 *
 * THE SHARED-WORKSPACE DIVERGENCE. onyx snapshots are per-sandbox (one session per pod). OpenBot
 * routes every craft session to one deployment-chosen Bot workspace, so a snapshot archive is
 * the BOT's workspace — taking one for session A and restoring it for session A restores the
 * whole Bot (all of its sessions). The `craft_snapshots` row still carries the session id
 * (parity with onyx's table), but the recovery unit is the Bot, not the session. The reaper
 * sleeps per-session for the same reason: any wake restores the shared workspace.
 *
 * THE PIPELINE. takeSnapshot → gateway bytes → objectStore.put → craft_snapshots row.
 * restoreLatestSnapshot → newest row → objectStore.get → gateway restore → boolean. The bytes
 * never live on the row; the row owns the key + size and the object store owns the bytes, so a
 * restore whose blob was evicted answers false and the caller degrades to "rebuild".
 */

import { getLogger } from "../../../shared/logger";
import type { CraftConfig } from "./config";
import type { SandboxGateway } from "./sandbox-gateway";
import type { ObjectStore } from "./storage/object-store";
import { type CraftSnapshotRow, type CraftStore, newCraftId } from "./store";

const logger = getLogger("server");

export type SnapshotContext = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  objectStore: ObjectStore;
};

/** The archive's object-store key — onyx's `sandbox-snapshots/{tenant}/{sandbox}/{id}` minus the
 * tenant (OpenBot craft has no tenant axis), with the Bot standing in for the sandbox. */
export function snapshotStoragePath(botId: string, snapshotId: string): string {
  return `sandbox-snapshots/${botId}/${snapshotId}.tar.gz`;
}

/**
 * Pack the session's (Bot's) workspace and record it. Returns the durable row; throws when the
 * sandbox produced no archive, so a caller treats "snapshotted" and "still active" as one fact.
 */
export async function takeSnapshot(
  ctx: SnapshotContext,
  input: { botId: string; sessionId: string },
): Promise<CraftSnapshotRow> {
  const archive = await ctx.gateway.snapshotArchiveFor(input.botId);
  if (archive === null) {
    throw new Error(
      `Snapshot failed: sandbox produced no archive for bot ${input.botId}`,
    );
  }
  const snapshotId = newCraftId("csn");
  const storagePath = snapshotStoragePath(input.botId, snapshotId);
  await ctx.objectStore.put(storagePath, archive, {
    snapshot_id: snapshotId,
    bot_id: input.botId,
    session_id: input.sessionId,
  });
  return ctx.store.createSnapshot({
    sessionId: input.sessionId,
    storagePath,
    sizeBytes: archive.byteLength,
  });
}

/**
 * Replay the newest snapshot into the session's workspace. False when there is nothing to replay
 * (no row, or the blob was evicted, or the gateway refused mid-turn) — the caller's honest
 * "could not wake from disk" that degrades to a fresh workspace build.
 */
export async function restoreLatestSnapshot(
  ctx: SnapshotContext,
  input: { botId: string; sessionId: string },
): Promise<boolean> {
  const row = await ctx.store.getLatestSnapshot(input.sessionId);
  if (!row) return false;
  const archive = await ctx.objectStore.get(row.storagePath);
  if (archive === null) return false;
  return ctx.gateway.restoreWorkspace(input.botId, archive);
}

/** Delete every snapshot row for a session and free its blobs (session delete path). */
export async function deleteSnapshots(
  ctx: SnapshotContext,
  sessionId: string,
): Promise<void> {
  const rows = await ctx.store.deleteSnapshots(sessionId);
  for (const row of rows) {
    await ctx.objectStore.delete(row.storagePath).catch(() => undefined);
  }
}

export type CraftIdleReaperDeps = {
  /** Resolves the Bot whose workspace hosts an idle session (snapshot must pack the right one). */
  botIdFor: (sessionId: string) => Promise<string | null>;
  /**
   * True while a session has a live interactive turn. The sweep leaves such a session awake even
   * when its row is quiet — a parked approval holds a turn with no traffic. An errored check also
   * counts as "active" (fail-closed: a session we cannot prove quiet is never slept).
   */
  hasActiveTurn?: (session: { id: string; userId: string }) => Promise<boolean>;
};

export type CraftIdleReaper = {
  stop: () => void;
  /** One immediate sweep — the interval's body plus a test/diagnostic hook. */
  sweepOnce: () => Promise<number>;
};

/**
 * The sleep half of sleep/wake: a periodic sweep (onyx's cleanup_idle_sandboxes_task, simplified
 * per the port plan) over ACTIVE sessions quiet past `sandboxIdleTimeoutSeconds`. Each candidate
 * is checked for a live turn, snapshotted, THEN flipped idle through a guarded CAS — a session
 * that failed its snapshot, gained a turn, or was touched mid-sweep stays active and retries next
 * sweep, because sleeping a session with no durable backup is worse than never sleeping it.
 *
 * DIVERGENCE (the release step): onyx terminates the pod after the snapshot; agent-sandbox hosts
 * every craft session in ONE shared Bot workspace behind a gateway with no per-session sandbox to
 * terminate (its /workspace/reset is a destructive governance verb that would drop every session's
 * live state, and the gateway already reaps idle per-Bot runtimes itself). So the sweep's release
 * degrades to snapshot + session→idle; the wake half (wakeIfIdle) restores from the snapshot.
 */
export function startCraftIdleReaper(
  ctx: SnapshotContext,
  deps: CraftIdleReaperDeps,
): CraftIdleReaper {
  const periodMs = Math.max(
    30_000,
    ctx.config.idleReaperIntervalSeconds * 1000,
  );
  const timer = setInterval(() => {
    reapIdleSessions(ctx, deps).catch((error) => {
      logger.error({ error }, "[craft] idle reaper sweep failed");
    });
  }, periodMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    sweepOnce: () => reapIdleSessions(ctx, deps),
  };
}

async function reapIdleSessions(
  ctx: SnapshotContext,
  deps: CraftIdleReaperDeps,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - ctx.config.sandboxIdleTimeoutSeconds * 1000,
  );
  const sessions = await ctx.store.listIdleSessions(cutoff);
  let slept = 0;
  for (const session of sessions) {
    if (await sessionHasLiveTurn(deps, session)) continue;
    try {
      // Resolver failures are per-session like snapshot failures: one bad botIdFor must not
      // abort the sweep for the sessions behind it.
      const botId = await deps.botIdFor(session.id);
      if (!botId) continue;
      await takeSnapshot(ctx, { botId, sessionId: session.id });
      // The flip is guarded: activity that landed between the list read and now keeps the
      // session awake (onyx's second still-idle scan, as one CAS).
      const flipped = await ctx.store.markSessionIdleIfStillIdle(
        session.id,
        cutoff,
      );
      if (flipped) slept += 1;
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id },
        "[craft] idle reaper could not snapshot session; leaving active",
      );
    }
  }
  return slept;
}

async function sessionHasLiveTurn(
  deps: CraftIdleReaperDeps,
  session: { id: string; userId: string },
): Promise<boolean> {
  if (!deps.hasActiveTurn) return false;
  try {
    return await deps.hasActiveTurn(session);
  } catch (error) {
    logger.warn(
      { error, sessionId: session.id },
      "[craft] idle reaper could not check for active turns; leaving active",
    );
    return true;
  }
}
