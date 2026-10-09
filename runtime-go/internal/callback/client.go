// Package callback is the Go runtime's only door to the TS tool plane for
// governed tool operations.
//
// The runtime executes no vendor tools itself: a governed tool call is TWO
// proposals to the platform's internal tool-invocation endpoints (master
// plan §4.1/§4.2) —
//
//   - Prepare proposes an operation (tool, target, args, digest, fencing);
//     the platform deduplicates on (tenant, run, tool_call_id), allocates
//     the operation_id, and answers whether approval is required and what
//     the operation would do. It performs NOTHING.
//   - Execute spends one prepared operation, and the answer is a RECEIPT
//     with a status from the frozen enum, not a bare tool answer.
//
// This client is deliberately narrow:
//
//   - the plane address is a field on the Client, set from operator
//     configuration; the two request paths are FIXED below it. There is no
//     generic "fetch this URL" tool here and there never will be one — a
//     model-selectable endpoint or header would be a prompt injector's
//     outbound request. The legacy /api/agent-tools/call entrance is not
//     mounted on this enterprise path and is not a failure fallback.
//   - the credential pair (service credential + short-term capability)
//     comes ONLY from the private context the auth middleware built after
//     the TS plane vouched for the run. Nothing model-reachable can supply
//     or override it.
//   - args are the model's chosen data and travel verbatim; the args
//     digest is computed by THIS client over the exact bytes sent, so a
//     caller cannot propose one thing and sign another.
package callback

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"openbot/runtime-go/internal/identity"
)

// Suggested limits for this candidate; configuration defaults, not measured
// performance guarantees.
const (
	// MaxResponseBytes bounds one plane answer read. An honest preparation
	// answer or receipt is small text; anything past this is a plane holding
	// this process on an endless body.
	MaxResponseBytes = int64(1 << 20) // 1 MiB

	// DefaultTimeout is the total-time bound one plane round trip gets when
	// neither the caller nor a supplied client set one. A plane that never
	// answers must not hold a run forever; the number is a suggested
	// configuration default, capacity validation owns the production value.
	DefaultTimeout = 10 * time.Second

	// prepareSuffix and the execute suffix are the fixed sub-paths the
	// configured plane address (master plan §4.1) is extended by.
	prepareSuffix = "/prepare"
	executeSuffix = "/execute"
)

// The receipt statuses the wire contract freezes (master plan §4.2). HTTP
// acceptance is never completion: submitted and unknown are receipts about a
// spend whose result is not yet known, not answers.
const (
	StatusNotSubmitted = "not_submitted"
	StatusSubmitted    = "submitted"
	StatusSucceeded    = "succeeded"
	StatusFailed       = "failed"
	StatusUnknown      = "unknown"
)

// ReceiptStatuses is the frozen enum, for validation and tests.
var ReceiptStatuses = []string{
	StatusNotSubmitted, StatusSubmitted, StatusSucceeded, StatusFailed, StatusUnknown,
}

