package bot

/*
 * The workbench Bot's configuration contract, in the posture every other Bot
 * in this box holds (see agent-bot/src/index.ts): the token is required
 * before anything else, the model key is required unless an endpoint was
 * named, and the default model is the `bots.agent-trpc` row of
 * shared/model-providers.json — the one file every Bot's default lives in —
 * with BOT_MODEL overriding it. A refusal names every problem at once, the
 * same honesty rule runtimeconfig.Load follows for the enterprise plane.
 */

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigRefusesWithoutToken(t *testing.T) {
	_, err := LoadConfig(func(string) string { return "" }, "")
	if err == nil {
		t.Fatal("empty environment must refuse to start")
	}
	if !strings.Contains(err.Error(), "MANAGED_AGENT_TOKEN") {
		t.Fatalf("refusal must name the token: %v", err)
	}
}

func TestLoadConfigDefaultsModelFromSpecRow(t *testing.T) {
	spec := filepath.Join(t.TempDir(), "model-providers.json")
	if err := os.WriteFile(spec, []byte(`{
		"bots": {"agent-trpc": {"provider": "openai", "model": "gpt-5.5"}}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(func(name string) string {
		switch name {
		case "MANAGED_AGENT_TOKEN":
			return "token-not-a-real-one"
		case "OPENAI_BASE_URL":
			return "http://127.0.0.1:1"
		case "OPENAI_API_KEY":
			return "fixture-not-a-credential"
		}
		return ""
	}, spec)
	if err != nil {
		t.Fatalf("spec row must satisfy the model: %v", err)
	}
	if cfg.Model != "gpt-5.5" {
		t.Fatalf("model = %q, want the spec row's gpt-5.5", cfg.Model)
	}
	if cfg.Port != "4204" {
		t.Fatalf("port = %q, want the fixed default 4204", cfg.Port)
	}
}

func TestLoadConfigBotModelOverridesSpecRow(t *testing.T) {
	cfg, err := LoadConfig(func(name string) string {
		switch name {
		case "MANAGED_AGENT_TOKEN":
			return "token-not-a-real-one"
		case "OPENAI_BASE_URL":
			return "http://127.0.0.1:1"
		case "BOT_MODEL":
			return "glm-5.3"
		}
		return ""
	}, "")
	if err != nil {
		t.Fatalf("BOT_MODEL alone must be enough: %v", err)
	}
	if cfg.Model != "glm-5.3" {
		t.Fatalf("model = %q, want the env override glm-5.3", cfg.Model)
	}
}

func TestLoadConfigRequiresModelKeyForPublicOpenAI(t *testing.T) {
	_, err := LoadConfig(func(name string) string {
		switch name {
		case "MANAGED_AGENT_TOKEN":
			return "token-not-a-real-one"
		case "BOT_MODEL":
			return "gpt-5.5"
		}
		return ""
	}, "")
	if err == nil || !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("public OpenAI without a key must be refused naming the key: %v", err)
	}
}

func TestLoadConfigRefusesNonHTTPBaseURL(t *testing.T) {
	_, err := LoadConfig(func(name string) string {
		switch name {
		case "MANAGED_AGENT_TOKEN":
			return "token-not-a-real-one"
		case "OPENAI_BASE_URL":
			return "ftp://not-a-web-address"
		case "BOT_MODEL":
			return "gpt-5.5"
		}
		return ""
	}, "")
	if err == nil || !strings.Contains(err.Error(), "OPENAI_BASE_URL") {
		t.Fatalf("a non-http base URL must be refused naming it: %v", err)
	}
}
