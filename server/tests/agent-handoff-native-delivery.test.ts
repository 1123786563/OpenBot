import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createOpenBotHandoffDelivery } from "../src/agents/handoff-wiring";
import type { HandoffWork } from "../src/agents/handoff-runner";
import {
  channelAgents,
  directChatRunEvents,
  directChatRuns,
  groupBotThreads,
  intelligenceChannelMappings,
} from "../src/db/schema";

/**
 * What a delivery without Intelligence tells the asking Conversation's entry.
 *
 * A hop finishes with no browser attached, so the delivery is the only thing that reports the
 * answer. The roster only moves forward, so what it is told, and when, is the whole contract.
 */

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  depth: 1,
  task: "find the outage window",
};

const ANSWER = "The status is clear.";

/** When the answering Bot's Run landed its last event. */
const LANDED = new Date("2026-11-25T10:00:02.000Z");
/** When it was sent, and when it started: both before the answer. */
const SENT = new Date("2026-11-25T10:00:01.000Z");
const STARTED = new Date("2026-11-25T10:00:00.000Z");

type Line = {
  actor: string;
  channelId: string;
  text: string;
  agentId: string | null;
  at: Date;
};

/** A shared Conversation's transcript line, as `announceHandoff` is given it: no time of its own. */
type TranscriptLine = {
  actor: string;
  threadId: string;
  text: string;
  agentId: string;
  /** The Run whose words these are, so the transcript takes them once. */
  conversationRunId?: string;
};

type Outcome = { replyText: string; shared: boolean };

/**
 * The delivery over stores that only record: `told` is every line the roster was given,
 * `transcript` every line a shared Conversation was, `sent` the threads it was told to look at,
 * `turns` the Runs it was asked to start. A channel shows the asking thread; a Bot's group thread
 * maps to no channel, and its transcript is told instead.
 */
