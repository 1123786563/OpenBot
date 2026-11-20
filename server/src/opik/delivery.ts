import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { opikRuns } from "../db/schema";
import {
  createOpikClient,
  OPIK_REQUEST_TIMEOUT_MS,
  type OpikConfig,
} from "./client";

// Opik expects a UUIDv7. Use the Run's finished time and a persisted, server-generated
// random ID, with separate IDs for ordinary traces and incomplete recovery records.
function traceId(run: typeof opikRuns.$inferSelect) {
  const time = run.finishedAt.getTime().toString(16).padStart(12, "0");
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${run.id}:${run.trace === "dropped"}`)
    .digest("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hash.slice(0, 3)}-8${hash.slice(3, 6)}-${hash.slice(6, 18)}`;
}

const availableAt = (now: Date) =>
  or(isNull(opikRuns.leaseUntil), lte(opikRuns.leaseUntil, now));
const pendingScore = and(
  isNotNull(opikRuns.score),
  isNull(opikRuns.feedbackDeliveredAt),
);
const pendingTrace = eq(opikRuns.trace, "pending");
const TRACE_RETRY_MS = 60 * 60_000;
// Incomplete feedback needs two sequential requests under the same lease.
const DELIVERY_LEASE_MS = 2 * OPIK_REQUEST_TIMEOUT_MS + 15_000;

export function createOpikDelivery(
  database: Database,
  config: OpikConfig,
  options: {
    now?: () => Date;
    onDropped?: (count: number) => void;
  } = {},
) {
  const opik = createOpikClient(config);
  const now = options.now ?? (() => new Date());
  const reportDropped =
    options.onDropped ??
    ((count) => {
      console.warn(JSON.stringify({ type: "opik_traces_dropped", count }));
    });

  async function drain() {
    const at = now();
    const cutoff = new Date(at.getTime() - TRACE_RETRY_MS);
    const dropped = await database
      .update(opikRuns)
      .set({ trace: "dropped", dueAt: at, leaseUntil: null, leaseId: null })
      .where(
        and(pendingTrace, lte(opikRuns.finishedAt, cutoff), availableAt(at)),
      )
      .returning({ id: opikRuns.id });
    if (dropped.length) reportDropped(dropped.length);

    for (let index = 0; index < 10; index++) {
      const at = now();
      const cutoff = new Date(at.getTime() - TRACE_RETRY_MS);
      const leaseId = crypto.randomUUID();
      const [run] = await database.transaction(async (transaction) => {
        const next = transaction
          .select({ id: opikRuns.id })
          .from(opikRuns)
          .where(
            and(
              lte(opikRuns.dueAt, at),
              availableAt(at),
              or(
                and(pendingTrace, gt(opikRuns.finishedAt, cutoff)),
                and(sql`${opikRuns.trace} <> 'pending'`, pendingScore),
              ),
            ),
          )
          .orderBy(asc(opikRuns.dueAt), asc(opikRuns.id))
          .limit(1)
          .for("update", { skipLocked: true });
        return transaction
          .update(opikRuns)
          .set({
            leaseId,
            leaseUntil: new Date(at.getTime() + DELIVERY_LEASE_MS),
          })
          .where(eq(opikRuns.id, next))
          .returning();
      });
      if (!run) break;
      const ownsLease = and(
        eq(opikRuns.id, run.id),
        eq(opikRuns.leaseId, leaseId),
      );
      const id = traceId(run);
      try {
        if (run.trace !== "delivered")
          await opik.trace({
            id,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            status: run.status,
            incomplete: run.trace === "dropped",
          });
        if (run.trace === "pending") {
          await database
            .update(opikRuns)
            .set({ trace: "delivered", leaseId: null, leaseUntil: null })
            .where(ownsLease);
        } else if (run.score !== null) {
          await opik.score({ traceId: id, score: run.score });
          await database
            .update(opikRuns)
            .set({
              feedbackDeliveredAt: now(),
              leaseId: null,
              leaseUntil: null,
            })
            .where(ownsLease);
        }
      } catch {
        await database
          .update(opikRuns)
          .set({
            dueAt: new Date(now().getTime() + 10_000),
            leaseId: null,
            leaseUntil: null,
          })
          .where(ownsLease);
      }
    }
  }

  function start() {
    let stopped = false;
    let active: Promise<void> | undefined;
    const tick = () => {
      if (stopped || active) return;
      active = drain()
        .catch(() => {
          console.warn(JSON.stringify({ type: "opik_delivery_sweep_failed" }));
        })
        .finally(() => {
          active = undefined;
        });
    };
    const timer = setInterval(tick, 2000);
    timer.unref();
    tick();
    return {
      async stop() {
        stopped = true;
        clearInterval(timer);
        await active;
      },
    };
  }

  return { drain, start };
}
