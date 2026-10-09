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
