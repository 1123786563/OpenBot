/**
 * Model-use admission, per plan 03 §8.1 (with §4.3's assertStart checks for the
 * model slice).
 *
 * `assertModelUseInTx` runs inside the caller's transaction on EVERY new model
 * call: the route must exist in the caller's tenant, still be active, and the
 * principal must hold an ACTIVE model grant for exactly that route. A run
 * presents the route id it pinned at creation — admission never re-resolves an
 * alias, so switching an alias's default cannot move an existing run onto a
 * new target, and disabling the pinned route refuses the run's new calls.
 *
 * Refusals are named: an unknown/cross-tenant route is the same 404 (the
 * caller cannot distinguish configuration from existence), a disabled route is
 * 403 MODEL_ROUTE_DISABLED, a missing or revoked grant is 403
 * MODEL_GRANT_REQUIRED. Statement texts are module constants; values travel
 * only as parameters.
 *
 * Lock discipline: the caller owns the §4.3 fixed lock order (this module only
 * reads, inside the transaction the caller already scoped with withTenant).
 */
import type { Scope, Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import { firstRow } from "../tenancy/transaction";
import { ID } from "./contracts";

const SELECT_ROUTE_STATUS = `
  select status
  from enterprise_model_routes
  where tenant_id = $1 and id = $2`;

const SELECT_ACTIVE_GRANT = `
  select 1
  from enterprise_model_grants
  where tenant_id = $1 and route_id = $2 and principal_id = $3
    and status = 'active'`;

/**
 * Asserts the current principal may start a NEW model call on the route, in
 * the caller's transaction. `routeId` is the route the run pinned at creation
 * (or the route a resolution just returned) — never a client-supplied target,
 * and never an alias.
 */
export async function assertModelUseInTx(
  tx: Tx,
  scope: Scope,
  routeId: string,
): Promise<void> {
  if (!ID.safeParse(routeId).success) {
    throw new EnterpriseError("INVALID_MODEL_ROUTE_ID", 400);
  }
  const route = await firstRow(tx, SELECT_ROUTE_STATUS, [
    scope.tenantId,
    routeId,
  ]);
  if (route === undefined) {
    throw new EnterpriseError("MODEL_ROUTE_NOT_FOUND", 404);
  }
  if (route.status !== "active") {
    throw new EnterpriseError("MODEL_ROUTE_DISABLED", 403);
  }
  const grant = await firstRow(tx, SELECT_ACTIVE_GRANT, [
    scope.tenantId,
    routeId,
    scope.principalId,
  ]);
  if (grant === undefined) {
    throw new EnterpriseError("MODEL_GRANT_REQUIRED", 403);
  }
}
