/**
 * The HTTP half of the gateway configuration (Bifrost ticket 01.1, #207).
 *
 * Shaped like the enterprise admin routes: one `requireUser` for everything, `requireAdmin` in
 * front of every write, and the same sentences the pure parse produces for a refused address.
 * Reads answer with the readonly {@link GatewayEndpointConfig} triple — never `updatedBy`, never
 * anything secret, because nothing secret is stored.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import {
  parseGatewayEndpointInput,
  readGatewayEndpoint,
  saveGatewayEndpoint,
} from "./config-store";

export function createGatewayConfigRoutes(options: {
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser);

  routes.get("/endpoint", async (context) => {
    return context.json({ gateway: (await readGatewayEndpoint(options.database)) ?? null });
  });

  routes.put("/endpoint", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const raw = (await context.req.json().catch(() => null)) as {
      baseUrl?: unknown;
      requestTimeoutMs?: unknown;
    } | null;
    const parsed = parseGatewayEndpointInput(raw ?? {});
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const saved = await saveGatewayEndpoint(
      options.database,
      parsed.value,
      context.var.actor.email,
    );
    return context.json({ gateway: saved });
  });

  return routes;
}
