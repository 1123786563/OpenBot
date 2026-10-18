// MT122（Issue #165）：部署主入口请求上下文 + 作用域工厂。
//
// 部署主入口（createApp 装配的 /api/* 业务面 + 内部入口）此前没有"从已认证
// 身份建立请求上下文"的装配：业务依赖全部来自启动时按单份部署配置构造的
// store。本模块补上接缝与工厂 + 装配中间件：
//
//   - HTTP 半边与内部半边消费与企业入口同一 createScopeResolver 构造（共享
//     签发 WeakSet、同一成员资格 DB 重验、同一 canonical 拒绝码——AC3）；
//   - 业务依赖只经作用域工厂按请求上下文构造（runtimeConfig = MT014 服务
//     resolve、transaction = MT005 gate——AC2），服务与 gate 由工厂一次构造、
//     按 scope 逐请求绑定，不是每请求重建连接池，也不是启动单份配置；
//   - requireEntryBusiness 是业务依赖唯一读取面：未建立即
//     ENTRY_CONTEXT_REQUIRED，不存在默认范围（fail-closed——AC1）；
//   - 中间件只在多租户模式挂载：全局例外放行（MT030 登记表）→ 企业前缀
//     放行（企业入口自建上下文）→ 无选择头放行（legacy 面尚未消费本接缝，
//     选择头铺设属 MT125）→ 显式选择建立失败按 canonical 码拒绝
//     （AUTH_REQUIRED→401、*_REQUIRED→400、*_FORBIDDEN→403），绝不落默认
//     （AC1 入口级拒绝半边）。
//
// 事务纪律：business.transaction 走 MT005 gate（受信 Scope 校验 + 两级成员
// 重验 + 事务本地租户上下文），事务体只触受限数据通道，不跨外部网络等待
// （AC4，测试与静态扫描存档佐证）。

import type { MiddlewareHandler } from "hono";
import type { PlatformScope } from "../contracts";
import type { DataDatabase, DirectoryDatabase } from "./connections";
import { matchGlobalException } from "./global-exceptions";
import {
  createRuntimeConfigService,
  type ResolvedRuntimeConfig,
} from "./runtime-config";
import { createWorkspaceGate } from "./scope-gate";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "./store";

/** 缺上下文的业务依赖读取：唯一合法的失败方式是拒绝，不是默认。 */
export const ENTRY_CONTEXT_REQUIRED = "ENTRY_CONTEXT_REQUIRED";

