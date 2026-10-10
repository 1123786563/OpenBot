import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Schema owned by the Marketplace: which packaged expert each person has installed, and the Bot
 * that installation created.
 *
 * A marketplace expert is a template, not a thing anybody owns a row of: installing one instantiates
 * a private Bot from it. This table is the receipt — the pair (person, expert slug) naming the Bot
 * that came out — because "installed" has to answer with a Bot id, not a boolean: the card that says
 * 已安装 is the one that can also say 去对话, and both facts live in the same row.
 */

/**
 * One person's installation of one catalogue expert.
 *
 * Unique per (person, expert): installing twice resolves to the Bot the first press created, so a
 * double-click cannot leave somebody with two identically-named Bots and no idea which is which.
 *
 * `agentId` cascades on Bot deletion — a person who deletes their installed Bot from the roster has
 * uninstalled the expert, and the marketplace card goes back to offering 安装. The row does not
 * survive the thing it is a receipt of.
 */
export const expertInstalls = pgTable(
  "expert_installs",
  {
    id: text("id").primaryKey(),
    /** The catalogue expert this row came from, as its slug in `marketplace/catalogue.ts`. */
    expertSlug: text("expert_slug").notNull(),
    /** The Bot the install created. Deleted with the Bot, per the cascade. */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Who installed it. The Bot is theirs, and only they see the row. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("expert_installs_owner_slug_key").on(
      table.ownerUserId,
      table.expertSlug,
    ),
    index("expert_installs_agent_idx").on(table.agentId),
  ],
);
