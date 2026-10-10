/**
 * The workshop's HTTP surface: /api/workshop/:channelId/**.
 *
 * `canUseBot` is required, not optional — the same reason the computer and codesandbox routes
 * demand it: mounting the workshop without answering "who may act as this Bot" is the one
 * wiring mistake that must not compile.
 *
 * This file starts as the SSE endpoint's home (B9); B6 fills in the full REST surface around
 * it. The events route resolves the channel's session, its active turn, and hands the
 * response builder the stream's two sources: the store (replay) and the bus (live).
 */
import { Hono, type MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import type { TurnEventBus } from "./bus";
import { streamEventsResponse } from "./events";
import type { WorkshopStore } from "./store";

export type WorkshopRoutesFactory = (options: {
  store: WorkshopStore;
  bus: TurnEventBus;
}) => Hono<{ Variables: AppVariables }>;

export function createWorkshopRoutes(input: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  store: WorkshopStore;
  bus: TurnEventBus;
}): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", input.requireUser);

  app.get("/:channelId/events", async (context) => {
    const actor = context.var.actor;
    const channelId = context.req.param("channelId");
    const session = await input.store
      .sessionByChannel(channelId)
      .catch(() => undefined);
    if (!session)
      return context.json({ error: "No workshop session for this channel." }, 404);
    if (!(await input.canUseBot(actor, session.botId)))
      return context.json({ error: "You may not watch this Bot's workshop." }, 403);

    // The turn to follow: the session's newest, whatever its state — a finished turn replays
    // its whole history, which is what a refreshed tab wants.
    const turns = await input.store.listTurns(session.id);
    const turnIds = turns.slice(-1).map((turn) => turn.id);
    if (turnIds.length === 0)
      return context.json({ error: "This session has no turns yet." }, 404);

    const lastEventIdHeader = context.req.header("last-event-id");
    const lastEventId = lastEventIdHeader
      ? Number.parseInt(lastEventIdHeader, 10)
      : undefined;

    return streamEventsResponse({
      bus: input.bus,
      store: input.store,
      turnIds,
      ...(Number.isFinite(lastEventId) ? { lastEventId } : {}),
      // request.signal fires when the client detaches; the response builder stops everything.
      stopSignal: context.req.raw.signal,
    });
  });

  return app;
}
