// Execution context bookkeeping for the cancel boundary (01 plan R3-B③).
//
// One rule governs this file: a cancel may only ever reach an execution this
// process is ACTUALLY running, found by the full verified tuple
// {tenant_id, principal_id, run_id, attempt_id} and vouched for by the fencing
// token the execution is running under. Anything else — another attempt,
// another principal, another tenant, a stale lease — is not this cancel's
// business, and reconciliation of interrupted runs is the persistence plane's
// job (E2), never a guess from here.
//
// The registry is deliberately NOT persisted: it is process-local execution
// state, rebuilt from nothing on every start. After a restart it is empty,
// every cancel answer is a plain 404, and this process never pretends to
// still be executing runs it forgot (R3-B④).
package server

import (
	"net/http"
	"sync"

	"openbot/runtime-go/internal/identity"
)

// executionKey is the full verified tuple a cancel resolves by: one business
// run may fan out into several attempts, and an attempt is one execution.
type executionKey struct {
	TenantID    string
	PrincipalID string
	RunID       string
	AttemptID   string
}

func executionKeyOf(v identity.VerifiedRun) executionKey {
	return executionKey{TenantID: v.TenantID, PrincipalID: v.PrincipalID, RunID: v.RunID, AttemptID: v.AttemptID}
}

// executionEntry is one executing tuple: the fencing token the execution
// started under, and how many in-flight executions share the tuple (a
// retried turn of the same attempt increments the count rather than forking
// entries).
type executionEntry struct {
	FencingToken string
	refs         int
}

// ExecutionRegistry tracks the executions this process is serving right now.
type ExecutionRegistry struct {
	mu      sync.Mutex
	entries map[executionKey]*executionEntry
}

// NewExecutionRegistry builds an empty registry. A restarted process builds
// one of these and holds nothing — that emptiness IS the restart boundary.
func NewExecutionRegistry() *ExecutionRegistry {
	return &ExecutionRegistry{entries: map[executionKey]*executionEntry{}}
}

// Record notes that a run started executing under the verified identity's
// fencing token. If the tuple is already executing, the reference count grows
// and the ORIGINAL fencing token stands: an executing lease is not rewritten
// mid-flight by a later request, so a cancel can only ever match the fencing
// the execution actually runs under.
func (r *ExecutionRegistry) Record(v identity.VerifiedRun) {
	key := executionKeyOf(v)
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[key]
	if !ok {
		r.entries[key] = &executionEntry{FencingToken: v.FencingToken, refs: 1}
		return
	}
	entry.refs++
}

// Forget releases one Record. The tuple disappears with its last execution;
// after that, this process holds nothing to cancel.
func (r *ExecutionRegistry) Forget(v identity.VerifiedRun) {
	key := executionKeyOf(v)
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[key]
	if !ok {
		return
	}
	entry.refs--
	if entry.refs <= 0 {
		delete(r.entries, key)
	}
}

// Held reports whether the full verified tuple has an executing entry, and
// the fencing token that execution is running under.
func (r *ExecutionRegistry) Held(v identity.VerifiedRun) (fencing string, held bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[executionKeyOf(v)]
	if !ok {
		return "", false
	}
	return entry.FencingToken, true
}

// Len reports how many tuples are executing; tests use it to prove the
// restart and end-of-execution boundaries.
func (r *ExecutionRegistry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// TrackExecutions wraps an execution handler: the verified run is recorded
// while its HTTP execution is in flight — for the AG-UI seam, the response
// IS the run's event stream, so its end is the execution's end — and
// forgotten when it finishes. Mount it BEHIND Authenticate (it records the
// verified identity, which only the middleware can have put there).
func (r *ExecutionRegistry) TrackExecutions(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		v, err := identity.FromContext(request.Context())
		if err != nil {
			// No verified identity, nothing to track: the auth middleware in
			// front refuses such requests anyway, and this tracker never
			// invents entries of its own.
			next.ServeHTTP(w, request)
			return
		}
		r.Record(v)
		defer r.Forget(v)
		next.ServeHTTP(w, request)
	})
}
