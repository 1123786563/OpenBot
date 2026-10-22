import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  type AccessGrantSource,
  accessGrants,
  botBindingOffers,
  botServices,
  gatewayVirtualKeys,
} from "../db/schema";
import { bindingCodeHash } from "./binding-codes";
import type { BotServiceStore } from "./store";
import { type BotServiceIdentity, BotServiceInputError } from "./types";

/**
 * Model access grants (Bifrost #238, 04.5): the confirmation flow that turns a one-time binding
 * code into an authorization, and the authorization itself.
 *
 * TWO STEPS, NEVER ONE (AC03). The binding code proves one external identity at one Bot — that is
 * all it proves. The authorization is created only when a signed-in person, shown exactly which
 * Bot and which identity, says yes. So `preview` validates a live code and answers what it would
 * authorize while consuming nothing, and `confirm` — a separate, explicit request — is the only
 * act anywhere that creates a grant. A code that arrives without a session is refused by the
 * guard before either runs, and a body that tries to name a user or an identity is refused at the
 * boundary: the user is always the session's, the identity is always the code's own.
 *
 * IDEMPOTENT BY CONSTRUCTION. Confirmation is keyed on (user, Bot, external identity), and the
 * database's partial unique index — one *active* row per triple — is the truth both the repeated
 * request and the concurrent race land on: a second confirmation returns the grant that already
 * is, and two codes for one authorization confirmed at once converge on one row. A consumed code
 * is spent forever either way; what an expired, replayed, guessed or disabled-Bot code can do is
 * one uniform refusal that says nothing about which of those it was.
 *
 * AND NOTHING ELSE HAPPENS. Creating the grant mints no key, opens no balance and writes no
 * credit grant (ADR 0002's separation): those are 05.3's and the ledger's own acts, taken later,
 * against this row's stable `grantId` — the id key issuance (05.3) and reservation revalidation
 * (06.2) resolve from, and the unit 04.7 revokes on its own.
 */

/** The one scope the confirmation flow creates today; the schema's check is the closed set. */
export const MODEL_ACCESS_SCOPE = "model-access" as const;

/**
 * The built-in workbench bot's well-known service identity (Bifrost #241, 04.8): the Bot OpenBot
 * itself presents as, registered exactly like any other Bot through 04.1's admin surface with
 * `kind: "builtin"`. The constant is what makes "the workbench bot" nameable — the implicit flow
 * resolves it live in the registry on every call, so a deployment that never registered it (or
 * disabled it, or let an external Bot take the identity) has no implicit authorization at all.
 */
export const WORKBENCH_BOT_ID = "openbot-workbench";

/** How a binding-code grant (04.5's flow) is marked; the schema's check is the closed set. */
export const BINDING_CODE_SOURCE =
  "binding-code" as const satisfies AccessGrantSource;

/** How the workbench's implicit grant is marked; distinguishable everywhere a grant is read. */
export const WORKBENCH_IMPLICIT_SOURCE =
  "workbench-implicit" as const satisfies AccessGrantSource;

/**
 * The external identity an implicit grant binds: the login identity itself, in a namespace no
 * Bot-issued binding hint (`slack:…`, `github:…`) can collide with. The OpenBot user id rides
 * inside the value so the partial unique index — one active row per (user, Bot, identity) —
 * stays the one idempotency answer for both kinds of grant, unchanged.
 */
export function workbenchImplicitIdentity(userId: string): string {
  return `openbot:${userId}`;
}

/** The grant as every reader sees it: the contract 04.6–04.8, 05.3 and 06.2 consume. */
export type AccessGrant = {
  /** Stable, opaque, never reused — the id downstream issuance and revalidation reference. */
  grantId: string;
  /** The OpenBot user who confirmed. Always the session's own user, never a body field. */
  userId: string;
  botId: string;
  /** The external identity exactly as the confirmed binding offer named it. */
  externalIdentity: string;
  scope: typeof MODEL_ACCESS_SCOPE;
  /** Which flow created this grant: a confirmed code, or the workbench's login identity. */
  source: AccessGrantSource;
  status: "active" | "revoked";
  createdAt: Date;
  revokedAt: Date | null;
};

/** What a live code would authorize: the whole of what the confirmation page shows. */
export type BindingPreview = {
  bot: { botId: string; displayName: string };
  externalIdentity: string;
  scope: typeof MODEL_ACCESS_SCOPE;
  expiresAt: Date;
};

/**
 * One of the caller's own grants as the list shows it (Bifrost #240, 04.7): the grant plus the
 * Bot's display name, so the page can say which Bot without a second lookup. Only the caller's
 * own rows ever come back — the list's `where` is the session's user id, never a request field.
 */
export type ListedAccessGrant = AccessGrant & { botDisplayName: string };

/**
 * One key version of a grant, as the person's own status page shows it (Bifrost 05.10): the
 * version number, the state this deployment believes, and the term the key was minted under.
 * No secret rides here — the table has no plaintext column to leak, and this shape keeps it
 * that way structurally rather than by filtering.
 */
