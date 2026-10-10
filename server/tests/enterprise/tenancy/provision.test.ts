import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like, or, sql } from "drizzle-orm";
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
import { EnterpriseError } from "../../../src/enterprise/errors";
import {
  createPrincipal,
  suspendPrincipal,
} from "../../../src/enterprise/tenancy/identity";
import {
  createResource,
  createWorkspace,
  grantRead,
  provisionMember,
  revokeRead,
  suspendMember,
} from "../../../src/enterprise/tenancy/provision";
import { testDatabaseUrlFrom } from "../../support/database";
import { rejectionOf } from "../../support/pg-errors";

/*
 * Explicit provisioning and versioned revocation, per plan 02 §5 T1-C.
 *
 * Every write goes through the controlled functions on the RESTRICTED operator login
 * (`ob_ent_operator`), never on the migration owner; the owner connection exists only to plant the
 * `users` rows a principal binds to (identity data the identity operator has no grant to create),
 * to flip tenant status for the negative cases, and to assert final state.
 *
 * The fixture principals are established by the real identity CLI (`enterprise-identity-provision`)
 * as a subprocess on the identity operator login — never by silently inserting principal rows.
 * A missing users row must surface as the foreign-key rejection it is, not as a fake user.
 *
 * The audit-failure case plants a prior security event whose details cannot be strictly parsed:
 * the plan requires every stored event to be re-read and validated before an operation decides it
 * is a replay, so a corrupt audit record must fail the operation closed and leave no writes.
 */

const TENANT_A = "prov-t1c-tenant-a";
const TENANT_CONC = "prov-t1c-tenant-conc";
const TENANT_OTHER = "prov-t1c-tenant-other";
const TENANT_CLI = "prov-t1c-tenant-cli";
const TENANT_AUDITFAIL = "prov-t1c-tenant-auditfail";
const TENANT_MISSING = "prov-t1c-tenant-missing";
const TENANT_DAROLE = "prov-t1c-tenant-datarole";
const TENANT_DRYRUN = "prov-t1c-tenant-dryrun";
const TENANT_NAME = "Provision T1C Tenant";
const USER_A = "prov-t1c-user-a";
const USER_B = "prov-t1c-user-b";
const USER_C = "prov-t1c-user-c";
const PRINCIPAL_A = "prov-t1c-principal-a";
const PRINCIPAL_B = "prov-t1c-principal-b";
const PRINCIPAL_C = "prov-t1c-principal-c";
const WORKSPACE_MAIN = "prov-t1c-workspace-main";
const WORKSPACE_OTHER = "prov-t1c-workspace-other";
const RESOURCE_MAIN = "prov-t1c-resource-main";
const OPERATOR = "prov-t1c-operator";
const IDENTITY_OPERATOR = "prov-t1c-identity-operator";
const CONNECTION_SECRET = "ent-operator-test-only";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
/* Two connections: the concurrency case needs two provisioning transactions in flight at once. */
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 2 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
/* One API-role connection, to prove provisioning is not reachable with a data login. */
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 1 },
);

/*
 * The offline CLIs run as subprocesses with exactly one database variable each, mapped from the
 * test logins. `--no-env-file` keeps Bun from auto-loading the repository root `.env`, and the
 * child environment carries nothing beyond PATH/HOME and the one mapped URL — so "no fallback to
 * DATABASE_URL" is structural, not a promise.
 */
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

type CliRun = { code: number; out: string; err: string };

