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
 * openbot/runtime-go with the repository's runtime-go directory.
 *
 * R2-B has since assembled the REAL main (runtime-go/cmd/runtime): strict
 * configuration, the fixed expert catalog, the run gate and the enterprise
 * execution/cancel routes. Pointing THIS probe at that real binary (with its
 * flag/env surface: -addr, -validation-endpoint, -model-base-url,
 * -model-alias, -expert version=path, -governed-tools, -callback-endpoint
 * plus the OPENBOT_RUNTIME_* environment secrets) is the R4-A "真二进制" step;
 * until then the launcher below remains the probe's controlled composition,
 * and no result here claims the real binary ran.
 *
 * Run from the repository root: `bun server/scripts/enterprise-runtime-probe.ts`
 * Exit code: 0 only when every check the probe EXECUTED passed and the report
 * was written; any FAILED check exits non-zero. A check with no executable
 * harness in this probe is recorded as "not_run" — it does not fail the run,
 * but it BLOCKS the G1a gate in the report (master plan §6: gates register
 * not_run/passed/failed/blocked, and nothing passes before it actually ran).
 * There is deliberately no single adoption conclusion in the report.
 *
 * Every child process below is spawned with an explicit argv array and no
 * shell: nothing that crosses a trust boundary (a URL, a credential, a pid)
 * is ever interpolated into a command string.
 */
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { HttpAgent } from "@ag-ui/client";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  createFakeToolInvocationPlane,
  type ToolCapabilityBinding,
} from "../src/enterprise/runtime/tool-invocations";
import {
  createRuntimeInvocationValidationRoutes,
  type InvocationValidationDeps,
  type InvocationVerifyOutcome,
  type RuntimeInvocation,
} from "../src/enterprise/runtime/validation-routes";

/** The repository root, resolved from this file so the cwd cannot steer it. */
export const repoRoot = (): string => resolve(import.meta.dir, "../..");

export const runtimeGoDir = (): string => join(repoRoot(), "runtime-go");

