import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The preload that loads the server's settings from Infisical, run the way the server runs it: in a
 * fresh `bun` process, against a stand-in Infisical on loopback. The stand-in answers the two routes
 * the SDK calls and records what it was asked, which is how the test knows what was sent, including
 * the precedence the preload exists to get right: the shell, then Infisical, then .env.
 */

const preload = resolve(import.meta.dir, "../scripts/infisical-env.ts");
// Named the way the real ones are: the preload knows a file by the end of its path.
const directory = join(
  mkdtempSync(join(tmpdir(), "infisical-env-")),
  "deploy/openbot",
);
mkdirSync(directory, { recursive: true });
const dotEnv = join(directory, ".env");
const serverEnv = join(directory, ".env.server");
const CLIENT_SECRET = "secret";

// One Infisical folder per service, as the preload reads them.
const SECRETS = {
  "/": [{ secretKey: "DATABASE_URL", secretValue: "from-infisical" }],
  "/server": [
    { secretKey: "FROM_DOT_ENV", secretValue: "from-infisical" },
    { secretKey: "FROM_SERVER_FILE", secretValue: "from-infisical" },
    { secretKey: "PILOT_KEPT", secretValue: "from-infisical" },
    { secretKey: "db.url", secretValue: "not-a-variable" },
    { secretKey: "EMPTY", secretValue: "" },
  ],
  "/agents": [
    { secretKey: "AGENT_BOT_MODEL", secretValue: "agents-model" },
    { secretKey: "MANAGED_AGENT_TOKEN", secretValue: "from-infisical" },
  ],
};

