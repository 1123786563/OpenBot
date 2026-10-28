import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";

const DIRECTORY_ROLE = "ob_ent_directory";
const DATA_ROLE = "ob_ent_data";
const OPERATOR_ROLE = "ob_ent_operator";

declare const directoryDatabaseBrand: unique symbol;
declare const dataDatabaseBrand: unique symbol;
declare const operatorDatabaseBrand: unique symbol;

/** Verified connection whose current_user is exactly ob_ent_directory. */
export type DirectoryDatabase = Database & {
  readonly [directoryDatabaseBrand]: true;
};
/** Verified connection whose current_user is exactly ob_ent_data. */
export type DataDatabase = Database & { readonly [dataDatabaseBrand]: true };
/** Offline-only verified connection whose current_user is exactly ob_ent_operator. */
export type OperatorDatabase = Database & {
  readonly [operatorDatabaseBrand]: true;
};

type CapabilityCatalog = {
  current_user_matches: boolean;
  capability_attributes_ok: boolean;
  login_attributes_ok: boolean;
  login_has_expected_capability: boolean;
  capability_has_no_escalation_membership: boolean;
  login_has_no_other_memberships: boolean;
  no_protected_ownership: boolean;
  login_has_no_enterprise_privileges: boolean;
};

const verifiedDirectory = new WeakSet<object>();
const verifiedData = new WeakSet<object>();
const verifiedOperator = new WeakSet<object>();

function capabilityCatalogQuery(role: string) {
  return sql<CapabilityCatalog>`
  SELECT
    current_user = capability.rolname AS current_user_matches,
    NOT capability.rolcanlogin
      AND NOT capability.rolsuper
      AND NOT capability.rolbypassrls
      AND NOT capability.rolcreatedb
      AND NOT capability.rolcreaterole
      AND NOT capability.rolreplication AS capability_attributes_ok,
    login.rolcanlogin
      AND NOT login.rolsuper
      AND NOT login.rolbypassrls
      AND NOT login.rolcreatedb
      AND NOT login.rolcreaterole
      AND NOT login.rolreplication AS login_attributes_ok,
    pg_has_role(session_user, capability.oid, 'MEMBER') AS login_has_expected_capability,
    NOT EXISTS (
      SELECT 1
      FROM pg_roles inherited
      WHERE inherited.rolname <> capability.rolname
        AND pg_has_role(current_user, inherited.oid, 'MEMBER')
    ) AS capability_has_no_escalation_membership,
    NOT EXISTS (
      SELECT 1
      FROM pg_roles inherited
      WHERE inherited.rolname <> capability.rolname
        AND inherited.rolname <> login.rolname
        AND pg_has_role(session_user, inherited.oid, 'MEMBER')
    ) AS login_has_no_other_memberships,
    NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname LIKE 'enterprise_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND (
          relation.relowner = capability.oid
          OR relation.relowner = login.oid
          OR pg_has_role(current_user, relation.relowner, 'MEMBER')
          OR pg_has_role(session_user, relation.relowner, 'MEMBER')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_namespace namespace
      WHERE namespace.nspname = 'public'
        AND (
          namespace.nspowner = capability.oid
          OR namespace.nspowner = login.oid
          OR pg_has_role(current_user, namespace.nspowner, 'MEMBER')
          OR pg_has_role(session_user, namespace.nspowner, 'MEMBER')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_database target_database
      WHERE target_database.datname = current_database()
        AND (
          target_database.datdba = capability.oid
          OR target_database.datdba = login.oid
          OR pg_has_role(current_user, target_database.datdba, 'MEMBER')
          OR pg_has_role(session_user, target_database.datdba, 'MEMBER')
        )
    ) AS no_protected_ownership,
    NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) relation_acl
      WHERE namespace.nspname = 'public'
        AND relation.relname LIKE 'enterprise_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND relation.relowner <> login.oid
        AND (relation_acl.grantee = login.oid OR relation_acl.grantee = 0)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute.attacl) attribute_acl
      WHERE namespace.nspname = 'public'
        AND relation.relname LIKE 'enterprise_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (attribute_acl.grantee = login.oid OR attribute_acl.grantee = 0)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) schema_acl
      WHERE namespace.nspname = 'public'
        AND namespace.nspowner <> login.oid
        AND schema_acl.grantee = login.oid
    ) AS login_has_no_enterprise_privileges
  FROM pg_roles capability
  JOIN pg_roles login ON login.rolname = session_user
  WHERE capability.rolname = ${role}`;
}

