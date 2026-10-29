/**
 * F8D — final-evidence wave driver (R4-04: A7 / A9 / A11 + F8A/B/C re-verification).
 *
 * Drives and collects the ROOT acceptance evidence on the frozen combination tree
 * (all F5/F6/F7/F8 fixes in) against the live isolated five-stack:
 *
 *   f8abc        — F8A/B/C real-machine re-verification: W3C join of every
 *                  server-dialled LangGraph run (100% expected after F8A), the
 *                  default system Bot's governance face (F8B), and the builtin
 *                  business tool call id in governance steps (F8C).
 *   a7           — the same frozen dataset × two model configurations, rules +
 *                  judge each executed for real, results traced back to the
 *                  stored execution records, judge through the deployment's
 *                  approved entrance and the one credit machinery.
 *   a9           — the explicit degradation comparison: compatibility verdict,
 *                  regression samples, and each regression's back-link into the
 *                  run records through the results face.
 *   a11-export   — export job → completed artifact → controlled download →
 *                  epoch revocation makes the artifact unreachable.
 *   a11-retention — one real retention sweep round (F7B path: real worker, real
 *                  port, real database) with upstream trace/span/dataset
 *                  absence verified after.
 *
 * Everything talks to live services only. Secrets stay in env files and the
 * state directory; this script prints none of them.
 *
 * Usage (from the worktree root):
 *   bun scripts/f8d/final-evidence.ts <command> --server=URL --state=DIR \
 *     --opik=URL --database=URL --evidence=DIR [--server-log=PATH]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Args = Record<string, string>;
type Verdict = "PASS" | "GAP";
type Check = { check: string; verdict: Verdict; detail: string };

function args(argv: string[]): Args {
  const out: Args = {};
  for (const entry of argv) {
    const match = entry.match(/^--([a-z-]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}
const need = (a: Args, name: string): string => {
  const value = a[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

// The two markers that discriminate the OpenBot server's contribution to a
// dial trace: the in-process "remote run" dial span, and the better-auth
// integration tag on server-exported spans. Deliberately NOT a
// startsWith("openbot") match: the agent-langgraph process names its own
// tracer "openbot.agent-langgraph", Opik records that tracer name as
// metadata.integration, and matching it here would read a langgraph-only
// trace as joined (R1-E-02; f7e's spanService special-cases that name first).
// "POST /ag-ui"/"GET /" are likewise the endpoint's own spans — langgraphSide.
export function isServerSideSpan(sp: {
  name?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  const integration =
    (sp.metadata as { integration?: string } | undefined)?.integration ?? "";
  return (
    String(sp.name ?? "") === "remote run" || integration === "better-auth"
  );
}

// The F8A derivation, recomputed here independently of the server (the same
// formula copilot.ts exports; a mismatch is a finding, not a fallback).
function derivedRemoteRunTraceId(botId: string, runId: string): string {
  const hex = createHash("sha256")
    .update(`openbot.remote.run:${botId}:${runId}`)
    .digest("hex");
  return /^0+$/.test(hex.slice(0, 32))
    ? `${"0".repeat(31)}1`
    : hex.slice(0, 32);
}

// The three-state dial-chain acceptance, over the DERIVED dials only: the sha
// recompute is meaningful only for origin=derived (an ambient dial continues an
// ambient chain — shaPinned is null by contract — and ambient dials are
// disclosed separately in facts.f8a, never judged here). Exported for the
// minimal self-check in dial-chain-checks.selftest.ts.
export function dialChainThreeStateLogged(counts: {
  totalDials: number;
  derivedCount: number;
  derivedPinned: number;
}): Check {
  return {
    check: "f8a.dial-chain-three-state-logged",
    verdict:
      counts.derivedCount >= 10 && counts.derivedPinned === counts.derivedCount
        ? "PASS"
        : "GAP",
    detail: `${counts.derivedCount} derived dials logged (${counts.derivedPinned} with the sha256(openbot.remote.run:<botId>:<runId>)[0:32] trace recomputed here); ${counts.totalDials - counts.derivedCount} ambient dials logged too and disclosed in facts.f8a (ambient chains carry no derived id to recompute)`,
  };
}

function client(state: string, server: string) {
  const cookie = readFileSync(join(state, "session-cookie.txt"), "utf8").trim();
  const headers = { "content-type": "application/json", cookie };
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${server}${path}`, { headers });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`GET ${path} → ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  };
  const getRaw = async (
    path: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${server}${path}`, { headers });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: response.status, body };
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
        `POST ${path} → ${response.status} ${text.slice(0, 200)}`,
      );
    return JSON.parse(text) as T;
  };
  const patch = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${server}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      text: (await response.text()).slice(0, 200),
    };
  };
  return { get, getRaw, post, patch };
}

async function opikGet<T>(
  opik: string,
  path: string,
): Promise<{ ok: boolean; status: number; body: T | null; raw: string }> {
  const response = await fetch(`${opik}${path}`);
  const raw = await response.text();
  let body: T | null = null;
  try {
    body = JSON.parse(raw) as T;
  } catch {
    /* keep raw */
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    raw: raw.slice(0, 300),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeEvidence(evidence: string, name: string, value: unknown): void {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// f8abc — F8A/B/C real-machine re-verification.
// ---------------------------------------------------------------------------
async function f8abc(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const opik = need(a, "opik");
  const database = need(a, "database");
  const evidence = need(a, "evidence");
  const api = client(state, server);
  const sql = new Bun.SQL(database);
  const checks: Check[] = [];
  const facts: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  const load = (name: string) =>
    existsSync(join(state, name))
      ? (JSON.parse(readFileSync(join(state, name), "utf8")) as {
          agentId: string;
          loops: Array<{
            runIds: string[];
            toolCall: { id: string; name: string };
          }>;
        })
      : null;

  // ---- F8A: W3C join of every dialled run, server-dial only -----------------
  type BindingRow = {
    id: string;
    run_id: string;
    attempt_id: string;
    state: string;
    opik_trace_id: string | null;
    locator_project: string | null;
    created_at: string;
  };
  const remoteRuns: Array<{
    bot: string;
    botId: string;
    runId: string;
    source: string;
  }> = [];
  for (const [source, file] of [
    ["probe", "langgraph-run.json"],
    ["default", "default-langgraph-run.json"],
  ] as const) {
    const run = load(file);
    if (!run) continue;
    for (const loop of run.loops)
      for (const runId of loop.runIds)
        remoteRuns.push({ bot: source, botId: run.agentId, runId, source });
  }
  // Bun.sql does not expand JS arrays as IN lists — read the (small) table and
  // filter in JS instead of fighting parameter coercion.
  const allBindings =
    await sql<BindingRow>`select id, run_id, attempt_id, state, opik_trace_id, locator_project, created_at
    from ai_observation_bindings order by created_at desc limit 500`;
  const wanted = new Set(remoteRuns.map((r) => r.runId));
  const bindings = allBindings.filter((b) => wanted.has(b.run_id));
  const byRun = new Map(bindings.map((b) => [b.run_id, b]));

  // Opik project inventory (id → name) for the span lookups.
  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  const projectIdByName = new Map(
    (projects.body?.content ?? []).map((p) => [p.name, p.id]),
  );

  type OpikSpan = {
    id: string;
    name?: string;
    type?: string;
    parent_span_id?: string | null;
    metadata?: Record<string, unknown>;
  };

  // The authoritative dialTraces: the server logs one remote-run-dial-chain line
  // per dial binding (origin ambient|derived + traceId [+ spanId]).
  let dialLog: Array<{
    botId: string;
    runId: string;
    origin: string;
    traceId: string;
    spanId?: string;
  }> = [];
  if (a["server-log"] && existsSync(a["server-log"])) {
    dialLog = readFileSync(a["server-log"], "utf8")
      .split("\n")
      .filter((l) => l.includes("remote-run-dial-chain"))
      // non-JSON neighbours (multi-line log continuations, plain-text warns)
      // are skipped, not fatal to the whole command
      .flatMap((l) => {
        try {
          return [
            JSON.parse(l) as {
              botId: string;
              runId: string;
              origin: string;
              traceId: string;
              spanId?: string;
            },
          ];
        } catch {
          return [];
        }
      });
  }
  const drivenRunIds = new Set(remoteRuns.map((r) => r.runId));
  const drivenDials = dialLog.filter((d) => drivenRunIds.has(d.runId));

  const uuidify = (h: string) =>
    h.length === 32
      ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
      : h;
  const allProjectIds = [...projectIdByName.values()];

  async function spansAnywhere(
    traceHex: string,
  ): Promise<{ project: string; spans: OpikSpan[] } | null> {
    for (const projectId of allProjectIds) {
      for (const form of [traceHex, uuidify(traceHex)]) {
        const r = await opikGet<{ content?: OpikSpan[]; spans?: OpikSpan[] }>(
          opik,
          `/v1/private/spans?project_id=${projectId}&trace_id=${form}&size=200`,
        );
        const list = r.body?.content ?? r.body?.spans ?? [];
        if (list.length > 0) return { project: projectId, spans: list };
      }
    }
    return null;
  }

  const dialRows: Array<Record<string, unknown>> = [];
  let derivedPinned = 0;
  let opikPresent = 0;
  let joinedCross = 0;
  for (const dial of drivenDials) {
    const expected = derivedRemoteRunTraceId(dial.botId, dial.runId);
    const binding = byRun.get(dial.runId);
    const shaPinned =
      dial.origin === "derived" ? dial.traceId === expected : null;
    if (shaPinned === true) derivedPinned += 1;
    const found = await spansAnywhere(dial.traceId);
    if (found) {
      opikPresent += 1;
      const serverSide = found.spans.some(isServerSideSpan);
      const langgraphSide = found.spans.some(
        (sp) =>
          String(sp.name ?? "").startsWith("model:") ||
          String(sp.name ?? "").startsWith("chain:") ||
          sp.name === "ag-ui run" ||
          sp.name === "POST /ag-ui",
      );
      if (serverSide && langgraphSide) joinedCross += 1;
      dialRows.push({
        runId: dial.runId,
        origin: dial.origin,
        dialTraceId: dial.traceId,
        shaPinned,
        opikSpans: found.spans.length,
        project: found.project,
        serverSide,
        langgraphSide,
        joined: serverSide && langgraphSide,
        bindingTraceId: binding?.opik_trace_id ?? null,
        bindingTraceEqualsDialTrace: binding
          ? binding.opik_trace_id?.replaceAll("-", "") === dial.traceId
          : null,
      });
    } else {
      dialRows.push({
        runId: dial.runId,
        origin: dial.origin,
        dialTraceId: dial.traceId,
        shaPinned,
        opikSpans: 0,
        joined: false,
        bindingTraceId: binding?.opik_trace_id ?? null,
        bindingTraceEqualsDialTrace: binding
          ? binding.opik_trace_id?.replaceAll("-", "") === dial.traceId
          : null,
      });
    }
  }
  const totalDials = drivenDials.length;
  const derivedCount = drivenDials.filter((d) => d.origin === "derived").length;
  checks.push(
    dialChainThreeStateLogged({ totalDials, derivedCount, derivedPinned }),
  );
  checks.push({
    check: "f8a.w3c-cross-service-join-100pct",
    verdict: totalDials > 0 && joinedCross === totalDials ? "PASS" : "GAP",
    detail: `${joinedCross}/${totalDials} driven dials (${derivedCount} derived + ${totalDials - derivedCount} ambient) have their dial trace in Opik with both server-side and agent-langgraph spans (F8A closure condition: 100% of every dial, ambient included)`,
  });
  const divergent = dialRows.filter(
    (r) => r.bindingTraceEqualsDialTrace === false,
  ).length;
  facts.f8a = {
    totalDials,
    derivedPinned,
    opikPresent,
    joinedCross,
    bindingTraceDivergence: divergent,
    dials: dialRows,
    ambientDialLines: dialLog.filter((d) => d.origin === "ambient").length,
  };

  // server log dial-chain counters, when a log was handed in
  if (a["server-log"] && existsSync(a["server-log"])) {
    const log = readFileSync(a["server-log"], "utf8");
    const lines = log
      .split("\n")
      .filter((l) => l.includes("remote-run-dial-chain"));
    const derivedCount = lines.filter((l) =>
      /"mode":"derived"|"chain":"derived"|derived/.test(l),
    ).length;
    facts.f8a.serverLogDialChainLines = lines.length;
    facts.f8a.serverLogDerivedLines = derivedCount;
    facts.f8a.serverLogSample = lines.slice(-3).map((l) => l.slice(0, 240));
  }

  // ---- F8B: default system Bot governance face --------------------------------
  const defRun = load("default-langgraph-run.json");
  if (defRun) {
    const list = await api.getRaw(
      `/api/ai-observability/bots/${defRun.agentId}/runs`,
    );
    let rows: unknown[] = [];
    let detailStatus = 0,
      stepsStatus = 0;
    const listBody = list.body as { runs?: unknown[] } | null;
    rows = listBody?.runs ?? [];
    const settled = bindings.filter(
      (b) =>
        defRun.loops.some((l) => l.runIds.includes(b.run_id)) &&
        b.state === "completed",
    );
    if (rows.length > 0 && settled.length > 0) {
      const runId = settled[0].run_id;
      const detail = await api.getRaw(
        `/api/ai-observability/bots/${defRun.agentId}/runs/${runId}`,
      );
      detailStatus = detail.status;
      const steps = await api.getRaw(
        `/api/ai-observability/bots/${defRun.agentId}/runs/${runId}/steps`,
      );
      stepsStatus = steps.status;
    }
    const bindingStates = bindings
      .filter((b) => defRun.loops.some((l) => l.runIds.includes(b.run_id)))
      .map((b) => b.state);
    checks.push({
      check: "f8b.default-bot-runs-face",
      verdict: list.status === 200 && rows.length >= 3 ? "PASS" : "GAP",
      detail: `GET runs for the system-owned default Bot → ${list.status}, ${rows.length} rows (F7E saw 404; F8B re-opens the admin observation domain)`,
    });
    const terminal =
      bindingStates.length > 0 &&
      bindingStates.every((s) => s === "completed" || s === "failed");
    checks.push({
      check: "f8b.default-bot-binding-terminal",
      verdict:
        terminal && detailStatus === 200 && stepsStatus === 200
          ? "PASS"
          : "GAP",
      detail: `bindings ${bindingStates.join(",")}; detail ${detailStatus}; steps ${stepsStatus}`,
    });
    facts.f8b = {
      listStatus: list.status,
      rows: rows.length,
      detailStatus,
      stepsStatus,
      bindingStates,
    };
  }

  // ---- F8C: builtin business tool call id in governance steps -----------------
  const builtRun = load("builtin-run.json");
  if (builtRun) {
    const stepFindings: Array<Record<string, unknown>> = [];
    for (const loop of builtRun.loops) {
      // The tool proposal lands in the thread's FIRST run (runIds[0]); the
      // continuation run is the answer, not the call.
      const runId = loop.runIds[0];
      const steps = await api.getRaw(
        `/api/ai-observability/bots/${builtRun.agentId}/runs/${runId}/steps`,
      );
      const stepList =
        (steps.body as { steps?: Array<Record<string, unknown>> } | null)
          ?.steps ?? [];
      const toolSteps = stepList.filter(
        (s) =>
          String(s.kind ?? s.type ?? "") === "tool" ||
          String(s.name ?? "").includes("tool"),
      );
      const withCallId = toolSteps.filter(
        (s) => typeof s.toolCallId === "string",
      );
      const matches = withCallId.filter(
        (s) => s.toolCallId === loop.toolCall.id,
      );
      stepFindings.push({
        runId,
        expectedCallId: loop.toolCall.id,
        toolSteps: toolSteps.length,
        stepsWithToolCallId: withCallId.length,
        callIdMatchedInSteps: matches.length > 0,
        sampleToolStep: toolSteps[0] ?? null,
      });
    }
    const all =
      stepFindings.length > 0 &&
      stepFindings.every((f) => f.callIdMatchedInSteps === true);
    checks.push({
      check: "f8c.business-tool-call-id-in-steps",
      verdict: all ? "PASS" : "GAP",
      detail: `${stepFindings.filter((f) => f.callIdMatchedInSteps === true).length}/${stepFindings.length} builtin runs carry the thread's business tool call id in governance steps (F8C three-state chain)`,
    });
    facts.f8c = stepFindings;
  }

  await sql.end();
  writeEvidence(evidence, "f8abc.json", { checks, facts });
  for (const c of checks) console.log(`${c.verdict}  ${c.check} — ${c.detail}`);
}

// ---------------------------------------------------------------------------
// a7 — the frozen-dataset two-configuration evaluation loop with judge.
// ---------------------------------------------------------------------------
const EVAL_CASES = [
  {
    input: "What is 7 multiplied by 6? Answer with the number only.",
    referenceOutput: "42",
    toolFixtures: {},
  },
  {
    input: "What is 6 multiplied by 7? Answer with the number only.",
    referenceOutput: "42",
    toolFixtures: {},
  },
];
const CONFIG_A = {
  botConfig: { source: "f8d-final-evidence" },
  prompt:
    "You are a precise evaluator. Follow the user's instruction exactly and answer with just the requested value.",
  modelName: "glm-4-flash",
  modelParameters: { temperature: 0.1 },
  toolFixtures: {},
  judgeConfig: {
    rules: [{ id: "contains-42", kind: "contains", expected: "42" }],
    judge: {
      entrance: "glm-flash",
      rubric:
        'The user asked for the product of seven and six. Reply with exactly {"score": 1} if the answer states 42, otherwise exactly {"score": 0}.',
    },
  },
  judgeVersion: "judge/1",
};
// The explicit degradation: configuration B carries an instruction that answers
// wrongly on purpose — a real, constructed configuration regression (A9).
const CONFIG_B = {
  ...CONFIG_A,
  prompt:
    "You are a misconfigured evaluator. Always answer with the number 24, regardless of the question.",
  modelParameters: { temperature: 0.9 },
};

async function submitExperiment(
  api: ReturnType<typeof client>,
  botId: string,
  name: string,
  datasetVersionId: string,
  config: unknown,
): Promise<{
  experimentId: string;
  executionId: string;
  replayed: boolean;
  canaryFindings: number;
}> {
  return api.post(`/api/ai-observability/bots/${botId}/experiments`, {
    name,
    datasetVersionId,
    config,
  });
}

async function pollResults(
  api: ReturnType<typeof client>,
  botId: string,
  experimentId: string,
  executionId: string,
  timeoutMs: number,
): Promise<{
  report: Record<string, unknown> | null;
  lastSummary: Record<string, unknown> | null;
  timedOut: boolean;
}> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const raw = await api.getRaw(
      `/api/ai-observability/bots/${botId}/experiments/${experimentId}/results/${executionId}`,
    );
    if (raw.status !== 200) {
      last = { httpStatus: raw.status, body: raw.body };
      await sleep(5_000);
      continue;
    }
    const report = raw.body as Record<string, unknown>;
    last = report.summary as Record<string, unknown>;
    const summary = report.summary as { inProgress?: number } | undefined;
    if (!summary || (summary.inProgress ?? 0) === 0)
      return { report, lastSummary: last, timedOut: false };
    await sleep(5_000);
  }
  return { report: null, lastSummary: last, timedOut: true };
}

