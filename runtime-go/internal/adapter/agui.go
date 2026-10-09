// Package adapter is the seam between the AG-UI framework and this runtime's
// trust model.
//
// The framework's defaults are wrong for this deployment on purpose-free
// grounds, not by accident: its demo path resolves every run to a fixed "user"
// and merges whatever state a client sends into runtime state. Left alone,
// that would make identity a client choice. Every option below replaces a
// default with the one trusted resolver this package owns, so a run cannot
// enter the framework except through the verified context the auth middleware
// built.
//
// R3 adds the two outbound seams this runtime is allowed to have:
//
//   - GovernedTool routes a model's tool call to the TS governance plane via
//     internal/callback. There is no other egress: no generic HTTP tool, no
//     model-selectable endpoint or header, exists anywhere in this module.
//   - WithCancelerSink hands the host the framework runner's cancel seam, to
//     mount behind server.Cancel — the {verified tenant, actor, run} cancel
//     boundary in internal/server/cancel.go.
package adapter

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"trpc.group/trpc-go/trpc-agent-go/agent"
	baserunner "trpc.group/trpc-go/trpc-agent-go/runner"
	aguiserver "trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguiadapter "trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/function"

	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/identity"
)

// appName names the runner inside the framework's bookkeeping.
const appName = "openbot-runtime-candidate"

// Canceler is the framework runner's cancel seam, as this package hands it
// to the host. server.Cancel's RunCanceler is satisfied by the same value:
// a cancel that re-resolves the caller through ResolveUser, so identity and
// run binding are checked inside the cancel path, not only at the handler.
type Canceler interface {
	Cancel(ctx context.Context, input *aguiadapter.RunAgentInput) error
}

// Option configures New. The zero configuration keeps the R2 behaviour
// exactly: one trusted resolver set, no callback wiring, no cancel sink.
type Option func(*options)

type options struct {
	// cancelerSink, when set, receives the framework runner's Canceler once
	// New has built it.
	cancelerSink func(Canceler)
}

// WithCancelerSink arranges for the host to receive the cancel seam of the
// runner behind the handler New returns. The host mounts it behind
// server.Cancel (and behind Authenticate), giving the runtime its
// {verified tenant, actor, run} cancel boundary.
func WithCancelerSink(sink func(Canceler)) Option {
	return func(o *options) { o.cancelerSink = sink }
}

// New wires an agent into the AG-UI HTTP handler.
//
// Every runner the framework builds behind this handler resolves its user and
// state through the same trusted resolvers below — there is no per-runner
// configuration knob in this candidate, on purpose: one resolver, one trust
// decision, no drift. The returned stop func currently owns nothing; the SSE
// transport keeps no long-lived resources, and cancel state lives inside the
// framework runner this hands out via WithCancelerSink.
func New(a agent.Agent, opts ...Option) (http.Handler, func() error, error) {
	if a == nil {
		return nil, nil, errors.New("runtime: agent must not be nil")
	}
	cfg := &options{}
	for _, opt := range opts {
		opt(cfg)
	}
	base := baserunner.NewRunner(appName, a)
	srv, err := aguiserver.New(base,
		// Reasoning content and event-source metadata are off: the first is
		// model chain-of-thought this deployment has not agreed to surface,
		// and the second carries raw internals (including request
		// forwardedProps) into events that outlive the request.
		aguiserver.WithReasoningContentEnabled(false),
		aguiserver.WithEventSourceMetadataEnabled(false),
		aguiserver.WithAGUIRunnerOptions(
			aguirunner.WithUserIDResolver(ResolveUser),
			aguirunner.WithStateResolver(ResolveState),
			aguirunner.WithRunAgentInputHook(clearForwardedProps),
		),
		// The runner factory is intercepted only to hand the host the cancel
		// seam; the options the framework aggregated above (including this
		// module's resolvers) flow into the runner unchanged, so there is
		// still exactly one resolver set in play.
		aguiserver.WithRunnerFactory(func(base baserunner.Runner, opt ...aguirunner.Option) (aguirunner.Runner, error) {
			r := aguirunner.New(base, opt...)
			if cfg.cancelerSink != nil {
				if c, ok := r.(Canceler); ok {
					cfg.cancelerSink(c)
				}
			}
			return r, nil
		}),
	)
	if err != nil {
		return nil, nil, err
	}
	stop := func() error { return nil }
	return srv.Handler(), stop, nil
}

