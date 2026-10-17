import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { botBindingOffers } from "../db/schema";
import type { BotServiceVariables } from "./auth";
import { createFailureLimiter, type FailureLimiter } from "./auth";
import { type BotServiceIdentity, BotServiceInputError } from "./types";

/**
 * One-time binding-code issuance and consumption (Bifrost #236, 04.3; #237, 04.4).
 *
 * A Bot's authenticated server asks: "start binding this external identity of mine". What it
 * receives is a {@link BindingOffer} — a high-entropy code bound to exactly its botId and the one
 * external identity it named, alive for a short, composition-configurable lifetime, single use by
 * default. The code is a claim ticket for one (Bot, identity) pair and never a universal one; the
 * person confirms it after signing in (04.5).
 *
 * The plaintext code exists exactly once — in the issuance response. Storage and audit hold only
 * its sha256 digest, so neither a database read nor the audit trail can redeem anything. What a
 * replayed, expired, forged or cross-bot code can do is settled here too: one uniform refusal, one
 * spend per code even under concurrency, and a lockout on the source that keeps guessing.
 */

/** Recognisable on sight, so a leaked one can be found in a log or by a secret scanner. */
const CODE_PREFIX = "obot_bbind_";

/** 32 random bytes: 256 bits of entropy. Nobody types this, so nobody needs it shorter. */
const CODE_BYTES = 32;

/** The default lifetime: short, like every other one-time credential this deployment mints. */
export const DEFAULT_BINDING_OFFER_TTL_MS = 15 * 60_000;

/** A configurable lifetime is still a short one: composition may not mint a day-long code. */
const MAX_BINDING_OFFER_TTL_MS = 24 * 60 * 60_000;

/** A hint is what the Bot knows the person by — a handle, an id in its own namespace. Not prose. */
const HINT_MAX = 512;

export type BindingOffer = {
  /** The plaintext code. Handed to the Bot's server once; never stored, never logged, never audited. */
  bindingCode: string;
  botId: string;
  externalIdentityHint: string;
  expiresAt: Date;
  singleUse: true;
  status: "pending";
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Mint one binding code: `<prefix><base64url of 32 random bytes>`. Fresh randomness on every call —
 * a code is never derived from the botId, the hint or a counter, so knowing every parameter of one
 * issuance predicts nothing about any other.
 */
export function mintBindingCode(): string {
  return `${CODE_PREFIX}${randomBytes(CODE_BYTES).toString("base64url")}`;
}

/** Only a digest is ever stored or audited; refuse anything that is not even a string. */
export function bindingCodeHash(code: string): string {
  if (typeof code !== "string" || code.length === 0)
    throw new BotServiceInputError("The binding code is not valid.");
  return sha256(code);
}

/**
 * Validate and trim a hint. A blank one names no identity and an over-long one is refused, not
 * truncated: silently shortening what the Bot named could bind a different identity than the one
 * the Bot meant, and nobody would notice until the wrong person confirmed.
 */
function normalizeHint(value: unknown): string {
  if (typeof value !== "string") throw new BotServiceInputError();
  const trimmed = value.trim();
  if (!trimmed) throw new BotServiceInputError();
  if (Array.from(trimmed).length > HINT_MAX) throw new BotServiceInputError();
  return trimmed;
}

export type BindingOfferIssuerDependencies = {
  database: Database;
  auditStore?: AuditStore;
  /** The offer's whole lifetime. Defaults to fifteen minutes; never longer than a day. */
  ttlMs?: number;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => Date;
};

export type BindingOfferIssuer = {
  /**
   * Offer a binding between the authenticated Bot and one external identity it named. `identity`
   * is what the bot-facing guard authenticated — the issuer trusts no botId a caller typed.
   */
  issue(
    identity: BotServiceIdentity,
    input: { externalIdentityHint: string },
  ): Promise<BindingOffer>;
};

export function createBindingOfferIssuer(
  dependencies: BindingOfferIssuerDependencies,
): BindingOfferIssuer {
  const ttlMs = dependencies.ttlMs ?? DEFAULT_BINDING_OFFER_TTL_MS;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_BINDING_OFFER_TTL_MS
  ) {
    throw new BotServiceInputError(
      "The binding offer lifetime must be positive and at most a day.",
    );
  }
  const now = dependencies.now ?? (() => new Date());

  return {
    async issue(identity, input) {
      // The guard refuses a disabled Bot before this runs; the check costs nothing and keeps the
      // issuer honest on its own, whoever composes it.
      if (identity.status !== "active")
        throw new BotServiceInputError(
          "A disabled bot service cannot issue binding codes.",
        );
      const externalIdentityHint = normalizeHint(input.externalIdentityHint);
      const bindingCode = mintBindingCode();
      const codeHash = bindingCodeHash(bindingCode);
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);
      await dependencies.database.insert(botBindingOffers).values({
        codeHash,
        botId: identity.botId,
        externalIdentityHint,
        singleUse: true,
        status: "pending",
        issuedAt,
        expiresAt,
      });
      if (dependencies.auditStore) {
        // Fail-closed: a broken audit trail refuses issuance rather than minting an unaudited
        // credential. The payload carries the digest and the hint, never the plaintext code.
        await recordAuditEvent(dependencies.auditStore, {
          eventType: "bot_binding.offered",
          targetType: "bot_binding_offer",
          targetId: codeHash,
          initiator: { kind: "handoff", id: identity.botId },
          payload: {
            botId: identity.botId,
            externalIdentityHint,
            expiresAt: expiresAt.toISOString(),
            singleUse: true,
            codeHash,
          },
        });
      }
      return {
        bindingCode,
        botId: identity.botId,
        externalIdentityHint,
        expiresAt,
        singleUse: true,
        status: "pending",
      };
    },
  };
}

