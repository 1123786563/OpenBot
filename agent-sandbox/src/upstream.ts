/**
 * One `opencode serve` child process, waited on and owned by this wrapper.
 *
 * The child runs with cwd at the workspace (sessions' files belong there, and opencode resolves
 * permission paths against the working directory — starting it anywhere else is the misconfiguration
 * a 2026-06 upstream issue describes) and with XDG_CONFIG_HOME pointed at the generated config dir,
 * so the deployment's config is the only one it can find.
 */
import { spawn, type ChildProcess } from "node:child_process";

export type Upstream = {
  ready: Promise<void>;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
};

export type UpstreamOptions = {
  bin: string;
  port: number;
  cwd: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  fetchImpl?: typeof fetch;
  readyTimeoutMs?: number;
};

export function startOpencodeServe(options: UpstreamOptions): Upstream {
  const spawnFn = options.spawnFn ?? spawn;
  const doFetch = options.fetchImpl ?? fetch;
  const child: ChildProcess = spawnFn(
    options.bin,
    ["serve", "--hostname", "127.0.0.1", "--port", String(options.port)],
    {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        XDG_CONFIG_HOME: options.configDir,
        HOME: options.configDir,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  let exitCode: number | undefined;
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code ?? -1;
      resolve(exitCode);
    });
  });
  const ready = (async () => {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
    for (;;) {
      if (exitCode !== undefined) throw new Error("opencode serve exited before it was ready.");
      try {
        const probe = await doFetch(`http://127.0.0.1:${options.port}/doc`);
        if (probe.ok) return;
      } catch {
        // Not listening yet; poll until the deadline.
      }
      if (Date.now() > deadline)
        throw new Error("opencode serve did not answer its OpenAPI probe in time.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    ready,
    exited,
    kill: (signal?: NodeJS.Signals) => child.kill(signal ?? "SIGTERM"),
  };
}
