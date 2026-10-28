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
import {
  authInvitations,
  authMembers,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
} from "../../src/db/schema/auth-directory";

/*
 * T02.01 (#523, P03) — the BA directory schema and the stable business-ID
 * mapping, checked against the real migration on the isolated BA_TEST_* stack.
 *
 * What this file pins, and why each part is a database fact rather than a code
 * convention:
 *
 * - `same_workspace_ids_map_to_distinct_ba_teams`: a workspace id is only unique
 *   inside a tenant (`enterprise_workspaces` PK is (tenant_id, id)). Two
 *   companies with the same workspace id must therefore get two different,
 *   globally unique BA team ids, joined back to their own (tenant, workspace)
 *   by `auth_team_bindings`.
 * - `binding_cannot_move_between_companies`: changing a binding's tenant — or
 *   moving a bound team to another organization — must be refused by the
 *   database, not merely by a service check. The composite FK
 *   (team_id, tenant_id) -> auth_teams (id, organization_id) is the refusal.
 * - `typed_schema_matches_applied_migration`: the Drizzle projection and the SQL
 *   that every environment actually runs cannot drift; table/column/constraint
 *   names are compared through introspection.
 * - `migration_replays_on_the_baseline_without_touching_existing_tables`: the
 *   expand migration applies on the 251-table baseline, leaves legacy identity
 *   and FK rows byte-for-byte intact, and re-applies identically from a clean
 *   state.
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance shape);
 * a missing one is a blocked suite, never a silent fallback to the shared, MT or
 * job-level database. No DSN is ever printed — refusals name the variable.
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
const AUTH_TABLES = [
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_invitations",
] as const;
const MIGRATION_PATH = join(
  import.meta.dirname,
  "../../drizzle/0221_better_auth_directory.sql",
);
const TENANT_A = "t0201-tenant-a";
const TENANT_B = "t0201-tenant-b";
const SHARED_WORKSPACE_ID = "ws-shared";
const TEAM_A = "t0201-team-a";
const TEAM_B = "t0201-team-b";

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

const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

async function dropAuthDirectoryTables(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${AUTH_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
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
       AND table_name <> ALL(${AUTH_TABLES as unknown as string[]})
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

interface LegacySnapshot {
  tenants: unknown[];
  workspaces: unknown[];
  memberships: unknown[];
  fingerprint: string;
}

async function legacySnapshot(sql: postgres.Sql): Promise<LegacySnapshot> {
  const tenants = await sql`
    SELECT id, name, status, policy_revision
      FROM enterprise_tenants WHERE id LIKE 't0201-%' ORDER BY id`;
  const workspaces = await sql`
    SELECT tenant_id, id, name
      FROM enterprise_workspaces WHERE tenant_id LIKE 't0201-%'
     ORDER BY tenant_id, id`;
  const memberships = await sql`
    SELECT tenant_id, principal_id, role, epoch
      FROM enterprise_memberships WHERE tenant_id LIKE 't0201-%'
     ORDER BY tenant_id`;
  return {
    tenants: [...tenants],
    workspaces: [...workspaces],
    memberships: [...memberships],
    fingerprint: await publicColumnFingerprint(sql),
  };
}

async function applyMigration(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

async function seedLegacyFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO enterprise_tenants (id, name) VALUES
      (${TENANT_A}, 'T02.01 company A'),
      (${TENANT_B}, 'T02.01 company B')`;
  await sql`
    INSERT INTO users (id, email) VALUES
      ('t0201-user-a', 't0201-user-a@example.test'),
      ('t0201-user-b', 't0201-user-b@example.test')`;
  // The same workspace id in two companies: legal by the composite PK, and the
  // exact shape the mapping must keep apart.
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name) VALUES
      (${TENANT_A}, ${SHARED_WORKSPACE_ID}, 'Shared workspace (A)'),
      (${TENANT_B}, ${SHARED_WORKSPACE_ID}, 'Shared workspace (B)'),
      (${TENANT_B}, 'ws-t0201-b2', 'Second workspace (B)')`;
  await sql`
    INSERT INTO enterprise_principals (id, user_id) VALUES
      ('t0201-principal-a', 't0201-user-a'),
      ('t0201-principal-b', 't0201-user-b')`;
  await sql`
    INSERT INTO enterprise_memberships (tenant_id, principal_id, role, epoch) VALUES
      (${TENANT_A}, 't0201-principal-a', 'member', 3),
      (${TENANT_B}, 't0201-principal-b', 'member', 5)`;
}

async function seedAuthDirectory(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO auth_organizations (id, name, slug) VALUES
      (${TENANT_A}, 'T02.01 company A', 't0201-tenant-a'),
      (${TENANT_B}, 'T02.01 company B', 't0201-tenant-b')`;
  await sql`
    INSERT INTO enterprise_workspaces (tenant_id, id, name)
    VALUES (${TENANT_A}, 'ws-move-a', 'Movable workspace (A)')`;
  await sql`
    INSERT INTO auth_teams (id, organization_id, name) VALUES
      (${TEAM_A}, ${TENANT_A}, 'Team A'),
      (${TEAM_B}, ${TENANT_B}, 'Team B'),
      ('t0201-team-move-a', ${TENANT_A}, 'Team move A')`;
  await sql`
    INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id) VALUES
      (${TENANT_A}, ${SHARED_WORKSPACE_ID}, ${TEAM_A}),
      (${TENANT_B}, ${SHARED_WORKSPACE_ID}, ${TEAM_B}),
      (${TENANT_A}, 'ws-move-a', 't0201-team-move-a')`;
  await sql`
    INSERT INTO auth_members (id, organization_id, user_id, role) VALUES
      ('t0201-member-a', ${TENANT_A}, 't0201-user-a', 'owner'),
      ('t0201-member-b', ${TENANT_B}, 't0201-user-b', 'member')`;
  await sql`
    INSERT INTO auth_team_members (id, team_id, user_id, membership_key) VALUES
      ('t0201-team-member-a', ${TEAM_A}, 't0201-user-a', 'key-t0201-a'),
      ('t0201-team-member-b', ${TEAM_B}, 't0201-user-b', 'key-t0201-b')`;
  await sql`
    INSERT INTO auth_invitations
      (id, organization_id, email, role, status, team_id, inviter_id, expires_at)
    VALUES
      ('t0201-invitation-a', ${TENANT_A}, 't0201-invitee@example.test',
       'member', 'pending', ${TEAM_A}, 't0201-user-a', now() + interval '1 day')`;
}

interface BindingRow {
  tenantId: string;
  workspaceId: string;
  teamId: string;
}

interface Harness {
  sql: postgres.Sql;
  baselineTableCount: number;
  firstApplyTableCount: number;
  replayTableCount: number;
  legacyBefore: LegacySnapshot;
  legacyAfter: LegacySnapshot;
  /** Idempotent: the directory rows every data-shaped assertion needs. */
  seed(): Promise<void>;
  bindingsForWorkspace(workspaceId: string): Promise<BindingRow[]>;
  close(): Promise<void>;
}

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await dropAuthDirectoryTables(sql);
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE 't0201-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0201-%'`;
}

async function createHarness(): Promise<Harness> {
  const { setup } = readBaUrls();
  const sql = postgres(setup, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });

  let seeded: Promise<void> | undefined;
  try {
    // A crashed earlier run may have left the expand tables behind; the
    // migration is a real expand migration, so it applies to a clean state, not
    // over itself.
    await cleanupFixture(sql);

    await seedLegacyFixture(sql);
    const legacyBefore = await legacySnapshot(sql);
    const baselineTableCount = await countPublicTables(sql);

    await applyMigration(sql);
    const firstApplyTableCount = await countPublicTables(sql);
    await dropAuthDirectoryTables(sql);
    await applyMigration(sql);
    const replayTableCount = await countPublicTables(sql);
    const legacyAfter = await legacySnapshot(sql);

    return {
      sql,
      baselineTableCount,
      firstApplyTableCount,
      replayTableCount,
      legacyBefore,
      legacyAfter,
      seed: () => (seeded ??= seedAuthDirectory(sql)),
      bindingsForWorkspace: async (workspaceId) => {
        const rows = await sql<
          { tenant_id: string; workspace_id: string; team_id: string }[]
        >`
          SELECT tenant_id, workspace_id, team_id
            FROM auth_team_bindings
           WHERE workspace_id = ${workspaceId}
           ORDER BY tenant_id`;
        return rows.map((row) => ({
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          teamId: row.team_id,
        }));
      },
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

describe("T02.01 BA directory schema bindings", () => {
  afterAll(async () => {
    const created = await harnessPromise?.catch(() => undefined);
    if (!created) return;
    await created.close();
    // A fresh probe, so the leak check sees the cleaned database rather than the
    // harness's released pool.
    const { setup } = readBaUrls();
    const probe = postgres(setup, { max: 1 });
    try {
      const leftover = await probe<{ name: string }[]>`
        SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${AUTH_TABLES as unknown as string[]})`;
      expect(leftover.map((row) => row.name).sort()).toEqual([]);
      const tenants = await probe`
        SELECT id FROM enterprise_tenants WHERE id LIKE 't0201-%'`;
      expect([...tenants]).toEqual([]);
    } finally {
      await probe.end({ timeout: 5 }).catch(() => {});
    }
  });

  test("same_workspace_ids_map_to_distinct_ba_teams", async () => {
    const harness = await loadHarness();
    await harness.seed();

    const bindings = await harness.bindingsForWorkspace(SHARED_WORKSPACE_ID);
    expect(bindings.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_B]);

    const teamA = bindings.find((row) => row.tenantId === TENANT_A)?.teamId;
    const teamB = bindings.find((row) => row.tenantId === TENANT_B)?.teamId;
    expect(teamA).not.toBe(teamB);
    expect(teamA).toBe(TEAM_A);
    expect(teamB).toBe(TEAM_B);

    // Each team carries its own organization, and each binding's workspace
    // resolves inside its own company only.
    const rows = await harness.sql<
      { team_id: string; organization_id: string }[]
    >`
      SELECT t.id AS team_id, t.organization_id
        FROM auth_teams t
        JOIN auth_team_bindings b ON b.team_id = t.id
       WHERE b.workspace_id = ${SHARED_WORKSPACE_ID}
       ORDER BY t.organization_id`;
    expect(rows).toEqual([
      { team_id: TEAM_A, organization_id: TENANT_A },
      { team_id: TEAM_B, organization_id: TENANT_B },
    ]);

    const workspaces = await harness.sql`
      SELECT tenant_id FROM enterprise_workspaces WHERE id = ${SHARED_WORKSPACE_ID}
       ORDER BY tenant_id`;
    expect(workspaces.map((row) => row.tenant_id)).toEqual([
      TENANT_A,
      TENANT_B,
    ]);
  });

  test("binding_cannot_move_between_companies", async () => {
    const harness = await loadHarness();
    await harness.seed();
    const before = await harness.bindingsForWorkspace(SHARED_WORKSPACE_ID);

    // Company B has a workspace with a *different* id, so re-pointing this
    // binding to company B collides with no primary key: the only thing that
    // can refuse it is the composite (team_id, tenant_id) team foreign key.
    let committed = true;
    try {
      await harness.sql`
        UPDATE auth_team_bindings SET tenant_id = ${TENANT_B}
         WHERE tenant_id = ${TENANT_A} AND workspace_id = 'ws-move-a'`;
    } catch (error) {
      committed = false;
      expect(sqlStateOf(error)).toBe("23503");
    }
    expect(committed).toBe(false);

    // The same invariant read from the business side: the workspace is still
    // bound inside company A.
    const [binding] = await harness.sql<
      { tenant_id: string; team_id: string }[]
    >`
      SELECT tenant_id, team_id FROM auth_team_bindings
       WHERE workspace_id = 'ws-move-a'`;
    expect(binding).toEqual({
      tenant_id: TENANT_A,
      team_id: "t0201-team-move-a",
    });

    // A shared workspace id does not become a loophole either: re-pointing its
    // binding is refused (by the mapping key and/or the team FK), left intact.
    let sharedMoved = true;
    try {
      await harness.sql`
        UPDATE auth_team_bindings SET tenant_id = ${TENANT_B}
         WHERE tenant_id = ${TENANT_A} AND workspace_id = ${SHARED_WORKSPACE_ID}`;
    } catch {
      sharedMoved = false;
    }
    expect(sharedMoved).toBe(false);
    expect(await harness.bindingsForWorkspace(SHARED_WORKSPACE_ID)).toEqual(
      before,
    );

    // The same invariant from the team's side: moving a bound team to another
    // organization has no matching binding row and is refused too.
    let teamMoved = true;
    try {
      await harness.sql`
        UPDATE auth_teams SET organization_id = ${TENANT_B}
         WHERE id = ${TEAM_A}`;
    } catch (error) {
      teamMoved = false;
      expect(sqlStateOf(error)).toBe("23503");
    }
    expect(teamMoved).toBe(false);

    const [team] = await harness.sql<{ organization_id: string }[]>`
      SELECT organization_id FROM auth_teams WHERE id = ${TEAM_A}`;
    expect(team?.organization_id).toBe(TENANT_A);
  });

  test("binding_keys_and_cross_company_insert_are_refused", async () => {
    const harness = await loadHarness();
    await harness.seed();

    // A second workspace in company B exists, and this team of company A is not
    // bound yet, so the (team_id, tenant_id) foreign key is the only thing that
    // can refuse the cross-company binding (no unique conflict to mask it).
    await harness.sql`
      INSERT INTO auth_teams (id, organization_id, name)
      VALUES ('t0201-team-a-free', ${TENANT_A}, 'Unbound team A')`;
    let crossCompanyInserted = true;
    try {
      await harness.sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT_B}, 'ws-t0201-b2', 't0201-team-a-free')`;
    } catch (error) {
      crossCompanyInserted = false;
      expect(sqlStateOf(error)).toBe("23503");
    }
    expect(crossCompanyInserted).toBe(false);

    // (tenant_id, workspace_id) is the mapping key: one binding per workspace.
    let duplicateWorkspaceInserted = true;
    try {
      await harness.sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT_A}, ${SHARED_WORKSPACE_ID}, 't0201-team-a2')`;
    } catch (error) {
      duplicateWorkspaceInserted = false;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(duplicateWorkspaceInserted).toBe(false);

    // team_id is unique: one team backs exactly one workspace.
    let duplicateTeamInserted = true;
    try {
      await harness.sql`
        INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
        VALUES (${TENANT_B}, 'ws-t0201-b2', ${TEAM_B})`;
    } catch (error) {
      duplicateTeamInserted = false;
      expect(sqlStateOf(error)).toBe("23505");
    }
    expect(duplicateTeamInserted).toBe(false);

    // The positive shape still works: company B's second workspace binds to a
    // fresh team in company B.
    await harness.sql`
      INSERT INTO auth_teams (id, organization_id, name)
      VALUES ('t0201-team-b2', ${TENANT_B}, 'Team B2')`;
    await harness.sql`
      INSERT INTO auth_team_bindings (tenant_id, workspace_id, team_id)
      VALUES (${TENANT_B}, 'ws-t0201-b2', 't0201-team-b2')`;
    const [bound] = await harness.sql<{ team_id: string }[]>`
      SELECT team_id FROM auth_team_bindings
       WHERE tenant_id = ${TENANT_B} AND workspace_id = 'ws-t0201-b2'`;
    expect(bound?.team_id).toBe("t0201-team-b2");
  });

  test("migration_replays_on_the_baseline_without_touching_existing_tables", async () => {
    const harness = await loadHarness();
    // 251-table baseline plus the six expand tables, both on the first apply and
    // on a replay from a clean state.
    expect(harness.baselineTableCount).toBeGreaterThanOrEqual(251);
    expect(harness.firstApplyTableCount).toBe(
      harness.baselineTableCount + AUTH_TABLES.length,
    );
    expect(harness.replayTableCount).toBe(harness.firstApplyTableCount);

    // Legacy identity/FK rows and every existing public column are untouched by
    // the expand migration.
    expect(harness.legacyAfter).toEqual(harness.legacyBefore);
    expect(harness.legacyBefore.tenants).toHaveLength(2);
    expect(harness.legacyBefore.memberships).toHaveLength(2);
    expect(harness.legacyAfter.fingerprint).toBe(
      harness.legacyBefore.fingerprint,
    );
  });

  test("schema_file_is_registered_in_barrel_generator_and_journal", () => {
    const barrel = readFileSync(
      join(import.meta.dirname, "../../src/db/schema/index.ts"),
      "utf8",
    );
    expect(barrel).toContain('export * from "./auth-directory";');

    const config = readFileSync(
      join(import.meta.dirname, "../../drizzle.config.ts"),
      "utf8",
    );
    expect(config).toContain('"./src/db/schema/auth-directory.ts"');

    const journal = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === "0221_better_auth_directory",
    );
    expect(entry?.idx).toBe(209);
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    // The journal stays monotonic: a later task appends, it never renumbers.
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].idx).toBeGreaterThan(
        journal.entries[index - 1].idx,
      );
    }
  });

  test("typed_schema_matches_applied_migration", async () => {
    const harness = await loadHarness();
    const tables = [
      authOrganizations,
      authTeams,
      authTeamBindings,
      authMembers,
      authTeamMembers,
      authInvitations,
    ];
    const sql = harness.sql;

    const columns = await sql<
      {
        table_name: string;
        column_name: string;
        is_nullable: string;
      }[]
    >`
      SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY(${AUTH_TABLES as unknown as string[]})`;

    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = columns.filter(
        (column) => column.table_name === config.name,
      );
      expect(
        actual.map((column) => column.column_name).sort(),
        `${config.name} columns`,
      ).toEqual(config.columns.map((column) => column.name).sort());
      for (const column of config.columns) {
        const found = actual.find(
          (candidate) => candidate.column_name === column.name,
        );
        expect(found, `${config.name}.${column.name} exists`).toBeDefined();
        expect(
          found?.is_nullable === "NO",
          `${config.name}.${column.name} nullability`,
        ).toBe(column.notNull);
      }
    }

    // The composite foreign keys that carry the invariants above are present
    // with the referenced columns the migration promises.
    const foreignKeys = await sql<
      {
        constraint_name: string;
        table_name: string;
        foreign_table: string;
        columns: string[];
        foreign_columns: string[];
      }[]
    >`
      SELECT con.conname AS constraint_name,
             rel.relname AS table_name,
             frel.relname AS foreign_table,
             ARRAY(
               SELECT att.attname
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = con.conrelid AND att.attnum = k.attnum
                ORDER BY k.ord
             ) AS columns,
             ARRAY(
               SELECT att.attname
                 FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = con.confrelid AND att.attnum = k.attnum
                ORDER BY k.ord
             ) AS foreign_columns
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        JOIN pg_class frel ON frel.oid = con.confrelid
       WHERE con.contype = 'f'
         AND n.nspname = 'public'
         AND rel.relname = ANY(${AUTH_TABLES as unknown as string[]})`;

    const bindingTeam = foreignKeys.find(
      (fk) => fk.constraint_name === "auth_team_binding_team_fk",
    );
    expect(bindingTeam).toEqual({
      constraint_name: "auth_team_binding_team_fk",
      table_name: "auth_team_bindings",
      foreign_table: "auth_teams",
      columns: ["team_id", "tenant_id"],
      foreign_columns: ["id", "organization_id"],
    });
    const bindingWorkspace = foreignKeys.find(
      (fk) => fk.constraint_name === "auth_team_binding_workspace_fk",
    );
    expect(bindingWorkspace).toEqual({
      constraint_name: "auth_team_binding_workspace_fk",
      table_name: "auth_team_bindings",
      foreign_table: "enterprise_workspaces",
      columns: ["tenant_id", "workspace_id"],
      foreign_columns: ["tenant_id", "id"],
    });
    const organizationTenant = foreignKeys.find(
      (fk) => fk.constraint_name === "auth_organization_tenant_fk",
    );
    expect(organizationTenant).toEqual({
      constraint_name: "auth_organization_tenant_fk",
      table_name: "auth_organizations",
      foreign_table: "enterprise_tenants",
      columns: ["id"],
      foreign_columns: ["id"],
    });

    // Every named constraint in the typed schema exists on the applied tables.
    const constraintNames = await sql<{ conname: string }[]>`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public'
         AND rel.relname = ANY(${AUTH_TABLES as unknown as string[]})`;
    const present = new Set(constraintNames.map((row) => row.conname));
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        const name = fk.getName();
        expect(present.has(name), `${config.name}: ${name}`).toBe(true);
      }
      for (const check of config.checks) {
        expect(present.has(check.name), `${config.name}: ${check.name}`).toBe(
          true,
        );
      }
    }

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY(${AUTH_TABLES as unknown as string[]})`;
    const indexNames = new Set(indexes.map((row) => row.indexname));
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const index of config.indexes) {
        expect(indexNames.has(index.config.name!), index.config.name).toBe(
          true,
        );
      }
    }
  });
});
