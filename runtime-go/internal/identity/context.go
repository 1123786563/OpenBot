// Package identity carries the verified run context for the Go runtime
// candidate.
//
// The VerifiedRun in a context is the only identity the runtime trusts, and it
// enters a context in exactly one place: the server auth middleware, after the
// TS governance plane has validated the caller's credentials. Model payloads
// and request bodies never generate this context; FromContext refuses anything
// that did not come through that path, so an unverified caller cannot talk the
// runner into an identity.
package identity

import (
	"context"
	"errors"
)

// VerifiedRun is the whitelist of identity fields the TS plane vouches for.
// Go adds nothing to it and reads nothing else: no client actorId/userId is
// accepted as identity, and no signing key ever reaches this process.
type VerifiedRun struct {
	TenantID string
	ActorID  string
	BotID    string
	RunID    string
	ThreadID string
}

type key struct{}

// WithVerified stores a verified run in a context.
//
// Only the auth middleware calls this. It is exported because the middleware
// lives in another package of this module; every other package must go through
// FromContext.
func WithVerified(ctx context.Context, v VerifiedRun) context.Context {
	return context.WithValue(ctx, key{}, v)
}

// FromContext returns the verified run, or an error when the caller is not
// verified. Incomplete identities are refused rather than repaired.
func FromContext(ctx context.Context) (VerifiedRun, error) {
	v, ok := ctx.Value(key{}).(VerifiedRun)
	if !ok || v.TenantID == "" || v.ActorID == "" || v.BotID == "" || v.RunID == "" || v.ThreadID == "" {
		return VerifiedRun{}, errors.New("UNAUTHENTICATED_RUNTIME")
	}
	return v, nil
}

type assertionKey struct{}

// WithRunAssertion keeps the opaque signed assertion a validated run arrived
// with, for the R3 callback client to present back to the TS plane.
//
// It lives HERE, in a private Go context key, and not in the AG-UI input's
// forwardedProps — which is model-visible — because the assertion is a
// credential: the model must not be able to read it, echo it, or edit it. As
// with WithVerified, only the auth middleware calls this; the adapter clears
// forwardedProps for the same reason.
func WithRunAssertion(ctx context.Context, assertion string) context.Context {
	return context.WithValue(ctx, assertionKey{}, assertion)
}

// RunAssertion returns the assertion stored by the auth middleware, if any.
func RunAssertion(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(assertionKey{}).(string)
	return v, ok && v != ""
}
