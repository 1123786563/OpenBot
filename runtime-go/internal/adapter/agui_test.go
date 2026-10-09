package adapter

/*
 * R4: real framework interop.
 *
 * Every test here drives the WHOLE candidate seam this package owns —
 * server.Authenticate in front of the handler New returns, behind which the
 * real framework runs an llmagent over the real model/openai client — against
 * a local httptest provider that answers with the plan's fixed chat.completion
 * fixture. Nothing in this file hand-writes an SSE echo of AG-UI events: the
 * events asserted on are the ones the framework itself translated and wrote.
 *
 * The provider stand-in also closes the question R3 left open on purpose:
 * whether the run assertion the auth middleware stored in the private context
 * actually survives the framework's event chain to the moment a governed tool
 * executes. The tool-call test answers it end to end — the plane stand-in
 * must receive exactly the assertion the request presented, or the test
 * fails.
 */

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	openaimodel "trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/tool"

	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/server"
)

// The fixed identity the validation stand-in vouches for, and the credentials
// a request must present to earn it. Test-only values, minted nowhere.
const (
	testServiceCredential = "test-service-credential-not-a-real-one"
	testAgentToken        = "test-agent-token"
	testAssertion         = "opaque-test-assertion"
	testRunID             = "run_1"
	testThreadID          = "thread_1"
	testTenantID          = "tenant_fixed_test_member"
	testActorID           = "actor_1"
	testBotID             = "knowledge"
	testModelAlias        = "contract-model"
	testModelAPIKey       = "test-only"
	// governedToolName is the tool the scripted provider calls. Underscored,
	// not slashed, because OpenAI-compatible providers commonly restrict tool
	// names to [A-Za-z0-9_-] and the framework sends this name to the
	// provider verbatim.
	governedToolName = "probe_governed"
)

// fixedCompletion is the plan's exact non-streaming fixture: the only model
// answer the non-streaming mapping test may accept.
const fixedCompletion = `{"id":"fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"contract-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

// fixedStreamFrames stream the same answer as SSE deltas ("contract-" +
// "ok"), so the streaming test proves delta mapping rather than re-proving
// the non-streaming path.
var fixedStreamFrames = []string{
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"contract-"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
	`data: [DONE]`,
}

// toolCallCompletion makes the model call the governed tool; roundtripCompletion
// is the answer the model gives once the plane's result is back in the
// conversation.
const toolCallCompletion = `{"id":"fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"` + governedToolName + `","arguments":"{\"query\":\"contract\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

const roundtripCompletion = `{"id":"fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"tool-roundtrip-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

// providerRequest is what one provider call looked like, as the test's
// assertions need it.
type providerRequest struct {
	Stream        bool
	Authorization string
	UserText      string
	HasToolResult bool
	Body          string
}

type providerLog struct {
	mu       sync.Mutex
	requests []providerRequest
}

func (l *providerLog) snapshot() []providerRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]providerRequest, len(l.requests))
	copy(out, l.requests)
	return out
}

// modelReply is one scripted provider answer.
type modelReply struct {
	status  int
	body    string   // used when the request was non-streaming
	frames  []string // used when the request was streaming
	headers map[string]string
}

// newProvider is the deterministic local model service: an OpenAI-compatible
// /chat/completions endpoint whose every answer is decided by the test's
// script (keyed on the call index and what the request carried), with every
// request recorded.
func newProvider(t *testing.T, script func(call int, req providerRequest) modelReply) (*httptest.Server, *providerLog) {
	t.Helper()
	log := &providerLog{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		var parsed struct {
			Stream   bool `json:"stream"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return
		}
		userText := ""
		for i := len(parsed.Messages) - 1; i >= 0; i-- {
			if parsed.Messages[i].Role == "user" {
				userText = strings.Trim(string(parsed.Messages[i].Content), `"`)
				break
			}
		}
		hasToolResult := false
		for _, m := range parsed.Messages {
			if m.Role == "tool" {
				hasToolResult = true
			}
		}
		captured := providerRequest{
			Stream:        parsed.Stream,
			Authorization: r.Header.Get("Authorization"),
			UserText:      userText,
			HasToolResult: hasToolResult,
			Body:          string(body),
		}
		log.mu.Lock()
		call := len(log.requests)
		log.requests = append(log.requests, captured)
		log.mu.Unlock()

		reply := script(call, captured)
		for k, v := range reply.headers {
			w.Header().Set(k, v)
		}
		if reply.status != 0 && reply.status != http.StatusOK {
			http.Error(w, "provider exploded: leak-bait-secret-detail", reply.status)
			return
		}
		if captured.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, strings.Join(reply.frames, "\n\n")+"\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, reply.body)
	}))
	t.Cleanup(s.Close)
	return s, log
}

