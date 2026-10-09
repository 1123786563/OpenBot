#!/usr/bin/env bun
/*
 * The R4 test coordinator: builds and starts the REAL Go runtime candidate as
 * a child process, drives it over HTTP, and writes the compatibility report
 * from what it actually measured — never a conclusion typed in ahead of time.
 *
 * What "the candidate" is here: the runtime-go module itself (the R2 adapter,
 * the R3 callback client and cancel boundary) composed with the real framework
 * — model/openai pointed at a fake OpenAI-compatible provider, llmagent.New,
 * adapter.New — exactly the composition the Go tests in
 * runtime-go/internal/adapter/agui_test.go verify. The launcher main below is
 * written by this script into a throwaway module that `replace`s
 * openbot/runtime-go with the repository's runtime-go directory, so the probe
 * composes the candidate WITHOUT shipping a second main in the repository:
 * R1's cmd/runtime stays the minimal health service until a ring owns its
 * production wiring.
 *
 * Run from the repository root: `bun server/scripts/enterprise-runtime-probe.ts`
 * Exit code: 0 only when every check passed; any failure (or any check that
 * could not run) exits non-zero — a missing check is a failed check, and the
 * report says "rejected", never a pre-written pass.
 *
 * Every child process below is spawned with an explicit argv array and no
 * shell: nothing that crosses a trust boundary (a URL, a credential, a pid)
 * is ever interpolated into a command string.
 */
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { HttpAgent } from "@ag-ui/client";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  hashCallbackToken,
  looksLikeCallbackToken,
  mintCallbackToken,
  mintRunAssertion,
  readRunAssertion,
} from "../src/agents/callback-token";
import { createApp, type DeploymentToolCaller } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createRuntimeValidationRoutes,
  type RuntimeVerificationIdentity,
} from "../src/enterprise/runtime/validation-routes";
import { testEnvironment } from "../tests/support/environment";

/** The repository root, resolved from this file so the cwd cannot steer it. */
export const repoRoot = (): string => resolve(import.meta.dir, "../..");

export const runtimeGoDir = (): string => join(repoRoot(), "runtime-go");

/** Runs one external tool with an explicit argv (no shell, no string commands). */
async function runTool(
  argv: readonly string[],
  cwd?: string,
): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GOPROXY: "off" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, text: code === 0 ? stdout : stderr || stdout };
}

// ---------------------------------------------------------------------------
// The candidate launcher: a complete Go program written into a temp module.
// ---------------------------------------------------------------------------

/*
 * The full composition the Go tests in runtime-go/internal/adapter/agui_test.go
 * verify piece by piece, assembled as one process:
 *
 *   server.Authenticate (identity middleware; the validation endpoint is the
 *   probe's real TS route) in front of adapter.New(llmagent over the real
 *   model/openai client), the one governed tool crossing the existing
 *   /api/agent-tools/call plane, and server.Cancel on the framework runner's
 *   cancel seam. The AG-UI handler answers under /agui/, the cancel boundary
 *   at /cancel, health under /health/ — and the ready address goes to stdout
 *   as the one line `READY <url>` the probe waits for.
 */
