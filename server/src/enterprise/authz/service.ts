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
        // action 在类型层是字面量 "read"；运行时复查为纵深防御。
        action !== "read" ||
        resource.active !== true ||
        resource.locallyAllowed !== true ||
        // Isolation boundary must fail closed on empty identity values.
        !scope.tenantId ||
        !scope.workspaceId ||
        !scope.principalId ||
        !resource.tenantId ||
        !resource.workspaceId ||
        !resource.principalId ||
        // principalId equality is defense-in-depth: the only facts producer
        // (tenancy/store.ts) copies it from scope. Keep in sync with
        // tenancy/resource-policy.ts tenancy-v1.
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