export type AccessGrantKeyStatus = {
  credentialVersion: number;
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
};

/** A listed grant beside the live key versions its authorization still holds. */
export type ListedAccessGrantWithKeys = ListedAccessGrant & {
  activeKeys: AccessGrantKeyStatus[];
};

/**
 * A binding code that is unknown, expired, already used, or names a Bot that is gone or disabled.
 * One class with one message on purpose: the answer must not reveal which of those it was, so
 * nobody can enumerate live codes or probe a Bot's existence through the confirmation flow —
 * the same silence 04.2's authenticator keeps.
 */
export class AccessGrantCodeError extends Error {
  readonly code = "model_access_invalid_code";
  constructor(message = "That binding code is not valid.") {
    super(message);
    this.name = "AccessGrantCodeError";
  }
}

/**
 * Every way an existing grant fails to be *usable*, said the same way. A grantId nobody issued,
 * an authorization that has been revoked, a grant that belongs to another user, and one that was
 * given to a different Bot all arrive as this one class with this one message — so no caller, and
 * no refusal built on it, can tell a prober whether a grantId exists, whose it is, or what state
 * it is in (04.6: the refusal must not leak anyone else's data). The class is the contract;
 * deliberately no subclasses for the reasons.
 */
export class AccessGrantUseError extends Error {
  readonly code = "model_access_grant_refused";
  constructor(message = "That model access grant cannot be used.") {
    super(message);
    this.name = "AccessGrantUseError";
  }
}

/**
 * The deployment has no usable built-in workbench bot: the well-known identity is unregistered,
 * disabled, or held by a non-builtin registration. One uniform refusal on purpose — the answer
 * must not reveal which of those it was, so the registry's state is not probeable through the
 * implicit flow. The whole flow is unavailable, and nothing is created.
 */
export class WorkbenchGrantUnavailableError extends Error {
  readonly code = "workbench_grant_unavailable";
  constructor(message = "The built-in workbench bot is not available.") {
    super(message);
    this.name = "WorkbenchGrantUnavailableError";
  }
}

/**
 * The person's implicit workbench grant was revoked and they have not re-authorized it. Revocation
 * is sticky (04.8): continuing to use the workbench does not resurrect it — only the explicit
 * `reauthorize` act does, as a new grant beside the dead one, never by overwriting history.
 */
export class WorkbenchGrantRevokedError extends Error {
  readonly code = "workbench_grant_revoked";
  constructor(
    message = "Your workbench model access was revoked. Re-authorize to restore it.",
  ) {
    super(message);
    this.name = "WorkbenchGrantRevokedError";
  }
}

/**
 * The violated constraint's name when `error` is a Postgres unique_violation (SQLSTATE 23505), else
 * null. Bun's driver puts the SQLSTATE in `errno` and the name in `constraint`; drizzle wraps the
 * driver error as `cause`. (Same helper the bot service store uses, kept local so the two modules
 * stay independently readable.)
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (candidate?.errno === "23505")
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  }
  return null;
}

type GrantRow = typeof accessGrants.$inferSelect;

function toGrant(row: GrantRow): AccessGrant {
  return { ...row, scope: MODEL_ACCESS_SCOPE };
}
function requireUserId(userId: string) {
  if (
    typeof userId !== "string" ||
    userId.trim() === "" ||
    userId !== userId.trim()
  )
    throw new BotServiceInputError("The confirming user is not valid.");
}

function requireCode(bindingCode: string): string {
  // The digest of whatever was presented, or the one uniform refusal: an unknown code and a
  // non-string are the same answer to the caller, on purpose.
  if (typeof bindingCode !== "string" || bindingCode.length === 0)
    throw new AccessGrantCodeError();
  return bindingCodeHash(bindingCode);
}

export type AccessGrantServiceDependencies = {
  database: Database;
  /** The registry whose live status verdict finishes the Bot check; read per call, never cached. */
  botServices: Pick<BotServiceStore, "getBotService">;
  auditStore?: AuditStore;
  /**
   * 05.7's remote-key retirement seam: called after a revocation has committed, with the
   * gateway key ids the revocation retired locally, so the gateway disables them too and an
   * old key cannot start new work there. BEST-EFFORT BY CONTRACT: the implementation must be
   * total (resolve no matter what the transport did, failures recorded — the deployment
   * composes {@link import("../gateway/key-revocation").createGrantKeyRevocator}), because a
   * throw past this seam would fail the person's revocation answer after the fact, and the
   * idempotent retry would skip the disable entirely. Absent, the local retirement still
   * stands alone — every admission path refuses from the rows.
   */
  revokeGatewayKeys?: (input: {
    grantId: string;
    gatewayVirtualKeyIds: string[];
  }) => Promise<void>;
};

export type AccessGrantService = ReturnType<typeof createAccessGrantService>;

