// server/tests/package-pk-names-migration.integration.test.ts
/*
 * OCRfix-3 (OCR-F6, 2026-10-26): the repair migration 0216 had no runtime coverage — the
 * fresh-chain no-op was the only branch CI ever executed, and the legacy-rename branch had
 * only ever been verified by hand on throwaway databases.
 *
 * Each case drives the real deployment engine — migrateWithValidationBoundary from
 * scripts/migration-runner.ts, the same code server/scripts/migrate.ts runs — against a
 * throwaway database created for the run and dropped at the end, and pins one branch of the
 * guard:
 *
 *   legacy     — every table still carrying `<table>_pkey` (the shape the pre-#652 0210 left
 *                on any database that migrated from origin/main's older revision) is renamed
 *                onto its target name, backing index following;
 *   failure    — a primary key named neither legacy nor target aborts the deployment with the
 *                OCR-F5 exception (a NOTICE would be swallowed by migrate.ts's
 *                onnotice: () => {}), and the file's single transaction rolls the renames
 *                that ran before it back;
 *   idempotent — a database already carrying the target names replays the file's own text as
 *                a zero-operation no-op.
 *
 * Environment contract: TEST_DATABASE_URL, the dedicated test database, whose role must also
 * be allowed CREATE DATABASE — the same trust schema-migration-r2 places in that URL. A
 * missing URL skips the whole suite with the reason in the case name; there is never a
 * fallback to another database.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import {
  migrateWithValidationBoundary,
  sqlStateFromError,
} from "../scripts/migration-runner";
import { testDatabaseUrlFrom } from "./support/database";

const hereDir = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(hereDir, "../drizzle");
const migrationFile = "0216_enterprise_package_primary_key_names.sql";

/*
 * The eight (table, target) pairs the guard converges, in the order its VALUES loop visits
 * them. The failure case relies on plans being visited before pins, so an exception on the
 * last table proves the renames before it rolled back.
 */
const TARGETS = [
  {
    table: "enterprise_package_plans",
    columns: "tenant_id text NOT NULL, id text NOT NULL",
    primaryKey: "tenant_id, id",
    target: "enterprise_package_plans_tenant_id_id_pk",
  },
  {
    table: "enterprise_package_revisions",
    columns:
      "tenant_id text NOT NULL, install_id text NOT NULL, revision text NOT NULL",
    primaryKey: "tenant_id, install_id, revision",
    target: "enterprise_package_revisions_tenant_id_install_id_revision_pk",
  },
  {
    table: "enterprise_package_installs",
    columns: "tenant_id text NOT NULL, id text NOT NULL",
    primaryKey: "tenant_id, id",
    target: "enterprise_package_installs_tenant_id_id_pk",
  },
  {
    table: "enterprise_package_grants",
    columns: "id text NOT NULL",
    primaryKey: "id",
    target: "enterprise_package_grant_pk",
  },
  {
    table: "enterprise_package_experts",
    columns: "id text NOT NULL",
    primaryKey: "id",
    target: "enterprise_package_expert_pk",
  },
  {
    table: "enterprise_package_resource_links",
    columns: "id text NOT NULL",
    primaryKey: "id",
    target: "enterprise_package_link_pk",
  },
  {
    table: "enterprise_package_changes",
    columns: "tenant_id text NOT NULL, change_id text NOT NULL",
    primaryKey: "tenant_id, change_id",
    target: "enterprise_package_changes_tenant_id_change_id_pk",
  },
  {
    table: "enterprise_run_package_pins",
    columns: "id text NOT NULL",
    primaryKey: "id",
    target: "enterprise_run_package_pin_pk",
  },
] as const;
const TABLE_NAMES = TARGETS.map((entry) => entry.table);
const TARGET_OF = new Map(TARGETS.map((entry) => [entry.table, entry.target]));

