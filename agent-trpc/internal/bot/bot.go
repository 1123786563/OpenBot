package bot

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	openaimodel "trpc.group/trpc-go/trpc-agent-go/model/openai"
	baserunner "trpc.group/trpc-go/trpc-agent-go/runner"
	aguiserver "trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguiadapter "trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
)

// Options assembles the Bot's handler.
type Options struct {
	// Token is the managed agent token; required.
	Token string
	// ModelBaseURL is the OpenAI-compatible endpoint; empty means OpenAI.
	ModelBaseURL string
	// ModelAPIKey is optional only for keyless endpoints.
	ModelAPIKey string
	// Model is sent verbatim to the endpoint; required.
	Model string
}

// appName names the runner inside the framework's bookkeeping.
const appName = "agent-trpc-bot"

// New builds the workbench Bot's HTTP handler: GET /health and POST /ag-ui,
// the AG-UI endpoint backed by the real trpc-agent-go server over an
// llmagent driving the OpenAI-compatible model client the options named.
//
// Every tool is the caller's: this Bot publishes none of its own, and the
// framework declares input.tools to the model and surfaces a call as
// TOOL_CALL events for the surface to execute — the same client-loop every
// other Bot in this box runs.
func New(opts Options) (http.Handler, error) {
	modelOptions := []openaimodel.Option{}
	if opts.ModelBaseURL != "" {
		modelOptions = append(modelOptions, openaimodel.WithBaseURL(opts.ModelBaseURL))
	}
	if opts.ModelAPIKey != "" {
		modelOptions = append(modelOptions, openaimodel.WithAPIKey(opts.ModelAPIKey))
	}
	provider := openaimodel.New(opts.Model, modelOptions...)

	a := llmagent.New(appName,
		llmagent.WithModel(provider),
		llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
		llmagent.WithMaxLLMCalls(4),
		llmagent.WithMaxToolIterations(2),
	)

	agui, err := aguiserver.New(
		baserunner.NewRunner(appName, a),
		aguiserver.WithPath("/ag-ui"),
		// The same two off-switches the enterprise plane sets: reasoning
		// content is chain-of-thought this deployment has not agreed to
		// surface, and event-source metadata carries raw internals into
		// events that outlive the request.
		aguiserver.WithReasoningContentEnabled(false),
		aguiserver.WithEventSourceMetadataEnabled(false),
		aguiserver.WithAGUIRunnerOptions(
			aguirunner.WithUserIDResolver(botResolveUser),
			aguirunner.WithStateResolver(botResolveState),
			aguirunner.WithRunAgentInputHook(stripForwardedProps),
		),
	)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "model": opts.Model})
	})
	mux.Handle("/ag-ui", requireToken(opts.Token, agui.Handler()))
	return mux, nil
}

// botResolveUser derives the framework's bookkeeping user for a run. The
// enterprise plane resolves a verified envelope; this Bot's caller is
// already the deployment's own server (the token gate proved that), so the
// thread the run belongs to is the only identity left to key, and an input
// without one is one anonymous bookkeeping bucket rather than a refusal.
func botResolveUser(_ context.Context, in *aguiadapter.RunAgentInput) (string, error) {
	if in == nil || in.ThreadID == "" {
		return "workbench", nil
	}
	return "thread:" + in.ThreadID, nil
}

// botResolveState always resolves empty runtime state, for the same reason
// the enterprise plane refuses client state: the state field is client
// input, and a runtime's state is server-owned until something deliberately
// builds a filter for reviewed keys.
func botResolveState(context.Context, *aguiadapter.RunAgentInput) (map[string]any, error) {
	return nil, nil
}

// stripForwardedProps empties forwardedProps before the input is processed.
// On the workbench wire the run assertion lives there — a bearer capability
// naming the Bot and the person — and the model is never the audience for
// credentials, exactly as the enterprise input hook drops them.
func stripForwardedProps(_ context.Context, in *aguiadapter.RunAgentInput) (*aguiadapter.RunAgentInput, error) {
	if in == nil {
		return nil, nil
	}
	stripped := *in
	stripped.ForwardedProps = nil
	return &stripped, nil
}

// requireToken answers 401 for every caller but the one holding the managed
// agent token, compared in constant time — the same timing posture as
// matchesToken in shared/agent-authorisation.ts.
func requireToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offered := r.Header.Get("x-openbot-agent-token")
		if token == "" || len(offered) != len(token) ||
			subtle.ConstantTimeCompare([]byte(offered), []byte(token)) != 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized."})
			return
		}
		next.ServeHTTP(w, r)
	})
}
