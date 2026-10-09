// Package server hosts the Go runtime candidate's HTTP boundary.
//
// This file is the gate in front of the AG-UI runner. A request becomes a
// verified run in exactly two steps, in this order:
//
//  1. the inter-service credential proves the call comes from the platform —
//     checked locally, before any network work is spent on it;
//  2. the enterprise invocation envelope (master plan §4.2 RuntimeInvocation,
//     carried in the x-openbot-runtime-invocation header) and the short-term
//     capability (x-openbot-runtime-capability) are forwarded — and nothing
//     else — to the FIXED TS validation address
//     (/internal/enterprise/v1/runtime/validate), which vouches for the whole
//     envelope: tenant, principal, run/attempt/turn/thread, expert version,
//     input digest, model route, budget reservation, lease/fencing, expiry.
//
// Only after both, plus the middleware's own defenses (trusted-input rules,
// input digest, turn binding, local expiry re-check, initiator/delegation
// pairing), does WithVerified run. Nothing here can mint an identity on its
// own: Go holds no signing key and no member database, by design.
//
// The legacy agent-token + run-assertion headers are NOT identity on this
// wire: they are optional credentials for the R3 callback client to present
// to the legacy tool plane, carried in the private context for that use only.
package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"openbot/runtime-go/internal/identity"
	"openbot/runtime-go/internal/trustedinput"
)

// Header names crossing the platform↔runtime and runtime↔TS boundaries.
const (
	// ServiceCredentialHeader carries the platform-to-runtime shared secret.
	ServiceCredentialHeader = "x-openbot-runtime-service-credential"
	// CapabilityHeader carries the short-term invocation capability the TS
	// plane issued for exactly this run attempt (master plan §4.2).
	CapabilityHeader = "x-openbot-runtime-capability"
	// InvocationHeader carries the strict RuntimeInvocation envelope, JSON
	// encoded, snake_case. A header (not a body field) so the AG-UI request
	// body stays framework-shaped and the envelope never becomes
	// model-visible forwardedProps.
	InvocationHeader = "x-openbot-runtime-invocation"
	// AgentTokenHeader is the LEGACY agent token, used only by the R3
	// callback client against the legacy tool plane. It is not consulted for
	// identity on the enterprise wire.
	AgentTokenHeader = "x-openbot-agent-token"
	// RunAssertionHeader is the LEGACY signed run assertion, carried in the
	// private context for the R3 callback client. Not identity here.
	RunAssertionHeader = "x-openbot-run-assertion"
)

// Suggested verification limits for this candidate; these are configuration
// defaults, not measured performance guarantees.
const (
	DefaultValidationTimeout      = 5 * time.Second
	DefaultMaxInboundBody         = int64(8 << 20) // 8 MiB
	maxValidationResponseFallback = int64(1 << 20) // 1 MiB
)

// AuthConfig configures the auth middleware.
//
// ServiceCredential and ValidationEndpoint come from the environment the
// operator controls, never from a request: a caller must not be able to aim
// the runtime at its own "validation endpoint".
type AuthConfig struct {
	ServiceCredential  string
	ValidationEndpoint string
	// Timeout bounds one validation round trip. Zero means the default.
	Timeout time.Duration
	// MaxResponseBytes bounds the validation response read. Zero means default.
	MaxResponseBytes int64
	// MaxInboundBytes bounds the inbound AG-UI request body. Zero means default.
	MaxInboundBytes int64
}

// Ready reports whether the runtime is configured to authenticate at all.
// Health readiness must report this: an unconfigured runtime answers 503 and
// never falls back to an anonymous user to stay servable.
func (c AuthConfig) Ready() bool {
	return c.ServiceCredential != "" && c.ValidationEndpoint != ""
}

