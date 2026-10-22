/**
 * The signed preview pass (#358 repair, spec craft-preview-origin AC4/D9).
 *
 * Before this module the preview pass WAS the session id: the gate compared the
 * cookie value against the sessionId, so knowledge of a session id and the
 * preview address was enough to forge the credential without redeeming a ticket.
 * This module is the replacement primitive: a versioned, deployment-key-signed
 * value binding (sessionId → userId), minted ONCE at ticket redemption and
 * verified on every later preview request (HTTP and HMR — one judgment, Task 2).
 *
 * Shape: `v1.<base64url(userId)>.<base64url(mac)>`. The userId rides readable
 * (it is the claim the proxy hands the store for the ownership re-check) — the
 * MAC is what makes the value unforgeable. The MAC covers the version, the
 * sessionId and the userId under LENGTH-PREFIXED framing, so no field boundary
 * is guessable and no pair of field values can collide with another pair. The
 * key is derived from the deployment secret under the purpose label
 * "craft-preview-pass" — the signed-value convention (server/src/auth/
 * signed-value.ts): one secret to configure, per-use material, so this MAC can
 * never be confused with (or computed as) the preview label's, a signature's,
 * or a credential ciphertext's use of the same secret.
 *
 * `verify` is stateless and non-consuming — unlike the 30-second single-use
 * ticket, the pass is a session credential: verifying twice must answer twice.
 * Parsing is strict (exact version, exact base64url round-trip, exact MAC
 * length, byte bounds) and the comparison is constant time. Every refusal is
 * `null` — never a reason that could echo a candidate value, because a pass is
 * a bearer credential (the ticket module's rule, kept here).
 *
 * Rotation semantics: the key material is (deployment secret, purpose label,
 * version). Changing any of them invalidates every outstanding pass — holders
 * re-enter from the main site and re-redeem. That is the documented upgrade
 * behavior (reference/craft-preview-origin.md), not a compatibility branch: the old
 * plaintext session-id cookie verifies to null here, by construction and by
 * test, and NO legacy shape is ever accepted.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** A codec bound to one deployment secret. */
export type PreviewPassCodec = {
  /** Mint the signed pass binding (sessionId → userId). Throws on out-of-bounds inputs. */
  issue(sessionId: string, userId: string): string;
  /** The ONE pass judgment: the exact userId the pass binds, or null. Never consumes. */
  verify(sessionId: string, candidate: string): { userId: string } | null;
};

/** The wire version. Bumping it invalidates every outstanding pass at once. */
export const PREVIEW_PASS_VERSION = "v1";

/**
 * The exact cookie-value shape a minted pass takes. Exported for the Set-Cookie
 * whitelist (preview-ticket.ts) so the value side and the header side read one
 * definition and cannot drift: `v1.` + base64url userId + `.` + a 32-byte MAC's
 * 43 base64url chars.
 */
export const PREVIEW_PASS_COOKIE_SHAPE =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** The purpose label this module's MAC use of the deployment secret derives under. */
const PASS_KEY_PURPOSE = "craft-preview-pass";
/** HMAC-SHA256 digest length — the exact length a candidate MAC must carry. */
const MAC_BYTES = 32;
/**
 * users.id is provider-provided text (`dev-local-user`, Casdoor/SCIM ids) —
 * the bound covers that shape with room to spare. An id beyond it fails at
 * MINT (loud) rather than at verify (silently), so a deployment never hands
 * out a pass its own gate would refuse.
 */
const MAX_USER_ID_BYTES = 256;
/** Craft session ids are `cs-<hex>`; the bound is generous, the check is strict. */
const MAX_SESSION_ID_BYTES = 128;
/** The candidate value ceiling at verify — no legitimate pass is longer. */
const MAX_CANDIDATE_LENGTH = 512;

function passKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(PASS_KEY_PURPOSE).digest();
}

/**
 * The MAC input: version and both ids under decimal-byte-length framing, then
 * the raw UTF-8 bytes. The lengths make the field boundaries exact — `("ab","c")`
 * and `("a","bc")` frame differently, so no split of a concatenated stream can
 * forge another triple's MAC.
 */
function passMac(key: Buffer, sessionId: string, userId: string): Buffer {
  const mac = createHmac("sha256", key);
  mac.update(
    `${PREVIEW_PASS_VERSION}|${Buffer.byteLength(sessionId, "utf8")}|${Buffer.byteLength(userId, "utf8")}|`,
    "utf8",
  );
  mac.update(Buffer.from(sessionId, "utf8"));
  mac.update(Buffer.from(userId, "utf8"));
  return mac.digest();
}

/**
 * Strict base64url: decode, then require the re-encode to round-trip — Node's
 * decoder ignores hostile bytes, so the round-trip (plus the charset test the
 * caller runs) is what makes parsing exact rather than lenient.
 */
function decodeStrict(part: string): Buffer | null {
  const decoded = Buffer.from(part, "base64url");
  if (decoded.length === 0) return null;
  if (decoded.toString("base64url") !== part) return null;
  return decoded;
}

export function createPreviewPassCodec(secret: string): PreviewPassCodec {
  const key = passKey(secret);
  return {
    issue(sessionId, userId) {
      if (
        sessionId.length === 0 ||
        Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_ID_BYTES
      ) {
        throw new RangeError(
          `preview pass: sessionId out of bounds (1..${MAX_SESSION_ID_BYTES} bytes).`,
        );
      }
      if (
        userId.length === 0 ||
        Buffer.byteLength(userId, "utf8") > MAX_USER_ID_BYTES
      ) {
        throw new RangeError(
          `preview pass: userId out of bounds (1..${MAX_USER_ID_BYTES} bytes).`,
        );
      }
      const userPart = Buffer.from(userId, "utf8").toString("base64url");
      const macPart = passMac(key, sessionId, userId).toString("base64url");
      return `${PREVIEW_PASS_VERSION}.${userPart}.${macPart}`;
    },

    verify(sessionId, candidate) {
      if (typeof candidate !== "string") return null;
      if (candidate.length === 0 || candidate.length > MAX_CANDIDATE_LENGTH) {
        return null;
      }
      if (
        sessionId.length === 0 ||
        Buffer.byteLength(sessionId, "utf8") > MAX_SESSION_ID_BYTES
      ) {
        return null;
      }
      const parts = candidate.split(".");
      if (parts.length !== 3) return null;
      const [version, userPart, macPart] = parts;
      if (version !== PREVIEW_PASS_VERSION) return null;
      // Charset before decode: base64url only. The round-trip inside
      // decodeStrict then pins the bytes exactly.
      if (!/^[A-Za-z0-9_-]+$/.test(userPart)) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(macPart)) return null;
      const userBytes = decodeStrict(userPart);
      if (userBytes === null) return null;
      if (Buffer.byteLength(userBytes) > MAX_USER_ID_BYTES) return null;
      const userId = userBytes.toString("utf8");
      const mac = decodeStrict(macPart);
      if (mac === null || mac.length !== MAC_BYTES) return null;
      // Constant time: both sides are exactly MAC_BYTES (length mismatch is
      // refused above — timingSafeEqual throws on unequal lengths), so the
      // comparison never leaks how much of a MAC was right.
      if (!timingSafeEqual(mac, passMac(key, sessionId, userId))) return null;
      return { userId };
    },
  };
}
