/**
 * MT027 (Issue #70) credentials-ownership fixture support.
 *
 * Builds on the MT008 resource-policy fixture (which itself wraps the MT002
 * isolation fixture: two companies, three teams, real provisioning, real
 * restricted roles). This wrapper adds exactly the arrangements MT027's tests
 * need and nothing else:
 *
 *   - a memory SecretVault whose envelopes carry the plaintext verbatim
 *     (`v1:<plaintext>`), so the canary leak-scan has teeth: any surface that
 *     leaked an envelope would also leak the literal canary secret;
 *   - the MT027 ownership admin (restricted operator channel: register /
 *     revoke / grant / revoke action) and decision services (restricted data
 *     channel: authorizeUse / disclosePlaintext / list / describe);
 *   - a vendor-call probe that counts ONLY allow-branch executions, so the
 *     acceptance "a cross-company credential ID never triggers a vendor call"
 *     is observed as a real effect, not a verdict;
 *   - catalog probes through the dedicated superuser connection (RLS flags,
 *     grant matrix, journal-free DDL assertions) — never used for business
 *     reads or writes;
 *   - read-back helpers for action rows and audit rows through the restricted
 *     operator role.
 *
 * Nothing here mocks the authorization path: credentials, action grants,
 * disclosure audits and decisions all execute against real rows under the
 * restricted `ob_ent_*` PostgreSQL roles with real RLS.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type CredentialOwnershipAdminService,
  type CredentialOwnershipDecisionService,
  createCredentialOwnershipAdminService,
  createCredentialOwnershipDecisionService,
  type SecretVault,
} from "../../../src/enterprise/tenancy/credential-ownership";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

/** The canonical credential kinds (Issue #70: 连接凭据 / 站点登录). */
export type CredentialKind = "connection" | "site-login";
export type CredentialClassification = "personal" | "team" | "company";
export type CredentialAction = "use" | "disclose";

/**
 * Memory vault: the envelope embeds the plaintext verbatim on purpose. A
 * sealed secret that leaked through any surface would surface the literal
 * canary, so the redaction scans observe real leakage instead of trusting
 * an opaque-string coincidence.
 */
export class MemoryVault implements SecretVault {
  readonly sealed: readonly string[] = [];
  private readonly entries: string[] = [];

  async seal(plaintext: string): Promise<string> {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new Error("VAULT_SEAL_INVALID");
    }
    const envelope = `v1:${plaintext}`;
    this.entries.push(envelope);
    return envelope;
  }

  async open(envelope: string): Promise<string> {
    if (typeof envelope !== "string" || !envelope.startsWith("v1:")) {
      throw new Error("VAULT_OPEN_INVALID");
    }
    return envelope.slice(3);
  }

  sealedCount(): number {
    return this.entries.length;
  }
}

export interface CredentialFact {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly ownerPrincipalId: string | null;
  readonly classification: CredentialClassification;
  readonly kind: CredentialKind;
  readonly target: string;
  readonly label: string;
}

