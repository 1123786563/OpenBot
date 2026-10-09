// Cancel boundary for the Go runtime candidate.
//
// One rule governs this file: a cancel request may only ever reach a run the
// requester's VERIFIED identity vouches for — {tenant, principal, run,
// attempt} as signed by the TS plane. A bare runId names nobody: without an
// identity behind it, it is a guess at somebody else's run, and with one it
// may only ever point at the identity's own execution, because the target is
// read from the context the auth middleware built, never from the request
// body.
//
// The registry behind RunCanceler is the framework runner's in-process map
// of runs this process is actually executing, and the ExecutionRegistry
// (executions.go) is this side's own bookkeeping of which verified tuple is
// executing under which fencing token. Both are deliberately NOT persisted:
// after a restart they are empty and every cancel answer is 404, because
// pretending to still hold runs it no longer executes would be worse than
// admitting it forgot them. Recovery of interrupted runs is the persistence
// plane's job (E2), out of scope for this candidate.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	aguiadapter "trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"

	"openbot/runtime-go/internal/identity"
)

// RunCanceler cancels a run this process is executing.
//
// It is the framework runner's cancel seam: the call re-resolves the caller
// through the adapter's trusted user resolver (identity plus run binding),
// so a mismatched or unverified context is refused INSIDE the cancel path as
// well, not only at this handler.
type RunCanceler interface {
	Cancel(ctx context.Context, input *aguiadapter.RunAgentInput) error
}

// Cancel returns the POST cancel handler. Mount it behind Authenticate: the
// verified run in the request context is both the authority and the target.
//
// The execution registry is the second half of the boundary: the cancel
// resolves the execution by the FULL verified tuple {tenant, principal, run,
// attempt} and only proceeds when the fencing token the requester presents
// is the one the execution is running under (R3-B③). A nil registry is a
// host that wired the canceler but not the tracking, and is refused rather
// than guessed through.
func Cancel(canceler RunCanceler, executions *ExecutionRegistry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if canceler == nil {
			http.Error(w, "cancel is not wired to a runner", http.StatusServiceUnavailable)
			return
		}
		if executions == nil {
			http.Error(w, "cancel is not wired to the execution registry", http.StatusServiceUnavailable)
			return
		}

		// No verified identity, no cancel. This is the "no bare runId" rule
		// made real: the run to cancel is ABOUT TO be read from this
		// identity, and an unauthenticated context has none to offer.
		v, err := identity.FromContext(r.Context())
		if err != nil {
			http.Error(w, "cancel requires a verified run identity", http.StatusForbidden)
			return
		}

		// Resolve the execution by the full verified tuple. A miss — another
		// attempt of the same run, another principal, another tenant, a run
		// from before a restart, a run that already ended — is the plain
		// "not held here" 404, stated as a fact and without echoing the
		// framework's internal keys.
		executingFencing, held := executions.Held(v)
		if !held {
			http.Error(w, "run is not held by this runtime", http.StatusNotFound)
			return
		}

		// Verify the CURRENT fencing: the cancel's lease proof must be the
		// one the execution is actually running under. A renewed or stale
		// token means the requester's lease is not the executing lease, and
		// stopping another lease's execution is reconciliation's job (E2),
		// not this boundary's.
		if executingFencing != v.FencingToken {
			http.Error(w, "cancel fencing does not match the executing run", http.StatusForbidden)
			return
		}

		// The target is the identity's own run — never a runId from the
		// body, which is client-chosen and untrusted here. The auth
		// middleware has already made the request's stated runId agree with
		// this identity's TURN (the AG-UI runId is the envelope's turn_id,
		// master §4.3), so consulting the body again would only add a way to
		// be lied to.
		err = canceler.Cancel(r.Context(), &aguiadapter.RunAgentInput{
			RunID:    v.TurnID,
			ThreadID: v.ThreadID,
		})
		switch {
		case err == nil:
			// One thing is said, and only this: the request was delivered.
			// Whether and when the run actually ends is told later, by its
			// exit events — answering "cancelled" here would claim a
			// terminal state this process does not control (a model may
			// ignore the cancellation and finish anyway), and submitted
			// tools keep their reconciliation: no external business is
			// promised to be rolled back.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "cancel_requested"})
		case errors.Is(err, aguirunner.ErrRunNotFound):
			// The registry held the tuple but the runner no longer holds the
			// run itself (it ended between the two lookups). Refused as a
			// fact, not an error to retry, and without echoing the
			// framework's internal key.
			http.Error(w, "run is not held by this runtime", http.StatusNotFound)
		default:
			// Anything else is this side's own failure; the caller gets a
			// stable sentence, never the framework's internals.
			http.Error(w, "cancel could not be requested", http.StatusInternalServerError)
		}
	})
}
