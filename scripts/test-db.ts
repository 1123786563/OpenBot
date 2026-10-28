/**
 * The database the driven tier needs, reported as it actually is on this machine.
 *
 * `bun run test` loads `.env` once (e2e.unit.config.ts) and the guard in
 * `server/tests/support/database.ts` then refuses to fall back to `DATABASE_URL`. Both halves are
 * deliberate: a suite that creates and drops databases must not be one typo away from the live one.
 * The consequence is that the URL the suite reads is only as good as the last person who edited
 * `.env` — and a published port is not a fact anybody can see. It was hand-rolled into place over
 * and over (`export TEST_DATABASE_URL=$(grep '^DATABASE_URL=' .env | sed …)`) because nothing said
 * "the value in .env points at 5435 and nothing is listening there".
 *
 * So this reports reachability per variable, in the order the suite reads them, and offers to own
 * the missing dependency: `--up` starts a container THIS script names, on a port nothing else has,
 * with the image CI uses (`pgvector/pgvector:pg17` — the knowledge schema needs the extension, and
 * the plain `postgres` the compose file defaults to does not carry it). `--down` removes only what
 * the `openbot-test-db-` prefix proves this script created, because concurrent sessions run their
 * own databases in this checkout and deleting one of those is not a cleanup.
 *
 *     bun scripts/test-db.ts          # report
 *     bun scripts/test-db.ts --up     # start our own, then print the exports
 *     bun scripts/test-db.ts --down   # remove only ours
 *
 * Credentials never reach the output: a URL is reduced to host, port and database name.
 */
import { connect } from "node:net";
import { existsSync } from "node:fs";

const PREFIX = "openbot-test-db-";
const IMAGE = process.env.OPENBOT_TEST_DB_IMAGE ?? "pgvector/pgvector:pg17";
const PORT_RANGE = [55440, 55460] as const;
// The names the driven tier reads, in the order ci.yml declares them for its two services.
const VARIABLES = [
  "TEST_DATABASE_URL",
  "ENTERPRISE_TEST_SETUP_DATABASE_URL",
  "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
  "ENTERPRISE_TEST_DATA_DATABASE_URL",
  "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
] as const;

if (existsSync(".env")) process.loadEnvFile(".env");
const [command = "report"] = process.argv.slice(2);

/** host:port/database, with any userinfo dropped — this is printed, the real value is not. */
function describe(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "5432"}/${decodeURIComponent(parsed.pathname.replace(/^\//, ""))}`;
  } catch {
    return "<not a URL>";
  }
}

function reachable(url: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const socket = connect(
      {
        host: target.hostname,
        port: Number(target.port || 5432),
        timeout: timeoutMs,
      },
      () => finish(true),
    );
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
}

function spawn(args: string[]): { ok: boolean; out: string; err: string } {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    out: new TextDecoder().decode(result.stdout).trim(),
    err: new TextDecoder().decode(result.stderr).trim(),
  };
}

/** Ports this machine already publishes or binds, so `--up` cannot wedge a running session. */
async function busyPorts(): Promise<Set<number>> {
  const busy = new Set<number>();
  for (const url of VARIABLES.map((name) => process.env[name])) {
    if (url) {
      try {
        busy.add(Number(new URL(url).port || 5432));
      } catch {
        // A malformed value is reported by the report loop, not here.
      }
    }
  }
  const containers = spawn(["docker", "ps", "--format", "{{.Ports}}"]);
  if (containers.ok) {
    for (const match of containers.out.matchAll(/127\.0\.0\.1:(\d+)->/g)) {
      busy.add(Number(match[1]));
    }
  }
  return busy;
}

async function report(): Promise<number> {
  let unusable = 0;
  for (const name of VARIABLES) {
    const value = process.env[name]?.trim();
    if (!value) {
      console.log(`${name}: unset`);
      unusable += 1;
      continue;
    }
    if (await reachable(value)) {
      console.log(`${name}: reachable at ${describe(value)}`);
      continue;
    }
    console.error(`::error::${name}: set but refused at ${describe(value)}`);
    unusable += 1;
  }
  if (unusable === 0) {
    console.log(
      "\nEvery database the driven tier reads is answering. Nothing to bring up.",
    );
    return 0;
  }
  console.error(
    `\n${unusable} of ${VARIABLES.length} database targets are not answering, so the groups that need them\n` +
      "report connection refusals, which is a missing dependency and not a product verdict.\n" +
      `Bring up one this script owns: bun scripts/test-db.ts --up`,
  );
  return 1;
}