const environment = (() => {
  try {
    testDatabaseUrlFrom(process.env);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
})();

const itMigration = (name: string, fn: () => Promise<void>) =>
  test.skipIf(!environment.ok)(
    environment.ok ? name : `${name} [skipped: ${environment.reason}]`,
    fn,
    120_000,
  );

const scratchNames: string[] = [];
const stagingDirectories: string[] = [];
let administrator: ReturnType<typeof postgres> | undefined;

function administratorClient(): ReturnType<typeof postgres> {
  administrator ??= postgres(testDatabaseUrlFrom(process.env), { max: 1 });
  return administrator;
}

function urlFor(name: string): string {
  const url = new URL(testDatabaseUrlFrom(process.env));
  url.pathname = `/${name}`;
  return url.toString();
}

async function createScratchDatabase(label: string) {
  const name = `openbot_0216_guard_${label}_${randomUUID().replaceAll("-", "")}`;
  await administratorClient().unsafe(`CREATE DATABASE "${name}"`);
  scratchNames.push(name);
  return {
    name,
    url: urlFor(name),
    async drop() {
      // WITH (FORCE) terminates the suite's own backends first — the terminate-then-drop
      // step the manual recipe uses, in one statement, so nothing outlives the run.
      await administratorClient().unsafe(
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      );
    },
  };
}

/*
 * The guard's file alone in a staging folder: one journal entry (idx 216) over one SQL file.
 * That is the same journal surgery schema-migration-r2 uses for its window fixtures, and it
 * puts the deployment engine — not a hand-copied statement — in charge of applying the file.
 */
async function migrationFolderWithOnlyTheGuard(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-0216-guard-"));
  stagingDirectories.push(directory);
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx === 216);
  if (journal.entries.length !== 1) {
    throw new Error(
      "server/drizzle's journal no longer carries exactly one entry at idx 216.",
    );
  }
  await cp(join(migrationsRoot, migrationFile), join(directory, migrationFile));
  await mkdir(join(directory, "meta"), { recursive: true });
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  return directory;
}

async function createLegacyShape(
  client: ReturnType<typeof postgres>,
  targets: ReadonlyArray<(typeof TARGETS)[number]> = TARGETS,
) {
  // An anonymous PRIMARY KEY lands as `<table>_pkey` — the default name PostgreSQL generated
  // for every one of these tables under the pre-#652 0210.
  for (const shape of targets) {
    await client.unsafe(
      `CREATE TABLE public.${shape.table} (${shape.columns}, PRIMARY KEY (${shape.primaryKey}))`,
    );
  }
}

async function primaryKeys(client: ReturnType<typeof postgres>) {
  const rows = await client`
    SELECT c.relname AS table_name,
           con.conname AS constraint_name,
           idx.relname AS index_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class idx ON idx.oid = con.conindid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'p'
      AND n.nspname = 'public'
      AND c.relname = ANY(${TABLE_NAMES})
    ORDER BY c.relname
  `;
  return rows as unknown as Array<{
    table_name: string;
    constraint_name: string;
    index_name: string;
  }>;
}

itMigration(
  "0216 renames all eight legacy <table>_pkey primary keys onto the target names, backing index following",
  async () => {
    const scratch = await createScratchDatabase("legacy");
    const folder = await migrationFolderWithOnlyTheGuard();
    const notices: string[] = [];
    const client = postgres(scratch.url, {
      max: 1,
      onnotice: (notice) => notices.push(String(notice.message)),
    });
    try {
      await createLegacyShape(client);
      const before = await primaryKeys(client);
      expect(before.map((row) => row.constraint_name).sort()).toEqual(
        [...TABLE_NAMES].map((table) => `${table}_pkey`).sort(),
      );

      await migrateWithValidationBoundary(client, folder);

      const after = await primaryKeys(client);
      expect(after).toHaveLength(8);
      for (const row of after) {
        // RENAME CONSTRAINT carries the backing index with it, so both must read as the target.
        expect(row.constraint_name).toBe(TARGET_OF.get(row.table_name));
        expect(row.index_name).toBe(TARGET_OF.get(row.table_name));
      }
      // The rename branch announced every one of its eight operations.
      expect(notices).toHaveLength(8);
    } finally {
      await client.end({ timeout: 5 });
      await scratch.drop();
    }
  },
);