// Authenticate returns the middleware that guards the AG-UI runner.
func Authenticate(cfg AuthConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !cfg.Ready() {
				http.Error(w, "runtime authentication is not configured", http.StatusServiceUnavailable)
				return
			}

			// Step 1: the call must come from the platform. Constant-time,
			// because a credential comparison is a timing oracle otherwise.
			if subtle.ConstantTimeCompare(
				[]byte(r.Header.Get(ServiceCredentialHeader)),
				[]byte(cfg.ServiceCredential),
			) != 1 {
				http.Error(w, "invalid service credential", http.StatusUnauthorized)
				return
			}

			capability := r.Header.Get(CapabilityHeader)
			invocation := r.Header.Get(InvocationHeader)
			if capability == "" || invocation == "" {
				http.Error(w, "missing enterprise run credentials", http.StatusBadRequest)
				return
			}

			// Bound and capture the inbound body: the trusted-input rules and
			// the input digest are checked against it, and the runner behind
			// us still needs it.
			maxInbound := cfg.MaxInboundBytes
			if maxInbound <= 0 {
				maxInbound = DefaultMaxInboundBody
			}
			body, err := readBounded(r, maxInbound)
			if err != nil {
				http.Error(w, "request body exceeds the runtime limit", http.StatusRequestEntityTooLarge)
				return
			}

			// Trusted input first (roles, client tools, client resume, client
			// context): garbage must not spend a validation round trip.
			run0, err := trustedinput.Parse(body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			// Step 2: the fixed TS validation address vouches for the whole
			// envelope. The invocation travels VERBATIM — the middleware does
			// not parse or repair an untrusted envelope, it only consumes
			// what the plane returns.
			run, err := cfg.validate(r, capability, []byte(invocation))
			if err != nil {
				writeAuthError(w, err)
				return
			}

			// Middleware defenses on the plane's answer (01 plan: Schema/期限/
			// initiator枚举及计划触发必须带delegation_ref由middleware先检查).
			if err := checkEnvelope(run); err != nil {
				writeAuthError(w, err)
				return
			}

			// Both steps passed: this is the only place a request becomes a
			// verified run. The inbound input projection (digest and binding
			// coordinates) rides along in a private context value for the
			// execution-only input guard (RequireVerifiedInput) to compare —
			// the digest/binding comparison belongs to ROUTES THAT CARRY RUN
			// INPUT (the AG-UI runId IS the envelope's turn_id, master §4.3),
			// not to control routes like cancel, whose body is not run input.
			// The tool-plane credential pair (this request's service
			// credential + capability, both already validated) also rides
			// along for the governed tool client — the ONLY source it will
			// ever read them from; the runner's model-visible input never
			// sees any of it. The legacy assertion (if presented) is kept in
			// the private context as an inert legacy regression seam.
			ctx := r.Context()
			if assertion := r.Header.Get(RunAssertionHeader); assertion != "" {
				ctx = identity.WithRunAssertion(ctx, assertion)
			}
			ctx = identity.WithVerified(ctx, run)
			ctx = identity.WithToolCredentials(ctx, identity.ToolCredentials{
				ServiceCredential: cfg.ServiceCredential,
				Capability:        capability,
			})
			ctx = withInboundInput(ctx, run0)
			r = r.WithContext(ctx)
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
			next.ServeHTTP(w, r)
		})
	}
}

// checkEnvelope enforces the middleware's own envelope defenses: the expiry
// must parse and still be in the future (a second, local look at what the
// plane said), and the initiator kind must be one the contract freezes, with
// a scheduled initiation carrying its delegation reference. A plane that
// verified an envelope violating these is a broken plane: 502, never a run.
func checkEnvelope(run identity.VerifiedRun) error {
	if expiry, err := time.Parse(time.RFC3339, run.ExpiresAt); err != nil || !expiry.After(time.Now()) {
		return &authError{status: http.StatusUnauthorized, reason: "verified invocation has expired"}
	}
	switch run.InitiatorKind {
	case identity.InitiatorUser:
		return nil
	case identity.InitiatorSchedule:
		if run.DelegationRef == "" {
			return &authError{status: http.StatusBadGateway, reason: "scheduled invocation carried no delegation reference"}
		}
		return nil
	default:
		return &authError{status: http.StatusBadGateway, reason: "verified invocation carries an unknown initiator kind"}
	}
}

// authError is a refusal with the status the caller should see.
type authError struct {
	status int
	reason string
}

func (e *authError) Error() string { return e.reason }

func writeAuthError(w http.ResponseWriter, err error) {
	var ae *authError
	if errors.As(err, &ae) {
		http.Error(w, ae.reason, ae.status)
		return
	}
	http.Error(w, "runtime validation failed", http.StatusBadGateway)
}

// readBounded reads at most max+1 bytes and reports overflow, so a body one
// byte over the limit is caught rather than silently truncated.
func readBounded(r *http.Request, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("body exceeds limit")
	}
	return data, nil
}

// envelopeWire is the snake_case wire form TS returns: the strict
// RuntimeInvocation the plane just verified, and nothing else. Fields
// outside it are ignored, so a compromised plane cannot smuggle extras in.
type envelopeWire struct {
	SchemaVersion      string `json:"schema_version"`
	TenantID           string `json:"tenant_id"`
	PrincipalID        string `json:"principal_id"`
	ActorID            string `json:"actor_id"`
	InitiatorKind      string `json:"initiator_kind"`
	RunID              string `json:"run_id"`
	AttemptID          string `json:"attempt_id"`
	TurnID             string `json:"turn_id"`
	ThreadID           string `json:"thread_id"`
	ExpertVersion      string `json:"expert_version"`
	InputDigest        string `json:"input_digest"`
	ModelRouteRef      string `json:"model_route_ref"`
	BudgetReservationID string `json:"budget_reservation_id"`
	LeaseID            string `json:"lease_id"`
	FencingToken       string `json:"fencing_token"`
	ExpiresAt          string `json:"expires_at"`
	DelegationRef      string `json:"delegation_ref"`
}