function harness(
  outcome: Outcome | Error,
  trouble:
    | "none"
    | "roster down"
    | "landing unreadable"
    | "run unreadable"
    | "owner unreadable"
    | "query failure" = "none",
  thread: "channel" | "group" = "channel",
) {
  const told: Line[] = [];
  const transcript: TranscriptLine[] = [];
  const sent: string[] = [];
  const turns: Record<string, unknown>[] = [];
  // The thread is the conversation's own Bot's: in a group its own row, in a direct channel its
  // mapping and the channel's one agent. A second hop's asking Bot differs from both.
  const rows = new Map<object, unknown[]>([
    [groupBotThreads, thread === "group" ? [{ agentId: "assistant" }] : []],
    [
      intelligenceChannelMappings,
      thread === "group" ? [] : [{ channelId: "channel-1" }],
    ],
    [channelAgents, thread === "group" ? [] : [{ agentId: "assistant" }]],
    [directChatRunEvents, [{ at: LANDED }]],
    [directChatRuns, [{ dispatchedAt: SENT, startedAt: STARTED }]],
  ]);
  const database = {
    select: () => ({
      from: (table: object) => ({
        where: () => {
          const limit = async () => {
            const unreadable =
              (table === directChatRunEvents &&
                trouble !== "none" &&
                trouble !== "roster down") ||
              (table === directChatRuns && trouble === "run unreadable");
            if (unreadable) throw new Error("unreadable");
            return rows.get(table) ?? [];
          };
          const orderBy = () => ({ limit });
          return { limit, orderBy };
        },
      }),
    }),
  };
  const delivery = createOpenBotHandoffDelivery({
    runBackground: (async (turn: Record<string, unknown>) => {
      turns.push(turn);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as never,
    actorFor: (async (id: string) => {
      if (trouble === "owner unreadable") throw new Error("owner unreadable");
      return { id };
    }) as never,
    mayAddress: async () => true,
    channelStore: {
      signalWork: async (threadId: string) => {
        sent.push(threadId);
      },
      recordActivity: async (
        actor: { id: string },
        channelId: string,
        activity: { text: string; agentId: string | null; at: Date },
      ) => {
        if (trouble === "roster down") throw new Error("roster down");
        if (trouble === "query failure")
          throw Object.assign(
            new Error(
              `Failed query: update "channels" set "last_message" = $1\nparams: ${ANSWER},user-1`,
            ),
            { query: {}, params: [] },
          );
        told.push({ actor: actor.id, channelId, ...activity });
      },
    } as never,
    database: database as never,
    groupConversations: {
      // A shared Conversation's transcript, which a direct Conversation never has.
      announceHandoff: async (input: {
        threadId: string;
        actorId: string;
        agentId: string;
        text: string;
        conversationRunId?: string;
      }) => {
        transcript.push({
          actor: input.actorId,
          threadId: input.threadId,
          text: input.text,
          agentId: input.agentId,
          ...(input.conversationRunId && {
            conversationRunId: input.conversationRunId,
          }),
        });
      },
    } as never,
  });
  return { delivery, told, transcript, sent, turns };
}

const HOP = {
  key: "hop-1",
  message: "You are asked to find the outage window",
};

const ANSWERED: Outcome = { replyText: ANSWER, shared: false };

describe("a handoff delivered without Intelligence", () => {
  test("records the answering Bot's words in the asking Conversation's entry, under its own Bot, when they landed", async () => {
    const { delivery, told, sent } = harness(ANSWERED);

    expect(
      await delivery.deliver({
        work: WORK,
        ...HOP,
        assertion: "signed",
      }),
    ).toEqual({
      answer: ANSWER,
      conversationRunId: createHash("sha256").update("hop-1").digest("hex"),
      relayRequired: false,
    });
    // The roster admits only a Bot that is in the Conversation, and the answering Bot is not.
    expect(told).toEqual([
      {
        actor: "user-1",
        channelId: "channel-1",
        text: ANSWER,
        agentId: "assistant",
        at: LANDED,
      },
    ]);
    expect(sent).toEqual(["thread-1"]);
  });

  test("gives the Run it starts the statement the runner signed, which carries the hop's depth", async () => {
    const { delivery, turns } = harness(ANSWERED);

    await delivery.deliver({
      work: WORK,
      ...HOP,
      assertion: "signed",
    });

    // Without it the Run is taken to have begun with a person: depth zero, and no claim of its own.
    expect(turns).toHaveLength(1);
    expect(turns[0].assertion).toBe("signed");
  });

  test("tells again, of a hop that already answered, the same line at the same time", async () => {
    const { delivery, told } = harness(ANSWERED);

    await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" });
    await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" });

    expect(told).toHaveLength(2);
    // Compared as numbers: toMatchObject takes any Date for a Date.
    expect(told[0].at.getTime()).toBe(LANDED.getTime());
    expect(told[1]).toEqual(told[0]);
  });

  test("gives the entry nothing for a Run that said nothing, or that answered in a shared Conversation", async () => {
    for (const outcome of [
      { replyText: "", shared: false },
      { replyText: ANSWER, shared: true },
    ]) {
      const { delivery, told } = harness(outcome);

      await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" });

      expect(told).toEqual([]);
    }
  });

  test("tells an answer spoken back, and a notice, under the Bot that speaks in the asking Conversation", async () => {
    const back = {
      ...WORK,
      fromBotId: "researcher",
      toBotId: "assistant",
      answerIn: "thread-1",
    };
    for (const work of [back, { ...back, answer: ANSWER }]) {
      const { delivery, told } = harness(ANSWERED);

      await delivery.deliver({ work, ...HOP, assertion: "signed" });

      expect(told.map((line) => line.agentId)).toEqual(["assistant"]);
    }
  });

  test("writes a notice into a shared Conversation's transcript under its own Bot, and a relayed answer not a second time", async () => {
    const back = {
      ...WORK,
      fromBotId: "researcher",
      toBotId: "assistant",
      answerIn: "thread-1",
    };
    const shared: Outcome = { replyText: ANSWER, shared: true };

    // A notice carries no answer, so the asking Bot speaks; nothing else writes its turn in. Its
    // thread is a Bot's group thread, which maps to no channel.
    const notice = harness(shared, "none", "group");

    await notice.delivery.deliver({
      work: back,
      ...HOP,
      assertion: "signed",
    });

    expect(notice.transcript).toEqual([
      {
        actor: "user-1",
        threadId: "thread-1",
        text: ANSWER,
        agentId: "assistant",
        conversationRunId: createHash("sha256").update("hop-1").digest("hex"),
      },
    ]);
    expect(notice.told).toEqual([]);

    // A relayed answer is already in the transcript as the answering Bot's own message.
    const relay = harness(shared);

    await relay.delivery.deliver({
      work: { ...back, answer: ANSWER },
      ...HOP,
      assertion: "signed",
    });

    expect(relay.transcript).toEqual([]);
    expect(relay.told).toEqual([]);
  });

  test("tells of when the Run started once its events are gone", async () => {
    const { delivery, told } = harness(ANSWERED, "landing unreadable");

    await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" });

    expect(told.map((line) => line.at)).toEqual([STARTED]);
  });

  test("tells as now when nothing about the Run can be read", async () => {
    const { delivery, told } = harness(ANSWERED, "run unreadable");

    const before = Date.now();
    await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" });
    const after = Date.now();

    expect(told).toHaveLength(1);
    expect(told[0].at.getTime()).toBeGreaterThanOrEqual(before);
    expect(told[0].at.getTime()).toBeLessThanOrEqual(after);
  });

  test("reports a Run that did not happen, and tells the entry nothing", async () => {
    const { delivery, told, sent } = harness(new Error("The Bot Run failed."));

    await expect(
      delivery.deliver({ work: WORK, ...HOP, assertion: "signed" }),
    ).rejects.toThrow("The Bot Run failed.");
    expect(told).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("still reports the hop delivered, and the Conversation looked at, when the roster cannot take the line", async () => {
    const { delivery, told, sent } = harness(ANSWERED, "roster down");
    const logged = spyOn(console, "error").mockImplementation(() => {});

    expect(
      await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" }),
    ).toMatchObject({ answer: ANSWER, relayRequired: false });
    expect(told).toEqual([]);
    expect(sent).toEqual(["thread-1"]);
    // Nothing delivers this hop again, so the miss is the only trace of it.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
      type: "handoff-activity-unrecorded",
      key: "hop-1",
      reason: "roster down",
    });
    logged.mockRestore();
  });

  test("logs a failed query's reason without the statement or the values bound to it", async () => {
    const { delivery, told } = harness(ANSWERED, "query failure");
    const logged = spyOn(console, "error").mockImplementation(() => {});

    expect(
      await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" }),
    ).toMatchObject({ answer: ANSWER });
    expect(told).toEqual([]);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
      type: "handoff-activity-unrecorded",
      reason: "The database gave no reason this deployment can quote.",
    });
    expect(logged.mock.calls[0][0]).not.toContain("Failed query");
    expect(logged.mock.calls[0][0]).not.toContain(ANSWER);
    logged.mockRestore();
  });

  test("still reports the hop delivered, and logs it, when the person it is told for cannot be looked up", async () => {
    const { delivery, told, sent } = harness(ANSWERED, "owner unreadable");
    const logged = spyOn(console, "error").mockImplementation(() => {});

    expect(
      await delivery.deliver({ work: WORK, ...HOP, assertion: "signed" }),
    ).toMatchObject({ answer: ANSWER, relayRequired: false });
    expect(told).toEqual([]);
    expect(sent).toEqual(["thread-1"]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
      type: "handoff-activity-unrecorded",
      reason: "owner unreadable",
    });
    logged.mockRestore();
  });
});
