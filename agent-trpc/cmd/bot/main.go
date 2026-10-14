// Command bot is the workbench Bot: the AG-UI HTTP contract every Bot in
// this box speaks, assembled from internal/bot (see that package for the
// trust model). This main only wires configuration to the listener —
//
//	agent-trpc-bot [-model-providers path]      serve (env-driven)
//	agent-trpc-bot -healthcheck URL             probe and exit 0/1
//
// The enterprise candidate lives in cmd/runtime and shares nothing with this
// entrypoint but the framework underneath.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"openbot/agent-trpc/internal/bot"
)

func main() {
	fs := flag.NewFlagSet("agent-trpc-bot", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	healthcheck := fs.String("healthcheck", "", "probe this URL and exit 0 (healthy) or 1 (not)")
	specPath := fs.String("model-providers", "shared/model-providers.json",
		"path to shared/model-providers.json, the file every Bot's default model lives in")
	if err := fs.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}

	if *healthcheck != "" {
		if err := bot.ProbeHealth(context.Background(), *healthcheck, 5*time.Second); err != nil {
			log.Printf("agent-trpc-bot: healthcheck failed: %v", err)
			os.Exit(1)
		}
		return
	}

	cfg, err := bot.LoadConfig(os.Getenv, *specPath)
	if err != nil {
		log.Fatalf("agent-trpc-bot: %v", err)
	}
	handler, err := bot.New(bot.Options{
		Token:        cfg.Token,
		ModelBaseURL: cfg.ModelBaseURL,
		ModelAPIKey:  cfg.ModelAPIKey,
		Model:        cfg.Model,
	})
	if err != nil {
		log.Fatalf("agent-trpc-bot: %v", err)
	}

	addr := net.JoinHostPort("0.0.0.0", cfg.Port)
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("agent-trpc-bot: listen %s: %v", addr, err)
	}
	log.Printf("agent-trpc-bot: listening on %s (model: %s)", ln.Addr().String(), cfg.Model)

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serveErr:
		log.Fatalf("agent-trpc-bot: serve failed: %v", err)
	case <-ctx.Done():
	}

	// The Bot holds no cross-run state; a short drain for in-flight SSE
	// streams is the whole shutdown story.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("agent-trpc-bot: shutdown: %v", err)
	}
}
