import type { ModelRef } from "./catalog";
import type { GatewayEndpointConfig } from "./endpoint-config";
import type { IssuedGatewayKey } from "./key-issuance";

/*
 * The CredentialBundle plaintext boundary (Bifrost 05.4, AC02/AC19): the short-lived virtual
 * key's plaintext has exactly ONE shape it ever rides — the bundle
 * {@link CredentialBundle} — and exactly ONE channel it ever rides on — the authenticated Bot
 * service door (`/api/bot-service/keys`, behind 04.2's guard). Everything else the flow
 * touches — logs, audit rows, stored records, status reads, error answers — carries either
 * nothing of the secret or a fragment too short to be reducible (the audit's four-hex
 * fingerprint), and this module gives both sides of that sentence their vocabulary:
 *
 * - the BUNDLE side: {@link buildCredentialBundle} assembles the five frozen fields and
 *   refuses to compose anything that is not the whole bundle, so a partial answer can never
 *   impersonate the contract;
 * - the BOUNDARY side: {@link credentialSecretVariants} enumerates what "a reducible piece of
 *   the secret" means operationally — the value itself, its URL/base64/base64url/hex
 *   encodings, and any prefix or suffix truncation long enough to narrow a search
 *   ({@link CREDENTIAL_SECRET_MIN_FRAGMENT}; a four-hex fingerprint stays below it on
 *   purpose) — and {@link redactCredentialSecrets} / {@link redactCredentialSecretsDeep}
 *   scrub those variants out of any text or structure a log, audit or error path is about to
 *   emit, while {@link gatewayKeyStatusView} freezes what a status answer may carry: expiry,
 *   version, status, the row's id — never the value, never a hash a value could be tested
 *   against.
 */

/** What every scrubbed occurrence of the secret reads as, anywhere it is caught. */
export const CREDENTIAL_BUNDLE_REDACTED = "[REDACTED:gateway-key]";

/**
 * The shortest piece of a secret this boundary treats as reducible. Fragments shorter than
 * this (the audit fingerprint's four hex characters) identify without narrowing a brute
 * force of a full-length random key, so they may name a key in an audit trail; anything at
 * or above this length is scrubbed wherever it is caught.
 */
export const CREDENTIAL_SECRET_MIN_FRAGMENT = 8;

/**
 * The frozen bundle contract (05.4 → 07.12): what a Bot server needs to call the gateway on
 * this authorization's behalf, answered once per claim. `secret` is the plaintext's only
 * ride; `endpoint` is the gateway base the Bot dials; `modelRefs` is the Bot's own
 * selectable set under 03.11's ModelRef contract; `expiresAt`/`credentialVersion` name the
 * key's term. Nothing else joins the answer — a consumer keying into this shape can treat
 * the five fields as exhaustive.
 */
export type CredentialBundle = {
  endpoint: string;
  modelRefs: ModelRef[];
  secret: string;
  expiresAt: string | null;
  credentialVersion: number;
};

/** Where the response layer reads the bundle's non-secret sides from. */
export type CredentialBundleSources = {
  /** 01.1's endpoint read — the gateway base the Bot server dials. */
  readGatewayEndpoint: () => Promise<GatewayEndpointConfig | undefined>;
  /**
   * The authenticated Bot's selectable refs (03.8's filter over 03.11's ModelRef contract),
   * resolved for this Bot's own declaration. An empty list is an answer; a throw is not.
   */
  listSelectableModels: (botId: string) => Promise<ModelRef[]>;
};

/**
 * Why a bundle could not be completed. Fixed constants, displayable anywhere, none built
 * from upstream data — the reason discipline every adapter on this surface keeps. Both
 * arrive after the key was minted (the orphan is inert: its plaintext was never delivered,
 * and the caller's retry becomes the next credentialVersion), so neither names the key.
 */
export type CredentialBundleUnavailableReason =
  | "bundle_endpoint_unconfigured"
  | "bundle_models_unavailable";

export class CredentialBundleUnavailableError extends Error {
  readonly reasonCode: CredentialBundleUnavailableReason;

