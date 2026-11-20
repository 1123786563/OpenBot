import { createHash } from "node:crypto";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { resumePersonQuestion } from "../approvals/question-resume";
import {
  createApprovalQuestions,
  personQuestionSchema,
} from "../approvals/questions";
import { createApprovalService } from "../approvals/service";
import { createApprovalStore } from "../approvals/store";
import {
  type ApprovalCandidate,
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import {
  buildAgents,
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  registeredAgentFromRow,
} from "../copilot";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
  workItems,
} from "../db/schema";
import { createWorkQueue, parkedPersonalWork } from "../work/queue";
import { readExecutionAccess } from "./account-access";
import { PERSONAL_BOT_WORK } from "./bot-work";
import {
  decisionInvalidated,
  readDecisionAccess,
  runWithDecisionAccess,
} from "./decision-access";
import { ensureDecisionActor } from "./decision-actor";

const questionInput = personQuestionSchema.pick({
  question: true,
  why: true,
  parts: true,
});
const questionDefinition = {
  name: "ask_person",
  description:
    "Ask the workspace owner a question when their input is needed to continue.",
  parameters: z.toJSONSchema(questionInput),
};

const botRuntimeConfig = z.object({
  INTELLIGENCE_API_URL: z.url({ protocol: /^https?$/ }),
  INTELLIGENCE_GATEWAY_WS_URL: z.url({ protocol: /^wss?$/ }),
  CPK_INTELLIGENCE_API_KEY: z.string().min(1),
  BOT_MODEL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

type TurnOptions = Parameters<typeof createTurnRunner>[0];
type PersonalTool = {
  definition: HeadlessTool["definition"];
  resolve(
    args: unknown,
    owner: { ownerUserId: string; agentId: string },
  ): Promise<
    Pick<ApprovalCandidate, "effect" | "scope" | "target"> & {
      execute(execution: {
        runId: string;
        signal: AbortSignal;
      }): Promise<unknown>;
    }
  >;
};

function deployedTransport(database: Database) {
  const config = botRuntimeConfig.safeParse(process.env);
  if (!config.success)
    throw new Error(
      `Invalid Personal SaaS Bot runtime configuration: ${config.error.issues.map(({ path }) => path.join(".")).join(", ")}`,
    );
  const env = config.data;
  const intelligence = new CopilotKitIntelligence({
    apiUrl: env.INTELLIGENCE_API_URL,
    wsUrl: env.INTELLIGENCE_GATEWAY_WS_URL,
    apiKey: env.CPK_INTELLIGENCE_API_KEY,
  });
  const model = { provider: "openai", defaultModel: env.BOT_MODEL } as const;
  normalizeModelBaseUrls();
  chooseOpenAIApi(model);
  return {
    intelligence,
    runner: new IntelligenceAgentRunner({
      url: intelligence.ɵgetRunnerWsUrl(),
      authToken: intelligence.ɵgetRunnerAuthToken(),
    }),
    buildAgent: async ({
      ownerUserId,
      agentId,
    }: Parameters<TurnOptions["buildAgentFor"]>[0]) => {
      const [row] = await database
        .select({
          id: agents.id,
          name: agents.name,
          configuration: agents.configuration,
          type: agents.type,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
        })
        .from(personalWorkspaces)
        .innerJoin(
          personalWorkspaceDefaultBots,
          eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
        )
        .innerJoin(agents, eq(agents.id, personalWorkspaceDefaultBots.agentId))
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            eq(personalWorkspaces.ownerId, ownerUserId),
            eq(agents.id, agentId),
            eq(agents.type, "built_in"),
            isNull(agentProfiles.deletedAt),
          ),
        );
      const definition = row && registeredAgentFromRow(row);
      if (!definition) throw new Error("Personal Assistant is unavailable");
      const built = await buildAgents([definition], model, env.OPENAI_API_KEY);
      const agent = built[agentId];
      if (!agent) throw new Error("Personal Assistant could not start");
      return agent;
    },
  };
}

