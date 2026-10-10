/**
 * Model-route data contracts, per plan 03 §8.1.
 *
 * `ModelRoute` is the §4.1 approved route row as a STRICT schema plus the one
 * thing the row cannot carry by itself: the deployment-registry target
 * reference. The reference is an operator-owned registry KEY — the endpoint it
 * names and its credentials live in the registry and are resolved only inside
 * the TS model proxy/Higress (E4-C), never here. A route object therefore has
 * no `endpoint`, `headers` or `credential_ref` field, and the strict parse
 * makes an attempt to smuggle one in a refusal rather than a trim.
 *
 * What a consumer other than the run ledger ever sees is `routeRefOf`'s
 * projection: the route reference alone. Go holds that reference (and nothing
 * else) for the life of the run it was pinned into.
 *
 * Money, token ceilings and revisions travel as the shared `Decimal`
 * strings — bigint values never round-trip through a JS number.
 */

import { z } from "zod";

/*
 * The shared run-contracts `ID`/`Decimal` shapes, re-declared natively for this
 * module: server code resolves zod v4 while `shared/` resolves v3, and a v3
 * schema cannot nest inside a v4 object. The patterns are the shared ones,
 * byte for byte — the tests pin both sides to the same refusals.
 */
export const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const Decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

/**
 * A deployment-registry target key: bounded, no spaces, no scheme — it names
 * an entry the operator loaded from deployment config, it never IS a URL.
 * A user-supplied URI can therefore never become a target through this shape.
 */
const TargetRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,127}$/);

/**
 * The approved route row (§4.1 models domain), strict: unknown keys refuse.
 * `status` admits a disabled row only so the catalog/policy can name the
 * refusal precisely — resolution and admission both reject non-active rows.
 */
export const ModelRouteSchema = z
  .object({
    tenant_id: ID,
    id: ID,
    alias: ID,
    revision: Decimal,
    resource_id: ID,
    target_ref: TargetRef,
    price_revision: Decimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    input_unit_micros: Decimal,
    output_unit_micros: Decimal,
    per_request_micros: Decimal,
    max_input_tokens: Decimal,
    max_output_tokens: Decimal,
    max_request_bytes: Decimal,
    protocol_profile: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    usage_profile: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    is_default_for_alias: z.boolean(),
    status: z.enum(["active", "disabled"]),
    created_at: z.iso.datetime(),
  })
  .strict();
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

/** The only model identity an execution component ever holds: the route ref. */
export const ModelRouteRefViewSchema = z.object({ route_ref: ID }).strict();
export type ModelRouteRefView = z.infer<typeof ModelRouteRefViewSchema>;

/** Projects a resolved route down to what Go may see: the reference, nothing else. */
export function routeRefOf(route: ModelRoute): ModelRouteRefView {
  return ModelRouteRefViewSchema.parse({ route_ref: route.id });
}

/**
 * The deployment registry seam: answers whether an operator-approved upstream
 * target reference exists. Implementations load from deployment config; the
 * proxy (E4-C) resolves the actual endpoint and credentials from the same
 * registry, which this contract deliberately cannot express.
 */
export interface TargetRegistry {
  has(targetRef: string): boolean;
}

/**
 * A fixed-reference registry for tests and for deployments whose approved
 * targets are static config. A reference that does not even match the
 * registry-key shape never answers yes, whatever the configured list holds.
 */
export function createStaticTargetRegistry(
  refs: readonly string[],
): TargetRegistry {
  const known = new Set(refs);
  return {
    has: (targetRef: string) =>
      TargetRef.safeParse(targetRef).success && known.has(targetRef),
  };
}

/**
 * The deployment registry loaded from the operator's approved target list: the
 * comma-separated `ENTERPRISE_MODEL_TARGETS` environment value, the same source
 * the offline provision CLI reads. An unset or empty list answers NO to
 * everything — a deployment without mapped targets refuses every resolution and
 * registration closed, never waves a route through to an unmapped target.
 */
export function createEnvTargetRegistry(raw?: string): TargetRegistry {
  const source = raw ?? process.env.ENTERPRISE_MODEL_TARGETS ?? "";
  const refs = source
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  return createStaticTargetRegistry(refs);
}
