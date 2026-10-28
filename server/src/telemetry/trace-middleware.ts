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
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { extractRequestContext } from "../../../shared/trace";
import type { RequestTrackingVariables } from "./request-tracking";

export function createTraceMiddleware(): MiddlewareHandler<{
  Variables: RequestTrackingVariables;
}> {
  const tracer = trace.getTracer("openbot.http");
  return async (context_, next) => {
    const remote = extractRequestContext(context_.req.raw);
    // SERVER, not the default INTERNAL: only a server span pairs with the caller's client
    // span, and only server spans feed the http.server.* metrics and the SERVER sampling rules.
    const span = tracer.startSpan(
      `${context_.req.method} ${context_.req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": context_.req.method,
          "url.path": context_.req.path,
        },
      },
      remote,
    );
    try {
      await context.with(trace.setSpan(remote, span), next);
      // The route template, once the router resolved it: naming spans after raw paths
      // (`/api/users/123/orders/456`) makes every request its own series in the backend.
      const routePath = context_.req.routePath;
      if (routePath && routePath !== "*")
        span.updateName(`${context_.req.method} ${routePath}`);
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
