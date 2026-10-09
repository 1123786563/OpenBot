// The execution-only input guard: the digest and turn-binding comparison the
// auth middleware PREPARES (it stores the inbound input projection next to
// the verified run) and this middleware ENFORCES, on exactly the routes that
// carry run input.
//
// The split is deliberate: cancel is a control route whose body is not run
// input — an empty message list there is correct, so applying the digest
// comparison to it would refuse every legitimate cancel. Mounting this guard
// is what makes a route an execution route.
package server

import (
	"context"
	"net/http"

	"openbot/runtime-go/internal/identity"
	"openbot/runtime-go/internal/trustedinput"
)

type inboundInputKey struct{}

// withInboundInput stores the trusted-input projection the auth middleware
// computed. Only the auth middleware calls this.
func withInboundInput(ctx context.Context, in trustedinput.InboundRun) context.Context {
	return context.WithValue(ctx, inboundInputKey{}, in)
}

// inboundInput returns the stored projection, if the auth middleware ran.
func inboundInput(ctx context.Context) (trustedinput.InboundRun, bool) {
	in, ok := ctx.Value(inboundInputKey{}).(trustedinput.InboundRun)
	return in, ok
}

// RequireVerifiedInput guards an execution route with the two comparisons
// that bind a verified envelope to the run input that actually arrived:
//
//   - 错误摘要: the envelope's input_digest must equal the frozen canonical
//     digest of the inbound messages — the plane vouched for one input, and
//     a different one arriving is a binding refusal;
//   - the AG-UI runId IS the envelope's turn_id (master §4.3) and the thread
//     must agree, so a verified identity for one run cannot steer another.
//
// A request without the auth middleware's values is an assembly error and is
// answered 500, never waved through.
func RequireVerifiedInput() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			run, err := identity.FromContext(r.Context())
			if err != nil {
				http.Error(w, "input guard requires a verified run identity", http.StatusInternalServerError)
				return
			}
			inbound, ok := inboundInput(r.Context())
			if !ok {
				http.Error(w, "input guard requires the authentication middleware", http.StatusInternalServerError)
				return
			}
			if inbound.Digest != run.InputDigest {
				http.Error(w, "input does not match the verified input digest", http.StatusForbidden)
				return
			}
			if inbound.RunID != run.TurnID || inbound.ThreadID != run.ThreadID {
				http.Error(w, "identity is bound to a different run", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