async function runScript(
  script: string,
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> = {},
): Promise<CliRun> {
  /*
   * A CLI run ALWAYS writes at least one stream: success prints its dry-run plan or applied
   * outcome to stdout, and every refusal path — usage, a bad --input, a missing URL,
   * an EnterpriseError, an uncaught throw — writes stderr before exiting. A run with EMPTY
   * stdout AND empty stderr is therefore not behaviour either CLI can produce; it is the child's
   * output failing to be captured at all, a spawn-layer fault observed under full-suite parallel
   * load. Such a result is infrastructure noise, not the thing under test, so it is retried; a
   * genuine failure still fails the assertions because its stderr reaches them.
   *
   * A spawn-layer exception is folded into `err` as a visible `[spawn]` line, so a fault of this
   * kind can never again present as a silent empty stderr. The arguments are passed as one exact
   * element per argument (never a shell string), and every literal below is fixed.
   */
  for (let attempt = 1; ; attempt += 1) {
    let code: number;
    let out = "";
    let err = "";
    let silentFaultExit: string | undefined;
    try {
      const { stdout, stderr, exitCode } = Bun.spawnSync(
        ["bun", "--no-env-file", script, ...args],
        {
          cwd: REPO_ROOT,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...environment,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      code = exitCode;
      out = stdout.toString();
      err = stderr.toString();
      if (out.length === 0 && err.length === 0) {
        /* 空输出不是任何 CLI 能产出的行为（见上注释）。观测值记入独立变量，不污染 err 的
         * "原始输出"语义——否则重试判断被这行非空字符串短路（第三轮门禁的 attempt=1 即该
         * 缺陷），故障场景就只剩一次机会。 */
        silentFaultExit = String(exitCode);
        code = exitCode === null ? -1 : exitCode;
      }
    } catch (spawnError) {
      code = -1;
      err = `[spawn] ${
        spawnError instanceof Error ? spawnError.message : String(spawnError)
      }`;
    }
    if (out.length > 0 || err.length > 0) {
      return { code, out, err };
    }
    if (attempt >= 4) {
      /* 重试耗尽仍是空输出：把 spawn 层观测编码进 err，让这类故障在断言消息里可见、可归因
       * （退出码/尝试次数），而不是无声的空串；该行不含任何 CLI 会打印的变量名，因此不会
       * 让任何失败断言误通过——真实断言依旧失败。 */
      return {
        code,
        out,
        err: `[spawn-observability] exit=${silentFaultExit ?? String(code)} attempt=${attempt}`,
      };
    }
    /* 指数退避后重试：瞬态高负载窗口下的 spawn 故障多数在下一次尝试时消失。 */
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
}

function identityCli(
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> = {},
): Promise<CliRun> {
  return runScript("server/scripts/enterprise-identity-provision.ts", args, {
    ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL:
      process.env.ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL,
    ...environment,
  });
}

function provisionCli(
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> = {},
): Promise<CliRun> {
  return runScript("server/scripts/enterprise-provision.ts", args, {
    ENTERPRISE_OPERATOR_DATABASE_URL:
      process.env.ENTERPRISE_TEST_OPERATOR_DATABASE_URL,
    ...environment,
  });
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
  throw new Error("expected the operation to be rejected, but it succeeded");
}

async function membershipOf(tenantId: string, principalId: string) {
  const rows = await ownerDatabase
    .select()
    .from(enterpriseMemberships)
    .where(
      and(
        eq(enterpriseMemberships.tenantId, tenantId),
        eq(enterpriseMemberships.principalId, principalId),
      ),
    )
    .limit(1);
  return rows[0];
}

async function securityEventCount(tenantId: string, operationId?: string) {
  const rows = await ownerDatabase
    .select({ id: enterpriseSecurityEvents.id })
    .from(enterpriseSecurityEvents)
    .where(
      operationId === undefined
        ? eq(enterpriseSecurityEvents.tenantId, tenantId)
        : and(
            eq(enterpriseSecurityEvents.tenantId, tenantId),
            eq(enterpriseSecurityEvents.id, operationId),
          ),
    );
  return rows.length;
}

async function identityEventCount(operationId: string) {
  const rows = await ownerDatabase
    .select({ id: enterpriseIdentityEvents.id })
    .from(enterpriseIdentityEvents)
    .where(eq(enterpriseIdentityEvents.id, operationId));
  return rows.length;
}

async function aclEpochOf(tenantId: string, resourceId: string) {
  const rows = await ownerDatabase
    .select({ aclEpoch: enterpriseResources.aclEpoch })
    .from(enterpriseResources)
    .where(
      and(
        eq(enterpriseResources.tenantId, tenantId),
        eq(enterpriseResources.id, resourceId),
      ),
    )
    .limit(1);
  return rows[0]?.aclEpoch;
}

async function grantRowOf(
  tenantId: string,
  resourceId: string,
  principalId: string,
) {
  const rows = await ownerDatabase
    .select()
    .from(enterpriseResourceGrants)
    .where(
      and(
        eq(enterpriseResourceGrants.tenantId, tenantId),
        eq(enterpriseResourceGrants.resourceId, resourceId),
        eq(enterpriseResourceGrants.principalId, principalId),
      ),
    )
    .limit(1);
  return rows[0];
}

async function tenantExists(tenantId: string) {
  const rows = await ownerDatabase
    .select({ id: enterpriseTenants.id })
    .from(enterpriseTenants)
    .where(eq(enterpriseTenants.id, tenantId))
    .limit(1);
  return rows.length === 1;
}

async function principalStatusOf(principalId: string) {
  const rows = await ownerDatabase
    .select({ status: enterprisePrincipals.status })
    .from(enterprisePrincipals)
    .where(eq(enterprisePrincipals.id, principalId))
    .limit(1);
  return rows[0]?.status;
}

const provisionInputA = {
  tenantId: TENANT_A,
  tenantName: TENANT_NAME,
  principalId: PRINCIPAL_A,
  userId: USER_A,
  role: "member" as const,
  operator: OPERATOR,
  operationId: "prov-t1c-op-open-a",
};

beforeAll(async () => {
  /* Idempotent fixture teardown in foreign-key order, scoped to this file's prefix. */
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(
      or(
        like(enterpriseSecurityEvents.tenantId, "prov-t1c-%"),
        like(enterpriseSecurityEvents.id, "prov-t1c-%"),
      ),
    );
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, "prov-t1c-%"));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, "prov-t1c-%"));
  await ownerDatabase.delete(users).where(like(users.id, "prov-t1c-%"));

  /*
   * The users rows are the deployment's own identity records: planted by the owner exactly like the
   * T1-B fixture, because only the identity operator may write principals and nothing short of the
   * owner may write users. The principals themselves are then established for real by the identity
   * CLI on its own login — a silent owner insert here would defeat the point of this file.
   */
  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_A, email: "prov-t1c-a@enterprise-test.invalid" },
      { id: USER_B, email: "prov-t1c-b@enterprise-test.invalid" },
      { id: USER_C, email: "prov-t1c-c@enterprise-test.invalid" },
    ])
    .onConflictDoNothing();

  for (const [principalId, userId, suffix] of [
    [PRINCIPAL_A, USER_A, "a"],
    [PRINCIPAL_B, USER_B, "b"],
    [PRINCIPAL_C, USER_C, "c"],
  ] as const) {
    const run = await identityCli([
      "create-principal",
      "--input",
      JSON.stringify({ principalId, userId }),
      "--operator",
      IDENTITY_OPERATOR,
      "--operation-id",
      `prov-t1c-op-idc-${suffix}`,
      "--apply",
    ]);
    if (run.code !== 0) {
      throw new Error(
        `identity CLI failed to create ${principalId}: ${run.err}`,
      );
    }
  }
});

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    operatorDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    dataDatabase.$client.close(),
  ]);
});

