import { expect, onTestFinished, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./update-local";

/**
 * start.sh launches the API server with this machine's pilot settings file, deploy/.local/pilot.env,
 * so switching a machine onto the pilot survives the ordinary startup. The real Bun loads the env
 * files the launch names, which is what pins two things at once: the file's values reach the server,
 * and a machine without the file starts the same way.
 */

test("the server launch carries this machine's pilot settings file, whose values win over the settings files", async () => {
  const { invocation, serverEnvironment, addPid } = await runStart({
    pilot: true,
  });
  const stdout = await invocation;
  expect(stdout).toContain("Ready. http://localhost:3010");
  expect(serverEnvironment).toEqual({
    pid: expect.any(Number),
    // The pilot file's value, not the settings file's: the pilot file is given last.
    PILOT_WINS: "from-pilot-file",
    // The pilot-only variable reached the server, so the launch really names the file.
    PILOT_PROBE: "from-pilot-file",
    // The settings files are still loaded, so the pilot file only wins over them.
    PILOT_FROM_SERVER: "from-server-file",
    PRELOAD_RAN: null,
  });
  addPid(serverEnvironment.pid);
}, 15_000);

test("a machine without the pilot settings file starts the same way", async () => {
  const { invocation, serverEnvironment, addPid } = await runStart({});
  const stdout = await invocation;
  expect(stdout).toContain("Ready. http://localhost:3010");
  expect(serverEnvironment).toEqual({
    pid: expect.any(Number),
    // Nothing supplied the pilot's values, and the settings file stands.
    PILOT_WINS: "from-server-file",
    PILOT_PROBE: null,
    PILOT_FROM_SERVER: "from-server-file",
    PRELOAD_RAN: null,
  });
  addPid(serverEnvironment.pid);
}, 15_000);

test("the Infisical launch carries the pilot settings file too", async () => {
  const { invocation, serverEnvironment, addPid } = await runStart({
    pilot: true,
    infisical: true,
  });
  const stdout = await invocation;
  expect(stdout).toContain("Ready. http://localhost:3010");
  expect(serverEnvironment).toEqual({
    pid: expect.any(Number),
    PILOT_WINS: "from-pilot-file",
    PILOT_PROBE: "from-pilot-file",
    // The Infisical launch does not read the settings files; Infisical stands in for them. That the
    // pilot file wins over Infisical is pinned in server/tests/infisical-env.test.ts.
    PILOT_FROM_SERVER: null,
    // The launch names the preload, which ran ahead of the entry point.
    PRELOAD_RAN: "yes",
  });
  addPid(serverEnvironment.pid);
}, 15_000);

async function runStart({
  pilot = false,
  infisical = false,
}: {
  pilot?: boolean;
  infisical?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "openbot-start-pilot-"));
  const bin = join(root, "bin");
  const pids: number[] = [];
  let invocation: Promise<string> | undefined;
  const executable = async (name: string, contents: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/usr/bin/env bash\n${contents}\n`);
    await chmod(path, 0o755);
  };
  onTestFinished(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          throw error;
      }
    }
    await invocation;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(
    ["bin", "scripts", "server/src", "server/scripts", "app"].map((path) =>
      mkdir(join(root, path), { recursive: true }),
    ),
  );
  for (const name of ["start.sh", "require-bash.sh", "processes.sh"])
    await writeFile(
      join(root, "scripts", name),
      await readFile(`scripts/${name}`),
    );
  // One settings file per service; start.sh refuses to run without all four.
  for (const directory of [
    "deploy/openbot",
    "deploy/agents",
    "deploy/.local",
    "deploy/infisical",
  ])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "deploy/openbot/.env"), "");
  await writeFile(join(root, "deploy/openbot/.env.worker"), "");
  await writeFile(
    join(root, "deploy/openbot/.env.server"),
    [
      "OPENBOT_ONE_COMPUTER_EACH=false",
      "PILOT_WINS=from-server-file",
      "PILOT_FROM_SERVER=from-server-file",
    ].join("\n"),
  );
  await writeFile(
    join(root, "deploy/agents/.env"),
    [
      "MANAGED_AGENT_TOKEN=synthetic-managed-token",
      "AGENT_TOOL_TOKEN=synthetic-tool-token",
    ].join("\n"),
  );
  if (pilot)
    await writeFile(
      join(root, "deploy/.local/pilot.env"),
      [
        "OPENBOT_PILOT_PROBE=from-pilot-file",
        "PILOT_WINS=from-pilot-file",
      ].join("\n"),
    );
  if (infisical)
    await writeFile(join(root, "deploy/infisical/.env.openbot-client"), "");

  // The entry point the server launch names. The real Bun runs it with the launch's own flags, so
  // the values below are what the env files on that command line produced.
  await writeFile(
    join(root, "server/src/production-entry.ts"),
    `import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.TEST_ROOT!;
const report = {
  pid: process.pid,
  PRELOAD_RAN: process.env.PRELOAD_RAN ?? null,
  PILOT_FROM_SERVER: process.env.PILOT_FROM_SERVER ?? null,
  PILOT_PROBE: process.env.OPENBOT_PILOT_PROBE ?? null,
  PILOT_WINS: process.env.PILOT_WINS ?? null,
};
// Whole, by rename: a read in the moment an in-place write exists empty is \`Number("")\`, 0, and the
// cleanup below would signal the test runner's own process group.
writeFileSync(join(root, "server-env.json.tmp"), JSON.stringify(report));
renameSync(join(root, "server-env.json.tmp"), join(root, "server-env.json"));
await Bun.sleep(30_000);
`,
  );
  // The Infisical launch names this preload. The stand-in answers the one question this file asks:
  // did the launch carry the preload, and did it run ahead of the entry point.
  await writeFile(
    join(root, "server/scripts/infisical-env.ts"),
    'process.env.PRELOAD_RAN = "yes";\n',
  );
  await writeFile(
    join(root, "service.ts"),
    'import {join} from "node:path"; import {renameSync, writeFileSync} from "node:fs"; const file = join(process.env.TEST_ROOT!, process.argv[2]+".pid"); writeFileSync(file+".tmp", String(process.pid)); renameSync(file+".tmp", file); await Bun.sleep(30_000);',
  );
  // Answers start.sh's `psql -tAc "select to_regclass('public.<table>')"` the way psql does: the one
  // table it names, and nothing more. See scripts/start-detached.test.ts for the SIGPIPE story.
  await executable(
    "docker",
    `printf '%s\\n' "$*" | sed -n "s/.*to_regclass('public\\.\\([a-z_]*\\)').*/\\1/p"`,
  );
  await executable("sleep", "exit 0");
  await executable("pkill", "exit 0");
  await executable(
    "lsof",
    'if [[ "$*" == *"-d cwd"* ]]; then printf "n%s\\n" "$TEST_ROOT"; fi',
  );
  await executable(
    "pgrep",
    'if [ -f "$TEST_ROOT/worker.pid" ]; then cat "$TEST_ROOT/worker.pid"; else exit 1; fi',
  );
  await executable(
    "curl",
    `case "$*" in
  *"/api/capabilities"*)
    [ -f "$TEST_ROOT/server-env.json" ] || exit 7
    printf '{"mode":"openbot","durableHistory":true}' ;;
  *"http://localhost:3010/"*)
    [ -f "$TEST_ROOT/app.pid" ] || exit 7
    printf '<title>OpenBot</title>' ;;
