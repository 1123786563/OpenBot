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
import {
  type DirectChatTestCredit,
  testCreditConfirmation,
} from "../billing/direct-chat-test-credit";
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
import { operationId } from "../managed-model";
import type { ManagedModel, ManagedModelResult } from "../managed-model-trial";

const id = z.string().min(1).max(256);
const runBody = z.object({
  threadId: id,
  runId: id,
  messages: z.array(z.unknown()).min(1),
  forwardedProps: z
    .object({
      testCreditQuote: z.unknown().optional(),
      rerunOfMessageId: id.optional(),
    })
    .nullish(),
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

const managedRunError: Record<
  Exclude<ManagedModelResult["state"], "completed">,
  string
> = {
  insufficient_credits: "This account does not have enough Test Credits.",
  execution_limit: "This run reached its Test Credit limit.",
  not_authorized:
    "This account is not authorized to spend Test Credits on this run.",
  route_unavailable: "This model route is unavailable.",
  pilot_closed:
    "The Test Credit trial has ended, so this run cannot use Test Credits.",
  reconciling: "The model outcome is being reconciled.",
  unavailable: "Test Credit admission is temporarily unavailable.",
  settled: "The previous model call settled, but its reply is unavailable.",
  released: "The previous model call ended and its reservation was released.",
};

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

function creditReceiptEvent(
  run: Run,
  receipt: NonNullable<Awaited<ReturnType<DirectChatTestCredit["receipt"]>>>,
  hasReply: boolean,
): BaseEvent {
  return {
    type: EventType.CUSTOM,
    name: "openbot-test-credit-receipt",
    value: {
      operationId: receipt.operationId,
      userMessageId: run.userMessageId,
      state: receipt.state,
      heldMicrocredits: receipt.heldMicrocredits,
      hasReply,
      chargedMicrocredits: receipt.chargedMicrocredits,
      releasedMicrocredits: receipt.releasedMicrocredits,
    },
  };
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
  testCredit?: DirectChatTestCredit;
  trial?: { route: string; model: ManagedModel };
  agentFor: (
    actor: AgentActor,
    agentId: string,
  ) => Promise<AbstractAgent | null>;
}) {
  const { database, profiles, testCredit } = deps;
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
    const runs = await history(database, threadId);
    return eventStream(async (emit) => {
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages: messagesFor(runs) });
      const latest = runs.at(-1);
      if (!testCredit || !latest?.testCreditOperationId) return;
      const receipt = await testCredit
        .receipt(latest.testCreditOperationId, actor.id)
        .catch(() => undefined);
      if (receipt)
        emit(
          creditReceiptEvent(latest, receipt, latest.status === "completed"),
        );
    });
  });

  routes.get("/agent/:agentId/test-credit-quote", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!testCredit)
      return context.json({ error: "Test Credit quote unavailable." }, 404);
    const actor = await actorFor(context.req.raw);
    const threadId = context.req.query("threadId");
    if (
      !actor?.id ||
      !threadId ||
      !(await threadFor(
        database,
        actor,
        threadId,
        context.req.param("agentId"),
      ))
    )
      return context.json(absent, 404);
    const quote = await testCredit.quote(actor.id).catch(() => undefined);
    return quote
      ? context.json(quote)
      : context.json({ error: "Test Credit quote unavailable." }, 503);
  });

  routes.post("/agent/:agentId/run", async (context) => {
    const body = runBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json({ error: "A text message is required." }, 400);
    const prompt = promptMessage.safeParse(body.data.messages.at(-1));
    if (!prompt.success)
      return context.json({ error: "A text message is required." }, 400);
    const { threadId, runId } = body.data;
    const rerunOfMessageId = body.data.forwardedProps?.rerunOfMessageId;
    const confirmation = testCreditConfirmation.safeParse(
      body.data.forwardedProps?.testCreditQuote,
    );
    const { id: messageId, content } = prompt.data;
    const agentId = context.req.param("agentId");
    const actor = await actorFor(context.req.raw);
    if (!actor?.id) return context.json(absent, 404);

    const operationFor = (id: string) => ({
      scope: {
        source: "direct-chat" as const,
        personId: actor.id,
        botId: agentId,
        conversationId: threadId,
        runId: id,
      },
      step: "direct-chat-answer",
    });
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
      if (testCredit && !confirmation.success)
        return { kind: "confirmation_required" } as const;
      const original =
        rerunOfMessageId === undefined
          ? undefined
          : previous.find((run) => run.userMessageId === rerunOfMessageId);
      if (
        rerunOfMessageId !== undefined &&
        (!testCredit ||
          !original?.testCreditOperationId ||
          original.prompt !== content)
      )
        return { kind: "rerun_unavailable" } as const;
      const [run] = await transaction
        .insert(directChatRuns)
        .values({
          threadId,
          id: runId,
          userMessageId: messageId,
          testCreditOperationId: testCredit
            ? operationId(operationFor(runId))
            : null,
          prompt: content,
          status: "running",
        })
        .returning();
      if (!run) throw new Error("Direct chat run was not created.");
      return {
        kind: "start",
        run,
        messages: messagesFor([...previous, run]),
        rerunOfOperationId: original?.testCreditOperationId ?? undefined,
      } as const;
    });
    if (claim.kind === "absent") return context.json(absent, 404);
    if (claim.kind === "confirmation_required")
      return context.json(
        { error: "Confirm the current Test Credit quote before sending." },
        409,
      );
    if (claim.kind === "rerun_unavailable")
      return context.json(
        { error: "The original Test Credit run is unavailable." },
        409,
      );
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

    const operation = operationFor(run.id);
    const trial = deps.trial;
    return eventStream(async (emit) => {
      function emitReceipt(
        result: Awaited<ReturnType<DirectChatTestCredit["reconcile"]>>,
      ) {
        const receipt = result?.operation;
        if (receipt)
          emit(creditReceiptEvent(run, receipt, result?.state === "completed"));
      }
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
        if (testCredit && run.testCreditOperationId) {
          const recovered = await testCredit
            .reconcile(run.testCreditOperationId, actor.id)
            .catch(() => undefined);
          emitReceipt(recovered);
          if (
            recovered?.state === "completed" &&
            outcome.status !== "completed"
          ) {
            const [saved] = await database
              .update(directChatRuns)
              .set({
                status: "completed",
                reply: recovered.text,
                assistantMessageId: crypto.randomUUID(),
              })
              .where(and(runKey, ne(directChatRuns.status, "completed")))
              .returning();
            if (saved) outcome = saved;
            else {
              const [completed] = await database
                .select()
                .from(directChatRuns)
                .where(runKey);
              if (completed) outcome = completed;
            }
          } else if (
            outcome.status !== "completed" &&
            recovered &&
            recovered.state !== "completed" &&
            recovered.state !== "unavailable"
          ) {
            emit({
              type: EventType.RUN_ERROR,
              code: recovered.state,
              message: managedRunError[recovered.state],
            });
            return;
          }
        }
        if (outcome.status === "completed") {
          emit({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: messagesFor(await history(database, threadId)),
          });
          emit({ type: EventType.RUN_FINISHED, threadId, runId: run.id });
        } else {
          if (outcome.status === "failed" && trial && !testCredit) {
            const state = await trial.model
              .reconcile(operation)
              .catch(() => undefined);
            const code = state === "pending" ? "reconciling" : state;
            if (code && code !== "absent") {
              emit({
                type: EventType.RUN_ERROR,
                code,
                message: managedRunError[code],
              });
              return;
            }
          }
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
      async function finish(reply: { id: string; content: string }) {
        const [saved] = await database
          .update(directChatRuns)
          .set({
            status: "completed",
            assistantMessageId: reply.id,
            reply: reply.content,
          })
          .where(running)
          .returning({ id: directChatRuns.id });
        if (saved) return reply;
        const [recovered] = await database
          .select()
          .from(directChatRuns)
          .where(runKey);
        if (
          recovered?.status === "completed" &&
          recovered.assistantMessageId &&
          recovered.reply !== null
        )
          return { id: recovered.assistantMessageId, content: recovered.reply };
        throw new Error("The Bot run has expired.");
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (testCredit || trial) {
          emit({ type: EventType.RUN_STARTED, threadId, runId: run.id });
          const messages = claim.messages.flatMap(({ role, content }) =>
            (role === "user" || role === "assistant") &&
            typeof content === "string"
              ? [{ role, content }]
              : [],
          );
          let result: ManagedModelResult;
          if (testCredit) {
            if (!confirmation.success || !run.testCreditOperationId)
              throw new Error("Test Credit confirmation unavailable.");
            const credited = await testCredit
              .complete({
                id: run.testCreditOperationId,
                personId: actor.id,
                confirmation: confirmation.data,
                rerunOfOperationId: claim.rerunOfOperationId,
                messages,
              })
              .catch(() => ({ state: "unavailable" as const }));
            emitReceipt(credited);
            result = credited;
          } else if (trial) {
            result = await trial.model.complete({
              ...operation,
              route: trial.route,
              messages,
            });
          } else {
            throw new Error("Managed model unavailable.");
          }
          if (result.state === "completed") {
            const reply = await finish({
              id: crypto.randomUUID(),
              content: result.text,
            });
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId: reply.id,
              role: "assistant",
            });
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: reply.id,
              delta: reply.content,
            });
            emit({ type: EventType.TEXT_MESSAGE_END, messageId: reply.id });
            emit({ type: EventType.RUN_FINISHED, threadId, runId: run.id });
          } else {
            await database
              .update(directChatRuns)
              .set({ status: "failed" })
              .where(running);
            emit({
              type: EventType.RUN_ERROR,
              code: result.state,
              message: managedRunError[result.state],
            });
          }
          return;
        }
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
        await finish({ id: reply.id, content: reply.content });
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
