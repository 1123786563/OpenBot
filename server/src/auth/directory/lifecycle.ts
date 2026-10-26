/*
 * Company lifecycle (T03.03 / #540, original task P06; interfaces §2, plan
 * Task 6). This slice owns the PROVISION half: the private `company.provision`
 * directory command the platform entry drives, and the post-commit state
 * machine that keeps a freshly provisioned company closed (`provisioning`)
 * until its idempotent external billing initialization is confirmed ready —
 * only then does the company flip `active`, and nothing in between ever opens
 * business traffic or hands out half benefits (plan Task 6 Step 3, the
 * `provisioning` status T02.02 reserved for exactly this consumer).
 *
 * What each export is:
 *
 * - `normalizeCompanySlug` — the ONE interfaces §2 normalization (trim,
 *   lowercase, fold runs of non-[a-z0-9] into a single hyphen, strip edges).
 *   check-slug and every later slug change reuse this function, so the rules
 *   cannot drift between surfaces.
 * - `preAllocateProvisionTenantId` / `…WorkspaceId` / `…TeamId` — the
 *   server-side idempotent pre-allocation interfaces §2 demands ("开通命令的
 *   tenantId 由服务器幂等预分配"): the tenant id is derived from the request's
 *   idempotency key, so a retry after any failure converges on the SAME
 *   company, and the executor's tenant+key receipt domain replays instead of
 *   creating a second tenant. The workspace/team ids derive from the tenant
 *   id the same way, so the default team's stable ids are reconstructible on
 *   replay without a read.
 * - `createProvisionTransactionBound` — the TransactionBoundBa envelope
 *   provision runs inside. Provision owns no BA sync (the organization is
 *   built by the private command under the T02.06 DML guard, interfaces
 *   §3.2's X ruling on /organization/create), so the bound carries no
 *   adapter: an auth.api call attempted inside provision fails closed with a
 *   named refusal instead of quietly leaving the executor's transaction.
 * - `createCompanyProvisionHandler` — the DirectoryCommandHandler the
 *   executor registers for `company.provision`. `authorize` re-verifies the
 *   platform actor's CURRENT global admin role in the locked transaction on
 *   every call, replay included; `sync` performs the atomic local half:
 *   PrincipalRegistry.ensure for the SPECIFIED owner (never a first user),
 *   the tenant row in `provisioning`, the organization under the §2 slug,
 *   the default team with its workspace and stable binding, the owner member
 *   and team-member rows (whose guard-registered change keys the finalizer
 *   projects and clocks), and exactly one idempotent billing-initialization
 *   intent on the command outbox — the external Customer is NEVER created in
 *   this transaction (plan Task 6 Step 3: "本地记录同事务，外部 Customer/供应商
 *   通过幂等 outbox").
 * - `activateProvisionedCompany` — the only `provisioning → active`
 *   transition: it refuses unless the billing initializer actually produced
 *   the mapping for THIS tenant (restored through the payer-binding layer's
 *   authoritative mapping row, never a key's shape), the outbox intent
 *   exists, and the tenant is still `provisioning`; the flip, the intent's
 *   delivery stamp and the audit fact share one transaction under the
 *   executor's tenant lock.
 *
 * The suspend/restore/deletion halves of P06 belong to T03.04 and are
 * deliberately absent here.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PayerAccount } from "../../billing/payer";
import {
  assertSamePayer,
  type PayerBinding,
  PayerBindingConflictError,
  restorePayerBinding,
} from "../../billing/payer-binding";
import type { Database } from "../../db/client";
import {
  authCommandOutbox,
  authMembers,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
} from "../../db/schema/auth-directory";
import { enterpriseAuditEvents } from "../../db/schema/enterprise-audit";
import {
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import type {
  BaTxOutcome,
  Directory,
  DirectoryTx,
  TransactionBoundBa,
} from "./contracts";
import type {
  DirectoryAuthorizeContext,
  DirectoryCommandHandler,
  DirectorySyncContext,
} from "./executor";

export const COMPANY_PROVISION_UNIMPLEMENTED =
  "COMPANY_PROVISION_UNIMPLEMENTED";
export const COMPANY_SLUG_INVALID = "COMPANY_SLUG_INVALID";
export const COMPANY_PROVISION_TENANT_MISSING =
  "COMPANY_PROVISION_TENANT_MISSING";
export const COMPANY_PROVISION_SLUG_TAKEN = "COMPANY_PROVISION_SLUG_TAKEN";
export const COMPANY_PROVISION_PAYER_MISMATCH =
  "COMPANY_PROVISION_PAYER_MISMATCH";
export const COMPANY_PROVISION_BILLING_INTENT_MISSING =
  "COMPANY_PROVISION_BILLING_INTENT_MISSING";
export const COMPANY_PROVISION_ACTOR_FORBIDDEN =
  "COMPANY_PROVISION_ACTOR_FORBIDDEN";
export const COMPANY_PROVISION_TENANT_NOT_PROVISIONING =
  "COMPANY_PROVISION_TENANT_NOT_PROVISIONING";

/**
 * A company lifecycle refusal: the command asked for a state change it must
 * not get, and nothing was written. The status is the HTTP projection the
 * platform surface answers with; the code is the stable, auditable reason.
 */
export class CompanyLifecycleRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 403 | 404 | 409 | 500 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CompanyLifecycleRefusal";
  }
}

export function isCompanyLifecycleRefusal(
  error: unknown,
): error is CompanyLifecycleRefusal {
  return error instanceof CompanyLifecycleRefusal;
}

/**
 * The interfaces §2 slug normalization — the one rule every surface shares:
 * trim, lowercase, fold runs of whitespace/illegal characters into a single
 * hyphen, strip leading/trailing hyphens. An empty result is returned as
 * `""`: the M2 backfill's `tenant-<digest>` fallback is the backfill's own
 * derivation (from a display name); the provision path receives an explicit
 * slug and refuses one that normalizes to nothing.
 */
