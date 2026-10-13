package server

/*
 * R3-B③/R3-B④: the execution registry this process resolves cancels against,
 * and the restart boundary that empties it.
 */

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"openbot/runtime-go/internal/identity"
)

// While a run's HTTP execution is in flight, the registry holds it under the
// full verified tuple; when the response (the run's stream) ends, the entry
// goes with it — the process no longer claims to be executing that run.
func TestTrackExecutionsHoldsOnlyWhileTheRunServes(t *testing.T) {
	executions := NewExecutionRegistry()
	canceler := &scriptCanceler{}

	heldWhileServing := make(chan bool, 1)
	tracked := executions.TrackExecutions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, err := identity.FromContext(r.Context())
		if err != nil {
			t.Errorf("the tracked handler lost the verified identity: %v", err)
		}
		_, held := executions.Held(v)
		heldWhileServing <- held
	}))

	r := httptest.NewRequest(http.MethodPost, "/internal/enterprise/v1/runtime/execution",
		strings.NewReader(`{}`)).WithContext(verifiedCtx())
	tracked.ServeHTTP(httptest.NewRecorder(), r)

	if !<-heldWhileServing {
		t.Fatal("the registry did not hold the run while it was serving")
	}
	if _, held := executions.Held(verifiedRun()); held {
		t.Fatal("the registry still held the run after its execution ended")
	}

	// And the cancel boundary says so: the finished run is not executing
	// here, and nothing is asked to stop.
	w := httptest.NewRecorder()
	Cancel(canceler, executions).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{}`)).WithContext(verifiedCtx()))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for a run whose execution already ended", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatal("a finished run's cancel reached the canceler")
	}
}

// A request without a verified identity is never recorded: the tracker sits
// behind the auth middleware, and a second gate that invented entries would
// be a second identity source.
func TestTrackExecutionsRecordsOnlyVerifiedRuns(t *testing.T) {
	executions := NewExecutionRegistry()
	served := make(chan struct{}, 1)
	tracked := executions.TrackExecutions(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		served <- struct{}{}
	}))
	tracked.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/execution", nil))
	<-served
	if executions.Len() != 0 {
		t.Fatalf("an unverified request was recorded: %d entries", executions.Len())
	}
}

// Repeated executions of the same verified tuple (a retried turn) hold one
// entry with a reference count, so the first Forget does not drop the second.
func TestExecutionRegistryReferenceCountsRetriedTurns(t *testing.T) {
	executions := NewExecutionRegistry()
	executions.Record(verifiedRun())
	executions.Record(verifiedRun())
	if executions.Len() != 1 {
		t.Fatalf("entries = %d, want 1 for the same tuple", executions.Len())
	}
	executions.Forget(verifiedRun())
	if _, held := executions.Held(verifiedRun()); !held {
		t.Fatal("the first forget dropped a still-serving execution")
	}
	executions.Forget(verifiedRun())
	if _, held := executions.Held(verifiedRun()); held {
		t.Fatal("the tuple outlived its executions")
	}
	if executions.Len() != 0 {
		t.Fatalf("entries = %d after the last execution ended", executions.Len())
	}
}

// A restart rebuilds this bookkeeping from nothing: the new process does not
// inherit the old one's execution state, does not pretend the old run is
// still executing here, and a cancel against it is the plain "not held" 404.
// What happens to the interrupted run is the persistence plane's to settle
// (E2 lease reclamation), never a claim from this side.
func TestRestartClearsLocalExecutionState(t *testing.T) {
	before := NewExecutionRegistry()
	before.Record(verifiedRun())
	if _, held := before.Held(verifiedRun()); !held {
		t.Fatal("precondition: the pre-restart process held the run")
	}

	after := NewExecutionRegistry() // the restarted process
	if _, held := after.Held(verifiedRun()); held {
		t.Fatal("a restarted process claimed to still be executing the old run")
	}
	canceler := &scriptCanceler{}
	w := httptest.NewRecorder()
	Cancel(canceler, after).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{}`)).WithContext(verifiedCtx()))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 after a restart cleared the execution state", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatal("a restarted process acted on the old run's cancel")
	}
	if strings.Contains(w.Body.String(), "cancel_requested") {
		t.Fatalf("the restart answer promised a cancellation: %s", w.Body.String())
	}
}

// The registry is shared by every concurrent execution and cancel: the
// bookkeeping itself must be safe under that concurrency (the -race gate
// leans on this too).
func TestExecutionRegistryIsConcurrencySafe(t *testing.T) {
	executions := NewExecutionRegistry()
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v := verifiedRun()
			if i%2 == 0 {
				v.AttemptID = "attempt_parallel"
			}
			executions.Record(v)
			executions.Held(v)
			executions.Forget(v)
		}(i)
	}
	wg.Wait()
	if executions.Len() != 0 {
		t.Fatalf("entries = %d after every execution was forgotten", executions.Len())
	}
}
