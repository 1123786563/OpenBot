import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { DIRECT_CHAT_REPLAY_HEADER } from "@openbot/shared/direct-chat-replay";
import { and, eq, isNull, ne, notExists } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentProfileStore,
  ProfileReadExecutor,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { IdentifyActor } from "../copilot";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  directChatRuns,
  groupBotThreads,
  intelligenceChannelMappings,
} from "../db/schema";
import { runFeedback, saveRunFeedback } from "../opik/feedback";

import {
  appendDirectChatEvent,
  directChatRunTimeoutMs,
  expireDirectChatRuns,
  directChatHistory as history,
  messagesFor,
  type RunKey,
  readDirectChatReplay,
} from "./direct-chat-replay";

const id = z.string().min(1).max(256);
const runBody = z.object({
  threadId: id,
  runId: id,
  messages: z.array(z.unknown()).min(1),
});
const promptMessage = z.object({
  id,
  role: z.literal("user"),
  content: z.string().min(1).max(1_000_000),
});
const joinBody = z.object({ threadId: id });
const resumeBody = joinBody.extend({
  runId: id,
  cursor: z.number().int().min(0).max(2_147_483_647),
});
type Emit = (event: BaseEvent, cursor?: number) => void;

function eventStream(
  work: (emit: Emit, signal: AbortSignal) => Promise<void>,
  key?: RunKey,
) {
  const encoder = new TextEncoder();
  const subscription = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit: Emit = (event, cursor) => {
        if (!subscription.signal.aborted) {
          const id = cursor === undefined ? "" : `id: ${cursor}\n`;
          controller.enqueue(
            encoder.encode(`${id}data: ${JSON.stringify(event)}\n\n`),
          );
        }
      };
      void work(emit, subscription.signal).then(
        () => {
          if (!subscription.signal.aborted) controller.close();
        },
        (error: unknown) => {
          if (!subscription.signal.aborted) controller.error(error);
        },
      );
    },
    cancel() {
      subscription.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...(key
        ? { [DIRECT_CHAT_REPLAY_HEADER]: encodeURIComponent(key.runId) }
        : {}),
    },
  });
}

