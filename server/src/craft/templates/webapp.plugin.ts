// Manage this session's web-app dev server: start/status/logs/restart over the
// protected `start-webapp.sh` the server materializes at session setup.
//
// Ported verbatim from onyx `sandbox/image/opencode-plugins/webapp.ts` (schema
// strings, observation text, failure classification byte-for-byte). One
// mechanical deviation, forced by this file's home inside the server tree (it
// ships as TEXT — written into each session workspace beside the turn-budget
// and connect-app plugins, because the agent-sandbox image cannot bake it): the
// `satisfies Plugin` type sugar is dropped for a structural ToolFactory, and
// the SDK load path list gains a leading `OPENBOT_PLUGIN_TOOL_HELPER` env
// candidate (tests inject a stub helper through it; the sandbox then tries the
// deployed agent-sandbox candidates followed by onyx's image paths).
//
// One deliberate BEHAVIORAL deviation (OCR r3): the restart arm guards its
// kill with the pid cwd identity check (see pidOwnsAppDir) — onyx's own
// restart arm (pinned webapp.ts:236-244, fixture F5 §E) kills on `kill -0`
// alone, so a stale/recycled nextjs.pid can kill an unrelated process.
// OpenBot's start script already carries the same guard (nextjs-dev.ts), and
// the plugin runs in the same Linux sandbox, so porting it in is free.
//
// Failures are returned as observations, never thrown; a thrown tool error
// would abort the agent's turn instead of letting it recover.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readlink, rm } from "node:fs/promises";

const SDK_TOOL_PATHS = [
  ...(process.env.OPENBOT_PLUGIN_TOOL_HELPER
    ? [process.env.OPENBOT_PLUGIN_TOOL_HELPER]
    : []),
  // The deployed agent-sandbox (verified live, remediation-verification
  // §3(ii)): the SDK lands beside the plugin in the session's own
  // `.opencode/node_modules`, and under opencode's config dir (HOME=/config).
  // onyx's image candidates follow (a trailing miss is harmless).
  new URL("../node_modules/@opencode-ai/plugin/dist/tool.js", import.meta.url)
    .href,
  "/config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
  "/home/sandbox/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
  "/home/sandbox/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
];

/**
 * A structural stand-in for the SDK's `tool` helper — erased at runtime (the
 * real helper arrives through the dynamic import below); it exists only so
 * this text ships typechecked. `schema` mirrors the two builder chains the
 * args use, to the depth they are chained.
 */
type ToolFactory = {
  (definition: ToolDefinition): unknown;
  schema: {
    enum(values: readonly string[]): {
      describe(description: string): unknown;
    };
    number(): { optional(): { describe(description: string): unknown } };
  };
};

async function loadToolFactory(): Promise<ToolFactory> {
  for (const path of SDK_TOOL_PATHS) {
    try {
      return (await import(path)).tool;
    } catch {}
  }
  throw new Error("could not resolve the @opencode-ai/plugin tool helper");
}

type ToolDefinition = {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: { action: "start" | "status" | "logs" | "restart"; lines?: number },
    context: {
      directory: string;
      metadata(input: { title: string }): void;
      abort: AbortSignal;
    },
  ): Promise<string>;
};

const SCRIPT_REL = "start-webapp.sh";
const PID_REL = "nextjs.pid";
const LOG_REL = "nextjs.log";
const APP_DIR_REL = "outputs/web";

const DEFAULT_ACTION_LOG_LINES = 10;
const DEFAULT_LOGS_LINES = 30;
const MAX_LOG_LINES = 200;
const DEFAULT_START_TIMEOUT_MS = 150_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 2000;
/** The cap's kill escalation: SIGTERM first, SIGKILL for whatever ignored it. */
const KILL_ESCALATION_MS = 1_000;
/** How long stdout may still be draining after the script exits before we answer. */
const OUTPUT_DRAIN_MS = 500;

/**
 * The wait window for one script run. Deployments on a slow registry can widen
 * it; it stays well under the turn's inactivity watchdog
 * (OPENBOT_CRAFT_SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS + its margin, 200s by
 * default) on purpose — a tool that answers late but answers beats a turn the
 * watchdog cancels, because a cancelled turn leaves the agent no observation to
 * recover from.
 */
