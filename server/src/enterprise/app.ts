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
import { getLogger } from "../../../shared/logger";
import type { AuthService } from "../auth/guards";
import type { Database } from "../db/client";
import {
  createRequestTracking,
  currentRequestId,
} from "../telemetry/request-tracking";
import type { Authz, Directory, ResourceReader, Scope } from "./contracts";
import type { MessageSeams } from "./conversations/messages";
import { mountConversationsRoutes } from "./conversations/routes";
import { EnterpriseError } from "./errors";
import type { RunServices } from "./runs/contracts";
import { type GatewayDeps, mountRunGateway } from "./runs/gateway";
import { mountRunRoutes } from "./runs/routes";
import type { ToolPlaneRoutes } from "./runtime/tool-plane";
import {
  createRuntimeInvocationValidationRoutes,
  type InvocationValidationDeps,
} from "./runtime/validation-routes";
import { mountTenantRoutes } from "./tenancy/routes";
import { resolveScope } from "./tenancy/scope";

export type EnterpriseDependencies = {
  auth: AuthService;
  directory: Directory;
  resources: ResourceReader;
  authz: Authz;
  /**
   * The conversations domain's own data-plane pool, opened by the bootstrap (so drain closes it
   * with every other pool) and validated through EnterpriseConfig's data URL — never a pool a
   * route mount opens from `process.env` on its own.
   */
  conversationsDatabase: Database;
  /**
   * The C07 message domain's own single-writer pool (ob_ent_run_writer): the
   * run/outbox/budget grants and RLS policies (0060 §5a) and the message table
   * (0063) live on that role, so the message+Run+Outbox transaction commits on
   * ONE connection. Absent → the message endpoints answer an explicit 503
   * (MESSAGES_DISABLED), never a registered empty success.
   */
  messagesDatabase?: Database;
  /**
   * The C07 Run/budget in-transaction seam: the frozen `RunService.create`
   * signature is scope-level and self-managed, so until the 03 volume ships an
   * inTx variant the assembly injects this narrow port — the seam the message
   * transaction calls to bind the business Run inside its own transaction.
   */
  messageSeams?: MessageSeams;
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
  /**
   * The Go runtime candidate, present only when the runtime block is configured. Mounting the
   * internal validation route is the first half; the tool plane and the run gateway join the same
   * object so one flag keeps the whole candidate disableable.
   */
  runtime?: {
    /** The real verify behind /internal/enterprise/v1/runtime/validate (runtime/verifier.ts). */
    verify: InvocationValidationDeps["verify"];
    /** The real tool plane's routes (runtime/tool-plane.ts), when governed tools are configured. */
    toolPlaneRoutes?: ToolPlaneRoutes;
    /** The run gateway's dependencies (runs/gateway.ts); mounted INSIDE the scoped api. */
    gateway?: GatewayDeps;
  };
  /**
   * The run ledger's public services (plan 03 §9.3), present only when the run feature is
   * explicitly enabled by the bootstrap. Present → POST /runs + GET /runs/:id mount inside the
   * scope middleware. Absent → the 02 read-only entry stays exactly as it was, and creation is
   * an explicit 503 (RUNS_DISABLED) — never a registered empty success.
   */
  runServices?: RunServices;
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

  const tracking = createRequestTracking({ logger: getLogger("enterprise") });
  app.use("*", tracking.requestId);

  app.onError((error, c) => {
    // The middleware already minted and echoed the id for any request that reached it;
    // onError is the fallback for paths that somehow skipped it (and for the mounted
    // case the ambient store still holds the main app's id).
    const requestId = currentRequestId() ?? crypto.randomUUID();
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

  /*
   * The Go runtime's identity oracle: an internal service-to-service route under /internal — no
   * session, no origin check, its own two-credential authentication inside the route factory.
   * Mounted only when the runtime block is configured, so an unconfigured deployment keeps the
   * exact route surface it had before the candidate existed.
   */
  if (deps.runtime) {
    app.route(
      "/",
      createRuntimeInvocationValidationRoutes({ verify: deps.runtime.verify }),
    );
    if (deps.runtime.toolPlaneRoutes) {
      app.route("/", deps.runtime.toolPlaneRoutes);
    }
  }

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
  /*
   * POST /runs and GET /runs/:id have EXACTLY ONE owner on this api (review fix: mounting
   * both made the effective handler depend on Hono's registration order, silently
   * dead-routing the other). Ownership, plan 03 §9.2/§9.3: the ledger's public routes mount
   * when the run feature is explicitly enabled (runServices); the Go candidate gateway's
   * create+execute entry is the FALLBACK owner for candidate deployments without the ledger
   * service (its historical behavior preserved); with neither, both verbs answer an explicit
   * 503 so a disabled deployment can never masquerade creation as an empty success. The
   * gateway's internal validate/tool-plane routes above are unaffected either way.
   */
  if (deps.runServices) {
    mountRunRoutes(api, deps.runServices.runs);
  } else if (deps.runtime?.gateway) {
    mountRunGateway(api, deps.runtime.gateway);
  } else {
    const runsDisabled = (): never => {
      throw new EnterpriseError("RUNS_DISABLED", 503);
    };
    api.post("/runs", runsDisabled);
    api.get("/runs/:id", runsDisabled);
  }
  app.route("/api/enterprise/v1", api);
  return app;
}
