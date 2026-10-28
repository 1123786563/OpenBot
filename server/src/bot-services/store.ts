import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { botServices } from "../db/schema";
import {
  BOT_ID_PATTERN,
  BOT_SERVICE_CAPABILITY_ORDER,
  type BotServiceCapability,
  BotServiceConflictError,
  BotServiceInputError,
  type BotServiceKind,
  BotServiceNotFoundError,
  type BotServiceRecord,
} from "./types";

export {
  BOT_ID_PATTERN,
  BOT_SERVICE_CAPABILITY_ORDER,
  type BotServiceCapability,
  BotServiceConflictError,
  BotServiceInputError,
  type BotServiceKind,
  BotServiceNotFoundError,
  type BotServiceRecord,
};

/**
 * The violated constraint's name when `error` is a Postgres unique_violation (SQLSTATE 23505), else
 * null. Bun's driver puts the SQLSTATE in `errno` and the name in `constraint`; drizzle wraps the
 * driver error as `cause`. (Same helper the identity store uses, kept local so the two modules
 * stay independently readable.)
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; code?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (
      candidate?.errno === "23505" ||
      candidate?.errno === 23505 ||
      candidate?.code === "23505"
    )
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  }
  return null;
}

/**
 * A botId is a stable service identity, not a display string. The pattern itself lives in
 * types.ts (BOT_ID_PATTERN) so the route can refuse a malformed identity at the boundary, before
 * the store is asked anything; this is the store's own refusal for anything that reaches it.
 */
function normalizeBotId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    !BOT_ID_PATTERN.test(value)
  )
    throw new BotServiceInputError(
      "The botId is not a valid service identity.",
    );
  return value;
}

/** A display name is trimmed, non-blank, and capped at 200 code points without splitting pairs. */
const DISPLAY_NAME_MAX = 200;
function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new BotServiceInputError();
  const trimmed = value.trim();
  if (!trimmed) throw new BotServiceInputError();
  return Array.from(trimmed).slice(0, DISPLAY_NAME_MAX).join("");
}

function normalizeKind(value: unknown): BotServiceKind {
  if (value !== "builtin" && value !== "external")
    throw new BotServiceInputError("The kind must be builtin or external.");
  return value;
}

/**
 * A capability declaration is a non-empty array from the closed enum, with no duplicates. It is
 * stored in the registry's canonical order so two equal declarations always compare equal, in the
 * database and in every response.
 */
function normalizeCapabilities(value: unknown): BotServiceCapability[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BotServiceInputError(
      "Declare at least one capability for the bot service.",
    );
  const seen = new Set<BotServiceCapability>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !BOT_SERVICE_CAPABILITY_ORDER.includes(item as BotServiceCapability)
    )
      throw new BotServiceInputError(`Unknown capability: ${String(item)}`);
    if (seen.has(item as BotServiceCapability))
      throw new BotServiceInputError("A capability may be declared only once.");
    seen.add(item as BotServiceCapability);
  }
  return BOT_SERVICE_CAPABILITY_ORDER.filter((capability) =>
    seen.has(capability),
  );
}

function toRecord(row: typeof botServices.$inferSelect): BotServiceRecord {
  return {
    botId: row.botId,
    displayName: row.displayName,
    kind: row.kind,
    capabilities: [...row.capabilities] as BotServiceCapability[],
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The parts of an edit an administrator may change. The identity (`botId`, `kind`) never changes. */
export type BotServicePatch = {
  displayName?: string;
  capabilities?: BotServiceCapability[];
};

export function createBotServiceStore(database: Database) {
  return {
    /**
     * Register a bot service. Duplicate botIds are refused — and because rows are never deleted,
     * a refusal today is a refusal forever: a disabled Bot's identity is not a vacancy.
     *
     * Registration writes exactly one row in exactly one table. No credential is minted, no user
     * authorization is created and no credit is attached: those are later, separate acts by
     * different tickets (04.2, 04.5+), each with its own trail.
     */
    async register(input: {
      botId: unknown;
      displayName: unknown;
      kind: unknown;
      capabilities: unknown;
    }): Promise<BotServiceRecord> {
      const botId = normalizeBotId(input.botId);
      const displayName = normalizeDisplayName(input.displayName);
      const kind = normalizeKind(input.kind);
      const capabilities = normalizeCapabilities(input.capabilities);
      const now = new Date();
      try {
        const [row] = await database
          .insert(botServices)
          .values({
            botId,
            displayName,
            kind,
            capabilities,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return toRecord(row as typeof botServices.$inferSelect);
      } catch (error) {
        if (uniqueViolationConstraint(error) === "bot_services_pkey")
          throw new BotServiceConflictError();
        throw error;
      }
    },

    /** Change the declaration (name, capabilities). The identity is the row's key and never moves. */
    async update(
      botId: string,
      patch: BotServicePatch,
    ): Promise<BotServiceRecord> {
      const id = normalizeBotId(botId);
      // An empty patch declares nothing: return the current record instead of a
      // no-field UPDATE that would still bump updatedAt.
      if (patch.displayName === undefined && patch.capabilities === undefined) {
        const [row] = await database
          .select()
          .from(botServices)
          .where(eq(botServices.botId, id))
          .limit(1);
        if (!row) throw new BotServiceNotFoundError();
        return toRecord(row);
      }
      const set: { updatedAt: Date } & Partial<
        Pick<BotServicePatch, "displayName" | "capabilities">
      > = { updatedAt: new Date() };
      if (patch.displayName !== undefined)
        set.displayName = normalizeDisplayName(patch.displayName);
      if (patch.capabilities !== undefined)
        set.capabilities = normalizeCapabilities(patch.capabilities);
      const [row] = await database
        .update(botServices)
        .set(set)
        .where(eq(botServices.botId, id))
        .returning();
      if (!row) throw new BotServiceNotFoundError();
      return toRecord(row);
    },

    /**
     * Take the Bot out of service. Idempotent: disabling a disabled Bot returns the same record
     * rather than an error, because the state the caller asked for is the state that already is.
     * Downstream readers see `disabled` immediately — nothing here is cached.
     */
    async disable(botId: string): Promise<BotServiceRecord> {
      return setStatus(database, botId, "disabled");
    },

    /** Restore a disabled Bot to service. Idempotent the same way disable is. */
    async enable(botId: string): Promise<BotServiceRecord> {
      return setStatus(database, botId, "active");
    },

    /** The Bot's record, or null. The read 04.2 and 05.3 make before acting for a Bot. */
    async getBotService(botId: string): Promise<BotServiceRecord | null> {
      const id = normalizeBotId(botId);
      const [row] = await database
        .select()
        .from(botServices)
        .where(eq(botServices.botId, id));
      return row ? toRecord(row) : null;
    },

    /** Every registered Bot, builtin and external alike, oldest first. */
    async listBotServices(): Promise<BotServiceRecord[]> {
      const rows = await database
        .select()
        .from(botServices)
        .orderBy(asc(botServices.createdAt), asc(botServices.botId));
      return rows.map(toRecord);
    },
  };
}

async function setStatus(
  database: Database,
  botId: string,
  status: "active" | "disabled",
): Promise<BotServiceRecord> {
  const id = normalizeBotId(botId);
  const [row] = await database
    .update(botServices)
    .set({ status, updatedAt: new Date() })
    .where(eq(botServices.botId, id))
    .returning();
  if (!row) throw new BotServiceNotFoundError();
  return toRecord(row);
}

export type BotServiceStore = ReturnType<typeof createBotServiceStore>;
