import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadIdentityConfig } from "../../../src/config";
import { createDatabase, type Database } from "../../../src/db/client";
import { revokedAccess } from "../../../src/db/schema";
import { REQUIRED_AUTH_ROUTES } from "../../../src/enterprise/auth-route-profile";
import {
  bootstrapEnterprise,
  createRevocationCheck,
  type DatabaseFactory,
} from "../../../src/enterprise/bootstrap";
import type { EnterpriseConfig } from "../../../src/enterprise/config";
import { testDatabaseUrlFrom } from "../../support/database";
import { testEnvironment } from "../../support/environment";

/*
 * The standalone enterprise entry's bootstrap and process lifecycle, per plan 02 §7 T3-C.
 *
 * Three claims are under test, and each has its own section:
 *
 *   1. A boot that fails part-way does not leak the connections it already opened (step 1). The
 *      third pool failing must close the first two exactly once and re-raise the original error —
 *      the entry never gets to listen on a half-built deployment.
 *   2. Before listening, every login is checked against the live database role contract (step 3,
 *      TEN-16): not a superuser, not bypassing RLS, not a member of the operator roles, not able to
 *      assume any enterprise table's owner, and — for the directory and data logins only — every
 *      enterprise table present with ENABLE + FORCE row-level security. The identity login is
 *      deliberately NOT asked for RLS on identity tables; it is only asked to hold no enterprise
 *      data powers.
 *   3. Readiness probes exactly the three databases the entry depends on, caches the health answer
 *      (not any authorization decision) for one second, and draining turns ready=false immediately
 *      while /health/live stays 200 (step 4, TEN-19).
 *
 * The unit sections run on injectable fake pools; the last section runs the same bootstrap against
 * the real enterprise test database through the restricted logins named in the workflow env file.
 */

/* ---------------------------------------------------------------------------
 * Shared shape: an EnterpriseConfig for tests, resolved from identity fields alone.
 * ------------------------------------------------------------------------- */

const base = testEnvironment();
const IDENTITY_ONLY = {
  GOOGLE_OAUTH_CLIENT_ID: base.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: base.GOOGLE_OAUTH_CLIENT_SECRET,
  BETTER_AUTH_SECRET: base.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: base.BETTER_AUTH_URL,
  INITIAL_ADMIN_EMAILS: base.INITIAL_ADMIN_EMAILS,
};

const resolvedAuth = loadIdentityConfig(IDENTITY_ONLY);
if (!resolvedAuth) {
  throw new Error("the identity fields must resolve an AuthConfig");
}

/** A real 32-byte key (not the public placeholder), so the key check passes on merit. */
const REAL_KEY = "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=";

function enterpriseConfig(urls: {
  authDatabaseUrl: string;
  directoryDatabaseUrl: string;
  dataDatabaseUrl: string;
}): EnterpriseConfig {
  if (!resolvedAuth) {
    throw new Error("the identity fields must resolve an AuthConfig");
  }
  return {
    port: 3101,
    hostname: "127.0.0.1",
    auth: resolvedAuth,
    keyEncryptionKey: REAL_KEY,
    allowedOrigins: new Set(["http://127.0.0.1:3010"]),
    authRoutes: new Set(REQUIRED_AUTH_ROUTES),
    shutdownGraceMs: 15000,
    ...urls,
  };
}

/** Nobody can dial port 1; nothing here connects, the strings only have to be distinct. */
const UNIT_URLS = {
  authDatabaseUrl:
    "postgres://ent_identity:ent-identity-not-a-secret@127.0.0.1:1/openbot_enterprise_test",
  directoryDatabaseUrl:
    "postgres://ent_directory:ent-directory-not-a-secret@127.0.0.1:1/openbot_enterprise_test",
  dataDatabaseUrl:
    "postgres://ent_data:ent-data-not-a-secret@127.0.0.1:1/openbot_enterprise_test",
};

