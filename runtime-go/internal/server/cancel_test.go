package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	aguiadapter "trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"

	"openbot/runtime-go/internal/adapter"
	"openbot/runtime-go/internal/identity"
)

// ---------------------------------------------------------------------------
// Handler contract, against a scripted canceler.
// ---------------------------------------------------------------------------

// scriptCanceler records what the cancel boundary was asked and answers with
// a scripted error (nil = held here, cancel requested).
type scriptCanceler struct {
	mu    sync.Mutex
	calls int
	input []aguiadapter.RunAgentInput
	seen  []identity.VerifiedRun // identity visible in each call's context
	err   error
}

func (s *scriptCanceler) Cancel(ctx context.Context, input *aguiadapter.RunAgentInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	v, _ := identity.FromContext(ctx)
	s.seen = append(s.seen, v)
	s.input = append(s.input, *input)
	return s.err
}

func (s *scriptCanceler) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func (s *scriptCanceler) lastInput() (runID, threadID string, seen identity.VerifiedRun) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.input[len(s.input)-1].RunID, s.input[len(s.input)-1].ThreadID, s.seen[len(s.seen)-1]
}

func verifiedCtx() context.Context {
	return identity.WithVerified(context.Background(), verifiedRun())
}

func verifiedRun() identity.VerifiedRun {
	// A complete §4.2 envelope. TurnID is "r1" because the AG-UI runId these
	// tests drive IS the envelope's turn (master §4.3).
	return identity.VerifiedRun{
		TenantID:            "t1",
		PrincipalID:         "p1",
		ActorID:             "a1",
		InitiatorKind:       identity.InitiatorUser,
		RunID:               "biz_run_1",
		AttemptID:           "attempt_1",
		TurnID:              "r1",
		ThreadID:            "th1",
		ExpertVersion:       "expert@1.0.0",
		InputDigest:         "digest_1",
		ModelRouteRef:       "route@1",
		BudgetReservationID: "budget_1",
		LeaseID:             "lease_1",
		FencingToken:        "fencing_1",
		ExpiresAt:           "2099-01-01T00:00:00Z",
	}
}

// executingRegistry is the assembly every positive cancel test needs: the run
// IS executing on this process, recorded under its full verified tuple with
// the fencing token it is executing under.
func executingRegistry() *ExecutionRegistry {
	executions := NewExecutionRegistry()
	executions.Record(verifiedRun())
	return executions
}

// A cancel request without a verified identity is refused before the canceler
// is reached: this is the "no bare runId" rule. A runId on its own — however
// well-formed — names nobody and controls nothing.
func TestCancelRequiresVerifiedIdentity(t *testing.T) {
	canceler := &scriptCanceler{}
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{"runId":"r1","threadId":"th1"}`)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for an unverified cancel request", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatalf("canceler reached %d times without a verified identity", canceler.count())
	}
}

// The response says one thing only — cancel_requested — because that is all
// this process knows at that moment: the actual terminal state arrives later,
// from the run's exit events. Nothing about "cancelled", "finished" or
// rolling back submitted tools is claimed here.
func TestCancelAnswersOnlyCancelRequested(t *testing.T) {
	canceler := &scriptCanceler{}
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{"runId":"r1","threadId":"th1"}`)).WithContext(verifiedCtx()))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", w.Code, w.Body.String())
	}
	body := strings.TrimSpace(w.Body.String())
	if body != `{"status":"cancel_requested"}` {
		t.Fatalf("body = %q, want exactly {\"status\":\"cancel_requested\"}", body)
	}
}

