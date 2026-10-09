package callback

/*
 * The enterprise tool-invocation contract (master plan §4.2, 01 plan R3-A):
 * Prepare proposes an operation, Execute spends it and returns a receipt.
 */

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"openbot/runtime-go/internal/identity"
)

const (
	testServiceCredential = "test-service-credential-not-a-real-one"
	testCapability        = "test-capability-not-a-real-one"
)

func toolCtx() context.Context {
	return identity.WithToolCredentials(context.Background(), identity.ToolCredentials{
		ServiceCredential: testServiceCredential,
		Capability:        testCapability,
	})
}

var canonicalArgs = []byte(`{"limit":3,"search":"incident"}`)

type planeStub struct {
	mu       sync.Mutex
	hits     map[string]int
	requests []planeRequest
	status   int
	response string
}

type planeRequest struct {
	Method            string
	Path              string
	ServiceCredential string
	Capability        string
	ContentType       string
	Body              map[string]any
	RawBody           string
}

func newPlaneStub(status int, response string) *planeStub {
	return &planeStub{hits: map[string]int{}, status: status, response: response}
}

func (s *planeStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.hits[r.URL.Path]++
	req := planeRequest{
		Method:            r.Method,
		Path:              r.URL.Path,
		ServiceCredential: r.Header.Get("x-openbot-runtime-service-credential"),
		Capability:        r.Header.Get("x-openbot-runtime-capability"),
		ContentType:       r.Header.Get("Content-Type"),
	}
	raw, _ := io.ReadAll(r.Body)
	req.RawBody = string(raw)
	parsed := map[string]any{}
	_ = json.Unmarshal(raw, &parsed)
	req.Body = parsed
	s.requests = append(s.requests, req)
	status, response := s.status, s.response
	s.mu.Unlock()
	if status == http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, response)
}

func (s *planeStub) total() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, v := range s.hits {
		n += v
	}
	return n
}

func (s *planeStub) last() planeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		return planeRequest{}
	}
	return s.requests[len(s.requests)-1]
}

const validPreparationAnswer = `{"operation_id":"op_1","requires_approval":false,"safety_preview":"would search","deduplicated":false,"reconciliation_required":false}`
const validReceipt = `{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"succeeded","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":false,"result_text":"plane-answer-ok"}`

const (
	pathInfix  = "/internal/enterprise/v1/tool-invocations"
	prepareSeg = "/prepare"
)

func planePrefix(srv *httptest.Server) string {
	return fmt.Sprintf("%s%s", srv.URL, pathInfix)
}

func samplePreparation() ToolPreparation {
	return ToolPreparation{
		ToolName:            "approved_tool",
		RunID:               "run_1",
		AttemptID:           "attempt_1",
		ToolCallID:          "run_1|attempt_1|approved_tool|001",
		StepID:              "turn_1",
		InstallationVersion: "approved_tool@1.2.3",
		Target:              "approved_tool",
		Args:                canonicalArgs,
		FencingToken:        "fencing_1",
	}
}

func sampleExecution() ToolExecution {
	return ToolExecution{
		OperationID:  "op_1",
		AttemptID:    "attempt_1",
		ArgsDigest:   DigestArgs(canonicalArgs),
		FencingToken: "fencing_1",
	}
}

// The plan's own first rule, carried to the new contract: a receipt that
// never arrives must not re-spend the operation. One attempt, then unknown.
func TestExecuteDoesNotRetryUnknownOutcome(t *testing.T) {
	var n atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		time.Sleep(50 * time.Millisecond)
	}))
	defer s.Close()
	c := Client{HTTP: &http.Client{Timeout: 10 * time.Millisecond}, Endpoint: planePrefix(s)}
	_, err := c.Execute(toolCtx(), sampleExecution())
	if err == nil || n.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, n.Load())
	}
}