// Stable, programmatically distinguishable outcomes. Callers must treat
// OUTCOME_UNKNOWN as exactly that — the operation may or may not have been
// spent, so it is neither a success to report nor a refusal to relay.
var (
	// ErrOutcomeUnknown wraps every failure where the plane's verdict cannot
	// be known here: network errors, timeouts, 5xx, refused redirects,
	// oversized or unreadable answers. One attempt is made; none is retried,
	// because a retry would spend a tool operation whose first copy may
	// already have been submitted.
	ErrOutcomeUnknown = errors.New("OUTCOME_UNKNOWN")
	// ErrAuthorizationRefused marks the decisive 401/403: the plane checked
	// the credentials against the operation and said no. The operation was
	// not spent and cannot be with these credentials.
	ErrAuthorizationRefused = errors.New("AUTHORIZATION_REFUSED")
	// ErrEndpointNotApproved marks a misconfigured plane address refused
	// before any dial: not http/https, or carrying embedded credentials. The
	// address comes from operator configuration only, so this is an
	// operator-facing configuration error, never a request-driven one.
	ErrEndpointNotApproved = errors.New("CALLBACK_ENDPOINT_NOT_APPROVED")
	// ErrUnauthenticated marks a context that never went through the auth
	// middleware: there is no credential pair to present, and no anonymous
	// tool operation exists.
	ErrUnauthenticated = errors.New("UNAUTHENTICATED_RUNTIME")
	// ErrOperationConflict marks a decisive 409: the platform holds an
	// operation under the same key with different content (another target,
	// digest, installation or step), and the conflict is the caller's to
	// resolve, not to retry.
	ErrOperationConflict = errors.New("OPERATION_CONFLICT")
	// ErrOperationNotFound marks a decisive 404 from execute: the
	// authoritative plane holds no such operation, so nothing was submitted
	// through it.
	ErrOperationNotFound = errors.New("OPERATION_NOT_FOUND")
	// ErrInvalidWire marks a decisive 4xx shape refusal: the plane rejected
	// the request as unreadable or inconsistent, which resending the same
	// bytes cannot fix.
	ErrInvalidWire = errors.New("INVALID_TOOL_WIRE")
	// ErrReconciliationRequired marks the platform's refusal to allocate or
	// reuse an operation because a prior proposal of the same business
	// content is submitted/unknown: the model must not get past it with a
	// fresh tool_call_id, and the run belongs in reconciliation.
	ErrReconciliationRequired = errors.New("RECONCILIATION_REQUIRED")
)

// ReconciliationError is the typed reconciliation refusal, carrying the
// operation the platform froze so the host can point the reconciliation at
// it. errors.Is(err, ErrReconciliationRequired) matches.
type ReconciliationError struct {
	OperationID string
}

func (e *ReconciliationError) Error() string {
	return fmt.Sprintf("%s: %s", ErrReconciliationRequired.Error(), e.OperationID)
}

func (e *ReconciliationError) Is(target error) bool { return target == ErrReconciliationRequired }

// ToolPreparation is one proposed governed operation (master plan §4.2).
//
// The string fields are the proposal's binding coordinates; Args is the
// model's chosen data as CANONICAL JSON (Go's encoding/json form: object
// keys sorted, no whitespace) — the digest travels over exactly those
// bytes, computed by the client, so the two can never disagree.
type ToolPreparation struct {
	ToolName            string          `json:"tool_name"`
	RunID               string          `json:"run_id"`
	AttemptID           string          `json:"attempt_id"`
	ToolCallID          string          `json:"tool_call_id"`
	StepID              string          `json:"step_id"`
	InstallationVersion string          `json:"installation_version"`
	Target              string          `json:"target"`
	Args                json.RawMessage `json:"args"`
	ArgsDigest          string          `json:"args_digest"`
	FencingToken        string          `json:"fencing_token"`
}

// Preparation is the plane's answer to a proposal: the operation reference
// the platform allocated (or reused), whether a human approval must arrive
// before the operation may execute, the safety preview of what it would do,
// and whether the operation is already frozen in reconciliation.
type Preparation struct {
	OperationID            string
	RequiresApproval       bool
	SafetyPreview          string
	Deduplicated           bool
	ReconciliationRequired bool
}

// ToolExecution spends one prepared operation. ArgsDigest must be the same
// digest the proposal carried: the platform re-checks it, and a spend whose
// content drifted from the proposal is a conflict, not a retry.
type ToolExecution struct {
	OperationID  string `json:"operation_id"`
	AttemptID    string `json:"attempt_id"`
	ArgsDigest   string `json:"args_digest"`
	ApprovalRef  string `json:"approval_ref,omitempty"` // presented only when there is one
	FencingToken string `json:"fencing_token"`
}

