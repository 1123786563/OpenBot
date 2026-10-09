// Package callback is the Go runtime's only door to the TS governance plane
// for tool execution.
//
// The runtime executes no vendor tools itself: a governed tool call is an
// HTTP request to the platform's `/api/agent-tools/call`, where the grant is
// checked, the policy evaluated and the audit row written — the same three
// questions every other door to a vendor is asked. This client is therefore
// deliberately narrow:
//
//   - the endpoint and the agent token are fields on the Client, set from
//     operator configuration; the model names a TOOL and its arguments and
//     nothing else. There is no generic "fetch this URL" tool here and there
//     never will be one — a model-selectable endpoint or header would be a
//     prompt injector's outbound request.
//   - the run assertion travels as its own `run` body field, never inside
//     `args`: args are model-chosen, and identity is a credential the plane
//     authorises against, not an argument it trusts.
package callback

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Suggested limits for this candidate; configuration defaults, not measured
// performance guarantees.
const (
	// MaxResponseBytes bounds one tool answer read. An honest answer is text;
	// anything past this is a plane holding this process on an endless body.
	MaxResponseBytes = int64(1 << 20) // 1 MiB
)

// Stable, programmatically distinguishable outcomes. Callers must treat
// OUTCOME_UNKNOWN as exactly that — the tool may or may not have run, so it
// is neither a success to report nor a refusal to relay.
var (
	// ErrOutcomeUnknown wraps every failure where the plane's verdict cannot
	// be known here: network errors, timeouts, 5xx, refused redirects,
	// oversized or unreadable answers. One attempt is made; none is retried,
	// because a retry would spend a tool call whose first copy may already
	// have executed.
	ErrOutcomeUnknown = errors.New("OUTCOME_UNKNOWN")
	// ErrAuthorizationRefused marks the decisive 401/403: the plane checked
	// the token against the assertion and said no. The call was not made and
	// cannot be made with these credentials.
	ErrAuthorizationRefused = errors.New("AUTHORIZATION_REFUSED")
	// ErrEndpointNotApproved marks a misconfigured endpoint refused before
	// any dial: not http/https, or carrying embedded credentials. The
	// endpoint comes from operator configuration only, so this is an
	// operator-facing configuration error, never a request-driven one.
	ErrEndpointNotApproved = errors.New("CALLBACK_ENDPOINT_NOT_APPROVED")
)

// Result is what the plane answers a tool call with. An answer the vendor
// gave as an error (isError) is still an answer: revoked grants and refused
// policy read 200 {text, isError:true}, and the model is owed that text.
type Result struct {
	Text    string `json:"text"`
	IsError bool   `json:"isError"`
}

// Client calls the platform's governed tool endpoint.
//
// HTTP, Endpoint and AgentToken are operator configuration. This is a value
// type on purpose: there is nothing to lifecycle, and a zero HTTP field
// means "use the default transport with redirects refused".
type Client struct {
	HTTP       *http.Client
	Endpoint   string
	AgentToken string
}

// Call executes one governed tool call and returns the plane's answer.
//
// Exactly one HTTP attempt is made. The request body is {run, name, args}
// with the caller's args verbatim — no identity is injected into args, and a
// nil args map still serialises as an object because the plane parses null
// as "arguments are not an object".
func (c Client) Call(ctx context.Context, assertion, name string, args map[string]any) (Result, error) {
	endpoint, err := approvedEndpoint(c.Endpoint)
	if err != nil {
		return Result{}, err
	}
	if args == nil {
		args = map[string]any{}
	}
	payload, err := json.Marshal(map[string]any{"run": assertion, "name": name, "args": args})
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-openbot-agent-token", c.AgentToken)

	// Redirects are refused even when the caller hands us a stock client
	// that would follow them: a 3xx must never become a second request the
	// operator did not configure. The shallow copy shares the transport and
	// leaves the caller's client untouched.
	client := c.HTTP
	if client == nil {
		client = &http.Client{}
	} else {
		copied := *client
		client = &copied
	}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}

	res, err := client.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrOutcomeUnknown, err)
	}
	defer func() {
		_ = res.Body.Close()
		// Drain a little so a keep-alive connection is not poisoned, bounded
		// so a hostile plane cannot hold the caller with an endless body.
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, MaxResponseBytes))
	}()

	switch {
	case res.StatusCode == http.StatusOK:
		// Decode below.
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		// The plane's own refusal wording stays on the plane: it may name
		// tokens, keys or people, and none of it belongs in this process's
		// error strings (which reach logs) or in anything model-visible.
		return Result{}, fmt.Errorf("%w: status %d", ErrAuthorizationRefused, res.StatusCode)
	default:
		// 3xx (unfollowed), 4xx beyond auth, 5xx: the plane's verdict about
		// whether the tool ran is not knowable here.
		return Result{}, fmt.Errorf("%w: status %d", ErrOutcomeUnknown, res.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return Result{}, fmt.Errorf("%w: unreadable answer", ErrOutcomeUnknown)
	}
	if int64(len(data)) > MaxResponseBytes {
		return Result{}, fmt.Errorf("%w: answer exceeds %d bytes", ErrOutcomeUnknown, MaxResponseBytes)
	}
	var decoded struct {
		Text    *string `json:"text"`
		IsError bool    `json:"isError"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil || decoded.Text == nil {
		// A 200 whose body is not a readable {text, isError} cannot be shown
		// to the model as an answer it never gave.
		return Result{}, fmt.Errorf("%w: answer is not a tool result", ErrOutcomeUnknown)
	}
	return Result{Text: *decoded.Text, IsError: decoded.IsError}, nil
}

// approvedEndpoint accepts a configured http/https URL without userinfo and
// returns it unchanged.
//
// The endpoint is not refused for being private or loopback: production tool
// endpoints are internal platform addresses by design. The surface guarded
// here is the URL's SHAPE, and the source it may come from — operator
// configuration, never a request or a model — is guarded by this package
// exposing no other way to set one.
func approvedEndpoint(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%w: unparseable endpoint", ErrEndpointNotApproved)
	}
	if raw == "" || u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%w: endpoint must be http or https", ErrEndpointNotApproved)
	}
	if u.User != nil || u.Host == "" {
		return "", fmt.Errorf("%w: endpoint must not carry credentials", ErrEndpointNotApproved)
	}
	return raw, nil
}
