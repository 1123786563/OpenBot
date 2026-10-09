// Package trustedinput is the trusted-input projection of an inbound AG-UI
// run body — the "输入字段权威来源" table of the 01 plan, R2-B, made into one
// pure seam the auth middleware and the adapter's input hook both enforce.
//
// What a client may contribute is NEW USER CONTENT: user-role messages with
// plain string content. Everything else that shapes a model's behaviour is
// refused here rather than filtered, because a filter that almost always
// works is an injection channel that fails rarely:
//
//   - system/developer messages are instruction authority the client never
//     holds; assistant/tool messages are history only the TS ledger may
//     confirm (拒绝用户伪造历史工具结果);
//   - tool schemas and context entries come from TS-approved immutable
//     configuration, never from the request (不从用户messages/tools覆盖);
//   - resume objects are a TS-plane decision that issues a new restricted
//     invocation; an arbitrary client resume object is refused wherever it
//     hides — the top-level field or inside forwardedProps.
//
// The canonical input digest is frozen so both planes hash the same bytes:
// the ordered {"content":…,"role":…} pairs, compact JSON with that field
// order and no HTML escaping (不各自散列不同JSON顺序). Changing any of that
// on one side only breaks every run's input_digest check — by design.
package trustedinput

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// CanonicalMessage is one message as the frozen digest sees it: content then
// role, nothing else — no ids, names, tool calls or any other field a client
// could vary without changing what the run means.
type CanonicalMessage struct {
	Content string `json:"content"`
	Role    string `json:"role"`
}

// InboundRun is the projection the auth middleware needs from a run body:
// the binding coordinates and the canonical digest of the user content.
type InboundRun struct {
	RunID    string
	ThreadID string
	Digest   string
}

// inboundShape mirrors only the fields Parse rules on. Unknown fields are
// invisible here on purpose: forwardedProps is cleared by the adapter hook,
// and anything else a framework adds is not this package's authority.
type inboundShape struct {
	RunID    string `json:"runId"`
	ThreadID string `json:"threadId"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
	Tools          json.RawMessage `json:"tools"`
	Context        json.RawMessage `json:"context"`
	Resume         json.RawMessage `json:"resume"`
	ForwardedProps json.RawMessage `json:"forwardedProps"`
}

// Parse validates a raw AG-UI run body against the trusted-input rules and
// returns its projection. Every refusal names what was refused.
func Parse(body []byte) (InboundRun, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err != nil {
		return InboundRun{}, errors.New("request body is not a JSON run input")
	}
	if object == nil {
		// `null` decodes to a nil map without error; a run body is an object.
		return InboundRun{}, errors.New("request body is not a JSON run input")
	}
	var shape inboundShape
	if err := json.Unmarshal(body, &shape); err != nil {
		return InboundRun{}, errors.New("request body is not a JSON run input")
	}

	if err := refuseNonEmptyArray(shape.Resume, "client resume objects are not accepted; resume is a platform decision that issues a new invocation"); err != nil {
		return InboundRun{}, err
	}
	if err := refuseResumeInForwardedProps(shape.ForwardedProps); err != nil {
		return InboundRun{}, err
	}
	if err := refuseNonEmptyArray(shape.Tools, "client tools are not accepted; tool schemas are platform-approved configuration"); err != nil {
		return InboundRun{}, err
	}
	if err := refuseNonEmptyArray(shape.Context, "client context entries are not accepted"); err != nil {
		return InboundRun{}, err
	}

	messages := make([]CanonicalMessage, 0, len(shape.Messages))
	for i, m := range shape.Messages {
		if m.Role != "user" {
			return InboundRun{}, fmt.Errorf("message %d has role %q: only user content may enter a run; system/developer/assistant/tool messages are platform-owned", i, m.Role)
		}
		var content string
		if err := json.Unmarshal(m.Content, &content); err != nil {
			return InboundRun{}, fmt.Errorf("message %d content is not a plain string", i)
		}
		messages = append(messages, CanonicalMessage{Content: content, Role: m.Role})
	}

	return InboundRun{
		RunID:    shape.RunID,
		ThreadID: shape.ThreadID,
		Digest:   DigestMessages(messages),
	}, nil
}

// refuseResumeInForwardedProps rejects a forwardedProps object carrying a
// resume or checkpoint payload. forwardedProps is cleared before the runner
// regardless; this refusal exists so an attempted resume is an answered
// refusal, not silently dropped payload that keeps working elsewhere.
func refuseResumeInForwardedProps(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var props map[string]json.RawMessage
	if err := json.Unmarshal(raw, &props); err != nil {
		// Non-object forwardedProps is inert (cleared downstream); not ours.
		return nil
	}
	for _, key := range []string{"resume", "checkpoint", "approval"} {
		if value, ok := props[key]; ok && string(value) != "null" {
			return errors.New("client resume objects are not accepted; resume is a platform decision that issues a new invocation")
		}
	}
	return nil
}

// refuseNonEmptyArray rejects a present, non-empty JSON array field. An
// absent field (nil) and an explicit empty array are both fine.
func refuseNonEmptyArray(raw json.RawMessage, violation string) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return errors.New(violation)
	}
	if len(arr) > 0 {
		return errors.New(violation)
	}
	return nil
}

// DigestMessages computes the frozen canonical input digest: SHA-256, hex
// encoded, over the compact JSON array of the messages in order. The encoder
// disables HTML escaping so the bytes are the plain JSON any side produces.
func DigestMessages(messages []CanonicalMessage) string {
	var buf bytes.Buffer
	// json.Encoder appends a newline; trim it so the digest is over the JSON
	// document exactly, not a formatted variant of it. HTML escaping is off:
	// the frozen serialization is plain JSON — the bytes any side produces —
	// not Go's \u003c variant of it.
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(messages); err != nil {
		// CanonicalMessage is two strings; encoding cannot fail.
		return ""
	}
	encoded := bytes.TrimRight(buf.Bytes(), "\n")
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
