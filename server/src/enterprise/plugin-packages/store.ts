import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageResourceLinks as linkRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import { assertDataDatabase, type DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";
import type {
  PackageGrantFact,
  PackageInstallFacts,
  PackageReadStore,
  PackageResourceLinkFact,
} from "./contracts";

/**
 * PKG02 read store: the current scope's install facts, read through the
 * verified restricted data role under real RLS.
 *
 * Every read is one read-committed transaction with transaction-local
 * `app.tenant_id` / `app.workspace_id` (defence in depth on top of the RLS
 * arms), never the operator channel and never a fallback. Another team's rows
 * are invisible at the policy level; the explicit tenant/workspace predicates
 * are the second, independent line.
 */

type DataTransaction = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

interface InstallRowFacts {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly packageKey: string;
  readonly currentVersion: string;
  readonly status: string;
  readonly generation: number;
  readonly revision: number;
  readonly artifactDigest: string | null;
  readonly membershipStatus: string | null;
  readonly membershipEpoch: number | null;
  readonly workspaceMembershipStatus: string | null;
}

async function readTransaction<T>(
  data: DataDatabase,
  scope: PlatformScope,
  operation: (tx: DataTransaction) => Promise<T>,
): Promise<T> {
  return data.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    /* Transaction-local settings are cleared on commit and rollback alike. */
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
    );
    return operation(tx);
  });
}

/** Live eligibility: company active at the scope epoch + team active. */
function isEligible(row: InstallRowFacts, scope: PlatformScope): boolean {
  return (
    row.membershipStatus === "active" &&
    row.membershipEpoch === scope.memberEpoch &&
    row.workspaceMembershipStatus === "active"
  );
}

async function loadLinks(
  tx: DataTransaction,
  scope: PlatformScope,
  installIds: readonly string[],
): Promise<Map<string, PackageResourceLinkFact[]>> {
  const byInstall = new Map<string, PackageResourceLinkFact[]>();
  if (installIds.length === 0) return byInstall;
  const rows = await tx
    .select({
      installId: linkRows.installId,
      revision: linkRows.revision,
      resourceId: linkRows.resourceId,
      kind: linkRows.kind,
      connectorInstallId: linkRows.connectorInstallId,
      existingSkillId: linkRows.existingSkillId,
      expertTemplateRef: linkRows.expertTemplateRef,
    })
    .from(linkRows)
    // Only the link rows of the install's CURRENT revision: a historical
    // revision's links stay in the table (append-only) but never describe the
    // install as it stands now.
    .innerJoin(
      installRows,
      and(
        eq(installRows.tenantId, linkRows.tenantId),
        eq(installRows.id, linkRows.installId),
        eq(installRows.revision, linkRows.revision),
      ),
    )
    .where(
      and(
        eq(linkRows.tenantId, scope.tenantId),
        eq(linkRows.workspaceId, scope.workspaceId),
        inArray(linkRows.installId, [...installIds]),
      ),
    )
    .orderBy(asc(linkRows.installId), asc(linkRows.resourceId));
  for (const row of rows) {
    const list = byInstall.get(row.installId) ?? [];
    list.push({
      resourceId: row.resourceId,
      kind: row.kind as PackageResourceLinkFact["kind"],
      connectorInstallId: row.connectorInstallId,
      existingSkillId: row.existingSkillId,
      expertTemplateRef: row.expertTemplateRef,
    });
    byInstall.set(row.installId, list);
  }
  return byInstall;
}

/**
 * PKG03A active Bot grants per install. `revision` counts DISTINCT grant
 * generations for (install, bot) — every row counts, including revoked ones —
 * while `resources` lists only rows whose `revoked_at` is null. Superseded
 * rows stay in the table (append-friendly) but never describe the current
 * authorization state.
 */
async function loadGrants(
  tx: DataTransaction,
  scope: PlatformScope,
  installIds: readonly string[],
): Promise<Map<string, PackageGrantFact[]>> {
  const byInstall = new Map<string, PackageGrantFact[]>();
  if (installIds.length === 0) return byInstall;
  const rows = await tx
    .select({
      installId: grantRows.installId,
      botId: grantRows.botId,
      resourceId: grantRows.resourceId,
      resourceKind: grantRows.resourceKind,
      toolRef: grantRows.toolRef,
      generation: grantRows.generation,
      revokedAt: grantRows.revokedAt,
    })
    .from(grantRows)
    .where(
      and(
        eq(grantRows.tenantId, scope.tenantId),
        eq(grantRows.workspaceId, scope.workspaceId),
        inArray(grantRows.installId, [...installIds]),
      ),
    )
    .orderBy(asc(grantRows.installId), asc(grantRows.botId));
  interface Accumulator {
    readonly generations: Set<number>;
    readonly skills: Set<string>;
    readonly tools: Map<string, Set<string>>;
  }
  const byBot = new Map<string, Accumulator>();
  for (const row of rows) {
    const key = `${row.installId}\u0000${row.botId}`;
    const accumulator = byBot.get(key) ?? {
      generations: new Set<number>(),
      skills: new Set<string>(),
      tools: new Map<string, Set<string>>(),
    };
    accumulator.generations.add(row.generation);
    if (row.revokedAt === null) {
      if (row.resourceKind === "connectorTool") {
        const set = accumulator.tools.get(row.resourceId) ?? new Set<string>();
        set.add(row.toolRef);
        accumulator.tools.set(row.resourceId, set);
      } else {
        accumulator.skills.add(row.resourceId);
      }
    }
    byBot.set(key, accumulator);
  }
  for (const [key, accumulator] of byBot) {
    // A Bot with no active rows has no grant to surface (its generations are
    // history); only bots with at least one live resource appear.
    if (accumulator.skills.size === 0 && accumulator.tools.size === 0) continue;
    const installId = key.split("\u0000")[0] as string;
    const botId = key.split("\u0000")[1] as string;
    const list = byInstall.get(installId) ?? [];
    list.push({
      botId,
      revision: accumulator.generations.size,
      resources: [
        ...[...accumulator.skills]
          .sort()
          .map((resourceId) => ({ resourceId, kind: "skill" as const })),
        ...[...accumulator.tools.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([resourceId, toolRefs]) => ({
            resourceId,
            kind: "managedConnector" as const,
            toolRefs: [...toolRefs].sort(),
          })),
      ],
    });
    byInstall.set(installId, list);
  }
  return byInstall;
}

