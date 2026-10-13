import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCraftConfig } from "../src/craft/config";
import { CraftSessionManager } from "../src/craft/manager";
import {
  buildWebappBootstrapScript,
  webappDevServerReady,
} from "../src/craft/nextjs-dev";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import { SESSION_PLUGINS } from "../src/craft/session-plugins";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { createWebappProxyRoutes } from "../src/craft/webapp-proxy";
import { setupSessionWorkspace } from "../src/craft/workspace";

/**
 * Fixture F5 — the webapp tool: byte-exact schema/strings (A), the start success
 * shape (B), the three failure classes (C), the unavailable observation (D), the
 * status/logs actions (E), and the start-webapp.sh contract (F) adapted to
 * OpenBot's environment (session-reserved port, no image template). The plugin
 * runs REAL bash scripts against REAL files and a REAL loopback listener, with
 * only the SDK tool helper stubbed — the closest executable evidence to a live
 * sandbox session available outside one.
 */

const config = loadCraftConfig({});

// ---------------------------------------------------------------------------
// harness: a stub SDK tool helper + a loopback listener + live pids
// ---------------------------------------------------------------------------

const workRoot = mkdtempSync(join(tmpdir(), "craft-webapp-"));

/** The stub `@opencode-ai/plugin` tool helper the plugin loads at runtime. */
const SDK_STUB = join(workRoot, "tool.js");
writeFileSync(
  SDK_STUB,
  [
    "const tool = (definition) => definition;",
    "tool.schema = {",
    "  enum: (values) => ({ describe: (description) => ({ values, description }) }),",
    "  number: () => ({ optional: () => ({ describe: (description) => ({ description }) }) }),",
    "};",
    "export { tool };",
  ].join("\n"),
);

let devServer: ReturnType<typeof Bun.serve> | null = null;
let livePidChild: Bun.Subprocess | null = null;

beforeAll(() => {
  process.env.OPENBOT_PLUGIN_TOOL_HELPER = SDK_STUB;
});

afterAll(() => {
  devServer?.stop(true);
  livePidChild?.kill();
  rmSync(workRoot, { recursive: true, force: true });
  delete process.env.OPENBOT_PLUGIN_TOOL_HELPER;
});

/** A real loopback listener on a free port — the "dev server is up" witness. */
async function startListener(): Promise<number> {
  devServer = Bun.serve({
    port: 0,
    fetch: () => new Response("ok", { status: 200 }),
  });
  return devServer.port;
}

/** A process that stays alive so nextjs.pid points at a live pid. */
function spawnLivePid(): number {
  livePidChild = Bun.spawn(["sleep", "60"]);
  return livePidChild.pid;
}

/** A throwaway live pid (for restart's kill), independent of the shared child. */
function spawnExtraPid(): number {
  return Bun.spawn(["sleep", "60"]).pid;
}

/**
 * PATH shims so the generated start-webapp.sh runs on darwin: a no-op
 * `flock`, a `bun` that serves the requested port instead of running a dev
 * script, and a `readlink` standing in for Linux /proc/$pid/cwd — the pid's
 * "cwd" is read from `$CRAFT_WEBAPP_TEST_PROC_CWD/$pid`; no mapping = a cwd
 * the guard does not recognize. Test-only: the shipped script bytes are
 * untouched (the real sandbox is Linux, where /proc exists).
 */
