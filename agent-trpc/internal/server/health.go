// Package server hosts the HTTP surface of the OpenBot Go runtime candidate.
//
// R1 scope: process health only. Readiness is injected as a function so the
// runtime never probes paid model providers from a health endpoint; the
// readiness decision stays local to the process.
package server

import "net/http"

// Health returns an http.Handler exposing liveness and readiness as separate
// endpoints. liveness always reports 200 while the process can serve;
// readiness delegates to the injected ready function.
func Health(ready func() bool) http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("/health/live", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	m.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if !ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return m
}
