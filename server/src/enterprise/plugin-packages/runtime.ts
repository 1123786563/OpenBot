import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PackageManifestV1 } from "../../../../shared/enterprise/plugin-package-contracts";
import { enterpriseBotOwnership as botOwnershipRows } from "../../db/schema/enterprise-bot-ownership";
import { enterpriseExpertVersions } from "../../db/schema/enterprise-expert-versions";
import {
  enterprisePackageGrants as grantRows,
  enterprisePackageInstalls as installRows,
  enterprisePackageResourceLinks as linkRows,
  enterpriseRunPackagePins as pinRows,
  enterprisePackageRevisions as revisionRows,
} from "../../db/schema/enterprise-plugin-packages";
import { enterpriseRuns } from "../../db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import { loadArtifact } from "../../plugin-packages/artifact";
import type { PlatformScope } from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import { PERSONAL_BOT_ID_PREFIX } from "../tenancy/personal-bot";
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
 *   - chat runtime Skill read: WIRED (T03-fix) — the durable Runner reads
 *     `readPinnedSkills` for every admitted run (production composition in
 *     `index.ts` passes the SAME `createPackageRuntime` instance to
 *     `createProductionRunnerComposition` as `readPinnedSkills`); the runner
 *     carries the run's (runId, attemptGeneration) from its own admission —
 *     never from a client field. Non-empty pins re-resolve the executing agent
 *     with `pinnedPackageSkills` in the resolution context, so the run's Skill
 *     catalogue serves the pinned revision (merged after the legacy
 *     `grantedSkills` catalogue — never a downgrade of legacy grants). A run
 *     with no package context keeps the legacy contract untouched.
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

/**
 * One managed-connector tool binding pinned into a run attempt (PKG05,
 * Spec §7.2 `allowedToolRefs`). The digest/effect travel with the binding so
 * dispatch can prove the run was admitted against the SAME tool contract the
 * grant was written for; a later grant of the same tool name cannot be
 * absorbed by this attempt's pin.
 */
export interface PackageToolBinding {
  readonly resourceId: string;
  /** `<resourceId>:<toolName>` — the grant's tool_ref. */
  readonly toolRef: string;
  readonly schemaDigest: string;
  readonly effect: "read" | "write";
  readonly connectorInstallId: string;
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
  /** PKG05: managed-connector tools this attempt may dispatch. */
  readonly allowedToolBindings: readonly PackageToolBinding[];
}

/** A tool binding read back for the runner's re-resolution decision. */
export interface PinnedToolBinding extends PackageToolBinding {
  readonly installId: string;
  readonly runId: string;
  readonly attemptGeneration: number;
  readonly botId: string;
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
   * time, per spec "后续调用仍重验") that the calling Bot is the run's admitted
   * Bot, the initiator's memberships still hold, each pinned install is still
   * enabled and the grant still active, then serves skill summaries parsed
   * from the IMMUTABLE artifact of the pinned revision. Revoked / disabled /
   * missing artifact / lost membership → those skills disappear from the
   * served set. Never serves connector tools and never touches the global
   * skills slug table.
   */
  readPinnedSkills(
    scope: PlatformScope,
    input: PreparePackageRunInput,
  ): Promise<readonly PinnedSkillSummary[]>;
  /**
   * PKG05: the tool bindings this attempt pinned, re-validated at read time
   * (install still enabled, grant still active, same digest/effect). The
   * runner uses a non-empty result to re-resolve the executing agent WITH the
   * run's package context, so the model is offered exactly the tools this
   * attempt may dispatch. Empty for a run with no connector-tool pins — the
   * legacy offer is untouched.
   */
  readPinnedTools(
    scope: PlatformScope,
    input: PreparePackageRunInput,
  ): Promise<readonly PinnedToolBinding[]>;
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

