package bot

/*
 * The workbench Bot's HTTP contract, end to end: the handler New returns,
 * over a real httptest server, exactly as OpenBot's server would reach it —
 * GET /health for the liveness compose asks for, POST /ag-ui with the one
 * managed agent token every deployment-run endpoint authenticates by
 * (shared/agent-authorisation.ts is the TS spelling of the same header).
 */

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// decodeJSON reads a small JSON response body.
func decodeJSON(res *http.Response, into any) error {
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}

const (
	// Test-only values, minted nowhere real; the posture matches the
	// enterprise adapter tests' fixture credentials.
	testToken     = "token-not-a-real-one"
	testModelName = "contract-model"
)

// newBot assembles the real handler on a real httptest server, pointed at a
// model endpoint the test controls.
func newBot(t *testing.T, modelBaseURL string) *httptest.Server {
	t.Helper()
	h, err := New(Options{
		Token:        testToken,
		ModelBaseURL: modelBaseURL,
		ModelAPIKey:  "fixture-not-a-credential",
		Model:        testModelName,
	})
	if err != nil {
		t.Fatalf("bot.New: %v", err)
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

// unreachableModel is an endpoint nothing ever dials in these tests: the
// health and 401 contracts must hold without a model behind them.
func unreachableModel(t *testing.T) string {
	t.Helper()
	ts := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(ts.Close)
	return ts.URL
}

func TestHealthReportsStatusAndModel(t *testing.T) {
	ts := newBot(t, unreachableModel(t))
	res, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", res.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
		Model  string `json:"model"`
	}
	if err := decodeJSON(res, &body); err != nil {
		t.Fatalf("health body: %v", err)
	}
	if body.Status != "ok" || body.Model != testModelName {
		t.Fatalf("health body = %+v, want status ok and model %s", body, testModelName)
	}
}

func TestAguiRefusesEveryTokenButTheOne(t *testing.T) {
	ts := newBot(t, unreachableModel(t))
	for _, offered := range []string{"", "wrong-token-not-it", testToken + "x"} {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/ag-ui", nil)
		if offered != "" {
			req.Header.Set("x-openbot-agent-token", offered)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("offered %q: %v", offered, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("offered token %q: status = %d, want 401", offered, res.StatusCode)
		}
	}
}

func TestRunStreamsContractEvents(t *testing.T) {
	provider, log := newProvider(t)
	ts := newBot(t, provider.URL)

	res, body := postRun(t, ts, runBody(t, nil))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("run status = %d, body = %s", res.StatusCode, body)
	}
	events := parseSSE(t, body)
	if len(events) == 0 {
		t.Fatal("no SSE events arrived")
	}
	if events[0]["type"] != "RUN_STARTED" {
		t.Fatalf("first event = %v, want RUN_STARTED", events[0]["type"])
	}
	if last := events[len(events)-1]; last["type"] != "RUN_FINISHED" {
		t.Fatalf("last event = %v, want RUN_FINISHED", last["type"])
	}
	if n := countType(events, "TEXT_MESSAGE_START"); n != 1 {
		t.Fatalf("TEXT_MESSAGE_START count = %d, want 1", n)
	}
	if n := countType(events, "TEXT_MESSAGE_END"); n != 1 {
		t.Fatalf("TEXT_MESSAGE_END count = %d, want 1", n)
	}
	joined := ""
	for _, e := range events {
		if e["type"] == "TEXT_MESSAGE_CONTENT" {
			joined += fmt.Sprintf("%v", e["delta"])
		}
	}
	if joined != "contract-ok" {
		t.Fatalf("streamed text = %q, want contract-ok", joined)
	}

	calls := log.snapshot()
	if len(calls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(calls))
	}
	if !strings.Contains(calls[0].Body, "Answer the contract check.") {
		t.Fatalf("provider never saw the user text: %s", calls[0].Body)
	}
	if !strings.Contains(calls[0].Authorization, "Bearer") {
		t.Fatalf("provider authorization = %q, want a bearer key", calls[0].Authorization)
	}
}

