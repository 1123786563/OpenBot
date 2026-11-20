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
import type { Database } from "../../../db/client";
import {
  slackSharedBotAccess as access,
  slackSharedInstallations as installations,
} from "../../../db/schema/corsair-slack";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
} from "../../../db/schema/responsibilities";
import { responsibilitySources } from "../../../responsibilities/types";
import {
  admits,
  OWNER_STEERED_SOURCES,
  SHARED_AUDIENCES,
} from "../../shared-use";
import type { SharedUseStore } from "../../shared-use-store";
import { slackChannel } from "./provider";
import {
  type SharedSlackProvider,
  slackInstallationIdentity,
  sharedSlackTool as tool,
} from "./shared-provider";

const id = z.uuid();
const botId = z.string().trim().min(1).max(200);
const invocation = z.strictObject({
  botId,
  channelId: slackChannel,
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.trim().length > 0),
});
const policy = z
  .strictObject({
    audience: z.enum(SHARED_AUDIENCES),
    outsideInput: z.boolean(),
    members: z
      .array(
        z.strictObject({
          kind: z.enum(["user", "group"]),
          value: z.string().trim().min(1).max(200),
        }),
      )
      .max(100),
  })
  .refine((rule) =>
    rule.audience === "people"
      ? rule.members.length > 0
      : rule.members.length === 0,
  );
const origin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person") }),
  z.strictObject({
    kind: z.literal("goal"),
    runId: z.string().min(1),
    eventId: z.string().min(1),
    goalId: z.string().min(1),
    source: z.enum(responsibilitySources),
  }),
]);
const target = z.strictObject({
  installationId: id,
  channelId: slackChannel,
  identity: slackInstallationIdentity,
  origin,
});
type Origin = z.infer<typeof origin>;
type Invocation = z.infer<typeof invocation>;
type Actor = AppVariables["actor"];
type Target = z.infer<typeof target>;

class SharedSlackRefusal extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

