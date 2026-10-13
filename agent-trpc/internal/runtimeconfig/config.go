// Package runtimeconfig is the strict configuration loader for the real
// runtime main (01 plan R2-B①): the enterprise mode either starts fully
// configured or refuses to start — never a fixed user, never a default
// endpoint, never a partially governed runtime.
//
// Secrets (the platform service credential, the legacy callback agent
// token, the model provider credential) come from the environment ONLY:
// flags are visible in process listings, so no secret has a flag.
// Everything else is an explicit operator flag; the numeric limits carry
// documented defaults because they are tuning knobs, not trust decisions.
//
// The environment variable NAMES this loader reads are documented on the
// env lookups themselves:
//
//	OPENBOT_RUNTIME_SERVICE_CREDENTIAL  platform→runtime service credential (required)
//	OPENBOT_RUNTIME_MODEL_CREDENTIAL    model provider credential (optional; isolated fakes need none)
//
// The governed tool plane needs no process-level credential: each tool call
// presents the request's own service credential and short-term capability
// from the private context (master plan §4.1/§4.2), so the legacy
// OPENBOT_RUNTIME_AGENT_TOKEN is no longer part of this configuration.
package runtimeconfig

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// Expert is one fixed catalog entry: an expert version and its immutable
// instruction, loaded from an operator-provided file at startup.
type Expert struct {
	Version     string
	Instruction string
}

// GovernedTool is one fixed governed-tool installation: the tool name the
// model calls and the PINNED installation version the platform authorizes
// against (a run references concrete versions; "latest" is never resolved
// mid-execution).
type GovernedTool struct {
	Name                string
	InstallationVersion string
}

// Config is everything the real main assembles the runtime from.
type Config struct {
	// Addr is the listen address; required.
	Addr string
	// ValidationEndpoint is the FIXED TS validation address (the full
	// /internal/enterprise/v1/runtime/validate URL); required.
	ValidationEndpoint string
	// ModelBaseURL and ModelAlias build the fixed model client; required.
	ModelBaseURL string
	ModelAlias   string
	// ModelRouteRef is the ONE model route this process serves — the
	// declarative name the TS plane must approve for every run handed to
	// this assembly. The auth middleware refuses a verified run naming any
	// other route (403), so a TS approval for a different assembly can never
	// be silently served by this one's fixed model client; required.
	ModelRouteRef string
	// ServiceCredential (platform→runtime) from the environment; required.
	ServiceCredential string
	// ModelProviderCredential from the environment; optional (an isolated
	// fake provider needs none, and no usable credential is ever written
	// into source).
	ModelProviderCredential string
	// Experts is the fixed expert directory; at least one entry.
	Experts []Expert
	// GovernedTools is the fixed governed-tool directory; optional, but
	// requires CallbackEndpoint.
	GovernedTools []GovernedTool
	// CallbackEndpoint is the FIXED internal tool-invocations plane address
	// (the .../internal/enterprise/v1/tool-invocations prefix the client
	// builds its prepare/execute paths from); required with governed tools.
	CallbackEndpoint string
	// MaxConcurrentRuns bounds in-flight run executions (RunGate).
	MaxConcurrentRuns int
	// DrainTimeout bounds the SIGTERM drain window; CancelGrace bounds the
	// extra wait after in-flight runs' contexts are cancelled.
	DrainTimeout time.Duration
	CancelGrace  time.Duration
	// MaxInboundBytes bounds one run request body (auth middleware).
	MaxInboundBytes int64
}

// expertList collects repeated -expert flags.
type expertList []string

func (e *expertList) String() string { return strings.Join(*e, ",") }
func (e *expertList) Set(value string) error {
	*e = append(*e, value)
	return nil
}

