import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../../auth/guards";
import {
  type CorsairEventOperations,
  eventSource,
  replayDecision,
} from "./event-operations";

const text = z.string().trim().min(1).max(256);
const evidence = eventSource.extend({
  eventKeys: z.array(text).min(1).max(1000),
  triggerPairs: z
    .array(z.object({ legacy: text, corsair: text }))
    .min(1)
    .max(1000),
  providerHistoryRef: text,
});
const replay = eventSource.extend({
  receiptId: text,
  triggerId: text,
  historyRef: text,
  decision: replayDecision.optional(),
});
const incident = eventSource.extend({ historyRef: text });

export function createCorsairEventOperationRoutes(
  operations: CorsairEventOperations,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  for (const path of ["/receipts", "/handoff", "/replay", "/incidents"]) {
    routes.use(path, requireUser, async (context, next) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      await next();
    });
  }
  routes.get("/receipts", async (context) => {
    const key = eventSource.safeParse(context.req.query());
    if (!key.success)
      return context.json({ error: "Invalid event source." }, 400);
    return context.json(await operations.report(key.data));
  });
  routes.post("/handoff", async (context) => {
    const input = evidence.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!input.success)
      return context.json({ error: "Invalid reconciliation evidence." }, 400);
    const cutoff = await operations.handoff(
      input.data,
      context.var.actor.id,
      input.data,
    );
    return cutoff
      ? context.json({ cutoff })
      : context.json({ error: "Source evidence does not reconcile." }, 409);
  });
  routes.post("/replay", async (context) => {
    const input = replay.safeParse(await context.req.json().catch(() => null));
    if (!input.success)
      return context.json({ error: "Invalid replay evidence." }, 400);
    return (await operations.replay(
      input.data,
      context.var.actor.id,
      input.data,
    ))
      ? context.json({ accepted: true }, 202)
      : context.json({ error: "Dispatch cannot be replayed." }, 409);
  });
  routes.get("/incidents", async (context) => {
    const key = eventSource.safeParse(context.req.query());
    if (!key.success)
      return context.json({ error: "Invalid event source." }, 400);
    return context.json(await operations.incidents(key.data));
  });
  routes.post("/incidents", async (context) => {
    const input = incident.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!input.success)
      return context.json({ error: "Invalid history reference." }, 400);
    const id = await operations.incident(
      input.data,
      context.var.actor.id,
      input.data.historyRef,
    );
    return context.json({ id }, 201);
  });
  return routes;
}
