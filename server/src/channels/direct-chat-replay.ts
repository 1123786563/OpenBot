import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { ProfileReadExecutor } from "../agents/profile-store";
import type { Database } from "../db/client";
import {
  approvalRequests,
  directChatRunEvents,
  directChatRuns,
} from "../db/schema";

const retentionMs = 60 * 60_000;
const cutoff = () => sql`now() - ${retentionMs} * interval '1 millisecond'`;
export const directChatRunTimeoutMs = 5 * 60_000;

type Run = typeof directChatRuns.$inferSelect;
export type RunKey = { threadId: string; runId: string };
const matchingRun = ({ threadId, runId }: RunKey) =>
  and(eq(directChatRuns.threadId, threadId), eq(directChatRuns.id, runId));

export function expireDirectChatEvents(database: Database) {
  return database
    .delete(directChatRunEvents)
    .where(lt(directChatRunEvents.createdAt, cutoff()));
}

export function expireDirectChatRuns(
  database: Pick<Database, "update">,
  threadId: string,
) {
  return database
    .update(directChatRuns)
    .set({ status: "failed" })
    .where(
      and(
        eq(directChatRuns.threadId, threadId),
        eq(directChatRuns.status, "running"),
        sql`${directChatRuns.startedAt} < now() - ${directChatRunTimeoutMs} * interval '1 millisecond'`,
      ),
    );
}

export function directChatHistory(
  executor: ProfileReadExecutor,
  threadId: string,
) {
  return executor
    .select()
    .from(directChatRuns)
    .where(eq(directChatRuns.threadId, threadId))
    .orderBy(asc(directChatRuns.startedAt), asc(directChatRuns.id));
}

export function messagesFor(runs: Run[]): Message[] {
  return runs.flatMap((run): Message[] => {
    const id = run.assistantMessageId ?? run.partialMessageId;
    const content = run.reply ?? run.partialReply;
    return [
      { id: run.userMessageId, role: "user", content: run.prompt },
      ...(id && content !== null
        ? [{ id, role: "assistant" as const, content }]
        : []),
    ];
  });
}

function partialUpdate(event: BaseEvent): Partial<Run> {
  if (
    event.type === EventType.TEXT_MESSAGE_START &&
    "messageId" in event &&
    typeof event.messageId === "string"
  ) {
    return { partialMessageId: event.messageId, partialReply: "" };
  }
  return {};
}

export async function appendDirectChatEvent(
  database: Database,
  key: RunKey,
  event: BaseEvent,
  reply?: { id: string; content: string },
) {
  return database.transaction(async (tx) => {
    const running = and(matchingRun(key), eq(directChatRuns.status, "running"));
    const delta =
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      "delta" in event &&
      typeof event.delta === "string"
        ? event.delta
        : null;
    const [row] = await tx
      .update(directChatRuns)
      .set({
        eventCursor: sql`${directChatRuns.eventCursor} + 1`,
        ...partialUpdate(event),
        ...(delta !== null
          ? {
              partialReply: sql`coalesce(${directChatRuns.partialReply}, '') || ${delta}`,
            }
          : {}),
        ...(reply
          ? {
              status: "completed",
              assistantMessageId: reply.id,
              reply: reply.content,
              partialMessageId: null,
              partialReply: null,
            }
          : {}),
        ...(event.type === EventType.RUN_ERROR ? { status: "failed" } : {}),
      })
      .where(running)
      .returning({ cursor: directChatRuns.eventCursor });
    if (!row) return false;
    await tx
      .insert(directChatRunEvents)
      .values({ ...key, cursor: row.cursor, event });
    return true;
  });
}

export async function readDirectChatReplay(
  tx: ProfileReadExecutor,
  key: RunKey,
  cursor: number,
  ownerUserId: string,
) {
  const [run] = await tx.select().from(directChatRuns).where(matchingRun(key));
  if (!run) return { kind: "absent" } as const;
  if (cursor > run.eventCursor) return { kind: "invalid" } as const;
  const events = await tx
    .select({
      cursor: directChatRunEvents.cursor,
      event: directChatRunEvents.event,
    })
    .from(directChatRunEvents)
    .where(
      and(
        eq(directChatRunEvents.threadId, key.threadId),
        eq(directChatRunEvents.runId, key.runId),
        gt(directChatRunEvents.cursor, cursor),
        gte(directChatRunEvents.createdAt, cutoff()),
      ),
    )
    .orderBy(asc(directChatRunEvents.cursor))
    .limit(128);
  const hasGap = events.some((row, index) => row.cursor !== cursor + index + 1);
  if (
    !hasGap &&
    (events.length || (cursor === run.eventCursor && run.status === "running"))
  ) {
    return { kind: "events", events, run } as const;
  }
  // The same database snapshot supplies both the materialized state and its event boundary.
  // A run from before replay or a stale run closed by the timeout may lack a terminal event.
  const messages = messagesFor(await directChatHistory(tx, key.threadId));
  const pendingApprovals = await tx
    .select({
      id: approvalRequests.id,
      toolCallId: approvalRequests.toolCallId,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.ownerUserId, ownerUserId),
        eq(approvalRequests.runId, key.runId),
        eq(approvalRequests.status, "pending"),
        sql`${approvalRequests.action} ->> 'threadId' = ${key.threadId}`,
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));
  return { kind: "snapshot", run, messages, pendingApprovals } as const;
}
