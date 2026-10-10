import { spawn, type ChildProcess } from "node:child_process";

/**
 * The per-bot dev server: a Bot's webapp artifact running live, in its workspace.
 *
 * WHY A POOL AND NOT A PORT EACH. The webapp ports (SANDBOX_WEBAPP_PORT_BASE) serve static
 * builds the sandbox serves itself; a dev server is a CHILD PROCESS (`vite` by default) with
 * its own loopback port, and the sandbox's caller reaches it through the proxy (the WS
 * passthrough is B15's; this batch is the lifecycle). Ports come from a third pool,
 * SANDBOX_DEVSERVER_PORT_BASE + offset, allocated in arrival order and released on stop.
 *
 * THE CAP IS A REFUSAL, NOT A QUEUE. Eight dev servers (SANDBOX_DEVSERVER_MAX) is a machine
 * budget — memory and file watchers — and a ninth is a deployment telling the caller "not
 * now", with a structured log line (`sandbox-devserver-capacity`) beside it. Queuing would
 * turn a machine limit into a mystery latency.
 *
 * LIFECYCLE RIDES THE RUNTIME. A dev server is stopped when its Bot stops (the cascade in
 * bot-runtimes' stopBot), not by its own sweep: a Bot's runtime and its dev server live and
 * die together, because a dev server without its Bot's runtime is a port held for nobody.
 */

export type DevServerEntry = {
  botId: string;
  dir: string;
  port: number;
  child: ChildProcess;
  command: string;
  startedAtMs: number;
};

export type DevServersOptions = {
  /** First port of the dev server pool; 100 ports from here. */
  portBase: number;
  /** How many dev servers may run at once. The (max+1)th start is refused, not queued. */
  max: number;
  /** The workspace root Bot dirs resolve against. */
  workspaceRoot: string;
  /** Injection for tests: the spawn under the entry. Default is node:child_process's. */
  spawnFn?: (command: string, args: string[], cwd: string) => ChildProcess;
  nowMs?: () => number;
  /** Where the structured capacity log goes. Default is console. */
  log?: (line: Record<string, unknown>) => void;
};

export type DevServers = {
  /**
   * The Bot's dev server for a dir, starting one if none. Same Bot+dir answers the same
   * running server (the lazy-start dedup); a different dir for the same Bot gets its own.
   */
  start(input: { botId: string; dir: string; command?: string }): Promise<
    | { ok: true; port: number; command: string }
    | { ok: false; reason: "capacity"; running: number; max: number }
  >;
  /** Stop one Bot's dev servers (a Bot may hold several, one per dir). Quiet when none. */
  stop(botId: string): Promise<void>;
  /** Everything running, for the status surface. */
  list(): Array<{
    botId: string;
    dir: string;
    port: number;
    command: string;
    startedAtMs: number;
  }>;
};

export function createDevServers(options: DevServersOptions): DevServers {
  const { portBase, max, workspaceRoot } = options;
  const spawnFn =
    options.spawnFn ??
    ((command: string, args: string[], cwd: string) =>
      spawn(command, args, { cwd, stdio: "ignore" }) as ChildProcess);
  const nowMs = options.nowMs ?? Date.now;
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));

  const entries = new Map<string, DevServerEntry>();
  /** Free port offsets: the pool's released slots, reused before growing. */
  const freeOffsets: number[] = [];
  let highOffset = 0;

  const key = (botId: string, dir: string) => `${botId}\u0000${dir}`;

  const takeOffset = (): number => freeOffsets.pop() ?? highOffset++;

  const releaseOffset = (offset: number): void => {
    freeOffsets.push(offset);
  };

  return {
    async start(input) {
      // The lazy-start dedup: same Bot, same dir, still running — same answer.
      const existing = entries.get(key(input.botId, input.dir));
      if (existing) {
        return { ok: true, port: existing.port, command: existing.command };
      }

      if (entries.size >= max) {
        // The refusal, with its structured line: a capacity event is an operational fact.
        log({
          type: "sandbox-devserver-capacity",
          running: entries.size,
          max,
          botId: input.botId,
          dir: input.dir,
        });
        return { ok: false, reason: "capacity", running: entries.size, max };
      }

      const command = input.command?.trim() || "vite --host 127.0.0.1";
      const [binary, ...args] = command.split(/\s+/);
      const cwd = `${workspaceRoot}/${input.botId}/${input.dir.replace(/^\/+/, "")}`;
      const offset = takeOffset();
      if (offset >= 100) {
        // Pool exhausted (100 ports): the same refusal shape, a different reason word.
        releaseOffset(offset);
        return { ok: false, reason: "capacity", running: entries.size, max };
      }
      const child = spawnFn(binary ?? "vite", args, cwd);
      const entry: DevServerEntry = {
        botId: input.botId,
        dir: input.dir,
        port: portBase + offset,
        child,
        command,
        startedAtMs: nowMs(),
      };
      entries.set(key(input.botId, input.dir), entry);
      // A child that dies on its own releases its slot: the map is "what we believe is
      // running", and belief that survives the process it is about is a leak.
      child.on("exit", () => {
        if (entries.get(key(input.botId, input.dir)) === entry) {
          entries.delete(key(input.botId, input.dir));
          releaseOffset(offset);
        }
      });
      return { ok: true, port: entry.port, command };
    },

    async stop(botId) {
      for (const [mapKey, entry] of entries) {
        if (entry.botId !== botId) continue;
        entries.delete(mapKey);
        entry.child.kill("SIGTERM");
        releaseOffset(entry.port - portBase);
      }
    },

    list() {
      return [...entries.values()].map((entry) => ({
        botId: entry.botId,
        dir: entry.dir,
        port: entry.port,
        command: entry.command,
        startedAtMs: entry.startedAtMs,
      }));
    },
  };
}
