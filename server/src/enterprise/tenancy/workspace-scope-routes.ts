// server/src/enterprise/tenancy/workspace-scope-routes.ts
// MT006（Issue #49）：工作范围列出与团队管理的 HTTP 路由面。
//
//   GET    /                                   列出登录用户有资格的公司与团队
//   POST   /admin/teams                        公司管理员创建团队
//   POST   /admin/teams/:workspaceId/members   加入成员（停用行 → 重新激活）
//   POST   /admin/teams/:workspaceId/members/:principalId/suspend  停用成员
//   DELETE /admin/teams/:workspaceId/members/:principalId          移除成员
//
// 裁决 #1：x-openbot-tenant / x-openbot-workspace 只做选择；列出不读取任何
// 选择头（全新用户还没有可选择的范围），管理面只消费 x-openbot-tenant。
// 管理路由未装配 operator 通道时回答 503 unavailable（与 conversations 的
// unavailable 模式一致），绝不以宽松替身放行。

import { Hono } from "hono";
import { isCompanyAssuranceRefusal } from "../../auth/company-assurance";
import { isAuthorityRefusal } from "../../auth/directory/authority";
import { isDirectoryCommandRefusal } from "../../auth/directory/executor";
import { MEMBERSHIP_LIFECYCLE_PAUSED } from "../../auth/directory/membership";
import { isTeamMemberRefusal } from "../../auth/directory/team-extension";
import {
  assertClassifiedCompanyEntrance,
  WORKSPACE_SCOPE_MOUNT_PREFIX,
} from "./admin-separation";
import type { AuthenticatedRequestIdentity } from "./store";
import type {
  BaScopeSelectionService,
  CompanyAdminAuthorizer,
  WorkspaceAdminService,
  WorkspaceScopeLister,
} from "./workspace-admin";
import { isBaSelectionRefusal } from "./workspace-admin";

export interface WorkspaceScopeRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  lister: WorkspaceScopeLister;
  /** Absent (operator channel unwired) → admin routes answer 503. */
  admin?: {
    authorizer: CompanyAdminAuthorizer;
    service: WorkspaceAdminService;
  };
  /**
   * The company admin surface (MT095/MT096/MT097, Issues #138-#140): people, identity,
   * credentials, audit, enterprise config, learning and the company books, mounted at this
   * same entrance so the MT075 company-plane classification covers every path it adds.
   * Absent → that surface's routes are simply not mounted here (its own unavailable face
   * answers 503 where the assembly wires one).
   */
  companyAdmin?: Hono;
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

// MT075（Issue #118）：管理面分类守卫。每个管理路由在自己的处理半边
// 声明自己的清单 id 形态入口，并要求分类为公司面——分类规则表与路由
// 表漂移（改挂载点、新增管理路由而未登记）时入口 fail-closed 拒绝，
// 而不是静默按旧面放行。清单侧同一分类函数回写 MT001 摘要。
const requireClassifiedCompanyEntrance = (
  method: string,
  routePath: string,
): void => {
  assertClassifiedCompanyEntrance(
    method,
    `${WORKSPACE_SCOPE_MOUNT_PREFIX}${routePath}`,
  );
};

function errorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  // T04.08 (#552): the ba branch of the team-member entrances surfaces the
  // directory refusal family — the command envelope's own codes plus the
  // team-member handler's — with the refusal's own status, exactly the
  // projection company-admin-routes already applies; the paused authority
  // mode answers its one named 503, and a live authority failure projects
  // as the 503 it is. None of these may collapse into the 500 fall-through.
  if (isDirectoryCommandRefusal(error) || isTeamMemberRefusal(error)) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: "Request refused." } },
    };
  }
  if (isAuthorityRefusal(error)) {
    return {
      status: 503,
      body: { error: { code: error.code, message: "Request refused." } },
    };
  }
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  const mapped: Record<string, number> = {
    AUTH_REQUIRED: 401,
    TENANT_REQUIRED: 400,
    WORKSPACE_REQUIRED: 400,
    INVALID_REQUEST: 400,
    TENANT_FORBIDDEN: 403,
    TENANT_ADMIN_REQUIRED: 403,
    WORKSPACE_FORBIDDEN: 403,
    UNVERIFIED_SCOPE: 403,
    UNVERIFIED_ADMIN_CONTEXT: 403,
    WORKSPACE_NOT_FOUND: 404,
    TEAM_MEMBER_NOT_FOUND: 404,
    TEAM_MEMBER_NOT_COMPANY_MEMBER: 404,
    TEAM_ALREADY_EXISTS: 409,
    TEAM_MEMBER_ALREADY_EXISTS: 409,
    DATA_DATABASE_UNAVAILABLE: 503,
    WORKSPACE_ADMIN_UNAVAILABLE: 503,
    [MEMBERSHIP_LIFECYCLE_PAUSED]: 503,
    // MT075：管理面分类漂移是服务端装配错误，不是请求方的错。
    MANAGEMENT_ENTRANCE_UNCLASSIFIED: 500,
  };
  const status = mapped[code];
  if (status === undefined) {
    // No log here: server/src is noConsole-enforced and the codes above
    // cover every expected business failure. A request reaching this branch
    // is a bug the suite pins, not a runtime event to trace.
    return {
      status: 500,
      body: {
        error: { code: "internal", message: "Request failed." },
      },
    };
  }
  return {
    status,
    body: { error: { code, message: "Request refused." } },
  };
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function requireSelector(value: string | undefined, pattern: RegExp): string {
  if (value === undefined || !pattern.test(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

export function createWorkspaceScopeRoutes(
  deps: WorkspaceScopeRouteDeps,
): Hono {
  const routes = new Hono();

  routes.get("/", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      return context.json(await deps.lister.list(identity));
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });

  const requireAdmin = () => {
    if (!deps.admin) throw new Error("WORKSPACE_ADMIN_UNAVAILABLE");
    return deps.admin;
  };

  // MT095/MT096/MT097: the company admin surface rides the same entrance, so
  // the closed company-plane classification stays the one authority for both.
  if (deps.companyAdmin !== undefined) {
    routes.route("/", deps.companyAdmin);
  }

  routes.post("/admin/teams", async (context) => {
    try {
      requireClassifiedCompanyEntrance("POST", "/admin/teams");
      const adminContext = await requireAdmin().authorizer.resolveAdminContext(
        context.req.raw,
      );
      const body = await jsonObject(context.req.raw);
      if (
        typeof body.name !== "string" ||
        (body.workspaceId !== undefined && typeof body.workspaceId !== "string")
      ) {
        throw new Error("INVALID_REQUEST");
      }
      const team = await requireAdmin().service.createTeam(adminContext, {
        name: body.name,
        workspaceId:
          body.workspaceId === undefined
            ? undefined
            : requireSelector(body.workspaceId, WORKSPACE_ID_PATTERN),
      });
      return context.json({ team }, 201);
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });

  routes.post("/admin/teams/:workspaceId/members", async (context) => {
    try {
      requireClassifiedCompanyEntrance(
        "POST",
        "/admin/teams/:workspaceId/members",
      );
      const adminContext = await requireAdmin().authorizer.resolveAdminContext(
        context.req.raw,
      );
      const workspaceId = requireSelector(
        context.req.param("workspaceId"),
        WORKSPACE_ID_PATTERN,
      );
      const body = await jsonObject(context.req.raw);
      if (typeof body.principalId !== "string") {
        throw new Error("INVALID_REQUEST");
      }
      const principalId = requireSelector(
        body.principalId,
        PRINCIPAL_ID_PATTERN,
      );
      const result = await requireAdmin().service.addTeamMember(adminContext, {
        workspaceId,
        principalId,
      });
      return context.json(
        { membership: result.membership },
        result.outcome === "created" ? 201 : 200,
      );
    } catch (error) {
      const response = errorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
  });

  routes.post(
    "/admin/teams/:workspaceId/members/:principalId/suspend",
    async (context) => {
      try {
        requireClassifiedCompanyEntrance(
          "POST",
          "/admin/teams/:workspaceId/members/:principalId/suspend",
        );
        const adminContext =
          await requireAdmin().authorizer.resolveAdminContext(context.req.raw);
        const workspaceId = requireSelector(
          context.req.param("workspaceId"),
          WORKSPACE_ID_PATTERN,
        );
        const principalId = requireSelector(
          context.req.param("principalId"),
          PRINCIPAL_ID_PATTERN,
        );
        const result = await requireAdmin().service.suspendTeamMember(
          adminContext,
          { workspaceId, principalId },
        );
        return context.json({ membership: result.membership });
      } catch (error) {
        const response = errorResponse(error);
        return context.json(
          response.body,
          response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
        );
      }
    },
  );

  routes.delete(
    "/admin/teams/:workspaceId/members/:principalId",
    async (context) => {
      try {
        requireClassifiedCompanyEntrance(
          "DELETE",
          "/admin/teams/:workspaceId/members/:principalId",
        );
        const adminContext =
          await requireAdmin().authorizer.resolveAdminContext(context.req.raw);
        const workspaceId = requireSelector(
          context.req.param("workspaceId"),
          WORKSPACE_ID_PATTERN,
        );
        const principalId = requireSelector(
          context.req.param("principalId"),
          PRINCIPAL_ID_PATTERN,
        );
        return context.json(
          await requireAdmin().service.removeTeamMember(adminContext, {
            workspaceId,
            principalId,
          }),
        );
      } catch (error) {
        const response = errorResponse(error);
        return context.json(
          response.body,
          response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
        );
      }
    },
  );

  return routes;
}

export function createUnavailableWorkspaceScopeRoutes(): Hono {
  const routes = new Hono();
  routes.all("*", (context) =>
    context.json(
      {
        error: {
          code: "unavailable",
          message: "Workspace scope surface unavailable.",
        },
      },
      503,
    ),
  );
  return routes;
}

// ---------------------------------------------------------------------------
// BA 选择面（T03.02 / #539，interfaces §4）：同一入口上的 ba-v1 半边
// ---------------------------------------------------------------------------

/*
 * The mount wrapper that adds the §4 selection surface to an already-built
 * workspace-scope app. The base keeps every route it had — admin, company
 * admin, the unavailable face — byte-identical: the wrapper owns exactly the
 * two §4 routes and delegates everything else to the base with the original
 * method, headers and body, so a deployment that wired the BA selection
 * service changes nothing about the requests it served before.
 *
 *   GET  /                      authority-branched: ba → the §4 ScopeListing,
 *                               advertised `ba-v1`; legacy/paused → the base's
 *                               own legacy answer, re-advertised `legacy` on
 *                               the response (the legacy BODY stays untouched)
 *   POST /validate-selection    the §4 validation, or its named refusals
 *
 * The advertisement header (`x-openbot-directory-authority`) is the DTO
 * contract the surface serves — `legacy` or `ba-v1` — never the migration
 * phase; a response that cannot prove its authority answers 503 instead of
 * guessing a branch (fail-closed, no silent legacy fallback).
 */

/** The DTO contract the listing response advertises (interfaces §4). */
export const DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER =
  "x-openbot-directory-authority";

const refusedBody = (code: string) => ({
  error: { code, message: "Request refused." },
});

/*
 * The BA directory surfaces' shared refusal→status projection (T03.02, and
 * since T04.01 a module-level export the sibling own-read surface consumes,
 * so the two adapters cannot drift apart on which refusal answers which
 * status). Same closed mapping the mount below has always applied.
 */
export function directorySurfaceErrorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (isBaSelectionRefusal(error)) {
    return { status: error.status, body: refusedBody(error.code) };
  }
  if (isAuthorityRefusal(error)) {
    return { status: 503, body: refusedBody(error.code) };
  }
  if (isCompanyAssuranceRefusal(error)) {
    return { status: 403, body: refusedBody(error.code) };
  }
  if (error instanceof Error) {
    if (error.message === "AUTH_REQUIRED") {
      return { status: 401, body: refusedBody("AUTH_REQUIRED") };
    }
    if (error.message === "INVALID_REQUEST") {
      return { status: 400, body: refusedBody("INVALID_REQUEST") };
    }
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "Request failed." } },
  };
}

export interface BaSelectionRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  /** The BA selection service; the wrapper exists only where the assembly built one. */
  selection: Pick<BaScopeSelectionService, "list" | "validate">;
}

