/**
 * The single-transaction authorized resource read, per plan 02 §6 T2-B step 5.
 *
 * `createResourceReader` is the only public read path. `readAuthorizedResource` runs inside ONE
 * READ COMMITTED `withTenant` transaction — membership epoch re-check, resource shared advisory
 * lock, live resource fact (grant included, same statement), local Authz, bare ResourceView — and
 * never exposes an intermediate snapshot or a two-phase read. A missing resource, a deleted
 * resource and a resource without a read grant are the same 404: the caller cannot distinguish
 * them, and the local Authz is never consulted without an active, locally granted resource.
 *
 * Statement texts are module constants with `$n` placeholders; values travel only as parameters.
 * The row is parsed with a strict Zod schema inside the lock — never `as`-cast — and a shape that
 * does not match the contract is a closed AUTHORIZATION_STATE_INVALID, not a best-effort answer.
 */
import { z } from "zod";
import type { Database } from "../../db/client";
import type {
  Authz,
  ResourceReader,
  ResourceSnapshot,
  Scope,
} from "../contracts";
import { EnterpriseError } from "../errors";
import {
  lockKey,
  lockShared,
  type TxClient,
  withTenant,
} from "../tenancy/transaction";

const SELECT_RESOURCE = `
  select r.id as id,
         r.tenant_id as "tenantId",
         r.workspace_id as "workspaceId",
         r.kind as kind,
         r.revision as revision,
         r.acl_epoch as "aclEpoch",
         t.policy_revision as "policyRevision",
         (r.status = 'active') as active,
         exists(select 1 from enterprise_resource_grants g
                where g.tenant_id = r.tenant_id and g.resource_id = r.id
                  and g.principal_id = $3 and g.action = 'read') as "locallyAllowed"
  from enterprise_resources r
  join enterprise_tenants t on t.id = r.tenant_id
  where r.tenant_id = $1 and r.id = $2`;

/** The DB fact shape, checked inside the lock; exactly the contract's ResourceSnapshot. */
const ResourceSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    workspaceId: z.string(),
    kind: z.string(),
    revision: z.number().int().positive(),
    aclEpoch: z.number().int().positive(),
    policyRevision: z.string(),
    active: z.boolean(),
    locallyAllowed: z.boolean(),
  })
  .strict();

/**
 * The one fixed parameterized statement of this module: the resource row joined with its tenant's
 * policy revision and the current principal's read grant, all in one READ COMMITTED statement.
 * Returns raw rows — validation happens in `parseResource` inside the lock, never an `as` cast.
 * Private on purpose — callers go through `readAuthorizedResource`, never a raw row.
 */
async function readResourceRows(
  tx: TxClient,
  scope: Scope,
  resourceId: string,
): Promise<Record<string, unknown>[]> {
  return tx.unsafe<Record<string, unknown>[]>(SELECT_RESOURCE, [
    scope.tenantId,
    resourceId,
    scope.principalId,
  ]);
}

/** Parses one raw row inside the lock; a wrong shape is a closed 503, never a raw DB result. */
function parseResource(row: Record<string, unknown> | undefined) {
  if (row === undefined) {
    return null;
  }
  const parsed = ResourceSchema.safeParse(row);
  if (!parsed.success) {
    throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
  }
  return parsed.data;
}

export function createResourceReader(
  database: Database,
  authz: Authz,
): ResourceReader {
  return {
    readAuthorizedResource: (scope: Scope, resourceId: string) =>
      withTenant(database, scope, async (tx) => {
        await lockShared(tx, lockKey("resource", scope.tenantId, resourceId));
        const rows = await readResourceRows(tx, scope, resourceId);
        const resource: ResourceSnapshot | null = parseResource(rows[0]);
        if (!resource?.active || !resource.locallyAllowed) {
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        if (!(await authz.check({ scope, resource, action: "read" }))) {
          throw new EnterpriseError("RESOURCE_NOT_FOUND", 404);
        }
        return {
          id: resource.id,
          workspaceId: resource.workspaceId,
          kind: resource.kind,
          revision: resource.revision,
        };
      }),
  };
}
