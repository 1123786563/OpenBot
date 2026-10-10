/**
 * The enterprise application assembly, per plan 02 §6 T3-A.
 *
 * Everything a request can reach on the shared enterprise entry lives behind this assembly: a
 * redacting onError (server-generated request_id, stable code, no raw error text — the caller
 * never sees the database's words), no-store/nosniff on every response, draining that spares only
 * /health/*, an auth allowlist keyed by EXACT `METHOD pathname` (operators enumerate verified
 * login/callback endpoints — never a prefix, never a wildcard), and the tenant API: session →
 * tenant chooser → per-request scope → the mounted tenant routes.
 *
 * The enterprise user guard is deliberately NOT the deployment `createRequireUser` (guards.ts):
 * that guard consults the deployment-wide role repository, while enterprise tenancy knows only
 * memberships. A deployment admin gets exactly their own memberships here.
 */
import { Hono } from "hono";
import type { AuthService } from "../auth/guards";
import type { Authz, Directory, ResourceReader, Scope } from "./contracts";
import { mountConversationsRoutes } from "./conversations/routes";
import { EnterpriseError } from "./errors";
import { mountTenantRoutes } from "./tenancy/routes";
import { resolveScope } from "./tenancy/scope";

export type EnterpriseDependencies = {
  auth: AuthService;
  directory: Directory;
  resources: ResourceReader;
  authz: Authz;
  allowedOrigins: ReadonlySet<string>;
  logRedactedSecurityError: (event: {
    requestId: string;
    status: number;
    code: string;
  }) => void;
  /** Exact `METHOD pathname` entries for operator-verified auth endpoints only. */
  authRoutes: ReadonlySet<string>;
  isDraining: () => boolean;
  ready: () => Promise<boolean>;
};

export type EnterpriseVariables = { userId: string; scope: Scope };

/*
 * Identified driver error codes, per plan 02 §4.3: adapters map ALREADY IDENTIFIED driver codes
 * onto EnterpriseError — this is never a message regex. Both codes below are the Bun SQL
 * connection failures observed in this repo's environment (refused dial, closed pool); anything
 * else stays an unknown error and fails closed as INTERNAL_ERROR/500.
 */
const DATABASE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_CLOSED",
]);

function asEnterpriseError(error: unknown): EnterpriseError {
  if (error instanceof EnterpriseError) {
    return error;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && DATABASE_UNAVAILABLE_CODES.has(code)) {
    return new EnterpriseError("DATABASE_UNAVAILABLE", 503);
  }
  return new EnterpriseError("INTERNAL_ERROR", 500);
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createEnterpriseApp(deps: EnterpriseDependencies) {
  const app = new Hono<{ Variables: EnterpriseVariables }>();

  app.onError((error, c) => {
    const requestId = crypto.randomUUID();
    c.header("x-request-id", requestId);
    const known = asEnterpriseError(error);
    const status = known.status;
    const code = known.code;
    deps.logRedactedSecurityError({ requestId, status, code });
    return c.json(
      {
        error: {
          code,
          request_id: requestId,
          retryable: false,
          summary: status >= 500 ? "服务暂不可用" : "请求未获允许",
        },
      },
      status,
    );
  });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (deps.isDraining() && !c.req.path.startsWith("/health/")) {
      throw new EnterpriseError("SERVICE_DRAINING", 503);
    }
    await next();
  });

  app.get("/health/live", (c) => c.json({ status: "live" }));
  app.get("/health/ready", async (c) => {
    const ready = await deps.ready();
    return c.json(
      { status: ready ? "ready" : "unavailable" },
      ready ? 200 : 503,
    );
  });

  app.all("/api/auth/*", async (c) => {
    const key = `${c.req.method} ${c.req.path}`;
    if (!deps.authRoutes.has(key)) {
      return c.notFound();
    }
    return deps.auth.handler(c.req.raw);
  });

  const api = new Hono<{ Variables: EnterpriseVariables }>();
  api.use("*", async (c, next) => {
    if (!READ_ONLY_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (!origin || !deps.allowedOrigins.has(origin)) {
        throw new EnterpriseError("ORIGIN_DENIED", 403);
      }
      if (!c.req.header("content-type")?.startsWith("application/json")) {
        throw new EnterpriseError("JSON_REQUIRED", 400);
      }
    }
    const session = await deps.auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
    if (!session?.user.id || session.user.id === "dev-local-user") {
      throw new EnterpriseError("AUTH_REQUIRED", 401);
    }
    c.set("userId", session.user.id);
    await next();
  });

  /* The chooser runs BEFORE the scope middleware: picking the first tenant cannot require one. */
  api.get("/tenants", async (c) => {
    const rows = await deps.directory.listForUser(c.var.userId);
    return c.json({
      items: rows
        .filter(
          (row) =>
            row.tenantStatus === "active" &&
            row.principalStatus === "active" &&
            row.memberStatus === "active",
        )
        .map((row) => ({
          id: row.tenantId,
          name: row.tenantName,
          role: row.role,
        })),
    });
  });

  api.use("*", async (c, next) => {
    c.set(
      "scope",
      await resolveScope(
        deps.directory,
        c.var.userId,
        c.req.header("x-openbot-tenant"),
      ),
    );
    await next();
  });

  mountTenantRoutes(api, deps);
  mountConversationsRoutes(api, deps);
  app.route("/api/enterprise/v1", api);
  return app;
}
