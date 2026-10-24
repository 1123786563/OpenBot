/**
 * PKG11 (#470, Spec §12.2): the apply half of `migrate-legacy.ts`, split out
 * because it is the only part that writes. It runs in one straight line:
 *
 *   manifest binding (digest) → builtin drift check → CAS re-verification of
 *   every source row → per-scope application through the REAL restricted
 *   services (plan/apply, grant set) and the real admin authorizer.
 *
 * CAS means: the live sources are re-exported and their manifest digest is
 * recomputed; anything that moved since the dry-run — a skill edited, an
 * install added, a grant revoked — refuses the WHOLE apply with the drifted
 * records named. The check precedes every write, so a refusal migrates
 * nothing partially.
 *
 * The apply itself is idempotent on two levels: stable idempotency keys
 * derived from the manifest digest replay stored receipts, and state checks
 * (install exists, provenance row exists, active grant set equal) skip work
 * that already landed — re-running a successful apply is a no-op that
 * reports what it found.
 */

import { readFile } from "node:fs/promises";
import { createDatabase } from "../../server/src/db/client";
import type { PlatformScope } from "../../server/src/enterprise/contracts";
import { createPackageService } from "../../server/src/enterprise/plugin-packages/install-service";
import { createPackageMutationStore } from "../../server/src/enterprise/plugin-packages/mutation-context";
import { createPackageReadStore } from "../../server/src/enterprise/plugin-packages/store";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../server/src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../server/src/enterprise/tenancy/store";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
} from "../../server/src/enterprise/tenancy/workspace-admin";
import {
  BUILTIN_PACKAGE_KEY,
  buildManifest,
  findScopeInstall,
  type LegacyInventory,
  type LegacyMigrationManifest,
  manifestDigestOf,
  openMigrationChannels,
  readLegacyInventory,
  upsertExpertProvenance,
} from "../../server/src/marketplace/legacy-migration";
import { loadPackageCatalogue } from "../../server/src/plugin-packages/catalogue";
import { builtinFactsFromIndex } from "./migrate-legacy";

export interface ApplyRefusal {
  readonly refused: true;
  readonly code:
    | "MANIFEST_DIGEST_MISMATCH"
    | "SOURCE_CHANGED"
    | "BUILTIN_DRIFT"
    | "BUILTIN_MISSING"
    | "SCOPE_HAS_NO_MAPPING";
  readonly detail: string;
}

export type ApplyOutcome =
  | ApplyRefusal
  | {
      readonly refused: false;
      readonly tenantId: string;
      readonly workspaceId: string;
      readonly install: { installId: string; created: boolean };
      readonly provenanceWritten: number;
      readonly botsGranted: number;
      readonly skippedUnresolved: number;
    };

function urlFrom(flag: string | undefined, ...envNames: string[]): string {
  if (flag) return flag;
  for (const name of envNames) {
    const value = process.env[name];
    if (value?.trim()) return value;
  }
  throw new Error(
    `a restricted-channel URL is required: ${envNames.join(" / ")} (or the matching --flag)`,
  );
}

function idempotencyKey(digest: string, suffix: string): string {
  // 128 printable-ASCII ceiling; 32 hex chars of manifest digest + suffix.
  return `pkg11-m:${digest.slice(0, 32)}:${suffix}`;
}