// callPrepare/callExecute are thin local aliases for the two contract
// methods, so each test below reads as one governed operation crossing the
// plane.
func callPrepare(c Client, ctx context.Context, p ToolPreparation) (Preparation, error) {
	return c.Prepare(ctx, p)
}

func callExecute(c Client, ctx context.Context, e ToolExecution) (Receipt, error) {
	return c.Execute(ctx, e)
}

// The digest the client signs is the digest the plane recomputes: Go's
// canonical map encoding is deterministic regardless of construction order.
func TestDigestArgsIsStableAcrossConstructionOrder(t *testing.T) {
	a, _ := json.Marshal(map[string]any{"search": "incident", "limit": 3.0, "nested": map[string]any{"z": 1, "a": 2}})
	b, _ := json.Marshal(map[string]any{"nested": map[string]any{"a": 2, "z": 1}, "limit": 3.0, "search": "incident"})
	if DigestArgs(a) != DigestArgs(b) {
		t.Fatalf("digest drifted with construction order: %s != %s", DigestArgs(a), DigestArgs(b))
	}
}

// The prepare wire is the contract's, exactly: the fixed internal path, the
// credential pair from the PRIVATE CONTEXT in headers (never body fields, so
// nothing model-chosen can carry identity), and the strict field set with
// the args verbatim plus the digest the client computed over those exact
// bytes.
func TestPrepareSendsStrictWireRequest(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validPreparationAnswer)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	prep, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: prefix}, toolCtx(), samplePreparation())
	if err != nil {
		t.Fatalf("valid prepare failed: %v", err)
	}
	if prep.OperationID != "op_1" || prep.RequiresApproval || prep.ReconciliationRequired {
		t.Fatalf("decoded preparation = %+v", prep)
	}
	got := stub.last()
	if got.Method != http.MethodPost {
		t.Fatalf("method = %q, want POST", got.Method)
	}
	if got.Path != pathInfix+prepareSeg {
		t.Fatalf("path = %q, want the fixed internal prepare path %q", got.Path, pathInfix+prepareSeg)
	}
	if got.ServiceCredential != testServiceCredential || got.Capability != testCapability {
		t.Fatalf("credentials = %q/%q, want the private-context pair in headers", got.ServiceCredential, got.Capability)
	}
	if got.ContentType != "application/json" {
		t.Fatalf("Content-Type = %q", got.ContentType)
	}
	wantFields := []string{
		"tool_name", "run_id", "attempt_id", "tool_call_id", "step_id",
		"installation_version", "target", "args", "args_digest", "fencing_token",
	}
	if len(got.Body) != len(wantFields) {
		t.Fatalf("prepare body = %#v, want exactly the contract fields %v", got.Body, wantFields)
	}
	for _, field := range wantFields {
		if _, ok := got.Body[field]; !ok {
			t.Fatalf("prepare body is missing %q: %#v", field, got.Body)
		}
	}
	// Args ride verbatim and the digest is over exactly those bytes: a
	// caller cannot propose one thing and sign another.
	sentArgs, err := json.Marshal(got.Body["args"])
	if err != nil {
		t.Fatal(err)
	}
	if string(sentArgs) != string(canonicalArgs) {
		t.Fatalf("args on the wire = %s, want the canonical bytes verbatim", sentArgs)
	}
	if got.Body["args_digest"] != DigestArgs(canonicalArgs) {
		t.Fatalf("args_digest = %#v, want the digest of the exact args bytes", got.Body["args_digest"])
	}
}

// Args that are not a JSON object are refused before any dial: the plane
// parses anything else as "not an object", and a proposal the plane cannot
// read must never leave this process as if it had been made.
func TestPrepareRefusesArgsThatAreNotAnObject(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validPreparationAnswer)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	for name, args := range map[string][]byte{
		"null":  []byte(`null`),
		"array": []byte(`[1,2]`),
		"text":  []byte(`"incident"`),
		"empty": nil,
	} {
		p := samplePreparation()
		p.Args = args
		if _, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: prefix}, toolCtx(), p); err == nil {
			t.Fatalf("%s: non-object args accepted", name)
		}
		if stub.total() != 0 {
			t.Fatalf("%s: a refused proposal still reached the plane", name)
		}
	}
}