const LAUNCHER_MAIN = `package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	openaimodel "trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/tool"

	"openbot/runtime-go/internal/adapter"
	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/server"
)

// governedToolName matches what the probe's fake provider scripts.
const governedToolName = "probe_governed"

func main() {
	var (
		addr         = flag.String("addr", "127.0.0.1:0", "listen address")
		modelBaseURL = flag.String("model-base-url", "", "OpenAI-compatible provider base URL (the probe's fake)")
		modelAlias   = flag.String("model-alias", "probe-model", "model alias sent to the provider")
		validationEP = flag.String("validation-endpoint", "", "TS validation endpoint URL")
		callbackEP   = flag.String("callback-endpoint", "", "TS /api/agent-tools/call endpoint URL")
		agentToken   = flag.String("agent-token", "", "agent token presented to the TS plane")
		serviceCred  = flag.String("service-credential", "", "platform-to-runtime shared credential")
	)
	flag.Parse()
	var missing []string
	if *modelBaseURL == "" {
		missing = append(missing, "-model-base-url")
	}
	if *validationEP == "" {
		missing = append(missing, "-validation-endpoint")
	}
	if *serviceCred == "" {
		missing = append(missing, "-service-credential")
	}
	if len(missing) > 0 {
		log.Fatalf("runtime candidate: missing %s", strings.Join(missing, ", "))
	}

	authCfg := server.AuthConfig{
		ServiceCredential:  *serviceCred,
		ValidationEndpoint: *validationEP,
	}

	// The one governed tool this candidate exposes: it executes on the TS
	// plane, never inline. No other egress exists in this composition.
	var tools []tool.Tool
	if *callbackEP != "" {
		plane := &callback.Client{
			HTTP:       &http.Client{Timeout: 10 * time.Second},
			Endpoint:   *callbackEP,
			AgentToken: *agentToken,
		}
		tools = append(tools, adapter.GovernedTool(plane, governedToolName,
			"Platform-governed probe tool; executes on the TS plane.", nil))
	}

	provider := openaimodel.New(*modelAlias,
		openaimodel.WithBaseURL(*modelBaseURL),
		openaimodel.WithAPIKey("test-only"),
	)
	agentOpts := []llmagent.Option{
		llmagent.WithModel(provider),
		llmagent.WithInstruction("You are the OpenBot Go runtime candidate under probe."),
		llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
		llmagent.WithMaxLLMCalls(4),
		llmagent.WithMaxToolIterations(2),
	}
	if len(tools) > 0 {
		agentOpts = append(agentOpts, llmagent.WithTools(tools))
	}
	a := llmagent.New("openbot-probe-agent", agentOpts...)

	var canceler adapter.Canceler
	handler, _, err := adapter.New(a, adapter.WithCancelerSink(func(c adapter.Canceler) {
		canceler = c
	}))
	if err != nil {
		log.Fatalf("runtime candidate: adapter.New: %v", err)
	}

	auth := server.Authenticate(authCfg)
	mux := http.NewServeMux()
	mux.Handle("/health/", server.Health(func() bool { return authCfg.Ready() }))
	mux.Handle("/agui/", http.StripPrefix("/agui", auth(handler)))
	mux.Handle("/cancel", auth(server.Cancel(canceler)))

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("runtime candidate: listen: %v", err)
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("READY http://%s\\n", ln.Addr().String())
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("runtime candidate: serve: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	// The probe owns this process's lifetime; on its signal the candidate
	// exits promptly rather than draining a stream a check has already ended.
	os.Exit(0)
}
`;

/** Pins the launcher to the exact module versions runtime-go froze (R1). */
function launcherGoMod(): string {
  const goMod = readFileSync(join(runtimeGoDir(), "go.mod"), "utf8");
  const goDirective = /^go\s+\S+$/m.exec(goMod)?.[0];
  if (!goDirective) throw new Error("runtime-go/go.mod carries no go directive");
  const pinned = [...goMod.matchAll(/^\t(trpc\.group\/\S+)\s+(v\S+)$/gm)].map(
    (m) => `\t${m[1]} ${m[2]}`,
  );
  if (pinned.length === 0)
    throw new Error("runtime-go/go.mod carries no trpc module pins for the launcher");
  return [
    /*
     * The launcher module's path deliberately sits INSIDE runtime-go's module
     * path: Go's internal-package rule is lexical, so only a package rooted
     * at openbot/runtime-go/... may import openbot/runtime-go/internal/...,
     * which is exactly the composition this probe exists to exercise.
     */
    "module openbot/runtime-go/probe-launcher",
    "",
    goDirective,
    "",
    "require (",
    "\topenbot/runtime-go v0.0.0",
    ...pinned,
    ")",
    "",
    `replace openbot/runtime-go => ${runtimeGoDir()}`,
    "",
  ].join("\n");
}

let candidateBinary: Promise<string> | undefined;

/** Builds the Go candidate offline (everything is in the local module cache). */
export function buildCandidate(): Promise<string> {
  candidateBinary ??= buildCandidateOnce();
  return candidateBinary;
}

async function buildCandidateOnce(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "openbot-runtime-probe-"));
  writeFileSync(join(dir, "main.go"), LAUNCHER_MAIN);
  writeFileSync(join(dir, "go.mod"), launcherGoMod());
  copyFileSync(join(runtimeGoDir(), "go.sum"), join(dir, "go.sum"));
  // Tidy resolves the launcher's own require set offline (the module cache
  // already holds everything runtime-go pinned); without it the build refuses
  // to guess which requirements the composition pulls in.
  const tidy = await runTool(["go", "mod", "tidy"], dir);
  if (tidy.code !== 0)
    throw new Error(`tidying the launcher module failed:\n${tidy.text.trim()}`);
  const build = await runTool(["go", "build", "-o", "candidate", "."], dir);
  if (build.code !== 0)
    throw new Error(`building the Go candidate failed (${build.code}):\n${build.text.trim()}`);
  return join(dir, "candidate");
}

