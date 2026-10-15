/**
 * The basic remote run-reporting seam (Issue #16 / DAG T10).
 *
 * Mounting contract for the coordinator (this file is deliberately NOT wired into
 * routes/index.ts — that seam is T01-owned):
 *
 *   routes.route("/bots/:botId/runs", createBasicRunRoutes({ ... }))
 *
 * inside createAiObservabilityRoutes, which puts the endpoint at
 * POST /api/ai-observability/bots/:botId/runs behind the root requireUser.
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
import type { AgentActor } from "../../agents/profile-types";
import type { AppVariables } from "../../auth/guards";
import { RunBindingError, type RunBindingStore } from "../bindings";
import { type BotManagementCheck, resolveObservationBot } from "../context";
import { type ObservationScope, ObservationScopeError } from "../contracts";
import {
  beginRunAttempt,
  parseRunObservationEvent,
  RunLifecycleError,
  type RunObservationEvent,
  resolveRunCapability,
} from "../run-lifecycle";
import { resolveObservationScope } from "../scope";

export type BasicRunDeps = Readonly<{
  canManageBot: BotManagementCheck;
  /** The ownership generation for the scope key; wiring supplies the live source. */
  scopeEpoch: (actor: AgentActor, botId: string) => Promise<number>;
  /** The accepted T07 trusted-association seam (Issue #13), injected. */
  bindings: Pick<RunBindingStore, "begin">;
  /** Binding expiry horizon. Default 7 days — the Spec's run-trace retention default. */
  bindingTtlMs?: number;
  now?: () => Date;
}>;

const DEFAULT_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BASIC_RUN_INPUT_INVALID = "BASIC_RUN_INPUT_INVALID";

type BasicRunReport = {
  threadId: string;
  runId: string;
  attemptId: string;
  traceId: string;
  events: RunObservationEvent[];
};

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
  return { ...refs, events: rawEvents.map(parseRunObservationEvent) };
}

export function createBasicRunRoutes(
  deps: BasicRunDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const ttl = deps.bindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
  const now = deps.now ?? (() => new Date());

  routes.post("/", async (context) => {
    const access = await resolveObservationBot(
      deps.canManageBot,
      context.var.actor,
      context.req.param("botId"),
    );
    if (!access.ok) return context.json({ error: access.error }, access.status);

    const actor = context.var.actor;
    // Ownership is answered from the same row the decision was made on; the epoch is
    // injected wiring, never a body value.
    const ownership =
      access.profile.ownerUserId === actor.id
        ? ("owner" as const)
        : ("admin" as const);
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

    // The remote AG-UI path is honest about what it cannot see: internal steps are
    // never verified here, so the verdict is basic or unavailable, never detailed.
    const capability = resolveRunCapability({
      internalStepsVerified: false,
      observedEvents: report.events.length > 0,
    });

    let bound: Awaited<ReturnType<RunBindingStore["begin"]>>;
    try {
      bound = await deps.bindings.begin(scope, {
        runId: report.runId,
        attemptId: report.attemptId,
        traceId: report.traceId,
        capability,
        expiresAt: new Date(now().getTime() + ttl),
      });
    } catch (error) {
      if (error instanceof RunBindingError) {
        return context.json({ error: error.code }, error.status);
      }
      throw error;
    }

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

    return context.json({
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
    });
  });

  return routes;
}
