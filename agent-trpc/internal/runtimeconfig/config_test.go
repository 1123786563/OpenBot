package runtimeconfig

/*
 * The strict loader behind R2-B①: a runtime that is missing ANY required
 * piece of configuration refuses to start, naming everything that is
 * missing — it never falls back to a fixed user, a default endpoint, or a
 * half-configured "enterprise" mode. Secrets come from the environment only
 * (never flags, which are visible in process listings); everything else is
 * explicit operator flags with no implicit defaults beyond documented
 * limits.
 */

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func noEnv(string) string { return "" }

// writeInstruction creates one expert instruction file and returns its path.
func writeInstruction(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "instruction.txt")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write instruction file: %v", err)
	}
	return path
}

// minimalArgs is a complete, valid non-secret argument set (the credential
// arrives via env).
func minimalArgs(t *testing.T) []string {
	return []string{
		"-addr", "127.0.0.1:8080",
		"-validation-endpoint", "http://127.0.0.1:3000/internal/enterprise/v1/runtime/validate",
		"-model-base-url", "http://127.0.0.1:4000/v1",
		"-model-alias", "fixture-model",
		"-model-route-ref", "fixture-route@1",
		"-expert", "expert@1.0.0=" + writeInstruction(t, "You are the contract expert."),
	}
}

func envWith(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestLoadRefusesWhenEverythingIsMissing(t *testing.T) {
	_, err := Load([]string{}, noEnv)
	if err == nil {
		t.Fatal("an empty configuration started the enterprise runtime")
	}
	for _, missing := range []string{"addr", "validation", "credential", "model", "expert"} {
		if !strings.Contains(err.Error(), missing) {
			t.Fatalf("the refusal does not name %q: %v", missing, err)
		}
	}
}

func TestLoadRefusesEachMissingPiece(t *testing.T) {
	instruction := writeInstruction(t, "instruction")
	base := func() map[string]string {
		return map[string]string{
			"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
		}
	}
	cases := []struct {
		name  string
		args  []string
		env   map[string]string
		want  string
	}{
		{
			name: "no service credential",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
				"-model-base-url", "http://127.0.0.1:2/v1",
				"-model-alias", "m",
				"-expert", "v=" + instruction,
			},
			env:  map[string]string{},
			want: "credential",
		},
		{
			name: "no experts",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
				"-model-base-url", "http://127.0.0.1:2/v1",
				"-model-alias", "m",
			},
			env:  base(),
			want: "expert",
		},
		{
			name: "validation endpoint with wrong scheme",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "ftp://127.0.0.1:1/validate",
				"-model-base-url", "http://127.0.0.1:2/v1",
				"-model-alias", "m",
				"-expert", "v=" + instruction,
			},
			env:  base(),
			want: "validation",
		},
		{
			name: "validation endpoint carrying credentials",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "http://user:pass@127.0.0.1:1/validate",
				"-model-base-url", "http://127.0.0.1:2/v1",
				"-model-alias", "m",
				"-expert", "v=" + instruction,
			},
			env:  base(),
			want: "validation",
		},
		{
			name: "model base URL with wrong scheme",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
				"-model-base-url", "gopher://127.0.0.1:2",
				"-model-alias", "m",
				"-expert", "v=" + instruction,
			},
			env:  base(),
			want: "model",
		},
		{
			name: "expert instruction file missing",
			args: []string{
				"-addr", "127.0.0.1:8080",
				"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
				"-model-base-url", "http://127.0.0.1:2/v1",
				"-model-alias", "m",
				"-expert", "v=" + filepath.Join(t.TempDir(), "does-not-exist.txt"),
			},
			env:  base(),
			want: "expert",
		},
		{
			name: "governed tools without callback endpoint",
			args: append(minimalArgs(t), "-governed-tools", "probe_tool=probe_tool@1.0.0"),
			env:  base(),
			want: "callback",
		},
		{
			name: "governed tool entry without a pinned version",
			args: append(minimalArgs(t),
				"-governed-tools", "probe_tool",
				"-callback-endpoint", "http://127.0.0.1:3/internal/enterprise/v1/tool-invocations"),
			env:  base(),
			want: "installation_version",
		},
		{
			name: "zero concurrent run limit",
			args: append(minimalArgs(t), "-max-concurrent-runs", "0"),
			env:  base(),
			want: "concurrent",
		},
		{
			name: "zero drain timeout",
			args: append(minimalArgs(t), "-drain-timeout", "0s"),
			env:  base(),
			want: "drain",
		},
	}
	for _, c := range cases {
		_, err := Load(c.args, envWith(c.env))
		if err == nil {
			t.Fatalf("%s: accepted", c.name)
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: refusal %q does not name %q", c.name, err.Error(), c.want)
		}
	}
}