// Every string field of the preparation is required: identity and binding
// coordinates are never defaulted, because a field the runtime invented is
// a field the plane never vouched for.
func TestPrepareRefusesIncompletePreparations(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validPreparationAnswer)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	emptiers := map[string]func(*ToolPreparation){
		"ToolName":            func(p *ToolPreparation) { p.ToolName = "" },
		"RunID":               func(p *ToolPreparation) { p.RunID = "" },
		"AttemptID":           func(p *ToolPreparation) { p.AttemptID = "" },
		"ToolCallID":          func(p *ToolPreparation) { p.ToolCallID = "" },
		"StepID":              func(p *ToolPreparation) { p.StepID = "" },
		"InstallationVersion": func(p *ToolPreparation) { p.InstallationVersion = "" },
		"Target":              func(p *ToolPreparation) { p.Target = "" },
		"FencingToken":        func(p *ToolPreparation) { p.FencingToken = "" },
	}
	for field, empty := range emptiers {
		p := samplePreparation()
		empty(&p)
		if _, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: prefix}, toolCtx(), p); err == nil {
			t.Fatalf("empty %s accepted", field)
		}
		if stub.total() != 0 {
			t.Fatalf("an incomplete proposal (empty %s) still reached the plane", field)
		}
	}
}

// The execute wire: the operation's own fixed path, the strict request
// field set — approval_ref rides only when there is one to present — and
// the same private-context credential pair.
func TestExecuteSendsStrictWireRequest(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validReceipt)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	receipt, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: prefix}, toolCtx(), sampleExecution())
	if err != nil {
		t.Fatalf("valid execute failed: %v", err)
	}
	if receipt.OperationID != "op_1" || receipt.Status != "succeeded" {
		t.Fatalf("decoded receipt = %+v", receipt)
	}
	got := stub.last()
	if got.Method != http.MethodPost {
		t.Fatalf("method = %q, want POST", got.Method)
	}
	if got.Path != fmt.Sprintf("%s/op_1/execute", pathInfix) {
		t.Fatalf("path = %q, want %q", got.Path, fmt.Sprintf("%s/op_1/execute", pathInfix))
	}
	if got.ServiceCredential != testServiceCredential || got.Capability != testCapability {
		t.Fatalf("credentials = %q/%q, want the private-context pair", got.ServiceCredential, got.Capability)
	}
	if len(got.Body) != 4 {
		t.Fatalf("execute body = %#v, want exactly {operation_id,attempt_id,args_digest,fencing_token}", got.Body)
	}

	// With an approval reference the body carries exactly one more field.
	stub2 := newPlaneStub(http.StatusOK, validReceipt)
	srv2 := httptest.NewServer(stub2)
	defer srv2.Close()
	e := sampleExecution()
	e.ApprovalRef = "approval_1"
	if _, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv2)}, toolCtx(), e); err != nil {
		t.Fatalf("approved execute failed: %v", err)
	}
	got = stub2.last()
	if len(got.Body) != 5 || got.Body["approval_ref"] != "approval_1" {
		t.Fatalf("execute body with approval = %#v", got.Body)
	}
}

// An execute request is refused locally when its binding coordinates are
// incomplete: the plane re-checks them, but a request this runtime could
// not even name is not spent.
func TestExecuteRefusesIncompleteRequests(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validReceipt)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	emptiers := map[string]func(*ToolExecution){
		"OperationID":  func(e *ToolExecution) { e.OperationID = "" },
		"AttemptID":    func(e *ToolExecution) { e.AttemptID = "" },
		"ArgsDigest":   func(e *ToolExecution) { e.ArgsDigest = "" },
		"FencingToken": func(e *ToolExecution) { e.FencingToken = "" },
	}
	for field, empty := range emptiers {
		e := sampleExecution()
		empty(&e)
		if _, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: prefix}, toolCtx(), e); err == nil {
			t.Fatalf("empty %s accepted", field)
		}
	}
	if stub.total() != 0 {
		t.Fatalf("an incomplete execute still reached the plane")
	}
}

