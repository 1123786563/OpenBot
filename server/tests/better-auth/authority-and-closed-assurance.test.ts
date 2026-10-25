import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  COMPANY_ASSURANCE_POLICY_REQUIRED,
  COMPANY_ASSURANCE_TARGET_REQUIRED,
  COMPANY_AUTH_NOT_READY,
  COMPANY_REAUTH_REQUIRED,
  CompanyAssuranceRefusal,
  createClosedCompanyAssurance,
} from "../../src/auth/company-assurance";
import {
  AUTHORITY_PHASES,
  AUTHORITY_STATE_MISSING,
  AUTHORITY_STATE_UNKNOWN,
  AUTHORITY_STATE_WITHOUT_TRANSACTION,
  AUTHORITY_VERSION_CONFLICT,
  AUTHORITY_VERSION_UNSAFE,
  AuthorityRefusal,
  createDirectoryAuthority,
  DIRECTORY_MIGRATION_PAUSED,
  DIRECTORY_WRITE_AUTHORITY_CLOSED,
  MULTI_TENANT_NOT_RELEASED,
} from "../../src/auth/directory/authority";
import type {
  DirectoryActor,
  DirectoryTx,
} from "../../src/auth/directory/contracts";
import { createDatabase } from "../../src/db/client";
import {
  type AuthorityMatrixFixture,
  withAuthorityMatrix,
} from "./support/authority-matrix";

/*
 * T02.10 (#532, P04) — the interim directory authority and the closed company
 * assurance adapter (interfaces §3.3, §5; design §9.1, §13.2).
 *
 * What this file pins, and why each part is a database fact or a real refusal
 * rather than a code convention:
 *
 * - `legacy_authority_keeps_existing_tenancy_green`: at M1 the legacy gate and
 *   writers keep working on a database where the BA clock, challenge and
 *   assurance tables do not even exist — the branch is allowed to read the
 *   authority row and nothing else, so an existing tenant is never refused by
 *   a migration it has not reached. `legacyStatus` is 200; a BA writer at M1
 *   is refused (BA runtime directory writes are closed before M4).
 * - `missing_authority_or_required_proof_fails_closed`: a deleted singleton
 *   row is refused as 503 AUTHORITY_STATE_MISSING for every writer — never
 *   guessed as legacy — and a company whose policy requires proof answers a
 *   controlled 403 COMPANY_REAUTH_REQUIRED, so `baStatus` is not 200.
 * - `paused_authority_rejects_every_directory_writer`: M2/M3 refuse the legacy
 *   AND the BA writer with 503 DIRECTORY_MIGRATION_PAUSED.
 * - `ba_authority_accepts_only_the_ba_writer`: M4..M7 accept exactly the BA
 *   writer; the legacy writer is closed.
 * - `authority_version_is_compared_before_any_branch`: a stale expected
 *   version is a 503 CAS conflict in every branch, and a version outside the
 *   Version domain is refused rather than wrapped.
 * - `authority_state_is_read_inside_the_callers_transaction`: an uncommitted
 *   CAS update is visible inside the command's transaction and invisible
 *   outside it until commit, and a rollback leaves the persisted row alone;
 *   reading on the pool (not inside a transaction) is refused.
 * - `unknown_or_unsafe_authority_state_is_refused_not_guessed`: a row the
 *   closed domains do not explain (phase/authority pair outside the state
 *   machine, version outside the safe-integer range) is a 503, never a branch.
 * - `release_gate_is_independent_of_authority_selection`: the release flag
 *   never selects the authority and the authority never releases; M1 can be
 *   released while still legacy, and M4 can write while still closed.
 * - `with_authority_matrix_covers_legacy_paused_and_ba`: the same request
 *   behaviour is asserted under all three persisted states through the shared
 *   fixture (P25 extends the scenario list, not the shape).
 * - `closed_company_assurance_requires_proof_and_refuses_interactive_halves`:
 *   the closed adapter cannot be constructed without its policy, returns null
 *   only for a company with no additional proof policy, refuses a
 *   proof-demanding company, and always refuses challenge/complete with 503
 *   COMPANY_AUTH_NOT_READY.
 *
 * The suite applies the real `0211_better_auth_command_authority` migration on
 * the isolated BA_TEST_* database (the AuthorityState seed is the fact these
 * gates read), and cleans up exactly what it created. The five BA_TEST_* role
 * URLs are all required; a missing one is a blocked suite, never a fallback to
 * the shared/MT/job-level database. No DSN is ever printed.
 */

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MIGRATION_TAG = "0211_better_auth_command_authority";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const AUTHORITY_TABLE = "auth_authority_states";
/**
 * Everything the migration above creates. The suite adds no rows outside
 * these tables, so dropping them returns the island to its pre-T02.10 shape.
 */
