// Command runtime is the REAL assembled Go runtime candidate (01 plan
// R2-B): strict configuration, a fixed TS validation client, a fixed model
// client, a fixed expert directory, adapter.New per expert behind service
// authentication, the run gate, and the internal execution/cancel routes —
// assembled in exactly that order.
//
// Startup rules:
//
//   - runtimeconfig.Load refuses to start when ANY required configuration is
//     missing (no fixed-user fallback, no default endpoints, no half
//     configured enterprise mode); the refusal names every problem.
//   - readiness turns true only after the listener is bound AND the
//     non-paid dependency prechecks in Load passed (endpoint shapes, catalog
//     files). Health endpoints never probe paid model providers.
//   - liveness answers while the process can serve, nothing more.
//
// Shutdown rules (two phases, honestly reported):
//
//   1. SIGINT/SIGTERM flips the runtime to draining: readiness goes false
//      and the run gate refuses every new run.
//   2. The HTTP server stops accepting; in-flight runs get the drain window,
//      then have their contexts cancelled and a short grace to exit. A run
//      that still has not exited is REPORTED as not exited (exit code 1),
//      never claimed as a clean stop.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	openaimodel "trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/tool"

	"openbot/runtime-go/internal/adapter"
	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/runtimeconfig"
	"openbot/runtime-go/internal/server"
)

// Enterprise routes this process serves (master plan §4.1 naming).
const (
	executionRoute = "/internal/enterprise/v1/runtime/execution"
	cancelRoute    = "/internal/enterprise/v1/runtime/cancel"
)

func main() {
	cfg, err := runtimeconfig.Load(os.Args[1:], os.Getenv)
	if err != nil {
		log.Fatalf("runtime: %v", err)
	}

	// Fixed model client: the TS-approved model_route_ref resolves to THIS
	// client the process was assembled with. Nothing a request carries can
	// aim a run at another provider (forwardedProps is dropped by the input
	// hook; there is no model-selectable endpoint anywhere in this module).
	modelOptions := []openaimodel.Option{
		openaimodel.WithBaseURL(cfg.ModelBaseURL),
	}
	if cfg.ModelProviderCredential != "" {
		modelOptions = append(modelOptions, openaimodel.WithAPIKey(cfg.ModelProviderCredential))
	}
	provider := openaimodel.New(cfg.ModelAlias, modelOptions...)

	// The one governed-tool client (legacy plane) shared by every expert;
	// GovernedTool keeps the endpoint and credential out of model hands.
	var governedTools []tool.Tool
	if len(cfg.GovernedTools) > 0 {
		plane := &callback.Client{
			HTTP:       &http.Client{Timeout: 10 * time.Second},
			Endpoint:   cfg.CallbackEndpoint,
			AgentToken: cfg.AgentToken,
		}
		for _, name := range cfg.GovernedTools {
			governedTools = append(governedTools,
				adapter.GovernedTool(plane, name,
					"Platform-governed tool; executes on the TS plane.", nil))
		}
	}

	// Fixed expert directory: one agent + one AG-UI handler per entry, all
	// sharing the same trusted resolver set (adapter.New installs it). A
	// construction failure cleans up the handlers already built.
	catalog := make(map[string]http.Handler, len(cfg.Experts))
	var cancelers []adapter.Canceler
	var stops []func() error
	for _, expert := range cfg.Experts {
		agentOptions := []llmagent.Option{
			llmagent.WithModel(provider),
			llmagent.WithInstruction(expert.Instruction),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithMaxLLMCalls(4),
			llmagent.WithMaxToolIterations(2),
		}
		if len(governedTools) > 0 {
			agentOptions = append(agentOptions, llmagent.WithTools(governedTools))
		}
		handler, stop, err := adapter.New(
			llmagent.New(expert.Version, agentOptions...),
			adapter.WithCancelerSink(func(c adapter.Canceler) { cancelers = append(cancelers, c) }),
		)
		if err != nil {
			for _, done := range stops {
				_ = done()
			}
			log.Fatalf("runtime: assembling expert %s failed: %v", expert.Version, err)
		}
		catalog[expert.Version] = handler
		stops = append(stops, stop)
	}

	authConfig := server.AuthConfig{
		ServiceCredential:  cfg.ServiceCredential,
		ValidationEndpoint: cfg.ValidationEndpoint,
		MaxInboundBytes:    cfg.MaxInboundBytes,
	}
	auth := server.Authenticate(authConfig)
	gate := server.NewRunGate(cfg.MaxConcurrentRuns)

	var ready atomic.Bool
	mux := http.NewServeMux()
	mux.Handle("/health/", server.Health(func() bool {
		// Readiness is: listener bound, authentication fully configured, and
		// the process not draining. No paid dependency is ever probed here.
		return ready.Load() && authConfig.Ready() && !gate.Draining()
	}))
	// Execution: the gate bounds concurrency and answers 503 while draining;
	// authentication turns the enterprise envelope into a verified run; the
	// input guard binds that envelope to the input that actually arrived
	// (digest + turn binding); the expert router serves the run with the
	// handler its VERIFIED expert version names (403 for anything outside
	// the fixed catalog).
	mux.Handle(executionRoute, gate.Middleware(auth(server.RequireVerifiedInput()(server.RouteByExpert(catalog)))))
	// Cancel stays reachable while draining: stopping a run is exactly what
	// drain itself needs to do.
	mux.Handle(cancelRoute, auth(server.Cancel(adapter.CompositeCanceler(cancelers...))))

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Listen FIRST; only a bound listener makes the runtime ready.
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatalf("runtime: listen %s: %v", cfg.Addr, err)
	}
	ready.Store(true)
	log.Printf("runtime: listening on %s (experts: %d, governed tools: %d)",
		ln.Addr().String(), len(catalog), len(governedTools))

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serveErr:
		log.Fatalf("runtime: serve failed: %v", err)
	case <-ctx.Done():
		log.Println("runtime: shutdown signal received; draining")
	}

	// Phase 1: stop being ready, refuse every new run.
	ready.Store(false)
	gate.BeginDrain()

	// Phase 2: stop accepting connections and wait out the drain window for
	// in-flight runs to end on their own.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.DrainTimeout)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("runtime: drain window closed with runs still in flight (shutdown: %v)", err)
	}

	// Phase 3: cancel what is left, grant a short grace, then report the
	// truth. "Unknown" is an honest exit status, never a silent success.
	if gate.InFlight() > 0 {
		cancelled := gate.CancelActive()
		log.Printf("runtime: cancelled %d in-flight run(s) at the drain deadline", cancelled)
	}
	if !gate.WaitDrain(cfg.CancelGrace) {
		log.Printf("runtime: %d run(s) did not exit within the drain window; their outcome is unknown",
			gate.InFlight())
		for _, done := range stops {
			_ = done()
		}
		os.Exit(1)
	}

	for _, done := range stops {
		if err := done(); err != nil {
			log.Printf("runtime: closing an expert handler failed: %v", err)
		}
	}
	fmt.Println("runtime: stopped")
}
