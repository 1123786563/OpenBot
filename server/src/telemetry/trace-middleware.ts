/**
 * Inbound tracing for the main deployment app: every request runs inside a span
 * named `METHOD path`, parented by its W3C `traceparent` when one is present and
 * self-rooted when not. The span wraps the rest of the middleware chain, so the
 * ambient context it establishes is what `requestScopedLogger` reads the trace id
 * from and what a handler's own outbound calls continue — which is why this must be
 * registered after the request-id middleware and before the access log. The span
 * records `http.response.status_code` and takes the ERROR status when the handler
 * throws or answers 5xx; a thrown error still propagates, so Hono's own error
 * handling sees exactly what it would have seen unwrapped.
 */
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { extractRequestContext } from "../../../shared/trace";
import type { RequestTrackingVariables } from "./request-tracking";

export function createTraceMiddleware(): MiddlewareHandler<{
  Variables: RequestTrackingVariables;
}> {
  const tracer = trace.getTracer("openbot.http");
  return async (context_, next) => {
    const remote = extractRequestContext(context_.req.raw);
    const span = tracer.startSpan(
      `${context_.req.method} ${context_.req.path}`,
      {},
      remote,
    );
    try {
      await context.with(trace.setSpan(remote, span), next);
      const status = context_.res.status;
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(
        error instanceof Error
          ? error
          : { name: "Error", message: String(error) },
      );
      throw error;
    } finally {
      span.end();
    }
  };
}