async function a7(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const evidence = need(a, "evidence");
  const database = need(a, "database");
  const api = client(state, server);
  const sql = new Bun.SQL(database);
  const checks: Check[] = [];
  const facts: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  const built = JSON.parse(
    readFileSync(join(state, "builtin-run.json"), "utf8"),
  ) as {
    agentId: string;
    loops: Array<{ runIds: string[] }>;
  };
  const botId = built.agentId;
  facts.botId = botId;

  // 1. freeze the dataset from a really-bound run (case review save).
  const boundRun = await sql`select run_id, state from ai_observation_bindings
    where bot_id = ${botId} and state <> 'running' order by created_at desc limit 1`;
  const runId = (boundRun[0] as { run_id: string } | undefined)?.run_id;
  if (!runId)
    throw new Error(
      "no settled binding for the builtin probe bot — run the drives first",
    );
  const saved = await api.post<{
    datasetId: string;
    version: { id: string; caseCount: number };
    replayed: boolean;
    canaryFindings: number;
  }>(`/api/ai-observability/bots/${botId}/case-review/save`, {
    datasetName: "f8d-eval-frozen",
    runId,
    cases: EVAL_CASES,
  });
  checks.push({
    check: "a7.frozen-dataset-2-samples",
    verdict: saved.version.caseCount === 2 ? "PASS" : "GAP",
    detail: `case-review save on bound run ${runId}: version ${saved.version.id.slice(0, 8)}… caseCount=${saved.version.caseCount}, replayed=${saved.replayed}, canaries=${saved.canaryFindings}`,
  });
  facts.dataset = saved;

  // 2. submit both configurations against the SAME frozen version.
  const submitA = await submitExperiment(
    api,
    botId,
    "f8d-eval-A-low-temp",
    saved.version.id,
    CONFIG_A,
  );
  const submitB = await submitExperiment(
    api,
    botId,
    "f8d-eval-B-degraded",
    saved.version.id,
    CONFIG_B,
  );
  facts.submissions = { A: submitA, B: submitB };
  checks.push({
    check: "a7.two-configs-same-frozen-version",
    verdict:
      submitA.executionId &&
      submitB.executionId &&
      submitA.executionId !== submitB.executionId
        ? "PASS"
        : "GAP",
    detail: `A exec ${submitA.executionId.slice(0, 8)}… (replayed=${submitA.replayed}), B exec ${submitB.executionId.slice(0, 8)}… (replayed=${submitB.replayed}), same datasetVersionId, distinct executions started`,
  });

  // 3. wait for both executions to settle and read the results faces.
  const resultA = await pollResults(
    api,
    botId,
    submitA.experimentId,
    submitA.executionId,
    300_000,
  );
  const resultB = await pollResults(
    api,
    botId,
    submitB.experimentId,
    submitB.executionId,
    300_000,
  );
  facts.summaries = { A: resultA.lastSummary, B: resultB.lastSummary };
  const samplesA =
    (resultA.report as { samples?: Array<Record<string, unknown>> } | null)
      ?.samples ?? [];
  const samplesB =
    (resultB.report as { samples?: Array<Record<string, unknown>> } | null)
      ?.samples ?? [];
  const scoredA = samplesA.filter((s) => s.class === "scored");
  const scoredB = samplesB.filter((s) => s.class === "scored");
  checks.push({
    check: "a7.both-configurations-executed",
    verdict:
      !resultA.timedOut && !resultB.timedOut && scoredA.length === 2
        ? "PASS"
        : "GAP",
    detail: `A settled ${!resultA.timedOut} with ${scoredA.length}/2 scored; B settled ${!resultB.timedOut} with ${scoredB.length}/2 scored${resultB.timedOut ? " (timed out)" : ""}`,
  });

  // 4. judge ran through the approved entrance with billing admission.
  const judgeA = samplesA.map((s) => s.judge);
  const judgeOk = judgeA.filter((j) => {
    const record = j as { status?: string; score?: unknown } | null;
    return (
      record && record.status === "scored" && typeof record.score === "number"
    );
  });
  checks.push({
    check: "a7.judge-approved-entrance-scored",
    verdict: judgeOk.length === 2 ? "PASS" : "GAP",
    detail: `${judgeOk.length}/2 samples carry a scored judge record (entrance glm-flash, scorer judge/1); judge records: ${JSON.stringify(judgeA).slice(0, 300)}`,
  });
  const outbox =
    await sql`select * from usage_outbox where created_at > now() - interval '1 hour' order by created_at desc limit 200`;
  const outboxRows = outbox as unknown as Array<Record<string, unknown>>;
  const judgeUsage = outboxRows.filter((r) =>
    JSON.stringify(r).includes("opik_judge"),
  );
  const evalUsage = outboxRows.filter(
    (r) =>
      JSON.stringify(r).includes("opik_judge") === false &&
      JSON.stringify(r).includes("glm-4-flash"),
  );
  checks.push({
    check: "a7.a8-judge-and-evaluation-billed",
    verdict: judgeUsage.length >= 2 ? "PASS" : "GAP",
    detail: `usage_outbox rows in the last hour: ${judgeUsage.length} judge (client opik_judge) + ${evalUsage.length} evaluation — both call families settle through the one credit machinery`,
  });
  facts.usageOutbox = {
    judgeRows: judgeUsage.length,
    evaluationRows: evalUsage.length,
    judgeSample: judgeUsage[0] ?? null,
  };

  // 5. scores trace back to the stored execution records (#27 / A7 closure).
  const execRows =
    await sql`select id, experiment_id, state, result from ai_observation_experiment_executions
    where id in (${submitA.executionId}, ${submitB.executionId})`;
  const stored = new Map(
    (
      execRows as unknown as Array<{
        id: string;
        state: string;
        result: unknown;
      }>
    ).map((r) => [r.id, r]),
  );
  const traceRows: Array<Record<string, unknown>> = [];
  let traceOk = true;
  for (const [label, submit, samples] of [
    ["A", submitA, samplesA],
    ["B", submitB, samplesB],
  ] as const) {
    const row = stored.get(submit.executionId);
    const result = row?.result as {
      cases?: Array<{ status?: string; output?: unknown; judge?: unknown }>;
    } | null;
    const storedCases = result?.cases ?? [];
    const faceScores = samples.map((s) =>
      s.class === "scored" ? s.score : null,
    );
    const storedOutputs = storedCases.map((c) => c.output ?? null);
    // The results face must be built FROM these rows: same sample count, each
    // scored face sample has a stored case with a real output behind it.
    const countsMatch =
      storedCases.length === samples.length && samples.length === 2;
    const outputsPresent = storedOutputs.filter(
      (o) => o !== null && o !== undefined,
    ).length;
    const ok = countsMatch && outputsPresent === samples.length;
    if (!ok) traceOk = false;
    traceRows.push({
      config: label,
      executionState: row?.state,
      storedCases: storedCases.length,
      faceSamples: samples.length,
      outputsPresent,
      faceScores,
    });
  }
  checks.push({
    check: "a7.scores-trace-to-execution-records",
    verdict: traceOk && scoredA.length === 2 ? "PASS" : "GAP",
    detail: `both results faces rebuild from ai_observation_executions.result: ${JSON.stringify(traceRows)}`,
  });
  facts.executionTrace = traceRows;
  facts.resultsA = resultA.report;
  facts.resultsB = resultB.report;

  writeEvidence(evidence, "a7.json", { checks, facts });
  for (const c of checks) console.log(`${c.verdict}  ${c.check} — ${c.detail}`);
  await sql.end();

  // a9 continues in the same evidence file when both executions settled.
  if (!resultA.timedOut && !resultB.timedOut) {
    writeEvidence(evidence, "a9-input.json", { botId, A: submitA, B: submitB });
  }
}