// newValidation is the TS plane stand-in: it vouches for the fixed identity
// when the right token and assertion are presented, refuses everything else,
// and — like the real route — checks that the identity it vouches for is the
// run the caller says it is (the real route's 403 on binding mismatch).
func newValidation(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(server.AgentTokenHeader) != testAgentToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Assertion string `json:"assertion"`
			RunID     string `json:"runId"`
			ThreadID  string `json:"threadId"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.Assertion != testAssertion {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if body.RunID != testRunID || body.ThreadID != testThreadID {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"tenantId": testTenantID,
			"actorId":  testActorID,
			"botId":    testBotID,
			"runId":    testRunID,
			"threadId": testThreadID,
		})
	}))
	t.Cleanup(s.Close)
	return s
}

// planeCall is one tool call the plane stand-in received.
type planeCall struct {
	Token string
	Run   string
	Name  string
	Args  map[string]any
}

func newPlane(t *testing.T) (*httptest.Server, func() []planeCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []planeCall
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Run   string         `json:"run"`
			Name  string         `json:"name"`
			Args  map[string]any `json:"args"`
			Extra map[string]any `json:"-"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, "unreadable receipt", http.StatusBadRequest)
			return
		}
		mu.Lock()
		calls = append(calls, planeCall{Token: r.Header.Get("x-openbot-agent-token"), Run: body.Run, Name: body.Name, Args: body.Args})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "tool-ok", "isError": false})
	}))
	t.Cleanup(s.Close)
	return s, func() []planeCall {
		mu.Lock()
		defer mu.Unlock()
		out := make([]planeCall, len(calls))
		copy(out, calls)
		return out
	}
}

// newAgent builds the real framework agent: model/openai over the provider
// stand-in, wrapped in llmagent, with streaming exactly as the test wants it.
func newAgent(t *testing.T, providerURL string, stream bool, tools ...tool.Tool) agent.Agent {
	t.Helper()
	m := openaimodel.New(testModelAlias,
		openaimodel.WithBaseURL(providerURL),
		openaimodel.WithAPIKey(testModelAPIKey),
	)
	opts := []llmagent.Option{
		llmagent.WithModel(m),
		llmagent.WithInstruction("You are answering a protocol contract check."),
		llmagent.WithGenerationConfig(model.GenerationConfig{Stream: stream}),
		llmagent.WithMaxLLMCalls(4),
		llmagent.WithMaxToolIterations(2),
	}
	if len(tools) > 0 {
		opts = append(opts, llmagent.WithTools(tools))
	}
	return llmagent.New("contract-agent", opts...)
}

// candidate is one assembled runtime candidate: auth in front of the handler
// New returns, on an httptest server.
type candidate struct {
	url      string
	provider *providerLog
}

func newCandidate(t *testing.T, a agent.Agent, provider *httptest.Server, providerLog *providerLog, validation *httptest.Server) *candidate {
	t.Helper()
	handler, _, err := New(a)
	if err != nil {
		t.Fatalf("adapter.New: %v", err)
	}
	authed := server.Authenticate(server.AuthConfig{
		ServiceCredential:  testServiceCredential,
		ValidationEndpoint: validation.URL,
	})(handler)
	ts := httptest.NewServer(authed)
	t.Cleanup(ts.Close)
	return &candidate{url: ts.URL, provider: providerLog}
}

// sampleRequestBody loads testdata/agui-request.json — the no-credentials
// protocol sample — with its run binding pinned to the fixed identity.
func sampleRequestBody(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../testdata/agui-request.json")
	if err != nil {
		t.Fatalf("read testdata/agui-request.json: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse testdata/agui-request.json: %v", err)
	}
	doc["runId"] = testRunID
	doc["threadId"] = testThreadID
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("re-marshal sample request: %v", err)
	}
	return out
}

