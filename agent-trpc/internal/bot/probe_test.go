package bot

/*
 * The self-healthcheck mode: the container image is distroless (no shell, no
 * curl), so the binary probes its own /health and answers with its exit
 * code — the healthcheck compose asks for, exec-form, no shell involved.
 */

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProbeHealthAnswersByExit(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ok.Close)
	if err := ProbeHealth(context.Background(), ok.URL+"/health", time.Second); err != nil {
		t.Fatalf("healthy endpoint must probe clean: %v", err)
	}

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(down.Close)
	if err := ProbeHealth(context.Background(), down.URL+"/health", time.Second); err == nil {
		t.Fatal("unhealthy endpoint must fail the probe")
	}
}
