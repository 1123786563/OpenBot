// Trace context propagation and per-process tracing init for the Go
// runtime — the Go counterpart of the Bun side's shared/trace.ts, with the
// same env contract and span shape so a run's spans stitch into one trace
// across the platform↔runtime boundary.
//
// TraceMiddleware is the outermost layer of the runtime's HTTP chain: it
// extracts a W3C `traceparent` from the request headers, starts a span named
// `METHOD path` parented by it (self-rooted when absent), and serves the
// rest of the chain inside that span's context. The span records
// `http.response.status_code`, takes the ERROR status on a 5xx or a
// panicking handler, and lets the panic propagate untouched.
//
// InitTracing registers the process's tracer provider once at boot. It is
// never fatal and off by default, exactly as the Bun side: `OPENBOT_TRACES=off`
// leaves tracing entirely unregistered; otherwise spans are recorded under
// `service.name = runtime-go`, exported through the OTLP/HTTP exporter when an
// endpoint is configured — the signal-level `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
// verbatim (it may carry the full path), else the generic
// `OTEL_EXPORTER_OTLP_ENDPOINT` with the default trace path appended — and
// recorded without export when no endpoint is set. Outbound, the governed
// tool client injects the active trace into its headers (internal/callback).
package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// tracingServiceName is the resource identity every exported span from this
// process carries.
const tracingServiceName = "runtime-go"

// tracingTracerName matches the tracer the Bun side's withTraceFetch uses, so
// the two sides' spans are attributable to the same instrumentation.
const tracingTracerName = "openbot.http"

// TraceMiddleware is the outermost middleware: one span per request, named
// `METHOD path`, parented by the request's W3C `traceparent` when present and
// self-rooted when not. The tracer resolves per request from the global
// provider, so a boot-time InitTracing anywhere in the process is picked up
// (and noop before it runs, keeping the middleware inert).
func TraceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := otel.GetTracerProvider().Tracer(tracingTracerName).Start(ctx, r.Method+" "+r.URL.Path)
		defer span.End()
		r = r.WithContext(ctx)

		// End must see the outcome (status or panic) before the span closes:
		// defers run last-declared-first, so this recover block — declared
		// after span.End() — unwinds first, records, and re-raises exactly
		// what the handler threw.
		tracked := &trackingResponseWriter{ResponseWriter: w}
		if flusher, ok := w.(http.Flusher); ok {
			tracked.flusher = flusher
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				span.RecordError(errorFromPanic(recovered))
				span.SetStatus(codes.Error, "handler panicked")
				panic(recovered)
			}
		}()
		next.ServeHTTP(tracked, r)

		span.SetAttributes(attribute.Int("http.response.status_code", tracked.status))
		if tracked.status >= 500 {
			span.SetStatus(codes.Error, "")
		}
	})
}

// errorFromPanic shapes a recovered panic value for span recording.
func errorFromPanic(recovered any) error {
	if err, ok := recovered.(error); ok {
		return err
	}
	return panicError{recovered}
}

type panicError struct{ value any }

func (e panicError) Error() string { return fmt.Sprintf("panic: %v", e.value) }

// trackingResponseWriter captures the status the chain answered with, while
// delegating everything else — including Flush, because the AG-UI runner
// streams its events through it.
type trackingResponseWriter struct {
	http.ResponseWriter
	flusher http.Flusher
	status  int
}

func (w *trackingResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *trackingResponseWriter) Flush() {
	if w.flusher != nil {
		w.flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer even when
// the middleware chain grows beyond this layer.
func (w *trackingResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// InitTracing registers the process's tracer provider, once, from the
// operator's environment (getenv is passed for testability; main supplies
// os.Getenv). It returns the shutdown that flushes the exporter, or nil when
// tracing stays off. It never fails the boot: a broken export configuration
// degrades to record-only rather than refusing to serve.
func InitTracing(ctx context.Context, getenv func(string) string) (func(context.Context) error, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	if strings.ToLower(strings.TrimSpace(getenv("OPENBOT_TRACES"))) == "off" {
		return nil, nil
	}

	endpoint := resolveTracesEndpoint(getenv)
	var processors []sdktrace.SpanProcessor
	if endpoint != "" {
		exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
		if err != nil {
			return nil, err
		}
		processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", tracingServiceName),
		)),
	)
	for _, processor := range processors {
		provider.RegisterSpanProcessor(processor)
	}
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return provider.Shutdown, nil
}

// resolveTracesEndpoint mirrors the Bun side's endpoint resolution: the
// signal-level `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` verbatim (it may carry
// the full path), else the generic endpoint with the default trace path
// appended; empty when neither is configured.
func resolveTracesEndpoint(getenv func(string) string) string {
	if endpoint := strings.TrimSpace(getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")); endpoint != "" {
		return endpoint
	}
	if base := strings.TrimSpace(getenv("OTEL_EXPORTER_OTLP_ENDPOINT")); base != "" {
		return strings.TrimSuffix(base, "/") + "/v1/traces"
	}
	return ""
}
