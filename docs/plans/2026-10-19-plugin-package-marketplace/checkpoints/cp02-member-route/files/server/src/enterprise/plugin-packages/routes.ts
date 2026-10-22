import type { Context } from "hono";
import { Hono } from "hono";
import {
  type PackageErrorCode,
  PackageIdempotencyKeySchema,
  type PackageListQuery,
  PackageListQuerySchema,
  PackagePlanInputSchema,
} from "../../../../shared/enterprise/plugin-package-contracts";
import type { PackageCatalogue } from "../../plugin-packages/catalogue";
import type { PlatformScope } from "../contracts";
import type { CompanyAdminContext } from "../tenancy/workspace-admin";
import type { PackageService } from "./contracts";
import { isPackageStorageFailure, packageErrorCodeOf } from "./contracts";

/**
 * Enterprise plugin-package surface.
 *
 * PKG01's read-only catalogue plus PKG02's install preview/confirm:
 *
 *   GET  /                            catalogue + the trusted scope's install
 *   GET  /catalogue/:publisher/:name  catalogue detail
 *   GET  /installs/:id                redacted install detail
 *   POST /plans                       10-minute install preview (company admin)
 *   POST /plans/:id/apply             confirm with Idempotency-Key (company admin)
 *
 * Every request first establishes a trusted PlatformScope from the signed-in
 * identity plus the tenant/workspace selection headers. Management writes
 * additionally require a verified CompanyAdminContext (`tenant_admin`); a
 * platform administrator without a company membership never gains company
 * authority here — the authorizer answers 403.
 *
 * A deployment whose catalogue failed to load, or whose restricted operator
 * channel could not be verified, answers 503 on the affected paths — never an
 * empty success page and never a permissive write. Unknown and cross-scope
 * install/plan ids answer one identical 404.
 */

const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUERY_KEYS = new Set(["search", "category", "cursor", "limit"]);
/** Spec §7: HTTP JSON bodies are capped at 128 KiB. */
const MAX_BODY_BYTES = 128 * 1024;

export interface PluginPackageRoutesDeps {
  /** Null when the catalogue could not be assembled at startup. */
  catalogue: PackageCatalogue | null;
  resolveScope(request: Request): Promise<PlatformScope>;
  /**
   * PKG02 install service. Absent when enterprise capabilities or the verified
   * operator channel are unavailable: reads fall back to the catalogue,
   * install/plan paths answer 503.
   */
  service?: PackageService | null;
  /** Issues a trusted CompanyAdminContext for plan/apply. */
  resolveAdmin?(request: Request): Promise<CompanyAdminContext>;
}

const ERROR_STATUS: Record<
  PackageErrorCode,
  400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 503
