/*
 * The durable eligibility clocks (T02.02 / #524, original task P03; design
 * §4.2/§4.4 "持久撤权版本事实", interfaces §2).
 *
 * `auth_eligibility_clocks` is the persistent revocation-version fact the
 * directory commands keep beside the rebuildable projections. The BA directory
 * says who is a member *now*; it cannot say who was removed, or which
 * generation of a relationship an old grant was issued against. This table
 * holds that memory, keyed by stable business ids — never by a BA member id,
 * which is recreated on every re-join — and it is deliberately NOT part of the
 * projection: deleting and rebuilding the membership rows must leave it alone
 * (`projection_rebuild_does_not_reset_tombstone`).
 *
 * One row per stable key (tenant, principal, kind, scope):
 * - a company clock's scope IS its tenant (enforced by CHECK, so a malformed
 *   key cannot be stored by a writer that got the convention wrong);
 * - a team clock's scope is the workspace — a plain text key, not a foreign
 *   key, because the clock must outlive the team member row it versions, and a
 *   workspace's physical deletion is a first-phase-forbidden controlled
 *   archive, never a path this table rides on.
 *
 * Versions are the interfaces §2 `Version`: a non-negative safe integer,
 * 0..9007199254740991. Stored as bigint (not integer: the safe-integer range
 * does not fit) and bounded by CHECK, so a wrapped or negative value is refused
 * by the database. First establishment is 1 and every advance is written
 * explicitly by the controlled command functions (T02.03/T02.08) — hence no
 * defaults: a writer must state the version it is advancing to, and
 * `last_command_id` names the command that did. Monotonicity (never advancing
 * below the current version) is a write-path rule of those functions, not DDL.
 *
 * The clock grants nothing by existing: eligibility still depends on the BA
 * relationship, the company lifecycle and the global identity. What the clock
 * adds is the comparison a read gate or a grant re-validation needs to reject
 * an ability issued against an older generation.
 *
 * Expand only (M1): new table, no existing column changes. RLS policies, the
 * controlled write functions and the role grants belong to T02.06; this file
 * grants nothing and revokes nothing, so the legacy authority path keeps
 * working unchanged.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterprisePrincipals, enterpriseTenants } from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const authEligibilityClocks = pgTable(
  "auth_eligibility_clocks",
  {
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** The eligibility domain: company membership or membership of one team. */
    kind: text("kind").notNull(),
    /** The scope the kind names: the tenant itself for company, the workspace for team. */
    scopeId: text("scope_id").notNull(),
    /**
     * The relationship's version counter: established at 1, advanced by verified
     * eligibility/role changes and by re-joins. Safe-integer-bounded bigint.
     */
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    /**
     * The revocation generation: advanced by suspension, removal and permission
     * narrowing, and carried across re-joins — a re-joined member's abilities
     * issued against an older generation stay dead. Safe-integer-bounded bigint.
     */
    generation: bigint("generation", { mode: "number" }).notNull(),
    /**
     * True once the keyed relationship was revoked by a removal. Persistent: a
     * projection rebuild recreates invalid projections from tombstones, it
     * never clears them to make a rebuild look clean.
     */
    tombstone: boolean("tombstone").notNull().default(false),
    /** The command receipt that last established or advanced this clock. */
    lastCommandId: text("last_command_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The stable four-column key of design §4.4: one clock per principal per
    // kind per scope, inside one company. The same workspace id in two
    // companies is two clocks, not a collision, because the tenant leads the key.
    primaryKey({
      name: "auth_eligibility_clock_pk",
      columns: [table.tenantId, table.principalId, table.kind, table.scopeId],
    }),
    check(
      "auth_eligibility_clock_kind",
      sql`${table.kind} in ('company','team')`,
    ),
    // A company clock's scope is the company itself; anything else is a
    // malformed key a reader would silently misresolve.
    check(
      "auth_eligibility_clock_scope_matches_kind",
      sql`(${table.kind} <> 'company' or ${table.scopeId} = ${table.tenantId})`,
    ),
    check(
      "auth_eligibility_clock_epoch_safe_integer",
      sql`${table.epoch} >= 0 and ${table.epoch} <= 9007199254740991`,
    ),
    check(
      "auth_eligibility_clock_generation_safe_integer",
      sql`${table.generation} >= 0 and ${table.generation} <= 9007199254740991`,
    ),
    // The principal's clock history is the hottest read side of this table (a
    // read gate resolves a principal's scopes), and the cascade from a
    // principal deletion has to find its rows without a scan.
    index("auth_eligibility_clock_principal_idx").on(table.principalId),
    foreignKey({
      name: "auth_eligibility_clock_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_eligibility_clock_principal_fk",
      columns: [table.principalId],
      foreignColumns: [enterprisePrincipals.id],
    }).onDelete("cascade"),
  ],
);
