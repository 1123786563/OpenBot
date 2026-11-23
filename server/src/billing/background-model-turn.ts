import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";
import { readSubagentResult, SUBAGENT_TOOL } from "@openbot/shared/subagent";
import { withApprovalContext } from "@openbot/toolkit/continuation";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { AuditInitiator } from "@openbot/toolkit/initiator";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { providerSafeSchema } from "@openbot/toolkit/tool-schema";
import { concatMap, defer, from, Observable } from "rxjs";
import { z } from "zod";
import { fitToolLimit } from "../agents/tool-search";
import {
  type BackgroundModel,
  type BackgroundModelScope,
  BackgroundModelWaiting,
  backgroundModelOperationId,
} from "./background-model";
import { coordinationToolName } from "./coordination-model-call";

export type BudgetedCoordination = (run: {
  runId: string;
  threadId: string;
  budgetId: string;
  operationId: string;
}) => Promise<GrantedTool[]>;

export function budgetedAgent(
  model: BackgroundModel | undefined,
  scope: BackgroundModelScope,
  authorize: () => Promise<void>,
  coordinate?: BudgetedCoordination,
  signal?: AbortSignal,
  connectedTools?: () => Promise<GrantedTool[]>,
  initiator?: AuditInitiator,
) {
  const step = "reply";
  const operationId = backgroundModelOperationId(scope, step);
  if (!model) throw new BackgroundModelWaiting(operationId, "not_authorized");
  let waiting: BackgroundModelWaiting | undefined;

  const agent = new (class extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable((subscriber) => {
        const lifetime = new AbortController();
        const activeSignal = signal
          ? AbortSignal.any([signal, lifetime.signal])
          : lifetime.signal;
        const authorizeRun = async () => {
          activeSignal.throwIfAborted();
          await authorize();
          activeSignal.throwIfAborted();
        };
        const stream = defer(async () => {
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
            const run = {
              runId: input.runId,
              threadId: input.threadId,
              budgetId: scope.budgetId,
              operationId,
            };
            const offersTools =
              (coordinate || connectedTools) &&
              (await model.offersCoordination());
            const coordination =
              coordinate && offersTools ? await coordinate(run) : [];
            const coordinatedNames = new Set(
              coordination.map(({ name }) => name),
            );
            const loadConnected = async () =>
              ((await connectedTools?.()) ?? []).filter(
                ({ name }) => !coordinatedNames.has(name),
              );
            const tools = fitToolLimit(
              [
                ...coordination,
                ...(offersTools
                  ? (await loadConnected()).filter(
                      ({ name }) =>
                        coordinationToolName.safeParse(name).success,
                    )
                  : []),
              ],
              {
                limit: MODEL_TOOL_LIMIT,
                text:
                  messages.findLast(({ role }) => role === "user")?.content ??
                  "",
              },
            );
            const result = await model.completeTurn(scope, {
              step,
              messages,
              authorize: authorizeRun,
              coordinationTools: tools.map(
                ({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters: providerSafeSchema(z.toJSONSchema(parameters)),
                }),
              ),
            });
            let text = result.text;
            if (
              !text &&
              result.calls?.some(({ name }) => !coordinatedNames.has(name)) &&
              connectedTools
            ) {
              const calls = result.calls;
              const current = new Map(
                (await loadConnected()).map((tool) => [tool.name, tool]),
              );
              const selected = calls.map((call) => {
                const tool = current.get(call.name);
                if (!tool)
                  throw new BackgroundModelWaiting(
                    operationId,
                    "tool_unavailable",
                  );
                return { call, tool };
              });
              const toolCalls = calls.map(({ id, name, arguments: args }) => ({
                id,
                type: "function" as const,
                function: { name, arguments: args },
              }));
              const outputs = [];
              for (const { call, tool } of selected) {
                let args: unknown;
                try {
                  args = JSON.parse(call.arguments);
                } catch {
                  args = null;
                }
                const parsed = tool.parameters.safeParse(args);
                const content = await model.completeTool(scope, {
                  operationId,
                  call,
                  toolRef: tool.ref,
                  authorize: authorizeRun,
                  execute: () =>
                    parsed.success
                      ? withApprovalContext(
                          {
                            runId: operationId,
                            threadId: input.threadId,
                            toolCallId: `${operationId}-${call.id}`,
                            toolName: tool.name,
                            args: parsed.data,
                            messages: input.messages,
                            state: input.state,
                            context: input.context,
                            forwardedProps: input.forwardedProps,
                            initiator,
                            budgeted: true,
                          },
                          () =>
                            tool.execute(parsed.data, {
                              toolCallId: `${operationId}-${call.id}`,
                              signal: activeSignal,
                            }),
                        )
                      : Promise.resolve(
                          "The connected tool received invalid arguments.",
                        ),
                });
                outputs.push({
                  role: "tool" as const,
                  tool_call_id: call.id,
                  content,
                });
              }
              text = await model.complete(scope, {
                step: "tool-follow-up",
                previousSteps: [step],
                messages: [
                  ...messages,
                  { role: "assistant", tool_calls: toolCalls },
                  ...outputs,
                ],
                authorize: authorizeRun,
              });
            } else if (!text) {
              const execute = new Map(
                (result.calls && coordinate
                  ? await coordinate({ ...run, budgetId: result.budgetId })
                  : []
                ).map((tool) => [tool.name, tool]),
              );
              const outcomes = await Promise.all(
                (result.calls ?? []).map(async (call) => {
                  const tool = execute.get(call.name);
                  if (!tool)
                    return "The coordination tool is no longer available.";
                  await authorizeRun();
                  let args: unknown;
                  try {
                    args = JSON.parse(call.arguments);
                  } catch {
                    return "The coordination tool received invalid arguments.";
                  }
                  const parsed = tool.parameters.safeParse(args);
                  if (!parsed.success)
                    return "The coordination tool received invalid arguments.";
                  const output = await tool.execute(parsed.data, {
                    toolCallId: `${operationId}-${call.id}`,
                    signal: activeSignal,
                  });
                  const subagent =
                    tool.name === SUBAGENT_TOOL
                      ? readSubagentResult(output)
                      : null;
                  if (!subagent) return output;
                  if ("answer" in subagent) return subagent.answer;
                  return "error" in subagent ? subagent.error : subagent.next;
                }),
              );
              text = outcomes.join("\n\n");
            }
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
        })
          .pipe(concatMap((events) => from(events)))
          .subscribe(subscriber);
        return () => {
          lifetime.abort();
          stream.unsubscribe();
        };
      });
    }
  })();
  return { agent, failure: () => waiting };
}

