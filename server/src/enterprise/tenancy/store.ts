import { and, eq, sql } from "drizzle-orm";
import type { CompanyAssurance } from "../../auth/company-assurance";
import type { DirectoryAuthority } from "../../auth/directory/authority";
import type { Database } from "../../db/client";
import {
  authMembers,
  authTeamBindings,
  authTeamMembers,
} from "../../db/schema/auth-directory";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../../db/schema/core";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import { createAuthz } from "../authz/service";
import type {
  PlatformScope,
  ResourceReader,
  ResourceView,
  ScopeResolver,
} from "../contracts";
import {
  assertDataDatabase,
  assertDirectoryDatabase,
  type DataDatabase,
  type DirectoryDatabase,
} from "./connections";

/** A result supplied only by the server's existing authenticated-session layer. */
export interface AuthenticatedRequestIdentity {
  readonly actorId: string;
  readonly entrypoint: PlatformScope["entrypoint"];
}

export interface ScopeResolverOptions {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  /** Tenant/workspace values are selectors only; the database membership determines authority. */
  selectTenant?(request: Request): string | null;
  selectWorkspace?(request: Request): string | null;
  data?: DataDatabase;
}

const issuedScopes = new WeakSet<object>();

export function assertTrustedScope(scope: PlatformScope): void {
  if (!scope || typeof scope !== "object" || !issuedScopes.has(scope)) {
    throw new Error("UNVERIFIED_SCOPE");
  }
}

export function requireAuthenticatedIdentity<
  T extends AuthenticatedRequestIdentity,
>(identity: T | null): T {
  if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
  return identity;
}

async function mapStorageFaults<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "DATA_DATABASE_UNAVAILABLE")
      throw error;
    // Runtime driver/infrastructure faults on the storage hot path surface as
    // unavailability (503) rather than raw 500s; the original fault rides on
    // `cause` for diagnostics — and leaves one structured log, so real
    // faults (including authorization regressions) are never silent (OCR R10).
    // biome-ignore lint/suspicious/noConsole: stable-code operational log
    console.error({
      error: "DATA_DATABASE_FAULT",
      cause:
        error instanceof Error
          ? ((error as { code?: unknown }).code ?? error.constructor.name)
          : typeof error,
    });
    throw Object.assign(new Error("DATA_DATABASE_UNAVAILABLE"), {
      cause: error,
    });
  }
}

/*
 * --- T03.01 (#538, interfaces §4): the BA-aware scope resolver ---------------
 *
 * The authority-aware issuance half. Inside ONE short directory transaction
 * the resolver reads the persisted AuthorityState and decides:
 *
 * - legacy (M0/M1) and paused (M2/M3): the original issuance runs, byte for
 *   byte — no BA table is read, no clock, no proof — so an existing tenant is
 *   never refused by a migration it has not reached, and business keeps the
 *   legacy facts while the directory is paused for the backfill.
 * - ba (M4..M7): the resolver additionally proves the BA directory facts
 *   (member row, team binding, team member row), the verified
 *   `identity_generation` (a NULL generation is "cannot compare", never a
 *   default) and the additional company proof, then reads the durable
 *   two-layer clocks and stamps their epoch/generation into the scope:
 *   `memberEpoch`/`companyGeneration` from the company clock,
 *   `workspaceMemberEpoch`/`teamGeneration` from the team clock. The clock
 *   read rides the data connection through its controlled function — the one
 *   privilege a runtime role holds on the clocks. A scope without versions
 *   never validates against the ba gate: the switch is fail-closed.
 *
 * The clock read is a second, later statement than the membership facts —
 * issuance is advisory, and the workspace gate revalidates BOTH the live rows
 * and the same clocks atomically at use time, so any drift between the two
 * reads can only produce a scope the gate immediately refuses.
 *
 * The three dependencies are REQUIRED at construction: an optional authority
 * would guess the branch, and an optional proof port is exactly the bypass
 * interfaces §5 forbids.
 */

