/**
 * SCIM 2.0 provisioning and deprovisioning, through Better Auth's own `@better-auth/scim` plugin.
 *
 * A directory (Okta, Entra, OneLogin, JumpCloud) is given `<BETTER_AUTH_URL>/api/auth/scim/v2` and
 * a bearer token. From then on:
 *
 * - Creating a user there creates the OpenBot user and provisions them into the connection's fixed
 *   company (`member.provision`, no invitation needed — the PrincipalRegistry establishes the
 *   principal inside the same command transaction). They still sign in through the company's SSO;
 *   SCIM never creates a password or any other way in.
 * - Deactivating the user there suspends only that company's membership (`member.suspend`): another
 *   company's membership, the global identity and the personal account are untouched — the legacy
 *   global deny-list reaction is kept only for deployments without the directory executor.
 * - Deleting the user there removes only the membership this directory provisioned (the provision
 *   receipt is the tie); an invited membership survives.
 * - Group membership there becomes `users.groups` here, which is what per-group capability switches
 *   and per-group network policies read (and what `channels.allowed_groups` was always waiting for).
 *
 * `SCIM_BEARER_TOKEN_NEXT` is accepted alongside the current token for rotation. Off entirely when
 * `SCIM_BEARER_TOKEN` is unset.
 *
 * T05.05 (#561 / P12): when the deployment provides the per-company connections and the directory
 * executor seam, every plugin lifecycle hook translates into an atomic directory command on the
 * plugin's own request transaction (see enterprise/tenancy/scim-directory.ts for the event →
 * command derivation and this file's `createScimProvisioningHandlers` for the in-lock
 * authorization). Without the seam the legacy reactions below keep the pre-T05 behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SCIMOptions } from "@better-auth/scim";
import { and, eq, like, sql } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import { enterpriseControls } from "../admin/controls";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { revokedAccess, userRoles, users } from "../db/schema";
import {
  authCommandChangeKeys,
  authCommandReceipts,
} from "../db/schema/auth-directory";
import {
  createScimDirectoryReaction,
  readScimWideRule,
  scimProvisionKey,
} from "../enterprise/tenancy/scim-directory";
import type {
  Directory,
  DirectoryOperation,
  DirectoryTx,
} from "./directory/contracts";
import {
  type DirectoryCommandHandler,
  DirectoryCommandRefusal,
} from "./directory/executor";
import type { InvitationBaAccess } from "./directory/membership";
import { createMembershipLifecycleHandlers } from "./directory/membership";
import { roleForEmail } from "./roles";

const log = getLogger("server");

export const SCIM_REVOKED_BY_PREFIX = "scim:";

export function scimStatus(env: Record<string, string | undefined>) {
  const configured = Boolean(env.SCIM_BEARER_TOKEN?.trim());
  const base = env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");
  return {
    configured,
    connectionId: env.SCIM_CONNECTION_ID?.trim() || "directory",
    baseUrl: base ? `${base}/api/auth/scim/v2` : null,
    rotating: Boolean(env.SCIM_BEARER_TOKEN_NEXT?.trim()),
  };
}

/** One code-defined SCIM connection: a bearer token set fixed to one company. */
export interface ScimConnectionSpec {
  readonly id: string;
  /** The company every write of this connection provisions into (server-side fact). */
  readonly provisioningDomainId: string;
  readonly credentials: readonly {
    readonly type: "bearer";
    readonly id: string;
    readonly token: string;
  }[];
}

export type ScimDeps = {
  database: Database;
  auditStore?: AuditStore;
  initialAdminEmails: readonly string[];
  /**
   * T05.05: the per-company connections. Each token is fixed to exactly one
   * company by the deployment; the plugin never learns another.
   */
  readonly connections?: readonly ScimConnectionSpec[] | null;
  /**
   * T05.05: the open transaction the fixed build's SCIM write runs in (the
   * seam createScimTransactionCapture installs around the deployment
   * database). Absent keeps the legacy reactions.
   */
  readonly currentTransaction?: (() => DirectoryTx | null) | null;
  /**
   * T05.05: the directory executor bound to that transaction. Absent keeps
   * the legacy reactions and every write refuses through the honest 503.
   */
  readonly directory?:
    | ((tx: DirectoryTx) => Pick<Directory, "execute"> | null)
    | null;
};

