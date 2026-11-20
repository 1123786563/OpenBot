import { expect, test } from "bun:test";
import {
  EventType,
  ProxiedCopilotRuntimeAgent,
} from "@copilotkit/react-core/v2";
import { DIRECT_CHAT_REPLAY_HEADER } from "@openbot/shared/direct-chat-replay";
import { withDirectChatReconnect } from "../src/lib/copilot/direct-chat-reconnect";

const key = { threadId: "thread-1", runId: "run-1" };
const userMessage = { id: "question", role: "user" as const, content: "Hello" };
const started = { type: EventType.RUN_STARTED, ...key };
const textStart = { type: EventType.TEXT_MESSAGE_START, messageId: "answer" };
const textEnd = { type: EventType.TEXT_MESSAGE_END, messageId: "answer" };
const finished = { type: EventType.RUN_FINISHED, ...key };
const content = (delta: string) => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "answer",
  delta,
});
const frame = (cursor: number | undefined, event: object) =>
  `${cursor === undefined ? "" : `id: ${cursor}\n`}data: ${JSON.stringify(event)}\n\n`;
const stream = (...frames: string[]) =>
  new Response(frames.join(""), {
    headers: {
      "content-type": "text/event-stream",
      [DIRECT_CHAT_REPLAY_HEADER]: key.runId,
    },
  });

test.each([false, true])(
  "the Web agent resumes an expired cursor even when message start was missed (%s)",
  async (sawTextStart) => {
    const agent = new ProxiedCopilotRuntimeAgent({
      runtimeUrl: "http://openbot.test/api/copilotkit",
      transport: "rest",
      agentId: "bot-1",
      threadId: key.threadId,
    });
    agent.setMessages([userMessage]);
    const requests: string[] = [];
    const approvals: unknown[] = [];
    agent.fetch = withDirectChatReconnect(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith("/run"))
        return stream(
          frame(1, started),
          ...(sawTextStart ? [frame(2, textStart)] : []),
        );
      expect(JSON.parse(String(init.body))).toEqual({
        ...key,
        cursor: sawTextStart ? 2 : 1,
      });
      return stream(
        frame(undefined, {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            userMessage,
            { id: "answer", role: "assistant", content: "Saved " },
          ],
        }),
        frame(3, {
          type: EventType.CUSTOM,
          name: "openbot.run.snapshot",
          value: {
            ...key,
            cursor: 3,
            status: "running",
            pendingApprovals: [{ id: "approval", toolCallId: "call" }],
          },
        }),
        frame(4, content("answer")),
        frame(5, textEnd),
        frame(6, finished),
      );
    });

    await agent.runAgent(key, {
      onCustomEvent({ event }) {
        if (event.name === "openbot.run.snapshot") approvals.push(event.value);
      },
    });
    expect(requests).toEqual([
      "/api/copilotkit/agent/bot-1/run",
      "/api/copilotkit/agent/bot-1/resume",
    ]);
    expect(approvals).toEqual([
      {
        ...key,
        cursor: 3,
        status: "running",
        pendingApprovals: [{ id: "approval", toolCallId: "call" }],
      },
    ]);
    expect(agent.messages).toEqual([
      userMessage,
      { id: "answer", role: "assistant", content: "Saved answer" },
    ]);
  },
);