describe("the identity CLI establishes real principals on its own login", () => {
  test("create-principal --apply created the fixture principals and global identity audit", async () => {
    for (const principalId of [PRINCIPAL_A, PRINCIPAL_B, PRINCIPAL_C]) {
      expect(await principalStatusOf(principalId)).toBe("active");
    }
    expect(await identityEventCount("prov-t1c-op-idc-a")).toBe(1);
    expect(await identityEventCount("prov-t1c-op-idc-b")).toBe(1);
    expect(await identityEventCount("prov-t1c-op-idc-c")).toBe(1);
  });

  test("create-principal without --apply writes nothing", async () => {
    const run = await identityCli([
      "create-principal",
      "--input",
      JSON.stringify({
        principalId: "prov-t1c-principal-dryrun",
        userId: USER_A,
      }),
      "--operator",
      IDENTITY_OPERATOR,
      "--operation-id",
      "prov-t1c-op-idc-dryrun",
    ]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("dry-run");
    expect(
      await principalStatusOf("prov-t1c-principal-dryrun"),
    ).toBeUndefined();
  });

  test("the identity CLI refuses unknown commands and refuses --apply without its URL", async () => {
    const unknown = await identityCli(["restore-principal", "--apply"]);
    expect(unknown.code).not.toBe(0);

    const noUrl = await identityCli(
      [
        "create-principal",
        "--input",
        JSON.stringify({
          principalId: "prov-t1c-principal-nourl",
          userId: USER_A,
        }),
        "--operator",
        IDENTITY_OPERATOR,
        "--operation-id",
        "prov-t1c-op-idc-nourl",
        "--apply",
      ],
      { ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL: undefined },
    );
    expect(noUrl.code).not.toBe(0);
    expect(noUrl.err).toContain("ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL");
    expect(await principalStatusOf("prov-t1c-principal-nourl")).toBeUndefined();
  });
});

describe("createPrincipal keeps the user binding unique in both directions", () => {
  test("an existing principal cannot rebind to another user, and a user cannot gain a second principal", async () => {
    const rebind = await enterpriseErrorOf(() =>
      createPrincipal(identityOperatorDatabase, {
        principalId: PRINCIPAL_A,
        userId: USER_B,
        operator: IDENTITY_OPERATOR,
        operationId: "prov-t1c-op-idp-rebind",
      }),
    );
    expect(rebind.code).toBe("PRINCIPAL_BINDING_CONFLICT");
    expect(rebind.status).toBe(409);

    const second = await enterpriseErrorOf(() =>
      createPrincipal(identityOperatorDatabase, {
        principalId: "prov-t1c-principal-second",
        userId: USER_A,
        operator: IDENTITY_OPERATOR,
        operationId: "prov-t1c-op-idp-second",
      }),
    );
    expect(second.code).toBe("PRINCIPAL_BINDING_CONFLICT");
    expect(
      await principalStatusOf("prov-t1c-principal-second"),
    ).toBeUndefined();
  });

  test("a missing users row is a foreign-key rejection, not a silently created user", async () => {
    const error = await rejectionOf(() =>
      createPrincipal(identityOperatorDatabase, {
        principalId: "prov-t1c-principal-ghost",
        userId: "prov-t1c-user-missing",
        operator: IDENTITY_OPERATOR,
        operationId: "prov-t1c-op-idp-ghost",
      }),
    );
    expect(error.code).toBe("23503");
    expect(await principalStatusOf("prov-t1c-principal-ghost")).toBeUndefined();
  });

  test("the same operation replays without a second audit event; a different payload conflicts", async () => {
    const input = {
      principalId: PRINCIPAL_B,
      userId: USER_B,
      operator: IDENTITY_OPERATOR,
      operationId: "prov-t1c-op-idp-replay",
    };
    const first = await createPrincipal(identityOperatorDatabase, input);
    expect(first.created).toBe(false);
    const replay = await createPrincipal(identityOperatorDatabase, input);
    expect(replay).toEqual(first);
    expect(await identityEventCount(input.operationId)).toBe(1);

    const conflict = await enterpriseErrorOf(() =>
      createPrincipal(identityOperatorDatabase, {
        ...input,
        userId: USER_C,
      }),
    );
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.status).toBe(409);
    expect(await identityEventCount(input.operationId)).toBe(1);
  });
});

