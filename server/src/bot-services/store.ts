/**
 * The Bot service registry's store (bifrost-5, 04.1 / #234).
 *
 * WHAT THIS IS. The one writer and reader of `bot_services`: an administrator's record that a Bot —
 * builtin or approved external — exists as a service identity, what capabilities it declared, and
 * whether it is active or disabled. `getBotService`/`listBotServices` are the contract 04.2 (service
 * authentication), 03.8 (capability filter) and 05.3 (per-authorization key issuance) consume.
 *
 * WHAT THIS IS NOT. It never creates a credential, a user authorization or any credit permission.
 * A registration is a fact about the deployment, not a grant to the Bot; a person's Model Access
 * Grant (04.5) is what lets a Bot spend credits, and nothing here can stand in for one.
 *
 * Uniqueness is the database's to enforce: `bot_id` is the primary key and there is no delete path,
 * so an id that has ever been used stays used. The store turns the constraint's violation into a
 * refusal with a sentence, including under the concurrent double registration the primary key —
 * not the store's bookkeeping — is what settles.
 */
import { asc, eq } from "drizzle-orm";
import { recordAuditEvent, type AuditStore } from "../audit";
import type { Database } from "../db/client";
import { botServices } from "../db/schema";

/** The capability declaration an administrator may pin, derived from the schema enum (one source). */
export const BOT_SERVICE_CAPABILITIES = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

export type BotServiceCapability = (typeof BOT_SERVICE_CAPABILITIES)[number];
export type BotServiceKind = "builtin" | "external";
export type BotServiceStatus = "active" | "disabled";

/** The whole truth about a registered Bot, as the contract in the ticket spells it and nothing more. */
export type BotServiceRecord = {
  botId: string;
  displayName: string;
  kind: BotServiceKind;
  capabilities: BotServiceCapability[];
  status: BotServiceStatus;
  registeredBy: string;
  disabledAt: Date | null;
  disabledBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BotServiceActor = { userId: string };

export type BotServiceRegisterInput = {
  botId: string;
  displayName: string;
  kind: BotServiceKind;
  capabilities: BotServiceCapability[];
};

export type BotServiceEditInput = {
  botId: string;
  displayName?: string;
  capabilities?: BotServiceCapability[];
};

/**
 * A refusal the HTTP layer can answer with its own status, the credential service's
 * `CredentialRefusedError` shape: a sentence a person can act on and the status it deserves.
 */
export class BotServiceRefusedError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BotServiceRefusedError";
    this.status = status;
  }
}

/** A botId is a service identity other systems embed in configuration and logs: readable, not wild. */
const BOT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MAX_DISPLAY_NAME = 200;

type StoredRow = typeof botServices.$inferSelect;

function toRecord(row: StoredRow): BotServiceRecord {
  return {
    botId: row.botId,
    displayName: row.displayName,
    kind: row.kind,
    capabilities: [...row.capabilities],
    status: row.status,
    registeredBy: row.registeredBy,
    disabledAt: row.disabledAt,
    disabledBy: row.disabledBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function refused(status: number, message: string): never {
  throw new BotServiceRefusedError(status, message);
}

function parseBotId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !BOT_ID_PATTERN.test(input) ||
    input.length > 64
  ) {
    refused(
      400,
      'botId must be 1-64 characters of lowercase letters, digits, ".", "_" or "-", starting and ending with a letter or digit.',
    );
  }
  return input;
}

function parseDisplayName(input: unknown, field = "displayName"): string {
  if (typeof input !== "string") {
    refused(400, `${field} must be a string.`);
  }
  const trimmed = input.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_DISPLAY_NAME) {
    refused(
      400,
      `${field} must be 1-${MAX_DISPLAY_NAME} characters after trimming.`,
    );
  }
  return trimmed;
}

function parseKind(input: unknown): BotServiceKind {
  if (input !== "builtin" && input !== "external") {
    refused(400, 'kind must be "builtin" or "external".');
  }
  return input;
}

function parseCapabilities(input: unknown): BotServiceCapability[] {
  if (!Array.isArray(input)) {
    refused(400, "capabilities must be an array.");
  }
  if (input.length === 0) {
    refused(400, "capabilities must declare at least one capability.");
  }
  const seen = new Set<string>();
  const parsed: BotServiceCapability[] = [];
  for (const value of input) {
    if (
      typeof value !== "string" ||
      !(BOT_SERVICE_CAPABILITIES as readonly string[]).includes(value)
    ) {
      refused(
        400,
        `capabilities contains "${String(value)}", which is not one of: ${BOT_SERVICE_CAPABILITIES.join(", ")}.`,
      );
    }
    if (seen.has(value)) {
      refused(400, `capabilities contains "${value}" more than once.`);
    }
    seen.add(value);
    parsed.push(value);
  }
  return parsed;
}

