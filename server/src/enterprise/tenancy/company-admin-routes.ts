// server/src/enterprise/tenancy/company-admin-routes.ts
// MT095/MT096/MT097（Issues #138-#140）：公司管理面的 HTTP 路由（people、身份、
// 凭据、审计、企业设置、学习、公司账簿），挂在 workspace-scope 集中入口之下。
//
// 挂载与分类：全部路由位于 /api/enterprise/workspace-scope/admin/** ——MT075
// 封闭规则表把它整体归入公司面；每个路由在自己的处理半边声明清单 id 形态入口
// 并要求公司面分类（与 MT006 既有管理路由同一 fail-closed 纪律）。路由面不
// 重复判定：能力位来自 company-capabilities 的组合，动作与读取来自各服务
// 自己的判定门——这里只做输入校验、判定门调用与哨兵→HTTP 映射。
//
//   GET    /admin/capabilities                 能力答案（成员面；入口可见性事实源）
//   GET    /admin/people                      本公司名册（tenant_admin）
//   POST   /admin/people/:principalId/promote 提升（MT076，留审计）
//   POST   /admin/people/:principalId/demote  降级（MT076，留审计）
//   POST   /admin/people/:principalId/offboard 离职（MT076，留审计）
//   GET    /admin/credentials                 本公司凭据名册（脱敏视图）
//   GET    /admin/identity                    本公司 SSO 配置 + SCIM 绑定（引用，无秘密）
//   GET    /admin/enterprise-config           本公司配置投影
//   GET    /admin/audit-events                business 域审计查询（auditor|tenant_admin）
//   GET    /admin/audit-events/export         导出（同判定门 + 导出留审计）
//   GET    /admin/learning                    本范围学习记录（范围 pin，他范围空页）
//   GET    /admin/billing/company-books       公司账簿 + 团队用量 + 用量证据行（财务读取授权）
//
// 装配契约：管理服务依赖 operator 通道；通道未装配时这些路由整体 503
// （createUnavailableCompanyAdminRoutes），绝不以宽松替身放行。

import { Hono } from "hono";
import type {
  CompanyBooks,
  CompanyFinanceVisibilityService,
  CompanyUsageLine,
} from "../../billing/company-finance-visibility";
import type { PlatformScope } from "../contracts";
import {
  assertClassifiedCompanyEntrance,
  WORKSPACE_SCOPE_MOUNT_PREFIX,
} from "./admin-separation";
import type {
  AuditDomain,
  AuditQueryActor,
  TenantAuditEventRow,
} from "./audit-domains";
import type { CompanyCapabilities } from "./company-capabilities";
import type { CompanyConfigView } from "./company-config";
import type { CredentialOwnershipAdminService } from "./credential-ownership";
import type { LearningRecordView } from "./learning-demonstrations";
import type {
  CompanyMemberRow,
  CompanyPeopleLifecycleService,
} from "./people-lifecycle";
import type { CompanySsoScimConfigService } from "./sso-scim-config";
import type {
  CompanyAdminAuthorizer,
  CompanyAdminContext,
  CompanyMemberContext,
} from "./workspace-admin";

/** The audit port the routes consume (queryTenantAuditEvents and friends, bound at assembly). */
export interface CompanyAuditPort {
  query(
    actor: AuditQueryActor,
    query: {
      readonly tenantId: string;
      readonly domain: AuditDomain;
      readonly limit?: number;
      readonly eventType?: string;
    },
  ): Promise<readonly TenantAuditEventRow[]>;
  exportEvents(
    actor: AuditQueryActor,
    query: {
      readonly tenantId: string;
      readonly domain: AuditDomain;
      readonly maxRows?: number;
    },
  ): Promise<{
    readonly events: readonly TenantAuditEventRow[];
    readonly truncated: boolean;
  }>;
  /** The export's own audit row (AC1: 导出留审计) — failures propagate, never fold into success. */
  recordExport(
    tenantId: string,
    actorPrincipalId: string,
    input: { readonly exportedRows: number; readonly truncated: boolean },
  ): Promise<void>;
}