// Receipt is the structured outcome of one execution attempt (master plan
// §4.2): the minimal field set the platform owes, plus the tool answer text
// when the receipt is terminal. A submitted/unknown receipt is NOT an error
// and NOT an answer — it freezes the operation until a trusted receipt or a
// reconciliation settles it.
type Receipt struct {
	OperationID            string
	ExecutionAttemptID     string
	Status                 string
	ReceiptRef             string
	ErrorCode              string
	ReconciliationRequired bool
	ResultText             string
}

// PendingReconciliation reports whether this receipt freezes the operation
// instead of answering it: submitted and unknown mean the spend may or may
// not have taken effect, and only a later trusted receipt may move the
// business run forward.
func (r Receipt) PendingReconciliation() bool {
	return r.Status == StatusSubmitted || r.Status == StatusUnknown
}

// DigestArgs is the frozen canonical args digest: SHA-256 hex over the
// exact canonical JSON bytes that travel in the proposal.
func DigestArgs(canonicalJSON []byte) string {
	sum := sha256.Sum256(canonicalJSON)
	return hex.EncodeToString(sum[:])
}

// Client calls the platform's governed tool-invocation endpoints.
//
// HTTP and Endpoint are operator configuration; the credential pair is not a
// field at all — it is taken from the private context of each call, because
// it belongs to the verified run, not to the process. Timeout is the total
// bound one round trip gets when the supplied client carries none: every
// call is bounded by SOME total timeout, so a silent plane cannot hold a run
// forever. This is a value type on purpose: there is nothing to lifecycle,
// and a zero HTTP field means "use the default transport with redirects
// refused and the default total timeout".
type Client struct {
	HTTP     *http.Client
	Endpoint string
	// Timeout bounds one plane round trip when HTTP is nil or carries no
	// timeout of its own. Zero means DefaultTimeout; an explicit timeout on
	// a supplied client always wins.
	Timeout time.Duration
}

// Prepare proposes one governed operation and returns the platform's
// answer. Exactly one HTTP attempt is made; nothing is executed by prepare.
func (c Client) Prepare(ctx context.Context, p ToolPreparation) (Preparation, error) {
	if err := validatePreparation(p); err != nil {
		return Preparation{}, err
	}
	wire := p
	wire.ArgsDigest = DigestArgs(p.Args)
	status, data, err := c.post(ctx, prepareSuffix, wire)
	if err != nil {
		return Preparation{}, err
	}
	switch {
	case status == http.StatusOK:
		var decoded preparationWire
		if err := decodeStrict(data, &decoded); err != nil ||
			decoded.OperationID == nil || *decoded.OperationID == "" ||
			decoded.RequiresApproval == nil || decoded.SafetyPreview == nil ||
			decoded.Deduplicated == nil || decoded.ReconciliationRequired == nil {
			// A 200 whose body is not a readable preparation answer cannot
			// be treated as a proposal the platform recorded.
			return Preparation{}, fmt.Errorf("%w: answer is not a preparation", ErrOutcomeUnknown)
		}
		return Preparation{
			OperationID:            *decoded.OperationID,
			RequiresApproval:       *decoded.RequiresApproval,
			SafetyPreview:          *decoded.SafetyPreview,
			Deduplicated:           *decoded.Deduplicated,
			ReconciliationRequired: *decoded.ReconciliationRequired,
		}, nil
	case status == http.StatusConflict:
		return Preparation{}, conflictError(data)
	default:
		return Preparation{}, mapRefusal(status, data)
	}
}

