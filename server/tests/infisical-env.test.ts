import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The preload that loads the server's settings from Infisical, run the way the server runs it: in a
 * fresh `bun` process, against a stand-in Infisical on loopback. The stand-in answers the two routes
 * the SDK calls and records what it was asked, which is how the test knows what was sent, including
 * the precedence the preload exists to get right: the shell, then Infisical, then .env.
 */

const preload = resolve(import.meta.dir, "../scripts/infisical-env.ts");
const directory = mkdtempSync(join(tmpdir(), "infisical-env-"));
const dotEnv = join(directory, ".env");
const CLIENT_SECRET = "secret";

const SECRETS = [
  { secretKey: "FROM_DOT_ENV", secretValue: "from-infisical" },
  { secretKey: "FROM_SHELL", secretValue: "from-infisical" },
  { secretKey: "ONLY_INFISICAL", secretValue: "added" },
  { secretKey: "db.url", secretValue: "not-a-variable" },
  { secretKey: "EMPTY", secretValue: "" },
];

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
    return Response.json({ secrets: SECRETS });
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
async function start(arguments_: string[], environment: Record<string, string>) {
  const report =
    "console.log(JSON.stringify({ FROM_DOT_ENV: process.env.FROM_DOT_ENV, FROM_SHELL: " +
    "process.env.FROM_SHELL, ONLY_INFISICAL: process.env.ONLY_INFISICAL, EMPTY: process.env.EMPTY, " +
    "dotted: process.env['db.url'], CLIENT_SECRET: process.env.INFISICAL_CLIENT_SECRET }))";
  const child = Bun.spawn(["bun", ...arguments_, "--preload", preload, "-e", report], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    status,
    stderr,
    seen: JSON.parse(stdout || "null") as Record<string, string | undefined> | null,
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

  test("with .env on the command line, Infisical replaces what .env supplied and nothing else", async () => {
    writeFileSync(dotEnv, "FROM_DOT_ENV=from-dot-env\n");
    asked.length = 0;
    const run = await start([`--env-file=${dotEnv}`], {
      ...identity,
      FROM_SHELL: "from-shell",
    });
    expect(run.status).toBe(0);
    expect(run.seen).toEqual({
      FROM_DOT_ENV: "from-infisical",
      FROM_SHELL: "from-shell",
      ONLY_INFISICAL: "added",
      EMPTY: "",
      dotted: undefined,
      CLIENT_SECRET: undefined,
    });
    expect(asked[0]).toMatchObject({
      body: { clientId: "identity", clientSecret: CLIENT_SECRET },
    });
    expect(asked[1]?.authorization).toBe("Bearer access-token");
    expect(asked[1]?.query).toContain("environment=dev");
    expect(asked[1]?.query).toContain("expandSecretReferences=false");
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

  test("a read that fails stops the start and says where it failed", async () => {
    asked.length = 0;
    const run = await start([], { ...identity, INFISICAL_CLIENT_SECRET: "wrong" });
    expect(run.status).not.toBe(0);
    expect(run.seen).toBeNull();
    expect(run.stderr).toContain("Could not read settings from Infisical");
  });
});
