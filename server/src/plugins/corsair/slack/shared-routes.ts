import {
  GITHUB_EVENT_ACCESS_ENDED,
  GITHUB_EVENT_PREFIX,
  GithubEventAccessRetry,
  githubQueuedRunAuthorization,
} from "../event-run-access";
import { PluginRefusedError } from "../../plugin-store/model";
import type { BotWrite } from "../bot-write";
import { finishExplicitWrite } from "../write-completion";
import { corsairWriteKey, dispatchCorsairWrite } from "../cutover";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import type { ActionPolicy } from "../../../computer/policy";
import type { Database } from "../../../db/client";
import {
  slackSharedBotAccess as access,
  slackSharedInstallations as installations,
} from "../../../db/schema/corsair-slack";
import { corsairAccounts as accounts } from "../../../db/schema/corsair-storage";
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
import {
  createRevocation,
  dispatchWhileConnected,
  RevocationRefusal,
  revocationState,
} from "../revocation";
import { migratedPolicyAllows } from "../migration-policy";
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
  legacyPolicy,
  enforceCutover,
  githubEventAccess,
}: {
  database: Database;
  workspaceId: string;
  provider: SharedSlackProvider;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  legacyPolicy?: () => ActionPolicy;
  enforceCutover?: boolean;
  githubEventAccess?: Parameters<
    typeof githubQueuedRunAuthorization
  >[0]["service"];
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
    if (
      error instanceof SharedSlackRefusal ||
      error instanceof RevocationRefusal
    )
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
  const sharedAccount = and(
    eq(accounts.kind, "slack-shared"),
    eq(accounts.sharedWorkspaceId, workspaceId),
  );
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
  // Shared enrollments and impact confirmation must see the same set of installations.
  const lockEnrollments = (tx: Transaction) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('openbot.corsair.slack.shared-enrollment'))`,
    );
  const revocation = createRevocation({
    database,
    refreshApplicable: false,
    verify: (row) =>
      matches(row) ? provider.revoke() : Promise.resolve(false),
  });

  async function affectedAccounts(
    row: typeof accounts.$inferSelect,
    tx?: Transaction,
  ) {
    const { appId, teamId, botId, botUserId } = row;
    if (!appId || !teamId || !botId || !botUserId)
      throw new RevocationRefusal(
        "The Slack installation identity is unavailable.",
        409,
      );
    const query = (tx ?? database)
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.kind, "slack-shared"),
          eq(accounts.appId, appId),
          eq(accounts.teamId, teamId),
          eq(accounts.botId, botId),
          eq(accounts.botUserId, botUserId),
        ),
      )
      .orderBy(accounts.id);
    return tx ? query.for("update") : query;
  }

  function impact(rows: Awaited<ReturnType<typeof affectedAccounts>>) {
    const installations = rows.map((row) => ({
      installationId: row.id,
      workspaceId: row.sharedWorkspaceId,
      channelIds: row.channelIds,
      status: revocationState(row.config).status,
    }));
    const confirmation = createHash("sha256")
      .update(
        JSON.stringify(
          rows.map(({ id, revision, channelIds, config }) => [
            id,
            revision,
            channelIds,
            revocationState(config).status,
          ]),
        ),
      )
      .digest("hex");
    return { installations, confirmation };
  }

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
  function matches(
    record: Pick<
      typeof accounts.$inferSelect,
      "appId" | "teamId" | "botId" | "botUserId"
    >,
  ) {
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
    if (forbidden) return forbidden;
    const row = await revocation.find(sharedAccount);
    const { id, channelIds, appId, teamId, botId, botUserId } = row;
    return c.json({
      id,
      channelIds,
      identity: { appId, teamId, botId, botUserId },
      revocation: revocationState(row.config),
    });
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
      await lockEnrollments(tx);
      const [prior] = await tx
        .select()
        .from(accounts)
        .where(sharedAccount)
        .for("update");
      if (prior) {
        const state = revocationState(prior.config);
        if (state.status === "pending")
          throw new RevocationRefusal(
            "Finish the pending installation revocation before enrolling.",
            409,
          );
        if (state.status === "revoked")
          await tx.delete(accounts).where(eq(accounts.id, prior.id));
      }
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
    return c.json(await revocation.disconnect(sharedAccount, c.var.actor.id));
  });

  routes.get("/installation/revocation/impact", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const row = await revocation.find(sharedAccount);
    return c.json(impact(await affectedAccounts(row)));
  });

  routes.post("/installation/revocation", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const { confirmation } = z
      .strictObject({
        confirmation: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await c.req.json());
    const current = await revocation.find(sharedAccount);
    return c.json(
      await revocation.retry(
        and(sharedAccount, eq(accounts.id, current.id)),
        c.var.actor.id,
        async (tx) => {
          await lockEnrollments(tx);
          const rows = await affectedAccounts(current, tx);
          if (
            !rows.some(({ id }) => id === current.id) ||
            impact(rows).confirmation !== confirmation
          )
            throw new RevocationRefusal(
              "The installation impact changed. Review it again.",
              409,
            );
          return rows;
        },
      ),
    );
  });

  routes.put("/installation/revocation/evidence", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    return c.json(
      await revocation.recordManualEvidence(
        sharedAccount,
        c.var.actor.id,
        revocation.manualEvidence.parse(await c.req.json()),
      ),
    );
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
    binding?: { id: string; threadId: string },
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
          ...(binding
            ? [
                eq(responsibilities.id, binding.id),
                eq(responsibilities.threadId, binding.threadId),
                eq(responsibilities.status, "active"),
                eq(responsibilityEvents.source, "github"),
                sql`starts_with(${responsibilityEvents.externalId}, ${GITHUB_EVENT_PREFIX})`,
              ]
            : []),
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
      !(await migratedPolicyAllows(database, {
        workspaceId,
        app: "slack",
        registration: current.appId,
        kind: "shared",
        botId: input.botId,
        connectionId: current.id,
        resource: input.channelId,
        actorId: actor.id,
        initiator:
          source.kind === "goal"
            ? { kind: "responsibility", id: source.goalId }
            : undefined,
        legacyPolicy,
      })) ||
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
    const { text } = z
      .object({ text: invocation.shape.text })
      .parse(action.args);
    const input = invocation.parse({
      botId: action.botId,
      channelId: pinned.channelId,
      text,
    });
    return c.json(
      await execute(actor, input, action, approvalId, async () => {
        if (status !== "approved" || decision !== "allow_once")
          throw new SharedSlackRefusal(
            "A current one-time Approval is required.",
            409,
          );
        return approvals.consume(actor.id, approvalId, action.actionDigest);
      }),
    );
  });

  async function execute(
    actor: Actor,
    input: Invocation,
    action: ApprovalAction,
    approvalId: string,
    consume: () => Promise<boolean>,
    bot?: Parameters<BotWrite["send"]>[1],
    approvalDigest?: string,
  ) {
    const pinned = target.parse(action.target);
    const writeAttemptId = randomUUID();
    const writeKey = corsairWriteKey(
      actor.id,
      pinned.identity.botUserId,
      pinned.channelId,
      action.args,
    );
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
          writeAttemptId,
          botId: input.botId,
          tool: tool.ref,
          target: pinned,
          receiptId: origin?.outcome.receiptId,
          triggerId: origin?.outcome.triggerId,
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
    const goal = bot && pinned.origin.kind === "goal" ? pinned.origin : null;
    const waiting = goal
      ? and(
          eq(responsibilityRuns.id, goal.runId),
          eq(responsibilityRuns.status, "waiting"),
          sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
        )
      : undefined;
    let origin: Awaited<
      ReturnType<typeof githubQueuedRunAuthorization>
    >["origin"];
    async function checkSource() {
      if (!goal || !waiting) return;
      const [run] = await database
        .select({
          status: responsibilityRuns.status,
          waiting: responsibilityRuns.waiting,
        })
        .from(responsibilityRuns)
        .where(eq(responsibilityRuns.id, goal.runId));
      if (run?.status === "running") throw new GithubEventAccessRetry();
      if (run?.status !== "waiting" || run.waiting?.approvalId !== approvalId)
        throw new SharedSlackRefusal(
          "The Goal is no longer waiting for this Approval.",
          409,
        );
      const source = await githubQueuedRunAuthorization({
        database,
        service: githubEventAccess,
        runId: goal.runId,
        personId: actor.id,
      });
      origin = source.origin;
      if (source.kind === "denied") {
        throw new RevocationRefusal(GITHUB_EVENT_ACCESS_ENDED, 403);
      }
      return source;
    }

    let source: Awaited<ReturnType<typeof checkSource>>;
    async function authorizeDispatch(
      tx: Parameters<NonNullable<typeof bot>>[0],
    ) {
      if (!source || !waiting) return;
      if (!(await source.check(tx, source.origin.outcome.triggerId, actor.id)))
        throw new RevocationRefusal(GITHUB_EVENT_ACCESS_ENDED, 403);
      const [run] = await tx
        .select({ id: responsibilityRuns.id })
        .from(responsibilityRuns)
        .innerJoin(
          responsibilities,
          eq(responsibilities.id, responsibilityRuns.responsibilityId),
        )
        .where(and(waiting, eq(responsibilities.status, "active")))
        .for("share");
      if (!run)
        throw new RevocationRefusal(
          "The Goal is no longer waiting for this Approval.",
          409,
        );
    }

    async function failIfSourceEnded(error: unknown) {
      if (
        !waiting ||
        !(error instanceof RevocationRefusal) ||
        error.message !== GITHUB_EVENT_ACCESS_ENDED
      )
        return;
      await database
        .update(responsibilityRuns)
        .set({
          status: "failed",
          error: error.message,
          waiting: null,
          continuation: null,
          finishedAt: new Date(),
        })
        .where(waiting);
    }

    try {
      await checkBinding();
      try {
        await dispatchWhileConnected(
          database,
          pinned.installationId,
          undefined,
          () => provider.verifyIdentity(),
        );
        await dispatchWhileConnected(
          database,
          pinned.installationId,
          undefined,
          () => provider.checkChannel(input.channelId),
        );
      } catch {
        throw new SharedSlackRefusal(
          "Slack could not verify the Bot identity and channel membership.",
          502,
        );
      }
      await checkBinding();
      source = await checkSource();
      const claimed = goal
        ? approvalDigest &&
          (await approvals.consume(
            actor.id,
            approvalId,
            approvalDigest,
            authorizeDispatch,
          ))
        : await consume();
      if (!claimed)
        throw new SharedSlackRefusal(
          "This Approval is no longer available.",
          409,
        );
    } catch (error) {
      if (error instanceof GithubEventAccessRetry) throw error;
      await log("corsair.slack.write_refused", {
        reason:
          error instanceof RevocationRefusal ? error.message : reason(error),
      });
      await failIfSourceEnded(error);
      throw error;
    }
    await log("corsair.slack.write_started", { writeKey });
    const message = await dispatchCorsairWrite(
      database,
      enforceCutover || bot
        ? {
            workspaceId,
            app: "slack",
            botId: input.botId,
            registration: provider.identity.appId,
            binding: "shared",
            approvalId,
            writeKey,
            writeAttemptId,
            validate:
              bot &&
              (async (tx, excluded) => {
                await bot(tx, excluded);
                await authorizeDispatch(tx);
              }),
            grant: `shared-grant:${input.botId}:${pinned.installationId}`,
          }
        : undefined,
      pinned.installationId,
      undefined,
      () =>
        provider
          .postMessage({ channel: input.channelId, text: input.text })
          .catch(() => null),
    ).catch(async (error: unknown) => {
      if (!(error instanceof RevocationRefusal)) throw error;
      await log("corsair.slack.write_refused", {
        reason: error.message,
        dispatchRefused: true,
      });
      await failIfSourceEnded(error);
      if (!bot)
        await finishExplicitWrite(approvals, actor.id, approvalId, {
          content: error.message,
          error: error.message,
        });
      throw error;
    });
    if (!message) {
      const error =
        "Slack did not confirm this write. Check Slack before requesting another Approval.";
      await log("corsair.slack.write_unconfirmed");
      if (!bot)
        await finishExplicitWrite(approvals, actor.id, approvalId, {
          content: error,
          error,
        });
      throw new SharedSlackRefusal(error, 502);
    }
    await log("corsair.slack.write_succeeded", {
      timestamp: message.timestamp,
    });
    if (!bot)
      await finishExplicitWrite(approvals, actor.id, approvalId, {
        content: `Slack message ${message.channel}/${message.timestamp}`,
      });
    return { message };
  }

  function refuseBotWrite(error: unknown): never {
    if (error instanceof SharedSlackRefusal && error.status !== 502)
      throw new PluginRefusedError(error.message, null);
    throw error;
  }
  return Object.assign(routes, {
    // Keep the explicit pilot refusal distinct from the normal Bot's approval lifecycle.
    async prepareBotWrite(
      actor: Actor,
      raw: unknown,
      connectionId: string,
      goal?: { id: string; runId: string; threadId: string },
    ): Promise<BotWrite> {
      const input = invocation.parse(raw);
      const source = goal
        ? await goalOrigin(actor, input.botId, goal.runId, goal).catch(
            refuseBotWrite,
          )
        : ({ kind: "person" } as const);
      if (goal && !githubEventAccess)
        throw new PluginRefusedError(
          "GitHub event authorization is unavailable.",
          null,
        );
      const pinned = await permitted(actor, input, source).catch(
        refuseBotWrite,
      );
      if (pinned.installationId !== connectionId)
        throw new SharedSlackRefusal(
          "The verified Slack installation changed.",
          409,
        );
      const action = actionFor(actor, input, pinned, randomUUID());
      return {
        action,
        send: (approvalId, validate, approvalDigest) =>
          execute(
            actor,
            input,
            action,
            approvalId,
            async () => true,
            validate,
            approvalDigest,
          ),
      };
    },
  });
}
