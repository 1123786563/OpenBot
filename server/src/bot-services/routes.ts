/**
 * `/api/admin/bot-services`: the registration screen behind Admin (bifrost-5, 04.1 / #234).
 *
 * Every write is administrator-only and lands on the audit trail with who made it; every read is
 * administrator-only too, because the registry is a deployment-level fact, not a person's view of
 * their own authorizations (that is 04.7's screen). The store refuses with a status and a sentence,
 * and this layer only carries both to the wire — it invents no semantics of its own.
 *
 * Mounted only where the assembly built the store, so a deployment that has no registry has no door
 * for one, the same shape every other optional admin surface here takes.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  BotServiceRefusedError,
  type BotServiceStore,
} from "./store";

export function createBotServiceAdminRoutes({
  requireUser,
  store,
}: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  store: BotServiceStore;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  const deniedFor = (context: Parameters<typeof requireAdmin>[0]) =>
    requireAdmin(context);

  routes.get("/", async (context) => {
    const denied = deniedFor(context);
    if (denied) return denied;
    return context.json({ botServices: await store.listBotServices() });
  });

  routes.get("/:botId", async (context) => {
    const denied = deniedFor(context);
    if (denied) return denied;
    const record = await store.getBotService(context.req.param("botId"));
    if (!record) {
      return context.json(
        {
          error: `No Bot service is registered with botId "${context.req.param("botId")}".`,
        },
        404,
      );
    }
    return context.json({ botService: record });
  });

  routes.post("/", async (context) => {
    const denied = deniedFor(context);
    if (denied) return denied;
    return write(context, 201, async () =>
      store.register(await readJson(context), {
        userId: context.var.actor.id,
      }),
    );
  });

  routes.post("/:botId", async (context) => {
    const denied = deniedFor(context);
    if (denied) return denied;
    const body = await readJson(context);
    return write(context, 200, () =>
      store.edit(
        { ...body, botId: context.req.param("botId") },
        { userId: context.var.actor.id },
      ),
    );
  });

  routes.post("/:botId/disable", async (context) => {
    const denied = deniedFor(context);
    if (denied) return denied;
    return write(context, 200, () =>
      store.disable(context.req.param("botId"), {
        userId: context.var.actor.id,
      }),
    );
  });

  return routes;
}

async function readJson(
  context: Parameters<typeof requireAdmin>[0],
): Promise<Record<string, unknown>> {
  try {
    const parsed = await context.req.raw.clone().json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function write(
  context: Parameters<typeof requireAdmin>[0],
  status: 200 | 201,
  run: () => Promise<Record<string, unknown>>,
) {
  try {
    const record = await run();
    return context.json({ botService: record }, status);
  } catch (error) {
    if (error instanceof BotServiceRefusedError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
}