async function up(): Promise<number> {
  const busy = await busyPorts();
  const port = Array.from(
    { length: PORT_RANGE[1] - PORT_RANGE[0] },
    (_, index) => PORT_RANGE[0] + index,
  ).find((candidate) => !busy.has(candidate));
  if (!port) {
    console.error(
      `::error::No free port in ${PORT_RANGE[0]}..${PORT_RANGE[1]}; every candidate is published or named by .env.`,
    );
    return 1;
  }
  const name = `${PREFIX}${port}`;
  const started = spawn([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--rm",
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    "POSTGRES_DB=openbot_test",
    "-e",
    "POSTGRES_USER=openbot",
    "-e",
    "POSTGRES_PASSWORD=openbot",
    IMAGE,
  ]);
  if (!started.ok) {
    console.error(
      `::error::${name} did not start: ${started.err.split("\n").slice(-2).join(" ")}`,
    );
    console.error(
      `If the image is the problem, pull it or point at another: OPENBOT_TEST_DB_IMAGE=pgvector/pgvector:pg17 bun scripts/test-db.ts --up`,
    );
    return 1;
  }
  const url = `postgres://openbot:openbot@127.0.0.1:${port}/openbot_test`;
  const enterpriseUrl = `postgres://openbot:openbot@127.0.0.1:${port}/openbot_enterprise_test`;
  // Readiness is asked of the server, not of the port: a published port under OrbStack accepts
  // connections as soon as the proxy is up, which is seconds before Postgres finishes
  // initialising, and a suite told "reachable" then still fails on a cold server.
  const ready = () =>
    spawn([
      "docker",
      "exec",
      "-e",
      "PGPASSWORD=openbot",
      name,
      "pg_isready",
      "-q",
      "-U",
      "openbot",
    ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (ready().ok) {
      // POSTGRES_DB makes one database; the enterprise guard refuses any name that is not
      // `openbot_enterprise_*` (server/tests/support/enterprise-database.ts), so it is made here
      // rather than left for the reader to meet as a refusal.
      const created = spawn([
        "docker",
        "exec",
        "-e",
        "PGPASSWORD=openbot",
        name,
        "createdb",
        "-U",
        "openbot",
        "openbot_enterprise_test",
      ]);
      if (!created.ok && !/already exists/.test(created.err)) {
        console.error(
          `::error::${name} came up but the enterprise database was not created: ${created.err}`,
        );
        return 1;
      }
      console.log(`${name} is listening on 127.0.0.1:${port}`);
      console.log(
        [
          "",
          `export TEST_DATABASE_URL="${url}"`,
          `export ENTERPRISE_TEST_SETUP_DATABASE_URL="${enterpriseUrl}"`,
          // The role-bound URLs are not invented here: the setup database creates the
          // `ob_ent_*` roles, and those URLs have to carry them.
          "",
          "Migrations and the enterprise roles are yours to run against this server:",
          "  cd server && bun scripts/migrate.ts",
          "  bun server/scripts/multitenancy/migrate-test.ts",
          "",
          `Finish with: bun scripts/test-db.ts --down`,
        ].join("\n"),
      );
      return 0;
    }
    await Bun.sleep(1000);
  }
  console.error(
    `::error::${name} started but never accepted a connection on ${port}.`,
  );
  console.error(
    `Inspect it with: docker logs ${name} — then bun scripts/test-db.ts --down`,
  );
  return 1;
}

async function down(): Promise<number> {
  const listed = spawn([
    "docker",
    "ps",
    "-a",
    "--filter",
    `name=${PREFIX}`,
    "--format",
    "{{.Names}}",
  ]);
  if (!listed.ok) {
    console.error(`::error::docker ps failed: ${listed.err}`);
    return 1;
  }
  const names = listed.out
    .split("\n")
    .filter((line) => line.startsWith(PREFIX));
  if (names.length === 0) {
    console.log(
      `Nothing named ${PREFIX}* to remove. Containers from other sessions were left alone.`,
    );
    return 0;
  }
  for (const name of names) {
    const removed = spawn(["docker", "rm", "-f", name]);
    if (!removed.ok) {
      console.error(`::error::${name} was not removed: ${removed.err}`);
      continue;
    }
    console.log(`removed ${name}`);
  }
  return 0;
}

process.exit(
  command === "--up"
    ? await up()
    : command === "--down"
      ? await down()
      : await report(),
);
