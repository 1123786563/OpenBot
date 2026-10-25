/**
 * The governed basic record for a remote AG-UI run this server mediated (F5E1-F2).
 *
 * OWNERSHIP: new with F5E1-F2, because the two compositions this fact otherwise fits each
 * own one half of it and would have to grow the other's contract to serve it —
 * `routes/basic-run.ts` owns the HTTP reporter's shape (classification only, deliberately no
 * upstream write) and `bindings.ts`'s observer gate owns the built-in span path (whose
 * capability is `detailed` by construction). This recorder composes the same machinery — the
 * T07 binding store, T10's run lifecycle, and F5E1-F3's deterministic upstream identity
 * through the verified port — for the in-process remote run, without editing either.
 *
 * WHAT A REMOTE RUN CAN HONESTLY CLAIM (T10): this path sees the AG-UI events that passed
 * through this server and nothing inside the endpoint, so `internalStepsVerified` is always
 * false — the capability is `basic` when events were observed, `unavailable` when none were,
 * never `detailed`.
 *
 * THE CHAIN IS THE RUN'S W3C TRACE (F5E1-F3's discipline, not a second identity scheme): the
 * binding's trace id is the chain the dial propagated to the endpoint, the upstream objects
 * are derived from it deterministically, and a retried materialization asks the backend for
 * the very same trace. A fact with no provable chain records nothing — the same honest no-op
 * the span recorders keep — because a trace id this side cannot prove is never claimed.
 *
 * SETTLEMENT DIVERGES FROM THE SPAN GATE ON ONE POINT, DELIBERATELY. The observer gate fails
 * a span's export closed when upstream objects cannot be established, because an unattributed
 * span is exactly the unattributable write the port refuses. A basic record exports no spans;
 * its deliverable is the LOCAL authoritative binding, and an outcome this process observed is
 * not made unrecorded by an upstream outage — the finish lands, the materialization failure
 * is logged, and the run stays locatable in the binding table (and, after a later successful
 * reconcile path, upstream) rather than silently absent from both.
 *
 * THIS MODULE ALSO OWNS THE REMOTE BUDGET SEAM (R3-02): the per-run admission that holds
 * credits, the declaration of which endpoints can actually enforce a budget, and the receipt
 * check that proves a run stayed inside it. They live beside the recorder because they are the
 * same subject — what this deployment may claim about a run somebody else's process executed —
 * and because the boot wiring for all three is one block that deserves one tested owner. See
 * `createRemoteRunBudgetGate`, `createRemoteBudgetContractResolver` and
 * `verifyRemoteBudgetReceipt` below.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { matchesToken } from "../../../shared/agent-authorisation";
import type { SafeText } from "../../../shared/ai-observability";
import { getLogger } from "../../../shared/logger";
import type {
  RemoteBudgetContract,
  RemoteBudgetContractCaps,
  RemoteBudgetContractRequest,
  RemoteBudgetReceiptCheck,
  RemoteBudgetUsage,
  RemoteRunAdmission,
  RemoteRunAdmissionInput,
} from "../copilot";
import type { RunBindingStore } from "./bindings";
import type { ObservationScope } from "./contracts";
import { runUpstreamIdentity } from "./opik-http";
import type { OpikOtlpSpan, OpikPort, OpikRunBindingRef } from "./opik-port";
import {
  beginRunAttempt,
  type RunObservationEvent,
  resolveRunCapability,
} from "./run-lifecycle";
import { nanos, nowNs, W3C_TRACE_ID } from "./span-support";

const log = getLogger("server");

/** The same seven-day lease the HTTP report path and the observer gate write. */
const DEFAULT_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The run root span's name — the tree's own word for the run, never projected text (the
 * port refuses a withheld name because the read-back locates spans by name). MUST stay the
 * literal `bindings.ts` materializes for built-in runs: the query face locates a run's root
 * by this name without asking which origin wrote it.
 */
const RUN_ROOT_SPAN_NAME: SafeText = { state: "projected", text: "run" };