export function createSharedSlackPilot({
  database,
  workspaceId,
  provider,
  requireUser,
  approvals,
  audit,
  sharedUse,
  canUseBot,
}: {
  database: Database;
  workspaceId: string;
  provider: SharedSlackProvider;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  approvals: Pick<
    ApprovalStore,
    "open" | "get" | "decide" | "consume" | "saveResult" | "finish"
  >;
  audit: AuditStore;
  sharedUse: Pick<SharedUseStore, "botFacts" | "actorFacts">;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET" && c.req.header("X-OpenBot-Pilot") !== "slack")
      return c.json(
        { error: "The Slack pilot request header is required." },
        403,
      );
    await next();
  });
  routes.onError((error, c) => {
    if (error instanceof SharedSlackRefusal)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ApprovalNotFoundError)
      return c.json({ error: "Approval unavailable." }, 404);
    if (error instanceof ApprovalRefusedError)
      return c.json({ error: "Approval unavailable for this action." }, 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "Invalid shared Slack request." }, 400);
    return c.json(
      { error: "The shared Slack pilot could not complete the request." },
      500,
    );
  });
  const workspace = eq(installations.workspaceId, workspaceId);
  async function installation() {
    const [record] = await database
      .select()
      .from(installations)
      .where(workspace);
    if (!record)
      throw new SharedSlackRefusal(
        "No shared Slack installation is enrolled.",
        404,
      );
    return record;
  }
  function view({
    id,
    channelIds,
    appId,
    teamId,
    botId,
    botUserId,
  }: typeof installations.$inferSelect) {
    return { id, channelIds, identity: { appId, teamId, botId, botUserId } };
  }
  function matches(record: typeof installations.$inferSelect) {
    const { appId, teamId, botId, botUserId } = provider.identity;
    return (
      record.appId === appId &&
      record.teamId === teamId &&
      record.botId === botId &&
      record.botUserId === botUserId
    );
  }
  routes.get("/installation", async (c) => {
    const forbidden = requireAdmin(c);
    return forbidden ?? c.json(view(await installation()));
  });
  routes.put("/installation", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const input = z
      .strictObject({ channelIds: z.array(slackChannel).min(1).max(20) })
      .parse(await c.req.json());
    const channelIds = [...new Set(input.channelIds)].sort();
    try {
      await provider.verifyIdentity();
      for (const channelId of channelIds)
        await provider.checkChannel(channelId);
    } catch {
      throw new SharedSlackRefusal(
        "Slack could not verify the installation or every selected channel.",
        502,
      );
    }
    const record = await database.transaction(async (tx) => {
      const values = { workspaceId, ...provider.identity, channelIds };
      const [inserted] = await tx
        .insert(installations)
        .values(values)
        .onConflictDoNothing({ target: installations.workspaceId })
        .returning();
      if (inserted) return inserted;
      const [current] = await tx
        .select()
        .from(installations)
        .where(workspace)
        .for("update");
      if (!current)
        throw new SharedSlackRefusal("The enrollment changed. Try again.", 409);
      if (
        matches(current) &&
        JSON.stringify(current.channelIds) === JSON.stringify(channelIds)
      )
        return current;
      await tx.delete(installations).where(workspace);
      const [replacement] = await tx
        .insert(installations)
        .values(values)
        .returning();
      return replacement;
    });
    await trail(
      c.var.actor,
      "corsair.slack.shared_enrollment_changed",
      "workspace",
      workspaceId,
      { installationId: record.id, channelIds },
    );
    return c.json(view(record));
  });
  const trail = (
    actor: Actor,
    eventType: AuditEventInput["eventType"],
    targetType: string,
    targetId: string,
    details: Record<string, unknown>,
    source?: Origin,
  ) =>
    recordAuditEvent(audit, {
      eventType,
      targetType,
      targetId,
      actorUserId: actor.id,
      ...(source?.kind === "goal"
        ? { initiator: { kind: "responsibility", id: source.goalId } }
        : {}),
      payload: {
        workspaceId,
        identityKind: tool.identity,
        identity: provider.identity,
        ...details,
      },
    });

  routes.delete("/installation", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    await database.delete(installations).where(workspace);
    await trail(
      c.var.actor,
      "corsair.slack.shared_enrollment_changed",
      "workspace",
      workspaceId,
      { removed: true },
    );
    return c.body(null, 204);
  });
  const held = (installationId: string, bot: string) =>
    and(eq(access.installationId, installationId), eq(access.botId, bot));
  async function setBotAccess(
    actor: Actor,
    bot: string,
    change: { granted: boolean } | { approval: z.infer<typeof policy> | null },
  ) {
    if (!(await canUseBot(actor, bot)))
      throw new SharedSlackRefusal("This Bot is unavailable.", 403);
    const current = await installation();
    if (!matches(current))
      throw new SharedSlackRefusal(
        "Enroll the configured Slack installation first.",
        409,
      );
    await database
      .insert(access)
      .values({ installationId: current.id, botId: bot, ...change })
      .onConflictDoUpdate({
        target: [access.installationId, access.botId],
        set: change,
      });
    await trail(actor, "corsair.slack.shared_access_changed", "bot", bot, {
      installationId: current.id,
      tool: tool.ref,
      ...change,
    });
    return change;
  }
  routes.put("/bots/:botId/grant", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const { enabled } = z
      .strictObject({ enabled: z.boolean() })
      .parse(await c.req.json());
    await setBotAccess(c.var.actor, botId.parse(c.req.param("botId")), {
      granted: enabled,
    });
    return c.json({ enabled });
  });
  routes.put("/bots/:botId/shared-use", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const change = z
      .strictObject({ approval: policy.nullable() })
      .parse(await c.req.json());
    return c.json(
      await setBotAccess(
        c.var.actor,
        botId.parse(c.req.param("botId")),
        change,
      ),
    );
  });

  async function goalOrigin(
    actor: Actor,
    bot: string,
    runId: string,
  ): Promise<Origin> {
    const [row] = await database
      .select({
        eventId: responsibilityEvents.id,
        source: responsibilityEvents.source,
        goalId: responsibilities.id,
      })
      .from(responsibilityRuns)
      .innerJoin(
        responsibilities,
        eq(responsibilities.id, responsibilityRuns.responsibilityId),
      )
      .innerJoin(
        responsibilityEvents,
        eq(responsibilityEvents.id, responsibilityRuns.eventId),
      )
      .where(
        and(
          eq(responsibilityRuns.id, runId),
          eq(responsibilities.ownerUserId, actor.id),
          eq(responsibilities.agentId, bot),
          eq(responsibilityEvents.ownerUserId, actor.id),
        ),
      );
    const result = origin.safeParse(row && { kind: "goal", runId, ...row });
    if (!result.success)
      throw new SharedSlackRefusal(
        "The Goal Run origin could not be verified.",
        403,
      );
    return result.data;
  }

  async function permitted(
    actor: Actor,
    input: Invocation,
    source: Origin,
  ): Promise<Target> {
    const current = await installation();
    if (!matches(current) || !current.channelIds.includes(input.channelId))
      throw new SharedSlackRefusal(
        "This Slack channel is outside the enrolled installation scope.",
        403,
      );
    const [rule] = await database
      .select()
      .from(access)
      .where(held(current.id, input.botId));
    if (!rule?.granted || !(await canUseBot(actor, input.botId)))
      throw new SharedSlackRefusal("A current Bot Grant is required.", 403);
    const facts = await sharedUse.botFacts(input.botId);
    const approval = policy.safeParse(rule.approval);
    const outside =
      source.kind === "goal" && !OWNER_STEERED_SOURCES.has(source.source);
    if (
      !approval.success ||
      !admits(
        approval.data,
        facts.ownerUserId,
        await sharedUse.actorFacts(actor.id),
        { outside },
      )
    )
      throw new SharedSlackRefusal(
        "The Shared-use Approval does not admit this Person or input source.",
        403,
      );
    return {
      installationId: current.id,
      channelId: input.channelId,
      identity: view(current).identity,
      origin: source,
    };
  }

  const reason = (error: unknown) =>
    error instanceof SharedSlackRefusal
      ? error.message
      : "Authorization could not be verified.";
  function actionFor(
    actor: Actor,
    input: Invocation,
    pinned: Target,
    runId: string,
  ): ApprovalAction {
    const binding = {
      actorId: actor.id,
      botId: input.botId,
      toolRef: tool.ref,
      effect: tool.effect,
      scope: workspaceId,
      target: pinned,
      args: { text: input.text },
    };
    return {
      ...binding,
      dispatch: "explicit",
      account: `${pinned.identity.teamId}/${pinned.identity.botId}`,
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
        reason: "Posting as the enrolled Slack Bot requires one-time Approval.",
      },
      declined: {
        eventType: "corsair.slack.write_refused",
        actorUserId: actor.id,
        targetType: "slack_channel",
        targetId: input.channelId,
        ...(pinned.origin.kind === "goal"
          ? { initiator: { kind: "responsibility", id: pinned.origin.goalId } }
          : {}),
        payload: {
          workspaceId,
          identityKind: tool.identity,
          tool: tool.ref,
          target: pinned,
          reason: "Person denied the Approval.",
        },
      },
    };
  }
  async function requestApproval(
    actor: Actor,
    input: Invocation,
    runId?: string,
  ) {
    let source: Origin | undefined;
    try {
      source =
        runId === undefined
          ? { kind: "person" }
          : await goalOrigin(actor, input.botId, runId);
      const pinned = await permitted(actor, input, source);
      const action = actionFor(actor, input, pinned, randomUUID());
      const approval = await approvals.open(action);
      return {
        id: approval.id,
        status: approval.status,
        action: { tool, args: action.args, target: pinned },
      };
    } catch (error) {
      await trail(
        actor,
        "corsair.slack.write_refused",
        "slack_channel",
        input.channelId,
        {
          botId: input.botId,
          tool: tool.ref,
          runId,
          origin: source,
          reason: reason(error),
        },
        source,
      );
      throw error;
    }
  }
  routes.post("/approvals", async (c) =>
    c.json(
      await requestApproval(c.var.actor, invocation.parse(await c.req.json())),
      201,
    ),
  );

  routes.post("/goal-runs/:runId/approvals", async (c) =>
    c.json(
      await requestApproval(
        c.var.actor,
        invocation.parse(await c.req.json()),
        z.string().min(1).max(256).parse(c.req.param("runId")),
      ),
      201,
    ),
  );

  async function owned(actor: Actor, approvalId: string) {
    const record = await approvals.get(actor.id, approvalId);
    if (
      !record ||
      record.action.scope !== workspaceId ||
      record.action.toolRef !== tool.ref ||
      record.action.dispatch !== "explicit"
    )
      throw new ApprovalNotFoundError();
    return record;
  }
  routes.post("/approvals/:id/decision", async (c) => {
    const approvalId = id.parse(c.req.param("id"));
    await owned(c.var.actor, approvalId);
    const { decision } = z
      .strictObject({ decision: z.enum(["allow_once", "deny"]) })
      .parse(await c.req.json());
    const record = await approvals.decide(c.var.actor.id, approvalId, decision);
    return c.json({ id: record.id, status: record.status });
  });
  routes.post("/approvals/:id/execute", async (c) => {
    const actor = c.var.actor;
    const approvalId = id.parse(c.req.param("id"));
    const { action, status, decision } = await owned(actor, approvalId);
    const pinned = target.parse(action.target);
    const input = invocation.parse({
      botId: action.botId,
      channelId: pinned.channelId,
      text: action.args.text,
    });
    const log = (
      event: AuditEventInput["eventType"],
      details: Record<string, unknown> = {},
    ) =>
      trail(
        actor,
        event,
        "slack_channel",
        pinned.channelId,
        {
          approvalId,
          botId: input.botId,
          tool: tool.ref,
          target: pinned,
          ...details,
        },
        pinned.origin,
      );
    async function checkBinding() {
      const source =
        pinned.origin.kind === "goal"
          ? await goalOrigin(actor, input.botId, pinned.origin.runId)
          : pinned.origin;
      const current = await permitted(actor, input, source);
      if (
        actionFor(actor, input, current, action.runId).actionDigest !==
        action.actionDigest
      )
        throw new SharedSlackRefusal(
          "The Slack action no longer matches its Approval.",
          409,
        );
    }
    try {
      if (status !== "approved" || decision !== "allow_once")
        throw new SharedSlackRefusal(
          "A current one-time Approval is required.",
          409,
        );
      await checkBinding();
      try {
        await provider.verifyIdentity();
        await provider.checkChannel(input.channelId);
      } catch {
        throw new SharedSlackRefusal(
          "Slack could not verify the Bot identity and channel membership.",
          502,
        );
      }
      await checkBinding();
      if (!(await approvals.consume(actor.id, approvalId, action.actionDigest)))
        throw new SharedSlackRefusal(
          "This Approval is no longer available.",
          409,
        );
    } catch (error) {
      await log("corsair.slack.write_refused", { reason: reason(error) });
      throw error;
    }
    await log("corsair.slack.write_started");
    const message = await provider
      .postMessage({ channel: input.channelId, text: input.text })
      .catch(() => null);
    if (!message) {
      const error =
        "Slack did not confirm this write. Check Slack before requesting another Approval.";
      await log("corsair.slack.write_unconfirmed");
      await approvals.saveResult(actor.id, approvalId, {
        content: error,
        error,
      });
      await approvals.finish(actor.id, approvalId);
      throw new SharedSlackRefusal(error, 502);
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
