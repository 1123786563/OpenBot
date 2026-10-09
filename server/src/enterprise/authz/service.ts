/**
 * The local TypeScript authorization service, per plan 02 §6 T2-C.
 *
 * `createAuthz` is the only authorization engine: a deterministic rule map shipped with the
 * application. It makes no HTTP call, reads no environment variable, keeps no second copy of any
 * ACL and never caches a positive decision — every check re-evaluates the resource facts the
 * ResourceReader read inside the same transaction. `Authz.check` stays a Promise so the call
 * contract survives, but the resolution is local and synchronous underneath.
 *
 * MVP rules: only the `read` action, only an explicit resource grant. A tenant_admin, an auditor or
 * a deployment admin never skips the grant — membership roles feed explicit administrative-domain
 * rules only, never implicit content access. Booleans are compared to `true`, never coerced, and a
 * scope this process did not issue fails closed in `assertScope` before any rule runs.
 *
 * `policyRules` is the deterministic revision → rule map shipped with the build. It starts with
 * exactly tenancy-v1; SUPPORTED_POLICY_REVISIONS is its frozen read-only derivation, so a new
 * revision cannot be appended at runtime — it takes an independent function, its own tests, and a
 * build that implements old and new rules together before any tenant's policy_revision switches
 * inside its exclusive lock. An unknown revision is a closed POLICY_REVISION_UNSUPPORTED (503), an
 * identifier of authorization unavailability, never a silent allow.
 */
import type { AuthorizationInput, Authz } from "../contracts";
import { EnterpriseError } from "../errors";
import { assertScope } from "../tenancy/scope";

type LocalRule = (input: AuthorizationInput) => boolean;

/*
 * tenancy-v1: a same-tenant read of an active resource the transaction's own grant query marked
 * allowed. Every comparison is an identity check against the literal — a truthy string, a non-one
 * number or a missing value can never satisfy it.
 */
const tenancyV1: LocalRule = ({ scope, resource, action }) =>
  action === "read" &&
  scope.tenantId === resource.tenantId &&
  resource.active === true &&
  resource.locallyAllowed === true;

const policyRules: ReadonlyMap<string, LocalRule> = new Map<string, LocalRule>([
  ["tenancy-v1", tenancyV1],
]);

export const SUPPORTED_POLICY_REVISIONS: readonly string[] = Object.freeze([
  ...policyRules.keys(),
]);

export function createAuthz(): Authz {
  return {
    async check({ scope, resource, action }) {
      assertScope(scope);
      /* Default deny first: anything not an exact same-tenant active granted read is false. */
      if (
        action !== "read" ||
        scope.tenantId !== resource.tenantId ||
        resource.active !== true ||
        resource.locallyAllowed !== true
      ) {
        return false;
      }
      /*
       * Authorization state the rules cannot judge: a non-positive revision or ACL epoch is a
       * corrupted fact, and answering either way on it would be a decision made on garbage. This
       * is the same closed 503 the ResourceReader raises for an unparsable row.
       */
      if (
        !Number.isSafeInteger(resource.revision) ||
        resource.revision < 1 ||
        !Number.isSafeInteger(resource.aclEpoch) ||
        resource.aclEpoch < 1
      ) {
        throw new EnterpriseError("AUTHORIZATION_STATE_INVALID", 503);
      }
      const rule = policyRules.get(resource.policyRevision);
      if (!rule) {
        throw new EnterpriseError("POLICY_REVISION_UNSUPPORTED", 503);
      }
      return rule({ scope, resource, action });
    },
  };
}