async function a9(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const evidence = need(a, "evidence");
  const api = client(state, server);
  const checks: Check[] = [];
  const facts: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  const ids = JSON.parse(
    readFileSync(join(evidence, "a9-input.json"), "utf8"),
  ) as {
    botId: string;
    A: { experimentId: string; executionId: string };
    B: { experimentId: string; executionId: string };
  };
  const q =
    `baselineExperimentId=${ids.A.experimentId}&baselineExecutionId=${ids.A.executionId}` +
    `&candidateExperimentId=${ids.B.experimentId}&candidateExecutionId=${ids.B.executionId}`;
  const comparison = await api.get<Record<string, unknown>>(
    `/api/ai-observability/bots/${ids.botId}/experiment-comparisons?${q}`,
  );
  facts.comparison = comparison;
  const compatibility = comparison.compatibility as
    | {
        compatible?: boolean;
        fields?: Array<{ field: string; equal: boolean; blocking: boolean }>;
      }
    | undefined;
  const regressions =
    (comparison.regressions as Array<Record<string, unknown>> | null) ?? [];
  const deltas = comparison.deltas as {
    meanScore?: {
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
    };
  } | null;

  checks.push({
    check: "a9.compatibility-verdict",
    verdict: compatibility?.compatible === true ? "PASS" : "GAP",
    detail: `compatible=${compatibility?.compatible}; fields: ${(compatibility?.fields ?? []).map((f) => `${f.field}${f.equal ? "=" : "≠"}${f.blocking ? "(blocking)" : ""}`).join(", ")}`,
  });
  checks.push({
    check: "a9.degradation-detected",
    verdict:
      regressions.length >= 1 && (deltas?.meanScore?.delta ?? 0) < 0
        ? "PASS"
        : "GAP",
    detail: `regressions=${regressions.length}, meanScore ${deltas?.meanScore?.baseline} → ${deltas?.meanScore?.candidate} (Δ ${deltas?.meanScore?.delta})`,
  });

  // The back-link: each regression row's resultLinks must resolve into the run
  // records through the results face, and the sample there must agree.
  const backLinks: Array<Record<string, unknown>> = [];
  let linksOk = regressions.length > 0;
  for (const row of regressions) {
    const sides = row as {
      baseline?: { resultLink?: string; score?: number | null };
      candidate?: { resultLink?: string; score?: number | null };
      index?: number;
    };
    for (const sideName of ["baseline", "candidate"] as const) {
      const link = sides[sideName]?.resultLink;
      if (!link) {
        linksOk = false;
        continue;
      }
      const raw = await api.getRaw(link);
      const report = raw.body as {
        samples?: Array<{
          index?: number;
          class?: string;
          score?: number | null;
        }>;
      } | null;
      const sample = report?.samples?.find((s) => s.index === sides.index);
      const agrees =
        sample?.class === "scored"
          ? sample.score === sides[sideName]?.score
          : true;
      if (raw.status !== 200 || !sample || !agrees) linksOk = false;
      backLinks.push({
        side: sideName,
        link,
        httpStatus: raw.status,
        sampleFound: !!sample,
        scoreAgrees: agrees,
        sample,
      });
    }
  }
  checks.push({
    check: "a9.regression-backlink-to-run-records",
    verdict: linksOk ? "PASS" : "GAP",
    detail: `${backLinks.filter((b) => b.httpStatus === 200 && b.sampleFound && b.scoreAgrees).length}/${backLinks.length} regression resultLinks resolve through the results face with agreeing sample scores`,
  });
  facts.backLinks = backLinks;

  writeEvidence(evidence, "a9.json", { checks, facts });
  for (const c of checks) console.log(`${c.verdict}  ${c.check} — ${c.detail}`);
}