function startTimeoutMs(): number {
  const raw = process.env.OPENBOT_WEBAPP_START_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_START_TIMEOUT_MS;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveScript(dir: string): Promise<string | null> {
  const scriptPath = `${dir}/${SCRIPT_REL}`;
  return (await pathExists(scriptPath)) ? scriptPath : null;
}

function parsePort(scriptText: string): number | null {
  const match = scriptText.match(/^PORT=(\d+)$/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function pidAlive(dir: string): Promise<number | null> {
  const pidPath = `${dir}/${PID_REL}`;
  if (!(await pathExists(pidPath))) return null;
  const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * The script's own identity guard, ported into the restart arm: kill -0 alone
 * trusts a recycled pid, and a stale nextjs.pid could name an unrelated live
 * process the restart would kill. Reuse the kill only when the pid's cwd IS
 * this session's app dir (onyx's readlink /proc/$pid/cwd comparison; the
 * plugin runs in the same Linux sandbox as the server it manages). When
 * identity cannot be established (/proc unreadable, e.g. outside the sandbox),
 * skip the kill — the script's own guard drops the stale pid file and
 * reconciles (see the file header's deviation note).
 */
async function pidOwnsAppDir(pid: number, dir: string): Promise<boolean> {
  try {
    return (await readlink(`/proc/${pid}/cwd`)) === `${dir}/${APP_DIR_REL}`;
  } catch {
    return false;
  }
}

async function probeRunning(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function tailLog(dir: string, n: number): Promise<string | null> {
  // slice(-0) === slice(0): a 0/negative n would return the WHOLE un-rotated
  // log. All call sites clamp (see the logs action), but keep the floor here
  // as the backstop.
  if (n <= 0) return null;
  const logPath = `${dir}/${LOG_REL}`;
  if (!(await pathExists(logPath))) return null;
  const lines = (await readFile(logPath, "utf8")).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

interface Observation {
  state: "running" | "not_running";
  port: number | null;
  text: string;
}

async function buildObservation(
  dir: string,
  scriptPath: string,
  logLines: number,
): Promise<Observation> {
  const scriptText = await readFile(scriptPath, "utf8");
  const port = parsePort(scriptText);
  const pid = await pidAlive(dir);
  const running = pid !== null && port !== null && (await probeRunning(port));
  const state: Observation["state"] = running ? "running" : "not_running";
  const isScaffolded = await pathExists(`${dir}/${APP_DIR_REL}/package.json`);

  const lines = [
    `state: ${state}`,
    port !== null
      ? `port: ${port}`
      : "port: unknown (could not parse PORT from start-webapp.sh)",
    `app dir: ${APP_DIR_REL}`,
    `scaffolded: ${isScaffolded ? "yes" : "no"}`,
    `logs: ${LOG_REL}`,
  ];

  const cappedLines = Math.min(logLines, MAX_LOG_LINES);
  const tail = await tailLog(dir, cappedLines);
  if (tail) {
    lines.push(`--- last ${cappedLines} lines of ${LOG_REL} ---`, tail);
  }

  return { state, port, text: lines.join("\n") };
}

/** Why a script run ended before the script did, if it did. */
type StopReason = "timeout" | "abort" | null;

type ScriptRun = {
  exitCode: number;
  output: string;
  /** Non-null when this side gave up waiting and killed the run. */
  stopped: StopReason;
};

/**
 * One run of the session's bootstrap script, and the cleanup that owes it.
 *
 * TWO PROCESS-HANDLING RULES, both learned from a dead preview:
 *
 * 1. Resolve on `exit`, not on stdio EOF. `close` waits for the stdout pipe to
 *    end, and any grandchild that inherited it — an orphaned `bun install`, a
 *    scaffold's own background job — holds that pipe open indefinitely. Waiting
 *    for EOF made the tool outrun its own 150s cap and get cancelled by the
 *    turn's 200s inactivity watchdog instead (live: a `webapp start` silent
 *    from 15:03:10 to 15:07:12, then cancelled, leaving a scaffold with a
 *    half-installed node_modules, no nextjs.pid and no nextjs.log). A bounded
 *    drain after `exit` keeps the normal case's output whole without ever
 *    handing the pipe a veto.
 *
 * 2. Kill the whole process group. `detached` makes the script a group leader,
 *    so the cap's SIGTERM reaches the script's subshell AND the `bun install`
 *    inside it. Killing only the direct child orphaned that install: it kept
 *    writing node_modules and kept holding `.webapp.lock`, so every retry
 *    blocked on the lock behind a half-finished install. The session's dev
 *    server is deliberately NOT in this group — start-webapp.sh spawns it with
 *    setsid — because a slow first boot must not be killed by the cap that
 *    fired while waiting for it.
 */
function runScript(
  dir: string,
  scriptPath: string,
  abort: AbortSignal,
): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const quotedPath = `'${scriptPath.replace(/'/g, `'\\''`)}'`;
    const child = spawn("bash", ["-c", `bash ${quotedPath} 2>&1`], {
      cwd: dir,
      detached: true,
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    let settled = false;
    let stopped: StopReason = null;
    let exitCode: number | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    const killTree = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (typeof pid !== "number") return;
      try {
        // Negative pid: the group, not just its leader.
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      abort.removeEventListener("abort", onAbort);
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(-MAX_OUTPUT_BYTES);
      }
      resolve({ exitCode: exitCode ?? 1, output, stopped });
    };

    /** Give up waiting and take the tree with us; `finish` follows the exit. */
    const stop = (reason: Exclude<StopReason, null>) => {
      if (settled || stopped !== null) return;
      stopped = reason;
      killTree("SIGTERM");
      const escalate = setTimeout(
        () => killTree("SIGKILL"),
        KILL_ESCALATION_MS,
      );
      escalate.unref?.();
      // Backstop for a tree that dies without ever closing its stdio.
      const giveUp = setTimeout(finish, KILL_ESCALATION_MS + OUTPUT_DRAIN_MS);
      giveUp.unref?.();
    };

    const capTimer = setTimeout(() => stop("timeout"), startTimeoutMs());
    capTimer.unref?.();

    const onAbort = () => stop("abort");
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) onAbort();

    child.on("exit", (code) => {
      exitCode = code ?? 1;
      // Bounded drain: `close` normally lands milliseconds later and carries
      // the last of the output with it.
      drainTimer = setTimeout(finish, OUTPUT_DRAIN_MS);
      drainTimer.unref?.();
    });
    child.on("close", () => {
      if (exitCode !== null) finish();
    });
    child.on("error", () => {
      exitCode = 1;
      finish();
    });
  });
}

const UNAVAILABLE_OBSERVATION =
  "state: unavailable\n" +
  "this session has no web-app support (headless session) or the bootstrap " +
  "script was deleted; reopen the session to regenerate it; never run " +
  "`bun run dev` yourself.";

export default async () => {
  const tool = await loadToolFactory();

  return {
    tool: {
      webapp: tool({
        description:
          "Manage this session's web-app dev server. Call with action='start' " +
          "BEFORE building a web app: it scaffolds outputs/web, installs " +
          "dependencies, starts the dev server, and waits until it serves. " +
          "SAFE TO CALL REPEATEDLY: it reconciles current state (already " +
          "running = success, crashed = restarted). Use action='status' or " +
          "'logs' to diagnose problems, and action='restart' if the server is " +
          "up but misbehaving. NEVER run `bun run dev` or start your own " +
          "server; the preview proxy only routes to the port this tool manages.",
        args: {
          action: tool.schema
            .enum(["start", "status", "logs", "restart"])
            .describe(
              "start: scaffold/install/start the dev server and wait for it " +
                "become ready (idempotent - safe even if already running). " +
                "status: report whether the server is running, without " +
                "starting anything. logs: show a larger log tail for " +
                "debugging. restart: stop the current server (if any) and " +
                "start it again - use when it's up but misbehaving.",
            ),
          lines: tool.schema
            .number()
            .optional()
            .describe(
              "Log lines to include, default 30, max 200 - only meaningful " +
                "for action='logs'.",
            ),
        },
        async execute(args, context) {
          const dir = context.directory;
          const titles: Record<string, string> = {
            start: "Starting web app…",
            restart: "Restarting web app…",
            status: "Checking web app status…",
            logs: "Reading web app logs…",
          };
          context.metadata({ title: titles[args.action] });

          const scriptPath = await resolveScript(dir);
          if (!scriptPath) {
            return UNAVAILABLE_OBSERVATION;
          }

          if (args.action === "status") {
            const obs = await buildObservation(
              dir,
              scriptPath,
              DEFAULT_ACTION_LOG_LINES,
            );
            const headline =
              obs.state === "running"
                ? `web app is running on port ${obs.port} and the preview updates live (hot reload)`
                : "web app is not running; call webapp start";
            return `${headline}\n\n${obs.text}`;
          }

          if (args.action === "logs") {
            // Floor at 1 and default on non-finite input (OCR r3): the schema
            // bounds no lower edge, and a 0/negative/NaN lines would otherwise
            // dump the whole un-rotated log past the advertised max 200.
            const requested =
              typeof args.lines === "number" && Number.isFinite(args.lines)
                ? args.lines
                : DEFAULT_LOGS_LINES;
            const n = Math.min(Math.max(requested, 1), MAX_LOG_LINES);
            const obs = await buildObservation(dir, scriptPath, n);
            const headline =
              obs.state === "running"
                ? `web app is running on port ${obs.port}`
                : "web app is not running";
            return `${headline}\n\n${obs.text}`;
          }

          if (args.action === "restart") {
            const pid = await pidAlive(dir);
            // Kill only a pid this session owns (pidOwnsAppDir): a stale pid
            // file must never kill an unrelated process. With the identity
            // unestablished the kill is skipped and the script reconciles.
            if (pid !== null && (await pidOwnsAppDir(pid, dir))) {
              try {
                process.kill(pid);
              } catch {}
              await rm(`${dir}/${PID_REL}`, { force: true });
              await new Promise((r) => setTimeout(r, 2000));
            }
          }

          const { exitCode, output, stopped } = await runScript(
            dir,
            scriptPath,
            context.abort,
          );
          const obs = await buildObservation(
            dir,
            scriptPath,
            DEFAULT_ACTION_LOG_LINES,
          );

          // The port is the proxy's routing contract (DB-allocated):
          // port_conflict must never auto-heal onto another port; a moved
          // server would "run" but be unreachable via the preview.
          let headline: string;
          let errorKind: string | null = null;
          if (exitCode === 0) {
            headline = output.includes("already running")
              ? "webapp was already running"
              : "webapp started successfully";
          } else if (stopped !== null) {
            // This side gave up waiting and killed the run. Its own class: the
            // script printed no error, so "fix the error above" would send the
            // agent hunting for something that does not exist.
            errorKind =
              stopped === "timeout" ? "start_timeout" : "start_cancelled";
            headline =
              stopped === "timeout"
                ? "webapp start timed out: the dev server did not come up " +
                  `within ${Math.round(startTimeoutMs() / 1000)}s, so the wait ` +
                  "was ended and the run was stopped (nothing was left " +
                  "running). This is usually a slow dependency install, not a " +
                  "broken app. Call webapp start again - it resumes the " +
                  "install and reuses a server that is already up. If it times " +
                  "out again, call webapp logs to see where it stalls."
                : "webapp start was cancelled before the dev server came up, " +
                  "and the run was stopped (nothing was left running). Call " +
                  "webapp start again to begin it once more.";
          } else if (
            output.includes("EADDRINUSE") ||
            output.includes("address already in use")
          ) {
            errorKind = "port_conflict";
            headline =
              "webapp start failed: something else is bound to the managed " +
              `port${obs.port !== null ? ` ${obs.port}` : ""}. Kill that ` +
              "process (e.g. `fuser -k <port>/tcp`), then call webapp start " +
              "again. Do not start a server on a different port; the " +
              "preview proxy only routes to the managed port.";
          } else if (output.includes("did not become ready")) {
            errorKind = "app_boot_failure";
            headline =
              "webapp start failed: the server did not become ready. the " +
              "server crashed or the app code throws on boot; read the log " +
              "tail, fix the code, then call webapp start again.";
          } else {
            errorKind = "bootstrap_failure";
            headline =
              "webapp start failed. fix the error shown above, then call " +
              "webapp start again.";
          }

          const errorKindLine = errorKind ? `error_kind: ${errorKind}\n` : "";
          return (
            `${headline}\n\n` +
            `--- script output ---\n${output}\n\n${errorKindLine}${obs.text}`
          );
        },
      }),
    },
  };
};