async function verifyCapability<T extends object>(
  database: Database,
  role: string,
  verified: WeakSet<object>,
): Promise<T> {
  let rows: CapabilityCatalog[];
  try {
    rows = (await database.execute(
      capabilityCatalogQuery(role),
    )) as unknown as CapabilityCatalog[];
  } catch {
    throw new Error("DATABASE_CAPABILITY_CHECK_FAILED");
  }
  const catalog = rows[0];
  if (
    catalog?.current_user_matches !== true ||
    !catalog.capability_attributes_ok ||
    !catalog.login_attributes_ok ||
    !catalog.login_has_expected_capability ||
    !catalog.capability_has_no_escalation_membership ||
    !catalog.login_has_no_other_memberships ||
    !catalog.no_protected_ownership ||
    !catalog.login_has_no_enterprise_privileges
  ) {
    throw new Error("DATABASE_CAPABILITY_MISMATCH");
  }
  verified.add(database);
  return database as T;
}

export function verifyDirectoryDatabase(
  database: Database,
): Promise<DirectoryDatabase> {
  return verifyCapability<DirectoryDatabase>(
    database,
    DIRECTORY_ROLE,
    verifiedDirectory,
  );
}

export function verifyDataDatabase(database: Database): Promise<DataDatabase> {
  return verifyCapability<DataDatabase>(database, DATA_ROLE, verifiedData);
}

export function verifyOperatorDatabase(
  database: Database,
): Promise<OperatorDatabase> {
  return verifyCapability<OperatorDatabase>(
    database,
    OPERATOR_ROLE,
    verifiedOperator,
  );
}

export function assertDirectoryDatabase(database: DirectoryDatabase): void {
  assertVerified(database, verifiedDirectory);
}

export function assertDataDatabase(database: DataDatabase): void {
  assertVerified(database, verifiedData);
}

export function assertOperatorDatabase(database: OperatorDatabase): void {
  assertVerified(database, verifiedOperator);
}

function assertVerified(database: object, verified: WeakSet<object>): void {
  if (!verified.has(database))
    throw new Error("UNVERIFIED_DATABASE_CAPABILITY");
}

/*
 * The directory writer of the Better Auth authority (T02.06 / #528, design
 * §5.2.1/§5.3, original task P03). The fourth restricted capability beside
 * directory/data/operator: current_user is exactly ob_ent_auth_writer, one
 * membership, no escalation, no protected ownership — the same catalog shape
 * the three siblings verify, because it is the same contract.
 *
 * M1 keeps the legacy writer: nothing about ob_ent_operator's enterprise_*
 * grants changes until M4 collects them, and the writer below reaches the
 * protected projections, clocks and the durable command model only through
 * the controlled functions migration 0214 installs.
 */
const AUTH_WRITER_ROLE = "ob_ent_auth_writer";

declare const authWriterDatabaseBrand: unique symbol;

/** Verified connection whose current_user is exactly ob_ent_auth_writer. */
export type AuthWriterDatabase = Database & {
  readonly [authWriterDatabaseBrand]: true;
};

const verifiedAuthWriter = new WeakSet<object>();

export function verifyAuthWriterDatabase(
  database: Database,
): Promise<AuthWriterDatabase> {
  return verifyCapability<AuthWriterDatabase>(
    database,
    AUTH_WRITER_ROLE,
    verifiedAuthWriter,
  );
}

export function assertAuthWriterDatabase(database: AuthWriterDatabase): void {
  assertVerified(database, verifiedAuthWriter);
}

/*
 * The startup half of the T02.06 schema-roles contract (design §5.3, defect
 * F-10): the roles, grants, functions and deferred constraints migration 0214
 * installs are verified facts, not deployment folklore. The BA boot path
 * calls this beside verifyAuthWriterDatabase before it serves anything, so a
 * dropped grant — a migration that never ran, a DBA "cleanup", a half-applied
 * upgrade — refuses startup instead of surfacing later as a runtime 42501
 * halfway through a directory command.
 *
 * The probe is read-only catalog SQL; it asserts on any connection that can
 * read the catalogs, and names every gap it finds (all of them, not the
 * first). What it pins:
 *
 * - the writer capability role exists with the safe attribute shape and no
 *   parent membership;
 * - the writer holds SELECT/INSERT/UPDATE/DELETE on the six BA directory
 *   tables and SELECT on the durable command model and authority sources;
 * - the reader holds SELECT on the six BA directory tables;
 * - the writer holds EXECUTE on its six controlled functions, the data role
 *   on its two controlled reads, and PUBLIC on none of them;
 * - no runtime role holds any direct privilege on the clocks or the
 *   assurance tables (the controlled functions are the only path);
 * - the DML guard is installed on all six directory tables and the four
 *   fences exist as DEFERRABLE INITIALLY DEFERRED constraint triggers.
 */

