import { describe, expect, test } from "bun:test";
import type { AgentActor } from "../src/agents/profile-types";
import type { BackgroundTurn } from "../src/channels/direct-chat";
import { createPersonResponseTurn } from "../src/approvals/person-response-turn";

const actor: AgentActor = { id: "person-1", role: "user" };

function harness(reply: Promise<{ replyText: string; shared: boolean }>) {
  const turns: BackgroundTurn[] = [];
  const runBackground = (turn: BackgroundTurn) => {
    turns.push(turn);
    return reply;
  };
  const actorFor = async (personId: string): Promise<AgentActor> => {
    if (personId !== "person-1") throw new Error("unknown person");
    return actor;
  };
  return { turns, turn: createPersonResponseTurn(runBackground, actorFor) };
}

const answer = {
  ownerUserId: "person-1",
  routineId: "person-response",
  agentId: "bot-1",
  threadId: "thread-1",
  instruction: "",
  userMessage: {
    id: "person-response:q-1",
    role: "user" as const,
    content: "In response to your question: which region?\n\neu-west",
  },
};

describe("a person's answer as an OpenBot background turn", () => {
  test("forwards the answer verbatim, as the conversation's Bot, under the question's initiator", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "Checking eu-west.", shared: false }),
    );
    const result = await turn({
      ...answer,
      initiator: { kind: "routine", id: "routine-1" },
    });
    expect(result).toEqual({ replyText: "Checking eu-west." });
    expect(turns).toHaveLength(1);
    const id = turns[0].id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(turns[0]).toMatchObject({
      source: "delivery",
      id,
      threadId: "thread-1",
      conversationBotId: "bot-1",
      personId: "person-1",
      agentId: "bot-1",
      prompt: answer.userMessage.content,
      initiator: { kind: "routine", id: "routine-1" },
    });
    // One Run per answer, however often the sweep hands it out.
    await turn({ ...answer, initiator: { kind: "routine", id: "routine-1" } });
    expect(turns[1].id).toBe(id);
    expect(await turns[0].authorize()).toBe(actor);
  });

  test("carries the pass's stop signal and its last check before dispatch", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "ok", shared: false }),
    );
    const signal = new AbortController().signal;
    const beforeDispatch = async () => {};
    await turn({ ...answer, signal, beforeDispatch });
    expect(turns[0].signal).toBe(signal);
    expect(turns[0].beforeDispatch).toBe(beforeDispatch);
  });

  test("an answer with no initiator of its own is a person's turn", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "ok", shared: false }),
    );
    await turn(answer);
    expect(turns[0].initiator).toEqual({ kind: "person" });
  });

  test("a reply in a shared Conversation is not also sent to the channel", async () => {
    const { turn } = harness(
      Promise.resolve({ replyText: "shared words", shared: true }),
    );
    expect(await turn(answer)).toEqual({ replyText: "" });
  });

  test("an answer with no words is not run", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "never", shared: false }),
    );
    expect(() => turn({ ...answer, userMessage: undefined })).toThrow(
      "A person's answer requires their words.",
    );
    expect(turns).toEqual([]);
  });
});
