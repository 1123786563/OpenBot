package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"openbot/runtime-go/internal/identity"
)

// testCredential is a fixture for the isolated test process only; no real
// deployment credential is ever written here.
const testCredential = "test-service-credential-not-real"

// validIdentity is the whitelist a healthy TS validation endpoint returns.
const validIdentity = `{"tenantId":"t1","actorId":"a1","botId":"b1","runId":"r1","threadId":"th1"}`

// validationStub records what the middleware sent and answers with scripted
// status, body and optional delay. It stands in for the TS governance plane.
type validationStub struct {
	mu       sync.Mutex
	requests int
	path     string // last path the stub was asked for
	body     map[string]any
	token    string
	status   int
	response string
	delay    time.Duration
}

func newValidationStub(status int, response string) *validationStub {
	return &validationStub{status: status, response: response}
}

func (s *validationStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests++
	s.path = r.URL.Path
	body, _ := io.ReadAll(r.Body)
	parsed := map[string]any{}
	_ = json.Unmarshal(body, &parsed)
	s.body = parsed
	s.token = r.Header.Get("x-openbot-agent-token")
	status, response, delay := s.status, s.response, s.delay
	s.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, response)
}

func (s *validationStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

func (s *validationStub) lastBody() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.body
}

func (s *validationStub) lastToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// guardedNext records whether the protected handler ran, and with what
// identity and request body.
type guardedNext struct {
	mu      sync.Mutex
	called  bool
	run     identity.VerifiedRun
	runErr  error
	body    string
	assert  string
	assertOK bool
}

func (g *guardedNext) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.called = true
		g.run, g.runErr = identity.FromContext(r.Context())
		g.assert, g.assertOK = identity.RunAssertion(r.Context())
		g.mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		g.mu.Lock()
		g.body = string(body)
		g.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})
}

func (g *guardedNext) invoked() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.called
}

func validRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/agui", strings.NewReader(body))
	r.Header.Set(ServiceCredentialHeader, testCredential)
	r.Header.Set(AgentTokenHeader, "obot_agt_test-token")
	r.Header.Set(RunAssertionHeader, "opaque-test-assertion")
	return r
}

func TestAuthReadyRequiresBothCredentialAndEndpoint(t *testing.T) {
	if (AuthConfig{}).Ready() {
		t.Fatal("empty config reported ready")
	}
	if (AuthConfig{ServiceCredential: "c"}).Ready() {
		t.Fatal("config without endpoint reported ready")
	}
	if (AuthConfig{ValidationEndpoint: "http://127.0.0.1:1/validate"}).Ready() {
		t.Fatal("config without credential reported ready")
	}
}

func TestAuthDeniesWhenNotConfigured(t *testing.T) {
	for name, cfg := range map[string]AuthConfig{
		"no credential": {ValidationEndpoint: "http://127.0.0.1:1/validate"},
		"no endpoint":   {ServiceCredential: testCredential},
	} {
		next := &guardedNext{}
		w := httptest.NewRecorder()
		Authenticate(cfg)(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, want 503", name, w.Code)
		}
		if next.invoked() {
			t.Fatalf("%s: unconfigured runtime let a request through", name)
		}
	}
}

func TestAuthRejectsInvalidServiceCredential(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	for name, mutate := range map[string]func(*http.Request){
		"missing credential": func(r *http.Request) { r.Header.Del(ServiceCredentialHeader) },
		"wrong credential": func(r *http.Request) {
			r.Header.Set(ServiceCredentialHeader, "wrong")
		},
	} {
		next := &guardedNext{}
		r := validRequest(`{"runId":"r1","threadId":"th1"}`)
		mutate(r)
		w := httptest.NewRecorder()
		Authenticate(AuthConfig{
			ServiceCredential:  testCredential,
			ValidationEndpoint: srv.URL + "/validate",
		})(next.handler()).ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", name, w.Code)
		}
		if next.invoked() {
			t.Fatalf("%s: bad service credential reached the runner", name)
		}
	}
	if stub.count() != 0 {
		t.Fatalf("validation endpoint hit %d times for unauthenticated callers", stub.count())
	}
}

