/**
 * `/api/admin/gateway/credential`: the administrator's write-and-status surface for the Bifrost
 * gateway's admin credential (Bifrost 01.2, #208).
 *
 * WRITE-ONLY BY CONSTRUCTION. A PUT stores or rotates the key and answers the redacted status; a
 * GET answers the same status for an unconfigured deployment too — "unconfigured", never a
 * failure shaped like a configuration. There is deliberately no route that returns the key: the
 * only decryption path is the service's `resolveGatewayAdminCredential`, which lives on the
 * service for server-side trusted code (01.5's probe, 07.x's admission extension) and is not
 * mounted here. Cache headers are `no-store`: a status that names which key is current must not
 * outlive the request that asked.
 *
 * Both routes are administrator-only, and the service re-checks the writer's role against the
 * same `user_roles` table — the route check guards the surface, the service check guards the
 * seam. Absent service (a test or a deployment that never wired the gateway) answers a tagged
 * 503, the way the bot service registry's routes do.
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  type GatewayAdminCredentialService,
  validateGatewayAdminCredentialInput,
} from "./admin-credential";

export function gatewayAdminCredentialRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  service: GatewayAdminCredentialService | undefined,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  if (!service) {
    app.all("*", (context) =>
      context.json(
        {
          error: "The gateway admin credential is not available.",
          code: "gateway_admin_credential_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  app.get("/", async (context) =>
    context.json({ status: await service.readGatewayAdminCredential() }),
  );

  app.put("/", async (context) => {
    const input = validateGatewayAdminCredentialInput(
      await context.req.json().catch(() => null),
    );
    if (!input.ok) {
      return badRequest(context, input.error);
    }
    const result = await service.saveGatewayAdminCredential(
      { adminKey: input.adminKey },
      {
        userId: context.var.actor.id,
        email: context.var.actor.email,
      },
    );
    if (!result.ok) {
      return context.json({ error: result.error }, result.status);
    }
    return context.json({ status: result.status });
  });

  return app;
}

function badRequest(
  context: Context<{ Variables: AppVariables }>,
  error: string,
) {
  return context.json({ error }, 400);
}