/* ---------------------------------------------------------------------------
 * Fake pools: the DatabaseFactory seam (plan step 1).
 * ------------------------------------------------------------------------- */

const ENTERPRISE_TABLE_NAMES = [
  "enterprise_principals",
  "enterprise_memberships",
  "enterprise_tenants",
  "enterprise_workspaces",
  "enterprise_resources",
  "enterprise_resource_grants",
] as const;

type RoleRow = Record<string, unknown>;
type TableRow = Record<string, unknown>;

const healthyRole = (userName: string): RoleRow[] => [
  {
    user_name: userName,
    superuser: false,
    bypasses_rls: false,
    operator_member: false,
    identity_operator_member: false,
  },
];

const healthyTables = (): TableRow[] =>
  ENTERPRISE_TABLE_NAMES.map((name) => ({
    table_name: name,
    rls_enabled: true,
    rls_forced: true,
    can_assume_owner: false,
  }));

/*
 * The bootstrap's statements are module-constant texts executed through `unsafe`, so a fake pool
 * tells the role query from the table query by the text itself — no interpolation ever happens.
 */

type FakePool = {
  database: Database;
  closeCount: number;
  probeCount: number;
  failClose: () => void;
  breakConnections: () => void;
};

function fakePool(options: {
  userName: string;
  roleRows?: RoleRow[];
  tableRows?: TableRow[];
}): FakePool {
  const pool: FakePool = {
    closeCount: 0,
    probeCount: 0,
    database: undefined as unknown as Database,
    failClose: () => {
      failOnClose = true;
    },
    breakConnections: () => {
      broken = true;
    },
  };
  let failOnClose = false;
  let broken = false;
  const roleRows = options.roleRows ?? healthyRole(options.userName);
  const tableRows = options.tableRows ?? healthyTables();

  pool.database = {
    $client: {
      close: async () => {
        if (failOnClose) throw new Error("close refused");
        pool.closeCount += 1;
      },
      unsafe: async (text: string) => {
        if (broken) throw new Error("ERR_POSTGRES_CONNECTION_CLOSED");
        if (text.includes("pg_roles")) return roleRows;
        if (text.includes("pg_class")) return tableRows;
        return [];
      },
      begin: async (
        callback: (tx: {
          unsafe: (text: string) => Promise<unknown[]>;
        }) => Promise<unknown>,
      ) => {
        if (broken) throw new Error("ERR_POSTGRES_CONNECTION_CLOSED");
        pool.probeCount += 1;
        return callback({ unsafe: async () => [] });
      },
    },
  } as unknown as Database;
  return pool;
}

/** A factory handing out the given pools in order, or throwing on a chosen URL. */
function fakeFactory(
  pools: FakePool[],
  failOnUrl?: string,
): { factory: DatabaseFactory; pools: FakePool[] } {
  let handed = 0;
  return {
    pools,
    factory: (url: string) => {
      if (url === failOnUrl) throw new Error("connection refused by the test");
      const pool = pools[handed];
      handed += 1;
      if (!pool) throw new Error("the test handed the factory too few pools");
      return pool.database;
    },
  };
}

const healthyUnitPools = () => [
  fakePool({ userName: "ent_identity" }),
  fakePool({ userName: "ent_directory" }),
  fakePool({ userName: "ent_data" }),
];

/* ---------------------------------------------------------------------------
 * 1. A failed boot closes what it opened (plan T3-C step 1).
 * ------------------------------------------------------------------------- */

