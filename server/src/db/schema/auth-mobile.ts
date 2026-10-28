import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/*
 * T05.12 (#568, original task P12; interfaces §5.2 / F2): the persisted half
 * of the mobile one-time PKCE session handoff. Two rows per handoff, both
 * written by the mobile-session service on the auth-writer capability, and
 * nothing else ever touches them:
 *
 *   auth_mobile_handoff_codes — GET /api/enterprise/mobile/authorize mints
 *     one row per intent: a 120-second single-use code bound to the BA
 *     session that browsed in, the registered client, its registered
 *     redirect, the OpenBot authority origin and the PKCE S256 challenge.
 *     The code itself never lands in the table — the primary key is its
 *     SHA-256 digest.
 *
 *   auth_mobile_session_handles — POST /api/enterprise/mobile/session/exchange
 *     consumes a pending code and mints the opaque session handle in the
 *     SAME transaction. The handle binds the verified facts (BA session,
 *     issuer/subject mapping, identityGeneration, principal, client, fixed
 *     audience) and lives at most 1800 seconds, capped by the BA session's
 *     own expiry. The server stores only the handle's digest; the plaintext
 *     leaves exactly once, in the exchange response.
 *
 * The single-use discipline is the database's, not the caller's: consumption
 * is a conditional `consumed_at IS NULL` UPDATE inside the exchange
 * transaction, and the handles table's unique code_digest makes a second
 * handle for the same code structurally impossible even if two exchanges
 * raced past the row lock.
 */
export const authMobileHandoffCodes = pgTable(
  "auth_mobile_handoff_codes",
  {
    /** SHA-256 hex of the one-time code; the plaintext code only ever rides the redirect URL. */
    codeDigest: text("code_digest").primaryKey(),
    /** The server-generated intent id the redirect echoes and the exchange must repeat. */
    intentId: text("intent_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The BA session that browsed in; the exchange re-verifies it live under lock. */
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** The registered client the code was minted for. */
    clientId: text("client_id").notNull(),
    /** The client's registered redirect, byte-for-byte; a different one never consumes. */
    redirectUri: text("redirect_uri").notNull(),
    /** The PKCE S256 challenge (43 base64url characters). */
    codeChallenge: text("code_challenge").notNull(),
    /** The OpenBot authority origin the handle will name — deployment config, never a request header. */
    authorityOrigin: text("authority_origin").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null while pending; set exactly once, by the exchange transaction that minted a handle. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // The 120-second window (interfaces §5.2): strictly after creation, never
    // longer than the ceiling — a skewed caller cannot mint a longer-lived code.
    check(
      "auth_mobile_handoff_code_window",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '120 seconds'`,
    ),
    // PKCE S256 challenges are exactly 43 unpadded base64url characters.
    check(
      "auth_mobile_handoff_code_challenge_shape",
      sql`char_length(${table.codeChallenge}) = 43`,
    ),
    check(
      "auth_mobile_handoff_code_intent_shape",
      sql`char_length(${table.intentId}) between 1 and 128`,
    ),
    // Consumption happens at or after creation, never before.
    check(
      "auth_mobile_handoff_code_consumed_after_created",
      sql`(${table.consumedAt} is null) or (${table.consumedAt} >= ${table.createdAt})`,
    ),
    index("auth_mobile_handoff_code_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

export const authMobileSessionHandles = pgTable(
  "auth_mobile_session_handles",
  {
    /** SHA-256 hex of the opaque handle; the plaintext is returned once and never stored. */
    handleDigest: text("handle_digest").primaryKey(),
    /** The code this handle consumed — unique forever: one handle per code, ever. */
    codeDigest: text("code_digest").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The original BA session; its death (expiry, revoke, account change) kills the handle. */
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    authorityOrigin: text("authority_origin").notNull(),
    /** The fixed audience the handle is good for; the registered BFF, nothing else. */
    audience: text("audience").notNull(),
    /** The user's principal at exchange time; null while the user has not been onboarded. */
    principalId: text("principal_id"),
    /** The verified remote binding at exchange time; null for a local-credential user. */
    issuer: text("issuer"),
    subject: text("subject"),
    /** The principal's identity generation pinned at exchange; later actions compare it live. */
    identityGeneration: bigint("identity_generation", { mode: "number" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The replay fence the exchange rides on: a second handle for the same
    // code is structurally impossible, whatever raced past the row lock.
    uniqueIndex("auth_mobile_session_handle_code_uq").on(table.codeDigest),
    // The 1800-second ceiling (interfaces §5.2); the session expiry may bind
    // tighter, never the ceiling.
    check(
      "auth_mobile_session_handle_window",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '1800 seconds'`,
    ),
    check(
      "auth_mobile_session_handle_binding_shape",
      sql`(${table.issuer} is null) = (${table.subject} is null) and (${table.audience} <> '')`,
    ),
    check(
      "auth_mobile_session_handle_identity_generation_safe_integer",
      sql`(${table.identityGeneration} is null) or (${table.identityGeneration} >= 0 and ${table.identityGeneration} <= 9007199254740991)`,
    ),
    index("auth_mobile_session_handle_user_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

/*
 * T05.13 (#569, original task P12; interfaces §5.2 / F2): the per-action
 * admission fence. POST /api/enterprise/mobile/session/authorize writes one
 * row per admitted action, in the SAME transaction that re-verifies the
 * handle's session, account, binding and generation live — an admission
 * never exists for facts the transaction did not verify. The UNIQUE
 * (handle_digest, request_id) is the "仅当前动作一次" fence: a second
 * admission for the same requestId under the same handle is structurally
 * impossible, whatever raced. The server stores only the admissionId's
 * SHA-256; the plaintext leaves exactly once, in the authorize response.
 */
export const authMobileSessionAdmissions = pgTable(
  "auth_mobile_session_admissions",
  {
    /** SHA-256 hex of the admissionId; the plaintext never lands in the table. */
    admissionDigest: text("admission_digest").primaryKey(),
    /** The handle this admission rode on; the handle's death takes it along. */
    handleDigest: text("handle_digest")
      .notNull()
      .references(() => authMobileSessionHandles.handleDigest, {
        onDelete: "cascade",
      }),
    /** The caller's action id this admission is good for — once, ever. */
    requestId: text("request_id").notNull(),
    /** The whitelisted operation word the admission covers. */
    operation: text("operation").notNull(),
    /** The resource the action names, when it names one; opaque to the fence. */
    resourceId: text("resource_id"),
    createdAt: createdAt(),
  },
  (table) => [
    // The one-shot fence (0223): one admission per (handle, requestId).
    uniqueIndex("auth_mobile_session_admission_once").on(
      table.handleDigest,
      table.requestId,
    ),
    check(
      "auth_mobile_session_admission_shape",
      sql`${table.admissionDigest} ~ '^[0-9a-f]{64}$' and ${table.requestId} <> '' and length(${table.requestId}) <= 256 and ${table.operation} <> ''`,
    ),
    index("auth_mobile_session_admission_created_idx").on(table.createdAt),
  ],
);