export function normalizeCompanySlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The derivation domain separator: stable, unprintable, never user-supplied. */
const PROVISION_ID_SEPARATOR = "\u001f";

function digestOf(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join(PROVISION_ID_SEPARATOR))
    .digest("hex")
    .slice(0, 24);
}

/** The idempotently pre-allocated tenant id of one provision request. */
export function preAllocateProvisionTenantId(idempotencyKey: string): string {
  return `c${digestOf("company.provision.tenant", idempotencyKey)}`;
}

/** The default team's stable workspace id, derived from its tenant's id. */
export function preAllocateProvisionWorkspaceId(tenantId: string): string {
  return `w${digestOf("company.provision.workspace", tenantId)}`;
}

/** The default team's BA team id, derived from its tenant's id. */
export function preAllocateProvisionTeamId(tenantId: string): string {
  return `bt${digestOf("company.provision.team", tenantId)}`;
}

/** The lifecycle's one outbox intent kind (a closed value this module owns). */
export const PROVISION_BILLING_OUTBOX_KIND = "company.billing.initialize";

/**
 * The stable event key of one company's billing-initialization intent: the
 * outbox row's id, so the intent is one row per company no matter how many
 * commands or retries reference it — a second registration under a new
 * command is the primary key's named refusal, never a second row.
 */
export function provisionBillingOutboxId(tenantId: string): string {
  return `${PROVISION_BILLING_OUTBOX_KIND}:${tenantId}`;
}

/**
 * The TransactionBoundBa envelope provision runs inside. Provision performs
 * no BA adapter call — the organization/team/member rows are written by the
 * private command under the T02.06 DML guard — so there is no adapter to
 * bind. A handler that someday does call auth.api through this bound gets a
 * named refusal at the call, fail-closed, rather than a quiet second
 * connection.
 */
export function createProvisionTransactionBound(): TransactionBoundBa {
  return Object.freeze({
    async run<T>(
      _tx: DirectoryTx,
      operation: () => Promise<T>,
    ): Promise<BaTxOutcome<T>> {
      return { value: await operation(), pendingHooks: [] };
    },
  });
}

/**
 * The `company.provision` DirectoryCommandHandler (interfaces §2's payload
 * table, plan Task 6 Step 3). Registered on the executor by the assembly;
 * the executor owns the tenant lock, the authority gate, the receipt and
 * the finalizer — this handler owns the operation's authorization and its
 * atomic local writes.
 */
