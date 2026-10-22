import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { describe, expect, it } from "../../tests/support/bun-test-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type { GovernedModelRequest } from "../src/enterprise/runs/governed-execution";
import { createMastraAgUiAgent } from "../src/mastra/ag-ui-agent";
import type {
  ExecutionBinding,
  ExecutionRequest,
} from "../src/mastra/execution-contracts";

/*
 * ME02 (#474) T3: the AbstractAgent adapter the existing runtime and runner
 * consume. Contracts under test: a clone keeps the same server binding and
 * fresh abort wiring (never copying a live subscription), and unsubscribing
 * the transport never cancels the business run — the adapter owns no lease,
 * no settlement and no stop; only the engine signal is released on teardown,
 * which is the existing transport contract.
 */

function bindingFor(runId: string): ExecutionBinding {
  const scope: PlatformScope = {
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    actorId: "actor-1",
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
  };
  return {
    scope,
    botId: "bot-a",
    runId,
    attemptId: `attempt-${runId}`,
    generation: 1,
    executionKey: `exec-key-${runId}`,
  };
}

interface RecordedRequest {
  readonly binding: ExecutionBinding;
  readonly signal: AbortSignal;
}

function textEvent(delta: string): BaseEvent {
  return {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m1",
    delta,
  } as unknown as BaseEvent;
}

/**
 * The completion the server wiring always carries: the governed collaborator
 * is required — run() refuses without it rather than fabricating a
 * placeholder model and a no-op consumption mark.
 */
function governedCompletion(): {
  instructions: readonly string[];
  tools: never[];
  governedModel: GovernedModelRequest;
} {
  return {
    instructions: [],
    tools: [],
    governedModel: {
      // The execute stub below never dials the model; the request only has
      // to carry the required collaborator.
      model: {} as GovernedModelRequest["model"],
      maxOutputTokens: 128,
      markConsumed: () => {},
    },
  };
}

function recordingExecute(
  events: BaseEvent[],
  holdOpen?: (recorded: RecordedRequest) => Promise<void>,
): {
  execute: (request: ExecutionRequest) => Observable<BaseEvent>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    execute: (request) =>
      new Observable<BaseEvent>((subscriber) => {
        requests.push({ binding: request.binding, signal: request.signal });
        for (const event of events) subscriber.next(event);
        void (
          holdOpen?.(requests[requests.length - 1]!) ?? Promise.resolve()
        ).then(
          () => subscriber.complete(),
          () => subscriber.complete(),
        );
      }),
  };
}

function collect(observable: Observable<BaseEvent>): {
  values: BaseEvent[];
  done: Promise<void>;
  dispose: () => void;
} {
  const values: BaseEvent[] = [];
  let doneResolver: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolver = resolve;
  });
  const subscription = observable.subscribe({
    next: (event) => values.push(event),
    complete: () => doneResolver(),
    error: () => doneResolver(),
  });
  return { values, done, dispose: () => subscription.unsubscribe() };
}

describe("mastra AG-UI agent adapter", () => {
  it("clone_keeps_binding_and_abort", async () => {
    const binding = bindingFor("server-run-1");
    const { execute, requests } = recordingExecute([textEvent("hi")]);
    const agent = createMastraAgUiAgent(execute, binding, governedCompletion());
    const first = collect(agent.run(inputFor()));
    await first.done;
    expect(first.values.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_CONTENT",
    ]);

    const cloned = agent.clone();
    const second = collect(cloned.run(inputFor()));
    await second.done;
    // The clone ran against the same server-issued binding: identity does not
    // drift across the runtime's per-run clones.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.binding).toBe(binding);
    expect(requests[1]!.binding.executionKey).toBe("exec-key-server-run-1");
    // Each run received fresh abort wiring (a distinct signal), never the
    // source's live subscription state.
    expect(requests[0]!.signal).not.toBe(requests[1]!.signal);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(true);
  });

  it("unsubscribe_does_not_cancel_run", async () => {
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { execute, requests } = recordingExecute(
      [textEvent("partial")],
      () => gate,
    );
    const agent = createMastraAgUiAgent(
      execute,
      bindingFor("server-run-9"),
      governedCompletion(),
    );
    const collected = collect(agent.run(inputFor()));
    // Give the subscription a tick to start, then tear the transport down.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const signalDuringRun = requests[0]!.signal;
    expect(signalDuringRun.aborted).toBe(false);
    collected.dispose();
    // The transport teardown releases the ENGINE signal (the existing
    // transport contract)…
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(signalDuringRun.aborted).toBe(true);
    // …but the adapter fabricated no business terminal of its own: no
    // RUN_ERROR, no RUN_FINISHED — the run's settlement is not the
    // adapter's to decide. Cancelling the business run stays with the
    // runner, which owns the lease and the stop.
    const terminal = collected.values.find(
      (event) => event.type === "RUN_ERROR" || event.type === "RUN_FINISHED",
    );
    expect(terminal).toBeUndefined();
    released();
  });

  it("run_without_governed_model_fails_through_the_error_channel", () => {
    // No placeholder model, no no-op markConsumed: a completion that lacks
    // the governed collaborator is a wiring bug, and the adapter refuses it
    // with the explicit marker the wiring bug can be grepped for. The refusal
    // rides the Observable error channel (never a synchronous throw), so a
    // caller without its own try/catch still sees the failure at subscribe.
    const { execute, requests } = recordingExecute([textEvent("hi")]);
    const agent = createMastraAgUiAgent(execute, bindingFor("server-run-2"));
    const errors: unknown[] = [];
    agent.run(inputFor()).subscribe({
      error: (cause) => errors.push(cause),
    });
    expect(String(errors[0])).toContain("MASTRA_AGENT_GOVERNED_MODEL_REQUIRED");
    expect(requests).toHaveLength(0);
  });
});

function inputFor() {
  return {
    threadId: "thread-1",
    runId: "client-run-1",
    messages: [{ id: "msg-1", role: "user" as const, content: "hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}
