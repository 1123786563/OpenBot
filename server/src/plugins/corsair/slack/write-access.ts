import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { BotAccessCheck } from "../../../agents/profile-policy";
import type { AgentActor } from "../../../agents/profile-types";
import type { ApprovalAction, ApprovalStore } from "../../../approvals/types";
import type { AuditStore } from "../../../audit";
import type { AppVariables } from "../../../auth/guards";
import { pluginGrants as grants } from "../../../db/schema/plugins";
import { corsairGrantRef } from "../grants";
import { slackAccounts, SlackPilotRefusal } from "./accounts";
import { SlackWritePermissionUnavailable, slackChannel } from "./provider";

export const tool = {
  ref: "corsair/slack.post_message",
  effect: "write",
  identity: "slack_user",
  resource: "registered_channel",
  permissions: ["chat:write", "channels:read", "groups:read"],
};
export const id = z.uuid();
export const botId = z.string().trim().min(1).max(200);
export const invocation = z.strictObject({
  botId,
  connectionId: id.optional(),
  channelId: slackChannel,
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.trim().length > 0),
});

export type Options = Omit<
  Parameters<typeof slackAccounts>[0],
  "clock" | "legacyDefaults"
> & {
  clock?: () => Date;
  legacyDefaults?: Parameters<typeof slackAccounts>[0]["legacyDefaults"];
  allowedChannels: ReadonlySet<string>;
  approvals: Pick<
    ApprovalStore,
    "open" | "get" | "decide" | "consume" | "saveResult" | "finish"
  >;
  audit: AuditStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
};

export function createSlackWriteAccess({
  allowedChannels,
  canUseBot,
  clock = () => new Date(),
  legacyDefaults = [],
  ...options
}: Omit<Options, "requireUser" | "audit" | "approvals">) {
  const { workspaceId, registration, provider, database } = options;
  const accounts = slackAccounts({ ...options, clock, legacyDefaults });
  const grantRef = corsairGrantRef(workspaceId, registration, tool.ref);
  const grantScope = (bot: string) =>
    and(
      eq(grants.kind, "corsair.slack"),
      eq(grants.agentId, bot),
      eq(grants.ref, grantRef),
    );
  const actorCanPost = async (actor: AgentActor, bot: string) =>
    (await canUseBot(actor, bot)) &&
    (
      await database
        .select({ bot: grants.agentId })
        .from(grants)
        .where(grantScope(bot))
    ).length > 0;
  type Invocation = z.infer<typeof invocation> & { connectionId: string };
  async function permitted(actor: AgentActor, input: Invocation) {
    if (
      !allowedChannels.has(input.channelId) ||
      !(await actorCanPost(actor, input.botId))
    )
      throw new SlackPilotRefusal(
        "A Slack channel in range and a current Bot Grant are required.",
        403,
      );
    return accounts.find(actor.id, input.connectionId);
  }

  function actionFor(
    personId: string,
    input: Invocation,
    connection: Awaited<ReturnType<typeof permitted>>,
    runId: string,
  ): ApprovalAction {
    const target = {
      workspaceId,
      registration,
      teamId: provider.teamId,
      subjectScope: connection.subjectScope,
      userId: connection.userId,
      connectionId: connection.id,
      revision: connection.revision,
      channelId: input.channelId,
    };
    const binding = {
      actorId: personId,
      botId: input.botId,
      toolRef: tool.ref,
      effect: tool.effect,
      scope: workspaceId,
      target,
      args: { text: input.text },
    };
    return {
      ...binding,
      dispatch: "explicit",
      account: connection.label,
      actionDigest: createHash("sha256")
        .update(JSON.stringify(binding))
        .digest("hex"),
      runId,
      toolCallId: runId,
      threadId: runId,
      policy: {
        behaviour: "ask",
        source: "safety",
        closed: true,
        reason: "Posting a message as a Slack user requires one-time Approval.",
      },
      declined: {
        eventType: "corsair.slack.write_refused",
        actorUserId: personId,
        targetType: "slack_channel",
        targetId: input.channelId,
        payload: {
          workspaceId,
          botId: input.botId,
          tool: tool.ref,
          target,
          reason: "Person denied the Approval.",
        },
      },
    };
  }

  async function verifiedTarget(
    actor: AgentActor,
    input: Invocation,
    action: ApprovalAction,
    verifyWriteScope = false,
  ) {
    const connection = await checkBinding(actor, input, action);
    const token = await accounts.verifiedToken(
      actor.id,
      connection.id,
      connection.revision,
    );
    try {
      await provider.checkChannel({
        token,
        channelId: input.channelId,
        userId: connection.userId,
        verifyWriteScope,
      });
    } catch (error) {
      if (error instanceof SlackWritePermissionUnavailable)
        throw new SlackPilotRefusal(
          "Slack could not verify the Connection's chat:write permission.",
          403,
        );
      throw new SlackPilotRefusal(
        "Slack could not verify membership in the selected channel.",
        403,
      );
    }
    return { token, userId: connection.userId };
  }

  async function checkBinding(
    actor: AgentActor,
    input: Invocation,
    action: ApprovalAction,
    tx?: Parameters<Parameters<Options["database"]["transaction"]>[0]>[0],
  ) {
    const connection = tx
      ? await accounts.find(actor.id, input.connectionId, tx)
      : await permitted(actor, input);
    if (
      tx &&
      !(
        await tx
          .select({ bot: grants.agentId })
          .from(grants)
          .where(grantScope(input.botId))
          .for("share")
      ).length
    )
      throw new SlackPilotRefusal(
        "A current Slack Bot Grant is required.",
        403,
      );
    if (
      actionFor(actor.id, input, connection, action.runId).actionDigest !==
      action.actionDigest
    )
      throw new SlackPilotRefusal(
        "The Slack action no longer matches its Approval.",
        409,
      );
    return connection;
  }
  return {
    accounts,
    grantRef,
    grantScope,
    actorCanPost,
    permitted,
    actionFor,
    checkBinding,
    verifiedTarget,
  };
}