describe("a failed boot closes the connections it already opened", () => {
  test("the third pool failing closes the first two exactly once and re-raises", async () => {
    const pools = healthyUnitPools();
    const { factory } = fakeFactory(pools, UNIT_URLS.dataDatabaseUrl);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("connection refused by the test");

    expect(pools[0]?.closeCount).toBe(1);
    expect(pools[1]?.closeCount).toBe(1);
    /* The third pool never existed; nothing to close. */
    expect(pools[2]?.closeCount).toBe(0);
  });

  test("a role-check failure closes all three pools before the stable error is raised", async () => {
    const pools = healthyUnitPools();
    pools[2] = fakePool({
      userName: "ent_data",
      roleRows: [
        {
          user_name: "ent_data",
          superuser: true,
          bypasses_rls: false,
          operator_member: false,
          identity_operator_member: false,
        },
      ],
    });
    const { factory } = fakeFactory(pools);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("ENTERPRISE_BOOT_ROLE_SUPERUSER");

    for (const pool of pools) {
      expect(pool.closeCount).toBe(1);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The startup role and schema checks (plan T3-C step 3, TEN-16).
 * ------------------------------------------------------------------------- */

describe("the startup role checks refuse a login with deployment powers", () => {
  const refusedRoles: ReadonlyArray<{
    over: string;
    patch: Partial<{
      superuser: boolean;
      bypasses_rls: boolean;
      operator_member: boolean;
      identity_operator_member: boolean;
    }>;
    error: string;
  }> = [
    {
      over: "superuser",
      patch: { superuser: true },
      error: "ENTERPRISE_BOOT_ROLE_SUPERUSER",
    },
    {
      over: "RLS bypass",
      patch: { bypasses_rls: true },
      error: "ENTERPRISE_BOOT_ROLE_BYPASSRLS",
    },
    {
      over: "operator membership",
      patch: { operator_member: true },
      error: "ENTERPRISE_BOOT_ROLE_OPERATOR_MEMBER",
    },
    {
      over: "identity-operator membership",
      patch: { identity_operator_member: true },
      error: "ENTERPRISE_BOOT_ROLE_OPERATOR_MEMBER",
    },
  ];

  for (const refusal of refusedRoles) {
    test(`a data login that is ${refusal.over} never starts`, async () => {
      const pools = healthyUnitPools();
      pools[2] = fakePool({
        userName: "ent_data",
        roleRows: [
          { ...healthyRole("ent_data")[0], ...refusal.patch } as RoleRow,
        ],
      });
      const { factory } = fakeFactory(pools);

      await expect(
        bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
          createDatabase: factory,
        }),
      ).rejects.toThrow(refusal.error);
    });
  }

  test("the same refusal applies to the identity and directory logins", async () => {
    for (const index of [0, 1]) {
      const pools = healthyUnitPools();
      pools[index] = fakePool({
        userName: "over-privileged",
        roleRows: [
          {
            ...healthyRole("over-privileged")[0],
            operator_member: true,
          } as RoleRow,
        ],
      });
      const { factory } = fakeFactory(pools);

      await expect(
        bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
          createDatabase: factory,
        }),
      ).rejects.toThrow("ENTERPRISE_BOOT_ROLE_OPERATOR_MEMBER");
    }
  });
});

describe("the startup schema checks refuse an unarmed enterprise boundary", () => {
  test("a missing enterprise table never starts", async () => {
    const pools = healthyUnitPools();
    pools[2] = fakePool({
      userName: "ent_data",
      tableRows: healthyTables().slice(0, 5),
    });
    const { factory } = fakeFactory(pools);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("ENTERPRISE_BOOT_TABLE_MISSING");
  });

  test("RLS disabled on one enterprise table never starts", async () => {
    const pools = healthyUnitPools();
    pools[2] = fakePool({
      userName: "ent_data",
      tableRows: healthyTables().map((row, index) =>
        index === 3 ? { ...row, rls_enabled: false } : row,
      ),
    });
    const { factory } = fakeFactory(pools);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("ENTERPRISE_BOOT_TABLE_RLS_DISABLED");
  });

  test("FORCE RLS missing on one enterprise table never starts", async () => {
    const pools = healthyUnitPools();
    pools[2] = fakePool({
      userName: "ent_data",
      tableRows: healthyTables().map((row, index) =>
        index === 2 ? { ...row, rls_forced: false } : row,
      ),
    });
    const { factory } = fakeFactory(pools);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("ENTERPRISE_BOOT_TABLE_RLS_DISABLED");
  });

  test("a login that could assume a table owner never starts (TEN-16)", async () => {
    const pools = healthyUnitPools();
    pools[1] = fakePool({
      userName: "ent_directory",
      tableRows: healthyTables().map((row, index) =>
        index === 0 ? { ...row, can_assume_owner: true } : row,
      ),
    });
    const { factory } = fakeFactory(pools);

    await expect(
      bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
        createDatabase: factory,
      }),
    ).rejects.toThrow("ENTERPRISE_BOOT_TABLE_OWNER_ASSUMABLE");
  });

  test("the identity login is not asked for RLS, only for holding no enterprise powers", async () => {
    /* The identity tables carry no RLS in this deployment, so the identity login's view of the
     * enterprise tables may legitimately report rls disabled — what must still hold is that it
     * cannot assume any enterprise table's owner. This boot SUCCEEDS and then closes cleanly. */
    const pools = healthyUnitPools();
    pools[0] = fakePool({
      userName: "ent_identity",
      tableRows: healthyTables().map((row) => ({
        ...row,
        rls_enabled: false,
        rls_forced: false,
      })),
    });
    const { factory } = fakeFactory(pools);

    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });
    expect((await enterprise.app.request("/health/live")).status).toBe(200);
    await enterprise.close();
    for (const pool of pools) {
      expect(pool.closeCount).toBe(1);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. Readiness, draining and close (plan T3-C step 4, TEN-19).
 * ------------------------------------------------------------------------- */

describe("readiness probes only the three databases and caches the health answer", () => {
  test("a healthy boot reports ready, and the one-second cache avoids re-probing", async () => {
    const pools = healthyUnitPools();
    const { factory } = fakeFactory(pools);
    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });

    expect((await enterprise.app.request("/health/ready")).status).toBe(200);
    expect((await enterprise.app.request("/health/ready")).status).toBe(200);
    for (const pool of pools) {
      expect(pool.probeCount).toBe(1);
    }
    await enterprise.close();
  });

  test("beginDrain turns ready=false at once: ready 503, live 200, business 503", async () => {
    const pools = healthyUnitPools();
    const { factory } = fakeFactory(pools);
    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });

    enterprise.beginDrain();

    expect((await enterprise.app.request("/health/ready")).status).toBe(503);
    expect((await enterprise.app.request("/health/live")).status).toBe(200);
    expect(
      (await enterprise.app.request("/api/enterprise/v1/tenants")).status,
    ).toBe(503);
    await enterprise.close();
  });

  test("a database failure flips ready to 503 while live stays 200 (TEN-19)", async () => {
    const pools = healthyUnitPools();
    const { factory } = fakeFactory(pools);
    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });
    expect((await enterprise.app.request("/health/ready")).status).toBe(200);

    /* Past the one-second cache window, then every pool refuses: the entry stays live and reports
     * itself unavailable rather than serving a cached "healthy". */
    await new Promise((resolve) => setTimeout(resolve, 1050));
    for (const pool of pools) pool.breakConnections();

    expect((await enterprise.app.request("/health/ready")).status).toBe(503);
    expect((await enterprise.app.request("/health/live")).status).toBe(200);
    await enterprise.close();
  });
});

