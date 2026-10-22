package server

/*
 * The frozen wire golden sample (03 plan §3.3): testdata/wire-v1.json is the
 * RuntimeInvocation envelope v1 golden sample, byte-identical to the TS
 * side's server/tests/enterprise/runs/fixtures/wire-v1.json. The sha256
 * below pins THOSE bytes, so any edit on either side — a field renamed, a
 * value loosened, a pretty-printer run on one file only — fails a test here
 * instead of drifting the two wire contracts apart silently.
 *
 * The sample must also survive this middleware's own consumption path: it
 * decodes into the envelopeWire shape with no extra fields, carries the
 * frozen schema_version, passes the identity completeness rule (no field
 * defaulted or repaired), and names the wire's one optional field nowhere.
 */

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"openbot/runtime-go/internal/identity"
)

// goldenWireSampleSha256 is the hash of server/tests/enterprise/runs/fixtures/
// wire-v1.json — the same bytes testdata/wire-v1.json must carry.
const goldenWireSampleSha256 = "73226adfbc215b661c8cd45e00464d1d202fdd799532cd13d4b9c89354883066"

// requiredEnvelopeFields is the wire's required field set, mirrored from the
// envelopeWire json tags; delegation_ref is the one optional field.
var requiredEnvelopeFields = []string{
	"schema_version", "tenant_id", "workspace_id", "principal_id", "actor_id", "initiator_kind",
	"run_id", "attempt_id", "turn_id", "thread_id", "expert_version",
	"input_digest", "model_route_ref", "budget_reservation_id", "lease_id",
	"fencing_token", "expires_at",
}

func TestGoldenWireSampleMatchesTheFrozenContract(t *testing.T) {
	data, err := os.ReadFile("../../testdata/wire-v1.json")
	if err != nil {
		t.Fatalf("read testdata/wire-v1.json: %v", err)
	}

	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != goldenWireSampleSha256 {
		t.Fatalf("testdata/wire-v1.json = %s, want the frozen bytes shared with the TS fixture (%s); regenerate both sides together", got, goldenWireSampleSha256)
	}

	// No extra fields: the golden sample is the contract, so a key outside
	// the envelopeWire tags is a contract change that must be made on both
	// sides and re-frozen, not smuggled into the sample.
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatalf("parse testdata/wire-v1.json: %v", err)
	}
	known := map[string]bool{"delegation_ref": true}
	for _, field := range requiredEnvelopeFields {
		known[field] = true
	}
	for key := range object {
		if !known[key] {
			t.Fatalf("golden sample carries unknown field %q", key)
		}
	}
	for _, field := range requiredEnvelopeFields {
		if _, ok := object[field]; !ok {
			t.Fatalf("golden sample is missing required field %q", field)
		}
	}

	var wire envelopeWire
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatalf("decode golden envelope: %v", err)
	}
	if wire.SchemaVersion != "1" {
		t.Fatalf("golden schema_version = %q, want the frozen \"1\"", wire.SchemaVersion)
	}

	// The completeness rule the middleware applies to a verified envelope
	// (identity.FromContext): a half envelope is refused, not repaired.
	run := identity.VerifiedRun{
		TenantID:            wire.TenantID,
		WorkspaceID:         wire.WorkspaceID,
		PrincipalID:         wire.PrincipalID,
		ActorID:             wire.ActorID,
		InitiatorKind:       wire.InitiatorKind,
		RunID:               wire.RunID,
		AttemptID:           wire.AttemptID,
		TurnID:              wire.TurnID,
		ThreadID:            wire.ThreadID,
		ExpertVersion:       wire.ExpertVersion,
		InputDigest:         wire.InputDigest,
		ModelRouteRef:       wire.ModelRouteRef,
		BudgetReservationID: wire.BudgetReservationID,
		LeaseID:             wire.LeaseID,
		FencingToken:        wire.FencingToken,
		ExpiresAt:           wire.ExpiresAt,
		DelegationRef:       wire.DelegationRef,
	}
	if _, err := identity.FromContext(identity.WithVerified(t.Context(), run)); err != nil {
		t.Fatalf("golden envelope fails the completeness rule: %v", err)
	}
}