export function createCompanyProvisionHandler(): DirectoryCommandHandler {
  return Object.freeze({
    /**
     * The locked authorization, re-run on every replay: a runtime platform
     * actor holding the CURRENT global admin role. A migration actor never
     * reaches here at runtime (offline tooling only), and a session/scim/jit
     * actor is refused by name — company roles never substitute (plan Task 6:
     * 平台动作授权与公司 role 隔离).
     *
     * The authorization half is also where the design's "同事务创建 Tenant
     * 存根" lives (§8.1): the receipt the executor's begin statement writes
     * carries a non-deferrable tenant foreign key, so the provisioning stub
     * — the closed, platform-only status — is created (or, on a replay,
     * verified) in this same transaction BEFORE that statement. A failure
     * anywhere after it rolls the stub back with everything else; nothing
     * outside this command's transaction ever creates the row.
     */
    async authorize(context: DirectoryAuthorizeContext): Promise<void> {
      const actor = context.actor;
      if (actor.kind !== "platform") {
        throw new CompanyLifecycleRefusal(
          COMPANY_PROVISION_ACTOR_FORBIDDEN,
          `a ${actor.kind} actor cannot provision a company; the platform actor is issued only after the server verifies a current session, the admin role and the deployment rules`,
          403,
        );
      }
      const adminRows = rowsOf(
        await context.tx.execute(
          sql`SELECT 1 AS ok FROM user_roles WHERE user_id = ${actor.userId} AND role = 'admin' LIMIT 1`,
        ),
      );
      if (adminRows.length === 0) {
        throw new CompanyLifecycleRefusal(
          COMPANY_PROVISION_ACTOR_FORBIDDEN,
          `actor ${actor.userId} holds no current global admin role; the check ran in this transaction under the tenant lock, and a demoted administrator never borrows a receipt`,
          403,
        );
      }
      const provisionPayload = context.command.payload as {
        readonly name: string;
      };
      const stub = await context.tx
        .insert(enterpriseTenants)
        .values({
          id: context.command.tenantId,
          name: provisionPayload.name,
          status: "provisioning",
        })
        .onConflictDoNothing()
        .returning({ id: enterpriseTenants.id });
      if (stub.length === 0) {
        // The row exists: this is a replay of the command that created it
        // (the tenant id is derived from the idempotency key) or, impossibly
        // through this derivation, a collision. Both are answered by the
        // row's own state — anything but a provision-shaped company is a
        // named refusal, never an overwrite.
        const [existing] = await context.tx
          .select({ status: enterpriseTenants.status })
          .from(enterpriseTenants)
          .where(eq(enterpriseTenants.id, context.command.tenantId))
          .limit(1);
        if (
          !existing ||
          (existing.status !== "provisioning" && existing.status !== "active")
        ) {
          throw new CompanyLifecycleRefusal(
            COMPANY_PROVISION_TENANT_NOT_PROVISIONING,
            `company ${context.command.tenantId} already exists as "${existing?.status ?? "missing"}"; provisioning never reopens or renames a company another lifecycle action owns`,
            409,
          );
        }
      }
    },

    /**
     * The atomic local half (fresh commands only; the executor replays
     * receipts without re-running this; the tenant stub is authorize's,
     * above). The order is load-bearing: the owner's principal is ensured
     * and locked FIRST so the DML guard's change-key registration always
     * finds it; the organization precedes the team rows whose foreign key it
     * anchors, and the workspace precedes the binding's; the member row
     * precedes the team-member row whose orphan fence reads it; and the
     * billing intent is the very last write — everything before it is local,
     * everything after it is external.
     */
    async sync(context: DirectorySyncContext): Promise<{
      workspaceId: string | null;
      resourceId: null;
      grantId: null;
      grantGeneration: null;
    }> {
      const { tx, command, registry } = context;
      const payload = command.payload as {
        readonly name: string;
        readonly slug: string;
        readonly ownerUserId: string;
        readonly defaultTeamName?: string | undefined;
      };
      // 1. The SPECIFIED owner's principal, locked (the activation's
      //    workspace-membership projection reads it back later from the
      //    durable row): an unknown user is the registry's named refusal and
      //    an existing identity is reused as it stands — never the first
      //    user, never a repair.
      await registry.ensure(tx, payload.ownerUserId);
      // 2. The one §2 slug; a provision request names its slug explicitly.
      const slug = normalizeCompanySlug(payload.slug);
      if (slug === "") {
        throw new CompanyLifecycleRefusal(
          COMPANY_SLUG_INVALID,
          "the requested slug normalizes to nothing; interfaces §2's tenant-digest fallback is the M2 backfill's derivation, and a provision request names its slug explicitly",
          400,
        );
      }
      // 3. The directory profile under the §2 slug (the T02.06 guard admits
      //    this INSERT for company.provision alone, id = tenant) — before the
      //    team rows whose organization foreign key it anchors.
      await tx.insert(authOrganizations).values({
        id: command.tenantId,
        name: payload.name,
        slug,
      });
      // 4. The default team's stable ids, derived from the tenant so a retry
      //    or replay reconstructs them without a read.
      let workspaceId: string | null = null;
      let teamId: string | null = null;
      if (payload.defaultTeamName !== undefined) {
        workspaceId = preAllocateProvisionWorkspaceId(command.tenantId);
        teamId = preAllocateProvisionTeamId(command.tenantId);
        await tx.insert(enterpriseWorkspaces).values({
          tenantId: command.tenantId,
          id: workspaceId,
          name: payload.defaultTeamName,
        });
        await tx.insert(authTeams).values({
          id: teamId,
          organizationId: command.tenantId,
          name: payload.defaultTeamName,
        });
      }
      // 5. The immutable team→workspace binding (guard-verified against the
      //    tenant through the team's organization).
      if (workspaceId !== null && teamId !== null) {
        await tx.insert(authTeamBindings).values({
          tenantId: command.tenantId,
          workspaceId,
          teamId,
        });
      }
      // 6. The owner member: the guard registers the company change key the
      //    finalizer projects (owner → tenant_admin) and clocks (1/1).
      await tx.insert(authMembers).values({
        id: randomUUID(),
        organizationId: command.tenantId,
        userId: payload.ownerUserId,
        role: "owner",
      });
      // 7. The owner's default-team membership: the guard registers the team
      //    change key; the counter moves exactly +1; the commit-time orphan
      //    fence reads the member row written at step 7.
      if (workspaceId !== null && teamId !== null) {
        await tx.insert(authTeamMembers).values({
          id: randomUUID(),
          teamId,
          userId: payload.ownerUserId,
        });
        await tx
          .update(authTeams)
          .set({ memberCount: sql`${authTeams.memberCount} + 1` })
          .where(
            and(
              eq(authTeams.id, teamId),
              eq(authTeams.organizationId, command.tenantId),
            ),
          );
      }
      // 8. The idempotent external-initialization intent — the ONLY durable
      //    record of the billing work this command owes. The Customer itself
      //    is never created in this transaction.
      await tx.execute(
        sql`SELECT public.auth_command_append_outbox(${provisionBillingOutboxId(command.tenantId)}, ${context.commandId}, ${PROVISION_BILLING_OUTBOX_KIND}, ${stableIntentPayload(command.tenantId)})`,
      );
      return {
        workspaceId,
        resourceId: null,
        grantId: null,
        grantGeneration: null,
      };
    },
  });
}

/** Drizzle's execute answers rows directly on Bun SQL; both shapes read the same. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/** The intent's sealed-shape payload: stable JSON, no secrets, no request text. */
function stableIntentPayload(tenantId: string): string {
  return JSON.stringify({ payerKind: "company", tenantId });
}

/**
 * The one `provisioning → active` transition. The caller hands in the payer
 * binding the platform provision fixed to this company and the mapping the
 * billing initializer produced; activation restores the binding from that
 * authoritative mapping row (never from a key's shape), asserts it names
 * exactly this tenant, and only then flips the status, stamps the outbox
 * intent delivered and records the audit fact — all in one transaction
 * under the executor's tenant lock. A company already `active` is an
 * idempotent no-op; a missing tenant or intent, or a mapping that names
 * another subject, is a named refusal that leaves the company exactly as it
 * was (`provisioning`, retryable, nothing opened).
 */
