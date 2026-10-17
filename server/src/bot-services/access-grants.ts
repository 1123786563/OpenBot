import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { accessGrants, botBindingOffers, botServices } from "../db/schema";
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
    async listForUser(userId: string): Promise<ListedAccessGrant[]> {
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
      return rows.map(({ grant, botDisplayName }) => ({
        ...toGrant(grant),
        botDisplayName,
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
     * AND NOTHING ELSE MOVES: only this row is written. No ledger entry, reservation or credit
     * grant is touched — consumption that already happened stays exactly as settled (the ticket's
     * "revocation does not affect settlement responsibility for consumption that already happened").
     * The audit event goes out after the commit, fail-closed like confirmation's: a revocation the
     * trail cannot name is a revocation that failed, and the caller retries into the idempotent
     * no-op rather than a second flip.
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
          return { grant: toGrant(row), revoked: false };

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
        if (flipped) return { grant: toGrant(flipped), revoked: true };
        const [winner] = await tx
          .select()
          .from(accessGrants)
          .where(eq(accessGrants.grantId, grantId));
        return { grant: toGrant(winner), revoked: false };
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
          },
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
            codeHash,
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
      })),
    });
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
