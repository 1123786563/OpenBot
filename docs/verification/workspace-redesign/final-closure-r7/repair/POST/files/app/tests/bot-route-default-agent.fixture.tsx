import { useState } from "react";
import { afterAll, mock } from "../../tests/support/bun-test-compat";

/*
 * Each handle is kept so the registry entries can be given back when this suite ends. Bun's
 * mock.module is process-wide and, as of Bun 1.4.2, returns no restore handle (probed:
 * undefined) — the afterAll below is inert on this runtime and starts unregistering the day
 * Bun ships the handle; until then these mocks stay behind for the later files of the host
 * group's single `bun test` process, all of which run (and pass) under them.
 */
const uninstallMocks: unknown[] = [
  mock.module("@copilotkit/react-core/v2", () => ({
    CopilotChat: ({
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
    ),
  })),

  mock.module("@/lib/copilot/active-bot", () => ({
    useActiveBot: () => undefined,
  })),

  mock.module("@/lib/copilot/bot-thread", () => ({
    useBotThread: (agentId: string) => {
      const [revision, setRevision] = useState(0);
      return {
        history: "ready",
        startNew: () => setRevision((value) => value + 1),
        threadId: `thread-${agentId}-${revision}`,
      };
    },
  })),

  mock.module("@/lib/copilot/stopped-turn", () => ({
    useStoppedTurn: () => null,
  })),
];

afterAll(() => {
  for (const uninstall of uninstallMocks) {
    if (typeof uninstall === "function") (uninstall as () => void)();
  }
});
