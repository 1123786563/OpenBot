import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { createResourceReader } from "../../../src/enterprise/authz/repository";
import type {
  AuthorizationInput,
  Authz,
  Scope,
} from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createResource,
  createWorkspace,
  grantRead,
  provisionMember,
  revokeRead,
  suspendMember,
} from "../../../src/enterprise/tenancy/provision";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import {
  lockKey,
  lockShared,
  withTenant,
} from "../../../src/enterprise/tenancy/transaction";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * The single-transaction authorized read, per plan 02 §6 T2-B steps 5 and 6.
 *
 * `readAuthorizedResource` is the ONLY public read path: inside one READ COMMITTED `withTenant`
 * transaction it takes the resource shared advisory lock, re-reads the live resource fact (grant
 * included, same statement), hands the parsed snapshot to the local Authz and returns the bare
 * ResourceView — never an intermediate snapshot. Missing resource, deleted resource and no grant
 * are the same 404; a corrupted row shape is a closed 503.
 *
 * The revocation races use TWO real connections (data login for the reader, operator login for the
 * revoker) coordinated by promise gates — the test-injection `afterLocks` hook is the revoker's
 * only pause point and is not reachable from any HTTP surface. Order is observed by polling with
 * deadlines, never by fixed sleeps.
 */

const TENANT_A = "t2brd-tenant-a";
const TENANT_B = "t2brd-tenant-b";
const TENANT_NAME_A = "T2B Repository Tenant A";
const TENANT_NAME_B = "T2B Repository Tenant B";
const USER_A = "t2brd-user-a";
const PRINCIPAL_A = "t2brd-principal-a";
const WORKSPACE_A = "t2brd-workspace-a";
const WORKSPACE_B = "t2brd-workspace-b";
const RESOURCE_GRANTED = "t2brd-resource-granted";
const RESOURCE_NO_GRANT = "t2brd-resource-no-grant";
const RESOURCE_CROSS = "t2brd-resource-cross";
const RESOURCE_BARRIER = "t2brd-resource-barrier";
const OPERATOR = "t2brd-operator";
const IDENTITY_OPERATOR = "t2brd-identity-operator";

const GRANT_EXISTS =
  "select exists(select 1 from enterprise_resource_grants g where g.tenant_id = $1 and g.resource_id = $2 and g.principal_id = $3 and g.action = 'read') as granted";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 2 },
);
const directoryLoginDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  { max: 2 },
);
const directoryDatabase = createDirectory(directoryLoginDatabase);
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 2 },
);

let scopeA: Scope;

/** A local Authz test double: records every input, supports an explicit policy-revision set. */
function createRecordingAuthz(
  config: {
    supportedRevisions?: readonly string[];
    decide?: (input: AuthorizationInput) => boolean;
  } = {},
) {
  const supported = new Set(config.supportedRevisions ?? ["tenancy-v1"]);
  const seen: AuthorizationInput[] = [];
  const authz: Authz = {
    async check(input) {
      seen.push(input);
      if (!supported.has(input.resource.policyRevision)) {
        throw new EnterpriseError("UNKNOWN_POLICY_REVISION", 503);
      }
      return config.decide
        ? config.decide(input)
        : input.resource.active && input.resource.locallyAllowed;
    },
  };
  return { authz, seen };
}

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

/** Resolves true when the promise has already settled (value or rejection), false otherwise. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const settled = Symbol("settled");
  const outcome = await Promise.race([
    promise.then(
      () => settled,
      () => settled,
    ),
    Bun.sleep(2).then(() => null),
  ]);
  return outcome === settled;
}

/** Samples a promise for a while and expects it NOT to settle — the ordering observation. */
async function expectPendingFor(
  promise: Promise<unknown>,
  windowMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (await isSettled(promise)) {
      throw new Error("promise settled while its gate was still closed");
    }
    await Bun.sleep(25);
  }
}

async function ownerScalar(text: string, values: ReadonlyArray<string>) {
  const rows = await ownerDatabase.$client.unsafe<Record<string, unknown>[]>(
    text,
    [...values],
  );
  return rows[0];
}