const INSTALL_COLUMNS = {
  tenantId: installRows.tenantId,
  workspaceId: installRows.workspaceId,
  id: installRows.id,
  packageKey: installRows.packageKey,
  currentVersion: installRows.currentVersion,
  status: installRows.status,
  generation: installRows.generation,
  revision: installRows.revision,
  artifactDigest: revisionRows.artifactDigest,
  membershipStatus: enterpriseMemberships.status,
  membershipEpoch: enterpriseMemberships.epoch,
  workspaceMembershipStatus: enterpriseWorkspaceMemberships.status,
} as const;

function joinEligibility(
  tx: DataTransaction,
  scope: PlatformScope,
  where: ReturnType<typeof and>,
) {
  return tx
    .select(INSTALL_COLUMNS)
    .from(installRows)
    .innerJoin(
      revisionRows,
      and(
        eq(revisionRows.tenantId, installRows.tenantId),
        eq(revisionRows.installId, installRows.id),
        eq(revisionRows.revision, installRows.revision),
      ),
    )
    .leftJoin(
      enterpriseMemberships,
      and(
        eq(enterpriseMemberships.tenantId, installRows.tenantId),
        eq(enterpriseMemberships.principalId, scope.principalId),
      ),
    )
    .leftJoin(
      enterpriseWorkspaceMemberships,
      and(
        eq(enterpriseWorkspaceMemberships.tenantId, installRows.tenantId),
        eq(enterpriseWorkspaceMemberships.workspaceId, installRows.workspaceId),
        eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
      ),
    )
    .where(where);
}

function toFacts(
  row: InstallRowFacts,
  links: readonly PackageResourceLinkFact[],
  grants: readonly PackageGrantFact[],
): PackageInstallFacts | null {
  if (!row.artifactDigest) return null;
  return Object.freeze({
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    installId: row.id,
    packageKey: row.packageKey,
    version: row.currentVersion,
    artifactDigest: row.artifactDigest,
    revision: row.revision,
    generation: row.generation,
    status: row.status as PackageInstallFacts["status"],
    links: Object.freeze([...links]),
    grants: Object.freeze([...grants]),
  });
}

export function createPackageReadStore(data: DataDatabase): PackageReadStore {
  assertDataDatabase(data);
  return {
    async listInstalls(scope) {
      assertTrustedScope(scope);
      return readTransaction(data, scope, async (tx) => {
        const rows = await joinEligibility(
          tx,
          scope,
          and(
            eq(installRows.tenantId, scope.tenantId),
            eq(installRows.workspaceId, scope.workspaceId),
          ),
        ).orderBy(asc(installRows.createdAt), asc(installRows.id));
        const eligible = rows.filter((row) => isEligible(row, scope));
        const links = await loadLinks(
          tx,
          scope,
          eligible.map((row) => row.id),
        );
        const grants = await loadGrants(
          tx,
          scope,
          eligible.map((row) => row.id),
        );
        return eligible
          .map((row) =>
            toFacts(row, links.get(row.id) ?? [], grants.get(row.id) ?? []),
          )
          .filter((facts): facts is PackageInstallFacts => facts !== null);
      });
    },

    async getInstall(scope, installId) {
      assertTrustedScope(scope);
      if (typeof installId !== "string" || !installId.trim()) return null;
      return readTransaction(data, scope, async (tx) => {
        const [row] = await joinEligibility(
          tx,
          scope,
          and(
            eq(installRows.tenantId, scope.tenantId),
            eq(installRows.workspaceId, scope.workspaceId),
            eq(installRows.id, installId),
          ),
        ).limit(1);
        // Cross-team, unknown and revoked-membership rows are all "not found"
        // at this seam: the caller answers one identical 404 shape.
        if (!row || !isEligible(row, scope)) return null;
        const links = await loadLinks(tx, scope, [row.id]);
        const grants = await loadGrants(tx, scope, [row.id]);
        return toFacts(row, links.get(row.id) ?? [], grants.get(row.id) ?? []);
      });
    },
  };
}
