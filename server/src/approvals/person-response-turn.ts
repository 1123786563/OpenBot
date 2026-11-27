/**
 * The person's answer to a Bot's question, resumed as a turn with nobody's browser open, on a
 * deployment without CopilotKit Intelligence.
 *
 * The headless toolkit runner drives every turn through the Intelligence gateway, so on a
 * deployment that configures none the answer disappears into the sweep's generic failure (issue
 * #133, the same reason deliveries run on the OpenBot background engine). This is that branch for
 * a queued answer.
 *
 * The answer is the person's words, forwarded verbatim; the turn is the conversation's own Bot's
 * (`questionConversationBot`), under the question's own initiator, so a Routine's chain stays a
 * Routine's work and a hand-off's stays a hand-off's. A reply the engine reports as shared comes
 * back empty, as a delivery's does: the sweep then neither records it nor sends it on.
 */
import { createHash } from "node:crypto";
import type { AuditInitiator } from "@openbot/toolkit/initiator";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import type { mountCopilotRuntime } from "../copilot";

export function createPersonResponseTurn(
  runBackground: NonNullable<
    ReturnType<typeof mountCopilotRuntime>["runBackground"]
  >,
  actorFor: (personId: string) => Promise<AgentActor>,
): TurnRunner {
  return ({
    ownerUserId,
    agentId,
    threadId,
    initiator,
    userMessage,
    signal,
    beforeDispatch,
  }) => {
    if (!userMessage || typeof userMessage.content !== "string")
      throw new Error("A person's answer requires their words.");
    return runBackground({
      source: "delivery",
      // One Run per answer, however often the sweep hands it out.
      id: createHash("sha256").update(userMessage.id).digest("hex"),
      threadId,
      conversationBotId: agentId,
      personId: ownerUserId,
      agentId,
      prompt: userMessage.content,
      signal,
      beforeDispatch,
      authorize: () => actorFor(ownerUserId).catch(() => null),
      initiator: initiator ?? ({ kind: "person" } satisfies AuditInitiator),
    }).then(({ replyText, shared }) => ({
      replyText: shared ? "" : replyText,
    }));
  };
}
