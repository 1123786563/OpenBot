import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { ProfileReadExecutor } from "../agents/profile-store";
import type { Database } from "../db/client";
import {
  approvalRequests,
  directChatRunEvents,
  directChatRuns,
  opikRuns,
} from "../db/schema";

const retentionMs = 60 * 60_000;
const cutoff = () => sql`now() - ${retentionMs} * interval '1 millisecond'`;
export const directChatRunTimeoutMs = 5 * 60_000;

type Run = typeof directChatRuns.$inferSelect;
export type RunKey = { threadId: string; runId: string };
export const matchingRun = ({ threadId, runId }: RunKey) =>
  and(eq(directChatRuns.threadId, threadId), eq(directChatRuns.id, runId));

export function expireDirectChatEvents(database: Database) {
  return database
    .delete(directChatRunEvents)
    .where(lt(directChatRunEvents.createdAt, cutoff()));
}

type RunTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const traceFields = {
  threadId: directChatRuns.threadId,
  runId: directChatRuns.id,
  startedAt: directChatRuns.startedAt,
};

async function queueRunTraces(
  tx: RunTransaction,
  runs: Pick<
    typeof opikRuns.$inferInsert,
    "threadId" | "runId" | "startedAt"
  >[],
  status: "completed" | "failed",
) {
  if (!runs.length) return;
  const finishedAt = new Date();
  await tx.insert(opikRuns).values(
    runs.map(({ threadId, runId, startedAt }) => ({
      threadId,
      runId,
      startedAt,
      status,
      finishedAt,
    })),
  );
}

export async function expireDirectChatRuns(
  tx: RunTransaction,
  threadId: string,
  traceRuns: boolean,
) {
  const expired = tx
    .update(directChatRuns)
    .set({
      status: "failed",
      externalOutcome: sql`case when ${directChatRuns.externalOutcome} = 'dispatching' then 'unknown' else ${directChatRuns.externalOutcome} end`,
    })
    .where(
      and(
        eq(directChatRuns.threadId, threadId),
        eq(directChatRuns.status, "running"),
        sql`${directChatRuns.dispatchedAt} < now() - ${directChatRunTimeoutMs} * interval '1 millisecond'`,
      ),
    );
  if (traceRuns) {
    await queueRunTraces(tx, await expired.returning(traceFields), "failed");
  } else {
    await expired;
  }
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

export function messagesFor(
  runs: Run[],
  { includePartial = true } = {},
): Message[] {
  return runs.flatMap((run): Message[] => {
    const id =
      run.assistantMessageId ?? (includePartial ? run.partialMessageId : null);
    const content = run.reply ?? (includePartial ? run.partialReply : null);
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

export async function stopDirectChatRun(
  tx: RunTransaction,
  key: RunKey,
  reason: NonNullable<Run["stopReason"]>,
  traceRuns: boolean,
) {
  const [run] = await tx
    .update(directChatRuns)
    .set({
      status: "failed",
      stopReason: reason,
      eventCursor: sql`${directChatRuns.eventCursor} + 1`,
      externalOutcome: sql`case when ${directChatRuns.externalOutcome} = 'dispatching' then 'unknown' else ${directChatRuns.externalOutcome} end`,
    })
    .where(and(matchingRun(key), eq(directChatRuns.status, "running")))
    .returning({ cursor: directChatRuns.eventCursor, ...traceFields });
  if (!run) return false;
  await tx.insert(directChatRunEvents).values({
    ...key,
    cursor: run.cursor,
    event: {
      type: EventType.RUN_ERROR,
      code: reason,
      message:
        reason === "stopped"
          ? "The Bot run was stopped."
          : "The Bot run lost access.",
    } satisfies BaseEvent,
  });
  if (traceRuns) await queueRunTraces(tx, [run], "failed");
  return true;
}

export async function appendDirectChatEvent(
  database: Database,
  key: RunKey,
  event: BaseEvent,
  {
    reply,
    traceRuns,
    streamReply,
    externalOutcome,
  }: {
    reply?: { id: string; content: string };
    traceRuns?: boolean;
    streamReply?: boolean;
    externalOutcome?: Run["externalOutcome"];
  } = {},
) {
  const events: BaseEvent[] =
    reply && streamReply
      ? [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: reply.id,
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: reply.id,
            delta: reply.content,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: reply.id },
          event,
        ]
      : [event];
  return database.transaction(async (tx) => {
    const running = and(matchingRun(key), eq(directChatRuns.status, "running"));
    const delta =
      event.type === EventType.TEXT_MESSAGE_CONTENT &&
      "delta" in event &&
      typeof event.delta === "string"
        ? event.delta
        : null;
    const status = reply
      ? "completed"
      : event.type === EventType.RUN_ERROR
        ? "failed"
        : undefined;
    const [row] = await tx
      .update(directChatRuns)
      .set({
        eventCursor: sql`${directChatRuns.eventCursor} + ${events.length}`,
        ...partialUpdate(event),
        ...(delta !== null
          ? {
              partialReply: sql`coalesce(${directChatRuns.partialReply}, '') || ${delta}`,
            }
          : {}),
        ...(reply
          ? {
              assistantMessageId: reply.id,
              reply: reply.content,
              partialMessageId: null,
              partialReply: null,
            }
          : {}),
        ...(status ? { status } : {}),
        ...(externalOutcome !== undefined ? { externalOutcome } : {}),
      })
      .where(running)
      .returning({ cursor: directChatRuns.eventCursor, ...traceFields });
    if (!row) return false;
    await tx.insert(directChatRunEvents).values(
      events.map((event, index) => ({
        ...key,
        cursor: row.cursor - events.length + index + 1,
        event,
      })),
    );
    if (traceRuns && status) {
      await queueRunTraces(tx, [row], status);
    }
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
        sql`${run.status} = 'running'`,
        sql`${approvalRequests.action} ->> 'threadId' = ${key.threadId}`,
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));
  return { kind: "snapshot", run, messages, pendingApprovals } as const;
}