export function createAccessGrantService(
  dependencies: AccessGrantServiceDependencies,
) {
  const { database } = dependencies;

  return {
    /**
     * The authorization-use check for a Bot (04.6): resolve a grant for use — key issuance
     * (05.3), renewal (05.6), revalidation (06.2) — through one door. `identity` is the
     * authenticator's own answer, never a field a caller typed; `grantId` only locates the row.
     * Unknown, revoked, cross-Bot, unregistered or disabled-Bot uses are one uniform refusal
     * ({@link AccessGrantUseError}), and the live registry read keeps a Bot disabled after the
     * grant was made refused here too — service identity and user authorization must both still
     * hold at the moment of use (Q15).
     */
    async resolveForBot(
      grantId: string,
      identity: BotServiceIdentity,
    ): Promise<AccessGrant> {
      if (typeof grantId !== "string" || grantId.length === 0)
        throw new AccessGrantUseError();
      if (identity.status !== "active") throw new AccessGrantUseError();
      const [row] = await database
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grantId));
      // One guard for everything a probe could distinguish: the row, its state, its Bot. The
      // answer to all of them is the same silence.
      if (row?.status !== "active" || row.botId !== identity.botId)
        throw new AccessGrantUseError();
      const bot = await dependencies.botServices.getBotService(identity.botId);
      if (bot?.status !== "active") throw new AccessGrantUseError();
      return toGrant(row);
    },

    /**
     * The authorization-use check for a signed-in user (04.6): the seam 04.7's list and
     * revocation and 05.10's revoke-all resolve through. `userId` is the session's own actor id,
     * never a body field; a grant that is unknown, revoked, or belongs to someone else is the
     * one uniform refusal — whether this grant exists, and whose it is, is nobody else's
     * information to learn by probing.
     */
    async resolveForUser(
      grantId: string,
      userId: string,
    ): Promise<AccessGrant> {
      if (typeof grantId !== "string" || grantId.length === 0)
        throw new AccessGrantUseError();
      if (
        typeof userId !== "string" ||
        userId.trim() !== userId ||
        userId === ""
      )
        throw new AccessGrantUseError();
      const [row] = await database
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grantId));
      if (!row || row.userId !== userId || row.status !== "active")
        throw new AccessGrantUseError();
      return toGrant(row);
    },

    /**
     * The caller's own authorizations (Bifrost #240, 04.7), newest first, revoked ones included —
     * revocation is a status, not a deletion, and the page shows the state a grant is actually in.
     * The user comes from the session at the route, never from a request field, so the query's
     * `where` is the whole of the visibility rule: another person's grants are not hidden here,
     * they are not in the question.
     */
    async listForUser(userId: string): Promise<ListedAccessGrantWithKeys[]> {
      if (
        typeof userId !== "string" ||
        userId.trim() !== userId ||
        userId === ""
      )
        throw new AccessGrantUseError();
      const rows = await database
        .select({
          grant: accessGrants,
          botDisplayName: botServices.displayName,
        })
        .from(accessGrants)
        .innerJoin(botServices, eq(accessGrants.botId, botServices.botId))
        .where(eq(accessGrants.userId, userId))
        .orderBy(desc(accessGrants.createdAt));
      /*
       * The live key versions beside their grants (05.10): one batched read of the rows the
       * person may still act on — the active versions, newest first. The revoked and expired
       * ones are history, already named by the grant's own status line; a person revoking
       * "every valid version" acts on exactly these rows' grant, and 05.7's revocation
       * retires the versions themselves in its own commit.
       */
      const grantIds = rows.map(({ grant }) => grant.grantId);
      const keyRows =
        grantIds.length === 0
          ? []
          : await database
              .select({
                grantId: gatewayVirtualKeys.grantId,
                credentialVersion: gatewayVirtualKeys.credentialVersion,
                status: gatewayVirtualKeys.status,
                expiresAt: gatewayVirtualKeys.expiresAt,
              })
              .from(gatewayVirtualKeys)
              .where(
                and(
                  inArray(gatewayVirtualKeys.grantId, grantIds),
                  eq(gatewayVirtualKeys.status, "active"),
                ),
              )
              .orderBy(desc(gatewayVirtualKeys.credentialVersion));
      const keysByGrant = new Map<string, AccessGrantKeyStatus[]>();
      for (const row of keyRows) {
        const list = keysByGrant.get(row.grantId) ?? [];
        list.push({
          credentialVersion: row.credentialVersion,
          status: row.status,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        });
        keysByGrant.set(row.grantId, list);
      }
      return rows.map(({ grant, botDisplayName }) => ({
        ...toGrant(grant),
        botDisplayName,
        activeKeys: keysByGrant.get(grant.grantId) ?? [],
      }));
    },

    /**
     * The person's own revocation (Bifrost #240, 04.7): mark it, in one transaction, and let the
     * commit be the moment it takes effect — no cache stands between the answer and the row, so
     * key issuance (05.3), renewal (05.7) and revalidation (06.2) that resolve through
     * {@link resolveForUser} see `revoked` the instant this returns.
     *
     * WHO MAY: the row is located by grantId *and* the session's user id together — a grantId
     * that belongs to someone else, and one nobody issued, are the same {@link AccessGrantUseError},
     * so a prober cannot learn that a grant exists from a refusal that names it.
     *
     * IDEMPOTENT: the flip is a conditional update (`status = 'active'` re-checked inside the
     * transaction, the database's own verdict under concurrency), so exactly one caller's update
     * lands; the second revocation finds the row already revoked and answers it unchanged —
     * `revoked: false`, the same grantId, the same `revokedAt` — and writes no audit event,
     * because nothing happened for it to record.
     *
     * AND NOTHING ELSE MOVES — EXCEPT 05.7's RETIREMENT. Only this row and the grant's own
     * short-lived key records are written: no ledger entry, reservation or credit grant is
     * touched — consumption that already happened stays exactly as settled (the ticket's
     * "revocation does not affect settlement responsibility for consumption that already
     * happened"), and a pending hold keeps occupying its capacity. The key records are the
     * ticket's own addition: every still-`active` gateway_virtual_keys row of this grant
     * flips to `revoked` IN THE SAME COMMIT (one conditional update — the flip is the
     * retirement), so the old credentialVersions stop being usable here the instant the
     * revocation lands, with no expiry grace and no "sync later". The gateway side of the
     * retirement is the {@link AccessGrantServiceDependencies.revokeGatewayKeys} seam,
     * called after the commit with exactly the ids this transaction retired; the admission
     * paths never wait on it.
     *
     * The audit event goes out after the commit, fail-closed like confirmation's: a revocation
     * the trail cannot name is a revocation that failed, and the caller retries into the
     * idempotent no-op rather than a second flip.
     */
    async revokeForUser(
      grantId: string,
      userId: string,
    ): Promise<{ grant: AccessGrant; revoked: boolean }> {
      if (typeof grantId !== "string" || grantId.length === 0)
        throw new AccessGrantUseError();
      if (
        typeof userId !== "string" ||
        userId.trim() !== userId ||
        userId === ""
      )
        throw new AccessGrantUseError();

      const outcome = await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.grantId, grantId),
              eq(accessGrants.userId, userId),
            ),
          );
        // Not found and not yours are one answer (04.6's rule, kept here).
        if (!row) throw new AccessGrantUseError();
        if (row.status === "revoked")
          return {
            grant: toGrant(row),
            revoked: false,
            retiredGatewayVirtualKeyIds: [],
          };

        // The conditional update is the flip's whole guard: under a concurrent revocation of the
        // same grant the second UPDATE re-checks `status = 'active'` against the committed row,
        // matches nothing, and the loser falls through to answer the winner's row unchanged.
        const [flipped] = await tx
          .update(accessGrants)
          .set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(accessGrants.grantId, grantId),
              eq(accessGrants.userId, userId),
              eq(accessGrants.status, "active"),
            ),
          )
          .returning();
        if (flipped) {
          // 05.7's retirement, same commit: the grant row lock this transaction holds is the
          // one issuance (05.3) and renewal (05.6) serialize on, so no new key version can be
          // born mid-revocation — what reads `active` here is everything the grant held. The
          // ids the gateway seam receives are the REMOTE key ids (the column the deactivation
          // transport and the 05.8 sync address), not this table's row ids.
          const retired = await tx
            .update(gatewayVirtualKeys)
            .set({ status: "revoked" })
            .where(
              and(
                eq(gatewayVirtualKeys.grantId, grantId),
                eq(gatewayVirtualKeys.status, "active"),
              ),
            )
            .returning({ id: gatewayVirtualKeys.gatewayVirtualKeyId });
          return {
            grant: toGrant(flipped),
            revoked: true,
            retiredGatewayVirtualKeyIds: retired.map((row) => row.id),
          };
        }
        const [winner] = await tx
          .select()
          .from(accessGrants)
          .where(eq(accessGrants.grantId, grantId));
        return {
          grant: toGrant(winner),
          revoked: false,
          retiredGatewayVirtualKeyIds: [],
        };
      });

      if (outcome.revoked && dependencies.auditStore) {
        await recordAuditEvent(dependencies.auditStore, {
          eventType: "model_access.revoked",
          targetType: "access_grant",
          targetId: outcome.grant.grantId,
          actorUserId: userId,
          payload: {
            grantId: outcome.grant.grantId,
            userId: outcome.grant.userId,
            botId: outcome.grant.botId,
            externalIdentity: outcome.grant.externalIdentity,
            scope: outcome.grant.scope,
            source: outcome.grant.source,
          },
        });
      }
      if (
        outcome.revoked &&
        outcome.retiredGatewayVirtualKeyIds.length > 0 &&
        dependencies.revokeGatewayKeys
      ) {
        // After the commit, after the trail: the person's answer is already true. The seam is
        // total by contract (failures recorded, never thrown), so a gateway that cannot be
        // reached softens nothing — the synchronous refusal lives in the rows above.
        await dependencies.revokeGatewayKeys({
          grantId: outcome.grant.grantId,
          gatewayVirtualKeyIds: outcome.retiredGatewayVirtualKeyIds,
        });
      }
      return outcome;
    },

    /**
     * What one live binding code would authorize, for the signed-in `userId` looking at it.
     * Reads the offer and the Bot and answers; consumes nothing, creates nothing — the person
     * has not confirmed yet, and looking must not spend the one thing (the code) the confirmation
     * needs. An unknown, used, expired or disabled-Bot code is the one uniform refusal.
     */
    /**
     * The person's revoke-everything act (Bifrost 05.10, AC08): one Bot's whole authorization
     * — every active grant the person holds for it, and through {@link revokeForUser} every
     * key version each grant still holds. The same visibility rule as the list: the user is
     * the session's own, so a Bot the person never authorized simply has nothing to revoke —
     * the answer is an empty result, not an error, and a replay after a completed revoke is
     * the same silence. Each grant's own revocation keeps its commit, audit and gateway
     * retirement exactly as the one-grant press has them.
     */
    async revokeAllForUser(
      userId: string,
      botId: string,
    ): Promise<{ grants: AccessGrant[]; revokedCount: number }> {
      if (
        typeof userId !== "string" ||
        userId.trim() !== userId ||
        userId === "" ||
        typeof botId !== "string" ||
        botId.trim() !== botId ||
        botId === ""
      )
        throw new AccessGrantUseError();
      const rows = await database
        .select({ grantId: accessGrants.grantId })
        .from(accessGrants)
        .where(
          and(
            eq(accessGrants.userId, userId),
            eq(accessGrants.botId, botId),
            eq(accessGrants.status, "active"),
          ),
        )
        .orderBy(desc(accessGrants.createdAt));
      const grants: AccessGrant[] = [];
      for (const { grantId } of rows) {
        const outcome = await this.revokeForUser(grantId, userId);
        grants.push(outcome.grant);
      }
      return { grants, revokedCount: grants.length };
    },

    async preview(
      userId: string,
      bindingCode: string,
    ): Promise<BindingPreview> {
      requireUserId(userId);
      const codeHash = requireCode(bindingCode);
      const [offer] = await database
        .select()
        .from(botBindingOffers)
        .where(eq(botBindingOffers.codeHash, codeHash));
      if (offer?.status !== "pending") throw new AccessGrantCodeError();
      if (offer.expiresAt.getTime() <= Date.now())
        throw new AccessGrantCodeError();
      // Live from the registry, so a Bot disabled since issuance is refused here, not at key time.
      const bot = await dependencies.botServices.getBotService(offer.botId);
      if (bot?.status !== "active") throw new AccessGrantCodeError();
      return {
        bot: { botId: bot.botId, displayName: bot.displayName },
        externalIdentity: offer.externalIdentityHint,
        scope: MODEL_ACCESS_SCOPE,
        expiresAt: offer.expiresAt,
      };
    },

    /**
     * The confirmation itself: consume the code and create (or return the already-existing) grant
     * for the signed-in `userId`, in one transaction.
     *
     * Consumption and creation share the transaction the way identity's `redeemChallenge` shares
     * its own — a refused grant leaves nothing spent, and a spent code leaves no way to replay it:
     * the offer row is locked, re-checked against the database's own clock, and flipped to
     * `redeemed` inside the same transaction that writes the grant. A concurrent confirmation of
     * the same code blocks on the row lock and finds `redeemed`; a concurrent confirmation of a
     * *different* code for the same authorization trips the partial unique index and returns the
     * twin it races. Either way exactly one active grant exists per (user, Bot, identity).
     */
    async confirm(
      userId: string,
      bindingCode: string,
    ): Promise<{ grant: AccessGrant; created: boolean }> {
      requireUserId(userId);
      const codeHash = requireCode(bindingCode);

      const { grant, created } = await database.transaction(async (tx) => {
        const [offer] = await tx
          .select()
          .from(botBindingOffers)
          .where(eq(botBindingOffers.codeHash, codeHash))
          .for("update");
        if (offer?.status !== "pending") throw new AccessGrantCodeError();
        // The registry read inside the transaction: a Bot disabled between preview and confirm
        // fails here, with the whole confirmation rolled back behind it.
        const [bot] = await tx
          .select()
          .from(botServices)
          .where(eq(botServices.botId, offer.botId));
        if (bot?.status !== "active") throw new AccessGrantCodeError();

        // Redeem conditionally — `pending` AND alive by the database clock, the real clock after
        // the row lock, so a code that expired while the person stared at the preview dies here
        // and not by a race with a stale application clock.
        const [consumed] = await tx
          .update(botBindingOffers)
          .set({ status: "redeemed" })
          .where(
            and(
              eq(botBindingOffers.codeHash, codeHash),
              eq(botBindingOffers.status, "pending"),
              gt(botBindingOffers.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ codeHash: botBindingOffers.codeHash });
        if (!consumed) throw new AccessGrantCodeError();

        // The same person confirming the same authorization again is the same grant, not a second
        // one — checked before the insert so the common repeat does no doomed write at all.
        const [existing] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.userId, userId),
              eq(accessGrants.botId, offer.botId),
              eq(accessGrants.externalIdentity, offer.externalIdentityHint),
              eq(accessGrants.status, "active"),
            ),
          );
        if (existing) return { grant: toGrant(existing), created: false };

        // The insert runs inside a savepoint: a unique violation aborts a plain PostgreSQL
        // transaction outright (25P02 on the next command), and the recovery this function owes —
        // return the twin that won the race — needs a transaction still alive to read it from.
        // Drizzle's nested transaction is exactly one SAVEPOINT, so the violation rolls back to
        // here and the outer transaction keeps going.
        const inserted = await tx
          .transaction(async (savepoint) => {
            const [row] = await savepoint
              .insert(accessGrants)
              .values({
                grantId: randomUUID(),
                userId,
                botId: offer.botId,
                externalIdentity: offer.externalIdentityHint,
                scope: MODEL_ACCESS_SCOPE,
                source: BINDING_CODE_SOURCE,
                status: "active",
              })
              .returning();
            return row;
          })
          .catch((error: unknown) => {
            // The concurrent twin: another confirmation of the same authorization committed first.
            // This one is the same act — return what already is rather than erroring a person who
            // confirmed in good faith. Anything else is a real failure.
            if (
              uniqueViolationConstraint(error) !==
              "access_grants_one_active_per_identity"
            )
              throw error;
            return null;
          });
        if (inserted) return { grant: toGrant(inserted), created: true };
        const [twin] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.userId, userId),
              eq(accessGrants.botId, offer.botId),
              eq(accessGrants.externalIdentity, offer.externalIdentityHint),
              eq(accessGrants.status, "active"),
            ),
          );
        return { grant: toGrant(twin), created: false };
      });

      /*
       * After the commit, and fail-closed: an authorization the trail cannot name is a
       * confirmation that failed, exactly like 04.3's issuance. The grant exists — the row
       * committed — but the caller sees the error; a retry with a fresh code answers the existing
       * grant (idempotent), so no authorization is ever silently unaudited. The payload names the
       * offer by its digest; the plaintext code exists exactly once, in the Bot's issuance
       * response, and never here.
       */
      if (dependencies.auditStore) {
        await recordAuditEvent(dependencies.auditStore, {
          eventType: created
            ? "model_access.granted"
            : "model_access.reconfirmed",
          targetType: "access_grant",
          targetId: grant.grantId,
          actorUserId: userId,
          payload: {
            grantId: grant.grantId,
            userId,
            botId: grant.botId,
            externalIdentity: grant.externalIdentity,
            scope: grant.scope,
            source: grant.source,
            codeHash,
          },
        });
      }
      return { grant, created };
    },

    /**
     * The built-in workbench bot's implicit authorization (Bifrost #241, 04.8): the login session
     * itself is the act of authorization, so `userId` — the session's own actor id, never a body
     * field — is the whole of who this is for, and no binding code exists anywhere in the flow.
     *
     * STILL A REAL GRANT. What this creates is one ordinary `access_grants` row — the same model,
     * the same one narrow scope, the same active/revoked lifecycle — marked `workbench-implicit`
     * and binding the login identity (`openbot:<userId>`) instead of a code-confirmed external
     * identity. Nothing implicit happens downstream: key issuance (05.3), reservation revalidation
     * (06.2) and revocation (04.7) all resolve this row through the same doors every other grant
     * goes through, so a revoked workbench grant is refused exactly like a revoked external one,
     * and no company content, no key, no credit and no payer decision comes into existence here.
     *
     * FAIL-CLOSED ON THE BOT. The registry is read live, inside the flow: if the well-known
     * identity is unregistered, disabled, or held by a non-builtin registration, the deployment
     * has no workbench bot and the whole flow refuses without creating anything — an absent bot
     * is not an authorization-free pass-through.
     *
     * REVOCATION IS STICKY. Asking again while an active grant exists is idempotent (the same
     * row back, `created: false`), but a revoked implicit grant stays revoked: plain asking
     * refuses with {@link WorkbenchGrantRevokedError} rather than silently resurrecting what the
     * person cancelled, and only the explicit `reauthorize` act creates a NEW row beside the dead
     * one — history is never overwritten, exactly like a re-confirmed external binding.
     */
    async ensureWorkbenchGrant(
      userId: string,
      options: { reauthorize?: boolean } = {},
    ): Promise<{ grant: AccessGrant; created: boolean }> {
      requireUserId(userId);
      const identity = workbenchImplicitIdentity(userId);

      // Live from the registry, never cached: a bot disabled since the last grant must refuse the
      // next implicit authorization here, not at key time — the same live read confirmation makes.
      const bot =
        await dependencies.botServices.getBotService(WORKBENCH_BOT_ID);
      if (bot?.status !== "active" || bot.kind !== "builtin")
        throw new WorkbenchGrantUnavailableError();

      const { grant, created } = await database.transaction(async (tx) => {
        // The common case first: an active implicit grant already is the authorization.
        const [existing] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.userId, userId),
              eq(accessGrants.botId, WORKBENCH_BOT_ID),
              eq(accessGrants.externalIdentity, identity),
              eq(accessGrants.status, "active"),
            ),
          );
        if (existing) return { grant: toGrant(existing), created: false };

        // No active grant: without an explicit re-authorization, a revoked one stays revoked —
        // using the workbench must not quietly un-cancel what the person cancelled.
        if (options.reauthorize !== true) {
          const [latest] = await tx
            .select()
            .from(accessGrants)
            .where(
              and(
                eq(accessGrants.userId, userId),
                eq(accessGrants.botId, WORKBENCH_BOT_ID),
                eq(accessGrants.externalIdentity, identity),
                eq(accessGrants.status, "revoked"),
              ),
            )
            .orderBy(desc(accessGrants.revokedAt))
            .limit(1);
          if (latest) throw new WorkbenchGrantRevokedError();
        }

        // The savepoint is the same race recovery confirmation owes: a concurrent twin that
        // committed first is the same act — return what already is rather than erroring a person
        // who asked in good faith. Anything else is a real failure.
        const inserted = await tx
          .transaction(async (savepoint) => {
            const [row] = await savepoint
              .insert(accessGrants)
              .values({
                grantId: randomUUID(),
                userId,
                botId: WORKBENCH_BOT_ID,
                externalIdentity: identity,
                scope: MODEL_ACCESS_SCOPE,
                source: WORKBENCH_IMPLICIT_SOURCE,
                status: "active",
              })
              .returning();
            return row;
          })
          .catch((error: unknown) => {
            if (
              uniqueViolationConstraint(error) !==
              "access_grants_one_active_per_identity"
            )
              throw error;
            return null;
          });
        if (inserted) return { grant: toGrant(inserted), created: true };
        const [twin] = await tx
          .select()
          .from(accessGrants)
          .where(
            and(
              eq(accessGrants.userId, userId),
              eq(accessGrants.botId, WORKBENCH_BOT_ID),
              eq(accessGrants.externalIdentity, identity),
              eq(accessGrants.status, "active"),
            ),
          );
        return { grant: toGrant(twin), created: false };
      });

      // After the commit, fail-closed like every other grant: an authorization the trail cannot
      // name is an authorization that failed. There is no code to omit here — the payload's
      // `source` is what says which flow the grant came from. And every ensure that returns an
      // active row is audited, not only the creating one — the same semantics `confirm` owes: if
      // this run's audit write failed after the row committed, the retry answers the existing
      // grant with `model_access.reconfirmed`, so the trail heals instead of leaving a grant no
      // event can ever name. There is no second event when both writes land — `reconfirmed` is
      // the idempotent ask's own record, one per ask, exactly like a re-confirmed binding code.
      if (dependencies.auditStore) {
        await recordAuditEvent(dependencies.auditStore, {
          eventType: created
            ? "model_access.granted"
            : "model_access.reconfirmed",
          targetType: "access_grant",
          targetId: grant.grantId,
          actorUserId: userId,
          payload: {
            grantId: grant.grantId,
            userId,
            botId: grant.botId,
            externalIdentity: grant.externalIdentity,
            scope: grant.scope,
            source: grant.source,
          },
        });
      }
      return { grant, created };
    },
  };
}