/** Postgres's unique-violation (SQLSTATE 23505). */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether a throw is that violation, wherever the layers wrapped it.
 *
 * Bun's driver throws a `PostgresError` with the SQLSTATE in `errno`; node-style drivers use `code`.
 * Drizzle hangs the driver error off `cause`, and neither layer's class is part of a published
 * surface worth an `instanceof` — so the shape is what this reads, the same way
 * `identity/audit-failure.ts` reads it. Only a Postgres error is trusted: a system errno such as
 * EPERM is also five characters and must not pass as a SQLSTATE.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      name?: unknown;
      errno?: unknown;
      code?: unknown;
    };
    if (candidate.name === "PostgresError") {
      for (const value of [candidate.errno, candidate.code]) {
        if (value === UNIQUE_VIOLATION) return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function rowFor(
  database: Database,
  botId: string,
): Promise<StoredRow | null> {
  const rows = await database
    .select()
    .from(botServices)
    .where(eq(botServices.botId, botId));
  return rows[0] ?? null;
}

async function mustExist(database: Database, botId: string): Promise<StoredRow> {
  const row = await rowFor(database, botId);
  if (!row) {
    refused(404, `No Bot service is registered with botId "${botId}".`);
  }
  return row;
}

export type BotServiceStore = {
  register: (
    input: BotServiceRegisterInput,
    actor: BotServiceActor,
  ) => Promise<BotServiceRecord>;
  edit: (
    input: BotServiceEditInput,
    actor: BotServiceActor,
  ) => Promise<BotServiceRecord>;
  disable: (botId: string, actor: BotServiceActor) => Promise<BotServiceRecord>;
  getBotService: (botId: string) => Promise<BotServiceRecord | null>;
  listBotServices: () => Promise<BotServiceRecord[]>;
};

export function createBotServiceStore(
  database: Database,
  auditStore: AuditStore,
): BotServiceStore {
  return {
    register: async (rawInput, actor) => {
      const input = rawInput as Record<string, unknown>;
      const botId = parseBotId(input.botId);
      const displayName = parseDisplayName(input.displayName);
      const kind = parseKind(input.kind);
      const capabilities = parseCapabilities(input.capabilities);

      // Refuse before the write when the answer is already known, so the duplicate refusal is a
      // sentence about the registry rather than a constraint error the caller unwraps. The race
      // still lands on the primary key, and that half is turned into the same refusal below.
      if (await rowFor(database, botId)) {
        refused(
          409,
          `A Bot service with botId "${botId}" is already registered, and a botId cannot be re-registered.`,
        );
      }

      let row: StoredRow;
      try {
        const inserted = await database
          .insert(botServices)
          .values({ botId, displayName, kind, capabilities, registeredBy: actor.userId })
          .returning();
        row = inserted[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          refused(
            409,
            `A Bot service with botId "${botId}" is already registered, and a botId cannot be re-registered.`,
          );
        }
        throw error;
      }

      await recordAuditEvent(auditStore, {
        eventType: "bot_service.registered",
        targetType: "bot_service",
        targetId: botId,
        actorUserId: actor.userId,
        payload: {
          displayName,
          kind,
          capabilities: [...capabilities],
        },
      });
      return toRecord(row);
    },

    edit: async (rawInput, actor) => {
      const input = rawInput as Record<string, unknown>;
      const botId = parseBotId(input.botId);
      const current = await mustExist(database, botId);

      const changingDisplayName = input.displayName !== undefined;
      const changingCapabilities = input.capabilities !== undefined;
      if (!changingDisplayName && !changingCapabilities) {
        refused(
          400,
          "An edit must change displayName or capabilities; kind and status are not editable here.",
        );
      }
      const displayName = changingDisplayName
        ? parseDisplayName(input.displayName)
        : current.displayName;
      const capabilities = changingCapabilities
        ? parseCapabilities(input.capabilities)
        : current.capabilities;

      const updated = await database
        .update(botServices)
        .set({ displayName, capabilities: [...capabilities], updatedAt: new Date() })
        .where(eq(botServices.botId, botId))
        .returning();

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (displayName !== current.displayName) {
        changes.displayName = { from: current.displayName, to: displayName };
      }
      if (
        capabilities.join(",") !== [...current.capabilities].join(",")
      ) {
        changes.capabilities = {
          from: [...current.capabilities],
          to: [...capabilities],
        };
      }
      await recordAuditEvent(auditStore, {
        eventType: "bot_service.edited",
        targetType: "bot_service",
        targetId: botId,
        actorUserId: actor.userId,
        payload: changes,
      });
      return toRecord(updated[0]);
    },

    disable: async (botIdValue, actor) => {
      const botId = parseBotId(botIdValue);
      const current = await mustExist(database, botId);
      if (current.status === "disabled") {
        refused(
          409,
          `The Bot service with botId "${botId}" is already disabled.`,
        );
      }
      const disabledAt = new Date();
      const updated = await database
        .update(botServices)
        .set({
          status: "disabled",
          disabledAt,
          disabledBy: actor.userId,
          updatedAt: disabledAt,
        })
        .where(eq(botServices.botId, botId))
        .returning();

      await recordAuditEvent(auditStore, {
        eventType: "bot_service.disabled",
        targetType: "bot_service",
        targetId: botId,
        actorUserId: actor.userId,
        payload: {
          status: { from: current.status, to: "disabled" },
          displayName: current.displayName,
        },
      });
      return toRecord(updated[0]);
    },

    getBotService: async (botIdValue) => {
      const row = await rowFor(database, parseBotId(botIdValue));
      return row ? toRecord(row) : null;
    },

    listBotServices: async () => {
      const rows = await database
        .select()
        .from(botServices)
        .orderBy(asc(botServices.createdAt), asc(botServices.botId));
      return rows.map(toRecord);
    },
  };
}
