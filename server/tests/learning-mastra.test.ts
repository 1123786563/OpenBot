import { expect, test } from "../../tests/support/bun-test-compat";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

function setupIsolatedHarnessFixture(fixtureDir: string) {
  const serverNodeModules = resolve(hereDir, "../node_modules");
  const agentMastraSource = resolve(hereDir, "../../agent-mastra");
  const sharedSource = resolve(hereDir, "../../shared");
  symlinkSync(serverNodeModules, join(fixtureDir, "node_modules"), "dir");
  cpSync(agentMastraSource, join(fixtureDir, "agent-mastra"), {
    recursive: true,
  });
  symlinkSync(sharedSource, join(fixtureDir, "shared"), "dir");
}

function createIsolatedHarnessFixture(
  setup = setupIsolatedHarnessFixture,
): string {
  const fixtureDir = mkdtempSync(join(tmpdir(), "openbot-learning-mastra-"));
  let setupComplete = false;
  try {
    setup(fixtureDir);
    setupComplete = true;
    return fixtureDir;
  } finally {
    if (!setupComplete) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
}

test("the isolated dependency fixture is removed when fixture setup fails", async () => {
  let fixtureDir: string | undefined;

  expect(() =>
    createIsolatedHarnessFixture((dir) => {
      fixtureDir = dir;
      throw new Error("injected setup failure");
    }),
  ).toThrow("injected setup failure");

  expect(fixtureDir).toBeDefined();
  expect(existsSync(fixtureDir!)).toBe(false);
});

test("Mastra's maintained AG-UI bridge consumes the catalog and both learned tool results", async () => {
  const seen: unknown[] = [];
  let fixtureDir: string | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    fixtureDir = createIsolatedHarnessFixture();

    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        seen.push(body);
        const history = JSON.stringify(body.messages);
        const done = history.includes("SUPPORTING_FILE_CONTENT");
        const name = history.includes("LOADED_SKILL_CONTENT")
          ? "copilotkit_read_skill_file"
          : "copilotkit_load_skill";
        const delta = done
          ? { role: "assistant", content: "SUPPORTING_FILE_CONTENT" }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${name}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify({
                      skill_name: "refunds",
                      ...(name === "copilotkit_read_skill_file"
                        ? { path: "supporting.txt" }
                        : {}),
                    }),
                  },
                },
              ],
            };
        const base = {
          id: `chat-${seen.length}`,
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
        };
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: done ? "stop" : "tool_calls",
              },
            ],
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const script = `
    import { getLocalAgents } from "@ag-ui/mastra";
    import { lastValueFrom, toArray } from "rxjs";
    import { mastra } from "./agent-mastra/src/mastra/index.ts";
    import { RemoteLearnedSkillsMiddleware } from "${pathToFileURL(resolve(hereDir, "../src/learning/remote.ts")).href}";
    const tools = ["copilotkit_load_skill", "copilotkit_read_skill_file"].map(name => ({
      name, description: "Read learned guidance", parameters: {
        type: "object", properties: { skill_name: { type: "string" }, path: { type: "string" } }, required: ["skill_name"]
      }
    }));
    const remote = getLocalAgents({ mastra, resourceId: "learning-test" }).openbot;
    const middleware = new RemoteLearnedSkillsMiddleware("bot", async () => ({
      catalog: "LEARNED_CATALOG_MARKER", tools,
      execute: async (name) => name === "copilotkit_load_skill" ? "LOADED_SKILL_CONTENT" : "SUPPORTING_FILE_CONTENT"
    }));
    const events = await lastValueFrom(middleware.run({
      threadId: crypto.randomUUID(), runId: crypto.randomUUID(), tools: [], context: [], state: {}, forwardedProps: {},
      messages: [{ id: "user", role: "user", content: "Apply the refund policy" }]
    }, remote).pipe(toArray()));
    console.log(JSON.stringify(events));
  `;
    child = Bun.spawn([Bun.argv[0], "--no-env-file", "-e", script], {
      cwd: fixtureDir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        BOT_PROVIDER: "openai",
        BOT_MODEL: "gpt-4.1-mini",
        OPENAI_API_KEY: "synthetic-key",
        OPENAI_BASE_URL: `${provider.url}v1`,
        MASTRA_TELEMETRY_DISABLED: "true",
        DO_NOT_TRACK: "1",
        NODE_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    timeout = setTimeout(() => child?.kill(), 15_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).not.toContain('"RUN_ERROR"');
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen[0])).toContain("LEARNED_CATALOG_MARKER");
    expect(JSON.stringify(seen[1])).toContain("LOADED_SKILL_CONTENT");
    expect(JSON.stringify(seen[2])).toContain("SUPPORTING_FILE_CONTENT");
    expect(stdout).toContain('"TOOL_CALL_RESULT"');
    expect(stdout).toContain("SUPPORTING_FILE_CONTENT");
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      child?.kill();
      if (child) await child.exited;
    } finally {
      try {
        await provider?.stop(true);
      } finally {
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
      }
    }
  }
}, 20_000);
