package bot

/*
 * The scripted OpenAI-compatible provider the contract tests drive the real
 * assembly against: /chat/completions answered by test-written SSE frames,
 * with every request recorded for the assertions. The same shape the
 * enterprise adapter tests use, kept local because this package owns its own
 * trust model — nothing here is shared with that plane.
 */

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// providerRequest is one model call as the assertions need it.
type providerRequest struct {
	Stream        bool
	Authorization string
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

// streamFrames streams "contract-" + "ok" as SSE deltas.
var streamFrames = []string{
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"contract-"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}`,
	`data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
	`data: [DONE]`,
}

// newProvider answers every /chat/completions call with the fixed streaming
// reply, recording each request.
func newProvider(t *testing.T) (*httptest.Server, *providerLog) {
	return newScriptedProvider(t, func(int) []string { return streamFrames })
}

// newScriptedProvider answers by the test's script (keyed on the call
// index), recording each request.
func newScriptedProvider(t *testing.T, script func(call int) []string) (*httptest.Server, *providerLog) {
	t.Helper()
	log := &providerLog{}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		var parsed struct {
			Stream bool `json:"stream"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return
		}
		log.mu.Lock()
		call := len(log.requests)
		log.requests = append(log.requests, providerRequest{
			Stream:        parsed.Stream,
			Authorization: r.Header.Get("Authorization"),
			Body:          string(body),
		})
		log.mu.Unlock()

		frames := script(call)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, strings.Join(frames, "\n\n")+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	t.Cleanup(s.Close)
	return s, log
}

// runBody builds a minimal AG-UI run request.
func runBody(t *testing.T, mutate func(doc map[string]any)) string {
	t.Helper()
	doc := map[string]any{
		"runId":    "run_1",
		"threadId": "thread_1",
		"messages": []map[string]any{
			{"id": "msg_user_1", "role": "user", "content": "Answer the contract check."},
		},
		"tools":          []any{},
		"context":        []any{},
		"forwardedProps": map[string]any{},
	}
	if mutate != nil {
		mutate(doc)
	}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("build run body: %v", err)
	}
	return string(data)
}

// postRun drives one authenticated run and returns the response and body.
func postRun(t *testing.T, ts *httptest.Server, body string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/ag-ui", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-openbot-agent-token", testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("run request: %v", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	return res, string(data)
}

// parseSSE decodes the data: frames of an AG-UI SSE body.
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
