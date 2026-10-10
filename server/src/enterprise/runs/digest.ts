import { createHash } from "node:crypto";
import {
  type CreateRun,
  CreateRunSchema,
} from "../../../../shared/enterprise/run-contracts";

/*
 * Request digests, per plan 03 §3.3: the idempotency comparison keys are
 * computed by THIS module on both sides of a replay, over the STRICTLY PARSED
 * request — never over raw bytes, which would make two JSON spellings of the
 * same request two runs (or two spellings of one run).
 *
 * The text is not trimmed and not Unicode-normalized: normalization and
 * trimming are equivalence classes the caller did not ask for, and every
 * equivalence class is an injection channel. U+2028/U+2029 are escaped
 * explicitly because JSON.stringify leaves them raw while Go's encoder
 * escapes them — same document, different bytes, so the escaping is frozen
 * here rather than left to each runtime's JSON dialect.
 */

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The create-run digest: sha256 over a positional array of the parsed
 * request's fields, so field order in the caller's JSON cannot matter and a
 * missing optional thread_id hashes as null — an absent field and an explicit
 * null are the same request.
 */
export function runRequestDigest(request: CreateRun): string {
  const v = CreateRunSchema.parse(request);
  return sha256(
    JSON.stringify([
      "run-create-v1",
      v.thread_id ?? null,
      v.workspace_id,
      v.expert_release_id,
      v.model_alias,
      v.input.text,
    ]),
  );
}

/**
 * The user-input digest the Go runtime computes over NEW USER CONTENT only
 * (role fixed to "user"): the frozen canonical `{"content":…,"role":…}` pairs.
 * Lone surrogates are refused before hashing — a string that is not
 * well-formed cannot have one canonical byte sequence across languages.
 */
export function goInputDigest(texts: readonly string[]): string {
  for (const text of texts) {
    if (!text.isWellFormed()) throw new Error("INVALID_UNICODE_INPUT");
  }
  const json = JSON.stringify(
    texts.map((content) => ({ content, role: "user" })),
  )
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return sha256(json);
}
