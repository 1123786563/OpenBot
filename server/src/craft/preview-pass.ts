/**
 * The preview pass — a random opaque token bound by a server-side index
 * (#358 repair Task 1; rotated by #427 AC1/AC7).
 *
 * Before the #358 repair the preview pass WAS the session id: the gate compared
 * the cookie value against the sessionId, so knowledge of a session id and the
 * preview address was enough to forge the credential without redeeming a ticket.
 * The repair replaced that with a deployment-key-signed value (#431 T1/T2):
 * unforgeable, but a PURE FUNCTION of (deployment secret, sessionId, userId) —
 * with no per-credential identity, retiring ONE holder meant rotating the global
 * key (killing every pass) or deleting the session row (killing the session).
 * #427 supplies that missing rotation ability with the design the module's own
 * ponytail note anticipated: a random token in the v1 MAC frame, plus a
 * token → (sessionId, userId) index that is the binding authority.
 *
 * Shape: `v1.<base64url(token)>.<base64url(mac)>`, where the token is 16 bytes
 * (128 bits) of `crypto.randomBytes` minted fresh at every redemption. The MAC
 * covers the version and the TOKEN under length-prefixed framing — NOT the
 * session id: the wire value carries no session identity at all (the index owns
 * the binding), while the frame keeps the two properties the signing bought:
 * a candidate this deployment never minted fails the MAC, and every refusal is
 * `null` — never a reason that could echo a candidate value (the ticket module's
 * rule, kept here). The key is derived from the deployment secret under the
 * purpose label "craft-preview-pass" (the signed-value convention,
 * server/src/auth/signed-value.ts), so this MAC can never be confused with — or
 * computed as — the preview label's or a credential ciphertext's use of the
 * same secret.
 *
 * Verification is MAC-then-index, and BOTH steps are acceptance:
 *   MAC fails  ⇒ null (unknown/garbage/tampered ⇒ 401, the fail-safe shape);
 *   MAC passes ⇒ the token must be in the index; a lookup miss is 401 too —
 *                there is NO "not found ⇒ let through" branch anywhere.
 * The index hit must also name the presenting session, so a pass for session A
 * still opens nothing on session B's host. Verification is non-consuming —
 * unlike the 30-second single-use ticket, the pass is a session credential:
 * verifying twice must answer twice.
 *
 * Index lifetime (the choice and its consequences, recorded here and in
 * reference/craft-preview-origin.md):
 * - IN-MEMORY, process-wide, one index per deployment secret (the #418
 *   single-replica contract the label registry and ticket table already live
 *   under). A multi-replica deployment needs sticky routing or a shared store;
 *   the boot log's single-replica notice covers the family.
 * - Cleared by a restart: every outstanding pass then verifies to null (MAC
 *   ok, lookup miss) ⇒ 401. Holders recover exactly like M-2: they re-enter
 *   through the main site, which re-mints a ticket and plants a fresh token.
 * - Entries live until revoked or the process restarts. The D9 cookie is
 *   session-level (the browser drops it at close), but the server cannot see
 *   that event; the index therefore keeps the entry — the same accepted
 *   no-eviction trade as the label registry, bounded by redemptions per
 *   process lifetime rather than by sessions.
 * - Single-token revocation (AC7) deletes one entry: that pass 401s while the
 *   session and every other token for it keep working. Global key/version
 *   rotation remains the higher, coarser layer (it invalidates everything).
 *
 * No compatibility branch: the pre-#427 stateless pass carried a base64url
 * userId in the token slot, which never satisfies the 16-byte token shape, so
 * it verifies to null by construction (and by test). Nobody re-enters a legacy
 * shape — holders re-mint through the main site.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A token's binding — what the index stores and `verify` answers from. The
 * wire never carries either field; the index is the sole authority for both.
 */
export type PreviewPassBinding = { sessionId: string; userId: string };

/**
 * The server-side token index: token → (sessionId, userId). One instance per
 * deployment secret in production (the process's single index); injectable so
 * tests can model a restart (a fresh index is the empty state a new process
 * boots with) and so a future shared-store adapter has one seam to implement.
 */
export type PreviewPassIndex = {
  /** Record a freshly minted token's binding. Overwrites only an identical token. */
  remember(token: string, binding: PreviewPassBinding): void;
  /** The binding for a token, or undefined — the ONE shape a miss takes. */
  lookup(token: string): PreviewPassBinding | undefined;
  /** Drop one token. True when an entry was actually removed. */
  forget(token: string): boolean;
  /** Live entries — observability/test only, never an enumeration of values. */
  size(): number;
};