describe("suspendPrincipal is idempotent, audited and never restores", () => {
  test("suspension lands once, replays return the recorded result, and a second operation does not restore", async () => {
    const input = {
      principalId: PRINCIPAL_C,
      operator: IDENTITY_OPERATOR,
      operationId: "prov-t1c-op-idp-suspend-c",
    };
    const first = await suspendPrincipal(identityOperatorDatabase, input);
    expect(first.changed).toBe(true);
    expect(await principalStatusOf(PRINCIPAL_C)).toBe("suspended");

    const replay = await suspendPrincipal(identityOperatorDatabase, input);
    expect(replay).toEqual(first);
    expect(await principalStatusOf(PRINCIPAL_C)).toBe("suspended");
    expect(await identityEventCount(input.operationId)).toBe(1);

    const again = await suspendPrincipal(identityOperatorDatabase, {
      ...input,
      operationId: "prov-t1c-op-idp-suspend-c2",
    });
    expect(again.changed).toBe(false);
    expect(await principalStatusOf(PRINCIPAL_C)).toBe("suspended");
  });

  test("suspending an unknown principal is rejected", async () => {
    const error = await enterpriseErrorOf(() =>
      suspendPrincipal(identityOperatorDatabase, {
        principalId: "prov-t1c-principal-missing",
        operator: IDENTITY_OPERATOR,
        operationId: "prov-t1c-op-idp-suspend-missing",
      }),
    );
    expect(error.code).toBe("PRINCIPAL_NOT_FOUND");
  });
});

describe("provisionMember is an explicit, idempotent open", () => {
  test("replaying the same operation does not raise the membership epoch", async () => {
    await provisionMember(operatorDatabase, provisionInputA);
    await provisionMember(operatorDatabase, provisionInputA);

    /* The plan's own read: the operator sees its tenant's rows only through the local context. */
    const rows = await operatorDatabase.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx.select().from(enterpriseMemberships);
    });
    expect(rows.find((row) => row.principalId === PRINCIPAL_A)?.epoch).toBe(1);
    expect(
      await securityEventCount(TENANT_A, provisionInputA.operationId),
    ).toBe(1);
  });

  test("a second member joins an existing tenant with the same name", async () => {
    const outcome = await provisionMember(operatorDatabase, {
      ...provisionInputA,
      principalId: PRINCIPAL_B,
      userId: USER_B,
      operationId: "prov-t1c-op-open-b",
    });
    expect(outcome.tenant).toBe("existing");
    expect(outcome.membershipEpoch).toBe(1);
    expect((await membershipOf(TENANT_A, PRINCIPAL_B))?.status).toBe("active");
  });

  test("the same operation running concurrently lands exactly once", async () => {
    const input = {
      ...provisionInputA,
      tenantId: TENANT_CONC,
      operationId: "prov-t1c-op-open-conc",
    };
    const outcomes = await Promise.all([
      provisionMember(operatorDatabase, input),
      provisionMember(operatorDatabase, input),
    ]);
    /* toEqual, not stringified comparison: a recorded result round-trips through jsonb, which
     * reorders object keys — equal content, different key order. */
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect((await membershipOf(TENANT_CONC, PRINCIPAL_A))?.epoch).toBe(1);
    expect(await securityEventCount(TENANT_CONC, input.operationId)).toBe(1);
  });

  test("the same operation id with a different payload is a conflict", async () => {
    const error = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        tenantName: "A Different Name",
      }),
    );
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.status).toBe(409);
    const tenant = await ownerDatabase
      .select({ name: enterpriseTenants.name })
      .from(enterpriseTenants)
      .where(eq(enterpriseTenants.id, TENANT_A))
      .limit(1);
    expect(tenant[0]?.name).toBe(TENANT_NAME);
  });

  test("a missing principal is rejected without creating the tenant or any audit event", async () => {
    const error = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        tenantId: TENANT_MISSING,
        principalId: "prov-t1c-principal-missing",
        operationId: "prov-t1c-op-open-missing",
      }),
    );
    expect(error.code).toBe("PRINCIPAL_NOT_FOUND");
    expect(await tenantExists(TENANT_MISSING)).toBe(false);
    expect(await securityEventCount(TENANT_MISSING)).toBe(0);
  });

  test("an existing tenant must keep its name and stay active", async () => {
    /* PRINCIPAL_A is still active here; the principal check passes so the refusal below is the
     * tenant's, in the plan's order (principal is validated before the tenant is touched). */
    const renamed = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        tenantName: "Renamed Tenant",
        operationId: "prov-t1c-op-open-a-wrongname",
      }),
    );
    expect(renamed.code).toBe("TENANT_CONFLICT");

    await ownerDatabase
      .update(enterpriseTenants)
      .set({ status: "suspended" })
      .where(eq(enterpriseTenants.id, TENANT_A));
    const suspended = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        operationId: "prov-t1c-op-open-a-suspended",
      }),
    );
    expect(suspended.code).toBe("TENANT_NOT_ACTIVE");
    expect((await membershipOf(TENANT_A, PRINCIPAL_A))?.status).toBe("active");
    await ownerDatabase
      .update(enterpriseTenants)
      .set({ status: "active" })
      .where(eq(enterpriseTenants.id, TENANT_A));
  });

  test("an existing membership must keep its role", async () => {
    const error = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        role: "auditor",
        operationId: "prov-t1c-op-open-a-role",
      }),
    );
    expect(error.code).toBe("MEMBERSHIP_CONFLICT");
    expect((await membershipOf(TENANT_A, PRINCIPAL_A))?.role).toBe("member");
  });

  test("a globally suspended principal cannot be opened into a tenant", async () => {
    /* PRINCIPAL_C was suspended by the identity operator earlier in this file. */
    const error = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        tenantId: "prov-t1c-tenant-suspended-principal",
        principalId: PRINCIPAL_C,
        userId: USER_C,
        operationId: "prov-t1c-op-open-c-principal-suspended",
      }),
    );
    expect(error.code).toBe("PRINCIPAL_SUSPENDED");
    expect(await tenantExists("prov-t1c-tenant-suspended-principal")).toBe(
      false,
    );
  });

  test("inputs outside the strict schema are rejected before any transaction", async () => {
    await expect(
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        unexpected: "field",
      }),
    ).rejects.toThrow();
    await expect(
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        role: "superuser",
      }),
    ).rejects.toThrow();
  });

  test("an API role login cannot run provisioning operations", async () => {
    const error = await rejectionOf(() =>
      provisionMember(dataDatabase, {
        ...provisionInputA,
        tenantId: TENANT_DAROLE,
        operationId: "prov-t1c-op-open-datarole",
      }),
    );
    expect(error.code).toBe("42501");
    expect(error.message).toContain("permission denied for table");
    expect(await tenantExists(TENANT_DAROLE)).toBe(false);
  });
});