describe("close shuts every pool, and a failed close is a stable error", () => {
  test("close settles all three pools", async () => {
    const pools = healthyUnitPools();
    const { factory } = fakeFactory(pools);
    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });

    await enterprise.close();
    for (const pool of pools) {
      expect(pool.closeCount).toBe(1);
    }
  });

  test("one pool refusing to close raises ENTERPRISE_DATABASE_CLOSE_FAILED", async () => {
    const pools = healthyUnitPools();
    pools[1]?.failClose();
    const { factory } = fakeFactory(pools);
    const enterprise = await bootstrapEnterprise(enterpriseConfig(UNIT_URLS), {
      createDatabase: factory,
    });

    await expect(enterprise.close()).rejects.toThrow(
      "ENTERPRISE_DATABASE_CLOSE_FAILED",
    );
  });
});

/* ---------------------------------------------------------------------------
 * 4. The real database: the restricted logins the workflow env file names.
 * ------------------------------------------------------------------------- */

function restrictedUrl(variable: string): string {
  const url = process.env[variable];
  if (!url) {
    throw new Error(
      `${variable} must point at the enterprise test database (run with the workflow env file)`,
    );
  }
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: url });
}

const REAL_URLS = () => ({
  authDatabaseUrl: restrictedUrl("ENTERPRISE_TEST_AUTH_DATABASE_URL"),
  directoryDatabaseUrl: restrictedUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  dataDatabaseUrl: restrictedUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
});

