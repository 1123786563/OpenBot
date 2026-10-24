/**
 * MT031 (Issue #74) plugin-install fixture support.
 *
 * Builds on the MT008 resource-policy fixture (which itself wraps the MT002
 * isolation fixture: two companies, three teams, real provisioning, real
 * restricted roles). This wrapper adds exactly the arrangements MT031's tests
 * need and nothing else:
 *
 *   - the MT031 plugin-catalog admin (restricted operator channel: install /
 *     uninstall / enable / bind / unbind) and decision services (restricted
 *     data channel: listCatalog / listInstalls / describe / authorizeInvoke /
 *     listConnections);
 *   - a vendor-call probe INJECTED into the decision service: the module
 *     increments the counter itself, exactly on an allow verdict — so the
 *     acceptance "a cross-company install/connection ID never triggers a
 *     vendor call" is observed as a real module effect, not a test-side
 *     simulation (MT027 vendorProbe precedent, one seam deeper);
 *   - the MemoryVault from the MT027 credentials fixture, whose envelopes
 *     carry the plaintext verbatim (`v1:<plaintext>`), so the canary leak-scan
 *     has teeth: any surface that leaked an envelope would also leak the
 *     literal canary secret;
 *   - a superuser setup connection used ONLY for disclosed arrangement
 *     stand-ins (seeding the deployment-curated catalog, structural FK probes)
 *     and catalog-only assertions (RLS flags, grant matrix) — never for
 *     business reads or writes.
 *
 * Nothing here mocks the authorization path: catalog entries, installs,
 * connections and decisions all execute against real rows under the
 * restricted `ob_ent_*` PostgreSQL roles with real RLS.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createPluginCatalogAdminService,
  createPluginCatalogDecisionService,
  type PluginCatalogAdminService,
  type PluginCatalogDecisionService,
} from "../../../src/enterprise/tenancy/plugin-catalog";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import { MemoryVault } from "./credentials-ownership";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

export interface CatalogEntryFact {
  readonly catalogId: string;
}

export interface InstallFact {
  readonly installId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly catalogId: string;
}

export interface ConnectionFact {
  readonly connectionId: string;
  readonly installId: string;
  readonly tenantId: string;
}

export interface PluginInstallFixture {
  readonly base: ResourcePolicyFixture;
  /** Install/uninstall/enable/bind admin, riding the restricted operator channel. */
  readonly admin: PluginCatalogAdminService;
  /** Catalog/install/connection decisions, riding the restricted data channel. */
  readonly decisions: PluginCatalogDecisionService;
  /** Memory vault shared by both services (test double for the production AES vault). */
  readonly vault: MemoryVault;
  /**
   * Vendor-call probe: `calls()` increments from INSIDE the decision module's
   * allow branch (injected via onVendorCall) and nowhere else.
   */
  readonly vendorProbe: { readonly calls: () => number };
  /**
   * Seeds one deployment-curated catalog entry (superuser, disclosed): the
   * catalog is read-only to every restricted business role, so curation is a
   * deployment-level act outside the business channels by construction.
   */
  seedCatalogEntry(input: {
    readonly catalogId: string;
    readonly kind: "mcp" | "composio" | "open-connector";
    readonly vendor: string;
    readonly source: "first-party" | "custom";
    readonly title: string;
    readonly summary: string;
  }): Promise<CatalogEntryFact>;
  /** Installs one catalog entry for an identity's team through the real admin service. */
  provisionInstall(input: {
    readonly identity: FixtureIdentity;
    readonly teamKey: TeamKey;
    readonly catalogId: string;
    readonly config?: Record<string, unknown>;
    readonly secret?: string;
  }): Promise<InstallFact>;
  /** Binds one connection to an install through the real admin service. */
  bindConnection(input: {
    readonly identity: FixtureIdentity;
    readonly teamKey: TeamKey;
    readonly install: InstallFact;
    readonly vendorRef: string;
  }): Promise<ConnectionFact>;
  /** Principal id behind one fixture identity in one company. */
  principalOf(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): string;
  /**
   * Offline arrangement stand-in (superuser, disclosed): flips one company
   * membership to the requested status, bumping epoch (MT027/MT010 same aid).
   * Decision paths never run through this; only fixtures do.
   */
  setCompanyMembershipStatus(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
    status: "active" | "suspended",
  ): Promise<void>;
  /**
   * Arrangement stand-in that flips ONLY the membership status without the
   * epoch bump (superuser, disclosed): pins that the decision layer enforces
   * status itself and never trusts upstream epoch discipline alone (MT027
   * same aid).
   */
  setCompanyMembershipStatusWithoutEpochBump(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
    status: "active" | "suspended",
  ): Promise<void>;
  /** One raw install row through the restricted operator role (never data). */
  installRow(input: {
    readonly tenantId: string;
    readonly installId: string;
  }): Promise<Record<string, unknown> | null>;
  /**
   * Structural probe (superuser, disclosed): attempts a raw install INSERT
   * and returns the first SQLSTATE of the failure chain ("" when it did not
   * throw). Proves cross-company install rows are structurally impossible.
   */
  rawInstallInsert(input: {
    readonly tenantId: string;
    readonly catalogId: string;
    readonly workspaceId: string;
    readonly installedBy: string;
    readonly config?: Record<string, unknown>;
  }): Promise<string>;
  /**
   * Structural probe (superuser, disclosed): attempts a raw catalog INSERT
   * and returns the first SQLSTATE of the failure chain ("" when it did not
   * throw). Proves the catalog metadata closed shape is enforced in storage.
   */
  rawCatalogInsert(input: {
    readonly kind?: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<string>;
  /** Catalog facts via the dedicated superuser connection (read-only assertions). */
  catalog: {
    rlsFlags(
      table: string,
    ): Promise<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    hasPrivilege(
      table: string,
      role: "ob_ent_directory" | "ob_ent_data" | "ob_ent_operator",
      privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
    ): Promise<boolean>;
    tableExists(table: string): Promise<boolean>;
    /** Column names of one table via the catalog (read-only assertion). */
    columnsOf(table: string): Promise<string[]>;
  };
  dispose(): Promise<void>;
}

// Thrown-error probes are shared with the whole package test chain; the single
// source lives in ./sql-errors (was duplicated verbatim here and in
// package-install.ts).
import { thrownMessage, thrownSqlState } from "./sql-errors";

export { thrownMessage, thrownSqlState };

/**
 * Creates the MT031 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT008 fixture does.
 */
export async function createPluginInstallFixture(): Promise<PluginInstallFixture> {
  const base = await createResourcePolicyFixture();
  // Dedicated setup (superuser) connection for arrangement stand-ins and
  // catalog-only assertions — never used for business reads or writes.
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });
  // Setup-side twin of the dispose() truncate: this suite owns the three
  // plugin tables on the dedicated test database (superuser, disclosed), and
  // its AC1 asserts the catalog contains exactly the entries it seeds. Other
  // suites on the same database (package-storage / package-install.integration)
  // leave `pkg02-*` catalog rows behind after this suite has already run, so
  // idempotent reruns need the clean slate here, not only at dispose.
  await setup.$client
    .unsafe(
      "truncate enterprise_plugin_connections, enterprise_plugin_installs, enterprise_plugin_catalog cascade",
    )
    .catch(() => {});
  const vault = new MemoryVault();
  const admin = createPluginCatalogAdminService(base.operator, vault);

  let vendorCalls = 0;
  const vendorProbe = {
    calls: () => vendorCalls,
  };
  // The probe is injected INTO the decision service: the module itself counts
  // exactly its allow-branch vendor executions, so a denied invocation can
  // never move the counter even if a caller wanted it to. The decision plane
  // never opens the envelope: allow hands the sealed material to the caller.
  const decisions = createPluginCatalogDecisionService(base.data, {
    onVendorCall: () => {
      vendorCalls += 1;
    },
  });

  const principalOf = (
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): string => {
    for (const company of base.isolation.identities[identity].companies) {
      if (company.companyKey === companyKey) return company.principalId;
    }
    throw new Error(`PRINCIPAL_MISSING:${identity}:${companyKey}`);
  };

  return {
    base,
    admin,
    decisions,
    vault,
    vendorProbe,
    async seedCatalogEntry({
      catalogId,
      kind,
      vendor,
      source,
      title,
      summary,
    }) {
      // Bun SQL jsonb-encodes object params itself: pass the object verbatim
      // (a pre-stringified string would arrive as a jsonb scalar — the same
      // double-encoding the enterprise-credentials schema documents).
      await setup.$client.unsafe(
        `insert into enterprise_plugin_catalog
           (id, kind, title, vendor, source, metadata)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [catalogId, kind, title, vendor, source, { summary }],
      );
      return { catalogId };
    },

    async provisionInstall({ identity, teamKey, catalogId, config, secret }) {
      const fact = base.teamOf(identity, teamKey);
      const { installId } = await admin.install({
        tenantId: fact.tenantId,
        workspaceId: fact.workspaceId,
        installedBy: fact.principalId,
        catalogId,
        config: config ?? {},
        ...(secret === undefined ? {} : { secret }),
      });
      return {
        installId,
        tenantId: fact.tenantId,
        workspaceId: fact.workspaceId,
        catalogId,
      };
    },

    async bindConnection({ identity, teamKey, install, vendorRef }) {
      const fact = base.teamOf(identity, teamKey);
      const { connectionId } = await admin.bindConnection({
        tenantId: install.tenantId,
        installId: install.installId,
        boundBy: fact.principalId,
        vendorRef,
      });
      return {
        connectionId,
        installId: install.installId,
        tenantId: install.tenantId,
      };
    },

    principalOf,

    async setCompanyMembershipStatus(identity, companyKey, status) {
      const tenantId =
        companyKey === "company-a"
          ? base.isolation.ids["company-a"]
          : base.isolation.ids["company-b"];
      const principalId = principalOf(identity, companyKey);
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "membership",
            tenantId,
            principalId,
          ])}, 0))`,
        );
        await tx.execute(sql`
          update enterprise_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_memberships
                     where tenant_id = ${tenantId}
                       and principal_id = ${principalId})
          where tenant_id = ${tenantId}
            and principal_id = ${principalId}
        `);
      });
    },

    async setCompanyMembershipStatusWithoutEpochBump(
      identity,
      companyKey,
      status,
    ) {
      const tenantId =
        companyKey === "company-a"
          ? base.isolation.ids["company-a"]
          : base.isolation.ids["company-b"];
      const principalId = principalOf(identity, companyKey);
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "membership",
            tenantId,
            principalId,
          ])}, 0))`,
        );
        await tx.execute(sql`
          update enterprise_memberships
          set status = ${status}
          where tenant_id = ${tenantId}
            and principal_id = ${principalId}
        `);
      });
    },

    async installRow({ tenantId, installId }) {
      const rows = (await base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select * from enterprise_plugin_installs
              where tenant_id = ${tenantId} and id = ${installId}`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows[0] ?? null;
    },

    async rawInstallInsert({
      tenantId,
      catalogId,
      workspaceId,
      installedBy,
      config,
    }) {
      return thrownSqlState(
        setup.$client.unsafe(
          `insert into enterprise_plugin_installs
             (tenant_id, id, catalog_id, workspace_id, installed_by, config)
           values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            tenantId,
            `raw-${randomUUID()}`,
            catalogId,
            workspaceId,
            installedBy,
            config ?? {},
          ],
        ),
      );
    },

    async rawCatalogInsert({ kind, metadata }) {
      return thrownSqlState(
        setup.$client.unsafe(
          `insert into enterprise_plugin_catalog
             (id, kind, title, vendor, source, metadata)
           values ($1, $2, 'probe', 'probe', 'first-party', $3::jsonb)`,
          [`raw-${randomUUID()}`, kind ?? "mcp", metadata],
        ),
      );
    },

    catalog: {
      async rlsFlags(table) {
        const rows = (await setup.$client.unsafe(
          `select relrowsecurity, relforcerowsecurity from pg_class
           where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        )) as Array<Record<string, unknown>>;
        const row = rows[0];
        if (!row) throw new Error(`CATALOG_TABLE_MISSING:${table}`);
        return {
          relrowsecurity: Boolean(row.relrowsecurity),
          relforcerowsecurity: Boolean(row.relforcerowsecurity),
        };
      },
      async hasPrivilege(table, role, privilege) {
        const rows = (await setup.$client.unsafe(
          "select has_table_privilege($1, $2, $3) as allowed",
          [role, table, privilege],
        )) as Array<Record<string, unknown>>;
        return Boolean(rows[0]?.allowed);
      },
      async tableExists(table) {
        const rows = (await setup.$client.unsafe(
          `select 1 from pg_class
           where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        )) as Array<Record<string, unknown>>;
        return rows.length > 0;
      },
      async columnsOf(table) {
        const rows = (await setup.$client.unsafe(
          `select column_name from information_schema.columns
           where table_schema = 'public' and table_name = $1
           order by ordinal_position`,
          [table],
        )) as Array<Record<string, unknown>>;
        return rows.map((row) => String(row.column_name));
      },
    },

    async dispose() {
      // Self-cleanup: this suite owns the three plugin tables on the dedicated
      // test database (superuser, disclosed). Truncating keeps reruns
      // idempotent without rebuilding the database.
      await setup.$client
        .unsafe(
          "truncate enterprise_plugin_connections, enterprise_plugin_installs, enterprise_plugin_catalog cascade",
        )
        .catch(() => {});
      await setup.$client.close().catch(() => {});
      await base.dispose();
    },
  };
}

/** Issues a real trusted scope for one identity in one company/team. */
export async function scopeOf(
  fixture: PluginInstallFixture,
  identity: FixtureIdentity,
  teamKey: TeamKey,
): Promise<PlatformScope> {
  return fixture.base.scopeFor(
    identity,
    fixture.base.teamOf(identity, teamKey),
  );
}
