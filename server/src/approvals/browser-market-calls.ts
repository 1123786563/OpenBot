import type { MiddlewareFunction } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import {
  marketSkillSnapshotSchema,
  RUN_MARKET_SKILL,
  type RunWithMarketSkill,
} from "@openbot/toolkit/continuation";
import { and, eq } from "drizzle-orm";
import { concatMap } from "rxjs";
import type { Database } from "../db/client";
import { browserMarketApprovalCalls as calls } from "../db/schema";

export type BrowserMarketCalls = ReturnType<typeof createBrowserMarketCalls>;

export function createBrowserMarketCalls(database: Database) {
  return {
    middleware(ownerUserId: string, botId: string): MiddlewareFunction {
      return (input: RunWithMarketSkill, next) => {
        // Keep the same selection object if middleware copies the run input before admission.
        input[RUN_MARKET_SKILL] ??= {};
        const selection = input[RUN_MARKET_SKILL];
        const browserTools = new Set(
          input.tools
            .filter((tool) => tool.name.startsWith("computer_"))
            .map((tool) => tool.name),
        );
        const stream = next.run(input);
        if (!browserTools.size) return stream;
        return stream.pipe(
          concatMap((event) => {
            if (
              event.type !== EventType.TOOL_CALL_START ||
              !selection.snapshot ||
              ("subagentRunId" in event && event.subagentRunId) ||
              !("toolCallName" in event) ||
              typeof event.toolCallName !== "string" ||
              !browserTools.has(event.toolCallName) ||
              !("toolCallId" in event) ||
              typeof event.toolCallId !== "string"
            )
              return [event];

            // A browser may post its approval request as soon as it sees the call.
            return database
              .insert(calls)
              .values({
                ownerUserId,
                botId,
                threadId: input.threadId,
                runId: input.runId,
                toolCallId: event.toolCallId,
                toolName: event.toolCallName,
                snapshot: selection.snapshot,
              })
              .onConflictDoNothing()
              .then(() => event);
          }),
        );
      };
    },
    async find(
      key: Pick<
        typeof calls.$inferSelect,
        "ownerUserId" | "botId" | "threadId" | "toolCallId"
      >,
    ) {
      const [call] = await database
        .select({
          runId: calls.runId,
          toolName: calls.toolName,
          snapshot: calls.snapshot,
        })
        .from(calls)
        .where(
          and(
            eq(calls.ownerUserId, key.ownerUserId),
            eq(calls.botId, key.botId),
            eq(calls.threadId, key.threadId),
            eq(calls.toolCallId, key.toolCallId),
          ),
        );
      return (
        call && {
          ...call,
          snapshot: marketSkillSnapshotSchema.parse(call.snapshot),
        }
      );
    },
  };
}