/** What one remote run's fact carries, in the closed event vocabulary the middleware observed. */
export type RemoteRunRecordInput = Readonly<{
  /** The trusted scope the run's threading minted; null or unissued records nothing. */
  scope: unknown;
  botId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  /** The run's W3C trace id; a fact that carried none provable records nothing. */
  traceId: string | null;
  events: readonly (
    | {
        type:
          | "http_first_frame"
          | "run_started"
          | "disconnected"
          | "success"
          | "error"
          | "interrupted"
          | "canceled";
      }
    | { type: "tool_proposed" | "tool_executed"; toolCallId: string }
  )[];
  endedAt: Date;
}>;

export type RemoteRunRecorder = {
  /** Records one fact. Sync-entry, network-free by contract: the durable work is contained. */
  record(input: RemoteRunRecordInput): void;
};

export function createRemoteRunRecorder(
  deps: Readonly<{
    bindings: Pick<RunBindingStore, "begin" | "finish"> &
      Partial<Pick<RunBindingStore, "reconcile">>;
    /** The verified port behind this deployment, asked at record time, never boot-frozen. */
    port: () => OpikPort | null;
    ttlMs?: number;
    now?: () => Date;
  }>,
): RemoteRunRecorder {
  const ttlMs = deps.ttlMs ?? DEFAULT_BINDING_TTL_MS;
  const now = deps.now ?? (() => new Date());
  return {
    record(input) {
      void recordRemoteRun(deps, { ttlMs, now }, input).catch((error) => {
        log.warn(
          {
            type: "opik-remote-run-record-failed",
            name: (error as Error | null | undefined)?.name,
          },
          "opik-remote-run-record-failed",
        );
      });
    },
  };
}

async function recordRemoteRun(
  deps: Parameters<typeof createRemoteRunRecorder>[0],
  timing: { ttlMs: number; now: () => Date },
  input: RemoteRunRecordInput,
): Promise<void> {
  if (input.scope === null || input.scope === undefined) return;
  /*
   * The wiring seam's own cast discipline: the ONLY writer of this value is the boot
   * threading's `resolveObservationScope` — a scope this process issued. Anything else fails
   * the store's own `assertObservationScope` on the write below, and the refusal is
   * attributable to the scope rather than to a constraint downstream of it.
   */
  const scope = input.scope as ObservationScope;
  const traceId = input.traceId;
  if (traceId === null || !W3C_TRACE_ID.test(traceId)) return;

  // T10: this path sees events, never internals, so `basic` is the honest ceiling.
  const capability = resolveRunCapability({
    internalStepsVerified: false,
    observedEvents: input.events.length > 0,
  });

  const { binding } = await deps.bindings.begin(scope, {
    runId: input.runId,
    attemptId: input.attemptId,
    traceId,
    capability,
    expiresAt: new Date(timing.now().getTime() + timing.ttlMs),
  });
  if (binding.traceId !== traceId) {
    // The authoritative row exists and names a different chain: the first claim stands, the
    // same reconcile discipline the observer gate keeps, and this fact records nothing.
    log.warn(
      { type: "opik-remote-run-binding-trace-conflict", botId: input.botId },
      "opik-remote-run-binding-trace-conflict",
    );
    return;
  }

  /*
   * F5E1-F3's materialization, same ordering on the crash path: create, root, THEN
   * reconcile. A crash between the create and the reconcile leaves upstream objects the
   * deterministic derivation finds again on a retry; a reconcile written first could claim a
   * tree nobody wrote. Absent port (Opik disabled or unverified) or an already-materialized
   * row keeps the binding-only shape — the recorder's local record is complete without it.
   */
  await materializeUpstream(
    deps,
    scope,
    {
      scopeKey: binding.scopeKey,
      runId: binding.runId,
      attemptId: binding.attemptId,
      locatorWorkspace: binding.locatorWorkspace,
      locatorProject: binding.locatorProject,
      opikTraceId: binding.opikTraceId,
    },
    traceId,
  ).catch((error) => {
    log.error(
      {
        type: "opik-remote-run-materialize-failed",
        name: (error as Error | null | undefined)?.name,
      },
      "opik-remote-run-materialize-failed",
    );
  });

  /*
   * The classification, under the same first-terminal-wins discipline the HTTP reporter
   * runs: events already rejected by the lifecycle (a straggler terminal after a standing
   * outcome) are counted, never re-decided, and the store's own first-terminal-write-wins
   * makes a replayed report unable to rewrite a standing outcome.
   */
  const attempt = beginRunAttempt({
    scopeKey: scope.key,
    botId: input.botId,
    threadId: input.threadId,
    runId: input.runId,
    attemptId: input.attemptId,
    origin: "remote-agui",
  });
  for (const event of input.events) {
    attempt.observe(event as RunObservationEvent);
  }
  const record = attempt.record();
  if (record.outcome !== null) {
    await deps.bindings.finish(
      scope,
      input.runId,
      input.attemptId,
      record.outcome.state,
    );
  }
  // No terminal outcome: the binding stays `running` and the lease sweeper's `unknown` is
  // the net — the run may still be executing at the endpoint, and nothing here invents an
  // ending it did not see (T10).
}

