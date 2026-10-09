package callback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The first test is the plan's own, verbatim: a tool whose receipt never
// arrives must not be re-spent. One attempt, then OUTCOME_UNKNOWN.
func TestCallDoesNotRetryUnknownOutcome(t *testing.T) {
	var n atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		time.Sleep(50 * time.Millisecond)
	}))
	defer s.Close()
	c := Client{HTTP: &http.Client{Timeout: 10 * time.Millisecond}, Endpoint: s.URL, AgentToken: "test-only"}
	_, err := c.Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
	if err == nil || n.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, n.Load())
	}
}

// toolStub records what the governance plane was asked and scripts what it
// answers: status, body, optional delay, and how many times it was reached.
type toolStub struct {
	mu       sync.Mutex
	hits     int
	method   string
	path     string
	body     map[string]any
	rawBody  string
	token    string
	content  string
	status   int
	response string
	delay    time.Duration
}

func newToolStub(status int, response string) *toolStub {
	return &toolStub{status: status, response: response}
}

func (s *toolStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.hits++
	s.method = r.Method
	s.path = r.URL.Path
	s.token = r.Header.Get("x-openbot-agent-token")
	s.content = r.Header.Get("Content-Type")
	raw, _ := io.ReadAll(r.Body)
	s.rawBody = string(raw)
	parsed := map[string]any{}
	_ = json.Unmarshal(raw, &parsed)
	s.body = parsed
	status, response, delay := s.status, s.response, s.delay
	s.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	if status == http.StatusOK {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, response)
}