// ResolveUser derives the framework user id for a run.
//
// The id is a JSON array of the verified whitelist — tenant, actor, bot — and
// nothing else: no client actorId/userId is read, and a context that did not
// come through the auth middleware fails here with UNAUTHENTICATED_RUNTIME
// rather than falling back to a default user. The run binding is re-checked
// (the TS plane already compared it) so a verified identity for one run
// cannot steer a different run on the same thread. This resolver also runs
// on the cancel path, which is what makes a cancel key owner-scoped.
func ResolveUser(ctx context.Context, in *aguiadapter.RunAgentInput) (string, error) {
	v, err := identity.FromContext(ctx)
	if err != nil {
		return "", err
	}
	if in == nil || in.RunID != v.RunID || in.ThreadID != v.ThreadID {
		return "", errors.New("RUN_BINDING_MISMATCH")
	}
	data, err := json.Marshal([]string{v.TenantID, v.ActorID, v.BotID})
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ResolveState always resolves empty runtime state.
//
// The framework's default merges object-shaped client state into runtime
// state; here the client's state field is untrusted input, so it is refused
// wholesale rather than filtered — a runtime's state is server-owned until a
// ring deliberately builds a filter for specific, reviewed keys.
func ResolveState(context.Context, *aguiadapter.RunAgentInput) (map[string]any, error) {
	return nil, nil
}

// clearForwardedProps empties forwardedProps before the input is processed.
//
// In the legacy TS stack the run assertion travelled to agent code in
// forwardedProps, because that is the part of a run a framework hands to
// customer code. Here the assertion is a credential that already lives in the
// private Go context (see identity.WithRunAssertion), so anything a client
// puts in forwardedProps — a forged assertion included — is dropped before
// the model or any tool can read it.
func clearForwardedProps(_ context.Context, in *aguiadapter.RunAgentInput) (*aguiadapter.RunAgentInput, error) {
	if in == nil {
		return nil, nil
	}
	stripped := *in
	stripped.ForwardedProps = nil
	return &stripped, nil
}

// GovernedTool builds the framework tool for one platform-governed tool
// name: calling it executes through the TS plane, where grants, policy and
// audit live.
//
// The model chooses a tool NAME and its ARGS, and that is the whole of its
// influence: the endpoint and the agent token are fields of the client
// (operator configuration), the run assertion comes from the private context
// the auth middleware built, and neither can be overridden by anything in
// args — identity is not an argument. A context without an assertion refuses
// rather than calling the plane unauthenticated.
//
// The result text is returned to the model verbatim, including when the plane
// answered isError:true: a revoked grant or refused policy is an answer the
// person is owed, worded by the plane, not a transport failure here.
func GovernedTool(client *callback.Client, name, description string, schema *tool.Schema) tool.Tool {
	if schema == nil {
		schema = openArgsSchema()
	}
	return function.NewFunctionTool(
		func(ctx context.Context, args map[string]any) (string, error) {
			assertion, ok := identity.RunAssertion(ctx)
			if !ok {
				return "", errors.New("UNAUTHENTICATED_RUNTIME")
			}
			res, err := client.Call(ctx, assertion, name, args)
			if err != nil {
				return "", err
			}
			return res.Text, nil
		},
		function.WithName(name),
		function.WithDescription(description),
		function.WithInputSchema(schema),
	)
}

// openArgsSchema is the schema for a tool whose argument shape the plane (not
// this runtime) validates: an open object, so the vendor is the one to reject
// a bad argument, which is where that error belongs.
func openArgsSchema() *tool.Schema {
	return &tool.Schema{
		Type:                 "object",
		AdditionalProperties: true,
	}
}
