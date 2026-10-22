// server/src/enterprise/tenancy/assembly-legacy.ts
// MT125（Issue #168）：旧 REST、Copilot 与移动聚合入口装配与兼容。
//
// 票面语义：旧 REST、Copilot 与移动聚合入口接入同一规则——旧接口不能
// 成为绕过新规则的旁路，同时保持既有兼容（路径、状态码与 DTO 不变）。
//
// 结构（三件，与 MT124 同款装配纪律）：
//
//   1. 移动聚合统一入口（唯一可立即隔离的入口族）：createMobileAggregation-
//      EntryRoutes——GET /api/mobile/openmuse-aggregate 经**与部署主入口
//      同一个** DeploymentEntryContextFactory 建立请求上下文（同一签发
//      WeakSet、同一成员资格 DB 重验、同一 canonical 拒绝码），聚合读取
//      骑 MT066（Issue #109）交付的 readMobileAggregate（每个子查询独立
//      经协会门过滤——scope 服务自己的授权，不是部署级默认）。
//   2. 入口处置表 LEGACY_ENTRY_DISPOSITIONS（AC3/AC4 的事实源）：三个
//      入口族的每个入口一行——establishment 闭集
//        unified-entry-context  已接统一上下文（本票装配）
//        registered-exception   无法立即隔离，显式登记例外（带理由；
//                              底层 store 是部署级，范围化属其归属票）
//        explicitly-closed      多租户模式下显式关闭（当前无——关闭是
//                              语义不是姿态，不虚构被关闭的入口）
//      未登记例外零隐式放行：表覆盖三族的全部清单入口（测试钉死与
//      buildInventory 的差集为空），inventory.ts 据此回写 ownerTicket。
//   3. 守卫 createLegacyEntryGuard：多租户模式下对三族入口逐请求执法——
//      explicitly-closed → 503 稳定码；registered-exception / unified →
//      放行到入口自身（例外的理由在处置表与清单里，不在请求路径上撒
//      谎）。不在表上的请求不属于本票入口族（其归属由 MT001 清单全局
//      强制：unowned 入口阻断多租户启动）。守卫只在多租户模式挂载——
//      单租户模式逐字节原行为（AC2 兼容半边的结构保证）。
//
// 兼容（AC2）：既有入口零改动——本模块不触碰 BFF/Copilot/channels/
// threads 的路由构造器；对照测试以「守卫前 vs 守卫后同请求同响应」钉死。
// Copilot 的 per-scope 半边已部分存在（workbench payer 绑定在 MT122 中间
// 件之后取 entry business——app.ts 09.2）；完全范围化属 runner 自身的
// 归属票，此处按 registered-exception 如实登记。

import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { DeploymentEntryBusiness } from "./entry-context";
import type { OpenMuseVoiceMobileTenancyService } from "./openmuse-voice-mobile-tenancy";

/** 统一建立失败时路由读业务依赖的唯一失败方式（fail-closed，无默认范围）。 */
export const LEGACY_ENTRY_CONTEXT_REQUIRED = "LEGACY_ENTRY_CONTEXT_REQUIRED";

/** 守卫关闭入口的稳定响应码（AC3：显式关闭不留隐式放行）。 */
export const LEGACY_ENTRANCE_CLOSED = "LEGACY_ENTRANCE_CLOSED";

/** 与 DeploymentEntryContextFactory 同形（index.ts 装配传同一个实例）。 */
export type LegacyEntryContextFactory = {
  fromRequest(request: Request): Promise<DeploymentEntryBusiness>;
};

/** MT066 聚合读取半边（服务自己的授权；本模块只建立上下文）。 */
export type MobileAggregateService = Pick<
  OpenMuseVoiceMobileTenancyService,
  "readMobileAggregate"
>;

