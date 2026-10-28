/**
 * F7E — frozen-tree real-chain evidence driver (R3-04 / A2 / A13 / #22 / #23 / #43).
 *
 * Drives REAL runs on the frozen combination tree (all F5/F6/F7 fixes in) through the
 * workbench-authenticated CopilotKit runtime, then collects the governance evidence from
 * OpenBot's own query API and from the self-hosted Opik instance:
 *
 *   - stock builtin Bots with real tools (F6C: governed facts without billing),
 *   - the deployment's default LangGraph dialled THROUGH the server (F6D admission +
 *     F7D budget contract + W3C cross-service chain), never direct,
 *   - the stock-phase fail-closed refusal for the same remote Bot,
 *   - multi-run locatability, real terminal states (F7C), tool-call ids, root spans.
 *
 * Everything talks to a live, isolated stack. It never mocks a run, never skips a missing
 * capability silently, and never prints a secret value: cookies and tokens stay in the
 * state directory (mode 600) and the env file.
 *
 * Commands
 *   login             --server=URL --state=DIR
 *   builtin           --server=URL --state=DIR [--threads=2]
 *   remote-unavailable --server=URL --state=DIR --endpoint=URL --env-file=PATH
 *   langgraph         --server=URL --state=DIR --env-file=PATH [--threads=2]
 *   grant-credits     --server=URL --state=DIR --cents=N
 *   collect           --server=URL --state=DIR --opik=URL --evidence=DIR --env-file=PATH --phase=stock|billed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

type Args = Record<string, string>;
type Verdict = "PASS" | "GAP";
type Finding = { check: string; verdict: Verdict; detail: string };

function args(argv: string[]): Args {
  const out: Args = {};
  for (const entry of argv) {
    const match = entry.match(/^--([a-z-]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function need(a: Args, name: string): string {
  const value = a[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readEnvValue(envFile: string, name: string): string {
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in ${envFile}`);
  return line.slice(name.length + 1).trim();
}

async function launchChromium() {
  for (const candidate of [
    { channel: "chrome" as const },
    { channel: "chrome-canary" as const },
    { channel: "microsoft-edge" as const },
  ]) {
    try {
      return await chromium.launch({ ...candidate, headless: true });
    } catch {
      /* next candidate */
    }
  }
  const paths = [
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const executablePath of paths) {
    if (existsSync(executablePath)) {
      return await chromium.launch({ executablePath, headless: true });
    }
  }
  throw new Error("no Chrome/Chromium available for the Casdoor login");
}

// ---------------------------------------------------------------------------
// login: the real Casdoor OAuth dance in a real browser.
// ---------------------------------------------------------------------------

async function login(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const casdoorUser = a.user ?? "admin";
  const casdoorPassword = a.password ?? "123";
  const timeout = 60_000;
  mkdirSync(state, { recursive: true });

  const browser = await launchChromium();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server}/health`, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    const authorizeUrl = await page.evaluate(async (origin) => {
      const response = await fetch(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "casdoor",
          callbackURL: `${origin}/api/agents`,
        }),
      });
      return ((await response.json()) as { url?: string }).url ?? null;
    }, server);
    if (!authorizeUrl)
      throw new Error("sign-in/social returned no authorize URL");
    await page.goto(authorizeUrl, { waitUntil: "domcontentloaded", timeout });
    await page.locator("#username").waitFor({ state: "visible", timeout });
    await page.fill("#username", casdoorUser);
    await page.fill("#password", casdoorPassword);
    await page.click("button[type=submit]");
    await page.waitForURL((url) => url.origin === new URL(server).origin, {
      timeout,
    });
    const cookies = await context.cookies(server);
    const session = cookies.find((c) => c.name === "better-auth.session_token");
    if (!session)
      throw new Error("no better-auth session cookie after the callback");
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    writeFileSync(join(state, "session-cookie.txt"), header, { mode: 0o600 });
    console.log(
      JSON.stringify({
        step: "login",
        finalUrl: page.url(),
        cookieNames: cookies.map((c) => c.name),
      }),
    );
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Shared HTTP client (session cookie from the login step).
// ---------------------------------------------------------------------------

type ThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: Array<{ id: string; name: string; args?: string }>;
  toolCallId?: string;
};

function client(state: string, server: string) {
  const cookie = readFileSync(join(state, "session-cookie.txt"), "utf8").trim();
  const headers = {
    "content-type": "application/json",
    cookie,
    origin: server,
  };
  const api = {
    serverOf: () => server,
    headersOf: () => headers,
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${server}${path}`, { headers });
    if (!response.ok)
      throw new Error(
        `GET ${path} → ${response.status} ${await response.text()}`,
      );
    return (await response.json()) as T;
  };
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${server}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `POST ${path} → ${response.status} ${text.slice(0, 400)}`,
      );
    return JSON.parse(text) as T;
  };
  return Object.assign(api, { get, post });
}

const TOOL = {
  name: "report_environment",
  description:
    "Report the fixed environment status line. Use it whenever the user asks about environment status.",
  parameters: { type: "object", properties: {}, required: [] },
};

const RESULT = { status: "f7e isolated stack: all systems nominal" };
const ASK =
  "What is the environment status? Use the report_environment tool and quote its exact output.";

/**
 * One real run with a tool loop: the model proposes the tool, this caller (the
 * surface) executes it, and the result is fed back so the model answers with it.
 * The evidence is therefore a proposal AND an execution — never a rehearsal.
 */