describe("the revocation check reuses revoked_access exactly (plan T3-C step 2)", () => {
  test("a revoked address is matched through its trimmed lowercase form", async () => {
    /* The fixture row is planted by the migration OWNER (the identity login may only read the
     * table); the check itself runs on the restricted identity login, which is the connection the
     * bootstrap actually reads revocations through. */
    const ownerDb = createDatabase(
      testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
      { max: 1 },
    );
    const authDb = createDatabase(
      restrictedUrl("ENTERPRISE_TEST_AUTH_DATABASE_URL"),
      { max: 1 },
    );
    const email = "boot-t3c-revoked@enterprise-test.invalid";
    try {
      await ownerDb
        .insert(revokedAccess)
        .values({ email, revokedBy: "boot-t3c" })
        .onConflictDoNothing();
      const isRevoked = createRevocationCheck(authDb);

      expect(
        await isRevoked("  BOOT-T3C-REVOKED@Enterprise-Test.Invalid "),
      ).toBe(true);
      expect(await isRevoked("kept@enterprise-test.invalid")).toBe(false);
    } finally {
      await ownerDb.delete(revokedAccess).where(eq(revokedAccess.email, email));
      await Promise.allSettled([
        ownerDb.$client.close(),
        authDb.$client.close(),
      ]);
    }
  });
});

describe("bootstrap against the real enterprise test database", () => {
  test("boots from identity configuration alone and serves healthy endpoints (TEN-15)", async () => {
    const enterprise = await bootstrapEnterprise(enterpriseConfig(REAL_URLS()));

    expect((await enterprise.app.request("/health/live")).status).toBe(200);
    expect((await enterprise.app.request("/health/ready")).status).toBe(200);

    enterprise.beginDrain();
    expect((await enterprise.app.request("/health/ready")).status).toBe(503);
    expect((await enterprise.app.request("/health/live")).status).toBe(200);

    await enterprise.close();
  });

  test("the migration owner never starts the entry (TEN-16)", async () => {
    const ownerUrl = testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const ownerConfig = enterpriseConfig({
      authDatabaseUrl: ownerUrl,
      directoryDatabaseUrl: ownerUrl,
      dataDatabaseUrl: ownerUrl,
    });

    await expect(bootstrapEnterprise(ownerConfig)).rejects.toThrow(
      /ENTERPRISE_BOOT_ROLE_(SUPERUSER|BYPASSRLS|OPERATOR_MEMBER|TABLE_OWNER_ASSUMABLE)/,
    );
  });

  test("closed pools flip ready to 503 while live stays 200 (TEN-19)", async () => {
    const enterprise = await bootstrapEnterprise(enterpriseConfig(REAL_URLS()));
    expect((await enterprise.app.request("/health/ready")).status).toBe(200);

    await enterprise.close();
    await new Promise((resolve) => setTimeout(resolve, 1050));

    expect((await enterprise.app.request("/health/ready")).status).toBe(503);
    expect((await enterprise.app.request("/health/live")).status).toBe(200);
  });
});
