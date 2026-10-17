/**
 * One-time binding offers between a registered Bot and one external identity (Bifrost #236, 04.3).
 *
 * A row here is what a Bot's authenticated server receives when it asks to start binding a person
 * in: a high-entropy code it can hand to that one external identity. The code itself is never
 * stored — only its sha256 digest is, so a database read cannot redeem anything — and the row is
 * bound to the issuing `bot_id` and the `external_identity_hint` the Bot named, so a code is a
 * claim ticket for exactly one (Bot, identity) pair and never a universal one.
 *
 * `single_use` is the default and the contract: one offer, one confirmation (04.5). `status`
 * records what became of an offer — `pending` until a downstream ticket consumes, redeems or
 * revokes it. Expiry is data, not a status: an expired offer is simply one whose `expires_at` has
 * passed, the same shape `identity_link_challenges` uses.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { botServices } from "./bot-services";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const botBindingOffers = pgTable(
  "bot_binding_offers",
  {
    /** sha256 of the issued code, hex. The plaintext lives only in the issuance response. */
    codeHash: text("code_hash").primaryKey(),
    /** The Bot the offer belongs to. A code binds to this Bot and nothing else. */
    botId: text("bot_id")
      .notNull()
      .references(() => botServices.botId),
    /** The external identity the Bot asked to bind, as the Bot knows it. Never an OpenBot user id. */
    externalIdentityHint: text("external_identity_hint").notNull(),
    /** One offer, one confirmation. False only if a later ticket ever needs a multi-use offer. */
    singleUse: boolean("single_use").notNull().default(true),
    /** `pending` until consumed downstream (redeemed or revoked); expiry is `expires_at`, not a status. */
    status: text("status")
      .$type<"pending" | "redeemed" | "revoked">()
      .notNull()
      .default("pending"),
    issuedAt: at("issued_at"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Which Bots hold live offers — the question an administrator and the confirmation flow ask.
    index("bot_binding_offers_bot_idx").on(table.botId),
    // Expiry sweeps read by time, the way identity_link_challenges does.
    index("bot_binding_offers_expiry_idx").on(table.expiresAt),
    check(
      "bot_binding_offers_status_check",
      sql`${table.status} IN ('pending', 'redeemed', 'revoked')`,
    ),
  ],
);