/** The required dependencies of the BA scope resolver (T03.01). */
export interface BaScopeResolverOptions {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  selectTenant?(request: Request): string | null;
  selectWorkspace?(request: Request): string | null;
  /** Reads the durable eligibility clocks via `auth_read_eligibility_clocks`. */
  readonly data: Database;
  /** Read inside the resolver's own transaction; never a cached branch. */
  readonly authority: Pick<DirectoryAuthority, "read">;
  /** Asked inside the ba branch's transaction only. */
  readonly assurance: CompanyAssurance;
}

/** One eligibility clock row, already epoch/generation-string normalized. */
interface ClockRow {
  readonly kind: string;
  readonly scopeId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly tombstone: boolean;
}

/** Drizzle execute results arrive as rows or wrapped rows depending on driver shape. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/** A `Version` a reader may compare: a non-negative safe integer, never a default. */
function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The server actor the proof question is asked for. A scope resolution runs
 * from a verified identity, not a client field; the live require (T05.04)
 * answers this platform actor from the user's active proof, and the
 * per-session binding tightens when the issuance identity carries its
 * private session association.
 */
function identityActor(
  identity: AuthenticatedRequestIdentity,
): Parameters<CompanyAssurance["require"]>[1] {
  return Object.freeze({
    userId: identity.actorId,
    principalId: null,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  });
}

/** The BA membership facts the ba branch proves inside the directory transaction. */
interface BaMembershipFacts {
  readonly principalId: string;
  readonly identityGeneration: number;
}

/**
 * Reads and proves the ba-branch membership facts on the caller's open
 * directory transaction: live identity/company statuses with a comparable
 * identity generation, the BA member row ("who is a member now"), the team
 * binding that pins the workspace to its BA team, and the BA team-member row
 * beside the business projection. Refusals reuse the legacy vocabulary
 * (TENANT_FORBIDDEN / WORKSPACE_FORBIDDEN) so a missing row, a suspended
 * relationship and a nonexistent object stay indistinguishable — no
 * existence leak — and the caller maps the same 403 family it always did.
 */