/**
 * Every way a binding code can fail its consumer, said the same way (Bifrost #237, 04.4).
 *
 * A forged code, an expired one, a replayed one and one pinned to a different Bot all arrive as
 * this one class with this one message, so no caller — and no response built on it — can tell
 * whether the code exists, whom it belongs to or which of the four it was. The class is the
 * contract; there are deliberately no subclasses for the reasons.
 */
export class BindingCodeRejectedError extends Error {
  constructor(message = "The binding code was not accepted.") {
    super(message);
    this.name = "BindingCodeRejectedError";
  }
}

/**
 * Too many failed presentations from one source, inside the limiter's window. A distinct class
 * because the answer is genuinely different — retry later — but it still says nothing about any
 * code: the lockout is keyed to whoever keeps failing, never to a code's existence.
 */
export class BindingCodeRateLimitedError extends Error {
  constructor(message = "Too many failed binding-code attempts; retry later.") {
    super(message);
    this.name = "BindingCodeRateLimitedError";
  }
}

/**
 * A transaction the caller already opened, so consumption can commit atomically with whatever
 * depends on it — 04.5's confirmation consumes the code and creates the access grant in one
 * transaction, or neither happens.
 */
export type BindingOfferTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** What a successful consumption returns: the pair the code was a claim ticket for, now spent. */
export type ConsumedBindingOffer = {
  botId: string;
  externalIdentityHint: string;
  singleUse: true;
  status: "redeemed";
};

/** One presentation of a binding code for spending. */
export type BindingOfferPresentation = {
  /**
   * Who is presenting the code — the confirmation flow passes the signed-in user's id. Failure
   * counting and lockout key on this, so a source is required: a caller that cannot attribute an
   * attempt must not make one.
   */
  source: string;
  /**
   * The Bot the presentation claims the code belongs to. Omitted learns the Bot from the row;
   * given, a code bound to any other Bot is refused without being spent. Either way the refusal
   * is the same one a forged code gets.
   */
  botId?: string;
};

export type BindingOfferConsumer = {
  /**
   * Spend one binding code. Either the offer flips to `redeemed` and its pair is returned, or
   * exactly one of the two errors above is thrown — and nothing else about the offer is said.
   */
  consume(
    code: string,
    presentation: BindingOfferPresentation,
    within?: BindingOfferTransaction,
  ): Promise<ConsumedBindingOffer>;
};

export type BindingOfferConsumerDependencies = {
  database: Database;
  /**
   * Failure counting per presenting source. Defaults to the same sliding-window shape bot service
   * authentication uses; like that one, it may only ever refuse, never grant.
   */
  limiter?: FailureLimiter;
};

