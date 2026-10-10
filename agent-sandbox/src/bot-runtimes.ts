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
import { startOpencodeServe, type Upstream } from "./upstream";
import { UnusableBotIdError, isPlainBotId } from "./bot-id";

export type BotRuntime = { port: number; workspaceDir: string };

export type BotRuntimesOptions = {
  env: SandboxEnv;
  workspaceRoot?: string;
  spawnFn?: typeof import("node:child_process").spawn;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type Entry = {
  port: number;
  workspaceDir: string;
  upstream: Upstream | null;
  lastUsedAtMs: number;
};

export type BotRuntimes = {
  getOrSpawn(botId: string): Promise<BotRuntime>;
  reapIdle(nowMs: number): string[];
  stopBot(botId: string): Promise<void>;
  stopAll(): Promise<void>;
  size(): number;
};

export function createBotRuntimes(options: BotRuntimesOptions): BotRuntimes {
  const { env } = options;
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
        };
        entries.set(botId, entry);
        await mkdir(entry.workspaceDir, { recursive: true });
        build(entry);
      } else if (!entry.upstream) {
        build(entry);
      }
      entry.lastUsedAtMs = nowMs();
      return { port: entry.port, workspaceDir: entry.workspaceDir };
    },

    reapIdle(nowMs: number): string[] {
      const reaped: string[] = [];
      for (const [botId, entry] of entries) {
        if (entry.upstream && nowMs - entry.lastUsedAtMs > env.upstreamIdleMs) {
          entry.upstream.kill("SIGTERM");
          entry.upstream = null;
          entries.delete(botId);
          reaped.push(botId);
        }
      }
      return reaped;
    },

    async stopBot(botId: string): Promise<void> {
      const entry = entries.get(botId);
      if (entry) stop(botId, entry);
    },

    async stopAll(): Promise<void> {
      for (const botId of [...entries.keys()]) {
        const entry = entries.get(botId);
        if (entry) stop(botId, entry);
      }
    },

    size() {
      return entries.size;
    },
  };
}
