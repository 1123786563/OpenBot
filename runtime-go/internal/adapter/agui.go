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
	"fmt"
	"net/http"
	"sync"

	"trpc.group/trpc-go/trpc-agent-go/agent"
	baserunner "trpc.group/trpc-go/trpc-agent-go/runner"
	aguiserver "trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguiadapter "trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/function"

	"openbot/runtime-go/internal/callback"
	"openbot/runtime-go/internal/identity"
	"openbot/runtime-go/internal/trustedinput"
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

// CompositeCanceler fans one cancel out over every runner a host assembled
// (one per expert in the fixed catalog) and reports the first decisive
// answer: a run one runner holds is cancelled there, a run nobody holds is
// ErrRunNotFound, and a real failure is returned as soon as one runner has
// it. Order is irrelevant — the verified identity keys which runner's run
// this can even touch, so only the owning runner can answer anything else.
func CompositeCanceler(cancelers ...Canceler) Canceler {
	return composite{cancelers: cancelers}
}

type composite struct {
	cancelers []Canceler
}

func (c composite) Cancel(ctx context.Context, input *aguiadapter.RunAgentInput) error {
	var notFound error = aguirunner.ErrRunNotFound
	for _, canceler := range c.cancelers {
		if canceler == nil {
			continue
		}
		err := canceler.Cancel(ctx, input)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, aguirunner.ErrRunNotFound):
			continue
		default:
			return err
		}
	}
	return notFound
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
			aguirunner.WithRunAgentInputHook(validateAndStripInput),
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
// The id is a JSON array of the verified whitelist — tenant, principal,
// expert version — and nothing else: no client actorId/userId is read, and a
// context that did not come through the auth middleware fails here with
// UNAUTHENTICATED_RUNTIME rather than falling back to a default user. The
// run binding is re-checked (the TS plane and the middleware already
// compared it): the AG-UI input's RunID IS the envelope's TurnID (master
// §4.3 — one business run fans out into attempts and turns), so a verified
// identity for one turn cannot steer a different turn on the same thread.
// This resolver also runs on the cancel path, which is what makes a cancel
// key owner-scoped.
func ResolveUser(ctx context.Context, in *aguiadapter.RunAgentInput) (string, error) {
	v, err := identity.FromContext(ctx)
	if err != nil {
		return "", err
	}
	if in == nil || in.RunID != v.TurnID || in.ThreadID != v.ThreadID {
		return "", errors.New("RUN_BINDING_MISMATCH")
	}
	data, err := json.Marshal([]string{v.TenantID, v.PrincipalID, v.ExpertVersion})
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

// validateAndStripInput is the input hook every runner applies: the SAME
// trusted-input rules the auth middleware enforced on the raw body (one rule
// set, two gates — the middleware answers the caller with a clean 4xx, this
// hook is the seam that holds even if a handler is mounted without it), then
// forwardedProps is emptied before the input is processed.
//
// In the legacy TS stack the run assertion travelled to agent code in
// forwardedProps, because that is the part of a run a framework hands to
// customer code. Here credentials live in the private Go context (see
// identity.WithRunAssertion), so anything a client puts in forwardedProps —
// a forged assertion, a model-route override, a resume object included — is
// either refused (resume-shaped keys) or dropped before the model or any
// tool can read it.
func validateAndStripInput(_ context.Context, in *aguiadapter.RunAgentInput) (*aguiadapter.RunAgentInput, error) {
	if in == nil {
		return nil, nil
	}
	// Re-serialize to the wire shape and apply the frozen trusted-input
	// rules, so the hook and the middleware can never drift apart.
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	if _, err := trustedinput.Parse(raw); err != nil {
		return nil, err
	}
	stripped := *in
	stripped.ForwardedProps = nil
	return &stripped, nil
}

// ErrSuspendedPendingReceipt is what a governed tool call returns when the
// platform's receipt for an operation is not final (status submitted or
// unknown, master plan §4.2/§4.3): the operation may or may not have taken
// effect, so the model is NOT handed a retryable tool failure — the run
// ends here, and the business run must be suspended for reconciliation by
// the plane that owns run state. The receipt rides along for the host.
var ErrSuspendedPendingReceipt = errors.New("OPERATION_PENDING_RECEIPT")

// PendingReceiptError carries the receipt (or the operation reference, when
// the receipt never arrived) that froze the operation.
//
// It unwraps to an agent.StopError: the framework's own "this run stops
// now" signal, which ends the invocation WITHOUT asking the model again —
// the property that makes a frozen operation unfreezable by the model
// simply calling the tool once more. errors.Is keeps the sentinel:
// errors.Is(err, ErrSuspendedPendingReceipt) matches.
type PendingReceiptError struct {
	OperationID string
	Status      string
	Receipt     *callback.Receipt
	stop        *agent.StopError
}

func newPendingReceiptError(operationID, status string, receipt *callback.Receipt) *PendingReceiptError {
	return &PendingReceiptError{
		OperationID: operationID,
		Status:      status,
		Receipt:     receipt,
		stop:        agent.NewStopError(fmt.Sprintf("%s: %s %s", ErrSuspendedPendingReceipt.Error(), operationID, status)),
	}
}

func (e *PendingReceiptError) Error() string { return e.stop.Error() }

func (e *PendingReceiptError) Unwrap() error { return e.stop }

func (e *PendingReceiptError) Is(target error) bool { return target == ErrSuspendedPendingReceipt }

// ErrApprovalRequired is what a governed tool call returns when prepare
// reports the operation needs a human approval this runtime has no channel
// to supply (the approval protocol is not part of this candidate): the tool
// call fails rather than the model being told to "try again", because
// approval is a platform state change, not a model retry. It is also a
// stop error, for the same reason as PendingReceiptError.
var ErrApprovalRequired = errors.New("OPERATION_REQUIRES_APPROVAL")

type approvalRequiredError struct {
	operationID string
	stop        *agent.StopError
}

func (e *approvalRequiredError) Error() string { return e.stop.Error() }

func (e *approvalRequiredError) Unwrap() error { return e.stop }

func (e *approvalRequiredError) Is(target error) bool { return target == ErrApprovalRequired }

// toolCallSequencer assigns the stable tool_call_id for each governed call
// within one run attempt: (run, attempt, tool) plus the ordinal of the call
// as this runtime received it. The model cannot choose the id — it is
// derived, not echoed — and within a process the same call slot always maps
// to the same id, so the platform's (tenant, run, tool_call_id) dedup has a
// stable key to hold onto. This is the G1a stand-in for the platform's
// step/checkpoint mapping (master plan §4.2); it is process-local execution
// state a restart rebuilds from nothing, which is exactly what the restart
// boundary promises not to paper over.
type toolCallSequencer struct {
	mu   sync.Mutex
	next map[string]int
}

func newToolCallSequencer() *toolCallSequencer {
	return &toolCallSequencer{next: map[string]int{}}
}

func (s *toolCallSequencer) toolCallID(v identity.VerifiedRun, toolName string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := v.RunID + "|" + v.AttemptID + "|" + toolName
	s.next[key]++
	return fmt.Sprintf("%s|%s|%s|%03d", v.RunID, v.AttemptID, toolName, s.next[key])
}

// GovernedTool builds the framework tool for one platform-governed tool
// installation: calling it PROPOSES the operation (prepare) and then SPENDS
// it (execute) through the TS tool plane, where the operation ledger,
// approvals, policy and audit live. The runtime executes nothing itself.
//
// The model chooses a tool NAME and its ARGS, and that is the whole of its
// influence: the plane address is operator configuration on the client, the
// credential pair and the binding coordinates (run/attempt/fencing) come
// from the private verified context, and none of it can be overridden by
// anything in args — identity is not an argument. The target of the
// operation is the one piece of args the contract names separately: a
// string "target" field if the model supplied one, otherwise the tool name
// itself.
//
// Receipt statuses map to exactly three outcomes for the model:
//
//   - succeeded / failed / not_submitted: terminal, proven states — the
//     receipt's answer text goes back to the model verbatim (a refused
//     policy is an answer the person is owed, worded by the plane).
//   - submitted / unknown: NOT the model's to retry — ErrSuspendedPendingReceipt
//     ends the call, and the receipt travels with it for the host to
//     suspend the business run pending reconciliation.
//   - approval required: ErrApprovalRequired, for the same reason.
func GovernedTool(client *callback.Client, name, installationVersion, description string, schema *tool.Schema) tool.Tool {
	if schema == nil {
		schema = openArgsSchema()
	}
	sequencer := newToolCallSequencer()
	return function.NewFunctionTool(
		func(ctx context.Context, args map[string]any) (string, error) {
			v, err := identity.FromContext(ctx)
			if err != nil {
				return "", err
			}
			// Canonical args bytes: nil becomes an empty object so the plane
			// reads a proposal, and Go's sorted-key encoding is the frozen
			// canonical form both sides digest.
			if args == nil {
				args = map[string]any{}
			}
			canonical, err := json.Marshal(args)
			if err != nil {
				return "", err
			}
			digest := callback.DigestArgs(canonical)

			preparation, err := client.Prepare(ctx, callback.ToolPreparation{
				ToolName:            name,
				RunID:               v.RunID,
				AttemptID:           v.AttemptID,
				ToolCallID:          sequencer.toolCallID(v, name),
				StepID:              v.TurnID,
				InstallationVersion: installationVersion,
				Target:              targetOf(name, args),
				Args:                canonical,
				FencingToken:        v.FencingToken,
			})
			if err != nil {
				// A reconciliation refusal is the freeze by another door: the
				// platform already holds this content submitted/unknown under
				// another key, and a new tool_call_id must not walk past it.
				var frozen *callback.ReconciliationError
				if errors.As(err, &frozen) {
					return "", newPendingReceiptError(frozen.OperationID, callback.StatusUnknown, nil)
				}
				// An unknown outcome of the PROPOSAL itself is not bluffed
				// through either: the platform may hold a proposal this
				// runtime never saw answered, and the run's state is the
				// plane's to settle.
				if errors.Is(err, callback.ErrOutcomeUnknown) {
					return "", newPendingReceiptError("", callback.StatusUnknown, nil)
				}
				return "", err
			}
			if preparation.ReconciliationRequired {
				return "", newPendingReceiptError(preparation.OperationID, callback.StatusUnknown, nil)
			}
			if preparation.RequiresApproval {
				return "", &approvalRequiredError{
					operationID: preparation.OperationID,
					stop:        agent.NewStopError(fmt.Sprintf("%s: %s", ErrApprovalRequired.Error(), preparation.OperationID)),
				}
			}

			receipt, err := client.Execute(ctx, callback.ToolExecution{
				OperationID:  preparation.OperationID,
				AttemptID:    v.AttemptID,
				ArgsDigest:   digest,
				FencingToken: v.FencingToken,
			})
			if err != nil {
				// A spend whose receipt never arrived is the unknown state:
				// the operation may or may not have been submitted, and the
				// model must not be asked to "just call again".
				if errors.Is(err, callback.ErrOutcomeUnknown) {
					return "", newPendingReceiptError(preparation.OperationID, callback.StatusUnknown, nil)
				}
				return "", err
			}
			if receipt.PendingReconciliation() {
				return "", newPendingReceiptError(receipt.OperationID, receipt.Status, &receipt)
			}
			return answerOf(receipt), nil
		},
		function.WithName(name),
		function.WithDescription(description),
		function.WithInputSchema(schema),
	)
}

// targetOf names the operation's target: the model may designate one with a
// string "target" argument (it is the thing the tool acts on — data, not a
// credential); without one, the operation targets the tool itself.
func targetOf(name string, args map[string]any) string {
	if target, ok := args["target"].(string); ok && target != "" {
		return target
	}
	return name
}

// answerOf renders a terminal receipt as the model-visible answer. The
// receipt's own result text is used verbatim when present; a receipt that
// carried none is summarized from its proven fields — never invented
// content.
func answerOf(receipt callback.Receipt) string {
	if receipt.ResultText != "" {
		return receipt.ResultText
	}
	if receipt.ErrorCode != "" {
		return fmt.Sprintf("operation %s: %s", receipt.Status, receipt.ErrorCode)
	}
	return fmt.Sprintf("operation %s (%s)", receipt.Status, receipt.ReceiptRef)
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
