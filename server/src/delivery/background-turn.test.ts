import { describe, expect, test } from "bun:test";
import type { AgentActor } from "../agents/profile-types";
import type { BackgroundTurn } from "../channels/direct-chat";
import { createDeliveryTurn } from "./background-turn";

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
  return { turns, turn: createDeliveryTurn(runBackground, actorFor) };
}

describe("a delivery's OpenBot background turn", () => {
  test("forwards the person's words verbatim as a delivery-sourced turn", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "hello back", shared: false }),
    );
    const result = await turn({
      ownerUserId: "person-1",
      runId: "run-1",
      agentId: "bot-1",
      threadId: "thread-1",
      text: "the words are theirs",
    });
    expect(result).toEqual({ replyText: "hello back" });
    expect(turns).toEqual([
      {
        source: "delivery",
        id: "run-1",
        threadId: "thread-1",
        conversationBotId: "bot-1",
        personId: "person-1",
        agentId: "bot-1",
        prompt: "the words are theirs",
        authorize: expect.any(Function),
        initiator: { kind: "person" },
      },
    ]);
    // The owner is resolved by the background engine whenever it re-authorizes mid-run.
    expect(await turns[0].authorize()).toBe(actor);
  });

  test("a reply shared with a group is not also sent to the channel", async () => {
    const { turn } = harness(
      Promise.resolve({ replyText: "shared words", shared: true }),
    );
    expect(
      await turn({
        ownerUserId: "person-1",
        runId: "run-2",
        agentId: "bot-1",
        threadId: "thread-1",
        text: "hi",
      }),
    ).toEqual({ replyText: "" });
  });

  test("an owner who cannot be resolved authorizes as nobody", async () => {
    const { turns, turn } = harness(
      Promise.resolve({ replyText: "never read", shared: false }),
    );
    await turn({
      ownerUserId: "person-gone",
      runId: "run-3",
      agentId: "bot-1",
      threadId: "thread-1",
      text: "hi",
    });
    expect(await turns[0].authorize()).toBeNull();
  });
});