export interface CompanyAdminRouteDeps {
  /** The authorizer both faces share: admin contexts for gated routes, member contexts otherwise. */
  authorizer: CompanyAdminAuthorizer & {
    resolveMemberContext(request: Request): Promise<CompanyMemberContext>;
  };
  capabilities: {
    capabilitiesOf(member: CompanyMemberContext): Promise<CompanyCapabilities>;
  };
  people: CompanyPeopleLifecycleService;
  credentials: Pick<CredentialOwnershipAdminService, "listForTenant">;
  identity: Pick<
    CompanySsoScimConfigService,
    "readSsoConfig" | "listScimBindings"
  >;
  config: (context: CompanyAdminContext) => Promise<CompanyConfigView>;
  learning: {
    listRecords(
      scope: PlatformScope,
      input?: { readonly kind?: "research" | "demonstration" },
    ): Promise<readonly LearningRecordView[]>;
  };
  /** Resolves the full selection pair (tenant + workspace) against membership facts (MT005). */
  resolveScope(request: Request): Promise<PlatformScope>;
  audit: CompanyAuditPort;
  finance: Pick<
    CompanyFinanceVisibilityService,
    "companyBooks" | "recentUsageLines"
  >;
}

const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const STATUS_BY_CODE: Readonly<
  Record<string, 400 | 401 | 403 | 404 | 409 | 500 | 503>
> = {
  AUTH_REQUIRED: 401,
  TENANT_REQUIRED: 400,
  WORKSPACE_REQUIRED: 400,
  INVALID_REQUEST: 400,
  TENANT_FORBIDDEN: 403,
  TENANT_ADMIN_REQUIRED: 403,
  UNVERIFIED_ADMIN_CONTEXT: 403,
  UNVERIFIED_MEMBER_CONTEXT: 403,
  SCOPE_REVOKED: 403,
  WORKSPACE_FORBIDDEN: 403,
  AUDIT_SCOPE_FORBIDDEN: 403,
  COMPANY_FINANCE_REQUIRED: 403,
  BILLING_MANAGE_REQUIRED: 403,
  COMPANY_MEMBER_NOT_FOUND: 404,
  COMPANY_CONFIG_NOT_FOUND: 404,
  SSO_CONFIG_NOT_FOUND: 404,
  SCIM_BINDING_NOT_FOUND: 404,
  COMPANY_ROLE_CHANGE_CONFLICT: 409,
  COMPANY_OFFBOARD_CONFLICT: 409,
  DATA_DATABASE_UNAVAILABLE: 503,
  WORKSPACE_ADMIN_UNAVAILABLE: 503,
  MANAGEMENT_ENTRANCE_UNCLASSIFIED: 500,
};

function errorResponse(error: unknown): {
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503;
  code: string;
  body: { error: { code: string; message: string } };
} {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  const status = STATUS_BY_CODE[code] ?? 500;
  if (status === 500) {
    return {
      status,
      code: "internal",
      body: { error: { code: "internal", message: "Request failed." } },
    };
  }
  return {
    status,
    code,
    body: { error: { code, message: "Request refused." } },
  };
}

const requireClassifiedCompanyEntrance = (
  method: string,
  routePath: string,
): void => {
  assertClassifiedCompanyEntrance(
    method,
    `${WORKSPACE_SCOPE_MOUNT_PREFIX}${routePath}`,
  );
};

function principalParam(value: string | undefined): string {
  if (value === undefined || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

function queryNumber(
  url: URL,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("INVALID_REQUEST");
  }
  return parsed;
}

function eventTypeParam(url: URL): string | undefined {
  const raw = url.searchParams.get("eventType");
  if (raw === null) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)) {
    throw new Error("INVALID_REQUEST");
  }
  return raw;
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("INVALID_REQUEST");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_REQUEST")
      throw error;
    throw new Error("INVALID_REQUEST");
  }
}