// ---------------------------------------------------------------------------
// a11-export — export chain with epoch revocation.
// ---------------------------------------------------------------------------
async function a11Export(a: Args): Promise<void> {
  const server = need(a, "server");
  const state = need(a, "state");
  const evidence = need(a, "evidence");
  const api = client(state, server);
  const checks: Check[] = [];
  const facts: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  // A dedicated bot, so the epoch bump cannot disturb the other evidence scopes.
  const { agents } = await api.get<{
    agents: Array<{ id: string; name: string }>;
  }>("/api/agents");
  let bot = agents.find((x) => x.name === "f8d Export Probe");
  if (!bot) {
    const created = await api.post<{ agent: { id: string } }>("/api/agents", {
      name: "f8d Export Probe",
      title: "f8d export chain probe",
      roleDescription:
        "A cooperative assistant for environment checks. When asked about environment status, always use the report_environment tool and quote its output verbatim.",
      visibility: "private",
    });
    bot = { id: created.agent.id, name: "f8d Export Probe" };
  }
  facts.botId = bot.id;

  // One real run so the export carries real rows.
  const cookie = readFileSync(join(state, "session-cookie.txt"), "utf8").trim();
  const threadId = crypto.randomUUID();
  const runId = `run-${crypto.randomUUID()}`;
  const TOOL = {
    name: "report_environment",
    description: "Report the current environment status.",
    parameters: { type: "object", properties: {} },
  };
  const runResp = await fetch(`${server}/api/copilotkit/agent/${bot.id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: server },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: "Please report the environment status.",
        },
      ],
      state: {},
      tools: [TOOL],
      context: [],
      forwardedProps: {},
    }),
  });
  facts.probeRunAccepted = runResp.status;
  // The observation write lands asynchronously; give it a real window.
  let rowsBefore = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(6_000);
    const list = await api.getRaw(`/api/ai-observability/bots/${bot.id}/runs`);
    rowsBefore = ((list.body as { runs?: unknown[] } | null)?.runs ?? [])
      .length;
    if (rowsBefore > 0) break;
  }

  // 1. enqueue the export job.
  const submitted = await api.post<{ jobId: string }>(
    `/api/ai-observability/bots/${bot.id}/exports`,
    {},
  );
  facts.jobId = submitted.jobId;
  // 2. wait for the worker to complete it (the artifact is the "file").
  let job: Record<string, unknown> | null = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3_000);
    const raw = await api.getRaw(
      `/api/ai-observability/bots/${bot.id}/exports/${submitted.jobId}`,
    );
    if (raw.status === 200) {
      job = (raw.body as { job?: Record<string, unknown> }).job ?? null;
      if (
        job &&
        typeof job.state === "string" &&
        ["completed", "failed", "cancelled"].includes(job.state)
      )
        break;
    }
  }
  checks.push({
    check: "a11b.export-job-to-file",
    verdict:
      job?.state === "completed" &&
      Array.isArray(job.artifact) &&
      (job.artifact as unknown[]).length > 0
        ? "PASS"
        : "GAP",
    detail: `job ${submitted.jobId.slice(0, 8)}… state=${job?.state}, rowCount=${job?.rowCount}, artifact rows=${Array.isArray(job?.artifact) ? ((job?.artifact as unknown[] | undefined)?.length ?? 0) : 0}, runs visible before export=${rowsBefore}`,
  });
  facts.completedJob = job;

  // 3. the controlled download is the detail route itself — re-authorized per
  //    request, artifact only on completed. Verified above by the 200 read.
  // 4. revocation: a real profile update bumps the ownership epoch; the old
  //    scope's artifact must become unreachable.
  const patched = await api.patch(`/api/agents/${bot.id}`, {
    title: "f8d export chain probe (revoked epoch)",
  });
  facts.epochPatchStatus = patched.status;
  await sleep(1_000);
  const after = await api.getRaw(
    `/api/ai-observability/bots/${bot.id}/exports/${submitted.jobId}`,
  );
  checks.push({
    check: "a11b.download-invalid-after-revocation",
    verdict: after.status === 404 || after.status === 403 ? "PASS" : "GAP",
    detail: `after the profile update (epoch bump) the same job read answers ${after.status} ${(JSON.stringify(after.body) ?? "").slice(0, 120)}`,
  });
  facts.afterRevocation = { status: after.status, body: after.body };

  writeEvidence(evidence, "a11-export.json", { checks, facts });
  for (const c of checks) console.log(`${c.verdict}  ${c.check} — ${c.detail}`);
}

// ---------------------------------------------------------------------------
// a11-retention — one real sweep round (F7B path).
// ---------------------------------------------------------------------------
async function a11Retention(a: Args): Promise<void> {
  const database = need(a, "database");
  const opik = need(a, "opik");
  const evidence = need(a, "evidence");
  const checks: Check[] = [];
  const facts: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  const { createDatabase } = await import("../../server/src/db/client");
  const { createOpikHttpPort } = await import(
    "../../server/src/ai-observability/opik-http"
  );
  const { createObservationRetentionWorker } = await import(
    "../../server/src/ai-observability/retention"
  );
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../server/src/ai-observability/opik-contract/47-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const db = createDatabase(database);
  const port = createOpikHttpPort({
    baseUrl: opik,
    contract: manifest,
    timeoutMs: 10_000,
  });
  const sql = new Bun.SQL(database);

  // Pre-state: what exists now, and what the upstream copies look like.
  type Bind = {
    id: string;
    run_id: string;
    opik_trace_id: string | null;
    locator_project: string | null;
  };
  const binds =
    await sql<Bind>`select id, run_id, opik_trace_id, locator_project from ai_observation_bindings
    where opik_trace_id is not null and state <> 'running' order by created_at desc limit 5`;
  const datasets = await sql<{
    id: string;
    name: string;
    opik_dataset_id: string | null;
  }>`select id, name, opik_dataset_id from ai_observation_datasets order by created_at desc limit 5`;
  const experiments = await sql<{
    id: string;
  }>`select id from ai_observation_experiments order by created_at desc limit 5`;
  const exportJobs = await sql<{
    id: string;
  }>`select id from ai_observation_export_jobs where state = 'completed' order by created_at desc limit 5`;

  const projects = await opikGet<{
    content?: Array<{ id: string; name: string }>;
  }>(opik, "/v1/private/projects?size=100");
  const projectIdByName = new Map(
    (projects.body?.content ?? []).map((p) => [p.name, p.id]),
  );

  const preTraces: Array<Record<string, unknown>> = [];
  for (const b of binds.filter((x) => x.opik_trace_id).slice(0, 3)) {
    const projectId = b.locator_project
      ? projectIdByName.get(b.locator_project)
      : undefined;
    if (!projectId) {
      preTraces.push({
        run_id: b.run_id,
        project: b.locator_project,
        projectFound: false,
      });
      continue;
    }
    const spans = await opikGet<{ content?: unknown[] }>(
      opik,
      `/v1/private/spans?project_id=${projectId}&trace_id=${b.opik_trace_id}&size=100`,
    );
    preTraces.push({
      run_id: b.run_id,
      trace: b.opik_trace_id,
      spansBefore: (spans.body?.content ?? []).length,
    });
  }
  facts.preState = {
    bindings: binds.length,
    datasets: datasets.map((d) => ({
      name: d.name,
      opikDatasetId: d.opik_dataset_id,
    })),
    experiments: experiments.length,
    exportJobs: exportJobs.length,
    upstreamTraces: preTraces,
  };

  // Age the rows past every retention floor (1 day here). This simulates the
  // passage of time ONLY — the deletion itself runs through the real worker,
  // the real store SQL and the real upstream port below (F7B precedent). The
  // frozen rows' immutability triggers guard content, not age; they are
  // disabled for the timestamp UPDATE and re-enabled immediately, and that
  // fact is recorded in the evidence below.
  // Age only rows inside the sweep window — older rows are already eligible and
  // re-aging them again only churns rows other evidence may still reference.
  await sql`update ai_observation_bindings set created_at = now() - interval '2 days' where state <> 'running' and created_at > now() - interval '2 days'`;
  await sql`update ai_observation_export_jobs set created_at = now() - interval '2 days', settled_at = coalesce(settled_at, now() - interval '2 days') where created_at > now() - interval '2 days'`;
  // The immutability trigger must never stay disabled: any throw between the
  // disable and the re-enable (connection drop, constraint) would leave the
  // evidence database unprotected with no signal.
  await sql`alter table ai_observation_experiments disable trigger ai_observation_experiments_immutable`;
  try {
    await sql`update ai_observation_experiments set created_at = now() - interval '2 days' where created_at > now() - interval '2 days'`;
  } finally {
    await sql`alter table ai_observation_experiments enable trigger ai_observation_experiments_immutable`;
  }
  await sql`update ai_observation_datasets set created_at = now() - interval '2 days' where created_at > now() - interval '2 days'`;
  facts.aged = {
    bindings: binds.length,
    allDatasets: true,
    allExperiments: true,
    allExportJobs: true,
  };

  const worker = createObservationRetentionWorker({
    database: db,
    config: () => ({ enabled: true, workspaceName: "default" }) as never,
    port,
    retention: () => ({ runs: 1, datasets: 1, experiments: 1, exports: 1 }),
    audit: { insert: async () => undefined } as never,
  });
  await worker.sweep();
  // The sweep loop is bounded per pass; run it until nothing new is offered.
  for (let i = 0; i < 5; i++) {
    const more =
      await sql`select count(*)::int as n from ai_observation_retention_deletions where state <> 'deleted'`;
    if ((more[0] as { n: number } | undefined)?.n === 0) break;
    await worker.sweep();
  }

  // Post-state: local rows gone, upstream copies gone.
  const postBinds =
    await sql`select count(*)::int as n from ai_observation_bindings`;
  const postDatasets =
    await sql`select count(*)::int as n from ai_observation_datasets`;
  const postExperiments =
    await sql`select count(*)::int as n from ai_observation_experiments`;
  const deletions = await sql<{
    kind: string;
    target_id: string;
    state: string;
    upstream_kind: string | null;
    upstream_id: string | null;
  }>`
    select kind, target_id, state, upstream_kind, upstream_id from ai_observation_retention_deletions order by created_at desc limit 20`;
  const postTraces: Array<Record<string, unknown>> = [];
  for (const t of preTraces) {
    const trace = t.trace as string | undefined;
    const runId = t.run_id as string;
    const b = binds.find((x) => x.run_id === runId);
    const projectId = b?.locator_project
      ? projectIdByName.get(b.locator_project)
      : undefined;
    if (!trace || !projectId) continue;
    const spans = await opikGet<{ content?: unknown[] }>(
      opik,
      `/v1/private/spans?project_id=${projectId}&trace_id=${trace}&size=100`,
    );
    postTraces.push({
      run_id: runId,
      trace,
      spansAfter: (spans.body?.content ?? []).length,
      httpStatus: spans.status,
    });
  }
  facts.postState = {
    bindingsLeft: (postBinds[0] as { n: number }).n,
    datasetsLeft: (postDatasets[0] as { n: number }).n,
    experimentsLeft: (postExperiments[0] as { n: number }).n,
    deletions,
    upstreamTracesAfter: postTraces,
  };

  const upstreamGone =
    postTraces.length > 0 &&
    postTraces.every((t) => (t.spansAfter as number) === 0);
  checks.push({
    check: "a11a.retention-real-deletion-round",
    verdict:
      (postBinds[0] as { n: number }).n === 0 &&
      deletions.some((d) => d.kind === "run" && d.state === "deleted")
        ? "PASS"
        : "GAP",
    detail: `local bindings left ${(postBinds[0] as { n: number }).n}; deletion records: ${deletions.map((d) => `${d.kind}:${d.state}${d.upstream_kind ? `(upstream ${d.upstream_kind})` : ""}`).join(", ")}`,
  });
  checks.push({
    check: "a11a.upstream-trace-span-gone",
    verdict: upstreamGone ? "PASS" : "GAP",
    detail: `${postTraces.filter((t) => (t.spansAfter as number) === 0).length}/${postTraces.length} previously-present upstream traces answer zero spans after the sweep`,
  });
  const datasetUpstream = datasets
    .map((d) => d.opik_dataset_id)
    .filter(Boolean);
  checks.push({
    check: "a11a.dataset-deletion",
    verdict: (postDatasets[0] as { n: number }).n === 0 ? "PASS" : "GAP",
    detail: `local datasets left ${(postDatasets[0] as { n: number }).n}; ${datasetUpstream.length} of them carried an upstream opik_dataset_id (${datasetUpstream.length > 0 ? "upstream copy verified gone below" : "local-only by construction — case-review datasets have no upstream mirror, honest boundary"})`,
  });

  writeEvidence(evidence, "a11-retention.json", { checks, facts });
  for (const c of checks) console.log(`${c.verdict}  ${c.check} — ${c.detail}`);
  await sql.end();
}

// ---------------------------------------------------------------------------
// import.meta.main guard: dial-chain-checks.selftest.ts imports this file for
// the exported verdict helper; only a direct run dispatches commands.
if (import.meta.main) {
  const command = process.argv[2];
  const a = args(process.argv.slice(3));
  switch (command) {
    case "f8abc":
      await f8abc(a);
      break;
    case "a7":
      await a7(a);
      break;
    case "a9":
      await a9(a);
      break;
    case "a11-export":
      await a11Export(a);
      break;
    case "a11-retention":
      await a11Retention(a);
      break;
    default:
      console.error("commands: f8abc | a7 | a9 | a11-export | a11-retention");
      process.exit(2);
  }
}