// validate asks the fixed TS validation endpoint and returns the verified
// envelope. The invocation is forwarded VERBATIM with the capability and the
// service credential; no field of the AG-UI request crosses this boundary.
//
// The endpoint is operator configuration only; it is parsed and restricted
// to plain http/https with no userinfo before any dial. Redirects are
// refused (ErrUseLastResponse), so a 3xx never turns into a second request
// the operator did not configure. The response is size-bounded: an envelope
// is a few hundred bytes, and anything larger is not an envelope.
func (c AuthConfig) validate(r *http.Request, capability string, invocation []byte) (identity.VerifiedRun, error) {
	endpoint, err := parseValidationEndpoint(c.ValidationEndpoint)
	if err != nil {
		return identity.VerifiedRun{}, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultValidationTimeout
	}
	maxResponse := c.MaxResponseBytes
	if maxResponse <= 0 {
		maxResponse = maxValidationResponseFallback
	}
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(invocation))
	if err != nil {
		return identity.VerifiedRun{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ServiceCredentialHeader, c.ServiceCredential)
	req.Header.Set(CapabilityHeader, capability)
	res, err := client.Do(req)
	if err != nil {
		// One attempt, no retry: an unknown outcome must surface, not be
		// re-spent (the callback client in R3 holds the same line).
		return identity.VerifiedRun{}, &authError{
			status: http.StatusBadGateway,
			reason: "runtime validation is unavailable",
		}
	}
	defer func() {
		_ = res.Body.Close()
		// Drain a little so a keep-alive connection is not poisoned, bounded
		// so a hostile endpoint cannot hold the handler with an endless body.
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxResponse))
	}()

	switch {
	case res.StatusCode == http.StatusOK:
		// fall through to decode below
	case res.StatusCode == http.StatusBadRequest:
		return identity.VerifiedRun{}, &authError{status: http.StatusBadRequest, reason: "validation request was malformed"}
	case res.StatusCode == http.StatusUnauthorized:
		return identity.VerifiedRun{}, &authError{status: http.StatusUnauthorized, reason: "run credentials did not verify"}
	case res.StatusCode == http.StatusForbidden:
		return identity.VerifiedRun{}, &authError{status: http.StatusForbidden, reason: "identity is bound to a different run"}
	case res.StatusCode == http.StatusServiceUnavailable:
		return identity.VerifiedRun{}, &authError{status: http.StatusServiceUnavailable, reason: "runtime validation could not query the authoritative ledger"}
	default:
		// 3xx (refused above from following), 5xx, anything else: the plane
		// being wrong is never the caller's success.
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation is unavailable"}
	}

	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil {
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation response unreadable"}
	}
	if int64(len(data)) > maxResponse {
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation response exceeds limit"}
	}
	var wire envelopeWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation response is not a verified run"}
	}
	run := identity.VerifiedRun{
		TenantID:            wire.TenantID,
		PrincipalID:         wire.PrincipalID,
		ActorID:             wire.ActorID,
		InitiatorKind:       wire.InitiatorKind,
		RunID:               wire.RunID,
		AttemptID:           wire.AttemptID,
		TurnID:              wire.TurnID,
		ThreadID:            wire.ThreadID,
		ExpertVersion:       wire.ExpertVersion,
		InputDigest:         wire.InputDigest,
		ModelRouteRef:       wire.ModelRouteRef,
		BudgetReservationID: wire.BudgetReservationID,
		LeaseID:             wire.LeaseID,
		FencingToken:        wire.FencingToken,
		ExpiresAt:           wire.ExpiresAt,
		DelegationRef:       wire.DelegationRef,
	}
	// FromContext's completeness rule, applied before the context is built: a
	// half envelope is refused, not repaired with defaults.
	if _, err := identity.FromContext(identity.WithVerified(r.Context(), run)); err != nil {
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation returned an incomplete envelope"}
	}
	return run, nil
}

// parseValidationEndpoint accepts a configured http/https URL without
// userinfo and returns it unchanged.
//
// The runtime does not refuse private or loopback addresses here: production
// validation endpoints are internal platform addresses by design. The SSRF
// surface this guards is a caller steering the URL, and the URL is operator
// configuration only — never taken from a request — with redirects refused on
// top, so a request cannot aim the runtime anywhere.
func parseValidationEndpoint(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", &authError{status: http.StatusBadGateway, reason: "configured validation endpoint is unparseable"}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", &authError{status: http.StatusBadGateway, reason: "configured validation endpoint must be http or https"}
	}
	if u.User != nil || u.Host == "" {
		return "", &authError{status: http.StatusBadGateway, reason: "configured validation endpoint must not carry credentials"}
	}
	return raw, nil
}