const confirmationInput = z.strictObject({
  bindingCode: z.string(),
});

/** The workbench grant's one body: empty, or the explicit re-authorization act — nothing else. */
const workbenchGrantInput = z
  .strictObject({
    reauthorize: z.boolean().optional(),
  })
  .transform((value) => ({ reauthorize: value.reauthorize ?? undefined }));

/**
 * `/api/model-access`, mounted behind the login guard: a person's own confirmation surface. Two
 * routes and only these — the preview that shows what a code would authorize, and the confirm
 * that authorizes it. Everything a later ticket adds (the list, the revocation) is a later
 * ticket's own route on this same mount; nothing here is reachable without a session, and no
 * route takes a user or an identity from the body. Without a composed service the whole surface
 * answers a tagged 503 — the feature absent, not the server broken.
 */
export function accessGrantRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  service?: AccessGrantService,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.use("*", requireUser);
  if (!service) {
    app.all("*", (context) =>
      context.json(
        {
          error: "Model access authorization is not available.",
          code: "model_access_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  const live = service;

  app.post("/binding-preview", async (context) => {
    return confirmationResponse(context, async (bindingCode) => {
      const preview = await live.preview(context.var.actor.id, bindingCode);
      return {
        preview: {
          bot: preview.bot,
          externalIdentity: preview.externalIdentity,
          scope: preview.scope,
          expiresAt: preview.expiresAt.toISOString(),
        },
      };
    });
  });

  app.post("/confirm", async (context) => {
    return confirmationResponse(context, async (bindingCode) => {
      const { grant, created } = await live.confirm(
        context.var.actor.id,
        bindingCode,
      );
      return {
        accessGrant: serializeGrant(grant),
        created,
      };
    });
  });

  /*
   * The built-in workbench bot's implicit authorization (Bifrost #241, 04.8), on the same mount
   * and behind the same guard as the confirmation above: the session's user is the authorization's
   * subject, and no binding code exists anywhere in the flow. The body is `{ reauthorize?: true }
   * and nothing else — a strict object, so nothing a caller sends can widen what is granted or
   * name a different subject. A revoked grant refuses with 409 `workbench_grant_revoked` until the
   * explicit re-authorization act; a deployment with no usable builtin workbench bot refuses with
   * 503 `workbench_grant_unavailable` and creates nothing — an absent bot is not a free pass.
   */
  app.post("/workbench/grant", async (context) => {
    const parsed = workbenchGrantInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        {
          error:
            "Send nothing, or { reauthorize: true } to restore revoked access.",
          code: "workbench_grant_invalid_request",
        },
        400,
      );
    try {
      const { grant, created } = await live.ensureWorkbenchGrant(
        context.var.actor.id,
        parsed.data,
      );
      return context.json({
        accessGrant: serializeGrant(grant),
        created,
      });
    } catch (error) {
      if (error instanceof WorkbenchGrantRevokedError)
        return context.json({ error: error.message, code: error.code }, 409);
      if (error instanceof WorkbenchGrantUnavailableError)
        return context.json({ error: error.message, code: error.code }, 503);
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "workbench_grant_invalid_request" },
          400,
        );
      throw error;
    }
  });

  /*
   * The person's own authorizations and their revocation (Bifrost #240, 04.7), on the same mount
   * and behind the same guard as the confirmation above — two reads of one rule: the user is the
   * session's, never a request field. The list answers only the caller's rows; the revocation
   * locates its grant by grantId AND that same session user id, so another person's grant and no
   * grant at all are the same tagged 404 — a prober learns nothing from the difference. The
   * response leaves only after the commit: what the list answers next is already `revoked`.
   */
  app.get("/grants", async (context) => {
    const grants = await live.listForUser(context.var.actor.id);
    return context.json({
      grants: grants.map((grant) => ({
        ...serializeGrant(grant),
        botDisplayName: grant.botDisplayName,
        // The live key versions (05.10): status, term and version number — no secret, none
        // exists to send.
        activeKeys: grant.activeKeys,
      })),
    });
  });

  /*
   * Revoke-everything for one Bot (05.10): the body names the Bot, the session names the
   * person, and the answer is the Bot's grants as they now stand. A Bot with nothing active
   * is not an error — the act is idempotent, and a replay after a completed revoke answers
   * the same revoked rows with nothing left to do.
   */
  app.post("/grants/revoke-all", async (context) => {
    const parsed = revokeAllInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "A botId is required." }, 400);
    try {
      const { grants, revokedCount } = await live.revokeAllForUser(
        context.var.actor.id,
        parsed.data.botId,
      );
      return context.json({ grants: grants.map(serializeGrant), revokedCount });
    } catch (error) {
      if (error instanceof AccessGrantUseError)
        return context.json({ error: error.message, code: error.code }, 404);
      throw error;
    }
  });

  app.post("/grants/:grantId/revoke", async (context) => {
    try {
      const { grant, revoked } = await live.revokeForUser(
        context.req.param("grantId"),
        context.var.actor.id,
      );
      return context.json({ accessGrant: serializeGrant(grant), revoked });
    } catch (error) {
      if (error instanceof AccessGrantUseError)
        return context.json({ error: error.message, code: error.code }, 404);
      throw error;
    }
  });

  return app;
}

