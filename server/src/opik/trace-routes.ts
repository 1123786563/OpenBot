import { asc, gt } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { opikRuns } from "../db/schema";
import { opikTraceId } from "./delivery";

type Env = { Variables: AppVariables };
const PAGE_SIZE = 100;
const traceCursor = z.uuid().optional();

export function createOpikTraceRoutes({
  database,
  requireUser,
  operators,
}: {
  database: Database;
  requireUser: MiddlewareHandler<Env>;
  operators?: ReadonlySet<string>;
}) {
  return new Hono<Env>().get(
    "/",
    async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    },
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      if (!operators?.has(context.var.actor.id))
        return context.json({ error: "Trace operator access required." }, 403);

      const cursor = traceCursor.safeParse(context.req.query("after"));
      if (!cursor.success)
        return context.json({ error: "Invalid trace cursor." }, 400);

      const rows = await database
        .select({
          id: opikRuns.id,
          trace: opikRuns.trace,
          status: opikRuns.status,
          startedAt: opikRuns.startedAt,
          finishedAt: opikRuns.finishedAt,
          score: opikRuns.score,
          feedbackDeliveredAt: opikRuns.feedbackDeliveredAt,
        })
        .from(opikRuns)
        .where(cursor.data ? gt(opikRuns.id, cursor.data) : undefined)
        .orderBy(asc(opikRuns.id))
        .limit(PAGE_SIZE + 1);

      const traces = rows.slice(0, PAGE_SIZE).map((run) => {
        const state =
          run.trace === "delivered"
            ? "complete"
            : run.trace === "dropped" && run.feedbackDeliveredAt
              ? "incomplete"
              : run.trace;
        return {
          recordId: run.id,
          traceId:
            state === "complete" || state === "incomplete"
              ? opikTraceId(run)
              : null,
          state,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: Math.max(
            0,
            run.finishedAt.getTime() - run.startedAt.getTime(),
          ),
          score: run.feedbackDeliveredAt ? run.score : null,
        };
      });
      return context.json({
        traces,
        next: rows.length > PAGE_SIZE ? traces.at(-1)?.recordId : undefined,
      });
    },
  );
}
