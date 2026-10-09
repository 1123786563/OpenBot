// Run gate and fixed expert directory: the assembly pieces R2-B① mounts in
// the real main.
//
// The gate enforces the configured concurrent-run bound and gives SIGTERM
// its two phases: BeginDrain flips the runtime to refusing new runs (the
// host also drives readiness false at the same moment), and the bounded
// drain/cancel that follows reports only what actually happened — a run that
// did not exit in time keeps InFlight > 0 so the host logs the unknown
// outcome instead of claiming a clean stop.
//
// The expert router maps the VERIFIED envelope's expert_version onto the
// fixed catalog of handlers assembled at startup. Expert versions are
// platform-approved configuration (TS 已批准不可变配置): a run for a version
// this process does not serve is refused, never routed to a fallback agent.
package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"openbot/runtime-go/internal/identity"
)

// RunGate bounds and tracks in-flight run executions.
//
// Zero max means unlimited (the strict loader in runtimeconfig refuses to
// build such a config for enterprise mode, so unlimited is a host-assembled
// test configuration only).
type RunGate struct {
	max int

	mu       sync.Mutex
	draining bool
	inFlight map[*http.Request]context.CancelFunc
}

// NewRunGate builds a gate admitting at most max concurrent runs.
func NewRunGate(max int) *RunGate {
	return &RunGate{
		max:      max,
		inFlight: make(map[*http.Request]context.CancelFunc),
	}
}

// Middleware wraps an execution handler with the gate: requests beyond the
// bound, and every request once draining, are answered 503 without reaching
// the handler. Admitted requests run under a cancellable context so drain
// can stop them.
func (g *RunGate) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		if g.draining {
			g.mu.Unlock()
			http.Error(w, "runtime is draining; no new runs are accepted", http.StatusServiceUnavailable)
			return
		}
		if g.max > 0 && len(g.inFlight) >= g.max {
			g.mu.Unlock()
			http.Error(w, "runtime is at its concurrent run limit", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		g.inFlight[r] = cancel
		g.mu.Unlock()

		defer func() {
			g.mu.Lock()
			delete(g.inFlight, r)
			g.mu.Unlock()
			cancel()
		}()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// BeginDrain stops admitting new runs. It is idempotent.
func (g *RunGate) BeginDrain() {
	g.mu.Lock()
	g.draining = true
	g.mu.Unlock()
}

// InFlight reports how many runs are executing right now.
func (g *RunGate) InFlight() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.inFlight)
}

// WaitDrain waits up to the timeout for every in-flight run to end and
// reports whether that actually happened. A false return is the honest
// answer the host must surface ("runs did not exit"), never a reason to
// claim a clean stop.
func (g *RunGate) WaitDrain(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if g.InFlight() == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// CancelActive cancels the contexts of every in-flight run and reports how
// many were cancelled. Runs whose model work is bound to the request context
// stop; a run that ignores cancellation stays in flight, and InFlight keeps
// saying so.
func (g *RunGate) CancelActive() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, cancel := range g.inFlight {
		cancel()
		n++
	}
	return n
}

// RouteByExpert serves each run with the catalog handler its VERIFIED
// expert_version names. The catalog is fixed at assembly time: a version it
// does not hold is refused with 403 — no fallback agent, no closest match —
// and a request without a verified identity (this router mounts behind
// Authenticate) is refused rather than guessed for.
func RouteByExpert(catalog map[string]http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, err := identity.FromContext(r.Context())
		if err != nil {
			http.Error(w, "expert routing requires a verified run identity", http.StatusForbidden)
			return
		}
		handler, ok := catalog[v.ExpertVersion]
		if !ok {
			http.Error(w, "this runtime does not serve the requested expert version", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
}