async function readBaMembershipFacts(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  actorId: string,
  tenantId: string,
  workspaceId: string,
): Promise<BaMembershipFacts> {
  const [member] = await tx
    .select({
      principalId: enterprisePrincipals.id,
      principalStatus: enterprisePrincipals.status,
      identityGeneration: enterprisePrincipals.identityGeneration,
      tenantStatus: enterpriseTenants.status,
      memberStatus: enterpriseMemberships.status,
    })
    .from(enterpriseMemberships)
    .innerJoin(
      enterprisePrincipals,
      eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
    )
    .innerJoin(
      enterpriseTenants,
      eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
    )
    .where(
      and(
        eq(enterprisePrincipals.userId, actorId),
        eq(enterpriseMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (
    member?.tenantStatus !== "active" ||
    member.principalStatus !== "active" ||
    member.memberStatus !== "active" ||
    !isSafeVersion(member.identityGeneration)
  ) {
    // A NULL identity generation is "cannot compare" — the branch closes
    // rather than issuing a scope that guesses a version (interfaces §2).
    throw new Error("TENANT_FORBIDDEN");
  }
  // The BA directory's own membership fact: the member row under the
  // organization the tenant maps to. Its absence closes the same way.
  const [baMember] = await tx
    .select({ role: authMembers.role })
    .from(authMembers)
    .where(
      and(
        eq(authMembers.organizationId, tenantId),
        eq(authMembers.userId, actorId),
      ),
    )
    .limit(1);
  if (!baMember) {
    throw new Error("TENANT_FORBIDDEN");
  }
  // Team facts: the stable binding pins (tenant, workspace) → BA team, the
  // BA team-member row proves current team membership, and the business
  // projection must still carry an active row — all in one joined read, so a
  // binding whose team member or projection is missing closes the team half.
  const [team] = await tx
    .select({
      teamId: authTeamBindings.teamId,
      teamMemberId: authTeamMembers.id,
      workspaceStatus: enterpriseWorkspaceMemberships.status,
    })
    .from(authTeamBindings)
    .innerJoin(
      authTeamMembers,
      and(
        eq(authTeamMembers.teamId, authTeamBindings.teamId),
        eq(authTeamMembers.userId, actorId),
      ),
    )
    .innerJoin(
      enterpriseWorkspaceMemberships,
      and(
        eq(enterpriseWorkspaceMemberships.tenantId, authTeamBindings.tenantId),
        eq(
          enterpriseWorkspaceMemberships.workspaceId,
          authTeamBindings.workspaceId,
        ),
        eq(enterpriseWorkspaceMemberships.principalId, member.principalId),
      ),
    )
    .where(
      and(
        eq(authTeamBindings.tenantId, tenantId),
        eq(authTeamBindings.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (team?.workspaceStatus !== "active") {
    throw new Error("WORKSPACE_FORBIDDEN");
  }
  return {
    principalId: member.principalId,
    identityGeneration: member.identityGeneration,
  };
}

/**
 * Reads the durable two-layer clocks through the data connection's
 * controlled function and returns the company and team rows for one
 * (tenant, principal) pair, or the missing halves as undefined.
 */
async function readBaClocks(
  data: Database,
  tenantId: string,
  principalId: string,
): Promise<{ company?: ClockRow; team?: ClockRow }> {
  const rows = rowsOf(
    await data.execute(
      sql`select kind, scope_id, epoch::text as epoch, generation::text as generation, tombstone
            from auth_read_eligibility_clocks(${tenantId}, ${principalId})`,
    ),
  );
  const clocks: ClockRow[] = [];
  for (const row of rows) {
    const epoch = Number(row.epoch);
    const generation = Number(row.generation);
    if (!isSafeVersion(epoch) || !isSafeVersion(generation)) continue;
    clocks.push({
      kind: String(row.kind),
      scopeId: String(row.scope_id),
      epoch,
      generation,
      tombstone: row.tombstone === true,
    });
  }
  return {
    company: clocks.find(
      (clock) => clock.kind === "company" && clock.scopeId === tenantId,
    ),
    team: clocks.find((clock) => clock.kind === "team"),
  };
}

/** Validates both clock halves for issuance: present, not tombstoned, comparable. */
function requireUsableClocks(
  clocks: { company?: ClockRow; team?: ClockRow },
  workspaceId: string,
): { company: ClockRow; team: ClockRow } {
  const { company, team } = clocks;
  if (!company || company.tombstone) {
    // A removed member's clock tombstones; a missing clock is a migration
    // hole. Both close the company half instead of issuing a guessed version.
    throw new Error("TENANT_FORBIDDEN");
  }
  if (!team || team.tombstone || team.scopeId !== workspaceId) {
    throw new Error("WORKSPACE_FORBIDDEN");
  }
  return { company, team };
}

export function createBaScopeResolver(
  database: Database,
  options: BaScopeResolverOptions,
): ScopeResolver {
  if (!options || typeof options.authenticate !== "function") {
    throw new Error(
      "BA_SCOPE_RESOLVER_DEPS_REQUIRED: createBaScopeResolver needs the authenticated-identity source; a scope can only be issued from a verified session layer",
    );
  }
  if (!options?.data) {
    throw new Error(
      "BA_SCOPE_RESOLVER_DEPS_REQUIRED: createBaScopeResolver needs the data connection the durable eligibility clocks are read through",
    );
  }
  if (typeof options?.authority?.read !== "function") {
    throw new Error(
      "BA_SCOPE_RESOLVER_DEPS_REQUIRED: createBaScopeResolver needs the directory authority port — without an in-transaction authority read the resolver cannot tell a ba issuance from a legacy one, and an optional port is the bypass interfaces §3.3 forbids",
    );
  }
  if (typeof options?.assurance?.require !== "function") {
    throw new Error(
      "BA_SCOPE_RESOLVER_DEPS_REQUIRED: createBaScopeResolver needs the company assurance port — an optional proof dependency is exactly the bypass interfaces §5 forbids",
    );
  }
  const authority = options.authority;
  const assurance = options.assurance;

  /**
   * The ba-branch issuance: prove the facts and the proof inside the
   * directory transaction, then stamp the durable clock versions.
   */
  const mintBaScope = async (
    identity: AuthenticatedRequestIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope> => {
    const facts = await database.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select set_config('app.user_id', ${identity.actorId}, true), set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
      );
      // The branch decision is read in THIS transaction, first.
      const state = await authority.read(tx);
      if (state.directoryAuthority !== "ba") {
        // legacy/paused: the original issuance on the legacy facts.
        return {
          legacy: true as const,
          scope: await resolveLegacyScopeInTx(
            tx,
            identity,
            tenantId,
            workspaceId,
          ),
        };
      }
      const membership = await readBaMembershipFacts(
        tx,
        identity.actorId,
        tenantId,
        workspaceId,
      );
      // The additional company proof, asked inside this transaction.
      await assurance.require(tx, identityActor(identity), tenantId);
      return { legacy: false as const, membership };
    });
    if ("scope" in facts && facts.legacy) {
      return facts.scope;
    }
    const clocks = await readBaClocks(
      options.data,
      tenantId,
      facts.membership.principalId,
    );
    const { company, team } = requireUsableClocks(clocks, workspaceId);
    const scope = Object.freeze({
      tenantId,
      workspaceId,
      principalId: facts.membership.principalId,
      actorId: identity.actorId,
      memberEpoch: company.epoch,
      aclEpoch: 1,
      entrypoint: identity.entrypoint,
      identityGeneration: facts.membership.identityGeneration,
      companyGeneration: company.generation,
      workspaceMemberEpoch: team.epoch,
      teamGeneration: team.generation,
    } satisfies PlatformScope);
    issuedScopes.add(scope);
    return scope;
  };

  return {
    async resolve(request) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      const tenantId = options.selectTenant?.(request);
      const workspaceId = options.selectWorkspace?.(request);
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");
      return mintBaScope(identity, tenantId, workspaceId);
    },
    async resolveForThread(request, threadId) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("INVALID_THREAD_ID");
      }
      // The legacy thread match decides WHICH tenant/workspace/thread triad
      // the request belongs to; the authority read then decides what the
      // mint carries, exactly like the selector half above.
      const facts = await resolveThreadFacts(
        database,
        options.data,
        identity,
        threadId,
      );
      const outcome = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true), set_config('app.tenant_id', ${facts.tenantId}, true), set_config('app.workspace_id', ${facts.workspaceId}, true)`,
        );
        const state = await authority.read(tx);
        if (state.directoryAuthority !== "ba") {
          return { legacy: true as const };
        }
        const membership = await readBaMembershipFacts(
          tx,
          identity.actorId,
          facts.tenantId,
          facts.workspaceId,
        );
        await assurance.require(tx, identityActor(identity), facts.tenantId);
        return { legacy: false as const, membership };
      });
      const scope = Object.freeze({
        tenantId: facts.tenantId,
        workspaceId: facts.workspaceId,
        principalId: facts.principalId,
        actorId: identity.actorId,
        memberEpoch: facts.memberEpoch,
        aclEpoch: 1,
        entrypoint: identity.entrypoint,
        ...(outcome.legacy
          ? {}
          : await baThreadVersions(
              options.data,
              outcome.membership,
              facts.tenantId,
              facts.workspaceId,
            )),
      } satisfies PlatformScope);
      issuedScopes.add(scope);
      return scope;
    },
  };
}

/** The ba thread mint's version fields, read from the durable clocks. */
async function baThreadVersions(
  data: Database,
  membership: BaMembershipFacts,
  tenantId: string,
  workspaceId: string,
): Promise<{
  identityGeneration: number;
  companyGeneration: number;
  workspaceMemberEpoch: number;
  teamGeneration: number;
}> {
  const clocks = await readBaClocks(data, tenantId, membership.principalId);
  const { company, team } = requireUsableClocks(clocks, workspaceId);
  return {
    identityGeneration: membership.identityGeneration,
    companyGeneration: company.generation,
    workspaceMemberEpoch: team.epoch,
    teamGeneration: team.generation,
  };
}

export function createScopeResolver(
  database: DirectoryDatabase,
  options: ScopeResolverOptions,
): ScopeResolver {
  assertDirectoryDatabase(database);
  return {
    async resolve(request) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      const tenantId = options.selectTenant?.(request);
      const workspaceId = options.selectWorkspace?.(request);
      // MT005 (issue #48): selectors are required and explicitly rejected when
      // missing — never defaulted to a first team or a default company, and
      // the two failure modes get distinct codes (was: TENANT_REQUIRED for
      // both, the dual meaning the seam report flags).
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      if (!workspaceId?.trim()) throw new Error("WORKSPACE_REQUIRED");

      const scope = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true), set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true)`,
        );
        return resolveLegacyScopeInTx(tx, identity, tenantId, workspaceId);
      });
      issuedScopes.add(scope);
      return scope;
    },
    async resolveForThread(request, threadId) {
      const identity = requireAuthenticatedIdentity(
        await options.authenticate(request),
      );
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("INVALID_THREAD_ID");
      }
      const data = options.data;
      if (!data) throw new Error("DATA_DATABASE_UNAVAILABLE");
      try {
        assertDataDatabase(data);
      } catch {
        throw new Error("DATA_DATABASE_UNAVAILABLE");
      }

      return resolveThreadFacts(database, data, identity, threadId).then(
        async (facts) => {
          const scope = Object.freeze({
            tenantId: facts.tenantId,
            workspaceId: facts.workspaceId,
            principalId: facts.principalId,
            actorId: identity.actorId,
            memberEpoch: facts.memberEpoch,
            aclEpoch: 1,
            entrypoint: identity.entrypoint,
          } satisfies PlatformScope);
          issuedScopes.add(scope);
          return scope;
        },
      );
    },
  };
}

