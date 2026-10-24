/**
 * F5E1 — real-chain evidence driver (FREV-06 / A2 / A13 / #22 / #23 / #43).
 *
 * Drives one REAL built-in Agent run and one REAL LangGraph Agent run through the
 * workbench-authenticated CopilotKit runtime, executing the offered client tool as
 * the surface would; then collects the governance evidence from OpenBot's own
 * query API and from the self-hosted Opik instance.
 *
 * Everything here talks to a live, isolated stack. It never mocks a run, never
 * skips a missing capability silently, and never prints a secret value: cookie and
 * token values stay in the state directory (mode 600) and env file.
 *
 * Commands
 *   login    --server=URL [--casdoor=CASDOOR_URL] [--user=admin] [--password=123] --state=DIR
 *   builtin  --server=URL --state=DIR
 *   langgraph --server=URL --state=DIR --endpoint=URL --env-file=PATH
 *   collect  --server=URL --state=DIR --opik=URL --evidence=DIR
 *
 * The login command is the repository's own e2e precedent (craft-preview-acceptance.ts
 * selectors #username/#password/button[type=submit], auth.setup.e2e.ts credentials):
 * a real browser against a real Casdoor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

type Args = Record<string, string>;

function spanIds_has(set: Set<string>, id: string): boolean {
  return set.has(id);
}
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
    // Same-origin POST the app's own sign-in button makes, then follow its URL.
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
// Run driver: one real two-turn tool loop against a named Bot.
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
  return { get, post };
}

const TOOL = {
  name: "report_environment",
  description:
    "Report the fixed environment status line. Use it whenever the user asks about environment status.",
  parameters: { type: "object", properties: {}, required: [] },
};

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
  const ask =
    "What is the environment status? Use the report_environment tool and quote its exact output.";

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

  // Turn 1: ask, and wait for the proposal to land in the thread.
  await run([{ id: crypto.randomUUID(), role: "user", content: ask }]);
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

  // Turn 2: the surface executes the tool and hands the result back.
  const result = { status: "f5e1 isolated stack: all systems nominal" };
  await run([
    { id: messages[0].id, role: "user", content: ask },
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
      content: JSON.stringify(result),
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
      last.content.includes(result.status)
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

async function builtin(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const api = client(state, server);
  const NAME = "f5e1 Builtin Probe";
  let bot = await findBot(api, NAME);
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: NAME,
      title: "f5e1 built-in path probe",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
    });
    bot = { id: created.agent.id, name: NAME, endpoint: null };
  }
  const loop = await runToolLoop(api, bot.id);
  writeFileSync(
    join(state, "builtin-run.json"),
    JSON.stringify({ agentId: bot.id, agentName: NAME, ...loop }, null, 2),
  );
  console.log(
    JSON.stringify({
      step: "builtin",
      agentId: bot.id,
      threadId: loop.threadId,
      runIds: loop.runIds,
      toolCall: loop.toolCall,
      finalAnswer: loop.finalAnswer.slice(0, 200),
    }),
  );
}

// ---------------------------------------------------------------------------
// langgraph-direct: drive the agent-langgraph process's own AG-UI endpoint.
// The server-side path to a remote Bot is fail-closed at this HEAD
// (REMOTE_RUN_BUDGET_UNVERIFIED, see the report), so the LangGraph half of the
// evidence is taken at the process boundary the server would dial — same token
// header, same AG-UI contract — and labelled honestly in the evidence.
// ---------------------------------------------------------------------------

async function langgraphDirect(a: Args): Promise<void> {
  const endpoint = need(a, "endpoint");
  const envFile = need(a, "env-file");
  const state = need(a, "state");
  const token = readEnvValue(envFile, "MANAGED_AGENT_TOKEN");
  const threadId = crypto.randomUUID();
  const runIds: string[] = [];
  const ask =
    "What is the environment status? Use the report_environment tool and quote its exact output.";
  const tool = {
    name: "report_environment",
    description:
      "Report the fixed environment status line. Use it whenever the user asks about environment status.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  type AgUiEvent = { type: string; [key: string]: unknown };
  const runOnce = async (messages: unknown[]): Promise<AgUiEvent[]> => {
    const runId = `run-${crypto.randomUUID()}`;
    runIds.push(runId);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": token,
      },
      body: JSON.stringify({
        threadId,
        runId,
        messages,
        state: {},
        tools: [tool],
        context: [],
        forwardedProps: {},
      }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `langgraph run → ${response.status} ${text.slice(0, 300)}`,
      );
    const events: AgUiEvent[] = [];
    for (const block of text.split("\n\n")) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        const ev = JSON.parse(data);
        if (ev && typeof ev === "object" && typeof ev.type === "string")
          events.push(ev);
      } catch {
        /* skip */
      }
    }
    return events;
  };

  const events1 = await runOnce([
    { id: crypto.randomUUID(), role: "user", content: ask },
  ]);
  const kinds1 = events1.map((e) => e.type);
  console.log(
    JSON.stringify({ step: "langgraph-direct", threadId, turn1Events: kinds1 }),
  );
  const toolCall = events1.find(
    (e) => e.type === "TOOL_CALL" || e.type === "TOOL_CALL_START",
  ) as { toolCallId?: string; toolName?: string } | undefined;
  let finalAnswer = "";
  if (toolCall?.toolCallId) {
    const result = { status: "f5e1 isolated stack: all systems nominal" };
    const events2 = await runOnce([
      { id: crypto.randomUUID(), role: "user", content: ask },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCall.toolCallId,
            type: "function",
            function: {
              name: toolCall.toolName ?? "report_environment",
              arguments: "{}",
            },
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        role: "tool",
        toolCallId: toolCall.toolCallId,
        content: JSON.stringify(result),
      },
    ]);
    const kinds2 = events2.map((e) => e.type);
    console.log(
      JSON.stringify({
        step: "langgraph-direct",
        threadId,
        turn2Events: kinds2,
      }),
    );
    finalAnswer = events2
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => String(e.delta ?? ""))
      .join("");
  }
  writeFileSync(
    join(state, "langgraph-direct-run.json"),
    JSON.stringify(
      {
        endpoint,
        threadId,
        runIds,
        toolCall: toolCall
          ? { id: toolCall.toolCallId ?? "", name: toolCall.toolName ?? "" }
          : null,
        finalAnswer: finalAnswer.slice(0, 400),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      step: "langgraph-direct",
      threadId,
      toolCall,
      finalAnswer: finalAnswer.slice(0, 200),
    }),
  );
}