/** The in-memory index (#418 single-replica contract — see the header). */
export function createPreviewPassIndex(): PreviewPassIndex {
  const entries = new Map<string, PreviewPassBinding>();
  return {
    remember(token, binding) {
      entries.set(token, binding);
    },
    lookup(token) {
      return entries.get(token);
    },
    forget(token) {
      return entries.delete(token);
    },
    size() {
      return entries.size;
    },
  };
}

/** A codec bound to one deployment secret (and the index its passes live in). */
export type PreviewPassCodec = {
  /** Mint a fresh random token bound to (sessionId → userId). Throws on out-of-bounds inputs. */
  issue(sessionId: string, userId: string): string;
  /** The ONE pass judgment: the exact userId the token binds, or null. Never consumes. */
  verify(sessionId: string, candidate: string): { userId: string } | null;
  /**
   * #427 AC7 — the single-token revocation channel: delete one pass's index
   * entry so THAT credential 401s. The session itself and the holder's other
   * tokens are untouched; a re-mint opens again. The candidate is the pass
   * VALUE as presented — the cookie's payload, the exact string `verify`
   * judges — so a caller needs no secret and no parsing: the token is
   * extracted by the same strict frame rules, and anything that is not a
   * well-formed pass (or whose frame parses but carries an unknown token)
   * answers false, never a throw. Session-guarded (`sessionId` must match the
   * entry) so a wrong id can never retire another session's pass. Call
   * surface: exported here and re-exposed as PreviewOrigin.revokePass for
   * server-side callers that hold no secret (no production caller is wired by
   * this ticket; the seam is the session-deletion/re-entry hook a later
   * consumer would own).
   */
  revoke(sessionId: string, candidate: string): boolean;
  /** Live index entries — the index's observable (test/observability only). */
  size(): number;
};

/** The wire version. Bumping it invalidates every outstanding pass at once. */
export const PREVIEW_PASS_VERSION = "v1";

/**
 * The exact cookie-value shape a minted pass takes. Exported for the Set-Cookie
 * whitelist (preview-ticket.ts) so the value side and the header side read one
 * definition and cannot drift: `v1.` + the base64url token + `.` + a 32-byte
 * MAC's 43 base64url chars.
 */
export const PREVIEW_PASS_COOKIE_SHAPE =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** The purpose label this module's MAC use of the deployment secret derives under. */
const PASS_KEY_PURPOSE = "craft-preview-pass";
/** HMAC-SHA256 digest length — the exact length a candidate MAC must carry. */
const MAC_BYTES = 32;
/** 128 bits of CSPRNG per pass — the AC's floor, and the token's strict decoded length. */
const TOKEN_BYTES = 16;
/**
 * users.id is provider-provided text (`dev-local-user`, Casdoor/SCIM ids) —
 * the bound covers that shape with room to spare. An id beyond it fails at
 * MINT (loud) rather than at verify (silently), so a deployment never hands
 * out a pass its own gate would refuse.
 */
const MAX_USER_ID_BYTES = 256;
/** Craft session ids are `cs-<hex>`; the bound is generous, the check is strict. */
const MAX_SESSION_ID_BYTES = 128;
/** The candidate value ceiling at verify — no legitimate pass is longer (~69 chars). */
const MAX_CANDIDATE_LENGTH = 512;

function passKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(PASS_KEY_PURPOSE).digest();
}

/**
 * The MAC input: version and the token's raw bytes under decimal-byte-length
 * framing. The token is the only variable field (the index, not the frame,
 * carries the session binding — #427), and the length prefix keeps the one
 * field boundary exact, the same framing discipline the repair shipped.
 */