async function emailOf(database: Database, userId: string) {
  const [row] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email;
}

/**
 * React to a person becoming inactive or active in the directory — the LEGACY
 * reaction of a deployment without the directory executor (T05.04 前语义).
 *
 * Called inside the plugin's transaction, so nothing here touches the rows that transaction holds
 * (`users`, `sessions`, the SCIM tables): the deny-list is its own table, and everything slower runs
 * after the hook returns. Deny-listing before the transaction commits errs toward refusing; a
 * rolled-back deactivation is undone by the directory's next retry setting them active again.
 */
export async function reconcileDirectoryState(
  deps: ScimDeps,
  state: { userId: string; active: boolean },
): Promise<void> {
  const email = await emailOf(deps.database, state.userId);
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  const by = `${SCIM_REVOKED_BY_PREFIX}directory`;

  if (!state.active) {
    const inserted = await deps.database
      .insert(revokedAccess)
      .values({ email: normalized, revokedBy: by })
      .onConflictDoNothing()
      .returning({ email: revokedAccess.email });
    setTimeout(() => {
      void (async () => {
        await enterpriseControls()?.offboard(state.userId, by);
        if (deps.auditStore && inserted.length > 0) {
          await recordAuditEvent(deps.auditStore, {
            eventType: "person.deprovisioned",
            targetType: "person",
            targetId: state.userId,
            payload: {
              email,
              via: "SCIM",
              note: "Sessions ended, address deny-listed, connector credentials retired, computers stopped.",
            },
          });
        }
      })().catch((error) =>
        log.error(
          {
            type: "scim-offboard-failed",
            error: String(error),
          },
          "scim-offboard-failed",
        ),
      );
    }, 0);
    return;
  }

  // An administrator's removal stands until an administrator lifts it — so the SCIM prefix is
  // judged INSIDE the delete, not in a read a concurrent upsert can outrun: an entry an
  // administrator wrote between the old select and delete would have been deleted anyway.
  // The audit rides the deleted rows, so it never describes a removal that did not happen.
  const lifted = await deps.database
    .delete(revokedAccess)
    .where(
      and(
        eq(revokedAccess.email, normalized),
        like(revokedAccess.revokedBy, `${SCIM_REVOKED_BY_PREFIX}%`),
      ),
    )
    .returning({ email: revokedAccess.email });
  if (lifted.length > 0 && deps.auditStore) {
    await recordAuditEvent(deps.auditStore, {
      eventType: "person.reprovisioned",
      targetType: "person",
      targetId: state.userId,
      payload: { email, via: "SCIM" },
    }).catch((error: unknown) =>
      log.error(
        { err: error, eventType: "person.reprovisioned" },
        "Could not write the reprovision audit row.",
      ),
    );
  }
}

/**
 * The production transaction capture (T05.05): every transaction the fixed
 * build opens on the wrapped database records its open tx in an
 * AsyncLocalStorage, so a SCIM hook running inside that transaction can hand
 * the SAME transaction to the directory executor — one commit, one rollback,
 * no second connection. The proxy delegates everything else to the target
 * unchanged; only `transaction` is observed.
 */