// ---------------------------------------------------------------------------
// A started candidate: one child process with a ready address on stdout.
// ---------------------------------------------------------------------------

export type Candidate = {
  pid: number;
  baseUrl: string;
  kill: () => Promise<void>;
};

export async function startCandidate(opts: {
  binary: string;
  serviceCredential: string;
  modelBaseUrl: string;
  validationEndpoint: string;
  callbackEndpoint?: string;
  agentToken?: string;
}): Promise<Candidate> {
  const argv = [
    opts.binary,
    "-model-base-url",
    opts.modelBaseUrl,
    "-validation-endpoint",
    opts.validationEndpoint,
    "-service-credential",
    opts.serviceCredential,
  ];
  if (opts.callbackEndpoint !== undefined) {
    argv.push("-callback-endpoint", opts.callbackEndpoint);
    argv.push("-agent-token", opts.agentToken ?? "");
  }
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrLog: string[] = [];
  const stderrDrain = new Response(proc.stderr)
    .text()
    .then((text) => stderrLog.push(text))
    .catch(() => {});
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 30_000;
  let url: string | null = null;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null),
    ]);
    if (next === null || next.done) break;
    seen += decoder.decode(next.value, { stream: true });
    url = /^READY (\S+)$/m.exec(seen)?.[1] ?? null;
    if (url) break;
  }
  // Drain the rest of both pipes in the background so the child can never
  // block on a full pipe while the probe is still talking to it.
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } catch {
      /* the child died; its exit code is checked where it matters */
    }
  })();
  if (!url) {
    proc.kill();
    await stderrDrain;
    throw new Error(
      `the Go candidate never reported a ready address; stdout: ${seen.trim()}; stderr: ${stderrLog.join("\n").trim()}`,
    );
  }
  return {
    pid: proc.pid,
    baseUrl: url,
    kill: async () => {
      proc.kill();
      const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
      if (exited === null) {
        proc.kill(9);
        await proc.exited;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The fake provider: one OpenAI-compatible endpoint, deterministic answers.
// ---------------------------------------------------------------------------

export const CANDIDATE_TOOL_NAME = "probe_governed";
export const PROBE_STREAM_TEXT = "PROBE_STREAM answer the protocol check";
export const PROBE_TOOL_TEXT = `PROBE_TOOL call ${CANDIDATE_TOOL_NAME} now`;
export const PROBE_SLOW_TEXT = "PROBE_SLOW take your time answering";
export const PROBE_FAIL_TEXT = "PROBE_FAIL break on purpose";

/**
 * How long the slow scripted answer takes. It must comfortably outlive the
 * cancel check's post-cancel window, so "the stream ended" can only mean "the
 * cancellation stopped the run", never "the answer finally arrived".
 */
const SLOW_MS = 15_000;

export type FakeModelRequest = {
  stream: boolean;
  userText: string;
  hasToolResult: boolean;
  authorization: string | null;
};

type ChatMessage = { role?: string; content?: unknown };

export function startFakeModel() {
  const requests: FakeModelRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !path.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 });
      const body = (await request.json()) as { stream?: boolean; messages?: ChatMessage[] };
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : JSON.stringify(lastUser?.content ?? "");
      const captured: FakeModelRequest = {
        stream: !!body.stream,
        userText,
        hasToolResult: messages.some((m) => m.role === "tool"),
        authorization: request.headers.get("authorization"),
      };
      requests.push(captured);
      if (userText.includes(PROBE_FAIL_TEXT))
        return new Response("provider exploded: leak-bait-secret-detail", { status: 500 });
      if (userText.includes(PROBE_SLOW_TEXT)) await Bun.sleep(SLOW_MS);
      if (userText.includes(PROBE_TOOL_TEXT) && !captured.hasToolResult)
        return toolCallCompletion(captured.stream);
      return textCompletion(finalTextFor(captured), captured.stream);
    },
  });
  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    requests,
    waitFor: (condition: () => boolean, timeoutMs = 10_000): Promise<void> =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          if (condition()) return resolve();
          if (Date.now() > deadline)
            return reject(new Error("the fake provider never saw the expected request"));
          setTimeout(tick, 25);
        };
        tick();
      }),
  };
}