type Asked = {
  path: string;
  query: string;
  authorization: string | null;
  body: unknown;
};
const asked: Asked[] = [];
const infisical = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    asked.push({
      path: url.pathname,
      query: url.search,
      authorization: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.json() : null,
    });
    const body = asked.at(-1)?.body as { clientSecret?: string } | undefined;
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      if (body?.clientSecret !== CLIENT_SECRET) {
        return Response.json(
          { message: "Invalid client secret" },
          { status: 401 },
        );
      }
      return Response.json({
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresIn: 3600,
      });
    }
    const path = url.searchParams.get("secretPath") ?? "";
    // As Infisical does for a folder nobody has created yet.
    if (!(path in SECRETS))
      return Response.json(
        {
          message: `Folder with path '${path}' in environment 'dev' was not found.`,
        },
        { status: 404 },
      );
    return Response.json({ secrets: SECRETS[path as keyof typeof SECRETS] });
  },
});
afterAll(() => {
  infisical.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

const identity = {
  INFISICAL_SITE_URL: `http://127.0.0.1:${infisical.port}`,
  INFISICAL_PROJECT_ID: "project",
  INFISICAL_CLIENT_ID: "identity",
  INFISICAL_CLIENT_SECRET: CLIENT_SECRET,
};

// What a server started this way would see, reported by the process itself. Spawned asynchronously:
// a synchronous spawn would hold this process still, and the stand-in Infisical runs inside it.
async function start(
  arguments_: string[],
  environment: Record<string, string>,
) {
  const report =
    "console.log(JSON.stringify({ FROM_DOT_ENV: process.env.FROM_DOT_ENV, FROM_SHELL: " +
    "process.env.FROM_SHELL, ONLY_INFISICAL: process.env.ONLY_INFISICAL, EMPTY: process.env.EMPTY, " +
    "FROM_SERVER_FILE: process.env.FROM_SERVER_FILE, AGENT_BOT_MODEL: process.env.AGENT_BOT_MODEL, " +
    "MANAGED_AGENT_TOKEN: process.env.MANAGED_AGENT_TOKEN, DATABASE_URL: process.env.DATABASE_URL, " +
    "PILOT_KEPT: process.env.PILOT_KEPT, " +
    "dotted: process.env['db.url'], CLIENT_SECRET: process.env.INFISICAL_CLIENT_SECRET }))";
  const child = Bun.spawn(
    ["bun", ...arguments_, "--preload", preload, "-e", report],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    status,
    stderr,
    seen: JSON.parse(stdout || "null") as Record<
      string,
      string | undefined
    > | null,
  };
}

describe("Infisical preload", () => {
  test("without the machine identity, nothing is asked of Infisical and .env stands", async () => {
    writeFileSync(dotEnv, "FROM_DOT_ENV=from-dot-env\n");
    asked.length = 0;
    const run = await start([`--env-file=${dotEnv}`], {
      FROM_DOT_ENV: "from-dot-env",
    });
    expect(run.status).toBe(0);
    expect(run.seen?.FROM_DOT_ENV).toBe("from-dot-env");
    expect(asked).toEqual([]);
  });

  test("with the env files on the command line, Infisical replaces what they supplied and nothing else", async () => {
    writeFileSync(dotEnv, "FROM_DOT_ENV=from-dot-env\n");
    writeFileSync(serverEnv, "FROM_SERVER_FILE=from-file\n");
    asked.length = 0;
    const run = await start(
      [`--env-file=${dotEnv}`, `--env-file=${serverEnv}`],
      { ...identity, FROM_SHELL: "from-shell" },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.seen).toEqual({
      FROM_DOT_ENV: "from-infisical",
      FROM_SHELL: "from-shell",
      FROM_SERVER_FILE: "from-infisical",
      // A key no settings file supplied lands in the environment from Infisical, as the pilot test
      // below relies on: the same key there keeps its file's value instead.
      PILOT_KEPT: "from-infisical",
      DATABASE_URL: "from-infisical",
      EMPTY: "",
      // /agents is read whole: the server picks each Bot's model from the settings the Bots run with.
      AGENT_BOT_MODEL: "agents-model",
      MANAGED_AGENT_TOKEN: "from-infisical",
    });
    // A key with a dot is not a variable, and the identity is not left in what the server sees.
    expect(run.seen && "dotted" in run.seen).toBe(false);
    expect(run.seen && "CLIENT_SECRET" in run.seen).toBe(false);
    expect(asked[0]).toMatchObject({
      body: { clientId: "identity", clientSecret: CLIENT_SECRET },
    });
    const lists = asked.slice(1);
    expect(
      lists
        .map((ask) => new URLSearchParams(ask.query).get("secretPath"))
        .sort(),
    ).toEqual(["/", "/agents", "/server"]);
    for (const list of lists) {
      expect(list.authorization).toBe("Bearer access-token");
      expect(list.query).toContain("environment=dev");
      expect(list.query).toContain("expandSecretReferences=false");
    }
  });

  test("a file that is not the server's, such as the machine identity, is never replaced from", async () => {
    const identityFile = join(directory, ".env.openbot-client");
    writeFileSync(identityFile, "ONLY_INFISICAL=from-the-identity-file\n");
    const run = await start([`--env-file=${identityFile}`], identity);
    expect(run.status, run.stderr).toBe(0);
    expect(run.seen?.ONLY_INFISICAL).toBe("from-the-identity-file");
  });

  test("a machine's own file, such as deploy/.local/pilot.env, is kept over Infisical", async () => {
    // Beside the settings files, the way start.sh and `bun run dev` name it: last, so it wins there,
    // and not one of SERVER_ENV_FILES, so the preload keeps it here.
    const pilotFile = join(directory, "..", ".local", "pilot.env");
    mkdirSync(join(directory, "..", ".local"), { recursive: true });
    writeFileSync(pilotFile, "PILOT_KEPT=from-the-pilot-file\n");
    const run = await start([`--env-file=${pilotFile}`], identity);
    expect(run.status, run.stderr).toBe(0);
    expect(run.seen?.PILOT_KEPT).toBe("from-the-pilot-file");
  });

  test("without .env, the environment is kept and Infisical fills in the rest", async () => {
    // Bun reads a .env it finds in the working directory by itself, so none may be left there.
    rmSync(dotEnv, { force: true });
    asked.length = 0;
    const run = await start([], {
      ...identity,
      FROM_SHELL: "from-shell",
      INFISICAL_ENV: "prod",
    });
    expect(run.status).toBe(0);
    expect(run.seen).toMatchObject({
      FROM_DOT_ENV: "from-infisical",
      FROM_SHELL: "from-shell",
    });
    expect(asked[1]?.query).toContain("environment=prod");
  });

  test("a service folder nobody has created yet reads as empty, and `/` must exist", async () => {
    const agents = SECRETS["/agents"];
    delete (SECRETS as Record<string, unknown>)["/agents"];
    try {
      const run = await start([`--env-file=${dotEnv}`], { ...identity });
      expect(run.status, run.stderr).toBe(0);
      expect(run.seen?.FROM_DOT_ENV).toBe("from-infisical");
      expect(run.seen && "MANAGED_AGENT_TOKEN" in run.seen).toBe(false);
    } finally {
      SECRETS["/agents"] = agents;
    }
    const deployment = SECRETS["/"];
    delete (SECRETS as Record<string, unknown>)["/"];
    try {
      const run = await start([`--env-file=${dotEnv}`], { ...identity });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("Could not read settings from Infisical");
    } finally {
      SECRETS["/"] = deployment;
    }
  });

  test("a read that fails stops the start and says where it failed", async () => {
    asked.length = 0;
    const run = await start([], {
      ...identity,
      INFISICAL_CLIENT_SECRET: "wrong",
    });
    expect(run.status).not.toBe(0);
    expect(run.seen).toBeNull();
    expect(run.stderr).toContain("Could not read settings from Infisical");
  });
});
