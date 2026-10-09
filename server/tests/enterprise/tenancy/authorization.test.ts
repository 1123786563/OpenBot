import { describe, expect, test } from "bun:test";
import {
  createAuthz,
  SUPPORTED_POLICY_REVISIONS,
} from "../../../src/enterprise/authz/service";
import type {
  AuthorizationInput,
  Membership,
} from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";

/*
 * The local authorization rules, per plan 02 §6 T2-C steps 1 and 4.
 *
 * These are unit cases: the Directory and the resource snapshot are local fixtures, so they prove
 * the RULES — an explicit same-tenant ACL grants read, nobody (tenant_admin included) bypasses a
 * missing ACL, other tenants and deleted resources are denied, and only a scope this process
 * actually issued is trusted. The real revocation behaviour (membership epoch, grant removal,
 * unknown policy revision on a live database) is proven against the live database in
 * repository.test.ts using the same createAuthz().
 *
 * The error contract is asserted on `code` and `status`, never on message text alone: §4.3 makes
 * the code the contract and the message deliberately just the code. Only the negative cases
 * simulate illegal shapes with `as unknown as` — production code never casts past input validation.
 */

const member: Membership = {
  tenantId: "a",
  principalId: "p",
  tenantName: "A",
  role: "tenant_admin",
  epoch: 1,
  tenantStatus: "active",
  principalStatus: "active",
  memberStatus: "active",
};

/*
 * The positive fixture: a tenant_admin scope plus an explicitly granted, active resource. The admin
 * role is deliberate — the tests below prove the strongest role still needs the explicit ACL.
 */
async function authorizedInput(): Promise<AuthorizationInput> {
  const scope = await resolveScope(
    { listForUser: async () => [member] },
    "u",
    "a",
  );
  return {
    scope,
    action: "read",
    resource: {
      id: "r",
      tenantId: "a",
      workspaceId: "w",
      kind: "document",
      revision: 1,
      aclEpoch: 1,
      policyRevision: "tenancy-v1",
      active: true,
      locallyAllowed: true,
    },
  };
}

/** Captures the EnterpriseError a rejected call throws, failing the test on any other outcome. */
async function enterpriseErrorOf(
  run: () => Promise<unknown>,
): Promise<EnterpriseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return error;
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

describe("plan 02 §6 T2-C step 1: explicit grants, no bypasses, default deny", () => {
  test("explicit ACL permits a valid same-tenant read", async () => {
    expect(await createAuthz().check(await authorizedInput())).toBe(true);
  });

  test("tenant admin cannot bypass a missing ACL", async () => {
    const input = await authorizedInput();
    input.resource.locallyAllowed = false;
    expect(await createAuthz().check(input)).toBe(false);
  });

  test("other tenants and deleted resources are denied", async () => {
    const input = await authorizedInput();
    expect(
      await createAuthz().check({
        ...input,
        resource: { ...input.resource, tenantId: "b" },
      }),
    ).toBe(false);
    expect(
      await createAuthz().check({
        ...input,
        resource: { ...input.resource, active: false },
      }),
    ).toBe(false);
  });

  test("a copied scope is no longer trusted", async () => {
    const input = await authorizedInput();
    const error = await enterpriseErrorOf(() =>
      createAuthz().check({ ...input, scope: { ...input.scope } }),
    );
    expect(error.code).toBe("UNVERIFIED_SCOPE");
    expect(error.status).toBe(403);
  });

  test("unsupported action cannot inherit read permission", async () => {
    const input = await authorizedInput();
    const malformed = {
      ...input,
      action: "write",
    } as unknown as AuthorizationInput;
    expect(await createAuthz().check(malformed)).toBe(false);
  });

  test("unknown policy revision is unavailable, not allowed", async () => {
    const input = await authorizedInput();
    input.resource.policyRevision = "unrecognized-revision";
    const error = await enterpriseErrorOf(() => createAuthz().check(input));
    expect(error.code).toBe("POLICY_REVISION_UNSUPPORTED");
    expect(error.status).toBe(503);
  });
});

describe("plan 02 §6 T2-C step 4: strict booleans, no JavaScript truthiness", () => {
  test("truthy strings cannot grant access", async () => {
    const input = await authorizedInput();
    const malformed = {
      ...input,
      resource: { ...input.resource, locallyAllowed: "true" },
    } as unknown as AuthorizationInput;
    expect(await createAuthz().check(malformed)).toBe(false);
  });

  test("invalid ACL epoch is not a successful decision", async () => {
    const input = await authorizedInput();
    input.resource.aclEpoch = 0;
    const error = await enterpriseErrorOf(() => createAuthz().check(input));
    expect(error.code).toBe("AUTHORIZATION_STATE_INVALID");
    expect(error.status).toBe(503);
  });
});

describe("plan 02 §6 T2-C step 3: the shipped policy surface is frozen and derived", () => {
  test("supported policy revisions are a read-only derivation of the rules", () => {
    expect(SUPPORTED_POLICY_REVISIONS).toEqual(["tenancy-v1"]);
    expect(Object.isFrozen(SUPPORTED_POLICY_REVISIONS)).toBe(true);
    expect(() =>
      (SUPPORTED_POLICY_REVISIONS as string[]).push("tenancy-v2"),
    ).toThrow();
  });
});
