import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import { createAuditStore } from "../audit";
import { personSeat } from "../computer/computer-key";
import {
  ComputerUnavailableError,
  createComputerGateway,
} from "../computer/gateway";
import { createHeadlessComputerTools } from "../computer/headless-tools";
import type { ActionPolicy } from "../computer/policy";
import type { Database } from "../db/client";
import { localAbortLeadMs } from "../work/execution";
import { createWorkQueue } from "../work/queue";
import { readExecutionAccess } from "./account-access";
import { PERSONAL_BOT_WORK, type workspaceQuotas } from "./quotas";
import {
  botRunCreditQuote,
  type PersonalTestCreditExecution,
} from "./test-credit";
import { assistantTarget, workspaceBots } from "./workspace-bots";
import {
  type workspaceComputer,
  workspaceComputerRestartMessage,
} from "./workspace-computer";

export { PERSONAL_BOT_WORK } from "./quotas";
export const botWorkInput = assistantTarget.extend({
  instruction: z.string().trim().min(1).max(20_000),
  requiresComputer: z.boolean().optional(),
});
export const queuedBotWorkInput = botWorkInput.extend({
  testCredit: botRunCreditQuote.optional(),
});

const workspaceFileTools = [
  "computer_list_files",
  "computer_read_file",
  "computer_write_file",
];
const workspaceFilePolicy: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: workspaceFileTools.map((name) => `tool.name == "${name}"`),
};

export const recoveryInput = z.strictObject({
  action: z.enum(["cancel", "retry"]),
  acknowledged: z.boolean().default(false),
});

