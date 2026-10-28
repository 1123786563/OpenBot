import { expect, test } from "../../../tests/support/e2e-compat";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { PgRolePrivilegeFlags } from "../../scripts/enterprise-test-db-guard";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
  ROLE_DATABASE_VARIABLES,
} from "../support/enterprise-database";

const quotedForeignRole = 'weird"role';
// CI's test job carries the enterprise role URLs as job-level env; without
// them the whole enterprise database fixture is absent, so skip like the
// other database-gated suites do locally.
const rawRoleUrl = process.env[ROLE_DATABASE_VARIABLES.data];
const enabled = Boolean(rawRoleUrl);

async function runProvision() {
  const child = Bun.spawn(
    ["bun", "scripts/enterprise-test-db.ts", "provision"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

test.skipIf(!enabled)(
  "provision re-entry strips foreign memberships (including quoted role names) and resets attributes",
  async () => {
    const loginName = decodeURIComponent(new URL(rawRoleUrl!).username);

    const setup = postgres(enterpriseTestDatabaseUrlFrom(), { max: 1 });
    try {
      // Foreign memberships a hostile CREATEROLE peer could have granted: a
      // quote-bearing role name (locks the identifier escaping) plus a second
      // capability role (locks the exactly-one-membership invariant).
      await setup.unsafe(
        `DROP ROLE IF EXISTS "${quotedForeignRole.replaceAll('"', '""')}"`,
      );
      await setup.unsafe(
        `CREATE ROLE "${quotedForeignRole.replaceAll('"', '""')}" NOLOGIN`,
      );
      await setup.unsafe(
        `GRANT "${quotedForeignRole.replaceAll('"', '""')}" TO "${loginName}"`,
      );
      await setup.unsafe(`GRANT "ob_ent_operator" TO "${loginName}"`);
      await setup.unsafe(
        `ALTER ROLE "${loginName}" PASSWORD 'stale-password-before-reprovision'`,
      );

      const reprovisioned = await runProvision();
      expect(reprovisioned.exitCode).toBe(0);

      const [state] = await setup.unsafe<
        {
          memberships: string[];
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
        }[]
      >(`
      SELECT COALESCE(array_agg(parent.rolname ORDER BY parent.rolname), '{}') AS memberships,
        actor.rolsuper, actor.rolbypassrls, actor.rolcanlogin
      FROM pg_roles actor
      LEFT JOIN pg_auth_members membership ON membership.member = actor.oid
      LEFT JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE actor.rolname = ${loginName}
      GROUP BY actor.rolsuper, actor.rolbypassrls, actor.rolcanlogin
    `);
      expect(state?.memberships).toEqual(["ob_ent_data"]);
      expect(state?.rolsuper).toBe(false);
      expect(state?.rolbypassrls).toBe(false);
      expect(state?.rolcanlogin).toBe(true);

      // The reset password is the one the role URL carries: dialing the
      // runtime login with the provisioned capability succeeds.
      const restricted = postgres(enterpriseRuntimeDatabaseUrlFrom("data"), {
        max: 1,
      });
      const [session] = await restricted<
        { current_user: string; session_user: string }[]
      >`SELECT current_user, session_user`;
      expect(session?.session_user).toBe(loginName);
      await restricted.end({ timeout: 5 });

      await setup.unsafe(
        `DROP ROLE IF EXISTS "${quotedForeignRole.replaceAll('"', '""')}"`,
      );
    } finally {
      await setup.end({ timeout: 5 }).catch(() => {});
    }
  },
);

test.skipIf(!enabled)(
  "provision refuses a login that carries cluster-level privileges",
  async () => {
    const loginName = decodeURIComponent(new URL(rawRoleUrl!).username);
    const setup = postgres(enterpriseTestDatabaseUrlFrom(), { max: 1 });
    try {
      await setup.unsafe(`ALTER ROLE "${loginName}" CREATEDB`);
      const refused = await runProvision();
      expect(refused.exitCode).not.toBe(0);
      expect(refused.output).toContain(
        `${ROLE_DATABASE_VARIABLES.data} must not name the privileged`,
      );
      // The refusal happened before any ALTER: the attribute survives untouched.
      const [state] = await setup<Pick<PgRolePrivilegeFlags, "rolcreatedb">[]>`
      SELECT rolcreatedb FROM pg_roles WHERE rolname = ${loginName}
    `;
      expect(state?.rolcreatedb).toBe(true);
    } finally {
      await setup
        .unsafe(`ALTER ROLE "${loginName}" NOCREATEDB`)
        .catch(() => {});
      await setup.end({ timeout: 5 }).catch(() => {});
    }
  },
);
