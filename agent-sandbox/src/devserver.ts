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
   * `botWorkspace` names the ownership-scoped tree to contain against (MT050); absent, the
   * configured root decides.
   */
  start(input: {
    botId: string;
    dir: string;
    botWorkspace?: string;
    command?: string;
  }): Promise<
    | { ok: true; port: number; command: string }
    | { ok: false; reason: "capacity"; running: number; max: number }
    | { ok: false; reason: "outside-workspace"; dir: string }
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

      // CONTAINMENT BEFORE SPAWN: the child's cwd must resolve INSIDE this Bot's workspace.
      // A dir like `../../../etc` (or an absolute path smuggled past the leading-slash strip)
      // would otherwise hand a caller's command a working directory the sandbox never meant
      // to share. Resolved lexically — the workspace root is the module's own configured
      // base, not caller input, so segment arithmetic is exact here.
      const botWorkspace =
        input.botWorkspace ?? `${workspaceRoot}/${input.botId}`;
      // An ABSOLUTE dir is a different escape entirely: joining it under the workspace makes
      // it relative by accident (`/workspace/bots/a//etc/...` reads fine), so the leading
      // slash itself is the refusal — a dev server dir is a subdirectory, spelled relatively.
      if (input.dir.startsWith("/")) {
        return { ok: false, reason: "outside-workspace", dir: input.dir };
      }
      const resolvedDir = input.dir.replace(/^\/+/, "");
      const segments: string[] = [];
      for (const part of resolvedDir.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
          segments.pop(); // Climbing is legal only as far as it stays inside; checked below.
          continue;
        }
        segments.push(part);
      }
      // The witness is arithmetic, not string comparison: a climb that pops past the root
      // (`a/../../..`) escapes, and so does any input whose RESOLVED path fails to sit under
      // the workspace (which also catches smuggled absolute dirs, whose segments are joined
      // as relative parts and land somewhere unrelated). Both statements below must hold.
      const climbCount = resolvedDir
        .split("/")
        .filter((part) => part === "..").length;
      const segmentCount = resolvedDir
        .split("/")
        .filter((part) => part && part !== "." && part !== "..").length;
      const cwd = `${botWorkspace}/${segments.join("/")}`;
      const inside =
        climbCount <= segmentCount + 1 &&
        (cwd === botWorkspace || cwd.startsWith(`${botWorkspace}/`));
      if (!inside) {
        return { ok: false, reason: "outside-workspace", dir: input.dir };
      }

      const command = input.command?.trim() || "vite --host 127.0.0.1";
      const [binary, ...args] = command.split(/\s+/);
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
