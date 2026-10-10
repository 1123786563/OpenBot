/**
 * Trace context helpers and per-process tracing init, the observability P2 foundation.
 *
 * The four helpers wrap the OpenTelemetry API so call sites never touch `propagation`
 * or the global tracer directly: inbound requests extract a W3C `traceparent` into a
 * `Context`, outbound calls inject the active trace back into headers, and anything
 * can name the trace it ran under. `initProcessTracing` registers the NodeTracerProvider
 * once per process — with an OTLP/HTTP batch exporter when an endpoint is configured,
 * recording-only otherwise — and is safe to call from every process's boot path.
 *
 * Never fatal and off by default: without a traces endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
 * or the generic `OTEL_EXPORTER_OTLP_ENDPOINT`) spans are still recorded, just never exported,
 * and `OPENBOT_TRACES=off` disables the whole thing with an endpoint still set.
 */
import { type Context, context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";

/**
 * The tracing-relevant slice of a process environment. The index signature is what
 * keeps `process.env` assignable at boot call sites — without it the named properties
 * alone form a weak type Bun's `ProcessEnv` shares nothing with and TypeScript refuses.
 */
export type TraceProcessEnv = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OPENBOT_TRACES?: string;
} & Record<string, string | undefined>;

/**
 * The remote parent context carried by a request's W3C `traceparent` (and `tracestate`)
 * headers, extracted case-insensitively through the Headers object. Without the headers
 * the returned context is the active one, so a span started from it roots a fresh trace.
 */
export function extractRequestContext(request: { headers: Headers }): Context {
  return propagation.extract(context.active(), request.headers, {
    get: (carrier, key) => carrier.get(key) ?? undefined,
    keys: (carrier) => [...carrier.keys()],
  });
}

/**
 * The active trace's `traceparent`, injected into the given header record (which is
 * mutated and returned, so callers can pass the headers they already build). Throwaway
 * when nothing is active: the record comes back as it went in.
 */
export function injectTraceHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * The active span's trace id, or undefined when nothing valid is active — no provider,
 * an invalid placeholder context, whatever else would make the id meaningless.
 */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && trace.isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
}

/** The provider this process registered, the idempotence guard for init/shutdown. */
let provider: NodeTracerProvider | undefined;
/** Whether this process ever installed the API globals (propagator, context manager). */
let globalsRegistered = false;

/**
 * Register this process's tracer provider, once. `OPENBOT_TRACES=off` leaves tracing
 * entirely unregistered; otherwise the provider records spans under `service.name`,
 * exporting them through the OTLP/HTTP batch processor when an endpoint is configured:
 * the signal-level `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` verbatim (it may carry the full
 * path), else the generic endpoint with the trace path appended.
 */
export function initProcessTracing(name: string, env: TraceProcessEnv): void {
  if (provider) return;
  if (env.OPENBOT_TRACES?.trim().toLowerCase() === "off") return;

  const tracesEndpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    (env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.trim().replace(/\/$/, "")}/v1/traces`
      : undefined);
  const instance = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": name }),
    spanProcessors: tracesEndpoint
      ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesEndpoint }))]
      : [],
  });
  // SDK 2.x registers processors through the constructor; addSpanProcessor is gone.
  // The first registration installs the W3C propagator and the AsyncLocalStorage
  // context manager with it. Both are stateless and outlive any single provider, so
  // a registration after a shutdownTracing (tests) skips them — the API refuses a
  // duplicate for either — and only rebinds the tracer.
  instance.register(
    globalsRegistered ? { contextManager: null, propagator: null } : {},
  );
  globalsRegistered = true;
  provider = instance;
}

/**
 * Flush and retire this process's tracing: the batch processor exports what it holds,
 * then the API's global trace slot is unbound, because it refuses a second provider and
 * a shut-down provider would record nothing. This is what a graceful process exit calls
 * and what tests call between cases.
 */
export async function shutdownTracing(): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;
  try {
    await current.shutdown();
  } finally {
    trace.disable();
  }
}