async function runToolLoop(
  api: ReturnType<typeof client>,
  agentId: string,
): Promise<{
  threadId: string;
  runIds: string[];
  toolCall: { id: string; name: string };
  finalAnswer: string;
}> {
  const threadId = crypto.randomUUID();
  const runIds: string[] = [];

  const run = async (messages: unknown[]) => {
    const runId = `run-${crypto.randomUUID()}`;
    runIds.push(runId);
    const accepted = await api.post<{ threadId: string; runId: string }>(
      `/api/copilotkit/agent/${encodeURIComponent(agentId)}/run`,
      {
        threadId,
        runId,
        messages,
        state: {},
        tools: [TOOL],
        context: [],
        forwardedProps: {},
      },
    );
    if (accepted.runId !== runId)
      throw new Error("run id mismatch in the acceptance");
  };

  const readThread = async () =>
    (
      await api.get<{ messages: ThreadMessage[] }>(
        `/api/copilotkit/threads/${threadId}/messages?agentId=${encodeURIComponent(agentId)}`,
      )
    ).messages;

  await run([{ id: crypto.randomUUID(), role: "user", content: ASK }]);
  const deadline = Date.now() + 180_000;
  let messages: ThreadMessage[] = [];
  let assistant: ThreadMessage | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    messages = await readThread();
    assistant = messages.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.length > 0,
    );
    const answered = messages.find(
      (m) =>
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.length > 0,
    );
    if (assistant || answered) break;
  }
  if (!assistant?.toolCalls?.length) {
    throw new Error(
      `no tool proposal landed in the thread: ${JSON.stringify(messages).slice(0, 400)}`,
    );
  }
  const call = assistant.toolCalls[0];

  await run([
    { id: messages[0].id, role: "user", content: ASK },
    {
      id: assistant.id,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.args ?? "{}" },
        },
      ],
    },
    {
      id: crypto.randomUUID(),
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify(RESULT),
    },
  ]);
  const answerDeadline = Date.now() + 180_000;
  let finalAnswer = "";
  while (Date.now() < answerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    messages = await readThread();
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (
      last &&
      typeof last.content === "string" &&
      last.content.includes(RESULT.status)
    ) {
      finalAnswer = last.content;
      break;
    }
    if (
      last &&
      typeof last.content === "string" &&
      last.content.trim().length > 0 &&
      !last.toolCalls
    ) {
      finalAnswer = last.content;
      break;
    }
  }
  if (!finalAnswer)
    throw new Error("the run produced no final assistant answer");
  return {
    threadId,
    runIds,
    toolCall: { id: call.id, name: call.name },
    finalAnswer,
  };
}