describe("suspendMember is a versioned revocation", () => {
  test("suspension bumps the epoch exactly once and replays change nothing", async () => {
    const input = {
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "prov-t1c-op-suspend-a",
    };
    const first = await suspendMember(operatorDatabase, input);
    expect(first.changed).toBe(true);
    expect(first.membershipEpoch).toBe(2);

    const membership = await membershipOf(TENANT_A, PRINCIPAL_A);
    expect(membership?.status).toBe("suspended");
    expect(membership?.epoch).toBe(2);

    const replay = await suspendMember(operatorDatabase, input);
    expect(replay).toEqual(first);
    expect((await membershipOf(TENANT_A, PRINCIPAL_A))?.epoch).toBe(2);
    expect(await securityEventCount(TENANT_A, input.operationId)).toBe(1);
  });

  test("suspending an already suspended member records the no-change result without raising the epoch", async () => {
    const outcome = await suspendMember(operatorDatabase, {
      tenantId: TENANT_A,
      principalId: PRINCIPAL_A,
      operator: OPERATOR,
      operationId: "prov-t1c-op-suspend-a2",
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.membershipEpoch).toBe(2);
    expect(await securityEventCount(TENANT_A, "prov-t1c-op-suspend-a2")).toBe(
      1,
    );
  });

  test("replaying the original provision does not reactivate the suspended member", async () => {
    const replay = await provisionMember(operatorDatabase, provisionInputA);
    expect(replay.membershipStatus).toBe("active");
    expect(replay.membershipEpoch).toBe(1);
    const membership = await membershipOf(TENANT_A, PRINCIPAL_A);
    expect(membership?.status).toBe("suspended");
    expect(membership?.epoch).toBe(2);
  });

  test("suspending an unknown membership is rejected", async () => {
    const error = await enterpriseErrorOf(() =>
      suspendMember(operatorDatabase, {
        tenantId: TENANT_A,
        principalId: PRINCIPAL_C,
        operator: OPERATOR,
        operationId: "prov-t1c-op-suspend-unknown",
      }),
    );
    expect(error.code).toBe("MEMBERSHIP_NOT_FOUND");
  });
});

describe("createWorkspace is a controlled, idempotent open", () => {
  test("a workspace is created once, identical retries are no-ops and replays stay single", async () => {
    const input = {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_MAIN,
      name: "Main Workspace",
      operator: OPERATOR,
      operationId: "prov-t1c-op-ws-main",
    };
    const first = await createWorkspace(operatorDatabase, input);
    expect(first.created).toBe(true);

    const retry = await createWorkspace(operatorDatabase, {
      ...input,
      operationId: "prov-t1c-op-ws-main-2",
    });
    expect(retry.created).toBe(false);

    const replay = await createWorkspace(operatorDatabase, input);
    expect(replay).toEqual(first);
    expect(await securityEventCount(TENANT_A, input.operationId)).toBe(1);

    const rows = await ownerDatabase
      .select({ id: enterpriseWorkspaces.id })
      .from(enterpriseWorkspaces)
      .where(
        and(
          eq(enterpriseWorkspaces.tenantId, TENANT_A),
          eq(enterpriseWorkspaces.id, WORKSPACE_MAIN),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("the same id with a different name conflicts, and unknown or suspended tenants are refused", async () => {
    const renamed = await enterpriseErrorOf(() =>
      createWorkspace(operatorDatabase, {
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_MAIN,
        name: "Renamed Workspace",
        operator: OPERATOR,
        operationId: "prov-t1c-op-ws-rename",
      }),
    );
    expect(renamed.code).toBe("WORKSPACE_CONFLICT");

    const unknown = await enterpriseErrorOf(() =>
      createWorkspace(operatorDatabase, {
        tenantId: "prov-t1c-tenant-unknown",
        workspaceId: "prov-t1c-workspace-unknown",
        name: "Unknown",
        operator: OPERATOR,
        operationId: "prov-t1c-op-ws-unknown",
      }),
    );
    expect(unknown.code).toBe("TENANT_NOT_FOUND");

    await ownerDatabase
      .update(enterpriseTenants)
      .set({ status: "suspended" })
      .where(eq(enterpriseTenants.id, TENANT_A));
    const suspended = await enterpriseErrorOf(() =>
      createWorkspace(operatorDatabase, {
        tenantId: TENANT_A,
        workspaceId: "prov-t1c-workspace-nope",
        name: "Nope",
        operator: OPERATOR,
        operationId: "prov-t1c-op-ws-suspended",
      }),
    );
    expect(suspended.code).toBe("TENANT_NOT_ACTIVE");
    await ownerDatabase
      .update(enterpriseTenants)
      .set({ status: "active" })
      .where(eq(enterpriseTenants.id, TENANT_A));
  });
});

describe("createResource only accepts same-tenant workspaces and approved kinds", () => {
  test("a resource starts at revision 1 and acl epoch 1; identical retries add nothing", async () => {
    const input = {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_MAIN,
      resourceId: RESOURCE_MAIN,
      kind: "document",
      operator: OPERATOR,
      operationId: "prov-t1c-op-res-main",
    };
    const first = await createResource(operatorDatabase, input);
    expect(first.created).toBe(true);
    expect(first.revision).toBe(1);
    expect(first.aclEpoch).toBe(1);

    const retry = await createResource(operatorDatabase, {
      ...input,
      operationId: "prov-t1c-op-res-main-2",
    });
    expect(retry.created).toBe(false);
    expect(retry.aclEpoch).toBe(1);

    const replay = await createResource(operatorDatabase, input);
    expect(replay).toEqual(first);
    expect(await aclEpochOf(TENANT_A, RESOURCE_MAIN)).toBe(1);
  });

  test("the same id with different content conflicts, another tenant's workspace is invisible, and unapproved kinds are rejected", async () => {
    /* A real second tenant with a real workspace, so the cross-tenant case is not an empty table. */
    await provisionMember(operatorDatabase, {
      ...provisionInputA,
      tenantId: TENANT_OTHER,
      principalId: PRINCIPAL_B,
      userId: USER_B,
      operationId: "prov-t1c-op-open-b-other",
    });
    await createWorkspace(operatorDatabase, {
      tenantId: TENANT_OTHER,
      workspaceId: WORKSPACE_OTHER,
      name: "Other Workspace",
      operator: OPERATOR,
      operationId: "prov-t1c-op-ws-other",
    });

    /* A real second workspace in the same tenant, so the conflict case is about the resource's
     * content, not a workspace that does not exist. */
    await createWorkspace(operatorDatabase, {
      tenantId: TENANT_A,
      workspaceId: "prov-t1c-workspace-alt",
      name: "Alternate Workspace",
      operator: OPERATOR,
      operationId: "prov-t1c-op-ws-alt",
    });

    const different = await enterpriseErrorOf(() =>
      createResource(operatorDatabase, {
        tenantId: TENANT_A,
        workspaceId: "prov-t1c-workspace-alt",
        resourceId: RESOURCE_MAIN,
        kind: "document",
        operator: OPERATOR,
        operationId: "prov-t1c-op-res-different",
      }),
    );
    expect(different.code).toBe("RESOURCE_CONFLICT");

    const crossTenant = await enterpriseErrorOf(() =>
      createResource(operatorDatabase, {
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_OTHER,
        resourceId: "prov-t1c-resource-cross",
        kind: "document",
        operator: OPERATOR,
        operationId: "prov-t1c-op-res-cross",
      }),
    );
    expect(crossTenant.code).toBe("WORKSPACE_NOT_FOUND");

    await expect(
      createResource(operatorDatabase, {
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_MAIN,
        resourceId: "prov-t1c-resource-kind",
        kind: "virtual-machine",
        operator: OPERATOR,
        operationId: "prov-t1c-op-res-kind",
      }),
    ).rejects.toThrow();
  });
});

describe("grantRead and revokeRead are the only ACL door", () => {
  test("granting read bumps the resource acl epoch only when the grant is actually new", async () => {
    const input = {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-grant-1",
    };
    const first = await grantRead(operatorDatabase, input);
    expect(first.granted).toBe(true);
    expect(first.aclEpoch).toBe(2);
    expect(
      await grantRowOf(TENANT_A, RESOURCE_MAIN, PRINCIPAL_B),
    ).toBeDefined();

    const again = await grantRead(operatorDatabase, {
      ...input,
      operationId: "prov-t1c-op-grant-2",
    });
    expect(again.granted).toBe(false);
    expect(again.aclEpoch).toBe(2);

    const replay = await grantRead(operatorDatabase, input);
    expect(replay).toEqual(first);
    expect(await securityEventCount(TENANT_A, input.operationId)).toBe(1);
    expect(await aclEpochOf(TENANT_A, RESOURCE_MAIN)).toBe(2);
  });

  test("granting requires an active principal, an active membership and an existing resource", async () => {
    const suspendedMember = await enterpriseErrorOf(() =>
      grantRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: RESOURCE_MAIN,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: "prov-t1c-op-grant-a",
      }),
    );
    expect(suspendedMember.code).toBe("MEMBER_NOT_ACTIVE");

    const unknownPrincipal = await enterpriseErrorOf(() =>
      grantRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: RESOURCE_MAIN,
        principalId: "prov-t1c-principal-missing",
        operator: OPERATOR,
        operationId: "prov-t1c-op-grant-missing",
      }),
    );
    expect(unknownPrincipal.code).toBe("PRINCIPAL_NOT_FOUND");

    const unknownResource = await enterpriseErrorOf(() =>
      grantRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: "prov-t1c-resource-missing",
        principalId: PRINCIPAL_B,
        operator: OPERATOR,
        operationId: "prov-t1c-op-grant-nores",
      }),
    );
    expect(unknownResource.code).toBe("RESOURCE_NOT_FOUND");
  });

  test("revoking removes the grant and bumps the epoch; an absent grant is an audited no-change", async () => {
    const revoke = await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-revoke-1",
    });
    expect(revoke.revoked).toBe(true);
    expect(revoke.aclEpoch).toBe(3);
    expect(
      await grantRowOf(TENANT_A, RESOURCE_MAIN, PRINCIPAL_B),
    ).toBeUndefined();

    const absent = await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-revoke-2",
    });
    expect(absent.revoked).toBe(false);
    expect(absent.aclEpoch).toBe(3);
    expect(await securityEventCount(TENANT_A, "prov-t1c-op-revoke-2")).toBe(1);
  });

  test("replaying the earlier grant operation after revocation does not re-grant", async () => {
    const replay = await grantRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-grant-1",
    });
    expect(replay.granted).toBe(true);
    expect(
      await grantRowOf(TENANT_A, RESOURCE_MAIN, PRINCIPAL_B),
    ).toBeUndefined();
    expect(await aclEpochOf(TENANT_A, RESOURCE_MAIN)).toBe(3);
  });

  test("revocation tolerates an already suspended member", async () => {
    const grant = await grantRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-grant-3",
    });
    expect(grant.aclEpoch).toBe(4);

    await suspendMember(operatorDatabase, {
      tenantId: TENANT_A,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-suspend-b",
    });
    expect((await membershipOf(TENANT_A, PRINCIPAL_B))?.epoch).toBe(2);

    const revoke = await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: RESOURCE_MAIN,
      principalId: PRINCIPAL_B,
      operator: OPERATOR,
      operationId: "prov-t1c-op-revoke-3",
    });
    expect(revoke.revoked).toBe(true);
    expect(revoke.aclEpoch).toBe(5);
    expect(
      await grantRowOf(TENANT_A, RESOURCE_MAIN, PRINCIPAL_B),
    ).toBeUndefined();
  });
});