/** The matched thread triad `resolveForThread` mints a scope for. */
interface ThreadFacts {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly memberEpoch: number;
}

/**
 * The legacy thread resolution (MT005), extracted so the legacy resolver and
 * the BA resolver (T03.01) share one match: the candidate memberships, the
 * capped per-request data-transaction fan-out over conversations and legacy
 * channel mappings, and the unique-match rule. The caller mints the scope.
 */
async function resolveThreadFacts(
  database: Database,
  data: Database,
  identity: AuthenticatedRequestIdentity,
  threadId: string,
): Promise<ThreadFacts> {
  const candidates = await mapStorageFaults(() =>
    database.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level read committed`);
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select set_config('app.user_id', ${identity.actorId}, true)`,
      );
      return tx
        .select({
          tenantId: enterpriseMemberships.tenantId,
          principalId: enterpriseMemberships.principalId,
          memberEpoch: enterpriseMemberships.epoch,
        })
        .from(enterpriseMemberships)
        .innerJoin(
          enterprisePrincipals,
          eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
        )
        .innerJoin(
          enterpriseTenants,
          eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
        )
        .where(
          and(
            eq(enterprisePrincipals.userId, identity.actorId),
            eq(enterprisePrincipals.status, "active"),
            eq(enterpriseMemberships.status, "active"),
            eq(enterpriseTenants.status, "active"),
          ),
        );
    }),
  );

  const matches: Array<{
    tenantId: string;
    workspaceId: string;
    principalId: string;
    candidate: (typeof candidates)[number];
  }> = [];
  // Per-request data-transaction fan-out is capped: a member of many
  // tenants must not hold one pool connection per tenant concurrently
  // (OCR R10 performance).
  const CANDIDATE_BATCH = 4;
  for (
    let batchStart = 0;
    batchStart < candidates.length;
    batchStart += CANDIDATE_BATCH
  ) {
    await Promise.all(
      candidates
        .slice(batchStart, batchStart + CANDIDATE_BATCH)
        .map(async (candidate) => {
          const found = await mapStorageFaults(() =>
            data.transaction(async (tx) => {
              await tx.execute(
                sql`set transaction isolation level read committed`,
              );
              await tx.execute(sql`set local lock_timeout = '2s'`);
              await tx.execute(sql`set local statement_timeout = '5s'`);
              await tx.execute(
                sql`select set_config('app.tenant_id', ${candidate.tenantId}, true), set_config('app.principal_id', ${candidate.principalId}, true), set_config('app.user_id', ${identity.actorId}, true)`,
              );
              const conversations = await tx
                .select({
                  tenantId: enterpriseConversations.tenantId,
                  workspaceId: enterpriseConversations.workspaceId,
                  principalId: enterpriseConversations.principalId,
                  tenantStatus: enterpriseTenants.status,
                })
                .from(enterpriseConversations)
                .innerJoin(
                  enterpriseTenants,
                  eq(enterpriseTenants.id, enterpriseConversations.tenantId),
                )
                .innerJoin(
                  enterpriseMemberships,
                  and(
                    eq(
                      enterpriseMemberships.tenantId,
                      enterpriseConversations.tenantId,
                    ),
                    eq(
                      enterpriseMemberships.principalId,
                      enterpriseConversations.principalId,
                    ),
                  ),
                )
                .innerJoin(
                  enterprisePrincipals,
                  eq(
                    enterprisePrincipals.id,
                    enterpriseMemberships.principalId,
                  ),
                )
                .innerJoin(
                  enterpriseWorkspaces,
                  and(
                    eq(
                      enterpriseWorkspaces.tenantId,
                      enterpriseConversations.tenantId,
                    ),
                    eq(
                      enterpriseWorkspaces.id,
                      enterpriseConversations.workspaceId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(enterpriseConversations.threadId, threadId),
                    eq(enterpriseTenants.status, "active"),
                    eq(enterpriseMemberships.status, "active"),
                    eq(enterpriseMemberships.epoch, candidate.memberEpoch),
                    eq(enterprisePrincipals.status, "active"),
                    eq(enterprisePrincipals.userId, identity.actorId),
                    eq(
                      enterpriseMemberships.principalId,
                      candidate.principalId,
                    ),
                  ),
                )
                .limit(2);
              const legacy = await tx
                .select({
                  actorId: intelligenceChannelMappings.userId,
                  threadId: intelligenceChannelMappings.threadId,
                  channelId: intelligenceChannelMappings.channelId,
                  memberId: channelMemberships.userId,
                  channelDeletedAt: channels.deletedAt,
                  tenantId: enterpriseResources.tenantId,
                  workspaceId: enterpriseResources.workspaceId,
                  principalId: enterpriseMemberships.principalId,
                  tenantStatus: enterpriseTenants.status,
                  principalStatus: enterprisePrincipals.status,
                  membershipStatus: enterpriseMemberships.status,
                  memberEpoch: enterpriseMemberships.epoch,
                  resourceKind: enterpriseResources.kind,
                  resourceStatus: enterpriseResources.status,
                  grantPrincipalId: enterpriseResourceGrants.principalId,
                  grantAction: enterpriseResourceGrants.action,
                })
                .from(intelligenceChannelMappings)
                .innerJoin(
                  channels,
                  and(
                    eq(channels.id, intelligenceChannelMappings.channelId),
                    sql`${channels.deletedAt} is null`,
                  ),
                )
                .innerJoin(
                  channelMemberships,
                  and(
                    eq(channelMemberships.channelId, channels.id),
                    eq(channelMemberships.userId, identity.actorId),
                  ),
                )
                .innerJoin(
                  enterpriseResources,
                  and(
                    eq(enterpriseResources.tenantId, candidate.tenantId),
                    eq(
                      enterpriseResources.id,
                      intelligenceChannelMappings.channelId,
                    ),
                    eq(enterpriseResources.kind, "channel"),
                    eq(enterpriseResources.status, "active"),
                  ),
                )
                .innerJoin(
                  enterpriseResourceGrants,
                  and(
                    eq(
                      enterpriseResourceGrants.tenantId,
                      enterpriseResources.tenantId,
                    ),
                    eq(
                      enterpriseResourceGrants.resourceId,
                      enterpriseResources.id,
                    ),
                    eq(
                      enterpriseResourceGrants.principalId,
                      candidate.principalId,
                    ),
                    eq(enterpriseResourceGrants.action, "read"),
                  ),
                )
                .innerJoin(
                  enterpriseMemberships,
                  and(
                    eq(enterpriseMemberships.tenantId, candidate.tenantId),
                    eq(
                      enterpriseMemberships.principalId,
                      candidate.principalId,
                    ),
                  ),
                )
                .innerJoin(
                  enterprisePrincipals,
                  eq(
                    enterprisePrincipals.id,
                    enterpriseMemberships.principalId,
                  ),
                )
                .innerJoin(
                  enterpriseTenants,
                  eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
                )
                .innerJoin(
                  enterpriseWorkspaces,
                  and(
                    eq(
                      enterpriseWorkspaces.tenantId,
                      enterpriseResources.tenantId,
                    ),
                    eq(
                      enterpriseWorkspaces.id,
                      enterpriseResources.workspaceId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(intelligenceChannelMappings.userId, identity.actorId),
                    eq(intelligenceChannelMappings.threadId, threadId),
                    eq(enterprisePrincipals.userId, identity.actorId),
                    eq(enterprisePrincipals.status, "active"),
                    eq(enterpriseMemberships.status, "active"),
                    eq(enterpriseMemberships.epoch, candidate.memberEpoch),
                    eq(enterpriseTenants.status, "active"),
                  ),
                )
                .limit(2);
              return { conversations, legacy };
            }),
          );
          matches.push(
            ...found.conversations
              .filter((match) => match.tenantStatus === "active")
              .map((match) => ({ ...match, candidate })),
          );
          matches.push(
            ...found.legacy
              .filter(
                (match) =>
                  match.actorId === identity.actorId &&
                  match.threadId === threadId &&
                  match.memberId === identity.actorId &&
                  match.channelDeletedAt === null &&
                  match.tenantId === candidate.tenantId &&
                  match.principalId === candidate.principalId &&
                  match.tenantStatus === "active" &&
                  match.principalStatus === "active" &&
                  match.membershipStatus === "active" &&
                  match.memberEpoch === candidate.memberEpoch &&
                  match.resourceKind === "channel" &&
                  match.resourceStatus === "active" &&
                  match.grantPrincipalId === candidate.principalId &&
                  match.grantAction === "read",
              )
              .map((match) => ({ ...match, candidate })),
          );
        }),
    );
  }

  const matched = uniqueThreadMatch(matches);
  return {
    tenantId: matched.tenantId,
    workspaceId: matched.workspaceId,
    principalId: matched.principalId,
    memberEpoch: matched.candidate.memberEpoch,
  };
}

/**
 * The legacy membership issuance (MT005), extracted so the legacy resolver and
 * the BA resolver's legacy/paused branches (T03.01) share one code path: the
 * same fact rows, the same refusal codes, the same mint. The caller owns the
 * transaction settings.
 */
async function resolveLegacyScopeInTx(
  tx: Parameters<Parameters<DirectoryDatabase["transaction"]>[0]>[0],
  identity: AuthenticatedRequestIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> {
  const [member] = await tx
    .select({
      principalId: enterprisePrincipals.id,
      tenantId: enterpriseTenants.id,
      tenantStatus: enterpriseTenants.status,
      principalStatus: enterprisePrincipals.status,
      memberStatus: enterpriseMemberships.status,
      memberEpoch: enterpriseMemberships.epoch,
    })
    .from(enterpriseMemberships)
    .innerJoin(
      enterprisePrincipals,
      eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
    )
    .innerJoin(
      enterpriseTenants,
      eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
    )
    .where(
      and(
        eq(enterprisePrincipals.userId, identity.actorId),
        eq(enterpriseMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (
    member?.tenantStatus !== "active" ||
    member.principalStatus !== "active" ||
    member.memberStatus !== "active"
  ) {
    throw new Error("TENANT_FORBIDDEN");
  }
  // MT005 (issue #48): team eligibility. The selected workspace must
  // carry an active workspace-membership row for this principal — the
  // server-side fact, not the header value, decides (acceptance 3/4/5).
  // A missing row, a suspended row, and a nonexistent workspace are
  // deliberately indistinguishable here: no existence leak.
  const [teamMembership] = await tx
    .select({ status: enterpriseWorkspaceMemberships.status })
    .from(enterpriseWorkspaceMemberships)
    .where(
      and(
        eq(enterpriseWorkspaceMemberships.tenantId, tenantId),
        eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
        eq(enterpriseWorkspaceMemberships.principalId, member.principalId),
      ),
    )
    .limit(1);
  if (teamMembership?.status !== "active") {
    throw new Error("WORKSPACE_FORBIDDEN");
  }
  const scope = Object.freeze({
    tenantId,
    workspaceId,
    principalId: member.principalId,
    actorId: identity.actorId,
    memberEpoch: member.memberEpoch,
    aclEpoch: 1,
    entrypoint: identity.entrypoint,
  } satisfies PlatformScope);
  issuedScopes.add(scope);
  return scope;
}

export function uniqueThreadMatch<T>(rows: readonly T[]): T {
  if (rows.length === 0) throw new Error("THREAD_SCOPE_NOT_FOUND");
  if (rows.length !== 1) throw new Error("THREAD_SCOPE_AMBIGUOUS");
  return rows[0] as T;
}

export function createResourceReader(database: DataDatabase): ResourceReader {
  assertDataDatabase(database);
  const authz = createAuthz();
  return {
    async readAuthorizedResource(scope, resourceId): Promise<ResourceView> {
      assertTrustedScope(scope);
      return database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        for (const key of readLockKeys(scope, resourceId)) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        /* Transaction-local settings are defense in depth for RLS and are cleared on commit. */
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );
        const [membership] = await tx
          .select({
            epoch: enterpriseMemberships.epoch,
            role: enterpriseMemberships.role,
            memberStatus: enterpriseMemberships.status,
            principalStatus: enterprisePrincipals.status,
            tenantStatus: enterpriseTenants.status,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(
            and(
              eq(enterpriseMemberships.tenantId, scope.tenantId),
              eq(enterpriseMemberships.principalId, scope.principalId),
              eq(enterprisePrincipals.userId, scope.actorId),
            ),
          )
          .limit(1);
        if (
          membership?.memberStatus !== "active" ||
          membership.principalStatus !== "active" ||
          membership.tenantStatus !== "active" ||
          membership.epoch !== scope.memberEpoch
        ) {
          throw new Error("SCOPE_REVOKED");
        }
        const [row] = await tx
          .select({
            id: enterpriseResources.id,
            tenantId: enterpriseResources.tenantId,
            workspaceId: enterpriseResources.workspaceId,
            kind: enterpriseResources.kind,
            displayName: enterpriseResources.displayName,
            revision: enterpriseResources.revision,
            aclEpoch: enterpriseResources.aclEpoch,
            status: enterpriseResources.status,
            policyRevision: enterpriseTenants.policyRevision,
            granted: enterpriseResourceGrants.principalId,
          })
          .from(enterpriseResources)
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseResources.tenantId),
          )
          .leftJoin(
            enterpriseResourceGrants,
            and(
              eq(
                enterpriseResourceGrants.tenantId,
                enterpriseResources.tenantId,
              ),
              eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
              eq(enterpriseResourceGrants.principalId, scope.principalId),
              eq(enterpriseResourceGrants.action, "read"),
            ),
          )
          .where(
            and(
              eq(enterpriseResources.tenantId, scope.tenantId),
              eq(enterpriseResources.workspaceId, scope.workspaceId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
        if (row?.status !== "active" || !row.granted) {
          throw new Error("RESOURCE_NOT_FOUND");
        }
        const allowed = await authz.check({
          scope,
          action: "read",
          resource: {
            id: row.id,
            tenantId: row.tenantId,
            workspaceId: row.workspaceId,
            principalId: scope.principalId,
            revision: row.revision,
            aclEpoch: row.aclEpoch,
            policyRevision: row.policyRevision,
            active: row.status === "active",
            locallyAllowed: Boolean(row.granted),
          },
        });
        if (!allowed) throw new Error("RESOURCE_NOT_FOUND");
        return {
          resourceId: row.id,
          resourceType: row.kind,
          revision: row.revision,
          displayName: row.displayName,
        };
      });
    },
  };
}

function readLockKeys(scope: PlatformScope, resourceId: string): string[] {
  const key = (kind: string, ...ids: string[]) =>
    JSON.stringify(["enterprise", kind, ...ids]);
  return [
    key("tenant", scope.tenantId),
    key("principal", scope.principalId),
    key("membership", scope.tenantId, scope.principalId),
    key("resource", scope.tenantId, resourceId),
  ];
}
