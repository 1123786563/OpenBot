import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseSecurityEvents,
  enterpriseTenants,
  users,
} from "../../../src/db/schema";
import type { Membership } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  provisionMember,
  suspendMember,
} from "../../../src/enterprise/tenancy/provision";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * The real directory role, per plan 02 §6 T2-A steps 4–5.
 *
 * The directory connection is the RESTRICTED `ob_ent_directory` login: RLS pins it to
 * `app.user_id`, which `createDirectory` sets inside each query's own transaction — never on a
 * neighbouring pooled connection. The fixture is established through the T1-C controlled
 * functions (identity operator creates principals, tenant operator provisions memberships); no
 * enterprise row is planted by hand.
 *
 * The shape under test: one authenticated human (user A) holds two tenants, so their listing spans
 * both; another user (B) sees exactly their own one tenant and never A's; a user with no principal
 * sees nothing at all. Suspension is observed live — the listing reports it, and resolveScope
 * refuses the suspended tenant while the untouched one still answers.
 */

const TENANT_A = "dir-t2a-tenant-a";
const TENANT_B = "dir-t2a-tenant-b";
const TENANT_NAME_A = "Directory T2A Tenant A";
const TENANT_NAME_B = "Directory T2A Tenant B";
const USER_A = "dir-t2a-user-a";
const USER_B = "dir-t2a-user-b";
const USER_NOBODY = "dir-t2a-user-nobody";
const PRINCIPAL_A = "dir-t2a-principal-a";
const PRINCIPAL_B = "dir-t2a-principal-b";
const OPERATOR = "dir-t2a-operator";
const IDENTITY_OPERATOR = "dir-t2a-identity-operator";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

/* The owner only tears the fixture down and plants the `users` rows (deployment identity data no
 * enterprise role may write); every principal and membership comes from the T1-C functions. */
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
/* The connection under test: the directory login the enterprise API would hold. */
const directoryDatabase = createDirectory(
  createDatabase(restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"), {
    max: 2,
  }),
);

beforeAll(async () => {
  /* Idempotent fixture teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, "dir-t2a-%"));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, "dir-t2a-%"));
  /* The identity audit rows too: their id IS the operation id, so a surviving event would make the
   * identity CLI replay return its recorded result without re-creating a torn-down principal. */
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "dir-t2a-%"));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, "dir-t2a-%"));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, "dir-t2a-%"));
  await ownerDatabase.delete(users).where(like(users.id, "dir-t2a-%"));

  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_A, email: "dir-t2a-a@enterprise-test.invalid" },
      { id: USER_B, email: "dir-t2a-b@enterprise-test.invalid" },
    ])
    .onConflictDoNothing();

  for (const [principalId, userId, suffix] of [
    [PRINCIPAL_A, USER_A, "a"],
    [PRINCIPAL_B, USER_B, "b"],
  ] as const) {
    await createPrincipal(identityOperatorDatabase, {
      principalId,
      userId,
      operator: IDENTITY_OPERATOR,
      operationId: `dir-t2a-op-idp-${suffix}`,
    });
  }

  /* One human, two tenants (different roles, proving the role travels with the row); a second
   * human in exactly one of them. */
  for (const input of [
    {
      tenantId: TENANT_A,
      tenantName: TENANT_NAME_A,
      principalId: PRINCIPAL_A,
      userId: USER_A,
      role: "tenant_admin" as const,
      operationId: "dir-t2a-op-open-a-in-a",
    },
    {
      tenantId: TENANT_B,
      tenantName: TENANT_NAME_B,
      principalId: PRINCIPAL_A,
      userId: USER_A,
      role: "member" as const,
      operationId: "dir-t2a-op-open-a-in-b",
    },
    {
      tenantId: TENANT_B,
      tenantName: TENANT_NAME_B,
      principalId: PRINCIPAL_B,
      userId: USER_B,
      role: "auditor" as const,
      operationId: "dir-t2a-op-open-b-in-b",
    },
  ]) {
    await provisionMember(operatorDatabase, {
      ...input,
      operator: OPERATOR,
    });
  }
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
  ]);
});

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

async function membershipsOf(principalId: string) {
  return ownerDatabase
    .select()
    .from(enterpriseMemberships)
    .where(eq(enterpriseMemberships.principalId, principalId));
}

describe("the fixture is real before anything is denied", () => {
  test("both principals and all three memberships exist via the T1-C functions", async () => {
    const forA = await membershipsOf(PRINCIPAL_A);
    const forB = await membershipsOf(PRINCIPAL_B);
    expect(forA).toHaveLength(2);
    expect(forB).toHaveLength(1);
    expect(
      await ownerDatabase
        .select({ id: enterpriseTenants.id })
        .from(enterpriseTenants)
        .where(
          and(
            like(enterpriseTenants.id, "dir-t2a-%"),
            eq(enterpriseTenants.status, "active"),
          ),
        ),
    ).toHaveLength(2);
  });
});

describe("the directory role answers for the authenticated user only", () => {
  test("one human lists both tenants; another user sees only their own", async () => {
    const first = await directoryDatabase.listForUser(USER_A);
    const second = await directoryDatabase.listForUser(USER_B);
    expect(first.map((row) => row.tenantId).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
    expect(second.map((row) => row.tenantId)).toEqual([TENANT_B]);
    /* B's listing must not leak A's tenant name or principal either. */
    expect(second.every((row) => row.principalId === PRINCIPAL_B)).toBe(true);
    expect(JSON.stringify(second)).not.toContain(TENANT_NAME_A);
  });

  test("each row carries the full membership fact, not just the tenant id", async () => {
    const rows: Membership[] = await directoryDatabase.listForUser(USER_A);
    const byTenant = new Map(rows.map((row) => [row.tenantId, row]));
    expect(byTenant.get(TENANT_A)).toEqual({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      tenantName: TENANT_NAME_A,
      role: "tenant_admin",
      epoch: 1,
      tenantStatus: "active",
      principalStatus: "active",
      memberStatus: "active",
    });
    expect(byTenant.get(TENANT_B)).toEqual({
      tenantId: TENANT_B,
      principalId: PRINCIPAL_A,
      tenantName: TENANT_NAME_B,
      role: "member",
      epoch: 1,
      tenantStatus: "active",
      principalStatus: "active",
      memberStatus: "active",
    });
  });

  test("a user without a principal sees nothing", async () => {
    expect(await directoryDatabase.listForUser(USER_NOBODY)).toEqual([]);
  });
});

describe("the directory reflects live revocation and resolveScope follows it", () => {
  test("a suspended membership is listed as suspended, denied as a scope, and the other tenant still answers", async () => {
    await suspendMember(operatorDatabase, {
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "dir-t2a-op-suspend-a-in-a",
    });

    const rows = await directoryDatabase.listForUser(USER_A);
    const suspended = rows.find((row) => row.tenantId === TENANT_A);
    expect(suspended?.memberStatus).toBe("suspended");
    expect(suspended?.epoch).toBe(2);

    const denied = await enterpriseErrorOf(() =>
      resolveScope(directoryDatabase, USER_A, TENANT_A),
    );
    expect(denied.code).toBe("TENANT_FORBIDDEN");
    expect(denied.status).toBe(403);

    const stillMember = await resolveScope(directoryDatabase, USER_A, TENANT_B);
    expect(stillMember.tenantId).toBe(TENANT_B);
    expect(stillMember.principalId).toBe(PRINCIPAL_A);

    const otherUser = await resolveScope(directoryDatabase, USER_B, TENANT_B);
    expect(otherUser.principalId).toBe(PRINCIPAL_B);
    expect(otherUser.role).toBe("auditor");
  });
});