export async function activateProvisionedCompany(
  database: Database,
  input: {
    readonly tenantId: string;
    readonly binding: PayerBinding;
    readonly payerAccount: PayerAccount;
    readonly actorUserId: string;
    readonly commandId: string;
  },
): Promise<{ readonly status: "active" }> {
  const { tenantId, binding, payerAccount, actorUserId, commandId } = input;
  // The payer fact is read from the authoritative mapping row, never from a
  // key's shape, and must name exactly the company this activation serves.
  try {
    const restored = restorePayerBinding(payerAccount);
    assertSamePayer(restored, binding.payer);
  } catch (error) {
    if (error instanceof PayerBindingConflictError) {
      throw new CompanyLifecycleRefusal(
        COMPANY_PROVISION_PAYER_MISMATCH,
        "the billing initializer returned a mapping that does not name this company; activation is refused and the company stays provisioning with nothing opened",
        409,
      );
    }
    throw error;
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    // The executor's own tenant-lock convention: activation serializes with
    // every command on the same company.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"directory-tenant\u001f"} || ${tenantId}, 0))`,
    );
    const [tenant] = await tx
      .select({ status: enterpriseTenants.status })
      .from(enterpriseTenants)
      .where(eq(enterpriseTenants.id, tenantId))
      .limit(1);
    if (!tenant) {
      throw new CompanyLifecycleRefusal(
        COMPANY_PROVISION_TENANT_MISSING,
        `company ${tenantId} does not exist; activation is only the second half of a provision this server started`,
        404,
      );
    }
    if (tenant.status !== "provisioning" && tenant.status !== "active") {
      throw new CompanyLifecycleRefusal(
        COMPANY_PROVISION_TENANT_NOT_PROVISIONING,
        `company ${tenantId} is "${tenant.status}"; activation flips a provisioning company and never reopens one another lifecycle action closed`,
        409,
      );
    }
    const [intent] = await tx
      .select({ id: authCommandOutbox.id, status: authCommandOutbox.status })
      .from(authCommandOutbox)
      .where(eq(authCommandOutbox.id, provisionBillingOutboxId(tenantId)))
      .limit(1);
    if (!intent) {
      throw new CompanyLifecycleRefusal(
        COMPANY_PROVISION_BILLING_INTENT_MISSING,
        `company ${tenantId} has no billing-initialization intent; activation only completes a provision this server started, and the missing row is an inconsistency refused rather than repaired`,
        500,
      );
    }
    // The legacy workspace-membership projection the frozen finalizer does
    // not write (team keys clock only): completed here, where the company
    // membership the finalizer projected satisfies the foreign key. Born
    // active at epoch 1 — the team clock's establishment.
    const [bindingRow] = await tx
      .select({
        workspaceId: authTeamBindings.workspaceId,
      })
      .from(authTeamBindings)
      .where(eq(authTeamBindings.tenantId, tenantId))
      .limit(1);
    if (bindingRow) {
      const [owner] = await tx
        .select({ userId: authMembers.userId })
        .from(authMembers)
        .where(
          and(
            eq(authMembers.organizationId, tenantId),
            eq(authMembers.role, "owner"),
          ),
        )
        .limit(1);
      if (owner) {
        const [principal] = await tx
          .select({ id: enterprisePrincipals.id })
          .from(enterprisePrincipals)
          .where(eq(enterprisePrincipals.userId, owner.userId))
          .limit(1);
        if (principal) {
          await tx
            .insert(enterpriseWorkspaceMemberships)
            .values({
              tenantId,
              workspaceId: bindingRow.workspaceId,
              principalId: principal.id,
              status: "active",
              epoch: 1,
            })
            .onConflictDoNothing();
        }
      }
    }
    // The audit fact records a TRANSITION, never a replay's echo: an
    // already-active company with a delivered intent and its projection in
    // place changes nothing here, so it writes nothing either.
    let transitioned = false;
    if (tenant.status === "provisioning") {
      await tx
        .update(enterpriseTenants)
        .set({ status: "active" })
        .where(
          and(
            eq(enterpriseTenants.id, tenantId),
            eq(enterpriseTenants.status, "provisioning"),
          ),
        );
      transitioned = true;
    }
    if (intent.status !== "delivered") {
      await tx
        .update(authCommandOutbox)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(authCommandOutbox.id, intent.id));
      transitioned = true;
    }
    if (transitioned) {
      const eventId = randomUUID();
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.operation_id', ${eventId}, true)`,
      );
      await tx.insert(enterpriseAuditEvents).values({
        tenantId,
        id: eventId,
        domain: "business",
        eventType: "company.provision.activated",
        actorId: actorUserId,
        targetId: tenantId,
        payload: { commandId, payerKind: binding.payer.kind } as never,
      });
    }
    return { status: "active" as const };
  });
}

// ---------------------------------------------------------------------------
// T03.04 (#541, original task P06; interfaces §2, spec §4.3): the company
// suspend / restore / deletion-request half of the lifecycle. The provision
// half above; this half is the same discipline on a company that already
// exists: one platform-authorized directory command per transition, the
// status flip, the applicable version advance and the audit in ONE
// transaction under the executor's tenant-exclusive lock.
//
// The applicable version advances through the SAME change-key channel member
// commands use (coordinator ruling 2026-10-26, "B-now"): migration 0215
// admits a self-assigning auth_members UPDATE for company.suspend/company.
// restore alone, whose per-row trigger registers each member's company
// change key with spec §4.4's rules — suspend advances the GENERATION (epoch
// unchanged), restore advances the EPOCH (generation unchanged, so a restored
// company is a new admission, never a resurrection of pre-suspension
// abilities). The frozen finalizer then advances every member's eligibility
// clock and projects the membership rows through its controlled functions,
// which is what keeps the BA workspace gate's three-way comparison (live row
// == scope == clock) true: old scopes die on the advanced generation, fresh
// scopes mint the advanced versions and work again.
//
// The deletion request is registration only (spec §4.3: 首期禁止裸物理删除
// 有业务资产的目录对象): the command verifies the asset/run/billing/retention
// facts, records them with the platform actor's reason on ONE idempotent
// outbox intent per company, and deletes nothing.
//
// What each export is:
//
// - `createCompanySuspendHandler` / `createCompanyRestoreHandler` /
//   `createCompanyDeletionRequestHandler` — the three DirectoryCommandHandlers
//   (interfaces §2's payload table: `reason` alone). `authorize` re-verifies
//   the platform actor's CURRENT global admin role inside the locked
//   transaction on every call (replay included) and confirms the company
//   exists before the executor writes its non-deferrable tenant-FK receipt;
//   `sync` performs the transition.
// - `createPlatformCompanyLifecycleService` — the orchestrator the platform
//   routes drive: the fail-fast admin pre-check, then the private command
//   through the executor (the authority gate, the tenant lock, the receipt,
//   the finalizer's audit).
// ---------------------------------------------------------------------------