export async function runApply(input: {
  manifestPath: string;
  expectedDigest: string;
  scope: { tenantId: string; workspaceId: string };
  actorUserId: string;
  indexPath: string;
  artifactRoot?: string;
  urls: {
    legacyUrl?: string;
    setupUrl?: string;
    directoryUrl?: string;
    dataUrl?: string;
    operatorUrl?: string;
  };
}): Promise<ApplyOutcome> {
  const scopeIds = input.scope;

  // -- 1. Manifest binding: the file is intact AND is the one the operator
  //    confirmed (explicit digest), before any channel is opened.
  const manifest: LegacyMigrationManifest = JSON.parse(
    await readFile(input.manifestPath, "utf8"),
  );
  if (manifest.manifestDigest !== manifestDigestOf(manifest)) {
    return {
      refused: true,
      code: "MANIFEST_DIGEST_MISMATCH",
      detail:
        "the manifest file's own digest does not match its content — regenerate it with dry-run",
    };
  }
  if (manifest.manifestDigest !== input.expectedDigest) {
    return {
      refused: true,
      code: "MANIFEST_DIGEST_MISMATCH",
      detail:
        "the bound digest does not match this manifest — refusing to apply against a different plan",
    };
  }

  // -- 2. Builtin drift: the catalogue release the manifest mapped against
  //    must still be the published one.
  const builtin = await builtinFactsFromIndex(input.indexPath);
  if (!builtin.present) {
    return {
      refused: true,
      code: "BUILTIN_MISSING",
      detail: `${BUILTIN_PACKAGE_KEY} is not registered in the marketplace index`,
    };
  }
  if (
    manifest.builtin.artifactDigest !== builtin.artifactDigest ||
    manifest.builtin.version !== builtin.version
  ) {
    return {
      refused: true,
      code: "BUILTIN_DRIFT",
      detail: `the index now serves ${BUILTIN_PACKAGE_KEY}@${builtin.version} (${builtin.artifactDigest?.slice(0, 12)}…); the manifest bound ${manifest.builtin.version} (${manifest.builtin.artifactDigest?.slice(0, 12)}…)`,
    };
  }

  // -- 3. CAS re-verification: re-export the live sources and require the
  //    identical digest. Any concurrent change refuses before any write.
  const { channels, close } = await openMigrationChannels({
    legacyUrl: input.urls.legacyUrl,
    setupUrl: input.urls.setupUrl,
  });
  try {
    const liveInventory = await readLegacyInventory(
      channels.legacy,
      channels.setup,
      builtin,
    );
    const liveDigest = manifestDigestOf(buildManifest(builtin, liveInventory));
    if (liveDigest !== manifest.manifestDigest) {
      return {
        refused: true,
        code: "SOURCE_CHANGED",
        detail: `legacy sources changed since the dry-run (manifest ${manifest.manifestDigest.slice(0, 12)}…, live ${liveDigest.slice(0, 12)}…): ${driftSummary(manifest, liveInventory)}`,
      };
    }

    // -- 4. What this apply covers, for THIS scope only.
    const expertRecords = manifest.sources.expertInstalls.filter(
      (record) =>
        record.mapping !== null &&
        record.ownership?.tenantId === scopeIds.tenantId &&
        record.ownership?.workspaceId === scopeIds.workspaceId,
    );
    const grantRecords = manifest.sources.grants.filter(
      (record) =>
        record.mapping !== null &&
        record.ownership?.tenantId === scopeIds.tenantId &&
        record.ownership?.workspaceId === scopeIds.workspaceId,
    );
    if (expertRecords.length === 0 && grantRecords.length === 0) {
      return {
        refused: true,
        code: "SCOPE_HAS_NO_MAPPING",
        detail: `no mapped legacy records belong to ${scopeIds.tenantId}/${scopeIds.workspaceId}; nothing was written`,
      };
    }

    // -- 5. Restricted channels + the real scope/admin issuance (the same
    //    authorizers the HTTP surface uses; a non-admin actor refuses here).
    const directory = await verifyDirectoryDatabase(
      createDatabase(
        urlFrom(
          input.urls.directoryUrl,
          "ENTERPRISE_DIRECTORY_DATABASE_URL",
          "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
        ),
        { max: 2 },
      ),
    );
    const data = await verifyDataDatabase(
      createDatabase(
        urlFrom(
          input.urls.dataUrl,
          "ENTERPRISE_DATA_DATABASE_URL",
          "ENTERPRISE_TEST_DATA_DATABASE_URL",
        ),
        { max: 2 },
      ),
    );
    const operator = await verifyOperatorDatabase(
      createDatabase(
        urlFrom(
          input.urls.operatorUrl,
          "ENTERPRISE_OPERATOR_DATABASE_URL",
          "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
        ),
        { max: 2 },
      ),
    );
    try {
      const sessions = new WeakMap<Request, { userId: string }>();
      const identity = async (request: Request) => {
        const session = sessions.get(request);
        if (!session) return null;
        return { actorId: session.userId, entrypoint: "web" as const };
      };
      const signedRequest = () => {
        const request = new Request("https://pkg11-migrate.invalid/apply", {
          headers: {
            "x-openbot-tenant": scopeIds.tenantId,
            "x-openbot-workspace": scopeIds.workspaceId,
          },
        });
        sessions.set(request, { userId: input.actorUserId });
        return request;
      };
      const resolveScope = createScopeResolver(directory, {
        authenticate: identity,
        selectTenant: (request) => request.headers.get("x-openbot-tenant"),
        selectWorkspace: (request) =>
          request.headers.get("x-openbot-workspace"),
      }).resolve;
      const resolveAdmin = createCompanyAdminAuthorizer(directory, {
        authenticate: identity,
        selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      }).resolveAdminContext;
      const request = signedRequest();
      const scope: PlatformScope = await resolveScope(request);
      const admin: CompanyAdminContext = await resolveAdmin(request);

      const artifactRoot = input.artifactRoot ?? "plugins/.artifacts";
      const catalogue = await loadPackageCatalogue({
        index: JSON.parse(await readFile(input.indexPath, "utf8")),
        artifactRoot,
      });
      const service = createPackageService({
        catalogue,
        readStore: createPackageReadStore(data),
        mutation: createPackageMutationStore(operator),
        artifactRoot,
      });

      // -- 6. The scope's install of the built-in package (create once).
      const existingInstall = await findScopeInstall(channels.setup, scopeIds);
      let installId: string;
      let created: boolean;
      if (existingInstall && existingInstall.status !== "uninstalled") {
        installId = existingInstall.id;
        created = false;
      } else {
        const plan = await service.plan(scope, admin, {
          operation: "install",
          packageKey: BUILTIN_PACKAGE_KEY,
          version: manifest.builtin.version,
          expectedRevision: null,
          config: {},
          connectorInstalls: {},
        });
        const applied = await service.apply(
          scope,
          admin,
          plan.planId,
          idempotencyKey(manifest.manifestDigest, "install"),
        );
        installId = applied.install.installId;
        created = applied.created;
      }

      // -- 7. Expert provenance for the migrated legacy Bots (existing Bots
      //    keep running; the row records which template created them).
      const mutation = createPackageMutationStore(operator);
      const installRevision =
        (await findScopeInstall(channels.setup, scopeIds))?.revision ?? 1;
      let provenanceWritten = 0;
      for (const record of expertRecords) {
        const written = await upsertExpertProvenance(mutation, scope, admin, {
          workspaceId: scopeIds.workspaceId,
          agentId: record.agentId,
          installId,
          revision: installRevision,
          resourceId: record.expertSlug,
        });
        if (written) provenanceWritten += 1;
      }

      // -- 8. Grants: exactly the legacy-mapped skills per Bot — never a
      //    wider set than the legacy authorization state, never silently
      //    re-granted (an equal active set is a no-op).
      const grantsByBot = new Map<string, Set<string>>();
      for (const record of grantRecords) {
        if (record.mapping === null) continue;
        const current = grantsByBot.get(record.agentId) ?? new Set<string>();
        current.add(record.mapping.resourceId);
        grantsByBot.set(record.agentId, current);
      }
      let botsGranted = 0;
      for (const [botId, resourceIds] of grantsByBot) {
        const detail = await service.get(scope, installId);
        const active = detail.grants.find((grant) => grant.botId === botId);
        const activeIds = new Set(
          (active?.resources ?? [])
            .filter((resource) => resource.kind === "skill")
            .map((resource) => resource.resourceId),
        );
        const sameSet =
          activeIds.size === resourceIds.size &&
          [...resourceIds].every((id) => activeIds.has(id));
        if (sameSet) continue;
        await service.setBotGrant(
          scope,
          admin,
          {
            installId,
            botId,
            expectedGrantRevision: active?.revision ?? null,
            resources: [...resourceIds]
              .sort()
              .map((resourceId) => ({ resourceId, kind: "skill" as const })),
          },
          idempotencyKey(
            manifest.manifestDigest,
            `grant:${botId.slice(0, 48)}`,
          ),
        );
        botsGranted += 1;
      }

      return {
        refused: false,
        tenantId: scopeIds.tenantId,
        workspaceId: scopeIds.workspaceId,
        install: { installId, created },
        provenanceWritten,
        botsGranted,
        skippedUnresolved: manifest.counts.unresolved,
      };
    } finally {
      await Promise.allSettled([
        directory.$client.close(),
        data.$client.close(),
        operator.$client.close(),
      ]);
    }
  } finally {
    await close();
  }
}

