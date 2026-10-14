import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  enterpriseTestDatabaseNameFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const enabled = process.env.ENTERPRISE_TEST_PREFLIGHT_MODE === "fresh";
const ownedRelation = "enterprise_r1_fix1_owned_view";
const bypassRole = "enterprise_r1_fix1_bypass";
const bypassPassword = "fixture-only-fix1";

async function runMigration(databaseUrl: string, bootstrap: boolean) {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  if (bootstrap) env.OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES = "on";
  else delete env.OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES;

  const child = Bun.spawn(["bun", "scripts/migrate.ts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function expectNoMigrationDdl(database: ReturnType<typeof postgres>) {
  const [state] = await database.unsafe<
    { journal: string | null; users: string | null }[]
  >(`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS journal,
      to_regclass('public.users')::text AS users
  `);
  expect(state).toMatchObject({ journal: null, users: null });
}

test.skipIf(!enabled)(
  "migration preflight, bootstrap safety, and bootstrap rollback hold on a fresh isolated PostgreSQL database",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const parsedSetupUrl = new URL(setupUrl);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(
      parsedSetupUrl.hostname,
    );
    expect(enterpriseTestDatabaseNameFrom(setupUrl)).toContain("enterprise");

    const database = postgres(setupUrl, { max: 1 });
    let dataRoleCreated = false;
    let viewCreated = false;
    let bypassCreated = false;
    try {
      const [initial] = await database.unsafe<{ public_relations: number }[]>(`
        SELECT count(*)::int AS public_relations
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      `);
      expect(initial?.public_relations).toBe(0);
      await expectNoMigrationDdl(database);

      const missing = await runMigration(setupUrl, false);
      expect(missing.exitCode).not.toBe(0);
      expect(missing.output).toContain("ENTERPRISE_ROLE_PREREQUISITES_UNSAFE");
      await expectNoMigrationDdl(database);

      await database.unsafe(`CREATE ROLE ob_ent_data NOLOGIN REPLICATION`);
      dataRoleCreated = true;
      const replication = await runMigration(setupUrl, true);
      expect(replication.exitCode).not.toBe(0);
      expect(replication.output).toContain("ob_ent_data");
      expect(replication.output).toContain("unsafe or missing attributes");
      const [afterReplication] = await database.unsafe<{ roles: string[] }[]>(`
        SELECT array_agg(rolname ORDER BY rolname) AS roles
        FROM pg_roles
        WHERE rolname IN (
          'ob_ent_directory', 'ob_ent_data', 'ob_ent_operator', 'ob_ent_identity_operator'
        )
      `);
      expect(afterReplication?.roles).toEqual(["ob_ent_data"]);
      await expectNoMigrationDdl(database);

      await database.unsafe(`ALTER ROLE ob_ent_data NOREPLICATION`);
      await database.unsafe(
        `CREATE VIEW public.${ownedRelation} AS SELECT 1 AS id`,
      );
      viewCreated = true;
      await database.unsafe(
        `ALTER VIEW public.${ownedRelation} OWNER TO ob_ent_data`,
      );
      const ownership = await runMigration(setupUrl, true);
      expect(ownership.exitCode).not.toBe(0);
      expect(ownership.output).toContain(
        "owns a protected enterprise relation",
      );
      const [afterOwnership] = await database.unsafe<{ roles: string[] }[]>(`
        SELECT array_agg(rolname ORDER BY rolname) AS roles
        FROM pg_roles
        WHERE rolname IN (
          'ob_ent_directory', 'ob_ent_data', 'ob_ent_operator', 'ob_ent_identity_operator'
        )
      `);
      expect(afterOwnership?.roles).toEqual(["ob_ent_data"]);
      await expectNoMigrationDdl(database);

      await database.unsafe(
        `CREATE ROLE ${bypassRole} LOGIN BYPASSRLS PASSWORD '${bypassPassword}'`,
      );
      bypassCreated = true;
      const bypassUrl = new URL(setupUrl);
      bypassUrl.username = bypassRole;
      bypassUrl.password = bypassPassword;
      const insufficientIdentity = await runMigration(
        bypassUrl.toString(),
        true,
      );
      expect(insufficientIdentity.exitCode).not.toBe(0);
      expect(insufficientIdentity.output).toContain(
        "direct PostgreSQL superuser session",
      );
      await expectNoMigrationDdl(database);
    } finally {
      if (viewCreated)
        await database.unsafe(`DROP VIEW IF EXISTS public.${ownedRelation}`);
      if (bypassCreated)
        await database.unsafe(`DROP ROLE IF EXISTS ${bypassRole}`);
      if (dataRoleCreated)
        await database.unsafe("DROP ROLE IF EXISTS ob_ent_data");
      await database.end({ timeout: 5 });
    }
  },
);
