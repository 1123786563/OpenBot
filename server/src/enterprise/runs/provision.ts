/**
 * The offline run-provisioning domain commands, per plan 03 §4.4 (E1-D).
 *
 * `applyRunProvision(tx, command)` is the ONLY door to release / route / grant / budget /
 * delegation writes for the offline operator — the same discipline 02's tenancy provision
 * established, extended to the runs ledger: a strict discriminated Zod union (eleven modes —
 * six registrations, five revocations; each mode admits ONLY its own fields), a deterministic
 * payload digest over EVERY business field, one READ COMMITTED transaction with the plan's
 * fixed advisory-lock order (tenant → principal → resource → release → route → delegation →
 * operation), a re-validated prior audit event, the write itself, and the audit append —
 * committed together or not at all. There is no dynamic table name, no whole-object spread
 * into a statement, and no second marketplace: identity/workspace/resource rows are 02's to
 * create, and this module verifies them instead of fabricating them.
 *
 * Idempotency reuses 02's `enterprise_security_events`: the audit event's id IS the operation
 * id, a replay of the exact same normalized payload writes nothing, and the same operation id
 * with ANY different payload is a 409 — even when it names a different row. A stored event
 * that does not strictly validate fails the operation closed (SECURITY_EVENT_UNREADABLE) and
 * rolls the whole transaction back.
 *
 * Server-owned state: every registered row's initial status and revision are set HERE, never
 * by the caller — releases insert `published`, routes `active`, grants `active` at revision 1,
 * budget accounts `active` at revision 1 with spent/held/overage fixed at 0, delegations with
 * used_runs 0. budget-open NEVER rewrites an existing account's limit or its incurred values:
 * the same period identity with a different limit is a 409, and a real adjustment needs its
 * own operation with a stated reason (not expressible in this union by construction).
 *
 * Tool manifests belong to the 04 tool plane (plan §4.4: "有工具的manifest须经过04"; §4.1:
 * "tool_count=0才能独立验证"): this CLI registers zero-tool releases only, and a zero-tool
 * release must carry the canonical EMPTY manifest digest — tool_count=0 with any other
 * manifest digest claims tools it says it has not, and is refused.
 *
 * Route targets: the input `target_ref` is an operator-owned deployment-registry KEY checked
 * against the `TargetRegistry` — never a URI, and the real endpoint and its credentials stay
 * in the deployment mapping this module cannot even express.
 *
 * Revocations run under the SAME locks and the SAME-transaction audit as registrations:
 * release/route/delegation flip status (route and delegation bump their revision inside the
 * resource lock, exactly once — an audited no-op afterwards), run grants DELETE the row, model
 * grants flip to `revoked`. Revoking an absent GRANT is an audited no-change (02's revocation
 * precedent); disabling/revokeing an object whose PARENT row never existed is a 404, so a
 * typo can never be laundered into an "applied" no-op.
 *
 * Delegations are the human-approved pilot instrument only (explicit principal/release/route/
 * term/counts/per-run cap); nothing here mints a long-lived session.
 *
 * Role note (plan §4.2 + §4.4 "生产开通仍需单独授权"): no single restricted role in the
 * current migration matrix holds BOTH the runs-domain writes and the security_events INSERT
 * (ob_ent_run_operator has the former, ob_ent_operator the latter). The transaction handle is
 * therefore the caller's, and this package's acceptance runs on the migration-owner test
 * connection exactly like the E1-C fixtures and enterprise-runtime-seed.ts; production
 * provisioning needs the DBA-approved operator wiring before it may run anywhere else.
 *
 * Statement texts are module constants; every value travels as an `$n` parameter. bigint and
 * timestamptz values are passed as strings with explicit casts — never as JS numbers.
 */
import { z } from "zod";
import type { Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import {
  createStaticTargetRegistry,
  ID,
  Decimal,
  type TargetRegistry,
} from "../models/contracts";
import {
  PAYLOAD_SERIALIZATION,
  payloadDigest,
} from "../tenancy/provision";
import {
  firstRow,
  lockExclusive,
  lockKey,
  lockShared,
  setTenantContext,
  type TxClient,
} from "../tenancy/transaction";

/* ---------------------------------------------------------------------------
 * Strict input union — eleven modes, each admitting only its own fields.
 * ------------------------------------------------------------------------ */

/** A sha256 hex digest: the shape every file/manifest summary must have before it is checked. */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** ISO currency code, the same shape the model route catalog enforces. */
const Currency = z.string().regex(/^[A-Z]{3}$/);

/**
 * A date that MUST carry its timezone (`Z` or ±HH:MM): an offline operator recording a budget
 * period or a delegation term without a timezone has not recorded a moment.
 */
const Timestamptz = z.iso.datetime({ offset: true });

/**
 * Bounded counters that travel as JSON numbers (byte ceilings, call counts, tool counts) and
 * land in bigint columns as strings — always whole, always within safe-integer range.
 */
const PositiveCount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const NonNegativeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The operator's stated justification; recorded in the audit event. */
const Reason = z.string().trim().min(1).max(512);

/**
 * Version labels for the Go expert build and the runtime compatibility claim. Bounded,
 * no whitespace, no separators beyond `._-` — they pin identity, they never carry prose.
 */
const VersionLabel = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** Lowercase protocol/usage profile names, the same shape ModelRouteSchema enforces. */
const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

/**
 * The deployment-registry target key — the SAME pattern as models/contracts.ts's private
 * `TargetRef` (bounded, no scheme, no spaces): it names an entry the operator loaded from
 * deployment config, it never IS a URL, so user-supplied URIs are refused at the schema.
 */
const ProvisionTargetRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,127}$/);

