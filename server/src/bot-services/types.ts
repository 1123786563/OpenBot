/**
 * The Bifrost bot service registry's own vocabulary (Bifrost #234, 04.1).
 *
 * These are the contract the downstream tickets consume: 04.2 authenticates a Bot's service
 * credential and then reads its record here to learn which Bot it is and whether it is still
 * enabled; 05.3 refuses key issuance for a disabled Bot; 03.8 attributes a call to the Bot whose
 * identity this is. The record deliberately carries no credential, user or credit of any kind —
 * a service identity says which Bot is talking, never for whom or on whose balance.
 */

/** A call kind a Bot may declare itself capable of. The closed set the registry stores. */
export type BotServiceCapability =
  | "chat"
  | "image"
  | "audio"
  | "embedding"
  | "realtime"
  | "async";

/** The registry's canonical order, so equal declarations always compare equal. */
export const BOT_SERVICE_CAPABILITY_ORDER: readonly BotServiceCapability[] = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
];

/**
 * A botId is a stable service identity, not a display string: lowercase letters, digits and the
 * separators a reverse-domain or slug id needs (`.` `_` `-` `:`), starting alphanumeric, at most
 * 128 characters, never padded with whitespace (padding is not trimmed away silently — ` bot` and
 * `bot` being the same Bot would be a surprise, not a convenience). Exported so the admin route can
 * refuse a malformed identity at the public boundary, before the store is asked anything.
 */
export const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export type BotServiceKind = "builtin" | "external";

export type BotServiceStatus = "active" | "disabled";

/** One registered Bot. This is the whole of what registration produces — no credential, no grant. */
export type BotServiceRecord = {
  /** The Bot's stable, globally unique service identity. Never reused, even after disabling. */
  botId: string;
  displayName: string;
  kind: BotServiceKind;
  /** A non-empty subset of the capability enum, in canonical order. */
  capabilities: BotServiceCapability[];
  status: BotServiceStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** A malformed registration or edit: bad botId, blank name, unknown capability, wrong kind. */
export class BotServiceInputError extends Error {
  constructor(message = "The bot service declaration is not valid.") {
    super(message);
    this.name = "BotServiceInputError";
  }
}

/** A botId that is already registered. botIds are never reusable, so this is terminal. */
export class BotServiceConflictError extends Error {
  constructor() {
    super("That botId is already registered and cannot be reused.");
    this.name = "BotServiceConflictError";
  }
}

/** A botId the registry has never held. */
export class BotServiceNotFoundError extends Error {
  constructor() {
    super("No bot service is registered under that botId.");
    this.name = "BotServiceNotFoundError";
  }
}
