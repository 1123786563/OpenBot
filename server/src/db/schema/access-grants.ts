/**
 * Model access grants (Bifrost #238, 04.5): one OpenBot user's authorization for one registered
 * Bot to call models as that person (CONTEXT.md: Model Access Grant).
 *
 * A row here is what a signed-in person's explicit confirmation produces — never a Bot's service
 * credential (that only proves which Bot is talking, 04.2), never a binding code (that only proves
 * one external identity, 04.3), and never a credit of any kind: creating the grant mints no key
 * and touches no balance. It is the unit ADR 0002 names — every "user × Bot authorization" gets
 * its own short-lived virtual Key (05.3), and all of a person's Keys spend the same personal
 * balance (02.4) — so `grant_id` is the stable id downstream key issuance (05.3) and reservation
 * revalidation (06.2) resolve from, and the unit 04.7 revokes on its own.
 *
 * Idempotency is the partial unique index: one *active* row per (user, Bot, external identity).
 * A repeated confirmation returns the row that already is (04.5), and a revoked grant stays in the
 * table forever — revocation is a status, not a deletion, exactly like the registry's — so a later
 * re-confirmation creates a new row beside the dead one and no history is ever overwritten.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { botServices } from "./bot-services";
import { enterprisePrincipals } from "./enterprise-tenancy";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/**
 * The one scope the confirmation flow (04.5) creates today: this Bot may call models on this
 * person's personal balance. A closed set, because scope is an admission surface — a value nobody
 * shipped must not be grantable, so a new scope arrives with its own ticket and migration, the
 * same rule the capability enum follows.
 */
export const MODEL_ACCESS_SCOPES = ["model-access"] as const;

/**
 * How a grant came to exist (Bifrost #241, 04.8): `binding-code` is the external Bot's flow — a
 * one-time code the person confirmed (04.5) — and `workbench-implicit` is the built-in workbench
 * Bot's, where the login session itself is the act of authorization. A closed set like scope:
 * source is what audit trails, listing screens and revocation sweeps read to tell the two kinds
 * apart, so an unshipped value must not be storable.
 */
export const MODEL_ACCESS_GRANT_SOURCES = [
  "binding-code",
  "workbench-implicit",
] as const;

/** One of the closed source values; how a grant came to exist (see {@link MODEL_ACCESS_GRANT_SOURCES}). */
export type AccessGrantSource = (typeof MODEL_ACCESS_GRANT_SOURCES)[number];

export const accessGrants = pgTable(
  "access_grants",
  {
    /** Stable, opaque, referenced by 05.3's keys and 06.2's revalidation; never reused. */
    grantId: text("grant_id").primaryKey(),
    /** The OpenBot user who confirmed (auth/guards.ts `AuthenticatedActor["id"]`). */
    userId: text("user_id").notNull(),
    /**
     * The principal the authorization is bound to (T02.04 / #526, design §4.2/§5.3,
     * interfaces §5.3: Model Access Grant 固定授权 user/principal/identityGeneration).
     * A personal grant is not company membership: PrincipalRegistry.ensure establishes
     * the principal in the principal lock layer for a user who has none, without joining
     * a company (design §5.3).
     *
     * Nullable at expand and deliberately NOT backfilled: a pre-T02.04 grant has no
     * verified source generation, and a missing version is "cannot compare" — M2/M3
     * re-verify and re-sign or revoke, never stamp from the current active state
     * (design §5.3: 旧 Grant/Key 无代际不自动补有效). Re-authorization revokes the
     * stale-active row and creates a NEW grantId with the current generation; the old
     * row keeps its (null) history and its references.
     */
    principalId: text("principal_id"),
    /** The source identity generation the grant was confirmed against; present exactly when principalId is. */
    identityGeneration: bigint("identity_generation", { mode: "number" }),
    /** The Bot this authorization is for. A disabled Bot (04.1) is refused downstream, not deleted here. */
    botId: text("bot_id")
      .notNull()
      .references(() => botServices.botId),
    /**
     * The external identity this authorization binds, exactly as the confirmed binding offer named
     * it — written by the confirmation from the code's own row, never from a client field (AC03).
     * An implicit grant names the login identity itself instead (`openbot:<userId>`, 04.8).
     */
    externalIdentity: text("external_identity").notNull(),
    /** What the authorization covers; see {@link MODEL_ACCESS_SCOPES}. */
    scope: text("scope").notNull(),
    /**
     * Which flow created this grant; see {@link MODEL_ACCESS_GRANT_SOURCES}. `binding-code` is
     * the default because every pre-04.8 row came from that flow and no other writer exists.
     */
    source: text("source")
      .$type<(typeof MODEL_ACCESS_GRANT_SOURCES)[number]>()
      .notNull()
      .default("binding-code"),
    /** `active` until 04.7 revokes it; revocation is a status, never a deletion. */
    status: text("status")
      .$type<"active" | "revoked">()
      .notNull()
      .default("active"),
    createdAt: at("created_at"),
    /** Null while active; the moment of revocation, forever after. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One active grant per (user, Bot, external identity): the idempotency 04.5 promises and the
    // concurrency race lands on, enforced by the database for every writer at once.
    uniqueIndex("access_grants_one_active_per_identity")
      .on(table.userId, table.botId, table.externalIdentity)
      .where(sql`status = 'active'`),
    // The questions the user-side list (04.7) and the admin's view ask.
    index("access_grants_user_idx").on(table.userId),
    index("access_grants_bot_idx").on(table.botId),
    check("access_grants_scope_check", sql`${table.scope} IN ('model-access')`),
    check(
      "access_grants_source_check",
      sql`${table.source} IN ('binding-code', 'workbench-implicit')`,
    ),
    check(
      "access_grants_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
    // The pair must agree: an active grant with a revocation date, or a revoked one without, is a
    // contradiction no writer may store.
    check(
      "access_grants_revoked_at_check",
      sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    // The source principal and its generation are written together by a confirmation
    // or not at all: a grant carries a comparable source exactly when it carries the
    // principal to compare against.
    check(
      "access_grants_principal_generation_pair",
      sql`(${table.principalId} IS NULL) = (${table.identityGeneration} IS NULL)`,
    ),
    check(
      "access_grants_identity_generation_safe_integer",
      sql`${table.identityGeneration} IS NULL OR (${table.identityGeneration} >= 0 AND ${table.identityGeneration} <= 9007199254740991)`,
    ),
    // NO ACTION on purpose: user deletion is not an open path (users cascade to
    // principals, design §4.3 "不能直接开放通用 DeleteUser"), and a revoked grant
    // must outlive its principal as history rather than vanish with it.
    foreignKey({
      name: "access_grants_principal_fk",
      columns: [table.principalId],
      foreignColumns: [enterprisePrincipals.id],
    }),
  ],
);