/** 移动聚合统一装配路由（挂载 /api/mobile，GET openmuse-aggregate）。 */
export function createMobileAggregationEntryRoutes({
  factory,
  service,
}: {
  readonly factory: LegacyEntryContextFactory;
  readonly service: MobileAggregateService;
}): Hono {
  const routes = new Hono();

  /**
   * 错误映射与 MT124 共享形状：工厂建立期的 canonical 缺上下文码 →
   * 400；未认证 → 401；其余（成员资格拒绝等）→ 403。聚合本体是
   * MT066 的白名单数据形（跨范围子集合为空，不存在 deny 正文——
   * 不可见语义在服务的过滤里，不在入口的错误映射里）。
   */
  const respond = (context: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "AUTH_REQUIRED") {
      return context.json({ error: { code: "unauthenticated", message } }, 401);
    }
    if (message === "TENANT_REQUIRED" || message === "WORKSPACE_REQUIRED") {
      return context.json({ error: { code: "invalid_request", message } }, 400);
    }
    return context.json({ error: { code: "forbidden", message } }, 403);
  };

  routes.get("/openmuse-aggregate", async (context) => {
    let aggregate: Awaited<
      ReturnType<MobileAggregateService["readMobileAggregate"]>
    >;
    try {
      const business = await factory.fromRequest(context.req.raw);
      if (!business) throw new Error(LEGACY_ENTRY_CONTEXT_REQUIRED);
      const limit = context.req.query("limit");
      aggregate = await service.readMobileAggregate(business.scope, {
        limit: limit === undefined ? undefined : Number(limit),
      });
    } catch (error) {
      return respond(context, error);
    }
    return context.json(aggregate);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// 入口处置表（AC3/AC4：单一事实源；inventory.ts 消费回写）
// ---------------------------------------------------------------------------

/** 一个旧入口族的入口处置记录。 */
export type LegacyEntranceDisposition = Readonly<{
  /** 清单 id 同形："METHOD path"（:param 形与路由表一致）。 */
  readonly entrance: string;
  readonly family: "legacy-rest" | "copilot" | "mobile-aggregation";
  /** "unified-entry-context"=已接统一上下文；"registered-exception"=显式
   *  登记例外（带理由）；"explicitly-closed"=多租户模式显式关闭。 */
  readonly establishment:
    | "unified-entry-context"
    | "registered-exception"
    | "explicitly-closed";
  /** 例外与关闭必须携带理由（审计面；unified 不需要）。 */
  readonly reason?: string;
  readonly ownerTicket: "MT125";
}>;

/** 旧 REST 族（channels/threads）按 store 语义分组的例外理由。 */
const LEGACY_REST_READ_REASON =
  "the channels/threads REST rides deployment-scoped stores (channelStore, thread reader); per-scope filtering lands with the channels tenancy wiring — registered, never silently passed";
const MOBILE_BFF_REASON =
  "the mobile BFF aggregates deployment-scoped stores (roster, channel provisioning, approvals); the scope-filtered aggregation entrance (GET /api/mobile/openmuse-aggregate, MT066) is the tenancy-safe read on this family";

/**
 * 三入口族逐入口处置（AC4 的事实源）。GET /api/channels/events 是流式
 * 入口（upgradeWebSocket），归 MT126 的流式处置表（SSE/WS 面），此处不
 * 重复登记——两个表各自闭集，不互相覆盖。
 */
export const LEGACY_ENTRY_DISPOSITIONS: readonly LegacyEntranceDisposition[] =
  Object.freeze([
    // ---- 移动聚合族：BFF 四入口（例外）+ 聚合统一入口 ----
    {
      entrance: "GET /api/mobile/workspace",
      family: "mobile-aggregation",
      establishment: "registered-exception",
      reason: MOBILE_BFF_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/mobile/conversations",
      family: "mobile-aggregation",
      establishment: "registered-exception",
      reason: MOBILE_BFF_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/mobile/openmuse-bot",
      family: "mobile-aggregation",
      establishment: "registered-exception",
      reason: MOBILE_BFF_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "GET /api/mobile/activity",
      family: "mobile-aggregation",
      establishment: "registered-exception",
      reason: MOBILE_BFF_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "GET /api/mobile/openmuse-aggregate",
      family: "mobile-aggregation",
      establishment: "unified-entry-context",
      ownerTicket: "MT125",
    },
    // ---- Copilot 族：vendor runtime，两入口（例外） ----
    {
      entrance: "ALL /api/copilotkit",
      family: "copilot",
      establishment: "registered-exception",
      reason:
        "the CopilotKit runtime owns its own routing behind the session guard; its workbench payer binding already rides the MT122 entry business — full per-scope filtering lands with the runner's own attribution ticket",
      ownerTicket: "MT125",
    },
    {
      entrance: "ALL /api/copilotkit/*",
      family: "copilot",
      establishment: "registered-exception",
      reason:
        "the CopilotKit runtime owns its own routing behind the session guard; its workbench payer binding already rides the MT122 entry business — full per-scope filtering lands with the runner's own attribution ticket",
      ownerTicket: "MT125",
    },
    // ---- 旧 REST 族：channels + threads（GET /api/channels/events 归 MT126）----
    {
      entrance: "ALL /api/channels/*",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "GET /api/channels",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "GET /api/channels/:channelId",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "PATCH /api/channels/:channelId",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "DELETE /api/channels/:channelId",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels/:channelId/activity",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels/:channelId/archive",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels/:channelId/unarchive",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels/:channelId/attachments",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/channels/:channelId/busy",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "PUT /api/channels/:channelId/pin",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "PUT /api/channels/:channelId/read",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "GET /api/threads/:threadId",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
    {
      entrance: "POST /api/threads/mint",
      family: "legacy-rest",
      establishment: "registered-exception",
      reason: LEGACY_REST_READ_REASON,
      ownerTicket: "MT125",
    },
  ] satisfies readonly LegacyEntranceDisposition[]);

// ---------------------------------------------------------------------------
// 守卫（AC3：显式关闭不留隐式放行；AC2：单租户零行为变化）
// ---------------------------------------------------------------------------

/** 处置表按行编译成 形匹配（":param" 段通配）。 */
function entranceMatches(
  entrance: string,
  method: string,
  path: string,
): boolean {
  const spaceAt = entrance.indexOf(" ");
  const entranceMethod = entrance.slice(0, spaceAt);
  const entrancePath = entrance.slice(spaceAt + 1);
  if (entranceMethod !== "ALL" && entranceMethod !== method) return false;
  const expected = entrancePath.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every(
    (segment, index) => segment.startsWith(":") || segment === actual[index],
  );
}

/**
 * 多租户模式下的旧入口守卫：逐请求对照处置表执法。closed → 503 稳定码
 * （拒绝不是放行加日志）；exception/unified → 放行（例外理由已在表与清
 * 单，unified 入口自己建立上下文——fail-closed 在路由内）。不在表上的
 * 请求不是本票入口族（MT001 清单的 unowned 阻断是全局闸）。
 */
export function createLegacyEntryGuard(
  dispositions: readonly LegacyEntranceDisposition[] = LEGACY_ENTRY_DISPOSITIONS,
): MiddlewareHandler {
  const closed = dispositions.filter(
    (row) => row.establishment === "explicitly-closed",
  );
  return async (context, next) => {
    const method = context.req.method;
    const path = context.req.path;
    for (const row of closed) {
      if (entranceMatches(row.entrance, method, path)) {
        return context.json(
          {
            error: {
              code: LEGACY_ENTRANCE_CLOSED,
              message: `entrance ${method} ${path} is explicitly closed in multitenancy mode (${row.reason ?? "no reason recorded — that is a disposition-table bug"})`,
            },
          },
          503,
        );
      }
    }
    return next();
  };
}