async function findBot(api: ReturnType<typeof client>, name: string) {
  const { agents } = await api.get<{
    agents: Array<{ id: string; name: string; endpoint: string | null }>;
  }>("/api/agents");
  return agents.find((agent) => agent.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// builtin: N real tool-loop runs on separate threads (multi-run locatability).
// ---------------------------------------------------------------------------

async function builtin(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const threads = Number(a.threads ?? "2");
  const api = client(state, server);
  const NAME = "f7e Builtin Probe";
  let bot = await findBot(api, NAME);
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: NAME,
      title: "f7e built-in path probe",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
    });
    bot = { id: created.agent.id, name: NAME, endpoint: null };
  }
  const loops = [];
  for (let i = 0; i < threads; i++) {
    loops.push(await runToolLoop(api, bot.id));
    console.log(
      JSON.stringify({
        step: "builtin",
        thread: i + 1,
        threadId: loops[i].threadId,
        runIds: loops[i].runIds,
        toolCall: loops[i].toolCall,
      }),
    );
  }
  writeFileSync(
    join(state, "builtin-run.json"),
    JSON.stringify(
      { agentId: bot.id, agentName: NAME, loops, result: RESULT },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// remote-unavailable: the stock deployment's honest refusal for the SAME remote
// Bot the billed phase later dials (fail-closed evidence, R3-02 discipline).
// ---------------------------------------------------------------------------

async function remoteUnavailable(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const endpoint = need(a, "endpoint");
  const envFile = need(a, "env-file");
  const token = readEnvValue(envFile, "MANAGED_AGENT_TOKEN");
  const api = client(state, server);
  const NAME = "f7e LangGraph Probe";
  let bot = await findBot(api, NAME);
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: NAME,
      title: "f7e default LangGraph probe (via server dial)",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
      endpoint,
      auth: { header: "x-openbot-agent-token", value: token },
    });
    bot = { id: created.agent.id, name: NAME, endpoint };
  }
  const threadId = crypto.randomUUID();
  const runId = `run-${crypto.randomUUID()}`;
  const cookie = readFileSync(join(state, "session-cookie.txt"), "utf8").trim();
  const response = await fetch(
    `${server}/api/copilotkit/agent/${encodeURIComponent(bot.id)}/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: server,
      },
      body: JSON.stringify({
        threadId,
        runId,
        messages: [{ id: crypto.randomUUID(), role: "user", content: ASK }],
        state: {},
        tools: [TOOL],
        context: [],
        forwardedProps: {},
      }),
    },
  );
  const body = await response.text();
  const refusal = {
    agentId: bot.id,
    threadId,
    runId,
    status: response.status,
    bodyHead: body.slice(0, 600),
    namesUnavailable: body.includes("REMOTE_RUN_BUDGET_UNVERIFIED"),
  };
  writeFileSync(
    join(state, "remote-refusal.json"),
    JSON.stringify(refusal, null, 2),
  );
  console.log(JSON.stringify({ step: "remote-unavailable", ...refusal }));
}

// ---------------------------------------------------------------------------
// langgraph: the deployment's default LangGraph, dialled THROUGH the server.
// ---------------------------------------------------------------------------

async function langgraph(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const endpoint = need(a, "endpoint");
  const envFile = need(a, "env-file");
  const threads = Number(a.threads ?? "2");
  const token = readEnvValue(envFile, "MANAGED_AGENT_TOKEN");
  const api = client(state, server);
  const startedAt = new Date().toISOString(); // collect's dial-trace window anchor
  const NAME = "f7e LangGraph Probe";
  let bot = await findBot(api, NAME);
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: NAME,
      title: "f7e default LangGraph probe (via server dial)",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
      endpoint,
      auth: { header: "x-openbot-agent-token", value: token },
    });
    bot = { id: created.agent.id, name: NAME, endpoint };
  }
  const loops = [];
  for (let i = 0; i < threads; i++) {
    loops.push(await runToolLoop(api, bot.id));
    console.log(
      JSON.stringify({
        step: "langgraph",
        thread: i + 1,
        threadId: loops[i].threadId,
        runIds: loops[i].runIds,
        toolCall: loops[i].toolCall,
      }),
    );
  }
  writeFileSync(
    join(state, "langgraph-run.json"),
    JSON.stringify(
      {
        agentId: bot.id,
        agentName: NAME,
        endpoint,
        startedAt,
        loops,
        result: RESULT,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// default-langgraph: the deployment's OWN default LangGraph Bot (the system
// package Bot whose endpoint is the configured managed agent URL), dialled
// through the server like any person would.
// ---------------------------------------------------------------------------
async function defaultLanggraph(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const api = client(state, server);
  const startedAt = new Date().toISOString(); // collect's dial-trace window anchor
  const NAME = a.name ?? "Risk Analyst";
  const bot = await findBot(api, NAME);
  if (!bot)
    throw new Error(`the default LangGraph Bot "${NAME}" is not in the roster`);
  const loops = [];
  const threads = Number(a.threads ?? "1");
  for (let i = 0; i < threads; i++) {
    loops.push(await runToolLoop(api, bot.id));
    console.log(
      JSON.stringify({
        step: "default-langgraph",
        thread: i + 1,
        threadId: loops[i].threadId,
        runIds: loops[i].runIds,
        toolCall: loops[i].toolCall,
      }),
    );
  }
  writeFileSync(
    join(state, "default-langgraph-run.json"),
    JSON.stringify(
      {
        agentId: bot.id,
        agentName: NAME,
        endpoint: bot.endpoint,
        startedAt,
        loops,
        result: RESULT,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// grant-credits: the admin route that funds the billed phase's admissions.
// ---------------------------------------------------------------------------

async function grantCredits(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const cents = Number(a.cents ?? "10000000");
  const api = client(state, server);
  const { grant } = await api.post<{ grant: { id: string } }>(
    "/api/admin/billing/credits/grants",
    {
      source: "promo",
      totalCents: cents,
      reason: "f7e frozen-tree evidence: fund remote budget admissions",
    },
  );
  console.log(
    JSON.stringify({ step: "grant-credits", grantId: grant.id, cents }),
  );
}

// ---------------------------------------------------------------------------
// collect: the governance evidence, through OpenBot's API and Opik's REST API.
// ---------------------------------------------------------------------------

async function opikGet<T>(opik: string, path: string): Promise<T> {
  const response = await fetch(`${opik}${path}`);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`GET ${path} → ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

type SpanRow = {
  id: string;
  name?: string;
  type?: string;
  parent_span_id?: string | null;
  trace_id?: string;
  usage?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
};

/**
 * Which process a span came from. Opik's OTLP ingestion does not surface the
 * SDK resource's service.name as a span field, so provenance is read from the
 * two facts that DO survive: the tracer name Opik records as
 * metadata.integration, and the span-name grammar each side's tracers use.
 * (R1-F6, f7e-review-r1: the former constant "rest" mode is gone — a check
 * built on it could not fail. REST-written spans in the bot-* projects are
 * the server's REST writer by construction and are no longer classified.)
 */
function spanService(span: SpanRow): string {
  const meta = span.metadata as { integration?: string } | undefined;
  const integration = meta?.integration;
  // NOTE: "openbot.http" is the tracer name in shared/trace.ts, which BOTH
  // processes' request tracers use — it cannot discriminate. The span-name
  // grammar can: only the endpoint serves /ag-ui and emits run/chain/model
  // spans, only the server serves /api/* and emits db/handler/hook spans.
  const name = typeof span.name === "string" ? span.name : "";
  if (
    name === "POST /ag-ui" ||
    name === "ag-ui run" ||
    name.startsWith("chain:") ||
    name.startsWith("model:") ||
    name.startsWith("tool:") ||
    name === "retrieval"
  )
    return "agent-langgraph";
  if (integration === "openbot.agent-langgraph") return "agent-langgraph";
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD) \//.test(name))
    return "openbot-server";
  if (
    name.startsWith("db ") ||
    name.startsWith("handler ") ||
    name.startsWith("hook ")
  )
    return "openbot-server";
  if (
    integration === "better-auth" ||
    (integration ?? "").startsWith("openbot")
  )
    return "openbot-server";
  const attrs = span.attributes as Record<string, unknown> | undefined;
  const inInput = (span.input ?? {}) as Record<string, unknown>;
  const resourceService = String(
    attrs?.["service.name"] ??
      attrs?.service_name ??
      inInput.service_name ??
      "",
  );
  return resourceService !== "" ? resourceService : "?";
}

