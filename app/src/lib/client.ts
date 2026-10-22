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
   * Extra headers a request carries beyond the transport's own, for the surfaces whose protocol
   * needs one of its own (`x-openbot-dictation` on the transcription upload). Merged in before the
   * selection pair, which cannot be overridden this way: the scope headers are this client's own
   * discipline (MT005 ruling #1 — the headers only select), so a caller "helpfully" passing them
   * is a wiring mistake the transport quietly corrects rather than a second opinion it honors.
   */
  headers?: Record<string, string>;
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

/**
 * The closed inventory of reviewed same-origin business paths the selection pair may ride
 * (MT081 / Issue #124, AC4).
 *
 * A path is on this list because a ticket reviewed it — the same discipline as the server's
 * MT030 global-exception registry (`GLOBAL_EXCEPTION_ENTRIES`, server/src/enterprise/tenancy/
 * global-exceptions.ts), and the two are cross-checked in `app/tests/multitenancy/
 * transport-rest.test.tsx`: no path under an allowed prefix may be covered by a registered
 * global exception, because an exception surface (login, health, static directory) is global
 * by design and must never receive a company/team selection. Widening this list is a review,
 * not an accident — each entry names its owner ticket and why the path is trusted with the
 * pair.
 *
 * TODAY the reviewed path families are the enterprise API (MT081), the coworker REST surface
 * (MT084, whose scoped reads and saves bind the Bot detail and configuration pages to the
 * selection), the Team Bot publication surface (MT085, whose sharing page reads and writes bind
 * the same way), the six page-binding tickets that follow the same seam: the Bot
 * operations surface (MT086 — responsibilities, computers, approvals), the conversation surface
 * (MT087 — channels and groups), the skills-and-connections surface (MT088 — plugins), the
 * memory-and-routines surface (MT089), the craft-and-workshop surface (MT091 — the sessions,
 * artifacts, turns and schedules the creation pages read and write), the catalog surface
 * (MT094 — the marketplace and component pages whose browsing, installs, configuration and
 * publication bind the same way), and the billing surface (MT097 — the orders, invoices, credits
 * and usage reads whose amounts belong to the selected scope, and the company books the finance
 * view reads through the enterprise API). The deployment's other legacy REST surfaces (the dictation
 * upload…) deliberately are NOT here: the server's entry middleware passes those through
 * untouched until they consume the scope seam themselves (MT125 lays the client headers onto
 * the legacy assembly), so sending the pair there now would be a selection no one reads. The
 * uploads and download issuances that target those surfaces ride the same attach logic below
 * (`clientUpload` and `send` share `scopeSelection`, AC3) and start carrying the pair the
 * moment their paths earn a review.
 */
export interface ScopeHeaderPathEntry {
  /** Stable id, the cross-check test names entries by. */
  readonly id: string;
  /** The path prefix the pair may ride on; the prefix itself is included. */
  readonly prefix: string;
  /** Why this path is trusted with the selection pair (non-empty). */
  readonly reason: string;
  /** The ticket that reviewed it (non-empty). */
  readonly ownerTicket: string;
}

export const SCOPE_HEADER_ALLOWED_PATHS: readonly ScopeHeaderPathEntry[] = [
  {
    id: "enterprise-api",
    prefix: "/api/enterprise/",
    reason:
      "the enterprise API is the scope middleware's own surface: it resolves the selection pair into a trusted scope (MT005 ruling #1 — the headers only select; database membership decides)",
    ownerTicket: "MT081",
  },
  {
    id: "agents-rest",
    prefix: "/api/agents",
    reason:
      "the coworker surface's reads and writes — a Bot's detail and configuration are company/team business data, and the scoped detail reads and save mutations of MT084 bind them to the selection; the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT084",
  },
  {
    id: "team-bots-rest",
    prefix: "/api/team-bots",
    reason:
      "the Team Bot publication surface — who may publish, unpublish and assign is the server's own capability answer, and the sharing page's reads and writes bind to the selection (MT085); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT085",
  },
  {
    id: "approvals-rest",
    prefix: "/api/approvals",
    reason:
      "the approval surface — whose inbox, rules and team caps a person holds is company/team business data, and the approvals page's reads and decisions bind to the selection (MT086); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT086",
  },
  {
    id: "responsibilities-rest",
    prefix: "/api/responsibilities",
    reason:
      "the standing-responsibility surface — a Bot's ongoing duties and their triggers are company/team business data, and the responsibilities page's reads, creates and actions bind to the selection (MT086); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT086",
  },
  {
    id: "computers-rest",
    prefix: "/api/computers",
    reason:
      "the computer surface — the fleet, its action boundary and the holder state that drives every control are the server's own answers, and the computers pages' reads and actions bind to the selection (MT086); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT086",
  },
  {
    id: "channels-rest",
    prefix: "/api/channels",
    reason:
      "the conversation surface — a person's channels with their coworkers are company/team business data, and the roster, detail, create and member writes bind to the selection (MT087); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT087",
  },
  {
    id: "groups-rest",
    prefix: "/api/groups",
    reason:
      "the group-conversation surface — creating a group and changing its members are company/team business writes, and they bind to the selection (MT087); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT087",
  },
  {
    id: "plugins-rest",
    prefix: "/api/plugins",
    reason:
      "the skills-and-connections surface — which skills exist and which connected accounts a person holds are company/team business data, and the skills and connected-accounts pages' reads, installs, connections and disclosures bind to the selection (MT088); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT088",
  },
  {
    id: "memory-rest",
    prefix: "/api/memory",
    reason:
      "the memory surface — a person's memories and their sources are company/team business data, and the memory pages' reads and writes bind to the selection (MT089); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT089",
  },
  {
    id: "routines-rest",
    prefix: "/api/routines",
    reason:
      "the routine surface — a person's standing instructions and their runs are company/team business data, and the routines page's reads, enable, delete and run-now writes bind to the selection (MT089); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT089",
  },
  {
    id: "craft-rest",
    prefix: "/api/craft",
    reason:
      "the creation surface — a craft session's roster, detail, artifacts, files and sandbox state, and the turns, uploads and scheduled tasks its pages submit, are company/team business data, and the craft pages' reads and writes bind to the selection (MT091); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT091",
  },
  {
    id: "workshop-rest",
    prefix: "/api/workshop",
    reason:
      "the workshop surface — a channel's workshop snapshot, its turns, artifacts, files, schedules and the share it mints are company/team business data, and the workshop panel's reads and writes bind to the selection (MT091); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT091",
  },
  {
    id: "marketplace-rest",
    prefix: "/api/marketplace",
    reason:
      "the catalog surface — the marketplace shelf a person browses and the expert and skill installs that land in the current scope are company/team business data, and the market page's reads and installs bind to the selection (MT094); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT094",
  },
  {
    id: "components-rest",
    prefix: "/api/components",
    reason:
      "the component surface — which components exist, which Bots and data functions they are granted, and whether one is published are company/team business data, and the component pages' reads, grants, drafts and publication writes bind to the selection (MT094); the server consumes the pair when the legacy assembly reads it (MT125)",
    ownerTicket: "MT094",
  },
  {
    id: "billing-rest",
    prefix: "/api/billing",
    reason:
      "the billing surface — the orders, invoices, credits and usage reads a person's billing pages make, and the company books a finance reader opens, are money facts of the selected scope, and MT097 binds those reads to the selection so a switch drops the old scope's amounts wholesale; the company books answer from the enterprise API's own scope gate, and the legacy payer-facing reads consume the pair when the legacy billing assembly reads it (MT125)",
    ownerTicket: "MT097",
  },
];

/**
 * The selection headers a request carries, or nothing.
 *
 * Same-origin here is a relative path on this app's own origin: a string that starts with exactly
 * one slash. An absolute URL names some other origin, and a `//host/path` URL does too — the
 * browser resolves it against a scheme, so its host is not ours. Only a reviewed business path
 * (the closed inventory above) with a selector may carry the headers, and every other combination
 * returns `undefined`, which leaves the request's headers exactly as they were before the
 * selectors existed.
 */
function scopeSelection(
  path: string,
  options: ClientOptions,
): Record<string, string> | undefined {
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  if (
    !SCOPE_HEADER_ALLOWED_PATHS.some((entry) => path.startsWith(entry.prefix))
  ) {
    return undefined;
  }
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
  const merged =
    options.body === undefined
      ? { ...options.headers, ...selection }
      : {
          "content-type": "application/json",
          ...options.headers,
          ...selection,
        };
  // An empty object would ride as `headers: {}` where the old call sent none at all.
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
 * The upload half of the same transport (MT081 / Issue #124, AC3).
 *
 * Multipart is the one body shape `send` cannot carry — it JSON-stringifies and sets the JSON
 * content type, and a multipart body must let the browser name its own boundary — so the
 * FormData paths used to open raw `fetch`es of their own, each a private copy of the credentials
 * discipline the JSON half already owned. This is the one place an upload leaves the browser
 * now: the SAME `scopeSelection` decides the selection pair (`scopeSelection`, not a reworking
 * of it — there is no second attach logic to drift), `credentials` stays `include`, and the
 * caller keeps its own envelope and refusal sentences, which are per-surface facts.
 *
 * Returns the `Response` verbatim: upload surfaces disagree about their envelopes (a file row
 * here, a count there), so unwrapping here would be the client guessing at meaning again.
 */
export function clientUpload(
  path: string,
  body: FormData,
  options: ClientOptions = {},
): Promise<Response> {
  const selection = scopeSelection(path, options);
  const headers: Record<string, string> | undefined = {
    ...options.headers,
    ...selection,
  };
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body,
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
