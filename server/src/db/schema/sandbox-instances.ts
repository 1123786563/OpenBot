import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { agents, users } from "./core";
import { enterpriseTenants } from "./enterprise-tenancy";

/**
 * The per-bot sandbox container lifecycle (P1-B): provisioning, ready, asleep, gone or failed.
 *
 * The database holds the facts the state machine owes durability to, and Docker holds the
 * containers themselves; the two are reconciled, not trusted to agree. `attempt_number` is the
 * CAS counter that makes durable provisioning safe: two replicas deciding to provision the same
 * bot race on this column, exactly one wins, and the loser reads back the winner's row.
 */
export type SandboxInstanceStatus =
  | "provisioning"
  | "ready"
  | "sleeping"
  | "terminated"
  | "failed";

export const sandboxInstances = pgTable(
  "sandbox_instances",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<SandboxInstanceStatus>()
      .notNull()
      .default("provisioning"),
    /** CAS counter for durable provisioning: rows compete on it, one attempt wins. */
    attemptNumber: integer("attempt_number").notNull().default(0),
    /** How the server reaches this container on the sandbox network, once it exists. */
    address: text("address"),
    /** Named-port map (opencode / webapp / devserver) allocated from the sandbox port pools. */
    ports: jsonb("ports").notNull().default({}),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    /** Renewed by the container's heartbeat; a stale one is a reaping candidate, not a verdict. */
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    /** Set when the container is torn down; the row stays for audit and reconcile bookkeeping. */
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Enterprise tenancy, nullable the same way every tenant-bearing table here is. */
    tenantId: text("tenant_id").references(() => enterpriseTenants.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /*
     * The supervisor's working set: "which containers does this bot have, in what state". Partial
     * over the live states so the index stays small — terminated and failed rows accumulate and
     * answer no lookup. At most one live instance per bot is enforced by the state machine's CAS
     * plus the migration constraint, not by this index.
     */
    index("sandbox_instances_bot_status_idx")
      .on(table.botId, table.status)
      .where(sql`${table.status} IN ('provisioning', 'ready', 'sleeping')`),
    index("sandbox_instances_tenant_idx").on(table.tenantId),
    check(
      "sandbox_instances_status_check",
      sql`${table.status} IN ('provisioning', 'ready', 'sleeping', 'terminated', 'failed')`,
    ),
  ],
);
