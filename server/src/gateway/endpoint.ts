/**
 * The gateway address rule, in one place with one set of sentences.
 *
 * Pure on purpose — no database, no HTTP — so the start-up environment (config.ts) and the
 * administrator save path (config-store.ts) refuse the same shapes with the same words, and a
 * person who hit the refusal in one place recognizes it in the other.
 *
 * The rule: an origin, and nothing else. http or https, no credentials in the URL, no path, query
 * or fragment — the gateway owns its own routes, so a deployment that names one with `/v1` glued
 * on has named the wrong thing, and every downstream path join would double it.
 */
export type GatewayEndpoint = { baseUrl: string; requestTimeoutMs: number };

export const GATEWAY_ENDPOINT_ERRORS = {
  missing: "Gateway base URL is required.",
  protocol: "Gateway base URL must be an http or https URL.",
  credentials: "Gateway base URL must not carry credentials.",
  path: "Gateway base URL must be the origin only, without a path, query or fragment.",
  timeout:
    "requestTimeoutMs must be a whole number of milliseconds greater than zero.",
  timeoutMaximum:
    "requestTimeoutMs must be no greater than 2147483647, the largest value a PostgreSQL integer column can store.",
} as const;

/** The address half alone, for callers that carry the timeout separately (the environment). */
export function parseGatewayBaseUrl(
  raw: unknown,
): { ok: true; baseUrl: string } | { ok: false; error: string } {
  const baseUrl = typeof raw === "string" ? raw.trim() : "";
  if (baseUrl === "")
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.missing };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.protocol };
  if (parsed.username || parsed.password)
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.credentials };
  if (parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search || parsed.hash)
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.path };
  return { ok: true, baseUrl: parsed.origin };
}

/** The largest timeout a save can carry: the gateway's `request_timeout_ms` column is an int4. */
const REQUEST_TIMEOUT_MS_MAX = 2_147_483_647;

/**
 * The connection-parameter half alone: a whole number of milliseconds greater than zero and no
 * greater than the column's largest integer, so an oversized value is refused with a sentence
 * here instead of by the database as an internal error.
 */
export function parseRequestTimeoutMs(
  raw: unknown,
): { ok: true; requestTimeoutMs: number } | { ok: false; error: string } {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.timeout };
  if (raw > REQUEST_TIMEOUT_MS_MAX)
    return { ok: false, error: GATEWAY_ENDPOINT_ERRORS.timeoutMaximum };
  return { ok: true, requestTimeoutMs: raw };
}

/** What an administrator submits: the two halves, both refused with their own reason. */
export function parseGatewayEndpointInput(raw: {
  baseUrl?: unknown;
  requestTimeoutMs?: unknown;
}): { ok: true; value: GatewayEndpoint } | { ok: false; error: string } {
  const baseUrl = parseGatewayBaseUrl(raw.baseUrl);
  if (!baseUrl.ok) return baseUrl;
  const timeout = parseRequestTimeoutMs(raw.requestTimeoutMs);
  if (!timeout.ok) return timeout;
  return {
    ok: true,
    value: { baseUrl: baseUrl.baseUrl, requestTimeoutMs: timeout.requestTimeoutMs },
  };
}
