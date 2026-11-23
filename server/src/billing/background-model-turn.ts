import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { concatMap, defer, from, type Observable } from "rxjs";
import {
  type BackgroundModel,
  type BackgroundModelScope,
  BackgroundModelWaiting,
  backgroundModelOperationId,
} from "./background-model";

export function budgetedTurn(
  model: BackgroundModel | undefined,
  kind: BackgroundModelScope["kind"],
  makeRunner: (agent: AbstractAgent) => TurnRunner,
  authorize: (turn: Parameters<TurnRunner>[0]) => Promise<void>,
  fallback: TurnRunner,
): TurnRunner {
  return async (turn) => {
    if (!turn.budget) return fallback(turn);
    const scope: BackgroundModelScope = {
      kind,
      executionId: turn.budget.stepId ?? turn.routineId,
      budgetId: turn.budget.id,
      personId: turn.ownerUserId,
    };
    const step = "reply";
    const operationId = backgroundModelOperationId(scope, step);
    if (!model) throw new BackgroundModelWaiting(operationId, "not_authorized");
    let waiting: BackgroundModelWaiting | undefined;

    const agent = new (class extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return defer(async () => {
          const started = {
            type: EventType.RUN_STARTED as const,
            threadId: input.threadId,
            runId: input.runId,
          };
          try {
            const messages = input.messages.flatMap((message) => {
              if (
                (message.role === "user" ||
                  message.role === "assistant" ||
                  message.role === "system") &&
                typeof message.content === "string" &&
                message.content.trim()
              )
                return [{ role: message.role, content: message.content }];
              return [];
            });
            const text = await model.complete(scope, {
              step,
              messages,
              authorize: async () => {
                if (turn.signal?.aborted)
                  throw new Error("The headless turn was cancelled.");
                await authorize(turn);
              },
            });
            const messageId = `${operationId}-reply`;
            const events: BaseEvent[] = [
              started,
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              },
              { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
              { type: EventType.TEXT_MESSAGE_END, messageId },
              {
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
              },
            ];
            return events;
          } catch (error) {
            if (!(error instanceof BackgroundModelWaiting)) throw error;
            waiting = error;
            const events: BaseEvent[] = [
              started,
              { type: EventType.RUN_ERROR, message: error.message },
            ];
            return events;
          }
        }).pipe(concatMap((events) => from(events)));
      }
    })();
    try {
      return await makeRunner(agent)(turn);
    } catch (error) {
      throw waiting ?? error;
    }
  };
}
