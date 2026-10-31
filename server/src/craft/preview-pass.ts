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
 * token → (sessionId, userId) index that is the binding authority. This index is
 * the third of the preview origin's three in-process families — alongside the
 * label registry and the ticket table — and carries the same single-replica
 * contract they do (#418).
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
 *   the boot log's single-replica notice names this index alongside the label
 *   registry and ticket table as the in-process families the contract covers
 *   — the three a restart clears and a second replica never sees (#647: the
 *   pass index's own failure shape is a 401 after a successful redemption,
 *   MAC ok and index miss, which reads as an auth bug and is a lost index).
 * - Cleared by a restart: every outstanding pass then verifies to null (MAC
 *   ok, lookup miss) ⇒ 401. Holders recover exactly like M-2: they re-enter
 *   through the main site, which re-mints a ticket and plants a fresh token.
 * - Bounded per session (#651 — this REPLACES the earlier no-eviction trade
 *   this note used to record). Each session keeps at most its 8 most recent
 *   tokens (PREVIEW_PASSES_PER_SESSION, with the N-value reasoning there);
 *   minting a 9th evicts that session's OLDEST entry. Eviction is passive: the
 *   evicted token is simply absent, so redeeming it hits the SAME index-miss
 *   branch as an expired or restart-cleared pass — 401, never an error code and
 *   never a pass-through. The invariant that makes the small N safe is that
 *   eviction always takes the oldest of THAT session, so the session's current
 *   (latest) mint can never be evicted by its own mint, and a pass for session
 *   A never affects session B's queue.
 *   Why the trade flipped: the old note accepted growth "bounded by redemptions
 *   per process lifetime", but redemptions are client-driven — an authenticated
 *   client looping mint+redeem grew the process's memory monotonically, and
 *   every superseded token stayed live until revoked or restart. A per-session
 *   ceiling makes growth "per session" instead, at the cost that a holder who
 *   mints more than 8 times without redeeming the newest loses the older
 *   cookies — which the ordinary steady state never does (one cookie slot per
 *   preview host/path, overwritten at each redemption).
 *   The session-deletion sweep remains the cleaner shape and is NOT this
 *   ticket's: it needs a production caller on the session-deletion hook
 *   (`revokePass` still has none, #649's seam), so the capacity bound is what
 *   holds today — it needs no caller and works even if no hook ever fires.
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
  /**
   * Record a freshly minted token's binding. Overwrites only an identical
   * token, and — since #651 — evicts that session's OLDEST entry once the
   * session holds more than the capacity (see PREVIEW_PASSES_PER_SESSION).
   */
  remember(token: string, binding: PreviewPassBinding): void;
  /** The binding for a token, or undefined — the ONE shape a miss takes. */
  lookup(token: string): PreviewPassBinding | undefined;
  /** Drop one token. True when an entry was actually removed. */
  forget(token: string): boolean;
  /** Live entries — observability/test only, never an enumeration of values. */
  size(): number;
};

/**
 * #651 — how many live passes ONE session may hold. The index used to grow with
 * every redemption (no eviction, no ceiling): an authenticated client that
 * looped mint+redeem grew the process's memory monotonically, and every
 * superseded token stayed redeemable until revoked or restart.
 *
 * Why 8 (the trade this number buys):
 * - A session's cookie jar holds ONE preview pass per (preview host, path): a
 *   mint at ticket redemption OVERWRITES the previous cookie, so the ordinary
 *   steady state is one live token per session. Re-entry through the main site
 *   (the M-2 recovery path) re-mints; a browser that reconnects repeatedly in a
 *   short window — HMR reload loops, several preview tabs on one session, a
 *   dev-form host whose Path=/ slots collide — can legitimately mint a handful.
 * - 8 is an order of magnitude above the steady state and above every
 *   concurrent-pass count the suites exercise, so eviction is never the reason
 *   a real holder 401s; it only bounds a client that mints in a loop.
 * - Bound per session ≈ 8 × (22-char token + ≤128-byte sessionId + ≤256-byte
 *   userId) < 4 KiB, i.e. a few MB at a thousand concurrent sessions — the
 *   ceiling replaces "growth per redemption" with "growth per session".
 * - The invariant that makes a small N safe: eviction always takes the OLDEST
 *   token of that session, so the session's CURRENT (latest) mint is never the
 *   victim — a mint may only retire tokens N mints older than itself.
 *
 * Eviction is PASSIVE (the entry is simply gone): a redeemed evicted token hits
 * the index-miss branch and 401s, which reads exactly like an expired pass —
 * not like an error, and never like a pass-through. Holders recover through the
 * main site, the same re-entry path a restart already forces.
 *
 * Not chosen: a session-deletion hook that sweeps a session's entries. That
 * needs a production caller wired to session deletion (#649's note: revokePass
 * has no production caller yet), which is a later ticket's seam — the capacity
 * bound here needs no caller and holds even when no hook ever fires.
 */
export const PREVIEW_PASSES_PER_SESSION = 8;

/**
 * The in-memory index (#418 single-replica contract — see the header).
 *
 * Two structures, one truth: `entries` answers lookups, and `bySession` holds
 * each session's live tokens in MINT order (a token is appended when remembered
 * and spliced out when forgotten/evicted), which is what makes "evict the
 * oldest of THIS session" an O(1) shift instead of a scan. They are only ever
 * mutated together, so a queue slot never outlives its map entry. A rebind onto
 * the SAME session only rewrites the map entry and keeps its original slot: the
 * queue is mint order, not recency order.
 *
 * `perSessionCapacity` is a parameter so tests can drive the bound with a small
 * N; production takes the default.
 */
export function createPreviewPassIndex(
  perSessionCapacity: number = PREVIEW_PASSES_PER_SESSION,
): PreviewPassIndex {
  if (!Number.isInteger(perSessionCapacity) || perSessionCapacity < 1) {
    // Capacity 0 would evict the mint it just recorded — the one entry the
    // invariant forbids losing. A bad value must fail at construction, not
    // silently 401 every holder.
    throw new RangeError(
      `preview pass index: per-session capacity must be a positive integer, got ${perSessionCapacity}.`,
    );
  }
  const entries = new Map<string, PreviewPassBinding>();
  const bySession = new Map<string, string[]>();

  function queueFor(sessionId: string): string[] {
    let queue = bySession.get(sessionId);
    if (queue === undefined) {
      queue = [];
      bySession.set(sessionId, queue);
    }
    return queue;
  }

  function dropFromQueue(sessionId: string, token: string): void {
    const queue = bySession.get(sessionId);
    if (queue === undefined) return;
    const at = queue.lastIndexOf(token);
    if (at !== -1) queue.splice(at, 1);
    // An emptied session leaves no key behind: the map itself must not become
    // the new unbounded structure (one array per session ever seen).
    if (queue.length === 0) bySession.delete(sessionId);
  }

  /**
   * #651/OCR-1 — evict this session's OLDEST tokens until its queue is at the
   * capacity. BOTH push paths call it (a fresh mint AND a rebind onto another
   * session): the ceiling is a property of the queue, not of how a token got
   * there, so no branch that pushes may skip it. Extracted verbatim from the
   * mint path, which it must keep answering identically — same oldest-first
   * order, same guard, same entries/map pairing.
   */
  function trimSessionQueue(sessionId: string): void {
    const queue = bySession.get(sessionId);
    if (queue === undefined) return;
    while (queue.length > perSessionCapacity) {
      const oldest = queue.shift();
      if (oldest === undefined) break;
      // Only drop a map entry that still binds THIS session — the queue and
      // the map are written together, so this is a guard, not a branch.
      if (entries.get(oldest)?.sessionId === sessionId) {
        entries.delete(oldest);
      }
    }
  }

  return {
    remember(token, binding) {
      const existing = entries.get(token);
      if (existing !== undefined) {
        // 128-bit random tokens make a repeat unreachable in practice; keeping
        // the queue honest anyway means a hand-planted duplicate can never
        // leave a slot pointing at a token the map no longer binds here.
        if (existing.sessionId === binding.sessionId) {
          entries.set(token, binding);
          return;
        }
        dropFromQueue(existing.sessionId, token);
        entries.set(token, binding);
        queueFor(binding.sessionId).push(token);
        // The rebind is a push like any other: the freshly bound session's
        // queue obeys the SAME ceiling (OCR-1 — this branch used to return
        // straight after pushing, so repeated rebinds on one session grew it
        // past PREVIEW_PASSES_PER_SESSION).
        trimSessionQueue(binding.sessionId);
        return;
      }
      entries.set(token, binding);
      const queue = queueFor(binding.sessionId);
      queue.push(token);
      trimSessionQueue(binding.sessionId);
    },
    lookup(token) {
      return entries.get(token);
    },
    forget(token) {
      const binding = entries.get(token);
      if (binding === undefined) return false;
      entries.delete(token);
      dropFromQueue(binding.sessionId, token);
      return true;
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
      // a 43-char base64url string always decodes to 32 bytes (Node drops the
      // two trailing bits that do not fit), so length alone cannot tell a
      // canonical encoding from a hostile one: "_"*43 and "-"*43 both yield
      // 32 bytes but neither re-encodes to itself. verify therefore ran the
      // same charset test and then pinned the round-trip with decodeStrict +
      // MAC_BYTES; revoke now runs the identical pair. Behavior is unchanged for
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