const SUITE_TABLES = [
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  AUTHORITY_TABLE,
] as const;
/** Number.MAX_SAFE_INTEGER: the Version domain's inclusive upper bound. */
const SAFE_MAX = 9007199254740991;

/** The proof question is always about a real company; the ids are test-only. */
const TENANT = "t0210-company";
const TENANT_WITHOUT_PROOF_POLICY = "t0210-company-no-proof";

const ACTOR: DirectoryActor = Object.freeze({
  userId: "t0210-user",
  principalId: "t0210-principal",
  sessionId: "t0210-session",
  kind: "session",
  bindingId: null,
  provisioning: null,
});

function shapeOf(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return `${host}:${url.port || "5432"}/${database}`;
}

/** All five URLs, shaped and naming one database; missing means blocked. */
function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the authority suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

/** Read lazily, so a missing migration fails the named target behavior. */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the ${AUTHORITY_TABLE} model (and its M1 seed this suite's branches read) is the T02.03 target behavior this task consumes, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** The three columns a scenario establishes, plus the independent release flag. */
interface AuthorityRowInput {
  authorityVersion: number;
  phase: string;
  directoryAuthority: string;
  multiTenantReleased: boolean;
}

interface Harness {
  /** Setup connection: DDL, the scenario's row, leak probe. */
  sql: postgres.Sql;
  /** The production client (drizzle over Bun SQL), for real transactions. */
  db: ReturnType<typeof createDatabase>;
  close(): Promise<void>;
}

/** Pre-T02.10 shape: this suite's tables and any crashed run's leftovers gone. */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
}

/**
 * The migration's own seed, restored between cases: M1, legacy, version 0,
 * release closed. Every case starts from a known authority instead of the
 * previous case's row.
 */
