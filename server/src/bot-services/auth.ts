import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  type CredentialStore,
  type CredentialSecretReader,
  decryptSecret,
} from "../credentials";
import type { BotServiceStore } from "./store";
import {
  BOT_ID_PATTERN,
  BotServiceAuthFailureError,
  BotServiceInputError,
  BotServiceRateLimitedError,
  type BotServiceIdentity,
} from "./types";

/**
 * Bot service authentication (Bifrost #235, 04.2): the one door a Bot's server walks through.
 *
 * A Bot presents `<prefix><botId>~<secret>`. The authenticator parses the botId the token claims,
 * reads that Bot's live credential from the shared vault, decrypts it and compares digests in
 * constant time. Nothing is cached: every call re-reads the vault and the registry, so a revoked
 * credential or a disabled Bot fails the very next call (AC). Every failure — a token that is not
 * ours, a botId nobody registered, a retired credential, a wrong secret, a disabled Bot — is the
 * same {@link BotServiceAuthFailureError}, because the answer must not reveal whether the Bot
 * exists. The result is a {@link BotServiceIdentity}: which Bot, and nothing about users,
 * accounts or credits (CONTEXT.md: Registered Bot).
 */

/** Recognisable on sight, so a leaked one can be found in a log or by a secret scanner. */
const SECRET_PREFIX = "obot_bsvc_";

/** 32 random bytes, the same material the deployment's other secrets use. Nobody types this. */
const SECRET_BYTES = 32;

/**
 * Mint a Bot's service secret: `<prefix><botId>~<base64url secret>`.
 *
 * The botId rides inside the token, so a presented secret names the Bot that claims to be talking
 * before the vault is asked anything. `~` is the separator because it is in neither the botId
 * charset (BOT_ID_PATTERN) nor base64url, so the split is unambiguous by construction.
 */
