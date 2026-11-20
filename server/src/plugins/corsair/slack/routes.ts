import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { BotAccessCheck } from "../../../agents/profile-policy";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  ApprovalRefusedError,
  type ApprovalStore,
} from "../../../approvals/types";
import {
  type AuditEventInput,
  type AuditStore,
  recordAuditEvent,
} from "../../../audit";
import { type AppVariables, requireAdmin } from "../../../auth/guards";
import { pluginGrants as grants } from "../../../db/schema/plugins";
import { corsairGrantRef } from "../grants";
import { SlackPilotRefusal, slackAccounts } from "./accounts";
import { slackChannel } from "./provider";

const tool = {
  ref: "corsair/slack.post_message",
  effect: "write",
  identity: "slack_user",
  resource: "registered_channel",
  permissions: ["chat:write", "channels:read", "groups:read"],
};
const id = z.uuid();
const botId = z.string().trim().min(1).max(200);
const invocation = z.strictObject({
  botId,
  connectionId: id.optional(),
  channelId: slackChannel,
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.trim().length > 0),
});

type Options = Omit<
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

export function createSlackPilotRoutes({
  allowedChannels,
  approvals,
  audit,
  requireUser,
  canUseBot,
  clock = () => new Date(),
  legacyDefaults = [],
  ...options
}: Options) {
  const { workspaceId, registration, provider, database } = options;
  const accounts = slackAccounts({ ...options, clock, legacyDefaults });
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.method !== "GET" && c.req.header("X-OpenBot-Pilot") !== "slack")
      return c.json(
        { error: "The Slack pilot request header is required." },
        403,
      );
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof SlackPilotRefusal)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ApprovalNotFoundError)
      return c.json({ error: "Approval unavailable." }, 404);
    if (error instanceof ApprovalRefusedError)
      return c.json({ error: "Approval unavailable for this action." }, 409);
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return c.json({ error: "Invalid Slack pilot request." }, 400);
    return c.json(
      { error: "The Slack pilot could not complete the request." },
      500,
    );
  });
  const grantRef = corsairGrantRef(workspaceId, registration, tool.ref);
  const grantScope = (bot: string) =>
    and(
      eq(grants.kind, "corsair.slack"),
      eq(grants.agentId, bot),
      eq(grants.ref, grantRef),
    );
  const actorCanPost = async (actor: AppVariables["actor"], bot: string) =>
    (await canUseBot(actor, bot)) &&
    (
      await database
        .select({ bot: grants.agentId })
        .from(grants)
        .where(grantScope(bot))
    ).length > 0;
  const trail = (
    actorUserId: string,
    eventType: AuditEventInput["eventType"],
    targetType: string,
    targetId: string,
    payload: Record<string, unknown>,
  ) =>
    recordAuditEvent(audit, {
      eventType,
      actorUserId,
      targetType,
      targetId,
      payload: { workspaceId, registration, ...payload },
    });

  routes.post("/connect", async (c) =>
    c.json({ authorizationUrl: await accounts.start(c.var.actor.id) }, 201),
  );
  routes.get("/callback", async (c) => {
    const { state, code } = z
      .object({
        state: z.string().regex(/^[\w-]{43}$/),
        code: z.string().min(1).max(1024),
      })
      .parse(c.req.query());
    const result = await accounts.connect(c.var.actor.id, state, code);
    const { id: connectionId, subjectScope, userId } = result.connection;
    await trail(
      c.var.actor.id,
      "corsair.slack.connected",
      "connection",
      connectionId,
      { subjectScope, userId, inheritedFrom: result.inheritedFrom },
    );
    return c.json({ connection: result.connection });
  });
  routes.get("/connections", async (c) =>
    c.json(await accounts.list(c.var.actor.id)),
  );
  routes.put("/connections/default", async (c) => {
    const { connectionId } = z
      .strictObject({ connectionId: id })
      .parse(await c.req.json());
    await accounts.setDefault(c.var.actor.id, connectionId);
    return c.json({ defaultConnectionId: connectionId });
  });
  routes.put("/bots/:botId/grant", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const bot = botId.parse(c.req.param("botId"));
    if (!(await canUseBot(c.var.actor, bot)))
      throw new SlackPilotRefusal("This Bot is unavailable.", 403);
    const { enabled } = z
      .strictObject({ enabled: z.boolean() })
      .parse(await c.req.json());
    if (enabled)
      await database
        .insert(grants)
        .values({
          kind: "corsair.slack",
          ref: grantRef,
          agentId: bot,
          grantedBy: c.var.actor.id,
          grantedAs: "admin",
        })
        .onConflictDoNothing();
    else await database.delete(grants).where(grantScope(bot));
    await trail(c.var.actor.id, "corsair.slack.grant_changed", "bot", bot, {
      tool: tool.ref,
      enabled,
    });
    return c.json({ enabled });
  });
  routes.get("/bots/:botId/tools", async (c) =>
    c.json({
      tools: (await actorCanPost(
        c.var.actor,
        botId.parse(c.req.param("botId")),
      ))
        ? [tool]
        : [],
    }),
  );

  type Invocation = z.infer<typeof invocation> & { connectionId: string };
  async function permitted(actor: AppVariables["actor"], input: Invocation) {
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

  routes.post("/approvals", async (c) => {
    const selection = invocation.parse(await c.req.json());
    const actor = c.var.actor;
    const connectionId =
      selection.connectionId ?? (await accounts.defaultConnectionId(actor.id));
    if (!connectionId)
      throw new SlackPilotRefusal(
        "Choose a verified Slack default or select a Connection for this action.",
        409,
      );
    const input = { ...selection, connectionId };
    const action = actionFor(
      actor.id,
      input,
      await permitted(actor, input),
      randomUUID(),
    );
    const approval = await approvals.open(action);
    return c.json(
      {
        id: approval.id,
        status: approval.status,
        action: {
          tool,
          args: action.args,
          target: action.target,
          account: action.account,
        },
      },
      201,
    );
  });

  async function ownedApproval(personId: string, approvalId: string) {
    const record = await approvals.get(personId, approvalId);
    const pinned = z
      .object({
        registration: z.literal(registration),
        channelId: slackChannel,
        connectionId: id,
        userId: z.string(),
      })
      .safeParse(record.action.target);
    if (
      record.action.dispatch !== "explicit" ||
      record.action.toolRef !== tool.ref ||
      record.action.scope !== workspaceId ||
      !pinned.success
    )
      throw new ApprovalNotFoundError();
    return { record, pinned: pinned.data };
  }

  routes.post("/approvals/:id/decision", async (c) => {
    const approvalId = id.parse(c.req.param("id"));
    const personId = c.var.actor.id;
    await ownedApproval(personId, approvalId);
    const { decision } = z
      .strictObject({ decision: z.enum(["allow_once", "deny"]) })
      .parse(await c.req.json());
    const record = await approvals.decide(personId, approvalId, decision);
    return c.json({ id: record.id, status: record.status });
  });

  routes.post("/approvals/:id/execute", async (c) => {
    const approvalId = id.parse(c.req.param("id"));
    const supplied = invocation.parse(await c.req.json());
    const actor = c.var.actor;
    const { record, pinned } = await ownedApproval(actor.id, approvalId);
    const input = { ...supplied, connectionId: pinned.connectionId };
    const log = (
      event: AuditEventInput["eventType"],
      details: Record<string, unknown> = {},
    ) =>
      trail(actor.id, event, "slack_channel", pinned.channelId, {
        approvalId,
        botId: record.action.botId,
        tool: tool.ref,
        target: record.action.target,
        ...details,
      });
    async function checkBinding() {
      const connection = await permitted(actor, input);
      if (
        actionFor(actor.id, input, connection, record.action.runId)
          .actionDigest !== record.action.actionDigest
      )
        throw new SlackPilotRefusal(
          "The Slack action no longer matches its Approval.",
          409,
        );
      return connection;
    }
    let token: string;
    try {
      if (record.status !== "approved" || record.decision !== "allow_once")
        throw new SlackPilotRefusal(
          "A current one-time Approval is required.",
          409,
        );
      if (
        supplied.connectionId !== undefined &&
        supplied.connectionId !== pinned.connectionId
      )
        throw new SlackPilotRefusal(
          "The Slack Connection no longer matches its Approval.",
          409,
        );
      const connection = await checkBinding();
      token = await accounts.verifiedToken(
        actor.id,
        connection.id,
        connection.revision,
      );
      try {
        await provider.checkChannel({
          token,
          channelId: input.channelId,
          userId: connection.userId,
        });
      } catch {
        throw new SlackPilotRefusal(
          "Slack could not verify membership in the selected channel.",
          403,
        );
      }
      await checkBinding();
      if (
        !(await approvals.consume(
          actor.id,
          approvalId,
          record.action.actionDigest,
        ))
      )
        throw new SlackPilotRefusal(
          "This Approval is no longer available.",
          409,
        );
    } catch (error) {
      await log("corsair.slack.write_refused", {
        reason:
          error instanceof SlackPilotRefusal
            ? error.message
            : "Authorization could not be verified.",
      });
      throw error;
    }
    await log("corsair.slack.write_started");
    let message: Awaited<ReturnType<typeof provider.postMessage>>;
    try {
      message = await provider.postMessage({
        token,
        channel: input.channelId,
        text: input.text,
        userId: pinned.userId,
      });
    } catch {
      const reason =
        "Slack did not confirm the channel and user for this write. Check Slack before requesting another Approval.";
      await log("corsair.slack.write_unconfirmed");
      await approvals.saveResult(actor.id, approvalId, {
        content: reason,
        error: reason,
      });
      await approvals.finish(actor.id, approvalId);
      throw new SlackPilotRefusal(reason, 502);
    }
    await log("corsair.slack.write_succeeded", {
      timestamp: message.timestamp,
    });
    await approvals.saveResult(actor.id, approvalId, {
      content: `Slack message ${message.channel}/${message.timestamp}`,
    });
    await approvals.finish(actor.id, approvalId);
    return c.json({ message });
  });
  return routes;
}