export function createBaSelectionScopeMount(
  base: Hono,
  deps: BaSelectionRouteDeps,
): Hono {
  const routes = new Hono();

  /**
   * Rewrites a request into the inner path space the base app owns, keeping
   * method, headers, body and query untouched — the base answers exactly as
   * it would when mounted directly.
   */
  const innerRequestOf = (request: Request, path: string | null): Request => {
    const url = new URL(request.url);
    const inner =
      path ?? (url.pathname.slice(WORKSPACE_SCOPE_MOUNT_PREFIX.length) || "/");
    return new Request(new URL(`${inner}${url.search}`, url.origin), request);
  };

  /** Re-serves a delegated answer with the DTO contract it carries. */
  const withAdvertisement = (
    response: Response,
    value: "legacy" | "ba-v1",
  ): Response => {
    const advertised = new Response(response.body, response);
    advertised.headers.set(DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER, value);
    return advertised;
  };

  routes.get("/", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const listing = await deps.selection.list(identity);
      if (listing !== null) {
        return context.json(listing, 200, {
          [DIRECTORY_AUTHORITY_ADVERTISEMENT_HEADER]: "ba-v1",
        });
      }
      // legacy/paused: the base's own answer, re-advertised — the body is the
      // legacy DTO exactly as the legacy routes serve it.
      const delegated = await base.fetch(innerRequestOf(context.req.raw, "/"));
      return withAdvertisement(delegated, "legacy");
    } catch (error) {
      const response = directorySurfaceErrorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 500 | 503,
      );
    }
  });

  routes.post("/validate-selection", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const body = await jsonObject(context.req.raw);
      if (
        typeof body.tenantId !== "string" ||
        typeof body.workspaceId !== "string"
      ) {
        throw new Error("INVALID_REQUEST");
      }
      const validated = await deps.selection.validate(
        identity,
        { tenantId: body.tenantId, workspaceId: body.workspaceId },
        {
          tenantId: context.req.header("x-openbot-tenant") ?? undefined,
          workspaceId: context.req.header("x-openbot-workspace") ?? undefined,
        },
      );
      return context.json(validated);
    } catch (error) {
      const response = directorySurfaceErrorResponse(error);
      return context.json(
        response.body,
        response.status as 400 | 401 | 403 | 404 | 500 | 503,
      );
    }
  });

  // Every other route is the base's own: delegated with the original request.
  // The one deliberate non-delegation: the inner root "/" of the catch-all —
  // a trailing-slash mount root never existed on the legacy surface (its GET
  // answers only the bare prefix), so the wrapper keeps that 404 instead of
  // inventing a second root.
  routes.all("*", (context) => {
    const inner =
      new URL(context.req.url).pathname.slice(
        WORKSPACE_SCOPE_MOUNT_PREFIX.length,
      ) || "/";
    if (inner === "/") return context.notFound();
    return base.fetch(innerRequestOf(context.req.raw, null));
  });

  return routes;
}
