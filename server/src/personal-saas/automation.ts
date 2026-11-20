import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { TURN_LIMITS } from "@openbot/toolkit/limits";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  deliveryBindings,
  deliveryInbox,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
  routineRuns,
  routines,
} from "../db/schema";
import { nextOccurrence, ScheduleRefusedError } from "../routines/schedule";
import { DEFAULT_GRACE_MS } from "../routines/sweep";
import { createWorkQueue } from "../work/queue";
import { readExecutionAccess } from "./account-access";
import { type Transaction, workspaceConversations } from "./store";

const routineKind = "personal.automation.routine";
const inboundKind = "personal.automation.inbound";
const resumeRequired = "manual_resume_required";
const subject = z.object({
  accountId: z.uuid(),
  epoch: z.number().int().nonnegative(),
  scheduledFor: z.number().int().optional(),
});

export const inboundMessage = z.strictObject({
  transport: z.enum(["sms", "slack", "teams"]),
  realm: z.string().min(1).max(512),
  identity: z.string().min(1).max(512),
  externalId: z.string().min(1).max(512),
  sentAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
  text: z.string().trim().min(1).max(20_000),
});

function personalResource(table: typeof routines | typeof deliveryBindings) {
  return and(
    eq(
      table.ownerUserId,
      sql<string>`'personal-workspace:' || ${personalWorkspaces.id}::text`,
    ),
    eq(table.agentId, personalWorkspaceDefaultBots.agentId),
  );
}

function requiredAccess(
  access: Awaited<ReturnType<typeof readExecutionAccess>>,
  resumedEpoch: number,
) {
  if (!access) return "account_status_unconfirmed";
  if (access.kind === "denied") return access.reason;
  return access.epoch === resumedEpoch ? null : resumeRequired;
}