export interface CredentialsFixture {
  readonly base: ResourcePolicyFixture;
  /** Ownership admin (register/revoke/grant), riding the restricted operator channel. */
  readonly admin: CredentialOwnershipAdminService;
  /** Use/disclose/list/describe decisions, riding the restricted data channel. */
  readonly decisions: CredentialOwnershipDecisionService;
  /** Memory vault shared by both services (test double for the production AES vault). */
  readonly vault: MemoryVault;
  /** Vendor-call probe: `calls` increments only when an allow branch executes. */
  readonly vendorProbe: { readonly calls: () => number };
  /** Registers one credential through the real admin service. */
  provisionCredential(input: {
    readonly kind: CredentialKind;
    readonly classification: CredentialClassification;
    /** Owner identity for personal credentials. */
    readonly owner?: FixtureIdentity;
    /** Team for team credentials. */
    readonly team?: TeamKey;
    readonly target: string;
    readonly label: string;
    readonly plaintext: string;
  }): Promise<CredentialFact>;
  /** Grants one action to an identity's principal through the real admin service. */
  grantAction(input: {
    readonly credentialId: string;
    readonly to: FixtureIdentity;
    readonly action: CredentialAction;
  }): Promise<void>;
  /** Revokes one action row through the real admin service (delete-row semantics). */
  revokeAction(input: {
    readonly credentialId: string;
    readonly from: FixtureIdentity;
    readonly action: CredentialAction;
  }): Promise<void>;
  /** Principal id behind one fixture identity in one company. */
  principalOf(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): string;
  /**
   * Offline arrangement stand-in (superuser, disclosed): flips one company
   * membership to the requested status, bumping epoch (personal-share same
   * aid). Decision paths never run through this; only fixtures do.
   */
  setCompanyMembershipStatus(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
    status: "active" | "suspended",
  ): Promise<void>;
  /**
   * Materializes one team-a1 workspace-membership row for the company admin
   * (restricted operator channel, MT005 precedent). This makes the admin the
   * STRONGEST negative for personal credentials: an admin who is even a team
   * member of the owner's team still cannot use or read them.
   */
  materializeAdminTeamMembership(): Promise<void>;
  /**
   * Arrangement stand-in that flips ONLY the membership status without the
   * epoch bump (superuser, disclosed): pins that the decision layer enforces
   * status itself and never trusts upstream epoch discipline alone.
   */
  setCompanyMembershipStatusWithoutEpochBump(
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
    status: "active" | "suspended",
  ): Promise<void>;
  /** Action rows for one credential, read through the restricted operator. */
  actionRows(input: {
    readonly tenantId: string;
    readonly credentialId: string;
  }): Promise<readonly { principalId: string; action: string }[]>;
  /** Disclosure audit rows for one credential, read through the restricted operator. */
  auditRows(input: {
    readonly tenantId: string;
    readonly credentialId: string;
  }): Promise<
    readonly {
      id: string;
      principalId: string;
      action: string;
      detail: Record<string, unknown>;
    }[]
  >;
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
  };
  dispose(): Promise<void>;
}

/**
 * Creates the MT027 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT008 fixture does.
 */