/** The grant as every response carries it: the same shape `/confirm` answered since 04.5. */
function serializeGrant(grant: AccessGrant) {
  return {
    grantId: grant.grantId,
    userId: grant.userId,
    botId: grant.botId,
    externalIdentity: grant.externalIdentity,
    scope: grant.scope,
    source: grant.source,
    status: grant.status,
    createdAt: grant.createdAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}

/**
 * The two confirmation routes share one body: `{ bindingCode }` and nothing else — a strict
 * object, so a forged `userId` or `externalIdentity` is refused here, before any service reads
 * anything. The two failures a person can cause are said differently: a malformed request is a
 * plain 400, and an unusable code is the one uniform tagged refusal that reveals nothing.
 */
/** The revoke-all body: `{ botId }` and nothing else, so no other field can smuggle a user. */
const revokeAllInput = z.object({ botId: z.string().trim().min(1) }).strict();

async function confirmationResponse(
  context: Parameters<MiddlewareHandler<{ Variables: AppVariables }>>[0],
  run: (bindingCode: string) => Promise<Record<string, unknown>>,
) {
  const parsed = confirmationInput.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success)
    return context.json(
      {
        error: "Send the binding code the Bot gave you.",
        code: "model_access_invalid_request",
      },
      400,
    );
  try {
    return context.json(await run(parsed.data.bindingCode));
  } catch (error) {
    if (error instanceof AccessGrantCodeError)
      return context.json({ error: error.message, code: error.code }, 400);
    if (error instanceof BotServiceInputError)
      return context.json(
        { error: error.message, code: "model_access_invalid_request" },
        400,
      );
    throw error;
  }
}
