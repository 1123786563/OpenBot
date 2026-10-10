/**
 * One opencode serve per Bot, spawned on demand and reaped when idle.
 *
 * The isolation boundary is the working directory: each Bot's serve runs with cwd at
 * <workspaceDir>/bots/<botId>, so its sessions read and write only its own tree, and the file routes
 * answer from the same root. The serve process itself is trusted code; the directory is what keeps
 * Bots out of each other's artifacts.
 *
 * Idle reaping stops the child after upstreamIdleMs without a request — a resident container stays
 * up, but Bots nobody is talking to stop costing memory. Ports come from a base and are handed out
 * per registration; the registry remembers the port across reaps so a reaped Bot returns to its own
 * port.
 */
import { mkdir } from "node:fs/promises";
import type { SandboxEnv } from "./env";
import { createDevServers, type DevServers } from "./devserver";
import { startOpencodeServe, type Upstream } from "./upstream";
import { UnusableBotIdError, isPlainBotId } from "./bot-id";

export type BotRuntime = { port: number; workspaceDir: string };

export type BotRuntimesOptions = {
  env: SandboxEnv;
  workspaceRoot?: string;
  spawnFn?: typeof import("node:child_process").spawn;
  /** The dev server subsystem; injectable for tests, built from env when absent. */
  devservers?: DevServers;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type Entry = {
  port: number;
  workspaceDir: string;
  upstream: Upstream | null;
  lastUsedAtMs: number;
  /**
   * The last time this Bot's stream produced anything (an event block forwarded, a request
   * answered). Distinct from lastUsedAtMs: a streaming turn keeps this fresh while holding no
   * request at all, which is exactly the case plain idle-reaping used to kill mid-turn.
   */
  lastActivityAtMs: number;
  /**
   * How many /events listeners this Bot currently has. The reaper splits its two endings on
   * this: a quiet stream WITH listeners is a stall (a turn that stopped reporting); a quiet
   * runtime with NO listeners is just idle (nobody is watching, nobody is working).
   */
  streamCount: number;
  /**
   * The mkdir+spawn in flight, if one is. Between the entry landing in the map and `upstream`
   * being set there is an `await`, so the same Bot's concurrent first requests used to each run
   * `build` — the second spawn overwrote the first into an orphaned child. Waiters hang off this
   * promise instead of spawning their own.
   */
  starting: Promise<void> | null;
  /**
   * How many spawns this Bot has had in this process's lifetime, stopped runtimes included:
   * the status endpoint's churn number — a Bot at attempts 7 today says something about
   * reaping policy that a point-in-time snapshot never will.
   */
  spawnAttempts: number;
};

export type BotRuntimes = {
  getOrSpawn(botId: string): Promise<BotRuntime>;
  /**
   * Note that a Bot's stream produced something. Called by the SSE forwarder for every block it
   * forwards, so a Bot mid-turn — busy, chatty, working — is distinguishable from one merely
   * not being asked anything. Reaping consults both clocks (see reapIdle).
   */
  markActivity(botId: string): void;
  /** A /events listener attached/detached; the reaper's two endings split on this count. */
  noteStreamOpen(botId: string): void;
  noteStreamClose(botId: string): void;
  /**
   * Stop runtimes that are idle AND quiet: no requests for `idleMs` is not enough once turns
   * stream, because a turn in flight holds no request at all. Returns what was stopped, split
   * by why — a stalled stop (silent stream past the activity budget) is a failure mode the
   * caller logs (`sandbox-runtime-stalled`), an idle stop is Tuesday.
   */
  reapIdle(nowMs: number, options?: {
    idleMs?: number;
    activityTimeoutMs?: number;
  }): { idle: string[]; stalled: string[] };
  stopBot(botId: string): Promise<void>;
  stopAll(): Promise<void>;
  size(): number;
  /**
   * The point-in-time roster for GET /runtimes: every Bot this process has state for, with the
   * fields an operator asks about (is it up, where does it live, when did it last do anything).
   * Read-only and stable-string-keyed; it never mutates anything.
   */
  listRuntimes(): Array<{
    botId: string;
    status: "up" | "down";
    port: number;
    workspaceDir: string;
    lastUsedAtMs: number;
    lastActivityAtMs: number;
    spawnAttempts: number;
  }>;
  /** Start (or reuse) this Bot's dev server for a dir; the cap is a refusal, not a queue. */
  startDevServer(input: {
    botId: string;
    dir: string;
    command?: string;
  }): Promise<
    | { ok: true; port: number; command: string }
    | { ok: false; reason: "capacity"; running: number; max: number }
    | { ok: false; reason: "outside-workspace"; dir: string }
  >;
  /** Stop this Bot's dev servers. Quiet when none. */
  stopDevServer(botId: string): Promise<void>;
  /** What dev servers run, for the status surface. */
  listDevServers(): Array<{
    botId: string;
    dir: string;
    port: number;
    command: string;
    startedAtMs: number;
  }>;
};

export function createBotRuntimes(options: BotRuntimesOptions): BotRuntimes {
  const { env } = options;
  /**
   * The dev servers ride this runtime's lifecycle: stopBot cascades (a dev server without its
   * Bot's runtime is a port held for nobody), and the runtime's own map never learns a thing
   * about them — they are a sibling subsystem, not runtime state.
   */
  const devservers: DevServers =
    options.devservers ??
    createDevServers({
      portBase: env.devserverPortBase,
      max: env.devserverMax,
      workspaceRoot: options.workspaceRoot ?? `${env.workspaceDir}/bots`,
    });
  const workspaceRoot = options.workspaceRoot ?? `${env.workspaceDir}/bots`;
  const spawnFn = options.spawnFn;
  const fetchImpl = options.fetchImpl;
  const nowMs = options.nowMs ?? Date.now;
  /** Live runtimes only: reap/stop delete from here, so `size` counts what is actually running. */
  const entries = new Map<string, Entry>();
  /** Persists across reaps: a Bot returning after idle always lands on its own port again. */
  const portByBot = new Map<string, number>();
  let nextPortOffset = 0;

  const build = (entry: Entry): void => {
    const upstream = startOpencodeServe({
      bin: process.env.SANDBOX_OPENCODE_BIN?.trim() || "opencode",
      port: entry.port,
      cwd: entry.workspaceDir,
      configDir: env.configDir,
      ...(spawnFn ? { spawnFn } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    entry.upstream = upstream;
    entry.lastUsedAtMs = nowMs();
    entry.lastActivityAtMs = nowMs();
    entry.spawnAttempts += 1;
    void upstream.ready.catch(() => {
      // 上线失败不在此处崩溃：探活由代理请求失败与下次清扫兜底。
      if (entry.upstream === upstream) entry.upstream = null;
    });
  };

  const stop = (botId: string, entry: Entry): void => {
    if (entry.upstream) {
      entry.upstream.kill("SIGTERM");
      entry.upstream = null;
    }
    entries.delete(botId);
  };

  /**
   * Exactly one mkdir+spawn per entry at a time: the caller that starts the flight owns it, and any
   * concurrent caller for the same Bot awaits the same promise instead of building a second
   * upstream that would orphan the first.
   */
  const ensureStarted = async (entry: Entry): Promise<void> => {
    if (entry.starting) {
      await entry.starting;
      return;
    }
    if (entry.upstream) return;
    const starting = (async () => {
      await mkdir(entry.workspaceDir, { recursive: true });
      build(entry);
    })();
    entry.starting = starting;
    try {
      await starting;
    } finally {
      entry.starting = null;
    }
  };

  return {
    async getOrSpawn(botId: string): Promise<BotRuntime> {
      if (!isPlainBotId(botId)) throw new UnusableBotIdError(botId);
      let entry = entries.get(botId);
      if (!entry) {
        const remembered = portByBot.get(botId);
        const port = remembered ?? env.upstreamPortBase + nextPortOffset;
        if (remembered === undefined) nextPortOffset += 1;
        portByBot.set(botId, port);
        entry = {
          port,
          workspaceDir: `${workspaceRoot}/${botId}`,
          upstream: null,
          lastUsedAtMs: nowMs(),
          lastActivityAtMs: nowMs(),
          streamCount: 0,
          starting: null,
          spawnAttempts: 0,
        };
        entries.set(botId, entry);
      }
      entry.lastUsedAtMs = nowMs();
      await ensureStarted(entry);
      entry.lastUsedAtMs = nowMs();
      entry.lastActivityAtMs = nowMs();
      return { port: entry.port, workspaceDir: entry.workspaceDir };
    },

    markActivity(botId: string): void {
      const entry = entries.get(botId);
      if (entry) entry.lastActivityAtMs = nowMs();
    },

    noteStreamOpen(botId: string): void {
      const entry = entries.get(botId);
      if (entry) entry.streamCount += 1;
    },

    noteStreamClose(botId: string): void {
      const entry = entries.get(botId);
      if (entry && entry.streamCount > 0) entry.streamCount -= 1;
    },

    reapIdle(
      now: number,
      options?: { idleMs?: number; activityTimeoutMs?: number },
    ): { idle: string[]; stalled: string[] } {
      const idleMs = options?.idleMs ?? env.upstreamIdleMs;
      const activityTimeoutMs =
        options?.activityTimeoutMs ?? env.activityTimeoutMs;
      const idle: string[] = [];
      const stalled: string[] = [];
      for (const [botId, entry] of entries) {
        if (!entry.upstream) continue;
        const quietFor = now - entry.lastActivityAtMs;
        const unusedFor = now - entry.lastUsedAtMs;
        if (unusedFor <= idleMs) continue;
        if (entry.streamCount > 0 && quietFor > activityTimeoutMs) {
          // Listeners attached AND the stream went silent past its budget: a turn that
          // stopped reporting. The caller logs `sandbox-runtime-stalled {botId, silentMs}`
          // for exactly these — a failure to report, not housekeeping.
          entry.upstream.kill("SIGTERM");
          entry.upstream = null;
          entries.delete(botId);
          stalled.push(botId);
        } else if (entry.streamCount === 0) {
          // No listeners and nothing asked: ordinary idle reaping, the original behaviour.
          entry.upstream.kill("SIGTERM");
          entry.upstream = null;
          entries.delete(botId);
          idle.push(botId);
        }
        // Listeners attached and the stream still fresh: mid-turn or watched. Not reaped.
      }
      return { idle, stalled };
    },

    startDevServer: (input) => devservers.start(input),
    stopDevServer: (botId) => devservers.stop(botId),
    listDevServers: () => devservers.list(),

    async stopBot(botId: string): Promise<void> {
      // The dev servers die with their Bot's runtime: see the devservers field above.
      await devservers.stop(botId);
      const entry = entries.get(botId);
      if (entry) stop(botId, entry);
    },

    async stopAll(): Promise<void> {
      for (const botId of [...entries.keys()]) {
        const entry = entries.get(botId);
        if (entry) stop(botId, entry);
      }
    },

    listRuntimes() {
      return [...entries.entries()]
        .map(([botId, entry]) => ({
          botId,
          status: entry.upstream ? ("up" as const) : ("down" as const),
          port: entry.port,
          workspaceDir: entry.workspaceDir,
          lastUsedAtMs: entry.lastUsedAtMs,
          lastActivityAtMs: entry.lastActivityAtMs,
          spawnAttempts: entry.spawnAttempts,
        }))
        .sort((a, b) => a.botId.localeCompare(b.botId));
    },

    size() {
      return entries.size;
    },
  };
}
