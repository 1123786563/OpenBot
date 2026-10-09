// Package server hosts the Go runtime candidate's HTTP boundary.
//
// This file is the gate in front of the AG-UI runner. A request becomes a
// verified run in exactly two steps, in this order:
//
//  1. the inter-service credential proves the call comes from the platform —
//     checked locally, before any network work is spent on it;
//  2. the agent token and signed run assertion are forwarded to the FIXED TS
//     validation address, which vouches for the whitelist identity.
//
// Only after both does WithVerified run. Nothing here can mint an identity on
// its own: Go holds no signing key and no member database, by design.
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
)

// Header names crossing the platform↔runtime and runtime↔TS boundaries.
const (
	// ServiceCredentialHeader carries the platform-to-runtime shared secret.
	ServiceCredentialHeader = "x-openbot-runtime-service-credential"
	// AgentTokenHeader is the same agent token the legacy tool-call route
	// reads; here it is forwarded to the TS validation endpoint.
	AgentTokenHeader = "x-openbot-agent-token"
	// RunAssertionHeader carries the signed run assertion. A header rather
	// than a body field, so it never becomes model-visible forwardedProps.
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

			token := r.Header.Get(AgentTokenHeader)
			assertion := r.Header.Get(RunAssertionHeader)
			if token == "" || assertion == "" {
				http.Error(w, "missing run credentials", http.StatusBadRequest)
				return
			}

			// Bound and capture the inbound body: the run binding needed for
			// validation is in it, and the runner behind us still needs it.
			maxInbound := cfg.MaxInboundBytes
			if maxInbound <= 0 {
				maxInbound = DefaultMaxInboundBody
			}
			body, err := readBounded(r, maxInbound)
			if err != nil {
				http.Error(w, "request body exceeds the runtime limit", http.StatusRequestEntityTooLarge)
				return
			}
			var binding struct {
				RunID    string `json:"runId"`
				ThreadID string `json:"threadId"`
			}
			// Decoding only picks the two binding fields out; every other
			// inbound field (state, forwardedProps, ...) stays below.
			if err := json.Unmarshal(body, &binding); err != nil {
				http.Error(w, "request body is not a JSON run input", http.StatusBadRequest)
				return
			}

			// Step 2: the fixed TS validation address vouches for the identity.
			run, err := cfg.validate(r, token, assertion, binding.RunID, binding.ThreadID)
			if err != nil {
				writeAuthError(w, err)
				return
			}

			// Both steps passed: this is the only place a request becomes a
			// verified run. The assertion rides along in the private context
			// for the R3 callback client; the runner's model-visible input
			// never sees it (the adapter clears forwardedProps).
			ctx := identity.WithRunAssertion(r.Context(), assertion)
			ctx = identity.WithVerified(ctx, run)
			r = r.WithContext(ctx)
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
			next.ServeHTTP(w, r)
		})
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

// validationIdentity is the whitelist the TS endpoint may return. Nothing
// outside it is read, so a compromised plane cannot smuggle extra fields in.
type validationIdentity struct {
	TenantID string `json:"tenantId"`
	ActorID  string `json:"actorId"`
	BotID    string `json:"botId"`
	RunID    string `json:"runId"`
	ThreadID string `json:"threadId"`
}

// validate asks the fixed TS validation endpoint and returns the verified run.
//
// The endpoint is operator configuration only; it is parsed and restricted to
// plain http/https with no userinfo before any dial. Redirects are refused
// (ErrUseLastResponse), so a 3xx never turns into a second request the
// operator did not configure. The response is size-bounded: an identity is a
// few hundred bytes, and anything larger is not an identity.
func (c AuthConfig) validate(r *http.Request, token, assertion, runID, threadID string) (identity.VerifiedRun, error) {
	endpoint, err := parseValidationEndpoint(c.ValidationEndpoint)
	if err != nil {
		return identity.VerifiedRun{}, err
	}
	payload, err := json.Marshal(map[string]string{
		"assertion": assertion,
		"runId":     runID,
		"threadId":  threadID,
	})
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

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return identity.VerifiedRun{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(AgentTokenHeader, token)
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
	var ident validationIdentity
	if err := json.Unmarshal(data, &ident); err != nil {
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation response is not an identity"}
	}
	run := identity.VerifiedRun{
		TenantID: ident.TenantID,
		ActorID:  ident.ActorID,
		BotID:    ident.BotID,
		RunID:    ident.RunID,
		ThreadID: ident.ThreadID,
	}
	if run.TenantID == "" || run.ActorID == "" || run.BotID == "" || run.RunID == "" || run.ThreadID == "" {
		// A half identity is refused, not repaired with defaults.
		return identity.VerifiedRun{}, &authError{status: http.StatusBadGateway, reason: "runtime validation returned an incomplete identity"}
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