async function materializeUpstream(
  deps: Parameters<typeof createRemoteRunRecorder>[0],
  scope: ObservationScope,
  ref: OpikRunBindingRef,
  traceId: string,
): Promise<void> {
  const port = deps.port();
  if (port === null) return;
  if (ref.opikTraceId !== null) return; // an earlier pass materialized this chain
  const reconcile = deps.bindings.reconcile;
  if (reconcile === undefined) {
    // A port without the authoritative store's mapping write is a wiring defect: fail
    // loudly rather than export under an identity nobody records.
    throw new Error("REMOTE_RUN_RECONCILE_UNWIRED");
  }
  const identity = runUpstreamIdentity(traceId);
  const startedAt = new Date();
  const created = await port.createTrace(scope, {
    traceId: identity.opikTraceId,
    name: RUN_ROOT_SPAN_NAME,
    startTime: startedAt,
    binding: ref,
  });
  if (created.outcome !== "ok") {
    throw new Error("REMOTE_RUN_UPSTREAM_UNAVAILABLE");
  }
  const rootSpan: OpikOtlpSpan = {
    traceId,
    spanId: identity.rootSpanId,
    name: RUN_ROOT_SPAN_NAME,
    startTimeUnixNano: nanos(startedAt) ?? nowNs(),
    // The root's close is not observed here — an end time would be a duration nobody
    // measured, so the row stays open and the query face reports what it knows.
    opik: {
      traceId: identity.opikTraceId,
      spanId: identity.rootOpikSpanId,
    },
  };
  const rooted = await port.writeSpans(scope, {
    spans: [rootSpan],
    binding: { ...ref, opikTraceId: identity.opikTraceId },
  });
  if (rooted.outcome !== "ok") {
    throw new Error("REMOTE_RUN_UPSTREAM_UNAVAILABLE");
  }
  await reconcile(scope, ref.runId, ref.attemptId, identity.opikTraceId);
}

/* ------------------------------------------------------------------------------------------
 * The remote budget seam (R3-02)
 *
 * Three functions, in the order a run meets them:
 *
 *   createRemoteBudgetContractResolver — asked at build time: can THIS endpoint be held to a
 *     budget this deployment can enforce, and under which caps?
 *   createRemoteRunBudgetGate         — asked at run time, before the dial: hold the run's
 *     worst case in credits.
 *   verifyRemoteBudgetReceipt         — asked when the endpoint's receipt arrives: did the run
 *     stay inside the contract it was dialled with?
 *
 * Before R3-02 the first was missing and the second was mistaken for it: a hold bounds what is
 * CHARGED, never what a remote endpoint SPENDS. The finding is answered here rather than by
 * quieting it — an endpoint that cannot be held to a contract is refused, not dialled.
 * ---------------------------------------------------------------------------------------- */

/**
 * An endpoint URL as this deployment identifies it: canonical, with the pathname's trailing
 * slashes removed so an operator's spelling and a registry row's spelling are the same string.
 *
 * `agent/runtime-agents.ts` canonicalises the managed endpoint the same way, and the rule is
 * repeated here on purpose: this module must not import the boot configuration (which would
 * drag auth and learning modules into every test that reads a receipt), and a test pins the two
 * spellings agreeing.
 */
export function canonicalRemoteEndpoint(
  value: string | URL,
): string | undefined {
  try {
    const endpoint = new URL(value);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    return endpoint.toString();
  } catch {
    return undefined;
  }
}

