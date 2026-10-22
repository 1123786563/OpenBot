import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PostgresStore } from "@mastra/pg";
import { createDatabase, type Database } from "../../src/db/client";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import type {
  TenantProvisionInput,
  TenantProvisionReceipt,
} from "../../src/mastra/contracts";
import {
  tenantStorageKey,
  tenantStorageRoleNames,
  tenantStorageSchemaName,
} from "../../src/mastra/contracts";
import {
  PostgresTenantProvisioner,
  RegistryTenantStorageLookup,
  type TenantCredentialStore,
  type TenantStorageRegistry,
} from "../../src/mastra/provisioning";
import { testPgContainer as container, psql } from "./pg-container";

/**
 * ME03 (#475) fixtures: ONE disposable database on the local test Postgres
 * (the openbot-test-pg container, host port from ME01_TEST_PG_PORT) holding
 * BOTH sides the conversation runtime touches —
 *
 *  1. the enterprise control-plane schema (tenants, memberships,
 *     conversations, mastra_message_intents) applied by the repository's own
 *     migration path (`scripts/migrate.ts` with the enterprise role
 *     bootstrap), reached through the three restricted capability logins the
 *     runtime verifier demands, and
 *  2. one mastra tenant-storage schema + restricted runtime role per tenant,
 *     provisioned by the production PostgresTenantProvisioner with an
 *     in-memory registry and credential store.
 *
 * Everything is dropped in teardown. The dev DATABASE_URL is never read and
 * no .env is consulted: connection targets come only from the container
 * bootstrap this file performs.
 */

export interface Me03EnterpriseLogins {
  readonly directoryUrl: string;
  readonly dataUrl: string;
  readonly operatorUrl: string;
}

export interface Me03Fixture {
  /** Superuser URL of the disposable database (control plane + admin probes). */
  readonly adminUrl: string;
  readonly dbName: string;
  /** The three restricted runtime URLs (current_user pinned per capability). */
  readonly logins: Me03EnterpriseLogins;
  openDatabase(url: string): Database;
  openDirectory(): Promise<DirectoryDatabase>;
  openData(): Promise<DataDatabase>;
  openOperator(): Promise<OperatorDatabase>;
  /** Production provisioning of one tenant's mastra storage inside this DB. */
  provisioner(): PostgresTenantProvisioner;
  lookup(): RegistryTenantStorageLookup;
  registry: TenantStorageRegistry;
  credentials: TenantCredentialStore;
  drop(): Promise<void>;
}

function runtimeUrl(
  dbName: string,
  roleName: string,
  password: string,
  port: string,
  capability: string,
): string {
  const option = encodeURIComponent(`-c role=${capability}`);
  return `postgresql://${roleName}:${encodeURIComponent(password)}@127.0.0.1:${port}/${dbName}?options=${option}`;
}

