/**
 * The one place the browser talks to the API server.
 *
 * WHAT THIS REPLACES. Every read opened with the same four lines — fetch with `credentials`, check
 * `ok`, throw a sentence, unwrap the envelope — and every entity that wrote more than once grew its
 * own private copy of the same request helper: `agentRequest`, `componentRequest`, and two others,
 * identical apart from the fallback sentence. Four copies of one function is four places for the
 * `body.error` extraction to be forgotten, and it had been, in more than one of them.
 *
 * WHAT IT DOES NOT DO. It owns the transport and nothing about meaning. The envelope key and the
 * sentence a person reads are per-endpoint facts, so they stay at the call site — a client that
 * guessed the envelope would be a client that had to be argued with.
 */

export type ClientOptions = {
  /** Absent means GET. */
  method?: string;
  /** Serialised as JSON, which is also what sets the content type. */
  body?: unknown;
  /**
   * What a person reads when the server sent no message of its own, as a key in the `errors`
   * namespace — `"agents.load"` for "Could not load coworkers".
   *
   * This is the form every call site should use: the sentence is a person-facing string, the
   * person has a language, and lib code cannot know it at module scope. Translated at throw time
   * (see `fallbackText`), so the active language at the moment of failure is the one that speaks.
   * A plain `fallback` string still works for the callers not yet migrated, and wins over the
   * key so a migration can never change the words a screen was already showing.
   */
  fallbackKey?: string;
  /**
   * Interpolation values for `fallbackKey`, when the sentence has a variable part ("The computer
   * could not be {{action}}."). Values are plain strings; i18next interpolates them at read time,
   * which keeps the translated sentence out of the module graph just like the key does.
   */
  fallbackVars?: Record<string, string>;
  /**
   * What a person reads when the server sent no message of its own, as literal English.
   *
   * Superseded by `fallbackKey` for anything a person can see; kept because lib modules are also
   * imported by tests and by code paths that run before i18n has initialized, where a literal is
   * the honest value.
   */
  fallback?: string;
  /** For the calls a Bot makes on a person's behalf, which are abandoned when the turn is. */
  signal?: AbortSignal;
  /**
   * The tenant this request selects, sent as the enterprise API's per-request scope header
   * (`x-openbot-tenant`, read by the scope middleware at server/src/enterprise/app.ts). The
   * selector is an explicit argument carried per request — never a module-level "current tenant"
   * the client would attach behind a caller's back. It only ever rides a same-origin enterprise
   * path: anything else (another `/api/*`, an absolute URL, a protocol-relative one) drops it, so
   * tenant identity cannot leak to an origin the app never chose.
   */
  tenantId?: string;
  /**
   * The team this request selects, sent as the scope pair's second header (`x-openbot-workspace`,
   * read beside the tenant one — MT005 ruling #1: the headers only select; database membership
   * decides). Same discipline as `tenantId`: an explicit per-request argument, attached only to a
   * same-origin enterprise path, never a module-level "current team". The enterprise scope
   * resolver refuses a workspace without a tenant, so callers select both or neither.
   */
  workspaceId?: string;
  /**
   * Request headers the endpoint requires beyond the transport's own, such as an
   * `Idempotency-Key` on a confirm. Merged under the content-type and the scope selection so a
   * caller cannot spoof either by supplying a header here.
   */
  headers?: Record<string, string>;
};

/**
 * A non-ok answer from the server, carrying the facts a screen may need to branch on.
 *
 * THE MESSAGE IS UNCHANGED. Every caller that read `thrown.message` still reads the same sentence.
 * What is new is the status and the server's own sentence (null when it sent none), so a shelf can
 * tell "you may not see this" (401/403) from "the request never arrived" without parsing prose.
 */
export class ClientResponseError extends Error {
  readonly status: number;
  /** The readable sentence the server itself sent, or null when its body carried none. */
  readonly serverMessage: string | null;