func TestAuthRejectsMissingRunCredentials(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	for name, mutate := range map[string]func(*http.Request){
		"missing agent token":   func(r *http.Request) { r.Header.Del(AgentTokenHeader) },
		"missing run assertion": func(r *http.Request) { r.Header.Del(RunAssertionHeader) },
	} {
		next := &guardedNext{}
		r := validRequest(`{"runId":"r1","threadId":"th1"}`)
		mutate(r)
		w := httptest.NewRecorder()
		Authenticate(AuthConfig{
			ServiceCredential:  testCredential,
			ValidationEndpoint: srv.URL + "/validate",
		})(next.handler()).ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, w.Code)
		}
		if next.invoked() {
			t.Fatalf("%s: request without run credentials reached the runner", name)
		}
	}
	if stub.count() != 0 {
		t.Fatalf("validation endpoint hit %d times without run credentials", stub.count())
	}
}

func TestAuthValidatesAndInjectsVerifiedIdentity(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if !next.invoked() {
		t.Fatal("validated request did not reach the runner")
	}
	if next.runErr != nil {
		t.Fatalf("runner context has no verified identity: %v", next.runErr)
	}
	want := identity.VerifiedRun{TenantID: "t1", ActorID: "a1", BotID: "b1", RunID: "r1", ThreadID: "th1"}
	if next.run != want {
		t.Fatalf("verified identity = %+v, want %+v", next.run, want)
	}
	if !next.assertOK || next.assert != "opaque-test-assertion" {
		t.Fatalf("callback assertion not preserved in private context (ok=%v value=%q)", next.assertOK, next.assert)
	}
	if stub.count() != 1 {
		t.Fatalf("validation endpoint hit %d times, want exactly 1", stub.count())
	}
	if stub.lastToken() != "obot_agt_test-token" {
		t.Fatalf("agent token not forwarded to validation endpoint: %q", stub.lastToken())
	}
	if stub.path != "/validate" {
		t.Fatalf("validation requested path %q, want /validate", stub.path)
	}
	// The protected handler must still be able to read the original body.
	if next.body != `{"runId":"r1","threadId":"th1"}` {
		t.Fatalf("runner saw body %q, want the original request body", next.body)
	}
}

func TestAuthForwardsOnlyWhitelistedFieldsToValidation(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	// The inbound AG-UI body carries state, forwardedProps and other fields a
	// client may stuff in; none of it may reach the governance plane, because
	// the governance plane vouches for credentials, not for client payloads.
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(
		`{"runId":"r1","threadId":"th1","state":{"private":"secret"},"forwardedProps":{"assertion":"forged"},"messages":[{"role":"user","content":"hi"}]}`,
	))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body := stub.lastBody()
	if len(body) != 3 {
		t.Fatalf("validation body = %#v, want exactly the whitelisted fields", body)
	}
	for _, key := range []string{"assertion", "runId", "threadId"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("validation body missing %q: %#v", key, body)
		}
	}
	if body["runId"] != "r1" || body["threadId"] != "th1" || body["assertion"] != "opaque-test-assertion" {
		t.Fatalf("validation body carried wrong values: %#v", body)
	}
}

func TestAuthMapsValidationRefusals(t *testing.T) {
	// 401 is "your credentials do not verify" (expired signature, closed
	// token, forged actor); 403 is "verified, but bound to another run"
	// (same thread, different tenant). 503 and anything else is the plane
	// being unavailable, which is never the caller's success.
	for _, c := range []struct {
		name   string
		status int
		want   int
	}{
		{"unverified identity", http.StatusUnauthorized, http.StatusUnauthorized},
		{"run binding mismatch", http.StatusForbidden, http.StatusForbidden},
		{"validation endpoint down", http.StatusServiceUnavailable, http.StatusBadGateway},
		{"validation endpoint error", http.StatusInternalServerError, http.StatusBadGateway},
	} {
		stub := newValidationStub(c.status, `{}`)
		srv := httptest.NewServer(stub)
		next := &guardedNext{}
		w := httptest.NewRecorder()
		Authenticate(AuthConfig{
			ServiceCredential:  testCredential,
			ValidationEndpoint: srv.URL + "/validate",
		})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))
		srv.Close()
		if w.Code != c.want {
			t.Fatalf("%s: status = %d, want %d", c.name, w.Code, c.want)
		}
		if next.invoked() {
			t.Fatalf("%s: refused validation still reached the runner", c.name)
		}
	}
}