export function personalBotWork(
  database: Database,
  now: () => number,
  quotas: ReturnType<typeof workspaceQuotas>,
  accessComputer?: ReturnType<typeof workspaceComputer>["accessForTask"],
) {
  const queue = createWorkQueue(database, now);
  const leaseMs = 65_000;
  const auditStore = createAuditStore(database);
  return {
    async history(accountId: string) {
      await queue.reconcilePersonalWork(PERSONAL_BOT_WORK, accountId);
      return (await queue.interrupted(PERSONAL_BOT_WORK, accountId)).flatMap(
        (row) => {
          const request = botWorkInput.safeParse(row.payload);
          if (!row.interruption || !request.success) return [];
          return [
            {
              key: row.key,
              instruction: request.data.instruction,
              output: row.output,
              ...row.interruption,
              recovery: row.recovery,
            },
          ];
        },
      );
    },
    async sweep(
      runTurn?: TurnRunner,
      executeManaged?: PersonalTestCreditExecution,
    ) {
      await queue.reconcilePersonalWork(PERSONAL_BOT_WORK);
      if (!runTurn && !executeManaged) return false;
      const owner = randomUUID();
      const [item] = await queue.claim({
        kind: PERSONAL_BOT_WORK,
        owner,
        leaseMs,
        mayClaim: (tx, row) =>
          row.accountId !== null && quotas.mayClaim(tx, row.accountId),
      });
      if (!item?.authorization) return false;
      const grant = item.authorization;
      const held = { kind: item.kind, key: item.key, owner };
      const controller = new AbortController();
      let expiresAt = grant.expiresAt;
      let localCutoffAt: number | undefined;
      let endedAt: number | undefined;
      let computerBlocked = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      let output: string | undefined;
      let checkpoint: Promise<void> | undefined;

      function saveOutput(text: string) {
        if (controller.signal.aborted) return;
        if (now() >= expiresAt) {
          localCutoffAt = expiresAt;
          controller.abort();
          return;
        }
        output = text;
        if (checkpoint) return;
        checkpoint = (async () => {
          while (output !== undefined) {
            const snapshot = output;
            output = undefined;
            await queue.checkpoint(held, snapshot);
          }
        })()
          .catch(() => controller.abort())
          .finally(() => {
            checkpoint = undefined;
          });
      }

      function enforceDeadline() {
        clearTimeout(deadline);
        function expire() {
          localCutoffAt = expiresAt;
          controller.abort();
        }
        const remainingMs = expiresAt - localAbortLeadMs - now();
        if (remainingMs <= 0) expire();
        else deadline = setTimeout(expire, remainingMs);
      }

      async function recheck() {
        try {
          const access = await database.transaction((tx) =>
            readExecutionAccess(tx, grant.accountId, now, grant.epoch),
          );
          if (done || controller.signal.aborted) return;
          if (
            now() >= expiresAt ||
            access?.kind !== "active" ||
            !(await queue.renew({ ...held, leaseMs }))
          ) {
            controller.abort();
            return;
          }
          if (done || controller.signal.aborted) return;
          if (now() >= expiresAt) {
            controller.abort();
            return;
          }
          expiresAt = access.expiresAt;
          enforceDeadline();
        } catch {
          // A failed check cannot extend the locally enforced grant.
        }
        if (!done && !controller.signal.aborted)
          poll = setTimeout(recheck, 1_000);
      }

      enforceDeadline();
      poll = setTimeout(recheck, 1_000);
      try {
        const work = queuedBotWorkInput.parse(item.payload);
        const bot = await workspaceBots(database).get({
          ...work,
          accountId: grant.accountId,
        });
        if (!bot) throw new Error("Personal Assistant is unavailable");
        controller.signal.throwIfAborted();
        const access = await database.transaction((tx) =>
          readExecutionAccess(tx, grant.accountId, now, grant.epoch),
        );
        if (access?.kind !== "active" || now() >= expiresAt) controller.abort();
        controller.signal.throwIfAborted();
        async function checkExecution() {
          controller.signal.throwIfAborted();
          const access = await database.transaction((tx) =>
            readExecutionAccess(tx, grant.accountId, now, grant.epoch),
          );
          if (
            access?.kind !== "active" ||
            now() >= expiresAt ||
            !(await queue.renew({ ...held, leaseMs }))
          )
            controller.abort();
          controller.signal.throwIfAborted();
        }

        if (work.testCredit || executeManaged) {
          if (!work.testCredit || !executeManaged || work.requiresComputer)
            throw new Error("Managed execution unavailable for this request");
          const text = await executeManaged({
            accountId: grant.accountId,
            operationId: item.key,
            instruction: work.instruction,
            quote: work.testCredit,
            checkExecution,
            signal: controller.signal,
          }).finally(() => {
            endedAt = now();
          });
          if (text === undefined)
            throw new Error("Managed execution unavailable");
          await checkExecution();
          saveOutput(text);
          await checkpoint;
          if (!controller.signal.aborted && (await queue.finish(held)))
            return true;
          throw new Error("Managed execution stopped");
        }
        if (!runTurn) throw new Error("Bot execution unavailable");

        async function connectComputer() {
          await checkExecution();
          const computer = await accessComputer?.(work.workspaceId, {
            ...grant,
            expiresAt,
          }).catch(() => undefined);
          if (now() >= expiresAt) enforceDeadline();
          controller.signal.throwIfAborted();
          if (computer?.kind !== "running")
            throw new ComputerUnavailableError(workspaceComputerRestartMessage);
          return { url: computer.address, token: computer.token };
        }

        const initiator = { kind: "routine", id: item.key } as const;
        const additionalTools = work.requiresComputer
          ? createHeadlessComputerTools({
              gateway: createComputerGateway({
                provider: {
                  name: "workspace-computer",
                  isolation: "per-person",
                  locate: async () => (await connectComputer()).url,
                  status: async ({ botId }) => ({
                    botId,
                    state: "unreachable",
                  }),
                  stop: async () => ({ wasRunning: false }),
                  reset: async () => ({ cleared: false }),
                  list: async () => [],
                },
                connect: connectComputer,
                signal: controller.signal,
                auditStore,
                policy: () => workspaceFilePolicy,
              }),
              seat: personSeat(work.workspaceId, bot.id),
              actor: { id: grant.accountId, initiator },
            }).filter(({ definition }) =>
              workspaceFileTools.includes(definition.name),
            )
          : undefined;
        const result = await runTurn({
          ownerUserId: grant.accountId,
          routineId: item.key,
          runId: item.key,
          // Each explicitly submitted request has its own thread and run.
          threadId: item.key,
          agentId: bot.id,
          instruction: work.instruction,
          userMessage: {
            id: item.key,
            role: "user",
            content: work.instruction,
          },
          signal: controller.signal,
          initiator,
          additionalTools,
          beforeDispatch: async () => {
            if (work.requiresComputer) {
              try {
                await connectComputer();
              } catch (error) {
                computerBlocked = error instanceof ComputerUnavailableError;
                throw error;
              }
            } else {
              await checkExecution();
            }
          },
          onText: saveOutput,
        }).finally(() => {
          endedAt = now();
        });
        if (result.replyText) saveOutput(result.replyText);
        await checkpoint;
        if (now() >= expiresAt) controller.abort();
        if (!controller.signal.aborted && (await queue.finish(held)))
          return true;
      } catch (error) {
        await checkpoint;
        if (
          error instanceof HeadlessToolSuspension &&
          ["approval", "person_question"].includes(error.waiting.kind) &&
          !controller.signal.aborted &&
          (await queue.park(held))
        )
          return true;
        // A claimed request may have reached an external service. Keep it for manual review.
      } finally {
        done = true;
        controller.abort();
        clearTimeout(deadline);
        clearTimeout(poll);
      }
      await checkpoint;
      await queue.endInterrupted(held, endedAt, localCutoffAt, computerBlocked);
      return true;
    },
  };
}