/** Human-short summary of what drifted, for the refusal receipt. */
function driftSummary(
  manifest: LegacyMigrationManifest,
  live: LegacyInventory,
): string {
  const parts: string[] = [];
  const liveExpertIds = new Set(live.expertInstalls.map((r) => r.id));
  const liveGrantKeys = new Set(
    live.grants.map((r) => `${r.agentId}:${r.ref}`),
  );
  const removedExperts = manifest.sources.expertInstalls.filter(
    (r) => !liveExpertIds.has(r.id),
  );
  const addedExperts = live.expertInstalls.filter(
    (r) => !manifest.sources.expertInstalls.some((m) => m.id === r.id),
  );
  const changedHashes = manifest.sources.expertInstalls.filter(
    (r) =>
      liveExpertIds.has(r.id) &&
      live.expertInstalls.some(
        (m) => m.id === r.id && m.contentHash !== r.contentHash,
      ),
  );
  const changedSkillHashes = manifest.sources.skillRows.filter((r) =>
    live.skillRows.some(
      (m) => m.id === r.id && m.contentHash !== r.contentHash,
    ),
  );
  const changedGrants = manifest.sources.grants.filter(
    (r) => !liveGrantKeys.has(`${r.agentId}:${r.ref}`),
  );
  if (removedExperts.length)
    parts.push(`${removedExperts.length} expert install(s) removed`);
  if (addedExperts.length)
    parts.push(`${addedExperts.length} expert install(s) added`);
  if (changedHashes.length)
    parts.push(`${changedHashes.length} expert install(s) content changed`);
  if (changedSkillHashes.length)
    parts.push(`${changedSkillHashes.length} skill row(s) content changed`);
  if (changedGrants.length)
    parts.push(`${changedGrants.length} grant(s) changed`);
  return parts.length > 0 ? parts.join("; ") : "row-level hash drift";
}