// Execute spends one prepared operation and returns the platform's receipt.
// Exactly one HTTP attempt is made: a receipt that never arrived may mean a
// spend that did, and one operation is never spent twice from here.
func (c Client) Execute(ctx context.Context, e ToolExecution) (Receipt, error) {
	if err := validateExecution(e); err != nil {
		return Receipt{}, err
	}
	status, data, err := c.post(ctx, "/"+url.PathEscape(e.OperationID)+executeSuffix, e)
	if err != nil {
		return Receipt{}, err
	}
	switch {
	case status == http.StatusOK:
		var decoded receiptWire
		if err := decodeStrict(data, &decoded); err != nil || !decoded.complete() {
			// A 200 whose body is not a readable receipt cannot be shown to
			// the model as an answer the tool never gave.
			return Receipt{}, fmt.Errorf("%w: answer is not a receipt", ErrOutcomeUnknown)
		}
		if *decoded.OperationID != e.OperationID {
			// The answer must speak for THIS spend: a receipt naming another
			// operation proves nothing about the one this call sent (which
			// may or may not have been spent), so the outcome stays unknown.
			return Receipt{}, fmt.Errorf("%w: answer is a receipt for a different operation", ErrOutcomeUnknown)
		}
		receipt := Receipt{
			OperationID:            *decoded.OperationID,
			ExecutionAttemptID:     *decoded.ExecutionAttemptID,
			Status:                 *decoded.Status,
			ReceiptRef:             *decoded.ReceiptRef,
			ErrorCode:              *decoded.ErrorCode,
			ReconciliationRequired: *decoded.ReconciliationRequired,
		}
		if decoded.ResultText != nil {
			receipt.ResultText = *decoded.ResultText
		}
		return receipt, nil
	case status == http.StatusConflict:
		return Receipt{}, conflictError(data)
	case status == http.StatusNotFound:
		return Receipt{}, ErrOperationNotFound
	default:
		return Receipt{}, mapRefusal(status, data)
	}
}

// preparationWire / receiptWire decode with pointers so PRESENCE is
// checkable: a missing required field is a broken answer, not a default.
type preparationWire struct {
	OperationID            *string `json:"operation_id"`
	RequiresApproval       *bool   `json:"requires_approval"`
	SafetyPreview          *string `json:"safety_preview"`
	Deduplicated           *bool   `json:"deduplicated"`
	ReconciliationRequired *bool   `json:"reconciliation_required"`
}

type receiptWire struct {
	OperationID            *string `json:"operation_id"`
	ExecutionAttemptID     *string `json:"execution_attempt_id"`
	Status                 *string `json:"status"`
	ReceiptRef             *string `json:"receipt_ref"`
	ErrorCode              *string `json:"error_code"`
	ReconciliationRequired *bool   `json:"reconciliation_required"`
	// ResultText is the optional model-visible answer a terminal receipt
	// may carry.
	ResultText *string `json:"result_text"`
}

func (w *receiptWire) complete() bool {
	if w.OperationID == nil || *w.OperationID == "" ||
		w.ExecutionAttemptID == nil || *w.ExecutionAttemptID == "" ||
		w.Status == nil || w.ReceiptRef == nil || *w.ReceiptRef == "" ||
		w.ErrorCode == nil || w.ReconciliationRequired == nil {
		return false
	}
	for _, s := range ReceiptStatuses {
		if *w.Status == s {
			return true
		}
	}
	return false
}

// decodeStrict refuses unknown fields: an answer carrying anything outside
// the contract is probing, not answering.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// refusalWire is the shape of a decisive refusal body. Only the CODE is ever
// surfaced (codes are contract vocabulary); prose stays on the plane.
type refusalWire struct {
	ErrorCode   string  `json:"error_code"`
	OperationID *string `json:"operation_id"`
}

// mapRefusal turns a non-200 status into the typed outcome. 401/403 are the
// plane's decisive refusals; 400/422 are decisive shape refusals; anything
// else (3xx unfollowed, 5xx, exotic codes) is the plane's verdict being
// unknowable here.
func mapRefusal(status int, data []byte) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: status %d", ErrAuthorizationRefused, status)
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: status %d", ErrInvalidWire, status)
	default:
		return fmt.Errorf("%w: status %d", ErrOutcomeUnknown, status)
	}
}