export async function createMe03Fixture(): Promise<Me03Fixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const dbName = `openbot_me03_${suffix.slice(0, 16)}`;
  const port = process.env.ME01_TEST_PG_PORT ?? "5433";
  // The local test container's superuser credential (the same one every
  // host-side test connection to openbot-test-pg uses; CI provisioned it).
  // Overridable so a differently-passworded local container still works.
  const adminPassword = process.env.ME03_TEST_PG_ADMIN_PASSWORD ?? "openbot";
  const adminUrl = `postgresql://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/${dbName}`;
  try {
    await psql("postgres", `CREATE DATABASE "${dbName}"`);
  } catch (error) {
    throw new Error(
      `ME03 fixture could not create its disposable database on ${container()} (${port}). Register this as an environment blocker, not a pass.`,
      { cause: error },
    );
  }
  const serverRoot = join(import.meta.dir, "..", "..");
  async function dropDatabase(name: string) {
    await psql(
      "postgres",
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ).catch(() => undefined);
  }
  // The repository's own migration path: roles.sql bootstrap + drizzle
  // migrations + the enterprise role preconditions, exactly as
  // scripts/enterprise-test-db.ts migrate mode drives it. --no-env-file: Bun
  // otherwise auto-loads server/.env over the explicit env below (the
  // learning-mastra.test.ts precedent), silently aiming the migration at the
  // dev database — the header promise above must hold unconditionally. The
  // spawn/wait path is cleanup-covered too: a `Bun.spawn` that throws (a
  // trimmed env whose PATH cannot resolve `bun`, for instance) or an `exited`
  // promise that rejects must not leave the just-created database behind in
  // the SHARED container — DROP DATABASE ... WITH (FORCE) below is
  // idempotent, so the catch can drop unconditionally.
  let stderrText: Promise<string>;
  let migrateExit: number;
  try {
    const migrated = await Bun.spawn(
      ["bun", "--no-env-file", "scripts/migrate.ts"],
      {
        cwd: serverRoot,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
          DATABASE_URL: adminUrl,
          OPENBOT_BOOTSTRAP_ENTERPRISE_ROLES: "on",
        },
        // The migration child prints one JSON line on success; "ignore" keeps a
        // future chattier migrate.ts from filling a ~64KB pipe buffer and hanging
        // the bootstrap until the runner timeout (stderr stays piped: it is the
        // failure evidence).
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    // Drain stderr concurrently with the exit: a chatty child (psql NOTICE
    // piles up on bulk DDL) can fill the ~64KB pipe buffer and block on write
    // forever — the exact hang the stdout "ignore" above avoids, on the other
    // stream. The `.catch` keeps the success path (where the text is never
    // awaited) from surfacing a dangling stream-read rejection as a
    // process-level unhandled failure pointing nowhere near this fixture.
    stderrText = new Response(migrated.stderr).text().catch(() => "");
    migrateExit = await migrated.exited;
  } catch (error) {
    await dropDatabase(dbName);
    throw error;
  }
  if (migrateExit !== 0) {
    const stderr = await stderrText;
    await dropDatabase(dbName);
    throw new Error(
      `ME03 fixture migration failed (exit ${migrateExit}): ${stderr.slice(-2000)}`,
    );
  }
  // 0163_restore_drifted_tables.sql recreates drifted tables without their
  // privilege grants (the official enterprise test database carries them from
  // before the drift). The scope resolver reads workspace membership status
  // through the directory capability, so restore that one grant here.
  // Everything from here to the returned fixture has an explicit failure
  // cleanup (the me01-fixture symmetry): a GRANT or CREATE ROLE that throws
  // on container flutter would otherwise leak the created database and any
  // partially created login roles in the SHARED openbot-test-pg container,
  // accumulating across runs.
  const loginNames = {
    directory: `me03_dir_${suffix.slice(0, 10)}`,
    data: `me03_dat_${suffix.slice(0, 10)}`,
    operator: `me03_ope_${suffix.slice(0, 10)}`,
  };
  const passwords = Object.fromEntries(
    Object.keys(loginNames).map((role) => [
      role,
      `me03_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    ]),
  );
  try {
    await psql(
      dbName,
      `GRANT SELECT ON TABLE "enterprise_workspace_memberships" TO ob_ent_directory`,
    );

    // Runtime LOGIN roles, one per capability, mirroring the official
    // provisionRuntimeTestLogins shape: non-escalating login + exactly one
    // capability membership. Grants on tables stay with the capability roles
    // (the migrations own them); the logins hold nothing directly.
    for (const [role, name] of Object.entries(loginNames)) {
      const capability = `ob_ent_${role}`;
      // Dollar-quoting (the me01-fixture convention for the same
      // UUID-hex-derived passwords): psql -c has no parameter binding, so the
      // quoting style is the only firewall when the password scheme changes.
      await psql(
        dbName,
        `CREATE ROLE "${name}" LOGIN PASSWORD $$${passwords[role as keyof typeof loginNames]}$$ NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await psql(dbName, `GRANT "${capability}" TO "${name}"`);
    }
  } catch (error) {
    for (const name of Object.values(loginNames)) {
      await psql(dbName, `DROP ROLE IF EXISTS "${name}"`).catch(
        () => undefined,
      );
    }
    await dropDatabase(dbName);
    throw error;
  }
  const logins: Me03EnterpriseLogins = {
    directoryUrl: runtimeUrl(
      dbName,
      loginNames.directory,
      passwords.directory!,
      port,
      "ob_ent_directory",
    ),
    dataUrl: runtimeUrl(
      dbName,
      loginNames.data,
      passwords.data!,
      port,
      "ob_ent_data",
    ),
    operatorUrl: runtimeUrl(
      dbName,
      loginNames.operator,
      passwords.operator!,
      port,
      "ob_ent_operator",
    ),
  };

  const credentials = new Map<string, string>();
  const claims = new Map<string, { token: string; input: string }>();
  const records = new Map<
    string,
    { receipt: TenantProvisionReceipt; runtimeRole: string }
  >();
  const credentialStore: TenantCredentialStore = {
    async put(ref, secret) {
      credentials.set(ref, secret);
    },
    async get(ref) {
      return credentials.get(ref);
    },
    async delete(ref) {
      credentials.delete(ref);
    },
  };
  const registry: TenantStorageRegistry = {
    async claim(input: TenantProvisionInput) {
      if (records.has(input.tenantId) || claims.has(input.tenantId)) return;
      const token = randomUUID();
      claims.set(input.tenantId, { token, input: JSON.stringify(input) });
      return token;
    },
    async put(receipt, runtimeRole, token) {
      if (token && claims.get(receipt.tenantId)?.token !== token)
        throw new Error("TENANT_STORAGE_CLAIM_LOST");
      records.set(receipt.tenantId, { receipt, runtimeRole });
      claims.delete(receipt.tenantId);
    },
    async get(tenant) {
      return records.get(tenant);
    },
    async delete(tenant) {
      records.delete(tenant);
    },
    async releaseClaim(tenant, token) {
      if (claims.get(tenant)?.token === token) claims.delete(tenant);
    },
  };

  const databases: Database[] = [];
  const adminStores: PostgresStore[] = [];

  return {
    adminUrl: adminUrl,
    dbName,
    logins,
    openDatabase(url: string) {
      const database = createDatabase(url, { max: 3 });
      databases.push(database);
      return database;
    },
    openDirectory() {
      return verifyDirectoryDatabase(
        this.openDatabase(this.logins.directoryUrl),
      );
    },
    openData() {
      return verifyDataDatabase(this.openDatabase(this.logins.dataUrl));
    },
    openOperator() {
      return verifyOperatorDatabase(this.openDatabase(this.logins.operatorUrl));
    },
    provisioner() {
      const controlPlane = new PostgresStore({
        id: `me03-control-${suffix.slice(0, 8)}`,
        connectionString: adminUrl,
        schemaName: "public",
        disableInit: true,
        max: 2,
      });
      adminStores.push(controlPlane);
      return new PostgresTenantProvisioner({
        controlPlane: controlPlane.pool,
        controlPlaneConnectionString: adminUrl,
        credentials: credentialStore,
        registry,
      });
    },
    lookup() {
      return new RegistryTenantStorageLookup({
        registry,
        credentials: credentialStore,
        runtimeConnectionString: adminUrl,
      });
    },
    registry,
    credentials: credentialStore,
    async drop() {
      const errors: unknown[] = [];
      // The whole database is disposable: close pools, drop the per-tenant
      // mastra schemas/roles (so the role drops do not fail on ownership),
      // drop the logins, then drop the database.
      for (const [tenantId, entry] of records) {
        // The registry record owns the EXACT receipt values: a schema/role
        // name derived from receipt.roleVersion (not a hardcoded 1), and the
        // receipt's own credentialRef — the provisioner's ref shape
        // (`tenant-credential:<uuid>`) never contains the tenant id, so a
        // substring probe would silently delete nothing.
        const storageKey = tenantStorageKey(tenantId);
        const schemaName = tenantStorageSchemaName(
          storageKey,
          entry.receipt.roleVersion,
        );
        const roles = tenantStorageRoleNames(
          storageKey,
          entry.receipt.roleVersion,
        );
        for (const statement of [
          `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
          `DROP ROLE IF EXISTS "${roles.runtime}"`,
          `DROP ROLE IF EXISTS "${roles.owner}"`,
        ]) {
          try {
            await psql(dbName, statement);
          } catch (error) {
            errors.push(error);
          }
        }
        credentials.delete(entry.receipt.credentialRef);
      }
      for (const store of adminStores) {
        await store.close().catch((error) => errors.push(error));
      }
      for (const database of databases) {
        await database.$client.close().catch((error) => errors.push(error));
      }
      for (const name of Object.values(loginNames)) {
        try {
          await psql(dbName, `DROP ROLE IF EXISTS "${name}"`);
        } catch (error) {
          errors.push(error);
        }
      }
      await dropDatabase(dbName);
      if (errors.length) {
        throw new AggregateError(errors, "ME03 fixture cleanup failed");
      }
    },
  };
}