beforeAll(async () => {
  /* Idempotent teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "t2brd-%"));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, "t2brd-%"));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, "t2brd-%"));
  await ownerDatabase.delete(users).where(like(users.id, "t2brd-%"));

  await ownerDatabase
    .insert(users)
    .values([{ id: USER_A, email: "t2brd-a@enterprise-test.invalid" }])
    .onConflictDoNothing();

  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL_A,
    userId: USER_A,
    operator: IDENTITY_OPERATOR,
    operationId: "t2brd-op-idp-a",
  });
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_A,
    tenantName: TENANT_NAME_A,
    principalId: PRINCIPAL_A,
    userId: USER_A,
    role: "member",
    operator: OPERATOR,
    operationId: "t2brd-op-open-a-in-a",
  });
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_B,
    tenantName: TENANT_NAME_B,
    principalId: PRINCIPAL_A,
    userId: USER_A,
    role: "member",
    operator: OPERATOR,
    operationId: "t2brd-op-open-a-in-b",
  });

  for (const [tenantId, workspaceId] of [
    [TENANT_A, WORKSPACE_A],
    [TENANT_B, WORKSPACE_B],
  ] as const) {
    await createWorkspace(operatorDatabase, {
      tenantId,
      workspaceId,
      name: `T2B Repository Workspace ${workspaceId}`,
      operator: OPERATOR,
      operationId: `t2brd-op-ws-${workspaceId}`,
    });
  }
  for (const [tenantId, resourceId, workspaceId] of [
    [TENANT_A, RESOURCE_GRANTED, WORKSPACE_A],
    [TENANT_A, RESOURCE_NO_GRANT, WORKSPACE_A],
    [TENANT_A, RESOURCE_BARRIER, WORKSPACE_A],
    [TENANT_B, RESOURCE_CROSS, WORKSPACE_B],
  ] as const) {
    await createResource(operatorDatabase, {
      tenantId,
      workspaceId,
      resourceId,
      kind: "document",
      operator: OPERATOR,
      operationId: `t2brd-op-res-${resourceId}`,
    });
  }
  for (const resourceId of [RESOURCE_GRANTED, RESOURCE_BARRIER]) {
    await grantRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: `t2brd-op-grant-${resourceId}`,
    });
  }

  scopeA = await resolveScope(directoryDatabase, USER_A, TENANT_A);
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
    directoryLoginDatabase.$client.close(),
    dataDatabase.$client.close(),
  ]);
});

describe("the authorized read answers only inside one transaction", () => {
  test("the fixture is real: a granted resource is readable and its view is exact", async () => {
    const grants = await ownerDatabase
      .select({ resourceId: enterpriseResourceGrants.resourceId })
      .from(enterpriseResourceGrants)
      .where(like(enterpriseResourceGrants.tenantId, "t2brd-%"));
    expect(grants.length).toBe(2);
    const resources = await ownerDatabase
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(like(enterpriseResources.tenantId, "t2brd-%"));
    expect(resources.length).toBe(4);

    const reader = createResourceReader(
      dataDatabase,
      createRecordingAuthz().authz,
    );
    const view = await reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED);
    expect(view).toEqual({
      id: RESOURCE_GRANTED,
      workspaceId: WORKSPACE_A,
      kind: "document",
      revision: 1,
    });
  });

  test("an ungranted resource, another tenant's resource and an unknown id are all 404", async () => {
    const { authz, seen } = createRecordingAuthz();
    const reader = createResourceReader(dataDatabase, authz);

    for (const resourceId of [
      RESOURCE_NO_GRANT,
      RESOURCE_CROSS,
      "t2brd-absent",
    ]) {
      const error = await enterpriseErrorOf(() =>
        reader.readAuthorizedResource(scopeA, resourceId),
      );
      expect(error.code).toBe("RESOURCE_NOT_FOUND");
      expect(error.status).toBe(404);
    }
    /* The local Authz is never consulted without a locally granted, active resource. */
    expect(seen).toHaveLength(0);
  });

  test("the Authz receives the live database fact, not caller input", async () => {
    const { authz, seen } = createRecordingAuthz();
    const reader = createResourceReader(dataDatabase, authz);
    await reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED);

    expect(seen).toHaveLength(1);
    expect(seen[0].scope).toBe(scopeA);
    expect(seen[0].action).toBe("read");
    expect(seen[0].resource).toEqual({
      id: RESOURCE_GRANTED,
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      kind: "document",
      revision: 1,
      aclEpoch: 2,
      policyRevision: "tenancy-v1",
      active: true,
      locallyAllowed: true,
    });
  });

  test("a local Authz denial is the same 404 as an absent resource", async () => {
    const { authz, seen } = createRecordingAuthz({ decide: () => false });
    const reader = createResourceReader(dataDatabase, authz);
    const error = await enterpriseErrorOf(() =>
      reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED),
    );
    expect(error.code).toBe("RESOURCE_NOT_FOUND");
    expect(error.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  test("a supported new policy revision is judged by its rules; an unknown revision is 503", async () => {
    const { authz, seen } = createRecordingAuthz({
      supportedRevisions: ["tenancy-v1", "tenancy-v2"],
      decide: (input) =>
        input.resource.policyRevision === "tenancy-v2"
          ? input.resource.locallyAllowed && input.resource.revision >= 1
          : input.resource.active && input.resource.locallyAllowed,
    });
    const reader = createResourceReader(dataDatabase, authz);

    try {
      await ownerDatabase.$client.unsafe(
        "update enterprise_tenants set policy_revision = $1 where id = $2",
        ["tenancy-v2", TENANT_A],
      );
      const view = await reader.readAuthorizedResource(
        scopeA,
        RESOURCE_GRANTED,
      );
      expect(view.id).toBe(RESOURCE_GRANTED);
      expect(seen.at(-1)?.resource.policyRevision).toBe("tenancy-v2");

      await ownerDatabase.$client.unsafe(
        "update enterprise_tenants set policy_revision = $1 where id = $2",
        ["tenancy-v9-unknown", TENANT_A],
      );
      const error = await enterpriseErrorOf(() =>
        reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED),
      );
      expect(error.code).toBe("UNKNOWN_POLICY_REVISION");
      expect(error.status).toBe(503);
    } finally {
      await ownerDatabase.$client.unsafe(
        "update enterprise_tenants set policy_revision = $1 where id = $2",
        ["tenancy-v1", TENANT_A],
      );
    }
  });

  test("a corrupted resource row is a closed 503, never a raw DB shape", async () => {
    const reader = createResourceReader(
      dataDatabase,
      createRecordingAuthz().authz,
    );
    try {
      await ownerDatabase.$client.unsafe(
        "alter table enterprise_resources drop constraint enterprise_resource_versions",
      );
      await ownerDatabase.$client.unsafe(
        "update enterprise_resources set revision = 0 where tenant_id = $1 and id = $2",
        [TENANT_A, RESOURCE_GRANTED],
      );
      const error = await enterpriseErrorOf(() =>
        reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED),
      );
      expect(error.code).toBe("AUTHORIZATION_STATE_INVALID");
      expect(error.status).toBe(503);
    } finally {
      await ownerDatabase.$client.unsafe(
        "update enterprise_resources set revision = 1 where tenant_id = $1 and id = $2",
        [TENANT_A, RESOURCE_GRANTED],
      );
      await ownerDatabase.$client.unsafe(
        "alter table enterprise_resources add constraint enterprise_resource_versions check (revision > 0 and acl_epoch > 0)",
      );
    }
  });
});

