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
   * What a person reads when the server sent no message of its own.
   *
   * Name the entity in it — "Could not load coworkers" rather than "Request failed" — because this
   * is the sentence that reaches the screen when the server is the one that broke.
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
};

/** The header the enterprise scope middleware reads the tenant selector from. */
const TENANT_HEADER = "x-openbot-tenant";

/** The path prefix the enterprise API answers on; `/api/enterprise/v1` is its one mounted version. */
const ENTERPRISE_PATH_PREFIX = "/api/enterprise/";

/**
 * The tenant selector a request carries, or nothing.
 *
 * Same-origin here is a relative path on this app's own origin: a string that starts with exactly
 * one slash. An absolute URL names some other origin, and a `//host/path` URL does too — the
 * browser resolves it against a scheme, so its host is not ours. Only a relative enterprise path
 * with a selector may carry the header, and every other combination returns `undefined`, which
 * leaves the request's headers exactly as they were before `tenantId` existed.
 */
function tenantSelection(
  path: string,
  tenantId: string | undefined,
): string | undefined {
  if (tenantId === undefined) return undefined;
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  if (!path.startsWith(ENTERPRISE_PATH_PREFIX)) return undefined;
  return tenantId;
}

/**
 * The sentence a refusal carries, read out of either envelope this app answers with.
 *
 * The deployment APIs put a plain string in `error`; the enterprise API puts its closed error
 * object there — `{ code, request_id, retryable, summary }` on the wire
 * (server/src/enterprise/app.ts onError), with `message` the shape a plan text may name for it.
 * Both are one sentence to a person: read the string, or the readable field of the object, and
 * otherwise let the caller's fallback speak.
 */
async function refusalMessage(
  response: Response,
  fallback: string | undefined,
): Promise<string> {
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
  return fallback ?? "That request failed.";
}

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  const selection = tenantSelection(path, options.tenantId);
  const headers: Record<string, string> | undefined =
    options.body === undefined
      ? selection === undefined
        ? undefined
        : { [TENANT_HEADER]: selection }
      : selection === undefined
        ? { "content-type": "application/json" }
        : {
            "content-type": "application/json",
            [TENANT_HEADER]: selection,
          };
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
     * fallback is only for the cases where it sent none, or sent something that is not JSON.
     */
    throw new Error(await refusalMessage(response, options.fallback));
  }

  if (key === undefined) return response;

  // A 204 or a non-JSON body used to throw a bare SyntaxError, and `null` or an array body threw
  // a TypeError on property access. Malformed success is a failed request with the fallback.
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(options.fallback ?? "That request failed.");
  }
  return (body as Record<string, T>)[key];
}
