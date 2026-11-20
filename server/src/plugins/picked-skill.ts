/**
 * The skill a person picked for a message, and the instructions the Bot is given for it.
 *
 * A skill is picked from the composer's `/` menu, which puts a chip at the start of the message
 * that is sent as `/<command>`. The Bot has to be told what that skill says, and it has to be told
 * by this server: the browser used to send the instructions as a system row of its own, and no Bot
 * read them as instructions. A built-in Bot's runtime drops every system row, and each harness this
 * deployment runs reads a system row that is not the server's own as conversation data, which is
 * right for anything a browser can write. On the Mac Desktop a person's "Pirate haiku" skill was
 * guessed at from its name, and the Bot, asked, said it had been given no instructions.
 *
 * So the server reads the command, checks it against the skills this Bot holds, and puts that
 * skill's stored instructions into the instructions it writes for the run itself: the built-in
 * prompt, or the standing role a remote Bot is sent. Nothing a request carries becomes an
 * instruction; a command only chooses among what the Bot already holds, as typing it does.
 */
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import {
  EventType,
  type RunErrorEvent,
  type RunStartedEvent,
} from "@ag-ui/core";
import { PICKED_SKILL_PROP } from "@openbot/toolkit/run-turn";
import { of } from "rxjs";
import {
  type MarketVersionIdentity,
  marketVersionDisabledMessage,
} from "../skill-market/disablements";
import { latestUserText } from "./selection";

export { PICKED_SKILL_PROP };

/** A skill as a run needs it: its command, its name, and what it tells the Bot. */
export type PickableSkill = {
  slug: string;
  title: string;
  instructions?: string;
  marketVersion?: {
    identity: MarketVersionIdentity & { fingerprint: string };
    disableReason: string | null;
  };
};

/**
 * The command a message starts with, or undefined.
 *
 * Only at the very start, as the composer's `/` menu only opens there, and only a whole command
 * followed by a space, a line break or the end: "please /pirate-haiku" and "/pirate-haiku," are
 * words, not a pick. Lower-case letters, numbers and hyphens, the characters a command is made of.
 */
export function leadingSkillCommand(text: string): string | undefined {
  return /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(text)?.[1];
}

/**
 * The command this run was asked to use: the one a headless host stated for its turn, or the one
 * the person's latest message starts with. An earlier message's command is not this run's.
 */
export function pickedSkillCommand(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
): string | undefined {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  const stated = props?.[PICKED_SKILL_PROP];
  if (typeof stated === "string") return stated;
  return leadingSkillCommand(latestUserText(input.messages));
}

export type PickedSkillAdmission =
  | { kind: "none" }
  | { kind: "refused"; reason: string }
  | {
      kind: "admitted";
      guidance: string;
      marketVersion?: NonNullable<PickableSkill["marketVersion"]>["identity"];
    };

/** Resolve the picked skill from the Bot's current holdings and local version status. */
export async function admitPickedSkill(
  input: Pick<RunAgentInput, "messages" | "forwardedProps">,
  loadSkills: () => Promise<readonly PickableSkill[]>,
): Promise<PickedSkillAdmission> {
  const command = pickedSkillCommand(input);
  if (!command) return { kind: "none" };
  const held = await loadSkills().catch(() => null);
  if (!held)
    return {
      kind: "refused",
      reason:
        "OpenBot couldn't check whether this skill is available. Try again.",
    };
  const skill = held.find((candidate) => candidate.slug === command);
  if (!skill) return { kind: "none" };
  const version = skill.marketVersion;
  if (version && version.disableReason !== null) {
    return {
      kind: "refused",
      reason: marketVersionDisabledMessage(
        version.identity.version,
        version.disableReason,
      ),
    };
  }

  const instructions = skill.instructions?.trim();
  if (!instructions) return { kind: "none" };
  return {
    kind: "admitted",
    guidance: [
      `The person picked the skill "${skill.title || skill.slug}" (/${skill.slug}) for their latest message. Follow its instructions for this reply:`,
      instructions,
    ].join("\n\n"),
    ...(version ? { marketVersion: version.identity } : {}),
  };
}

export class PickedSkillRefusal extends AbstractAgent {
  constructor(private readonly reason: string) {
    super();
  }

  run(input: RunAgentInput) {
    return of<[RunStartedEvent, RunErrorEvent]>(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.RUN_ERROR,
        code: "PICKED_SKILL_UNAVAILABLE",
        message: this.reason,
      },
    );
  }
}
