/**
 * The shape of content that is safe to store, evaluate and export.
 *
 * A projection never answers with a bare string. "Nothing here" is three different facts and the
 * UI has to tell them apart: the value was projected and is safe; it was withheld on purpose; it
 * was given but cut. Collapsing them into "" is how a redaction system starts lying — an operator
 * reads an empty field as "the run produced nothing" instead of "we refused to show you this".
 *
 * The state names match the availability copy registered by ticket #8, so a view can render the
 * reason without inventing wording per surface.
 */

/**
 * Bump this whenever the semantics below change. Frozen into dataset versions by ticket #25.
 * v2: PEM blocks are denied wherever they sit; an AWS secret is denied with its label before the
 * value; record caps report `truncated` instead of silently dropping; the byte cut never strands a
 * lone surrogate; record projection is prototype-safe.
 * v3: URL userinfo credentials (scheme://user:pass@host) are denied at every entrance; the
 * secret-label context covers api_key/access-token-style labels at any distance on either side;
 * `<think>` chains are reasoning content; loopback, unspecified and link-local hosts are raw
 * attachments; a hostile accessor cannot abort projection; lowercase PEM headers are denied.
 * v4: endpoint host matching strips the DNS root-label trailing dot (`localhost.` is the
 * loopback host); record enumeration survives throwing ownKeys/getOwnPropertyDescriptor traps
 * and drops deny-matching Proxy key names.
 * v5: the array branch survives throwing array traps (slice/length) and the allowlist loop
 * survives a throwing own-key read — a hostile record degrades to omitted/skipped, never a
 * crash out of the projection.
 */
export const REDACTION_POLICY_VERSION = "opik-redaction/5";

export type SafeContentState = "projected" | "omitted" | "truncated";

export type OmitReason =
  | "credential"
  | "connection_string"
  | "account_identifier"
  | "reasoning_content"
  | "raw_attachment"
  | "internal_capability"
  | "unhandled_free_text";

export type SafeText =
  | { state: "projected"; text: string }
  | { state: "omitted"; reason: OmitReason }
  | { state: "truncated"; text: string; originalBytes: number };

/** A record whose every value is a projected SafeValue — the metadata wire shape. */
export type SafeRecord = Record<string, SafeValue>;

export type SafeValue =
  | { state: "projected"; value: unknown }
  | { state: "omitted"; reason: OmitReason }
  | {
      state: "truncated";
      /** For string leaves the cut text; for records/arrays the partial projection. */
      value: unknown;
      /** UTF-8 byte size of the original value; -1 when it cannot be measured (e.g. BigInt). */
      originalBytes: number;
      /** Items removed by a record/array cap; absent for string cuts. */
      dropped?: number;
    };

/**
 * Reason -> the i18n key that explains it. Keys live in the `ai-observability-*` namespaces
 * created by ticket #8; a reason without a key is a type error here, not a blank string there.
 */
export const OMIT_COPY_KEY: Record<OmitReason, string> = {
  credential: "availability.omitted",
  connection_string: "availability.omitted",
  account_identifier: "availability.omitted",
  reasoning_content: "availability.omitted",
  raw_attachment: "availability.omitted",
  internal_capability: "availability.omitted",
  unhandled_free_text: "availability.omitted",
};