describe("authorization-then-revocation races across two real connections", () => {
  test("a reader holding the shared resource lock delays the revoker, then both finish in order", async () => {
    /* Reader: take the resource shared lock inside a scoped transaction, signal that the lock is
     * genuinely held, pause on the gate, then read the grant fact in the same lock. */
    let releaseReader: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let signalLockTaken: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      signalLockTaken = resolve;
    });
    const reader = withTenant(dataDatabase, scopeA, async (tx) => {
      await lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_BARRIER));
      signalLockTaken();
      await gate;
      const rows = await tx.unsafe<{ granted: boolean }[]>(GRANT_EXISTS, [
        TENANT_A,
        RESOURCE_BARRIER,
        PRINCIPAL_A,
      ]);
      return rows[0].granted;
    });
    await lockTaken;

    try {
      /* Revoker: a real revokeRead that must wait for the resource EXCLUSIVE lock. */
      const revoker = revokeRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: RESOURCE_BARRIER,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: "t2brd-op-race-reader-first",
      });

      /* The revoker cannot finish while the reader holds the shared lock. */
      await expectPendingFor(revoker);
      releaseReader();

      /* The reader saw the grant inside its lock, before the revocation committed. */
      expect(await reader).toBe(true);
      const outcome = await revoker;
      expect(outcome.revoked).toBe(true);
    } finally {
      releaseReader();
    }

    /* After the revocation commits, the same authorized read is a 404. */
    const readerAfter = createResourceReader(
      dataDatabase,
      createRecordingAuthz().authz,
    );
    const error = await enterpriseErrorOf(() =>
      readerAfter.readAuthorizedResource(scopeA, RESOURCE_BARRIER),
    );
    expect(error.code).toBe("RESOURCE_NOT_FOUND");
    expect(error.status).toBe(404);

    /* Restore the barrier grant for the next race. */
    await grantRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_BARRIER,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "t2brd-op-race-restore-1",
    });
  });

  test("a revoker holding the exclusive lock makes the reader wait, then the reader sees 404", async () => {
    let releaseRevoker: () => void = () => {};
    const revokerGate = new Promise<void>((resolve) => {
      releaseRevoker = resolve;
    });
    let signalLocksTaken: () => void = () => {};
    const locksTaken = new Promise<void>((resolve) => {
      signalLocksTaken = resolve;
    });
    /* The afterLocks hook runs after every advisory lock — the resource EXCLUSIVE one included —
     * is held, and is a test-injection pause point only; no HTTP surface reaches it. */
    const revoker = revokeRead(
      operatorDatabase,
      {
        tenantId: TENANT_A,
        resourceId: RESOURCE_BARRIER,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: "t2brd-op-race-revoker-first",
      },
      {
        afterLocks: () => {
          signalLocksTaken();
          return revokerGate;
        },
      },
    );

    try {
      /* The revoker provably holds the locks (the hook fired) and is paused before committing. */
      await locksTaken;

      const reader = createResourceReader(
        dataDatabase,
        createRecordingAuthz().authz,
      );
      const reading = reader.readAuthorizedResource(scopeA, RESOURCE_BARRIER);
      /* The reader is stuck on the lock while the revoker has not committed. */
      await expectPendingFor(reading);

      releaseRevoker();
      const outcome = await revoker;
      expect(outcome.revoked).toBe(true);

      /* READ COMMITTED: the reader's in-lock statement reads the post-revocation fact and 404s. */
      const error = await enterpriseErrorOf(() => reading);
      expect(error.code).toBe("RESOURCE_NOT_FOUND");
      expect(error.status).toBe(404);
    } finally {
      releaseRevoker();
    }

    await grantRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_BARRIER,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "t2brd-op-race-restore-2",
    });
  });

  test("a revoker that fails inside its transaction rolls back and the reader keeps access", async () => {
    const revoker = revokeRead(
      operatorDatabase,
      {
        tenantId: TENANT_A,
        resourceId: RESOURCE_BARRIER,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: "t2brd-op-race-revoker-abort",
      },
      {
        afterLocks: async () => {
          throw new Error("revoke-aborted");
        },
      },
    );
    await expect(revoker).rejects.toThrow("revoke-aborted");

    const survivor = await ownerScalar(GRANT_EXISTS, [
      TENANT_A,
      RESOURCE_BARRIER,
      PRINCIPAL_A,
    ]);
    expect(survivor.granted).toBe(true);

    const reader = createResourceReader(
      dataDatabase,
      createRecordingAuthz().authz,
    );
    const view = await reader.readAuthorizedResource(scopeA, RESOURCE_BARRIER);
    expect(view.id).toBe(RESOURCE_BARRIER);
  });

  test("a reader that fails inside its transaction releases the lock and the revocation proceeds", async () => {
    await expect(
      withTenant(dataDatabase, scopeA, async (tx) => {
        await lockShared(tx, lockKey("resource", TENANT_A, RESOURCE_BARRIER));
        throw new Error("reader-aborted");
      }),
    ).rejects.toThrow("reader-aborted");

    const outcome = await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_BARRIER,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "t2brd-op-race-reader-abort",
    });
    expect(outcome.revoked).toBe(true);
  });

  test("a membership suspended after minting revokes the scope inside the read transaction", async () => {
    await suspendMember(operatorDatabase, {
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "t2brd-op-suspend-a",
    });
    const reader = createResourceReader(
      dataDatabase,
      createRecordingAuthz().authz,
    );
    const error = await enterpriseErrorOf(() =>
      reader.readAuthorizedResource(scopeA, RESOURCE_GRANTED),
    );
    expect(error.code).toBe("SCOPE_REVOKED");
    expect(error.status).toBe(403);
  });
});