itMigration(
  "a primary key named neither legacy nor target aborts the deployment and rolls the file's renames back",
  async () => {
    const scratch = await createScratchDatabase("odd");
    const folder = await migrationFolderWithOnlyTheGuard();
    const client = postgres(scratch.url, { max: 1 });
    try {
      // plans is visited first by the guard's loop and carries the legacy name; pins is
      // visited last and carries a name no revision of this chain ever authored.
      await createLegacyShape(
        client,
        TARGETS.filter((entry) => entry.table === "enterprise_package_plans"),
      );
      await client.unsafe(`
        CREATE TABLE public.enterprise_run_package_pins (
          id text NOT NULL,
          CONSTRAINT zz_other_pk PRIMARY KEY (id)
        )
      `);

      let failure: unknown;
      try {
        await migrateWithValidationBoundary(client, folder);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      // Drizzle puts the query text in `message` and keeps the server's error in `cause`, so
      // the RAISE text is asserted against the whole chain, the way migration-runner reads it.
      const chain: string[] = [];
      for (
        let cursor: unknown = failure;
        cursor instanceof Error;
        cursor = (cursor as { cause?: unknown }).cause
      ) {
        chain.push(cursor.message);
      }
      const message = chain.join("\n");
      expect(sqlStateFromError(failure)).toBe("P0001");
      expect(message).toContain("enterprise_run_package_pins");
      expect(message).toContain("enterprise_run_package_pins_pkey");
      expect(message).toContain("enterprise_run_package_pin_pk");
      expect(message).toContain("settle the live constraint name by hand");

      // One migration file runs inside one transaction: the rename of plans that ran before
      // the exception must not survive the abort. The runner may have force-ended the first
      // client, so read the post-mortem shape through a fresh one.
      const inspector = postgres(scratch.url, { max: 1 });
      try {
        const keys = await primaryKeys(inspector);
        expect(
          keys.map((row) => `${row.table_name}:${row.constraint_name}`).sort(),
        ).toEqual([
          "enterprise_package_plans:enterprise_package_plans_pkey",
          "enterprise_run_package_pins:zz_other_pk",
        ]);
      } finally {
        await inspector.end({ timeout: 5 });
      }
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await scratch.drop();
    }
  },
);

itMigration(
  "replaying 0216 on a converged database is a zero-operation no-op",
  async () => {
    const scratch = await createScratchDatabase("replay");
    const folder = await migrationFolderWithOnlyTheGuard();
    const notices: string[] = [];
    const client = postgres(scratch.url, {
      max: 1,
      onnotice: (notice) => notices.push(String(notice.message)),
    });
    try {
      // grants arrives already converged (the fresh-chain shape); plans arrives legacy.
      await client.unsafe(`
        CREATE TABLE public.enterprise_package_grants (
          id text NOT NULL,
          CONSTRAINT enterprise_package_grant_pk PRIMARY KEY (id)
        )
      `);
      await createLegacyShape(
        client,
        TARGETS.filter((entry) => entry.table === "enterprise_package_plans"),
      );

      await migrateWithValidationBoundary(client, folder);
      expect(notices).toHaveLength(1); // only plans was renamed; the converged table stayed silent
      const converged = await primaryKeys(client);
      expect(converged.map((row) => row.constraint_name).sort()).toEqual(
        [
          "enterprise_package_grant_pk",
          "enterprise_package_plans_tenant_id_id_pk",
        ].sort(),
      );

      // Replay the file's own text, journal aside: this is the content-level replay an
      // operator would run by hand, so nothing may change and nothing may be emitted.
      notices.length = 0;
      await client.unsafe(
        await readFile(join(migrationsRoot, migrationFile), "utf8"),
      );
      expect(notices).toHaveLength(0);
      expect(await primaryKeys(client)).toEqual(converged);
    } finally {
      await client.end({ timeout: 5 });
      await scratch.drop();
    }
  },
);

afterAll(async () => {
  // The per-test finally blocks already dropped their databases; this is the net for a test
  // that failed between CREATE DATABASE and its own drop.
  for (const name of scratchNames) {
    await administratorClient()
      .unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
  }
  if (administrator)
    await administrator.end({ timeout: 5 }).catch(() => undefined);
  for (const directory of stagingDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});