function makeScriptShims(port: number): {
  shimDir: string;
  procCwdDir: string;
} {
  const shimDir = join(workRoot, `shim-${Math.random().toString(36).slice(2)}`);
  const procCwdDir = join(shimDir, "proc-cwd");
  mkdirSync(procCwdDir, { recursive: true });
  writeFileSync(
    join(shimDir, "flock"),
    "#!/bin/bash\n# test shim: no-op flock\nexit 0\n",
  );
  writeFileSync(
    join(shimDir, "bun"),
    [
      "#!/bin/bash",
      'if [ "$1" = "install" ]; then exit 0; fi',
      'port=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-p" ]; then port="$a"; fi; prev="$a"; done',
      `exec ${JSON.stringify(process.execPath)} -e "Bun.serve({ port: ${port}, fetch: () => new Response('ok') }); setInterval(() => {}, 1e9)"`,
    ].join("\n"),
  );
  writeFileSync(
    join(shimDir, "readlink"),
    [
      "#!/bin/bash",
      "# test shim: Linux /proc/$pid/cwd stand-in (mapped cwd, else failure).",
      "p=\"$(printf '%s' \"$1\" | sed -e 's#^/proc/##' -e 's#/cwd$##')\"",
      'if [ -n "$p" ] && [ -f "$CRAFT_WEBAPP_TEST_PROC_CWD/$p" ]; then',
      '  cat "$CRAFT_WEBAPP_TEST_PROC_CWD/$p"',
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"),
  );
  chmodSync(join(shimDir, "flock"), 0o755);
  chmodSync(join(shimDir, "bun"), 0o755);
  chmodSync(join(shimDir, "readlink"), 0o755);
  return { shimDir, procCwdDir };
}

/** Run the session's start-webapp.sh the way the plugin does; both streams. */
async function runBootstrapScript(dir: string): Promise<string> {
  const proc = Bun.spawn(["bash", "start-webapp.sh"], {
    cwd: dir,
    // Explicit env: Bun.spawn would otherwise inherit the environment
    // snapshot from process start, missing the test's PATH shims.
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return `${out}${err}`;
}

type ExecResult = {
  result: string;
  metadataTitles: string[];
};

type WebappArgs = { action: string; lines?: number };

/** One session dir with the files a scenario needs; returns its path. */
function makeSessionDir(files: Record<string, string>): string {
  const dir = join(workRoot, `s-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** Load the plugin (after the env hook is set) and run one tool call. */
async function executeWebapp(
  dir: string,
  args: WebappArgs,
): Promise<ExecResult> {
  const pluginModule = await import("../src/craft/templates/webapp.plugin");
  const factory = await pluginModule.default();
  const definition = factory.tool.webapp as {
    execute(
      args: WebappArgs,
      context: {
        directory: string;
        metadata(input: { title: string }): void;
        abort: AbortSignal;
      },
    ): Promise<string>;
  };
  const metadataTitles: string[] = [];
  const result = await definition.execute(args, {
    directory: dir,
    metadata: (input) => metadataTitles.push(input.title),
    abort: new AbortController().signal,
  });
  return { result, metadataTitles };
}

// ---------------------------------------------------------------------------
// ① plugin source fidelity (fixture F5 A — schema + strings, byte-exact)
// ---------------------------------------------------------------------------

describe("webapp plugin source (F5 tool schema)", () => {
  test("carries onyx's description, arg descriptions, and titles verbatim", async () => {
    const source = await readFile(
      new URL("../src/craft/templates/webapp.plugin.ts", import.meta.url),
      "utf8",
    );
    // The description's literal segments, concatenated exactly as onyx writes them.
    expect(source).toContain(
      "\"Manage this session's web-app dev server. Call with action='start' \"",
    );
    expect(source).toContain(
      '"BEFORE building a web app: it scaffolds outputs/web, installs "',
    );
    expect(source).toContain(
      '"dependencies, starts the dev server, and waits until it serves. "',
    );
    expect(source).toContain(
      '"SAFE TO CALL REPEATEDLY: it reconciles current state (already "',
    );
    expect(source).toContain(
      "\"running = success, crashed = restarted). Use action='status' or \"",
    );
    expect(source).toContain(
      "\"'logs' to diagnose problems, and action='restart' if the server is \"",
    );
    expect(source).toContain(
      '"up but misbehaving. NEVER run `bun run dev` or start your own "',
    );
    expect(source).toContain(
      '"server; the preview proxy only routes to the port this tool manages.",',
    );
    // The action enum + describes (onyx :184-193).
    expect(source).toContain('.enum(["start", "status", "logs", "restart"])');
    expect(source).toContain(
      '"start: scaffold/install/start the dev server and wait for it " +',
    );
    expect(source).toContain(
      '"become ready (idempotent - safe even if already running). " +',
    );
    expect(source).toContain(
      '"status: report whether the server is running, without " +',
    );
    expect(source).toContain(
      '"starting anything. logs: show a larger log tail for " +',
    );
    expect(source).toContain(
      '"debugging. restart: stop the current server (if any) and " +',
    );
    expect(source).toContain(
      '"start it again - use when it\'s up but misbehaving."',
    );
    expect(source).toContain(
      '"Log lines to include, default 30, max 200 - only meaningful " +',
    );
    expect(source).toContain("\"for action='logs'.\"");
    // Titles (onyx :204-210).
    expect(source).toContain('start: "Starting web app…"');
    expect(source).toContain('restart: "Restarting web app…"');
    // OCR r3: the restart arm carries the script's pid identity guard — the
    // kill fires only when /proc/<pid>/cwd is this session's app dir (onyx's
    // plugin restart arm — pinned webapp.ts:236-244 — kills on kill -0 alone;
    // OpenBot deliberately ports the guard in, a documented deviation).
    expect(source).toContain(
      "if (pid !== null && (await pidOwnsAppDir(pid, dir))) {",
    );
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source pin
      "(await readlink(`/proc/${pid}/cwd`)) === `${dir}/${APP_DIR_REL}`",
    );
    expect(source).toContain('status: "Checking web app status…"');
    expect(source).toContain('logs: "Reading web app logs…"');
    // Constants (onyx :36-41).
    expect(source).toContain("DEFAULT_ACTION_LOG_LINES = 10");
    expect(source).toContain("DEFAULT_LOGS_LINES = 30");
    expect(source).toContain("MAX_LOG_LINES = 200");
    expect(source).toContain("START_TIMEOUT_MS = 150_000");
    expect(source).toContain("MAX_OUTPUT_BYTES = 8 * 1024");
    expect(source).toContain("PROBE_TIMEOUT_MS = 2000");
  });

  test("carries onyx's result strings verbatim (unavailable + headlines + classification)", async () => {
    const source = await readFile(
      new URL("../src/craft/templates/webapp.plugin.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      '"state: unavailable\\n" +\n  "this session has no web-app support (headless session) or the bootstrap " +\n  "script was deleted; reopen the session to regenerate it; never run " +\n  "`bun run dev` yourself."',
    );
    expect(source).toContain('"webapp was already running"');
    expect(source).toContain('"webapp started successfully"');
    expect(source).toContain(
      '"webapp start failed: something else is bound to the managed " +',
    );
    // The assertions below pin onyx's TEMPLATE-LITERAL source text verbatim —
    // the ${…} inside the string is the subject, not an interpolation.
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
      '`port${obs.port !== null ? ` ${obs.port}` : ""}. Kill that ` +',
    );
    expect(source).toContain(
      '"process (e.g. `fuser -k <port>/tcp`), then call webapp start " +',
    );
    expect(source).toContain(
      '"again. Do not start a server on a different port; the " +',
    );
    expect(source).toContain(
      '"preview proxy only routes to the managed port.";',
    );
    expect(source).toContain(
      '"webapp start failed: the server did not become ready. the " +',
    );
    expect(source).toContain(
      '"server crashed or the app code throws on boot; read the log " +',
    );
    expect(source).toContain(
      '"tail, fix the code, then call webapp start again.";',
    );
    expect(source).toContain(
      '"webapp start failed. fix the error shown above, then call " +',
    );
    expect(source).toContain('"webapp start again.";');
    // Status/logs headlines (onyx :217-233).
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
      "`web app is running on port ${obs.port} and the preview updates live (hot reload)`",
    );
    expect(source).toContain('"web app is not running; call webapp start"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
    expect(source).toContain("`web app is running on port ${obs.port}`");
    expect(source).toContain('"web app is not running"');
    // Observation lines (onyx :100-129).
    expect(source).toContain(
      '"port: unknown (could not parse PORT from start-webapp.sh)"',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
    expect(source).toContain("`app dir: ${APP_DIR_REL}`");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
    expect(source).toContain("`logs: ${LOG_REL}`");
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: onyx-verbatim source pin
      "`--- last ${cappedLines} lines of ${LOG_REL} ---`",
    );
    // Error kinds.
    expect(source).toContain('errorKind = "port_conflict"');
    expect(source).toContain('errorKind = "app_boot_failure"');
    expect(source).toContain('errorKind = "bootstrap_failure"');
    expect(source).toContain('output.includes("already running")');
    expect(source).toContain('output.includes("EADDRINUSE")');
    expect(source).toContain('output.includes("address already in use")');
    expect(source).toContain('output.includes("did not become ready")');
  });
});

// ---------------------------------------------------------------------------
// ② behaviors (real bash scripts, real files, a real listener, live pids)
// ---------------------------------------------------------------------------

describe("webapp tool behaviors (F5 B–E)", () => {
  test("no app: missing script → the unavailable observation, byte-exact", async () => {
    const dir = makeSessionDir({});
    const { result } = await executeWebapp(dir, { action: "start" });
    expect(result).toBe(
      "state: unavailable\n" +
        "this session has no web-app support (headless session) or the bootstrap " +
        "script was deleted; reopen the session to regenerate it; never run " +
        "`bun run dev` yourself.",
    );
  }, 10000);

  test("first start: exit 0 → the success result byte-exact, running observation", async () => {
    const port = await startListener();
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=${port}\necho "Copying outputs template"\necho "web app dev server running on port ${port} - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand."\n`,
      "nextjs.pid": `${spawnLivePid()}\n`,
      "outputs/web/package.json": '{"name":"web"}\n',
    });
    const { result, metadataTitles } = await executeWebapp(dir, {
      action: "start",
    });
    expect(metadataTitles).toEqual(["Starting web app…"]);
    // onyx's format is verbatim: headline, script output (its trailing newline
    // included), a blank line, then the observation block.
    expect(result).toBe(
      "webapp started successfully\n\n" +
        "--- script output ---\n" +
        `Copying outputs template\nweb app dev server running on port ${port} - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand.\n` +
        "\n\n" +
        "state: running\n" +
        `port: ${port}\n` +
        "app dir: outputs/web\n" +
        "scaffolded: yes\n" +
        "logs: nextjs.log",
    );
  }, 15000);

  test("repeated start: output contains 'already running' → the idempotent headline", async () => {
    const port = await startListener();
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=${port}\necho "Next.js server already running (PID 4242); reusing"\n`,
      "nextjs.pid": `${spawnLivePid()}\n`,
      "outputs/web/package.json": '{"name":"web"}\n',
    });
    const { result } = await executeWebapp(dir, { action: "start" });
    expect(result).toContain(
      "webapp was already running\n\n--- script output ---",
    );
    expect(result).toContain("state: running");
  }, 15000);

  test("logs: headline + the tail, clamped to max 200", async () => {
    const port = await startListener();
    const lines = Array.from({ length: 250 }, (_, i) => `log line ${i + 1}`);
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=${port}\n`,
      "nextjs.pid": `${spawnLivePid()}\n`,
      "outputs/web/package.json": '{"name":"web"}\n',
      "nextjs.log": `${lines.join("\n")}\n`,
    });
    const { result, metadataTitles } = await executeWebapp(dir, {
      action: "logs",
    });
    expect(metadataTitles).toEqual(["Reading web app logs…"]);
    // Default 30 lines when args.lines is absent.
    expect(result).toContain(
      `web app is running on port ${port}\n\nstate: running`,
    );
    expect(result).toContain("--- last 30 lines of nextjs.log ---");
    expect(result).toContain("log line 250");
    expect(result).not.toContain("log line 219\n");

    // args.lines clamps at 200.
    const capped = await executeWebapp(dir, { action: "logs", lines: 500 });
    expect(capped.result).toContain("--- last 200 lines of nextjs.log ---");
    expect(capped.result).toContain("log line 51");
    expect(capped.result).not.toContain("log line 50\nlog line 51");
  }, 15000);

  test("status: not running (dead pid, no listener) → the not-running headline", async () => {
    const dir = makeSessionDir({
      "start-webapp.sh": "#!/bin/bash\nPORT=3017\n",
      // A pid that certainly does not exist.
      "nextjs.pid": "999999\n",
      "outputs/web/package.json": '{"name":"web"}\n',
    });
    const { result, metadataTitles } = await executeWebapp(dir, {
      action: "status",
    });
    expect(metadataTitles).toEqual(["Checking web app status…"]);
    expect(result).toBe(
      "web app is not running; call webapp start\n\n" +
        "state: not_running\n" +
        "port: 3017\n" +
        "app dir: outputs/web\n" +
        "scaffolded: yes\n" +
        "logs: nextjs.log",
    );
  }, 10000);

  test("unparseable PORT → the unknown-port observation line", async () => {
    const dir = makeSessionDir({
      "start-webapp.sh": "#!/bin/bash\necho nothing\n",
    });
    const { result } = await executeWebapp(dir, { action: "status" });
    expect(result).toContain(
      "port: unknown (could not parse PORT from start-webapp.sh)",
    );
    expect(result).toContain("scaffolded: no");
  }, 10000);

  test("port conflict: EADDRINUSE output → the port_conflict class with the port", async () => {
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=3017\necho "Error: listen EADDRINUSE: address already in use 0.0.0.0:3017"\nexit 1\n`,
    });
    const { result } = await executeWebapp(dir, { action: "start" });
    expect(result).toContain("error_kind: port_conflict");
    expect(result).toContain(
      "webapp start failed: something else is bound to the managed port 3017. " +
        "Kill that process (e.g. `fuser -k <port>/tcp`), then call webapp start " +
        "again. Do not start a server on a different port; the preview proxy " +
        "only routes to the managed port.",
    );
  }, 10000);

  test("readiness failure: 'did not become ready' → the app_boot_failure class", async () => {
    const dir = makeSessionDir({
      "start-webapp.sh":
        '#!/bin/bash\nPORT=3017\necho "server did not become ready - check nextjs.log; if it crashed, fix the error and re-run bash start-webapp.sh" >&2\nexit 1\n',
    });
    const { result } = await executeWebapp(dir, { action: "start" });
    expect(result).toContain("error_kind: app_boot_failure");
    expect(result).toContain(
      "webapp start failed: the server did not become ready. the " +
        "server crashed or the app code throws on boot; read the log " +
        "tail, fix the code, then call webapp start again.",
    );
    // The result shape: headline, script output, error_kind line, observation.
    expect(result).toMatch(
      /^webapp start failed: the server did not become ready\./,
    );
    expect(result).toContain("--- script output ---");
  }, 10000);

  test("other failure → the bootstrap_failure class", async () => {
    const dir = makeSessionDir({
      "start-webapp.sh":
        '#!/bin/bash\nPORT=3017\necho "bun: command not found"\nexit 127\n',
    });
    const { result } = await executeWebapp(dir, { action: "start" });
    expect(result).toContain("error_kind: bootstrap_failure");
    expect(result).toContain(
      "webapp start failed. fix the error shown above, then call webapp start again.",
    );
  }, 10000);

  test("restart kills a live pid only when its identity verifies — otherwise the kill is skipped and start reconciles", async () => {
    const port = await startListener();
    const victim = spawnExtraPid();
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=${port}\necho "web app dev server running on port ${port} - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand."\n`,
      "nextjs.pid": `${victim}\n`,
      "outputs/web/package.json": '{"name":"web"}\n',
    });
    const { result, metadataTitles } = await executeWebapp(dir, {
      action: "restart",
    });
    expect(metadataTitles).toEqual(["Restarting web app…"]);
    expect(result).toContain("webapp started successfully");
    // OCR r3: kill -0 alone trusts a recycled pid. On this darwin host /proc
    // does not exist, so the pid's identity CANNOT be established — the kill
    // must be skipped (the victim survives) and the start path still runs; on
    // the Linux sandbox, readlink /proc/<pid>/cwd verifies and the kill
    // proceeds (the guard itself is source-pinned in the test above).
    let alive = true;
    try {
      process.kill(victim, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  }, 20000);

  // ── OCR round-3: the lines argument gets a floor ───────────────────────────
  // slice(-0) === slice(0): a 0/negative lines must not dump the whole
  // un-rotated nextjs.log into the observation, past the advertised max 200.
  test("logs: lines of 0/negative clamps to 1 line; non-finite falls back to the default 30", async () => {
    const port = await startListener();
    const dir = makeSessionDir({
      "start-webapp.sh": `#!/bin/bash\nPORT=${port}\necho ok\n`,
      "nextjs.log": "alpha\nbeta\ngamma\n",
    });
    const zero = await executeWebapp(dir, { action: "logs", lines: 0 });
    expect(zero.result).toContain("--- last 1 lines of nextjs.log ---");
    expect(zero.result).toContain("gamma");
    expect(zero.result).not.toContain("alpha");

    const negative = await executeWebapp(dir, { action: "logs", lines: -5 });
    expect(negative.result).toContain("--- last 1 lines of nextjs.log ---");
    expect(negative.result).not.toContain("alpha");

    // NaN (a malformed agent input): the default 30, which for this 3-line
    // log legitimately includes everything.
    const nan = await executeWebapp(dir, { action: "logs", lines: Number.NaN });
    expect(nan.result).toContain("--- last 30 lines of nextjs.log ---");
  }, 15000);

  // ── the full pipeline: real plugin + REAL generated script, shimmed bun ──────
  // The closest executable evidence to a live sandbox session available outside
  // one: start-webapp.sh as generated by nextjs-dev.ts, executed by the plugin
  // verbatim, provisioning the reserved port end to end (only `bun` and `flock`
  // are PATH shims; curl, bash, and the probe are real).
  test("full pipeline: the real generated script provisions the reserved port once, idempotently", async () => {
    // A free port: occupy to learn it, release for the script to bind.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);

    const dir = makeSessionDir({
      "outputs/web/package.json":
        '{"name":"web","scripts":{"dev":"next dev"}}\n',
    });
    const script = buildWebappBootstrapScript({
      sessionDirectory: dir,
      port,
    });
    writeFileSync(join(dir, "start-webapp.sh"), script);

    // PATH shims (see makeScriptShims): a no-op flock, a bun that serves the
    // requested port, and a readlink standing in for Linux /proc/$pid/cwd so
    // the script's pid cwd-identity guard is exercisable on darwin.
    const { shimDir, procCwdDir } = makeScriptShims(port);
    const originalPath = process.env.PATH;
    const originalProcCwd = process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
    process.env.PATH = `${shimDir}:${originalPath}`;
    process.env.CRAFT_WEBAPP_TEST_PROC_CWD = procCwdDir;
    try {
      const first = await executeWebapp(dir, { action: "start" });
      expect(first.result).toContain("webapp started successfully");
      expect(first.result).toContain(
        `web app dev server running on port ${port} - app dir: outputs/web, logs: nextjs.log.`,
      );
      expect(first.result).toContain(`port: ${port}`);
      expect(first.result).toContain("state: running");

      // Map the provisioned pid's cwd (Linux /proc on the real sandbox; the
      // readlink shim here) so the replay's identity guard reuses it.
      writeFileSync(
        join(procCwdDir, readFileSync(join(dir, "nextjs.pid"), "utf8").trim()),
        `${dir}/outputs/web`,
      );

      // Repeated start: the live pid is reused — the idempotent headline.
      const second = await executeWebapp(dir, { action: "start" });
      expect(second.result).toContain("webapp was already running");

      // The preview's ready probe sees the same port the tool reports.
      expect(await webappDevServerReady({ host: "127.0.0.1", port })).toBe(
        true,
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalProcCwd === undefined) {
        delete process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
      } else {
        process.env.CRAFT_WEBAPP_TEST_PROC_CWD = originalProcCwd;
      }
      // Kill the provisioned dev server via the script's own pid file.
      const pid = Number.parseInt(
        readFileSync(join(dir, "nextjs.pid"), "utf8").trim(),
        10,
      );
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 30000);

  // ── the pid cwd-identity guard (onyx parity) ────────────────────────────────
  // onyx guards the "already running" reuse with readlink /proc/$pid/cwd: pids
  // recycle, so a stale nextjs.pid could otherwise name an unrelated live
  // process — a false "already running" loop whose pid the plugin's restart
  // arm would kill. Mismatch → respawn and drop the stale pid file; match →
  // the reuse path is preserved.
  test("pid cwd-identity guard: recycled pid (cwd mismatch) respawns and clears the pid file; cwd match reuses", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);

    const dir = makeSessionDir({
      "outputs/web/package.json":
        '{"name":"web","scripts":{"dev":"next dev"}}\n',
    });
    writeFileSync(
      join(dir, "start-webapp.sh"),
      buildWebappBootstrapScript({ sessionDirectory: dir, port }),
    );
    const { shimDir, procCwdDir } = makeScriptShims(port);
    const originalPath = process.env.PATH;
    const originalProcCwd = process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
    process.env.PATH = `${shimDir}:${originalPath}`;
    process.env.CRAFT_WEBAPP_TEST_PROC_CWD = procCwdDir;

    // The "recycled" pid: alive (kill -0 passes) but not the webapp — no cwd
    // mapping, so the guard's readlink comparison fails exactly like a
    // recycled pid on the Linux sandbox would.
    const recycled = Bun.spawn(["sleep", "60"]);
    writeFileSync(join(dir, "nextjs.pid"), `${recycled.pid}\n`);

    try {
      // cwd mismatch → treated as not running: the spawn path runs.
      const first = await runBootstrapScript(dir);
      expect(first).toContain("Starting Next.js dev server on port");
      expect(first).toContain("Next.js server started with PID");
      expect(first).toContain(
        `web app dev server running on port ${port} - app dir: outputs/web`,
      );
      // And the stale entry is cleared: the pid file now names the freshly
      // spawned server, never the recycled pid.
      const spawnedPid = readFileSync(join(dir, "nextjs.pid"), "utf8").trim();
      expect(spawnedPid).not.toBe(String(recycled.pid));

      // cwd match (the /proc view of the spawned server) → the already-
      // running path: no respawn, pid file untouched.
      writeFileSync(join(procCwdDir, spawnedPid), `${dir}/outputs/web`);
      const second = await runBootstrapScript(dir);
      expect(second).toContain(
        `Next.js server already running (PID ${spawnedPid}); reusing`,
      );
      expect(second).not.toContain("Next.js server started with PID");
      expect(readFileSync(join(dir, "nextjs.pid"), "utf8").trim()).toBe(
        spawnedPid,
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalProcCwd === undefined) {
        delete process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
      } else {
        process.env.CRAFT_WEBAPP_TEST_PROC_CWD = originalProcCwd;
      }
      recycled.kill();
      const pid = Number.parseInt(
        readFileSync(join(dir, "nextjs.pid"), "utf8").trim(),
        10,
      );
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// ②b scaffold-on-start (onyx semantics restored: cp from the session template)
// ---------------------------------------------------------------------------

describe("start scaffolds outputs/web from the session template", () => {
  /** A free port + the generated script + the PATH shims, ready to run. */
  async function scaffoldHarness(
    files: Record<string, string>,
  ): Promise<{ dir: string; port: number; restore: () => void }> {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);
    const dir = makeSessionDir(files);
    writeFileSync(
      join(dir, "start-webapp.sh"),
      buildWebappBootstrapScript({ sessionDirectory: dir, port }),
    );
    const { shimDir, procCwdDir } = makeScriptShims(port);
    const originalPath = process.env.PATH;
    const originalProcCwd = process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
    process.env.PATH = `${shimDir}:${originalPath}`;
    process.env.CRAFT_WEBAPP_TEST_PROC_CWD = procCwdDir;
    return {
      dir,
      port,
      restore: () => {
        process.env.PATH = originalPath;
        if (originalProcCwd === undefined) {
          delete process.env.CRAFT_WEBAPP_TEST_PROC_CWD;
        } else {
          process.env.CRAFT_WEBAPP_TEST_PROC_CWD = originalProcCwd;
        }
        try {
          const pid = Number.parseInt(
            readFileSync(join(dir, "nextjs.pid"), "utf8").trim(),
            10,
          );
          if (Number.isFinite(pid)) process.kill(pid, "SIGKILL");
        } catch {
          // no pid file / already gone
        }
      },
    };
  }

  test("empty workspace + .openbot/web-template: start scaffolds, byte-exact (dotfiles + binary included)", async () => {
    const iconBytes = Buffer.from([
      0x00, 0x01, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x0a,
    ]);
    const harness = await scaffoldHarness({
      ".openbot/web-template/package.json": '{"name":"template-web"}\n',
      ".openbot/web-template/.oxlintrc.json": '{"rules":{}}\n',
      ".openbot/web-template/app/page.tsx": "export default () => null;\n",
    });
    writeFileSync(
      join(harness.dir, ".openbot/web-template/app/favicon.ico"),
      iconBytes,
    );
    try {
      const output = await runBootstrapScript(harness.dir);
      expect(output).toContain("Copying outputs template");
      // The scaffolded tree is the template, byte for byte.
      expect(
        readFileSync(join(harness.dir, "outputs/web/package.json"), "utf8"),
      ).toBe('{"name":"template-web"}\n');
      expect(
        readFileSync(join(harness.dir, "outputs/web/.oxlintrc.json"), "utf8"),
      ).toBe('{"rules":{}}\n');
      expect(
        readFileSync(join(harness.dir, "outputs/web/app/page.tsx"), "utf8"),
      ).toBe("export default () => null;\n");
      expect(
        readFileSync(join(harness.dir, "outputs/web/app/favicon.ico")),
      ).toEqual(iconBytes);
      // And the run proceeded into install/start (the shimmed bun serves).
      expect(output).toContain(
        `web app dev server running on port ${harness.port}`,
      );
    } finally {
      harness.restore();
    }
  }, 30000);

  test("an existing outputs/web is never overwritten by the template", async () => {
    const harness = await scaffoldHarness({
      "outputs/web/package.json": '{"name":"agent-built"}\n',
      ".openbot/web-template/package.json": '{"name":"template-web"}\n',
    });
    try {
      const output = await runBootstrapScript(harness.dir);
      expect(output).not.toContain("Copying outputs template");
      expect(
        readFileSync(join(harness.dir, "outputs/web/package.json"), "utf8"),
      ).toBe('{"name":"agent-built"}\n');
      expect(output).toContain(
        `web app dev server running on port ${harness.port}`,
      );
    } finally {
      harness.restore();
    }
  }, 30000);

  test("no app AND no template: the original missing-scaffold error, exit 1", async () => {
    const harness = await scaffoldHarness({});
    try {
      const proc = Bun.spawn(["bash", "start-webapp.sh"], {
        cwd: harness.dir,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(1);
      expect(`${out}${err}`).toContain(
        "no web app scaffold found - build your web app under outputs/web first (outputs/web/package.json), then call webapp start again",
      );
      expect(readFileSync(join(harness.dir, ".nextjs-port"), "utf8")).toBe(
        `${harness.port}\n`,
      );
      // No scaffold appeared out of nowhere.
      expect(() =>
        readFileSync(join(harness.dir, "outputs/web/package.json")),
      ).toThrow();
    } finally {
      harness.restore();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// ③ the generated start-webapp.sh (fixture F5 F, environment-adapted)
// ---------------------------------------------------------------------------

describe("buildWebappBootstrapScript (F5 F)", () => {
  const script = buildWebappBootstrapScript({
    sessionDirectory: "/workspace/sessions/cs-1",
    port: 3017,
  });

  test("header carries SESSION_PATH and the reserved PORT (the plugin's parsePort source)", () => {
    expect(script).toContain("SESSION_PATH=/workspace/sessions/cs-1");
    expect(script.match(/^PORT=(\d+)$/m)?.[1]).toBe("3017");
  });

  test("success and failure lines are onyx byte-verbatim", () => {
    expect(script).toContain(
      "echo \"web app dev server running on port $PORT - app dir: outputs/web, logs: nextjs.log. It hot-reloads on file changes and never needs 'bun run dev' run by hand.\"",
    );
    expect(script).toContain(
      'echo "server did not become ready - check nextjs.log; if it crashed, fix the error and re-run bash start-webapp.sh" >&2',
    );
    expect(script).toContain('echo "--- last 30 lines of nextjs.log ---" >&2');
    expect(script).toContain("tail -n 30");
    expect(script).toContain(
      "trap 'echo \"bootstrap failed - read the error above, fix, and re-run bash start-webapp.sh\" >&2' ERR",
    );
  });

  test("one-process guard: flock, pid file, log file, already-running reuse", () => {
    expect(script).toContain("flock -x 9");
    expect(script).toContain('9>"$SESSION_PATH/.webapp.lock"');
    expect(script).toContain('"$SESSION_PATH/nextjs.pid"');
    expect(script).toContain('"$SESSION_PATH/nextjs.log"');
    expect(script).toContain(
      '"Next.js server already running (PID $NEXTJS_PID); reusing"',
    );
    // onyx parity: the pid-alive check is guarded by a cwd identity
    // comparison (readlink /proc/$pid/cwd) so a recycled pid is not mistaken
    // for the webapp process, and a stale pid file is dropped before
    // respawning.
    expect(script).toContain(
      '[ "$(readlink /proc/$NEXTJS_PID/cwd 2>/dev/null)" = "$SESSION_PATH/outputs/web" ]',
    );
    expect(script).toContain('rm -f "$SESSION_PATH/nextjs.pid"');
    // The lock fd must not leak into the dev server.
    expect(script).toContain("9>&-");
  });

  test("starts the dev server on the reserved port, nohup + background", () => {
    expect(script).toContain("nohup bun run dev");
    expect(script).toMatch(/PORT="\$PORT"|PORT=\$PORT/);
    expect(script).toContain('-p "$PORT"');
    // F-E: onyx's own bind (0.0.0.0) is restored — the preview and ready probe
    // dial the SANDBOX host (the published reserved range), not the host's own
    // loopback, so the server must listen beyond container-loopback.
    expect(script).toContain("-H 0.0.0.0");
    expect(script).toContain("Installing dependencies with bun...");
    expect(script).toContain("bun install");
  });

  test("readiness poll: 90s deadline, curl probe on the reserved port", () => {
    expect(script).toContain("DEADLINE=$((SECONDS + 90))");
    expect(script).toContain(
      "curl -s -o /dev/null --noproxy '*' --max-time 2 \"http://127.0.0.1:$PORT/\"",
    );
    expect(script).toContain(
      'echo "Waiting for the dev server to become ready..."',
    );
  });

  test("environment substitution: the scaffold template ships with the session, not the image", () => {
    // OpenBot's sandbox image carries no outputs template; the byte-verbatim
    // onyx tree ships with the server and materializes into the session at
    // .openbot/web-template (managed-content push), so start scaffolds from
    // there — onyx's cp semantics restored — and only reports a missing
    // scaffold when neither the app nor the template exists.
    expect(script).not.toContain("/workspace/templates/outputs");
    expect(script).toContain(
      'if [ ! -f "$SESSION_PATH/outputs/web/package.json" ]; then',
    );
    expect(script).toContain(
      'if [ -f "$SESSION_PATH/.openbot/web-template/package.json" ]; then',
    );
    expect(script).toContain('echo "Copying outputs template"');
    expect(script).toContain(
      'cp -R "$SESSION_PATH/.openbot/web-template" "$SESSION_PATH/outputs/web"',
    );
    expect(script).toContain(
      "no web app scaffold found - build your web app under outputs/web first (outputs/web/package.json), then call webapp start again",
    );
  });

  test("bot-relative session dirs resolve: SESSION_PATH is normalized absolute", () => {
    const rel = buildWebappBootstrapScript({
      sessionDirectory: "cs-1",
      port: 3017,
    });
    expect(rel).toContain(
      'SESSION_PATH="$(cd "$SESSION_PATH" 2>/dev/null && pwd || pwd)"',
    );
  });
});

// ---------------------------------------------------------------------------
// ④ wiring: the plugin ships in the workspace, the script when a port exists
// ---------------------------------------------------------------------------

const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

describe("workspace wiring", () => {
  test("the webapp plugin rides SESSION_PLUGINS and the workspace", async () => {
    expect(SESSION_PLUGINS).toContain("./.opencode/plugin/webapp.ts");
    const files = new Map<string, string>();
    await setupSessionWorkspace(
      {
        writeFile: async (path, content) => files.set(path, content),
        mkdir: async () => undefined,
      },
      {
        sessionId: "cs-w",
        config,
        llmConfig: llm,
        agentsTemplate: "",
        webappPort: 3017,
      },
    );
    const plugin = files.get(
      "/workspace/sessions/cs-w/.opencode/plugin/webapp.ts",
    );
    expect(typeof plugin).toBe("string");
    expect(plugin).toContain("\"Manage this session's web-app dev server.");
    // The script lands at the session root with the reserved port.
    const script = files.get("/workspace/sessions/cs-w/start-webapp.sh");
    expect(script).toContain("PORT=3017");
    // opencode.json references the plugin.
    const parsed = JSON.parse(
      files.get("/workspace/sessions/cs-w/opencode.json") as string,
    );
    expect(parsed.plugin).toContain("./.opencode/plugin/webapp.ts");
    // Files materialize before the config references them (write order).
    expect(
      [...files.keys()].indexOf(
        "/workspace/sessions/cs-w/.opencode/plugin/webapp.ts",
      ),
    ).toBeLessThan(
      [...files.keys()].indexOf("/workspace/sessions/cs-w/opencode.json"),
    );
  });

  test("headless (no reserved port): plugin present, no script — the tool reports unavailable", async () => {
    const files = new Map<string, string>();
    await setupSessionWorkspace(
      {
        writeFile: async (path, content) => files.set(path, content),
        mkdir: async () => undefined,
      },
      {
        sessionId: "cs-h",
        config,
        llmConfig: llm,
        agentsTemplate: "",
        webappPort: null,
      },
    );
    expect(
      files.has("/workspace/sessions/cs-h/.opencode/plugin/webapp.ts"),
    ).toBe(true);
    expect(files.has("/workspace/sessions/cs-h/start-webapp.sh")).toBe(false);
  });

  test("the script is protected content: edit/write/patch deny + the two bash fallbacks allow", async () => {
    const files = new Map<string, string>();
    await setupSessionWorkspace(
      {
        writeFile: async (path, content) => files.set(path, content),
        mkdir: async () => undefined,
      },
      {
        sessionId: "cs-p",
        config,
        llmConfig: llm,
        agentsTemplate: "",
        webappPort: 3017,
      },
    );
    const permission = JSON.parse(
      files.get("/workspace/sessions/cs-p/opencode.json") as string,
    ).permission;
    for (const tool of ["edit", "write", "patch"]) {
      expect(permission[tool]["start-webapp.sh"]).toBe("deny");
      expect(permission[tool]["**/start-webapp.sh"]).toBe("deny");
      expect(permission[tool]["**/.opencode/plugin/**"]).toBe("deny");
    }
    // findLast: the exact fallback commands allow AFTER the wildcard deny.
    const bashRules = Object.entries(permission.bash);
    expect(bashRules.findLast(([k]) => k === "*start-webapp.sh*")?.[1]).toBe(
      "deny",
    );
    expect(bashRules.findLast(([k]) => k === "bash start-webapp.sh")?.[1]).toBe(
      "allow",
    );
    expect(
      bashRules.findLast(([k]) => k === "bash ./start-webapp.sh")?.[1],
    ).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// ⑤ the preview route attaches to the session's reserved port
// ---------------------------------------------------------------------------

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-pv",
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: 3017,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

function proxyHarness(input: {
  session: CraftSessionRow | undefined;
  files?: string[];
}) {
  const files = new Set(input.files ?? []);
  const gateway = {
    fileApiFor: () => ({
      async listFiles(path: string) {
        return [...files].filter((f) => f.startsWith(`${path}/`));
      },
    }),
  } as unknown as SandboxGateway;
  const app = createWebappProxyRoutes(
    async (context, next) => {
      context.set("actor", { id: "u1", email: "u1@x", role: "user" });
      await next();
    },
    {
      config,
      store: {
        getSession: async () => input.session,
      } as unknown as CraftStore,
      gateway,
      botIdFor: async () => "craft",
      sandboxConnectionFor: () => ({
        baseUrl: "http://127.0.0.1:1",
        token: null,
      }),
    },
  );
  return { app };
}

describe("webapp preview route (reserved-port attach)", () => {
  test("webapp-info: honest ready via the port probe, has_webapp from the scaffold", async () => {
    const port = await startListener();
    const { app } = proxyHarness({
      session: sessionRow({ nextjsPort: port }),
      files: ["/workspace/sessions/cs-pv/outputs/web/package.json"],
    });
    const response = await app.request("/sessions/cs-pv/webapp-info");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.has_webapp).toBe(true);
    expect(body.webapp_url).toBe("/api/craft/sessions/cs-pv/webapp");
    expect(body.ready).toBe(true);
  });

  test("webapp-info: not scaffolded or down → ready false", async () => {
    const { app } = proxyHarness({
      session: sessionRow({ nextjsPort: 3017 }),
      files: [],
    });
    const response = await app.request("/sessions/cs-pv/webapp-info");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.has_webapp).toBe(false);
    expect(body.ready).toBe(false);
  });

  test("preview proxies to the session's reserved port when the dev server answers", async () => {
    const port = await startListener();
    const { app } = proxyHarness({
      session: sessionRow({ nextjsPort: port }),
      files: ["/workspace/sessions/cs-pv/outputs/web/package.json"],
    });
    const response = await app.request("/sessions/cs-pv/webapp/index.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("preview when the dev server is down → 503 with guidance", async () => {
    const { app } = proxyHarness({
      session: sessionRow({ nextjsPort: 3017 }),
      files: ["/workspace/sessions/cs-pv/outputs/web/package.json"],
    });
    const response = await app.request("/sessions/cs-pv/webapp");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("not running");
  });

  test("headless session (no reserved port) → 503, not a spawn attempt", async () => {
    const { app } = proxyHarness({
      session: sessionRow({ nextjsPort: null }),
      files: ["/workspace/sessions/cs-pv/outputs/web/package.json"],
    });
    const response = await app.request("/sessions/cs-pv/webapp");
    expect(response.status).toBe(503);
  });

  test("ownership: another user's session is a 404", async () => {
    const { app } = proxyHarness({ session: undefined });
    const response = await app.request("/sessions/cs-pv/webapp/");
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// ⑥ webappDevServerReady (onyx manager.py:1570-1593 — any answer counts)
// ---------------------------------------------------------------------------

describe("webappDevServerReady", () => {
  test("a live listener on the given host answers true; a dead port answers false", async () => {
    const port = await startListener();
    expect(await webappDevServerReady({ host: "127.0.0.1", port })).toBe(true);
    expect(await webappDevServerReady({ host: "127.0.0.1", port: 3017 })).toBe(
      false,
    );
  });

  test("dials the SANDBOX host it is handed, with any-answer semantics (F-E)", async () => {
    const dialed: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      dialed.push(String(input));
      return new Response("nope", { status: 404 }); // ANY answer counts (onyx)
    }) as typeof fetch;
    expect(
      await webappDevServerReady(
        { host: "sbox.internal", port: 3011 },
        fetchImpl,
      ),
    ).toBe(true);
    expect(dialed).toEqual(["http://sbox.internal:3011/"]);

    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await webappDevServerReady(
        { host: "sbox.internal", port: 3011 },
        refused,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑦ reconcile refreshes the tool and disposes when the tool config changes
// ---------------------------------------------------------------------------

describe("reconcile: webapp tool rides the regenerate + dispose", () => {
  test("a workspace predating the webapp plugin: config rewritten, plugin + script materialized, instance disposed", async () => {
    const files = new Map<string, string>();
    const disposals: string[] = [];
    // The workspace carries a config WITHOUT the webapp plugin (the pre-Task-4 bytes).
    files.set(
      "/workspace/sessions/cs-rc/opencode.json",
      JSON.stringify({ plugin: ["./.opencode/plugin/turn-budget.ts"] }),
    );
    const gateway = {
      fileApiFor: () => ({
        async listFiles() {
          return ["/workspace/sessions/cs-rc/outputs"];
        },
        async readFile(path: string) {
          return files.get(path) ?? null;
        },
        async writeFile(path: string, content: string) {
          files.set(path, content);
        },
      }),
      workspaceApiFor: () => ({
        async writeFile(path: string, content: string) {
          files.set(path, content);
        },
        mkdir: async () => undefined,
      }),
      serveClientFor: ({ directory }: { directory: string }) => ({
        disposeInstance: async () => {
          disposals.push(directory);
        },
      }),
    } as unknown as SandboxGateway;
    const manager = new CraftSessionManager({
      config,
      store: {
        async updateSession() {
          return undefined;
        },
      } as unknown as CraftStore,
      gateway,
      llmConfigFor: async () => llm,
      botIdFor: async () => "craft",
    });

    await manager.reconcileSessionLlmConfig(
      {} as never,
      {
        ...sessionRow({ id: "cs-rc", nextjsPort: 3017 }),
      },
      null,
    );

    // The config now carries the webapp plugin (the byte-compare flipped)...
    const rewritten = JSON.parse(
      files.get("/workspace/sessions/cs-rc/opencode.json") as string,
    );
    expect(rewritten.plugin).toContain("./.opencode/plugin/webapp.ts");
    // ...the plugin and the protected script materialized beside it...
    expect(
      files.has("/workspace/sessions/cs-rc/.opencode/plugin/webapp.ts"),
    ).toBe(true);
    expect(files.get("/workspace/sessions/cs-rc/start-webapp.sh")).toContain(
      "PORT=3017",
    );
    // ...and the old instance was disposed so a fresh one loads the new tools.
    expect(disposals).toEqual(["/workspace/sessions/cs-rc"]);
  });
});
