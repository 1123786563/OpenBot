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

// Initiator kinds the enterprise wire contract freezes (master plan §4.2:
// MVP human principals plus revocable plan delegations — nothing else).
const (
	// InitiatorUser marks a run a human principal started directly.
	InitiatorUser = "user"
	// InitiatorSchedule marks a run a scheduled plan started on a human
	// principal's behalf; it must carry a DelegationRef.
	InitiatorSchedule = "schedule"
)

// VerifiedRun is the whitelist of identity fields the TS plane vouches for:
// the master-plan §4.2 RuntimeInvocation, mapped to wire snake_case by the
// auth middleware. Go adds nothing to it and reads nothing else: no client
// actorId/userId is accepted as identity, and no signing key ever reaches
// this process.
//
// DelegationRef is the one optional field: only a scheduled initiation must
// carry one (the auth middleware enforces that pairing; FromContext checks
// only that everything else is present, because it is a completeness
// assertion, not the place where initiator policy lives).
type VerifiedRun struct {
	TenantID            string
	PrincipalID         string
	ActorID             string
	InitiatorKind       string
	RunID               string
	AttemptID           string
	TurnID              string
	ThreadID            string
	ExpertVersion       string
	InputDigest         string
	ModelRouteRef       string
	BudgetReservationID string
	LeaseID             string
	FencingToken        string
	ExpiresAt           string
	DelegationRef       string
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
// verified. Incomplete identities are refused rather than repaired: every
// envelope field except DelegationRef must have arrived, because a field the
// plane did not vouch for is a field no run may execute on.
func FromContext(ctx context.Context) (VerifiedRun, error) {
	v, ok := ctx.Value(key{}).(VerifiedRun)
	if !ok || v.TenantID == "" || v.PrincipalID == "" || v.ActorID == "" ||
		v.InitiatorKind == "" || v.RunID == "" || v.AttemptID == "" || v.TurnID == "" ||
		v.ThreadID == "" || v.ExpertVersion == "" || v.InputDigest == "" ||
		v.ModelRouteRef == "" || v.BudgetReservationID == "" ||
		v.LeaseID == "" || v.FencingToken == "" || v.ExpiresAt == "" {
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

// ToolCredentials is the pair the runtime presents to the TS tool plane for
// governed tool operations (master plan §4.1: the tool-invocation endpoints
// answer an AUTHENTICATED Runtime): the platform-to-runtime service
// credential and the short-term invocation capability this run was
// validated with. The plane re-validates the capability against the
// operation's run/attempt/fencing, so a capability minted for one run
// cannot spend another run's operations.
type ToolCredentials struct {
	ServiceCredential string
	Capability        string
}

type toolCredentialKey struct{}

// WithToolCredentials stores the tool-plane credential pair for a verified
// run.
//
// Only the auth middleware calls this, after the local service-credential
// check AND the TS validation round trip have both passed — the pair a tool
// call presents is the pair the plane already vouched for, never anything a
// model chose. The callback client refuses to operate without it; there is
// no field anywhere in model-reachable data that can supply these values.
func WithToolCredentials(ctx context.Context, c ToolCredentials) context.Context {
	return context.WithValue(ctx, toolCredentialKey{}, c)
}

// ToolCredentialsFromContext returns the tool-plane credential pair the auth
// middleware stored, or ok=false when the caller was never verified. A
// half-empty pair is refused rather than repaired: a credential the
// middleware did not store is a credential no tool call may present.
func ToolCredentialsFromContext(ctx context.Context) (ToolCredentials, bool) {
	c, ok := ctx.Value(toolCredentialKey{}).(ToolCredentials)
	return c, ok && c.ServiceCredential != "" && c.Capability != ""
}