export function personalAutomation(
  database: Database,
  now: () => number,
  runTurn?: TurnRunner,
) {
  const queue = createWorkQueue(database, now);
  const runnerId = crypto.randomUUID();

  function ownRoutines(db: Pick<Database, "select">) {
    return db
      .select({ routine: routines, accountId: personalWorkspaces.ownerId })
      .from(routines)
      .innerJoin(
        personalWorkspaceDefaultBots,
        eq(routines.agentId, personalWorkspaceDefaultBots.agentId),
      )
      .innerJoin(
        personalWorkspaces,
        and(
          eq(personalWorkspaces.id, personalWorkspaceDefaultBots.workspaceId),
          personalResource(routines),
        ),
      );
  }

  function ownBindings(db: Pick<Database, "select">) {
    return db
      .select({
        binding: deliveryBindings,
        accountId: personalWorkspaces.ownerId,
      })
      .from(deliveryBindings)
      .innerJoin(
        personalWorkspaceDefaultBots,
        eq(deliveryBindings.agentId, personalWorkspaceDefaultBots.agentId),
      )
      .innerJoin(
        personalWorkspaces,
        and(
          eq(personalWorkspaces.id, personalWorkspaceDefaultBots.workspaceId),
          personalResource(deliveryBindings),
        ),
      );
  }

  const ownRoutine = (id: string, accountId: string) =>
    and(eq(routines.id, id), eq(personalWorkspaces.ownerId, accountId));

  async function startRoutine(
    tx: Transaction,
    accountId: string,
    routine: typeof routines.$inferSelect,
    source: "schedule" | "run_now",
    reason: string | null,
  ) {
    const runId = `routine_run_${crypto.randomUUID()}`;
    await tx.insert(routineRuns).values({
      id: runId,
      routineId: routine.id,
      source,
      ...(reason
        ? { status: "skipped", finishedAt: new Date(now()), error: reason }
        : {}),
    });
    if (!reason)
      await createWorkQueue(tx, now).offer({
        kind: routineKind,
        key: runId,
        payload: {
          accountId,
          epoch: routine.personalResumeEpoch,
          ...(source === "schedule"
            ? { scheduledFor: routine.nextRunAt.getTime() }
            : {}),
        },
      });
    return runId;
  }

  async function offerSchedules() {
    const due = await ownRoutines(database)
      .where(
        and(
          eq(routines.enabled, true),
          lte(routines.nextRunAt, new Date(now())),
        ),
      )
      .orderBy(asc(routines.nextRunAt), asc(routines.id))
      .limit(50);
    for (const candidate of due) {
      await database.transaction(async (tx) => {
        const { accountId } = candidate;
        const access = await readExecutionAccess(tx, accountId, now);
        const [held] = await ownRoutines(tx)
          .where(
            and(
              ownRoutine(candidate.routine.id, accountId),
              eq(routines.enabled, true),
              eq(routines.nextRunAt, candidate.routine.nextRunAt),
            ),
          )
          .for("update", { of: routines, skipLocked: true });
        if (!held) return;
        const { routine } = held;
        const reason =
          requiredAccess(access, routine.personalResumeEpoch) ??
          (!runTurn ? "bot_execution_unavailable" : null);
        const currentTime = new Date(now());
        try {
          const nextRunAt = nextOccurrence(
            routine.cron,
            routine.timezone,
            currentTime,
          );
          await tx
            .update(routines)
            .set({ nextRunAt, lastRunAt: routine.nextRunAt })
            .where(eq(routines.id, routine.id));
        } catch (error) {
          if (!(error instanceof ScheduleRefusedError)) throw error;
          await tx
            .update(routines)
            .set({ enabled: false })
            .where(eq(routines.id, routine.id));
          await startRoutine(
            tx,
            accountId,
            routine,
            "schedule",
            reason ?? error.message,
          );
          return;
        }
        if (reason || now() - routine.nextRunAt.getTime() <= DEFAULT_GRACE_MS)
          await startRoutine(tx, accountId, routine, "schedule", reason);
      });
    }
  }

  async function dispatch(
    input: Parameters<TurnRunner>[0],
    accountId: string,
    epoch: number,
    expiresAt: number,
  ) {
    if (!runTurn) return "bot_execution_unavailable";
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let stopped: string | undefined;
    let done = false;

    function stop(reason: string) {
      stopped ??= reason;
      controller.abort();
    }

    function enforceDeadline() {
      clearTimeout(deadline);
      if (now() >= expiresAt) stop("account_status_unconfirmed");
      else
        deadline = setTimeout(
          () => stop("account_status_unconfirmed"),
          expiresAt - now(),
        );
    }

    async function verify() {
      const access = await database.transaction((tx) =>
        readExecutionAccess(tx, accountId, now, epoch),
      );
      if (done) return;
      const reason = requiredAccess(access, epoch);
      if (reason) stop(reason);
      if (now() >= expiresAt) stop("account_status_unconfirmed");
      controller.signal.throwIfAborted();
      if (access?.kind === "active") {
        expiresAt = access.expiresAt;
        enforceDeadline();
      }
    }

    function checkSoon() {
      poll = setTimeout(() => {
        void verify()
          .catch(() => stop("account_status_unconfirmed"))
          .finally(() => {
            if (!done && !controller.signal.aborted) checkSoon();
          });
      }, 1_000);
    }

    const timeout = setTimeout(
      () => stop("run_interrupted"),
      TURN_LIMITS.turnTimeoutMs,
    );
    enforceDeadline();
    checkSoon();
    try {
      await verify();
      await runTurn({
        ...input,
        signal: controller.signal,
        beforeDispatch: verify,
      });
      await verify();
      return null;
    } catch {
      return stopped ?? "run_interrupted";
    } finally {
      done = true;
      clearTimeout(timeout);
      clearTimeout(deadline);
      clearTimeout(poll);
    }
  }

  async function channelIsOwned(
    tx: Transaction,
    accountId: string,
    channelId: string,
  ) {
    const owned = workspaceConversations(tx, { accountId }).as(
      "owned_conversations",
    );
    const [row] = await tx
      .select({ id: owned.id })
      .from(owned)
      .where(eq(owned.id, channelId));
    return Boolean(row);
  }

  async function process(kind: typeof routineKind | typeof inboundKind) {
    if (!runTurn) return;
    const owner = `${runnerId}:${crypto.randomUUID()}`;
    const [item] = await queue.claim({
      kind,
      owner,
      limit: 1,
      leaseMs: TURN_LIMITS.turnTimeoutMs + 30_000,
    });
    if (!item) return;
    const { accountId, epoch, scheduledFor } = subject.parse(item.payload);
    if (kind === routineKind) {
      const [row] = await database
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.id, item.key));
      if (row?.status === null) {
        const admission = await database.transaction(async (tx) => {
          const access = await readExecutionAccess(tx, accountId, now, epoch);
          const [held] = await ownRoutines(tx).where(
            ownRoutine(row.routineId, accountId),
          );
          const reason = requiredAccess(access, epoch);
          if (reason) return { reason };
          if (item.attempts > 1) return { reason: "run_interrupted" };
          if (
            scheduledFor !== undefined &&
            now() - scheduledFor > DEFAULT_GRACE_MS
          )
            return { reason: "routine_occurrence_expired" };
          if (
            !held?.routine.enabled ||
            held.routine.personalResumeEpoch !== epoch
          )
            return { reason: "routine_paused" };
          if (!(await channelIsOwned(tx, accountId, held.routine.channelId)))
            return { reason: "conversation_unavailable" };
          return access?.kind === "active"
            ? { expiresAt: access.expiresAt, ...held }
            : { reason: "account_status_unconfirmed" };
        });
        const reason =
          "reason" in admission
            ? admission.reason
            : await dispatch(
                {
                  ownerUserId: accountId,
                  routineId: row.routineId,
                  runId: row.id,
                  agentId: admission.routine.agentId,
                  threadId: admission.routine.channelId,
                  instruction: admission.routine.instruction,
                  telemetry: {
                    trigger: row.source === "run_now" ? "human" : "routine",
                    surface: "unknown",
                    rootTaskId: row.id,
                  },
                },
                accountId,
                epoch,
                admission.expiresAt,
              );
        await database
          .update(routineRuns)
          .set({
            status: !reason
              ? "succeeded"
              : item.attempts > 1 || !("reason" in admission)
                ? "failed"
                : "skipped",
            error: reason ?? null,
            finishedAt: new Date(now()),
          })
          .where(and(eq(routineRuns.id, row.id), isNull(routineRuns.status)));
      }
    } else {
      const [row] = await database
        .select()
        .from(deliveryInbox)
        .where(eq(deliveryInbox.id, item.key));
      if (row && (row.state === "queued" || row.state === "running")) {
        const admission = await database.transaction(async (tx) => {
          const access = await readExecutionAccess(tx, accountId, now, epoch);
          const [held] = row.bindingId
            ? await ownBindings(tx).where(
                and(
                  eq(deliveryBindings.id, row.bindingId),
                  eq(personalWorkspaces.ownerId, accountId),
                ),
              )
            : [];
          const reason = requiredAccess(access, epoch);
          if (reason) return { reason };
          if (item.attempts > 1 || row.state === "running")
            return { reason: "run_interrupted" };
          if (
            !held?.binding.enabled ||
            held.binding.optedOutAt ||
            held.binding.personalResumeEpoch !== epoch ||
            held.binding.agentId !== row.agentId ||
            held.binding.threadId !== row.threadId ||
            held.binding.channelId !== row.channelId ||
            !(await channelIsOwned(tx, accountId, row.channelId))
          )
            return { reason: "binding_unavailable" };
          await tx
            .update(deliveryInbox)
            .set({ state: "running" })
            .where(eq(deliveryInbox.id, row.id));
          return access?.kind === "active"
            ? { expiresAt: access.expiresAt }
            : { reason: "account_status_unconfirmed" };
        });
        const reason =
          "reason" in admission
            ? admission.reason
            : await dispatch(
                {
                  ownerUserId: accountId,
                  routineId: row.id,
                  runId: row.id,
                  agentId: row.agentId,
                  threadId: row.threadId,
                  instruction: row.text,
                  userMessage: { id: row.id, role: "user", content: row.text },
                },
                accountId,
                epoch,
                admission.expiresAt,
              );
        await database
          .update(deliveryInbox)
          .set({
            state: !reason
              ? "sent"
              : row.state === "running" || !("reason" in admission)
                ? "unknown"
                : "skipped",
            error: reason ?? null,
          })
          .where(eq(deliveryInbox.id, row.id));
      }
    }
    await queue.finish({ kind, key: item.key, owner });
  }

  return {
    offerSchedules,
    sweepRoutines: () => process(routineKind),
    sweepInbound: () => process(inboundKind),
    async list(tx: Transaction, accountId: string) {
      const access = await readExecutionAccess(tx, accountId, now);
      const schedules = await ownRoutines(tx).where(
        eq(personalWorkspaces.ownerId, accountId),
      );
      const bindings = await ownBindings(tx).where(
        and(
          eq(personalWorkspaces.ownerId, accountId),
          eq(deliveryBindings.enabled, true),
        ),
      );
      return {
        routines: schedules.map(({ routine }) => ({
          id: routine.id,
          title: routine.title,
          enabled: routine.enabled,
          nextRunAt: routine.nextRunAt,
          blockedReason: requiredAccess(access, routine.personalResumeEpoch),
        })),
        bindings: bindings.map(({ binding }) => ({
          id: binding.id,
          transport: binding.transport,
          blockedReason: requiredAccess(access, binding.personalResumeEpoch),
        })),
      };
    },
    async routineHistory(tx: Transaction, accountId: string, id: string) {
      if (!(await ownRoutines(tx).where(ownRoutine(id, accountId))).length)
        return null;
      return tx
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, id))
        .orderBy(desc(routineRuns.startedAt))
        .limit(50);
    },
    async bindingHistory(tx: Transaction, accountId: string, id: string) {
      const [held] = await ownBindings(tx).where(
        and(
          eq(deliveryBindings.id, id),
          eq(personalWorkspaces.ownerId, accountId),
        ),
      );
      if (!held) return null;
      return tx
        .select({
          id: deliveryInbox.id,
          state: deliveryInbox.state,
          error: deliveryInbox.error,
          receivedAt: deliveryInbox.createdAt,
        })
        .from(deliveryInbox)
        .where(
          and(
            eq(deliveryInbox.bindingId, id),
            eq(deliveryInbox.ownerUserId, held.binding.ownerUserId),
          ),
        )
        .orderBy(desc(deliveryInbox.createdAt))
        .limit(50);
    },
    async routineAction(
      tx: Transaction,
      accountId: string,
      id: string,
      action: "run" | "resume",
    ) {
      const access = await readExecutionAccess(tx, accountId, now);
      const [held] = await ownRoutines(tx)
        .where(ownRoutine(id, accountId))
        .for("update", { of: routines });
      if (!held) return { kind: "missing" } as const;
      if (access?.kind !== "active") return { kind: "denied" } as const;
      const { routine } = held;
      if (action === "resume") {
        if (routine.personalResumeEpoch !== access.epoch) {
          const resumedAt = new Date(now());
          if (routine.enabled && routine.nextRunAt <= resumedAt)
            await startRoutine(
              tx,
              accountId,
              routine,
              "schedule",
              resumeRequired,
            );
          await tx
            .update(routines)
            .set({
              personalResumeEpoch: access.epoch,
              nextRunAt: nextOccurrence(
                routine.cron,
                routine.timezone,
                resumedAt,
              ),
            })
            .where(eq(routines.id, id));
        }
        return { kind: "resumed" } as const;
      }
      if (!routine.enabled) return { kind: "paused" } as const;
      const reason = requiredAccess(access, routine.personalResumeEpoch);
      if (reason) {
        await startRoutine(tx, accountId, routine, "run_now", reason);
        return { kind: "paused" } as const;
      }
      if (!runTurn) return { kind: "offline" } as const;
      const [open] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(and(eq(routineRuns.routineId, id), isNull(routineRuns.status)))
        .limit(1);
      if (open) return { kind: "running" } as const;
      return {
        kind: "queued",
        runId: await startRoutine(tx, accountId, routine, "run_now", null),
      } as const;
    },
    async resumeBinding(tx: Transaction, accountId: string, id: string) {
      const access = await readExecutionAccess(tx, accountId, now);
      if (access?.kind !== "active") return "denied";
      const [held] = await ownBindings(tx)
        .where(
          and(
            eq(deliveryBindings.id, id),
            eq(personalWorkspaces.ownerId, accountId),
            eq(deliveryBindings.enabled, true),
          ),
        )
        .for("update", { of: deliveryBindings });
      if (!held) return "missing";
      if (held.binding.personalResumeEpoch !== access.epoch)
        await tx
          .update(deliveryBindings)
          .set({
            personalResumeEpoch: access.epoch,
            personalResumedAt: new Date(now()),
          })
          .where(eq(deliveryBindings.id, id));
      return "resumed";
    },
    async receive(input: z.infer<typeof inboundMessage>) {
      return database.transaction(async (tx) => {
        const match = and(
          eq(deliveryBindings.transport, input.transport),
          eq(deliveryBindings.realm, input.realm),
          eq(deliveryBindings.identity, input.identity),
          eq(deliveryBindings.enabled, true),
        );
        const [candidate] = await ownBindings(tx).where(match);
        if (!candidate) return;
        const access = await readExecutionAccess(tx, candidate.accountId, now);
        const [held] = await ownBindings(tx)
          .where(and(match, eq(deliveryBindings.id, candidate.binding.id)))
          .for("share", { of: deliveryBindings });
        if (!held) return;
        const { binding, accountId } = held;
        if (accountId !== candidate.accountId) return;
        const reason =
          requiredAccess(access, binding.personalResumeEpoch) ??
          (binding.optedOutAt
            ? "opted_out"
            : binding.personalResumedAt &&
                input.sentAt <= binding.personalResumedAt
              ? "message_predates_resume"
              : !runTurn
                ? "bot_execution_unavailable"
                : null);
        const id = crypto.randomUUID();
        const [row] = await tx
          .insert(deliveryInbox)
          .values({
            id,
            bindingId: binding.id,
            ownerUserId: binding.ownerUserId,
            channelId: binding.channelId,
            agentId: binding.agentId,
            threadId: binding.threadId,
            source: input.transport,
            realm: input.realm,
            externalId: input.externalId,
            text: reason ? "" : input.text,
            state: reason ? "skipped" : "queued",
            error: reason,
          })
          .onConflictDoNothing()
          .returning({ id: deliveryInbox.id });
        if (row && !reason)
          await createWorkQueue(tx, now).offer({
            kind: inboundKind,
            key: id,
            payload: { accountId, epoch: binding.personalResumeEpoch },
          });
      });
    },
  };
}
