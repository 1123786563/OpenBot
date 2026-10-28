import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Workshop share tokens, and the scoped actor they mint.
 *
 * ⚠️ THE ONE EXCEPTION: the read path below (`resolveShareActor`) is the ONLY read path in the
 * entire repository that deliberately bypasses `canUseBot`. Every other surface asks "who may
 * act as this Bot"; a share link asks "who holds the token" — that is the whole product of a
 * share. Because the exception is singular, it is guarded harder than the rule: the token is
 * 32 bytes of entropy (not guessable, not derivable from anything), the stored form is its
 * sha256 (a database leak mints nothing), the plaintext exists exactly once at creation, and
 * misses never say WHY (a wrong guess, an expired link, and a revoked one are the same answer
 * — an enumeration probe learns nothing about which links ever existed).
 *
 * SIGNATURES, NOT DATABASES, UNLOCK ARTIFACTS: a share URL's artifact links are HMAC-signed
 * with the deployment's key. The verifier is `verifyArtifactUrl`, constant-time, and the
 * signature binds the artifact and the share scope so a link cannot be reshaped mid-flight.
 */

/** 32 bytes of entropy, base32 (Crockford: no I/L/O/U — unambiguous to read aloud). */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newShareToken(): string {
  const bytes = randomBytes(32);
  let out = "";
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

/** The stored form: sha256 hex of the plaintext. Never reversible, always comparable. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ShareScope = "preview" | "preview_download";

export type CreateShareInput = {
  channelId: string;
  scope: ShareScope;
  /** Days the link lives; absent means until revoked. */
  expiresInDays?: number;
  /** Who created the link, for the audit column. */
  createdBy: string;
};

export type ShareHandle = {
  /** The ONLY time the plaintext exists on this side of the wire. Render it or lose it. */
  token: string;
  shareUrl: string;
  scope: ShareScope;
  expiresAt: Date | null;
};

export type ShareStore = {
  /** Set (or replace) the session's live share. One live link per session, by the unique index. */
  setShare(input: {
    channelId: string;
    tokenHash: string;
    scope: ShareScope;
    expiresAt: Date | null;
    createdBy: string;
  }): Promise<void>;
  /** Revoke: the row's fields are kept, `shareRevokedAt` is set. Misses are quiet. */
  revokeShare(channelId: string): Promise<void>;
  /** Look a share up BY TOKEN HASH — the one read that starts from a bearer secret. */
  findLiveShareByTokenHash(tokenHash: string): Promise<
    | {
        channelId: string;
        botId: string;
        scope: ShareScope;
        expiresAt: Date | null;
        revokedAt: Date | null;
      }
    | undefined
  >;
};

export type RateLimiter = {
  /** Count one hit for the key; true when the caller is still under the budget. */
  hit(key: string): Promise<boolean>;
};

/**
 * The in-process fallback limiter: a fixed window per hash. Redis (ws:rl:share:<hash>, 60/min)
 * is the multi-replica shape; a deployment without Redis degrades to this, which is correct
 * per-replica and wrong only by replication count.
 */
