// Issue #1123786563/OpenBot#4 — T37 E2E real-instance ingest acceptance.
//
// Drives the PRODUCTION observation chain exactly as server/src/index.ts wires it at
// boot: opikConfigFromEnv -> loadVerifiedOpikPort -> createOpikHealthService ->
// createRunBindingStore -> createObserverRunBindingGate -> createModelSpanRecorder.
// Nothing is reimplemented here: the recorder projects content through T05 redaction
// (deny patterns run first and always win), the FREV-01 approval is minted by the
// production approveSpanContent (the only minter), the FREV-02 binding gate begins the
// run's local authoritative binding before the span exports, the health service's
// bounded queue performs the write against the verified port, and the port speaks the
// T04 contract. This is the app-side seam, not a raw OTLP curl — and not a bypass:
// without a real DATABASE_URL behind the real binding store the write fails closed.
//
// Proves against a real self-hosted Opik instance:
//   (a) an approved canary-bearing observation actually reaches storage (REST
//       read-back) — since F5A1 a proof-less body is omitted, so the canary rides
//       a minted approval or it never lands;
//   (b) credential-shaped canaries never reach it (A4) — they die at projection
//       EVEN approved (deny patterns win over approval), and a storage read-back
//       over every row of the project confirms absence;
//   (c) the run's local authoritative binding exists (FREV-02): begun before the
//       export and settled to its observed close, readable through the store.
//
// Read-only read-back through the same verified port. Evidence is sanitized: the safe
// canary value may appear (it is the proof marker); secret canary VALUES never do —
// only their labels. Exits nonzero on any failed check; writes no "passed" evidence.
//
//   DATABASE_URL=postgres://... (migrated; the binding store reads it) \
//   bun server/scripts/opik-e2e-ingest.ts \
//     --base-url http://127.0.0.1:5174/api \
//     --api-key e2e-synthetic-key \
//     --evidence <dir>

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createObserverRunBindingGate,
  createRunBindingStore,
} from "../src/ai-observability/bindings";
import { opikConfigFromEnv } from "../src/ai-observability/config";
import { runUpstreamIdentity } from "../src/ai-observability/opik-http";
import { createOpikHealthService } from "../src/ai-observability/health";
import type {
  OpikReadiness,
  OpikWriteStats,
} from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import type { OpikTraceRow } from "../src/ai-observability/opik-port";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { approveSpanContent } from "../src/ai-observability/span-support";
import { loadVerifiedOpikPort } from "../src/ai-observability/wiring";
import { createDatabase } from "../src/db/client";

type Args = { baseUrl: string; apiKey: string; evidenceDir: string };

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const baseUrl = get("--base-url");
  const apiKey = get("--api-key");
  const evidenceDir = get("--evidence");
  if (!baseUrl || !apiKey || !evidenceDir) {
    throw new Error(
      "usage: bun server/scripts/opik-e2e-ingest.ts --base-url <api> --api-key <synthetic> --evidence <dir>",
    );
  }
  return { baseUrl, apiKey, evidenceDir };
}

// Crypto-random hex (W3C trace ids must be unique across runs — a Math.random
// collision would merge two runs into one chain and misattribute evidence).
const hex = (n: number): string =>
  randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);