// A receipt is decoded only when it is the whole contract: the frozen status
// enum, the execution attempt the plane allocated, and no fields the
// contract does not name. Anything else is an answer this runtime cannot
// show the model as a result.
func TestExecuteDecodesReceiptStrictly(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		wantOK bool
	}{
		{"complete receipt", validReceipt, true},
		{"status not in the frozen enum", `{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"pending","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":false}`, false},
		{"missing execution_attempt_id", `{"operation_id":"op_1","status":"succeeded","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":false}`, false},
		{"missing receipt_ref", `{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"succeeded","error_code":"","reconciliation_required":false}`, false},
		{"missing reconciliation_required", `{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"succeeded","receipt_ref":"rcpt_1","error_code":""}`, false},
		{"field outside the contract", `{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"succeeded","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":false,"text":"smuggled answer"}`, false},
		{"not json", "this is not json", false},
	}
	for _, c := range cases {
		stub := newPlaneStub(http.StatusOK, c.body)
		srv := httptest.NewServer(stub)
		_, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
		srv.Close()
		if c.wantOK && err != nil {
			t.Fatalf("%s: rejected a valid receipt: %v", c.name, err)
		}
		if !c.wantOK && (err == nil || !errors.Is(err, ErrOutcomeUnknown)) {
			t.Fatalf("%s: err = %v, want ErrOutcomeUnknown", c.name, err)
		}
	}
}

// The receipt statuses the contract freezes are all decodable, including
// the ones that freeze the operation instead of answering it.
func TestExecuteDecodesEveryFrozenStatus(t *testing.T) {
	for _, status := range ReceiptStatuses {
		body := fmt.Sprintf(`{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"%s","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":true}`, status)
		stub := newPlaneStub(http.StatusOK, body)
		srv := httptest.NewServer(stub)
		receipt, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
		srv.Close()
		if err != nil {
			t.Fatalf("status %s: %v", status, err)
		}
		if receipt.Status != status {
			t.Fatalf("status %s decoded as %q", status, receipt.Status)
		}
	}
}

// The preparation answer is decoded just as strictly: an operation
// reference is the minimum the plane owes a proposal, and unknown fields
// are refused rather than ignored.
func TestPrepareDecodesAnswerStrictly(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		wantOK bool
	}{
		{"complete answer", validPreparationAnswer, true},
		{"missing operation_id", `{"requires_approval":false,"safety_preview":"would search","deduplicated":false,"reconciliation_required":false}`, false},
		{"missing requires_approval", `{"operation_id":"op_1","safety_preview":"would search","deduplicated":false,"reconciliation_required":false}`, false},
		{"field outside the contract", `{"operation_id":"op_1","requires_approval":false,"safety_preview":"would search","deduplicated":false,"reconciliation_required":false,"text":"smuggled answer"}`, false},
		{"not json", "nope", false},
	}
	for _, c := range cases {
		stub := newPlaneStub(http.StatusOK, c.body)
		srv := httptest.NewServer(stub)
		_, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), samplePreparation())
		srv.Close()
		if c.wantOK && err != nil {
			t.Fatalf("%s: rejected a valid answer: %v", c.name, err)
		}
		if !c.wantOK && (err == nil || !errors.Is(err, ErrOutcomeUnknown)) {
			t.Fatalf("%s: err = %v, want ErrOutcomeUnknown", c.name, err)
		}
	}
}