// postRun drives one run with the full credential set, optionally mutated.
func (c *candidate) postRun(t *testing.T, mutate func(h http.Header)) (*http.Response, string) {
	t.Helper()
	body := sampleRequestBody(t)
	req, err := http.NewRequest(http.MethodPost, c.url+"/", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build run request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(server.ServiceCredentialHeader, testServiceCredential)
	req.Header.Set(server.AgentTokenHeader, testAgentToken)
	req.Header.Set(server.RunAssertionHeader, testAssertion)
	if mutate != nil {
		mutate(req.Header)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("run request: %v", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res, string(data)
}

// parseSSE turns the framework's SSE body into decoded event maps.
func parseSSE(t *testing.T, body string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			continue
		}
		var evt map[string]any
		if err := json.Unmarshal([]byte(payload), &evt); err != nil {
			t.Fatalf("undecodable SSE frame %q: %v", payload, err)
		}
		events = append(events, evt)
	}
	return events
}

func countType(events []map[string]any, typ string) int {
	n := 0
	for _, e := range events {
		if e["type"] == typ {
			n++
		}
	}
	return n
}

func textDeltas(events []map[string]any) string {
	var b strings.Builder
	for _, e := range events {
		if e["type"] == "TEXT_MESSAGE_CONTENT" {
			if delta, ok := e["delta"].(string); ok {
				b.WriteString(delta)
			}
		}
	}
	return b.String()
}

// assertContract is the same sequence rule the TS coordinator asserts, in the
// Go tests' own words: open once, close once, close last.
func assertContract(t *testing.T, events []map[string]any) {
	t.Helper()
	if len(events) == 0 {
		t.Fatal("empty event stream: not a run")
	}
	if got := events[0]["type"]; got != "RUN_STARTED" {
		t.Fatalf("first event is %v, not RUN_STARTED", got)
	}
	if n := countType(events, "RUN_STARTED"); n != 1 {
		t.Fatalf("RUN_STARTED count = %d, want 1", n)
	}
	terminals := countType(events, "RUN_FINISHED") + countType(events, "RUN_ERROR")
	if terminals != 1 {
		t.Fatalf("terminal event count = %d, want 1", terminals)
	}
	last := events[len(events)-1]["type"]
	if last != "RUN_FINISHED" && last != "RUN_ERROR" {
		t.Fatalf("last event is %v, want RUN_FINISHED or RUN_ERROR", last)
	}
}

func TestNonStreamingProviderResponseMapsToContractEvents(t *testing.T) {
	provider, log := newProvider(t, func(call int, req providerRequest) modelReply {
		return modelReply{body: fixedCompletion}
	})
	validation := newValidation(t)
	c := newCandidate(t, newAgent(t, provider.URL, false), provider, log, validation)

	res, body := c.postRun(t, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("run status = %d, body = %s", res.StatusCode, body)
	}
	events := parseSSE(t, body)
	assertContract(t, events)

	// The non-streaming mapping: the provider's whole answer arrives as the
	// message content, not as re-chunked deltas.
	if got := textDeltas(events); got != "contract-ok" {
		t.Fatalf("mapped content = %q, want %q", got, "contract-ok")
	}
	if n := countType(events, "TEXT_MESSAGE_START"); n != 1 {
		t.Fatalf("TEXT_MESSAGE_START count = %d, want 1", n)
	}
	// The envelope carries the verified run's own coordinates.
	if events[0]["threadId"] != testThreadID || events[0]["runId"] != testRunID {
		t.Fatalf("RUN_STARTED coordinates = %v/%v", events[0]["threadId"], events[0]["runId"])
	}
	if last := events[len(events)-1]["type"]; last != "RUN_FINISHED" {
		t.Fatalf("terminal = %v, want RUN_FINISHED", last)
	}

	// Exactly one provider call, made with the test-only key, carrying the
	// user's text and no stream flag.
	calls := log.snapshot()
	if len(calls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(calls))
	}
	if calls[0].Authorization != "Bearer "+testModelAPIKey {
		t.Fatalf("authorization = %q", calls[0].Authorization)
	}
	if calls[0].Stream {
		t.Fatal("non-streaming run asked the provider to stream")
	}
	if !strings.Contains(calls[0].UserText, "Answer the contract check.") {
		t.Fatalf("provider never saw the user text: %q", calls[0].UserText)
	}
}

