import { mock } from "bun:test";
import { useState } from "react";

mock.module("@copilotkit/react-core/v2", () => ({
  CopilotChatInput: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label="Message"
      value={value}
      onInput={(event) => onChange?.(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
  CopilotChat: ({
    agentId,
    input: Input,
    threadId,
  }: {
    agentId: string;
    input: React.ComponentType<{
      value: string;
      onChange: (value: string) => void;
    }>;
    threadId?: string;
  }) => {
    const [value, setValue] = useState("");
    return (
      <div
        data-agent-id={agentId}
        data-thread-id={threadId}
        data-testid="copilot-chat"
      >
        <Input value={value} onChange={setValue} />
      </div>
    );
  },
}));

/*
 * `@/lib/copilot/active-bot` IS NOT MOCKED, though the route calls `useActiveBot`. Drawn without an
 * `ActiveBotProvider`, as these tests draw it, the real hook finds no holder and does nothing — which
 * is all the mock that used to be here did. And a module mock is not this file's to keep: bun cannot
 * take one back off, so a replacement exporting only `useActiveBot` stood in for the whole module in
 * every file walked into the same process, and `useDeclaredBotId` — the app-access card's fallback
 * for a refusal that names no Bot — stopped existing there.
 */

mock.module("@/lib/copilot/bot-thread", () => ({
  useBotThread: (agentId: string) => {
    const [revision, setRevision] = useState(0);
    return {
      history: "ready",
      startNew: () => setRevision((value) => value + 1),
      threadId: `thread-${agentId}-${revision}`,
    };
  },
}));

mock.module("@/lib/copilot/stopped-turn", () => ({
  useStoppedTurn: () => null,
}));

// Reads the same shared agent `useStoppedTurn` does, which needs the CopilotKit provider this page is drawn without.
mock.module("@/lib/copilot/bot-activity", () => ({
  useBotActivity: () => {},
}));
