/**
 * The basic remote run-reporting seam (Issue #16 / DAG T10).
 *
 * Mounting contract (T-final H1 — now MET, after the final review found the
 * route assembly-complete but zero-mounted):
 *
 *   routes.route("/bots/:botId/runs", createBasicRunRoutes({ ... }))
 *
 * inside createAiObservabilityRoutes (routes/index.ts), which puts the endpoint
 * at POST /api/ai-observability/bots/:botId/runs behind the root requireUser —
 * the same prefix the T11 query routes own the GETs of. The mount is guarded by
 * the deps actually carrying begin/finish; absent, the route stays unmounted
 * under the module's "absent = not mounted" contract.
 *
 * This is the seam through which an OpenBot-mediated remote AG-UI execution reports
 * the events OpenBot actually observed. Authorization is the management question
 * (resolveObservationBot), the association is derived from the authenticated context
 * plus the injected ownership epoch — the body contributes thread/run/attempt/trace
 * references and nothing else, so no forged actor, bot, scope or epoch can steer the
 * binding. The response is a classification, never business content: states,
 * outcomes, tool ids, counters and the binding id.
 *
 * Honesty of the answer: this seam cannot see the remote runtime's internal steps,
 * so the capability verdict comes from resolveRunCapability with
 * internalStepsVerified=false — `basic` when events were observed, `unavailable`
 * when none were — and `internalSteps` is reported as "unobserved", a marker that
 * says "invisible", not an empty list that would claim "nothing happened inside".
 *
 * Upstream writes: this seam performs NO Opik write in this ticket. When the
 * consumer side (T11/T14) starts recording runs upstream, the write must enter
 * through OpikHealthService.submit — the T09 bounded queue — never a direct port
 * call, so this classification path stays synchronous, non-blocking and network-free.
 */
import { Hono } from "hono";
import type { AgentActor } from "../../agents/public";
import type { AppVariables } from "../../auth/public";
import { RunBindingError, type RunBindingStore } from "../bindings";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../context";
import { type ObservationScope, ObservationScopeError } from "../contracts";
import {
  type AttemptRunState,
  type AttemptTerminalOutcome,
  beginRunAttempt,
  parseRunObservationEvent,
  type RunAssociation,
  type RunCapability,
  RunLifecycleError,
  type RunObservationEvent,
  type RunToolObservation,
  resolveRunCapability,
} from "../run-lifecycle";
import { resolveObservationScope } from "../scope";

export type BasicRunDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** The accepted T07 trusted-association seam (Issue #13), injected. */
  bindings: Pick<RunBindingStore, "begin" | "finish">;
  /** Binding expiry horizon. Default 7 days — the Spec's run-trace retention default. */
  bindingTtlMs?: number;
  now?: () => Date;
}>;

/** Everything the classification seam needs once authorization has answered. */
export type BasicRunCore = Readonly<{
  bindings: Pick<RunBindingStore, "begin" | "finish">;
  bindingTtlMs?: number;
  now?: () => Date;
}>;

const DEFAULT_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type BasicRunReport = {
  threadId: string;
  runId: string;
  attemptId: string;
  traceId: string;
  events: RunObservationEvent[];
};

export type BasicRunOutcome = Readonly<{
  attempt: {
    origin: RunAssociation["origin"];
    botId: string;
    threadId: string;
    runId: string;
    attemptId: string;
    state: AttemptRunState;
    outcome: AttemptTerminalOutcome | null;
    observed: { firstFrame: boolean; started: boolean; disconnected: boolean };
    tools: RunToolObservation;
  };
  capability: RunCapability;
  internalSteps: "unobserved";
  rejectedEvents: number;
  binding: { id: string; replayed: boolean };
}>;

/**
 * A single report's event ceiling (OCR m171): a real run reports tens of events;
 * beyond this the request is refused rather than parsed — parsing is synchronous
 * per request, so an uncapped array is an authenticated denial-of-surface.
 */
const MAX_REPORT_EVENTS = 10_000;

/** Reads the report by whitelist. Unknown fields — however forged — are ignored. */
function parseReport(body: unknown): BasicRunReport {
  const invalid = () => new RunLifecycleError("LIFECYCLE_INPUT_INVALID", 400);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid();
  }
  const raw = body as Record<string, unknown>;
  const fields = ["threadId", "runId", "attemptId", "traceId"] as const;
  const refs = {} as Pick<
    BasicRunReport,
    "threadId" | "runId" | "attemptId" | "traceId"
  >;
  for (const field of fields) {
    if (
      typeof raw[field] !== "string" ||
      (raw[field] as string).trim() === ""
    ) {
      throw invalid();
    }
    refs[field] = raw[field] as string;
  }
  const rawEvents: unknown = raw.events;
  if (!Array.isArray(rawEvents)) throw invalid();
  // A count cap beside the per-event whitelist (OCR m171): each event parses in
  // O(1), but millions of minimal events would parse synchronously inside one
  // request — an authenticated denial-of-surface. A real run reports tens of
  // events; a report beyond the cap is refused, not drained.
  if (rawEvents.length > MAX_REPORT_EVENTS) throw invalid();
  return { ...refs, events: rawEvents.map(parseRunObservationEvent) };
}

