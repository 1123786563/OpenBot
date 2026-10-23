import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME15 (#487): the boot leg in a real, Intelligence-free environment.
 *
 * The unit suite (mastra-intelligence-optional.test.ts) proves the lazy seams
 * construct nothing; the governed entrance suites prove the governed path
 * serves turns without an Intelligence client anywhere. What only a real
 * child process can prove is the BOOT ITSELF:
 *
 *   1. a deployment with neither engine configured refuses to boot, by name,
 *      before any client, pool or route exists (AGENT_RUNTIME_UNCONFIGURED);
 *   2. a deployment whose enterprise URLs are set but fail their capability
 *      verification refuses too (AGENT_RUNTIME_UNVERIFIED) — the
 *      no-permission in-memory runner the spec forbids is unreachable;
 *   3. a deployment with a VERIFIED governed path and no Intelligence boots,
 *      serves /ready and /api/capabilities, and reports its capabilities
 *      honestly (mode "none", durableHistory false).
 */

const workspaceRoot = join(fileURLToPath(import.meta.url), "../../../..");
const serverRoot = join(workspaceRoot, "server");

const TEST_PG_PORT = process.env.ME01_TEST_PG_PORT ?? "5433";
const MAIN_DB =
  process.env.TEST_DATABASE_URL ??
  `postgresql://postgres:openbot@127.0.0.1:${TEST_PG_PORT}/openbot_test`;

/** The smallest environment loadConfig accepts, with NO Intelligence at all. */
function bootEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = {
    DATABASE_URL: MAIN_DB,
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_SINGLE_USER: "true",
    // config.ts refuses port 0; the refusal cases never listen anyway, and
    // the positive case binds this to nothing before the harness stops it.
    PORT: String(39000 + Math.floor(Math.random() * 20000)),
    // Nothing INTELLIGENCE_* may leak in from the driving shell.
    INTELLIGENCE_API_URL: undefined,
    INTELLIGENCE_GATEWAY_WS_URL: undefined,
    INTELLIGENCE_API_KEY: undefined,
    COPILOTKIT_LICENSE_TOKEN: undefined,
    ...overrides,
  };
  // An undefined value must OMIT the key, not pass the string "undefined".
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
}

function runBootChild(
  label: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      Bun.which("bun") ?? process.execPath,
      [join(serverRoot, "src/index.ts")],
      {
        cwd: serverRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `[${label}] boot child did not exit within 120s; stdout: ${stdout.slice(-2000)} stderr: ${stderr.slice(-2000)}`,
        ),
      );
    }, 120_000);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function bootLog(output: string): string {
  // The structured logger writes one JSON object per line to stdout.
  return output
    .split("\n")
    .filter((line) => line.includes("agent-runtime-"))
    .join("\n");
}

describe("no-Intelligence boot (ME15 #487)", () => {
  test("refuses to boot, by name, when neither engine is configured", async () => {
    const { code, stdout, stderr } = await runBootChild(
      "unconfigured",
      bootEnvironment(),
    );
    expect(code).toBe(1);
    const line = bootLog(`${stdout}\n${stderr}`);
    expect(line).toContain("agent-runtime-unconfigured");
    expect(line).toContain("AGENT_RUNTIME_UNCONFIGURED");
    expect(line).toContain("INTELLIGENCE_API_URL");
    expect(line).toContain("ENTERPRISE_DIRECTORY_DATABASE_URL");
    // The refusal is the WHOLE story: no routes, no pools, no runner.
    expect(`${stdout}\n${stderr}`).not.toContain("listening");
  }, 180_000);

  test("refuses to boot when the enterprise databases fail verification", async () => {
    const { code, stdout, stderr } = await runBootChild(
      "unverified",
      bootEnvironment({
        // Reachable-looking Postgres endpoints with no OpenBot capability
        // schema: the composition must fail its check, and the process must
        // refuse rather than run degraded.
        ENTERPRISE_DIRECTORY_DATABASE_URL: `postgresql://postgres:openbot@127.0.0.1:${TEST_PG_PORT}/openbot_test`,
        ENTERPRISE_DATA_DATABASE_URL: `postgresql://postgres:openbot@127.0.0.1:${TEST_PG_PORT}/openbot_test`,
        OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL: `postgresql://postgres:openbot@127.0.0.1:${TEST_PG_PORT}/openbot_test`,
      }),
    );
    expect(code).toBe(1);
    const line = bootLog(`${stdout}\n${stderr}`);
    expect(line).toContain("agent-runtime-unverified");
    expect(line).toContain("AGENT_RUNTIME_UNVERIFIED");
  }, 180_000);

  describe("verified governed path, no Intelligence", () => {
    let fixture: Me03Fixture;
    let port: number;

    const serve = (
      env: NodeJS.ProcessEnv,
    ): {
      child: ReturnType<typeof spawn>;
      stdout: () => string;
      stderr: () => string;
      stop: () => Promise<number | null>;
    } => {
      const child = spawn(
        Bun.which("bun") ?? process.execPath,
        ["src/index.ts"],
        {
          cwd: serverRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const stop = () =>
        new Promise<number | null>((resolve) => {
          if (child.exitCode !== null || child.signalCode) {
            resolve(child.exitCode);
            return;
          }
          const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
          child.on("exit", (code) => {
            clearTimeout(killer);
            resolve(code);
          });
          child.kill("SIGTERM");
        });
      return { child, stdout: () => stdout, stderr: () => stderr, stop };
    };

    beforeAll(async () => {
      fixture = await createMe03Fixture();
      port = 39100 + Math.floor(Math.random() * 200);
    });

    afterAll(async () => {
      await fixture.drop();
    });

    test("boots, serves /ready, and reports its capabilities honestly", async () => {
      const serving = serve(
        bootEnvironment({
          PORT: String(port),
          ENTERPRISE_DIRECTORY_DATABASE_URL: fixture.logins.directoryUrl,
          ENTERPRISE_DATA_DATABASE_URL: fixture.logins.dataUrl,
          OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL: fixture.adminUrl,
        }),
      );
      try {
        // The readiness endpoint answers 200 only when the database
        // answers; it is the boot's own statement that it is serving.
        const deadline = Date.now() + 90_000;
        let ready = "";
        let status = 0;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/ready`, {
              signal: AbortSignal.timeout(2_000),
            });
            status = response.status;
            ready = await response.text();
            if (status === 200) break;
          } catch {
            // not up yet
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(status).toBe(200);
        expect(JSON.parse(ready)).toEqual({ status: "ok", database: "up" });

        const capabilities = await (
          await fetch(`http://127.0.0.1:${port}/api/capabilities`)
        ).json();
        // The honest projection (AC: 部署健康/配置文案与实际能力一致): this
        // deployment runs on the governed path with no Intelligence, and it
        // says exactly that instead of claiming durable platform history.
        expect(capabilities).toMatchObject({
          mode: "none",
          durableHistory: false,
        });
      } finally {
        const code = await serving.stop();
        // A clean stop, and every Intelligence refusal in the log is the
        // banner's caught entitlement read — the lazy gate refusing BY NAME
        // instead of constructing. No other consumer asked for a client at
        // all: chat serving, the governed path and the readiness probe ran
        // with zero constructed Intelligence clients.
        expect(code === 0 || code === null || code === 143).toBe(true);
        const unconfigured = serving
          .stdout()
          .split("\n")
          .filter((line) => line.includes("INTELLIGENCE_UNCONFIGURED"));
        for (const line of unconfigured) {
          expect(line).toContain("self-host-banner-entitlement-unavailable");
        }
      }
    }, 180_000);
  });
});
