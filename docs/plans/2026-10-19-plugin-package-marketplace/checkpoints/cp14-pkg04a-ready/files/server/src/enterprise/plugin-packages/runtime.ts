import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PackageManifestV1 } from "../../../../shared/enterprise/plugin-package-contracts";
import {
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageResourceLinks as linkRows,
  enterpriseRunPackagePins as pinRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import { loadArtifact } from "../../plugin-packages/artifact";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";
import { packageError } from "./contracts";

/**
 * PKG03B package runtime (Spec §9): run pins + the pinned runtime Skill read.
 *
 * `prepareWithin` runs INSIDE the caller's run-write transaction. That tx is
 * the restricted data channel (`createConversationStore.transaction` →
 * `createRunInTransaction`): it sets transaction-local `app.tenant_id` /
 * `app.principal_id` / `app.user_id`, holds the member locks and revalidates
 * membership — but NOT `app.workspace_id`. The package tables' data policies
 * are tenant+workspace armed, so `prepareWithin` pins `app.workspace_id`
 * transaction-locally from the trusted scope (set_config local) before any
 * package read/write. With that GUC set, grants/installs/links are readable in
 * the same transaction and the pin INSERT passes the data policy — so Spec §9's
 * "same transaction" holds with NO snapshot bridge: run row, attempt row and
 * pin rows commit atomically, and a concurrent observer can never see a ready
 * run without its pins.
 *
 * TOCTOU analysis (documented decision, spec §9/§10):
 *   - Pin creation has no check-then-act window: the grant facts read and the
 *     pin rows written commit together with the run row. A grant revoked after
 *     commit cannot unpin, so the RUNTIME READ revalidates at every read:
 *     served skills = pin.allowed ∩ currently-active grant resources, gated on
 *     the install still being enabled (A05 narrowing). A revision upgrade
 *     never rewrites a pin: an old run keeps reading the OLD revision's
 *     artifact, and new-revision resources absent from the pin are refused
 *     (A06).
 *   - Read-time re-checks run in one read-committed data transaction per read,
 *     so a grant revoked mid-read serves either the old or the new set — never
 *     a mix across installs (per-pin independence is the unit).
 *
 * ENTRY WIRING MAP (support matrix seed; Spec §9 requires every entry to
 * record "wired" or "explicitly refused"):
 *   - chat run creation: WIRED — `createRunService.start` calls `prepareWithin`
 *     via `RunServiceDependencies.preparePackageRun` (production composition in
 *     `index.ts` → `createProductionRunnerComposition`).
 *   - chat runtime Skill read: NOT WIRED (disclosed deferral of brief
 *     deliverable 4) — `readPinnedSkills` below is implemented and tested, but
 *     has NO production call site: the chat skill-loading seam
 *     (`selectionForActor.loadSkills(botId)` in `index.ts`) resolves skills
 *     pre-admission from the botId alone and carries no run identity, so
 *     serving the pinned read through it requires threading (runId,
 *     attemptGeneration) through the dispatch path — deferred to the dispatch
 *     wiring ticket. `loadSkills` keeps its legacy `grantedSkills` behavior and
 *     cannot serve package resources (package skills never enter the global
 *     slug table).
 *   - approvals resume / schedules & responsibility / memory ingestion /
 *     `plugins/routes.ts` call / `app.ts` internal call: NOT WIRED — later
 *     tickets; until wired they must not serve package resources
 *     (PACKAGE_RUN_REQUIRED semantics belong to the dispatch slice).
 */

/**
 * The restricted run-write transaction handle. Structurally the same drizzle
 * transaction `createRunInTransaction` receives (the data channel), expressed
 * without importing the runs module.
 */
export type PackageRunWriteTx = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

export interface PreparePackageRunInput {
  readonly botId: string;
  readonly runId: string;
  readonly attemptGeneration: number;
}

/** One pinned install, as the run's authorization snapshot. */
export interface PackageRunPinSnapshot {
  readonly installId: string;
  readonly packageKey: string;
  readonly installGeneration: number;
  readonly revision: number;
  readonly artifactDigest: string;
  readonly grantRevision: number;
  readonly allowedResourceIds: readonly string[];
}

export interface PackageRunSnapshot {
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly botId: string;
  readonly pins: readonly PackageRunPinSnapshot[];
}

/** `grantedSkills`-shaped summary for one pinned package skill. */
export interface PinnedSkillSummary {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly tools: readonly string[];
}

export interface PackageRuntime {
  /**
   * Spec §9 `prepareWithin`: pins the Bot's active package grants into the
   * run-write transaction. Idempotent per (runId, attemptGeneration): a retry
   * reads the existing pins back and returns the same snapshot without writing.
   * No client input reaches this seam — the botId is the admission's
   * server-resolved agent, never a request field.
   */
  prepareWithin(
    tx: PackageRunWriteTx,
    scope: PlatformScope,
    input: PreparePackageRunInput,
  ): Promise<PackageRunSnapshot>;
  /**
   * The pinned runtime Skill read: given the run identity, re-validates (read
   * time, per spec "后续调用仍重验") that each pinned install is still enabled
   * and the grant still active, then serves skill summaries parsed from the
   * IMMUTABLE artifact of the pinned revision. Revoked / disabled / missing
   * artifact → those skills disappear from the served set. Never serves
   * connector tools and never touches the global skills slug table.
   */
  readPinnedSkills(
    scope: PlatformScope,
    input: PreparePackageRunInput,
  ): Promise<readonly PinnedSkillSummary[]>;
}

export interface CreatePackageRuntimeInput {
  readonly data: DataDatabase;
  /**
   * Content-addressed artifact root (the catalogue's root). Null degrades the
   * READ path to an empty set (fail closed); pin writing never needs it.
   */
  readonly artifactRoot: string | null;
}

function assertRunInput(input: PreparePackageRunInput): void {
  if (
    !input ||
    typeof input.botId !== "string" ||
    !input.botId.trim() ||
    input.botId.length > 256 ||
    typeof input.runId !== "string" ||
    !input.runId.trim() ||
    input.runId.length > 64 ||
    !Number.isSafeInteger(input.attemptGeneration) ||
    input.attemptGeneration <= 0
  ) {
    throw packageError("INPUT_INVALID");
  }
}

/**
 * Pins `app.workspace_id` transaction-locally. The run tx set tenant only;
 * every package-table data policy is tenant+workspace armed and the INSERT
 * WITH CHECK arm needs the workspace too. Local scope clears on commit and
 * rollback alike, so the caller's transaction is unchanged outside its own
 * lifetime, and the value comes from the trusted scope — never from input.
 */
async function pinWorkspaceLocally(
  tx: PackageRunWriteTx,
  scope: PlatformScope,
): Promise<void> {
  await tx.execute(
    sql`select set_config('app.workspace_id', ${scope.workspaceId}, true)`,
  );
}

export function createPackageRuntime(
  input: CreatePackageRuntimeInput,
): PackageRuntime {
  const { data } = input;

  return {
    async prepareWithin(tx, scope, rawInput) {
      assertTrustedScope(scope);
      assertRunInput(rawInput);
      await pinWorkspaceLocally(tx, scope);

      // Idempotent retry: same (run, attempt) → the same pins, never duplicates.
      const existing = await tx
        .select({
          installId: pinRows.installId,
          revision: pinRows.revision,
          releaseDigest: pinRows.releaseDigest,
          grantRevision: pinRows.grantRevision,
          allowedResourceIds: pinRows.allowedResourceIds,
          packageKey: installRows.packageKey,
          installGeneration: installRows.generation,
        })
        .from(pinRows)
        .innerJoin(
          installRows,
          and(
            eq(installRows.tenantId, pinRows.tenantId),
            eq(installRows.workspaceId, pinRows.workspaceId),
            eq(installRows.id, pinRows.installId),
          ),
        )
        .where(
          and(
            eq(pinRows.tenantId, scope.tenantId),
            eq(pinRows.workspaceId, scope.workspaceId),
            eq(pinRows.runId, rawInput.runId),
            eq(pinRows.attemptGeneration, rawInput.attemptGeneration),
          ),
        )
        .orderBy(asc(pinRows.installId));
      if (existing.length > 0) {
        return {
          runId: rawInput.runId,
          attemptGeneration: rawInput.attemptGeneration,
          botId: rawInput.botId,
          pins: existing.map((row) => ({
            installId: row.installId,
            packageKey: row.packageKey,
            installGeneration: row.installGeneration,
            revision: row.revision,
            artifactDigest: row.releaseDigest,
            grantRevision: row.grantRevision,
            allowedResourceIds: Object.freeze(
              Array.isArray(row.allowedResourceIds)
                ? row.allowedResourceIds.filter(
                    (id): id is string => typeof id === "string",
                  )
                : [],
            ),
          })),
        };
      }

      // The Bot's ACTIVE grants on ENABLED installs of this scope, in this one
      // transaction. Grant rows are the only package authorization; installs
      // never self-authorize ("安装≠授权").
      const grantFacts = await tx
        .select({
          installId: installRows.id,
          packageKey: installRows.packageKey,
          installGeneration: installRows.generation,
          installRevision: installRows.revision,
          resourceId: grantRows.resourceId,
          grantGeneration: grantRows.generation,
        })
        .from(grantRows)
        .innerJoin(
          installRows,
          and(
            eq(installRows.tenantId, grantRows.tenantId),
            eq(installRows.workspaceId, grantRows.workspaceId),
            eq(installRows.id, grantRows.installId),
          ),
        )
        .where(
          and(
            eq(grantRows.tenantId, scope.tenantId),
            eq(grantRows.workspaceId, scope.workspaceId),
            eq(grantRows.botId, rawInput.botId),
            isNull(grantRows.revokedAt),
            eq(installRows.status, "enabled"),
          ),
        )
        .orderBy(asc(grantRows.installId));
      if (grantFacts.length === 0) {
        return {
          runId: rawInput.runId,
          attemptGeneration: rawInput.attemptGeneration,
          botId: rawInput.botId,
          pins: [],
        };
      }

      // The grant revision counts DISTINCT generations for (install, bot) —
      // every row, including superseded/revoked ones (slice A semantics: the
      // revision is the CAS counter that revocation also advances). The
      // active-only facts above decide WHAT is allowed; this decides the
      // recorded revision.
      const installIds = [...new Set(grantFacts.map((fact) => fact.installId))];
      const generationRows = await tx
        .select({
          installId: grantRows.installId,
          generation: grantRows.generation,
        })
        .from(grantRows)
        .where(
          and(
            eq(grantRows.tenantId, scope.tenantId),
            eq(grantRows.workspaceId, scope.workspaceId),
            eq(grantRows.botId, rawInput.botId),
            inArray(grantRows.installId, installIds),
          ),
        );
      const generationsByInstall = new Map<string, Set<number>>();
      for (const row of generationRows) {
        const set =
          generationsByInstall.get(row.installId) ?? new Set<number>();
        set.add(row.generation);
        generationsByInstall.set(row.installId, set);
      }

      const byInstall = new Map<
        string,
        {
          fact: (typeof grantFacts)[number];
          resources: Set<string>;
        }
      >();
      for (const fact of grantFacts) {
        let entry = byInstall.get(fact.installId);
        if (!entry) {
          entry = { fact, resources: new Set<string>() };
          byInstall.set(fact.installId, entry);
        }
        entry.resources.add(fact.resourceId);
      }

      // The install's CURRENT-revision skill links: the pin's allowed set is
      // the active grant ∩ the current revision's skill resources. (Historical
      // revisions' links stay in the table but never describe the install.)
      const currentSkillIds = new Map<string, Set<string>>();
      const currentRevisionLinks = await tx
        .select({
          installId: linkRows.installId,
          resourceId: linkRows.resourceId,
          revision: linkRows.revision,
        })
        .from(linkRows)
        .where(
          and(
            eq(linkRows.tenantId, scope.tenantId),
            eq(linkRows.workspaceId, scope.workspaceId),
            inArray(linkRows.installId, installIds),
            eq(linkRows.kind, "skill"),
          ),
        );
      for (const row of currentRevisionLinks) {
        const install = byInstall.get(row.installId);
        if (!install || row.revision !== install.fact.installRevision) continue;
        const set = currentSkillIds.get(row.installId) ?? new Set<string>();
        set.add(row.resourceId);
        currentSkillIds.set(row.installId, set);
      }

      // The pinned revision's artifact digest (immutable revision facts).
      const revisions = await tx
        .select({
          installId: revisionRows.installId,
          revision: revisionRows.revision,
          artifactDigest: revisionRows.artifactDigest,
        })
        .from(revisionRows)
        .where(
          and(
            eq(revisionRows.tenantId, scope.tenantId),
            inArray(revisionRows.installId, installIds),
            inArray(
              revisionRows.revision,
              [...byInstall.values()].map(
                (entry) => entry.fact.installRevision,
              ),
            ),
          ),
        );
      const digestOf = new Map(
        revisions.map((row) => [
          `${row.installId}\u0000${row.revision}`,
          row.artifactDigest,
        ]),
      );

      const pinValues: Array<typeof pinRows.$inferInsert> = [];
      const pins: PackageRunPinSnapshot[] = [];
      for (const installId of [...byInstall.keys()].sort()) {
        const entry = byInstall.get(installId);
        if (!entry) continue;
        const currentSkillsOfInstall = currentSkillIds.get(installId);
        if (!currentSkillsOfInstall) continue;
        const allowed = [...entry.resources]
          .filter((resourceId) => currentSkillsOfInstall.has(resourceId))
          .sort();
        // Nothing left to pin for this install (grant superseded to nothing or
        // resources no longer linked): no pin row, nothing served later.
        if (allowed.length === 0) continue;
        const artifactDigest = digestOf.get(
          `${installId}\u0000${entry.fact.installRevision}`,
        );
        if (!artifactDigest) continue;
        const grantRevision = generationsByInstall.get(installId)?.size ?? 1;
        pinValues.push({
          tenantId: scope.tenantId,
          runId: rawInput.runId,
          attemptGeneration: rawInput.attemptGeneration,
          installId,
          workspaceId: scope.workspaceId,
          revision: entry.fact.installRevision,
          releaseDigest: artifactDigest,
          grantRevision,
          allowedResourceIds: allowed,
        });
        pins.push({
          installId,
          packageKey: entry.fact.packageKey,
          installGeneration: entry.fact.installGeneration,
          revision: entry.fact.installRevision,
          artifactDigest,
          grantRevision,
          allowedResourceIds: Object.freeze(allowed),
        });
      }
      if (pinValues.length > 0) {
        await tx.insert(pinRows).values(pinValues);
      }
      return {
        runId: rawInput.runId,
        attemptGeneration: rawInput.attemptGeneration,
        botId: rawInput.botId,
        pins: Object.freeze(pins),
      };
    },

    async readPinnedSkills(scope, rawInput) {
      assertTrustedScope(scope);
      assertRunInput(rawInput);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );

        // Read-time revalidation, per pin: the install must still be enabled.
        // The pin's revision row is immutable, so an upgraded install leaves
        // old pins pointing at the OLD revision (A06): the join intentionally
        // does NOT require install.revision = pin.revision.
        const pinned = await tx
          .select({
            installId: pinRows.installId,
            revision: pinRows.revision,
            releaseDigest: pinRows.releaseDigest,
            allowedResourceIds: pinRows.allowedResourceIds,
            packageKey: installRows.packageKey,
            installStatus: installRows.status,
          })
          .from(pinRows)
          .innerJoin(
            installRows,
            and(
              eq(installRows.tenantId, pinRows.tenantId),
              eq(installRows.workspaceId, pinRows.workspaceId),
              eq(installRows.id, pinRows.installId),
            ),
          )
          .where(
            and(
              eq(pinRows.tenantId, scope.tenantId),
              eq(pinRows.workspaceId, scope.workspaceId),
              eq(pinRows.runId, rawInput.runId),
              eq(pinRows.attemptGeneration, rawInput.attemptGeneration),
            ),
          )
          .orderBy(asc(pinRows.installId));

        const served: PinnedSkillSummary[] = [];
        for (const pin of pinned) {
          if (pin.installStatus !== "enabled") continue;
          // Still-active grant resources for this Bot (re-read now).
          const active = await tx
            .select({ resourceId: grantRows.resourceId })
            .from(grantRows)
            .where(
              and(
                eq(grantRows.tenantId, scope.tenantId),
                eq(grantRows.workspaceId, scope.workspaceId),
                eq(grantRows.installId, pin.installId),
                eq(grantRows.botId, rawInput.botId),
                isNull(grantRows.revokedAt),
              ),
            );
          const activeIds = new Set(active.map((row) => row.resourceId));
          const allowed = (pin.allowedResourceIds as string[])
            .filter((resourceId) => activeIds.has(resourceId))
            .sort();
          if (allowed.length === 0) continue;
          if (!input.artifactRoot) continue;
          let manifest: PackageManifestV1;
          try {
            // The IMMUTABLE artifact of the PINNED revision — an upgrade never
            // changes what an old run reads.
            ({ manifest } = await loadArtifact(
              input.artifactRoot,
              pin.releaseDigest,
            ));
          } catch {
            // Artifact gone/unreadable: fail closed for this install only.
            continue;
          }
          const titles = new Map(
            manifest.resources
              .filter((resource) => resource.kind === "skill")
              .map((resource) => [resource.id, resource]),
          );
          for (const resourceId of allowed) {
            if (!titles.has(resourceId)) continue;
            served.push({
              // Package skills never touch the global slug table: the slug is
              // install-scoped and resolved back through the pin, not a slug.
              slug: `pkg:${pin.installId}:${resourceId}`,
              title: manifest.display.name,
              summary: manifest.display.summary,
              tools: [],
            });
          }
        }
        return served;
      });
    },
  };
}
