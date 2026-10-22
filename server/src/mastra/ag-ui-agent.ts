import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { Observable, throwError } from "rxjs";
import type { GovernedModelRequest } from "../enterprise/runs/governed-execution";
import type { GrantedTool } from "../plugins/tools";
import type {
  ExecuteMastra,
  ExecutionBinding,
  ExecutionRequest,
  FrontendToolDefinition,
  LearnedSkillInvocationSurface,
} from "./execution-contracts";

/*
 * ME02 (#474) T3: the AbstractAgent the existing runtime and runner consume.
 *
 * The adapter owns exactly one thing: turning the runtime's `run(input)`
 * subscription into one execution request against the server-issued binding,
 * and relaying the canonical events back. It keeps no run state, settles
 * nothing and stops nothing:
 *  - the business Run (lease, persistence, settlement, stop) stays with the
 *    governed runner — the adapter never cancels it on unsubscribe;
 *  - the engine signal IS released on transport teardown, which is the
 *    existing transport contract (the stream that nobody listens to stops
 *    dialling; the runner's finalize owns the truthful settlement);
 *  - `clone` keeps the same binding and hands out fresh abort wiring — the
 *    runtime clones an agent before every run, and a copied live subscription
 *    would be a second consumer of one execution.
 */

/** Server-owned execution inputs completed onto every ExecutionRequest. */
export interface MastraExecutionCompletion {
  readonly instructions?: readonly string[];
  /** Trusted parts that compose after the unconditional guidance blocks. */
  readonly trailingInstructions?: readonly string[];
  readonly tools?: readonly GrantedTool[];
  /**
   * ME06: the client-declared participation tools this run relays (inert
   * bridges on the engine); composed server-side, never by the wire.
   */
  readonly frontendTools?: readonly FrontendToolDefinition[];
  /**
   * ME08: the outer run's validated learned-skill invocation; composed
   * server-side (the acquisition the legacy engine already performed), never
   * by the wire. Mounted through the ME04 controlled wrapper shape.
   */
  readonly learnedSkills?: LearnedSkillInvocationSurface;
  /**
   * ME07: the rendered personal-memory block for this run's trusted scope —
   * the #395 consumer's answer, composed server-side, never by the wire.
   */
  readonly personalMemoryContext?: string;
  /** Required: an execution without one is not governed and must not run. */
  readonly governedModel: GovernedModelRequest;
}

export interface MastraAgUiAgentOptions {
  readonly execute: ExecuteMastra;
  readonly binding: ExecutionBinding;
  readonly completion?: MastraExecutionCompletion;
}

export class MastraAgUiAgent extends AbstractAgent {
  private readonly options: MastraAgUiAgentOptions;

  constructor(options: MastraAgUiAgentOptions) {
    super({
      agentId: options.binding.botId,
      description: options.binding.botId,
    });
    this.options = options;
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    const { execute, binding, completion } = this.options;
    // Fail through the Observable error channel, not a synchronous throw:
    // an Observable API reports subscription-time failures to its subscribers,
    // and a caller that forgets to wrap the call in try/catch must still see
    // the refusal (a sync throw would leak as an unhandled exception instead).
    if (!completion?.governedModel) {
      return throwError(
        () => new Error("MASTRA_AGENT_GOVERNED_MODEL_REQUIRED"),
      );
    }
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      const request: ExecutionRequest = {
        binding,
        input,
        instructions: completion.instructions ?? [],
        trailingInstructions: completion.trailingInstructions ?? [],
        tools: completion.tools ?? [],
        ...(completion.frontendTools
          ? { frontendTools: completion.frontendTools }
          : {}),
        ...(completion.learnedSkills
          ? { learnedSkills: completion.learnedSkills }
          : {}),
        ...(completion.personalMemoryContext
          ? { personalMemoryContext: completion.personalMemoryContext }
          : {}),
        governedModel: completion.governedModel,
        signal: controller.signal,
      };
      const subscription = execute(request).subscribe({
        next: (event) => subscriber.next(event),
        error: (cause) => subscriber.error(cause),
        complete: () => subscriber.complete(),
      });
      return () => {
        subscription.unsubscribe();
        // Transport teardown: release the engine stream. This is NOT a
        // product cancel — the adapter holds no lease and writes no run
        // state; the runner's finalize path owns what the business run
        // becomes after the transport went away.
        controller.abort(new Error("MASTRA_TRANSPORT_UNSUBSCRIBED"));
      };
    });
  }

  /**
   * Carried by hand because `AbstractAgent.clone` builds a bare object: the
   * clone must keep the same execute/binding/completion (identity does not
   * drift) while owning fresh subscription state — never a copy of a live
   * execution.
   */
  override clone(): MastraAgUiAgent {
    return new MastraAgUiAgent(this.options);
  }
}

/**
 * Build the AbstractAgent for one server-issued binding. `completion` carries
 * the server-owned inputs the ExecutionRequest requires (trusted instructions,
 * granted tools, the governed model collaborator); the runtime and the wire
 * cannot supply any of them.
 */
export function createMastraAgUiAgent(
  execute: ExecuteMastra,
  binding: ExecutionBinding,
  completion?: MastraExecutionCompletion,
): AbstractAgent {
  return new MastraAgUiAgent({
    execute,
    binding,
    ...(completion ? { completion } : {}),
  });
}

/**
 * Bridge one execution's event observable into the async-iterable shape the
 * BuiltInAgent custom-factory contract consumes.
 *
 * The abort signal tears the subscription down (transport teardown releases
 * the engine stream — the adapter's own contract), and it is raced with the
 * queue so a stream that stalls still stops on abort.
 */
export async function* observableToAsyncIterable(
  source: Observable<BaseEvent>,
  signal: AbortSignal,
): AsyncGenerator<BaseEvent> {
  interface Queued {
    event?: BaseEvent;
    error?: unknown;
    done?: boolean;
  }
  const queue: Queued[] = [];
  let notify: (() => void) | undefined;
  const wake = () => {
    const current = notify;
    notify = undefined;
    current?.();
  };
  const subscription = source.subscribe({
    next: (event) => {
      queue.push({ event });
      wake();
    },
    error: (cause) => {
      queue.push({ error: cause });
      wake();
    },
    complete: () => {
      queue.push({ done: true });
      wake();
    },
  });
  const onAbort = () => {
    queue.push({ done: true });
    wake();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const queued = queue.shift();
      if (!queued) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      // Key presence, not value truthiness: a subscriber that errored with
      // `undefined` still terminated the subscription, and treating that
      // entry as empty would swallow the error and hang the generator until
      // abort — with the failure lost entirely.
      if ("error" in queued) throw queued.error;
      if (queued.done) return;
      if (queued.event) yield queued.event;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    subscription.unsubscribe();
  }
}