/** 作用域工厂按请求构造的业务依赖（AC2：每请求新对象，绑定在 scope 上）。 */
export interface DeploymentEntryBusiness {
  readonly scope: PlatformScope;
  /** MT014 运行配置：按本 scope 的公司/团队解析，无配置行即拒（无默认回退）。 */
  runtimeConfig(): Promise<ResolvedRuntimeConfig>;
  /** MT005 gate：事务内两级成员重验；事务体只触受限数据通道（AC4）。 */
  transaction<T>(
    operation: (
      tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T>;
}

/** 内部入口的身份输入：服务器持久化归属（trigger 行/任务 pin 的接线在 MT123+）。 */
export interface DeploymentInternalEntryIdentity {
  readonly actorId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface DeploymentEntryContextFactory {
  fromRequest(request: Request): Promise<DeploymentEntryBusiness>;
  fromInternalIdentity(
    identity: DeploymentInternalEntryIdentity,
  ): Promise<DeploymentEntryBusiness>;
}

export interface DeploymentEntryContextFactoryInput {
  readonly directory: DirectoryDatabase;
  readonly data: DataDatabase;
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
}

/**
 * The deployment main entry's one context factory. Both halves construct the
 * SAME scope resolver the enterprise entry uses, so issuance (WeakSet),
 * membership revalidation and every canonical refusal code are inherited, not
 * reimplemented (AC3). Business dependencies are built per scope by
 * `businessFor` — the factory's services are constructed once and bound to
 * each request's scope (AC2), never a startup-wide single config and never a
 * default scope (AC1, fail-closed at the seam).
 */
export function createDeploymentEntryContextFactory({
  directory,
  data,
  authenticate,
}: DeploymentEntryContextFactoryInput): DeploymentEntryContextFactory {
  const runtimeConfig = createRuntimeConfigService(data);
  const gate = createWorkspaceGate(data);
  // HTTP half: the enterprise entry's own resolution semantics, byte for byte
  // (same authenticate closure, same ruling #1 selection headers).
  const httpScopes = createScopeResolver(directory, {
    authenticate,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  // Internal half: same resolver constructor; the actor comes from the
  // caller-supplied server-persisted identity carried on a synthetic request
  // that exists only inside this process and is never mounted on any HTTP
  // surface. Establishment still performs the same database membership
  // revalidation, so a machine identity without membership is TENANT_FORBIDDEN.
  const internalScopes = createScopeResolver(directory, {
    authenticate: async (request) => ({
      actorId: request.headers.get("x-openbot-internal-actor") ?? "",
      entrypoint: "schedule",
    }),
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  const businessFor = (scope: PlatformScope): DeploymentEntryBusiness => ({
    scope,
    runtimeConfig: () =>
      runtimeConfig.resolve({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      }),
    transaction: (operation) => gate.transaction(scope, operation),
  });
  return {
    async fromRequest(request: Request) {
      return businessFor(await httpScopes.resolve(request));
    },
    async fromInternalIdentity({
      actorId,
      tenantId,
      workspaceId,
    }: DeploymentInternalEntryIdentity) {
      const request = new Request("http://mt122.internal/entry", {
        headers: {
          "x-openbot-internal-actor": actorId,
          "x-openbot-tenant": tenantId,
          "x-openbot-workspace": workspaceId,
        },
      });
      return businessFor(await internalScopes.resolve(request));
    },
  };
}

/**
 * 业务依赖唯一读取面（fail-closed）：路由拿业务依赖只有这一条路，未建立
 * 上下文即 ENTRY_CONTEXT_REQUIRED——不存在绕过中间件取默认依赖的路径。
 */
export function requireEntryBusiness(
  business: DeploymentEntryBusiness | null | undefined,
): DeploymentEntryBusiness {
  if (!business) throw new Error(ENTRY_CONTEXT_REQUIRED);
  return business;
}

/**
 * Assembly middleware for the deployment main entry (mounted /api/*-wide,
 * multitenancy mode only). Order matters and each step is disclosed:
 *   1. MT030 global exceptions pass through (their entries ARE the explicit
 *      exception registry — R5);
 *   2. the enterprise entry's own paths pass through (it establishes context
 *      itself from the same shared seam);
 *   3. requests with NO selection headers pass through untouched — the legacy
 *      business surface does not consume this seam yet, and its business
 *      dependencies are absent, so consuming it refuses (MT125 lays the
 *      client headers);
 *   4. an explicit selection establishes the context; establishment failure is
 *      refused with the canonical code's own status mapping — never a default.
 */
export function createDeploymentEntryContextMiddleware(
  factory: DeploymentEntryContextFactory,
): MiddlewareHandler {
  return async (context, next) => {
    if (matchGlobalException(context.req.method, context.req.path)) {
      return next();
    }
    if (
      context.req.path === "/api/enterprise" ||
      context.req.path.startsWith("/api/enterprise/")
    ) {
      return next();
    }
    const tenant = context.req.header("x-openbot-tenant");
    const workspace = context.req.header("x-openbot-workspace");
    if (!tenant?.trim() && !workspace?.trim()) return next();
    let business: DeploymentEntryBusiness;
    try {
      business = await factory.fromRequest(context.req.raw);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const status =
        code === "AUTH_REQUIRED"
          ? 401
          : code === "TENANT_REQUIRED" || code === "WORKSPACE_REQUIRED"
            ? 400
            : 403;
      const wireCode =
        status === 401
          ? "unauthenticated"
          : status === 400
            ? "invalid_request"
            : "forbidden";
      return context.json(
        { error: { code: wireCode, message: code } },
        status as 400 | 401 | 403,
      );
    }
    context.set("entryBusiness", business);
    return next();
  };
}
