/**
 * A delivery's turn with nobody's browser open, on a deployment without CopilotKit
 * Intelligence.
 *
 * The headless toolkit runner (`toolkit/src/run-turn.ts`) drives every turn through the
 * Intelligence gateway, so on a deployment that configures none — `INTELLIGENCE_*` unset, the
 * chart's default — the first call, `getOrCreateThread`, throws `PlatformRequestError`
 * ("Intelligence is not configured.", 503) and the delivery disappears into the inbox's
 * generic failure with no Run row and no transcript (issue #133). The OpenBot background
 * engine (`direct-chat.runBackground`) has no such dependency, and routines already run on
 * it in exactly that case (`routines/runner.ts`); this file gives delivery the same branch.
 *
 * Unlike a routine's firing, the person's message is forwarded verbatim: no `frameFiring`
 * wrapper, because the words are theirs, not a schedule's.
 */
import type { AgentActor } from "../agents/profile-types";
import type { mountCopilotRuntime } from "../copilot";

export function createDeliveryTurn(
  runBackground: NonNullable<
    ReturnType<typeof mountCopilotRuntime>["runBackground"]
  >,
  actorFor: (personId: string) => Promise<AgentActor>,
) {
  return (input: {
    ownerUserId: string;
    runId: string;
    agentId: string;
    threadId: string;
    text: string;
  }) =>
    runBackground({
      source: "delivery",
      id: input.runId,
      threadId: input.threadId,
      conversationBotId: input.agentId,
      personId: input.ownerUserId,
      agentId: input.agentId,
      prompt: input.text,
      authorize: () => actorFor(input.ownerUserId).catch(() => null),
      initiator: { kind: "person" },
    }).then(({ replyText, shared }) => ({
      replyText: shared ? "" : replyText,
    }));
}
