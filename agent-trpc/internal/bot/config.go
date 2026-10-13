// Package bot is the workbench Bot assembly: the AG-UI HTTP contract every
// Bot in this box speaks (agent-bot, agent-langgraph, a picked harness) —
// POST /ag-ui behind the managed agent token, GET /health — built on the same
// trpc-agent-go AG-UI server the enterprise plane uses, but with NONE of the
// enterprise trust model: no three-header envelope, no identity oracle, no
// governed tool plane. The workbench Bot's caller is OpenBot's own server,
// authenticated by the one shared token every deployment-run endpoint holds.
//
// The configuration posture mirrors agent-bot/src/index.ts rather than
// runtimeconfig: env-driven with honest defaults, refusing to start only on
// what makes answering impossible (no token, no model, no key for the public
// endpoint) — the enterprise plane's all-or-nothing strictness stays there.
package bot

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Config is everything the Bot process assembles from.
type Config struct {
	// Port is the listen port; the fixed default 4204 is this Bot's own,
	// because each Bot in the box fixes its own port in its own image.
	Port string
	// Token is the managed agent token; required, compared in constant time.
	Token string
	// ModelBaseURL is the OpenAI-compatible endpoint; empty means OpenAI.
	ModelBaseURL string
	// ModelAPIKey is the provider credential; optional only when a base URL
	// was named (Ollama, vLLM and friends serve keyless).
	ModelAPIKey string
	// Model is sent verbatim; the default is the `bots.agent-trpc` row of
	// shared/model-providers.json, BOT_MODEL overrides it.
	Model string
}

// defaultPort is this Bot's port, the way agent-bot owns 4200 and
// agent-langgraph owns 4201.
const defaultPort = "4204"

// LoadConfig reads the environment (and, for the model default, the
// model-providers spec) or refuses naming EVERY problem, the way the
// enterprise loader does for its own contract.
func LoadConfig(env func(string) string, specPath string) (Config, error) {
	if env == nil {
		env = func(string) string { return "" }
	}
	lookup := func(name string) string { return strings.TrimSpace(env(name)) }

	var problems []string

	token := lookup("MANAGED_AGENT_TOKEN")
	if token == "" {
		problems = append(problems, "MANAGED_AGENT_TOKEN is required: this process holds a model credential and will not start without a token for OpenBot's server")
	}

	port := lookup("PORT")
	if port == "" {
		port = defaultPort
	}

	baseURL := lookup("OPENAI_BASE_URL")
	if baseURL != "" {
		if u, err := url.Parse(baseURL); err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil {
			problems = append(problems, fmt.Sprintf("OPENAI_BASE_URL %q must be an http(s) address naming a host, without embedded credentials", baseURL))
		}
	}

	apiKey := lookup("OPENAI_API_KEY")
	if apiKey == "" && baseURL == "" {
		problems = append(problems, "OPENAI_API_KEY is required when no OPENAI_BASE_URL names an endpoint that needs no key")
	}

	model := lookup("BOT_MODEL")
	if model == "" && specPath != "" {
		fromSpec, err := specModel(specPath)
		if err != nil {
			problems = append(problems, fmt.Sprintf("BOT_MODEL is unset and the model-providers spec could not be read: %v", err))
		} else if fromSpec != "" {
			model = fromSpec
		}
	}
	if model == "" {
		problems = append(problems, "no model: set BOT_MODEL or provide the bots.agent-trpc row in shared/model-providers.json")
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("agent-trpc bot refuses to start; configuration problems:\n  - %s", strings.Join(problems, "\n  - "))
	}

	return Config{
		Port:         port,
		Token:        token,
		ModelBaseURL: baseURL,
		ModelAPIKey:  apiKey,
		Model:        model,
	}, nil
}

// specModel reads the `bots.agent-trpc` model row from a
// shared/model-providers.json file. Only the model string is read: the
// provider is this Bot's own assembly (an OpenAI-compatible client), which is
// the same split agent-bot makes — the row's provider names who catalogues
// the model, the Bot's code decides how it is spoken to.
func specModel(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var spec struct {
		Bots map[string]struct {
			Model string `json:"model"`
		} `json:"bots"`
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		return "", errors.New("unparseable model-providers.json: " + err.Error())
	}
	row, ok := spec.Bots["agent-trpc"]
	if !ok {
		return "", nil
	}
	return strings.TrimSpace(row.Model), nil
}
