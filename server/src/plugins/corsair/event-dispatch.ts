import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type AuditStore,
  createAuditStore,
  withAuditTransaction,
} from "../../audit";
import {
  githubPilotEventTriggers as bindings,
  githubPilotEventOutcomes as outcomes,
  githubPilotEventReceipts as receipts,
  githubPilotRepositories as repositories,
} from "../../db/schema/corsair";
import {
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
} from "../../db/schema/responsibilities";
import { workItems } from "../../db/schema/work";
import { RESPONSIBILITY_RUN_KIND } from "../../responsibilities/engine";
import { type GithubEventScope, githubPilotEventType } from "./event-ingress";
import type { CorsairEventOperations } from "./event-operations";
import { GITHUB_EVENT_PREFIX } from "./event-run-access";
import type {
  createGithubEventTriggers,
  EventTransaction,
} from "./event-triggers";

type Receipt = typeof receipts.$inferSelect;
type Outcome = typeof outcomes.$inferSelect;

export function createGithubEventDispatch({
  database,
  workspaceId,
  registration,
  triggers,
  isolatedSources,
  operations,
  retryMs = 30_000,
}: GithubEventScope & {
  database: Database;
  triggers: ReturnType<typeof createGithubEventTriggers>;
  isolatedSources: ReadonlySet<string>;
  operations?: CorsairEventOperations;
  retryMs?: number;
}) {
  const inScope = and(
    eq(receipts.workspaceId, workspaceId),
    eq(receipts.registration, registration),
  );
  const available = inArray(outcomes.outcome, ["pending", "retry"]);
  const key = (row: Pick<Outcome, "receiptId" | "triggerId">) =>
    and(
      eq(outcomes.receiptId, row.receiptId),
      eq(outcomes.triggerId, row.triggerId),
    );

  async function audit(
    store: AuditStore,
    {
      receipt,
      triggerId,
      outcome,
      runId,
      personId,
      reason,
    }: {
      receipt: Receipt;
      triggerId?: string;
      outcome: string;
      runId?: string;
      personId?: string;
      reason?: string;
    },
  ) {
    await store.insert({
      eventType: "corsair.github.event_delivery",
      actorUserId: personId,
      initiator: { kind: "system" },
      targetType: "github_event_receipt",
      targetId: receipt.id,
      payload: {
        workspaceId,
        registration,
        deliveryId: receipt.deliveryId,
        installationId: receipt.installationId,
        repositoryId: receipt.repositoryId,
        eventType: receipt.eventType,
        triggerId,
        outcome,
        runId,
        reason,
      },
    });
  }

  async function plan(
    tx: EventTransaction,
    receipt: Receipt,
    store: AuditStore,
  ): Promise<NonNullable<Receipt["disposition"]>> {
    if (!receipt.installationId || !receipt.repositoryId) return "review";
    const [repo] = await tx
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.workspaceId, workspaceId),
          eq(repositories.registration, registration),
          eq(repositories.installationId, receipt.installationId),
          eq(repositories.repositoryId, receipt.repositoryId),
        ),
      );
    if (!repo) return "unenrolled";
    if (!githubPilotEventType.safeParse(receipt.eventType).success)
      return "review";
    const owns =
      receipt.pilotDispatch &&
      (isolatedSources.has(
        `${receipt.installationId}/${receipt.repositoryId}`,
      ) ||
        (await operations?.nativeOwner(
          tx,
          { provider: "github", source: receipt.repositoryId },
          receipt.occurredAt,
          undefined,
          receipt.installationId,
        )) === "corsair");
    const candidates = await tx
      .select({ trigger: bindings, personId: responsibilities.ownerUserId })
      .from(bindings)
      .innerJoin(responsibilities, eq(responsibilities.id, bindings.goalId))
      .where(
        and(
          eq(bindings.workspaceId, workspaceId),
          eq(bindings.registration, registration),
          eq(bindings.installationId, repo.installationId),
          eq(bindings.repositoryId, repo.repositoryId),
          sql`${receipt.eventType} = any(${bindings.eventTypes})`,
        ),
      );
    for (const { trigger, personId } of candidates) {
      const reason =
        receipt.occurredAt && trigger.createdAt > receipt.occurredAt
          ? "trigger-created-after-event"
          : trigger.disabledAt
            ? "trigger-disabled"
            : trigger.repositoryNodeId !== repo.nodeId
              ? "source-binding-changed"
              : undefined;
      const outcome = reason
        ? "ineligible"
        : owns && receipt.occurredAt
          ? "pending"
          : "review";
      await tx
        .insert(outcomes)
        .values({ receiptId: receipt.id, triggerId: trigger.id, outcome });
      if (outcome !== "pending")
        await audit(store, {
          receipt,
          triggerId: trigger.id,
          personId,
          outcome,
          reason,
        });
    }
    return !receipt.occurredAt ? "review" : owns ? "planned" : "observed";
  }

  async function planReceipt(
    tx: EventTransaction,
    receipt: Receipt,
    store: AuditStore,
  ) {
    const disposition = await plan(tx, receipt, store);
    await tx
      .update(receipts)
      .set({ disposition, fanoutAt: new Date() })
      .where(eq(receipts.id, receipt.id));
    await audit(store, { receipt, outcome: disposition });
  }

  async function deliver(receipt: Receipt, outcome: Outcome) {
    const [binding] = await database
      .select({ trigger: bindings, personId: responsibilities.ownerUserId })
      .from(bindings)
      .innerJoin(responsibilities, eq(responsibilities.id, bindings.goalId))
      .where(eq(bindings.id, outcome.triggerId));
    const access = binding
      ? await triggers.access(binding.trigger, binding.personId)
      : "denied";
    const historyUnknown =
      receipt.occurredAt &&
      (await operations?.requiresReplayEvidence(
        receipt.id,
        outcome.triggerId,
        receipt.occurredAt,
        receipt.receivedAt,
      ));
    await withAuditTransaction(database, async (tx, deferTap) => {
      const store = createAuditStore(tx, deferTap);
      const [current] = await tx
        .select()
        .from(outcomes)
        .where(
          and(key(outcome), available, lte(outcomes.nextAttemptAt, new Date())),
        )
        .for("update", { skipLocked: true });
      if (!current) return;
      const [goal] = binding
        ? await tx
            .select()
            .from(responsibilities)
            .where(eq(responsibilities.id, binding.trigger.goalId))
            .for("update")
        : [];
      const isolated = !!(
        receipt.pilotDispatch &&
        (isolatedSources.has(
          `${receipt.installationId}/${receipt.repositoryId}`,
        ) ||
          (receipt.repositoryId &&
            (await operations?.nativeOwner(
              tx,
              { provider: "github", source: receipt.repositoryId },
              receipt.occurredAt,
              undefined,
              receipt.installationId,
            )) === "corsair"))
      );
      let result: Outcome["outcome"] = isolated ? "denied" : "ineligible";
      let runId: string | undefined;
      let reason = isolated
        ? "source-read-access-unavailable"
        : "legacy-owns-source";
      if (
        isolated &&
        binding &&
        goal?.ownerUserId === binding.personId &&
        (await triggers.stillAuthorized(
          tx,
          binding.trigger.id,
          binding.personId,
        ))
      ) {
        if (goal.status !== "active") {
          result = "ineligible";
          reason = "goal-inactive";
        } else if (
          !receipt.occurredAt ||
          (goal.updatedAt > receipt.occurredAt &&
            goal.updatedAt <= receipt.receivedAt)
        )
          result = "review";
        else if (access === "retry") result = "retry";
        else if (access === "allowed" && historyUnknown) {
          result = "review";
          reason = "history-unverified";
        } else if (access === "allowed") {
          const eventId = randomUUID();
          runId = randomUUID();
          await tx.insert(responsibilityEvents).values({
            id: eventId,
            ownerUserId: goal.ownerUserId,
            source: "github",
            externalId: `${GITHUB_EVENT_PREFIX}${receipt.id}:${binding.trigger.id}`,
            type: receipt.eventType,
            payload: receipt.payload,
          });
          await tx
            .insert(responsibilityRuns)
            .values({ id: runId, responsibilityId: goal.id, eventId });
          await tx.insert(workItems).values({
            kind: RESPONSIBILITY_RUN_KIND,
            key: runId,
            payload: { runId },
          });
          result = "queued";
        }
      }
      await tx
        .update(outcomes)
        .set({
          outcome: result,
          runId,
          nextAttemptAt: new Date(Date.now() + retryMs),
        })
        .where(key(outcome));
      if (result !== "retry" || current.outcome !== "retry")
        await audit(store, {
          receipt,
          triggerId: outcome.triggerId,
          personId: binding?.personId,
          outcome: result,
          runId,
          reason:
            result === "queued" || result === "retry" ? undefined : reason,
        });
    });
  }

  return {
    async planAccepted(
      tx: EventTransaction,
      receiptId: string,
      store: AuditStore,
    ) {
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(inScope, eq(receipts.id, receiptId)));
      if (receipt) await planReceipt(tx, receipt, store);
    },
    async sweep() {
      await withAuditTransaction(database, async (tx, deferTap) => {
        const store = createAuditStore(tx, deferTap);
        const batch = await tx
          .select()
          .from(receipts)
          .where(and(inScope, isNull(receipts.fanoutAt)))
          .orderBy(asc(receipts.receivedAt))
          .limit(20)
          .for("update", { skipLocked: true });
        for (const receipt of batch) await planReceipt(tx, receipt, store);
      });
      const pending = await database
        .select({ receipt: receipts, outcome: outcomes })
        .from(outcomes)
        .innerJoin(receipts, eq(receipts.id, outcomes.receiptId))
        .where(and(inScope, available, lte(outcomes.nextAttemptAt, new Date())))
        .orderBy(asc(outcomes.nextAttemptAt))
        .limit(20);
      for (const { receipt, outcome } of pending)
        await deliver(receipt, outcome);
    },
  };
}
