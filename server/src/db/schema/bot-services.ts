/**
 * The Bifrost bot service registry: the server-side Bots an administrator has approved for
 * model access (Bifrost #234, 04.1).
 *
 * A row here is a service identity and nothing more. It is not a credential (04.2 mints those
 * separately, from the shared vault), not a user authorization and not a grant of anybody's
 * credits — a Bot spends a person's credits only through that person's own model access grant
 * (ADR 0002), and registering the Bot is the step that comes before any of that exists. The
 * registry's whole job is to answer "which Bots may present themselves to this deployment at
 * all, and what kinds of call do they declare themselves capable of".
 *
 * `kind` keeps built-in and external Bots in one model rather than two: the workbench Bot is
 * registered exactly like an outside one, because the difference between them is who operates
 * them, not what an identity means. `status` is the switch downstream authentication and key
 * issuance read (04.2, 05.x): a disabled Bot reads disabled here and is refused there.
 *
 * `bot_id` is the primary key, and rows are never deleted — disabling is the whole of taking a
 * Bot out of service — so a botId can never be reused, not even after its Bot is gone from
 * every list a person sees. A service identity that could be handed to a different Bot would
 * make every audit row and every future credential ambiguous about which Bot it was about.
 */
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/**
 * The call kinds a Bot may declare (the parent spec's Q20). The check is the restricted enum the
 * ticket names: a capability outside this list cannot be stored, by the store or by anything else.
 */
export const BOT_SERVICE_CAPABILITIES = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

export const botServices = pgTable(
  "bot_services",
  {
    /** The Bot's stable, globally unique service identity. Immutable once written. */
    botId: text("bot_id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** `builtin` for OpenBot's own Bots, `external` for approved outside ones. Immutable. */
    kind: text("kind").$type<"builtin" | "external">().notNull(),
    /** A non-empty subset of {@link BOT_SERVICE_CAPABILITIES}, in the registry's canonical order. */
    capabilities: text("capabilities").array().notNull(),
    /** `active` or `disabled`; disabled means every downstream refuses this Bot. */
    status: text("status")
      .$type<"active" | "disabled">()
      .notNull()
      .default("active"),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
  },
  (table) => [
    check(
      "bot_services_kind_check",
      sql`${table.kind} IN ('builtin', 'external')`,
    ),
    check(
      "bot_services_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
    check(
      "bot_services_capabilities_check",
      sql`${table.capabilities} <@ ARRAY['chat','image','audio','embedding','realtime','async']::text[]`,
    ),
  ],
);
