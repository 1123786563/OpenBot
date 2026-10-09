import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getTableName, like } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../src/db/schema";
import { users } from "../../src/db/schema/core";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  provisionDeployment,
  revokeResourceRead,
  suspendMembership,
} from "../../src/enterprise/tenancy/provision";
import {
  createResourceReader,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const prefix = `enterprise-r2-${randomUUID()}`;
let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;

function setupDb() {
  setupDatabase ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 2 });
  return setupDatabase;
}
async function directoryDb() {
  if (!directoryDatabase) {
    const candidate = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("directory"),
      { max: 2 },
    );
    try {
      directoryDatabase = await verifyDirectoryDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return directoryDatabase;
}
async function dataDb() {
  if (!dataDatabase) {
    const candidate = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
      max: 2,
    });
    try {
      dataDatabase = await verifyDataDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return dataDatabase;
}
async function operatorDb() {
  if (!operatorDatabase) {
    const candidate = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("operator"),
      { max: 2 },
    );
    try {
      operatorDatabase = await verifyOperatorDatabase(candidate);
    } catch (error) {
      await candidate.$client.close();
      throw error;
    }
  }
  return operatorDatabase;
}

async function closeDatabase(database: Database | undefined) {
  await database?.$client.close();
}

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    if (setupDatabase) {
      await setupDatabase
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseResourceGrants)
        .where(like(enterpriseResourceGrants.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseResources)
        .where(like(enterpriseResources.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${prefix}%`));
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    }
  } catch (error) {
    failures.push(error);
  }
  const closes = await Promise.allSettled([
    closeDatabase(operatorDatabase),
    closeDatabase(dataDatabase),
    closeDatabase(directoryDatabase),
    closeDatabase(setupDatabase),
  ]);
  failures.push(
    ...closes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  );
  if (failures.length) {
    throw new AggregateError(
      failures,
      "Enterprise test fixture cleanup failed.",
    );
  }
});

test("enterprise tenancy tables are registered", () => {
  expect(getTableName(enterpriseTenants)).toBe("enterprise_tenants");
  expect(getTableName(enterpriseMemberships)).toBe("enterprise_memberships");
  expect(getTableName(enterpriseWorkspaces)).toBe("enterprise_workspaces");
  expect(getTableName(enterpriseResources)).toBe("enterprise_resources");
  expect(getTableName(enterpriseResourceGrants)).toBe(
    "enterprise_resource_grants",
  );
});

test("directory, data, and offline operator connections enforce tenant access", async () => {
  const setup = setupDb();
  const directory = await directoryDb();
  const data = await dataDb();
  const operator = await operatorDb();
  const tenantA = `${prefix}-a`;
  const tenantB = `${prefix}-b`;
  const userA = `${prefix}-user-a`;
  const userB = `${prefix}-user-b`;
  const principalA = `${prefix}-principal-a`;
  const principalB = `${prefix}-principal-b`;
  const workspaceA = `${prefix}-workspace-a`;
  const workspaceB = `${prefix}-workspace-b`;
  const resourceA = `${prefix}-resource-a`;
  const resourceB = `${prefix}-resource-b`;
  const noGrantResource = `${prefix}-resource-no-grant`;
  const revocationResource = `${prefix}-resource-revocation-sentinel`;

  await setup.insert(users).values([
    { id: userA, email: `${userA}@example.invalid`, name: "Synthetic A" },
    { id: userB, email: `${userB}@example.invalid`, name: "Synthetic B" },
  ]);
  await setup.insert(enterprisePrincipals).values([
    { id: principalA, userId: userA },
    { id: principalB, userId: userB },
  ]);

  await provisionDeployment(operator, {
    operationId: `${prefix}-provision-a`,
    operator: principalA,
    tenant: { id: tenantA, name: "Synthetic tenant A" },
    workspace: { id: workspaceA, name: "Workspace A" },
    members: [{ principalId: principalA, userId: userA, role: "tenant_admin" }],
    resources: [
      {
        id: resourceA,
        kind: "document",
        displayName: "Synthetic resource A",
        readers: [principalA],
      },
      {
        id: noGrantResource,
        kind: "document",
        displayName: "Synthetic resource without grant",
        readers: [],
      },
      {
        id: revocationResource,
        kind: "document",
        displayName: "Synthetic revocation resource",
        readers: [principalA],
      },
    ],
  });
  await provisionDeployment(operator, {
    operationId: `${prefix}-provision-b`,
    operator: principalB,
    tenant: { id: tenantB, name: "Synthetic tenant B" },
    workspace: { id: workspaceB, name: "Workspace B" },
    members: [{ principalId: principalB, userId: userB, role: "member" }],
    resources: [
      {
        id: resourceB,
        kind: "document",
        displayName: "Synthetic resource B",
        readers: [principalB],
      },
    ],
  });

  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const actorId = authenticated.get(request);
      return actorId ? { actorId, entrypoint: "web" } : null;
    },
    selectTenant: (request) => request.headers.get("x-enterprise-tenant"),
    selectWorkspace: (request) => request.headers.get("x-enterprise-workspace"),
  });
  const requestFor = (
    actorId: string,
    tenantId: string,
    workspaceId: string,
  ) => {
    const request = new Request("https://enterprise.example.invalid/resource", {
      headers: {
        "x-enterprise-tenant": tenantId,
        "x-enterprise-workspace": workspaceId,
      },
    });
    authenticated.set(request, actorId);
    return request;
  };
  const scopeA = await resolver.resolve(requestFor(userA, tenantA, workspaceA));
  const reader = createResourceReader(data);
  expect(await reader.readAuthorizedResource(scopeA, resourceA)).toMatchObject({
    resourceId: resourceA,
    resourceType: "document",
    displayName: "Synthetic resource A",
  });

  await expect(
    resolver.resolve(requestFor(userA, tenantB, workspaceB)),
  ).rejects.toThrow("TENANT_FORBIDDEN");
  await expect(
    reader.readAuthorizedResource(scopeA, resourceB),
  ).rejects.toThrow("RESOURCE_NOT_FOUND");
  await expect(
    reader.readAuthorizedResource(scopeA, noGrantResource),
  ).rejects.toThrow("RESOURCE_NOT_FOUND");
  await setup.insert(users).values({
    id: `${prefix}-deployment-admin`,
    email: `${prefix}-deployment-admin@example.invalid`,
    name: "Synthetic deployment admin",
  });
  const adminRequest = requestFor(
    `${prefix}-deployment-admin`,
    tenantA,
    workspaceA,
  );
  await expect(resolver.resolve(adminRequest)).rejects.toThrow(
    "TENANT_FORBIDDEN",
  );

  const aclRevocation = await revokeResourceRead(operator, {
    operationId: `${prefix}-revoke-resource-a`,
    operator: principalA,
    tenantId: tenantA,
    resourceId: resourceA,
    principalId: principalA,
  });
  expect(aclRevocation).toEqual({ changed: true, aclEpoch: 2 });
  await expect(
    reader.readAuthorizedResource(scopeA, resourceA),
  ).rejects.toThrow("RESOURCE_NOT_FOUND");
  expect(
    await reader.readAuthorizedResource(scopeA, revocationResource),
  ).toMatchObject({
    resourceId: revocationResource,
  });

  const membershipRevocation = await suspendMembership(operator, {
    operationId: `${prefix}-revoke-member-a`,
    operator: principalA,
    tenantId: tenantA,
    principalId: principalA,
  });
  expect(membershipRevocation).toEqual({ changed: true, epoch: 2 });
  await expect(
    reader.readAuthorizedResource(scopeA, revocationResource),
  ).rejects.toThrow("SCOPE_REVOKED");
});
