/**
 * The tenant-scoped routes, per plan 02 §6 T3-A step 4.
 *
 * Mounted only after the scope middleware, so `c.var.scope` is a scope this process issued for
 * THIS request — rebuilt from the live directory every time, never a cached client credential.
 *
 * MVP publishes exactly two reads and no enumeration: `/scope` is the just-verified member view
 * (not a bearer token for anything later), and `/resources/:id` returns the bare ResourceView
 * metadata. No resource counts, no listings — document bodies get their own authorization in
 * booklet 05.
 */
import type { Hono } from "hono";
import type { EnterpriseDependencies, EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";

/** Same shape the tenant selector and every enterprise id allows: URL-safe, non-empty, bounded. */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function mountTenantRoutes(
  app: Hono<{ Variables: EnterpriseVariables }>,
  deps: EnterpriseDependencies,
): void {
  app.get("/scope", (c) =>
    c.json({
      tenantId: c.var.scope.tenantId,
      principalId: c.var.scope.principalId,
      role: c.var.scope.role,
    }),
  );
  app.get("/resources/:id", async (c) => {
    const scope = c.var.scope;
    const id = c.req.param("id");
    if (!RESOURCE_ID_PATTERN.test(id)) {
      throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
    }
    const view = await deps.resources.readAuthorizedResource(scope, id);
    return c.json(view);
  });
}
