import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import type { Database } from "../db/client";
import { createWorkQueue } from "../work/queue";
import { readExecutionAccess } from "./account-access";
import { assistantTarget, workspaceBots } from "./workspace-bots";
import type { workspaceComputer } from "./workspace-computer";

export const PERSONAL_BOT_WORK = "personal.bot.turn";
export const botWorkInput = assistantTarget.extend({
  instruction: z.string().trim().min(1).max(20_000),
  requiresComputer: z.boolean().optional(),
});
export const recoveryInput = z.strictObject({
  action: z.enum(["cancel", "retry"]),
  acknowledged: z.boolean().default(false),
});

export function personalBotWork(
  database: Database,
  now = Date.now,
  accessComputer?: ReturnType<typeof workspaceComputer>["accessForTask"],
) {
  const queue = createWorkQueue(database, now);
  const leaseMs = 65_000;
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
    async sweep(runTurn?: TurnRunner) {
      await queue.reconcilePersonalWork(PERSONAL_BOT_WORK);
      if (!runTurn) return false;
      const owner = randomUUID();
      const [item] = await queue.claim({
        kind: PERSONAL_BOT_WORK,
        owner,
        leaseMs,
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
        if (now() >= expiresAt) expire();
        else deadline = setTimeout(expire, expiresAt - now());
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
        const work = botWorkInput.parse(item.payload);
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
          beforeDispatch: async () => {
            controller.signal.throwIfAborted();
            if (work.requiresComputer) {
              const computer = await accessComputer?.(work.workspaceId, {
                ...grant,
                expiresAt,
              }).catch(() => undefined);
              if (computer?.kind !== "running") {
                computerBlocked = true;
                throw new Error("Workspace Computer is unavailable");
              }
            }
            const access = await database.transaction((tx) =>
              readExecutionAccess(tx, grant.accountId, now, grant.epoch),
            );
            if (access?.kind !== "active" || now() >= expiresAt)
              controller.abort();
            controller.signal.throwIfAborted();
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
      } catch {
        // A claimed request may have reached an external service. Keep it for manual review.
      } finally {
        done = true;
        clearTimeout(deadline);
        clearTimeout(poll);
      }
      await checkpoint;
      await queue.endInterrupted(held, endedAt, localCutoffAt, computerBlocked);
      return true;
    },
  };
}