export function createScimTransactionCapture(database: Database): {
  readonly database: Database;
  readonly currentTransaction: () => DirectoryTx | null;
} {
  const storage = new AsyncLocalStorage<DirectoryTx>();
  const captured = new Proxy(database, {
    get(target, property) {
      if (property === "transaction") {
        return (run: (tx: DirectoryTx) => Promise<unknown>) =>
          target.transaction(((tx: DirectoryTx) =>
            storage.run(tx, () => run(tx))) as Parameters<
            Database["transaction"]
          >[0]);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: captured,
    currentTransaction: () => storage.getStore() ?? null,
  };
}

/** The plugin's options, or undefined when SCIM is not configured. */
export function scimOptions(
  deps: ScimDeps,
  env: Record<string, string | undefined> = process.env,
): SCIMOptions | undefined {
  const token = env.SCIM_BEARER_TOKEN?.trim();
  const connections: ScimConnectionSpec[] =
    deps.connections && deps.connections.length > 0
      ? [...deps.connections]
      : token
        ? [
            {
              id: env.SCIM_CONNECTION_ID?.trim() || "directory",
              // SCIM_TENANT_ID pins the env-configured connection to one
              // company; without it the legacy deployments keep the
              // connection-id domain and the legacy reactions.
              provisioningDomainId:
                env.SCIM_TENANT_ID?.trim() ||
                env.SCIM_CONNECTION_ID?.trim() ||
                "directory",
              credentials: [
                {
                  type: "bearer" as const,
                  id: `${env.SCIM_CONNECTION_ID?.trim() || "directory"}-primary`,
                  token,
                },
                ...(env.SCIM_BEARER_TOKEN_NEXT?.trim()
                  ? [
                      {
                        type: "bearer" as const,
                        id: `${env.SCIM_CONNECTION_ID?.trim() || "directory"}-next`,
                        token: env.SCIM_BEARER_TOKEN_NEXT?.trim() ?? "",
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [];
  if (connections.length === 0) return undefined;

  const reaction =
    deps.directory && deps.currentTransaction
      ? createScimDirectoryReaction({
          currentTransaction: deps.currentTransaction,
          executor: deps.directory,
        })
      : null;

  return {
    connections,
    identity: {
      /*
       * Link by the deployment's own verified email anchor: OpenBot's people
       * model is one account per address (roles, the deny list and the People
       * screen are all email-keyed), so a second directory provisioning the
       * same person links to their existing account and never rewrites it
       * (profile "preserve" — the directory's display data lives in its own
       * SCIM rows). A brand-new address creates the account.
       */
      resolveUser: async (input, context) => {
        const email = input.resource.primaryEmail.trim().toLowerCase();
        const existing = (await context.database.findOne({
          model: "user",
          where: [{ field: "email", value: email }],
        })) as { id?: unknown } | null;
        return existing
          ? {
              action: "link" as const,
              userId: String(existing.id),
              profile: "preserve" as const,
            }
          : { action: "create" as const };
      },
      reconcileUser: async (state) => {
        if (!reaction) {
          await reconcileDirectoryState(deps, state);
          return;
        }
        await reaction.reconcileIdentity({
          userId: state.userId,
          active: state.active,
          sources: state.sources.map((source) => ({
            id: source.id,
            connectionId: source.connectionId,
            provisioningDomainId: source.provisioningDomainId,
            active: source.active,
          })),
        });
      },
    },
    /*
     * Groups become `users.groups`. The role projection maps each SCIM Group to its display name as
     * an opaque "role" slug, which is the plugin's supported way to hand group membership to the
     * application; `reconcileUser` then writes the complete set inside the plugin's own transaction,
     * so a removal from a group removes it here too. The OpenBot role (admin/user) is never taken
     * from the directory. The approved-rule team mapping is T05.06's (single-shot team capability).
     */
    projection: {
      roles: {
        // A directory group with no name contributes nothing; without this it landed in
        // `users.groups` as an `undefined`/blank slug that no policy can ever match.
        map: ({ source }) => {
          const name = source.displayName?.trim();
          return name ? [name] : [];
        },
        exists: () => true,
      },
      reconcileUser: async (projected, { database }) => {
        const groups = [
          ...new Set(projected.grants.map((grant) => grant.role)),
        ].sort();
        await database.update({
          model: "user",
          where: [{ field: "id", value: projected.userId }],
          update: { groups },
        });
      },
    },
    compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
  };
}

/**
 * A person SCIM just created: give them their role, and say so — the LEGACY
 * trail (deployments without the directory executor). With the transcription
 * assembled, the member.provision command's own finalizer writes the audit
 * fact in the command transaction, and this legacy row is suppressed.
 */
export async function recordProvisioned(
  deps: ScimDeps,
  user: { id: string; email: string },
): Promise<void> {
  if (deps.directory && deps.currentTransaction) return;
  if (!deps.auditStore) return;
  const [role] = await deps.database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, user.id))
    .limit(1);
  await recordAuditEvent(deps.auditStore, {
    eventType: "person.provisioned",
    targetType: "person",
    targetId: user.id,
    payload: {
      email: user.email,
      via: "SCIM",
      role: role?.role ?? roleForEmail(user.email, deps.initialAdminEmails),
    },
  }).catch((error: unknown) =>
    log.error(
      { err: error, eventType: "person.provisioned" },
      "Could not write the provision audit row.",
    ),
  );
}

// ---------------------------------------------------------------------------
// T05.05：SCIM 事件的目录命令 handler 族
//
// `member.provision`（本文件的实现）+ member.suspend/restore/remove 的 scim
// actor 准入包装（非 scim actor 原样走 P08 的授权与写入半区）。授权在锁内
// 重验：actor 携带的 binding/规则证据必须与当前已批准宽规则行完全一致
// （证据是主张，规则行是事实），恢复只解除本目录自己写入的停用（收据 +
// change-key epoch 对照），删除只作用于本目录供应的成员资格（供应收据即
// 归属事实，邀请建立的成员资格永不被目录删除）。
// ---------------------------------------------------------------------------

export const SCIM_PROVISIONING_ACTOR_FORBIDDEN =
  "SCIM_PROVISIONING_ACTOR_FORBIDDEN";
export const SCIM_PROVISIONING_EVIDENCE_STALE =
  "SCIM_PROVISIONING_EVIDENCE_STALE";
export const SCIM_PROVISIONING_ROLE_NOT_ASSIGNABLE =
  "SCIM_PROVISIONING_ROLE_NOT_ASSIGNABLE";
export const SCIM_PROVISIONING_COMPANY_CLOSED =
  "SCIM_PROVISIONING_COMPANY_CLOSED";
export const SCIM_PROVISION_WORKSPACE_UNBOUND =
  "SCIM_PROVISION_WORKSPACE_UNBOUND";
export const SCIM_REMOVE_WITHOUT_PROVISION_RECEIPT =
  "SCIM_REMOVE_WITHOUT_PROVISION_RECEIPT";
export const SCIM_REPROVISION_NOT_ALLOWED = "SCIM_REPROVISION_NOT_ALLOWED";

/** Drizzle's execute() answer: an array on some drivers, .rows on others. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function scimRefusal(
  code: string,
  detail: string,
  status: 400 | 409 | 503 = 409,
): DirectoryCommandRefusal {
  return new DirectoryCommandRefusal(code, detail, status);
}

/** The in-lock scim-actor authorization shared by the four member commands. */
async function authorizeScimMemberCommand(
  context: Parameters<DirectoryCommandHandler["authorize"]>[0],
  input: {
    readonly requireProvisionTie?: boolean;
    readonly requireOwnSuspensionTie?: boolean;
  } = {},
): Promise<void> {
  const actor = context.actor;
  const { userId } = context.command.payload as { userId?: string };
  const rule = await readScimWideRule(
    context.tx,
    actor.bindingId as string,
    context.command.tenantId,
  );
  const provisioning = actor.provisioning;
  if (!provisioning) {
    throw scimRefusal(
      SCIM_PROVISIONING_ACTOR_FORBIDDEN,
      `a scim/jit actor without its verified provisioning event cannot exercise a member command; the event evidence is the server's mint, never a client field`,
    );
  }
  if (rule.minimumRole !== "member") {
    throw scimRefusal(
      SCIM_PROVISIONING_ROLE_NOT_ASSIGNABLE,
      `connection ${String(actor.bindingId)}'s approved rule carries minimum role "${rule.minimumRole}"; the directory provisions the minimum role member and never a management role`,
    );
  }
  if (
    rule.ruleId !== provisioning.ruleId ||
    rule.revision !== provisioning.ruleRevision
  ) {
    throw scimRefusal(
      SCIM_PROVISIONING_EVIDENCE_STALE,
      `the event's provisioning evidence names rule ${String(provisioning.ruleId)} revision ${String(provisioning.ruleRevision)}, but connection ${String(actor.bindingId)}'s approved rule is ${rule.ruleId} revision ${String(rule.revision)}; a stale or forged event is refused, never replayed against the current rule`,
      409,
    );
  }
  const [tenant] = rowsOf(
    await context.tx.execute(
      sql`SELECT status FROM enterprise_tenants WHERE id = ${context.command.tenantId} LIMIT 1`,
    ),
  );
  if (String(tenant?.status ?? "missing") !== "active") {
    throw scimRefusal(
      SCIM_PROVISIONING_COMPANY_CLOSED,
      `company ${context.command.tenantId} is ${String(tenant?.status ?? "missing")}; a suspended or provisioning company admits no directory reactions`,
    );
  }
  if (input.requireProvisionTie) {
    const [receipt] = await context.tx
      .select({ commandId: authCommandReceipts.commandId })
      .from(authCommandReceipts)
      .where(
        and(
          eq(
            authCommandReceipts.idempotencyKey,
            scimProvisionKey(actor.bindingId as string, String(userId)),
          ),
          eq(authCommandReceipts.operation, "member.provision"),
          eq(authCommandReceipts.tenantId, context.command.tenantId),
        ),
      )
      .limit(1);
    if (!receipt) {
      throw scimRefusal(
        SCIM_REMOVE_WITHOUT_PROVISION_RECEIPT,
        `no member.provision receipt of connection ${String(actor.bindingId)} names user ${String(userId)}; a directory deletes only the membership it provisioned, and an invited membership is never touched`,
        409,
      );
    }
  }
  if (input.requireOwnSuspensionTie) {
    // The current suspension must be exactly the one this directory wrote:
    // its suspend receipt's change-key epoch_after equals the live epoch.
    const [projection] = rowsOf(
      await context.tx.execute(
        sql`SELECT m.status, m.epoch::int AS epoch FROM enterprise_memberships m
             JOIN enterprise_principals p ON p.id = m.principal_id
            WHERE m.tenant_id = ${context.command.tenantId}
              AND p.user_id = ${String(userId)} LIMIT 1`,
      ),
    );
    const epoch = Number(projection?.epoch ?? NaN);
    if (String(projection?.status ?? "missing") !== "suspended") {
      throw scimRefusal(
        SCIM_REPROVISION_NOT_ALLOWED,
        `user ${String(userId)} is not suspended in company ${context.command.tenantId}; reactivation reopens a suspended member and never re-states an active one`,
        409,
      );
    }
    /*
     * The generation is what distinguishes the two suspenders: suspend
     * advances the generation and keeps the epoch, so a later administrator
     * suspension leaves the live generation one past the directory's own
     * receipt. The directory may lift its suspension only while the live
     * clock still matches its receipt's after-versions exactly.
     */
    const [clock] = rowsOf(
      await context.tx.execute(
        sql`SELECT c.generation::int AS generation FROM auth_eligibility_clocks c
             JOIN enterprise_principals p ON p.id = c.principal_id
            WHERE c.tenant_id = ${context.command.tenantId}
              AND p.user_id = ${String(userId)}
              AND c.kind = 'company' AND c.scope_id = ${context.command.tenantId}
            LIMIT 1`,
      ),
    );
    const generation = Number(clock?.generation ?? NaN);
    const own = await context.tx
      .select({ commandId: authCommandChangeKeys.commandId })
      .from(authCommandChangeKeys)
      .innerJoin(
        authCommandReceipts,
        eq(authCommandReceipts.commandId, authCommandChangeKeys.commandId),
      )
      .where(
        and(
          eq(authCommandReceipts.operation, "member.suspend"),
          eq(authCommandReceipts.tenantId, context.command.tenantId),
          sql`${authCommandReceipts.idempotencyKey} like ${`scim:${String(actor.bindingId)}:suspend:${String(userId)}:e%`}`,
          eq(authCommandChangeKeys.kind, "company"),
          eq(authCommandChangeKeys.epochAfter, epoch),
          eq(authCommandChangeKeys.generationAfter, generation),
        ),
      )
      .limit(1);
    if (own.length === 0) {
      throw scimRefusal(
        SCIM_REPROVISION_NOT_ALLOWED,
        `the current suspension of user ${String(userId)} was not written by connection ${String(actor.bindingId)}; the directory lifts only its own suspension and an administrator's newer decision stands`,
        409,
      );
    }
  }
}

/** The scim-actor admission wrapper: non-scim actors keep P08's authorization. */
function scimAdmitted(
  wrapped: DirectoryCommandHandler["authorize"],
  input: {
    readonly requireProvisionTie?: boolean;
    readonly requireOwnSuspensionTie?: boolean;
  },
): DirectoryCommandHandler["authorize"] {
  return async (context) => {
    if (context.actor.kind !== "scim") return wrapped(context);
    await authorizeScimMemberCommand(context, input);
  };
}

export interface ScimProvisioningHandlerDeps {
  /** The pinned membership/team writers over the command transaction. */
  readonly ba: Pick<InvitationBaAccess, "createMember" | "addTeamMember">;
}

/**
 * The T05.05 handler family: `member.provision` (first establishment, no
 * invitation, minimum role member, the approved rule's teams in the same
 * atomic command) plus the scim-actor admission of the P08 lifecycle trio.
 */
export function createScimProvisioningHandlers(
  deps: ScimProvisioningHandlerDeps,
): Partial<Record<DirectoryOperation, DirectoryCommandHandler>> {
  const lifecycle = createMembershipLifecycleHandlers();

  const provisionAuthorize: DirectoryCommandHandler["authorize"] = async (
    context,
  ) => {
    // T05.06: a jit actor carrying the verified issuer+subject/binding event
    // of an approved rule provisions the same way a scim actor does — the
    // minimum member role, the rule's fixed teams, never an invitation.
    if (
      (context.actor.kind !== "scim" && context.actor.kind !== "jit") ||
      !context.actor.provisioning
    ) {
      throw scimRefusal(
        SCIM_PROVISIONING_ACTOR_FORBIDDEN,
        `a ${context.actor.kind} actor cannot provision a member; member.provision is the directory's own command, exercised by a scim or jit actor carrying its fixed binding and verified provisioning event`,
        503,
      );
    }
    await authorizeScimMemberCommand(context);
  };

  const provisionSync: DirectoryCommandHandler["sync"] = async (context) => {
    const userId = String(
      (context.command.payload as { userId?: unknown }).userId ?? "",
    );
    // Idempotent establishment: an existing member's role is never rewritten
    // by the directory (重复不增版/不覆盖角色).
    const [existing] = rowsOf(
      await context.tx.execute(
        sql`SELECT id FROM auth_members
             WHERE organization_id = ${context.command.tenantId}
               AND user_id = ${userId} LIMIT 1`,
      ),
    );
    if (existing) return { resourceId: String(existing.id) };
    const rule = await readScimWideRule(
      context.tx,
      context.actor.bindingId as string,
      context.command.tenantId,
    );
    // The approved rule's fixed workspace targets: the rule's team adds land
    // in this same atomic command (多团队变化同一原子事件).
    const teamIds: string[] = [];
    for (const workspaceId of rule.workspaceIds) {
      const [binding] = rowsOf(
        await context.tx.execute(
          sql`SELECT t.id AS team_id FROM auth_team_bindings b
               JOIN auth_teams t ON t.id = b.team_id
              WHERE b.tenant_id = ${context.command.tenantId}
                AND b.workspace_id = ${workspaceId} LIMIT 1`,
        ),
      );
      if (!binding) {
        throw scimRefusal(
          SCIM_PROVISION_WORKSPACE_UNBOUND,
          `workspace ${workspaceId} of the approved rule has no team binding in company ${context.command.tenantId}; the rule's team grant is refused rather than granted narrower`,
          400,
        );
      }
      teamIds.push(String(binding.team_id));
    }
    const memberId = await deps.ba.createMember({
      tenantId: context.command.tenantId,
      userId,
      role: "member",
    });
    for (const teamId of teamIds) {
      await deps.ba.addTeamMember({ teamId, userId });
    }
    return { resourceId: memberId };
  };

  const lifecycleOf = (
    operation: "member.suspend" | "member.restore" | "member.remove",
  ) => {
    const handler = lifecycle[operation];
    if (!handler) {
      throw new Error(
        `SCIM_PROVISIONING_DEPS_REQUIRED: the membership lifecycle handler for ${operation} is missing; the SCIM admission wraps the P08 pair and refuses to run without it`,
      );
    }
    return handler;
  };
  const suspend = lifecycleOf("member.suspend");
  const restore = lifecycleOf("member.restore");
  const remove = lifecycleOf("member.remove");
  return {
    "member.provision": Object.freeze({
      authorize: provisionAuthorize,
      sync: provisionSync,
    }),
    "member.suspend": Object.freeze({
      authorize: scimAdmitted(suspend.authorize, {}),
      sync: suspend.sync,
    }),
    "member.restore": Object.freeze({
      authorize: scimAdmitted(restore.authorize, {
        requireOwnSuspensionTie: true,
      }),
      sync: restore.sync,
    }),
    "member.remove": Object.freeze({
      authorize: scimAdmitted(remove.authorize, {
        requireProvisionTie: true,
      }),
      sync: remove.sync,
    }),
  };
}
