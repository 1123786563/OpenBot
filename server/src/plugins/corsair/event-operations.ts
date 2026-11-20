import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../credentials";
import type { Database } from "../../db/client";
import {
  corsairAccounts,
  corsairIntegrations,
  corsairEventDispatches as dispatches,
  corsairEvents as events,
} from "../../db/schema/corsair-storage";
import type { DeliveryOutcome } from "../../responsibilities/trigger-routes";
import type { EventTransaction } from "./event-triggers";

export const eventSource = z.object({
  provider: z.enum(["github", "slack"]),
  source: z.string().min(1).max(160),
});
type Source = z.infer<typeof eventSource>;
type EventKey = Source & { eventKey: string };
const journalType = "openbot.events.legacy";
const handoffType = "openbot.events.handoff";
const incidentType = "openbot.events.incident";
const replayType = "openbot.events.replay";
const evidenceType = "openbot.events.raw-evidence";
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const alertMs = 15 * 60 * 1000;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const journalPayload = eventSource.extend({
  eventKey: z.string(),
  eventType: z.string(),
  owner: z.enum(["legacy", "corsair"]),
  reasons: z.record(z.string(), z.string()).optional(),
});
const nativeSlack = "openbot.slack.events_api";

export type CorsairEventOperations = ReturnType<
  typeof createCorsairEventOperations
>;