// The frames a model produces when it calls the surface's tool: the call
// arrives as a tool_calls delta, the run ends with finish_reason tool_calls.
var toolCallFrames = []string{
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"probe_tool","arguments":"{\"query\":\"contract\"}"}}]},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	`data: [DONE]`,
}

func TestCallerToolsAreDeclaredAndTheirCallsSurfaceAsEvents(t *testing.T) {
	provider, log := newScriptedProvider(t, func(int) []string { return toolCallFrames })
	ts := newBot(t, provider.URL)

	_, body := postRun(t, ts, runBody(t, func(doc map[string]any) {
		doc["tools"] = []map[string]any{{
			"name":        "probe_tool",
			"description": "Probes the contract.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"query": map[string]any{"type": "string"}},
			},
		}}
	}))

	// The declaration the model saw is the caller's, verbatim.
	calls := log.snapshot()
	if len(calls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(calls))
	}
	if !strings.Contains(calls[0].Body, `"probe_tool"`) || !strings.Contains(calls[0].Body, `"function"`) {
		t.Fatalf("caller tool was not declared to the model: %s", calls[0].Body)
	}

	// The call surfaces as TOOL_CALL events for the surface to execute.
	events := parseSSE(t, body)
	if last := events[len(events)-1]; last["type"] != "RUN_FINISHED" {
		t.Fatalf("last event = %v, want RUN_FINISHED (a surfaced call ends the run)", last["type"])
	}
	if n := countType(events, "TOOL_CALL_START"); n != 1 {
		t.Fatalf("TOOL_CALL_START count = %d, want 1", n)
	}
	if n := countType(events, "TOOL_CALL_END"); n != 1 {
		t.Fatalf("TOOL_CALL_END count = %d, want 1", n)
	}
	joined := ""
	for _, e := range events {
		if e["type"] == "TOOL_CALL_ARGS" {
			joined += fmt.Sprintf("%v", e["delta"])
		}
	}
	if !strings.Contains(joined, "query") {
		t.Fatalf("tool call args = %q, want the query argument", joined)
	}
}

func TestForwardedPropsNeverReachTheModel(t *testing.T) {
	provider, log := newProvider(t)
	ts := newBot(t, provider.URL)

	_, body := postRun(t, ts, runBody(t, func(doc map[string]any) {
		doc["forwardedProps"] = map[string]any{
			"openbotRun": map[string]any{"assertion": "opaque-bearer-capability"},
		}
	}))

	if last := parseSSE(t, body); len(last) == 0 || last[len(last)-1]["type"] != "RUN_FINISHED" {
		t.Fatal("run must still finish normally")
	}
	calls := log.snapshot()
	if len(calls) != 1 {
		t.Fatalf("provider calls = %d, want 1", len(calls))
	}
	for _, banned := range []string{"openbotRun", "opaque-bearer-capability", "forwardedProps"} {
		if strings.Contains(calls[0].Body, banned) {
			t.Fatalf("forwardedProps leaked %q to the model: %s", banned, calls[0].Body)
		}
	}
}

func TestProviderErrorIsATerminalRunError(t *testing.T) {
	// A provider that explodes mid-run: the surface must be told the run
	// failed, not left waiting on a stream that simply ends.
	log := &providerLog{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		log.mu.Lock()
		log.requests = append(log.requests, providerRequest{Body: string(body)})
		log.mu.Unlock()
		http.Error(w, "provider exploded: leak-bait-secret-detail", http.StatusInternalServerError)
	}))
	t.Cleanup(ts.Close)

	botTS := newBot(t, ts.URL)
	_, body := postRun(t, botTS, runBody(t, nil))

	events := parseSSE(t, body)
	if len(events) == 0 {
		t.Fatal("no SSE events arrived")
	}
	last := events[len(events)-1]
	if last["type"] != "RUN_ERROR" {
		t.Fatalf("last event = %v, want RUN_ERROR", last["type"])
	}
	if msg, _ := last["message"].(string); strings.Contains(msg, "leak-bait-secret-detail") {
		t.Fatalf("run error leaked provider internals: %q", msg)
	}
}