async function collectBuiltin(
  api: ReturnType<typeof client>,
  opik: string,
  sql: ReturnType<typeof Bun.SQL>,
  record: {
    agentId: string;
    loops: Array<{
      threadId: string;
      runIds: string[];
      toolCall: { id: string; name: string };
      finalAnswer: string;
    }>;
  },
  label: string,
): Promise<Record<string, unknown>> {
  const findings: Finding[] = [];
  const evidence: Record<string, unknown> = { label, agentId: record.agentId };
  evidence.driverRunIds = record.loops.flatMap((l) => l.runIds);
  evidence.driverToolCallIds = record.loops.map((l) => l.toolCall.id);

  // 1. OpenBot's own query API: the run list the product shows.
  const runsResponse = await fetch(
    `${api.serverOf()}/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs?limit=100`,
    { headers: api.headersOf() },
  );
  if (runsResponse.status === 404) {
    // A system-owned Bot (the deployment's default LangGraph): the manage gate
    // that precedes observation ownership refuses systemOwned for every actor,
    // so the run has no governance face at all. Recorded as the finding, not
    // smoothed over — the Opik half below still shows the run really executed.
    findings.push({
      check: "lg.run-locatable",
      verdict: "GAP",
      detail: `GET .../runs → 404: a system-owned Bot has no observation scope (canManageAgent refuses systemOwned even for the deployment admin), so its runs leave no bindings and no query face`,
    });
    evidence.runsList = [];
    evidence.runsFaceStatus = 404;
  } else if (!runsResponse.ok) {
    throw new Error(`GET runs → ${runsResponse.status}`);
  }
  const list = runsResponse.ok
    ? ((await runsResponse.json()) as {
        runs: Array<{
          runId: string;
          opikTraceId: string | null;
          state: string;
          usage: Record<string, unknown> | null;
          capability: string;
        }>;
        syncing: boolean;
      })
    : { runs: [], syncing: true };
  evidence.runsList = list.runs;
  findings.push({
    check: "run.locatable",
    verdict: list.runs.length > 0 ? "PASS" : "GAP",
    detail: `${list.runs.length} run(s) via GET /api/ai-observability/bots/:id/runs (syncing=${list.syncing})`,
  });

  // 2. The local authoritative bindings (the run ids the query API keys on).
  //    Measured straight from the table whatever the query face answered — a
  //    refused face never replaces a measurement (the R1-F5 discipline). This
  //    block was lost in the last edit of the r1 delivery and is what made
  //    `bindings` below an undeclared reference (R1-F1, f7e-review-r1).
  const bindings = await sql`
    SELECT run_id, attempt_id, trace_id, opik_trace_id, state, capability, created_at, updated_at
    FROM ai_observation_bindings
    WHERE bot_id = ${record.agentId}
    ORDER BY created_at DESC
    LIMIT 20
  `;
  evidence.bindings = bindings;
  // 3. Multi-run locatability: distinct binding run ids, details answer their
  // own id, and every listed row maps to a binding (no cross-talk).
  const details: unknown[] = [];
  const stepsAll: unknown[] = [];
  for (const binding of bindings as Array<{ run_id: string }>) {
    const runId = binding.run_id;
    // Error isolation per binding (f5e1 precedent): one 404 or transient
    // network error must not terminate collect and lose every other fact.
    try {
      const detail = await api.get(
        `/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(runId)}`,
      );
      details.push(detail);
      const stepResult = await api.get<{
        steps: Array<Record<string, unknown>>;
      }>(
        `/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(runId)}/steps`,
      );
      stepsAll.push({ runId, steps: stepResult.steps });
    } catch (error) {
      stepsAll.push({
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  evidence.runDetails = details;
  evidence.runSteps = stepsAll;
  const distinctIds = new Set(
    (bindings as Array<{ run_id: string }>).map((b) => b.run_id),
  );
  const detailIds = (details as Array<{ run?: { runId?: string } }>).map(
    (d) => d?.run?.runId ?? "?",
  );
  const listedTraceIds = new Set(
    list.runs.map(
      (r) => (r as { opikTraceId?: string | null }).opikTraceId ?? null,
    ),
  );
  const bindingsListed = (
    bindings as Array<{ opik_trace_id: string | null }>
  ).filter(
    (b) => b.opik_trace_id !== null && listedTraceIds.has(b.opik_trace_id),
  );
  const noCrossTalk =
    distinctIds.size >= 2 &&
    detailIds.length === new Set(detailIds).size &&
    detailIds.every((id) => distinctIds.has(id)) &&
    bindingsListed.length === bindings.length;
  findings.push({
    check: "run.multi-distinct",
    verdict: noCrossTalk ? "PASS" : "GAP",
    detail: `${distinctIds.size} distinct run id(s); ${detailIds.length} detail read(s), all answering their own id; ${bindingsListed.length}/${bindings.length} binding(s) reconciled into the listed rows`,
  });
  findings.push({
    check: "binding.established",
    verdict: bindings.length > 0 ? "PASS" : "GAP",
    detail: `${bindings.length} binding row(s); states=${bindings.map((row) => row.state).join(",") || "-"}`,
  });
  const terminalNamed = bindings.filter(
    (row) =>
      row.state === "completed" ||
      row.state === "failed" ||
      row.state === "canceled" ||
      row.state === "interrupted",
  );
  findings.push({
    check: "binding.terminal-state",
    verdict:
      bindings.length > 0 && terminalNamed.length === bindings.length
        ? "PASS"
        : "GAP",
    detail: `F7C real terminal states: ${bindings.map((row) => row.state).join(",") || "-"} (${terminalNamed.length}/${bindings.length} named completed/failed/canceled/interrupted; unknown would be the disconnected-only honest fallback)`,
  });

  // 4. Steps: model/tool spans with execution states, parents pointing at the run root.
  const allSteps = stepsAll.flatMap((entry) =>
    Array.isArray((entry as { steps?: unknown }).steps)
      ? (entry as { steps: Array<Record<string, unknown>> }).steps
      : [],
  );
  const modelSteps = allSteps.filter((s) => s.kind === "model");
  const toolSteps = allSteps.filter((s) => s.kind === "tool");
  findings.push({
    check: "steps.model-span",
    verdict: modelSteps.length > 0 ? "PASS" : "GAP",
    detail: `${modelSteps.length} model step(s)`,
  });
  findings.push({
    check: "steps.tool-span",
    verdict: toolSteps.length > 0 ? "PASS" : "GAP",
    detail: `${toolSteps.length} tool step(s); executionState=${toolSteps.map((s) => s.executionState ?? "?").join(",") || "-"}`,
  });
  const vocabularyNamed = toolSteps.filter(
    (s) => typeof s.executionState === "string" && s.executionState !== "",
  );
  findings.push({
    check: "steps.proposed-vs-executed",
    verdict:
      toolSteps.length > 0 && vocabularyNamed.length === toolSteps.length
        ? "PASS"
        : "GAP",
    detail: `every tool step names its determination vocabulary: ${toolSteps.map((s) => `${s.name}:${s.executionState ?? "?"}`).join(",") || "-"} (surface-executed tools are unobserved-by-design; receipt is its own fact)`,
  });

  // 5. Usage on the run query face (the product's own projection).
  const providerUsage = list.runs.filter(
    (run) => (run.usage as { source?: string } | null)?.source === "provider",
  );
  findings.push({
    check: "usage.run-face",
    verdict: providerUsage.length > 0 ? "PASS" : "GAP",
    detail:
      providerUsage.length > 0
        ? JSON.stringify(providerUsage.map((run) => run.usage))
        : "no run reported provider usage on the query face",
  });

  // 6. Raw Opik rows for this Bot's derived projects.
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  evidence.opikProjects = projects.content?.map((p) => p.name);
  const spansByTrace: Record<string, SpanRow[]> = {};
  const botProjects = (projects.content ?? []).filter((p) =>
    p.name.startsWith(`bot-${record.agentId}-`),
  );
  for (const project of botProjects) {
    const traces =
      (
        await opikGet<{ content?: Array<{ id: string; name?: string }> }>(
          opik,
          `/v1/private/traces?project_id=${project.id}&size=100`,
        )
      ).content ?? [];
    evidence.opikTraces = {
      ...(evidence.opikTraces as object),
      [project.name]: traces.map((t) => ({ id: t.id, name: t.name })),
    };
    for (const trace of traces) {
      const spans =
        (
          await opikGet<{ content?: SpanRow[] }>(
            opik,
            `/v1/private/spans?project_id=${project.id}&trace_id=${trace.id}&size=100`,
          )
        ).content ?? [];
      spansByTrace[`${project.name}:${trace.id}`] = spans;
    }
  }
  evidence.opikSpans = spansByTrace;

  const anywhere = Object.values(spansByTrace).flat();
  // Root span: the materialized run root ("run"), written and closed (F6B + F7C).
  const roots = anywhere.filter((s) => s.name === "run");
  const rootsClosed = roots.filter(
    (s) => typeof s.end_time === "string" && s.end_time !== "",
  );
  findings.push({
    check: "root.materialized-and-closed",
    verdict:
      roots.length > 0 && rootsClosed.length === roots.length ? "PASS" : "GAP",
    detail: `${roots.length} root span(s) named "run"; ${rootsClosed.length} with end_time (F7C lifetime write-back)`,
  });
  // Hierarchy: every model/tool span's parent resolves inside the same trace.
  const traceGroups = Object.values(spansByTrace);
  let nestedInTrace = 0;
  for (const spans of traceGroups) {
    const ids = new Set(spans.map((s) => s.id));
    nestedInTrace += spans.filter(
      (s) => s.parent_span_id && ids.has(s.parent_span_id),
    ).length;
  }
  findings.push({
    check: "opik.parent-child",
    verdict: nestedInTrace > 0 ? "PASS" : "GAP",
    detail: `${nestedInTrace} span(s) with a parent present in the same trace (model/tool under the written run root)`,
  });
  // Model/tool spans parent specifically at a root span.
  const rootIds = new Set(roots.map((s) => s.id));
  const childOfRoot = anywhere.filter(
    (s) => s.parent_span_id && rootIds.has(s.parent_span_id),
  );
  findings.push({
    check: "steps.parent-is-root",
    verdict: childOfRoot.length > 0 ? "PASS" : "GAP",
    detail: `${childOfRoot.length} step span(s) whose parent is the run root span`,
  });
  // Real provider usage straight off the raw spans.
  const usageActual = anywhere.filter(
    (s) =>
      ((s.input ?? {}) as Record<string, unknown>).usage_state === "actual",
  );
  findings.push({
    check: "opik.span-usage-actual",
    verdict: usageActual.length > 0 ? "PASS" : "GAP",
    detail:
      usageActual.length > 0
        ? JSON.stringify(
            usageActual.slice(0, 4).map((s) => ({
              name: s.name,
              tokens_input: ((s.input ?? {}) as Record<string, unknown>)[
                "tokens_input"
              ],
              tokens_output: ((s.input ?? {}) as Record<string, unknown>)[
                "tokens_output"
              ],
            })),
          )
        : "no span carries actual provider usage",
  });
  // The R3-04-named gap: the real tool_call_id from the thread, on a span.
  const wanted = new Set(record.loops.map((l) => l.toolCall.id));
  const toolIdMatches = anywhere.filter((s) =>
    wanted.has(
      String(((s.input ?? {}) as Record<string, unknown>).tool_call_id ?? ""),
    ),
  );
  findings.push({
    check: "opik.tool-call-id",
    verdict: toolIdMatches.length > 0 ? "PASS" : "GAP",
    detail: toolIdMatches.length
      ? `${toolIdMatches.length} span(s) carry the real thread tool_call_id(s) ${[...wanted].join(",")}`
      : `no span carries the real thread tool_call_id(s) ${[...wanted].join(",")}`,
  });
  // R1-F6 (f7e-review-r1): the "opik.services" check that stood here classified
  // every span in the bot projects with one constant label and so could never
  // fail; removed rather than kept as a hollow PASS.

  evidence.findings = findings;
  return evidence;
}

// The remote (default LangGraph) record: the basic bindings this server wrote for
// the dialled runs, plus the ONE cross-service trace in Opik's Default Project.
async function collectLanggraph(
  api: ReturnType<typeof client>,
  opik: string,
  sql: ReturnType<typeof Bun.SQL>,
  record: {
    agentId: string;
    startedAt?: string;
    loops: Array<{
      threadId: string;
      runIds: string[];
      toolCall: { id: string; name: string };
      finalAnswer: string;
    }>;
  },
): Promise<Record<string, unknown>> {
  const findings: Finding[] = [];
  const evidence: Record<string, unknown> = { agentId: record.agentId };
  const driverRunIds = record.loops.flatMap((l) => l.runIds);
  evidence.driverRunIds = driverRunIds;

  const runsResponse = await fetch(
    `${api.serverOf()}/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs?limit=100`,
    { headers: api.headersOf() },
  );
  if (runsResponse.status === 404) {
    // A system-owned Bot (the deployment's default LangGraph): the manage gate
    // that precedes observation ownership refuses systemOwned for every actor,
    // so the run has no governance face at all. Recorded as the finding, not
    // smoothed over — the Opik half below still shows the run really executed.
    findings.push({
      check: "lg.run-locatable",
      verdict: "GAP",
      detail: `GET .../runs → 404: a system-owned Bot has no observation scope (canManageAgent refuses systemOwned even for the deployment admin), so its runs leave no bindings and no query face`,
    });
    evidence.runsList = [];
    evidence.runsFaceStatus = 404;
  } else if (!runsResponse.ok) {
    throw new Error(`GET runs → ${runsResponse.status}`);
  }
  const list = runsResponse.ok
    ? ((await runsResponse.json()) as {
        runs: Array<{
          runId: string;
          opikTraceId: string | null;
          state: string;
          usage: Record<string, unknown> | null;
          capability: string;
        }>;
        syncing: boolean;
      })
    : { runs: [], syncing: true };
  evidence.runsList = list.runs;
  if (evidence.runsFaceStatus !== 404) {
    findings.push({
      check: "lg.run-locatable",
      verdict: list.runs.length > 0 ? "PASS" : "GAP",
      detail: `${list.runs.length} remote run(s) via the query API (syncing=${list.syncing})`,
    });
  }
  const bindings = await sql`
    SELECT run_id, attempt_id, trace_id, opik_trace_id, state, capability, created_at, updated_at
    FROM ai_observation_bindings
    WHERE bot_id = ${record.agentId}
    ORDER BY created_at DESC
    LIMIT 20
  `;
  // R1-F5 (f7e-review-r1): the measured rows stand whatever the query face
  // answered — a 404 face is itself the finding, not a reason to blank the
  // measurement that says whether any binding exists at all.
  evidence.bindings = bindings;
  if (evidence.runsFaceStatus === 404) {
    findings.push({
      check: "lg.capability-basic",
      verdict: "GAP",
      detail:
        "no governance face for a system-owned Bot: no capability record exists to read",
    });
    findings.push({
      check: "lg.terminal-state",
      verdict: "GAP",
      detail:
        "no governance face for a system-owned Bot: no state to read (the run itself succeeded)",
    });
  } else {
    findings.push({
      check: "lg.capability-basic",
      verdict:
        list.runs.length > 0 && list.runs.every((r) => r.capability === "basic")
          ? "PASS"
          : "GAP",
      detail: `capability=${list.runs.map((r) => r.capability).join(",") || "-"} (T10: remote sees events, never internals)`,
    });
    const lgNamed = list.runs.filter(
      (r) =>
        r.state === "success" ||
        r.state === "completed" ||
        r.state === "failed" ||
        r.state === "error" ||
        r.state === "canceled" ||
        r.state === "interrupted",
    );
    findings.push({
      check: "lg.terminal-state",
      verdict:
        list.runs.length > 0 && lgNamed.length === list.runs.length
          ? "PASS"
          : "GAP",
      detail: `states=${list.runs.map((r) => r.state).join(",") || "-"}`,
    });
  }
  const distinctIds = new Set(
    (bindings as Array<{ run_id: string }>).map((b) => b.run_id),
  );
  findings.push({
    check: "lg.multi-distinct",
    verdict:
      (bindings as unknown[]).length >= 2 && distinctIds.size >= 2
        ? "PASS"
        : "GAP",
    detail: `${distinctIds.size} distinct authoritative remote run id(s) across ${list.runs.length} listed row(s)`,
  });

  // The Default Project: the one trace both services wrote into.
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  const def = (projects.content ?? []).find(
    (p) => p.name === "Default Project",
  );
  if (!def) {
    findings.push({
      check: "lg.default-project",
      verdict: "GAP",
      detail: "no Default Project in Opik",
    });
    evidence.findings = findings;
    return evidence;
  }
  // OCR r5 (dial-scan window): bound the scan to THIS drive's window — unjoined
  // residue from an earlier phase or a previous collect on the same instance
  // would otherwise sit in the acceptance denominator forever. Traces without a
  // parseable start_time are kept: the window scopes, it does not assert.
  const windowStart =
    typeof record.startedAt === "string" &&
    !Number.isNaN(Date.parse(record.startedAt))
      ? Date.parse(record.startedAt)
      : null;
  const traces =
    (
      await opikGet<{
        content?: Array<{ id: string; name?: string; start_time?: string }>;
      }>(opik, `/v1/private/traces?project_id=${def.id}&size=100`)
    ).content ?? [];
  const windowed =
    windowStart === null
      ? traces
      : traces.filter((t) => {
          if (
            typeof t.start_time !== "string" ||
            Number.isNaN(Date.parse(t.start_time))
          )
            return true;
          return Date.parse(t.start_time) >= windowStart;
        });
  evidence.dialWindow = {
    startedAt: record.startedAt ?? null,
    tracesScanned: traces.length,
    tracesInWindow: windowed.length,
  };
  const matched: Array<{ traceId: string; spans: SpanRow[]; runId: string }> =
    [];
  for (const trace of windowed) {
    const spans =
      (
        await opikGet<{ content?: SpanRow[] }>(
          opik,
          `/v1/private/spans?project_id=${def.id}&trace_id=${trace.id}&size=200`,
        )
      ).content ?? [];
    const runSpan = spans.find((s) => s.name === "ag-ui run");
    const runId = String(
      ((runSpan?.input ?? {}) as Record<string, unknown>)["openbot.run.id"] ??
        "",
    );
    if (driverRunIds.includes(runId))
      matched.push({ traceId: trace.id, spans, runId });
  }
  evidence.matchedTraces = matched.map((m) => ({
    traceId: m.traceId,
    runId: m.runId,
    services: [...new Set(m.spans.map(spanService))],
    spans: m.spans.map((s) => ({
      name: s.name,
      id: s.id,
      parent: s.parent_span_id ?? null,
      service: spanService(s),
    })),
  }));
  findings.push({
    check: "lg.run-id-mapping",
    verdict:
      matched.length === driverRunIds.length && matched.length > 0
        ? "PASS"
        : "GAP",
    detail: `${matched.length}/${driverRunIds.length} dialled run(s) found in Opik by openbot.run.id`,
  });
  findings.push({
    check: "lg.multi-run-distinct-traces",
    verdict:
      matched.length >= 2 &&
      new Set(matched.map((m) => m.traceId)).size === matched.length
        ? "PASS"
        : "GAP",
    detail: `${new Set(matched.map((m) => m.traceId)).size} distinct trace(s) for ${matched.length} matched run(s)`,
  });

  /*
   * The cross-service question over EVERY endpoint dial in the window, not just
   * the driver-named runs: the CopilotKit runtime forwards some dials under its
   * own derived run ids, and the trace-joined dials are among those — matching
   * only the driver's ids would count the joined half out by construction.
   */
  const dialTraces: Array<{
    traceId: string;
    spans: SpanRow[];
    runId: string;
    joined: boolean;
    crossEdges: number;
    services: string[];
  }> = [];
  for (const trace of windowed) {
    const spans =
      (
        await opikGet<{ content?: SpanRow[] }>(
          opik,
          `/v1/private/spans?project_id=${def.id}&trace_id=${trace.id}&size=200`,
        )
      ).content ?? [];
    const runSpan = spans.find((s) => s.name === "ag-ui run");
    if (!runSpan) continue;
    const runId = String(
      ((runSpan.input ?? {}) as Record<string, unknown>)["openbot.run.id"] ??
        "",
    );
    const byService = new Map(spans.map((s) => [s.id, spanService(s)]));
    const services = [...new Set(spans.map(spanService))];
    let crossEdges = 0;
    for (const s of spans) {
      const parentService = s.parent_span_id
        ? byService.get(s.parent_span_id)
        : undefined;
      if (
        parentService !== undefined &&
        parentService !== spanService(s) &&
        parentService !== "?"
      )
        crossEdges++;
    }
    const joined =
      services.includes("openbot-server") &&
      services.includes("agent-langgraph");
    dialTraces.push({
      traceId: trace.id,
      spans,
      runId,
      joined,
      crossEdges,
      services,
    });
  }
  evidence.dialTraces = dialTraces.map((d) => ({
    traceId: d.traceId,
    runId: d.runId,
    joined: d.joined,
    crossEdges: d.crossEdges,
    services: d.services,
  }));
  const joinedCount = dialTraces.filter((d) => d.joined).length;
  /*
   * R1-F2 (f7e-review-r1): this is the ACCEPTANCE row, and a partial join is
   * not a pass. The verdict is PASS only when every dial in the window
   * continued the host chain; anything less is a GAP whose detail names the
   * split — driver-supplied run ids versus the runtime's derived ids — so the
   * fraction cannot be read as "mostly works". (In the r1 evidence the split
   * was perfectly systematic: 0/6 driver-supplied ids joined, 3/3 derived ids
   * joined, and the joined ones were exactly the dials that carried the
   * authoritative binding identity.)
   */
  const driverDials = dialTraces.filter((d) => driverRunIds.includes(d.runId));
  const driverJoined = driverDials.filter((d) => d.joined).length;
  findings.push({
    check: "lg.w3c-cross-service-same-trace",
    verdict:
      dialTraces.length > 0 && joinedCount === dialTraces.length
        ? "PASS"
        : "GAP",
    detail:
      dialTraces.length > 0 && joinedCount === dialTraces.length
        ? `${joinedCount}/${dialTraces.length} endpoint dial trace(s) carry BOTH service names in one W3C-continued trace (host POST /api/... → endpoint POST /ag-ui → ag-ui run → chain → model)`
        : `${joinedCount}/${dialTraces.length} endpoint dial trace(s) carry BOTH service names in one W3C-continued trace; only ${driverJoined}/${driverDials.length} driver-supplied run id(s) joined — the acceptance property (every person-initiated dial continues the host chain) does NOT hold for the rest; the un-joined dials found no active span context at fetch time and the endpoint rooted its own trace — F7E-F1`,
  });
  const crossParented = dialTraces.reduce((sum, d) => sum + d.crossEdges, 0);
  findings.push({
    check: "lg.cross-service-parent",
    verdict: crossParented > 0 ? "PASS" : "GAP",
    detail: `${crossParented} span(s) whose parent lives on the OTHER service in the same trace (existence-only fact; the coverage verdict is the lg.w3c-cross-service-same-trace row)`,
  });
  const all = dialTraces.flatMap((d) => d.spans);
  const modelSpans = all.filter((s) =>
    String(s.name ?? "").startsWith("model:"),
  );
  findings.push({
    check: "lg.model-span",
    verdict: modelSpans.length > 0 ? "PASS" : "GAP",
    detail: `${modelSpans.length} model span(s) in the dialled traces`,
  });
  const chainSpans = all.filter((s) =>
    String(s.name ?? "").startsWith("chain:"),
  );
  findings.push({
    check: "lg.framework-callback",
    verdict: chainSpans.length > 0 ? "PASS" : "GAP",
    detail: `${chainSpans.length} chain:* callback span(s) (LangGraph/LangChain)`,
  });
  const usageActual = all.filter(
    (s) =>
      ((s.input ?? {}) as Record<string, unknown>).usage_state === "actual",
  );
  findings.push({
    check: "lg.span-usage-actual",
    verdict: usageActual.length > 0 ? "PASS" : "GAP",
    detail:
      usageActual.length > 0
        ? JSON.stringify(
            usageActual.slice(0, 4).map((s) => ({
              name: s.name,
              tokens_input: ((s.input ?? {}) as Record<string, unknown>)[
                "tokens_input"
              ],
              tokens_output: ((s.input ?? {}) as Record<string, unknown>)[
                "tokens_output"
              ],
            })),
          )
        : "no span carries actual provider usage",
  });
  const toolSpans = all.filter((s) => String(s.name ?? "").startsWith("tool:"));
  findings.push({
    check: "lg.tool-span",
    verdict: toolSpans.length > 0 ? "PASS" : "GAP",
    detail: `${toolSpans.length} tool span(s) (surface-executed client tools have no endpoint-side tool span — structural, disclosed)`,
  });
  // The driver's real tool_call_id from the AG-UI stream: recorded in the driver
  // state; checked here against any span carrying it.
  const wanted = new Set(record.loops.map((l) => l.toolCall.id));
  const toolIdMatches = all.filter((s) =>
    wanted.has(
      String(((s.input ?? {}) as Record<string, unknown>).tool_call_id ?? ""),
    ),
  );
  findings.push({
    check: "lg.tool-call-id",
    verdict: toolIdMatches.length > 0 ? "PASS" : "GAP",
    detail: toolIdMatches.length
      ? `${toolIdMatches.length} span(s) carry the real AG-UI tool_call_id(s)`
      : `no span carries the real AG-UI tool_call_id(s) ${[...wanted].join(",")} (endpoint proposes, surface executes — the ids live in the AG-UI stream facts, not a span)`,
  });
  // The budget receipt is a CONTROL-plane fact: it must NOT reach the person's
  // stream. The run completing at all is the receipt-verified evidence; the
  // person-facing leak check is asserted from the driver state below.
  findings.push({
    check: "lg.budget-receipt-verified",
    verdict:
      matched.length === driverRunIds.length && matched.length > 0
        ? "PASS"
        : "GAP",
    detail: `${matched.length}/${driverRunIds.length} dialled run(s) completed through the F7D middleware — a run only reaches RUN_FINISHED after its HMAC receipt verified (a refused receipt aborts the stream with REMOTE_RUN_BUDGET_CONTRACT_VIOLATION); server log corroborates`,
  });

  evidence.findings = findings;
  return evidence;
}

// The host process's own OTel half (A13): spans the OpenBot server process
// exported for the very requests these runs rode on, in Opik's Default Project.
async function collectHostProcess(
  opik: string,
  paths: string[],
): Promise<Record<string, unknown>> {
  const findings: Finding[] = [];
  const evidence: Record<string, unknown> = {};
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  const def = (projects.content ?? []).find(
    (p) => p.name === "Default Project",
  );
  if (!def) {
    return {
      findings: [
        {
          check: "host.otel-export",
          verdict: "GAP",
          detail: "no Default Project",
        },
      ],
    };
  }
  const traces =
    (
      await opikGet<{ content?: Array<{ id: string }> }>(
        opik,
        `/v1/private/traces?project_id=${def.id}&size=100`,
      )
    ).content ?? [];
  const hits: Array<{ traceId: string; span: SpanRow }> = [];
  for (const trace of traces) {
    const spans =
      (
        await opikGet<{ content?: SpanRow[] }>(
          opik,
          `/v1/private/spans?project_id=${def.id}&trace_id=${trace.id}&size=100`,
        )
      ).content ?? [];
    for (const span of spans) {
      // The host spans are named "<METHOD> <pathname>" by the server's own
      // request tracer, so match on the pathname suffix of the span name.
      if (
        paths.some(
          (path) => typeof span.name === "string" && span.name.endsWith(path),
        )
      )
        hits.push({ traceId: trace.id, span });
    }
  }
  evidence.matchedSpans = hits.map((h) => ({
    traceId: h.traceId,
    name: h.span.name,
    service: spanService(h.span),
  }));
  const services = new Set(hits.map((h) => spanService(h.span)));
  findings.push({
    check: "host.otel-export",
    verdict: hits.length > 0 ? "PASS" : "GAP",
    detail: `${hits.length} server-process span(s) in Default Project for the driven request paths (${paths.join(", ")})`,
  });
  findings.push({
    check: "host.service-name",
    verdict:
      services.size > 0 && ![...services].every((x) => x === "?")
        ? "PASS"
        : "GAP",
    detail: `service.name on the host spans: ${[...services].join(", ") || "-"}`,
  });
  evidence.findings = findings;
  return evidence;
}

async function collect(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const opik = need(a, "opik");
  const evidenceDir = need(a, "evidence");
  const envFile = need(a, "env-file");
  const phase = a.phase ?? "stock";
  const sql = new Bun.SQL(readEnvValue(envFile, "DATABASE_URL"));
  mkdirSync(evidenceDir, { recursive: true });
  const api = client(state, server);
  const output: Record<string, unknown> = {
    phase,
    collectedAt: new Date().toISOString(),
  };
  // try/finally: a collect-half throw must still release the connection.
  try {
    if (existsSync(join(state, "builtin-run.json"))) {
      const record = JSON.parse(
        readFileSync(join(state, "builtin-run.json"), "utf8"),
      );
      output.builtin = await collectBuiltin(api, opik, sql, record, "builtin");
    }
    if (existsSync(join(state, "langgraph-run.json"))) {
      const record = JSON.parse(
        readFileSync(join(state, "langgraph-run.json"), "utf8"),
      );
      output.langgraph = await collectLanggraph(api, opik, sql, record);
    }
    if (existsSync(join(state, "default-langgraph-run.json"))) {
      const record = JSON.parse(
        readFileSync(join(state, "default-langgraph-run.json"), "utf8"),
      );
      output.defaultLanggraph = await collectLanggraph(api, opik, sql, record);
    }
    if (existsSync(join(state, "remote-refusal.json"))) {
      output.remoteRefusal = JSON.parse(
        readFileSync(join(state, "remote-refusal.json"), "utf8"),
      );
    }
    const agentPaths: string[] = [];
    for (const file of ["builtin-run.json", "langgraph-run.json"]) {
      if (!existsSync(join(state, file))) continue;
      const record = JSON.parse(readFileSync(join(state, file), "utf8"));
      agentPaths.push(
        `/api/copilotkit/agent/${encodeURIComponent(record.agentId)}/run`,
      );
    }
    if (agentPaths.length > 0) {
      output.hostProcess = await collectHostProcess(opik, agentPaths);
    }
  } finally {
    await sql.close();
  }
  const file = join(evidenceDir, `real-chain-${phase}.json`);
  writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ step: "collect", evidence: file }));
}

const [command, ...rest] = process.argv.slice(2);
const a = args(rest);
const table: Record<string, (args: Args) => Promise<void>> = {
  login,
  builtin,
  "remote-unavailable": remoteUnavailable,
  langgraph,
  "default-langgraph": defaultLanggraph,
  "grant-credits": grantCredits,
  collect,
};
const run = table[command];
if (!run) {
  console.error(
    `unknown command ${command ?? "(none)"}; use login|builtin|remote-unavailable|langgraph|default-langgraph|grant-credits|collect`,
  );
  process.exit(2);
}
await run(a);