export function createCorsairEventOperations(
  database: Database,
  workspaceId: string,
  options: {
    githubRegistration?: string;
    slackRegistration?: string;
    rawEvidence?: { encryptionKey: string; deliveries: ReadonlySet<string> };
  } = {},
) {
  const accountId = `openbot:event-operations:${digest(workspaceId)}`;
  const idFor = (kind: string, ...key: string[]) =>
    digest([accountId, kind, ...key]);
  const registrationFor = (provider: Source["provider"]) =>
    provider === "github"
      ? options.githubRegistration
      : options.slackRegistration;
  const handoffId = ({ provider, source }: Source) =>
    idFor(handoffType, provider, registrationFor(provider) ?? "", source);
  const legacyId = ({ provider, source, eventKey }: EventKey) =>
    idFor(journalType, provider, source, eventKey);
  const sourceOwner = async (
    db: Database | EventTransaction,
    key: Source,
    time: Date,
  ) => {
    const [handoff] = await db
      .select({ cutoff: events.occurredAt })
      .from(events)
      .where(eq(events.id, handoffId(key)));
    return handoff?.cutoff && time >= handoff.cutoff ? "corsair" : "legacy";
  };
  const lockSource = (tx: EventTransaction, key: Source) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${handoffId(key)}, 0))`,
    );

  async function ensureAccount(tx: EventTransaction) {
    await tx
      .insert(corsairIntegrations)
      .values({ id: accountId, name: accountId })
      .onConflictDoNothing();
    await tx
      .insert(corsairAccounts)
      .values({
        id: accountId,
        integrationId: accountId,
        tenantId: workspaceId,
        workspaceId,
        registration: accountId,
        kind: "registration",
      })
      .onConflictDoNothing();
  }

  const scope = eq(events.workspaceId, workspaceId);
  function nativeSource(key: Source) {
    const registration = registrationFor(key.provider);
    if (!registration) return sql`false`;
    return and(
      scope,
      eq(events.registration, registration),
      key.provider === "github"
        ? and(
            sql`${events.deliveryId} is not null`,
            eq(events.repositoryId, key.source),
          )
        : and(
            eq(events.eventType, nativeSlack),
            sql`concat(${events.payload}->>'teamId', '/', ${events.payload}->>'channelId') = ${key.source}`,
          ),
    );
  }

  function nativeKey(key: EventKey) {
    return and(
      nativeSource(key),
      key.provider === "github"
        ? eq(events.bodyHash, key.eventKey)
        : sql`${events.payload}->>'eventId' = ${key.eventKey}`,
    );
  }

  const replayId = (receiptId: string, triggerId: string) =>
    idFor(replayType, receiptId, triggerId);

  async function reportOn(db: Database | EventTransaction, key: Source) {
    const rows = await db
      .select({
        id: events.id,
        eventType: events.eventType,
        deliveryId: events.deliveryId,
        installationId: events.installationId,
        channelId: sql<string | null>`${events.payload}->>'channelId'`,
        occurredAt: events.occurredAt,
        receivedAt: events.createdAt,
        disposition: events.disposition,
        pilotDispatch: events.pilotDispatch,
        metadata: sql<unknown>`case when ${events.eventType} = ${journalType} then ${events.payload}
        when ${events.eventType} = ${nativeSlack} then jsonb_build_object('eventKey', ${events.payload}->>'eventId')
        else jsonb_build_object('eventKey', ${events.bodyHash}) end`,
      })
      .from(events)
      .where(
        sql`((${events.accountId} = ${accountId} and ${events.eventType} = ${journalType}
        and ${events.payload}->>'provider' = ${key.provider} and ${events.payload}->>'source' = ${key.source})
        or ${nativeSource(key)})`,
      )
      .orderBy(asc(events.createdAt), asc(events.id));

    const outcomes = rows.length
      ? await db
          .select({
            receiptId: dispatches.receiptId,
            triggerId: dispatches.triggerId,
            outcome: dispatches.outcome,
            runId: dispatches.runId,
          })
          .from(dispatches)
          .where(
            inArray(
              dispatches.receiptId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(dispatches.triggerId))
      : [];
    const byReceipt = new Map<string, typeof outcomes>();
    for (const outcome of outcomes) {
      const group = byReceipt.get(outcome.receiptId) ?? [];
      group.push(outcome);
      byReceipt.set(outcome.receiptId, group);
    }
    return rows.flatMap(({ metadata, ...row }) => {
      const legacy = journalPayload.safeParse(metadata);
      const native = z.object({ eventKey: z.string() }).safeParse(metadata);
      if (!native.success) return [];
      return [
        {
          ...key,
          ...row,
          entry: legacy.success ? "legacy" : "corsair",
          eventType: legacy.success ? legacy.data.eventType : row.eventType,
          eventKey: native.data.eventKey,
          outcomes: (byReceipt.get(row.id) ?? []).map((result) => ({
            ...result,
            reason: legacy.success
              ? legacy.data.reasons?.[result.triggerId]
              : undefined,
          })),
        },
      ];
    });
  }

  return {
    async nativeOwner(
      tx: EventTransaction,
      key: Source,
      occurredAt: Date | null,
      eventKey?: string,
    ) {
      if (!occurredAt) return "legacy";
      await lockSource(tx, key);
      if (eventKey) {
        const [legacy] = await tx
          .select({ payload: events.payload })
          .from(events)
          .where(eq(events.id, legacyId({ ...key, eventKey })));
        if (legacy && journalPayload.parse(legacy.payload).owner === "legacy")
          return "legacy";
      }
      return sourceOwner(tx, key, occurredAt);
    },
    async receiveLegacy(
      input: EventKey & {
        eventType: string;
        triggerIds: string[];
        occurredAt?: Date | null;
        receivedAt?: Date;
      },
    ) {
      const { provider, source, eventKey, eventType, triggerIds, occurredAt } =
        input;
      const key = { provider, source, eventKey };
      const id = legacyId(key);
      return database.transaction(async (tx) => {
        await lockSource(tx, key);
        await ensureAccount(tx);
        const receivedAt = input.receivedAt ?? new Date();
        const [native] = await tx
          .select({ dispatch: events.pilotDispatch })
          .from(events)
          .where(nativeKey(key));
        const owner =
          native && native.dispatch !== false
            ? "corsair"
            : await sourceOwner(tx, key, occurredAt ?? receivedAt);
        await tx
          .insert(events)
          .values({
            id,
            accountId,
            workspaceId,
            registration: accountId,
            eventType: journalType,
            status: "completed",
            occurredAt,
            createdAt: receivedAt,
            payload: {
              ...key,
              eventType,
              owner,
              ...(owner === "corsair"
                ? {
                    reasons: Object.fromEntries(
                      triggerIds.map((id) => [id, "corsair-owns-source"]),
                    ),
                  }
                : {}),
            },
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select({ payload: events.payload })
          .from(events)
          .where(eq(events.id, id));
        const pinned = journalPayload.parse(row?.payload).owner;
        if (triggerIds.length) {
          await tx
            .insert(dispatches)
            .values(
              triggerIds.map((triggerId) => ({
                receiptId: id,
                triggerId,
                outcome: pinned === "legacy" ? "pending" : "ineligible",
              })),
            )
            .onConflictDoNothing();
        }
        return { id, owner: pinned };
      });
    },
    async finishLegacy(
      receiptId: string,
      triggerId: string,
      result: DeliveryOutcome,
    ) {
      const runId = result.status === "queued" ? result.runIds[0] : undefined;
      await database.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.id, receiptId),
              eq(events.accountId, accountId),
              eq(events.eventType, journalType),
            ),
          )
          .for("update");
        if (!row) return;
        const [updated] = await tx
          .update(dispatches)
          .set({
            outcome: runId
              ? "queued"
              : result.status === "queued"
                ? "review"
                : "ineligible",
            runId,
          })
          .where(
            and(
              eq(dispatches.receiptId, receiptId),
              eq(dispatches.triggerId, triggerId),
              inArray(dispatches.outcome, ["pending", "retry"]),
            ),
          )
          .returning();
        if (updated && result.status !== "queued") {
          await tx
            .update(events)
            .set({
              payload: sql`${events.payload} || jsonb_build_object('reasons',
              coalesce(${events.payload}->'reasons', '{}'::jsonb) || jsonb_build_object(${triggerId}::text, ${result.reason}::text))`,
            })
            .where(eq(events.id, receiptId));
        }
      });
    },
    report: (key: Source) => reportOn(database, key),
    async incidents(key: Source) {
      return database
        .select({
          id: events.id,
          createdAt: events.createdAt,
          details: events.payload,
        })
        .from(events)
        .where(
          and(
            eq(events.accountId, accountId),
            eq(events.eventType, incidentType),
            sql`${events.payload}->>'provider' = ${key.provider} and ${events.payload}->>'source' = ${key.source}`,
          ),
        );
    },
    async handoff(
      key: Source,
      actorId: string,
      evidence: {
        eventKeys: string[];
        triggerPairs: { legacy: string; corsair: string }[];
        providerHistoryRef: string;
      },
    ) {
      return database.transaction(async (tx) => {
        await lockSource(tx, key);
        const id = handoffId(key);
        const [existing] = await tx
          .select({ cutoff: events.occurredAt })
          .from(events)
          .where(eq(events.id, id));
        if (existing?.cutoff) return existing.cutoff;
        const rows = await reportOn(tx, key);
        const installations = new Set(
          rows
            .filter((row) => row.entry === "corsair")
            .map((row) => row.installationId),
        );
        if (installations.size !== 1 || installations.has(null)) return null;
        const eventKeys = new Set(rows.map((row) => row.eventKey));
        if (
          !eventKeys.size ||
          evidence.eventKeys.length !== eventKeys.size ||
          !evidence.eventKeys.every((eventKey) => eventKeys.has(eventKey)) ||
          new Set(evidence.eventKeys).size !== eventKeys.size
        )
          return null;
        const pairs = new Map(
          evidence.triggerPairs.map(({ legacy, corsair }) => [legacy, corsair]),
        );
        if (
          pairs.size !== evidence.triggerPairs.length ||
          new Set(pairs.values()).size !== pairs.size
        )
          return null;
        for (const eventKey of eventKeys) {
          const old = rows.filter(
            (row) => row.entry === "legacy" && row.eventKey === eventKey,
          );
          const next = rows.filter(
            (row) => row.entry === "corsair" && row.eventKey === eventKey,
          );
          if (old.length !== 1 || next.length !== 1) return null;
          const [legacy] = old;
          const [corsair] = next;
          if (
            !legacy ||
            !corsair ||
            corsair.disposition !== "observed" ||
            !corsair.occurredAt ||
            corsair.outcomes.length !== legacy.outcomes.length ||
            !legacy.outcomes.every(
              (result) =>
                ((result.outcome === "queued" && result.runId) ||
                  result.outcome === "ineligible") &&
                corsair.outcomes.some(
                  (shadow) =>
                    shadow.triggerId === pairs.get(result.triggerId) &&
                    shadow.outcome === "review",
                ),
            )
          )
            return null;
        }
        if (
          !pairs.size ||
          !rows.some((row) =>
            row.outcomes.some((result) => result.outcome === "queued"),
          )
        )
          return null;
        await ensureAccount(tx);
        const [record] = await tx
          .insert(events)
          .values({
            id,
            accountId,
            workspaceId,
            registration: accountId,
            eventType: handoffType,
            status: "completed",
            occurredAt: sql`date_trunc('second', clock_timestamp()) + interval '1 second'`,
            payload: { ...key, actorId, ...evidence },
          })
          .returning({ cutoff: events.occurredAt });
        return record.cutoff;
      });
    },
    async incident(key: Source, actorId: string, historyRef: string) {
      return database.transaction(async (tx) => {
        await ensureAccount(tx);
        const id = idFor(incidentType, key.provider, key.source, historyRef);
        await tx
          .insert(events)
          .values({
            id,
            accountId,
            workspaceId,
            registration: accountId,
            eventType: incidentType,
            status: "completed",
            payload: {
              ...key,
              actorId,
              historyRef,
              reason: "provider-history-incomplete",
            },
          })
          .onConflictDoNothing();
        return id;
      });
    },
    async alert(now = new Date()) {
      return database.transaction(async (tx) => {
        const overdue = await tx
          .select({
            receiptId: events.id,
            triggerId: dispatches.triggerId,
            outcome: dispatches.outcome,
            provider: sql<string>`case when ${events.eventType} = ${journalType} then ${events.payload}->>'provider'
            when ${events.eventType} = ${nativeSlack} then 'slack' else 'github' end`,
            source: sql<string>`case when ${events.eventType} = ${journalType} then ${events.payload}->>'source'
            when ${events.eventType} = ${nativeSlack} then concat(${events.payload}->>'teamId', '/', ${events.payload}->>'channelId')
            else ${events.repositoryId} end`,
            eventKey: sql<string>`case when ${events.eventType} = ${journalType} then ${events.payload}->>'eventKey'
            when ${events.eventType} = ${nativeSlack} then ${events.payload}->>'eventId' else ${events.bodyHash} end`,
          })
          .from(dispatches)
          .innerJoin(events, eq(events.id, dispatches.receiptId))
          .where(
            and(
              scope,
              lt(events.createdAt, new Date(now.getTime() - alertMs)),
              sql`(${dispatches.outcome} in ('pending', 'retry') or
              (${dispatches.outcome} = 'review' and ${events.disposition} is distinct from 'observed'))`,
              sql`not exists (select 1 from corsair_events a
              where a.id = 'openbot:overdue:' || ${events.id} || ':' || ${dispatches.triggerId})`,
            ),
          )
          .orderBy(asc(events.createdAt))
          .limit(100)
          .for("update", { of: dispatches, skipLocked: true });
        if (!overdue.length) return [];
        await ensureAccount(tx);
        const inserted = await tx
          .insert(events)
          .values(
            overdue.map((row) => ({
              id: `openbot:overdue:${row.receiptId}:${row.triggerId}`,
              accountId,
              workspaceId,
              registration: accountId,
              eventType: "openbot.events.overdue",
              status: "completed",
              payload: row,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: events.id });
        const ids = new Set(inserted.map((row) => row.id));
        return overdue.filter((row) =>
          ids.has(`openbot:overdue:${row.receiptId}:${row.triggerId}`),
        );
      });
    },
    async replay(
      key: Source,
      actorId: string,
      request: {
        receiptId: string;
        triggerId: string;
        historyRef: string;
      },
    ) {
      const { receiptId, triggerId, historyRef } = request;
      return database.transaction(async (tx) => {
        const [target] = await tx
          .select({ outcome: dispatches.outcome })
          .from(dispatches)
          .innerJoin(events, eq(events.id, dispatches.receiptId))
          .where(
            and(
              nativeSource(key),
              eq(events.id, receiptId),
              eq(events.disposition, "planned"),
              eq(dispatches.triggerId, triggerId),
              inArray(dispatches.outcome, ["pending", "retry", "review"]),
            ),
          )
          .for("update", { of: dispatches });
        if (!target) return false;
        await ensureAccount(tx);
        await tx
          .insert(events)
          .values({
            id: replayId(receiptId, triggerId),
            accountId,
            workspaceId,
            registration: accountId,
            eventType: replayType,
            status: "completed",
            payload: { ...key, receiptId, triggerId, actorId, historyRef },
          })
          .onConflictDoNothing();
        await tx
          .update(dispatches)
          .set({ outcome: "retry", nextAttemptAt: new Date() })
          .where(
            and(
              eq(dispatches.receiptId, receiptId),
              eq(dispatches.triggerId, triggerId),
            ),
          );
        return true;
      });
    },
    async requiresReplayEvidence(
      receiptId: string,
      triggerId: string,
      occurredAt: Date,
      receivedAt: Date,
    ) {
      if (receivedAt.getTime() - occurredAt.getTime() <= 5 * 60 * 1000)
        return false;
      const [record] = await database
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, replayId(receiptId, triggerId)));
      return !record;
    },
    async captureEvidence(
      tx: EventTransaction,
      provider: Source["provider"],
      delivery: string,
      receiptId: string,
      raw: Uint8Array,
    ) {
      if (!options.rawEvidence?.deliveries.has(`${provider}:${delivery}`))
        return;
      const sealed = await encryptSecret(
        options.rawEvidence.encryptionKey,
        Buffer.from(raw).toString("base64"),
      );
      await ensureAccount(tx);
      await tx
        .insert(events)
        .values({
          id: idFor(evidenceType, receiptId),
          accountId,
          workspaceId,
          registration: accountId,
          eventType: evidenceType,
          status: "completed",
          payload: { sealed },
        })
        .onConflictDoNothing();
    },
    async readEvidence(receiptId: string, canRead: () => Promise<boolean>) {
      if (!options.rawEvidence || !(await canRead())) return null;
      const [row] = await database
        .select({ payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.id, idFor(evidenceType, receiptId)),
            sql`${events.createdAt} > clock_timestamp() - interval '7 days'`,
          ),
        );
      const parsed = z.object({ sealed: z.string() }).safeParse(row?.payload);
      return parsed.success
        ? Buffer.from(
            await decryptSecret(
              options.rawEvidence.encryptionKey,
              parsed.data.sealed,
            ),
            "base64",
          )
        : null;
    },
    async expireEvidence(now = new Date()) {
      await database
        .delete(events)
        .where(
          and(
            eq(events.accountId, accountId),
            eq(events.eventType, evidenceType),
            sql`${events.createdAt} <= ${new Date(now.getTime() - retentionMs)}`,
          ),
        );
    },
  };
}