// conflictError separates the two 409s the plane can answer with: a frozen
// operation awaiting reconciliation (carrying its operation id) and a plain
// content/binding conflict.
func conflictError(data []byte) error {
	var refusal refusalWire
	_ = json.Unmarshal(data, &refusal)
	if refusal.ErrorCode == "reconciliation_required" {
		frozen := ""
		if refusal.OperationID != nil {
			frozen = *refusal.OperationID
		}
		return &ReconciliationError{OperationID: frozen}
	}
	return ErrOperationConflict
}

// validatePreparation refuses an incomplete or malformed proposal before
// any dial: identity and binding coordinates are never defaulted, and args
// that are not a JSON object are a proposal the plane cannot read.
func validatePreparation(p ToolPreparation) error {
	for field, value := range map[string]string{
		"tool_name":            p.ToolName,
		"run_id":               p.RunID,
		"attempt_id":           p.AttemptID,
		"tool_call_id":         p.ToolCallID,
		"step_id":              p.StepID,
		"installation_version": p.InstallationVersion,
		"target":               p.Target,
		"fencing_token":        p.FencingToken,
	} {
		if value == "" {
			return fmt.Errorf("%w: preparation is missing %s", ErrInvalidWire, field)
		}
	}
	trimmed := bytes.TrimSpace(p.Args)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: args must be a JSON object", ErrInvalidWire)
	}
	var object map[string]any
	if err := json.Unmarshal(trimmed, &object); err != nil {
		return fmt.Errorf("%w: args must be a JSON object", ErrInvalidWire)
	}
	return nil
}

// validateExecution refuses an incomplete spend request before any dial:
// the platform re-checks every one of these, and a request this runtime
// could not even name is not spent.
func validateExecution(e ToolExecution) error {
	for field, value := range map[string]string{
		"operation_id":  e.OperationID,
		"attempt_id":    e.AttemptID,
		"args_digest":   e.ArgsDigest,
		"fencing_token": e.FencingToken,
	} {
		if value == "" {
			return fmt.Errorf("%w: execution is missing %s", ErrInvalidWire, field)
		}
	}
	return nil
}

// post performs the single fixed attempt both methods share: strict body,
// private-context credentials in headers, redirects refused, answer
// bounded. It returns the status and raw body for the caller's own decode.
func (c Client) post(ctx context.Context, suffix string, payload any) (int, []byte, error) {
	base, err := approvedEndpoint(c.Endpoint)
	if err != nil {
		return 0, nil, err
	}
	creds, ok := identity.ToolCredentialsFromContext(ctx)
	if !ok {
		return 0, nil, ErrUnauthenticated
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	endpoint := strings.TrimSuffix(base, "/") + suffix
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-openbot-runtime-service-credential", creds.ServiceCredential)
	req.Header.Set("x-openbot-runtime-capability", creds.Capability)

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
	// The total bound: a client with no timeout of its own gets this one,
	// so every call is bounded and a silent plane cannot hold the run.
	if client.Timeout <= 0 {
		client.Timeout = c.timeout()
	}

	res, err := client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %v", ErrOutcomeUnknown, err)
	}
	defer func() {
		_ = res.Body.Close()
		// Drain a little so a keep-alive connection is not poisoned, bounded
		// so a hostile plane cannot hold the caller with an endless body.
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, MaxResponseBytes))
	}()

	data, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return 0, nil, fmt.Errorf("%w: unreadable answer", ErrOutcomeUnknown)
	}
	if int64(len(data)) > MaxResponseBytes {
		return 0, nil, fmt.Errorf("%w: answer exceeds %d bytes", ErrOutcomeUnknown, MaxResponseBytes)
	}
	return res.StatusCode, data, nil
}

// timeout resolves the total round-trip bound: the caller's explicit Timeout,
// or the documented default when none was set.
func (c Client) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return DefaultTimeout
}

// approvedEndpoint accepts a configured http/https URL without userinfo and
// returns it unchanged.
//
// The endpoint is not refused for being private or loopback: production tool
// planes are internal platform addresses by design. The surface guarded
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