function passMac(key: Buffer, tokenBytes: Buffer): Buffer {
  const mac = createHmac("sha256", key);
  mac.update(`${PREVIEW_PASS_VERSION}|${tokenBytes.length}|`, "utf8");
  mac.update(tokenBytes);
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

/**
 * The process's default index per deployment. Production creates ONE codec from
 * the boot secret; keying the default index by the DERIVED key (never the raw
 * secret) means every codec over the same deployment secret reads the same
 * index — the process-level state the design describes — while two deployments
 * collide on nothing. Tests inject `createPreviewPassIndex()` to model a
 * restart; production never passes one.
 */
const defaultIndexes = new Map<string, PreviewPassIndex>();

function defaultIndexFor(key: Buffer): PreviewPassIndex {
  const id = key.toString("hex");
  let index = defaultIndexes.get(id);
  if (index === undefined) {
    index = createPreviewPassIndex();
    defaultIndexes.set(id, index);
  }
  return index;
}

export function createPreviewPassCodec(
  secret: string,
  index?: PreviewPassIndex,
): PreviewPassCodec {
  const key = passKey(secret);
  const store = index ?? defaultIndexFor(key);
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
      const tokenBytes = randomBytes(TOKEN_BYTES);
      const token = tokenBytes.toString("base64url");
      // The binding is recorded BEFORE the value leaves this function: a pass
      // whose token missed its index entry would 401 at its own gate.
      store.remember(token, { sessionId, userId });
      const macPart = passMac(key, tokenBytes).toString("base64url");
      return `${PREVIEW_PASS_VERSION}.${token}.${macPart}`;
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
      const [version, token, macPart] = parts;
      if (version !== PREVIEW_PASS_VERSION) return null;
      // Charset before decode: base64url only. The round-trip inside
      // decodeStrict then pins the bytes exactly.
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(macPart)) return null;
      const tokenBytes = decodeStrict(token);
      if (tokenBytes === null) return null;
      // Strict token shape: exactly the minted 128 bits. The pre-#427 stateless
      // pass (a userId's base64url in this slot) dies here, by construction.
      if (tokenBytes.length !== TOKEN_BYTES) return null;
      const mac = decodeStrict(macPart);
      if (mac === null || mac.length !== MAC_BYTES) return null;
      // Constant time: both sides are exactly MAC_BYTES (length mismatch is
      // refused above — timingSafeEqual throws on unequal lengths), so the
      // comparison never leaks how much of a MAC was right.
      if (!timingSafeEqual(mac, passMac(key, tokenBytes))) return null;
      // MAC ok is NOT acceptance (#427's fail-safe clause): the token must be
      // in this deployment's index, and a miss is 401 — never a pass-through.
      const binding = store.lookup(token);
      if (binding === undefined) return null;
      // The index binds the session; a token for session A opens nothing on B.
      if (binding.sessionId !== sessionId) return null;
      return { userId: binding.userId };
    },

    revoke(sessionId, candidate) {
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > MAX_CANDIDATE_LENGTH
      ) {
        return false;
      }
      // Frame rules aligned with verify's SHAPE (N4-01, and to verify's full
      // byte-level strictness since #650): macPart charset (43 chars = the
      // 32-byte MAC's base64url), strict token decode, and the TOKEN_BYTES
      // length — a value this deployment's own shape would refuse never
      // reaches the index lookup, so revoke===true keeps meaning "a
      // well-formed pass this deployment could have minted".
      // The MAC itself is deliberately NOT re-verified — the index, not the
      // signature, is revocation's authority (a known token retires its own
      // entry; proving the deployment key buys nothing here). #650 changed
      // only HOW STRICTLY the MAC's FRAME is checked, never that the MAC's
      // VALUE is checked at all: revoke remains non-cryptographic.
      const parts = candidate.split(".");
      if (parts.length !== 3) return false;
      const [version, token, macPart] = parts;
      if (version !== PREVIEW_PASS_VERSION) return false;
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;
      // #650: the charset test above is a SHAPE bound, not a length bound —
      // a 43-char base64url string is only 32 bytes when it is the
      // canonical encoding, and Node's decoder silently accepts hostile
      // trailing bits ("_"*43 decodes to a different length, "-"*43 does
      // not round-trip at all). verify therefore ran the same charset
      // test and then pinned the bytes with decodeStrict + MAC_BYTES;
      // revoke now runs the identical pair. Behavior is unchanged for
      // every value a mint can produce (canonically encoded, exactly 32
      // bytes), and the two gates now refuse exactly the same frames —
      // which is what lets the sentence below be TRUE rather than merely
      // intended.
      if (!/^[A-Za-z0-9_-]{43}$/.test(macPart)) return false;
      const mac = decodeStrict(macPart);
      if (mac === null || mac.length !== MAC_BYTES) return false;
      const tokenBytes = decodeStrict(token);
      if (tokenBytes === null || tokenBytes.length !== TOKEN_BYTES)
        return false;
      const binding = store.lookup(token);
      if (binding === undefined || binding.sessionId !== sessionId)
        return false;
      return store.forget(token);
    },

    size() {
      return store.size();
    },
  };
}