// #40: retry rounds re-submit BOTH observations, so accepted/completed accumulate
// across rounds and counts alone cannot prove the credential-bearing observation
// ever landed — any perform failure (stats.failed.*) or readiness refusal must
// void the gate, or forbiddenCanariesAbsent passes vacuously (safe completed twice
// while the sensitive write kept failing would still clear the count thresholds).
// Exported for the standalone gate check next to this script.
export const writesEstablished = (stats: OpikWriteStats): boolean =>
  stats.accepted >= 2 &&
  stats.completed >= 2 &&
  stats.droppedFull === 0 &&
  stats.refusedNotReady === 0 &&
  Object.values(stats.failed).every((count) => count === 0);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tag = hex(6);
  const startedAt = new Date();

  // Safe canary: the proof marker that storage really received this run's content.
  const safeCanary = `SAFE_CANARY_T37_${tag}`;

  // Credential-shaped canaries: their VALUES must never reach storage (A4). Each is a
  // shape the T05 deny list names; the label is all that may appear in evidence.
  const secretCanaries: ReadonlyArray<{ label: string; value: string }> = [
    {
      label: "connection-string",
      value: `postgresql://canary_user:e2e_${tag}_pw@db.internal:5432/canary`,
    },
    { label: "bearer-token", value: `Bearer ${tag}${hex(24)}` },
    { label: "anthropic-key", value: `sk-ant-api03-${tag}${hex(20)}` },
    { label: "aws-access-key", value: `AKIA${hex(16).toUpperCase()}` },
    { label: "github-token", value: `ghp_${tag}${hex(24)}` },
    { label: "private-key-header", value: "-----BEGIN RSA PRIVATE KEY-----" },
  ];

  const env = {
    OPIK_ENABLED: "true",
    OPIK_BASE_URL: args.baseUrl,
    OPIK_API_KEY: args.apiKey,
  };
  const config = opikConfigFromEnv(env);

  // A 30s deadline (the port default is 5s): the read-back pages on a loaded host legitimately
  // take longer, and the port settles into a typed `unavailable` rather than hanging either way.
  const port = await loadVerifiedOpikPort(
    config.baseUrl ?? args.baseUrl,
    30_000,
    undefined,
    config.apiKey ?? undefined,
  );
  if (port === null)
    throw new Error("loadVerifiedOpikPort returned null (manifest untrusted)");

  // FREV-02: the production binding gate over a real binding store — captured
  // before createDatabase because that call takes $DATABASE_URL out of the
  // environment (see db/client.ts), and a missing or unmigrated database must
  // fail this run loudly, never silently fall back to a binding-less write.
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.trim() === "") {
    throw new Error(
      "DATABASE_URL is required: the FREV-02 gate binds the run through the real binding store, and a run without one fails closed.",
    );
  }
  const database = createDatabase(databaseUrl);
  const bindings = createRunBindingStore(database);
  const observerBindings = createObserverRunBindingGate(bindings, {
    port: () => port,
  });

  const healthService = createOpikHealthService({ config: () => config, port });
  const recorder = createModelSpanRecorder({
    healthService,
    bindings: observerBindings,
  });

  // The scope the production path issues per run (T06): synthetic ids, real issuer.
  const scope = resolveObservationScope({
    actorId: `e2e-actor-${tag}`,
    botId: `e2e-bot-${tag}`,
    ownership: "owner",
    epoch: 1,
  });
  const locator = resolveStorageLocator(scope);

  // The run's W3C chain — what the production path captures from the request's
  // active span at doStream entry; here it is minted as one honest chain id for
  // the whole run, because since FREV-02 a chain-less observation exports
  // nothing (no chain, no binding, no export).
  const runChainId = hex(32);
  const runChain = { traceId: runChainId };

  // F5A1/f5a1-F3: the proof the safe canary's body rides — minted by the ONE
  // production minter from an approving policy, exactly as the run wiring
  // would when the Bot's policy resolves. The secret canary rides it too: the
  // assertion that matters is that the deny patterns win OVER the approval.
  const contentApproval = approveSpanContent({
    source: "bot_security_policy",
    policyRef: `opik-e2e-ingest/canary-policy/${tag}`,
    allowFreeText: true,
  });
  if (contentApproval === null) {
    throw new Error(
      "approveSpanContent minted nothing for an approving policy — the canary cannot ride a proof that does not exist.",
    );
  }

  // The bounded write entry fails closed until a probe has actually succeeded (T09), and a
  // refused submit is a counter, never a silent retry. So: wait for readiness, submit both
  // observations, and if the counters show either was refused behind a probe flip, wait out
  // the re-arm cooldown and resubmit both — up to three rounds, all visible in the counters.
  const submitBoth = (): void => {
    // Clean observation: must arrive — body behind the minted approval.
    recorder.record({
      occurredAt: new Date(),
      endedAt: new Date(),
      provider: "openbot-e2e",
      modelId: "e2e-canary",
      ending: { kind: "succeeded", inputTokens: 3, outputTokens: 5 },
      input: `e2e real-instance ingest ${safeCanary}`,
      output: `e2e output ${safeCanary}`,
      scope,
      trace: runChain,
      contentApproval,
    });
    // Credential-bearing observation: approved LIKE THE SAFE ONE — it must be
    // omitted anyway at projection (deny wins over approval), never sent.
    recorder.record({
      occurredAt: new Date(),
      endedAt: new Date(),
      provider: "openbot-e2e",
      modelId: "e2e-secret-canary",
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      input: `secret probe ${secretCanaries.map((c) => c.value).join(" ")}`,
      output: `secret probe output`,
      scope,
      trace: runChain,
      contentApproval,
    });
  };

  const awaitReady = async (): Promise<OpikReadiness> => {
    let current = await healthService.readiness();
    for (let i = 0; i < 30 && !current.ready; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      current = await healthService.readiness();
    }
    return current;
  };

  let readiness = await awaitReady();
  submitBoth();
  await healthService.drain();
  let stats = healthService.writeStats();
  for (let round = 0; round < 3 && (stats.accepted < 2 || stats.completed < 2); round++) {
    readiness = await awaitReady();
    submitBoth();
    await healthService.drain();
    stats = healthService.writeStats();
  }
  const readinessAtEnd = await healthService.readiness();

  // ---- Read-back through the verified port (REST), polling: writes are async. ----
  const poll = async <T>(
    label: string,
    fn: () => Promise<{ ok: true; value: T } | { ok: false; detail: string }>,
  ): Promise<T> => {
    let last = "";
    for (let i = 0; i < 30; i++) {
      const r = await fn();
      if (r.ok) return r.value;
      last = r.detail;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`${label} never settled: ${last}`);
  };

  let projectId = "";
  const rows: Array<Record<string, unknown>> = [];
  let readbackError: string | null = null;
  try {
    projectId = await poll("retrieveProject", async () => {
      const r = await port.retrieveProject(scope);
      return r.outcome === "ok" && r.value !== null
        ? { ok: true as const, value: r.value.id }
        : {
            ok: false as const,
            detail: r.outcome === "ok" ? "null" : r.outcome,
          };
    });

    // #21: an empty page is NOT a terminal state — writes are async and upstream
    // read visibility lags. Poll until content is non-empty (or the poll window
    // closes) so a timing hiccup doesn't read as "zero traces".
    const traces = await poll("listTraces", async () => {
      const r = await port.listTraces(scope, { projectId, size: 100 });
      if (r.outcome !== "ok") return { ok: false as const, detail: r.outcome };
      if (r.value.content.length === 0) return { ok: false as const, detail: "empty page (read visibility lag)" };
      return { ok: true as const, value: r.value };
    });
    // #17: single-page size=100 truncation — if total exceeds content.length,
    // the absence proof covers only the first page. Fail explicitly.
    if (traces.total > traces.content.length) {
      throw new Error(`listTraces truncated: total=${traces.total} > content=${traces.content.length} (absence proof would cover only page 1)`);
    }
    for (const trace of traces.content as readonly OpikTraceRow[]) {
      // A failed span read is NOT "this trace has no spans": poll like the
      // other read-backs, and on persistent failure record the trace id and
      // fail the read-back — unread spans must never read as "no leak" (A4).
      const spans = await poll(`listSpans ${trace.id}`, async () => {
        const r = await port.listSpans(scope, {
          projectId,
          traceId: trace.id,
          size: 100,
        });
        if (r.outcome !== "ok") return { ok: false as const, detail: r.outcome };
        if (r.value.content.length === 0) return { ok: false as const, detail: "empty page (read visibility lag)" };
        return { ok: true as const, value: r.value };
      });
      // #17: same truncation guard for spans.
      if (spans.total > spans.content.length) {
        throw new Error(`listSpans truncated for trace ${trace.id}: total=${spans.total} > content=${spans.content.length} (absence proof would cover only page 1)`);
      }
      rows.push({ traceId: trace.id, spans: spans.content as unknown });
    }
  } catch (error) {
    // Record the honest failure — never a fabricated pass, never a thrown-away run.
    readbackError = error instanceof Error ? error.message : String(error);
  }

  const serialized = JSON.stringify(rows);
  const safeFound = serialized.includes(safeCanary);
  const secretFound = secretCanaries.filter((c) =>
    serialized.includes(c.value),
  );

  // ---- FREV-02: the local authoritative binding, through the real store. ----
  // The run's OWN lifecycle observation settles the binding, exactly as the boot
  // wiring forwards the run's real ending (index.ts setBuiltinRunLifecycleObserver
  // → settleObservedRun with startedAt/ending/endedAt; settleObservedWindow's
  // tool-step shape is kept for callers with nothing better, and the production
  // wiring no longer calls it). The row is then read back through the production
  // query seam (latestAttempt) — the same lookup the run detail route answers
  // with, proving this run's content is locally locatable.
  observerBindings.settleObservedRun(scope, runChain, {
    startedAt,
    ending: "success",
    endedAt: new Date(),
  });
  let bindingRead: Awaited<ReturnType<typeof bindings.latestAttempt>> = null;
  let bindingReadError: string | null = null;
  try {
    // Poll past "running": the settle's finish races this read, and the check
    // below wants the SETTLED row, not the begun one.
    for (
      let i = 0;
      i < 30 && (bindingRead === null || bindingRead.state === "running");
      i++
    ) {
      bindingRead = await bindings.latestAttempt(
        scope,
        `builtin:${runChainId}`,
      );
      if (bindingRead === null || bindingRead.state === "running") {
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  } catch (error) {
    bindingReadError = error instanceof Error ? error.message : String(error);
  }
  // C2: materialization chain must have been exercised — the gate now receives
  // { port: () => port }, so the run's upstream identity is created upstream and
  // reconciled into the binding. Assert the binding carries a non-null opikTraceId
  // matching runUpstreamIdentity(runChainId).opikTraceId; without it the gate
  // would have taken the binding-only path (the tests' seam), not the production
  // shape the header claims. The settled state is the observed ending's own
  // terminal state — "success" maps to completed via observerTerminalState; the
  // window settle's pinned `unknown` was a test-seam shape, not the production
  // run close (R3-03).
  const expectedOpikTraceId = runUpstreamIdentity(runChainId).opikTraceId;
  const bindingEstablished =
    bindingReadError === null &&
    bindingRead !== null &&
    bindingRead.traceId === runChainId &&
    bindingRead.opikTraceId === expectedOpikTraceId &&
    bindingRead.capability === "detailed" &&
    bindingRead.state === "completed";

  const checks = {
    readinessReady: readiness.ready,
    readinessAtEndReady: readinessAtEnd.ready,
    // `completed` (not `accepted`): accepted only proves the writes were queued;
    // completed proves they were performed. Retry rounds accumulate both counters
    // (#40), so the count thresholds alone no longer mean "both observations
    // landed" — writesEstablished also refuses any perform failure or readiness
    // refusal, which is what makes forbiddenCanariesAbsent non-vacuous: if the
    // secret-bearing write failed at perform time, its absence from storage
    // would prove nothing.
    writeAccepted: writesEstablished(stats),
    readbackSettled: readbackError === null,
    projectResolved: projectId.length > 0,
    safeCanaryInStorage: safeFound,
    forbiddenCanariesAbsent: secretFound.length === 0,
    runBindingEstablished: bindingEstablished,
  };
  const passed = Object.values(checks).every(Boolean);

  let sanitized: unknown = rows;
  if (!checks.forbiddenCanariesAbsent) {
    // Never spill a leaked secret into evidence.
    sanitized = {
      redacted: true,
      reason: "secret canary found in storage read-back",
    };
  }

  await mkdir(args.evidenceDir, { recursive: true });
  await writeFile(
    join(args.evidenceDir, "ingest-summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        startedAt: startedAt.toISOString(),
        baseUrl: args.baseUrl,
        apiKey: args.apiKey === "" ? null : "<present, not recorded>",
        seam: "production modules: opikConfigFromEnv -> loadVerifiedOpikPort -> createOpikHealthService -> createRunBindingStore -> createObserverRunBindingGate -> createModelSpanRecorder (+ approveSpanContent for the canary proof)",
        scope: {
          key: scope.key,
          actorId: scope.actorId,
          botId: scope.botId,
          epoch: scope.epoch,
        },
        locator,
        projectId,
        readbackError,
        readiness,
        writeStats: stats,
        safeCanary: {
          label: "SAFE_CANARY_T37",
          value: safeCanary,
          foundInStorage: safeFound,
          ridesApproval: true,
        },
        runBinding: {
          runId: `builtin:${runChainId}`,
          traceId: runChainId,
          read: bindingRead
            ? {
                id: bindingRead.id,
                state: bindingRead.state,
                capability: bindingRead.capability,
                traceId: bindingRead.traceId,
                createdAt: bindingRead.createdAt.toISOString(),
              }
            : null,
          readError: bindingReadError,
        },
        forbiddenCanaries: secretCanaries.map((c) => ({
          label: c.label,
          foundInStorage: secretFound.some((f) => f.label === c.label),
        })),
        checks,
        passed,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(args.evidenceDir, "readback-spans.json"),
    `${JSON.stringify(sanitized, null, 2)}\n`,
  );

  await database.$client.close();
  if (!passed) {
    console.error(`FAILED checks: ${JSON.stringify(checks)}`);
    process.exit(1);
  }
  console.log(
    `E2E ingest PASSED project=${locator.project} projectId=${projectId} accepted=${stats.accepted} completed=${stats.completed} safeCanaryFound=${safeFound} forbiddenFound=${secretFound.length} bindingState=${bindingRead?.state ?? "absent"}`,
  );
}

// Run only as an entrypoint — the gate predicate is imported by the standalone
// check next to this script, and an import must not launch an ingest run.
if (import.meta.main) {
  await main();
}
