/*
 * The company authentication challenge and proof storage (T02.05 / #527,
 * original task P03; design §9.1 "公司认证证据与追加认证", Global Constraints
 * "公司 challenge 最长 600 秒、proof 使用签名声明真实认证时间"; interfaces
 * §5's VerifiedSsoEvidence / CompanyAssurance).
 *
 * Two halves of one protocol, deliberately shaped the way the verified
 * evidence bridge (T01.06/T01.07) consumes them:
 *
 * - `auth_company_auth_challenges` is the one-time server record the §9.1
 *   gate issues: it FIXES the original user and session, the target tenant,
 *   the allowed provider, the protocol and the policy revision at issue time,
 *   and carries the protocol correlation material only as the state's digest
 *   plus one sealed envelope — the raw nonce, the PKCE verifier and the SAML
 *   request binding are never stored in the clear, so a database leak gives
 *   an attacker no usable token. The 600-second ceiling on the challenge age
 *   is a CHECK, not writer discipline.
 * - `auth_company_session_assurances` is the proof: what a VERIFIED callback
 *   earns — the real IdP-authenticated time, the normalized strength, the
 *   issuance generations and the policy revision the read gate compares at
 *   use time. It binds the FINAL session (after a BA rotation the proof moves
 *   to the new session, §9.1 step 4) and the global principal, never the
 *   active organization or the account email.
 *
 * The binding is immutable across accounts and companies at the database
 * level, not just in service code: the proof carries a composite foreign key
 * on (challenge_id, user_id, tenant_id, provider_id, authentication_method)
 * pointing at the challenge's own unique binding index, so a consumed
 * challenge cannot be re-pointed at another user, company, provider or
 * protocol, and a proof cannot ride a challenge issued to someone else —
 * exactly the discipline `auth_team_bindings` applies to team bindings.
 * Session is deliberately NOT in that key: rotation is legal, everything
 * else is not.
 *
 * Consumption is a status, never a deletion: the store's at-most-once answer
 * (the T01.06/T01.07 `SsoChallengeStore.consume` port) is the atomic
 * conditional UPDATE on `consumed_at` — one statement, row-locked, the second
 * consumer matches zero rows. Keeping the row is what lets the proof's
 * foreign key pin the binding for good and leaves the audit trail behind.
 *
 * Two design decisions review r1 pinned, recorded here deliberately:
 *
 * - The challenge's `session_id` is HISTORICAL TEXT, not a foreign key — the
 *   T02.01 precedent ("sessions are ephemeral, receipts are not"). A session
 *   row's deletion is how an old session dies (`sessions` has no status
 *   column), and §9.1 step 4's rotation must leave that possible: after the
 *   proof binds the final session, deleting the OLD session succeeds and
 *   removes nothing, while deleting the FINAL session cascades its proofs
 *   away. The challenge's lifecycle therefore rides only its user and tenant
 *   cascades, and the proof→challenge composite foreign key stays the
 *   permanent anchor. Corollary, also explicit: the proof's revocation
 *   status governs LOGICAL expiry while its session lives — it is not, and
 *   must not be, a guard against physically deleting an ephemeral session
 *   row; a proof whose session is gone is unusable and unworth keeping.
 * - The challenge's `protocol` and the proof's `authentication_method` are
 *   one and the same fact under two §9.1 spellings, and the composite
 *   foreign key enforces them equal. P11 must confirm this one-to-one
 *   mapping before it consumes the table: if a later contract needs to
 *   record a distinct "real authentication method" (break-glass records its
 *   own), that is a schema change, not a value this column can absorb.
 *
 * `(session_id, tenant_id)` is the §9.1 current-proof key: ONE active proof
 * per session per company, enforced by a partial unique index, with history
 * kept as revocation status (`revoked_at`), the same never-a-deletion
 * discipline the grants follow. The proof's `expires_at` is the write path's
 * min(session expiry, authenticated_at + company maxAuthAge) (P11 computes
 * it); the database pins its floor — an expiry before the real
 * authentication time is not storable.
 *
 * Every constraint is explicitly named so the typed schema, the migration
 * and the journal agree by name. The provider registry and the company
 * auth-policy model do not exist yet (later tasks own them), so `provider_id`
 * is plain text here — exactly as `auth_command_receipts.actor_binding_id`
 * and `auth_provisioning_rules.binding_id` are. Roles, RLS policies and the
 * controlled write functions belong to T02.06/P11; this file adds only the
 * expand-stage tables, grants nothing and revokes nothing, so the legacy
 * authority path keeps working unchanged.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./core";
import { enterprisePrincipals, enterpriseTenants } from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One issued company-auth challenge: the §9.1 step-2 server record, single
 * use, at most 600 seconds alive.
 *
 * `state_digest` is the digest of the correlation token (the OIDC `state` or
 * the SAML `RelayState`) — the bridge's `consume(state)` resolves the row by
 * digest, so the token itself is never stored and the digest is unique: the
 * same correlation token cannot be re-issued as another user's or another
 * company's challenge. `secret_envelope` is the sealed protocol material
 * (nonce, PKCE verifier, request binding); P11 owns the cipher, the table
 * owns the contract: protected bytes only, no plaintext secret column
 * exists to write into.
 *
 * The binding unique index is the referenced side of the proof's composite
 * foreign key — it is what makes "a challenge cannot be re-bound" a database
 * fact. The session foreign key keeps the challenge tied to the session the
 * gate authenticated; the (session belongs to this user) pairing is the
 * write path's check, the same way the receipts pair actor fields.
 */