type BaSchemaRolesCatalog = {
  writer_role_ok: boolean;
  writer_memberships: number;
  writer_directory_dml: number;
  writer_command_model_read: number;
  reader_directory_read: number;
  writer_functions: number;
  data_functions: number;
  public_functions: number;
  roles_with_clock_privilege: number;
  guard_triggers: number;
  fence_triggers: number;
};

const BA_DIRECTORY_TABLES = [
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_invitations",
] as const;
const BA_COMMAND_MODEL_TABLES = [
  "auth_command_receipts",
  "auth_command_change_keys",
  "auth_command_outbox",
  "auth_authority_states",
  "auth_team_management_grants",
  "auth_provisioning_rules",
] as const;
const BA_WRITER_FUNCTIONS = [
  "auth_directory_begin_command(text,text,text,text,text,text,text,text,text)",
  "auth_directory_finalize_command(text)",
  "auth_command_append_outbox(text,text,text,text)",
  "auth_principals_register(text,text,text)",
  "auth_project_company_membership(text,text,text,text,integer,text)",
  "auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)",
] as const;
const BA_DATA_FUNCTIONS = [
  "auth_read_eligibility_clocks(text,text)",
  "auth_read_session_assurances(text,text)",
] as const;
const BA_NO_DIRECT_PRIVILEGE_TABLES = [
  "auth_eligibility_clocks",
  "auth_company_auth_challenges",
  "auth_company_session_assurances",
] as const;
const BA_RUNTIME_ROLES = [
  "ob_ent_directory",
  "ob_ent_data",
  "ob_ent_operator",
  "ob_ent_auth_writer",
] as const;
const BA_FENCE_TRIGGERS = [
  "auth_command_receipt_fence",
  "auth_change_key_fence",
  "auth_team_member_orphan_fence",
  "auth_member_orphan_fence",
] as const;