export function createPersonalBotRuntime(
  database: Database,
  options: {
    now?: () => number;
    transport?: Pick<TurnOptions, "intelligence" | "runner"> & {
      buildAgent: TurnOptions["buildAgentFor"];
    };
    /** Server-owned tool catalogue. Arguments from the Bot are resolved again after approval. */
    tools?: readonly PersonalTool[];
  } = {},
) {
  const now = options.now ?? Date.now;
  const { intelligence, runner, buildAgent } =
    options.transport ?? deployedTransport(database);
  const store = createApprovalStore(database, now);
  async function ownsBotThread(
    ownerUserId: string,
    agentId: string,
    threadId: string,
  ) {
    const [origin] = await database
      .select({ payload: workItems.payload })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, PERSONAL_BOT_WORK),
          eq(workItems.key, threadId),
          eq(workItems.accountId, ownerUserId),
        ),
      );
    return origin?.payload.botId === agentId;
  }

  const questions = createApprovalQuestions(
    database,
    async (question) => {
      if (
        !(await ownsBotThread(
          question.actorId,
          question.botId,
          question.threadId,
        ))
      )
        throw new ApprovalRefusedError(
          "That question does not belong to this Personal Assistant.",
        );
    },
    now,
  );
  const approvals = createApprovalService(store, questions);
  const queue = createWorkQueue(database, now);
  const tools = options.tools ?? [];

  async function callTool(
    tool: PersonalTool,
    args: unknown,
    owner: { ownerUserId: string; agentId: string },
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ) {
    const continuation = currentApprovalContext();
    if (!continuation)
      throw new ApprovalRefusedError("Missing tool call context.");
    signal.throwIfAborted();
    const { execute, ...target } = await tool.resolve(args, owner);
    const permit = await approvals.gate({
      ...target,
      actorId: owner.ownerUserId,
      botId: owner.agentId,
      toolRef: tool.definition.name,
      args,
    });
    if (permit && "replay" in permit) return permit.replay;
    await beforeDispatch?.();
    await store.checkDecisionAccess?.(owner.ownerUserId, continuation);
    signal.throwIfAborted();
    const result = await execute({ runId: continuation.runId, signal });
    await permit?.complete(result);
    return result;
  }

  async function askPerson(
    raw: unknown,
    actorId: string,
    botId: string,
    signal: AbortSignal,
  ) {
    const input = questionInput.parse(raw);
    const snapshot = currentApprovalContext();
    if (!snapshot) throw new ApprovalRefusedError("Missing tool call context.");
    const { threadId, runId, toolCallId, initiator } = snapshot;
    const key = createHash("sha256")
      .update(JSON.stringify([runId, toolCallId]))
      .digest("hex");
    await database.transaction(async (tx) => {
      const access = await readDecisionAccess(tx, actorId, now, {
        runId,
        threadId,
      });
      if (access?.kind !== "active")
        throw new ApprovalRefusedError(decisionInvalidated);
      signal.throwIfAborted();
      await tx
        .insert(workItems)
        .values({
          kind: "person.question",
          key,
          accountId: actorId,
          accountEpoch: access.epoch,
          payload: {
            ...input,
            actorId,
            botId,
            threadId,
            runId,
            initiator,
            mode: "completed_question",
          },
        })
        .onConflictDoNothing();
    });
    throw new HeadlessToolSuspension(
      "The Personal Assistant is waiting for your answer.",
      {
        kind: "person_question",
        requestId: key,
      },
    );
  }

  const runTurn = createTurnRunner({
    intelligence,
    runner,
    buildAgentFor: buildAgent,
    admission: async ({ ownerUserId, signal }) => {
      const access = await database.transaction((tx) =>
        readExecutionAccess(tx, ownerUserId, now),
      );
      if (access?.kind !== "active" || !signal)
        throw new Error("Workspace execution is unavailable");
      signal.throwIfAborted();
      await ensureDecisionActor(database, ownerUserId);
      return signal;
    },
    toolsForTurn: async (owner) => {
      if (
        !(await ownsBotThread(owner.ownerUserId, owner.agentId, owner.threadId))
      )
        return [];
      return [
        {
          definition: questionDefinition,
          execute: (args, { signal }) =>
            askPerson(args, owner.ownerUserId, owner.agentId, signal),
        },
        ...tools.map(
          (tool): HeadlessTool => ({
            definition: tool.definition,
            execute: (args, { signal }) => callTool(tool, args, owner, signal),
          }),
        ),
      ];
    },
  });

  async function continueTurn(
    account: string,
    threadId: string,
    run: () => Promise<{ replyText: string }>,
  ) {
    try {
      const answer = await run();
      await queue.finishParked(
        PERSONAL_BOT_WORK,
        account,
        threadId,
        answer.replyText,
      );
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
    }
  }

  async function sweepDecision(
    kind: "approval.resume" | "person.response",
    ready: Parameters<typeof parkedPersonalWork>[1],
    resume: (
      account: string,
      key: string,
      payload: unknown,
      epoch: number,
    ) => Promise<void>,
  ) {
    const owner = crypto.randomUUID();
    const [item] = await queue.claim({
      kind,
      owner,
      leaseMs: 15 * 60_000,
      ready: parkedPersonalWork(PERSONAL_BOT_WORK, ready),
    });
    if (!item?.authorization) return;
    const held = { kind, key: item.key, owner };
    try {
      await resume(
        item.authorization.accountId,
        item.key,
        item.payload,
        item.authorization.epoch,
      );
      await queue.finish(held);
    } catch (error) {
      await queue.release({
        ...held,
        delayMs: 0,
        reason: "Workspace decision could not continue.",
      });
      throw error;
    }
  }

  return {
    approvals,
    runTurn,
    async sweepDecisions() {
      await sweepDecision(
        "approval.resume",
        sql`(
        select ${approvalRequests.action}->>'threadId' from ${approvalRequests}
        where ${approvalRequests.id} = ${workItems.key}
          and ${approvalRequests.ownerUserId} = ${workItems.accountId}::text
      )`,
        async (account, key) => {
          const request = await store.get(account, key);
          const action = request.action;
          await runWithDecisionAccess(
            database,
            account,
            {
              runId: action.runId,
              createdAt: request.createdAt,
              epoch: action.executionEpoch,
            },
            async (execution) => {
              if (!execution.signal)
                throw new ApprovalRefusedError(
                  "Workspace execution is unavailable.",
                );
              const signal = execution.signal;
              const invoke = (current: typeof action) => {
                const snapshot = currentApprovalContext();
                const tool = tools.find(
                  ({ definition }) =>
                    definition.name === snapshot?.toolName &&
                    definition.name === current.toolRef,
                );
                if (!tool || !snapshot)
                  throw new ApprovalRefusedError(
                    "The approved tool is no longer available.",
                  );
                return callTool(
                  tool,
                  snapshot.args,
                  { ownerUserId: account, agentId: current.botId },
                  signal,
                  execution.beforeDispatch,
                );
              };
              await approvals.resume(account, key, {
                validate: (current) =>
                  approvals.validateReentry(current, () => invoke(current)),
                execute: invoke,
                continue: async ({ continuation, result, messageId }) => {
                  await continueTurn(account, continuation.threadId, () =>
                    runTurn({
                      ownerUserId: account,
                      agentId: action.botId,
                      routineId: "approval",
                      threadId: continuation.threadId,
                      instruction: "",
                      initiator: continuation.initiator,
                      continuation: {
                        snapshot: continuation,
                        result,
                        messageId,
                      },
                      ...execution,
                    }),
                  );
                },
              });
            },
            now,
          );
        },
      );
      await sweepDecision(
        "person.response",
        sql`${workItems.payload}->'question'->>'threadId'`,
        async (account, key, payload, epoch) => {
          const { question, response } = z
            .object({
              question: personQuestionSchema,
              response: z.string(),
            })
            .parse(payload);
          await runWithDecisionAccess(
            database,
            account,
            {
              runId: question.runId,
              threadId: question.threadId,
              epoch,
            },
            (execution) =>
              continueTurn(account, question.threadId, () =>
                resumePersonQuestion({
                  ownerUserId: account,
                  question,
                  response,
                  messageId: `person-response:${key}`,
                  runTurn,
                  ...execution,
                }),
              ),
            now,
          );
        },
      );
    },
  };
}
