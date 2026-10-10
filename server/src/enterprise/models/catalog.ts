/**
 * The model route catalog, per plan 03 §8.1.
 *
 * `resolveRouteInTx` runs inside the caller's transaction (the run-creation
 * transaction for E1-C): it resolves the business `model_alias` to the ONE
 * approved route revision — the alias's single active default version, kept
 * unique per (tenant, alias) by the `enterprise_route_alias_default` partial
 * unique index in the custom migration — and the run then pins that route id
 * forever. Switching an alias's default later changes only NEW resolutions;
 * nothing here ever rewrites an existing run's stored reference.
 *
 * The resolved value is checked against the deployment `TargetRegistry`
 * before it leaves the function: a route whose target reference the registry
 * does not know has no dialable target and refuses. The endpoint itself is
 * never read here — target resolution is E4-C's proxy concern, and this file
 * is the admission boundary that keeps user input away from it (a caller
 * contributes an alias, never a target, endpoint or credential).
 *
 * Statement texts are module constants with `$n` placeholders; values travel
 * only as parameters. The row is parsed with the strict contract schema —
 * never `as`-cast — and a shape that does not match is a closed
 * MODEL_ROUTE_STATE_INVALID, not a best-effort answer.
 */
import type { Scope, Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import { firstRow } from "../tenancy/transaction";
import {
  ID,
  type ModelRoute,
  ModelRouteSchema,
  type TargetRegistry,
} from "./contracts";

/**
 * The alias's approved revision: the active default only. Disabled routes and
 * non-default revisions are invisible to a new resolution — "the same"
 * MODEL_ROUTE_NOT_FOUND answers an unknown alias, a disabled route and a
 * tenant that has no such alias at all, so the caller cannot enumerate
 * operator configuration by probing error codes.
 */
const SELECT_DEFAULT_ROUTE = `
  select tenant_id, id, alias, revision, resource_id, target_ref,
         price_revision, currency, input_unit_micros, output_unit_micros,
         per_request_micros, max_input_tokens, max_output_tokens,
         max_request_bytes, protocol_profile, usage_profile,
         is_default_for_alias, status, created_at
  from enterprise_model_routes
  where tenant_id = $1 and alias = $2
    and status = 'active' and is_default_for_alias = true`;

/** bigint columns arrive as strings on the raw client; decimal strings only. */
function decimal(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new EnterpriseError("MODEL_ROUTE_STATE_INVALID", 503);
  }
  return text;
}

/** Parses one raw row inside the caller's transaction; no `as` casts. */
function parseRouteRow(row: Record<string, unknown>): ModelRoute {
  const parsed = ModelRouteSchema.safeParse({
    tenant_id: row.tenant_id,
    id: row.id,
    alias: row.alias,
    revision: decimal(row.revision),
    resource_id: row.resource_id,
    target_ref: row.target_ref,
    price_revision: decimal(row.price_revision),
    currency: row.currency,
    input_unit_micros: decimal(row.input_unit_micros),
    output_unit_micros: decimal(row.output_unit_micros),
    per_request_micros: decimal(row.per_request_micros),
    max_input_tokens: decimal(row.max_input_tokens),
    max_output_tokens: decimal(row.max_output_tokens),
    max_request_bytes: decimal(row.max_request_bytes),
    protocol_profile: row.protocol_profile,
    usage_profile: row.usage_profile,
    is_default_for_alias: row.is_default_for_alias,
    status: row.status,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  });
  if (!parsed.success) {
    throw new EnterpriseError("MODEL_ROUTE_STATE_INVALID", 503);
  }
  return parsed.data;
}

/**
 * Resolves the alias to the pinned route for a NEW run, inside the caller's
 * transaction. The scope is the trusted caller's — this module never derives
 * tenancy from a parameter other than the scope, and the alias is validated
 * against the shared ID shape before it reaches a statement.
 */
export async function resolveRouteInTx(
  tx: Tx,
  scope: Scope,
  alias: string,
  targets: TargetRegistry,
): Promise<ModelRoute> {
  if (!ID.safeParse(alias).success) {
    throw new EnterpriseError("INVALID_MODEL_ALIAS", 400);
  }
  const row = await firstRow(tx, SELECT_DEFAULT_ROUTE, [scope.tenantId, alias]);
  if (row === undefined) {
    throw new EnterpriseError("MODEL_ROUTE_NOT_FOUND", 404);
  }
  const route = parseRouteRow(row);
  if (!targets.has(route.target_ref)) {
    throw new EnterpriseError("MODEL_TARGET_UNKNOWN", 503);
  }
  return route;
}
