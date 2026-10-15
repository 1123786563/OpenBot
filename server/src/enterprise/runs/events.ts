import type { BaseEvent } from "@ag-ui/client";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { EventRow } from "../../db/schema/enterprise-runs";
import {
  enterpriseRunAttempts,
  enterpriseRunnerEvents,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import type {
  EventAck,
  EventPage,
  EventProposal,
  PlatformScope,
  RunnerEventRecord,
  RunnerRequestLease,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import type { DataDatabase } from "../tenancy/connections";
import { assertDataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

export type RunnerEventProposal = EventProposal;

export interface RunnerEventTransaction {
  lockRunAndAttempt(
    scope: PlatformScope,
    lease: RunnerRequestLease,
  ): Promise<void>;
  lockSourceIdentity(
    scope: PlatformScope,
    lease: RunnerRequestLease,
    sourceEventId: string,
  ): Promise<void>;
  findActiveRun(
    scope: PlatformScope,
    lease: RunnerRequestLease,
  ): Promise<{ threadId: string } | undefined>;
  findBySourceIdentity(
    scope: PlatformScope,
    lease: RunnerRequestLease,
    sourceEventId: string,
  ): Promise<RunnerEventRecord | undefined>;
  lockThreadCursor(scope: PlatformScope, threadId: string): Promise<void>;
  nextThreadCursor(scope: PlatformScope, threadId: string): Promise<number>;
  insert(
    scope: PlatformScope,
    proposal: RunnerEventProposal,
    threadId: string,
    seq: number,
  ): Promise<RunnerEventRecord>;
  replay(
    scope: PlatformScope,
    threadId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RunnerEventRecord[]>;
}

export interface RunnerEventRepository {
  transaction<T>(
    scope: PlatformScope,
    operation: (tx: RunnerEventTransaction) => Promise<T>,
  ): Promise<T>;
}

export function canonicalizeRunnerEvent(event: BaseEvent): string {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof event.type !== "string" ||
    !event.type.trim()
  ) {
    throw new Error("RUNNER_EVENT_INVALID");
  }
  try {
    const canonical = JSON.stringify(sortJson(event));
    if (!canonical || Buffer.byteLength(canonical, "utf8") > 1_000_000) {
      throw new Error("RUNNER_EVENT_INVALID");
    }
    return canonical;
  } catch {
    throw new Error("RUNNER_EVENT_INVALID");
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new Error("RUNNER_EVENT_INVALID");
}

function recordOf(row: EventRow): RunnerEventRecord {
  return {
    eventId: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    threadId: row.threadId,
    runId: row.runId,
    attemptId: row.attemptId,
    generation: row.generation,
    sourceEventId: row.sourceEventId,
    seq: row.seq,
    schemaVersion: row.schemaVersion,
    event: row.event,
    createdAt: row.createdAt,
  };
}

export function createDrizzleRunnerEventRepository(
  data: DataDatabase,
): RunnerEventRepository {
  assertDataDatabase(data);
  const scoped = createConversationStore(data);
  return {
    transaction: (scope, operation) =>
      scoped.transaction(scope, (tx) =>
        operation({
          async lockRunAndAttempt(eventScope, lease) {
            const [run] = await tx
              .select({ id: enterpriseRuns.id })
              .from(enterpriseRuns)
              .where(
                and(
                  eq(enterpriseRuns.tenantId, eventScope.tenantId),
                  eq(enterpriseRuns.workspaceId, eventScope.workspaceId),
                  eq(enterpriseRuns.principalId, eventScope.principalId),
                  eq(enterpriseRuns.id, lease.runId),
                ),
              )
              .for("update")
              .limit(1);
            if (!run) throw new Error("RUN_ATTEMPT_STALE");
            const [attempt] = await tx
              .select({ id: enterpriseRunAttempts.id })
              .from(enterpriseRunAttempts)
              .where(
                and(
                  eq(enterpriseRunAttempts.tenantId, eventScope.tenantId),
                  eq(enterpriseRunAttempts.runId, lease.runId),
                  eq(enterpriseRunAttempts.id, lease.attemptId),
                  eq(enterpriseRunAttempts.generation, lease.generation),
                ),
              )
              .for("update")
              .limit(1);
            if (!attempt) throw new Error("RUN_ATTEMPT_STALE");
          },
          async lockSourceIdentity(eventScope, lease, sourceEventId) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["runner-event-source", eventScope.tenantId, lease.runId, lease.attemptId, lease.generation, sourceEventId])}, 0))`,
            );
          },
          async findActiveRun(eventScope, lease) {
            const [run] = await tx
              .select({ threadId: enterpriseRuns.threadId })
              .from(enterpriseRuns)
              .innerJoin(
                enterpriseRunAttempts,
                and(
                  eq(enterpriseRunAttempts.tenantId, enterpriseRuns.tenantId),
                  eq(enterpriseRunAttempts.runId, enterpriseRuns.id),
                ),
              )
              .where(
                and(
                  eq(enterpriseRuns.tenantId, eventScope.tenantId),
                  eq(enterpriseRuns.workspaceId, eventScope.workspaceId),
                  eq(enterpriseRuns.principalId, eventScope.principalId),
                  eq(enterpriseRuns.id, lease.runId),
                  eq(enterpriseRuns.attemptGeneration, lease.generation),
                  sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
                  sql`${enterpriseRuns.leaseExpiresAt} > clock_timestamp()`,
                  eq(enterpriseRunAttempts.id, lease.attemptId),
                  eq(enterpriseRunAttempts.generation, lease.generation),
                  eq(enterpriseRunAttempts.status, "active"),
                  eq(enterpriseRunAttempts.requestOwnerToken, lease.ownerToken),
                  sql`${enterpriseRunAttempts.leaseExpiresAt} > clock_timestamp()`,
                  sql`${enterpriseRunAttempts.requestOwnerExpiresAt} > clock_timestamp()`,
                ),
              )
              .limit(1);
            return run;
          },
          async findBySourceIdentity(eventScope, lease, sourceEventId) {
            const [row] = await tx
              .select()
              .from(enterpriseRunnerEvents)
              .where(
                and(
                  eq(enterpriseRunnerEvents.tenantId, eventScope.tenantId),
                  eq(enterpriseRunnerEvents.runId, lease.runId),
                  eq(enterpriseRunnerEvents.attemptId, lease.attemptId),
                  eq(enterpriseRunnerEvents.generation, lease.generation),
                  eq(enterpriseRunnerEvents.sourceEventId, sourceEventId),
                ),
              )
              .limit(1);
            return row ? recordOf(row) : undefined;
          },
          async lockThreadCursor(eventScope, threadId) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["runner-event-cursor", eventScope.tenantId, threadId])}, 0))`,
            );
          },
          async nextThreadCursor(eventScope, threadId) {
            const [last] = await tx
              .select({ seq: enterpriseRunnerEvents.seq })
              .from(enterpriseRunnerEvents)
              .where(
                and(
                  eq(enterpriseRunnerEvents.tenantId, eventScope.tenantId),
                  eq(enterpriseRunnerEvents.threadId, threadId),
                ),
              )
              .orderBy(desc(enterpriseRunnerEvents.seq))
              .limit(1);
            const next = (last?.seq ?? 0) + 1;
            if (!Number.isSafeInteger(next))
              throw new Error("RUNNER_EVENT_CURSOR_EXHAUSTED");
            return next;
          },
          async insert(eventScope, proposal, threadId, seq) {
            const [row] = await tx
              .insert(enterpriseRunnerEvents)
              .values({
                tenantId: eventScope.tenantId,
                workspaceId: eventScope.workspaceId,
                principalId: eventScope.principalId,
                threadId,
                runId: proposal.lease.runId,
                attemptId: proposal.lease.attemptId,
                generation: proposal.lease.generation,
                sourceEventId: proposal.sourceEventId,
                seq,
                schemaVersion: proposal.schemaVersion,
                eventType: proposal.event.type,
                event: proposal.event,
              })
              .returning();
            if (!row) throw new Error("RUNNER_EVENT_APPEND_FAILED");
            return recordOf(row);
          },
          async replay(eventScope, threadId, afterSeq, limit) {
            const rows = await tx
              .select()
              .from(enterpriseRunnerEvents)
              .where(
                and(
                  eq(enterpriseRunnerEvents.tenantId, eventScope.tenantId),
                  eq(
                    enterpriseRunnerEvents.workspaceId,
                    eventScope.workspaceId,
                  ),
                  eq(
                    enterpriseRunnerEvents.principalId,
                    eventScope.principalId,
                  ),
                  eq(enterpriseRunnerEvents.threadId, threadId),
                  sql`${enterpriseRunnerEvents.seq} > ${afterSeq}`,
                ),
              )
              .orderBy(asc(enterpriseRunnerEvents.seq))
              .limit(limit);
            return rows.map(recordOf);
          },
        } as RunnerEventTransaction),
      ),
  };
}