/** Narrow a stored `allowed_tool_bindings` value to typed bindings. */
function toolBindingsOf(value: unknown): PackageToolBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: PackageToolBinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<PackageToolBinding>;
    if (
      typeof candidate.resourceId !== "string" ||
      typeof candidate.toolRef !== "string" ||
      typeof candidate.schemaDigest !== "string" ||
      (candidate.effect !== "read" && candidate.effect !== "write") ||
      typeof candidate.connectorInstallId !== "string"
    ) {
      continue;
    }
    bindings.push({
      resourceId: candidate.resourceId,
      toolRef: candidate.toolRef,
      schemaDigest: candidate.schemaDigest,
      effect: candidate.effect,
      connectorInstallId: candidate.connectorInstallId,
    });
  }
  return bindings.sort((left, right) =>
    left.toolRef < right.toolRef ? -1 : left.toolRef > right.toolRef ? 1 : 0,
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
          allowedToolBindings: pinRows.allowedToolBindings,
          pinnedInstallGeneration: pinRows.installGeneration,
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
            // The generation recorded at pin time — re-reading the live
            // install generation here would make the snapshot lie about what
            // was pinned (the runtime read revalidates it per read).
            installGeneration: row.pinnedInstallGeneration,
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
            allowedToolBindings: Object.freeze(
              toolBindingsOf(row.allowedToolBindings),
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
          resourceKind: grantRows.resourceKind,
          toolRef: grantRows.toolRef,
          schemaDigest: grantRows.schemaDigest,
          effect: grantRows.effect,
          connectorInstallId: grantRows.connectorInstallId,
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

      // Run admission binding (Spec §9 / AC5): the Bot's grants make this a
      // package run, so its trusted business ownership must resolve in THIS
      // scope before anything is pinned. A logically-private Bot (`pbot-`,
      // ADR 0006) has no wired execution-scope resolution in this version and
      // is refused loudly — the identity is never copied into an ownership row
      // and no default environment is fallen back to. An expert Bot whose
      // ownership row drifted away (deleted/soft-deleted/moved) is refused the
      // same way: grants without a resolvable execution scope must not start a
      // run. The error rolls the whole run start back (the caller's
      // transaction), so no package run ever starts unbound.
      if (rawInput.botId.startsWith(PERSONAL_BOT_ID_PREFIX)) {
        throw packageError("PACKAGE_BOT_SCOPE_UNAVAILABLE");
      }
      const [ownership] = await tx
        .select({
          workspaceId: botOwnershipRows.workspaceId,
          status: botOwnershipRows.status,
        })
        .from(botOwnershipRows)
        .where(
          and(
            eq(botOwnershipRows.tenantId, scope.tenantId),
            eq(botOwnershipRows.agentId, rawInput.botId),
          ),
        )
        .limit(1);
      if (
        ownership?.status !== "active" ||
        ownership.workspaceId !== scope.workspaceId
      ) {
        throw packageError("PACKAGE_BOT_SCOPE_UNAVAILABLE");
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
          /** Raw active connector-tool grant rows, classified below. */
          toolRows: (typeof grantFacts)[number][];
        }
      >();
      for (const fact of grantFacts) {
        let entry = byInstall.get(fact.installId);
        if (!entry) {
          entry = { fact, resources: new Set<string>(), toolRows: [] };
          byInstall.set(fact.installId, entry);
        }
        if (fact.resourceKind === "connectorTool") {
          entry.toolRows.push(fact);
          continue;
        }
        entry.resources.add(fact.resourceId);
      }

      // The install's CURRENT-revision links: the pin's allowed skill set is
      // the active grant ∩ the current revision's skill resources, and a tool
      // binding additionally needs the grant's connector install to be the one
      // the revision links for that resource. (Historical revisions' links
      // stay in the table but never describe the install.)
      const currentSkillIds = new Map<string, Set<string>>();
      /** resourceId → connector install id, current revision only. */
      const currentConnectorIds = new Map<string, string>();
      const currentRevisionLinks = await tx
        .select({
          installId: linkRows.installId,
          resourceId: linkRows.resourceId,
          revision: linkRows.revision,
          kind: linkRows.kind,
          connectorInstallId: linkRows.connectorInstallId,
        })
        .from(linkRows)
        .where(
          and(
            eq(linkRows.tenantId, scope.tenantId),
            eq(linkRows.workspaceId, scope.workspaceId),
            inArray(linkRows.installId, installIds),
            inArray(linkRows.kind, ["skill", "managedConnector"]),
          ),
        );
      for (const row of currentRevisionLinks) {
        const install = byInstall.get(row.installId);
        if (!install || row.revision !== install.fact.installRevision) continue;
        if (row.kind === "skill") {
          const set = currentSkillIds.get(row.installId) ?? new Set<string>();
          set.add(row.resourceId);
          currentSkillIds.set(row.installId, set);
          continue;
        }
        if (row.connectorInstallId) {
          currentConnectorIds.set(
            `${row.installId}\u0000${row.resourceId}`,
            row.connectorInstallId,
          );
        }
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
        const currentSkillsOfInstall =
          currentSkillIds.get(installId) ?? new Set<string>();
        const allowed = [...entry.resources]
          .filter((resourceId) => currentSkillsOfInstall.has(resourceId))
          .sort();
        // A tool row is pinned only when it names the CURRENT revision's
        // connector link AND carries the reviewed contract. A row that
        // cannot be described this way is skipped (fail-closed narrowing,
        // never a guessed digest).
        const toolBindings: PackageToolBinding[] = [];
        for (const toolRow of entry.toolRows) {
          const connectorInstallId = currentConnectorIds.get(
            `${installId}\u0000${toolRow.resourceId}`,
          );
          if (
            !connectorInstallId ||
            !toolRow.toolRef ||
            !toolRow.schemaDigest ||
            (toolRow.effect !== "read" && toolRow.effect !== "write") ||
            toolRow.connectorInstallId !== connectorInstallId
          ) {
            continue;
          }
          toolBindings.push({
            resourceId: toolRow.resourceId,
            toolRef: toolRow.toolRef,
            schemaDigest: toolRow.schemaDigest,
            effect: toolRow.effect,
            connectorInstallId,
          });
        }
        // Nothing left to pin for this install (grant superseded to nothing or
        // resources no longer linked): no pin row, nothing served later.
        if (allowed.length === 0 && toolBindings.length === 0) continue;
        const artifactDigest = digestOf.get(
          `${installId}\u0000${entry.fact.installRevision}`,
        );
        // Missing revision digest (L-2, disclosed): the install is skipped —
        // never pinned with unverifiable content. This is fail-closed
        // narrowing, not an authorization gap: the run simply has no package
        // surface for that install, and AC3's "no unpinned package run" holds
        // because a zero-pin run dispatches nothing. A hard failure here would
        // let corrupt artifact metadata roll back every run start for the Bot.
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
          allowedToolBindings: toolBindings,
          installGeneration: entry.fact.installGeneration,
        });
        pins.push({
          installId,
          packageKey: entry.fact.packageKey,
          installGeneration: entry.fact.installGeneration,
          revision: entry.fact.installRevision,
          artifactDigest,
          grantRevision,
          allowedResourceIds: Object.freeze(allowed),
          allowedToolBindings: Object.freeze(toolBindings),
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

        // (runId, attemptGeneration) → admitted bot binding (L-3): the pins of
        // a run are only ever served to the Bot the run was admitted for. The
        // run's expert version is the server-resolved agent identity written
        // by the run writer; a caller naming another Bot is a contract
        // violation, refused loudly. A run that does not exist in THIS scope
        // is indistinguishable from having no pins: the same empty set.
        const [run] = await tx
          .select({ expertVersionRef: enterpriseRuns.expertVersionRef })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, rawInput.runId),
            ),
          )
          .limit(1);
        if (run) {
          const [admitted] = await tx
            .select({ agentId: enterpriseExpertVersions.agentId })
            .from(enterpriseExpertVersions)
            .where(
              and(
                eq(enterpriseExpertVersions.tenantId, scope.tenantId),
                eq(
                  enterpriseExpertVersions.expertVersionRef,
                  run.expertVersionRef,
                ),
              ),
            )
            .limit(1);
          if (admitted?.agentId !== rawInput.botId) {
            throw packageError("INPUT_INVALID");
          }
        }

        // Membership revalidation (AC4, every read, zero cache): the run's
        // initiator must still be an active company member (epoch pinned to
        // the issued scope) and an active team member. A revoked principal's
        // next read serves nothing — fail closed, no distinction leaked.
        const [company] = await tx
          .select({
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        const [team] = await tx
          .select({ status: enterpriseWorkspaceMemberships.status })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (
          company?.status !== "active" ||
          company.epoch !== scope.memberEpoch ||
          team?.status !== "active"
        ) {
          return [];
        }

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

    async readPinnedTools(scope, rawInput) {
      assertTrustedScope(scope);
      assertRunInput(rawInput);
      return data.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );

        // The admitted-bot binding, exactly like the pinned Skill read (L-3):
        // another Bot naming this run is a contract violation, refused loudly;
        // a run unknown in this scope answers an empty set.
        const [run] = await tx
          .select({ expertVersionRef: enterpriseRuns.expertVersionRef })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, rawInput.runId),
            ),
          )
          .limit(1);
        if (run) {
          const [admitted] = await tx
            .select({ agentId: enterpriseExpertVersions.agentId })
            .from(enterpriseExpertVersions)
            .where(
              and(
                eq(enterpriseExpertVersions.tenantId, scope.tenantId),
                eq(
                  enterpriseExpertVersions.expertVersionRef,
                  run.expertVersionRef,
                ),
              ),
            )
            .limit(1);
          if (admitted?.agentId !== rawInput.botId) {
            throw packageError("INPUT_INVALID");
          }
        }

        // Membership revalidation, same as the Skill read: a revoked
        // principal's next read serves nothing.
        const [company] = await tx
          .select({
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        const [team] = await tx
          .select({ status: enterpriseWorkspaceMemberships.status })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
            ),
          )
          .limit(1);
        if (
          company?.status !== "active" ||
          company.epoch !== scope.memberEpoch ||
          team?.status !== "active"
        ) {
          return [];
        }

        // The pinned bindings, narrowed by what is STILL authorized now:
        // install enabled, install generation unmoved, and an active grant
        // row with the SAME digest/effect the pin captured. A grant granted
        // after admission never appears here (it is not in the pin); a grant
        // revoked since admission disappears (the run's offer narrows).
        const pinned = await tx
          .select({
            installId: pinRows.installId,
            revision: pinRows.revision,
            allowedToolBindings: pinRows.allowedToolBindings,
            installGeneration: pinRows.installGeneration,
            installStatus: installRows.status,
            liveGeneration: installRows.generation,
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

        const served: PinnedToolBinding[] = [];
        for (const pin of pinned) {
          if (pin.installStatus !== "enabled") continue;
          if (pin.installGeneration !== pin.liveGeneration) continue;
          const active = await tx
            .select({
              resourceId: grantRows.resourceId,
              toolRef: grantRows.toolRef,
              schemaDigest: grantRows.schemaDigest,
              effect: grantRows.effect,
              connectorInstallId: grantRows.connectorInstallId,
            })
            .from(grantRows)
            .where(
              and(
                eq(grantRows.tenantId, scope.tenantId),
                eq(grantRows.workspaceId, scope.workspaceId),
                eq(grantRows.installId, pin.installId),
                eq(grantRows.botId, rawInput.botId),
                isNull(grantRows.revokedAt),
                eq(grantRows.resourceKind, "connectorTool"),
              ),
            );
          const activeByKey = new Map(
            active.map((row) => [`${row.resourceId}\u0000${row.toolRef}`, row]),
          );
          for (const binding of toolBindingsOf(pin.allowedToolBindings)) {
            const live = activeByKey.get(
              `${binding.resourceId}\u0000${binding.toolRef}`,
            );
            if (!live) continue;
            if (
              live.schemaDigest !== binding.schemaDigest ||
              live.effect !== binding.effect ||
              live.connectorInstallId !== binding.connectorInstallId
            ) {
              // The contract moved since pinning: the run's offer narrows to
              // nothing for this tool until it is re-granted (A06).
              continue;
            }
            served.push({
              installId: pin.installId,
              runId: rawInput.runId,
              attemptGeneration: rawInput.attemptGeneration,
              botId: rawInput.botId,
              ...binding,
            });
          }
        }
        return served;
      });
    },
  };
}