// The run targeted is ALWAYS the verified identity's own run. A runId placed
// in the body naming somebody else's run changes nothing — the body is not
// consulted, so a caller cannot steer the cancel at a run its credentials do
// not vouch for.
func TestCancelTargetsOnlyTheVerifiedRun(t *testing.T) {
	canceler := &scriptCanceler{}
	// The body tries to name another tenant's run; the identity says r1/th1.
	r := httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{"runId":"run-belongs-to-somebody-else","threadId":"th1"}`)).
		WithContext(verifiedCtx())
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", w.Code, w.Body.String())
	}
	runID, threadID, seen := canceler.lastInput()
	if runID != "r1" || threadID != "th1" {
		t.Fatalf("canceler asked for run %q thread %q, want the verified run r1/th1", runID, threadID)
	}
	if seen.TurnID != "r1" || seen.PrincipalID != "p1" || seen.TenantID != "t1" {
		t.Fatalf("canceler context identity = %+v, want the caller's verified run", seen)
	}
}

// A run this process does not hold is a 404, and the answer must not pretend
// otherwise — after a restart the in-memory registry is empty by design, and
// recovery of interrupted runs belongs to the persistence plane (E2), not to
// a guess made here.
func TestCancelNotFoundIsNotPretended(t *testing.T) {
	canceler := &scriptCanceler{err: errors.Join(aguirunner.ErrRunNotFound, errors.New("session: {app user thread}"))}
	r := httptest.NewRequest(http.MethodPost, "/runs/cancel", strings.NewReader(`{}`)).
		WithContext(verifiedCtx())
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for a run this process does not hold", w.Code)
	}
	if strings.Contains(w.Body.String(), "session") {
		t.Fatalf("404 body leaked internal detail: %s", w.Body.String())
	}
}

// Any other failure from the cancel boundary is answered with a stable
// sentence: internal wording (which may name sessions, keys, hosts) does not
// reach the caller.
func TestCancelInternalErrorIsStable(t *testing.T) {
	canceler := &scriptCanceler{err: errors.New("internal: session service exploded with secret-detail")}
	r := httptest.NewRequest(http.MethodPost, "/runs/cancel", strings.NewReader(`{}`)).
		WithContext(verifiedCtx())
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	if strings.Contains(w.Body.String(), "secret-detail") {
		t.Fatalf("500 body leaked internal detail: %s", w.Body.String())
	}
}

func TestCancelRequiresPost(t *testing.T) {
	canceler := &scriptCanceler{}
	w := httptest.NewRecorder()
	Cancel(canceler, executingRegistry()).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/runs/cancel", nil).
		WithContext(verifiedCtx()))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatal("GET reached the canceler")
	}
}

// A host that wired the canceler but not the execution registry is refused
// outright: answering 404 ("not held") for runs the process may in fact be
// executing would be a guess, and answering 200 would bypass the registry
// checks entirely.
func TestCancelWithoutExecutionTrackingIsRefused(t *testing.T) {
	canceler := &scriptCanceler{}
	w := httptest.NewRecorder()
	Cancel(canceler, nil).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/runs/cancel",
		strings.NewReader(`{}`)).WithContext(verifiedCtx()))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when cancel is not wired to the execution registry", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatal("an unwired cancel path still reached the canceler")
	}
}

// ---------------------------------------------------------------------------
// R3-B③: the cancel boundary resolves the execution context by the FULL
// verified tuple {tenant, principal, run, attempt} and verifies the CURRENT
// fencing before anything is asked to stop.
// ---------------------------------------------------------------------------

// A verified identity naming a DIFFERENT attempt of the same run gets
// nothing: the attempt it may control is not executing on this process, and
// the run's executing attempt is not its business.
func TestCancelLooksUpTheExecutionContextByTheVerifiedTuple(t *testing.T) {
	canceler := &scriptCanceler{}
	executions := NewExecutionRegistry()
	executions.Record(verifiedRun()) // executing: {t1, p1, biz_run_1, attempt_1}

	otherAttempt := verifiedRun()
	otherAttempt.AttemptID = "attempt_2"
	r := httptest.NewRequest(http.MethodPost, "/runs/cancel", strings.NewReader(`{}`)).
		WithContext(identity.WithVerified(context.Background(), otherAttempt))
	w := httptest.NewRecorder()
	Cancel(canceler, executions).ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for another attempt's cancel", w.Code)
	}
	if canceler.count() != 0 {
		t.Fatalf("another attempt's cancel reached the canceler %d times", canceler.count())
	}

	// The same check by tenant and by principal: a full-tuple miss is a miss.
	for name, mutate := range map[string]func(*identity.VerifiedRun){
		"another tenant":    func(v *identity.VerifiedRun) { v.TenantID = "t2" },
		"another principal": func(v *identity.VerifiedRun) { v.PrincipalID = "p2" },
	} {
		v := verifiedRun()
		mutate(&v)
		r := httptest.NewRequest(http.MethodPost, "/runs/cancel", strings.NewReader(`{}`)).
			WithContext(identity.WithVerified(context.Background(), v))
		w := httptest.NewRecorder()
		Cancel(canceler, executions).ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", name, w.Code)
		}
		if canceler.count() != 0 {
			t.Fatalf("%s: the canceler was reached", name)
		}
	}
}

// A cancel presenting a fencing token that is not the one the run is
// EXECUTING under is refused without touching the run: that is the stale or
// foreign lease, and stopping another lease's execution is reconciliation's
// job (E2), not this boundary's.
func TestCancelRefusesStaleFencing(t *testing.T) {
	canceler := &scriptCanceler{}
	executions := executingRegistry() // executing under fencing_1

	renewed := verifiedRun()
	renewed.FencingToken = "fencing_renewed_after_lease_change"
	r := httptest.NewRequest(http.MethodPost, "/runs/cancel", strings.NewReader(`{}`)).
		WithContext(identity.WithVerified(context.Background(), renewed))
	w := httptest.NewRecorder()
	Cancel(canceler, executions).ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d (body: %s), want 403 for a stale fencing cancel", w.Code, w.Body.String())
	}
	if canceler.count() != 0 {
		t.Fatal("a stale fencing cancel reached the canceler")
	}
	// The executing run is untouched: still held, still under its own fencing.
	if fencing, held := executions.Held(verifiedRun()); !held || fencing != "fencing_1" {
		t.Fatalf("the stale cancel disturbed the execution: held=%v fencing=%q", held, fencing)
	}
}

// ---------------------------------------------------------------------------
// Real framework semantics: an agui runner driven through the same trusted
// user resolver the adapter installs, with a scripted "model" underneath.
// ---------------------------------------------------------------------------

func TestCancelRequestedRunStillCleansUpWhenModelIgnoresIt(t *testing.T) {
	model := newScriptedModel()
	canceler, streamDone := startRunWithModel(t, model)
	model.waitStarted(t)

	// The run is live: cancel through the same boundary the handler uses.
	if err := canceler.Cancel(verifiedCtx(), &aguiadapter.RunAgentInput{RunID: "r1", ThreadID: "th1"}); err != nil {
		t.Fatalf("cancel of a live run failed: %v", err)
	}

	// The framework terminates the run's serving lifecycle even though the
	// model ignores the cancellation — and the registry entry goes with it.
	waitStreamClosed(t, streamDone)

	// The model itself is STILL running (it never watched its context). A
	// second cancel request now finds no run: this process no longer claims
	// to hold one.
	if err := canceler.Cancel(verifiedCtx(), &aguiadapter.RunAgentInput{RunID: "r1", ThreadID: "th1"}); !errors.Is(err, aguirunner.ErrRunNotFound) {
		t.Fatalf("after the run ended, cancel err = %v, want ErrRunNotFound", err)
	}

	// Let the model finish on its own; its late completion must not
	// resurrect anything.
	model.release()
	model.waitFinished(t)
	if err := canceler.Cancel(verifiedCtx(), &aguiadapter.RunAgentInput{RunID: "r1", ThreadID: "th1"}); !errors.Is(err, aguirunner.ErrRunNotFound) {
		t.Fatalf("after the model finished late, cancel err = %v, want ErrRunNotFound", err)
	}
}

func TestStartupFailureCleansUpTheRun(t *testing.T) {
	model := newScriptedModel()
	model.startErr = errors.New("model provider unavailable at startup")
	canceler := newRealRunner(t, model)

	v := verifiedRun()
	ctx := identity.WithVerified(context.Background(), v)
	events, err := canceler.Run(ctx, &aguiadapter.RunAgentInput{
		RunID:    v.TurnID,
		ThreadID: v.ThreadID,
		Messages: []aguitypes.Message{{Role: aguitypes.RoleUser, Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("run start failed: %v", err)
	}
	// The startup failure ends the run; the framework unregisters it.
	waitStreamClosed(t, consumeEvents(events))
	if err := canceler.Cancel(ctx, &aguiadapter.RunAgentInput{RunID: v.TurnID, ThreadID: v.ThreadID}); !errors.Is(err, aguirunner.ErrRunNotFound) {
		t.Fatalf("after a failed startup, cancel err = %v, want ErrRunNotFound", err)
	}
}

func TestCancelRefusesAnotherUsersRun(t *testing.T) {
	// One user's run is live on this process...
	model := newScriptedModel()
	canceler, streamDone := startRunWithModel(t, model)
	model.waitStarted(t)
	defer waitStreamClosed(t, streamDone)
	defer model.release()

	// ...and a DIFFERENT verified user asks to cancel. Its identity is real,
	// its run binding is self-consistent, and it still gets nothing: the run
	// it may control is its own, which this process is not running.
	otherRun := verifiedRun()
	otherRun.ActorID = "a2"
	otherRun.TurnID = "r2"
	otherRun.ThreadID = "th2"
	other := identity.WithVerified(context.Background(), otherRun)
	err := canceler.Cancel(other, &aguiadapter.RunAgentInput{RunID: "r2", ThreadID: "th2"})
	if !errors.Is(err, aguirunner.ErrRunNotFound) {
		t.Fatalf("another user's cancel err = %v, want ErrRunNotFound", err)
	}

	// And the run's own user still can.
	if err := canceler.Cancel(verifiedCtx(), &aguiadapter.RunAgentInput{RunID: "r1", ThreadID: "th1"}); err != nil {
		t.Fatalf("the owning user's cancel failed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Scripted framework pieces.
// ---------------------------------------------------------------------------

// scriptedModel is a model that does not respond to cancellation: its Run
// never watches its context, and finishes only when the test releases it.
// It implements the framework's underlying runner contract.
type scriptedModel struct {
	blockUntil chan struct{}
	finished   chan struct{}
	startErr   error
	runCalled  chan struct{} // closed once the framework has invoked Run
}

func newScriptedModel() *scriptedModel {
	return &scriptedModel{
		blockUntil: make(chan struct{}),
		finished:   make(chan struct{}),
		runCalled:  make(chan struct{}),
	}
}

func (m *scriptedModel) runInvoked() bool {
	select {
	case <-m.runCalled:
		return true
	default:
		return false
	}
}

// waitStarted blocks until the framework has actually invoked the model.
// A cancel can legally race a run's startup (registration happens inside
// Run, the run goroutine starts async), and these tests are about a model
// that is RUNNING and ignores a cancellation — not about that race — so
// they wait for the model to be live first.
func (m *scriptedModel) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-m.runCalled:
	case <-time.After(5 * time.Second):
		t.Fatal("the framework never invoked the scripted model")
	}
}

func (m *scriptedModel) release() { close(m.blockUntil) }

func (m *scriptedModel) waitFinished(t *testing.T) {
	t.Helper()
	select {
	case <-m.finished:
	case <-time.After(5 * time.Second):
		t.Fatal("scripted model never finished")
	}
}

func (m *scriptedModel) Run(
	_ context.Context,
	_, _ string,
	_ model.Message,
	_ ...agent.RunOption,
) (<-chan *event.Event, error) {
	close(m.runCalled)
	if m.startErr != nil {
		return nil, m.startErr
	}
	events := make(chan *event.Event, 1)
	go func() {
		defer close(events)
		// THE MODEL DOES NOT WATCH ITS CONTEXT. It works until it is done,
		// which is what "does not respond to cancellation" means here.
		<-m.blockUntil
		events <- &event.Event{
			Response: &model.Response{Object: model.ObjectTypeRunnerCompletion, Done: true},
		}
		close(m.finished)
	}()
	return events, nil
}

func (m *scriptedModel) Close() error { return nil }

// runnerWithCancel is what the framework's concrete runner actually is: a
// Runner that can also be cancelled. Asserting to this local union keeps the
// tests honest about the real seam the handler will sit on.
type runnerWithCancel interface {
	aguirunner.Runner
	aguirunner.Canceler
}

// newRealRunner assembles the real cancel path with the same trusted user
// resolver the adapter installs, so identity and run-binding checks run.
// The concrete runner the framework builds satisfies aguirunner.Canceler;
// the assertion failing would itself be a finding.
func newRealRunner(t *testing.T, m *scriptedModel) runnerWithCancel {
	t.Helper()
	r := aguirunner.New(m, aguirunner.WithUserIDResolver(adapter.ResolveUser))
	withCancel, ok := r.(runnerWithCancel)
	if !ok {
		t.Fatal("the framework runner cannot both run and cancel")
	}
	return withCancel
}

func startRunWithModel(t *testing.T, m *scriptedModel) (runnerWithCancel, <-chan struct{}) {
	t.Helper()
	canceler := newRealRunner(t, m)
	events, err := canceler.Run(verifiedCtx(), &aguiadapter.RunAgentInput{
		RunID:    "r1",
		ThreadID: "th1",
		Messages: []aguitypes.Message{{Role: aguitypes.RoleUser, Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("run start failed: %v", err)
	}
	return canceler, consumeEvents(events)
}

// consumeEvents drains an AG-UI event stream in the background, the way the
// SSE transport does in production, and reports its closure. A run's event
// stream is unbuffered on the framework side, so without a consumer even
// the startup event blocks and the model is never invoked.
func consumeEvents(events <-chan aguievents.Event) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range events {
		}
	}()
	return done
}

func waitStreamClosed(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("event stream never closed")
	}
}
