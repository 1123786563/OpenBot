/**
 * Per-request correlation for the main deployment app: every response carries an
 * `x-request-id`, and every log emitted while a request is in flight can pick that
 * id up through the ambient store instead of threading a parameter through every
 * handler. The id is server-minted unless the caller sent a well-formed one, so a
 * hostile header cannot smuggle junk into Loki; that matches the tenancy plan's
 * rule (TEN-22) that logs correlate by server-generated ids. When a trace span is
 * active above the store (the inbound trace middleware), the same logs also carry
 * its `trace_id`, tying a log line to the distributed trace it happened in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "../../../shared/logger";
import { currentTraceId } from "../../../shared/trace";

export type RequestTrackingVariables = { requestId?: string };

const INBOUND_ID = /^[A-Za-z0-9._-]{8,128}$/;

const requestStore = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

export function requestScopedLogger(root: Logger): Logger {
  const requestId = currentRequestId();
  if (!requestId) return root;
  const traceId = currentTraceId();
  return traceId
    ? root.child({ request_id: requestId, trace_id: traceId })
    : root.child({ request_id: requestId });
}

/**
 * The pair must be mounted in one order: `requestId` OUTSIDE `accessLog`. The access line reads
 * the request id from the ambient store, which `requestId` has already exited if the order is
 * reversed — the line then silently loses `request_id`/`trace_id`. Mount them with
 * {@link createRequestTracking} callers' `app.use` order: requestId first.
 */
export function createRequestTracking(options: { logger: Logger }): {
  requestId: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
  accessLog: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
} {
  const requestId: MiddlewareHandler<{
    Variables: RequestTrackingVariables;
  }> = async (context, next) => {
    const inbound = context.req.header("x-request-id");
    const id = inbound && INBOUND_ID.test(inbound) ? inbound : randomUUID();
    context.header("x-request-id", id);
    context.set("requestId", id);
    await requestStore.run({ requestId: id }, next);
  };

  const accessLog: MiddlewareHandler<{
    Variables: RequestTrackingVariables;
  }> = async (context, next) => {
    const start = performance.now();
    const line = (status: number) =>
      // Logs even when a handler throws, so 5xx requests keep their access line. On a throw
      // the status is the error's own when it carries one (an HTTPException), else 500.
      requestScopedLogger(options.logger).info(
        {
          method: context.req.method,
          path: context.req.path,
          status,
          duration_ms: Math.round(performance.now() - start),
        },
        "request",
      );
    try {
      await next();
      line(context.res.status);
    } catch (error) {
      const status = error instanceof HTTPException ? error.status : 500;
      line(status);
      throw error;
    }
  };

  return { requestId, accessLog };
}
