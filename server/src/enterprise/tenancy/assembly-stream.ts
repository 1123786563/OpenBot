// server/src/enterprise/tenancy/assembly-stream.ts
// MT126（Issue #169）：流式与长连接入口的上下文与订阅授权装配。
//
// 票面语义：SSE、WebSocket 与长连接入口在建连、续订与重连时都建立并
// 校验上下文，订阅按订阅者权限过滤，切换范围后旧连接被终止。
//
// 结构（消费 MT025（Issue #68）交付的订阅判定面，不复制其可见性判断）：
//
//   1. 流式统一入口 createStreamEntryRoutes——三条路由全部经**与部署主
//      入口同一个** DeploymentEntryContextFactory 建立请求上下文（同一
//      签发 WeakSet、同一成员资格 DB 重验、同一 canonical 拒绝码）：
//        POST   /:threadId/subscription            建连判定（AC1）：
//              工厂上下文 + openSubscription 的会话可见门（目标会话对本
//              scope 不可见 = canonical not-found）；同一 principal 在其
//              他 workspace 的活跃订阅同时被关闭（AC4 的收旧半边，MT025
//              交付语义）。
//        GET    /subscriptions/:id/events          SSE 长连接（AC1/AC2/AC3）：
//              重连也重新过工厂；探针帧（connected status 事件）在开流
//              前强制重验订阅者事实——撤权/取消/切换范围 ⇒ 终止（closed
//              → 403 稳定码；订阅不存在/他租户 ⇒ canonical 404 与不存
//              在同形）。流上每一帧都经 pushEvent 重验（订阅行活跃 +
//              订阅者当前事实）；正文是 MT025 的白名单闭形 {type,status,
//              message}——构造面不可表达更多字段（AC2 形状保证，装配
//              不加字段）。
//        DELETE /subscriptions/:id                 取消订阅（连接终止面）。
//   2. 事务纪律（AC3）：装配层不持有任何数据库事务跨网络等待——三条路
//      由的每次判定都是 MT025 服务自身的短事务（open/push/cancel 各自
//      开-提交），SSE 循环里「等待下一事件」的网络 await 期间没有任何
//      打开的事务（装配代码零 business.transaction 调用——测试以会抛
//      的事务探针钉死）。
//   3. 入口处置表 STREAM_ENTRY_DISPOSITIONS（AC4 的事实源）：清单登记
//      的全部流式入口逐个处置——统一装配三入口 + 既有五个 SSE/WS 入口
//      按其既有授权形态登记例外（升级期授权已存在的注明；范围化属各自
//      家族票），inventory.ts 据此回写 ownerTicket。
//
// 边界（诚实披露）：
//   - 真实传输（Bun serve websocket / 事件总线背压）不在本票：SSE 半边
//     以注入的 StreamEventPort 驱动（生产接线票把事件总线接到端口上），
//     判定与终止语义全部真实（MT025 服务 + 真实 RLS）。
//   - WS 升级入口（电脑流/HMR）在 serve() 层带各自的升级期授权（MT126
//     处置表如实登记，不重复实现）；其 per-scope 上下文属各自家族票。

import { type Context, Hono } from "hono";
import type { PlatformScope } from "../contracts";
import type { DeploymentEntryBusiness } from "./entry-context";
import type {
  PushOutcome,
  StreamEventBody,
  StreamSubscriptionService,
  StreamVerdict,
} from "./streams";

/** 统一建立失败时路由读业务依赖的唯一失败方式（fail-closed，无默认范围）。 */
export const STREAM_ENTRY_CONTEXT_REQUIRED = "STREAM_ENTRY_CONTEXT_REQUIRED";

/** SSE 探针帧判定的「订阅者事实已死」稳定码（撤权/取消/切换范围）。 */
export const STREAM_SUBSCRIPTION_CLOSED = "STREAM_SUBSCRIPTION_CLOSED";

/** 与 DeploymentEntryContextFactory 同形（index.ts 装配传同一个实例）。 */
export type StreamEntryContextFactory = {
  fromRequest(request: Request): Promise<DeploymentEntryBusiness>;
};

/**
 * 事件端口：装配层与传输层的唯一接缝。nextEvent 是网络半边——装配在
 * await 它期间不持有任何数据库事务（AC3）；null = 流自然结束。
 */
export interface StreamEventPort {
  nextEvent(subscriptionId: string): Promise<StreamEventBody | null>;
}

/** SSE 帧序列化（正文 = MT025 白名单闭形逐字节 JSON，不加字段）。 */
function sseFrame(body: StreamEventBody): string {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}

/**
 * 流式统一装配路由（挂载 /api/enterprise/streams）。
 */