/**
 * Spend binding codes (Bifrost #237, 04.4).
 *
 * The whole double-spend defence is one conditional UPDATE: `pending → redeemed`, only while
 * `expires_at` is still ahead, only for the Bot a pinned presentation names. PostgreSQL takes the
 * row lock for the first transaction and re-evaluates the condition for every waiter, so two
 * concurrent consumptions of one code cannot both match — one commits, the other sees a spent row
 * and receives the same uniform refusal a forged code gets.
 *
 * Consumption proves the code, nothing more. It does not decide whether the Bot is still enabled —
 * downstream (04.5's grant creation, 05.3's key issuance) re-validates on its own trigger — and it
 * writes no audit event: the confirmation flow that owns the surrounding transaction owns the
 * trail, naming the grant and this code's digest together. Consumption is also per code, not per
 * (Bot, identity): a Bot may hold several live offers for the same person, and spending one leaves
 * its siblings untouched.
 */
export function createBindingOfferConsumer(
  dependencies: BindingOfferConsumerDependencies,
): BindingOfferConsumer {
  const limiter = dependencies.limiter ?? createFailureLimiter();
  const { database } = dependencies;

  return {
    async consume(code, presentation, within) {
      const codeHash = bindingCodeHash(code);
      const source = presentationSource(presentation.source);
      const botId = presentationBotId(presentation.botId);
      if (limiter.blocked(source)) throw new BindingCodeRateLimitedError();

      const conditions = [
        eq(botBindingOffers.codeHash, codeHash),
        eq(botBindingOffers.singleUse, true),
        eq(botBindingOffers.status, "pending"),
        gt(botBindingOffers.expiresAt, sql`clock_timestamp()`),
        ...(botId === undefined ? [] : [eq(botBindingOffers.botId, botId)]),
      ];
      const spend = (connection: Database | BindingOfferTransaction) =>
        connection
          .update(botBindingOffers)
          .set({ status: "redeemed" })
          .where(and(...conditions))
          .returning({
            botId: botBindingOffers.botId,
            externalIdentityHint: botBindingOffers.externalIdentityHint,
          });
      const [row] = within
        ? await spend(within)
        : await database.transaction((transaction) => spend(transaction));
      if (!row) {
        limiter.record(source);
        throw new BindingCodeRejectedError();
      }
      return {
        botId: row.botId,
        externalIdentityHint: row.externalIdentityHint,
        singleUse: true,
        status: "redeemed",
      };
    },
  };
}

/**
 * A source names who is presenting: non-empty and unpadded, because silently trimming it would
 * fork one presenter's failure count into `" u1"` and `"u1"` and halve every lockout.
 */
function presentationSource(source: unknown): string {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.trim() !== source
  )
    throw new BotServiceInputError("Name who is presenting the binding code.");
  return source;
}

/** A pinned botId is the exact service identity it claims, or the presentation is refused. */
function presentationBotId(botId: unknown): string | undefined {
  if (botId === undefined) return undefined;
  if (typeof botId !== "string" || botId.length === 0 || botId.trim() !== botId)
    throw new BotServiceInputError(
      "The botId a binding code is pinned to must be its exact service identity.",
    );
  return botId;
}

const issuanceInput = z.strictObject({
  externalIdentityHint: z.string(),
});

export type BindingCodeRouteDependencies = {
  issuer?: BindingOfferIssuer;
};

/**
 * `/api/bot-service/binding-codes`, mounted by the bot-facing router under its service guard: the
 * authenticated surface a Bot's server presents a service credential at, so only an authenticated
 * Bot can reach issuance at all. Without a composed issuer the surface answers a tagged 503 —
 * the same fail-closed shape every absent surface in this module takes.
 */
export function bindingCodeRoutes(
  dependencies: BindingCodeRouteDependencies | undefined,
) {
  const app = new Hono<{ Variables: BotServiceVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  if (!dependencies?.issuer) {
    app.all("*", (context) =>
      context.json(
        {
          error: "Binding-code issuance is not available.",
          code: "bot_binding_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  const issuer = dependencies.issuer;
  app.post("/", async (context) => {
    const botService = context.get("botService");
    const parsed = issuanceInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success || !botService)
      return context.json(
        {
          error: "Name the external identity to bind.",
          code: "bot_binding_invalid",
        },
        400,
      );
    try {
      const offer = await issuer.issue(botService, parsed.data);
      return context.json({
        bindingOffer: {
          bindingCode: offer.bindingCode,
          botId: offer.botId,
          externalIdentityHint: offer.externalIdentityHint,
          expiresAt: offer.expiresAt.toISOString(),
          singleUse: offer.singleUse,
          status: offer.status,
        },
      });
    } catch (error) {
      if (error instanceof BotServiceInputError)
        return context.json(
          { error: error.message, code: "bot_binding_invalid" },
          400,
        );
      throw error;
    }
  });
  return app;
}