type CoordinationTurn = {
  kind: "subagent";
  executionId: string;
  parentRunId: string;
};

export function budgetedTurn(
  model: BackgroundModel | undefined,
  kind: "routine" | "task" | CoordinationTurn,
  makeRunner: (agent: AbstractAgent) => TurnRunner,
  authorize: (turn: Parameters<TurnRunner>[0]) => Promise<void>,
  fallback: TurnRunner,
  coordinate?: (
    turn: Parameters<TurnRunner>[0],
    run: Parameters<BudgetedCoordination>[0],
  ) => ReturnType<BudgetedCoordination>,
  connectedTools?: (turn: Parameters<TurnRunner>[0]) => Promise<GrantedTool[]>,
): TurnRunner {
  return async (turn) => {
    if (!turn.budget) return fallback(turn);
    const context = { budgetId: turn.budget.id, personId: turn.ownerUserId };
    const scope: BackgroundModelScope =
      typeof kind === "string"
        ? {
            ...context,
            kind,
            executionId: turn.budget.stepId ?? turn.routineId,
          }
        : { ...context, ...kind, botId: turn.agentId };
    const { agent, failure } = budgetedAgent(
      model,
      scope,
      async () => {
        if (turn.signal?.aborted)
          throw new Error("The headless turn was cancelled.");
        await authorize(turn);
      },
      coordinate ? (run) => coordinate(turn, run) : undefined,
      turn.signal,
      connectedTools ? () => connectedTools(turn) : undefined,
      turn.initiator,
    );
    try {
      const result = await makeRunner(agent)(turn);
      if (failure()) throw failure();
      return result;
    } catch (error) {
      throw failure() ?? error;
    }
  };
}