func TestStreamingDeltasArriveAsContentDeltas(t *testing.T) {
	provider, log := newProvider(t, func(call int, req providerRequest) modelReply {
		return modelReply{frames: fixedStreamFrames}
	})
	validation := newValidation(t)
	c := newCandidate(t, newAgent(t, provider.URL, true), provider, log, validation)

	res, body := c.postRun(t, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("run status = %d, body = %s", res.StatusCode, body)
	}
	events := parseSSE(t, body)
	assertContract(t, events)

	// The streaming mapping: the answer arrives as the provider's two deltas,
	// not as one re-chunked message.
	deltas := 0
	for _, e := range events {
		if e["type"] == "TEXT_MESSAGE_CONTENT" {
			deltas++
		}
	}
	if deltas < 2 {
		t.Fatalf("TEXT_MESSAGE_CONTENT deltas = %d, want at least 2", deltas)
	}
	if got := textDeltas(events); got != "contract-ok" {
		t.Fatalf("joined deltas = %q, want %q", got, "contract-ok")
	}
	if last := events[len(events)-1]["type"]; last != "RUN_FINISHED" {
		t.Fatalf("terminal = %v, want RUN_FINISHED", last)
	}

	calls := log.snapshot()
	if len(calls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(calls))
	}
	if !calls[0].Stream {
		t.Fatal("streaming run did not ask the provider to stream")
	}
}

func TestGovernedToolCallCrossesThePlaneWithThePrivateAssertion(t *testing.T) {
	// The plane stand-in is the existing /api/agent-tools/call shape: the
	// assertion travels as "run", the tool as "name", the model's data as
	// "args", the credential in the header.
	plane, planeCalls := newPlane(t)
	provider, log := newProvider(t, func(call int, req providerRequest) modelReply {
		if call == 0 {
			return modelReply{body: toolCallCompletion}
		}
		return modelReply{body: roundtripCompletion}
	})
	validation := newValidation(t)

	client := &callback.Client{
		HTTP:       &http.Client{Timeout: 5 * time.Second},
		Endpoint:   plane.URL,
		AgentToken: testAgentToken,
	}
	governed := GovernedTool(client, governedToolName, "Platform-governed contract tool.", nil)
	c := newCandidate(t, newAgent(t, provider.URL, false, governed), provider, log, validation)

	res, body := c.postRun(t, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("run status = %d, body = %s", res.StatusCode, body)
	}
	events := parseSSE(t, body)
	assertContract(t, events)

	// The framework emitted the tool call on the wire.
	if countType(events, "TOOL_CALL_START") != 1 || countType(events, "TOOL_CALL_END") != 1 {
		t.Fatalf("tool call events missing: %v", eventTypes(events))
	}
	// The model's final answer proves the plane's result came back around.
	if got := textDeltas(events); got != "tool-roundtrip-ok" {
		t.Fatalf("final content = %q, want %q", got, "tool-roundtrip-ok")
	}

	// Exactly one plane call, with the assertion the REQUEST presented — the
	// private-context handoff through the framework's event chain, verified
	// end to end (the question R3 explicitly left to this file).
	calls := planeCalls()
	if len(calls) != 1 {
		t.Fatalf("plane calls = %d, want 1", len(calls))
	}
	if calls[0].Token != testAgentToken {
		t.Fatalf("plane token = %q", calls[0].Token)
	}
	if calls[0].Run != testAssertion {
		t.Fatalf("plane run = %q, want the request's own assertion", calls[0].Run)
	}
	if calls[0].Name != governedToolName {
		t.Fatalf("plane tool name = %q", calls[0].Name)
	}
	if fmt.Sprint(calls[0].Args) != fmt.Sprint(map[string]any{"query": "contract"}) {
		t.Fatalf("plane args = %v", calls[0].Args)
	}

	// Two provider calls: the tool-call answer, then the final one — and the
	// second carried the plane's answer text for the model to read.
	providerCalls := log.snapshot()
	if len(providerCalls) != 2 {
		t.Fatalf("provider calls = %d, want 2", len(providerCalls))
	}
	if !providerCalls[1].HasToolResult {
		t.Fatal("second provider call carried no tool result")
	}
	if !strings.Contains(providerCalls[1].Body, "tool-ok") {
		t.Fatalf("second provider call never saw the plane's answer")
	}
}