  constructor(status: number, message: string, serverMessage: string | null) {
    super(message);
    this.name = "ClientResponseError";
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

/**
 * The sentence a failed request carries, resolved from whichever fallback the caller gave.
 *
 * The i18n import is dynamic and lazy on purpose: `client.ts` sits at the bottom of the module
 * graph (everything in `lib/` imports it), while `lib/i18n` imports every locale bundle. A static
 * import here would drag the bundles into every module that makes a request before the app has
 * decided anything about language, and a cycle would be one renamed import away. Resolved at
 * throw time instead — a module-level handle would capture the language at import time, which is
 * exactly the stale-translation bug this refactor exists to remove.
 *
 * When i18n has not initialized (unit tests importing a lib module directly), `t` returns the
 * key itself; the key losing to a missing translation is a fact about the test environment, and
 * the caller's English `fallback` — or the generic sentence — speaks instead.
 */
async function fallbackText(options: ClientOptions): Promise<string> {
  if (options.fallback !== undefined) return options.fallback;
  if (options.fallbackKey !== undefined) {
    const i18n = (await import("./i18n")).default;
    const vars = options.fallbackVars;
    const read = (lng?: string): string => {
      const opts: {
        ns: "errors";
        defaultValue: string;
        lng?: string;
        replace?: Record<string, string>;
      } = {
        ns: "errors",
        defaultValue: "",
      };
      if (lng !== undefined) opts.lng = lng;
      if (vars !== undefined) opts.replace = vars;
      return i18n.t(options.fallbackKey as string, opts);
    };
    if (i18n.isInitialized) {
      const translated = read();
      // An empty result means the key is missing from the bundle — a wiring mistake worth
      // seeing in dev, but a person should still get a sentence.
      if (translated !== "") return translated;
    }
    const english = read("en");
    return english !== "" ? english : "That request failed.";
  }
  return "That request failed.";
}

/** The headers the enterprise scope middleware reads the selection pair from (MT005 ruling #1). */
const TENANT_HEADER = "x-openbot-tenant";
const WORKSPACE_HEADER = "x-openbot-workspace";

/** The path prefix the enterprise API answers on; `/api/enterprise/v1` is its one mounted version. */
const ENTERPRISE_PATH_PREFIX = "/api/enterprise/";

/**
 * The selection headers a request carries, or nothing.
 *
 * Same-origin here is a relative path on this app's own origin: a string that starts with exactly
 * one slash. An absolute URL names some other origin, and a `//host/path` URL does too — the
 * browser resolves it against a scheme, so its host is not ours. Only a relative enterprise path
 * with a selector may carry the headers, and every other combination returns `undefined`, which
 * leaves the request's headers exactly as they were before the selectors existed.
 */
function scopeSelection(
  path: string,
  options: ClientOptions,
): Record<string, string> | undefined {
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  if (!path.startsWith(ENTERPRISE_PATH_PREFIX)) return undefined;
  const headers: Record<string, string> = {};
  if (options.tenantId !== undefined) headers[TENANT_HEADER] = options.tenantId;
  if (options.workspaceId !== undefined) {
    headers[WORKSPACE_HEADER] = options.workspaceId;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * The sentence a refusal carries, read out of either envelope this app answers with.
 *
 * The deployment APIs put a plain string in `error`; the enterprise API puts its closed error
 * object there — `{ code, request_id, retryable, summary }` on the wire
 * (server/src/enterprise/app.ts onError), with `message` the shape a plan text may name for it.
 * Both are one sentence to a person: read the string, or the readable field of the object. Null
 * means the server sent none, and the caller's fallback speaks instead.
 */
async function refusalText(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (typeof body?.error === "string") return body.error;
  if (body?.error !== null && typeof body?.error === "object") {
    const fields = body.error as Record<string, unknown>;
    for (const field of [fields.message, fields.summary]) {
      if (typeof field === "string" && field.length > 0) return field;
    }
  }
  return null;
}

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  const selection = scopeSelection(path, options);
  /*
   * Caller headers first, then the transport's own facts on top: a request cannot rename the
   * content type of its body or the scope it selects, which is the same discipline the scope
   * headers have had since they were introduced.
   */
  const merged: Record<string, string> = {};
  // HTTP header names are case-insensitive; normalize caller keys so a caller-sent
  // "Content-Type" or "X-Openbot-Tenant" variant replaces into the same slot instead
  // of appending a second, ambiguous header next to the transport's own value.
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    merged[name.toLowerCase()] = value;
  }
  if (options.body !== undefined) merged["content-type"] = "application/json";
  if (selection !== undefined) Object.assign(merged, selection);
  const headers = Object.keys(merged).length > 0 ? merged : undefined;
  return fetch(path, {
    method: options.method,
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A request whose failure is a value rather than a throw.
 *
 * For the endpoints where a refusal is the answer: the gateway declining a component call, or the
 * catalogue announcement that is allowed to come back empty. Those callers read the status
 * themselves, and turning a refusal into an exception would make the boundary working look like the
 * boundary breaking.
 */
export function tryClient(
  path: string,
  options: ClientOptions = {},
): Promise<Response> {
  return send(path, options);
}

/**
 * A request that throws when the server says no, carrying the server's own message.
 *
 * With a `key`, the JSON body is parsed and that key unwrapped, so a caller receives the payload
 * rather than the envelope it arrived in. Without one, the `Response` is returned for a caller that
 * only needed to know it worked.
 */
export async function client<T>(
  path: string,
  key: string,
  options?: ClientOptions,
): Promise<T>;
export async function client(
  path: string,
  options?: ClientOptions,
): Promise<Response>;
export async function client<T>(
  path: string,
  keyOrOptions?: string | ClientOptions,
  maybeOptions?: ClientOptions,
): Promise<T | Response> {
  const key = typeof keyOrOptions === "string" ? keyOrOptions : undefined;
  const options =
    (typeof keyOrOptions === "string" ? maybeOptions : keyOrOptions) ?? {};

  const response = await send(path, options);

  if (!response.ok) {
    /*
     * The server's message is the useful one: it names the field or the permission that failed. The
     * fallback is only for the cases where it sent none, or sent something that is not JSON. The
     * status and whether the sentence came from the server ride the error for callers that must
     * tell a refusal from transport trouble.
     */
    const serverMessage = await refusalText(response);
    throw new ClientResponseError(
      response.status,
      serverMessage !== null ? serverMessage : await fallbackText(options),
      serverMessage,
    );
  }

  if (key === undefined) return response;

  // A 204 or a non-JSON body used to throw a bare SyntaxError, and `null` or an array body threw
  // a TypeError on property access. Malformed success is a failed request with the fallback.
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(await fallbackText(options));
  }
  const unwrapped = (body as Record<string, T>)[key];
  if (unwrapped === undefined) {
    // JSON has no `undefined` value, so a missing key here is the server
    // answering a shape this caller never asked for — a malformed success,
    // handled like the malformed bodies above instead of a typed undefined
    // reaching the caller as if it were the payload. A stored `null` passes.
    throw new Error(await fallbackText(options));
  }
  return unwrapped;
}