/**
 * The one run-reporting composition, shared by the HTTP seam and the deletion-path
 * probe: begin (idempotent), classify what was actually observed, and — when the
 * events reached a terminal outcome — settle the binding onto that state through the
 * T07 store's `finish`. A report with no observed terminal event leaves the binding
 * `running`: the run may still be executing, and nothing here may invent an ending
 * it did not see. The store's first-terminal-write-wins discipline makes a replayed
 * or divergent later report unable to rewrite a standing outcome.
 */
export async function reportBasicRun(
  core: BasicRunCore,
  scope: ObservationScope,
  report: BasicRunReport,
): Promise<BasicRunOutcome> {
  const ttl = core.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
  const now = core.now ?? (() => new Date());

  // The remote AG-UI path is honest about what it cannot see: internal steps are
  // never verified here, so the verdict is basic or unavailable, never detailed.
  const capability = resolveRunCapability({
    internalStepsVerified: false,
    observedEvents: report.events.length > 0,
  });

  const bound: Awaited<ReturnType<RunBindingStore["begin"]>> =
    await core.bindings.begin(scope, {
      runId: report.runId,
      attemptId: report.attemptId,
      traceId: report.traceId,
      capability,
      expiresAt: new Date(now().getTime() + ttl),
    });

  const attempt = beginRunAttempt({
    scopeKey: scope.key,
    botId: scope.botId,
    threadId: report.threadId,
    runId: report.runId,
    attemptId: report.attemptId,
    origin: "remote-agui",
  });
  let rejectedEvents = 0;
  for (const event of report.events) {
    if (!attempt.observe(event).accepted) rejectedEvents += 1;
  }
  const record = attempt.record();

  // The G1 seam: an observed terminal outcome is the one production writer of the
  // binding's terminal state — the write that makes the retention run discovery
  // (`state <> 'running'`) reachable for real production bindings.
  if (record.outcome !== null) {
    await core.bindings.finish(
      scope,
      report.runId,
      report.attemptId,
      record.outcome.state,
    );
  }

  return {
    attempt: {
      origin: record.association.origin,
      botId: record.association.botId,
      threadId: record.association.threadId,
      runId: record.association.runId,
      attemptId: record.association.attemptId,
      state: record.state,
      outcome: record.outcome,
      observed: record.observed,
      tools: record.tools,
    },
    capability,
    // "unobserved" is a visibility marker, not an empty result: invisible internal
    // calls are not claimed to be absent.
    internalSteps: "unobserved",
    rejectedEvents,
    binding: { id: bound.binding.id, replayed: bound.replayed },
  };
}

export function createBasicRunRoutes(
  deps: BasicRunDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const BASIC_RUN_INPUT_INVALID = "BASIC_RUN_INPUT_INVALID";

  routes.post("/", async (context) => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) return context.json({ error: access.error }, access.status);

    const actor = context.var.actor;
    // Explicit, never inferred (OCR h10/m182): a caller the seam refuses to mint
    // for is answered with the same unified not-found the manage gate uses.
    const ownership = explicitObservationOwnership(actor, access.profile);
    if (ownership === null) {
      return context.json({ error: OBSERVATION_BOT_NOT_FOUND }, 404);
    }
    let scope: ObservationScope;
    try {
      const epoch = await deps.scopeEpoch(actor, access.botId);
      scope = resolveObservationScope({
        actorId: actor.id,
        botId: access.botId,
        ownership,
        epoch,
      });
    } catch (error) {
      if (error instanceof ObservationScopeError) {
        return context.json({ error: error.code }, error.status);
      }
      throw error;
    }

    let report: BasicRunReport;
    try {
      report = parseReport(await context.req.json().catch(() => undefined));
    } catch (error) {
      if (error instanceof RunLifecycleError) {
        return context.json({ error: BASIC_RUN_INPUT_INVALID }, 400);
      }
      throw error;
    }

    let outcome: BasicRunOutcome;
    try {
      // The one composition, shared with the deletion-path probe: begin, classify,
      // and settle the binding when the events reached a terminal outcome.
      outcome = await reportBasicRun(deps, scope, report);
    } catch (error) {
      if (error instanceof RunBindingError) {
        return context.json({ error: error.code }, error.status);
      }
      throw error;
    }

    return context.json(outcome);
  });

  return routes;
}
