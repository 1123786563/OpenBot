import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "../../../db/client";
import { auditEvents } from "../../../db/schema/core";
import {
  slackPilotConnections as connections,
  slackSharedInstallations as installations,
} from "../../../db/schema/corsair-slack";
import {
  corsairAccounts,
  corsairEvents,
  corsairIntegrations,
  corsairEventDispatches as dispatches,
} from "../../../db/schema/corsair-storage";
import {
  responsibilities as goals,
  responsibilityEvents,
  responsibilityRuns,
  responsibilityTriggers as triggers,
} from "../../../db/schema/responsibilities";
import { workItems } from "../../../db/schema/work";
import { LINK_CODES } from "../../../delivery/link-code";
import { RESPONSIBILITY_RUN_KIND } from "../../../responsibilities/engine";
import {
  type SlackTriggerEvent,
  slackTriggerEventSchema,
  slackTriggerMatches,
} from "../../../responsibilities/slack";
import { TRIGGER_BODY_LIMIT } from "../../../responsibilities/trigger-routes";
import { fitPayload } from "../../../responsibilities/triggers";
import type { CorsairEventOperations } from "../event-operations";
import type { EventTransaction } from "../event-triggers";
import { SLACK_EVENT_PREFIX, SlackEventAccessRetry } from "./event-run-access";
import { slackChannel } from "./provider";
import type { SharedSlackProvider } from "./shared-provider";

const challenge = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().max(1024),
});
const callback = z.object({
  type: z.literal("event_callback"),
  api_app_id: z.string(),
  team_id: z.string(),
  event_id: z.string(),
  event_time: z.int().positive(),
  is_ext_shared_channel: z.boolean().optional(),
  authorizations: z.array(
    z.object({
      team_id: z.string().nullable(),
      user_id: z.string(),
      is_bot: z.boolean(),
    }),
  ),
  event: z.object({
    type: z.string(),
    channel: z.string().optional(),
    user: z.string().optional(),
    ts: z.string().optional(),
    thread_ts: z.string().optional(),
    text: z.string().optional(),
    reaction: z.string().optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    item: z
      .object({
        type: z.string(),
        channel: z.string().optional(),
        ts: z.string().optional(),
      })
      .optional(),
  }),
});