export function createRunnerEventService(deps: {
  readonly repository: RunnerEventRepository;
  readonly pollMilliseconds?: number;
}) {
  const pollMilliseconds = deps.pollMilliseconds ?? 200;
  if (
    !Number.isSafeInteger(pollMilliseconds) ||
    pollMilliseconds < 10 ||
    pollMilliseconds > 5000
  ) {
    throw new RangeError("RUNNER_EVENT_POLL_INTERVAL_INVALID");
  }
  return {
    async append(
      scope: PlatformScope,
      proposal: RunnerEventProposal,
    ): Promise<EventAck> {
      assertTrustedScope(scope);
      // Shape guards first: a malformed proposal must fail with the domain
      // error, not an uncontrolled TypeError (OCR R10).
      if (
        !proposal?.lease ||
        typeof proposal.lease.ownerToken !== "string" ||
        !proposal.lease.ownerToken.trim() ||
        typeof proposal.sourceEventId !== "string" ||
        !proposal.sourceEventId.trim() ||
        proposal.sourceEventId.length > 200 ||
        proposal.schemaVersion !== 1
      ) {
        throw new Error("RUNNER_EVENT_INVALID");
      }
      canonicalizeRunnerEvent(proposal.event);
      const stored = await deps.repository.transaction(scope, async (tx) => {
        await tx.lockRunAndAttempt(scope, proposal.lease);
        await tx.lockSourceIdentity(
          scope,
          proposal.lease,
          proposal.sourceEventId,
        );
        const run = await tx.findActiveRun(scope, proposal.lease);
        if (!run) throw new Error("RUN_ATTEMPT_STALE");
        const existing = await tx.findBySourceIdentity(
          scope,
          proposal.lease,
          proposal.sourceEventId,
        );
        if (existing) {
          if (
            canonicalizeRunnerEvent(existing.event) !==
            canonicalizeRunnerEvent(proposal.event)
          ) {
            throw new Error("RUNNER_EVENT_IDENTITY_CONFLICT");
          }
          return { record: existing, duplicate: true };
        }
        await tx.lockThreadCursor(scope, run.threadId);
        const seq = await tx.nextThreadCursor(scope, run.threadId);
        return {
          record: await tx.insert(scope, proposal, run.threadId, seq),
          duplicate: false,
        };
      });
      return {
        eventId: stored.record.eventId,
        seq: stored.record.seq,
        duplicate: stored.duplicate,
      };
    },
    async replay(
      scope: PlatformScope,
      input: { threadId: string; afterSeq: number; limit?: number },
    ): Promise<EventPage> {
      assertTrustedScope(scope);
      if (!input) throw new Error("RUNNER_EVENT_CURSOR_INVALID");
      const { threadId, afterSeq } = input;
      const limit = input.limit ?? 100;
      if (
        typeof threadId !== "string" ||
        !threadId.trim() ||
        threadId.length > 200 ||
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500
      ) {
        throw new Error("RUNNER_EVENT_CURSOR_INVALID");
      }
      const rows = await deps.repository.transaction(scope, (tx) =>
        tx.replay(scope, threadId, afterSeq, limit + 1),
      );
      const items = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        items,
        nextCursor:
          hasMore && items.length
            ? {
                threadId,
                afterSeq: items[items.length - 1]?.seq ?? afterSeq,
                limit,
              }
            : null,
      };
    },
    async *subscribe(
      scope: PlatformScope,
      cursor: { threadId: string; afterSeq: number; limit?: number },
      signal: AbortSignal,
    ): AsyncIterable<RunnerEventRecord> {
      let afterSeq = cursor.afterSeq;
      while (!signal?.aborted) {
        const page = await this.replay(scope, { ...cursor, afterSeq });
        if (page.items.length) {
          for (const row of page.items) {
            if (signal?.aborted) return;
            afterSeq = row.seq;
            yield row;
          }
          continue;
        }
        await waitForPoll(pollMilliseconds, signal);
      }
    },
  };
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
