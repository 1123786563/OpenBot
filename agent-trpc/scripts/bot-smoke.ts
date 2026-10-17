/**
 * The workbench Bot's smoke: the REAL Go process (`go run ./cmd/bot`) against
 * a scripted OpenAI-compatible endpoint, driven exactly the way OpenBot's
 * server drives a Bot. Exit code 0 = the contract held.
 *
 *   bun agent-trpc/scripts/bot-smoke.ts
 *
 * Asserts: /health answers, the token gate refuses strangers, a run streams
 * the AG-UI event contract (RUN_STARTED first, RUN_FINISHED last, the
 * provider's text as deltas), a caller's tool is declared to the model and
 * its call surfaces as TOOL_CALL events, and forwardedProps never reach the
 * model. No real provider is dialled; the model answers are fixtures.
 */

const TOKEN = "smoke-token-not-a-real-one";
const MODEL = "smoke-model";
const PORT = 4271;

const textFrames = [
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"smoke-"},"finish_reason":null}]}`,
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}`,
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  `data: [DONE]`,
];
const toolFrames = [
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_f","type":"function","function":{"name":"smoke_tool","arguments":"{\\"q\\":\\"1\\"}"}}]},"finish_reason":null}]}`,
  `data: {"id":"f","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  `data: [DONE]`,
];

const seenBodies: string[] = [];
let replyWith: "text" | "tool" = "text";

const fakeProvider = Bun.serve({
  port: 4272,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/chat/completions")) {
      seenBodies.push(await request.text());
      const frames = replyWith === "text" ? textFrames : toolFrames;
      return new Response(`${frames.join("\n\n")}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

// Build the binary first and spawn IT, not `go run`: killing a `go run`
// wrapper leaves the compiled child serving, and a smoke that leaks its bot
// fails the next run with "address already in use".
const binary = `/tmp/agent-trpc-bot-smoke-${process.pid}`;
const build = Bun.spawnSync(["go", "build", "-o", binary, "./cmd/bot"], {
  cwd: `${import.meta.dir}/..`,
});
if (!build.success) failNow(`go build failed: ${build.stderr.toString()}`);

function failNow(message: string): never {
  fakeProvider.stop(true);
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

const bot = Bun.spawn([binary], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MANAGED_AGENT_TOKEN: TOKEN,
    OPENAI_BASE_URL: "http://127.0.0.1:4272/v1",
    OPENAI_API_KEY: "fixture-not-a-credential",
    BOT_MODEL: MODEL,
  },
  stdout: "pipe",
  stderr: "pipe",
});

function fail(message: string): never {
  bot.kill();
  fakeProvider.stop(true);
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

async function waitForHealth(attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) {
        const body = (await res.json()) as { status: string; model: string };
        if (body.status !== "ok" || body.model !== MODEL)
          fail(`health body ${JSON.stringify(body)}`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("bot never became healthy");
}

function parseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
    events.push(JSON.parse(trimmed.slice("data: ".length)));
  }
  return events;
}

async function run(body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT}/ag-ui`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": token,
    },
    body: JSON.stringify(body),
  });
}

const baseInput = {
  runId: "run_smoke",
  threadId: "thread_smoke",
  messages: [{ id: "m1", role: "user", content: "Answer the smoke check." }],
  tools: [],
  context: [],
  forwardedProps: {},
};

try {
  await waitForHealth();
  console.log("[smoke] health: ok");

  const refused = await run(baseInput, "wrong-token");
  if (refused.status !== 401)
    fail(`wrong token answered ${refused.status}, want 401`);
  console.log("[smoke] token gate: refuses strangers");

  const text = await run({
    ...baseInput,
    forwardedProps: { openbotRun: { assertion: "opaque" } },
  });
  if (!text.ok) fail(`text run answered ${text.status}`);
  let events = parseEvents(await text.text());
  if (events[0]?.type !== "RUN_STARTED") fail(`first event ${events[0]?.type}`);
  if (events.at(-1)?.type !== "RUN_FINISHED")
    fail(`last event ${events.at(-1)?.type}`);
  const streamed = events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => e.delta)
    .join("");
  if (streamed !== "smoke-ok")
    fail(`streamed text ${JSON.stringify(streamed)}`);
  if (seenBodies.some((b) => b.includes("opaque") || b.includes("openbotRun")))
    fail("forwardedProps leaked to the model");
  console.log(
    "[smoke] run contract: RUN_STARTED … text deltas … RUN_FINISHED, no forwardedProps leak",
  );

  replyWith = "tool";
  const toolRun = await run({
    ...baseInput,
    runId: "run_smoke_tool",
    tools: [
      {
        name: "smoke_tool",
        description: "Smoke tool.",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  });
  if (!toolRun.ok) fail(`tool run answered ${toolRun.status}`);
  events = parseEvents(await toolRun.text());
  const starts = events.filter((e) => e.type === "TOOL_CALL_START").length;
  const ends = events.filter((e) => e.type === "TOOL_CALL_END").length;
  if (starts !== 1 || ends !== 1)
    fail(`TOOL_CALL events start=${starts} end=${ends}`);
  if (events.at(-1)?.type !== "RUN_FINISHED")
    fail(`tool run ended on ${events.at(-1)?.type}`);
  if (!seenBodies.at(-1)?.includes('"smoke_tool"'))
    fail("caller tool not declared to the model");
  console.log(
    "[smoke] caller tool: declared, its call surfaced as TOOL_CALL events",
  );

  console.log("[smoke] PASS");
} finally {
  bot.kill();
  fakeProvider.stop(true);
  await bot.exited;
  Bun.spawnSync(["rm", "-f", binary]);
}
