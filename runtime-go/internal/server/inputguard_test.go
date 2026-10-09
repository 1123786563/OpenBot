package server

/*
 * The execution-only input guard, over the full auth+guard chain: the digest
 * and turn-binding refusals that were the auth middleware's own until cancel
 * proved the split necessary (a cancel body carries no messages, so an input
 * digest comparison there would refuse every legitimate cancel).
 */

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"openbot/runtime-go/internal/identity"
)

// chain builds the execution-shaped assembly: auth, then the input guard,
// then the handler under test.
func chain(t *testing.T, stub *validationStub, next http.Handler) http.Handler {
	t.Helper()
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	auth := Authenticate(AuthConfig{
		ServiceCredential:  testCredential,
		ValidationEndpoint: srv.URL + "/internal/enterprise/v1/runtime/validate",
	})
	return auth(RequireVerifiedInput()(next))
}

// 错误摘要: the envelope vouches for one input; a different input arriving is
// a binding refusal at the guard, before the runner exists.
func TestInputGuardRefusesDigestMismatch(t *testing.T) {
	stub := newValidationStub(http.StatusOK, envelopeJSON(func(f map[string]any) {
		f["input_digest"] = "digest_of_entirely_other_content"
	}))
	next := &guardedNext{}
	w := httptest.NewRecorder()
	chain(t, stub, next.handler()).ServeHTTP(w, validRequest(testRunBody, envelopeJSON(nil)))

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for an input digest mismatch", w.Code)
	}
	if next.invoked() {
		t.Fatal("a run whose input the envelope did not vouch for reached the runner")
	}
	if stub.count() != 1 {
		t.Fatalf("validation endpoint hit %d times, want 1", stub.count())
	}
}

// The AG-UI runId IS the envelope's turn_id; the thread must agree. A body
// claiming somebody else's coordinates is refused at the guard.
func TestInputGuardRefusesTurnBindingMismatch(t *testing.T) {
	for name, body := range map[string]string{
		"other run":    `{"runId":"turn_somebody_elses","threadId":"th1","messages":[{"role":"user","content":"hi"}]}`,
		"other thread": `{"runId":"turn_1","threadId":"thread_somebody_elses","messages":[{"role":"user","content":"hi"}]}`,
	} {
		stub := newValidationStub(http.StatusOK, envelopeJSON(nil))
		next := &guardedNext{}
		w := httptest.NewRecorder()
		chain(t, stub, next.handler()).ServeHTTP(w, validRequest(body, envelopeJSON(nil)))
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s: status = %d, want 403", name, w.Code)
		}
		if next.invoked() {
			t.Fatalf("%s: mismatched binding reached the runner", name)
		}
	}
}

// A matching digest and binding pass through to the runner untouched.
func TestInputGuardAdmitsMatchingInput(t *testing.T) {
	stub := newValidationStub(http.StatusOK, envelopeJSON(nil))
	next := &guardedNext{}
	w := httptest.NewRecorder()
	chain(t, stub, next.handler()).ServeHTTP(w, validRequest(testRunBody, envelopeJSON(nil)))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if !next.invoked() {
		t.Fatal("matching input did not reach the runner")
	}
}

// An assembly error (the guard mounted without the auth middleware's
// projection) is a 500, never a waved-through request.
func TestInputGuardRefusesWithoutAuthProjection(t *testing.T) {
	next := &guardedNext{}
	w := httptest.NewRecorder()
	// A verified identity WITHOUT the inbound projection: the auth
	// middleware was skipped, so the guard refuses loudly.
	r := httptest.NewRequest(http.MethodPost, "/run", nil)
	r.Header.Set(ServiceCredentialHeader, testCredential)
	r = r.WithContext(identity.WithVerified(r.Context(), wantEnvelope()))
	RequireVerifiedInput()(next.handler()).ServeHTTP(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 for a mis-assembled guard", w.Code)
	}
	if next.invoked() {
		t.Fatal("a mis-assembled guard let a request through")
	}
}
