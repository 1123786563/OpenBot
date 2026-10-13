package adapter

/*
 * R4-A 慢消费者 (slow consumer): a consumer that reads slower than the runtime
 * produces must push that slowness BACK through the whole pipeline — the SSE
 * writer blocks, the run's unbuffered event channel blocks, the model client
 * stops reading, and the provider's own write blocks — so nothing accumulates
 * in runtime memory and nothing is dropped: when the consumer catches up, it
 * receives every delta and exactly one terminal, last.
 *
 * This test proves the MECHANISM (the bounded-queue property) end to end: a
 * deliberately stalled raw TCP consumer, a provider whose handler CANNOT have
 * finished while the consumer is stalled, and a complete, uncorrupted stream
 * afterwards. The probe-level check (server/scripts/enterprise-runtime-probe.ts)
 * runs the same scenario against the REAL binary as a child process and adds
 * the process-level RSS measurement; this Go test is the in-process evidence.
 */

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"openbot/runtime-go/internal/server"
)

// The slow-consumer fixture: a deterministic streamed answer far larger than
// any kernel socket buffer, so a stalled consumer must eventually block the
// provider's own writes. The payload is derived, never random: the joined
// deltas must equal chunkText repeated chunkCount times.
const (
	slowChunkCount = 4096
	slowChunkSize  = 4096
)

func slowChunkText() string {
	block := strings.Repeat("0123456789abcdef", slowChunkSize/16)
	return strings.Repeat(block, slowChunkCount)
}

// TestSlowConsumerBlocksTheProviderAndLosesNothing drives the full candidate
// (auth → input guard → framework runner) with a raw TCP consumer that reads
// a little, then stalls, then catches up.
func TestSlowConsumerBlocksTheProviderAndLosesNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("the slow-consumer scenario transfers megabytes on purpose")
	}
	answer := slowChunkText()

	// The provider: streams the long answer as SSE deltas, one frame per
	// chunk, counting frames as they are WRITTEN and signaling when the
	// handler returns. While the runtime's reads stall, this handler's writes
	// must block (framesWritten stops advancing, handler not returned) — the
	// end-to-end proof that the runtime propagates backpressure instead of
	// buffering the run in memory.
	var framesWritten atomic.Int64
	handlerReturned := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		const framesPerChunk = 1
		for i := 0; i < slowChunkCount; i++ {
			chunk := answer[i*slowChunkSize : (i+1)*slowChunkSize]
			frame := fmt.Sprintf("data: {\"id\":\"slow\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":%s},\"finish_reason\":null}]}\n\n", mustJSON(chunk))
			if _, err := io.WriteString(w, frame); err != nil {
				return // the run was cancelled/failed; the assertions below catch it
			}
			flusher.Flush()
			framesWritten.Add(framesPerChunk)
		}
		if _, err := io.WriteString(w, "data: {\"id\":\"slow\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"); err != nil {
			return
		}
		flusher.Flush()
	}))
	t.Cleanup(provider.Close)

	validation := newValidation(t)
	c := newCandidate(t, newAgent(t, provider.URL, true), provider, &providerLog{}, validation)

	// A raw TCP consumer of the candidate: write the enterprise POST by hand,
	// read a first slab, then STOP reading for the stall window.
	conn, err := net.Dial("tcp", strings.TrimPrefix(c.url, "http://"))
	if err != nil {
		t.Fatalf("dial candidate: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	body, _ := json.Marshal(map[string]any{
		"runId":    testRunID,
		"threadId": testThreadID,
		"messages": []map[string]any{
			{"id": "m1", "role": "user", "content": sampleUserContent},
		},
		"state":          map[string]any{},
		"tools":          []map[string]any{},
		"context":        []map[string]any{},
		"forwardedProps": map[string]any{},
	})
	req := strings.Join([]string{
		"POST / HTTP/1.1",
		"Host: candidate",
		"Content-Type: application/json",
		"Content-Length: " + fmt.Sprint(len(body)),
		"Connection: close",
		serverHeader(server.ServiceCredentialHeader, testServiceCredential),
		serverHeader(server.CapabilityHeader, testCapability),
		serverHeader(server.InvocationHeader, envelopeJSON(nil)),
		"", "",
	}, "\r\n") + string(body)
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write run request: %v", err)
	}

	// Read the first slab: enough to prove the stream opened.
	first := make([]byte, 32<<10)
	if _, err := io.ReadFull(conn, first); err != nil {
		t.Fatalf("read first slab: %v", err)
	}

	// The stall: read NOTHING while the producer pushes. Take two samples of
	// the provider's written frames; they must both be short of the whole
	// answer (the runtime cannot swallow the provider's output while its own
	// consumer is stalled), and the provider handler must not have returned.
	stall := 1500 * time.Millisecond
	time.Sleep(stall)
	sampleA := framesWritten.Load()
	time.Sleep(stall)
	sampleB := framesWritten.Load()
	if sampleB == slowChunkCount {
		t.Fatalf("the provider finished all %d frames while the consumer was stalled: the runtime buffered the run instead of propagating backpressure", slowChunkCount)
	}
	if sampleA != sampleB {
		t.Fatalf("the provider kept writing during the consumer stall (%d -> %d frames): backpressure did not reach the provider", sampleA, sampleB)
	}
	select {
	case <-handlerReturned:
		t.Fatal("the provider handler returned while its consumer was stalled: the runtime fully consumed a stream nobody read")
	default:
	}

	// Catch up: read the whole response to the end.
	var received []byte
	received = append(received, first...)
	deadline := time.Now().Add(60 * time.Second)
	if err := conn.SetReadDeadline(deadline); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	buf := make([]byte, 64<<10)
	for {
		n, err := conn.Read(buf)
		received = append(received, buf[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read response: %v (after %d bytes)", err, len(received))
		}
	}
	// The provider must now have finished.
	select {
	case <-handlerReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("the provider handler never returned after the consumer caught up")
	}
	if got := framesWritten.Load(); got != slowChunkCount {
		t.Fatalf("provider frames = %d, want %d", got, slowChunkCount)
	}

	// Nothing lost, nothing corrupted: the joined deltas are EXACTLY the
	// deterministic fixture, and the run closed once with a terminal last.
	response := string(received)
	if !strings.Contains(response, "RUN_STARTED") {
		t.Fatalf("the stream never opened; first bytes: %q", response[:min(200, len(response))])
	}
	events := parseSSE(t, response)
	assertContract(t, events)
	if got := textDeltas(events); got != answer {
		sum := sha256.Sum256([]byte(got))
		want := sha256.Sum256([]byte(answer))
		t.Fatalf("joined deltas diverge from the fixture: got sha256 %s (%d bytes), want %s (%d bytes)",
			hex.EncodeToString(sum[:]), len(got), hex.EncodeToString(want[:]), len(answer))
	}
}

func mustJSON(v string) string {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func serverHeader(name, value string) string { return name + ": " + value }