function finalTextFor(request: FakeModelRequest): string {
  if (request.hasToolResult) return "callback-observed";
  if (request.userText.includes(PROBE_SLOW_TEXT)) return "slow-run-ok";
  return "probe-stream-ok";
}

function textCompletion(text: string, stream: boolean): Response {
  const message = { role: "assistant", content: text };
  if (!stream) return jsonResponse(chatCompletionBody({ message, finish_reason: "stop" }));
  return sseResponse([
    chunk({ role: "assistant" }, null),
    chunk({ content: text.slice(0, Math.ceil(text.length / 2)) }, null),
    chunk({ content: text.slice(Math.ceil(text.length / 2)) }, null),
    chunk({}, "stop"),
  ]);
}

function toolCallCompletion(stream: boolean): Response {
  const toolCall = {
    id: "call_probe",
    type: "function",
    function: { name: CANDIDATE_TOOL_NAME, arguments: JSON.stringify({ query: "probe" }) },
  };
  if (!stream)
    return jsonResponse(
      chatCompletionBody({
        message: { role: "assistant", tool_calls: [toolCall] },
        finish_reason: "tool_calls",
      }),
    );
  return sseResponse([
    chunk(
      {
        role: "assistant",
        tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: CANDIDATE_TOOL_NAME, arguments: "" } }],
      },
      null,
    ),
    chunk(
      { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: "probe" }) } }] },
      null,
    ),
    chunk({}, "tool_calls"),
  ]);
}

function chatCompletionBody(choice: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "fixture",
    object: "chat.completion",
    choices: [{ index: 0, ...choice }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "probe-chunk",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// The TS side of the candidate's trust chain, with the real primitives.
// ---------------------------------------------------------------------------

const TENANT = "tenant_fixed_test_member";
const ACTOR = "actor_probe";
const BOT = "probe_bot";
/** The deployment key both planes share; a test value, never a real credential. */
const PLANE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * The identity oracle the Go middleware calls, wired exactly as the R2 tests
 * wired the host: real mint/read primitives, a token store of hashes, the
 * token naming which Bot may present an assertion.
 */
export function startValidationPlane() {
  const token = mintCallbackToken();
  const open = new Set([hashCallbackToken(token)]);
  const verify = async (
    presented: string,
    assertion: string,
  ): Promise<RuntimeVerificationIdentity | null> => {
    const run = readRunAssertion(assertion, PLANE_KEY);
    if (!run) return null;
    if (!looksLikeCallbackToken(presented)) return null;
    if (!open.has(hashCallbackToken(presented))) return null;
    if (run.botId !== BOT) return null;
    return {
      tenantId: TENANT,
      actorId: run.actorId,
      botId: run.botId,
      runId: run.runId,
      threadId: run.threadId ?? "",
    };
  };
  const server = Bun.serve({
    port: 0,
    fetch: createRuntimeValidationRoutes({ verify }).fetch,
  });
  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    validationEndpoint: `http://${server.hostname}:${server.port}/validate`,
    token,
    mint: (runId: string, threadId: string) => ({
      assertion: mintRunAssertion({ botId: BOT, actorId: ACTOR, runId, threadId }, PLANE_KEY),
      token,
    }),
  };
}

/**
 * The existing `/api/agent-tools/call` route, on the real `createApp`, with
 * the same wiring its R3 tests use: hashed token store and a deployment tool
 * caller that records what crossed the plane.
 */
export function startCallbackPlane() {
  const captured: Parameters<DeploymentToolCaller>[0][] = [];
  const token = mintCallbackToken();
  const tokenHashes = new Map<string, { id: string }>([
    [hashCallbackToken(token), { id: BOT }],
  ]);
  const parameters: Parameters<typeof createApp> = [
    loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: PLANE_KEY })),
  ];
  parameters[9] = {
    agentForCallbackToken: async (hash: string) => tokenHashes.get(hash) ?? null,
  } as Parameters<typeof createApp>[9];
  parameters[28] = (async (input: Parameters<DeploymentToolCaller>[0]) => {
    captured.push(input);
    return { text: "plane-answer-ok", isError: false };
  }) as DeploymentToolCaller;
  const server = Bun.serve({ port: 0, fetch: createApp(...parameters).fetch });
  return {
    server,
    callbackEndpoint: `http://${server.hostname}:${server.port}/api/agent-tools/call`,
    token,
    captured,
  };
}

