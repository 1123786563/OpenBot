package adapter

/*
 * The wait-state mapping (01 plan R4-A 等待输入/审批 row).
 *
 * A governed tool call that must WAIT — the plane requires a human approval,
 * or the operation's receipt is not final (submitted/unknown, the run must be
 * suspended for reconciliation) — ends the run, because neither is the
 * model's to retry. The locked AG-UI protocol (the frozen Go SDK AND the
 * frozen @ag-ui/core 1.0.1 zod schema the TS consumer validates with) carries
 * exactly one machine-readable form for that: a RUN_FINISHED whose outcome is
 * {type: "interrupt", interrupts: [...]}. The mapping below turns the
 * runtime's own suspension signals into that form, so the platform ledger can
 * key the wait on the frozen operation (interrupt.id), distinguish why it
 * waits (interrupt.reason), and attach it to the tool call that caused it
 * (interrupt.toolCallId) — instead of string-matching an error message or,
 * worse, reading the run as succeeded.
 *
 * Nothing else changes: a run that fails for any other reason still ends in
 * RUN_ERROR, and a plain success still carries NO outcome (the locked 1.0
 * protocol's success form), so the two can never be confused.
 */

import (
	"context"
	"fmt"
	"strings"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"

	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/translator"

	"openbot/runtime-go/internal/callback"
)

// The frozen interrupt reason values (the protocol leaves reason an open
// string; these are THIS runtime's stable vocabulary, unchanged once shipped).
const (
	// WaitReasonToolApproval: the plane requires a human approval before the
	// proposed operation may execute (master §4.3 running→waiting_approval).
	WaitReasonToolApproval = "tool_approval"
	// WaitReasonReceiptPending: the operation's outcome is not final
	// (submitted/unknown/reconciliation-required); the business run must be
	// suspended until the plane reconciles it (master §4.3 未知效果→suspended).
	WaitReasonReceiptPending = "operation_receipt_pending"
)

// interruptOf maps one RUN_ERROR message onto the wait it actually represents.
// ok is false when the message carries neither suspension sentinel — an
// ordinary failure that must stay a RUN_ERROR.
func interruptOf(message string) (waitInterrupt, bool) {
	for _, mapping := range []struct {
		sentinel string
		reason   string
	}{
		{ErrApprovalRequired.Error(), WaitReasonToolApproval},
		{ErrSuspendedPendingReceipt.Error(), WaitReasonReceiptPending},
	} {
		at := strings.Index(message, mapping.sentinel)
		if at < 0 {
			continue
		}
		rest := strings.TrimSpace(message[at+len(mapping.sentinel):])
		rest = strings.TrimPrefix(rest, ":")
		fields := strings.Fields(rest)
		wait := waitInterrupt{reason: mapping.reason}
		if len(fields) > 0 && !isReceiptStatus(fields[0]) {
			wait.id = fields[0]
		}
		// A message with no operation reference (the proposal itself came back
		// unknown) leaves the id empty — the outcome builder derives a stable
		// key from the run's own coordinates instead. The receipt status
		// (submitted/unknown/…) rides in the interrupt's message context; the
		// id stays the operation the platform must approve or reconcile.
		return wait, true
	}
	return waitInterrupt{}, false
}

// isReceiptStatus recognizes the frozen receipt statuses so a status word can
// never be mistaken for an operation reference.
func isReceiptStatus(word string) bool {
	switch word {
	case callback.StatusNotSubmitted, callback.StatusSubmitted,
		callback.StatusSucceeded, callback.StatusFailed, callback.StatusUnknown:
		return true
	}
	return false
}

// waitInterrupt is the single interrupt a suspension maps to.
type waitInterrupt struct {
	id         string
	reason     string
	toolCallID string
}

// asOutcome renders the wait as the locked protocol's interrupt outcome.
func (w waitInterrupt) asOutcome() *aguievents.RunFinishedOutcome {
	id := w.id
	if id == "" {
		// An operation reference that never arrived still needs a stable,
		// non-empty resume key; the run's tool-call coordinates are the only
		// ones this seam holds.
		id = fmt.Sprintf("pending:%s", w.toolCallID)
	}
	interrupt := aguitypes.Interrupt{
		ID: id,
		// Reason is the frozen machine-readable category; the open protocol
		// string stays free-form, so no draft fields are invented.
		Reason: w.reason,
	}
	if w.toolCallID != "" {
		interrupt.ToolCallID = w.toolCallID
	}
	return &aguievents.RunFinishedOutcome{
		Type:       aguievents.RunFinishedOutcomeTypeInterrupt,
		Interrupts: []aguitypes.Interrupt{interrupt},
	}
}

// waitMappingTranslator decorates one run's translator: every event the frozen
// translator produces passes through unchanged, except a RUN_ERROR that this
// runtime's own suspension sentinels caused, which becomes the locked
// protocol's interrupt-outcome RUN_FINISHED. Per-run state (thread, run, and
// the tool calls observed so far) closes over the factory input, so one
// server can serve concurrent runs without cross-run leakage.
type waitMappingTranslator struct {
	inner    translator.Translator
	threadID string
	runID    string

	// lastToolCallID is the most recent tool call the stream opened — the
	// call a governed suspension interrupts. The framework's error surface
	// does not name it, and in the governed-tool flow the suspended run has
	// exactly one open tool call.
	lastToolCallID string
}

// Translate passes the frozen translation through, then applies the wait
// mapping to a suspension RUN_ERROR and tracks the tool calls it saw.
func (w *waitMappingTranslator) Translate(ctx context.Context, ev *event.Event) ([]aguievents.Event, error) {
	events, err := w.inner.Translate(ctx, ev)
	if err != nil {
		return nil, err
	}
	for i, produced := range events {
		if start, ok := produced.(*aguievents.ToolCallStartEvent); ok && start.ToolCallID != "" {
			w.lastToolCallID = start.ToolCallID
		}
		runError, ok := produced.(*aguievents.RunErrorEvent)
		if !ok {
			continue
		}
		wait, isWait := interruptOf(runError.Message)
		if !isWait {
			continue
		}
		wait.toolCallID = w.lastToolCallID
		events[i] = aguievents.NewRunFinishedEventWithOptions(
			w.threadID, w.runID,
			aguievents.WithOutcome(*wait.asOutcome()),
		)
	}
	return events, nil
}

// PostRunFinalizationEvents delegates to the frozen translator so open text
// streams still close before whatever terminal the run ends on.
func (w *waitMappingTranslator) PostRunFinalizationEvents(ctx context.Context) ([]aguievents.Event, error) {
	if finalizer, ok := w.inner.(translator.PostRunFinalizingTranslator); ok {
		return finalizer.PostRunFinalizationEvents(ctx)
	}
	return nil, nil
}

// waitMappingFactory wraps the frozen default translator factory: each run's
// translator is decorated with the wait mapping, carrying that run's own
// thread/run coordinates.
func waitMappingFactory(base translator.Factory) translator.Factory {
	return func(ctx context.Context, input *adapter.RunAgentInput, opts ...translator.Option) (translator.Translator, error) {
		inner, err := base(ctx, input, opts...)
		if err != nil {
			return nil, err
		}
		return &waitMappingTranslator{inner: inner, threadID: input.ThreadID, runID: input.RunID}, nil
	}
}
