// Command runtime starts the OpenBot Go runtime candidate HTTP server.
//
// R1 scope: minimal testable service with health endpoints, an explicit
// listen address (no implicit default), and graceful shutdown. Read-header
// timeout and request body limits are introduced alongside the business
// handlers in R2.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"openbot/runtime-go/internal/server"
)

// shutdownGrace bounds the drain window after SIGINT/SIGTERM.
const shutdownGrace = 10 * time.Second

func main() {
	addr := flag.String("addr", "", "listen address (host:port), required; the runtime refuses to bind an implicit address")
	flag.Parse()
	if *addr == "" {
		log.Fatal("runtime: -addr is required")
	}

	// R1: readiness is process-local only; this candidate does not probe
	// paid model providers from health checks.
	srv := &http.Server{
		Addr:    *addr,
		Handler: server.Health(func() bool { return true }),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		log.Printf("runtime: listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case err := <-serveErr:
		log.Fatalf("runtime: serve failed: %v", err)
	case <-ctx.Done():
		log.Println("runtime: shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("runtime: graceful shutdown failed: %v", err)
	}
	log.Println("runtime: stopped")
}
