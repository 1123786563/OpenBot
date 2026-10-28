// server/src/enterprise/tenancy/assembly-enterprise.ts
// MT124（Issue #167）：企业入口装配接入统一上下文与授权。
//
// 企业入口的每个会话路由不再各自做可见性判断（MT019 之前的形态：每条路由
// 先 scopes.resolve / resolveForThread 再调服务），而是统一经**与部署主入口
// 同一个** DeploymentEntryContextFactory 建立请求上下文（AC2：同一工厂、
// 同一签发 WeakSet、同一成员资格 DB 重验、同一 canonical 拒绝码——不是
// 平行实现）：
//
//   - 缺上下文拒绝（AC1）：无会话 → AUTH_REQUIRED(401)；缺公司/团队选择 →
//     TENANT_REQUIRED / WORKSPACE_REQUIRED(400)——工厂在建立期拒绝，路由
//     不再落任何默认范围。
//   - 越权不可见（AC1）：上下文建立后，对象归属由**服务自己的授权**判定
//     （authorizedConversation / service.list 按 scope 过滤）；无权对象按
//     canonical 不可见语义回答（CONVERSATION_NOT_FOUND → 404 not_found，
//     与不存在同形）。旧 resolveForThread 的跨公司扇出定位从本入口移除
//     ——那是另一套可见性判断。
//   - DTO 兼容（AC3）：错误映射逐字节复用 conversations/routes 的
//     enterpriseConversationErrorResponse（仅补充工厂新增的两个 canonical
//     缺上下文码），服务调用与服务契约不变。
//
// 工作范围入口清单（workspace-scope 面）在 ENTERPRISE_ENTRY_DISPOSITIONS
// 如实登记其上下文形态：列出半边是登录发现面（无选择头，共享会话解析闭包
// ——工厂建立需要选择头，发现面在能力上不消费它）；管理半边是公司管理面
// （MT075 分类守卫 + CompanyAdminContext——面分离是规则，不是漂移）。
// 处置表由 MT001 清单消费回写（AC4）。

import { type Context, Hono } from "hono";
import type {
  AppendMessageInput,
  ConversationDTO,
  ConversationService,
  PlatformScope,
} from "../contracts";
import { enterpriseConversationErrorResponse } from "../conversations/routes";
import type { DeploymentEntryBusiness } from "./entry-context";

/** 统一建立失败时路由读业务依赖的唯一失败方式（fail-closed，无默认范围）。 */
export const ENTERPRISE_ENTRY_CONTEXT_REQUIRED =
  "ENTERPRISE_ENTRY_CONTEXT_REQUIRED";

export type EnterpriseConversationEntryService = ConversationService & {
  list(scope: PlatformScope): Promise<ConversationDTO[]>;
};

export type EnterpriseEntryAssemblyInput = Readonly<{
  /** 与部署主入口同一个工厂（AC2：同一实现，不是平行构造）。 */
  readonly factory: EnterpriseEntryContextFactory;
  readonly service: EnterpriseConversationEntryService;
}>;

/** 与 DeploymentEntryContextFactory 同形（index.ts 装配传同一个实例）。 */
export type EnterpriseEntryContextFactory = {
  fromRequest(request: Request): Promise<DeploymentEntryBusiness>;
};

/**
 * 企业会话入口的统一装配路由（挂载 /api/enterprise/conversations）。
 * 每条路由的第一件事都是同一件：经共享工厂建立请求上下文。
 */
