import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { botServices } from "../db/schema/bots";

export type BotCapability = "chat" | "image" | "audio" | "embedding" | "realtime" | "async";
export const BOT_CAPABILITIES: readonly BotCapability[] = ["chat", "image", "audio", "embedding", "realtime", "async"];
export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class BotIdTakenError extends Error {
  constructor(public botId: string) { super(`botId "${botId}" is already registered and cannot be reused.`); }
}

export type BotServiceInput = { botId: string; displayName: string; kind: "builtin" | "external"; capabilities: BotCapability[] };

export function parseBotServiceInput(raw: {
  botId?: unknown; displayName?: unknown; kind?: unknown; capabilities?: unknown;
}): { ok: true; value: BotServiceInput } | { ok: false; error: string } {
  const botId = typeof raw.botId === "string" ? raw.botId.trim() : "";
  if (!BOT_ID_RE.test(botId)) return { ok: false, error: 'botId must match ^[a-z0-9][a-z0-9-]{1,63}$.' };
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (displayName === "" || displayName.length > 100) return { ok: false, error: "displayName must be 1–100 characters." };
  if (raw.kind !== "builtin" && raw.kind !== "external") return { ok: false, error: 'kind must be "builtin" or "external".' };
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  if (caps.length === 0 || !caps.every((c): c is BotCapability => BOT_CAPABILITIES.includes(c as BotCapability))) {
    return { ok: false, error: `capabilities must be a non-empty subset of ${BOT_CAPABILITIES.join(", ")}.` };
  }
  return { ok: true, value: { botId, displayName, kind: raw.kind, capabilities: caps } };
}

export async function registerBotService(database: Database, input: BotServiceInput): Promise<void> {
  const rows = await database.insert(botServices).values({
    botId: input.botId, displayName: input.displayName, kind: input.kind, capabilities: input.capabilities,
  }).onConflictDoNothing({ target: botServices.botId }).returning({ botId: botServices.botId });
  if (rows.length === 0) throw new BotIdTakenError(input.botId);
}

export async function listBotServices(database: Database) {
  return database.select().from(botServices).orderBy(asc(botServices.createdAt));
}

export async function setBotServiceStatus(database: Database, botId: string, status: "active" | "disabled") {
  await database.update(botServices).set({ status, updatedAt: new Date() }).where(eq(botServices.botId, botId));
}
