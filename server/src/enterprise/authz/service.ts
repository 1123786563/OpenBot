import type { PlatformScope } from "../contracts";

export interface AuthorizedResourceFacts {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly revision: number;
  readonly aclEpoch: number;
  readonly policyRevision: string;
  readonly active: boolean;
  readonly locallyAllowed: boolean;
}

export interface AuthorizationInput {
  readonly scope: PlatformScope;
  readonly resource: AuthorizedResourceFacts;
  readonly action: "read";
}

export interface Authz {
  check(input: AuthorizationInput): Promise<boolean>;
}

export const SUPPORTED_POLICY_REVISIONS: readonly string[] = Object.freeze([
  "tenancy-v1",
]);

/** Local, deterministic resource-read policy. Roles never imply content access. */
export function createAuthz(): Authz {
  return {
    async check({ scope, resource, action }) {
      if (
        action !== "read" ||
        resource.active !== true ||
        resource.locallyAllowed !== true ||
        scope.tenantId !== resource.tenantId ||
        scope.workspaceId !== resource.workspaceId ||
        scope.principalId !== resource.principalId
      ) {
        return false;
      }
      if (
        !Number.isSafeInteger(resource.revision) ||
        resource.revision < 1 ||
        !Number.isSafeInteger(resource.aclEpoch) ||
        resource.aclEpoch < 1
      ) {
        return false;
      }
      if (!SUPPORTED_POLICY_REVISIONS.includes(resource.policyRevision)) {
        throw new Error("POLICY_REVISION_UNSUPPORTED");
      }
      return true;
    },
  };
}