// Load parses args and env into a Config, or refuses with an error naming
// EVERY missing or invalid piece. flag.ContinueOnError keeps a bad flag a
// returned error instead of a process exit.
func Load(args []string, env func(string) string) (Config, error) {
	if env == nil {
		env = func(string) string { return "" }
	}
	var (
		addr          string
		validationEP  string
		modelBaseURL  string
		modelAlias    string
		modelRouteRef string
		experts       expertList
		governedTools string
		callbackEP    string
		maxRuns       int
		drainTimeout  time.Duration
		cancelGrace   time.Duration
		maxInbound    int64
	)
	fs := flag.NewFlagSet("runtime", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&addr, "addr", "", "listen address (host:port); required")
	fs.StringVar(&validationEP, "validation-endpoint", "", "full TS validation URL (/internal/enterprise/v1/runtime/validate); required")
	fs.StringVar(&modelBaseURL, "model-base-url", "", "OpenAI-compatible provider base URL; required")
	fs.StringVar(&modelAlias, "model-alias", "", "model alias the fixed client sends; required")
	fs.StringVar(&modelRouteRef, "model-route-ref", "", "the one model route ref this assembly serves (TS must approve exactly this ref); required")
	fs.Var(&experts, "expert", "expert catalog entry version=path/to/instruction.txt; repeatable; at least one required")
	fs.StringVar(&governedTools, "governed-tools", "", "comma-separated platform-governed tool entries name=installation_version; optional")
	fs.StringVar(&callbackEP, "callback-endpoint", "", "internal tool-invocations plane address (.../internal/enterprise/v1/tool-invocations); required with -governed-tools")
	fs.IntVar(&maxRuns, "max-concurrent-runs", 20, "maximum concurrent run executions (suggested limit, not a measured capacity)")
	fs.DurationVar(&drainTimeout, "drain-timeout", 15*time.Second, "SIGTERM drain window before in-flight runs are cancelled")
	fs.DurationVar(&cancelGrace, "cancel-grace", 5*time.Second, "extra wait after cancelling in-flight runs")
	fs.Int64Var(&maxInbound, "max-inbound-bytes", 8<<20, "maximum inbound run request body in bytes")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	var problems []string
	if addr == "" {
		problems = append(problems, "-addr (listen address) is required")
	}
	if err := checkHTTPEndpoint(validationEP); err != nil {
		problems = append(problems, "-validation-endpoint: "+err.Error())
	}
	if err := checkHTTPEndpoint(modelBaseURL); err != nil {
		problems = append(problems, "-model-base-url: "+err.Error())
	}
	if modelAlias == "" {
		problems = append(problems, "-model-alias is required")
	}
	if strings.TrimSpace(modelRouteRef) == "" {
		problems = append(problems, "-model-route-ref (the one model route this assembly serves) is required")
	}

	// OPENBOT_RUNTIME_SERVICE_CREDENTIAL: the platform→runtime shared
	// credential, supplied by the operator's environment.
	serviceCredential := strings.TrimSpace(env("OPENBOT_RUNTIME_SERVICE_CREDENTIAL"))
	if serviceCredential == "" {
		problems = append(problems, "OPENBOT_RUNTIME_SERVICE_CREDENTIAL (platform service credential) is required from the environment")
	}

	var tools []GovernedTool
	if strings.TrimSpace(governedTools) != "" {
		for _, entry := range strings.Split(governedTools, ",") {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			name, version, ok := strings.Cut(entry, "=")
			name, version = strings.TrimSpace(name), strings.TrimSpace(version)
			if !ok || name == "" || version == "" {
				problems = append(problems, fmt.Sprintf("-governed-tools %q: want name=installation_version (versions are pinned, never latest)", entry))
				continue
			}
			tools = append(tools, GovernedTool{Name: name, InstallationVersion: version})
		}
	}
	// The tool plane authenticates each call with the service credential
	// and the run's short-term capability — both per-request, from the
	// private context — so there is no process-level tool credential to
	// require here anymore.
	if len(tools) > 0 {
		if err := checkHTTPEndpoint(callbackEP); err != nil {
			problems = append(problems, "-callback-endpoint (required with -governed-tools): "+err.Error())
		}
	}

	catalog, catalogProblems := loadExperts(experts)
	problems = append(problems, catalogProblems...)

	if maxRuns <= 0 {
		problems = append(problems, "-max-concurrent-runs must be positive")
	}
	if drainTimeout <= 0 {
		problems = append(problems, "-drain-timeout must be positive")
	}
	if cancelGrace < 0 {
		problems = append(problems, "-cancel-grace must not be negative")
	}
	if maxInbound <= 0 {
		problems = append(problems, "-max-inbound-bytes must be positive")
	}
	if len(problems) > 0 {
		return Config{}, fmt.Errorf("runtime refuses to start; configuration problems:\n  - %s", strings.Join(problems, "\n  - "))
	}

	return Config{
		Addr:                    addr,
		ValidationEndpoint:      validationEP,
		ModelBaseURL:            modelBaseURL,
		ModelAlias:              modelAlias,
		ModelRouteRef:           strings.TrimSpace(modelRouteRef),
		ServiceCredential:       serviceCredential,
		ModelProviderCredential: strings.TrimSpace(env("OPENBOT_RUNTIME_MODEL_CREDENTIAL")),
		Experts:                 catalog,
		GovernedTools:           tools,
		CallbackEndpoint:        callbackEP,
		MaxConcurrentRuns:       maxRuns,
		DrainTimeout:            drainTimeout,
		CancelGrace:             cancelGrace,
		MaxInboundBytes:         maxInbound,
	}, nil
}

// checkHTTPEndpoint accepts a plain http/https URL with a host and no
// embedded credentials — the same shape the outbound clients enforce again
// before any dial.
func checkHTTPEndpoint(raw string) error {
	if raw == "" {
		return errors.New("is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("is unparseable")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("must be http or https")
	}
	if u.User != nil || u.Host == "" {
		return errors.New("must not carry embedded credentials and must name a host")
	}
	return nil
}

// loadExperts reads the fixed catalog: version=path pairs, files read NOW so
// a broken catalog is a startup refusal, not a mid-run surprise.
func loadExperts(entries []string) ([]Expert, []string) {
	if len(entries) == 0 {
		return nil, []string{"-expert: at least one catalog entry (version=path) is required"}
	}
	var problems []string
	seen := make(map[string]bool, len(entries))
	catalog := make([]Expert, 0, len(entries))
	for _, entry := range entries {
		version, path, ok := strings.Cut(entry, "=")
		version, path = strings.TrimSpace(version), strings.TrimSpace(path)
		if !ok || version == "" || path == "" {
			problems = append(problems, fmt.Sprintf("-expert %q: want version=path/to/instruction.txt", entry))
			continue
		}
		if seen[version] {
			problems = append(problems, fmt.Sprintf("-expert %q: duplicate expert version", version))
			continue
		}
		seen[version] = true
		instruction, err := os.ReadFile(path)
		if err != nil {
			problems = append(problems, fmt.Sprintf("-expert %s: instruction file unreadable: %v", version, err))
			continue
		}
		if len(strings.TrimSpace(string(instruction))) == 0 {
			problems = append(problems, fmt.Sprintf("-expert %s: instruction file is empty", version))
			continue
		}
		catalog = append(catalog, Expert{Version: version, Instruction: string(instruction)})
	}
	return catalog, problems
}
