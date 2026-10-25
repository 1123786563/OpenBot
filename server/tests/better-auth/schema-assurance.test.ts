import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  afterAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import * as schema from "../../src/db/schema";

/*
 * T02.05 (#527, P03) — the company authentication challenge and proof
 * storage, checked against the real migration on the isolated BA_TEST_*
 * stack (design §9.1 "公司认证证据与追加认证", Global Constraints "公司
 * challenge 最长 600 秒、proof 使用签名声明真实认证时间"; interfaces §5).
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `challenge_binding_is_immutable_and_single_use`: a challenge fixes its
 *   original user/session, its target tenant, its provider, its protocol and
 *   its policy revision at issue time. Consumption is the atomic conditional
 *   UPDATE on `consumed_at` — the at-most-once answer the T01.06/T01.07
 *   `SsoChallengeStore.consume` port demands — and the proof's composite
 *   foreign key onto the challenge's binding makes a cross-account,
 *   cross-company or cross-provider rebind of the SAME challenge structurally
 *   impossible (SQLSTATE 23503), the way `auth_team_bindings`' composite FK
 *   makes a team binding immovable between companies. Re-issuing the same
 *   challenge id or the same state digest is refused by the PK/unique index
 *   (23505).
 * - `challenge_secret_is_not_stored_plaintext`: the correlation token is
 *   stored only as its digest and the protocol secrets (nonce, PKCE verifier,
 *   request binding) only inside the sealed envelope — the stored row never
 *   contains the raw nonce/state/verifier (design §9.1: "秘密仅摘要或加密").
 * - `challenge_age_and_domains_are_database_facts`: the 600-second maximum
 *   challenge age, a non-expired birth, the closed protocol domain and the
 *   safe-integer policy revision are CHECKs, not writer discipline.
 * - `proof_is_one_per_challenge_and_current_per_session_and_company`: the
 *   evidence↔challenge one-to-one binding (spec: "evidence 与 challenge 的一
 *   一绑定") is a unique index; `(session_id, tenant_id)` is the §9.1
 *   current-proof key — one ACTIVE proof per session per company, history
 *   kept as revocation status, never a deletion; and the composite FK
 *   deliberately excludes session, so the proof may bind the FINAL session
 *   after a BA rotation (§9.1 step 4) while everything else must match the
 *   challenge exactly.
 * - `proof_generations_and_validity_are_safe_integer_bounded`: the issuance
 *   generations and policy revision are Versions (0..9007199254740991), and a
 *   proof cannot be born expired (`expires_at > authenticated_at`) — the
 *   min(session expiry, authenticated_at + maxAuthAge) rule is computed by
 *   the write path (P11), but its floor is a database fact.
 * - `typed_schema_matches_applied_migration`: the Drizzle projection and the
 *   SQL every environment runs cannot drift.
 * - `migration_replays_from_clean_state_without_touching_legacy` and
 *   `schema_file_is_registered_in_barrel_generator_and_journal` complete the
 *   expand-migration proofs (apply/replay, journal monotonic).
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape);
 * a missing one is a blocked suite, never a silent fallback to the shared, MT
 * or job-level database. No DSN is ever printed — refusals name the variable.
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
const MIGRATION_TAG = "0213_better_auth_assurance";
const MIGRATION_PATH = join(
  import.meta.dirname,
  `../../drizzle/${MIGRATION_TAG}.sql`,
);
const CHALLENGE_TABLE = "auth_company_auth_challenges";
const ASSURANCE_TABLE = "auth_company_session_assurances";
const SUITE_TABLES = [ASSURANCE_TABLE, CHALLENGE_TABLE] as const;
/** Number.MAX_SAFE_INTEGER: the Version domain's inclusive upper bound. */
const SAFE_MAX = 9007199254740991;
const TENANT_A = "t0205-tenant-a";
const TENANT_B = "t0205-tenant-b";
const USER_A = "t0205-user-a";
const USER_B = "t0205-user-b";
const PRINCIPAL_A = "t0205-principal-a";
const PRINCIPAL_B = "t0205-principal-b";
/**
 * One session per proof-writing test: the current-proof key is (session,
 * tenant), so a test that dies midway must not poison the next test's key.
 */
const SESSION_1 = "t0205-session-1";
const SESSION_PAIR = "t0205-session-pair";
const SESSION_GENERATIONS = "t0205-session-generations";
/** The post-rotation final session (§9.1 step 4). */
const SESSION_ROTATED = "t0205-session-rotated";
/**
 * Dedicated pair for the rotation lifecycle: the session the challenge was
 * issued in, and the final session the proof binds after rotation. Deleting
 * the old one must succeed; deleting the final one cascades the proof.
 */
const SESSION_ROT_OLD = "t0205-session-rot-old";
const SESSION_ROT_NEW = "t0205-session-rot-new";
const SESSION_B = "t0205-session-b";
const PROVIDER = "t0205-idp";
const PROVIDER_OTHER = "t0205-idp-other";
const RETURN_PATH = "/enterprise/team";
/**
 * The raw protocol material a writer holds before persisting. The store never
 * writes these bytes; a leak of them into any column fails the secret probe.
 */
