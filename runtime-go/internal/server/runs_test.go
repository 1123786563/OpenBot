package server

/*
 * The run gate and the fixed expert directory: the two pieces of real
 * assembly R2-B① asks the main to mount.
 *
 * The gate bounds how many runs execute at once and gives SIGTERM handling
 * its two phases — draining (new runs 503, ready false) and a bounded
 * cancel/drain of what is in flight, with an HONEST answer when a run did
 * not exit in time (never "drained" as a guess).
 *
 * The expert router maps the VERIFIED envelope's expert_version onto the
 * fixed catalog of handlers the process assembled at startup. An expert
 * version the runtime does not serve is a 403 fact, not a fallback agent.
 */

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"openbot/runtime-go/internal/identity"
)

// blockingHandler blocks until released, so a test holds a run "in flight".
func blockingHandler(release <-chan struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	})
}

func TestRunGateRejectsBeyondCapacity(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	gate := NewRunGate(1)
	h := gate.Middleware(blockingHandler(release))

	// Occupy the single slot in the background.
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
	}()
	waitFor(t, func() bool { return gate.InFlight() == 1 })

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("over-capacity run status = %d, want 503", w.Code)
	}
}

func TestRunGateRejectsNewRunsWhileDraining(t *testing.T) {
	gate := NewRunGate(4)
	h := gate.Middleware(blockingHandler(nil))
	gate.BeginDrain()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("draining run status = %d, want 503", w.Code)
	}
	if gate.InFlight() != 0 {
		t.Fatalf("a refused run consumed a slot (in flight = %d)", gate.InFlight())
	}
}

func TestRunGateReleasesSlotsWhenRunsEnd(t *testing.T) {
	release := make(chan struct{})
	gate := NewRunGate(1)
	h := gate.Middleware(blockingHandler(release))

	done := make(chan struct{})
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
		_ = w.Code
		close(done)
	}()
	waitFor(t, func() bool { return gate.InFlight() == 1 })
	close(release)
	<-done
	waitFor(t, func() bool { return gate.InFlight() == 0 })

	// The slot came back: a new run is admitted.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("run after a freed slot status = %d, want 200", w.Code)
	}
}

// SIGTERM phase 3: a bounded wait, and when the wait expires, the in-flight
// request CONTEXTS are cancelled — the seam a streaming run's model work is
// bound to. What the gate reports afterwards must be the truth.
func TestRunGateCancelsActiveRunsAndReportsHonestly(t *testing.T) {
	gate := NewRunGate(4)
	var cancelled atomic.Bool
	h := gate.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		cancelled.Store(true)
		w.WriteHeader(http.StatusOK)
	}))

	finished := make(chan struct{})
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
		_ = w.Code
		close(finished)
	}()
	waitFor(t, func() bool { return gate.InFlight() == 1 })
	gate.BeginDrain()

	if gate.WaitDrain(20*time.Millisecond) {
		t.Fatal("drain reported complete while a run is still in flight")
	}
	if n := gate.CancelActive(); n != 1 {
		t.Fatalf("CancelActive cancelled %d runs, want 1", n)
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("the cancelled run never finished")
	}
	if !cancelled.Load() {
		t.Fatal("the run's context was never cancelled")
	}
	if !gate.WaitDrain(time.Second) {
		t.Fatal("drain never completed after the run ended")
	}
}

// drainTimeoutPath: when a run ignores cancellation, WaitDrain keeps telling
// the truth — the host must then report "did not exit", not "drained".
func TestRunGateWaitDrainTimesOutTruthfully(t *testing.T) {
	gate := NewRunGate(4)
	h := gate.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Ignores its context, like a model that never watches cancellation.
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
		_ = w.Code
	}()
	waitFor(t, func() bool { return gate.InFlight() == 1 })
	gate.BeginDrain()

	if gate.WaitDrain(20 * time.Millisecond) {
		t.Fatal("WaitDrain claimed complete for a run that has not exited")
	}
	if gate.InFlight() != 1 {
		t.Fatalf("in flight = %d, want 1 (the run has NOT exited)", gate.InFlight())
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}

// ---------------------------------------------------------------------------
// The fixed expert directory.
// ---------------------------------------------------------------------------

func envelopeFor(version string) identity.VerifiedRun {
	v := identity.VerifiedRun{
		TenantID:            "t1",
		PrincipalID:         "p1",
		ActorID:             "a1",
		InitiatorKind:       identity.InitiatorUser,
		RunID:               "run_1",
		AttemptID:           "attempt_1",
		TurnID:              "turn_1",
		ThreadID:            "th1",
		ExpertVersion:       version,
		InputDigest:         "digest_1",
		ModelRouteRef:       "route@1",
		BudgetReservationID: "budget_1",
		LeaseID:             "lease_1",
		FencingToken:        "fencing_1",
		ExpiresAt:           "2099-01-01T00:00:00Z",
	}
	return v
}

func TestExpertRouterServesTheVerifiedExpertVersion(t *testing.T) {
	var served struct {
		mu   sync.Mutex
		who  string
	}
	handlerFor := func(name string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			served.mu.Lock()
			served.who = name
			served.mu.Unlock()
			w.WriteHeader(http.StatusOK)
		})
	}
	router := RouteByExpert(map[string]http.Handler{
		"expert@1.0.0": handlerFor("one"),
		"expert@2.0.0": handlerFor("two"),
	})

	for version, want := range map[string]string{
		"expert@1.0.0": "one",
		"expert@2.0.0": "two",
	} {
		r := httptest.NewRequest(http.MethodPost, "/run", nil).
			WithContext(identity.WithVerified(context.Background(), envelopeFor(version)))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", version, w.Code)
		}
		served.mu.Lock()
		got := served.who
		served.mu.Unlock()
		if got != want {
			t.Fatalf("%s: served %q, want %q", version, got, want)
		}
	}
}

// An expert version outside the fixed catalog is refused — no fallback
// agent, no "closest match": the runtime serves exactly what it was
// assembled with.
func TestExpertRouterRefusesUnknownExpertVersion(t *testing.T) {
	var reached bool
	router := RouteByExpert(map[string]http.Handler{
		"expert@1.0.0": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		}),
	})
	r := httptest.NewRequest(http.MethodPost, "/run", nil).
		WithContext(identity.WithVerified(context.Background(), envelopeFor("expert@attacker")))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("unknown expert version status = %d, want 403", w.Code)
	}
	if reached {
		t.Fatal("an unknown expert version reached a catalog handler")
	}
}

// Without a verified identity there is no expert version to route on: the
// router refuses rather than guessing (it is mounted behind Authenticate,
// and must not quietly become a bypass).
func TestExpertRouterRequiresVerifiedIdentity(t *testing.T) {
	router := RouteByExpert(map[string]http.Handler{
		"expert@1.0.0": http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/run", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("unverified request status = %d, want 403", w.Code)
	}
}

var errShutdown = errors.New("shut down")

var _ = errShutdown // reserved for future drain tests