  constructor(reasonCode: CredentialBundleUnavailableReason, message: string) {
    super(message);
    this.name = "CredentialBundleUnavailableError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Assemble the one answer the plaintext rides on. The inputs are already resolved; this is
 * the shape check that keeps a partial bundle from ever wearing the contract's name.
 */
export function buildCredentialBundle(input: {
  endpointConfig: GatewayEndpointConfig;
  modelRefs: ModelRef[];
  issued: IssuedGatewayKey;
}): CredentialBundle {
  const endpoint = input.endpointConfig.baseUrl.trim();
  if (!endpoint) {
    throw new CredentialBundleUnavailableError(
      "bundle_endpoint_unconfigured",
      "No gateway address is configured, so the credential bundle cannot be completed.",
    );
  }
  return {
    endpoint,
    modelRefs: input.modelRefs,
    secret: input.issued.secret,
    expiresAt: input.issued.expiresAt,
    credentialVersion: input.issued.credentialVersion,
  };
}

/**
 * The status-query contract (05.4 → 05.10 and every read that names a key to a person):
 * expiry, version, status and the row's own id — the whole of what a status answer may
 * carry. Typed on the stored row so a status route reads a row and passes it here; the view
 * has no field a plaintext could hide in, and `valueHash` deliberately stays behind: a hash
 * of the secret is a verification oracle no status screen needs.
 */
export type GatewayKeyStatusRow = {
  id: string;
  status: string;
  expiresAt: Date | string | null;
  credentialVersion: number;
};

export type GatewayKeyStatusView = {
  keyId: string;
  status: string;
  expiresAt: string | null;
  credentialVersion: number;
};

export function gatewayKeyStatusView(
  row: GatewayKeyStatusRow,
): GatewayKeyStatusView {
  return {
    keyId: row.id,
    status: row.status,
    expiresAt:
      row.expiresAt instanceof Date
        ? row.expiresAt.toISOString()
        : (row.expiresAt ?? null),
    credentialVersion: row.credentialVersion,
  };
}

/**
 * Every form the secret could surface in and still be the secret: the value itself, its
 * percent/base64/base64url/hex encodings, and every prefix or suffix truncation from
 * {@link CREDENTIAL_SECRET_MIN_FRAGMENT} up to full length. Encodings of truncations are
 * covered by scanning each emitted text against the whole list (a truncated fragment's
 * encoding is the encoding of a listed fragment only when the fragment is listed — which it
 * is, at every length).
 */
export function credentialSecretVariants(secret: string): string[] {
  if (!secret) return [];
  const variants = new Set<string>([secret]);
  const encodingsOf = (value: string): string[] => {
    const bytes = Buffer.from(value, "utf8");
    return [
      encodeURIComponent(value),
      encodeURI(value),
      bytes.toString("base64"),
      bytes.toString("base64url"),
      bytes.toString("hex"),
    ];
  };
  for (const variant of encodingsOf(secret)) variants.add(variant);
  for (let end = CREDENTIAL_SECRET_MIN_FRAGMENT; end < secret.length; end += 1) {
    for (const variant of encodingsOf(secret.slice(0, end))) variants.add(variant);
  }
  for (let start = 0; start <= secret.length - CREDENTIAL_SECRET_MIN_FRAGMENT; start += 1) {
    for (const variant of encodingsOf(secret.slice(start))) variants.add(variant);
  }
  return [...variants];
}

/**
 * Scrub every variant of the secret out of one string. Used on anything a log, audit or
 * error path is about to emit after a secret may have existed.
 */
export function redactCredentialSecrets(text: string, secret: string): string {
  if (!secret) return text;
  let scrubbed = text;
  for (const variant of credentialSecretVariants(secret)) {
    if (scrubbed.includes(variant)) {
      scrubbed = scrubbed.split(variant).join(CREDENTIAL_BUNDLE_REDACTED);
    }
  }
  return scrubbed;
}

/**
 * Scrub every string anywhere inside a JSON-ish structure — the shape log metadata and
 * audit payloads actually have. Arrays, plain objects and Date/other leaves are walked;
 * the structure's shape is preserved exactly.
 */
export function redactCredentialSecretsDeep<T>(value: T, secret: string): T {
  if (!secret) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactCredentialSecrets(node, secret);
    if (Array.isArray(node)) return node.map(walk);
    if (node instanceof Date) return node;
    if (node !== null && typeof node === "object") {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        scrubbed[key] = walk(entry);
      }
      return scrubbed;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Scour a thrown value for the secret in place — message and stack — so an error that
 * somehow absorbed the plaintext cannot carry it through a rethrow. The error's identity
 * (constructor, name, reason codes) is preserved: this is a redaction, not a replacement,
 * so the caller's instanceof dispatch above keeps working.
 */
export function scrubErrorOfCredentialSecret(
  error: unknown,
  secret: string | undefined,
): unknown {
  if (!secret || !(error instanceof Error)) return error;
  if (error.message) {
    error.message = redactCredentialSecrets(error.message, secret);
  }
  if (error.stack) {
    error.stack = redactCredentialSecrets(error.stack, secret);
  }
  return error;
}