// 401/403 are the plane's decisive refusals (unknown or expired capability,
// an operation this principal may not touch, an approval that does not
// hold). The call was not made, retrying cannot help, and the plane's own
// wording stays on the plane.
func TestAuthorizationRefusalsAreDecisiveAndDoNotLeak(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
	}{
		{"unverified capability", http.StatusUnauthorized},
		{"refused by policy", http.StatusForbidden},
	} {
		stub := newPlaneStub(c.status, `{"error_code":"leak-bait-secret-detail"}`)
		srv := httptest.NewServer(stub)
		_, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
		srv.Close()
		if !errors.Is(err, ErrAuthorizationRefused) {
			t.Fatalf("%s: err = %v, want ErrAuthorizationRefused", c.name, err)
		}
		if strings.Contains(err.Error(), "leak-bait-secret-detail") {
			t.Fatalf("%s: refusal body leaked into the error: %v", c.name, err)
		}
	}
}

// 409 with the reconciliation code is the plane freezing an operation this
// runtime must not spend again; 409 without it is a content/binding
// conflict. Both are decisive, and the reconciliation refusal carries the
// operation it froze.
func TestConflictsAreTyped(t *testing.T) {
	stub := newPlaneStub(http.StatusConflict, `{"error_code":"reconciliation_required","operation_id":"op_stuck"}`)
	srv := httptest.NewServer(stub)
	_, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), samplePreparation())
	srv.Close()
	var re *ReconciliationError
	if !errors.As(err, &re) || !errors.Is(err, ErrReconciliationRequired) {
		t.Fatalf("err = %v, want ErrReconciliationRequired", err)
	}
	if re.OperationID != "op_stuck" {
		t.Fatalf("frozen operation = %q, want op_stuck", re.OperationID)
	}

	stub2 := newPlaneStub(http.StatusConflict, `{"error_code":"operation_conflict"}`)
	srv2 := httptest.NewServer(stub2)
	defer srv2.Close()
	_, err = callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv2)}, toolCtx(), sampleExecution())
	if !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("err = %v, want ErrOperationConflict", err)
	}
}

// A shape refusal (400) is decisive: the plane rejected the request as
// unreadable or inconsistent, which a retry of the same bytes cannot fix.
func TestShapeRefusalsAreDecisive(t *testing.T) {
	for _, method := range []string{"prepare", "execute"} {
		stub := newPlaneStub(http.StatusBadRequest, `{"error_code":"digest_mismatch"}`)
		srv := httptest.NewServer(stub)
		var err error
		if method == "prepare" {
			_, err = callPrepare(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), samplePreparation())
		} else {
			_, err = callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
		}
		srv.Close()
		if !errors.Is(err, ErrInvalidWire) {
			t.Fatalf("%s: err = %v, want ErrInvalidWire", method, err)
		}
	}
}