const RAW_STATE = "t0205-raw-state-b7d1e4c8a9";
const RAW_NONCE = "t0205-raw-nonce-3f8a2d91c6";
const RAW_VERIFIER = "t0205-raw-verifier-e5b09d47aa";

function shapeOf(variable: string, raw: string) {
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
  return { endpoint: `${host}:${url.port || "5432"}`, database };
}

function readBaUrls(): { setup: string; shapes: Map<string, string> } {
  const shapes = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: a better-auth DB suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    shapes.set(variable, shapeOf(variable, raw).endpoint);
  }
  const signature = (variable: string) => {
    const { endpoint, database } = shapeOf(
      variable,
      process.env[variable]!.trim(),
    );
    return `${endpoint}/${database}`;
  };
  const reference = signature(DATABASE_VARIABLE);
  for (const variable of BA_URL_VARIABLES) {
    if (signature(variable) !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return { setup: process.env[DATABASE_VARIABLE]!.trim(), shapes };
}

function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SHA-256 hex digest — the only form of the correlation token the table keeps. */
function digestOf(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

/**
 * The sealed envelope stand-in — deliberately NOT a cipher. This base64 of a
 * JSON document is reversible, and nothing in this suite claims otherwise:
 * what `challenge_secret_is_not_stored_plaintext` pins is the storage
 * CONTRACT (no plaintext protocol-secret column exists and the raw material
 * appears nowhere in the row), not cryptographic protection. P11 owns the
 * real envelope format and its own tests must assert it is genuinely
 * encrypted (AEAD with managed keys, not base64): if P11 kept this
 * reversible stand-in, a database leak would hand back the nonce and PKCE
 * verifier. Review r1 (R1-F4) recorded this boundary; it is accepted as a
 * disclosed limitation of a db-task suite.
 */
function sealEnvelope(material: Record<string, string>): string {
  return Buffer.from(JSON.stringify(material), "utf8").toString("base64");
}

/**
 * Read lazily, so a worktree without the expand migration still collects (and
 * fails) every case with a message naming the missing target behavior instead
 * of dying at import time as a zero-case collection error.
 */
function loadMigrationSql(): string {
  if (!existsSync(MIGRATION_PATH)) {
    throw new Error(
      `${MIGRATION_TAG}.sql does not exist: the expand migration this suite pins (the one-time company-auth challenge table and the session assurance proof table) is the T02.05 target behavior, not an environment problem.`,
    );
  }
  return readFileSync(MIGRATION_PATH, "utf8");
}

interface ChallengeRow {
  challengeId: string;
  userId: string;
  sessionId: string;
  tenantId: string;
  providerId: string;
  protocol?: string;
  policyRevision?: number;
  returnPath?: string;
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  protocolRequestId?: string;
  /** Seconds from creation the challenge stays valid; the ceiling is 600. */
  ageSeconds?: number;
}

/**
 * The store-shaped writer: digest the correlation token, seal the protocol
 * secrets, state the policy revision and the expiry window explicitly.
 */
async function insertChallenge(
  sql: postgres.Sql,
  row: ChallengeRow,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(CHALLENGE_TABLE)}
      (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
       policy_revision, return_path, state_digest, secret_envelope,
       expires_at, created_at)
    VALUES
      (${row.challengeId}, ${row.userId}, ${row.sessionId}, ${row.tenantId},
       ${row.providerId}, ${row.protocol ?? "oidc"},
       ${row.policyRevision ?? 1}, ${row.returnPath ?? RETURN_PATH},
       ${digestOf(row.state ?? RAW_STATE)},
       ${sealEnvelope({
         nonce: row.nonce ?? RAW_NONCE,
         codeVerifier: row.codeVerifier ?? RAW_VERIFIER,
         protocolRequestId: row.protocolRequestId ?? `${row.challengeId}-req`,
       })},
       now() + (${`${row.ageSeconds ?? 599} seconds`}::interval), now())`;
}

interface AssuranceRow {
  assuranceId: string;
  userId?: string;
  principalId?: string;
  sessionId?: string;
  tenantId?: string;
  challengeId: string;
  providerId?: string;
  authenticationMethod?: string;
  issuer?: string;
  subject?: string;
  authenticatedAt?: Date;
  strength?: string;
  expiresAt?: Date;
  policyRevision?: number;
  identityGeneration?: number;
  companyGeneration?: number;
  status?: string;
  revokedAt?: Date | null;
}

/** The proof writer: states the issuance generations, never defaults them. */
async function insertAssurance(
  sql: postgres.Sql,
  row: AssuranceRow,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(ASSURANCE_TABLE)}
      (assurance_id, user_id, principal_id, session_id, tenant_id,
       challenge_id, provider_id, authentication_method, issuer, subject,
       authenticated_at, strength, expires_at, policy_revision,
       identity_generation, company_generation, status, revoked_at)
    VALUES
      (${row.assuranceId}, ${row.userId ?? USER_A},
       ${row.principalId ?? PRINCIPAL_A}, ${row.sessionId ?? SESSION_1},
       ${row.tenantId ?? TENANT_A}, ${row.challengeId},
       ${row.providerId ?? PROVIDER},
       ${row.authenticationMethod ?? "oidc"},
       ${row.issuer ?? "https://idp.example"},
       ${row.subject ?? "user-a-at-idp"},
       ${row.authenticatedAt ?? new Date(Date.now() - 30_000)},
       ${row.strength ?? "mfa"},
       ${row.expiresAt ?? new Date(Date.now() + 45 * 60_000)},
       ${row.policyRevision ?? 1}, ${row.identityGeneration ?? 1},
       ${row.companyGeneration ?? 1},
       ${row.status ?? "active"},
       ${row.revokedAt ?? null})`;
}

/**
 * The single-consumption protocol the T01.06/T01.07 store port demands, made
 * atomic by one conditional UPDATE: the row lock serializes concurrent
 * consumers, the second consumer matches zero rows and gets `null`. Keeping
 * the row (a status, never a deletion) is what lets the proof's foreign key
 * pin the binding for good.
 */
async function consumeChallenge(
  sql: postgres.Sql,
  rawState: string,
): Promise<{ challenge_id: string } | null> {
  const rows = await sql<{ challenge_id: string }[]>`
    UPDATE ${sql(CHALLENGE_TABLE)}
       SET consumed_at = now()
     WHERE state_digest = ${digestOf(rawState)}
       AND consumed_at IS NULL
    RETURNING challenge_id`;
  return rows[0] ?? null;
}

/**
 * Returns the island to the pre-T02.05 shape: this suite's two tables and its
 * seeded tenants/users/principals/sessions gone. Every statement is a no-op on
 * a pristine baseline, and it also recovers a crashed earlier run that left
 * any of them behind.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  await sql`DELETE FROM sessions WHERE id LIKE 't0205-%'`;
  await sql`DELETE FROM enterprise_principals WHERE id LIKE 't0205-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0205-%'`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0205-%'`;
}

/**
 * The baseline the assurance model rides on: two companies, the two users
 * with their one-per-user principals, and the sessions a challenge can fix —
 * user A's original session, user A's post-rotation session, user B's.
 */
async function seedBaselineFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT_A}, 'T02.05 company A'),
      (${TENANT_B}, 'T02.05 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      (${USER_A}, 't0205-user-a@example.test'),
      (${USER_B}, 't0205-user-b@example.test')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      (${PRINCIPAL_A}, ${USER_A}),
      (${PRINCIPAL_B}, ${USER_B})`;
  await sql`
    INSERT INTO sessions (id, user_id, token, expires_at) VALUES
      (${SESSION_1}, ${USER_A}, 't0205-token-1', now() + interval '2 hours'),
      (${SESSION_PAIR}, ${USER_A}, 't0205-token-pair', now() + interval '2 hours'),
      (${SESSION_GENERATIONS}, ${USER_A}, 't0205-token-generations', now() + interval '2 hours'),
      (${SESSION_ROTATED}, ${USER_A}, 't0205-token-rotated', now() + interval '2 hours'),
      (${SESSION_ROT_OLD}, ${USER_A}, 't0205-token-rot-old', now() + interval '2 hours'),
      (${SESSION_ROT_NEW}, ${USER_A}, 't0205-token-rot-new', now() + interval '2 hours'),
      (${SESSION_B}, ${USER_B}, 't0205-token-b', now() + interval '2 hours')`;
}

async function countPublicTables(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
  `;
  return Number(row?.count ?? 0);
}