func (s *toolStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

func (s *toolStub) last() (method, path, token, contentType string, body map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.method, s.path, s.token, s.content, s.body
}

// The wire shape is the platform's, exactly: {run, name, args} with the run
// assertion as its own field and the model's args passed through verbatim.
// Identity never rides inside args, because args are model-chosen and the
// assertion is the credential the plane authorises against.
func TestCallSendsPlatformShapedRequest(t *testing.T) {
	stub := newToolStub(http.StatusOK, `{"text":"ok","isError":false}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	args := map[string]any{"query": "incident", "limit": 3.0}
	res, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "obot_agt_test-only"}.
		Call(context.Background(), "opaque-test-assertion", "approved-tool", args)
	if err != nil {
		t.Fatalf("valid call failed: %v", err)
	}
	if res.Text != "ok" || res.IsError {
		t.Fatalf("decoded result = %+v", res)
	}
	method, path, token, contentType, body := stub.last()
	if method != http.MethodPost {
		t.Fatalf("method = %q, want POST", method)
	}
	if path != "/" && path != "" {
		// The stub is mounted at its root; what matters is that the request
		// went to the configured endpoint, which the hit itself proves.
		t.Fatalf("path = %q, want the configured endpoint root", path)
	}
	if token != "obot_agt_test-only" {
		t.Fatalf("x-openbot-agent-token = %q", token)
	}
	if contentType != "application/json" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if len(body) != 3 {
		t.Fatalf("request body = %#v, want exactly {run,name,args}", body)
	}
	if body["run"] != "opaque-test-assertion" {
		t.Fatalf("run field = %#v", body["run"])
	}
	if body["name"] != "approved-tool" {
		t.Fatalf("name field = %#v", body["name"])
	}
	gotArgs, ok := body["args"].(map[string]any)
	if !ok || len(gotArgs) != 2 || gotArgs["query"] != "incident" || gotArgs["limit"] != 3.0 {
		t.Fatalf("args field = %#v, want the caller's args verbatim with no identity injected", body["args"])
	}
}

// A nil args map must still be an object on the wire: the plane parses null
// as "arguments are not an object" and refuses with 400, which would turn a
// caller's nil into a shaped refusal the caller cannot tell from its own
// mistake.
func TestCallSendsEmptyObjectForNilArgs(t *testing.T) {
	stub := newToolStub(http.StatusOK, `{"text":"ok","isError":false}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	if _, err := (Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}).
		Call(context.Background(), "opaque-test-assertion", "approved-tool", nil); err != nil {
		t.Fatalf("nil-args call failed: %v", err)
	}
	_, _, _, _, body := stub.last()
	args, ok := body["args"].(map[string]any)
	if !ok {
		t.Fatalf("args on the wire = %#v, want an empty object for nil", body["args"])
	}
	if len(args) != 0 {
		t.Fatalf("args on the wire = %#v, want empty", args)
	}
}

// A vendor that answered with isError is an ANSWER, not a failure: revoked
// grants and refused policy read 200 {text, isError:true} on this plane, and
// the model is owed that text.
func TestCallDecodesVendorErrorAsResult(t *testing.T) {
	stub := newToolStub(http.StatusOK, `{"text":"Refused. The grant was revoked.","isError":true}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	res, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}.
		Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
	if err != nil {
		t.Fatalf("a vendor error answer must not be a transport error: %v", err)
	}
	if !res.IsError || res.Text != "Refused. The grant was revoked." {
		t.Fatalf("decoded result = %+v", res)
	}
}

// 401/403 are the plane saying "not authorised" (unknown token, expired or
// forged assertion, a token that belongs to another Bot). These are stable,
// decisive refusals — the call was NOT made, and retrying cannot help.
func TestCallMapsAuthorizationRefusal(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
	}{
		{"unverified credentials", http.StatusUnauthorized},
		{"token is for another bot", http.StatusForbidden},
	} {
		// The refusal body is deliberately loaded with bait: whatever the
		// plane says in a refusal body is its own wording, and none of it
		// belongs in this process's error strings or logs.
		stub := newToolStub(c.status, `{"error":"leak-bait-secret-detail"}`)
		srv := httptest.NewServer(stub)
		_, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}.
			Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
		srv.Close()
		if !errors.Is(err, ErrAuthorizationRefused) {
			t.Fatalf("%s: err = %v, want ErrAuthorizationRefused", c.name, err)
		}
		if stub.count() != 1 {
			t.Fatalf("%s: plane hit %d times, want exactly 1", c.name, stub.count())
		}
		if strings.Contains(err.Error(), "leak-bait-secret-detail") {
			t.Fatalf("%s: refusal body leaked into the error: %v", c.name, err)
		}
	}
}

// A connection the client cannot complete is an unknown outcome: the request
// may or may not have reached the plane, and only the plane's own audit row
// knows. It surfaces as OUTCOME_UNKNOWN, never as a silent success or a
// decisive "refused".
func TestCallReturnsUnknownOutcomeOnNetworkFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listens here anymore

	err := func() error {
		_, err := Client{HTTP: &http.Client{Timeout: time.Second}, Endpoint: url, AgentToken: "test-only"}.
			Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
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
// tool may or may not have run behind the error. Unknown outcome, one attempt.
func TestCallReturnsUnknownOutcomeOnServerFailure(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		stub := newToolStub(status, "upstream exploded")
		srv := httptest.NewServer(stub)
		_, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}.
			Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
		srv.Close()
		if !errors.Is(err, ErrOutcomeUnknown) {
			t.Fatalf("status %d: err = %v, want OUTCOME_UNKNOWN", status, err)
		}
		if strings.Contains(err.Error(), "upstream exploded") {
			t.Fatalf("status %d: server body leaked into the error: %v", status, err)
		}
		if stub.count() != 1 {
			t.Fatalf("status %d: plane hit %d times, want exactly 1", status, stub.count())
		}
	}
}

// Redirects are refused even when the caller hands us a stock http.Client
// that would happily follow them: a 3xx must never become a second request
// the operator did not configure.
func TestCallRefusesToFollowRedirects(t *testing.T) {
	var targetHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "http://"+r.Host+"/attacker")
			w.WriteHeader(http.StatusFound)
			return
		}
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL + "/redirect", AgentToken: "test-only"}.
		Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
	if !errors.Is(err, ErrOutcomeUnknown) {
		t.Fatalf("err = %v, want OUTCOME_UNKNOWN for a refused redirect", err)
	}
	if targetHits.Load() != 0 {
		t.Fatalf("redirect target hit %d times", targetHits.Load())
	}
}

// A tool answer is text; 1 MiB is far past any honest one, and reading
// further would let a hostile plane hold this process on an endless body.
func TestCallRejectsOversizedResponse(t *testing.T) {
	huge := `{"text":"` + strings.Repeat("x", 1<<20) + `"}`
	stub := newToolStub(http.StatusOK, huge)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	_, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}.
		Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
	if !errors.Is(err, ErrOutcomeUnknown) {
		t.Fatalf("err = %v, want OUTCOME_UNKNOWN for an oversized answer", err)
	}
}

// A 200 whose body is not a readable result is still an unknown outcome: the
// call happened, and what came back cannot be shown to the model as an
// answer it never gave.
func TestCallRejectsUnreadableResult(t *testing.T) {
	for name, body := range map[string]string{
		"not json":            "this is not json",
		"missing text field":  `{"isError":false}`,
		"text is not a string": `{"text":42}`,
	} {
		stub := newToolStub(http.StatusOK, body)
		srv := httptest.NewServer(stub)
		_, err := Client{HTTP: &http.Client{}, Endpoint: srv.URL, AgentToken: "test-only"}.
			Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
		srv.Close()
		if !errors.Is(err, ErrOutcomeUnknown) {
			t.Fatalf("%s: err = %v, want OUTCOME_UNKNOWN", name, err)
		}
	}
}

// The endpoint is operator configuration. Anything that is not a plain
// http/https URL without embedded credentials is refused before any dial —
// the model (and, through it, a prompt injector) never gets to aim this
// client anywhere, and neither does a misconfigured environment silently
// get a best-effort call.
func TestCallValidatesConfiguredEndpoint(t *testing.T) {
	stub := newToolStub(http.StatusOK, `{"text":"ok","isError":false}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	for name, endpoint := range map[string]string{
		"empty":         "",
		"not a url":     "not a url at all",
		"other scheme":  "ftp://" + strings.TrimPrefix(srv.URL, "http://"),
		"with userinfo": "http://user:pass@" + strings.TrimPrefix(srv.URL, "http://"),
	} {
		_, err := Client{HTTP: &http.Client{}, Endpoint: endpoint, AgentToken: "test-only"}.
			Call(context.Background(), "opaque-test-assertion", "approved-tool", map[string]any{})
		if !errors.Is(err, ErrEndpointNotApproved) {
			t.Fatalf("%s: err = %v, want ErrEndpointNotApproved", name, err)
		}
	}
	if stub.count() != 0 {
		t.Fatalf("an unapproved endpoint still reached the network %d times", stub.count())
	}
}
