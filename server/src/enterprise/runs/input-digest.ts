/**
 * The frozen canonical input digest, the TS twin of the Go candidate's
 * `trustedinput.DigestMessages` (runtime-go/internal/trustedinput/input.go).
 *
 * The gateway computes it when minting an invocation; the Go input guard
 * recomputes it over the body that actually arrives and refuses on any
 * difference — so these two functions must hash the SAME bytes forever:
 *
 *   - an ARRAY of {"content":…,"role":…} objects in message order, field
 *     order content-then-role (Go struct order), nothing else per message;
 *   - compact JSON, no HTML escaping, no trailing newline;
 *   - U+2028/U+2029 escaped explicitly (Go's encoder always escapes them;
 *     JSON.stringify leaves them raw — the escaping is frozen here, the same
 *     rule ../runtime/envelope-digest.ts froze for the envelope digest);
 *   - SHA-256, hex.
 *
 * Only NEW USER CONTENT can change this digest: the gateway builds the
 * message list itself from the strictly parsed CreateRun input, so a client
 * can never wrap history or tools into the bytes the invocation vouched for.
 */
import { createHash } from "node:crypto";

const ESCAPE_U2028 = /\u2028/g;
const ESCAPE_U2029 = /\u2029/g;

function escapeFrozen(value: string): string {
  return value
    .replace(ESCAPE_U2028, "\\u2028")
    .replace(ESCAPE_U2029, "\\u2029");
}

export type CanonicalInputMessage = { content: string; role: "user" };

export function canonicalInputMessages(input: {
  text: string;
}): CanonicalInputMessage[] {
  return [{ content: input.text, role: "user" }];
}

/** SHA-256 hex over the frozen canonical form of an ordered user-message list. */
export function digestMessages(messages: CanonicalInputMessage[]): string {
  return createHash("sha256")
    .update(escapeFrozen(JSON.stringify(messages)), "utf8")
    .digest("hex");
}

/** SHA-256 hex over the frozen canonical form of the run's user input. */
export function runInputDigest(input: { text: string }): string {
  return digestMessages(canonicalInputMessages(input));
}