async function restoreSeed(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DELETE FROM "${AUTHORITY_TABLE}"`);
  await sql`
    INSERT INTO auth_authority_states
      (id, authority_version, phase, directory_authority, multi_tenant_released)
    VALUES (1, 0, 'M1', 'legacy', false)`;
}

async function setAuthority(
  sql: postgres.Sql,
  row: AuthorityRowInput,
): Promise<void> {
  await sql`
    UPDATE auth_authority_states
       SET authority_version = ${row.authorityVersion},
           phase = ${row.phase},
           directory_authority = ${row.directoryAuthority},
           multi_tenant_released = ${row.multiTenantReleased},
           updated_at = now()
     WHERE id = 1`;
}

interface HarnessState {
  harness: Harness;
  /** Runs `work` in one real transaction of the production client. */
  inTx<T>(work: (tx: DirectoryTx) => Promise<T>): Promise<T>;
  /** The persisted CAS counter, read on the setup connection (outside any tx). */
  persistedVersion(): Promise<number>;
  /** The persisted row, for "the read branch never wrote anything" checks. */
  persistedRow(): Promise<AuthorityRowInput | undefined>;
}

let state: HarnessState | undefined;

async function createHarness(): Promise<HarnessState> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupFixture(sql);
    await sql.unsafe(loadMigrationSql());
    const db = createDatabase(setupUrl, { max: 2 });
    const persistedRow = async () => {
      const [row] = await sql<
        {
          authority_version: string | number;
          phase: string;
          directory_authority: string;
          multi_tenant_released: boolean;
        }[]
      >`SELECT authority_version, phase, directory_authority, multi_tenant_released
          FROM auth_authority_states WHERE id = 1`;
      if (!row) return undefined;
      return {
        authorityVersion: Number(row.authority_version),
        phase: row.phase,
        directoryAuthority: row.directory_authority,
        multiTenantReleased: row.multi_tenant_released,
      };
    };
    const harness: Harness = {
      sql,
      db,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await db.$client.close?.();
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
    return {
      harness,
      inTx: (work) =>
        db.transaction((trx) => work(trx as unknown as DirectoryTx)),
      persistedVersion: async () =>
        (await persistedRow())?.authorityVersion ?? Number.NaN,
      persistedRow,
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

/** One harness per process; a setup failure is this suite's failure, not a skip. */
function harness(): HarnessState {
  if (!state) throw new Error("authority harness is not initialized");
  return state;
}

describe("T02.10 directory authority and closed company assurance", () => {
  /** The status/refusal projection a gate produces for one request. */
  interface GateAnswer {
    status: number;
    code: string | null;
  }

  async function answerOf(work: () => Promise<unknown>): Promise<GateAnswer> {
    try {
      await work();
      return { status: 200, code: null };
    } catch (error) {
      if (error instanceof AuthorityRefusal) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
  }

  function writeAnswer(
    authority: ReturnType<typeof createDirectoryAuthority>,
    tx: DirectoryTx,
    expectedVersion: number,
    writer: "legacy" | "ba",
  ): Promise<GateAnswer> {
    return answerOf(() => authority.requireWrite(tx, expectedVersion, writer));
  }

  function releaseAnswer(
    authority: ReturnType<typeof createDirectoryAuthority>,
    tx: DirectoryTx,
    expectedVersion: number,
  ): Promise<GateAnswer> {
    return answerOf(() => authority.requireRelease(tx, expectedVersion));
  }

  async function refusalOf(
    work: () => Promise<unknown>,
  ): Promise<{ status: number; code: string }> {
    try {
      await work();
    } catch (error) {
      if (error instanceof CompanyAssuranceRefusal) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
    throw new Error(
      "expected a company-assurance refusal, but the operation succeeded",
    );
  }

  /** The M1/legacy/version-0 row the migration seeds. */
  async function seed(): Promise<void> {
    await restoreSeed(harness().harness.sql);
  }

  beforeAll(async () => {
    state = await createHarness();
  }, 120_000);

  test("legacy_authority_keeps_existing_tenancy_green", async () => {
    const { inTx, harness: fixture } = harness();
    await seed();
    const outcome = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      const authorityState = await authority.read(tx);
      return {
        authorityState,
        legacy: await writeAnswer(
          authority,
          tx,
          authorityState.authorityVersion,
          "legacy",
        ),
        ba: await writeAnswer(
          authority,
          tx,
          authorityState.authorityVersion,
          "ba",
        ),
      };
    });

    const legacyStatus = outcome.legacy.status;
    expect(legacyStatus).toBe(200);
    expect(outcome.authorityState).toEqual({
      authorityVersion: 0,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
    });
    // BA runtime directory writes are closed before M4 — the legacy branch is
    // preserved, not widened.
    expect(outcome.ba).toEqual({
      status: 503,
      code: DIRECTORY_WRITE_AUTHORITY_CLOSED,
    });

    // The strongest form of "legacy does not depend on the BA migration": the
    // clock, challenge and assurance tables do not exist anywhere in this
    // database, and the legacy gate above still answered 200.
    const [relations] = await fixture.sql<
      {
        clocks: string | null;
        challenges: string | null;
        assurances: string | null;
      }[]
    >`SELECT to_regclass('public.auth_eligibility_clocks') AS clocks,
             to_regclass('public.auth_company_auth_challenges') AS challenges,
             to_regclass('public.auth_company_session_assurances') AS assurances`;
    expect(relations).toEqual({
      clocks: null,
      challenges: null,
      assurances: null,
    });

    // A read/write gate performs no DML: the persisted row is untouched.
    expect(await harness().persistedRow()).toEqual({
      authorityVersion: 0,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
    });
  });

  test("missing_authority_or_required_proof_fails_closed", async () => {
    const { inTx, harness: fixture } = harness();
    await seed();
    await fixture.sql.unsafe(`DELETE FROM "${AUTHORITY_TABLE}"`);

    const missing = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        read: await answerOf(() => authority.read(tx)),
        legacyWrite: await writeAnswer(authority, tx, 0, "legacy"),
        baWrite: await writeAnswer(authority, tx, 0, "ba"),
      };
    });
    // No row is never legacy: every writer gets the same infrastructure
    // answer, including the legacy one that a fallback would have let through.
    expect(missing.read).toEqual({
      status: 503,
      code: AUTHORITY_STATE_MISSING,
    });
    expect(missing.legacyWrite).toEqual({
      status: 503,
      code: AUTHORITY_STATE_MISSING,
    });
    expect(missing.baWrite).toEqual({
      status: 503,
      code: AUTHORITY_STATE_MISSING,
    });

    // The second half of the named case: a company that demands proof, on a
    // deployment without the evidence bridge, fails closed (403, not 200).
    const assurance = createClosedCompanyAssurance({
      policy: {
        async requiresProof(tenantId: string) {
          return tenantId === TENANT;
        },
      },
    });
    const baStatus = (
      await refusalOf(() => assurance.require({} as DirectoryTx, ACTOR, TENANT))
    ).status;
    expect(baStatus).not.toBe(200);
    expect(baStatus).toBe(403);

    await seed();
  });

  test("paused_authority_rejects_every_directory_writer", async () => {
    const { inTx, harness: fixture } = harness();
    for (const phase of ["M2", "M3"] as const) {
      await setAuthority(fixture.sql, {
        authorityVersion: 21,
        phase,
        directoryAuthority: "paused",
        multiTenantReleased: false,
      });
      const outcome = await inTx(async (tx) => {
        const authority = createDirectoryAuthority();
        const authorityState = await authority.read(tx);
        return {
          authorityState,
          legacy: await writeAnswer(authority, tx, 21, "legacy"),
          ba: await writeAnswer(authority, tx, 21, "ba"),
        };
      });
      // Reads keep working (M2/M3 pause directory WRITES, interfaces §3.3)…
      expect(outcome.authorityState).toEqual({
        authorityVersion: 21,
        phase,
        directoryAuthority: "paused",
        multiTenantReleased: false,
      });
      // …and both writers see the one documented 503.
      expect(outcome.legacy).toEqual({
        status: 503,
        code: DIRECTORY_MIGRATION_PAUSED,
      });
      expect(outcome.ba).toEqual({
        status: 503,
        code: DIRECTORY_MIGRATION_PAUSED,
      });
    }
  });

  test("ba_authority_accepts_only_the_ba_writer", async () => {
    const { inTx, harness: fixture } = harness();
    for (const phase of ["M4", "M5", "M6", "M7"] as const) {
      await setAuthority(fixture.sql, {
        authorityVersion: 31,
        phase,
        directoryAuthority: "ba",
        multiTenantReleased: phase === "M5" || phase === "M6",
      });
      const outcome = await inTx(async (tx) => {
        const authority = createDirectoryAuthority();
        const authorityState = await authority.read(tx);
        return {
          authorityState,
          ba: await writeAnswer(authority, tx, 31, "ba"),
          legacy: await writeAnswer(authority, tx, 31, "legacy"),
        };
      });
      expect(outcome.authorityState.phase).toBe(phase);
      expect(outcome.authorityState.directoryAuthority).toBe("ba");
      expect(outcome.ba.status).toBe(200);
      // The M4 CAS collects the legacy writer's rights; the gate says so too.
      expect(outcome.legacy).toEqual({
        status: 503,
        code: DIRECTORY_WRITE_AUTHORITY_CLOSED,
      });
    }
  });

  test("authority_version_is_compared_before_any_branch", async () => {
    const { inTx, harness: fixture } = harness();
    await setAuthority(fixture.sql, {
      authorityVersion: 5,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
    });
    const legacy = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        stale: await writeAnswer(authority, tx, 4, "legacy"),
        current: await writeAnswer(authority, tx, 5, "legacy"),
      };
    });
    expect(legacy.stale).toEqual({
      status: 503,
      code: AUTHORITY_VERSION_CONFLICT,
    });
    expect(legacy.current.status).toBe(200);

    // The version is compared before the branch: a stale expected version under
    // a paused state is a conflict, not "paused says nothing".
    await setAuthority(fixture.sql, {
      authorityVersion: 6,
      phase: "M2",
      directoryAuthority: "paused",
      multiTenantReleased: false,
    });
    const paused = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        stale: await writeAnswer(authority, tx, 5, "legacy"),
        current: await writeAnswer(authority, tx, 6, "legacy"),
      };
    });
    expect(paused.stale).toEqual({
      status: 503,
      code: AUTHORITY_VERSION_CONFLICT,
    });
    expect(paused.current).toEqual({
      status: 503,
      code: DIRECTORY_MIGRATION_PAUSED,
    });

    // A caller's expected version outside the Version domain is refused, never
    // coerced into a match.
    const unsafe = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        negative: await writeAnswer(authority, tx, -1, "legacy"),
        fractional: await writeAnswer(authority, tx, 1.5, "legacy"),
        nan: await writeAnswer(authority, tx, Number.NaN, "legacy"),
        beyond: await writeAnswer(authority, tx, SAFE_MAX + 1, "legacy"),
      };
    });
    for (const answer of Object.values(unsafe)) {
      expect(answer).toEqual({
        status: 503,
        code: AUTHORITY_VERSION_UNSAFE,
      });
    }
  });

  test("authority_state_is_read_inside_the_callers_transaction", async () => {
    const { harness: fixture, persistedVersion } = harness();
    await seed();
    const observed: { insideVersion?: number; outsideDuring?: number } = {};
    let signalInside!: () => void;
    const insideRead = new Promise<void>((resolve) => {
      signalInside = resolve;
    });
    let signalOutside!: () => void;
    const outsideRead = new Promise<void>((resolve) => {
      signalOutside = resolve;
    });

    /** Aborts the command transaction after the outside read, like a rollback. */
    class RollbackSignal extends Error {}

    const transaction = fixture.db
      .transaction(async (trx) => {
        const tx = trx as unknown as DirectoryTx;
        await trx.execute(
          dsql`UPDATE auth_authority_states
                  SET authority_version = 41, updated_at = now()
                WHERE id = 1`,
        );
        observed.insideVersion = (
          await createDirectoryAuthority().read(tx)
        ).authorityVersion;
        signalInside();
        await outsideRead;
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });

    await insideRead;
    // A different connection, while the command transaction is still open: the
    // uncommitted CAS is invisible, which is what "read in the caller's tx"
    // means for a command racing the M4 switch.
    observed.outsideDuring = await persistedVersion();
    signalOutside();
    await transaction;

    expect(observed.insideVersion).toBe(41);
    expect(observed.outsideDuring).toBe(0);
    // The rollback left the persisted row alone.
    expect(await persistedVersion()).toBe(0);

    // Reading on the pool is refused: a state read outside a transaction is a
    // snapshot no command commits against.
    const pool = await answerOf(() =>
      createDirectoryAuthority().read(
        harness().harness.db as unknown as DirectoryTx,
      ),
    );
    expect(pool).toEqual({
      status: 503,
      code: AUTHORITY_STATE_WITHOUT_TRANSACTION,
    });
  });

  test("unknown_or_unsafe_authority_state_is_refused_not_guessed", async () => {
    const { inTx, harness: fixture } = harness();
    await seed();
    // The database CHECKs are the first line of defence (T02.03); they are
    // lifted here only to prove the reader refuses a row that got past them.
    const constraints = [
      "auth_authority_state_phase",
      "auth_authority_state_directory_authority",
      "auth_authority_state_phase_matches_authority",
      "auth_authority_state_version_safe_integer",
    ] as const;
    for (const constraint of constraints) {
      await fixture.sql.unsafe(
        `ALTER TABLE "${AUTHORITY_TABLE}" DROP CONSTRAINT "${constraint}"`,
      );
    }
    try {
      const answers = await inTx(async (tx) => {
        const authority = createDirectoryAuthority();
        const read = () =>
          answerOf(async () => {
            await authority.read(tx);
          });
        await fixture.sql`
          UPDATE auth_authority_states SET phase = 'M9' WHERE id = 1`;
        const unknownPhase = await read();
        await fixture.sql`
          UPDATE auth_authority_states SET phase = 'M1', directory_authority = 'hybrid' WHERE id = 1`;
        const unknownAuthority = await read();
        await fixture.sql`
          UPDATE auth_authority_states SET directory_authority = 'legacy', authority_version = ${SAFE_MAX + 1} WHERE id = 1`;
        const unsafeVersion = await read();
        return { unknownPhase, unknownAuthority, unsafeVersion };
      });
      for (const answer of Object.values(answers)) {
        expect(answer.status).toBe(503);
      }
      expect(answers.unknownPhase.code).toBe(AUTHORITY_STATE_UNKNOWN);
      expect(answers.unknownAuthority.code).toBe(AUTHORITY_STATE_UNKNOWN);
      expect(answers.unsafeVersion.code).toBe(AUTHORITY_VERSION_UNSAFE);
    } finally {
      await fixture.sql.unsafe(`DELETE FROM "${AUTHORITY_TABLE}"`);
      await fixture.sql.unsafe(
        `ALTER TABLE "${AUTHORITY_TABLE}" ADD CONSTRAINT "auth_authority_state_phase" CHECK ("phase" in ('M0','M1','M2','M3','M4','M5','M6','M7'))`,
      );
      await fixture.sql.unsafe(
        `ALTER TABLE "${AUTHORITY_TABLE}" ADD CONSTRAINT "auth_authority_state_directory_authority" CHECK ("directory_authority" in ('legacy','paused','ba'))`,
      );
      await fixture.sql.unsafe(
        `ALTER TABLE "${AUTHORITY_TABLE}" ADD CONSTRAINT "auth_authority_state_phase_matches_authority" CHECK ((("phase" in ('M0','M1') and "directory_authority" = 'legacy') or ("phase" in ('M2','M3') and "directory_authority" = 'paused') or ("phase" in ('M4','M5','M6','M7') and "directory_authority" = 'ba')))`,
      );
      await fixture.sql.unsafe(
        `ALTER TABLE "${AUTHORITY_TABLE}" ADD CONSTRAINT "auth_authority_state_version_safe_integer" CHECK ("authority_version" >= 0 and "authority_version" <= 9007199254740991)`,
      );
      await seed();
    }
  });

  test("release_gate_is_independent_of_authority_selection", async () => {
    const { inTx, harness: fixture } = harness();

    // M1, release closed: the authority writes as legacy, the release refuses.
    await setAuthority(fixture.sql, {
      authorityVersion: 51,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: false,
    });
    const closed = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        legacy: await writeAnswer(authority, tx, 51, "legacy"),
        release: await releaseAnswer(authority, tx, 51),
        authorityState: await authority.read(tx),
      };
    });
    expect(closed.legacy.status).toBe(200);
    expect(closed.release).toEqual({
      status: 503,
      code: MULTI_TENANT_NOT_RELEASED,
    });

    // M1, release OPEN: the release flag never selects the authority — the row
    // is still legacy, and the BA writer is still closed.
    await setAuthority(fixture.sql, {
      authorityVersion: 51,
      phase: "M1",
      directoryAuthority: "legacy",
      multiTenantReleased: true,
    });
    const releasedLegacy = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        legacy: await writeAnswer(authority, tx, 51, "legacy"),
        ba: await writeAnswer(authority, tx, 51, "ba"),
        release: await releaseAnswer(authority, tx, 51),
        authorityState: await authority.read(tx),
      };
    });
    expect(releasedLegacy.authorityState.directoryAuthority).toBe("legacy");
    expect(releasedLegacy.legacy.status).toBe(200);
    expect(releasedLegacy.ba).toEqual({
      status: 503,
      code: DIRECTORY_WRITE_AUTHORITY_CLOSED,
    });
    expect(releasedLegacy.release.status).toBe(200);

    // M4 (ba), release closed: the authority writes, the release refuses. The
    // authority's version is the release's CAS, not its selector.
    await setAuthority(fixture.sql, {
      authorityVersion: 52,
      phase: "M4",
      directoryAuthority: "ba",
      multiTenantReleased: false,
    });
    const baClosedRelease = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        ba: await writeAnswer(authority, tx, 52, "ba"),
        release: await releaseAnswer(authority, tx, 52),
        staleRelease: await releaseAnswer(authority, tx, 51),
      };
    });
    expect(baClosedRelease.ba.status).toBe(200);
    expect(baClosedRelease.release).toEqual({
      status: 503,
      code: MULTI_TENANT_NOT_RELEASED,
    });
    expect(baClosedRelease.staleRelease).toEqual({
      status: 503,
      code: AUTHORITY_VERSION_CONFLICT,
    });

    // M2 (paused) with release open: the release gate is not the write gate —
    // release answers 200 while directory writes stay paused.
    await setAuthority(fixture.sql, {
      authorityVersion: 53,
      phase: "M2",
      directoryAuthority: "paused",
      multiTenantReleased: true,
    });
    const pausedReleased = await inTx(async (tx) => {
      const authority = createDirectoryAuthority();
      return {
        release: await releaseAnswer(authority, tx, 53),
        legacy: await writeAnswer(authority, tx, 53, "legacy"),
      };
    });
    expect(pausedReleased.release.status).toBe(200);
    expect(pausedReleased.legacy).toEqual({
      status: 503,
      code: DIRECTORY_MIGRATION_PAUSED,
    });
  });

  test("with_authority_matrix_covers_legacy_paused_and_ba", async () => {
    const { inTx, harness: fixture } = harness();
    const observed: string[] = [];
    const matrixFixture: AuthorityMatrixFixture = {
      async setAuthorityState(row) {
        await setAuthority(fixture.sql, row);
      },
      inDirectoryTransaction: inTx,
    };
    await withAuthorityMatrix(
      matrixFixture,
      async ({ authority, state: scenarioState, tx, scenario }) => {
        observed.push(scenario.name);
        const legacy = await writeAnswer(
          authority,
          tx,
          scenarioState.authorityVersion,
          "legacy",
        );
        const ba = await writeAnswer(
          authority,
          tx,
          scenarioState.authorityVersion,
          "ba",
        );
        if (scenario.expectedWriter === null) {
          // Paused: the same 503 for every writer, including the BA one.
          expect(legacy).toEqual({
            status: 503,
            code: DIRECTORY_MIGRATION_PAUSED,
          });
          expect(ba).toEqual({
            status: 503,
            code: DIRECTORY_MIGRATION_PAUSED,
          });
          return;
        }
        const accepted = scenario.expectedWriter === "legacy" ? legacy : ba;
        const refused = scenario.expectedWriter === "legacy" ? ba : legacy;
        expect(accepted.status).toBe(200);
        expect(refused).toEqual({
          status: 503,
          code: DIRECTORY_WRITE_AUTHORITY_CLOSED,
        });
      },
    );
    // A silently skipped scenario would be a matrix that tested nothing.
    expect(observed).toEqual(["legacy", "paused", "ba"]);
  });

  test("closed_company_assurance_requires_proof_and_refuses_interactive_halves", async () => {
    // No optional dependency: a factory built without the proof policy refuses
    // at construction, so a call site cannot forget the question.
    expect(() => createClosedCompanyAssurance(undefined as never)).toThrow(
      COMPANY_ASSURANCE_POLICY_REQUIRED,
    );
    expect(() => createClosedCompanyAssurance({} as never)).toThrow(
      COMPANY_ASSURANCE_POLICY_REQUIRED,
    );

    const assurance = createClosedCompanyAssurance({
      policy: {
        async requiresProof(tenantId: string) {
          return tenantId === TENANT;
        },
      },
    });

    // Required methods exist and the adapter cannot be monkey-patched into a
    // no-proof bypass.
    expect(typeof assurance.require).toBe("function");
    expect(typeof assurance.challenge).toBe("function");
    expect(typeof assurance.complete).toBe("function");
    expect(Object.isFrozen(assurance)).toBe(true);

    // A company with no additional proof policy answers null — the ONLY way
    // `require` lets a caller through, and it still needs no BA table (none
    // exist in this database).
    await expect(
      assurance.require({} as DirectoryTx, ACTOR, TENANT_WITHOUT_PROOF_POLICY),
    ).resolves.toBeNull();

    // A company that demands proof refuses with the controlled 403.
    const required = await refusalOf(() =>
      assurance.require({} as DirectoryTx, ACTOR, TENANT),
    );
    expect(required).toEqual({
      status: 403,
      code: COMPANY_REAUTH_REQUIRED,
    });

    // A proof question with no company is not answered as "no proof needed".
    const nameless = await refusalOf(() =>
      assurance.require({} as DirectoryTx, ACTOR, "   "),
    );
    expect(nameless).toEqual({
      status: 403,
      code: COMPANY_ASSURANCE_TARGET_REQUIRED,
    });

    // Only an explicit "false" answers "no proof"; a policy that cannot rule
    // the requirement out fails closed instead of opening the read.
    const unansweredPolicy = createClosedCompanyAssurance({
      policy: {
        async requiresProof() {
          return undefined as unknown as boolean;
        },
      },
    });
    expect(
      await refusalOf(() =>
        unansweredPolicy.require(
          {} as DirectoryTx,
          ACTOR,
          TENANT_WITHOUT_PROOF_POLICY,
        ),
      ),
    ).toEqual({ status: 403, code: COMPANY_REAUTH_REQUIRED });

    // Both interactive halves are closed until P11 wires the evidence bridge.
    const challenge = await refusalOf(() =>
      assurance.challenge(ACTOR, {
        tenantId: TENANT,
        returnPath: "/enterprise/team",
      }),
    );
    expect(challenge).toEqual({
      status: 503,
      code: COMPANY_AUTH_NOT_READY,
    });
    const noProofCompanyChallenge = await refusalOf(() =>
      assurance.challenge(ACTOR, {
        tenantId: TENANT_WITHOUT_PROOF_POLICY,
        returnPath: "/enterprise/team",
      }),
    );
    expect(noProofCompanyChallenge).toEqual({
      status: 503,
      code: COMPANY_AUTH_NOT_READY,
    });
    const complete = await refusalOf(() =>
      assurance.complete(
        new Request("http://127.0.0.1/company-auth/oidc/callback/idp", {
          method: "GET",
        }),
      ),
    );
    expect(complete).toEqual({
      status: 503,
      code: COMPANY_AUTH_NOT_READY,
    });
  });

  test("authority_domains_are_the_frozen_closed_sets", () => {
    // The migration CHECKs and interfaces §3.3 name the same domains; a
    // divergence here would let the reader version of the domain drift from
    // the database's.
    expect([...AUTHORITY_PHASES]).toEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "M7",
    ]);
  });

  afterAll(async () => {
    const created = state;
    if (created) await created.harness.close();
    state = undefined;
    // A fresh probe, so the leak check sees the cleaned database rather than
    // the harness's released pool: none of this suite's tables and no rows.
    const setupUrl = readBaUrls();
    const probe = postgres(setupUrl, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${[...SUITE_TABLES]}::text[])`;
      expect([...tables]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  // The harness is built in beforeAll above; a missing URL or migration fails
  // every case with its reason instead of aborting collection with zero cases.
});
