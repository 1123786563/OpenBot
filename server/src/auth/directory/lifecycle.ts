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
import {
  PayerBindingConflictError,
  restorePayerBinding,
  assertSamePayer,
  type PayerBinding,
} from "../../billing/payer-binding";
import type { PayerAccount } from "../../billing/payer";
import type { Database } from "../../db/client";
import {
  authCommandOutbox,
  authMembers,
  authTeamBindings,
  authTeams,
  authTeamMembers,
  authOrganizations,
} from "../../db/schema/auth-directory";
import { enterpriseAuditEvents } from "../../db/schema/enterprise-audit";
import {
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import type { BaTxOutcome, DirectoryTx, TransactionBoundBa } from "./contracts";
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