func TestProviderErrorIsATerminalRunError(t *testing.T) {
	provider, log := newProvider(t, func(call int, req providerRequest) modelReply {
		return modelReply{status: http.StatusInternalServerError}
	})
	validation := newValidation(t)
	c := newCandidate(t, newAgent(t, provider.URL, false), provider, log, validation)

	res, body := c.postRun(t, nil)
	if res.StatusCode != http.StatusOK {
		// The run itself opened; the failure is a terminal event, not a dead
		// connection.
		t.Fatalf("run status = %d, body = %s", res.StatusCode, body)
	}
	events := parseSSE(t, body)
	assertContract(t, events)
	if last := events[len(events)-1]["type"]; last != "RUN_ERROR" {
		t.Fatalf("terminal = %v, want RUN_ERROR", last)
	}
	// The provider's error body must not leak into the events it caused.
	for _, e := range events {
		if s, ok := e["message"].(string); ok && strings.Contains(s, "leak-bait-secret-detail") {
			t.Fatal("provider error body leaked into a RUN_ERROR event")
		}
	}
	/*
	 * The frozen framework retries a failing provider before giving up: an
	 * always-500 script was hit exactly three times for one run (observed
	 * against trpc-agent-go v1.11.1-0.20260925110348-9bb1c42b968c). The count
	 * is pinned on purpose — a provider-error run that starts spending
	 * differently under a future pin is a change this candidate's owner wants
	 * to see, not absorb silently.
	 */
	if calls := log.snapshot(); len(calls) != 3 {
		t.Fatalf("provider calls = %d, want 3 (the frozen framework's retry count)", len(calls))
	}
}

func TestUnverifiedRequestNeverReachesTheProvider(t *testing.T) {
	provider, log := newProvider(t, func(call int, req providerRequest) modelReply {
		return modelReply{body: fixedCompletion}
	})
	validation := newValidation(t)
	c := newCandidate(t, newAgent(t, provider.URL, false), provider, log, validation)

	// No platform credential at all.
	res, body := c.postRun(t, func(h http.Header) { h.Del(server.ServiceCredentialHeader) })
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-credential status = %d, body = %s", res.StatusCode, body)
	}
	// Platform credential fine, assertion the plane refuses.
	res, body = c.postRun(t, func(h http.Header) { h.Set(server.RunAssertionHeader, "forged-assertion") })
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged-assertion status = %d, body = %s", res.StatusCode, body)
	}
	// Verified identity bound to a different run on the same thread: the
	// middleware compares the binding before the runner exists.
	manipulated := sampleRequestBody(t)
	var doc map[string]any
	if err := json.Unmarshal(manipulated, &doc); err != nil {
		t.Fatalf("unmarshal sample: %v", err)
	}
	doc["runId"] = "run_somebody_elses"
	manipulated, _ = json.Marshal(doc)
	req, _ := http.NewRequest(http.MethodPost, c.url+"/", bytes.NewReader(manipulated))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(server.ServiceCredentialHeader, testServiceCredential)
	req.Header.Set(server.AgentTokenHeader, testAgentToken)
	req.Header.Set(server.RunAssertionHeader, testAssertion)
	res2, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("mismatched-binding request: %v", err)
	}
	defer res2.Body.Close()
	b2, _ := io.ReadAll(res2.Body)
	if res2.StatusCode != http.StatusForbidden {
		t.Fatalf("mismatched-binding status = %d, body = %s", res2.StatusCode, b2)
	}

	// None of the refusals may have spent a provider call.
	if calls := log.snapshot(); len(calls) != 0 {
		t.Fatalf("provider calls after refusals = %d, want 0", len(calls))
	}
}

func eventTypes(events []map[string]any) []string {
	types := make([]string, len(events))
	for i, e := range events {
		types[i] = fmt.Sprint(e["type"])
	}
	return types
}