/**
 * Every public column except this suite's two new tables. The fingerprint is
 * taken before the first apply and after the replay, so anything the
 * migration changed about an existing column would show — which is the
 * point: the migration may only add, never rewrite.
 */
async function publicColumnFingerprint(sql: postgres.Sql): Promise<string> {
  const rows = await sql<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }[]
  >`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name NOT IN (${CHALLENGE_TABLE}, ${ASSURANCE_TABLE})
     ORDER BY table_name, ordinal_position
  `;
  const hasher = new Bun.CryptoHasher("sha256");
  for (const row of rows) {
    hasher.update(
      `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}:${row.column_default ?? ""}\n`,
    );
  }
  return hasher.digest("hex");
}

interface Harness {
  sql: postgres.Sql;
  baselineTableCount: number;
  firstApplyTableCount: number;
  replayTableCount: number;
  fingerprintBefore: string;
  fingerprintAfter: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const { setup } = readBaUrls();
  const sql = postgres(setup, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });

  try {
    await cleanupFixture(sql);
    await seedBaselineFixture(sql);
    const baselineTableCount = await countPublicTables(sql);
    const fingerprintBefore = await publicColumnFingerprint(sql);

    const migrationSql = loadMigrationSql();
    await sql.unsafe(migrationSql);
    const firstApplyTableCount = await countPublicTables(sql);
    await sql.unsafe(
      `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
    );
    await sql.unsafe(migrationSql);
    const replayTableCount = await countPublicTables(sql);
    const fingerprintAfter = await publicColumnFingerprint(sql);

    return {
      sql,
      baselineTableCount,
      firstApplyTableCount,
      replayTableCount,
      fingerprintBefore,
      fingerprintAfter,
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      },
    };
  } catch (error) {
    // Never leave the shared BA database holding this suite's rows/tables when
    // setup itself fails.
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harnessPromise: Promise<Harness> | undefined;

/** One harness per process; a setup failure is this suite's failure, not a skip. */
function loadHarness(): Promise<Harness> {
  harnessPromise ??= createHarness();
  return harnessPromise;
}

describe("T02.05 company authentication challenge and proof storage", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (created) await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than
    // the harness's released pool: no table this suite adds, none of its rows.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${[...SUITE_TABLES]}::text[])`;
      expect([...tables]).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0205-%'`;
      expect([...tenants]).toEqual([]);
      const users = await probe`
        SELECT id FROM users WHERE id LIKE 't0205-%'`;
      expect([...users]).toEqual([]);
      const sessionsLeft = await probe`
        SELECT id FROM sessions WHERE id LIKE 't0205-%'`;
      expect([...sessionsLeft]).toEqual([]);
      const principals = await probe`
        SELECT id FROM enterprise_principals WHERE id LIKE 't0205-%'`;
      expect([...principals]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("challenge_binding_is_immutable_and_single_use", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The gate's challenge: user A, in session 1, for company A, provider P,
    // policy revision 3, OIDC, alive 599 of its 600 seconds.
    await insertChallenge(sql, {
      challengeId: "t0205-ch-b1",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      protocol: "oidc",
      policyRevision: 3,
      state: "t0205-state-b1",
    });

    // First consumption wins — the atomic conditional UPDATE returns the row.
    const first = await consumeChallenge(sql, "t0205-state-b1");
    expect(first?.challenge_id).toBe("t0205-ch-b1");

    // The verified callback's proof, bound to the same user, company,
    // provider and protocol as the challenge (§9.1 step 3: the callback that
    // proves another user, or another company, is refused).
    await insertAssurance(sql, {
      assuranceId: "t0205-as-b1",
      challengeId: "t0205-ch-b1",
      userId: USER_A,
      principalId: PRINCIPAL_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      authenticationMethod: "oidc",
      policyRevision: 3,
    });

    // The proof's composite FK pins the challenge's binding: re-pointing the
    // consumed challenge at another user, company, provider or protocol has
    // no matching referenced row and is refused by the database.
    const refuse = async (statement: Promise<unknown>) => {
      let ran = true;
      try {
        await statement;
      } catch (error) {
        ran = false;
        expect(sqlStateOf(error)).toBe("23503");
      }
      expect(ran).toBe(false);
    };
    await refuse(sql`
      UPDATE ${sql(CHALLENGE_TABLE)} SET user_id = ${USER_B}
       WHERE challenge_id = 't0205-ch-b1'`);
    await refuse(sql`
      UPDATE ${sql(CHALLENGE_TABLE)} SET tenant_id = ${TENANT_B}
       WHERE challenge_id = 't0205-ch-b1'`);
    await refuse(sql`
      UPDATE ${sql(CHALLENGE_TABLE)} SET provider_id = ${PROVIDER_OTHER}
       WHERE challenge_id = 't0205-ch-b1'`);
    await refuse(sql`
      UPDATE ${sql(CHALLENGE_TABLE)} SET protocol = 'saml'
       WHERE challenge_id = 't0205-ch-b1'`);

    // The same challenge cannot be re-issued under another account or
    // company: the PK and the state-digest unique index both refuse.
    const refuseUnique = async (statement: Promise<unknown>) => {
      let inserted = true;
      try {
        await statement;
      } catch (error) {
        inserted = false;
        expect(sqlStateOf(error)).toBe("23505");
      }
      expect(inserted).toBe(false);
    };
    await refuseUnique(sql`
      INSERT INTO ${sql(CHALLENGE_TABLE)}
        (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
         policy_revision, return_path, state_digest, secret_envelope,
         expires_at, created_at)
      VALUES
        ('t0205-ch-b1', ${USER_B}, ${SESSION_B}, ${TENANT_B}, ${PROVIDER},
         'oidc', 3, ${RETURN_PATH}, ${digestOf("t0205-state-b1")}, 'x',
         now() + interval '60 seconds', now())`);
    await refuseUnique(sql`
      INSERT INTO ${sql(CHALLENGE_TABLE)}
        (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
         policy_revision, return_path, state_digest, secret_envelope,
         expires_at, created_at)
      VALUES
        ('t0205-ch-b1-clone', ${USER_B}, ${SESSION_B}, ${TENANT_B},
         ${PROVIDER}, 'oidc', 3, ${RETURN_PATH},
         ${digestOf("t0205-state-b1")}, 'x',
         now() + interval '60 seconds', now())`);

    // And a proof for user B cannot ride user A's challenge: the composite
    // FK has no (challenge, B, company, provider, protocol) row to match.
    // (A fresh challenge, so the one-to-one challenge index is not what
    // refuses — the binding is.)
    await insertChallenge(sql, {
      challengeId: "t0205-ch-b2",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-b2",
    });
    await consumeChallenge(sql, "t0205-state-b2");
    await refuse(sql`
      INSERT INTO ${sql(ASSURANCE_TABLE)}
        (assurance_id, user_id, principal_id, session_id, tenant_id,
         challenge_id, provider_id, authentication_method, issuer, subject,
         authenticated_at, strength, expires_at, policy_revision,
         identity_generation, company_generation)
      VALUES
        ('t0205-as-b2-foreign', ${USER_B}, ${PRINCIPAL_B}, ${SESSION_B},
         ${TENANT_A}, 't0205-ch-b2', ${PROVIDER}, 'oidc',
         'https://idp.example', 'user-b-at-idp',
         now() - interval '30 seconds', 'mfa',
         now() + interval '45 minutes', 3, 1, 1)`);

    // Second consumption of the same state: zero rows, `null` — the
    // at-most-once answer, never a replay.
    const secondConsume =
      (await consumeChallenge(sql, "t0205-state-b1")) !== null;
    expect(secondConsume).toBe(false);

    // The consumption is a status, never a deletion: the row, its binding
    // and its envelope stay for the audit the proof anchors.
    const [kept] = await sql<{ consumed_at: string | null }[]>`
      SELECT consumed_at FROM ${sql(CHALLENGE_TABLE)}
       WHERE challenge_id = 't0205-ch-b1'`;
    expect(kept?.consumed_at).not.toBeNull();
  });

  test("challenge_secret_is_not_stored_plaintext", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await insertChallenge(sql, {
      challengeId: "t0205-ch-s1",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: RAW_STATE,
      nonce: RAW_NONCE,
      codeVerifier: RAW_VERIFIER,
      protocolRequestId: "t0205-ch-s1-request",
    });

    const [row] = await sql<Record<string, unknown>[]>`
      SELECT * FROM ${sql(CHALLENGE_TABLE)}
       WHERE challenge_id = 't0205-ch-s1'`;
    expect(row).toBeDefined();
    const storedJson = JSON.stringify(row ?? {});
    // The raw protocol material is nowhere in the stored row: the nonce, the
    // correlation token and the PKCE verifier exist only as digest or sealed
    // envelope bytes (design §9.1: 秘密仅摘要或加密).
    expect(storedJson).not.toContain(RAW_NONCE);
    expect(storedJson).not.toContain(RAW_STATE);
    expect(storedJson).not.toContain(RAW_VERIFIER);
    // The correlation token is kept as its digest, and only as its digest.
    expect(row?.state_digest).toBe(digestOf(RAW_STATE));
    expect(String(row?.state_digest)).not.toBe(RAW_STATE);
    expect(typeof row?.secret_envelope).toBe("string");
  });

  test("challenge_age_and_domains_are_database_facts", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    const refuse = async (statement: Promise<unknown>) => {
      let ran = true;
      try {
        await statement;
      } catch (error) {
        ran = false;
        expect(sqlStateOf(error)).toBe("23514");
      }
      expect(ran).toBe(false);
    };

    // 601 seconds is past the 600-second ceiling the Global Constraints pin;
    // exactly 600 is legal.
    await refuse(
      insertChallenge(sql, {
        challengeId: "t0205-ch-a1",
        userId: USER_A,
        sessionId: SESSION_1,
        tenantId: TENANT_A,
        providerId: PROVIDER,
        state: "t0205-state-a1",
        ageSeconds: 601,
      }),
    );
    await insertChallenge(sql, {
      challengeId: "t0205-ch-a1",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-a1",
      ageSeconds: 600,
    });

    // A challenge cannot be born expired or live backwards in time.
    await refuse(
      insertChallenge(sql, {
        challengeId: "t0205-ch-a2",
        userId: USER_A,
        sessionId: SESSION_1,
        tenantId: TENANT_A,
        providerId: PROVIDER,
        state: "t0205-state-a2",
        ageSeconds: 0,
      }),
    );
    await refuse(sql`
      INSERT INTO ${sql(CHALLENGE_TABLE)}
        (challenge_id, user_id, session_id, tenant_id, provider_id, protocol,
         policy_revision, return_path, state_digest, secret_envelope,
         expires_at, created_at, consumed_at)
      VALUES
        ('t0205-ch-a3', ${USER_A}, ${SESSION_1}, ${TENANT_A}, ${PROVIDER},
         'oidc', 1, ${RETURN_PATH}, ${digestOf("t0205-state-a3")}, 'x',
         now() + interval '60 seconds',
         now() + interval '5 seconds',
         now() - interval '1 second')`);

    // The protocol domain is closed: there is no third protocol to accept.
    await refuse(
      insertChallenge(sql, {
        challengeId: "t0205-ch-a4",
        userId: USER_A,
        sessionId: SESSION_1,
        tenantId: TENANT_A,
        providerId: PROVIDER,
        protocol: "oauth",
        state: "t0205-state-a4",
      }),
    );

    // The policy revision is a Version: negative and wrapped values are
    // refused, both boundaries are legal.
    await refuse(
      insertChallenge(sql, {
        challengeId: "t0205-ch-a5",
        userId: USER_A,
        sessionId: SESSION_1,
        tenantId: TENANT_A,
        providerId: PROVIDER,
        state: "t0205-state-a5",
        policyRevision: -1,
      }),
    );
    await refuse(
      insertChallenge(sql, {
        challengeId: "t0205-ch-a6",
        userId: USER_A,
        sessionId: SESSION_1,
        tenantId: TENANT_A,
        providerId: PROVIDER,
        state: "t0205-state-a6",
        policyRevision: SAFE_MAX + 1,
      }),
    );
    await insertChallenge(sql, {
      challengeId: "t0205-ch-a7",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-a7",
      policyRevision: SAFE_MAX,
    });
    await sql`DELETE FROM ${sql(CHALLENGE_TABLE)} WHERE challenge_id LIKE 't0205-ch-a%'`;
  });

  test("proof_is_one_per_challenge_and_current_per_session_and_company", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await insertChallenge(sql, {
      challengeId: "t0205-ch-p1",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-p1",
    });
    await consumeChallenge(sql, "t0205-state-p1");
    await insertAssurance(sql, {
      assuranceId: "t0205-as-p1",
      challengeId: "t0205-ch-p1",
      sessionId: SESSION_PAIR,
      tenantId: TENANT_A,
    });

    const refuse = async (statement: Promise<unknown>) => {
      let ran = true;
      try {
        await statement;
      } catch (error) {
        ran = false;
        expect(sqlStateOf(error)).toBe("23505");
      }
      expect(ran).toBe(false);
    };

    // The evidence↔challenge binding is one-to-one: a second proof on the
    // same challenge is refused, however it is shaped.
    await refuse(
      insertAssurance(sql, {
        assuranceId: "t0205-as-p1-again",
        challengeId: "t0205-ch-p1",
        sessionId: SESSION_PAIR,
        tenantId: TENANT_A,
      }),
    );

    // The §9.1 current-proof key: one ACTIVE proof per (session, company).
    await insertChallenge(sql, {
      challengeId: "t0205-ch-p2",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-p2",
    });
    await consumeChallenge(sql, "t0205-state-p2");
    await refuse(
      insertAssurance(sql, {
        assuranceId: "t0205-as-p2",
        challengeId: "t0205-ch-p2",
        sessionId: SESSION_PAIR,
        tenantId: TENANT_A,
      }),
    );

    // Revocation is a status, never a deletion: once the old proof is
    // revoked, the re-authenticated proof becomes the current one.
    await sql`
      UPDATE ${sql(ASSURANCE_TABLE)}
         SET status = 'revoked', revoked_at = now()
       WHERE assurance_id = 't0205-as-p1'`;
    await insertAssurance(sql, {
      assuranceId: "t0205-as-p2",
      challengeId: "t0205-ch-p2",
      sessionId: SESSION_PAIR,
      tenantId: TENANT_A,
    });
    const [current] = await sql<{ assurance_id: string }[]>`
      SELECT assurance_id FROM ${sql(ASSURANCE_TABLE)}
       WHERE session_id = ${SESSION_PAIR} AND tenant_id = ${TENANT_A}
         AND status = 'active'`;
    expect(current?.assurance_id).toBe("t0205-as-p2");

    // The same session under another company is a different current-proof
    // key: the two companies' proofs coexist (company A revocation never
    // touches company B's proof).
    await insertChallenge(sql, {
      challengeId: "t0205-ch-p3",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_B,
      providerId: PROVIDER,
      state: "t0205-state-p3",
    });
    await consumeChallenge(sql, "t0205-state-p3");
    await insertAssurance(sql, {
      assuranceId: "t0205-as-p3",
      challengeId: "t0205-ch-p3",
      sessionId: SESSION_PAIR,
      tenantId: TENANT_B,
    });

    // Session rotation (§9.1 step 4): the proof binds the FINAL session, so
    // the composite FK deliberately excludes session — user, company,
    // provider and protocol still have to match the challenge exactly.
    await insertChallenge(sql, {
      challengeId: "t0205-ch-p4",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-p4",
    });
    await consumeChallenge(sql, "t0205-state-p4");
    await insertAssurance(sql, {
      assuranceId: "t0205-as-p4",
      challengeId: "t0205-ch-p4",
      sessionId: SESSION_ROTATED,
      tenantId: TENANT_A,
    });

    // Status and revocation time exist together or not at all.
    let refused = false;
    try {
      await sql`
        UPDATE ${sql(ASSURANCE_TABLE)} SET status = 'active'
         WHERE assurance_id = 't0205-as-p1'`;
    } catch (error) {
      refused = true;
      expect(sqlStateOf(error)).toBe("23514");
    }
    expect(refused).toBe(true);
  });

  test("proof_generations_and_validity_are_safe_integer_bounded", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    await insertChallenge(sql, {
      challengeId: "t0205-ch-g1",
      userId: USER_A,
      sessionId: SESSION_1,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-g1",
    });
    await consumeChallenge(sql, "t0205-state-g1");

    const refuse = async (row: Partial<AssuranceRow>) => {
      let inserted = true;
      try {
        await insertAssurance(sql, {
          assuranceId: "t0205-as-g-refused",
          challengeId: "t0205-ch-g1",
          sessionId: SESSION_GENERATIONS,
          ...row,
        });
      } catch (error) {
        inserted = false;
        expect(sqlStateOf(error)).toBe("23514");
      }
      expect(inserted).toBe(false);
    };

    // The issuance generations and the policy revision are Versions: wrapped
    // and negative values are refused by the database.
    await refuse({ identityGeneration: SAFE_MAX + 1 });
    await refuse({ identityGeneration: -1 });
    await refuse({ companyGeneration: SAFE_MAX + 1 });
    await refuse({ companyGeneration: -1 });
    await refuse({ policyRevision: SAFE_MAX + 1 });
    await refuse({ policyRevision: -1 });

    // The authentication method domain is closed to the two protocols the
    // evidence bridge can verify.
    await refuse({ authenticationMethod: "password" });

    // A proof cannot expire before the authentication it certifies — the
    // §9.1 floor is a CHECK, not a writer courtesy. (A proof that is merely
    // already past its computed expiry is refused by the issuing write path,
    // which is a policy comparison, not a storable-shape fact.)
    await refuse({
      authenticatedAt: new Date(Date.now() - 30_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    // The boundary is legal and inclusive: the ceiling is a Version.
    await insertAssurance(sql, {
      assuranceId: "t0205-as-g1",
      challengeId: "t0205-ch-g1",
      sessionId: SESSION_GENERATIONS,
      tenantId: TENANT_A,
      identityGeneration: SAFE_MAX,
      companyGeneration: SAFE_MAX,
      policyRevision: SAFE_MAX,
    });
    const [boundary] = await sql<{ identity_generation: string }[]>`
      SELECT identity_generation FROM ${sql(ASSURANCE_TABLE)}
       WHERE assurance_id = 't0205-as-g1'`;
    expect(Number(boundary?.identity_generation)).toBe(SAFE_MAX);
  });

  test("rotation_survives_old_session_deletion", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // §9.1 step 4: the challenge is issued in session S1, the verified
    // callback rotates the BA session, and the proof binds the FINAL session
    // S2. The old session must then be deletable — `sessions` rows are
    // ephemeral (T02.01's "sessions are ephemeral, receipts are not"), and a
    // revocation has no flag to set: deleting the row IS how an old session
    // dies.
    await insertChallenge(sql, {
      challengeId: "t0205-ch-r1",
      userId: USER_A,
      sessionId: SESSION_ROT_OLD,
      tenantId: TENANT_A,
      providerId: PROVIDER,
      state: "t0205-state-r1",
    });
    await consumeChallenge(sql, "t0205-state-r1");
    await insertAssurance(sql, {
      assuranceId: "t0205-as-r1",
      challengeId: "t0205-ch-r1",
      sessionId: SESSION_ROT_NEW,
      tenantId: TENANT_A,
    });

    // The old session goes; the challenge's session reference is historical
    // text, not a foreign key, so nothing cascades and nothing blocks.
    await sql`DELETE FROM sessions WHERE id = ${SESSION_ROT_OLD}`;
    const [gone] = await sql<{ id: string }[]>`
      SELECT id FROM sessions WHERE id = ${SESSION_ROT_OLD}`;
    expect(gone).toBeUndefined();

    // The challenge stays — with the historical session text — as the
    // durable audit anchor of the authorization attempt.
    const [challenge] = await sql<{ session_id: string }[]>`
      SELECT session_id FROM ${sql(CHALLENGE_TABLE)}
       WHERE challenge_id = 't0205-ch-r1'`;
    expect(challenge?.session_id).toBe(SESSION_ROT_OLD);

    // And the proof, bound to the final session, is untouched and current.
    const [proof] = await sql<{ status: string }[]>`
      SELECT status FROM ${sql(ASSURANCE_TABLE)}
       WHERE assurance_id = 't0205-as-r1'`;
    expect(proof?.status).toBe("active");
  });

  test("final_session_deletion_cascades_the_proof", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // Continues the rotation scenario: the proof created above is bound to
    // the FINAL session S2. Deleting that session physically removes its
    // proofs — the status model (revocation) governs logical expiry while
    // the session lives and is explicitly NOT a guard against deleting an
    // ephemeral session row (review r1's design decision).
    const [before] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${sql(ASSURANCE_TABLE)}
       WHERE session_id = ${SESSION_ROT_NEW}`;
    expect(Number(before?.count)).toBe(1);

    await sql`DELETE FROM sessions WHERE id = ${SESSION_ROT_NEW}`;
    const [after] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${sql(ASSURANCE_TABLE)}
       WHERE session_id = ${SESSION_ROT_NEW}`;
    expect(Number(after?.count)).toBe(0);

    // The challenge survives as the audit anchor even though both of its
    // sessions are gone.
    const [challenge] = await sql<{ challenge_id: string }[]>`
      SELECT challenge_id FROM ${sql(CHALLENGE_TABLE)}
       WHERE challenge_id = 't0205-ch-r1'`;
    expect(challenge?.challenge_id).toBe("t0205-ch-r1");
  });

  test("typed_schema_matches_applied_migration", async () => {
    const harness = await loadHarness();
    const sql = harness.sql;

    // The barrel carries the two new models: a schema table that exists but
    // is not exported is invisible to every consumer of the barrel.
    const tables = schema as unknown as Record<string, unknown>;
    const challengeTable = tables.authCompanyAuthChallenges;
    expect(
      challengeTable,
      "schema barrel exports authCompanyAuthChallenges",
    ).toBeDefined();
    const assuranceTable = tables.authCompanySessionAssurances;
    expect(
      assuranceTable,
      "schema barrel exports authCompanySessionAssurances",
    ).toBeDefined();

    const columnNames = (table: unknown) =>
      getTableConfig(table as Parameters<typeof getTableConfig>[0])
        .columns.map((column) => column.name)
        .sort();
    expect(columnNames(challengeTable)).toEqual([
      "challenge_id",
      "consumed_at",
      "created_at",
      "expires_at",
      "policy_revision",
      "protocol",
      "provider_id",
      "return_path",
      "secret_envelope",
      "session_id",
      "state_digest",
      "tenant_id",
      "user_id",
    ]);
    expect(columnNames(assuranceTable)).toEqual([
      "assurance_id",
      "authenticated_at",
      "authentication_method",
      "challenge_id",
      "company_generation",
      "created_at",
      "expires_at",
      "identity_generation",
      "issuer",
      "policy_revision",
      "principal_id",
      "provider_id",
      "revoked_at",
      "session_id",
      "status",
      "strength",
      "subject",
      "tenant_id",
      "user_id",
    ]);

    // The applied database agrees with the typed projection, column for
    // column, type for type — and only the two timestamps of state
    // transitions are nullable.
    const dbColumns = await sql<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }[]
    >`
      SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (${CHALLENGE_TABLE}, ${ASSURANCE_TABLE})
       ORDER BY table_name, column_name`;
    const observed = new Map(
      [...dbColumns].map((row) => [
        `${row.table_name}.${row.column_name}`,
        row,
      ]),
    );
    expect(observed.size).toBe(13 + 19);
    const bigintColumns = new Set([
      `${CHALLENGE_TABLE}.policy_revision`,
      `${ASSURANCE_TABLE}.policy_revision`,
      `${ASSURANCE_TABLE}.identity_generation`,
      `${ASSURANCE_TABLE}.company_generation`,
    ]);
    const nullableColumns = new Set([
      `${CHALLENGE_TABLE}.consumed_at`,
      `${ASSURANCE_TABLE}.revoked_at`,
    ]);
    for (const [key, row] of observed) {
      if (bigintColumns.has(key)) {
        expect([key, row.data_type]).toEqual([key, "bigint"]);
      } else if (key.endsWith("_at")) {
        expect([key, row.data_type]).toEqual([key, "timestamp with time zone"]);
      } else {
        expect([key, row.data_type]).toEqual([key, "text"]);
      }
      if (nullableColumns.has(key)) {
        expect([key, row.is_nullable]).toEqual([key, "YES"]);
      } else {
        expect([key, row.is_nullable]).toEqual([key, "NO"]);
      }
    }

    // The two one-per-something keys are real partial/unique indexes on the
    // applied database, not typed-schema claims.
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN (${CHALLENGE_TABLE}, ${ASSURANCE_TABLE})
       ORDER BY indexname`;
    const defs = new Map(
      [...indexes].map((row) => [row.indexname, row.indexdef]),
    );
    const currentStateKey = defs.get(
      "auth_company_session_assurance_current_uq",
    );
    expect(
      currentStateKey,
      "the (session_id, tenant_id) active-proof key exists",
    ).toBeDefined();
    expect(currentStateKey).toContain("UNIQUE");
    expect(currentStateKey).toContain("(session_id, tenant_id)");
    expect(currentStateKey).toContain("active");
    expect(defs.get("auth_company_session_assurance_challenge_uq")).toContain(
      "UNIQUE",
    );
    expect(defs.get("auth_company_auth_challenge_state_uq")).toContain(
      "UNIQUE",
    );
  });

  test("migration_replays_from_clean_state_without_touching_legacy", async () => {
    const harness = await loadHarness();

    // Exactly the two new tables, on the first apply and on the replay after
    // a full revert — nothing else appears or disappears, and not a single
    // existing column moved.
    expect(harness.firstApplyTableCount).toBe(harness.baselineTableCount + 2);
    expect(harness.replayTableCount).toBe(harness.baselineTableCount + 2);
    expect(harness.fingerprintAfter).toBe(harness.fingerprintBefore);
  });

  test("schema_file_is_registered_in_barrel_generator_and_journal", () => {
    // The journal carries this migration, appended after T02.04's 0212 and
    // still monotonic and gapless.
    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === `${MIGRATION_TAG}`,
    );
    expect(
      entry,
      `the drizzle journal registers ${MIGRATION_TAG}`,
    ).toBeDefined();
    expect(entry?.idx).toBe(213);
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].idx).toBe(
        journal.entries[index - 1].idx + 1,
      );
    }

    // Every schema file this task touched is listed in the generator's source
    // list — a file missing there is invisible to the next generated
    // migration, which could then emit destructive DDL against these tables.
    const config = readFileSync(
      join(import.meta.dirname, "../../drizzle.config.ts"),
      "utf8",
    );
    expect(
      config.includes("./src/db/schema/auth-assurance.ts"),
      "drizzle.config.ts lists auth-assurance.ts",
    ).toBe(true);

    // And the barrel re-exports the module, so every consumer of
    // server/src/db/schema sees the two models.
    const barrel = readFileSync(
      join(import.meta.dirname, "../../src/db/schema/index.ts"),
      "utf8",
    );
    expect(barrel.includes(`export * from "./auth-assurance"`)).toBe(true);
  });
});
