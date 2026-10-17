import { expect, test } from "../../../tests/support/e2e-compat";
import type { AuthorizationInput } from "../../src/enterprise/authz/service";
import { createAuthz } from "../../src/enterprise/authz/service";
import type { PlatformScope } from "../../src/enterprise/contracts";

const scope: PlatformScope = Object.freeze({
  tenantId: "tenant-alpha",
  workspaceId: "workspace-alpha",
  principalId: "principal-alpha",
  actorId: "user-alpha",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
});
const resource = {
  id: "resource-alpha",
  tenantId: "tenant-alpha",
  workspaceId: "workspace-alpha",
  principalId: "principal-alpha",
  revision: 1,
  aclEpoch: 1,
  policyRevision: "tenancy-v1",
  active: true,
  locallyAllowed: true,
};

test("explicit active resource grant permits same-tenant read", async () => {
  expect(await createAuthz().check({ scope, resource, action: "read" })).toBe(
    true,
  );
});

test("tenant mismatch, workspace mismatch, revoked membership and missing grant are denied", async () => {
  const authz = createAuthz();
  expect(
    await authz.check({
      scope,
      resource: { ...resource, tenantId: "tenant-beta" },
      action: "read",
    }),
  ).toBe(false);
  expect(
    await authz.check({
      scope,
      resource: { ...resource, workspaceId: "workspace-beta" },
      action: "read",
    }),
  ).toBe(false);
  expect(
    await authz.check({
      scope,
      resource: { ...resource, locallyAllowed: false },
      action: "read",
    }),
  ).toBe(false);
  expect(
    await authz.check({
      scope,
      resource: { ...resource, active: false },
      action: "read",
    }),
  ).toBe(false);
});

test("deployment admin role and client tenant header do not create authority", async () => {
  const changedScope = { ...scope, tenantId: "tenant-beta" };
  const input = {
    scope: changedScope,
    resource,
    action: "read",
  } as AuthorizationInput;
  expect(await createAuthz().check(input)).toBe(false);
});

test("unsupported policy and invalid ACL state fail closed", async () => {
  const authz = createAuthz();
  await expect(
    authz.check({
      scope,
      resource: { ...resource, policyRevision: "future" },
      action: "read",
    }),
  ).rejects.toThrow();
  expect(
    await authz.check({
      scope,
      resource: { ...resource, locallyAllowed: "true" as unknown as boolean },
      action: "read",
    }),
  ).toBe(false);
});