describe("a corrupt audit record fails the operation closed", () => {
  test("an unparseable prior security event blocks the open and leaves no membership behind", async () => {
    /*
     * Planted through the typed query builder on the owner login (bound values). The event id is
     * the operation id the open will replay against, and its details deliberately fail the strict
     * stored-event schema — the plan requires every prior event to be re-validated before an
     * operation may treat itself as a replay, so this must refuse rather than guess.
     */
    await ownerDatabase
      .insert(enterpriseTenants)
      .values({ id: TENANT_AUDITFAIL, name: TENANT_NAME });
    await ownerDatabase.insert(enterpriseSecurityEvents).values({
      tenantId: TENANT_AUDITFAIL,
      id: "prov-t1c-op-open-auditfail",
      operationId: "prov-t1c-op-open-auditfail",
      actor: "prov-t1c-corrupt-audit",
      kind: "membership.provisioned",
      details: { noise: true },
    });

    const error = await enterpriseErrorOf(() =>
      provisionMember(operatorDatabase, {
        ...provisionInputA,
        tenantId: TENANT_AUDITFAIL,
        operationId: "prov-t1c-op-open-auditfail",
      }),
    );
    expect(error.code).toBe("SECURITY_EVENT_UNREADABLE");
    expect(await membershipOf(TENANT_AUDITFAIL, PRINCIPAL_A)).toBeUndefined();
    expect(
      await securityEventCount(TENANT_AUDITFAIL, "prov-t1c-op-open-auditfail"),
    ).toBe(1);
  });
});