/**
 * The caps one run's contract carries, from the approved policy.
 *
 * The token ceiling is the billing policy's own code-run ceiling (`BILLING_CODE_RUN_MAX_
 * RESERVATION_TOKENS`): the same number the hold is derived from, which is what makes the
 * contract and the hold agree. It is a per-run total, so both per-kind caps are the same
 * number — the sum is what binds, and neither kind may claim the whole budget alone.
 *
 * Undefined when the ceiling cannot be represented exactly or the step cap is not a whole
 * positive number: an endpoint is not declared supported on arithmetic this deployment cannot
 * do, and the resolver answers `undefined` (a refusal) rather than guessing.
 */
export function remoteBudgetCaps(
  maximumTokens: bigint,
  maxModelSteps: number,
): RemoteBudgetContractCaps | undefined {
  if (!Number.isSafeInteger(maxModelSteps) || maxModelSteps <= 0)
    return undefined;
  if (maximumTokens <= 0n || maximumTokens > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const total = Number(maximumTokens);
  return Object.freeze({
    modelSteps: maxModelSteps,
    inputTokens: total,
    outputTokens: total,
    totalTokens: total,
  });
}

/** The config a deployment declares for the contract, already parsed and canonicalised. */
export type RemoteBudgetContractWiring = Readonly<{
  /** The endpoint identities this deployment runs AND has declared contract-capable. */
  endpoints: ReadonlySet<string>;
  /** The deployment token both ends hold; the receipt's HMAC key. */
  sharedSecret: string | undefined;
  /** The approved per-run token ceiling (`creditPolicy.codeRun.maximumTokens`). */
  maximumTokens: bigint;
  maxModelSteps: number;
}>;

/**
 * Which remote endpoints are held to the budget contract — and it takes THREE explicit facts,
 * not the mere presence of a billing policy.
 *
 * That was the finding's sharpest point: `creditPolicy.configured` says what a unit of work
 * costs, never that a third party may spend without limit. So an endpoint is supported only
 * when the operator has named it (`endpoints`), it presents the deployment token this process
 * holds (`agentToken` — the same token `runtime-agents` attaches ONLY to endpoints the
 * deployment itself runs), and the policy's ceiling converts to a whole number of tokens. Any
 * missing fact answers `undefined`, which the caller turns into the same
 * REMOTE_RUN_BUDGET_UNVERIFIED refusal the deployment has always given.
 *
 * `remote_ag_ui` only, deliberately: the contract rides in `forwardedProps` and is reported in
 * a protocol CUSTOM event, and the Mastra bridge carries neither to the Mastra server. A Mastra
 * endpoint is therefore not contract-capable today, and pretends otherwise nowhere — see the
 * disclosure in the task report rather than a guess here.
 */
export function createRemoteBudgetContractResolver(
  wiring: RemoteBudgetContractWiring,
): (request: RemoteBudgetContractRequest) => RemoteBudgetContract | undefined {
  const caps = remoteBudgetCaps(wiring.maximumTokens, wiring.maxModelSteps);
  const secret = wiring.sharedSecret;
  return (request) => {
    if (request.type !== "remote_ag_ui") return undefined;
    if (secret === undefined || secret.length === 0) return undefined;
    if (request.agentToken === undefined) return undefined;
    if (!matchesToken(secret, request.agentToken)) return undefined;
    if (caps === undefined) return undefined;
    const endpoint = canonicalRemoteEndpoint(request.endpoint);
    if (endpoint === undefined || !wiring.endpoints.has(endpoint)) {
      return undefined;
    }
    return {
      caps,
      verifyReceipt: (value, expected) =>
        verifyRemoteBudgetReceipt(
          { runId: expected.runId, caps, secret },
          value,
        ),
    };
  };
}

/*
 * The receipt's signing input, byte for byte what the endpoint builds.
 *
 * The endpoint's copy is `agent-langgraph/src/budget.ts` (`receiptSigningInput`), and this one
 * MUST stay identical: a receipt is refused rather than accepted when the two drift, which is
 * the safe direction but a silent outage, so the full-chain smoke test runs both ends against
 * each other and each package pins the literal in its own suite.
 */
function receiptSigningInput(input: {
  runId: string;
  caps: RemoteBudgetContractCaps;
  usage: RemoteBudgetUsage;
  status: "ok" | "budget_exceeded";
}): string {
  return [
    "openbot-budget-receipt",
    "v=1",
    `runId=${input.runId}`,
    `caps=${input.caps.modelSteps}|${input.caps.inputTokens}|${input.caps.outputTokens}|${input.caps.totalTokens}`,
    `usage=${input.usage.modelSteps}|${input.usage.inputTokens}|${input.usage.outputTokens}|${input.usage.totalTokens}`,
    `status=${input.status}`,
  ].join("\n");
}

const MAC_PATTERN = /^[0-9a-f]{64}$/;
const wholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check one receipt against the contract this run was dialled with.
 *
 * The order is deliberate: shape, then identity, then signature, then arithmetic. Everything
 * before the signature is cheap; the signature is what turns "some JSON arrived" into "the
 * endpoint holding this deployment's token reported for THIS run under THESE caps"; and the
 * arithmetic check runs only on a receipt proven to be that one.
 *
 * The overrun rule is the endpoint's enforcement promise read back: a run it says stopped at
 * its budget may show usage past a cap, because the last provider call is the one that crossed
 * it and there is no way to un-spend it — but a run that claims `ok` may not. Steps are
 * different from tokens: they are counted before each call, so no honest receipt exceeds them
 * in any status.
 */
export function verifyRemoteBudgetReceipt(
  expected: {
    runId: string;
    caps: RemoteBudgetContractCaps;
    secret: string;
  },
  value: unknown,
): RemoteBudgetReceiptCheck {
  if (!isRecord(value)) return { state: "invalid", reason: "shape" };
  if (value.kind !== "openbot-budget-receipt") {
    return { state: "invalid", reason: "kind" };
  }
  if (value.v !== 1) return { state: "invalid", reason: "version" };
  if (value.runId !== expected.runId) {
    return { state: "invalid", reason: "run" };
  }
  /*
   * The caps the endpoint echoes must be the caps this run was dialled with: a receipt for a
   * wider contract is a receipt for a run this deployment did not admit.
   */
  const caps = value.caps;
  if (!isRecord(caps)) return { state: "invalid", reason: "caps" };
  for (const key of [
    "modelSteps",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    if (caps[key] !== expected.caps[key]) {
      return { state: "invalid", reason: `caps.${key}` };
    }
  }
  const status = value.status;
  if (status !== "ok" && status !== "budget_exceeded") {
    return { state: "invalid", reason: "status" };
  }
  const usage = value.usage;
  if (!isRecord(usage)) return { state: "invalid", reason: "usage" };
  for (const key of [
    "modelSteps",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ] as const) {
    if (!wholeNumber(usage[key])) {
      return { state: "invalid", reason: `usage.${key}` };
    }
  }
  const resolved: RemoteBudgetUsage = {
    modelSteps: usage.modelSteps as number,
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
    totalTokens: usage.totalTokens as number,
  };
  if (resolved.totalTokens !== resolved.inputTokens + resolved.outputTokens) {
    return { state: "invalid", reason: "usage.totalTokens" };
  }
  const mac = value.mac;
  if (typeof mac !== "string" || !MAC_PATTERN.test(mac)) {
    return { state: "invalid", reason: "signature" };
  }
  const signingInput = receiptSigningInput({
    runId: expected.runId,
    caps: expected.caps,
    usage: resolved,
    status,
  });
  const computed = createHmac("sha256", expected.secret)
    .update(signingInput)
    .digest();
  const offered = Buffer.from(mac, "hex");
  if (
    offered.length !== computed.length ||
    !timingSafeEqual(offered, computed)
  ) {
    return { state: "invalid", reason: "signature" };
  }
  if (resolved.modelSteps > expected.caps.modelSteps) {
    return { state: "overrun", reason: "usage.modelSteps" };
  }
  if (status === "ok") {
    if (resolved.inputTokens > expected.caps.inputTokens) {
      return { state: "overrun", reason: "usage.inputTokens" };
    }
    if (resolved.outputTokens > expected.caps.outputTokens) {
      return { state: "overrun", reason: "usage.outputTokens" };
    }
    if (resolved.totalTokens > expected.caps.totalTokens) {
      return { state: "overrun", reason: "usage.totalTokens" };
    }
  }
  return { state: "verified", status, usage: resolved };
}

/**
 * What the gate needs from the billing seam, structurally — no dependency on its internals.
 *
 * Generic over the payer kind only so the refusal it hands back carries the wiring's own type:
 * the gate must not import the billing module (this file is the observability side of the seam),
 * and the caller's `CreditInsufficientError` must still get the exact union it declares.
 */
export type RemoteRunBudgetGateWiring<TPayerKind extends string = string> =
  Readonly<{
    creditWriter: {
      reserveCredits(input: {
        externalCustomerId: string;
        idempotencyKey: string;
        maximumCents: number;
        expiresAt: Date;
      }): Promise<
        | { reserved: true; reservationId: string }
        | { reserved: false; availableCents: number }
      >;
      markReservationUnknown(
        reservationId: string,
        reason: string,
      ): Promise<void>;
    };
    /** The request's one payer (B5-219), resolved by the wiring exactly as the model gate does. */
    resolvePayer(): { externalCustomerId: string; payer: { kind: TPayerKind } };
    /** The run-class ceiling in scaled credit units (`codeRun.maximumReservationUnits`). */
    maximumCents: number;
    /** How long the hold lives before it expires on its own clock. */
    reservationWindowMs: number;
    /** The natural-key prefix the ledger shares with every other hold. */
    idempotencyPrefix: string;
    log: {
      error(context: Record<string, unknown>, message: string): void;
      warn(context: Record<string, unknown>, message: string): void;
    };
    /** The refusals the person's surface already understands, built by the wiring. */
    refusals: {
      gateFailure(): Error;
      insufficient(input: {
        payerKind: TPayerKind;
        availableCents: number;
      }): Error;
    };
  }>;

/**
 * The per-run credit admission a remote dial passes through (F5E1-F2, lifted out of the boot
 * wiring by R3-02 so it is a tested seam rather than an untested block).
 *
 * Behaviour is unchanged from the inline version it replaces: one reservation over the run's
 * worst case, in the SAME writer and ledger the built-in path uses; a refusal that throws (the
 * dial never happens); and a settlement that MARKS THE HOLD UNKNOWN with the observed outcome,
 * never releasing it — AG-UI carries no usage receipt in credit units, so no side can confirm a
 * remote run was free. The contract's own receipt bounds what was SPENT; it does not price it,
 * and inventing a charge from it would be exactly the kind of second book this seam exists to
 * avoid.
 */
export function createRemoteRunBudgetGate<TPayerKind extends string>(
  wiring: RemoteRunBudgetGateWiring<TPayerKind>,
): (input: RemoteRunAdmissionInput) => Promise<RemoteRunAdmission> {
  return async (input) => {
    const payerBinding = wiring.resolvePayer();
    let reservation: Awaited<
      ReturnType<RemoteRunBudgetGateWiring["creditWriter"]["reserveCredits"]>
    >;
    try {
      reservation = await wiring.creditWriter.reserveCredits({
        externalCustomerId: payerBinding.externalCustomerId,
        idempotencyKey: `${wiring.idempotencyPrefix}${input.eventId}`,
        maximumCents: wiring.maximumCents,
        expiresAt: new Date(
          input.occurredAt.getTime() + wiring.reservationWindowMs,
        ),
      });
    } catch (error) {
      wiring.log.error(
        {
          type: "remote-run-credit-gate-failed",
          eventId: input.eventId,
          botId: input.botId,
          name: (error as Error | null | undefined)?.name,
        },
        "remote-run-credit-gate-failed",
      );
      throw wiring.refusals.gateFailure();
    }
    if (!reservation.reserved) {
      wiring.log.warn(
        {
          type: "remote-run-credit-reservation-refused",
          eventId: input.eventId,
          botId: input.botId,
          payerKind: payerBinding.payer.kind,
          available: reservation.availableCents,
        },
        "remote-run-credit-reservation-refused",
      );
      throw wiring.refusals.insufficient({
        payerKind: payerBinding.payer.kind,
        availableCents: reservation.availableCents,
      });
    }
    const reservationId = reservation.reservationId;
    return {
      finish: async ({ outcome }) => {
        try {
          await wiring.creditWriter.markReservationUnknown(
            reservationId,
            `remote_usage_unreported:${outcome}`,
          );
        } catch (error) {
          wiring.log.error(
            {
              type: "remote-run-credit-settle-failed",
              eventId: input.eventId,
              botId: input.botId,
              outcome,
              name: (error as Error | null | undefined)?.name,
            },
            "remote-run-credit-settle-failed",
          );
        }
      },
    };
  };
}