function baSchemaRolesCatalogQuery() {
  return sql<BaSchemaRolesCatalog>`
  SELECT
    EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = ${AUTH_WRITER_ROLE}
         AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
         AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
    ) AS writer_role_ok,
    (SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid = membership.member
      WHERE member.rolname = ${AUTH_WRITER_ROLE})::int AS writer_memberships,
    -- Each privilege on its own (review r1 R1-F2): a comma list here is
    -- ANY-of semantics in PostgreSQL, so a writer holding only SELECT would
    -- pass and lose INSERT at command time instead of at startup.
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${BA_DIRECTORY_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS tables(name)
      WHERE has_table_privilege(${AUTH_WRITER_ROLE}, 'public.' || tables.name, 'SELECT')
        AND has_table_privilege(${AUTH_WRITER_ROLE}, 'public.' || tables.name, 'INSERT')
        AND has_table_privilege(${AUTH_WRITER_ROLE}, 'public.' || tables.name, 'UPDATE')
        AND has_table_privilege(${AUTH_WRITER_ROLE}, 'public.' || tables.name, 'DELETE'))::int AS writer_directory_dml,
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${BA_COMMAND_MODEL_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS tables(name)
      WHERE has_table_privilege(${AUTH_WRITER_ROLE}, 'public.' || tables.name, 'SELECT'))::int AS writer_command_model_read,
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${BA_DIRECTORY_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS tables(name)
      WHERE has_table_privilege('ob_ent_directory', 'public.' || tables.name, 'SELECT'))::int AS reader_directory_read,
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${BA_WRITER_FUNCTIONS.map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS functions(signature)
      WHERE has_function_privilege(${AUTH_WRITER_ROLE}, 'public.' || functions.signature, 'EXECUTE'))::int AS writer_functions,
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${BA_DATA_FUNCTIONS.map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS functions(signature)
      WHERE has_function_privilege('ob_ent_data', 'public.' || functions.signature, 'EXECUTE'))::int AS data_functions,
    (SELECT count(*) FROM unnest(${sql.raw(
      `ARRAY[${[...BA_WRITER_FUNCTIONS, ...BA_DATA_FUNCTIONS, "auth_directory_dml_guard()", "auth_directory_commit_fence()", "auth_directory_guard_principal(text)"].map((name) => `'${name}'`).join(", ")}]::text[]`,
    )}) AS functions(signature)
      WHERE has_function_privilege('public', 'public.' || functions.signature, 'EXECUTE'))::int AS public_functions,
    (SELECT count(*) FROM pg_roles roles
       CROSS JOIN unnest(${sql.raw(
         `ARRAY[${BA_NO_DIRECT_PRIVILEGE_TABLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
       )}) AS tables(name)
      WHERE roles.rolname = ANY(${sql.raw(
        `ARRAY[${BA_RUNTIME_ROLES.map((name) => `'${name}'`).join(", ")}]::text[]`,
      )})
        AND has_table_privilege(roles.rolname, 'public.' || tables.name, 'SELECT,INSERT,UPDATE,DELETE'))::int AS roles_with_clock_privilege,
    (SELECT count(*) FROM pg_trigger
      WHERE tgname = 'auth_directory_dml_guard' AND NOT tgisinternal)::int AS guard_triggers,
    (SELECT count(*) FROM pg_trigger
      WHERE tgname = ANY(${sql.raw(
        `ARRAY[${BA_FENCE_TRIGGERS.map((name) => `'${name}'`).join(", ")}]::text[]`,
      )})
        AND NOT tgisinternal AND tgdeferrable AND tginitdeferred)::int AS fence_triggers`;
}

/**
 * Throws `BA_SCHEMA_ROLES_MISMATCH` naming every gap when the live database
 * lacks any part of the T02.06 roles contract. Read-only; safe on any
 * catalog-reading connection, so the startup probe and the schema-roles test
 * suite verify the same facts.
 */
export async function verifyBaSchemaRoles(database: Database): Promise<void> {
  let rows: BaSchemaRolesCatalog[];
  try {
    rows = (await database.execute(
      baSchemaRolesCatalogQuery(),
    )) as unknown as BaSchemaRolesCatalog[];
  } catch (error) {
    const failure = error as { cause?: { message?: string }; message?: string };
    const reason = failure.cause?.message ?? failure.message ?? String(error);
    throw new Error(
      `BA_SCHEMA_ROLES_CHECK_FAILED: catalog probe failed (${reason.slice(0, 300)})`,
    );
  }
  const catalog = rows[0];
  const gaps: string[] = [];
  if (catalog?.writer_role_ok !== true)
    gaps.push("ob_ent_auth_writer missing or has unsafe attributes");
  if (catalog?.writer_memberships !== 0)
    gaps.push("ob_ent_auth_writer inherits another role");
  if (catalog?.writer_directory_dml !== BA_DIRECTORY_TABLES.length)
    gaps.push("ob_ent_auth_writer lacks full DML on the BA directory tables");
  if (catalog?.writer_command_model_read !== BA_COMMAND_MODEL_TABLES.length)
    gaps.push("ob_ent_auth_writer lacks SELECT on the command model tables");
  if (catalog?.reader_directory_read !== BA_DIRECTORY_TABLES.length)
    gaps.push("ob_ent_directory lacks SELECT on the BA directory tables");
  if (catalog?.writer_functions !== BA_WRITER_FUNCTIONS.length)
    gaps.push("ob_ent_auth_writer lacks EXECUTE on its controlled functions");
  if (catalog?.data_functions !== BA_DATA_FUNCTIONS.length)
    gaps.push("ob_ent_data lacks EXECUTE on its controlled read functions");
  if (catalog?.public_functions !== 0)
    gaps.push("PUBLIC still holds EXECUTE on a controlled function");
  if (catalog?.roles_with_clock_privilege !== 0)
    gaps.push("a runtime role holds a direct privilege on clocks/assurance");
  if (catalog?.guard_triggers !== 6)
    gaps.push("the DML guard is not installed on all six directory tables");
  if (catalog?.fence_triggers !== BA_FENCE_TRIGGERS.length)
    gaps.push("the deferred constraint fences are missing or not deferrable");
  if (gaps.length > 0) {
    throw new Error(`BA_SCHEMA_ROLES_MISMATCH: ${gaps.join("; ")}`);
  }
}