export async function createCredentialsFixture(): Promise<CredentialsFixture> {
  const base = await createResourcePolicyFixture();
  // Dedicated setup (superuser) connection for arrangement stand-ins and
  // catalog-only assertions — never used for business reads or writes.
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });
  const vault = new MemoryVault();
  const admin = createCredentialOwnershipAdminService(base.operator, vault);
  const decisions = createCredentialOwnershipDecisionService(base.data, vault);

  let vendorCalls = 0;
  const vendorProbe = {
    calls: () => vendorCalls,
    /** The one and only allow-branch execution seam (stands for the vendor). */
    execute(): void {
      vendorCalls += 1;
    },
  };

  const principalOf = (
    identity: FixtureIdentity,
    companyKey: "company-a" | "company-b",
  ): string => {
    for (const company of base.isolation.identities[identity].companies) {
      if (company.companyKey === companyKey) return company.principalId;
    }
    throw new Error(`PRINCIPAL_MISSING:${identity}:${companyKey}`);
  };

  const idsOf = (identity: FixtureIdentity, teamKey: TeamKey) =>
    base.teamOf(identity, teamKey);

  return {
    base,
    admin,
    decisions,
    vault,
    vendorProbe,
    principalOf,
    async materializeAdminTeamMembership() {
      const team = base.teamOf("a1-member", "team-a1");
      const adminPrincipalId = principalOf("company-admin", "company-a");
      await base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${team.tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_workspace_memberships
            (tenant_id, workspace_id, principal_id, status, epoch)
          values (${team.tenantId}, ${team.workspaceId}, ${adminPrincipalId}, 'active', 1)
          on conflict do nothing
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

    async provisionCredential({
      kind,
      classification,
      owner,
      team,
      target,
      label,
      plaintext,
    }) {
      if (classification === "personal") {
        if (!owner) throw new Error("PROVISION_REQUIRES_OWNER");
        const fact = idsOf(owner, team ?? "team-a1");
        const { credentialId } = await admin.register({
          tenantId: fact.tenantId,
          kind,
          classification,
          ownerPrincipalId: fact.principalId,
          target,
          label,
          plaintext,
        });
        return {
          credentialId,
          tenantId: fact.tenantId,
          workspaceId: null,
          ownerPrincipalId: fact.principalId,
          classification,
          kind,
          target,
          label,
        };
      }
      if (classification === "team") {
        if (!team) throw new Error("PROVISION_REQUIRES_TEAM");
        // Anchor on a member who actually belongs to the target team; the
        // optional `owner` only selects the anchor identity.
        const anchor: FixtureIdentity =
          owner ??
          (team === "team-a2"
            ? "a2-member"
            : team === "team-b1"
              ? "b1-member"
              : "a1-member");
        const fact = idsOf(anchor, team);
        const { credentialId } = await admin.register({
          tenantId: fact.tenantId,
          kind,
          classification,
          workspaceId: fact.workspaceId,
          target,
          label,
          plaintext,
        });
        return {
          credentialId,
          tenantId: fact.tenantId,
          workspaceId: fact.workspaceId,
          ownerPrincipalId: null,
          classification,
          kind,
          target,
          label,
        };
      }
      const anchor: FixtureIdentity =
        owner ?? (team === "team-b1" ? "b1-member" : "a1-member");
      const fact = idsOf(anchor, team ?? "team-a1");
      const { credentialId } = await admin.register({
        tenantId: fact.tenantId,
        kind,
        classification,
        target,
        label,
        plaintext,
      });
      return {
        credentialId,
        tenantId: fact.tenantId,
        workspaceId: null,
        ownerPrincipalId: null,
        classification,
        kind,
        target,
        label,
      };
    },

    async grantAction({ credentialId, to, action }) {
      const fact = base.isolation.identities[to].companies[0];
      await admin.grantAction({
        tenantId: fact.tenantId,
        credentialId,
        principalId: fact.principalId,
        action,
        grantedBy: principalOf("company-admin", "company-a"),
      });
    },

    async revokeAction({ credentialId, from, action }) {
      const fact = base.isolation.identities[from].companies[0];
      await admin.revokeAction({
        tenantId: fact.tenantId,
        credentialId,
        principalId: fact.principalId,
        action,
      });
    },

    async actionRows({ tenantId, credentialId }) {
      const rows = (await base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select principal_id, action from enterprise_credential_actions
              where tenant_id = ${tenantId} and credential_id = ${credentialId}
              order by principal_id, action`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        principalId: String(row.principal_id),
        action: String(row.action),
      }));
    },

    async auditRows({ tenantId, credentialId }) {
      const rows = (await base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select id, principal_id, action, detail from enterprise_credential_audit
              where tenant_id = ${tenantId} and credential_id = ${credentialId}
              order by occurred_at, id`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        principalId: String(row.principal_id),
        action: String(row.action),
        detail: row.detail as Record<string, unknown>,
      }));
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
    },

    async dispose() {
      await setup.$client.close().catch(() => {});
      await base.dispose();
    },
  };
}

/** Resolves to the concatenated error-message + SQLSTATE chain ("" when it did not throw). */
export async function thrownMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const parts: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      parts.push(e.message);
      const code = (e as Error & { code?: unknown }).code;
      const errno = (e as Error & { errno?: unknown }).errno;
      if (typeof code === "string") parts.push(code);
      if (typeof errno === "string") parts.push(errno);
    }
    return parts.join(" | ");
  }
}

/** Issues a real trusted scope for one identity in one company/team. */
export async function scopeOf(
  fixture: CredentialsFixture,
  identity: FixtureIdentity,
  teamKey: TeamKey,
): Promise<PlatformScope> {
  let fact: { tenantId: string; workspaceId: string; principalId: string };
  try {
    fact = fixture.base.teamOf(identity, teamKey);
  } catch {
    // Arranged memberships (e.g. the materialized admin) are not in the
    // fixture's planned facts; resolve the selector from the isolation ids —
    // the scope resolver still verifies the real membership row.
    const ids = fixture.base.isolation.ids;
    const company =
      fixture.base.isolation.identities[identity].companies.find(
        (entry) =>
          entry.tenantId ===
          ids[teamKey === "team-b1" ? "company-b" : "company-a"],
      ) ?? fixture.base.isolation.identities[identity].companies[0];
    fact = {
      tenantId: company.tenantId,
      workspaceId: ids[teamKey],
      principalId: company.principalId,
    };
  }
  return fixture.base.scopeFor(identity, {
    tenantId: fact.tenantId,
    workspaceId: fact.workspaceId,
  });
}