// 404 on execute: the authoritative plane says the operation does not
// exist, so nothing was submitted through it. Decisive, not unknown.
func TestExecuteMapsUnknownOperationDecisively(t *testing.T) {
	stub := newPlaneStub(http.StatusNotFound, `{"error_code":"operation_not_found"}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	_, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
	if !errors.Is(err, ErrOperationNotFound) {
		t.Fatalf("err = %v, want ErrOperationNotFound", err)
	}
}

// A connection the client cannot complete is an unknown outcome: the
// request may or may not have reached the plane, and only the plane's own
// receipt can settle it.
func TestNetworkFailureIsAnUnknownOutcome(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listens here anymore

	err := func() error {
		_, err := callExecute(Client{HTTP: &http.Client{Timeout: time.Second}, Endpoint: fmt.Sprintf("%s%s", url, pathInfix)}, toolCtx(), sampleExecution())
		return err
	}()
	if !errors.Is(err, ErrOutcomeUnknown) {
		t.Fatalf("err = %v, want OUTCOME_UNKNOWN", err)
	}
	if errors.Is(err, ErrAuthorizationRefused) {
		t.Fatalf("a network failure must not read as an authorization refusal: %v", err)
	}
}

// 5xx from the plane is the plane being wrong, not the caller refused: the
// operation may or may not have run behind the error. Unknown, one attempt.
func TestServerFailureIsAnUnknownOutcome(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		stub := newPlaneStub(status, "upstream exploded")
		srv := httptest.NewServer(stub)
		_, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
		srv.Close()
		if !errors.Is(err, ErrOutcomeUnknown) {
			t.Fatalf("status %d: err = %v, want OUTCOME_UNKNOWN", status, err)
		}
		if strings.Contains(err.Error(), "upstream exploded") {
			t.Fatalf("status %d: server body leaked into the error: %v", status, err)
		}
	}
}

// Redirects are refused even when the caller hands us a stock http.Client
// that would happily follow them: a 3xx must never become a second request
// the operator did not configure.
func TestRedirectsAreRefused(t *testing.T) {
	var targetHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, prepareSeg) {
			w.Header().Set("Location", fmt.Sprintf("http://%s/attacker", r.Host))
			w.WriteHeader(http.StatusFound)
			return
		}
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), samplePreparation())
	if !errors.Is(err, ErrOutcomeUnknown) {
		t.Fatalf("err = %v, want OUTCOME_UNKNOWN for a refused redirect", err)
	}
	if targetHits.Load() != 0 {
		t.Fatalf("redirect target hit %d times", targetHits.Load())
	}
}

// A receipt is bounded text; anything past the cap is a plane holding this
// process on an endless body, and reads as unknown — never as an answer.
func TestOversizedAnswersAreRefused(t *testing.T) {
	huge := fmt.Sprintf(`{"operation_id":"op_1","execution_attempt_id":"exec_1","status":"succeeded","receipt_ref":"rcpt_1","error_code":"","reconciliation_required":false,"result_text":"%s"}`, strings.Repeat("x", 1<<20))
	stub := newPlaneStub(http.StatusOK, huge)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	_, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: planePrefix(srv)}, toolCtx(), sampleExecution())
	if !errors.Is(err, ErrOutcomeUnknown) {
		t.Fatalf("err = %v, want OUTCOME_UNKNOWN for an oversized answer", err)
	}
}

// The credential pair exists only in the private context the auth middleware
// builds. A context without it refuses BEFORE any dial — there is no
// anonymous tool call, and no credentials anywhere a model could set them.
func TestCredentialsComeOnlyFromThePrivateContext(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validReceipt)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	prefix := planePrefix(srv)

	if _, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: prefix}, context.Background(), sampleExecution()); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("execute err = %v, want ErrUnauthenticated", err)
	}
	if _, err := callPrepare(Client{HTTP: &http.Client{}, Endpoint: prefix}, context.Background(), samplePreparation()); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("prepare err = %v, want ErrUnauthenticated", err)
	}
	if stub.total() != 0 {
		t.Fatalf("a context without credentials still reached the plane %d times", stub.total())
	}
}

// The endpoint is operator configuration. Anything that is not a plain
// http/https URL without embedded credentials is refused before any dial —
// the model never gets to aim this client anywhere, and neither does a
// misconfigured environment silently get a best-effort call.
func TestEndpointMustBeOperatorConfiguredShape(t *testing.T) {
	stub := newPlaneStub(http.StatusOK, validReceipt)
	srv := httptest.NewServer(stub)
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")

	for name, endpoint := range map[string]string{
		"empty":         "",
		"not a url":     "not a url at all",
		"other scheme":  fmt.Sprintf("ftp://%s%s", host, pathInfix),
		"with userinfo": fmt.Sprintf("http://user:pass@%s%s", host, pathInfix),
	} {
		if _, err := callExecute(Client{HTTP: &http.Client{}, Endpoint: endpoint}, toolCtx(), sampleExecution()); !errors.Is(err, ErrEndpointNotApproved) {
			t.Fatalf("%s: err = %v, want ErrEndpointNotApproved", name, err)
		}
	}
	if stub.total() != 0 {
		t.Fatalf("an unapproved endpoint still reached the network %d times", stub.total())
	}
}
