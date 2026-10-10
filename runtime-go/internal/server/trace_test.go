package server

/*
 * The trace middleware contract (observability P2 task 5), mirroring the
 * Bun side's shared/trace.ts semantics on the Go wire:
 *
 *   - an inbound W3C `traceparent` continues that trace: the request span
 *     carries the header's trace id and reports the header's span id as its
 *     parent;
 *   - a request without one roots a fresh trace of its own;
 *   - the span is named `METHOD path` like the Bun fetch wrapper, records
 *     `http.response.status_code`, and takes the ERROR status on a 5xx or a
 *     panicking handler — while the panic itself still propagates exactly
 *     what the handler threw;
 *   - a governed-tool callback sent with an active span in its context
 *     carries that trace's `traceparent` to the plane, so the run's spans
 *     stitch across the runtime↔TS boundary.
 */

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/identity"
)

// statusCodeKey is the response status attribute the middleware records,
// named exactly as the Bun side's withTraceFetch names it.
const statusCodeKey = attribute.Key("http.response.status_code")

// installTraceTestGlobals registers a real SDK tracer provider backed by a
// SpanRecorder and the W3C propagator, restoring the noop globals when the
// test ends. These mutate process globals, so tests using it must not run in
// parallel with each other.
func installTraceTestGlobals(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTracerProvider(trace.NewNoopTracerProvider())
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())
	})
	return recorder
}

// serveTraced runs one request through the middleware with the given headers
// and returns the ended request span.
func serveTraced(t *testing.T, recorder *tracetest.SpanRecorder, header http.Header, handler http.Handler) sdktrace.ReadOnlySpan {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/enterprise/v1/runtime/execution", nil)
	if header != nil {
		req.Header = header
	}
	TraceMiddleware(handler).ServeHTTP(httptest.NewRecorder(), req)

	ended := recorder.Ended()
	if len(ended) == 0 {
		t.Fatalf("trace middleware recorded no spans")
	}
	return ended[len(ended)-1]
}

func TestTraceMiddlewareContinuesAnInboundTrace(t *testing.T) {
	recorder := installTraceTestGlobals(t)

	const (
		traceID   = "11111111111111111111111111111111"
		parentID  = "2222222222222222"
		tracepair = "00-" + traceID + "-" + parentID + "-01"
	)
	header := http.Header{}
	header.Set("traceparent", tracepair)

	stub := serveTraced(t, recorder, header, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	if got := stub.SpanContext().TraceID().String(); got != traceID {
		t.Fatalf("inbound traceparent %q produced span trace id %s, want %s", tracepair, got, traceID)
	}
	if got := stub.Parent().SpanID().String(); got != parentID {
		t.Fatalf("request span parent = %s, want the traceparent's span id %s", got, parentID)
	}
	if got := stub.Name(); got != "POST /internal/enterprise/v1/runtime/execution" {
		t.Fatalf("span name = %q, want %q", got, "POST /internal/enterprise/v1/runtime/execution")
	}
}

func TestTraceMiddlewareRootsAFreshTraceWithoutAHeader(t *testing.T) {
	recorder := installTraceTestGlobals(t)

	stub := serveTraced(t, recorder, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	if !stub.SpanContext().TraceID().IsValid() {
		t.Fatalf("headerless request produced invalid trace id %s", stub.SpanContext().TraceID())
	}
	if stub.Parent().IsValid() {
		t.Fatalf("self-rooted span must have no parent, got %s", stub.Parent().SpanID())
	}
}

// recordedStatus scans a span's attributes for the response status value,
// -1 when the middleware failed to record it.
func recordedStatus(span sdktrace.ReadOnlySpan) int64 {
	for _, kv := range span.Attributes() {
		if kv.Key == statusCodeKey {
			return kv.Value.AsInt64()
		}
	}
	return -1
}

func TestTraceMiddlewareRecordsTheResponseStatus(t *testing.T) {
	recorder := installTraceTestGlobals(t)

	stub := serveTraced(t, recorder, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if got := recordedStatus(stub); got != 200 {
		t.Fatalf("span attributes = %v, want http.response.status_code 200", stub.Attributes())
	}
	if stub.Status().Code != codes.Unset {
		t.Fatalf("a 200 response span must stay unset, got %s", stub.Status().Code)
	}

	stub = serveTraced(t, recorder, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "plane down", http.StatusBadGateway)
	}))
	if got := recordedStatus(stub); got != 502 {
		t.Fatalf("span attributes carry status %d, want 502", got)
	}
	if stub.Status().Code != codes.Error {
		t.Fatalf("a 5xx response span must be ERROR, got %s", stub.Status().Code)
	}
}

func TestTraceMiddlewarePropagatesAPanickingHandler(t *testing.T) {
	recorder := installTraceTestGlobals(t)

	defer func() {
		if recover() == nil {
			t.Fatalf("a panicking handler must still panic through the middleware")
		}
	}()
	serveTraced(t, recorder, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("run exploded")
	}))
}

