/**
 * The frozen canonical envelope digest, the binding between a minted capability and the exact
 * RuntimeInvocation it was minted for.
 *
 * Both computations live on the TS plane today — the gateway mints the capability row with this
 * digest, the verifier recomputes it from the invocation the Go side forwarded — so the freeze
 * exists to make the two agree byte-for-byte forever, and to keep the shape a future Go-side
 * ledger verifier (plan 03 E2-B) can adopt without a renegotiation:
 *
 *   - strictly-parsed invocation only (the wire schema is the authority, never raw bytes);
 *   - object keys sorted lexicographically, so two JSON spellings of one envelope are one digest;
 *   - compact JSON (no spaces), no HTML escaping;
 *   - U+2028/U+2029 escaped explicitly — JSON.stringify leaves them raw while Go's encoder always
 *     escapes them, so the escaping is frozen here rather than left to each runtime's dialect
 *     (the same rule ../runs/digest.ts froze for the create-run digest).
 */
import { createHash } from "node:crypto";

import type { RuntimeInvocation } from "./wire";

const ESCAPE_U2028 = /\u2028/g;
const ESCAPE_U2029 = /\u2029/g;

function escapeFrozen(value: string): string {
  return value.replace(ESCAPE_U2028, "\\u2028").replace(ESCAPE_U2029, "\\u2029");
}

/**
 * SHA-256 hex over the canonical form of one invocation. Every field is a string on the wire
 * (schema_version included), so the canonical object is a plain string record — no nested
 * canonicalization exists to disagree about.
 */
export function invocationEnvelopeDigest(invocation: RuntimeInvocation): string {
  const canonical: Record<string, string> = {};
  for (const key of Object.keys(invocation).sort()) {
    /* delegation_ref is the one optional field: an invocation without it keeps the key out of the
     * canonical record entirely, which is byte-identical to what JSON.stringify did when the value
     * was assigned as undefined (undefined properties are omitted from the JSON text). */
    const value = invocation[key as keyof RuntimeInvocation];
    if (value !== undefined) {
      canonical[key] = value;
    }
  }
  return createHash("sha256")
    .update(escapeFrozen(JSON.stringify(canonical)), "utf8")
    .digest("hex");
}