async function langgraph(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const endpoint = need(a, "endpoint");
  const envFile = need(a, "env-file");
  const token = readEnvValue(envFile, "MANAGED_AGENT_TOKEN");
  const api = client(state, server);
  const NAME = "f5e1 LangGraph Probe";
  let bot = await findBot(api, NAME);
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: NAME,
      title: "f5e1 LangGraph path probe",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
      endpoint,
      auth: { header: "x-openbot-agent-token", value: token },
    });
    bot = { id: created.agent.id, name: NAME, endpoint };
  }
  const loop = await runToolLoop(api, bot.id);
  writeFileSync(
    join(state, "langgraph-run.json"),
    JSON.stringify(
      { agentId: bot.id, agentName: NAME, endpoint, ...loop },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      step: "langgraph",
      agentId: bot.id,
      threadId: loop.threadId,
      runIds: loop.runIds,
      toolCall: loop.toolCall,
      finalAnswer: loop.finalAnswer.slice(0, 200),
    }),
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
  start_time?: string;
  end_time?: string;
};

async function collectOne(
  api: ReturnType<typeof client>,
  opik: string,
  sql: ReturnType<typeof Bun.SQL>,
  record: {
    agentId: string;
    threadId: string;
    runIds: string[];
    toolCall: { id: string; name: string };
  },
  label: string,
) {
  const findings: Array<{
    check: string;
    verdict: "PASS" | "GAP";
    detail: string;
  }> = [];
  const evidence: Record<string, unknown> = {
    label,
    agentId: record.agentId,
    threadId: record.threadId,
  };

  // 1. The run as OpenBot's own API projects it (binding-backed).
  const list = await api.get<{
    runs: Array<{
      opikTraceId: string;
      state: string;
      usage: Record<string, unknown>;
      capability: string;
    }>;
  }>(
    `/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs?limit=100`,
  );
  evidence.runsList = list.runs;
  findings.push({
    check: "run.locatable",
    verdict: list.runs.length > 0 ? "PASS" : "GAP",
    detail: `${list.runs.length} run(s) via GET /api/ai-observability/bots/:id/runs`,
  });

  // 2. The local authoritative bindings for this Bot: the run ids the query API
  // keys on are the binding rows, not the AG-UI run ids this driver generated.
  const bindings = await sql`
    SELECT run_id, attempt_id, trace_id, opik_trace_id, state, capability, created_at
    FROM ai_observation_bindings
    WHERE bot_id = ${record.agentId}
    ORDER BY created_at DESC
    LIMIT 20
  `;
  evidence.bindings = bindings;
  findings.push({
    check: "binding.established",
    verdict: bindings.length > 0 ? "PASS" : "GAP",
    detail: `${bindings.length} binding row(s) for the Bot; states=${bindings.map((row) => row.state).join(",") || "-"}`,
  });

  // 3. Run detail + steps for each binding's run id.
  const details: unknown[] = [];
  const steps: unknown[] = [];
  for (const binding of bindings as Array<{ run_id: string }>) {
    const runId = binding.run_id;
    try {
      const detail = await api.get(
        `/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(runId)}`,
      );
      details.push(detail);
      const stepResult = await api.get<{
        steps: Array<{
          kind: string;
          spanId: string;
          parentSpanId: string | null;
          name: string | null;
          executionState?: string;
          state: string;
        }>;
      }>(
        `/api/ai-observability/bots/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(runId)}/steps`,
      );
      steps.push({ runId, steps: stepResult.steps });
    } catch (error) {
      steps.push({
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  evidence.runDetails = details;
  evidence.runSteps = steps;

  const allSteps = steps.flatMap((entry) =>
    Array.isArray((entry as { steps?: unknown }).steps)
      ? (
          entry as {
            steps: Array<{
              kind: string;
              spanId: string;
              parentSpanId: string | null;
              name: string | null;
              executionState?: string;
              state: string;
            }>;
          }
        ).steps
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

  // 3. Hierarchy: a model/tool step whose parent is a span in the same run tree
  // (run root → model/tool), and a tool step authenticating the proposed/executed
  // distinction from this driver's REAL two-turn loop.
  const spanIds = new Set(allSteps.map((s) => s.spanId));
  const nested = allSteps.filter(
    (s) => s.parentSpanId && spanIds.has(s.parentSpanId),
  );
  findings.push({
    check: "steps.hierarchy",
    verdict: nested.length > 0 ? "PASS" : "GAP",
    detail: `${nested.length} step(s) carry a parent inside the run tree`,
  });
  const executed = toolSteps.filter((s) => s.executionState === "executed");
  findings.push({
    check: "steps.proposed-vs-executed",
    verdict: toolSteps.length > 0 && executed.length > 0 ? "PASS" : "GAP",
    detail: `proposed=${toolSteps.filter((s) => s.executionState === "proposed").length} executed=${executed.length}`,
  });

  // 4. Real provider usage, as the run summary reports it.
  const providerUsage = list.runs.filter(
    (run) => (run.usage as { source?: string }).source === "provider",
  );
  findings.push({
    check: "usage.provider",
    verdict: providerUsage.length > 0 ? "PASS" : "GAP",
    detail:
      providerUsage.length > 0
        ? JSON.stringify(providerUsage.map((run) => run.usage))
        : "no run reported provider usage",
  });

  // 5. Raw Opik rows, across ALL projects: REST-written spans (the bot-* project)
  // and OTLP-written spans (the collector's default project) are both this
  // deployment's evidence, so the search is not narrowed to one project.
  // The REST writer's spans adopt Opik-derived trace ids that the binding's W3C
  // trace id cannot name, so the search scans the Bot's own project's spans
  // directly and groups them by the trace id Opik actually stored.
  const knownTraceIds = new Set<string>();
  for (const detail of details as Array<{
    run?: { traceId?: string; opikTraceId?: string | null };
  }>) {
    if (detail?.run?.traceId) knownTraceIds.add(detail.run.traceId);
    if (detail?.run?.opikTraceId) knownTraceIds.add(detail.run.opikTraceId);
  }
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  evidence.opikProjects = projects.content?.map((p) => p.name);
  const spansByTrace: Record<string, SpanRow[]> = {};
  const tracesByProject: Record<
    string,
    Array<{ id: string; name?: string }>
  > = {};
  const botProjects = (projects.content ?? []).filter((p) =>
    p.name.startsWith(`bot-${record.agentId}-`),
  );
  for (const project of botProjects) {
    const spans =
      (
        await opikGet<{ content?: SpanRow[] }>(
          opik,
          `/v1/private/spans?project_id=${project.id}&size=100`,
        )
      ).content ?? [];
    const byTrace = new Map<string, SpanRow[]>();
    for (const span of spans) {
      const traceId = String(span.trace_id ?? "");
      byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), span]);
    }
    for (const [traceId, traceSpans] of byTrace) {
      spansByTrace[`${project.name}:${traceId}`] = traceSpans;
    }
    tracesByProject[project.name] = [...byTrace.keys()].map((id) => ({ id }));
  }
  evidence.opikTraces = tracesByProject;
  evidence.opikSpans = spansByTrace;
  evidence.opikTraceIdsWanted = [...knownTraceIds];
  const anywhere = Object.values(spansByTrace).flat();
  // Real provider usage and the tool call id, read straight off the raw spans.
  const usageActual = anywhere.filter(
    (s) =>
      ((s.input ?? {}) as Record<string, unknown>).usage_state === "actual",
  );
  findings.push({
    check: "opik.span-usage",
    verdict: usageActual.length > 0 ? "PASS" : "GAP",
    detail:
      usageActual.length > 0
        ? JSON.stringify(
            usageActual.map((s) => ({
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
  const toolIdMatch = anywhere.find(
    (s) =>
      ((s.input ?? {}) as Record<string, unknown>).tool_call_id ===
      record.toolCall.id,
  );
  findings.push({
    check: "opik.tool-call-id",
    verdict: toolIdMatch ? "PASS" : "GAP",
    detail: toolIdMatch
      ? `span ${toolIdMatch.name} carries tool_call_id ${record.toolCall.id} from the real run; execution_state=${JSON.stringify(((toolIdMatch.input ?? {}) as Record<string, unknown>).execution_state)}`
      : `no span carries the real tool_call_id ${record.toolCall.id}`,
  });
  const spanIdSet = new Set(anywhere.map((s) => s.id));
  const childOfKnown = anywhere.filter(
    (s) => s.parent_span_id && spanIds_has(spanIdSet, s.parent_span_id),
  );
  findings.push({
    check: "opik.spans",
    verdict: anywhere.length > 0 ? "PASS" : "GAP",
    detail: `${anywhere.length} span(s) across ${Object.keys(spansByTrace).length} trace(s); wanted trace ids ${[...knownTraceIds].join(",") || "-"}`,
  });
  findings.push({
    check: "opik.parent-child",
    verdict: childOfKnown.length > 0 ? "PASS" : "GAP",
    detail: `${childOfKnown.length} span(s) with a parent present in the same trace`,
  });
  const serviceName = (span: SpanRow) => {
    const meta = span.metadata as { service_name?: string } | undefined;
    const attrs = span.attributes as Record<string, unknown> | undefined;
    return String(meta?.service_name ?? attrs?.["service.name"] ?? "?");
  };
  const services = new Set(anywhere.map(serviceName));
  evidence.opikServiceNames = [...services];
  findings.push({
    check: "opik.services",
    verdict: services.size > 1 ? "PASS" : "GAP",
    detail: `services observed: ${[...services].join(", ")}`,
  });

  evidence.findings = findings;
  return evidence;
}

// The LangGraph direct record: spans live in Opik's Default Project (the process's
// OTel export), matched by the run span's openbot.run.id attribute.
async function collectLanggraphDirect(
  opik: string,
  record: {
    threadId: string;
    runIds: string[];
    toolCall: { id: string; name: string } | null;
  },
): Promise<Record<string, unknown>> {
  const findings: Array<{
    check: string;
    verdict: "PASS" | "GAP";
    detail: string;
  }> = [];
  const evidence: Record<string, unknown> = { threadId: record.threadId };
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  const def = (projects.content ?? []).find(
    (p) => p.name === "Default Project",
  );
  if (!def)
    return {
      findings: [
        { check: "opik.project", verdict: "GAP", detail: "no Default Project" },
      ],
    };
  const traces = await opikGet<{
    content?: Array<{ id: string; name?: string }>;
  }>(opik, `/v1/private/traces?project_id=${def.id}&size=100`);
  const matched: Array<{ traceId: string; spans: SpanRow[]; runId: string }> =
    [];
  for (const trace of traces.content ?? []) {
    const spans =
      (
        await opikGet<{ content?: SpanRow[] }>(
          opik,
          `/v1/private/spans?project_id=${def.id}&trace_id=${trace.id}&size=100`,
        )
      ).content ?? [];
    const runSpan = spans.find((s) => s.name === "ag-ui run");
    const runId = String(
      ((runSpan?.input ?? {}) as Record<string, unknown>)["openbot.run.id"] ??
        "",
    );
    if (record.runIds.includes(runId))
      matched.push({ traceId: trace.id, spans, runId });
  }
  evidence.matchedTraces = matched.map((m) => ({
    traceId: m.traceId,
    runId: m.runId,
    spans: m.spans.map((s) => ({
      name: s.name,
      parent: s.parent_span_id ?? null,
      id: s.id,
    })),
  }));
  findings.push({
    check: "lg.otel-export",
    verdict:
      matched.length === record.runIds.length && matched.length > 0
        ? "PASS"
        : "GAP",
    detail: `${matched.length}/${record.runIds.length} run(s) found in Opik by openbot.run.id`,
  });
  const all = matched.flatMap((m) => m.spans);
  const runSpans = all.filter((s) => s.name === "ag-ui run");
  const modelSpans = all.filter((s) =>
    String(s.name ?? "").startsWith("model:"),
  );
  const chainSpans = all.filter((s) =>
    String(s.name ?? "").startsWith("chain:"),
  );
  const toolSpans = all.filter((s) => String(s.name ?? "").startsWith("tool:"));
  findings.push({
    check: "lg.run-span",
    verdict: runSpans.length > 0 ? "PASS" : "GAP",
    detail: `${runSpans.length} ag-ui run span(s)`,
  });
  findings.push({
    check: "lg.framework-callback",
    verdict: chainSpans.length > 0 ? "PASS" : "GAP",
    detail: `${chainSpans.length} chain:* callback span(s) (LangGraph/LangChain)`,
  });
  findings.push({
    check: "lg.model-span",
    verdict: modelSpans.length > 0 ? "PASS" : "GAP",
    detail: `${modelSpans.length} model span(s)`,
  });
  findings.push({
    check: "lg.tool-span",
    verdict: toolSpans.length > 0 ? "PASS" : "GAP",
    detail: `${toolSpans.length} tool span(s)`,
  });
  const spanIds = new Set(all.map((s) => s.id));
  const childOfKnown = all.filter(
    (s) => s.parent_span_id && spanIds.has(s.parent_span_id),
  );
  findings.push({
    check: "lg.parent-child",
    verdict: childOfKnown.length > 0 ? "PASS" : "GAP",
    detail: `${childOfKnown.length} span(s) parented inside the trace`,
  });
  const serviceName = (span: SpanRow) => {
    const input = (span.input ?? {}) as Record<string, unknown>;
    const attrs = span.attributes as Record<string, unknown> | undefined;
    return String(input.service_name ?? attrs?.service_name ?? "?");
  };
  const services = new Set(all.map(serviceName));
  findings.push({
    check: "lg.cross-service",
    verdict: services.size > 1 ? "PASS" : "GAP",
    detail: `services in the langgraph trace(s): ${[...services].join(", ") || "?"} — the server is absent because the server→remote-bot dial is fail-closed at this HEAD`,
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
  const sql = new Bun.SQL(readEnvValue(envFile, "DATABASE_URL"));
  mkdirSync(evidenceDir, { recursive: true });
  const api = client(state, server);
  const output: Record<string, unknown> = {};
  for (const [label, file] of [
    ["builtin", "builtin-run.json"],
    ["langgraph", "langgraph-run.json"],
  ] as const) {
    if (!existsSync(join(state, file))) {
      output[label] = {
        findings: [
          { check: "record", verdict: "GAP", detail: `${file} absent` },
        ],
      };
      continue;
    }
    const record = JSON.parse(readFileSync(join(state, file), "utf8"));
    output[label] = await collectOne(api, opik, sql, record, label);
  }
  if (existsSync(join(state, "langgraph-direct-run.json"))) {
    const record = JSON.parse(
      readFileSync(join(state, "langgraph-direct-run.json"), "utf8"),
    );
    output["langgraph-direct"] = await collectLanggraphDirect(opik, record);
  }
  await sql.close();
  writeFileSync(
    join(evidenceDir, "real-chain.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    JSON.stringify({
      step: "collect",
      evidence: join(evidenceDir, "real-chain.json"),
    }),
  );
}

const [command, ...rest] = process.argv.slice(2);
const a = args(rest);
const table: Record<string, (args: Args) => Promise<void>> = {
  login,
  builtin,
  langgraph,
  "langgraph-direct": langgraphDirect,
  collect,
};
const run = table[command];
if (!run) {
  console.error(
    `unknown command ${command ?? "(none)"}; use login|builtin|langgraph|langgraph-direct|collect`,
  );
  process.exit(2);
}
await run(a);