export const authCompanyAuthChallenges = pgTable(
  "auth_company_auth_challenges",
  {
    challengeId: text("challenge_id").notNull(),
    /** The user the gate authenticated when it issued the challenge. */
    userId: text("user_id").notNull(),
    /**
     * The original session the challenge was issued in — fixed, never
     * rotated. Historical text with NO foreign key (sessions are ephemeral,
     * the challenge is the record): deleting that session must succeed and
     * must not cascade or block here.
     */
    sessionId: text("session_id").notNull(),
    /** The company the proof will unlock. */
    tenantId: text("tenant_id").notNull(),
    /** The provider the policy allowed; the registry is a later task's. */
    providerId: text("provider_id").notNull(),
    /** The protocol flow the challenge drives; closed to the two the bridge verifies. */
    protocol: text("protocol").notNull(),
    /** The company auth policy's revision at issue time; compared again at callback. */
    policyRevision: bigint("policy_revision", { mode: "number" }).notNull(),
    /** The site-local return path; only in-site paths are accepted (write path). */
    returnPath: text("return_path").notNull(),
    /** SHA-256 of the correlation token — the only form of it this table keeps. */
    stateDigest: text("state_digest").notNull(),
    /** Sealed protocol secrets (nonce/PKCE/request binding); never plaintext. */
    secretEnvelope: text("secret_envelope").notNull(),
    /** Hard ceiling: at most 600 seconds after creation (CHECK, not discipline). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set exactly once by the store's atomic conditional UPDATE; null until then. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "auth_company_auth_challenge_pk",
      columns: [table.challengeId],
    }),
    uniqueIndex("auth_company_auth_challenge_state_uq").on(table.stateDigest),
    // The referenced side of the proof's binding foreign key: one row per
    // (challenge, user, tenant, provider, protocol), trivially unique through
    // the challenge id but existing so the proof can pin the whole tuple.
    uniqueIndex("auth_company_auth_challenge_binding_uq").on(
      table.challengeId,
      table.userId,
      table.tenantId,
      table.providerId,
      table.protocol,
    ),
    check(
      "auth_company_auth_challenge_protocol",
      sql`${table.protocol} in ('oidc','saml')`,
    ),
    check(
      "auth_company_auth_challenge_policy_revision_safe_integer",
      sql`${table.policyRevision} >= 0 and ${table.policyRevision} <= 9007199254740991`,
    ),
    // The Global Constraints' ceiling: 600 seconds, inclusive; and a
    // challenge cannot be born expired.
    check(
      "auth_company_auth_challenge_max_age",
      sql`${table.expiresAt} <= ${table.createdAt} + interval '600 seconds'`,
    ),
    check(
      "auth_company_auth_challenge_expires_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "auth_company_auth_challenge_consumed_after_creation",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
    index("auth_company_auth_challenge_user_idx").on(table.userId),
    // A lookup index, not a cascade path: the store resolves a session's
    // live challenges; the session's own deletion rides no reference here.
    index("auth_company_auth_challenge_session_idx").on(table.sessionId),
    foreignKey({
      name: "auth_company_auth_challenge_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_company_auth_challenge_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
  ],
);

/**
 * One proof of company authentication (§9.1's recommended
 * `auth_company_session_assurances`): the row a VERIFIED protocol callback
 * earns and every company-scoped read gate compares. The real authenticated
 * time and strength come from the signed IdP claims through the evidence
 * bridge — never the callback clock — and the issuance generations
 * (identity, company) plus the policy revision are what "exists and is
 * unexpired" is NOT enough: the gate compares them live.
 *
 * `challenge_id` is unique: the evidence↔challenge binding of the spec is
 * one-to-one, and the composite foreign key makes the proof's
 * user/tenant/provider/protocol identical to the challenge's — a proof for
 * another account or company is structurally unstoreable. `session_id` is
 * NOT in that key: after a BA session rotation the proof binds the final
 * session (§9.1 step 4), so only its own foreign key pins it.
 *
 * `(session_id, tenant_id)` with status 'active' is the current-proof key:
 * one current proof per session per company; re-authentication revokes the
 * old row and inserts the new one in the same transaction. Revocation is a
 * status, never a deletion.
 */
export const authCompanySessionAssurances = pgTable(
  "auth_company_session_assurances",
  {
    assuranceId: text("assurance_id").notNull(),
    /** The global user the proof is for — never the active organization. */
    userId: text("user_id").notNull(),
    /** The user's stable principal; the read gate compares identityGeneration against it. */
    principalId: text("principal_id").notNull(),
    /** The FINAL session after any rotation; proofs die with their session. */
    sessionId: text("session_id").notNull(),
    /** The company this proof unlocks; company A's proof says nothing about company B. */
    tenantId: text("tenant_id").notNull(),
    /** The challenge this proof consumed — unique, one-to-one with the evidence. */
    challengeId: text("challenge_id").notNull(),
    /** The provider that produced the verified evidence. */
    providerId: text("provider_id").notNull(),
    /** §9.1's authentication_method: the protocol flow that was actually verified. */
    authenticationMethod: text("authentication_method").notNull(),
    /** The IdP's issuer, from the signed payload. */
    issuer: text("issuer").notNull(),
    /** The IdP's subject, mapped to this user by the server's own binding. */
    subject: text("subject").notNull(),
    /** The real authentication time from the signed claims — not the callback time. */
    authenticatedAt: timestamp("authenticated_at", {
      withTimezone: true,
    }).notNull(),
    /** The provider's trusted mapping of acr/amr/AuthnContext; P11 normalizes. */
    strength: text("strength").notNull(),
    /** min(session expiry, authenticated_at + company maxAuthAge) at issuance; P11 computes. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** The policy revision the proof was issued under; a changed policy makes it stale. */
    policyRevision: bigint("policy_revision", { mode: "number" }).notNull(),
    /** The identity generation at issuance; compared live, never assumed. */
    identityGeneration: bigint("identity_generation", {
      mode: "number",
    }).notNull(),
    /** The company-eligibility generation at issuance. */
    companyGeneration: bigint("company_generation", {
      mode: "number",
    }).notNull(),
    /** `active` until revoked — by rotation, session loss, or a newer proof. */
    status: text("status").notNull().default("active"),
    /** Null while active; the moment of revocation, forever after. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "auth_company_session_assurance_pk",
      columns: [table.assuranceId],
    }),
    // The evidence↔challenge binding is one-to-one (spec §9.1 / P01's proof
    // discipline): one proof per challenge, ever.
    uniqueIndex("auth_company_session_assurance_challenge_uq").on(
      table.challengeId,
    ),
    // The §9.1 current-proof key: one ACTIVE proof per (session, company).
    uniqueIndex("auth_company_session_assurance_current_uq")
      .on(table.sessionId, table.tenantId)
      .where(sql`${table.status} = 'active'`),
    check(
      "auth_company_session_assurance_authentication_method",
      sql`${table.authenticationMethod} in ('oidc','saml')`,
    ),
    check(
      "auth_company_session_assurance_status",
      sql`${table.status} in ('active','revoked')`,
    ),
    check(
      "auth_company_session_assurance_status_with_time",
      sql`(${table.status} = 'active') = (${table.revokedAt} is null)`,
    ),
    check(
      "auth_company_session_assurance_policy_revision_safe_integer",
      sql`${table.policyRevision} >= 0 and ${table.policyRevision} <= 9007199254740991`,
    ),
    check(
      "auth_company_session_assurance_identity_generation_safe_integer",
      sql`${table.identityGeneration} >= 0 and ${table.identityGeneration} <= 9007199254740991`,
    ),
    check(
      "auth_company_session_assurance_company_generation_safe_integer",
      sql`${table.companyGeneration} >= 0 and ${table.companyGeneration} <= 9007199254740991`,
    ),
    // The validity floor of §9.1: a proof expires strictly after the real
    // authentication it certifies — the maxAuthAge/session-expiry minimum is
    // the write path's; the ordering floor is the database's.
    check(
      "auth_company_session_assurance_expires_after_authentication",
      sql`${table.expiresAt} > ${table.authenticatedAt}`,
    ),
    index("auth_company_session_assurance_user_idx").on(table.userId),
    index("auth_company_session_assurance_principal_idx").on(
      table.tenantId,
      table.principalId,
    ),
    foreignKey({
      name: "auth_company_session_assurance_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_company_session_assurance_principal_fk",
      columns: [table.principalId],
      foreignColumns: [enterprisePrincipals.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_company_session_assurance_session_fk",
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_company_session_assurance_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    // The binding pin: user, company, provider and protocol must match the
    // consumed challenge exactly (session deliberately excluded — rotation).
    // NO ACTION, like the receipts' targets: the proof is the durable half.
    foreignKey({
      name: "auth_company_session_assurance_challenge_fk",
      columns: [
        table.challengeId,
        table.userId,
        table.tenantId,
        table.providerId,
        table.authenticationMethod,
      ],
      foreignColumns: [
        authCompanyAuthChallenges.challengeId,
        authCompanyAuthChallenges.userId,
        authCompanyAuthChallenges.tenantId,
        authCompanyAuthChallenges.providerId,
        authCompanyAuthChallenges.protocol,
      ],
    }),
  ],
);