/** OpenBot's durable path for one Person, one direct Conversation, and one Bot. */
export function createDirectChatRoutes(deps: {
  database: Database;
  profiles: AgentProfileStore;
  identifyActor: IdentifyActor;
  traceRuns: boolean;
  agentFor: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<AbstractAgent | null>;
}) {
  const { database, profiles, traceRuns } = deps;
  const routes = new Hono();

  async function threadFor(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    threadId: string,
    agentId: string,
    lock = false,
  ) {
    if (!actor.id) return null;
    const mapping = intelligenceChannelMappings;
    const otherAgent = executor
      .select({ id: channelAgents.agentId })
      .from(channelAgents)
      .where(
        and(
          eq(channelAgents.channelId, mapping.channelId),
          ne(channelAgents.agentId, agentId),
        ),
      );
    const otherMember = executor
      .select({ id: channelMemberships.userId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, mapping.channelId),
          ne(channelMemberships.userId, actor.id),
        ),
      );
    const group = executor
      .select({ id: groupBotThreads.channelId })
      .from(groupBotThreads)
      .where(eq(groupBotThreads.channelId, mapping.channelId));
    const query = executor
      .select({ channelId: mapping.channelId })
      .from(mapping)
      .innerJoin(channels, eq(channels.id, mapping.channelId))
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, actor.id),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(
        and(
          eq(mapping.threadId, threadId),
          eq(mapping.userId, actor.id),
          isNull(channels.deletedAt),
          notExists(otherAgent),
          notExists(otherMember),
          notExists(group),
        ),
      );
    const [row] = lock
      ? await query.for("update", { of: [channels, mapping] })
      : await query;
    if (!row) return null;
    const profile = await profiles.getWithin(executor, actor, agentId);
    return profile && !profile.deletedAt && !profile.hidden ? row : null;
  }

  const actorFor = (request: Request) =>
    deps.identifyActor(request).catch(() => null);
  const absent = { error: "Conversation not found." };

  routes.get("/threads/:threadId/messages", async (context) => {
    const { threadId } = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (
      !actor ||
      !agentId ||
      !(await threadFor(database, actor, threadId, agentId))
    )
      return context.json(absent, 404);
    const runs = await history(database, threadId);
    return context.json({
      messages: messagesFor(runs),
      runs: runs.map(({ id, status, userMessageId, assistantMessageId }) => ({
        id,
        status,
        userMessageId,
        assistantMessageId,
      })),
    });
  });

  routes.post("/threads/:threadId/runs/:runId/feedback", async (context) => {
    const { threadId, runId } = context.req.param();
    const agentId = context.req.query("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor || !agentId) return context.json(absent, 404);
    const feedback = runFeedback.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!feedback.success)
      return context.json({ error: "Invalid Run feedback." }, 400);
    const outcome = await database.transaction(async (transaction) => {
      if (!(await threadFor(transaction, actor, threadId, agentId, true)))
        return "absent";
      return saveRunFeedback(transaction, { threadId, runId }, feedback.data);
    });
    if (outcome === "absent") return context.json(absent, 404);
    if (outcome === "conflict")
      return context.json(
        { error: "Feedback already submitted for this Run." },
        409,
      );
    return context.json({ feedbackId: feedback.data.feedbackId }, 202);
  });

  routes.post("/agent/:agentId/connect", async (context) => {
    const parsed = joinBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "A thread is required." }, 400);
    const { threadId } = parsed.data;
    const agentId = context.req.param("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor || !(await threadFor(database, actor, threadId, agentId)))
      return context.json(absent, 404);
    const messages = messagesFor(await history(database, threadId));
    return eventStream(async (emit) => {
      if (!(await threadFor(database, actor, threadId, agentId))) return;
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
    });
  });

  function terminal(key: RunKey, status: "completed" | "failed"): BaseEvent {
    return status === "completed"
      ? { type: EventType.RUN_FINISHED, ...key }
      : { type: EventType.RUN_ERROR, message: "The Bot run failed." };
  }

  async function read(
    request: Request,
    key: RunKey,
    agentId: string,
    cursor: number,
  ) {
    const actor = await actorFor(request);
    const actorId = actor?.id;
    if (!actor || !actorId) return { kind: "absent" } as const;
    // Close abandoned executions when their existing dispatch deadline passes.
    return database.transaction(
      async (tx) => {
        if (!(await threadFor(tx, actor, key.threadId, agentId)))
          return { kind: "absent" } as const;
        await expireDirectChatRuns(tx, key.threadId, traceRuns);
        return readDirectChatReplay(tx, key, cursor, actorId);
      },
      { isolationLevel: "repeatable read" },
    );
  }

  function follow(
    request: Request,
    key: RunKey,
    agentId: string,
    after: number,
    initial?: Awaited<ReturnType<typeof read>>,
  ) {
    return eventStream(async (emit, signal) => {
      let cursor = after;
      let page = initial;
      while (!signal.aborted && !request.signal.aborted) {
        const result = page ?? (await read(request, key, agentId, cursor));
        page = undefined;
        if (result.kind === "absent" || result.kind === "invalid") {
          emit({
            type: EventType.RUN_ERROR,
            message: "The Bot run is unavailable.",
          });
          return;
        }
        if (result.kind === "snapshot") {
          if (cursor === 0) emit({ type: EventType.RUN_STARTED, ...key });
          emit({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: result.messages,
          });
          cursor = result.run.eventCursor;
          emit(
            {
              type: EventType.CUSTOM,
              name: "openbot.run.snapshot",
              value: {
                ...key,
                cursor,
                status: result.run.status,
                pendingApprovals: result.pendingApprovals,
              },
            },
            cursor,
          );
          if (result.run.status !== "running") {
            emit(terminal(key, result.run.status));
            return;
          }
        } else {
          for (const row of result.events) {
            emit(row.event, row.cursor);
            cursor = row.cursor;
            if (
              row.event.type === EventType.RUN_FINISHED ||
              row.event.type === EventType.RUN_ERROR
            )
              return;
          }
          if (
            cursor < result.run.eventCursor ||
            result.run.status !== "running"
          )
            continue;
        }
        await Bun.sleep(200);
      }
    }, key);
  }

  routes.post("/agent/:agentId/resume", async (context) => {
    const body = resumeBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success)
      return context.json({ error: "A run and cursor are required." }, 400);
    const { cursor, ...key } = body.data;
    const agentId = context.req.param("agentId");
    const initial = await read(context.req.raw, key, agentId, cursor);
    if (initial.kind === "absent") return context.json(absent, 404);
    if (initial.kind === "invalid")
      return context.json({ error: "Invalid run cursor." }, 400);
    return follow(context.req.raw, key, agentId, cursor, initial);
  });

  routes.post("/agent/:agentId/run", async (context) => {
    const body = runBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json({ error: "A text message is required." }, 400);
    const prompt = promptMessage.safeParse(body.data.messages.at(-1));
    if (!prompt.success)
      return context.json({ error: "A text message is required." }, 400);
    const { threadId, runId } = body.data;
    const { id: messageId, content } = prompt.data;
    const agentId = context.req.param("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor) return context.json(absent, 404);

    const claim = await database.transaction(async (transaction) => {
      if (!(await threadFor(transaction, actor, threadId, agentId, true)))
        return { kind: "absent" } as const;
      // The mapping row serializes claims from every server process. An expired claim remains
      // the original request's record, so repeating it can never start the Bot again.
      await expireDirectChatRuns(transaction, threadId, traceRuns);
      const previous = await history(transaction, threadId);
      const same = previous.find((run) => run.userMessageId === messageId);
      if (same)
        return same.prompt === content
          ? ({ kind: "repeat", run: same } as const)
          : ({ kind: "conflict" } as const);
      if (previous.some((run) => run.id === runId))
        return { kind: "conflict" } as const;
      if (previous.some((run) => run.status === "running"))
        return { kind: "busy" } as const;
      const [run] = await transaction
        .insert(directChatRuns)
        .values({
          threadId,
          id: runId,
          userMessageId: messageId,
          prompt: content,
          status: "running",
        })
        .returning();
      if (!run) throw new Error("Direct chat run was not created.");
      return {
        kind: "start",
        run,
        messages: messagesFor([...previous, run]),
      } as const;
    });
    if (claim.kind === "absent") return context.json(absent, 404);
    if (claim.kind === "conflict")
      return context.json({ error: "The request ID is already in use." }, 409);
    if (claim.kind === "busy")
      return context.json(
        { error: "This conversation already has a running Bot." },
        409,
      );
    const run = claim.run;
    const key = { threadId, runId: run.id };
    if (claim.kind === "start") {
      void execute(actor, claim.messages).catch(() => {
        // A database failure leaves the claim for the existing timeout to settle.
      });
    }
    return follow(context.req.raw, key, agentId, 0);

    async function execute(
      actor: AgentActor,
      messages: ReturnType<typeof messagesFor>,
    ) {
      let writes = Promise.resolve();
      let writeFailed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const agent = await deps.agentFor(actor, agentId);
        if (!agent) throw new Error("Bot unavailable.");
        agent.threadId = threadId;
        agent.agentId = agentId;
        agent.setMessages(messages);
        const input: RunAgentInput = {
          threadId,
          runId: run.id,
          messages: messages,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        };
        let failure = false;
        const completion = agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_ERROR) failure = true;
            else if (event.type !== EventType.RUN_FINISHED) {
              writes = writes
                .then(async () => {
                  if (
                    !writeFailed &&
                    !(await appendDirectChatEvent(database, key, event))
                  )
                    writeFailed = true;
                })
                .catch(() => {
                  writeFailed = true;
                });
            }
          },
        });
        await Promise.race([
          completion,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                agent.abortRun();
                reject(new Error("The Bot run timed out."));
              },
              Math.max(
                0,
                run.startedAt.getTime() + directChatRunTimeoutMs - Date.now(),
              ),
            );
          }),
        ]);
        const reply = agent.messages
          .slice(messages.length)
          .findLast(
            (message) =>
              message.role === "assistant" &&
              typeof message.content === "string" &&
              message.content.trim(),
          );
        await writes;
        if (
          writeFailed ||
          failure ||
          !reply ||
          typeof reply.content !== "string"
        )
          throw new Error("Bot returned no text.");
        await appendDirectChatEvent(database, key, terminal(key, "completed"), {
          traceRuns,
          reply: { id: reply.id, content: reply.content },
        });
      } catch {
        await writes;
        await appendDirectChatEvent(database, key, terminal(key, "failed"), {
          traceRuns,
        });
      } finally {
        clearTimeout(timer);
      }
    }
  });

  return routes;
}
