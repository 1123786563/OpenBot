import { z } from "zod";

/*
 * The internal runtime wire, per plan 03 §3.3: ONE module owns the strict
 * RuntimeInvocation — its fields, its value rules, its version — and every
 * parser (the validation route, the ledger verifier that E2-B will add, the
 * golden fixtures) derives from this schema instead of re-listing fields.
 *
 * Frozen at schema_version "1". Adding a field is a both-sides contract
 * upgrade that mints a new golden sample; it never relaxes what "1" means.
 *
 * The legacy error codes from the 01 wire (`runtime-invocation.test.ts` is
 * its regression suite) are preserved by `parseRuntimeInvocation`, which
 * classifies in the route's historical precedence and lets the Zod schema be
 * the final authority over everything the legacy checks already passed.
 *
 * There is deliberately NO default verification here: nothing in this module
 * ever says "ok". Verdicts come from a host-supplied verifier (the route's
 * `InvocationValidationDeps`), and the always-yes fakes live only in test
 * planes (`scripts/enterprise-runtime-probe.ts`, the G1a fake), never in a
 * production import path.
 */

/** The wire version this module freezes. */
export const RUNTIME_WIRE_SCHEMA_VERSION = "1";

/** Header names of the v0.2 wire, shared verbatim with the validation route. */
export const RUNTIME_SERVICE_CREDENTIAL_HEADER =
  "x-openbot-runtime-service-credential";
export const RUNTIME_CAPABILITY_HEADER = "x-openbot-runtime-capability";

/** RFC3339 with an offset — the one timestamp shape the wire freezes. */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The fields a RuntimeInvocation must carry. */
const REQUIRED_FIELDS = {
  schema_version: z.literal(RUNTIME_WIRE_SCHEMA_VERSION),
  tenant_id: z.string().min(1),
  principal_id: z.string().min(1),
  actor_id: z.string().min(1),
  initiator_kind: z.enum(["user", "schedule"]),
  run_id: z.string().min(1),
  attempt_id: z.string().min(1),
  turn_id: z.string().min(1),
  thread_id: z.string().min(1),
  expert_version: z.string().min(1),
  input_digest: z.string().min(1),
  model_route_ref: z.string().min(1),
  budget_reservation_id: z.string().min(1),
  lease_id: z.string().min(1),
  fencing_token: z.string().min(1),
  expires_at: z.string().regex(RFC3339),
} as const;

/** The one field a RuntimeInvocation may carry: a scheduled initiation's delegation. */
const OPTIONAL_FIELDS = {
  delegation_ref: z.string().min(1).optional(),
} as const;

/**
 * The strict RuntimeInvocation (master plan §4.2, wire schema v1): snake_case,
 * every field required except delegation_ref, which a scheduled initiation
 * must carry. Unknown fields are refused, not ignored. This is the ONLY
 * identity-carrying body shape the enterprise validation endpoint accepts.
 */
export const RuntimeInvocationSchema = z
  .object({ ...REQUIRED_FIELDS, ...OPTIONAL_FIELDS })
  .strict();

export type RuntimeInvocation = z.infer<typeof RuntimeInvocationSchema>;

export const REQUIRED_INVOCATION_FIELDS = Object.keys(REQUIRED_FIELDS) as Array<
  Exclude<keyof RuntimeInvocation, "delegation_ref">
>;

export const OPTIONAL_INVOCATION_FIELDS = Object.keys(OPTIONAL_FIELDS) as Array<
  keyof Pick<RuntimeInvocation, "delegation_ref">
>;

/** The refusal codes the 01 wire froze; the validation route maps each to one 400 body. */
export type RuntimeInvocationParseError =
  | "invalid_body"
  | "unknown_field"
  | "missing_fields"
  | "unsupported_schema_version"
  | "invalid_expires_at"
  | "invalid_initiator_kind"
  | "schedule_requires_delegation";

export type RuntimeInvocationParseResult =
  | { ok: true; invocation: RuntimeInvocation }
  | { ok: false; error: RuntimeInvocationParseError };

/**
 * The single strict parse of an inbound RuntimeInvocation body.
 *
 * Precedence is the legacy route's, so the 01 regression suite keeps its
 * exact codes: shape, unknown keys, missing/empty fields, then the frozen
 * version, the timestamp, the initiator kind, and finally the schedule rule.
 * The full schema runs last as the authority — if it still refuses something
 * the legacy classification did not name, the body is refused (invalid_body),
 * never accepted.
 */
export function parseRuntimeInvocation(
  raw: unknown,
): RuntimeInvocationParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;

  const known = new Set<string>([
    ...REQUIRED_INVOCATION_FIELDS,
    ...OPTIONAL_INVOCATION_FIELDS,
  ]);
  const unknownField = Object.keys(body).find((key) => !known.has(key));
  if (unknownField !== undefined) {
    return { ok: false, error: "unknown_field" };
  }

  const missing = REQUIRED_INVOCATION_FIELDS.filter(
    (field) =>
      typeof body[field] !== "string" || (body[field] as string) === "",
  );
  if (missing.length > 0) {
    return { ok: false, error: "missing_fields" };
  }
  if (
    body.delegation_ref !== undefined &&
    (typeof body.delegation_ref !== "string" || body.delegation_ref === "")
  ) {
    return { ok: false, error: "missing_fields" };
  }

  if (body.schema_version !== RUNTIME_WIRE_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported_schema_version" };
  }
  // The timestamp rule is the regex AND calendar validity ("2099-13-45…" is
  // shape-valid but not a moment); the semantic half is checked here rather
  // than in the schema because an unrepresentable refinement would take the
  // JSON-Schema projection of the wire off the deterministic path.
  if (
    !RuntimeInvocationSchema.shape.expires_at.safeParse(body.expires_at)
      .success ||
    Number.isNaN(Date.parse(body.expires_at as string))
  ) {
    return { ok: false, error: "invalid_expires_at" };
  }
  if (
    !RuntimeInvocationSchema.shape.initiator_kind.safeParse(body.initiator_kind)
      .success
  ) {
    return { ok: false, error: "invalid_initiator_kind" };
  }

  const parsed = RuntimeInvocationSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_body" };
  }
  if (
    parsed.data.initiator_kind === "schedule" &&
    parsed.data.delegation_ref === undefined
  ) {
    return { ok: false, error: "schedule_requires_delegation" };
  }
  return { ok: true, invocation: parsed.data };
}