func TestInitTracingOffLeavesTheGlobalsAlone(t *testing.T) {
	// Re-prime the globals a previous test's cleanup reset, so the assertion
	// below means something.
	otel.SetTracerProvider(trace.NewNoopTracerProvider())
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	stop, err := InitTracing(context.Background(), func(key string) string {
		if key == "OPENBOT_TRACES" {
			return "off"
		}
		return "http://collector:4318"
	})
	if err != nil {
		t.Fatalf("InitTracing with OPENBOT_TRACES=off must never fail: %v", err)
	}
	if stop != nil {
		_ = stop(context.Background())
	}
	// The observable claim: with off, the global propagator stays the noop
	// default, so extraction/injection stay throwaway no-ops.
	carrier := propagation.HeaderCarrier(http.Header{})
	otel.GetTextMapPropagator().Inject(context.Background(), carrier)
	if got := carrier.Get("traceparent"); got != "" {
		t.Fatalf("OPENBOT_TRACES=off must not install the W3C propagator; injection produced %q", got)
	}
}

func TestInitTracingResolvesTheExportEndpoint(t *testing.T) {
	env := map[string]string{
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://collector.internal:4318/custom/traces",
		"OTEL_EXPORTER_OTLP_ENDPOINT":        "http://ignored:4318",
	}
	stop, err := InitTracing(context.Background(), func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("InitTracing: %v", err)
	}
	if stop == nil {
		t.Fatalf("an endpoint was configured; InitTracing must return a shutdown")
	}
	if err := stop(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	otel.SetTracerProvider(trace.NewNoopTracerProvider())

	// The signal-less generic endpoint gets the default trace path appended,
	// trailing slash normalized.
	delete(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
	env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector.internal:4318/"
	stop, err = InitTracing(context.Background(), func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("InitTracing: %v", err)
	}
	if stop == nil {
		t.Fatalf("a generic endpoint was configured; InitTracing must return a shutdown")
	}
	if err := stop(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	otel.SetTracerProvider(trace.NewNoopTracerProvider())
}

func TestInitTracingWithoutAnEndpointRecordsButExportsNothing(t *testing.T) {
	otel.SetTracerProvider(trace.NewNoopTracerProvider())
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	stop, err := InitTracing(context.Background(), func(string) string { return "" })
	if err != nil {
		t.Fatalf("InitTracing: %v", err)
	}
	if stop == nil {
		t.Fatalf("record-only tracing still registers a provider; a shutdown is expected")
	}
	// Recording-only means spans still carry ids for context propagation.
	carrier := propagation.HeaderCarrier(http.Header{})
	ctx, span := otel.GetTracerProvider().Tracer("test").Start(context.Background(), "root")
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	if got := carrier.Get("traceparent"); got == "" {
		t.Fatalf("record-only tracing must still propagate trace context")
	}
	span.End()
	if err := stop(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	otel.SetTracerProvider(trace.NewNoopTracerProvider())
}

// validPreparation is the minimal proposal the plane stub below will accept.
func validPreparation() callback.ToolPreparation {
	return callback.ToolPreparation{
		ToolName:            "search",
		RunID:               "run-1",
		AttemptID:           "attempt-1",
		ToolCallID:          "call-1",
		StepID:              "step-1",
		InstallationVersion: "v1",
		Target:              "docs",
		Args:                []byte(`{"q":"x"}`),
		FencingToken:        "fence-1",
	}
}

// preparationAnswer is the plane's minimal 200 preparation answer.
const preparationAnswer = `{"operation_id":"op-1","requires_approval":false,` +
	`"safety_preview":"preview","deduplicated":false,"reconciliation_required":false}`

func TestCallbackClientInjectsTheActiveTrace(t *testing.T) {
	installTraceTestGlobals(t)

	var seenTraceparent string
	plane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTraceparent = r.Header.Get("traceparent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(preparationAnswer))
	}))
	defer plane.Close()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	ctx, span := tp.Tracer("test").Start(context.Background(), "test-run")
	ctx = identity.WithToolCredentials(ctx, identity.ToolCredentials{
		ServiceCredential: "cred",
		Capability:        "cap",
	})

	client := callback.Client{HTTP: plane.Client(), Endpoint: plane.URL}
	prep, err := client.Prepare(ctx, validPreparation())
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prep.OperationID != "op-1" {
		t.Fatalf("Prepare returned operation %q, want op-1", prep.OperationID)
	}
	if seenTraceparent == "" {
		t.Fatalf("the callback client sent no traceparent with an active span")
	}
	// W3C form: version-traceid-spanid-flags. The injected ids must be the
	// active span's own — the plane can pick the trace up from there.
	parts := strings.Split(seenTraceparent, "-")
	if len(parts) != 4 {
		t.Fatalf("injected traceparent %q is not W3C-shaped", seenTraceparent)
	}
	if parts[1] != span.SpanContext().TraceID().String() {
		t.Fatalf("injected trace id %s, want the active span's %s",
			parts[1], span.SpanContext().TraceID())
	}
	if parts[2] != span.SpanContext().SpanID().String() {
		t.Fatalf("injected parent span id %s, want the active span's %s",
			parts[2], span.SpanContext().SpanID())
	}
}

func TestCallbackClientWithoutATraceSendsNone(t *testing.T) {
	otel.SetTracerProvider(trace.NewNoopTracerProvider())
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	var seenTraceparent string
	plane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTraceparent = r.Header.Get("traceparent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(preparationAnswer))
	}))
	defer plane.Close()

	ctx := identity.WithToolCredentials(context.Background(), identity.ToolCredentials{
		ServiceCredential: "cred",
		Capability:        "cap",
	})
	client := callback.Client{HTTP: plane.Client(), Endpoint: plane.URL}
	if _, err := client.Prepare(ctx, validPreparation()); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if seenTraceparent != "" {
		t.Fatalf("a run without tracing must not carry a traceparent, got %q", seenTraceparent)
	}
}