func TestAuthRefusesRedirectedValidation(t *testing.T) {
	var targetHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/validate" {
			// The redirect points back at this same stub under a path a
			// following client would request; a refusing client never asks.
			w.Header().Set("Location", "http://"+r.Host+"/attacker")
			w.WriteHeader(http.StatusFound)
			return
		}
		targetHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a redirected validation response", w.Code)
	}
	if targetHits != 0 {
		t.Fatalf("validation client followed a redirect %d times", targetHits)
	}
	if next.invoked() {
		t.Fatal("redirected validation still let the request through")
	}
}

func TestAuthRejectsOversizedValidationResponse(t *testing.T) {
	huge := `{"padding":"` + strings.Repeat("x", 2<<20) + `"}`
	stub := newValidationStub(http.StatusOK, huge)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for an oversized validation response", w.Code)
	}
	if next.invoked() {
		t.Fatal("oversized validation response still let the request through")
	}
}

func TestAuthRejectsOversizedInboundBody(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	big := `{"runId":"r1","threadId":"th1","padding":"` + strings.Repeat("y", 2<<20) + `"}`
	r := validRequest(big)
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
		MaxInboundBytes:    1 << 20,
	})(next.handler()).ServeHTTP(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 for an oversized inbound body", w.Code)
	}
	if next.invoked() {
		t.Fatal("oversized inbound body still reached the runner")
	}
	if stub.count() != 0 {
		t.Fatalf("validation endpoint hit %d times for an oversized body", stub.count())
	}
}

func TestAuthTimesOutSlowValidationWithoutRetry(t *testing.T) {
	stub := newValidationStub(http.StatusOK, validIdentity)
	stub.delay = 150 * time.Millisecond
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
		Timeout:            20 * time.Millisecond,
	})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a timed-out validation", w.Code)
	}
	if stub.count() != 1 {
		t.Fatalf("validation endpoint hit %d times, want exactly 1 (no retries)", stub.count())
	}
	if next.invoked() {
		t.Fatal("timed-out validation still let the request through")
	}
}

func TestAuthIncompleteValidationIdentityIsRefused(t *testing.T) {
	// The plane answered 200 but without the whole whitelist (here: no
	// threadId). The runtime must refuse rather than run with a half identity.
	stub := newValidationStub(http.StatusOK, `{"tenantId":"t1","actorId":"a1","botId":"b1","runId":"r1"}`)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(`{"runId":"r1","threadId":"th1"}`))

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for an incomplete identity", w.Code)
	}
	if next.invoked() {
		t.Fatal("incomplete identity still let the request through")
	}
}

func TestAuthValidationEndpointComesOnlyFromConfiguration(t *testing.T) {
	// The endpoint the middleware calls is the configured one, regardless of
	// anything the request body or headers claim.
	stub := newValidationStub(http.StatusOK, validIdentity)
	srv := httptest.NewServer(stub)
	defer srv.Close()

	next := &guardedNext{}
	w := httptest.NewRecorder()
	Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/validate",
	})(next.handler()).ServeHTTP(w, validRequest(
		`{"runId":"r1","threadId":"th1","validationEndpoint":"http://127.0.0.1:9/malicious"}`,
	))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if stub.count() != 1 {
		t.Fatalf("validation endpoint hit %d times, want 1", stub.count())
	}
	if stub.path != "/validate" {
		t.Fatalf("validation requested path %q, want the configured /validate", stub.path)
	}
}
