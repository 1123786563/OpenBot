package identity

import (
	"context"
	"testing"
)

func TestMissingVerifiedIdentityIsDenied(t *testing.T) {
	if _, err := FromContext(context.Background()); err == nil {
		t.Fatal("unverified caller accepted")
	}
}

// fullEnvelope is a complete master-plan §4.2 RuntimeInvocation mapping: every
// field the TS plane must vouch for before a run may execute. DelegationRef is
// deliberately empty here — a user-initiated run carries none (only a
// scheduled initiation must, which the auth middleware enforces separately).
func fullEnvelope() VerifiedRun {
	return VerifiedRun{
		TenantID:           "t1",
		WorkspaceID:        "ws1",
		PrincipalID:        "p1",
		ActorID:            "a1",
		InitiatorKind:      InitiatorUser,
		RunID:              "run_1",
		AttemptID:          "attempt_1",
		TurnID:             "turn_1",
		ThreadID:           "th1",
		ExpertVersion:      "expert@1.0.0",
		InputDigest:        "digest_1",
		ModelRouteRef:      "route@1",
		BudgetReservationID: "budget_1",
		LeaseID:            "lease_1",
		FencingToken:       "fencing_1",
		ExpiresAt:          "2026-10-09T12:00:00Z",
	}
}

func TestFullEnvelopeRoundTripsThroughContext(t *testing.T) {
	want := fullEnvelope()
	got, err := FromContext(WithVerified(context.Background(), want))
	if err != nil {
		t.Fatalf("complete envelope refused: %v", err)
	}
	if got != want {
		t.Fatalf("envelope = %+v, want %+v", got, want)
	}
}

// Every envelope field is load-bearing: the TS plane vouches for the whole
// binding, so a run that arrives missing ANY field is a run the plane did not
// fully vouch for — refused, never repaired with defaults.
func TestIncompleteEnvelopeIsRefused(t *testing.T) {
	for field, clear := range map[string]func(*VerifiedRun){
		"tenant_id":            func(v *VerifiedRun) { v.TenantID = "" },
		"workspace_id":         func(v *VerifiedRun) { v.WorkspaceID = "" },
		"principal_id":         func(v *VerifiedRun) { v.PrincipalID = "" },
		"actor_id":             func(v *VerifiedRun) { v.ActorID = "" },
		"initiator_kind":       func(v *VerifiedRun) { v.InitiatorKind = "" },
		"run_id":               func(v *VerifiedRun) { v.RunID = "" },
		"attempt_id":           func(v *VerifiedRun) { v.AttemptID = "" },
		"turn_id":              func(v *VerifiedRun) { v.TurnID = "" },
		"thread_id":            func(v *VerifiedRun) { v.ThreadID = "" },
		"expert_version":       func(v *VerifiedRun) { v.ExpertVersion = "" },
		"input_digest":         func(v *VerifiedRun) { v.InputDigest = "" },
		"model_route_ref":      func(v *VerifiedRun) { v.ModelRouteRef = "" },
		"budget_reservation_id": func(v *VerifiedRun) { v.BudgetReservationID = "" },
		"lease_id":             func(v *VerifiedRun) { v.LeaseID = "" },
		"fencing_token":        func(v *VerifiedRun) { v.FencingToken = "" },
		"expires_at":           func(v *VerifiedRun) { v.ExpiresAt = "" },
	} {
		v := fullEnvelope()
		clear(&v)
		if _, err := FromContext(WithVerified(context.Background(), v)); err == nil {
			t.Fatalf("envelope missing %s was accepted", field)
		}
	}
}

// A delegation reference is required only for scheduled initiation; a plain
// user-initiated run must pass with it empty, and a delegated run must carry
// it through untouched.
func TestDelegationRefIsOptionalForUserRuns(t *testing.T) {
	if _, err := FromContext(WithVerified(context.Background(), fullEnvelope())); err != nil {
		t.Fatalf("user-initiated run refused for lacking a delegation ref: %v", err)
	}
	delegated := fullEnvelope()
	delegated.InitiatorKind = InitiatorSchedule
	delegated.DelegationRef = "delegation_1"
	got, err := FromContext(WithVerified(context.Background(), delegated))
	if err != nil {
		t.Fatalf("delegated run refused: %v", err)
	}
	if got.DelegationRef != "delegation_1" {
		t.Fatalf("delegation ref = %q, want it carried through", got.DelegationRef)
	}
}

// The tool-plane credential triple is whole or absent: a half-empty triple is
// refused rather than repaired, because the missing part is a credential
// the middleware never vouched for and no tool call may present.
func TestToolCredentialsAreWholeOrAbsent(t *testing.T) {
	if _, ok := ToolCredentialsFromContext(context.Background()); ok {
		t.Fatal("an unverified context presented tool credentials")
	}
	full := WithToolCredentials(context.Background(), ToolCredentials{
		ServiceCredential: "service-credential",
		Capability:        "capability",
		Invocation:        `{"schema_version":"1"}`,
	})
	if _, ok := ToolCredentialsFromContext(full); !ok {
		t.Fatal("a stored triple was refused")
	}
	for name, triple := range map[string]ToolCredentials{
		"no service credential": {Capability: "capability", Invocation: `{"schema_version":"1"}`},
		"no capability":         {ServiceCredential: "service-credential", Invocation: `{"schema_version":"1"}`},
		"no invocation":         {ServiceCredential: "service-credential", Capability: "capability"},
	} {
		if _, ok := ToolCredentialsFromContext(WithToolCredentials(context.Background(), triple)); ok {
			t.Fatalf("%s: a half-empty triple was accepted", name)
		}
	}
}
