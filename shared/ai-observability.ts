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

/** Bump this whenever the semantics below change. Frozen into dataset versions by ticket #25. */
export const REDACTION_POLICY_VERSION = "opik-redaction/2";

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

export type SafeValue =
  | { state: "projected"; value: unknown }
  | { state: "omitted"; reason: OmitReason }
  | {
      state: "truncated";
      /** The kept prefix: a cut string, or the kept items of an array/object. */
      value: unknown;
      /** For a string, its original UTF-8 byte size; for an array/object, its original item count. */
      originalBytes: number;
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