/** Runs one external tool with an explicit argv (no shell, no string commands). */
async function runTool(
  argv: string[],
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

/**
 * Every external command this probe run spawned, with the exit code each
 * invocation returned. This journal IS the report's `commands` field: what
 * ran, labelled by static purpose strings, never a pre-typed transcript.
 */
const commandJournal: Array<{ argv: string[]; exitCode: number; purpose: string }> = [];

/**
 * runTool, journalled: every probe-spawned command lands in the report with
 * its argv and its exit code (the report's `commands`/`exit_codes` sections
 * are read straight out of this journal).
 */
async function probeTool(
  argv: string[],
  purpose: string,
  cwd?: string,
): Promise<{ code: number; text: string }> {
  const result = await runTool(argv, cwd);
  commandJournal.push({ argv: [...argv], exitCode: result.code, purpose });
  return result;
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

// governedToolName and its PINNED installation match what the probe's fake
// tool plane authorizes.
const (
	governedToolName = "probe_governed"
	governedVersion  = "probe_governed@1.0.0"
)

func main() {
	var (
		addr         = flag.String("addr", "127.0.0.1:0", "listen address")
		modelBaseURL = flag.String("model-base-url", "", "OpenAI-compatible provider base URL (the probe's fake)")
		modelAlias   = flag.String("model-alias", "probe-model", "model alias sent to the provider")
		validationEP = flag.String("validation-endpoint", "", "TS validation endpoint URL")
		callbackEP   = flag.String("callback-endpoint", "", "internal tool-invocations plane address")
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

	// The one governed tool this candidate exposes: it PROPOSES and SPENDS
	// on the TS tool plane, never inline. No other egress exists in this
	// composition; the credentials each call presents are the verified
	// run's own, from the private context.
	var tools []tool.Tool
	if *callbackEP != "" {
		plane := &callback.Client{
			HTTP:     &http.Client{Timeout: 10 * time.Second},
			Endpoint: *callbackEP,
		}
		tools = append(tools, adapter.GovernedTool(plane, governedToolName, governedVersion,
			"Platform-governed probe tool; proposes and executes on the TS plane.", nil))
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
	// The execution registry: which verified tuple is executing under which
	// fencing. Process-local; the cancel boundary resolves executions by the
	// full verified tuple and verifies the executing fencing (R3-B③).
	executions := server.NewExecutionRegistry()
	mux := http.NewServeMux()
	mux.Handle("/health/", server.Health(func() bool { return authCfg.Ready() }))
	mux.Handle("/agui/", http.StripPrefix("/agui", auth(executions.TrackExecutions(server.RequireVerifiedInput()(handler)))))
	mux.Handle("/cancel", auth(server.Cancel(canceler, executions)))

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
  const tidy = await probeTool(["go", "mod", "tidy"], "candidate build: resolve the launcher module offline", dir);
  if (tidy.code !== 0)
    throw new Error(`tidying the launcher module failed:\n${tidy.text.trim()}`);
  const build = await probeTool(["go", "build", "-o", "candidate", "."], "candidate build: compile the real Go candidate binary", dir);
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
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
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
const PRINCIPAL = "principal_probe";
const ACTOR = "actor_probe";

/**
 * The frozen canonical input digest (01 plan R2-B: 摘要基于双方冻结的规范
 * 序列化): SHA-256 hex over the compact JSON array of {"content":…,"role":…}
 * pairs in message order — the exact serialization runtime-go's
 * internal/trustedinput computes, so TS signs and Go re-checks the same
 * bytes.
 */
export function canonicalInputDigest(
  messages: Array<{ role: string; content: string }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map(({ content, role }) => ({ content, role }))))
    .digest("hex");
}

/** How long a minted test capability stays valid. */
const CAPABILITY_TTL_MS = 10 * 60_000;

/**
 * The enterprise identity oracle the Go middleware calls, on the v0.2 wire:
 * createRuntimeInvocationValidationRoutes with a verify that models what the
 * production host enforces — the runtime service credential, the short-term
 * capability (audience: this runtime, bound to one invocation's digest and
 * coordinates, expiring), and the CURRENT lease per run, the way the
 * authoritative ledger would answer.
 */
export function startValidationPlane(
  serviceCredential = "probe-service-credential-not-a-real-one",
) {
  type Capability = {
    expiresAt: number;
    bound: Pick<RuntimeInvocation, "run_id" | "attempt_id" | "turn_id" | "input_digest">;
  };
  const capabilities = new Map<string, Capability>();
  /**
   * The SAME capability registry the fake tool plane authenticates against:
   * one minted capability vouches for one run on both planes, exactly as
   * the production planes would resolve it.
   */
  const toolCapabilities = new Map<string, ToolCapabilityBinding>();
  /** The current lease per business run, as the ledger would hold it. */
  const currentLeases = new Map<string, string>();

  const verify: InvocationValidationDeps["verify"] = async (input): Promise<InvocationVerifyOutcome> => {
    if (input.serviceCredential !== serviceCredential) return { status: "invalid_credential" };
    const capability = capabilities.get(input.capability);
    if (!capability || capability.expiresAt < Date.now()) {
      return { status: "invalid_credential" };
    }
    const { bound } = capability;
    if (
      bound.run_id !== input.invocation.run_id ||
      bound.attempt_id !== input.invocation.attempt_id ||
      bound.turn_id !== input.invocation.turn_id ||
      bound.input_digest !== input.invocation.input_digest
    ) {
      return { status: "binding_mismatch" };
    }
    // The current-lease check: an expired or superseded lease is a binding
    // refusal even when the capability itself is perfectly valid.
    if (currentLeases.get(input.invocation.run_id) !== input.invocation.lease_id) {
      return { status: "binding_mismatch" };
    }
    return { status: "ok" };
  };

  const server = Bun.serve({
    port: 0,
    fetch: createRuntimeInvocationValidationRoutes({ verify }).fetch,
  });

  /** Mints the enterprise credential pair plus the legacy callback pair. */
  const mint = (runId: string, threadId: string, text: string) => {
    const invocation: RuntimeInvocation = {
      schema_version: "1",
      tenant_id: TENANT,
      principal_id: PRINCIPAL,
      actor_id: ACTOR,
      initiator_kind: "user",
      run_id: runId,
      attempt_id: `${runId}_attempt_1`,
      turn_id: runId,
      thread_id: threadId,
      expert_version: "probe-expert@1.0.0",
      input_digest: canonicalInputDigest([{ role: "user", content: text }]),
      model_route_ref: "probe-route@1",
      budget_reservation_id: `${runId}_budget`,
      lease_id: `${runId}_lease_1`,
      fencing_token: `${runId}_fencing_1`,
      expires_at: new Date(Date.now() + CAPABILITY_TTL_MS).toISOString(),
    };
    const capability = `cap_${randomUUID()}`;
    capabilities.set(capability, {
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
      bound: {
        run_id: invocation.run_id,
        attempt_id: invocation.attempt_id,
        turn_id: invocation.turn_id,
        input_digest: invocation.input_digest,
      },
    });
    toolCapabilities.set(capability, {
      tenant_id: TENANT,
      principal_id: PRINCIPAL,
      run_id: invocation.run_id,
      attempt_id: invocation.attempt_id,
      fencing_token: invocation.fencing_token,
      expires_at: Date.now() + CAPABILITY_TTL_MS,
    });
    currentLeases.set(runId, invocation.lease_id);
    return {
      capability,
      invocation: JSON.stringify(invocation),
    };
  }

  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    validationEndpoint: `http://${server.hostname}:${server.port}/internal/enterprise/v1/runtime/validate`,
    toolCapabilities,
    mint,
  };
}

/**
 * The enterprise tool plane for the probe: the G1a fake tool-invocation
 * endpoints, sharing the validation plane's capability registry (one minted
 * capability vouches for one run on both planes). The recheck boundary is
 * a recording pass-through: the probe observes it ran, it authorizes
 * nothing real.
 */
export function startToolPlane(validation: ReturnType<typeof startValidationPlane>) {
  const plane = createFakeToolInvocationPlane({
    serviceCredential: "probe-service-credential-not-a-real-one",
    capabilities: validation.toolCapabilities,
    recheck: () => ({ ok: true }),
  });
  const server = Bun.serve({ port: 0, fetch: plane.routes.fetch });
  return {
    server,
    toolPlaneEndpoint: `http://${server.hostname}:${server.port}/internal/enterprise/v1/tool-invocations`,
    state: plane.state,
  };
}

// ---------------------------------------------------------------------------
// HTTP talking to the candidate.
// ---------------------------------------------------------------------------

export function candidateHeaders(credentials: {
  serviceCredential: string;
  /** The enterprise pair: short-term capability + strict invocation envelope. */
  capability: string;
  invocation: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-openbot-runtime-service-credential": credentials.serviceCredential,
    "x-openbot-runtime-capability": credentials.capability,
    "x-openbot-runtime-invocation": credentials.invocation,
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

/**
 * The R4 report contract (01 plan R4 + master plan §6): every gate registers
 * one of not_run/passed/failed/blocked with evidence refs — there is no
 * single adoption boolean anywhere — and the artifact carries the plan's
 * field list: commit, workspace_digest, document_baseline, go_version,
 * dependency_graph_digest, sdk_versions, environment, commands, exit_codes,
 * evidence_refs, limitations.
 */
export type CheckStatus = "passed" | "failed" | "not_run";
export type GateStatus = "not_run" | "passed" | "failed" | "blocked";

export type CheckOutcome = { status: CheckStatus; evidence: string };
export type GateOutcome = { status: GateStatus; evidence: string[] };

/** The nine check categories the 01 plan R4 contract names, in plan order. */
export const R4_CHECK_NAMES = [
  "identity",
  "trusted_input",
  "text",
  "tool",
  "wait",
  "error",
  "cancel",
  "backpressure",
  "restart",
] as const;
export type R4CheckName = (typeof R4_CHECK_NAMES)[number];
export type R4Checks = Record<R4CheckName, CheckOutcome>;

export type CompatibilityReport = {
  commit: string;
  go_version: string;
  workspace_digest: { dirty: boolean; summary: string[] };
  document_baseline: Record<string, string>;
  dependency_graph_digest: {
    goModSha256: string;
    goSumSha256: string;
    goSumLines: number;
    moduleCount: number;
  };
  sdk_versions: Record<string, string>;
  environment: Record<string, string>;
  commands: Array<{ argv: string[]; exitCode: number; purpose: string }>;
  exit_codes: { probe: number };
  evidence_refs: string[];
  limitations: string[];
  modules: Array<{ path: string; version: string; indirect: boolean }>;
  checks: R4Checks;
  gates: { G1a: GateOutcome; G1b: GateOutcome; G2: GateOutcome };
  measurements: {
    rssBytes: number;
    firstEventMs: number;
    cancelLagMs: number;
    streamDurationMs: number;
  };
  /** Who must sign each gate (master plan §6 sign-off table); a probe signs nothing. */
  reviewers: Record<string, { required: string[]; signed: string[] }>;
};

const SERVICE_CREDENTIAL = "probe-service-credential-not-a-real-one";

/** The governing documents and code this report answers to, hashed. */
const BASELINE_FILES = [
  "docs/superpowers/plans/2026-10-09-enterprise-ai-00-master.md",
  "docs/superpowers/plans/2026-10-09-enterprise-ai-01-runtime.md",
  "server/scripts/enterprise-runtime-probe.ts",
];

const sha256Of = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every .go file under runtime-go, walked deterministically. */
function goSourcesOf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...goSourcesOf(path));
    else if (entry.name.endsWith(".go")) out.push(path);
  }
  return out;
}

/** The direct (non-indirect) requires of runtime-go/go.mod, as path -> version. */
export function directGoDependencies(): Record<string, string> {
  const goMod = readFileSync(join(runtimeGoDir(), "go.mod"), "utf8");
  const deps: Record<string, string> = {};
  for (const match of goMod.matchAll(/^\t(\S+)\s+(v\S+)$/gm)) {
    deps[match[1]] = match[2];
  }
  return deps;
}

async function gatherEnvironment(): Promise<{
  commit: string;
  go_version: string;
  workspace_digest: CompatibilityReport["workspace_digest"];
  document_baseline: CompatibilityReport["document_baseline"];
  dependency_graph_digest: CompatibilityReport["dependency_graph_digest"];
  sdk_versions: CompatibilityReport["sdk_versions"];
  environment: CompatibilityReport["environment"];
  modules: CompatibilityReport["modules"];
}> {
  const commit = await probeTool(
    ["git", "rev-parse", "HEAD"],
    "environment: which commit the candidate is probed at",
    repoRoot(),
  );
  if (commit.code !== 0) throw new Error(`git rev-parse failed: ${commit.text.trim()}`);
  const status = await probeTool(
    ["git", "status", "--porcelain"],
    "environment: workspace difference summary (master §6 工作区差异摘要)",
    repoRoot(),
  );
  const porcelain = status.code === 0 ? status.text.trim().split("\n").filter(Boolean) : [];
  const goVersion = await probeTool(["go", "version"], "environment: toolchain version");
  if (goVersion.code !== 0) throw new Error(`go version failed: ${goVersion.text.trim()}`);
  const modules = await probeTool(
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
    "environment: the frozen module graph (go list -m all)",
    runtimeGoDir(),
  );
  if (modules.code !== 0) throw new Error(`go list -m failed: ${modules.text.trim()}`);

  const moduleList = modules.text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [path, version, indirect] = line.trim().split(/\s+/);
      return { path, version, indirect: indirect === "true" };
    });

  const goModPath = join(runtimeGoDir(), "go.mod");
  const goSumPath = join(runtimeGoDir(), "go.sum");
  const serverPackage = JSON.parse(
    readFileSync(join(repoRoot(), "server", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };

  const document_baseline: Record<string, string> = {};
  for (const file of BASELINE_FILES) {
    document_baseline[file] = sha256Of(join(repoRoot(), file));
  }
  for (const absolute of goSourcesOf(runtimeGoDir())) {
    document_baseline[relative(repoRoot(), absolute)] = sha256Of(absolute);
  }

  return {
    commit: commit.text.trim(),
    go_version: goVersion.text.trim(),
    workspace_digest: {
      dirty: porcelain.length > 0,
      summary: porcelain.slice(0, 100),
    },
    document_baseline,
    dependency_graph_digest: {
      goModSha256: sha256Of(goModPath),
      goSumSha256: sha256Of(goSumPath),
      goSumLines: readFileSync(goSumPath, "utf8").trim().split("\n").length,
      moduleCount: moduleList.length,
    },
    sdk_versions: {
      "@ag-ui/client": serverPackage.dependencies["@ag-ui/client"] ?? "unknown",
      ...directGoDependencies(),
    },
    environment: {
      platform: `${process.platform}/${process.arch}`,
      bun: Bun.version,
      network:
        "every spawned Go command runs with GOPROXY=off (module cache only); the probe talks to localhost fakes and nothing else",
    },
    modules: moduleList,
  };
}

async function rssBytesOf(pid: number): Promise<number> {
  const result = await probeTool(
    ["ps", "-o", "rss=", "-p", String(pid)],
    "measurement: resident set size of the candidate process",
  );
  const kb = Number(result.text.trim());
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : 0;
}

function writeReport(report: CompatibilityReport): string {
  const path = join(runtimeGoDir(), "testdata", "compatibility-report.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/** Why the two not_run check categories have no executable harness here. */
export const WAIT_NOT_RUN_EVIDENCE =
  "no input-required/wait protocol seam exists in this candidate yet (01 plan R4-A 等待输入/审批 row: the mapping must follow the locked protocol's verified fields, which this runtime does not expose yet)";
export const BACKPRESSURE_NOT_RUN_EVIDENCE =
  "no slow-consumer/bounded-queue harness is exercised against the candidate yet (01 plan R4-A 慢消费者 row)";

const LIMITATIONS = [
  `check 'wait' is not_run: ${WAIT_NOT_RUN_EVIDENCE}`,
  `check 'backpressure' is not_run: ${BACKPRESSURE_NOT_RUN_EVIDENCE}`,
  "load measurements are partial (rssBytes, firstEventMs, cancelLagMs, streamDurationMs on one localhost fake provider); the full R4 load set (active connections/runs, model concurrency, queue bounds, payload sizes, hardware/image) and pre-approved thresholds are outstanding — measurements alone cannot pass a capacity gate",
  "G1b/G2 evidence sets (T1–T3/E1–E4/P2–P4/D2/D4, D5/business acceptance, and the dependency risk closure in runtime-go/dependency-review.json) are not produced by this probe",
];

const EVIDENCE_REFS = [
  "runtime-go/testdata/compatibility-report.json (this artifact, written only by the probe)",
  "server/scripts/enterprise-runtime-probe.ts (the probe that wrote it)",
  "server/tests/enterprise/runtime-contract.test.ts (TS HttpAgent over the same candidate)",
  "server/tests/enterprise/runtime-artifacts.test.ts (asserts this artifact's R4 shape)",
  "runtime-go/internal/adapter/agui_test.go (Go-side semantics, incl. RUN_ERROR and leak refusal)",
  "runtime-go/internal/server/auth_test.go (identity and run-binding refusals)",
  "runtime-go/dependency-review.json (the dependency risk record the G1b gate must close)",
];

/** Master plan §6 sign-off table; the probe itself signs nothing. */
const REVIEWERS: CompatibilityReport["reviewers"] = {
  G1a: { required: ["技术", "运行", "QA"], signed: [] },
  G1b: { required: ["安全", "运行", "SRE", "技术"], signed: [] },
  G2: { required: ["产品", "业务", "技术", "安全", "SRE"], signed: [] },
};

function initialChecks(): R4Checks {
  return {
    identity: { status: "not_run", evidence: "not reached before the probe ended" },
    trusted_input: { status: "not_run", evidence: "not reached before the probe ended" },
    text: { status: "not_run", evidence: "not reached before the probe ended" },
    tool: { status: "not_run", evidence: "not reached before the probe ended" },
    wait: { status: "not_run", evidence: WAIT_NOT_RUN_EVIDENCE },
    error: { status: "not_run", evidence: "not reached before the probe ended" },
    cancel: { status: "not_run", evidence: "not reached before the probe ended" },
    backpressure: { status: "not_run", evidence: BACKPRESSURE_NOT_RUN_EVIDENCE },
    restart: { status: "not_run", evidence: "not reached before the probe ended" },
  };
}

/**
 * Gate registration from the check outcomes, per master plan §6: failed checks
 * fail G1a; checks that could not run BLOCK it (nothing passes before it
 * actually ran); G1b/G2 evidence is not produced by this probe, so they stay
 * not_run — this book never auto-passes them.
 */
function deriveGates(
  checks: R4Checks,
  failure?: string,
): CompatibilityReport["gates"] {
  const failed = R4_CHECK_NAMES.filter((name) => checks[name].status === "failed");
  const notRun = R4_CHECK_NAMES.filter((name) => checks[name].status === "not_run");
  const g1a: GateOutcome =
    failed.length > 0 || failure !== undefined
      ? {
          status: "failed",
          evidence: [
            ...(failed.length > 0 ? [`failed checks: ${failed.join(", ")}`] : []),
            ...(failure
              ? [`the probe run itself failed before completing every check: ${failure}`]
              : []),
            "runtime-go/testdata/compatibility-report.json#checks",
          ],
        }
      : notRun.length > 0
        ? {
            status: "blocked",
            evidence: [
              `blocked by check categories with no executable harness yet: ${notRun.join(", ")}`,
              "G1a can only be reviewed as passed once every R4 check category actually ran (master §6: 所有项只有实际执行后才填pass/fail)",
              "runtime-go/testdata/compatibility-report.json#checks",
            ],
          }
        : {
            status: "passed",
            evidence: [
              "all nine R4 check categories ran and passed",
              "measurements recorded in this artifact (no capacity threshold is approved by a probe)",
              "server/tests/enterprise/runtime-contract.test.ts",
              "runtime-go/internal/adapter/agui_test.go",
            ],
          };
  return {
    G1a: g1a,
    G1b: {
      status: "not_run",
      evidence: [
        "G1b evidence (T1–T3, E1–E4, P2–P4, D2/D4, and current dependency risk closure) is not produced by this probe",
        "runtime-go/dependency-review.json (open reachable-vulnerability record the gate must answer)",
      ],
    },
    G2: {
      status: "not_run",
      evidence: [
        "G2 depends on G1b plus D5/business acceptance with capacity and recovery evidence; nothing in this probe executed it",
      ],
    },
  };
}

function fallbackEnvironment(): Awaited<ReturnType<typeof gatherEnvironment>> {
  return {
    commit: "unknown",
    go_version: "unknown",
    workspace_digest: { dirty: true, summary: [] },
    document_baseline: {},
    dependency_graph_digest: { goModSha256: "", goSumSha256: "", goSumLines: 0, moduleCount: 0 },
    sdk_versions: {},
    environment: {},
    modules: [],
  };
}

async function runProbe(): Promise<number> {
  const checks = initialChecks();
  const measurements: CompatibilityReport["measurements"] = {
    rssBytes: 0,
    firstEventMs: 0,
    cancelLagMs: 0,
    streamDurationMs: 0,
  };
  const model = startFakeModel();
  const validation = startValidationPlane();
  const toolPlane = startToolPlane(validation);
  const started: Candidate[] = [];
  try {
    const environment = await gatherEnvironment();
    const binary = await buildCandidate();
    const candidate = await startCandidate({
      binary,
      serviceCredential: SERVICE_CREDENTIAL,
      modelBaseUrl: model.url,
      validationEndpoint: validation.validationEndpoint,
      callbackEndpoint: toolPlane.toolPlaneEndpoint,
    });
    started.push(candidate);
    const base = candidate.baseUrl;
    const headers = (minted: { capability: string; invocation: string }) =>
      candidateHeaders({
        serviceCredential: SERVICE_CREDENTIAL,
        capability: minted.capability,
        invocation: minted.invocation,
      });

    // -- identity: refusals in front of the framework, and nothing reaching the provider.
    const streamCreds = validation.mint("run_stream", "thread_stream", PROBE_STREAM_TEXT);
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
        capability: "forged-capability-signed-by-nobody",
        invocation: streamCreds.invocation,
      }),
      body: JSON.stringify(runStreamInput),
    });
    const identityOk =
      noCredential.status === 401 &&
      forgedAssertion.status === 401 &&
      model.requests.length === 0;
    checks.identity = {
      status: identityOk ? "passed" : "failed",
      evidence: `no-credential request -> ${noCredential.status}, forged capability -> ${forgedAssertion.status} (both want 401); provider requests during the refusals: ${model.requests.length} (want 0)`,
    };
    if (!identityOk)
      throw new Error(
        `identity refusals did not hold: no-credential=${noCredential.status}, forged=${forgedAssertion.status}, provider requests=${model.requests.length}`,
      );

    // -- trusted input: valid credentials vouch for ONE run; a body claiming
    //    somebody else's run must be refused before the framework spends anything.
    const bindingCreds = validation.mint("run_binding", "thread_binding", PROBE_STREAM_TEXT);
    const mismatchedBinding = await fetch(`${base}/agui/`, {
      method: "POST",
      headers: headers(bindingCreds),
      body: JSON.stringify(
        runInput({
          runId: "run_somebody_elses",
          threadId: "thread_somebody_elses",
          text: PROBE_STREAM_TEXT,
        }),
      ),
    });
    const trustedInputOk = mismatchedBinding.status === 403 && model.requests.length === 0;
    checks.trusted_input = {
      status: trustedInputOk ? "passed" : "failed",
      evidence: `a valid assertion minted for run_binding/thread_binding presented against a body claiming run_somebody_elses -> ${mismatchedBinding.status} (want 403, identity bound to a different run); provider requests so far: ${model.requests.length} (want 0)`,
    };
    if (!trustedInputOk)
      throw new Error(
        `a run binding mismatch was not refused: status=${mismatchedBinding.status}, provider requests=${model.requests.length}`,
      );

    // -- text: one real run through @ag-ui/client against the real endpoint.
    const streamT0 = performance.now();
    let firstEventAt = 0;
    const streamEvents = await withTimeout(
      collectEvents(httpAgentFor(base, headers(streamCreds)), runStreamInput, {
        onFirstEvent: () => {
          firstEventAt = performance.now() - streamT0;
        },
      }),
      20_000,
      "the text check run",
    );
    measurements.firstEventMs = Math.round(firstEventAt);
    measurements.streamDurationMs = Math.round(performance.now() - streamT0);
    const textOk =
      satisfiesEventContract(streamEvents) &&
      textOf(streamEvents) === "probe-stream-ok" &&
      (streamEvents[0] as { threadId?: string }).threadId === "thread_stream" &&
      (streamEvents[0] as { runId?: string }).runId === "run_stream";
    checks.text = {
      status: textOk ? "passed" : "failed",
      evidence: `events=${streamEvents.map((e) => e.type).join(",")}; joined text=${JSON.stringify(
        textOf(streamEvents),
      )}; first event echoed threadId=thread_stream runId=run_stream`,
    };
    if (!textOk)
      throw new Error(
        `the candidate's stream did not satisfy the contract: ${streamEvents.map((e) => e.type).join(",")}`,
      );
    measurements.rssBytes = await rssBytesOf(candidate.pid);

    // -- tool: a governed tool call proposes, spends and the model reads the receipt's answer.
    const callbackCreds = validation.mint("run_callback", "thread_callback", PROBE_TOOL_TEXT);
    const callbackEvents = await withTimeout(
      collectEvents(
        httpAgentFor(
          base,
          candidateHeaders({
            serviceCredential: SERVICE_CREDENTIAL,
            capability: callbackCreds.capability,
            invocation: callbackCreds.invocation,
          }),
        ),
        runInput({
          runId: "run_callback",
          threadId: "thread_callback",
          text: PROBE_TOOL_TEXT,
        }),
      ),
      20_000,
      "the tool check run",
    );
    const operations = toolPlane.state.operations;
    const receipts = toolPlane.state.receipts;
    const toolOk =
      operations.length === 1 &&
      operations[0].tool_name === CANDIDATE_TOOL_NAME &&
      operations[0].tenant_id === TENANT &&
      operations[0].run_id === "run_callback" &&
      receipts.length === 1 &&
      receipts[0].status === "succeeded" &&
      toolPlane.state.effects === 1 &&
      callbackEvents.some((e) => e.type === "TOOL_CALL_START") &&
      satisfiesEventContract(callbackEvents) &&
      textOf(callbackEvents) === "callback-observed";
    checks.tool = {
      status: toolOk ? "passed" : "failed",
      evidence: `prepare/execute crossings on the fake tool plane: 1 operation (${operations
        .map((o) => `${o.tool_name} on ${o.run_id}`)
        .join(",")}), 1 receipt (${receipts.map((r) => r.status).join(",")}), effects=${toolPlane.state.effects}; run carried TOOL_CALL_START and finished with text ${JSON.stringify(
        textOf(callbackEvents),
      )}`,
    };
    if (!toolOk)
      throw new Error(
        `the governed tool call did not cross the tool plane cleanly: operations=${JSON.stringify(
          operations.map((o) => ({ tool: o.tool_name, run: o.run_id, status: o.status })),
        )}, receipts=${JSON.stringify(receipts.map((r) => r.status))}, events=${callbackEvents
          .map((e) => e.type)
          .join(",")}`,
      );

    // -- wait: registered not_run (see WAIT_NOT_RUN_EVIDENCE); nothing is
    //    pretend-executed here, and it blocks G1a until a real seam exists.

    // -- error: a failing provider ends the run in RUN_ERROR without leaking
    //    the provider's internal error body to the consumer.
    const errorCreds = validation.mint("run_error", "thread_error", PROBE_FAIL_TEXT);
    const errorEvents = await withTimeout(
      collectEvents(
        httpAgentFor(base, headers(errorCreds)),
        runInput({
          runId: "run_error",
          threadId: "thread_error",
          text: PROBE_FAIL_TEXT,
        }),
      ),
      20_000,
      "the error check run",
    );
    const errorOk =
      satisfiesEventContract(errorEvents) &&
      errorEvents[errorEvents.length - 1]?.type === "RUN_ERROR" &&
      !JSON.stringify(errorEvents).includes("leak-bait-secret-detail");
    checks.error = {
      status: errorOk ? "passed" : "failed",
      evidence: `provider 500 -> events=${errorEvents
        .map((e) => e.type)
        .join(",")} (terminal RUN_ERROR required); provider's error body 'leak-bait-secret-detail' present in events: ${JSON.stringify(
        errorEvents,
      ).includes("leak-bait-secret-detail")} (want false)`,
    };
    if (!errorOk)
      throw new Error(
        `a failing provider did not end as a clean RUN_ERROR run: ${errorEvents.map((e) => e.type).join(",")}`,
      );

    // -- cancel: the owner's cancel is acknowledged and the slow run actually stops.
    const cancelCreds = validation.mint("run_cancel", "thread_cancel", PROBE_SLOW_TEXT);
    const cancelRunInput = runInput({
      runId: "run_cancel",
      threadId: "thread_cancel",
      text: PROBE_SLOW_TEXT,
    });
    const cancelRun = collectEvents(httpAgentFor(base, headers(cancelCreds)), cancelRunInput);
    await model.waitFor(() => model.requests.some((r) => r.userText.includes(PROBE_SLOW_TEXT)));
    const cancelT0 = performance.now();
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
    measurements.cancelLagMs = Math.round(performance.now() - cancelT0);
    const cancelOk = cancelResponse.status === 200 && cancelBody.status === "cancel_requested";
    checks.cancel = {
      status: cancelOk ? "passed" : "failed",
      evidence: `POST /cancel -> ${cancelResponse.status} ${JSON.stringify(
        cancelBody,
      )} (want 200 cancel_requested); the cancelled run's stream settled ${measurements.cancelLagMs}ms after the cancel`,
    };
    if (!cancelOk)
      throw new Error(
        `cancel did not behave: status=${cancelResponse.status}, body=${JSON.stringify(cancelBody)}`,
      );

    // -- backpressure: registered not_run (see BACKPRESSURE_NOT_RUN_EVIDENCE).

    // -- restart: a restarted candidate admits it no longer holds the old run.
    const restartCreds = validation.mint("run_restart", "thread_restart", PROBE_SLOW_TEXT);
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
      callbackEndpoint: toolPlane.toolPlaneEndpoint,
    });
    started.push(restarted);
    const oldRunCancel = await fetch(`${restarted.baseUrl}/cancel`, {
      method: "POST",
      headers: headers(restartCreds),
      body: JSON.stringify({ runId: "run_restart", threadId: "thread_restart" }),
    });
    const restartOk = oldRunCancel.status === 404;
    checks.restart = {
      status: restartOk ? "passed" : "failed",
      evidence: `after killing and restarting the candidate, the old run's cancel -> ${oldRunCancel.status} (want 404: the restarted process holds no state it could lie about)`,
    };
    if (!restartOk)
      throw new Error(
        `a restarted candidate answered the old run's cancel with ${oldRunCancel.status}`,
      );

    const gates = deriveGates(checks);
    const report: CompatibilityReport = {
      ...environment,
      commands: [...commandJournal],
      exit_codes: { probe: 0 },
      evidence_refs: EVIDENCE_REFS,
      limitations: LIMITATIONS,
      checks,
      gates,
      measurements,
      reviewers: REVIEWERS,
    };
    const path = writeReport(report);
    console.log(
      `[probe] executed checks all passed; gates: G1a=${gates.G1a.status}, G1b=${gates.G1b.status}, G2=${gates.G2.status}; report written to ${path}`,
    );
    console.log(
      `[probe] measurements: rssBytes=${measurements.rssBytes} firstEventMs=${measurements.firstEventMs} cancelLagMs=${measurements.cancelLagMs} streamDurationMs=${measurements.streamDurationMs}`,
    );
    return 0;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try {
      const environment = await gatherEnvironment().catch(() => fallbackEnvironment());
      const gates = deriveGates(checks, failure);
      const path = writeReport({
        ...environment,
        commands: [...commandJournal],
        exit_codes: { probe: 1 },
        evidence_refs: EVIDENCE_REFS,
        limitations: LIMITATIONS,
        checks,
        gates,
        measurements,
        reviewers: REVIEWERS,
      });
      console.error(`[probe] FAILED: ${failure}`);
      console.error(`[probe] report written to ${path} with G1a=${gates.G1a.status}`);
    } catch (reportError) {
      console.error(`[probe] FAILED and the report could not be written: ${String(reportError)}`);
      console.error(`[probe] original failure: ${failure}`);
    }
    return 1;
  } finally {
    for (const candidate of started) await candidate.kill();
    model.server.stop(true);
    validation.server.stop(true);
    toolPlane.server.stop(true);
  }
}

if (import.meta.main) {
  process.exitCode = await runProbe();
}
