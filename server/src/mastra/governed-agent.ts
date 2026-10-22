import type { BaseEvent } from "@ag-ui/client";
import { defer, type Observable } from "rxjs";
import type { PlatformScope } from "../enterprise/contracts";
import { runMastraExecution } from "./execution";
import type { ExecutionRequest } from "./execution-contracts";

/*
 * ME02 (#474) T5: the governed Mastra execution — the ONLY execution entry.
 *
 * The only model ever injected is `request.governedModel.model`, the existing
 * gateway adapter: per-call capabilities minted against the admitted
 * {scope, run, attempt, generation, route, ceiling}, with the gateway's own
 * confirmUsage/markUnknown rules as the settlement authority. Nothing here
 * reads Mastra's usage as authoritative, nothing constructs a provider client
 * from strings, and no client-visible field can select the engine, the route
 * or the run identity — engine selection is server-side by construction.
 *
 * The maxOutputTokens ceiling comes from the governed collaborator; the
 * adapter inside it narrows each step to the run's remaining budget, so a
 * 100-token run that already settled 70 can only ask for 30 next.
 *
 * A 402 budget refusal and malformed usage fail the run through the same
 * failure taxonomy as every governed path (`classifyGovernedRunFailure` keys
 * on the carrier and the markers the stream carries verbatim inside the
 * wrapped RUN_ERROR message).
 */

export class MastraGovernedExecutionRefusal extends Error {}

/**
 * Every PlatformScope field the admission identity covers, frozen next to the
 * comparison that consumes it. The contract's policy is extend-never-rename,
 * so a future eighth field must enter THIS comparison without anyone
 * remembering to edit it: the key set is checked against the type (`satisfies`
 * refuses an unknown key), and `every` refuses nothing new.
 */
const SCOPE_IDENTITY_FIELDS = [
  "tenantId",
  "workspaceId",
  "principalId",
  "actorId",
  "memberEpoch",
  "aclEpoch",
  "entrypoint",
] as const satisfies readonly (keyof PlatformScope)[];

/**
 * Field-wise PlatformScope identity: all seven contract fields must agree —
 * tenant, workspace, principal, actor, both authorization epochs and the
 * entrypoint. A stale epoch or a different actor is a different admission,
 * exactly as a different tenant is. Never an object identity check: the
 * production path passes the same reference (`copilot.ts` binds
 * `scope: facts.scope`), so this gate is defense in depth.
 */
function scopeIdentityEquals(
  facts: PlatformScope,
  binding: PlatformScope,
): boolean {
  return SCOPE_IDENTITY_FIELDS.every(
    (field) => facts[field] === binding[field],
  );
}

/**
 * Validate the governed request before anything runs.
 *
 * The governed model collaborator is required — an execution without one is
 * not governed and refuses rather than improvising. When the collaborator
 * carries the carrier's execution facts (the production governed admission),
 * the request binding must be exactly those facts: a binding that disagrees
 * with the admission is refused, not reconciled.
 */
function governedRequest(request: ExecutionRequest): ExecutionRequest {
  const governed = request.governedModel;
  if (
    !governed ||
    typeof governed.markConsumed !== "function" ||
    !governed.model
  ) {
    throw new MastraGovernedExecutionRefusal(
      "EXECUTION_GOVERNED_MODEL_REQUIRED",
    );
  }
  // typeof-guarded like markConsumed above: a malformed cross-package object
  // carrying a truthy non-function stays a NAMED refusal (below), never a
  // bare TypeError from calling it.
  const facts =
    typeof governed.executionBinding === "function"
      ? governed.executionBinding()
      : null;
  if (!facts) {
    // Whether the method is missing or it reports an unbound admission: a
    // collaborator that publishes no execution facts cannot prove the
    // admission identity, and `request.binding` (which decides the Mastra
    // run id, the event runId and the botId) is refused rather than trusted.
    // Fail closed, never guess.
    throw new MastraGovernedExecutionRefusal("EXECUTION_BINDING_UNBOUND");
  }
  if (
    facts.runId !== request.binding.runId ||
    facts.attemptId !== request.binding.attemptId ||
    facts.generation !== request.binding.generation ||
    facts.botId !== request.binding.botId ||
    // The engine execution identity and the scope are published facts too:
    // the executionKey is what `agent.stream({ runId })` actually runs
    // under, and a scope disagreement is a different tenancy. Field-wise
    // comparison — never an object identity check.
    facts.executionKey !== request.binding.executionKey ||
    !scopeIdentityEquals(facts.scope, request.binding.scope)
  ) {
    throw new MastraGovernedExecutionRefusal("EXECUTION_BINDING_MISMATCH");
  }
  if (request.resume) {
    // Continuations are ME05's slice; a request claiming one today is out of
    // contract and refuses instead of silently starting a fresh run.
    throw new MastraGovernedExecutionRefusal("EXECUTION_RESUME_UNSUPPORTED");
  }
  return request;
}

/**
 * Execute one admitted run through Mastra under the governed model.
 *
 * Cold: subscription is the only thing that starts the engine, and the
 * request signal is consumed before any model or tool runs.
 */
export function executeGovernedMastra(
  request: ExecutionRequest,
): Observable<BaseEvent> {
  // defer: the governed validation runs at subscription time, so a refusal
  // surfaces as a stream error and nothing starts when nobody listens.
  return defer(() => runMastraExecution(governedRequest(request)));
}