export function createCompanyAdminRoutes(deps: CompanyAdminRouteDeps): Hono {
  const routes = new Hono();

  routes.get("/admin/capabilities", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/capabilities");
      // 成员面：每个成员都能问「我在选中的公司里能做什么」——这是入口
      // 可见性的事实源（AC1），答案本身只有能力位，无任何公司事实。
      const member = await deps.authorizer.resolveMemberContext(
        context.req.raw,
      );
      return context.json(await deps.capabilities.capabilitiesOf(member));
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/people", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/people");
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      const members: readonly CompanyMemberRow[] =
        await deps.people.companyMembers(adminContext);
      return context.json({ members });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.post("/admin/people/:principalId/promote", async (context) => {
    try {
      requireClassifiedCompanyEntrance(
        "POST",
        "/admin/people/:principalId/promote",
      );
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      const report = await deps.people.promoteCompanyMember(adminContext, {
        principalId: principalParam(context.req.param("principalId")),
      });
      return context.json({ report });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.post("/admin/people/:principalId/demote", async (context) => {
    try {
      requireClassifiedCompanyEntrance(
        "POST",
        "/admin/people/:principalId/demote",
      );
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      const body = await readJsonObject(context.req.raw);
      if (body.to !== "member" && body.to !== "auditor") {
        throw new Error("INVALID_REQUEST");
      }
      const report = await deps.people.demoteCompanyMember(adminContext, {
        principalId: principalParam(context.req.param("principalId")),
        to: body.to,
      });
      return context.json({ report });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.post("/admin/people/:principalId/offboard", async (context) => {
    try {
      requireClassifiedCompanyEntrance(
        "POST",
        "/admin/people/:principalId/offboard",
      );
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      const report = await deps.people.offboardCompanyMember(adminContext, {
        principalId: principalParam(context.req.param("principalId")),
      });
      return context.json({ report });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/credentials", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/credentials");
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      // 脱敏名册：视图类型上没有 envelope/plaintext 字段（结构性脱敏）。
      const credentials = await deps.credentials.listForTenant({
        tenantId: adminContext.tenantId,
      });
      return context.json({ credentials });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/identity", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/identity");
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      // SSO 配置是引用文档（协议/issuer/domain/凭据引用），无秘密；无配置
      // 是诚实空（null），不是错误——「没有」与「别家有」同形（AC2 不可见语义）。
      let sso: Awaited<ReturnType<typeof deps.identity.readSsoConfig>> | null =
        null;
      try {
        sso = await deps.identity.readSsoConfig(adminContext);
      } catch (error) {
        if (
          !(error instanceof Error && error.message === "SSO_CONFIG_NOT_FOUND")
        ) {
          throw error;
        }
      }
      const scimBindings = await deps.identity.listScimBindings(adminContext);
      return context.json({
        sso: sso === null ? null : { ...sso.config, revision: sso.revision },
        scimBindings,
      });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/enterprise-config", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/enterprise-config");
      const adminContext = await deps.authorizer.resolveAdminContext(
        context.req.raw,
      );
      return context.json(await deps.config(adminContext));
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/audit-events", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/audit-events");
      const member = await deps.authorizer.resolveMemberContext(
        context.req.raw,
      );
      const url = new URL(context.req.raw.url);
      const events = await deps.audit.query(
        { kind: "company", principalId: member.principalId },
        {
          tenantId: member.tenantId,
          domain: "business",
          limit: queryNumber(url, "limit", 1, 500),
          eventType: eventTypeParam(url),
        },
      );
      return context.json({ events });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/audit-events/export", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/audit-events/export");
      const member = await deps.authorizer.resolveMemberContext(
        context.req.raw,
      );
      const url = new URL(context.req.raw.url);
      const { events, truncated } = await deps.audit.exportEvents(
        { kind: "company", principalId: member.principalId },
        {
          tenantId: member.tenantId,
          domain: "business",
          maxRows: queryNumber(url, "maxRows", 1, 5000),
        },
      );
      // 导出本身留审计（AC1）：记录在导出成功之后、响应之前——审计写失败
      // 则导出失败（绝不折叠成成功）；行内容已双脱敏（写入+导出）。
      await deps.audit.recordExport(member.tenantId, member.principalId, {
        exportedRows: events.length,
        truncated,
      });
      const csv = toAuditCsv(events);
      return context.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="company-audit-${member.tenantId}.csv"`,
      });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/learning", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/learning");
      // 双重判定：管理上下文（tenant_admin，能力入口）+ 完整范围解析
      // （选择对 → 成员事实，MT005）。学习记录按范围 pin——其他范围的
      // 容器与内容结构性不可见（RLS），他范围 = 空页（AC3）。
      await deps.authorizer.resolveAdminContext(context.req.raw);
      const scope = await deps.resolveScope(context.req.raw);
      const records = await deps.learning.listRecords(scope);
      return context.json({ records });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  routes.get("/admin/billing/company-books", async (context) => {
    try {
      requireClassifiedCompanyEntrance("GET", "/admin/billing/company-books");
      // 财务读取授权是显式授予（MT073），不是公司管理员自动权——判定门
      // 在服务内（拒绝路径零账务读取），路由只翻译哨兵。
      const member = await deps.authorizer.resolveMemberContext(
        context.req.raw,
      );
      const url = new URL(context.req.raw.url);
      const books: CompanyBooks = await deps.finance.companyBooks({
        tenantId: member.tenantId,
        principalId: member.principalId,
      });
      const recentUsage: readonly CompanyUsageLine[] =
        await deps.finance.recentUsageLines({
          tenantId: member.tenantId,
          principalId: member.principalId,
          limit: queryNumber(url, "limit", 1, 200),
        });
      return context.json({ books, recentUsage });
    } catch (error) {
      const response = errorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  return routes;
}

/**
 * The CSV the audit export answers with: the same rows the list renders, masked the same way
 * (they were masked at write and again at export), one header row, values quoted on demand.
 */
function toAuditCsv(events: readonly TenantAuditEventRow[]): string {
  const quoteIfNeeded = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = ["id,domain,eventType,actorId,targetId,createdAt"];
  for (const event of events) {
    lines.push(
      [
        event.id,
        event.domain,
        event.eventType,
        event.actorId,
        event.targetId ?? "",
        event.createdAt.toISOString(),
      ]
        .map(quoteIfNeeded)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The fail-closed stand-in when the operator channel is unwired (never a permissive face). */
export function createUnavailableCompanyAdminRoutes(): Hono {
  const routes = new Hono();
  routes.all("*", (context) =>
    context.json(
      {
        error: {
          code: "unavailable",
          message: "Company admin surface unavailable.",
        },
      },
      503,
    ),
  );
  return routes;
}

// ---------------------------------------------------------------------------
// T03.03（#540，P06）：平台公司开通入口（platform 面，非 company 面）
// ---------------------------------------------------------------------------

import { isAuthorityRefusal } from "../../auth/directory/authority";
import { isDirectoryCommandRefusal } from "../../auth/directory/executor";
import { isCompanyLifecycleRefusal } from "../../auth/directory/lifecycle";
import type {
  PlatformCompanyProvisionInput,
  PlatformCompanyProvisionOutcome,
  PlatformCompanyProvisionService,
} from "./provision";
import type { AuthenticatedRequestIdentity } from "./store";

/** The platform face's dependencies: authentication plus the provision service. */
export interface PlatformCompanyRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  provisioner: PlatformCompanyProvisionService;
}

const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY_MAX = 512;

function isPrintableText(value: string): boolean {
  return value
    .split("")
    .every((character) => character >= " " && character !== "\u007f");
}

/**
 * The platform company-provision surface, mounted at
 * `/api/enterprise/companies`. Exactly one route: `POST /` with
 * {name,slug,ownerUserId,defaultTeamName} and the idempotency-key header.
 * The plane is the platform's, not a company's — the admin gate lives in the
 * provision service (and is re-verified inside the locked command), so no
 * company role ever reaches this surface and the route never mounts under
 * the workspace-scope company entrance.
 */
export function createPlatformCompanyRoutes(
  deps: PlatformCompanyRouteDeps,
): Hono {
  const routes = new Hono();

  routes.post("/", async (context) => {
    try {
      const identity = await deps.authenticate(context.req.raw);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const idempotencyKey = context.req.header(IDEMPOTENCY_HEADER);
      if (
        idempotencyKey === undefined ||
        idempotencyKey.trim() === "" ||
        idempotencyKey.length > IDEMPOTENCY_KEY_MAX ||
        !isPrintableText(idempotencyKey)
      ) {
        throw new Error("INVALID_REQUEST");
      }
      const body = await readJsonObject(context.req.raw);
      const text = (field: string): string => {
        const value = body[field];
        if (typeof value !== "string" || value.trim() === "") {
          throw new Error("INVALID_REQUEST");
        }
        return value;
      };
      const input: PlatformCompanyProvisionInput = {
        actorUserId: identity.actorId,
        name: text("name"),
        slug: text("slug"),
        ownerUserId: text("ownerUserId"),
        defaultTeamName: text("defaultTeamName"),
        idempotencyKey,
      };
      const outcome: PlatformCompanyProvisionOutcome =
        await deps.provisioner.provision(input);
      return context.json({ company: outcome }, outcome.replayed ? 200 : 201);
    } catch (error) {
      const response = platformErrorResponse(error);
      return context.json(response.body, response.status);
    }
  });

  return routes;
}

/** The platform face's own refusal projection (no company-plane codes leak in). */
function platformErrorResponse(error: unknown): {
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503;
  body: { error: { code: string; message: string } };
} {
  if (isCompanyLifecycleRefusal(error)) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: "Request refused." } },
    };
  }
  if (isDirectoryCommandRefusal(error)) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: "Request refused." } },
    };
  }
  if (isAuthorityRefusal(error)) {
    // The refusal's stable code, never its message: the message carries the
    // detail text (T03.03 review R1-F1, low), and the platform face's error
    // DTO is a closed vocabulary, not a diagnostic channel.
    return {
      status: 503,
      body: { error: { code: error.code, message: "Request refused." } },
    };
  }
  if (error instanceof Error && error.message === "AUTH_REQUIRED") {
    return {
      status: 401,
      body: { error: { code: "AUTH_REQUIRED", message: "Request refused." } },
    };
  }
  if (error instanceof Error && error.message === "INVALID_REQUEST") {
    return {
      status: 400,
      body: {
        error: { code: "INVALID_REQUEST", message: "Request refused." },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "Request failed." } },
  };
}

// ---------------------------------------------------------------------------
// T03.04（#541，P06）：平台公司生命周期入口（suspend / restore / deletion-request）
// ---------------------------------------------------------------------------

import type {
  PlatformCompanyLifecycleInput,
  PlatformCompanyLifecycleService,
} from "../../auth/directory/lifecycle";

/** The platform lifecycle face's dependencies: authentication plus the service. */
export interface PlatformCompanyLifecycleRouteDeps {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  lifecycle: PlatformCompanyLifecycleService;
}

const COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const LIFECYCLE_REASON_MAX = 512;

/**
 * The platform company-lifecycle surface, mounted beside the provision face at
 * `/api/enterprise/companies`: `POST /:companyId/suspend`, `POST /:companyId/
 * restore` and `POST /:companyId/deletion-request`, each with a {reason} body
 * and the idempotency-key header. The plane is the platform's — the admin gate
 * lives in the lifecycle service (and is re-verified inside the locked
 * command), so no company role ever reaches this surface.
 */
export function createPlatformCompanyLifecycleRoutes(
  deps: PlatformCompanyLifecycleRouteDeps,
): Hono {
  const routes = new Hono();

  /** One lifecycle route's shared shape: auth → key → body → service call. */
  const lifecycleRoute = (
    path: string,
    createdStatus: 200 | 201,
    call: (
      input: PlatformCompanyLifecycleInput,
    ) => Promise<{ readonly replayed: boolean }>,
  ) => {
    routes.post(path, async (context) => {
      try {
        const identity = await deps.authenticate(context.req.raw);
        if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
        const idempotencyKey = context.req.header(IDEMPOTENCY_HEADER);
        if (
          idempotencyKey === undefined ||
          idempotencyKey.trim() === "" ||
          idempotencyKey.length > IDEMPOTENCY_KEY_MAX ||
          !isPrintableText(idempotencyKey)
        ) {
          throw new Error("INVALID_REQUEST");
        }
        const companyId = context.req.param("companyId");
        if (!companyId || !COMPANY_ID_PATTERN.test(companyId)) {
          throw new Error("INVALID_REQUEST");
        }
        const body = await readJsonObject(context.req.raw);
        const reason = body.reason;
        if (
          typeof reason !== "string" ||
          reason.trim() === "" ||
          reason.length > LIFECYCLE_REASON_MAX ||
          !isPrintableText(reason)
        ) {
          throw new Error("INVALID_REQUEST");
        }
        const outcome = await call({
          actorUserId: identity.actorId,
          tenantId: companyId,
          reason,
          idempotencyKey,
        });
        return context.json(
          path.endsWith("/deletion-request")
            ? { deletionRequest: outcome }
            : { company: outcome },
          outcome.replayed ? 200 : createdStatus,
        );
      } catch (error) {
        const response = platformErrorResponse(error);
        return context.json(response.body, response.status);
      }
    });
  };

  lifecycleRoute("/:companyId/suspend", 200, (input) =>
    deps.lifecycle.suspend(input),
  );
  lifecycleRoute("/:companyId/restore", 200, (input) =>
    deps.lifecycle.restore(input),
  );
  lifecycleRoute("/:companyId/deletion-request", 201, (input) =>
    deps.lifecycle.requestDeletion(input),
  );

  return routes;
}