const RunGrantActions = ["start", "cancel_own", "resume_own"] as const;
const BudgetScopeKinds = ["tenant", "workspace", "expert", "principal"] as const;

const RouteRegisterSchema = z
  .object({
    mode: z.literal("route-register"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    resource_id: ID,
    alias: ID,
    revision: Decimal,
    target_ref: ProvisionTargetRef,
    price_revision: Decimal,
    currency: Currency,
    input_unit_micros: Decimal,
    output_unit_micros: Decimal,
    per_request_micros: Decimal,
    max_input_tokens: PositiveCount,
    max_output_tokens: PositiveCount,
    max_request_bytes: PositiveCount,
    protocol_profile: ProfileName,
    usage_profile: ProfileName,
    is_default_for_alias: z.boolean(),
  })
  .strict();

const ReleaseRegisterSchema = z
  .object({
    mode: z.literal("release-register"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    resource_id: ID,
    version_digest: Sha256Hex,
    runtime_compatibility: VersionLabel,
    expert_version: VersionLabel,
    model_route_ref: ID,
    input_limit_bytes: PositiveCount,
    max_model_calls: PositiveCount,
    max_run_micros: Decimal,
    currency: Currency,
    tool_manifest_digest: Sha256Hex,
    tool_count: NonNegativeCount,
  })
  .strict();

const RunGrantSchema = z
  .object({
    mode: z.literal("run-grant"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    release_id: ID,
    principal_id: ID,
    action: z.enum(RunGrantActions),
  })
  .strict();

const ModelGrantSchema = z
  .object({
    mode: z.literal("model-grant"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    route_id: ID,
    principal_id: ID,
  })
  .strict();

const BudgetOpenSchema = z
  .object({
    mode: z.literal("budget-open"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    scope_kind: z.enum(BudgetScopeKinds),
    scope_ref: ID,
    period_id: ID,
    starts_at: Timestamptz,
    ends_at: Timestamptz,
    currency: Currency,
    limit_micros: Decimal,
  })
  .strict();

const DelegationRegisterSchema = z
  .object({
    mode: z.literal("delegation-register"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    principal_id: ID,
    release_id: ID,
    route_id: ID,
    max_run_micros: Decimal,
    max_runs: PositiveCount,
    expires_at: Timestamptz,
  })
  .strict();

/*
 * Revocation inputs carry ONLY their target ids, the reason and the operation identity —
 * nothing a caller could use to rewrite the object it is taking away.
 */
const DisableReleaseSchema = z
  .object({
    mode: z.literal("disable-release"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    reason: Reason,
  })
  .strict();

const RevokeRunGrantSchema = z
  .object({
    mode: z.literal("revoke-run-grant"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    release_id: ID,
    principal_id: ID,
    action: z.enum(RunGrantActions),
    reason: Reason,
  })
  .strict();

const DisableRouteSchema = z
  .object({
    mode: z.literal("disable-route"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    reason: Reason,
  })
  .strict();

const RevokeModelGrantSchema = z
  .object({
    mode: z.literal("revoke-model-grant"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    route_id: ID,
    principal_id: ID,
    reason: Reason,
  })
  .strict();

const RevokeDelegationSchema = z
  .object({
    mode: z.literal("revoke-delegation"),
    tenant_id: ID,
    operator: z.string().trim().min(1),
    operation_id: ID,
    id: ID,
    reason: Reason,
  })
  .strict();

export const RunProvisionCommandSchema = z.discriminatedUnion("mode", [
  RouteRegisterSchema,
  ReleaseRegisterSchema,
  RunGrantSchema,
  ModelGrantSchema,
  BudgetOpenSchema,
  DelegationRegisterSchema,
  DisableReleaseSchema,
  RevokeRunGrantSchema,
  DisableRouteSchema,
  RevokeModelGrantSchema,
  RevokeDelegationSchema,
]);

export type RunProvisionCommand = z.infer<typeof RunProvisionCommandSchema>;

export type RunProvisionMode = RunProvisionCommand["mode"];

/** Fault-injection pause point for the §4.4 audit-rollback test; production never passes it. */
export type RunProvisionHooks = {
  beforeAudit?: () => Promise<void>;
};

export type RunProvisionDeps = {
  /** The deployment's approved target keys; defaults to ENTERPRISE_MODEL_TARGETS (fail-closed). */
  targets?: TargetRegistry;
  hooks?: RunProvisionHooks;
};

/**
 * The canonical zero-tool manifest is the empty JSON array; ONLY its digest may ride with
 * tool_count=0. A different digest with a zero count claims tools the release says it has
 * not — refused, not normalized.
 */
export const EMPTY_TOOL_MANIFEST_DIGEST = new Bun.CryptoHasher("sha256")
  .update("[]")
  .digest("hex");

/**
 * The default deployment registry: the operator's approved target keys, one comma-separated
 * list. An unset or empty list answers NO to everything — production provisioning without a
 * mapped target is refused closed, never waved through.
 */
function defaultTargetRegistry(): TargetRegistry {
  const raw = process.env.ENTERPRISE_MODEL_TARGETS ?? "";
  const refs = raw
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  return createStaticTargetRegistry(refs);
}

/* ---------------------------------------------------------------------------
 * Stable errors.
 * ------------------------------------------------------------------------ */

const INVALID_PROVISION_INPUT = new EnterpriseError("INVALID_PROVISION_INPUT", 400);
const IDEMPOTENCY_CONFLICT = new EnterpriseError("IDEMPOTENCY_CONFLICT", 409);
const SECURITY_EVENT_UNREADABLE = new EnterpriseError("SECURITY_EVENT_UNREADABLE", 503);
const TENANT_NOT_FOUND = new EnterpriseError("TENANT_NOT_FOUND", 409);
const TENANT_NOT_ACTIVE = new EnterpriseError("TENANT_NOT_ACTIVE", 409);
const RESOURCE_NOT_FOUND = new EnterpriseError("RESOURCE_NOT_FOUND", 404);
const MEMBERSHIP_NOT_FOUND = new EnterpriseError("MEMBERSHIP_NOT_FOUND", 409);
const MEMBER_NOT_ACTIVE = new EnterpriseError("MEMBER_NOT_ACTIVE", 409);
const WORKSPACE_NOT_FOUND = new EnterpriseError("WORKSPACE_NOT_FOUND", 404);
const MODEL_TARGET_UNKNOWN = new EnterpriseError("MODEL_TARGET_UNKNOWN", 503);
const ROUTE_CONFLICT = new EnterpriseError("ROUTE_CONFLICT", 409);
const ROUTE_REVISION_CONFLICT = new EnterpriseError("ROUTE_REVISION_CONFLICT", 409);
const ROUTE_DEFAULT_CONFLICT = new EnterpriseError("ROUTE_DEFAULT_CONFLICT", 409);
const ROUTE_NOT_FOUND = new EnterpriseError("ROUTE_NOT_FOUND", 404);
const RELEASE_CONFLICT = new EnterpriseError("RELEASE_CONFLICT", 409);
const RELEASE_NOT_FOUND = new EnterpriseError("RELEASE_NOT_FOUND", 404);
const RELEASE_MODEL_ROUTE_NOT_FOUND = new EnterpriseError(
  "RELEASE_MODEL_ROUTE_NOT_FOUND",
  404,
);
const RELEASE_TOOLS_REQUIRE_TOOL_PLANE = new EnterpriseError(
  "RELEASE_TOOLS_REQUIRE_TOOL_PLANE",
  403,
);
const RELEASE_TOOL_MANIFEST_MISMATCH = new EnterpriseError(
  "RELEASE_TOOL_MANIFEST_MISMATCH",
  400,
);
const BUDGET_CONFLICT = new EnterpriseError("BUDGET_CONFLICT", 409);
const PERIOD_INVALID = new EnterpriseError("PERIOD_INVALID", 400);
const DELEGATION_CONFLICT = new EnterpriseError("DELEGATION_CONFLICT", 409);
const DELEGATION_NOT_FOUND = new EnterpriseError("DELEGATION_NOT_FOUND", 404);
const DELEGATION_EXPIRED = new EnterpriseError("DELEGATION_EXPIRED", 400);

/* ---------------------------------------------------------------------------
 * Statements (module constants; `$n` placeholders only; values never in text).
 * ------------------------------------------------------------------------ */

const SELECT_TENANT_STATUS = `
  select status from enterprise_tenants where id = $1`;
const SELECT_RESOURCE_STATUS = `
  select status from enterprise_resources where tenant_id = $1 and id = $2`;
const SELECT_MEMBERSHIP_STATUS = `
  select status from enterprise_memberships where tenant_id = $1 and principal_id = $2`;
const SELECT_WORKSPACE = `
  select id from enterprise_workspaces where tenant_id = $1 and id = $2`;

const SELECT_ROUTE_FULL = `
  select id, alias, revision::text as revision, resource_id, target_ref,
         price_revision::text as price_revision, currency,
         input_unit_micros::text as input_unit_micros,
         output_unit_micros::text as output_unit_micros,
         per_request_micros::text as per_request_micros,
         max_input_tokens::text as max_input_tokens,
         max_output_tokens::text as max_output_tokens,
         max_request_bytes::text as max_request_bytes,
         protocol_profile, usage_profile, is_default_for_alias, status
  from enterprise_model_routes where tenant_id = $1 and id = $2`;
const SELECT_ROUTE_SLOT = `
  select id from enterprise_model_routes
  where tenant_id = $1 and alias = $2 and revision = $3::bigint`;
const SELECT_ROUTE_ACTIVE_DEFAULT = `
  select id from enterprise_model_routes
  where tenant_id = $1 and alias = $2 and is_default_for_alias = true and status = 'active'`;
const INSERT_ROUTE = `
  insert into enterprise_model_routes (tenant_id, id, alias, revision, resource_id, target_ref,
    price_revision, currency, input_unit_micros, output_unit_micros, per_request_micros,
    max_input_tokens, max_output_tokens, max_request_bytes, protocol_profile, usage_profile,
    is_default_for_alias, status)
  values ($1, $2, $3, $4::bigint, $5, $6, $7::bigint, $8, $9::bigint, $10::bigint, $11::bigint,
    $12::bigint, $13::bigint, $14::bigint, $15, $16, $17, 'active')`;
const DISABLE_ROUTE = `
  update enterprise_model_routes set status = 'disabled', revision = revision + 1
  where tenant_id = $1 and id = $2 and status = 'active'
  returning revision::text as revision`;

const SELECT_RELEASE_FULL = `
  select id, resource_id, version_digest, runtime_compatibility, expert_version,
         model_route_ref, input_limit_bytes::text as input_limit_bytes,
         max_model_calls::text as max_model_calls, max_run_micros::text as max_run_micros,
         currency, tool_manifest_digest, tool_count::text as tool_count, status
  from enterprise_run_releases where tenant_id = $1 and id = $2`;
const INSERT_RELEASE = `
  insert into enterprise_run_releases (tenant_id, id, resource_id, version_digest,
    runtime_compatibility, expert_version, model_route_ref, input_limit_bytes, max_model_calls,
    max_run_micros, currency, tool_manifest_digest, tool_count, status)
  values ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10::bigint, $11, $12, $13::bigint,
    'published')`;
const DISABLE_RELEASE = `
  update enterprise_run_releases set status = 'disabled'
  where tenant_id = $1 and id = $2 and status = 'published'`;

const SELECT_RUN_GRANT = `
  select revision::text as revision from enterprise_run_grants
  where tenant_id = $1 and release_id = $2 and principal_id = $3 and action = $4`;
const INSERT_RUN_GRANT = `
  insert into enterprise_run_grants (tenant_id, release_id, principal_id, action, revision)
  values ($1, $2, $3, $4, 1)`;
const DELETE_RUN_GRANT = `
  delete from enterprise_run_grants
  where tenant_id = $1 and release_id = $2 and principal_id = $3 and action = $4`;

const SELECT_MODEL_GRANT = `
  select revision::text as revision, status from enterprise_model_grants
  where tenant_id = $1 and route_id = $2 and principal_id = $3`;
const INSERT_MODEL_GRANT = `
  insert into enterprise_model_grants (tenant_id, route_id, principal_id, revision, status)
  values ($1, $2, $3, 1, 'active')`;
const REVOKE_MODEL_GRANT = `
  update enterprise_model_grants set status = 'revoked', revision = revision + 1
  where tenant_id = $1 and route_id = $2 and principal_id = $3 and status = 'active'
  returning revision::text as revision`;

const SELECT_BUDGET_ACCOUNT = `
  select id, limit_micros::text as limit_micros, starts_at, ends_at, status
  from enterprise_budget_accounts
  where tenant_id = $1 and scope_kind = $2 and scope_ref = $3 and period_id = $4 and currency = $5`;
const INSERT_BUDGET_ACCOUNT = `
  insert into enterprise_budget_accounts (tenant_id, id, scope_kind, scope_ref, period_id,
    starts_at, ends_at, currency, limit_micros, spent_micros, held_micros, overage_micros,
    status, revision)
  values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::bigint, 0, 0, 0,
    'active', 1)`;

const SELECT_DELEGATION = `
  select id, principal_id, release_id, route_id, max_run_micros::text as max_run_micros,
         max_runs::text as max_runs, used_runs::text as used_runs, expires_at, revoked_at,
         revision::text as revision
  from enterprise_run_delegations where tenant_id = $1 and id = $2`;
const INSERT_DELEGATION = `
  insert into enterprise_run_delegations (tenant_id, id, principal_id, release_id, route_id,
    max_run_micros, max_runs, used_runs, expires_at, revision)
  values ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, 0, $8::timestamptz, 1)`;
const REVOKE_DELEGATION = `
  update enterprise_run_delegations set revoked_at = clock_timestamp(), revision = revision + 1
  where tenant_id = $1 and id = $2 and revoked_at is null
  returning revision::text as revision`;

/* 02's idempotency anchor, reused verbatim: the event id IS the operation id. */
const SELECT_STORED_EVENT =
  "select kind, details from enterprise_security_events where tenant_id = $1 and id = $2";
const INSERT_EVENT =
  "insert into enterprise_security_events (tenant_id, id, operation_id, actor, kind, details) values ($1, $2, $3, $4, $5, $6::jsonb)";

/* ---------------------------------------------------------------------------
 * Audit helpers — the exact stored shape 02 froze (same serialization constant, same strict
 * re-read), so a replay is recognized across both provisioning domains or fails closed.
 * ------------------------------------------------------------------------ */

const StoredDetailsSchema = z
  .object({
    serialization: z.literal(PAYLOAD_SERIALIZATION),
    payload_digest: z.string().min(1),
    result: z.unknown(),
  })
  .strict();

type StoredDetails = z.infer<typeof StoredDetailsSchema>;

/** The minimal recorded outcome of an operation, replayed verbatim to a re-submitted caller. */
type OperationOutcome = Record<string, unknown>;

async function readStoredEvent(
  tx: TxClient,
  tenantId: string,
  operationId: string,
): Promise<{ kind: string; details: StoredDetails } | undefined> {
  const row = await firstRow(tx, SELECT_STORED_EVENT, [tenantId, operationId]);
  if (row === undefined) {
    return undefined;
  }
  const parsedDetails = StoredDetailsSchema.safeParse(row.details);
  if (!parsedDetails.success || typeof row.kind !== "string") {
    throw SECURITY_EVENT_UNREADABLE;
  }
  return { kind: row.kind, details: parsedDetails.data };
}

async function appendEvent(
  tx: TxClient,
  tenantId: string,
  operationId: string,
  operator: string,
  kind: string,
  digest: string,
  result: OperationOutcome,
): Promise<void> {
  /* The details value is passed as an object, not pre-stringified: Bun's SQL serializes a value
   * once, so a pre-stringified parameter would land as a doubly-encoded jsonb string. */
  await tx.unsafe(INSERT_EVENT, [
    tenantId,
    operationId,
    operationId,
    operator,
    kind,
    {
      serialization: PAYLOAD_SERIALIZATION,
      payload_digest: digest,
      result,
    },
  ]);
}

/** Every business field of the command, as strings — the digest covers ALL of them. */
function digestPayload(command: RunProvisionCommand): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(command)) {
    if (key === "operation_id") {
      continue; // the event id carries it; the digest covers everything else
    }
    payload[key] = typeof value === "string" ? value : String(value);
  }
  return payload;
}

/** The audit kind per mode; the record is total over the union. */
const AUDIT_KINDS: Readonly<Record<RunProvisionMode, string>> = {
  "route-register": "model.route.registered",
  "release-register": "run.release.registered",
  "run-grant": "run.grant.added",
  "model-grant": "model.grant.added",
  "budget-open": "budget.account.opened",
  "delegation-register": "run.delegation.registered",
  "disable-release": "run.release.disabled",
  "revoke-run-grant": "run.grant.revoked",
  "disable-route": "model.route.disabled",
  "revoke-model-grant": "model.grant.revoked",
  "revoke-delegation": "run.delegation.revoked",
};

/* ---------------------------------------------------------------------------
 * Shared fact checks (fail-closed; same codes 02 uses).
 * ------------------------------------------------------------------------ */

async function requireActiveTenant(tx: TxClient, tenantId: string): Promise<void> {
  const tenant = await firstRow(tx, SELECT_TENANT_STATUS, [tenantId]);
  if (tenant === undefined) {
    throw TENANT_NOT_FOUND;
  }
  if (tenant.status !== "active") {
    throw TENANT_NOT_ACTIVE;
  }
}

async function requireActiveResource(
  tx: TxClient,
  tenantId: string,
  resourceId: string,
): Promise<void> {
  const resource = await firstRow(tx, SELECT_RESOURCE_STATUS, [tenantId, resourceId]);
  if (resource === undefined || resource.status !== "active") {
    throw RESOURCE_NOT_FOUND;
  }
}

async function requireActiveMember(
  tx: TxClient,
  tenantId: string,
  principalId: string,
): Promise<void> {
  const membership = await firstRow(tx, SELECT_MEMBERSHIP_STATUS, [
    tenantId,
    principalId,
  ]);
  if (membership === undefined) {
    throw MEMBERSHIP_NOT_FOUND;
  }
  if (membership.status !== "active") {
    throw MEMBER_NOT_ACTIVE;
  }
}

/* ---------------------------------------------------------------------------
 * Advisory locks — the plan's fixed order (tenant → principal → resource → release →
 * route → delegation → operation), each mode taking only what it touches. Locks that need a
 * derived key (the resource behind a route/release) read the parent row first and fail with
 * the parent's 404 before any lock is taken; the act re-validates everything inside the lock.
 * ------------------------------------------------------------------------ */

async function lockFor(tx: TxClient, command: RunProvisionCommand): Promise<void> {
  switch (command.mode) {
    case "route-register": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockExclusive(tx, lockKey("resource", command.tenant_id, command.resource_id));
      await lockExclusive(tx, lockKey("route", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "release-register": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockExclusive(tx, lockKey("resource", command.tenant_id, command.resource_id));
      await lockExclusive(tx, lockKey("release", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "run-grant": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockShared(tx, lockKey("principal", command.tenant_id, command.principal_id));
      await lockExclusive(tx, lockKey("release", command.tenant_id, command.release_id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "model-grant":
    case "revoke-model-grant": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockShared(tx, lockKey("principal", command.tenant_id, command.principal_id));
      const route = await firstRow(tx, SELECT_ROUTE_FULL, [
        command.tenant_id,
        command.route_id,
      ]);
      if (route !== undefined) {
        await lockExclusive(
          tx,
          lockKey("resource", command.tenant_id, String(route.resource_id)),
        );
      }
      await lockExclusive(tx, lockKey("route", command.tenant_id, command.route_id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "budget-open": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      if (command.scope_kind === "principal") {
        await lockShared(tx, lockKey("principal", command.tenant_id, command.scope_ref));
      }
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "delegation-register": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockShared(tx, lockKey("principal", command.tenant_id, command.principal_id));
      await lockExclusive(tx, lockKey("release", command.tenant_id, command.release_id));
      await lockExclusive(tx, lockKey("route", command.tenant_id, command.route_id));
      await lockExclusive(tx, lockKey("delegation", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "disable-release": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      const release = await firstRow(tx, SELECT_RELEASE_FULL, [
        command.tenant_id,
        command.id,
      ]);
      if (release === undefined) {
        throw RELEASE_NOT_FOUND;
      }
      await lockExclusive(
        tx,
        lockKey("resource", command.tenant_id, String(release.resource_id)),
      );
      await lockExclusive(tx, lockKey("release", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "disable-route": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      const route = await firstRow(tx, SELECT_ROUTE_FULL, [
        command.tenant_id,
        command.id,
      ]);
      if (route === undefined) {
        throw ROUTE_NOT_FOUND;
      }
      await lockExclusive(
        tx,
        lockKey("resource", command.tenant_id, String(route.resource_id)),
      );
      await lockExclusive(tx, lockKey("route", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "revoke-run-grant": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      await lockShared(tx, lockKey("principal", command.tenant_id, command.principal_id));
      await lockExclusive(tx, lockKey("release", command.tenant_id, command.release_id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
    case "revoke-delegation": {
      await lockShared(tx, lockKey("tenant", command.tenant_id));
      const delegation = await firstRow(tx, SELECT_DELEGATION, [
        command.tenant_id,
        command.id,
      ]);
      if (delegation === undefined) {
        throw DELEGATION_NOT_FOUND;
      }
      await lockExclusive(tx, lockKey("delegation", command.tenant_id, command.id));
      await lockExclusive(tx, lockKey("operation", command.tenant_id, command.operation_id));
      return;
    }
  }
}

/* ---------------------------------------------------------------------------
 * One fixed write per mode — explicit column lists, server-owned initial state, and only
 * explicitly mutable fields on update. No dynamic table names, no whole-object spread.
 * ------------------------------------------------------------------------ */

async function actRouteRegister(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "route-register" }>,
  targets: TargetRegistry,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);
  await requireActiveResource(tx, command.tenant_id, command.resource_id);

  const existing = await firstRow(tx, SELECT_ROUTE_FULL, [
    command.tenant_id,
    command.id,
  ]);
  if (
    existing !== undefined &&
    (existing.alias !== command.alias ||
      existing.revision !== command.revision ||
      existing.resource_id !== command.resource_id ||
      existing.target_ref !== command.target_ref ||
      existing.price_revision !== command.price_revision ||
      existing.currency !== command.currency ||
      existing.input_unit_micros !== command.input_unit_micros ||
      existing.output_unit_micros !== command.output_unit_micros ||
      existing.per_request_micros !== command.per_request_micros ||
      existing.max_input_tokens !== String(command.max_input_tokens) ||
      existing.max_output_tokens !== String(command.max_output_tokens) ||
      existing.max_request_bytes !== String(command.max_request_bytes) ||
      existing.protocol_profile !== command.protocol_profile ||
      existing.usage_profile !== command.usage_profile ||
      existing.is_default_for_alias !== command.is_default_for_alias)
  ) {
    throw ROUTE_CONFLICT;
  }
  if (existing !== undefined) {
    return { created: false };
  }

  const slot = await firstRow(tx, SELECT_ROUTE_SLOT, [
    command.tenant_id,
    command.alias,
    command.revision,
  ]);
  if (slot !== undefined && slot.id !== command.id) {
    throw ROUTE_REVISION_CONFLICT;
  }
  if (command.is_default_for_alias) {
    const currentDefault = await firstRow(tx, SELECT_ROUTE_ACTIVE_DEFAULT, [
      command.tenant_id,
      command.alias,
    ]);
    if (currentDefault !== undefined && currentDefault.id !== command.id) {
      throw ROUTE_DEFAULT_CONFLICT;
    }
  }
  if (!targets.has(command.target_ref)) {
    /* The operator named a target this deployment never mapped: the route would be
     * unexecutable, and the endpoint it names stays unknowable through this CLI. */
    throw MODEL_TARGET_UNKNOWN;
  }

  await tx.unsafe(INSERT_ROUTE, [
    command.tenant_id,
    command.id,
    command.alias,
    command.revision,
    command.resource_id,
    command.target_ref,
    command.price_revision,
    command.currency,
    command.input_unit_micros,
    command.output_unit_micros,
    command.per_request_micros,
    String(command.max_input_tokens),
    String(command.max_output_tokens),
    String(command.max_request_bytes),
    command.protocol_profile,
    command.usage_profile,
    command.is_default_for_alias,
  ]);
  return { created: true, status: "active" };
}

async function actReleaseRegister(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "release-register" }>,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);
  await requireActiveResource(tx, command.tenant_id, command.resource_id);

  if (command.tool_count > 0) {
    /* Tool manifests are the 04 tool plane's approved artifact; this CLI cannot independently
     * verify one (plan §4.1: "tool_count=0才能独立验证"), so it refuses them closed. */
    throw RELEASE_TOOLS_REQUIRE_TOOL_PLANE;
  }
  if (command.tool_manifest_digest !== EMPTY_TOOL_MANIFEST_DIGEST) {
    /* tool_count=0 yet carrying a real tool manifest: the input contradicts itself. */
    throw RELEASE_TOOL_MANIFEST_MISMATCH;
  }

  const existing = await firstRow(tx, SELECT_RELEASE_FULL, [
    command.tenant_id,
    command.id,
  ]);
  if (
    existing !== undefined &&
    (existing.resource_id !== command.resource_id ||
      existing.version_digest !== command.version_digest ||
      existing.runtime_compatibility !== command.runtime_compatibility ||
      existing.expert_version !== command.expert_version ||
      existing.model_route_ref !== command.model_route_ref ||
      existing.input_limit_bytes !== String(command.input_limit_bytes) ||
      existing.max_model_calls !== String(command.max_model_calls) ||
      existing.max_run_micros !== command.max_run_micros ||
      existing.currency !== command.currency ||
      existing.tool_manifest_digest !== command.tool_manifest_digest ||
      existing.tool_count !== String(command.tool_count))
  ) {
    throw RELEASE_CONFLICT; // an approved release version is immutable; a new one gets a new id
  }
  if (existing !== undefined) {
    return { created: false };
  }

  const route = await firstRow(tx, SELECT_ROUTE_FULL, [
    command.tenant_id,
    command.model_route_ref,
  ]);
  if (route === undefined) {
    throw RELEASE_MODEL_ROUTE_NOT_FOUND;
  }

  await tx.unsafe(INSERT_RELEASE, [
    command.tenant_id,
    command.id,
    command.resource_id,
    command.version_digest,
    command.runtime_compatibility,
    command.expert_version,
    command.model_route_ref,
    String(command.input_limit_bytes),
    String(command.max_model_calls),
    command.max_run_micros,
    command.currency,
    command.tool_manifest_digest,
    String(command.tool_count),
  ]);
  return { created: true, status: "published" };
}

async function actRunGrant(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "run-grant" }>,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);
  const release = await firstRow(tx, SELECT_RELEASE_FULL, [
    command.tenant_id,
    command.release_id,
  ]);
  if (release === undefined) {
    throw RELEASE_NOT_FOUND;
  }
  await requireActiveMember(tx, command.tenant_id, command.principal_id);

  const existing = await firstRow(tx, SELECT_RUN_GRANT, [
    command.tenant_id,
    command.release_id,
    command.principal_id,
    command.action,
  ]);
  if (existing !== undefined) {
    return { granted: false, revision: existing.revision };
  }
  await tx.unsafe(INSERT_RUN_GRANT, [
    command.tenant_id,
    command.release_id,
    command.principal_id,
    command.action,
  ]);
  return { granted: true, revision: "1" };
}

async function actModelGrant(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "model-grant" }>,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);
  const route = await firstRow(tx, SELECT_ROUTE_FULL, [
    command.tenant_id,
    command.route_id,
  ]);
  if (route === undefined) {
    throw ROUTE_NOT_FOUND;
  }
  await requireActiveMember(tx, command.tenant_id, command.principal_id);

  const existing = await firstRow(tx, SELECT_MODEL_GRANT, [
    command.tenant_id,
    command.route_id,
    command.principal_id,
  ]);
  if (existing !== undefined) {
    return { granted: false, revision: existing.revision };
  }
  await tx.unsafe(INSERT_MODEL_GRANT, [
    command.tenant_id,
    command.route_id,
    command.principal_id,
  ]);
  return { granted: true, revision: "1" };
}

async function actBudgetOpen(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "budget-open" }>,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);

  /* The scope anchor must exist in THIS tenant; the polymorphic scope_ref gets a real check
   * per kind instead of trusting the string. */
  switch (command.scope_kind) {
    case "tenant": {
      if (command.scope_ref !== command.tenant_id) {
        throw INVALID_PROVISION_INPUT;
      }
      break;
    }
    case "workspace": {
      const workspace = await firstRow(tx, SELECT_WORKSPACE, [
        command.tenant_id,
        command.scope_ref,
      ]);
      if (workspace === undefined) {
        throw WORKSPACE_NOT_FOUND;
      }
      break;
    }
    case "expert": {
      const release = await firstRow(tx, SELECT_RELEASE_FULL, [
        command.tenant_id,
        command.scope_ref,
      ]);
      if (release === undefined) {
        throw RELEASE_NOT_FOUND;
      }
      break;
    }
    case "principal": {
      await requireActiveMember(tx, command.tenant_id, command.scope_ref);
      break;
    }
  }

  if (new Date(command.starts_at).getTime() >= new Date(command.ends_at).getTime()) {
    throw PERIOD_INVALID;
  }

  const existing = await firstRow(tx, SELECT_BUDGET_ACCOUNT, [
    command.tenant_id,
    command.scope_kind,
    command.scope_ref,
    command.period_id,
    command.currency,
  ]);
  if (
    existing !== undefined &&
    (existing.limit_micros !== command.limit_micros ||
      new Date(existing.starts_at as unknown as Date).getTime() !==
        new Date(command.starts_at).getTime() ||
      new Date(existing.ends_at as unknown as Date).getTime() !==
        new Date(command.ends_at).getTime())
  ) {
    /* An existing account is never rewritten here: incurred spent/held are the ledger's truth,
     * and a limit adjustment is its own operation with its own stated reason. */
    throw BUDGET_CONFLICT;
  }
  if (existing !== undefined) {
    return { created: false };
  }

  await tx.unsafe(INSERT_BUDGET_ACCOUNT, [
    command.tenant_id,
    command.id,
    command.scope_kind,
    command.scope_ref,
    command.period_id,
    command.starts_at,
    command.ends_at,
    command.currency,
    command.limit_micros,
  ]);
  return { created: true, status: "active", spent_micros: "0", held_micros: "0", overage_micros: "0" };
}

async function actDelegationRegister(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "delegation-register" }>,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, command.tenant_id);
  await requireActiveMember(tx, command.tenant_id, command.principal_id);
  const release = await firstRow(tx, SELECT_RELEASE_FULL, [
    command.tenant_id,
    command.release_id,
  ]);
  if (release === undefined) {
    throw RELEASE_NOT_FOUND;
  }
  const route = await firstRow(tx, SELECT_ROUTE_FULL, [
    command.tenant_id,
    command.route_id,
  ]);
  if (route === undefined) {
    throw ROUTE_NOT_FOUND;
  }
  if (new Date(command.expires_at).getTime() <= Date.now()) {
    /* A pilot delegation that is already expired at registration is not a term. */
    throw DELEGATION_EXPIRED;
  }

  const existing = await firstRow(tx, SELECT_DELEGATION, [
    command.tenant_id,
    command.id,
  ]);
  if (
    existing !== undefined &&
    (existing.principal_id !== command.principal_id ||
      existing.release_id !== command.release_id ||
      existing.route_id !== command.route_id ||
      existing.max_run_micros !== command.max_run_micros ||
      existing.max_runs !== String(command.max_runs) ||
      new Date(existing.expires_at as unknown as Date).getTime() !==
        new Date(command.expires_at).getTime())
  ) {
    throw DELEGATION_CONFLICT;
  }
  if (existing !== undefined) {
    return { created: false };
  }

  await tx.unsafe(INSERT_DELEGATION, [
    command.tenant_id,
    command.id,
    command.principal_id,
    command.release_id,
    command.route_id,
    command.max_run_micros,
    String(command.max_runs),
    command.expires_at,
  ]);
  return { created: true, used_runs: "0" };
}

async function actDisableRelease(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "disable-release" }>,
): Promise<OperationOutcome> {
  const disabled = await tx.unsafe(DISABLE_RELEASE, [
    command.tenant_id,
    command.id,
  ]);
  return { changed: disabled.length > 0 };
}

async function actRevokeRunGrant(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "revoke-run-grant" }>,
): Promise<OperationOutcome> {
  /* Typo protection on the parent: a grant on a release that does not exist is a 404, while an
   * already-absent grant under a REAL release is an audited no-change (02's precedent). */
  const release = await firstRow(tx, SELECT_RELEASE_FULL, [
    command.tenant_id,
    command.release_id,
  ]);
  if (release === undefined) {
    throw RELEASE_NOT_FOUND;
  }
  const deleted = await tx.unsafe(DELETE_RUN_GRANT, [
    command.tenant_id,
    command.release_id,
    command.principal_id,
    command.action,
  ]);
  return { revoked: deleted.length > 0 };
}

async function actDisableRoute(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "disable-route" }>,
): Promise<OperationOutcome> {
  const updated = await tx.unsafe<{ revision: string }[]>(DISABLE_ROUTE, [
    command.tenant_id,
    command.id,
  ]);
  if (updated.length === 0) {
    return { changed: false };
  }
  return { changed: true, revision: updated[0].revision };
}

async function actRevokeModelGrant(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "revoke-model-grant" }>,
): Promise<OperationOutcome> {
  const route = await firstRow(tx, SELECT_ROUTE_FULL, [
    command.tenant_id,
    command.route_id,
  ]);
  if (route === undefined) {
    throw ROUTE_NOT_FOUND;
  }
  const updated = await tx.unsafe<{ revision: string }[]>(REVOKE_MODEL_GRANT, [
    command.tenant_id,
    command.route_id,
    command.principal_id,
  ]);
  if (updated.length === 0) {
    return { changed: false };
  }
  return { changed: true, revision: updated[0].revision };
}

async function actRevokeDelegation(
  tx: TxClient,
  command: Extract<RunProvisionCommand, { mode: "revoke-delegation" }>,
): Promise<OperationOutcome> {
  const updated = await tx.unsafe<{ revision: string }[]>(REVOKE_DELEGATION, [
    command.tenant_id,
    command.id,
  ]);
  if (updated.length === 0) {
    return { changed: false };
  }
  return { changed: true, revision: updated[0].revision };
}

async function act(
  tx: TxClient,
  command: RunProvisionCommand,
  targets: TargetRegistry,
): Promise<OperationOutcome> {
  switch (command.mode) {
    case "route-register":
      return actRouteRegister(tx, command, targets);
    case "release-register":
      return actReleaseRegister(tx, command);
    case "run-grant":
      return actRunGrant(tx, command);
    case "model-grant":
      return actModelGrant(tx, command);
    case "budget-open":
      return actBudgetOpen(tx, command);
    case "delegation-register":
      return actDelegationRegister(tx, command);
    case "disable-release":
      return actDisableRelease(tx, command);
    case "revoke-run-grant":
      return actRevokeRunGrant(tx, command);
    case "disable-route":
      return actDisableRoute(tx, command);
    case "revoke-model-grant":
      return actRevokeModelGrant(tx, command);
    case "revoke-delegation":
      return actRevokeDelegation(tx, command);
  }
}

/* ---------------------------------------------------------------------------
 * The one entry: strict parse → locks → idempotency anchor → write → audit.
 * ------------------------------------------------------------------------ */

export async function applyRunProvision(
  tx: Tx,
  command: RunProvisionCommand,
  deps: RunProvisionDeps = {},
): Promise<void> {
  const parsed = RunProvisionCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw INVALID_PROVISION_INPUT;
  }
  const input = parsed.data;
  const targets = deps.targets ?? defaultTargetRegistry();
  const hooks = deps.hooks ?? {};
  const kind = AUDIT_KINDS[input.mode];
  const digest = payloadDigest(kind, digestPayload(input));

  /* The RLS context follows the command's tenant, exactly as 02's provision does — the
   * operator login sees only the tenant it is provisioning. */
  await setTenantContext(tx, input.tenant_id);
  await lockFor(tx, input);

  const prior = await readStoredEvent(tx, input.tenant_id, input.operation_id);
  if (prior !== undefined) {
    if (prior.kind !== kind || prior.details.payload_digest !== digest) {
      throw IDEMPOTENCY_CONFLICT;
    }
    /* The exact operation already landed: write nothing. A release disabled since, or a
     * grant revoked since, is NOT restored by a replay. */
    return;
  }

  const result = await act(tx, input, targets);
  await hooks.beforeAudit?.();
  await appendEvent(
    tx,
    input.tenant_id,
    input.operation_id,
    input.operator,
    kind,
    digest,
    result,
  );
}