export function createInProcessShareLimiter(
  limitPerMinute = 60,
  nowMs: () => number = Date.now,
): RateLimiter {
  /** The key is attacker-chosen (a token hash), so the map itself is budgeted. */
  const MAX_WINDOWS = 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  const evictExpired = (now: number) => {
    for (const [key, window] of windows) {
      if (now - window.start >= 60_000) windows.delete(key);
    }
  };
  return {
    async hit(key) {
      const now = nowMs();
      const window = windows.get(key);
      if (!window || now - window.start >= 60_000) {
        // Full map: expired windows first, then refuse — a flood of fresh tokens must not be
        // able to price honest callers out of memory on an anonymous endpoint.
        if (windows.size >= MAX_WINDOWS) {
          evictExpired(now);
          if (windows.size >= MAX_WINDOWS) return false;
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      window.count += 1;
      return window.count <= limitPerMinute;
    },
  };
}

export type ShareService = {
  createShare(input: CreateShareInput): Promise<ShareHandle>;
  revokeShare(channelId: string): Promise<void>;
  /**
   * Token → scoped actor, or null. THE canUseBot exception (see the file's head). All three
   * failure shapes — wrong token, expired, revoked — answer the same null, on purpose.
   */
  resolveShareActor(token: string): Promise<{
    channelId: string;
    botId: string;
    scope: ShareScope;
  } | null>;
  /** A signed artifact URL for one artifact under one share scope. */
  signArtifactUrl(input: {
    channelId: string;
    artifactId: string;
    scope: ShareScope;
  }): string;
  /** Verify one signed URL. Constant-time; false on any reshape. */
  verifyArtifactUrl(
    channelId: string,
    artifactId: string,
    scope: string,
    signature: string,
  ): boolean;
  /** One limiter probe against the token's hash — the anonymous rate limiter's door. */
  underRateLimit(token: string): Promise<boolean>;
};

export function createShareService(options: {
  store: ShareStore;
  /** The HMAC key; the deployment's, not derived from the token (revocation must not orphan signatures' siblings). */
  signingKey: string;
  limiter?: RateLimiter;
  now?: () => Date;
  tokenFactory?: () => string;
}): ShareService {
  const { store, signingKey } = options;
  // An empty HMAC key still signs: every deployment that misconfigures this would mint
  // signatures anyone with the algorithm can forge, so the mistake is fatal here instead.
  if (!signingKey)
    throw new Error("The workshop share signing key must not be empty.");
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter ?? createInProcessShareLimiter();
  const newToken = options.tokenFactory ?? newShareToken;

  const artifactSignature = (
    channelId: string,
    artifactId: string,
    scope: string,
  ): string =>
    createHmac("sha256", signingKey)
      // Length-prefixed fields, so a triple whose ids contain colons cannot collide with
      // another triple spelled differently.
      .update(
        [channelId, artifactId, scope]
          .map((part) => `${part.length}:${part}`)
          .join(""),
      )
      .digest("base64url");

  return {
    async createShare(input) {
      const token = newToken();
      const tokenHash = hashShareToken(token);
      // Absent means never-expiring. An EXPLICIT non-positive or non-integer value is a
      // caller mistake, refused rather than widened into the most permissive outcome
      // (a link that never expires).
      if (
        input.expiresInDays !== undefined &&
        (!Number.isInteger(input.expiresInDays) || input.expiresInDays <= 0)
      )
        throw new Error("expiresInDays must be a positive whole number of days.");
      const expiresAt =
        input.expiresInDays !== undefined
          ? new Date(now().getTime() + input.expiresInDays * 86_400_000)
          : null;
      await store.setShare({
        channelId: input.channelId,
        tokenHash,
        scope: input.scope,
        expiresAt,
        createdBy: input.createdBy,
      });
      return {
        token,
        // The URL carries the token once; the server never stores it again.
        shareUrl: `/workshop/${encodeURIComponent(input.channelId)}/shared?t=${token}`,
        scope: input.scope,
        expiresAt,
      };
    },

    async revokeShare(channelId) {
      await store.revokeShare(channelId);
    },

    async resolveShareActor(token) {
      const tokenHash = hashShareToken(token);
      const live = await store.findLiveShareByTokenHash(tokenHash);
      // The uniform miss: no row, revoked, or expired all answer null, and nothing about
      // which one it was reaches the caller.
      if (!live || live.revokedAt) return null;
      if (live.expiresAt && live.expiresAt.getTime() <= now().getTime())
        return null;
      return {
        channelId: live.channelId,
        botId: live.botId,
        scope: live.scope,
      };
    },

    signArtifactUrl(input) {
      const signature = artifactSignature(
        input.channelId,
        input.artifactId,
        input.scope,
      );
      return `/api/workshop/${encodeURIComponent(input.channelId)}/public/artifacts/${encodeURIComponent(
        input.artifactId,
      )}?scope=${input.scope}&s=${signature}`;
    },

    verifyArtifactUrl(channelId, artifactId, scope, signature) {
      const expected = Buffer.from(
        artifactSignature(channelId, artifactId, scope),
      );
      const presented = Buffer.from(signature);
      if (expected.length !== presented.length) return false;
      return timingSafeEqual(expected, presented);
    },

    async underRateLimit(token) {
      // Keyed on the HASH, not the plaintext: the limiter's keys are infrastructure, and
      // infrastructure never holds the secret in clear.
      return limiter.hit(hashShareToken(token));
    },
  };
}