type SlackEventPilotOptions = {
  database: Database;
  workspaceId: string;
  identity: SharedSlackProvider["identity"];
  secret: string;
  checkMember: (input: {
    channelId: string;
    slackUserId: string;
  }) => Promise<"allowed" | "denied" | "retry">;
  retryMs?: number;
  operations?: CorsairEventOperations;
};
type Receipt = typeof corsairEvents.$inferSelect;
type Dispatch = typeof dispatches.$inferSelect;
const receiptType = "openbot.slack.events_api";
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function createSlackEventPilot({
  database,
  workspaceId,
  identity,
  secret,
  checkMember,
  retryMs = 30_000,
  operations,
}: SlackEventPilotOptions) {
  const registration = [
    identity.appId,
    identity.teamId,
    identity.botId,
    identity.botUserId,
  ].join("/");
  // Use native Corsair receipts. Their account is stable across installation revocation,
  // so an administrator can revoke authorization without erasing delivery history.
  const accountId = `openbot:slack-events:${sha256(JSON.stringify([workspaceId, registration]))}`;
  async function enrolled(
    db: EventTransaction,
    channelId: string,
    installationId?: string,
  ) {
    const [row] = await db
      .select({ id: installations.id })
      .from(installations)
      .where(
        and(
          eq(installations.workspaceId, workspaceId),
          eq(installations.appId, identity.appId),
          eq(installations.teamId, identity.teamId),
          eq(installations.botId, identity.botId),
          eq(installations.botUserId, identity.botUserId),
          installationId === undefined
            ? undefined
            : eq(installations.id, installationId),
          sql`${channelId} = any(${installations.channelIds})`,
        ),
      )
      .for("share");
    return row;
  }

  const receiptScope = and(
    eq(corsairEvents.accountId, accountId),
    eq(corsairEvents.eventType, receiptType),
  );
  const ready = () =>
    and(
      inArray(dispatches.outcome, ["pending", "retry"]),
      lte(dispatches.nextAttemptAt, new Date()),
    );
  const dispatchKey = (row: Dispatch) =>
    and(
      eq(dispatches.receiptId, row.receiptId),
      eq(dispatches.triggerId, row.triggerId),
    );

  function candidates(db: Database | EventTransaction, triggerId?: string) {
    return db
      .select({
        id: triggers.id,
        responsibilityId: triggers.responsibilityId,
        ownerUserId: triggers.ownerUserId,
        createdAt: triggers.createdAt,
        updatedAt: triggers.updatedAt,
        kind: triggers.kind,
        config: triggers.config,
        enabled: triggers.enabled,
        responsibilityStatus: goals.status,
        secret: sql<null>`null`,
      })
      .from(triggers)
      .innerJoin(
        goals,
        and(
          eq(goals.id, triggers.responsibilityId),
          eq(goals.ownerUserId, triggers.ownerUserId),
        ),
      )
      .where(
        and(
          eq(triggers.kind, "slack"),
          sql`${triggers.config}->>'teamId' = ${identity.teamId}`,
          triggerId === undefined ? undefined : eq(triggers.id, triggerId),
        ),
      );
  }

  function readGrants(db: Database | EventTransaction, personId: string) {
    return db
      .select({
        id: connections.id,
        userId: connections.userId,
        revision: connections.revision,
      })
      .from(connections)
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.personId, personId),
          eq(connections.subjectScope, identity.teamId),
          isNull(connections.verificationRequiredAt),
        ),
      );
  }

  async function lookup(
    receipt: Receipt,
    triggerId: string,
    event: SlackTriggerEvent,
  ) {
    if (!receipt.installationId) return { kind: "denied" } as const;
    const [trigger] = await candidates(database, triggerId);
    if (
      !trigger?.enabled ||
      trigger.responsibilityStatus !== "active" ||
      trigger.updatedAt > receipt.createdAt ||
      !slackTriggerMatches(trigger, event)
    )
      return { kind: "ineligible" } as const;
    const grants = await readGrants(database, trigger.ownerUserId);
    if (!grants.length) return { kind: "denied" } as const;
    const installation = await database.transaction((tx) =>
      enrolled(tx, event.channelId, receipt.installationId ?? undefined),
    );
    if (!installation) return { kind: "denied" } as const;
    let retry = false;
    for (const grant of grants) {
      const access = await checkMember({
        channelId: event.channelId,
        slackUserId: grant.userId,
      }).catch(() => "retry" as const);
      if (access === "allowed") {
        return {
          kind: "allowed",
          async check(tx: EventTransaction, personId: string) {
            if (personId !== trigger.ownerUserId) return false;
            const [current] = await candidates(tx, triggerId).for("share", {
              of: triggers,
            });
            if (
              !current?.enabled ||
              current.ownerUserId !== personId ||
              current.updatedAt.getTime() !== trigger.updatedAt.getTime() ||
              !slackTriggerMatches(current, event)
            )
              return false;
            const currentGrants = await readGrants(tx, personId).for("share");
            return (
              currentGrants.some(
                (row) => row.id === grant.id && row.revision === grant.revision,
              ) && !!(await enrolled(tx, event.channelId, installation.id))
            );
          },
        } as const;
      }
      retry ||= access === "retry";
    }
    return { kind: retry ? "retry" : "denied" } as const;
  }

  async function audit(
    tx: EventTransaction,
    receipt: Receipt,
    outcome: string,
    triggerId?: string,
    runId?: string,
  ) {
    await tx.insert(auditEvents).values({
      eventType: "corsair.slack.event_delivery",
      initiatorKind: "system",
      targetType: "slack_event_receipt",
      targetId: receipt.id,
      payload: {
        workspaceId,
        registration,
        installationId: receipt.installationId,
        eventId: receipt.payload.eventId,
        channelId: receipt.payload.channelId,
        outcome,
        triggerId,
        runId,
      },
    });
  }

  async function deliver(receipt: Receipt, dispatch: Dispatch) {
    const event = slackTriggerEventSchema.parse(receipt.payload);
    const access = await lookup(receipt, dispatch.triggerId, event);
    const historyUnknown =
      !!receipt.occurredAt &&
      (await operations?.requiresReplayEvidence(
        receipt.id,
        dispatch.triggerId,
        receipt.occurredAt,
        receipt.createdAt,
      ));
    await database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(dispatches)
        .where(and(dispatchKey(dispatch), ready()))
        .for("update", { skipLocked: true });
      if (!current) return;
      let outcome: Dispatch["outcome"] =
        access.kind === "allowed" ? "denied" : access.kind;
      let runId: string | undefined;
      if (access.kind === "allowed") {
        const [trigger] = await candidates(tx, dispatch.triggerId).for(
          "update",
          { of: goals },
        );
        if (trigger?.responsibilityStatus !== "active") outcome = "ineligible";
        else if (historyUnknown) outcome = "review";
        else if (await access.check(tx, trigger.ownerUserId)) {
          const eventId = randomUUID();
          runId = randomUUID();
          await tx.insert(responsibilityEvents).values({
            id: eventId,
            ownerUserId: trigger.ownerUserId,
            source: "slack",
            externalId: `${SLACK_EVENT_PREFIX}${receipt.id}:${trigger.id}`,
            type: event.type,
            payload: fitPayload({
              ...event,
              text: event.text?.slice(0, 16_000),
            }),
          });
          await tx.insert(responsibilityRuns).values({
            id: runId,
            responsibilityId: trigger.responsibilityId,
            eventId,
          });
          await tx.insert(workItems).values({
            kind: RESPONSIBILITY_RUN_KIND,
            key: runId,
            payload: { runId },
          });
          outcome = "queued";
        }
      }
      await tx
        .update(dispatches)
        .set({ outcome, runId, nextAttemptAt: new Date(Date.now() + retryMs) })
        .where(dispatchKey(dispatch));
      if (outcome !== "retry" || current.outcome !== "retry")
        await audit(tx, receipt, outcome, dispatch.triggerId, runId);
    });
  }

  async function planReceipt(tx: EventTransaction, receipt: Receipt) {
    const event = slackTriggerEventSchema.parse(receipt.payload);
    const matching = (await candidates(tx)).filter((trigger) =>
      slackTriggerMatches(trigger, event),
    );
    if (matching.length)
      await tx.insert(dispatches).values(
        matching.map((trigger) => ({
          receiptId: receipt.id,
          triggerId: trigger.id,
          outcome: receipt.pilotDispatch === false ? "review" : "pending",
        })),
      );
    await tx
      .update(corsairEvents)
      .set({
        disposition: receipt.pilotDispatch === false ? "observed" : "planned",
        fanoutAt: new Date(),
        status: "completed",
      })
      .where(eq(corsairEvents.id, receipt.id));
    await audit(
      tx,
      receipt,
      receipt.pilotDispatch === false ? "observed" : "planned",
    );
  }

  const routes = new Hono();
  routes.use("/webhook", bodyLimit({ maxSize: TRIGGER_BODY_LIMIT }));
  routes.onError((_error, c) =>
    c.json({ error: "Slack receipt could not be persisted." }, 503),
  );
  routes.post("/webhook", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const time = c.req.header("x-slack-request-timestamp") ?? "";
    const signature = c.req.header("x-slack-signature") ?? "";
    if (
      !secret ||
      !/^\d{1,12}$/.test(time) ||
      Math.abs(Date.now() / 1000 - Number(time)) > 300 ||
      !/^v0=[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(
        Buffer.from(signature.slice(3), "hex"),
        createHmac("sha256", secret).update(`v0:${time}:`).update(raw).digest(),
      )
    ) {
      return c.json({ error: "Invalid Slack signature." }, 401);
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return c.json({ error: "Invalid Slack JSON." }, 400);
    }
    const verification = challenge.safeParse(input);
    if (verification.success)
      return c.json({ challenge: verification.data.challenge });
    const parsed = callback.safeParse(input);
    if (!parsed.success)
      return c.json({ error: "Invalid Slack event envelope." }, 400);
    const delivery = parsed.data;
    if (
      delivery.api_app_id !== identity.appId ||
      delivery.team_id !== identity.teamId ||
      !delivery.authorizations.some(
        (auth) =>
          auth.team_id === identity.teamId &&
          auth.is_bot &&
          auth.user_id === identity.botUserId,
      )
    ) {
      return c.json({ error: "Slack event installation does not match." }, 403);
    }
    const event = delivery.event;
    const reaction = event.type === "reaction_added";
    const channel = slackChannel.safeParse(
      reaction ? event.item?.channel : event.channel,
    );
    if (
      delivery.is_ext_shared_channel ||
      !channel.success ||
      (reaction && event.item?.type !== "message")
    )
      return c.body(null, 200);
    const normalized = slackTriggerEventSchema.safeParse({
      teamId: delivery.team_id,
      eventId: delivery.event_id,
      eventTime: delivery.event_time,
      type: event.type,
      channelId: channel.data,
      userId: event.user,
      ts: reaction ? event.item?.ts : event.ts,
      threadTs: event.thread_ts,
      text: event.text?.replace(LINK_CODES, "link [code removed]"),
      reaction: event.reaction,
      isBot: !!event.bot_id,
      subtype: event.subtype,
    });
    if (!normalized.success || normalized.data.isBot || normalized.data.subtype)
      return c.body(null, 200);
    const payload = normalized.data;
    const id = sha256(JSON.stringify([accountId, payload.eventId]));
    const bodyHash = sha256(raw);
    const result = await database.transaction(async (tx) => {
      const occurredAt = new Date(payload.eventTime * 1000);
      const owner = operations
        ? await operations.nativeOwner(
            tx,
            {
              provider: "slack",
              source: `${payload.teamId}/${payload.channelId}`,
            },
            occurredAt,
            payload.eventId,
          )
        : "corsair";
      const installation = await enrolled(tx, payload.channelId);
      await tx
        .insert(corsairIntegrations)
        .values({ id: accountId, name: accountId })
        .onConflictDoNothing();
      await tx
        .insert(corsairAccounts)
        .values({
          id: accountId,
          tenantId: workspaceId,
          integrationId: accountId,
          kind: "registration",
          workspaceId,
          registration,
        })
        .onConflictDoNothing();
      const [inserted] = await tx
        .insert(corsairEvents)
        .values({
          id,
          accountId,
          workspaceId,
          registration,
          eventType: receiptType,
          installationId: installation?.id,
          occurredAt,
          pilotDispatch: owner === "corsair",
          bodyHash,
          payload: installation
            ? payload
            : {
                eventId: payload.eventId,
                channelId: payload.channelId,
                teamId: payload.teamId,
              },
          ...(installation
            ? {}
            : {
                disposition: "unenrolled",
                status: "completed",
                fanoutAt: new Date(),
              }),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        if (installation)
          await operations?.captureEvidence(
            tx,
            "slack",
            payload.eventId,
            id,
            raw,
          );
        if (!installation) await audit(tx, inserted, "unenrolled");
        else if (operations) await planReceipt(tx, inserted);
        return "saved";
      }
      const [existing] = await tx
        .select({ bodyHash: corsairEvents.bodyHash })
        .from(corsairEvents)
        .where(eq(corsairEvents.id, id));
      return existing?.bodyHash === bodyHash ? "duplicate" : "conflict";
    });
    if (result === "conflict")
      return c.json({ error: "Conflicting Slack event identity." }, 409);
    return c.body(null, 200);
  });
  return {
    routes,
    async sweep() {
      await database.transaction(async (tx) => {
        const receipts = await tx
          .select()
          .from(corsairEvents)
          .where(and(receiptScope, eq(corsairEvents.status, "pending")))
          .orderBy(asc(corsairEvents.createdAt))
          .limit(20)
          .for("update", { skipLocked: true });
        for (const receipt of receipts) await planReceipt(tx, receipt);
      });
      const pending = await database
        .select({ receipt: corsairEvents, dispatch: dispatches })
        .from(dispatches)
        .innerJoin(corsairEvents, eq(corsairEvents.id, dispatches.receiptId))
        .where(and(receiptScope, ready()))
        .orderBy(asc(dispatches.nextAttemptAt))
        .limit(20);
      for (const { receipt, dispatch } of pending)
        await deliver(receipt, dispatch);
    },
    async readEvidence(receiptId: string, triggerId: string, personId: string) {
      return operations?.readEvidence(receiptId, async () => {
        const [receipt] = await database
          .select()
          .from(corsairEvents)
          .where(and(receiptScope, eq(corsairEvents.id, receiptId)));
        const event = slackTriggerEventSchema.safeParse(receipt?.payload);
        if (!receipt || !event.success) return false;
        const access = await lookup(receipt, triggerId, event.data);
        return (
          access.kind === "allowed" &&
          (await database.transaction((tx) => access.check(tx, personId)))
        );
      });
    },
    async authorizeRun(runId: string) {
      const [origin] = await database
        .select({ receipt: corsairEvents, triggerId: dispatches.triggerId })
        .from(dispatches)
        .innerJoin(corsairEvents, eq(corsairEvents.id, dispatches.receiptId))
        .where(and(receiptScope, eq(dispatches.runId, runId)));
      if (!origin) return null;
      const event = slackTriggerEventSchema.parse(origin.receipt.payload);
      const access = await lookup(origin.receipt, origin.triggerId, event);
      if (access.kind === "retry") throw new SlackEventAccessRetry();
      return {
        receiptId: origin.receipt.id,
        triggerId: origin.triggerId,
        check: access.kind === "allowed" ? access.check : null,
      };
    },
  };
}
