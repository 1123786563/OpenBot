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
};

export type CraftIdleReaper = {
  stop: () => void;
  /** One immediate sweep — the interval's body plus a test/diagnostic hook. */
  sweepOnce: () => Promise<number>;
};

/**
 * The sleep half of sleep/wake: a period sweep over ACTIVE sessions quiet past
 * `sandboxIdleTimeoutSeconds`. Each is snapshotted THEN marked idle — a session that failed its
 * snapshot stays active and retries next sweep, because sleeping a session with no durable backup
 * is worse than never sleeping it.
 *
 * The sweep cadence is a fraction of the idle threshold (at least every 30s) so a session that
 * goes quiet just past a boundary is caught within one cadence, not two full thresholds.
 */
export function startCraftIdleReaper(
  ctx: SnapshotContext,
  deps: CraftIdleReaperDeps,
): CraftIdleReaper {
  const periodMs = Math.max(
    30_000,
    Math.floor(ctx.config.sandboxIdleTimeoutSeconds / 6) * 1000,
  );
  const timer = setInterval(() => {
    reapIdleSessions(ctx, deps.botIdFor).catch((error) => {
      logger.error({ error }, "[craft] idle reaper sweep failed");
    });
  }, periodMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    sweepOnce: () => reapIdleSessions(ctx, deps.botIdFor),
  };
}

async function reapIdleSessions(
  ctx: SnapshotContext,
  botIdFor: (sessionId: string) => Promise<string | null>,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - ctx.config.sandboxIdleTimeoutSeconds * 1000,
  );
  const sessions = await ctx.store.listIdleSessions(cutoff);
  let slept = 0;
  for (const session of sessions) {
    const botId = await botIdFor(session.id);
    if (!botId) continue;
    try {
      await takeSnapshot(ctx, { botId, sessionId: session.id });
      await ctx.store.updateSession(session.id, { status: "idle" });
      slept += 1;
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id },
        "[craft] idle reaper could not snapshot session; leaving active",
      );
    }
  }
  return slept;
}