export function createStreamEntryRoutes({
  factory,
  service,
  events,
}: {
  readonly factory: StreamEntryContextFactory;
  readonly service: Pick<
    StreamSubscriptionService,
    "openSubscription" | "pushEvent" | "cancelSubscription"
  >;
  readonly events: StreamEventPort;
}): Hono {
  const routes = new Hono();

  /**
   * 错误映射与 MT124/MT125 共享形状：canonical 缺上下文码 → 400；
   * 未认证 → 401；canonical not-found 判定（MT011 冻结实例的 outcome
   * 形）→ 404 与不存在同形；其余 → 403。
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

  const notFound = (context: Context) =>
    context.json(
      { error: { code: "not_found", message: "RESOURCE_NOT_FOUND" } },
      404,
    );

  const subscriptionIdOf = (
    verdict: StreamVerdict<{ subscriptionId: string }>,
  ): string => ("subscriptionId" in verdict ? verdict.subscriptionId : "");

  const isNotFound = (verdict: StreamVerdict<unknown> | PushOutcome) =>
    "outcome" in verdict && verdict.outcome === "deny";

  /** 建立期上下文（每条路由第一件事；失败即路由失败，无默认范围）。 */
  const establishScope = async (request: Request): Promise<PlatformScope> => {
    const business = await factory.fromRequest(request);
    if (!business) throw new Error(STREAM_ENTRY_CONTEXT_REQUIRED);
    return business.scope;
  };

  // ---- 建连判定（AC1：上下文 + 订阅授权；AC4 收旧半边在服务内） ----
  routes.post("/:threadId/subscription", async (context) => {
    let scope: PlatformScope;
    try {
      scope = await establishScope(context.req.raw);
    } catch (error) {
      return respond(context, error);
    }
    let verdict: StreamVerdict<{ subscriptionId: string }>;
    try {
      verdict = await service.openSubscription(scope, {
        threadId: context.req.param("threadId"),
      });
    } catch (error) {
      return respond(context, error);
    }
    if (isNotFound(verdict)) return notFound(context);
    return context.json({ subscription_id: subscriptionIdOf(verdict) }, 201);
  });

  // ---- SSE 长连接（AC1/AC2/AC3：重连重验 + 逐帧重验 + 零跨网络事务） ----
  routes.get("/subscriptions/:subscriptionId/events", async (context) => {
    let scope: PlatformScope;
    try {
      scope = await establishScope(context.req.raw);
    } catch (error) {
      return respond(context, error);
    }
    const subscriptionId = context.req.param("subscriptionId");
    // 探针帧：开流前强制重验（撤权/取消/切换范围 ⇒ 终止，不进流）。
    let probe: PushOutcome;
    try {
      probe = await service.pushEvent(scope, subscriptionId, {
        type: "status",
        status: "ok",
        message: "connected",
      });
    } catch (error) {
      return respond(context, error);
    }
    if (isNotFound(probe)) return notFound(context);
    if (probe.outcome === "closed") {
      return context.json(
        {
          error: {
            code: STREAM_SUBSCRIPTION_CLOSED,
            message:
              "the subscriber facts no longer hold (revoked, cancelled or scope switched) — the connection is terminated",
          },
        },
        403,
      );
    }

    /*
     * 客户端离开的传播面（fix2）：cancel() 是流对「读端已消失」的唯一通
     * 知。离开信号立刻唤醒等待中的循环（不等下一个事件到来），此后任何
     * 迟到的事件都直接丢弃——绝不再过判定面，也绝不再投递。
     */
    let departed = false;
    let signalDeparture: (() => void) | null = null;
    const departure = new Promise<null>((resolve) => {
      signalDeparture = () => resolve(null);
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          // 探针帧即首帧（真实 push 判定过的正文）。
          controller.enqueue(encoder.encode(sseFrame(probe.body)));
          for (;;) {
            if (departed) break;
            /*
             * 背压检查（fix2）：desiredSize ≤ 0 = 消费端队列已满（探针帧
             * 还没被读走）；null = 流已关/已取消。满了就等消费者腾出空间
             * 再拉下一个事件——不把无界的事件队列堆给一个不读的客户端；
             * 等待期间离开信号随时可以打断。
             */
            for (
              let size = controller.desiredSize;
              size !== null && size <= 0 && !departed;
              size = controller.desiredSize
            ) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (departed) break;
            // 网络半边：等待下一事件。此刻没有打开的事务（AC3）。等待与
            // 离开信号赛跑——读端消失时循环立即释放，不等下一个事件。
            const next = events.nextEvent(subscriptionId);
            next.catch(() => {}); // 输掉赛跑后端口的拒绝不是循环的问题
            const body = await Promise.race([next, departure]);
            if (body === null || departed) break;
            // 判定半边：短事务重验（订阅行 + 订阅者事实）。
            const outcome = await service.pushEvent(
              scope,
              subscriptionId,
              body,
            );
            if (outcome.outcome !== "delivered") break; // closed/notFound → 终止
            controller.enqueue(encoder.encode(sseFrame(outcome.body)));
          }
        } catch {
          // 传输端异常：流结束（判定面无默认放行）。
        } finally {
          // 读端已取消时流已闭——close() 会抛，那不是要上报的异常。
          try {
            controller.close();
          } catch {
            // already closed by cancellation
          }
        }
      },
      cancel() {
        departed = true;
        signalDeparture?.();
      },
    });
    return context.body(stream, 200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  // ---- 取消订阅（连接终止面） ----
  routes.delete("/subscriptions/:subscriptionId", async (context) => {
    let scope: PlatformScope;
    try {
      scope = await establishScope(context.req.raw);
    } catch (error) {
      return respond(context, error);
    }
    let verdict: StreamVerdict<{ subscriptionId: string }>;
    try {
      verdict = await service.cancelSubscription(
        scope,
        context.req.param("subscriptionId"),
      );
    } catch (error) {
      return respond(context, error);
    }
    if (isNotFound(verdict)) return notFound(context);
    return context.json({ subscription_id: subscriptionIdOf(verdict) });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// 入口处置表（AC4：单一事实源；inventory.ts 消费回写）
// ---------------------------------------------------------------------------

export type StreamEntranceDisposition = Readonly<{
  /** 清单 id 同形（serve-upgrade 入口是清单登记的原字符串，含正则面）。 */
  readonly entrance: string;
  /** "unified-entry-context"=本票装配；"registered-exception"=显式登记
   *  例外（既有授权形态注明，范围化属其家族票）。 */
  readonly establishment: "unified-entry-context" | "registered-exception";
  readonly reason?: string;
  readonly ownerTicket: "MT126";
}>;

const LEGACY_STREAM_REASON =
  "the entrance carries its own session-guarded authorization at connect (upgrade-time gate or guarded route); per-scope context and subscriber-permission filtering land with its owning family's tenancy wiring — registered, never silently passed";

/**
 * 清单登记的全部流式入口逐个处置（AC4 的事实源）。三个统一装配入口是
 * 本票交付；其余五个按既有授权形态登记例外。HMR 两个入口的 id 是
 * inventory 静态提取 WEBAPP_HMR_PATH 的原字符串形状（清单事实源）。
 */
export const STREAM_ENTRY_DISPOSITIONS: readonly StreamEntranceDisposition[] =
  Object.freeze([
    {
      entrance: "POST /api/enterprise/streams/:threadId/subscription",
      establishment: "unified-entry-context",
      ownerTicket: "MT126",
    },
    {
      entrance:
        "GET /api/enterprise/streams/subscriptions/:subscriptionId/events",
      establishment: "unified-entry-context",
      ownerTicket: "MT126",
    },
    {
      entrance: "DELETE /api/enterprise/streams/subscriptions/:subscriptionId",
      establishment: "unified-entry-context",
      ownerTicket: "MT126",
    },
    {
      entrance: "GET /api/channels/events",
      establishment: "registered-exception",
      reason: LEGACY_STREAM_REASON,
      ownerTicket: "MT126",
    },
    {
      entrance: "GET /api/craft/sessions/:sessionId/turns/:turnId/events",
      establishment: "registered-exception",
      reason: LEGACY_STREAM_REASON,
      ownerTicket: "MT126",
    },
    {
      entrance: "GET /api/workshop/:channelId/events",
      establishment: "registered-exception",
      reason: LEGACY_STREAM_REASON,
      ownerTicket: "MT126",
    },
    {
      entrance: "GET /api/workshop/:channelId/turns/:id/events",
      establishment: "registered-exception",
      reason: LEGACY_STREAM_REASON,
      ownerTicket: "MT126",
    },
    {
      entrance: "WS /api/computers/:botId/stream",
      establishment: "registered-exception",
      reason:
        "the computer-stream proxy authorizes at upgrade (authorizeStream: session actor + bot gate) before server.upgrade commits; per-scope context lands with the computer family's tenancy wiring",
      ownerTicket: "MT126",
    },
    {
      entrance: "WS /^\\/api",
      establishment: "registered-exception",
      reason:
        "the craft webapp HMR upgrade authorizes at upgrade (session actor + session gate); dev tooling channel — registered as-is until the craft family wires per-scope context",
      ownerTicket: "MT126",
    },
    {
      entrance: "WS <preview-host>/^\\/api",
      establishment: "registered-exception",
      reason:
        "the craft preview HMR upgrade authorizes at upgrade (preview pass + origin gate); dev tooling channel — registered as-is until the craft family wires per-scope context",
      ownerTicket: "MT126",
    },
  ] satisfies readonly StreamEntranceDisposition[]);