// ---------------------------------------------------------------------------
// HTTP talking to the candidate.
// ---------------------------------------------------------------------------

export function candidateHeaders(credentials: {
  serviceCredential: string;
  agentToken: string;
  assertion: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-openbot-runtime-service-credential": credentials.serviceCredential,
    "x-openbot-agent-token": credentials.agentToken,
    "x-openbot-run-assertion": credentials.assertion,
  };
}

export function runInput(run: {
  runId: string;
  threadId: string;
  text: string;
}): RunAgentInput {
  return {
    runId: run.runId,
    threadId: run.threadId,
    messages: [{ id: `msg-${run.runId}`, role: "user", content: run.text }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

export function httpAgentFor(
  baseUrl: string,
  headers: Record<string, string>,
): HttpAgent {
  return new HttpAgent({ url: `${baseUrl}/agui/`, headers });
}

/** Consumes one real run through @ag-ui/client's HttpAgent (or any AbstractAgent). */
export async function collectEvents(
  agent: Pick<AbstractAgent, "run">,
  input: RunAgentInput,
  opts: { onFirstEvent?: () => void } = {},
): Promise<BaseEvent[]> {
  return await new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => {
        if (events.length === 0) opts.onFirstEvent?.();
        events.push(event);
      },
      error: reject,
      complete: () => resolve(events),
    });
  });
}

/** The boolean form of the contract the tests assert; the probe cannot throw its way to a pass. */
export function satisfiesEventContract(events: BaseEvent[]): boolean {
  const types = events.map((e) => e.type);
  const count = (t: string) => types.filter((x) => x === t).length;
  const terminals = count("RUN_FINISHED") + count("RUN_ERROR");
  return (
    types.length > 0 &&
    types[0] === "RUN_STARTED" &&
    count("RUN_STARTED") === 1 &&
    terminals === 1 &&
    (types[types.length - 1] === "RUN_FINISHED" || types[types.length - 1] === "RUN_ERROR")
  );
}

/** Joins the stream's text deltas into the answer the consumer saw. */
export function textOf(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The probe itself.
// ---------------------------------------------------------------------------

export type CompatibilityReport = {
  commit: string;
  goVersion: string;
  modules: Array<{ path: string; version: string; indirect: boolean }>;
  checks: {
    identity: boolean;
    stream: boolean;
    callback: boolean;
    cancel: boolean;
    restart: boolean;
  };
  measurements: { rssBytes: number; firstEventMs: number };
  adoption: "candidate" | "rejected";
};

const SERVICE_CREDENTIAL = "probe-service-credential-not-a-real-one";

async function gatherEnvironment(): Promise<{
  commit: string;
  goVersion: string;
  modules: CompatibilityReport["modules"];
}> {
  const commit = await runTool(["git", "rev-parse", "HEAD"], repoRoot());
  if (commit.code !== 0) throw new Error(`git rev-parse failed: ${commit.text.trim()}`);
  const goVersion = await runTool(["go", "version"]);
  if (goVersion.code !== 0) throw new Error(`go version failed: ${goVersion.text.trim()}`);
  const modules = await runTool(
    // -e: the frozen graph names test-only members (Azure SDKs among them)
    // whose go.mod files a probe host has no reason to hold; their versions
    // are still the ones the frozen pins resolve to, so they are listed
    // rather than silently dropped — and nothing is fetched to do it.
    [
      "go",
      "list",
      "-m",
      "-e",
      "-f",
      "{{.Path}} {{if .Version}}{{.Version}}{{else}}(main){{end}} {{.Indirect}}",
      "all",
    ],
    runtimeGoDir(),
  );
  if (modules.code !== 0) throw new Error(`go list -m failed: ${modules.text.trim()}`);
  return {
    commit: commit.text.trim(),
    goVersion: goVersion.text.trim(),
    modules: modules.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [path, version, indirect] = line.trim().split(/\s+/);
        return { path, version, indirect: indirect === "true" };
      }),
  };
}

async function rssBytesOf(pid: number): Promise<number> {
  const result = await runTool(["ps", "-o", "rss=", "-p", String(pid)]);
  const kb = Number(result.text.trim());
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : 0;
}

