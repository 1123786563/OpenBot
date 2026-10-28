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
export const BOT_SERVICE_CAPABILITY_ORDER = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

/** The union derives from the array, so the compile-time set and the runtime order are one fact:
 * a member added to the union alone cannot typecheck against the registry's closed-set check. */
export type BotServiceCapability =
  (typeof BOT_SERVICE_CAPABILITY_ORDER)[number];

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

/**
 * What 04.2's authentication answers (Bifrost #235): which Bot presented a valid service
 * credential, and the status that was checked live in the registry at that moment. On success the
 * status is always `active` — a disabled Bot is refused outright — and the shape carries nothing
 * else by design: no user, no account, no credit. A service identity proves which Bot is talking,
 * never for whom or on whose balance (CONTEXT.md: Registered Bot).
 */
export type BotServiceIdentity = {
  botId: string;
  status: BotServiceStatus;
};

/**
 * Every way bot service authentication can fail, said the same way.
 *
 * A wrong secret, an unregistered botId, a revoked credential and a disabled Bot all arrive as
 * this one class with this one message, so no caller — and no response — can tell an attacker
 * whether the botId they presented exists (AC: the failure answer must not distinguish "Bot does
 * not exist" from "credential wrong"). The class is the contract; there are deliberately no
 * subclasses for the reasons.
 */
export class BotServiceAuthFailureError extends Error {
  constructor(message = "Bot service authentication failed.") {
    super(message);
    this.name = "BotServiceAuthFailureError";
  }
}

/**
 * Too many failed presentations for one identity, inside the limiter's window. A distinct class
 * because the answer is genuinely different — retry later — but it still names no bot: the 429
 * the middleware answers carries the same silence about existence as the 401.
 */
export class BotServiceRateLimitedError extends Error {
  constructor(
    message = "Too many failed bot service authentications; retry later.",
  ) {
    super(message);
    this.name = "BotServiceRateLimitedError";
  }
}

/**
 * An administrator asked to rotate or revoke a Bot's service credential when the Bot has no live
 * one: rotation needs a credential to retire, and revoking twice revokes nothing the second time.
 * Not an auth failure — an administrator's honest bookkeeping question — so it is its own class,
 * and the route answers 409 rather than the authentication boundary's uniform 401.
 */
export class BotServiceCredentialMissingError extends Error {
  constructor() {
    super("That bot service has no live credential.");
    this.name = "BotServiceCredentialMissingError";
  }
}

/**
 * The confirming user's global identity is not active (T05.10 / #566, design §5.3): a personal
 * model grant binds the principal of an *active* user, so a suspended identity is refused whole —
 * before the confirmation consumes its code. Restoring the identity never revives the grants an
 * older generation issued; only an explicit re-authorization does.
 */
export class AccessGrantIdentityInactiveError extends Error {
  readonly code = "model_access_identity_inactive";
  constructor(message = "Your account is disabled and cannot authorize bots.") {
    super(message);
    this.name = "AccessGrantIdentityInactiveError";
  }
}