export function createEnterpriseConversationEntryRoutes({
  factory,
  service,
}: EnterpriseEntryAssemblyInput): Hono {
  const routes = new Hono();

  /** 统一建立：工厂拒绝即路由拒绝，路由层零自己的可见性判断。 */
  async function establish(request: Request): Promise<DeploymentEntryBusiness> {
    const business = await factory.fromRequest(request);
    // 工厂契约从不返回空（拒绝即抛 canonical 码）；此守卫是 fail-closed 哨兵。
    if (!business) throw new Error(ENTERPRISE_ENTRY_CONTEXT_REQUIRED);
    return business;
  }

  /**
   * 错误映射与 conversations/routes 逐字节共享；仅补充工厂建立期的两个
   * canonical 缺上下文码（TENANT_REQUIRED / WORKSPACE_REQUIRED → 400，
   * 与部署主入口中间件同形——共享映射本身没有这两个码，因为旧路由的
   * 建立面从不缺选择头）。
   */
  const respond = (context: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "TENANT_REQUIRED" || message === "WORKSPACE_REQUIRED") {
      return context.json({ error: { code: "invalid_request", message } }, 400);
    }
    const response = enterpriseConversationErrorResponse(error);
    return context.json(
      response.body,
      response.status as 400 | 401 | 403 | 404 | 409 | 500 | 503,
    );
  };

  routes.get("/", async (context) => {
    try {
      const business = await establish(context.req.raw);
      return context.json(await service.list(business.scope));
    } catch (error) {
      return respond(context, error);
    }
  });

  routes.post("/", async (context) => {
    try {
      const business = await establish(context.req.raw);
      const input = await jsonObject(context.req.raw);
      if (
        Object.keys(input).some((key) => key !== "title") ||
        (input.title !== undefined && typeof input.title !== "string")
      )
        throw new Error("INVALID_REQUEST");
      return context.json(
        await service.getOrCreate(
          business.scope,
          typeof input.title === "string" ? { title: input.title } : {},
        ),
        201,
      );
    } catch (error) {
      return respond(context, error);
    }
  });

  routes.get("/:threadId/messages", async (context) => {
    try {
      const business = await establish(context.req.raw);
      const before = context.req.query("before_seq");
      const limit = context.req.query("limit");
      return context.json(
        await service.history(business.scope, {
          threadId: context.req.param("threadId"),
          beforeSeq: before === undefined ? null : Number(before),
          limit: limit === undefined ? 50 : Number(limit),
        }),
      );
    } catch (error) {
      return respond(context, error);
    }
  });

  routes.post("/:threadId/messages", async (context) => {
    try {
      const business = await establish(context.req.raw);
      const body = await jsonObject(context.req.raw);
      if (
        typeof body.clientMessageKey !== "string" ||
        typeof body.content !== "string" ||
        !Array.isArray(body.attachments) ||
        body.attachments.some((id) => typeof id !== "string")
      )
        throw new Error("INVALID_REQUEST");
      const input: AppendMessageInput = {
        threadId: context.req.param("threadId"),
        clientMessageKey: body.clientMessageKey,
        content: body.content,
        attachments: body.attachments as string[],
      };
      return context.json(await service.append(business.scope, input), 201);
    } catch (error) {
      return respond(context, error);
    }
  });

  return routes;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 入口清单处置表（AC4：MT001 清单消费回写）
// ---------------------------------------------------------------------------

/** 一个企业入口的上下文处置记录。 */
export type EnterpriseEntranceDisposition = Readonly<{
  /** 清单 id 同形："METHOD path"。 */
  readonly entrance: string;
  /** "unified-entry-context"=共享工厂；"shared-session-resolution"=发现面；
   *  "company-admin-context"=公司管理面（MT075）。 */
  readonly establishment:
    | "unified-entry-context"
    | "shared-session-resolution"
    | "company-admin-context";
  /** 对象可见性由谁判定："service-authorized"=服务自己的授权（不可见语义）。 */
  readonly visibility:
    | "service-authorized"
    | "own-listing"
    | "plane-classified";
  readonly ownerTicket: "MT124" | "MT075";
}>;

/**
 * 企业入口逐路由处置（AC4 的事实源；inventory.ts 据此回写 ownerTicket）。
 * 会话四路由 = MT124 统一上下文；工作范围列出 = 登录发现面（共享会话解析，
 * 无选择头——工厂建立需要选择头，发现面不消费）；管理四路由 = MT075 公司
 * 管理面（分类守卫 + CompanyAdminContext）。
 */
export const ENTERPRISE_ENTRY_DISPOSITIONS: readonly EnterpriseEntranceDisposition[] =
  Object.freeze([
    {
      entrance: "GET /api/enterprise/conversations",
      establishment: "unified-entry-context",
      visibility: "service-authorized",
      ownerTicket: "MT124",
    },
    {
      entrance: "POST /api/enterprise/conversations",
      establishment: "unified-entry-context",
      visibility: "service-authorized",
      ownerTicket: "MT124",
    },
    {
      entrance: "GET /api/enterprise/conversations/:threadId/messages",
      establishment: "unified-entry-context",
      visibility: "service-authorized",
      ownerTicket: "MT124",
    },
    {
      entrance: "POST /api/enterprise/conversations/:threadId/messages",
      establishment: "unified-entry-context",
      visibility: "service-authorized",
      ownerTicket: "MT124",
    },
    {
      entrance: "GET /api/enterprise/workspace-scope",
      establishment: "shared-session-resolution",
      visibility: "own-listing",
      ownerTicket: "MT124",
    },
    {
      entrance: "POST /api/enterprise/workspace-scope/admin/teams",
      establishment: "company-admin-context",
      visibility: "plane-classified",
      ownerTicket: "MT075",
    },
    {
      entrance:
        "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members",
      establishment: "company-admin-context",
      visibility: "plane-classified",
      ownerTicket: "MT075",
    },
    {
      entrance:
        "POST /api/enterprise/workspace-scope/admin/teams/:workspaceId/members/:principalId/suspend",
      establishment: "company-admin-context",
      visibility: "plane-classified",
      ownerTicket: "MT075",
    },
    {
      entrance:
        "DELETE /api/enterprise/workspace-scope/admin/teams/:workspaceId/members/:principalId",
      establishment: "company-admin-context",
      visibility: "plane-classified",
      ownerTicket: "MT075",
    },
  ]);
