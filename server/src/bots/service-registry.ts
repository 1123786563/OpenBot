import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { botServices } from "../db/schema/bots";

/**
 * The bot-service registry (ticket 04.1, #234): the administrator-kept list of server-side
 * service identities. It is deliberately inert — a row here grants no credential, no model
 * access grant, no credit authority and no content permission. Those live in later tickets
 * (04.2 credentials, per-user grants), which consume `getBotService`/`listBotServices` and
 * refuse when the record is missing or `status !== "active"`.
 */

/** The closed capability enum a bot may declare (Q20: full coverage, text-only is not enough). */
export type BotCapability =
  | "chat"
  | "image"
  | "audio"
  | "embedding"
  | "realtime"
  | "async";

export const BOT_CAPABILITIES: readonly BotCapability[] = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

/** A botId is a DNS-ish slug: starts and ends alphanumeric, lowercase, 2–64 chars. */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export type BotServiceKind = "builtin" | "external";
export type BotServiceStatus = "active" | "disabled";

/** The registry contract handed to downstream tickets (#235, #238, #241). */
export type BotServiceRecord = {
  botId: string;
  displayName: string;
  kind: BotServiceKind;
  capabilities: BotCapability[];
  status: BotServiceStatus;
  createdAt: Date;
};

/** Thrown when a botId is already claimed — including by a disabled service: ids never recycle. */
export class BotIdTakenError extends Error {
  constructor(public readonly botId: string) {
    super(`botId "${botId}" is already registered and cannot be reused.`);
    this.name = "BotIdTakenError";
  }
}

export type BotServiceInput = {
  botId: string;
  displayName: string;
  kind: BotServiceKind;
  capabilities: BotCapability[];
};

/** The editable half of a registration: identity (botId, kind) is immutable, the label is not. */
export type BotServiceEdit = {
  displayName: string;
  capabilities: BotCapability[];
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseBotServiceInput(raw: {
  botId?: unknown;
  displayName?: unknown;
  kind?: unknown;
  capabilities?: unknown;
}): Parsed<BotServiceInput> {
  const botId = typeof raw.botId === "string" ? raw.botId.trim() : "";
  if (!BOT_ID_PATTERN.test(botId)) {
    return {
      ok: false,
      error: "botId must match ^[a-z0-9][a-z0-9-]{1,63}$ (lowercase slug, 2–64 chars).",
    };
  }
  const displayName =
    typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (displayName === "" || displayName.length > 100) {
    return { ok: false, error: "displayName must be 1–100 characters." };
  }
  if (raw.kind !== "builtin" && raw.kind !== "external") {
    return { ok: false, error: 'kind must be "builtin" or "external".' };
  }
  const capabilities = parseCapabilities(raw.capabilities);
  if (!capabilities.ok) return capabilities;
  return {
    ok: true,
    value: { botId, displayName, kind: raw.kind, capabilities: capabilities.value },
  };
}

export function parseBotServiceEdit(raw: {
  displayName?: unknown;
  capabilities?: unknown;
}): Parsed<BotServiceEdit> {
  const displayName =
    typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (displayName === "" || displayName.length > 100) {
    return { ok: false, error: "displayName must be 1–100 characters." };
  }
  const capabilities = parseCapabilities(raw.capabilities);
  if (!capabilities.ok) return capabilities;
  return { ok: true, value: { displayName, capabilities: capabilities.value } };
}

function parseCapabilities(raw: unknown): Parsed<BotCapability[]> {
  const capabilities = Array.isArray(raw) ? raw : [];
  if (
    capabilities.length === 0 ||
    !capabilities.every((capability): capability is BotCapability =>
      BOT_CAPABILITIES.includes(capability as BotCapability),
    )
  ) {
    return {
      ok: false,
      error: `capabilities must be a non-empty subset of ${BOT_CAPABILITIES.join(", ")}.`,
    };
  }
  return { ok: true, value: capabilities };
}

function toRecord(row: typeof botServices.$inferSelect): BotServiceRecord {
  return {
    botId: row.botId,
    displayName: row.displayName,
    kind: row.kind,
    capabilities: row.capabilities as BotCapability[],
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Claim a botId. The primary key — not a pre-check — decides uniqueness, so two concurrent
 * registrations of the same id cannot both win; the loser gets `BotIdTakenError`. A disabled
 * id is still a claimed id: there is no delete and no reuse.
 */
export async function registerBotService(
  database: Database,
  input: BotServiceInput,
): Promise<BotServiceRecord> {
  const rows = await database
    .insert(botServices)
    .values({
      botId: input.botId,
      displayName: input.displayName,
      kind: input.kind,
      capabilities: input.capabilities,
    })
    .onConflictDoNothing({ target: botServices.botId })
    .returning();
  if (rows.length === 0) throw new BotIdTakenError(input.botId);
  return toRecord(rows[0]);
}

/** One service by its id — `undefined` when unknown, so callers treat missing as refused. */
export async function getBotService(
  database: Database,
  botId: string,
): Promise<BotServiceRecord | undefined> {
  const rows = await database
    .select()
    .from(botServices)
    .where(eq(botServices.botId, botId));
  return rows.length === 0 ? undefined : toRecord(rows[0]);
}

/** Every registered service, oldest first — the admin list and downstream caches read this. */
export async function listBotServices(
  database: Database,
): Promise<BotServiceRecord[]> {
  const rows = await database
    .select()
    .from(botServices)
    .orderBy(asc(botServices.createdAt));
  return rows.map(toRecord);
}

/** Edit the mutable half (displayName, capabilities). `undefined` when the botId is unknown. */
export async function editBotService(
  database: Database,
  botId: string,
  edit: BotServiceEdit,
): Promise<BotServiceRecord | undefined> {
  const rows = await database
    .update(botServices)
    .set({ displayName: edit.displayName, capabilities: edit.capabilities, updatedAt: new Date() })
    .where(eq(botServices.botId, botId))
    .returning();
  return rows.length === 0 ? undefined : toRecord(rows[0]);
}

/** Flip status between active and disabled — the one lever; there is no delete. */
export async function setBotServiceStatus(
  database: Database,
  botId: string,
  status: BotServiceStatus,
): Promise<BotServiceRecord | undefined> {
  const rows = await database
    .update(botServices)
    .set({ status, updatedAt: new Date() })
    .where(eq(botServices.botId, botId))
    .returning();
  return rows.length === 0 ? undefined : toRecord(rows[0]);
}
