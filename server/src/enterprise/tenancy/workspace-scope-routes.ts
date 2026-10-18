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
import {
  assertClassifiedCompanyEntrance,
  WORKSPACE_SCOPE_MOUNT_PREFIX,
} from "./admin-separation";
import type { AuthenticatedRequestIdentity } from "./store";
import type {
  CompanyAdminAuthorizer,
  WorkspaceAdminService,
  WorkspaceScopeLister,
} from "./workspace-admin";

export interface WorkspaceScopeRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  lister: WorkspaceScopeLister;
  /** Absent (operator channel unwired) → admin routes answer 503. */
  admin?: {
    authorizer: CompanyAdminAuthorizer;
    service: WorkspaceAdminService;
  };
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