function writeReport(report: CompatibilityReport): string {
  const path = join(runtimeGoDir(), "testdata", "compatibility-report.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

async function runProbe(): Promise<number> {
  const checks: CompatibilityReport["checks"] = {
    identity: false,
    stream: false,
    callback: false,
    cancel: false,
    restart: false,
  };
  const measurements = { rssBytes: 0, firstEventMs: 0 };
  const model = startFakeModel();
  const validation = startValidationPlane();
  const callbackPlane = startCallbackPlane();
  const started: Candidate[] = [];
  try {
    const environment = await gatherEnvironment();
    const binary = await buildCandidate();
    const candidate = await startCandidate({
      binary,
      serviceCredential: SERVICE_CREDENTIAL,
      modelBaseUrl: model.url,
      validationEndpoint: validation.validationEndpoint,
      callbackEndpoint: callbackPlane.callbackEndpoint,
      agentToken: callbackPlane.token,
    });
    started.push(candidate);
    const base = candidate.baseUrl;
    const headers = (minted: { assertion: string; token: string }) =>
      candidateHeaders({
        serviceCredential: SERVICE_CREDENTIAL,
        agentToken: minted.token,
        assertion: minted.assertion,
      });

    // -- identity: refusals in front of the framework, and nothing reaching the provider.
    const streamCreds = validation.mint("run_stream", "thread_stream");
    const runStreamInput = runInput({
      runId: "run_stream",
      threadId: "thread_stream",
      text: PROBE_STREAM_TEXT,
    });
    const noCredential = await fetch(`${base}/agui/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runStreamInput),
    });
    const forgedAssertion = await fetch(`${base}/agui/`, {
      method: "POST",
      headers: candidateHeaders({
        serviceCredential: SERVICE_CREDENTIAL,
        agentToken: streamCreds.token,
        assertion: "forged-assertion-signed-by-nobody",
      }),
      body: JSON.stringify(runStreamInput),
    });
    checks.identity =
      noCredential.status === 401 &&
      forgedAssertion.status === 401 &&
      model.requests.length === 0;
    if (!checks.identity)
      throw new Error(
        `identity refusals did not hold: no-credential=${noCredential.status}, forged=${forgedAssertion.status}, provider requests=${model.requests.length}`,
      );

    // -- stream: one real run through @ag-ui/client against the real endpoint.
    const streamT0 = performance.now();
    let firstEventAt = 0;
    const streamEvents = await withTimeout(
      collectEvents(httpAgentFor(base, headers(streamCreds)), runStreamInput, {
        onFirstEvent: () => {
          firstEventAt = performance.now() - streamT0;
        },
      }),
      20_000,
      "the stream check run",
    );
    measurements.firstEventMs = Math.round(firstEventAt);
    checks.stream =
      satisfiesEventContract(streamEvents) &&
      textOf(streamEvents) === "probe-stream-ok" &&
      (streamEvents[0] as { threadId?: string }).threadId === "thread_stream" &&
      (streamEvents[0] as { runId?: string }).runId === "run_stream";
    if (!checks.stream)
      throw new Error(
        `the candidate's stream did not satisfy the contract: ${streamEvents.map((e) => e.type).join(",")}`,
      );
    measurements.rssBytes = await rssBytesOf(candidate.pid);

    // -- callback: a governed tool call crosses the existing plane and the model sees the answer.
    const callbackCreds = validation.mint("run_callback", "thread_callback");
    const callbackEvents = await withTimeout(
      collectEvents(
        httpAgentFor(base, headers(callbackCreds)),
        runInput({
          runId: "run_callback",
          threadId: "thread_callback",
          text: PROBE_TOOL_TEXT,
        }),
      ),
      20_000,
      "the callback check run",
    );
    const crossed = callbackPlane.captured;
    checks.callback =
      crossed.length === 1 &&
      crossed[0].name === CANDIDATE_TOOL_NAME &&
      crossed[0].botId === BOT &&
      crossed[0].actorId === ACTOR &&
      callbackEvents.some((e) => e.type === "TOOL_CALL_START") &&
      satisfiesEventContract(callbackEvents) &&
      textOf(callbackEvents) === "callback-observed";
    if (!checks.callback)
      throw new Error(
        `the governed tool call did not cross the plane cleanly: captured=${JSON.stringify(
          crossed.map((c) => ({ name: c.name, botId: c.botId, actorId: c.actorId })),
        )}, events=${callbackEvents.map((e) => e.type).join(",")}`,
      );

    // -- cancel: the owner's cancel is acknowledged and the slow run actually stops.
    const cancelCreds = validation.mint("run_cancel", "thread_cancel");
    const cancelRunInput = runInput({
      runId: "run_cancel",
      threadId: "thread_cancel",
      text: PROBE_SLOW_TEXT,
    });
    const cancelRun = collectEvents(httpAgentFor(base, headers(cancelCreds)), cancelRunInput);
    await model.waitFor(() => model.requests.some((r) => r.userText.includes(PROBE_SLOW_TEXT)));
    const cancelResponse = await fetch(`${base}/cancel`, {
      method: "POST",
      headers: headers(cancelCreds),
      body: JSON.stringify({ runId: "run_cancel", threadId: "thread_cancel" }),
    });
    const cancelBody = (await cancelResponse.json().catch(() => ({}))) as { status?: string };
    await withTimeout(
      cancelRun.then(
        () => true,
        () => true,
      ),
      8_000,
      "the cancelled run kept streaming",
    );
    checks.cancel =
      cancelResponse.status === 200 && cancelBody.status === "cancel_requested";
    if (!checks.cancel)
      throw new Error(
        `cancel did not behave: status=${cancelResponse.status}, body=${JSON.stringify(cancelBody)}`,
      );

    // -- restart: a restarted candidate admits it no longer holds the old run.
    const restartCreds = validation.mint("run_restart", "thread_restart");
    const restartAgent = httpAgentFor(base, headers(restartCreds));
    const restartRun = collectEvents(
      restartAgent,
      runInput({
        runId: "run_restart",
        threadId: "thread_restart",
        text: PROBE_SLOW_TEXT,
      }),
    );
    await model.waitFor(
      () => model.requests.filter((r) => r.userText.includes(PROBE_SLOW_TEXT)).length >= 2,
    );
    // Retire this consumer's connection BEFORE the kill, so the child's death
    // cannot leave the client library holding a reset socket nobody catches.
    restartAgent.abortRun();
    await restartRun.then(
      () => {},
      () => {},
    );
    await candidate.kill();
    const restarted = await startCandidate({
      binary,
      serviceCredential: SERVICE_CREDENTIAL,
      modelBaseUrl: model.url,
      validationEndpoint: validation.validationEndpoint,
      callbackEndpoint: callbackPlane.callbackEndpoint,
      agentToken: callbackPlane.token,
    });
    started.push(restarted);
    const oldRunCancel = await fetch(`${restarted.baseUrl}/cancel`, {
      method: "POST",
      headers: headers(restartCreds),
      body: JSON.stringify({ runId: "run_restart", threadId: "thread_restart" }),
    });
    checks.restart = oldRunCancel.status === 404;
    if (!checks.restart)
      throw new Error(
        `a restarted candidate answered the old run's cancel with ${oldRunCancel.status}`,
      );

    const adoption: CompatibilityReport["adoption"] = Object.values(checks).every(Boolean)
      ? "candidate"
      : "rejected";
    const report: CompatibilityReport = { ...environment, checks, measurements, adoption };
    const path = writeReport(report);
    console.log(`[probe] all checks passed; report written to ${path}`);
    console.log(
      `[probe] measurements: rssBytes=${measurements.rssBytes} firstEventMs=${measurements.firstEventMs}`,
    );
    return 0;
  } catch (error) {
    try {
      const environment = await gatherEnvironment().catch(() => ({
        commit: "unknown",
        goVersion: "unknown",
        modules: [] as CompatibilityReport["modules"],
      }));
      const path = writeReport({
        ...environment,
        checks,
        measurements,
        adoption: "rejected",
      });
      console.error(`[probe] FAILED: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[probe] report written to ${path} with adoption "rejected"`);
    } catch (reportError) {
      console.error(`[probe] FAILED and the report could not be written: ${String(reportError)}`);
      console.error(
        `[probe] original failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return 1;
  } finally {
    for (const candidate of started) await candidate.kill();
    model.server.stop(true);
    validation.server.stop(true);
    callbackPlane.server.stop(true);
  }
}

if (import.meta.main) {
  process.exitCode = await runProbe();
}