export const COMPANY_LIFECYCLE_UNIMPLEMENTED =
  "COMPANY_LIFECYCLE_UNIMPLEMENTED";
export const COMPANY_LIFECYCLE_INPUT_INVALID =
  "COMPANY_LIFECYCLE_INPUT_INVALID";
export const COMPANY_LIFECYCLE_ADMIN_REQUIRED =
  "COMPANY_LIFECYCLE_ADMIN_REQUIRED";
export const COMPANY_LIFECYCLE_ACTOR_FORBIDDEN =
  "COMPANY_LIFECYCLE_ACTOR_FORBIDDEN";
export const COMPANY_LIFECYCLE_TENANT_MISSING =
  "COMPANY_LIFECYCLE_TENANT_MISSING";
export const COMPANY_SUSPEND_REQUIRES_ACTIVE =
  "COMPANY_SUSPEND_REQUIRES_ACTIVE";
export const COMPANY_RESTORE_REQUIRES_SUSPENDED =
  "COMPANY_RESTORE_REQUIRES_SUSPENDED";
export const COMPANY_DELETION_REQUIRES_OPEN_COMPANY =
  "COMPANY_DELETION_REQUIRES_OPEN_COMPANY";
export const COMPANY_DELETION_REQUEST_EXISTS =
  "COMPANY_DELETION_REQUEST_EXISTS";

/** The lifecycle's one outbox intent kind (a closed value this module owns). */
export const COMPANY_DELETION_REQUEST_OUTBOX_KIND = "company.deletion.request";

/** The stable id of one company's deletion request: one row per company. */
export function companyDeletionRequestOutboxId(tenantId: string): string {
  return `${COMPANY_DELETION_REQUEST_OUTBOX_KIND}:${tenantId}`;
}

/**
 * The locked authorization all three lifecycle commands share, re-run on
 * every replay: a runtime platform actor holding the CURRENT global admin
 * role, and a company that exists. Company roles never substitute (plan
 * Task 6: 平台动作授权与公司 role 隔离), and the existence check runs here so
 * an unknown company is a named 404 BEFORE the executor begins a receipt
 * whose tenant foreign key would otherwise fail as a raw driver error.
 */
