/**
 * Per-request correlation for the main deployment app: every response carries an
 * `x-request-id`, and every log emitted while a request is in flight can pick that
 * id up through the ambient store instead of threading a parameter through every
 * handler. The id is server-minted unless the caller sent a well-formed one, so a
 * hostile header cannot smuggle junk into Loki; that matches the tenancy plan's
 * rule (TEN-22) that logs correlate by server-generated ids.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../../shared/logger";

export type RequestTrackingVariables = { requestId?: string };

const INBOUND_ID = /^[A-Za-z0-9._-]{8,128}$/;

const requestStore = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

export function requestScopedLogger(root: Logger): Logger {
  const requestId = currentRequestId();
  return requestId ? root.child({ request_id: requestId }) : root;
}

export function createRequestTracking(options: {
  logger: Logger;
}): {
  requestId: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
  accessLog: MiddlewareHandler<{ Variables: RequestTrackingVariables }>;
} {
  const requestId: MiddlewareHandler<{ Variables: RequestTrackingVariables }> =
    async (context, next) => {
      const inbound = context.req.header("x-request-id");
      const id =
        inbound && INBOUND_ID.test(inbound) ? inbound : randomUUID();
      context.header("x-request-id", id);
      context.set("requestId", id);
      await requestStore.run({ requestId: id }, next);
    };

  const accessLog: MiddlewareHandler<{
    Variables: RequestTrackingVariables;
  }> = async (context, next) => {
    const start = performance.now();
    let status = 0;
    try {
      await next();
      status = context.res.status;
    } finally {
      // Logs even when a handler throws, so 5xx requests keep their access line;
      // an unhandled error surfaces as Hono's 500 fallback.
      requestScopedLogger(options.logger).info(
        {
          method: context.req.method,
          path: context.req.path,
          status: status || 500,
          duration_ms: Math.round(performance.now() - start),
        },
        "request",
      );
    }
  };

  return { requestId, accessLog };
}
