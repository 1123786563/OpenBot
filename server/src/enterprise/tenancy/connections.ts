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
  no_table_ownership: boolean;
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
      AND NOT capability.rolcreaterole AS capability_attributes_ok,
    login.rolcanlogin
      AND NOT login.rolsuper
      AND NOT login.rolbypassrls
      AND NOT login.rolcreatedb
      AND NOT login.rolcreaterole AS login_attributes_ok,
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
        AND relation.relkind IN ('r', 'p')
        AND (
          relation.relowner = capability.oid
          OR pg_has_role(current_user, relation.relowner, 'MEMBER')
        )
    ) AS no_table_ownership
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
    !catalog.no_table_ownership
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