> = {
  AUTH_REQUIRED: 401,
  SCOPE_REQUIRED: 400,
  INPUT_INVALID: 400,
  TENANT_FORBIDDEN: 403,
  TENANT_ADMIN_REQUIRED: 403,
  RESOURCE_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  PLAN_CHANGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PLAN_EXPIRED: 410,
  PACKAGE_UNSUPPORTED: 422,
  PACKAGE_STORAGE_UNAVAILABLE: 503,
  ADMIN_CHANNEL_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const ERROR_MESSAGE: Record<PackageErrorCode, string> = {
  AUTH_REQUIRED: "Authentication required.",
  SCOPE_REQUIRED: "Tenant and workspace selection required.",
  INPUT_INVALID: "The request is not valid.",
  TENANT_FORBIDDEN: "This account is not a member of the selected team.",
  TENANT_ADMIN_REQUIRED: "Company administrator rights are required.",
  RESOURCE_NOT_FOUND: "Package resource not found.",
  REVISION_CONFLICT: "The package is already installed at another revision.",
  PLAN_CHANGED: "The package plan no longer matches the published release.",
  IDEMPOTENCY_CONFLICT:
    "This idempotency key was already used for a different request.",
  PLAN_EXPIRED: "The package plan has expired.",
  PACKAGE_UNSUPPORTED: "This package operation is not supported.",
  PACKAGE_STORAGE_UNAVAILABLE: "Package storage is unavailable.",
  ADMIN_CHANNEL_UNAVAILABLE: "Package administration is unavailable.",
  INTERNAL: "Package request failed.",
};

/** Closed mapping; unknown failures are INTERNAL, never an echoed message. */
function errorCodeFor(error: unknown): PackageErrorCode {
  const packageCode = packageErrorCodeOf(error);
  if (packageCode) return packageCode;
  // A driver/SQLSTATE failure is storage, not a bug in the request: 503 with
  // the same closed body as a missing catalogue, never a 500 that reads like
  // a product defect. Integrity/permission SQLSTATEs are excluded by the
  // classifier, so a real policy verdict is still `INTERNAL`.
  if (isPackageStorageFailure(error)) return "PACKAGE_STORAGE_UNAVAILABLE";
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "TENANT_REQUIRED":
    case "WORKSPACE_REQUIRED":
      return "SCOPE_REQUIRED";
    case "TENANT_FORBIDDEN":
    case "WORKSPACE_FORBIDDEN":
    case "UNVERIFIED_SCOPE":
    case "UNVERIFIED_ADMIN_CONTEXT":
    case "SCOPE_REVOKED":
    case "WORKSPACE_REVOKED":
      return "TENANT_FORBIDDEN";
    case "TENANT_ADMIN_REQUIRED":
      return "TENANT_ADMIN_REQUIRED";
    case "INPUT_INVALID":
      return "INPUT_INVALID";
    case "RESOURCE_NOT_FOUND":
      return "RESOURCE_NOT_FOUND";
    case "PACKAGE_STORAGE_UNAVAILABLE":
      return "PACKAGE_STORAGE_UNAVAILABLE";
    case "ADMIN_CHANNEL_UNAVAILABLE":
      return "ADMIN_CHANNEL_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}

function respondError(context: Context, error: unknown) {
  const code = errorCodeFor(error);
  const status = ERROR_STATUS[code];
  return context.json(
    { error: { code, message: ERROR_MESSAGE[code] } },
    status,
  );
}

function unavailable(
  context: Context,
  code: PackageErrorCode = "PACKAGE_STORAGE_UNAVAILABLE",
) {
  return context.json({ error: { code, message: ERROR_MESSAGE[code] } }, 503);
}

/**
 * Strict list-query parsing. Unknown keys are refused rather than ignored, and
 * the one rule set the wire contract declares (`PackageListQuerySchema`) decides
 * every remaining bound — the only coercion is the numeric `limit`.
 */
function parseListQuery(raw: Record<string, string>): PackageListQuery {
  for (const key of Object.keys(raw)) {
    if (!QUERY_KEYS.has(key)) throw new Error("INPUT_INVALID");
  }
  if (raw.category !== undefined && !PACKAGE_ID_PATTERN.test(raw.category)) {
    throw new Error("INPUT_INVALID");
  }
  const candidate: Record<string, unknown> = { ...raw };
  if (raw.limit !== undefined) {
    if (!/^[0-9]+$/.test(raw.limit)) throw new Error("INPUT_INVALID");
    candidate.limit = Number(raw.limit);
  }
  const parsed = PackageListQuerySchema.safeParse(candidate);
  if (!parsed.success) throw new Error("INPUT_INVALID");
  return parsed.data;
}

/** Bounded JSON body: never echoes the body, never accepts a secret field. */
async function parseJsonBody(context: Context): Promise<unknown> {
  const contentLength = context.req.header("content-length");
  if (contentLength !== undefined) {
    if (!/^[0-9]+$/.test(contentLength)) throw new Error("INPUT_INVALID");
    if (Number(contentLength) > MAX_BODY_BYTES)
      throw new Error("INPUT_INVALID");
  }
  const text = await context.req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("INPUT_INVALID");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INPUT_INVALID");
  }
}

export function createPluginPackageRoutes(deps: PluginPackageRoutesDeps): Hono {
  const routes = new Hono();

  const requireService = (): PackageService => {
    if (!deps.service) throw new Error("ADMIN_CHANNEL_UNAVAILABLE");
    return deps.service;
  };

  const resolveAdmin = async (
    request: Request,
  ): Promise<CompanyAdminContext> => {
    if (!deps.resolveAdmin) throw new Error("ADMIN_CHANNEL_UNAVAILABLE");
    return deps.resolveAdmin(request);
  };

  routes.get("/", async (context) => {
    if (!deps.catalogue) return unavailable(context);
    try {
      const scope = await deps.resolveScope(context.req.raw);
      const query = parseListQuery(context.req.query());
      if (deps.service) {
        return context.json(await deps.service.list(scope, query));
      }
      return context.json(await deps.catalogue.list(scope, query));
    } catch (error) {
      return respondError(context, error);
    }
  });

  routes.get("/catalogue/:publisher/:name", async (context) => {
    if (!deps.catalogue) return unavailable(context);
    try {
      const scope = await deps.resolveScope(context.req.raw);
      const publisher = context.req.param("publisher");
      const name = context.req.param("name");
      if (
        !PACKAGE_ID_PATTERN.test(publisher) ||
        !PACKAGE_ID_PATTERN.test(name)
      ) {
        throw new Error("RESOURCE_NOT_FOUND");
      }
      return context.json(await deps.catalogue.get(scope, publisher, name));
    } catch (error) {
      return respondError(context, error);
    }
  });

  routes.get("/installs/:id", async (context) => {
    if (!deps.catalogue) return unavailable(context);
    try {
      const scope = await deps.resolveScope(context.req.raw);
      return context.json(
        await requireService().get(scope, context.req.param("id")),
      );
    } catch (error) {
      return respondError(context, error);
    }
  });

  routes.post("/plans", async (context) => {
    if (!deps.catalogue) return unavailable(context);
    try {
      const scope = await deps.resolveScope(context.req.raw);
      const body = await parseJsonBody(context);
      const parsed = PackagePlanInputSchema.safeParse(body);
      if (!parsed.success) throw new Error("INPUT_INVALID");
      const admin = await resolveAdmin(context.req.raw);
      return context.json(
        await requireService().plan(scope, admin, parsed.data),
      );
    } catch (error) {
      return respondError(context, error);
    }
  });

  routes.post("/plans/:id/apply", async (context) => {
    if (!deps.catalogue) return unavailable(context);
    try {
      const scope = await deps.resolveScope(context.req.raw);
      const idempotency = PackageIdempotencyKeySchema.safeParse(
        context.req.header("idempotency-key"),
      );
      if (!idempotency.success) throw new Error("INPUT_INVALID");
      const admin = await resolveAdmin(context.req.raw);
      const result = await requireService().apply(
        scope,
        admin,
        context.req.param("id"),
        idempotency.data,
      );
      // First apply → 201; replay (same or new key) → 200.
      return context.json(result.install, result.created ? 201 : 200);
    } catch (error) {
      return respondError(context, error);
    }
  });

  return routes;
}

/** Mounted when enterprise capabilities (and therefore the catalogue) are absent. */
export function createUnavailablePluginPackageRoutes(): Hono {
  const routes = new Hono();
  routes.all("*", (context) => unavailable(context));
  return routes;
}