export function mintBotServiceSecret(botId: string): string {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new BotServiceInputError(
      "The botId is not a valid service identity.",
    );
  }
  return `${SECRET_PREFIX}${botId}~${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/**
 * Parse a presented secret into the botId it claims and the secret part to verify, or null when
 * the presentation is not even shaped like one of ours. Null is not an answer a caller can show
 * anyone: the authenticator turns it into the same uniform failure as everything else.
 */
export function parseBotServiceSecret(
  presented: unknown,
): { botId: string; secret: string } | null {
  if (typeof presented !== "string" || !presented.startsWith(SECRET_PREFIX)) {
    return null;
  }
  const rest = presented.slice(SECRET_PREFIX.length);
  const separator = rest.indexOf("~");
  if (separator <= 0) return null;
  const botId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!secret || !BOT_ID_PATTERN.test(botId)) return null;
  return { botId, secret };
}

/**
 * How many failed presentations one identity may make before the window closes on it.
 *
 * Twenty wrong secrets in a minute is no operator typing from a config file; it is guessing. The
 * window (one minute) then drains on its own — an operator who fat-fingered a secret twice is
 * never locked out, and a botId under active guessing gets a minute of silence per burst. The
 * counter sits on the identity the token claims, so guessing at one Bot cannot lock another; the
 * trade-off, that a botId an attacker already knows can be quieted for a minute at a time, buys
 * the rate the AC asks for without any per-IP apparatus a self-hosted deployment cannot see
 * behind its proxy honestly.
 */
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 20;

/**
 * The failed attempts, per claimed identity, inside a sliding window.
 *
 * In-memory on purpose: the limiter may only ever refuse, so a process restart clears counting
 * but never grants anything, and the authentication answer it guards is always read live from the
 * database beside it. A hint is the parsed botId — or, for presentations too malformed to name
 * one, a digest of what was presented, so flooding garbage cannot grow the map without bound.
 */
export type FailureLimiter = {
  /** Whether this hint has worn out its welcome for the current window. */
  blocked: (hint: string) => boolean;
  /** Record one failure against this hint. */
  record: (hint: string) => void;
};

export function createFailureLimiter(
  options: {
    windowMs?: number;
    maxFailures?: number;
    /** Injectable for tests; defaults to the wall clock. */
    now?: () => number;
  } = {},
): FailureLimiter {
  const windowMs = options.windowMs ?? FAILURE_WINDOW_MS;
  const maxFailures = options.maxFailures ?? MAX_FAILURES_PER_WINDOW;
  const now = options.now ?? Date.now;
  const failures = new Map<string, number[]>();
  /** Hard cap, so even per-hint counting cannot grow without bound under a flood. */
  const maxHints = 10_000;

  return {
    blocked(hint) {
      const attempts = failures.get(hint);
      if (!attempts) return false;
      const cutoff = now() - windowMs;
      const recent = attempts.filter((at) => at > cutoff);
      if (recent.length === 0) {
        failures.delete(hint);
        return false;
      }
      failures.set(hint, recent);
      return recent.length >= maxFailures;
    },
    record(hint) {
      if (!failures.has(hint) && failures.size >= maxHints) {
        // Evict the oldest hint (Map iterates in insertion order) rather than grow forever.
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      const attempts = failures.get(hint) ?? [];
      attempts.push(now());
      failures.set(hint, attempts);
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type BotServiceAuthenticatorDependencies = {
  encryptionKey: string;
  /** The vault, able to find a Bot's live credential and read its ciphertext back. */
  credentialStore: CredentialStore & CredentialSecretReader;
  /** The registry whose status verdict (active vs disabled) finishes the check. */
  botServices: Pick<BotServiceStore, "getBotService">;
  limiter?: FailureLimiter;
};

export type BotServiceAuthenticator = (
  presentedSecret: string,
) => Promise<BotServiceIdentity>;

export function createBotServiceAuthenticator(
  dependencies: BotServiceAuthenticatorDependencies,
): BotServiceAuthenticator {
  const limiter = dependencies.limiter ?? createFailureLimiter();
  const { credentialStore } = dependencies;

  return async (presentedSecret) => {
    const parsed = parseBotServiceSecret(presentedSecret);
    const hint = parsed ? parsed.botId : sha256(String(presentedSecret));
    if (limiter.blocked(hint)) throw new BotServiceRateLimitedError();
    const failure = () => {
      limiter.record(hint);
      return new BotServiceAuthFailureError();
    };

    if (!parsed) throw failure();
    const live = await credentialStore.findLiveByKey({
      kind: "bot_service",
      provider: "bot-service",
      keyId: parsed.botId,
    });
    if (!live) throw failure();
    const stored = await credentialStore.readSecret(live.id);
    if (!stored || stored.revokedAt) throw failure();
    const expected = await decryptSecret(
      dependencies.encryptionKey,
      stored.encryptedValue,
    );
    // Both sides are the full presented token vs the full stored one, digested to equal-length
    // 32-byte buffers first, so the constant-time comparison never leaks how much of the secret
    // was right.
    if (
      !timingSafeEqual(
        Buffer.from(sha256(presentedSecret)),
        Buffer.from(sha256(expected)),
      )
    ) {
      throw failure();
    }

    // The credential is real; the registry gets the last word. A missing row or a disabled Bot
    // fails authentication too (AC: disabling is immediate) — but it is not counted as a guessing
    // failure, because whoever holds a valid secret is not guessing.
    const record = await dependencies.botServices.getBotService(parsed.botId);
    if (record?.status !== "active") {
      throw new BotServiceAuthFailureError();
    }
    return { botId: record.botId, status: record.status };
  };
}

/** The Variables the bot-facing routes read after the middleware has answered. */
export type BotServiceVariables = AppVariables & {
  botService: BotServiceIdentity;
};

export type BotServiceRouteDependencies = {
  authenticate: BotServiceAuthenticator;
  /**
   * Optional additional bot-facing surfaces that ride the same service guard (04.3 mounts its
   * binding-code issuance here), as routers already carrying their own routes and no-store header.
   */
  bindingCodes?: Hono<{ Variables: BotServiceVariables }>;
};

/**
 * Guard every route in a bot-facing router with service authentication.
 *
 * The credential arrives as `Authorization: Bearer <secret>`. Failure is one uniform 401 body;
 * a spent failure budget is one uniform 429; neither says whether the botId exists.
 */
export function requireBotService(
  dependencies: BotServiceRouteDependencies,
): MiddlewareHandler<{ Variables: BotServiceVariables }> {
  return async (context, next) => {
    const header = context.req.header("authorization");
    const presented = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined;
    if (!presented) {
      return uniformAuthFailure(context);
    }
    try {
      context.set("botService", await dependencies.authenticate(presented));
    } catch (error) {
      if (error instanceof BotServiceRateLimitedError) {
        context.header("retry-after", "60");
        return context.json(
          { error: error.message, code: "bot_service_auth_rate_limited" },
          429,
        );
      }
      return uniformAuthFailure(context);
    }
    await next();
  };
}

function uniformAuthFailure(
  context: Context<{ Variables: BotServiceVariables }>,
) {
  return context.json(
    {
      error: "Bot service authentication failed.",
      code: "bot_service_auth_failed",
    },
    401,
  );
}

/**
 * `/api/bot-service`: the Bot-facing surface this ticket mounts. Today it answers exactly one
 * question — "which Bot does this credential say I am?" — which makes it the deployment's own
 * smoke test for a credential. Later tickets in the group (04.3's binding-code issuance) mount
 * their routes on the same guard rather than inventing another door.
 */
export function botServiceRoutes(
  dependencies: BotServiceRouteDependencies | undefined,
) {
  const app = new Hono<{ Variables: BotServiceVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  if (!dependencies?.authenticate) {
    app.all("*", (context) =>
      context.json(
        {
          error: "Bot service authentication is not available.",
          code: "bot_service_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  app.use("*", requireBotService(dependencies));
  app.get("/", (context) =>
    context.json({ botService: context.get("botService") }),
  );
  if (dependencies.bindingCodes)
    app.route("/binding-codes", dependencies.bindingCodes);
  return app;
}
