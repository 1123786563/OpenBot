import { afterAll, spyOn } from "bun:test";
import { useState } from "react";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import * as ActiveBot from "@/lib/copilot/active-bot";
import * as BotThread from "@/lib/copilot/bot-thread";
import * as StoppedTurn from "@/lib/copilot/stopped-turn";

/*
 * Restorable stand-ins for the chat SDK surface the Bot route draws on, installed as NAMESPACE
 * SPIES rather than `mock.module`, because bun cannot take a module mock back off: a
 * registry-level mock would stay installed for every test file walked into the same process
 * afterwards (see composer-queue-attachments.test.tsx). A spy is restorable, and the `afterAll`
 * below genuinely puts the real module back.
 */
const copilotChatSpy = spyOn(ReactCoreV2, "CopilotChat").mockImplementation((({
  agentId,
  threadId,
}: {
  agentId: string;
  threadId?: string;
}) => (
  <div
    data-agent-id={agentId}
    data-thread-id={threadId}
    data-testid="copilot-chat"
  >
    <textarea aria-label="Chat draft" />
  </div>
)) as never);

const useActiveBotSpy = spyOn(ActiveBot, "useActiveBot").mockImplementation(
  () => undefined,
);

/*
 * The thread hook keeps the revision in state, as the real one keeps its own: `startNew` must
 * move `threadId` so the test can see the chat actually remount on the new thread. The stateful
 * fake still runs inside React's render, as a hook has to.
 */
const useBotThreadSpy = spyOn(BotThread, "useBotThread").mockImplementation(
  (agentId: string) => {
    const [revision, setRevision] = useState(0);
    return {
      history: "ready",
      startNew: () => setRevision((value) => value + 1),
      threadId: `thread-${agentId}-${revision}`,
    } as const;
  },
);

const useStoppedTurnSpy = spyOn(
  StoppedTurn,
  "useStoppedTurn",
).mockImplementation(() => null);

afterAll(() => {
  copilotChatSpy.mockRestore();
  useActiveBotSpy.mockRestore();
  useBotThreadSpy.mockRestore();
  useStoppedTurnSpy.mockRestore();
});