describe("the tenant operator CLI writes only with --apply --operation-id", () => {
  test("dry-run prints a redacted plan and writes nothing", async () => {
    const run = await provisionCli([
      "provision-member",
      "--input",
      JSON.stringify({
        tenantId: TENANT_DRYRUN,
        tenantName: "Dry Run Tenant",
        principalId: PRINCIPAL_A,
        userId: USER_A,
        role: "member",
      }),
      "--operator",
      OPERATOR,
      "--operation-id",
      "prov-t1c-op-cli-dryrun",
    ]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("dry-run");
    expect(run.out).not.toContain(CONNECTION_SECRET);
    expect(run.out).not.toContain("postgres://");
    expect(run.err).not.toContain(CONNECTION_SECRET);
    expect(await tenantExists(TENANT_DRYRUN)).toBe(false);
  });

  test("--apply --operation-id provisions a member end to end", async () => {
    const run = await provisionCli([
      "provision-member",
      "--input",
      JSON.stringify({
        tenantId: TENANT_CLI,
        tenantName: "CLI Tenant",
        principalId: PRINCIPAL_B,
        userId: USER_B,
        role: "tenant_admin",
      }),
      "--operator",
      OPERATOR,
      "--operation-id",
      "prov-t1c-op-cli-apply",
      "--apply",
    ]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("applied");
    expect(run.out).not.toContain(CONNECTION_SECRET);
    expect(run.err).not.toContain(CONNECTION_SECRET);
    const membership = await membershipOf(TENANT_CLI, PRINCIPAL_B);
    expect(membership?.role).toBe("tenant_admin");
    expect(membership?.epoch).toBe(1);
  });

  test("the CLI refuses --apply without its URL, unknown commands and flags, and non-strict input", async () => {
    const noUrl = await provisionCli(
      [
        "provision-member",
        "--input",
        JSON.stringify({
          tenantId: "prov-t1c-tenant-nourl",
          tenantName: "No URL",
          principalId: PRINCIPAL_A,
          userId: USER_A,
          role: "member",
        }),
        "--operator",
        OPERATOR,
        "--operation-id",
        "prov-t1c-op-cli-nourl",
        "--apply",
      ],
      { ENTERPRISE_OPERATOR_DATABASE_URL: undefined },
    );
    expect(noUrl.code).not.toBe(0);
    expect(noUrl.err).toContain("ENTERPRISE_OPERATOR_DATABASE_URL");
    expect(await tenantExists("prov-t1c-tenant-nourl")).toBe(false);

    expect(
      (
        await provisionCli([
          "grant-write",
          "--input",
          "{}",
          "--operator",
          OPERATOR,
          "--operation-id",
          "prov-t1c-op-cli-unknown",
        ])
      ).code,
    ).not.toBe(0);

    expect(
      (
        await provisionCli([
          "provision-member",
          "--surprise",
          "1",
          "--operator",
          OPERATOR,
          "--operation-id",
          "prov-t1c-op-cli-flag",
        ])
      ).code,
    ).not.toBe(0);

    const strict = await provisionCli([
      "provision-member",
      "--input",
      JSON.stringify({
        tenantId: "prov-t1c-tenant-strict",
        tenantName: "Strict",
        principalId: PRINCIPAL_A,
        userId: USER_A,
        role: "member",
        surprise: true,
      }),
      "--operator",
      OPERATOR,
      "--operation-id",
      "prov-t1c-op-cli-strict",
    ]);
    expect(strict.code).not.toBe(0);
    expect(await tenantExists("prov-t1c-tenant-strict")).toBe(false);

    const noOperationId = await provisionCli([
      "provision-member",
      "--input",
      JSON.stringify({
        tenantId: "prov-t1c-tenant-noop",
        tenantName: "No Op",
        principalId: PRINCIPAL_A,
        userId: USER_A,
        role: "member",
      }),
      "--operator",
      OPERATOR,
      "--apply",
    ]);
    expect(noOperationId.code).not.toBe(0);
  });
});