func TestLoadAcceptsACompleteConfiguration(t *testing.T) {
	instruction := writeInstruction(t, "You are the contract expert.")
	secondInstruction := writeInstruction(t, "You are the second expert.")
	cfg, err := Load([]string{
		"-addr", "127.0.0.1:8080",
		"-validation-endpoint", "http://127.0.0.1:3000/internal/enterprise/v1/runtime/validate",
		"-model-base-url", "http://127.0.0.1:4000/v1",
		"-model-alias", "fixture-model",
		"-model-route-ref", "fixture-route@1",
		"-expert", "expert@1.0.0=" + instruction,
		"-expert", "expert@2.0.0=" + secondInstruction,
		"-governed-tools", "probe_tool=probe_tool@1.0.0",
		"-callback-endpoint", "http://127.0.0.1:3000/internal/enterprise/v1/tool-invocations",
		"-max-concurrent-runs", "7",
		"-drain-timeout", "12s",
	}, envWith(map[string]string{
		"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
		"OPENBOT_RUNTIME_MODEL_CREDENTIAL":   "fixture-key",
	}))
	if err != nil {
		t.Fatalf("complete configuration refused: %v", err)
	}
	if cfg.Addr != "127.0.0.1:8080" {
		t.Fatalf("addr = %q", cfg.Addr)
	}
	if cfg.ValidationEndpoint != "http://127.0.0.1:3000/internal/enterprise/v1/runtime/validate" {
		t.Fatalf("validation endpoint = %q", cfg.ValidationEndpoint)
	}
	if cfg.ServiceCredential != "test-service-credential" || cfg.ModelProviderCredential != "fixture-key" {
		t.Fatal("secrets did not arrive from the environment")
	}
	if len(cfg.Experts) != 2 {
		t.Fatalf("experts = %d, want 2", len(cfg.Experts))
	}
	if cfg.Experts[0].Version != "expert@1.0.0" || cfg.Experts[0].Instruction != "You are the contract expert." {
		t.Fatalf("first expert = %+v", cfg.Experts[0])
	}
	if cfg.MaxConcurrentRuns != 7 {
		t.Fatalf("max concurrent runs = %d", cfg.MaxConcurrentRuns)
	}
	if cfg.DrainTimeout != 12*time.Second {
		t.Fatalf("drain timeout = %s", cfg.DrainTimeout)
	}
	if len(cfg.GovernedTools) != 1 ||
		cfg.GovernedTools[0].Name != "probe_tool" ||
		cfg.GovernedTools[0].InstallationVersion != "probe_tool@1.0.0" {
		t.Fatalf("governed tools = %+v, want the pinned installation", cfg.GovernedTools)
	}
	if cfg.CallbackEndpoint != "http://127.0.0.1:3000/internal/enterprise/v1/tool-invocations" {
		t.Fatalf("callback endpoint = %q", cfg.CallbackEndpoint)
	}
}

// Duplicate expert versions would make the catalog ambiguous: refused.
func TestLoadRefusesDuplicateExpertVersions(t *testing.T) {
	instruction := writeInstruction(t, "instruction")
	_, err := Load([]string{
		"-addr", "127.0.0.1:8080",
		"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
		"-model-base-url", "http://127.0.0.1:2/v1",
		"-model-alias", "m",
		"-expert", "v=" + instruction,
		"-expert", "v=" + instruction,
	}, envWith(map[string]string{
		"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
	}))
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate expert version accepted: %v", err)
	}
}

// An expert instruction file that exists but is empty is a broken catalog
// entry: refused rather than served as an empty instruction.
func TestLoadRefusesEmptyInstructionFile(t *testing.T) {
	empty := filepath.Join(t.TempDir(), "empty.txt")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load([]string{
		"-addr", "127.0.0.1:8080",
		"-validation-endpoint", "http://127.0.0.1:1/internal/enterprise/v1/runtime/validate",
		"-model-base-url", "http://127.0.0.1:2/v1",
		"-model-alias", "m",
		"-expert", "v=" + empty,
	}, envWith(map[string]string{
		"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
	}))
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty instruction accepted: %v", err)
	}
}

// The process declares exactly one model route — the route its one fixed
// model client serves (review finding on R2-B③). Without the declaration a
// runtime cannot verify that TS-approved runs name the client it assembled,
// so the loader refuses to start.
func TestLoadRequiresTheModelRouteDeclaration(t *testing.T) {
	_, err := Load(minimalArgsWithoutRouteRef(t), envWith(map[string]string{
		"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
	}))
	if err == nil || !strings.Contains(err.Error(), "model-route-ref") {
		t.Fatalf("assembly without -model-route-ref accepted: %v", err)
	}

	cfg, err := Load(minimalArgs(t), envWith(map[string]string{
		"OPENBOT_RUNTIME_SERVICE_CREDENTIAL": "test-service-credential",
	}))
	if err != nil {
		t.Fatalf("declared route refused: %v", err)
	}
	if cfg.ModelRouteRef != "fixture-route@1" {
		t.Fatalf("model route ref = %q, want fixture-route@1", cfg.ModelRouteRef)
	}
}

// minimalArgsWithoutRouteRef is the pre-declaration assembly: everything but
// -model-route-ref.
func minimalArgsWithoutRouteRef(t *testing.T) []string {
	args := minimalArgs(t)
	trimmed := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "-model-route-ref" {
			i++ // skip its value too
			continue
		}
		trimmed = append(trimmed, args[i])
	}
	return trimmed
}
