import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { auditEvents } from "../../db/schema/core";
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
  retryMs = 30_000,
}: GithubEventScope & {
  database: Database;
  triggers: ReturnType<typeof createGithubEventTriggers>;
  isolatedSources: ReadonlySet<string>;
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
    tx: EventTransaction,
    {
      receipt,
      triggerId,
      outcome,
      runId,
      personId,
    }: {
      receipt: Receipt;
      triggerId?: string;
      outcome: string;
      runId?: string;
      personId?: string;
    },
  ) {
    await tx.insert(auditEvents).values({
      eventType: "corsair.github.event_delivery",
      actorUserId: personId,
      initiatorKind: "system",
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
      },
    });
  }

  async function plan(
    tx: EventTransaction,
    receipt: Receipt,
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
    if (
      !receipt.pilotDispatch ||
      !isolatedSources.has(`${receipt.installationId}/${receipt.repositoryId}`)
    )
      return "observed";
    if (
      !receipt.occurredAt ||
      !githubPilotEventType.safeParse(receipt.eventType).success
    )
      return "review";
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
      const outcome =
        trigger.createdAt > receipt.occurredAt ||
        trigger.disabledAt ||
        trigger.repositoryNodeId !== repo.nodeId
          ? "ineligible"
          : "pending";
      await tx
        .insert(outcomes)
        .values({ receiptId: receipt.id, triggerId: trigger.id, outcome });
      if (outcome !== "pending")
        await audit(tx, { receipt, triggerId: trigger.id, personId, outcome });
    }
    return "planned";
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
    await database.transaction(async (tx) => {
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
      const isolated = isolatedSources.has(
        `${receipt.installationId}/${receipt.repositoryId}`,
      );
      let result: Outcome["outcome"] = isolated ? "denied" : "ineligible";
      let runId: string | undefined;
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
        if (goal.status !== "active") result = "ineligible";
        else if (
          !receipt.occurredAt ||
          (goal.updatedAt > receipt.occurredAt &&
            goal.updatedAt <= receipt.receivedAt)
        )
          result = "review";
        else if (access === "retry") result = "retry";
        else if (access === "allowed") {
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
        await audit(tx, {
          receipt,
          triggerId: outcome.triggerId,
          personId: binding?.personId,
          outcome: result,
          runId,
        });
    });
  }

  return {
    async sweep() {
      await database.transaction(async (tx) => {
        const batch = await tx
          .select()
          .from(receipts)
          .where(and(inScope, isNull(receipts.fanoutAt)))
          .orderBy(asc(receipts.receivedAt))
          .limit(20)
          .for("update", { skipLocked: true });
        for (const receipt of batch) {
          const disposition = await plan(tx, receipt);
          await tx
            .update(receipts)
            .set({ disposition, fanoutAt: new Date() })
            .where(eq(receipts.id, receipt.id));
          await audit(tx, { receipt, outcome: disposition });
        }
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
