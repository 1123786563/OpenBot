import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { and, asc, eq, isNull, ne, notExists, sql } from "drizzle-orm";
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
type Run = typeof directChatRuns.$inferSelect;
const RUN_TIMEOUT_MS = 5 * 60_000;
const DUPLICATE_WAIT_MS = 30_000;

function messagesFor(runs: Run[]): Message[] {
  return runs.flatMap((run): Message[] => [
    { id: run.userMessageId, role: "user", content: run.prompt },
    ...replyFor(run),
  ]);
}

function replyFor(run: Run): Message[] {
  return run.assistantMessageId && run.reply !== null
    ? [{ id: run.assistantMessageId, role: "assistant", content: run.reply }]
    : [];
}

function eventStream(
  work: (emit: (event: BaseEvent) => void) => Promise<void>,
) {
  const encoder = new TextEncoder();
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: BaseEvent) => {
        if (open)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
      };
      void work(emit)
        .catch(() => {
          emit({
            type: EventType.RUN_ERROR,
            message: "Could not load the Bot run.",
          });
        })
        .finally(() => {
          if (open) controller.close();
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

/** OpenBot's durable path for one Person, one direct Conversation, and one Bot. */
export function createDirectChatRoutes(deps: {
  database: Database;
  profiles: AgentProfileStore;
  identifyActor: IdentifyActor;
  agentFor: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<AbstractAgent | null>;
}) {
  const { database, profiles } = deps;
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
      ? await query.for("update", { of: mapping })
      : await query;
    if (!row) return null;
    const profile = lock
      ? await profiles.getWithin(executor, actor, agentId)
      : await profiles.get(actor, agentId);
    return profile && !profile.deletedAt && !profile.hidden ? row : null;
  }

  function history(executor: ProfileReadExecutor, threadId: string) {
    return executor
      .select()
      .from(directChatRuns)
      .where(eq(directChatRuns.threadId, threadId))
      .orderBy(asc(directChatRuns.startedAt), asc(directChatRuns.id));
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

  routes.post("/agent/:agentId/connect", async (context) => {
    const parsed = joinBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "A thread is required." }, 400);
    const { threadId } = parsed.data;
    const actor = await actorFor(context.req.raw);
    if (
      !actor ||
      !(await threadFor(
        database,
        actor,
        threadId,
        context.req.param("agentId"),
      ))
    )
      return context.json(absent, 404);
    const messages = messagesFor(await history(database, threadId));
    return eventStream(async (emit) => {
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
    });
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
      await transaction
        .update(directChatRuns)
        .set({ status: "failed" })
        .where(
          and(
            eq(directChatRuns.threadId, threadId),
            eq(directChatRuns.status, "running"),
            sql`${directChatRuns.startedAt} < now() - ${RUN_TIMEOUT_MS} * interval '1 millisecond'`,
          ),
        );
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
    const runKey = and(
      eq(directChatRuns.threadId, threadId),
      eq(directChatRuns.id, run.id),
    );

    return eventStream(async (emit) => {
      if (claim.kind === "repeat") {
        let outcome = run;
        const deadline = Date.now() + DUPLICATE_WAIT_MS;
        while (
          outcome.status === "running" &&
          Date.now() < deadline &&
          !context.req.raw.signal.aborted
        ) {
          await Bun.sleep(150);
          const [saved] = await database
            .select()
            .from(directChatRuns)
            .where(runKey);
          if (!saved) break;
          outcome = saved;
        }
        if (!(await threadFor(database, actor, threadId, agentId))) return;
        emit({ type: EventType.RUN_STARTED, threadId, runId: run.id });
        if (outcome.status === "completed") {
          emit({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: messagesFor(await history(database, threadId)),
          });
          emit({ type: EventType.RUN_FINISHED, threadId, runId: run.id });
        } else {
          emit({
            type: EventType.RUN_ERROR,
            message:
              outcome.status === "running"
                ? "This request is already running."
                : "The Bot run failed.",
          });
        }
        return;
      }

      const running = and(runKey, eq(directChatRuns.status, "running"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const agent = await deps.agentFor(actor, agentId);
        if (!agent) throw new Error("Bot unavailable.");
        agent.threadId = threadId;
        agent.agentId = agentId;
        agent.setMessages(claim.messages);
        const input: RunAgentInput = {
          threadId,
          runId: run.id,
          messages: claim.messages,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        };
        let failure = false;
        const completion = agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_ERROR) failure = true;
            else if (event.type !== EventType.RUN_FINISHED) emit(event);
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
                run.startedAt.getTime() + RUN_TIMEOUT_MS - Date.now(),
              ),
            );
          }),
        ]);
        const reply = agent.messages
          .slice(claim.messages.length)
          .findLast(
            (message) =>
              message.role === "assistant" &&
              typeof message.content === "string" &&
              message.content.trim(),
          );
        if (failure || !reply || typeof reply.content !== "string")
          throw new Error("Bot returned no text.");
        const [saved] = await database
          .update(directChatRuns)
          .set({
            status: "completed",
            assistantMessageId: reply.id,
            reply: reply.content,
          })
          .where(running)
          .returning({ id: directChatRuns.id });
        if (!saved) throw new Error("The Bot run has expired.");
        emit({ type: EventType.RUN_FINISHED, threadId, runId: run.id });
      } catch {
        await database
          .update(directChatRuns)
          .set({ status: "failed" })
          .where(running);
        emit({ type: EventType.RUN_ERROR, message: "The Bot run failed." });
      } finally {
        clearTimeout(timer);
      }
    });
  });

  return routes;
}