async function authorizePlatformLifecycle(
  context: DirectoryAuthorizeContext,
  action: string,
): Promise<void> {
  const actor = context.actor;
  if (actor.kind !== "platform") {
    throw new CompanyLifecycleRefusal(
      COMPANY_LIFECYCLE_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot ${action}; the platform actor is issued only after the server verifies a current session, the admin role and the deployment rules`,
      403,
    );
  }
  const adminRows = rowsOf(
    await context.tx.execute(
      sql`SELECT 1 AS ok FROM user_roles WHERE user_id = ${actor.userId} AND role = 'admin' LIMIT 1`,
    ),
  );
  if (adminRows.length === 0) {
    throw new CompanyLifecycleRefusal(
      COMPANY_LIFECYCLE_ACTOR_FORBIDDEN,
      `actor ${actor.userId} holds no current global admin role; the check ran in this transaction under the tenant lock, and a demoted administrator never borrows a receipt`,
      403,
    );
  }
  const [tenant] = await context.tx
    .select({ id: enterpriseTenants.id })
    .from(enterpriseTenants)
    .where(eq(enterpriseTenants.id, context.command.tenantId))
    .limit(1);
  if (!tenant) {
    throw new CompanyLifecycleRefusal(
      COMPANY_LIFECYCLE_TENANT_MISSING,
      `company ${context.command.tenantId} does not exist; a lifecycle command only ever acts on a company this server provisioned`,
      404,
    );
  }
}

/**
 * The `company.suspend` handler: `active → suspended` only, every member's
 * company generation +1 through the 0215 change-key channel (the finalizer
 * advances clock and projection from the registered keys), and the
 * suspension reason recorded as the BA organization marker the control plane
 * can query — one atomic command.
 */
export function createCompanySuspendHandler(): DirectoryCommandHandler {
  return Object.freeze({
    async authorize(context: DirectoryAuthorizeContext): Promise<void> {
      await authorizePlatformLifecycle(context, "suspend a company");
    },

    async sync(context: DirectorySyncContext): Promise<{
      workspaceId: string | null;
      resourceId: string | null;
      grantId: string | null;
      grantGeneration: null;
    }> {
      const { tx, command } = context;
      const payload = command.payload as { readonly reason: string };
      await tx.execute(
        sql`select set_config('app.tenant_id', ${command.tenantId}, true)`,
      );
      // The guarded flip: only an active company suspends, and the WHERE
      // re-checks it — a concurrent writer that flipped the status under us
      // is answered by the refusal below, never a second suspension.
      const flipped = await tx
        .update(enterpriseTenants)
        .set({ status: "suspended" })
        .where(
          and(
            eq(enterpriseTenants.id, command.tenantId),
            eq(enterpriseTenants.status, "active"),
          ),
        )
        .returning({ id: enterpriseTenants.id });
      if (flipped.length === 0) {
        const [current] = await tx
          .select({ status: enterpriseTenants.status })
          .from(enterpriseTenants)
          .where(eq(enterpriseTenants.id, command.tenantId))
          .limit(1);
        throw new CompanyLifecycleRefusal(
          COMPANY_SUSPEND_REQUIRES_ACTIVE,
          `company ${command.tenantId} is "${current?.status ?? "missing"}"; suspend closes an active company and never re-closes one another lifecycle action owns`,
          409,
        );
      }
      // The applicable version, through the change-key channel: one
      // self-assigning UPDATE over every member row. Migration 0215 admits
      // it for company.suspend alone and its per-row trigger registers each
      // member's company change key (epoch unchanged, generation +1); the
      // finalizer advances the clocks and projects the rows from those keys,
      // so the whole company-level revocation lands as one atomic command.
      await tx
        .update(authMembers)
        .set({ role: sql`${authMembers.role}` })
        .where(eq(authMembers.organizationId, command.tenantId));
      await setOrganizationSuspension(
        tx,
        command.tenantId,
        payload.reason,
        context.commandId,
      );
      return {
        workspaceId: null,
        resourceId: null,
        grantId: null,
        grantGeneration: null,
      };
    },
  });
}

/**
 * The `company.restore` handler: `suspended → active` only, and every
 * member's epoch +1 with the generation kept at its already-advanced value —
 * the restore is a controlled re-admission that never rewinds the versions
 * the suspension invalidated, so an old scope stays dead and only freshly
 * issued ones (reading the live versions) work again.
 */
export function createCompanyRestoreHandler(): DirectoryCommandHandler {
  return Object.freeze({
    async authorize(context: DirectoryAuthorizeContext): Promise<void> {
      await authorizePlatformLifecycle(context, "restore a company");
    },

    async sync(context: DirectorySyncContext): Promise<{
      workspaceId: string | null;
      resourceId: string | null;
      grantId: string | null;
      grantGeneration: null;
    }> {
      const { tx, command } = context;
      await tx.execute(
        sql`select set_config('app.tenant_id', ${command.tenantId}, true)`,
      );
      const flipped = await tx
        .update(enterpriseTenants)
        .set({ status: "active" })
        .where(
          and(
            eq(enterpriseTenants.id, command.tenantId),
            eq(enterpriseTenants.status, "suspended"),
          ),
        )
        .returning({ id: enterpriseTenants.id });
      if (flipped.length === 0) {
        const [current] = await tx
          .select({ status: enterpriseTenants.status })
          .from(enterpriseTenants)
          .where(eq(enterpriseTenants.id, command.tenantId))
          .limit(1);
        throw new CompanyLifecycleRefusal(
          COMPANY_RESTORE_REQUIRES_SUSPENDED,
          `company ${command.tenantId} is "${current?.status ?? "missing"}"; restore reopens a suspended company and never re-opens one that is already open or still provisioning`,
          409,
        );
      }
      // The same change-key vehicle under restore's rule (epoch +1,
      // generation unchanged): the finalizer advances every member's clock
      // epoch and projection, so pre-suspension scopes stay dead on the
      // already-advanced generation while fresh issuance reads the new epoch.
      await tx
        .update(authMembers)
        .set({ role: sql`${authMembers.role}` })
        .where(eq(authMembers.organizationId, command.tenantId));
      await clearOrganizationSuspension(tx, command.tenantId);
      return {
        workspaceId: null,
        resourceId: null,
        grantId: null,
        grantGeneration: null,
      };
    },
  });
}

/** One verification probe: the fact a deletion request must record. */
interface DeletionProbe {
  readonly key: string;
  readonly table: string;
  /** true → counted WHERE tenant_id; false → the billing external-id probe. */
  readonly tenantScoped: boolean;
}

/** The closed probe list (spec §4.3: 资产、Run、费用与保留期). */
const DELETION_PROBES: readonly DeletionProbe[] = Object.freeze([
  { key: "assets", table: "enterprise_resources", tenantScoped: true },
  { key: "runs", table: "enterprise_runs", tenantScoped: true },
  { key: "billing", table: "billing_customers", tenantScoped: false },
  { key: "auditEvents", table: "enterprise_audit_events", tenantScoped: true },
  {
    key: "securityEvents",
    table: "enterprise_security_events",
    tenantScoped: true,
  },
] as const);

/**
 * Reads the deletion-verification facts inside the command's transaction. A
 * table this deployment does not carry is recorded as `null` (absent, never
 * a guessed zero); a count is the live number of rows the later deletion
 * phase would have to answer for. The request registers the facts — it never
 * acts on them.
 */
async function readDeletionVerification(
  tx: DirectoryTx,
  tenantId: string,
): Promise<Record<string, number | null>> {
  const verification: Record<string, number | null> = {};
  for (const probe of DELETION_PROBES) {
    const tableRows = rowsOf(
      await tx.execute(
        sql`SELECT 1 AS present FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${probe.table}`,
      ),
    );
    if (tableRows.length === 0) {
      verification[probe.key] = null;
      continue;
    }
    if (probe.tenantScoped) {
      const columnRows = rowsOf(
        await tx.execute(
          sql`SELECT 1 AS present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${probe.table} AND column_name = 'tenant_id'`,
        ),
      );
      if (columnRows.length === 0) {
        verification[probe.key] = null;
        continue;
      }
      const counted = rowsOf(
        await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(`public.${probe.table}`)} WHERE tenant_id = ${tenantId}`,
        ),
      );
      verification[probe.key] = Number(counted[0]?.n ?? 0);
      continue;
    }
    const counted = rowsOf(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(`public.${probe.table}`)} WHERE external_id = ${`openbot-company-${tenantId}`}`,
      ),
    );
    verification[probe.key] = Number(counted[0]?.n ?? 0);
  }
  return verification;
}

/** The outbox PK's own named refusal: one request row per company. */
function isOutboxUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (String((current as Error).message).includes("auth_command_outbox_pk")) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The `company.deletion.request` handler: verification plus registration,
 * never deletion. The request is ONE idempotent outbox intent per company —
 * the asset/run/billing/retention counts and the platform actor's reason
 * sealed on the row — and every directory fact stays exactly as it was.
 */
export function createCompanyDeletionRequestHandler(): DirectoryCommandHandler {
  return Object.freeze({
    async authorize(context: DirectoryAuthorizeContext): Promise<void> {
      await authorizePlatformLifecycle(
        context,
        "request the deletion of a company",
      );
    },

    async sync(context: DirectorySyncContext): Promise<{
      workspaceId: string | null;
      resourceId: string | null;
      grantId: string | null;
      grantGeneration: null;
    }> {
      const { tx, command } = context;
      const payload = command.payload as { readonly reason: string };
      await tx.execute(
        sql`select set_config('app.tenant_id', ${command.tenantId}, true)`,
      );
      const [tenant] = await tx
        .select({ status: enterpriseTenants.status })
        .from(enterpriseTenants)
        .where(eq(enterpriseTenants.id, command.tenantId))
        .limit(1);
      if (!tenant) {
        throw new CompanyLifecycleRefusal(
          COMPANY_LIFECYCLE_TENANT_MISSING,
          `company ${command.tenantId} does not exist; a deletion request only ever names a company this server provisioned`,
          404,
        );
      }
      if (tenant.status === "provisioning") {
        throw new CompanyLifecycleRefusal(
          COMPANY_DELETION_REQUIRES_OPEN_COMPANY,
          `company ${command.tenantId} is still provisioning; a deletion request is registered for an opened company (active or suspended), never one whose provision is still settling`,
          409,
        );
      }
      const verification = await readDeletionVerification(tx, command.tenantId);
      const intentPayload = JSON.stringify({
        tenantId: command.tenantId,
        reason: payload.reason,
        verification,
      });
      try {
        await tx.execute(
          sql`SELECT public.auth_command_append_outbox(${companyDeletionRequestOutboxId(command.tenantId)}, ${context.commandId}, ${COMPANY_DELETION_REQUEST_OUTBOX_KIND}, ${intentPayload})`,
        );
      } catch (error) {
        if (isOutboxUniqueViolation(error)) {
          throw new CompanyLifecycleRefusal(
            COMPANY_DELETION_REQUEST_EXISTS,
            `company ${command.tenantId} already carries a deletion request; the request is one durable row per company and a new key cannot file a second — the existing request stands until its phase disposes of it`,
            409,
          );
        }
        throw error;
      }
      return {
        workspaceId: null,
        resourceId: null,
        grantId: null,
        grantGeneration: null,
      };
    },
  });
}

/** The organization's metadata document, tolerating absence and noise. */
async function readOrganizationMetadata(
  tx: DirectoryTx,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const [organization] = await tx
    .select({ metadata: authOrganizations.metadata })
    .from(authOrganizations)
    .where(eq(authOrganizations.id, tenantId))
    .limit(1);
  const raw = organization?.metadata;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * The suspension marker on the BA organization (the one auth_organizations
 * write the 0214 guard admits for company.suspend): the platform actor's
 * reason, queryable by the independent control plane spec §4.3 names. A
 * company without a BA organization row updates nothing — the tenant status
 * and the epoch advance above are the closure facts; the marker is their
 * readable companion.
 */
async function setOrganizationSuspension(
  tx: DirectoryTx,
  tenantId: string,
  reason: string,
  commandId: string,
): Promise<void> {
  const current = await readOrganizationMetadata(tx, tenantId);
  const next = {
    ...current,
    suspended: true,
    suspensionReason: reason,
    suspendedByCommand: commandId,
  };
  await tx
    .update(authOrganizations)
    .set({ metadata: JSON.stringify(next) })
    .where(eq(authOrganizations.id, tenantId));
}

/** The restore's counterpart: the marker keys leave with the suspension. */
async function clearOrganizationSuspension(
  tx: DirectoryTx,
  tenantId: string,
): Promise<void> {
  const current = await readOrganizationMetadata(tx, tenantId);
  const {
    suspended: _suspended,
    suspensionReason: _suspensionReason,
    suspendedByCommand: _suspendedByCommand,
    ...rest
  } = current;
  await tx
    .update(authOrganizations)
    .set({
      metadata: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
    })
    .where(eq(authOrganizations.id, tenantId));
}

/** One platform lifecycle request: which company, by whom, why, under which key. */
export interface PlatformCompanyLifecycleInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** What a suspend/restore answers; `replayed` marks the receipt's own replay. */
export interface PlatformCompanyLifecycleOutcome {
  readonly tenantId: string;
  readonly status: "suspended" | "active";
  readonly commandId: string;
  readonly replayed: boolean;
}

/** The asset/run/billing/retention facts a deletion request registers with. */
export interface CompanyDeletionVerification
  extends Readonly<Record<string, number | null>> {}

/** What a deletion request answers: the registered request, never a deletion. */
export interface PlatformCompanyDeletionRequestOutcome {
  readonly tenantId: string;
  readonly requestId: string;
  readonly commandId: string;
  readonly replayed: boolean;
  readonly verification: CompanyDeletionVerification;
}

export interface PlatformCompanyLifecycleService {
  suspend(
    input: PlatformCompanyLifecycleInput,
  ): Promise<PlatformCompanyLifecycleOutcome>;
  restore(
    input: PlatformCompanyLifecycleInput,
  ): Promise<PlatformCompanyLifecycleOutcome>;
  requestDeletion(
    input: PlatformCompanyLifecycleInput,
  ): Promise<PlatformCompanyDeletionRequestOutcome>;
}

export interface PlatformCompanyLifecycleServiceDeps {
  /** The single-writer connection the fail-fast admin pre-check reads on. */
  readonly database: Database;
  readonly directory: Directory;
}

/** The input vocabulary the routes and the pre-check share. */
function assertLifecycleInput(
  input: PlatformCompanyLifecycleInput,
): PlatformCompanyLifecycleInput {
  const reason = input.reason.trim();
  if (
    typeof input.tenantId !== "string" ||
    input.tenantId.trim() === "" ||
    input.tenantId.length > 128 ||
    reason === "" ||
    input.reason.length > 512
  ) {
    throw new CompanyLifecycleRefusal(
      COMPANY_LIFECYCLE_INPUT_INVALID,
      "a lifecycle command names one existing company and one non-empty reason (bounded), and nothing else; the payload contract is interfaces §2's table",
      400,
    );
  }
  return input;
}

/** The fail-fast actor gate the handler re-verifies inside the lock. */
async function readHoldsAdminRole(
  database: Database,
  userId: string,
): Promise<boolean> {
  const rows = await database.execute(
    sql`SELECT 1 AS ok FROM user_roles WHERE user_id = ${userId} AND role = 'admin' LIMIT 1`,
  );
  return rowsOf(rows).length > 0;
}

/** The server-issued platform actor one lifecycle command runs under. */
function lifecycleActor(actorUserId: string) {
  return Object.freeze({
    userId: actorUserId,
    principalId: null,
    sessionId: null,
    kind: "platform" as const,
    bindingId: null,
    provisioning: null,
  });
}

/**
 * The platform lifecycle orchestrator: the fail-fast admin pre-check, then
 * the private directory command through the executor — the authority gate,
 * the tenant-exclusive lock, the receipt the same key replays and the
 * finalizer's audit are the executor's, so every transition is one atomic
 * command that never advances anything twice.
 */
export function createPlatformCompanyLifecycleService(
  deps: PlatformCompanyLifecycleServiceDeps,
): PlatformCompanyLifecycleService {
  if (!deps?.database) {
    throw new Error(
      "PLATFORM_LIFECYCLE_DEPS_REQUIRED: createPlatformCompanyLifecycleService needs the single-writer database the actor pre-check reads on",
    );
  }
  if (typeof deps?.directory?.execute !== "function") {
    throw new Error(
      "PLATFORM_LIFECYCLE_DEPS_REQUIRED: createPlatformCompanyLifecycleService needs the Directory executor; without the command envelope there is no lifecycle transition, and a permissive substitute is the bypass interfaces §3.3 forbids",
    );
  }

  /** The shared half: pre-check → command → outcome. */
  async function runLifecycleCommand(
    input: PlatformCompanyLifecycleInput,
    operation: "company.suspend" | "company.restore",
  ): Promise<PlatformCompanyLifecycleOutcome> {
    const valid = assertLifecycleInput(input);
    if (!(await readHoldsAdminRole(deps.database, valid.actorUserId))) {
      throw new CompanyLifecycleRefusal(
        COMPANY_LIFECYCLE_ADMIN_REQUIRED,
        `actor ${valid.actorUserId} holds no current global admin role; company lifecycle transitions are platform actions and company roles never substitute for them`,
        403,
      );
    }
    const result = await deps.directory.execute(
      lifecycleActor(valid.actorUserId),
      {
        operation,
        tenantId: valid.tenantId,
        idempotencyKey: valid.idempotencyKey,
        payload: { reason: valid.reason },
      },
    );
    return {
      tenantId: valid.tenantId,
      status: operation === "company.suspend" ? "suspended" : "active",
      commandId: result.commandId,
      replayed: result.replayed,
    };
  }

  return Object.freeze({
    async suspend(input: PlatformCompanyLifecycleInput) {
      return runLifecycleCommand(input, "company.suspend");
    },
    async restore(input: PlatformCompanyLifecycleInput) {
      return runLifecycleCommand(input, "company.restore");
    },
    async requestDeletion(input: PlatformCompanyLifecycleInput) {
      const valid = assertLifecycleInput(input);
      if (!(await readHoldsAdminRole(deps.database, valid.actorUserId))) {
        throw new CompanyLifecycleRefusal(
          COMPANY_LIFECYCLE_ADMIN_REQUIRED,
          `actor ${valid.actorUserId} holds no current global admin role; a company deletion request is a platform action and company roles never substitute for it`,
          403,
        );
      }
      const result = await deps.directory.execute(
        lifecycleActor(valid.actorUserId),
        {
          operation: "company.deletion.request",
          tenantId: valid.tenantId,
          idempotencyKey: valid.idempotencyKey,
          payload: { reason: valid.reason },
        },
      );
      // The verification travels on the one durable request row, so a fresh
      // command and a replay answer with the same registered facts.
      const [intent] = await deps.database
        .select({ payload: authCommandOutbox.payload })
        .from(authCommandOutbox)
        .where(
          eq(
            authCommandOutbox.id,
            companyDeletionRequestOutboxId(valid.tenantId),
          ),
        )
        .limit(1);
      let verification: CompanyDeletionVerification = {};
      if (typeof intent?.payload === "string") {
        try {
          const parsed: unknown = JSON.parse(intent.payload);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof (parsed as { verification?: unknown }).verification ===
              "object"
          ) {
            verification = (
              parsed as { verification: Record<string, number | null> }
            ).verification;
          }
        } catch {
          verification = {};
        }
      }
      return {
        tenantId: valid.tenantId,
        requestId: companyDeletionRequestOutboxId(valid.tenantId),
        commandId: result.commandId,
        replayed: result.replayed,
        verification,
      };
    },
  });
}