esac`,
  );
  // The server role runs as the real Bun with the launch's own flags; the worker and the app are
  // stand-ins. The runtime health check is piped into `bun run -`, so that one invocation is also
  // the real Bun. See scripts/start-detached.test.ts, which this harness follows.
  await executable(
    "bun",
    `if [ "$1" = run ] && [ "$2" = - ]; then exec "$REAL_BUN" "$@"; fi
case "$*" in
  *"src/production-entry.ts"*) exec "$REAL_BUN" "$@" ;;
  *"worker/src/index.ts"*) role=worker ;;
  *"run dev"*) role=app ;;
  *) exit 0 ;;
esac
exec "$REAL_BUN" "$TEST_ROOT/service.ts" "$role"`,
  );
  invocation = runCommand(["bash", "scripts/start.sh"], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TEST_ROOT: root,
      REAL_BUN: process.execPath,
    },
  });
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(join(root, "server-env.json")).exists())) {
    if (Date.now() > deadline) throw new Error("Server did not launch");
    await Bun.sleep(20);
  }
  return {
    invocation,
    serverEnvironment: (await Bun.file(
      join(root, "server-env.json"),
    ).json()) as {
      pid: number;
      PRELOAD_RAN: string | null;
      PILOT_FROM_SERVER: string | null;
      PILOT_PROBE: string | null;
      PILOT_WINS: string | null;
    },
    addPid: (pid: number) => pids.push(pid),
  };
}
