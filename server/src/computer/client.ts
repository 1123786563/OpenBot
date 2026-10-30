import type { HandoffRequest } from "@openbot/shared/computer-control";
import { applyExecutionScopeHeaders, type ExecutionScope } from "@openbot/shared/execution-scope";
import { injectTraceHeaders } from "@openbot/shared/trace";
import type { NavigateResult } from "./schema";
import { checkNavigationTarget } from "./target";

/** The computer did not accept or answer a request. */
export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * A person pressed Stop and the action was aborted mid-flight.
 *
 * A subclass of `ComputerUnavailableError` on purpose: everything downstream that catches an
 * unavailable computer to tell the model still catches this unchanged. What it adds is a type the
 * gateway can see, so the audit row it writes is `computer.action_stopped` rather than
 * `computer.action_failed` -- a stop is not an outage, and a count of failures that includes every
 * Stop reports one where there was none.
 */
export class ComputerStoppedError extends ComputerUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerStoppedError";
  }
}

/**
 * The transport refusals that PROVE the request never reached the computer:
 * no listener on the port, no such host, DNS not answering yet. Matched over
 * every error in the chain and its `code` (the syscall's own name), plus the
 * message, because a fetch failure arrives as a bare `TypeError` whose only
 * signal is the sentence.
 */
const NEVER_REACHED = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /connection refused/i,
];

/**
 * The interruptions that prove the opposite — the connection WAS established
 * and broke with the request in flight, so the write may have landed. These
 * stay on the AMBIGUOUS side of the write budget's refund decision.
 */
const INTERRUPTED_MID_FLIGHT = [
  /ECONNRESET/i,
  /EPIPE/i,
  /UND_ERR_SOCKET/i,
  /socket hang up/i,
  /connection reset/i,
];

/** Every node of an error's cause chain, the error itself first. */
function causesOf(
  error: unknown,
): Array<{ code?: unknown; message?: unknown }> {
  const nodes: Array<{ code?: unknown; message?: unknown }> = [];
  // A wrapped error can carry a cycle (a proxy or deserializer rebuilt the chain); the
  // refund decision must terminate, so a node already visited ends the walk.
  const seen = new Set<unknown>();
  for (
    let node: unknown = error;
    node !== undefined && node !== null && !seen.has(node);
    node = (node as { cause?: unknown }).cause
  ) {
    seen.add(node);
    nodes.push(node as { code?: unknown; message?: unknown });
  }
  return nodes;
}

/**
 * Whether a fetch rejection proves the request never reached the computer.
 * Only the never-connected directions answer true: a reset or socket death
 * mid-flight (the write may have committed) outranks any refusal wording and
 * answers false, and so does every failure this classifier does not
 * recognise — the ambiguous direction keeps the charge.
 */
/**
 * Any legal `RequestInit` headers shape (record, Headers instance, entry array) as a
 * plain record, so the spread in `request` keeps every caller header — a Headers
 * instance or entry array spreads to nothing as a plain object.
 */
function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function provablyNeverReached(error: unknown): boolean {
  const signals = causesOf(error)
    .flatMap((node) => [
      typeof node.code === "string" ? node.code : "",
      typeof node.message === "string" ? node.message : "",
    ])
    .join(" | ");
  if (INTERRUPTED_MID_FLIGHT.some((shape) => shape.test(signals))) return false;
  return NEVER_REACHED.some((shape) => shape.test(signals));
}

/**
 * The request provably never reached the computer: the transport itself refused (no listener,
 * no route) before anything was sent. A subclass of `ComputerUnavailableError` so every existing
 * catch keeps working; what it adds is the proof, which the write budget's refund decision needs
 * — a timeout or a mid-flight abort may have landed its bytes, a connection that was never
 * established cannot have.
 */
export class ComputerUnreachableError extends ComputerUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnreachableError";
  }
}

/** The requested element is not on the current page. */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/** The navigation target is not permitted. */
export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/** The computer refused access to a path outside its workspace. */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/** The workspace request names a path or value that cannot be used. */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/** The workspace has no file at the requested path. */
export class WorkspaceNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceNotFoundError";
  }
}

/** The requested workspace file is larger than the download limit. */
export class WorkspaceTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceTooLargeError";
  }
}

/** Raw bytes and their size, kept as a stream until the caller sends them onward. */
export type ComputerDownload = {
  body: ReadableStream<Uint8Array>;
  bytes: number;
};

/** The page changed after the caller received its element references. */
export class StaleSnapshotError extends Error {
  constructor(
    reason: string,
    readonly snapshotRequired = false,
  ) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

/**
 * A person has the wheel, so the Bot's action was not carried out.
 *
 * Its own condition rather than a stale snapshot, though both arrive as 409, because what the caller
 * should do next is the opposite in each case. Stale refs mean take a fresh snapshot and go again;
 * this means stop and leave the browser to the person holding it. Told apart by the flag the computer
 * puts on the body, which is the only thing in the response that distinguishes them.
 */
export class HumanHasControlError extends Error {
  constructor(
    reason: string,
    readonly requestId?: string,
    readonly handoff?: HandoffRequest,
  ) {
    super(reason);
    this.name = "HumanHasControlError";
  }
}

/** Invalid, unknown, or superseded handoff identity is distinct from page freshness. */
export class HandoffRequestError extends Error {
  constructor(
    reason: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(reason);
    this.name = "HandoffRequestError";
  }
}

/**
 * Transport options used inside the computer gateway.
 *
 * This is an internal seam. Application code uses ComputerGateway and does not
 * use this interface directly.
 */
export type ComputerTransportOptions = {
  token?: string;
  /*
   * The execution ownership this deployment's computer calls state on the wire (MT050):
   * a scope injects the two headers, null refuses the dial (half-set configuration),
   * undefined skips injection — a deployment that wired no scope dials as it always did.
   */
  executionScope?: ExecutionScope | null;
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Internal HTTP interface used only by ComputerGateway. */
export interface ComputerTransport {
  call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  navigate(
    baseUrl: string,
    botId: string,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  download(
    baseUrl: string,
    botId: string,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload>;
}

/**
 * Send authenticated HTTP requests to one located agent-computer process.
 *
 * Lifecycle and location are deliberately absent. ComputerGateway owns those
 * operations through ComputerProvider.
 */
export function createComputerTransport(
  options: ComputerTransportOptions,
): ComputerTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 45_000;

  async function request(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    if (caller?.aborted) {
      throw new ComputerStoppedError("The action was stopped.");
    }

    /*
     * A browser action either happens in seconds or has gone wrong, so 45s is the right deadline for
     * it. A command is not that: the shell's own budget is 120s by default and up to 600s, and the
     * tool description tells the model to install packages. Giving up here first reported failure to
     * the person while the command carried on running to completion inside the container, and made
     * the shell's own limit unreachable. A caller with a longer limit of its own passes it in, and
     * this becomes the backstop rather than the limit.
     */
    const timeoutMs = timeoutMsOverride ?? defaultTimeoutMs;
    const target = baseUrl.replace(/\/$/, "");
    // Applied before the dial: a half-set scope is a configuration refusal, not a transport
    // outcome, so it must not be re-wrapped by the transport failure handling below.
    const scopedHeaders = applyExecutionScopeHeaders(
      {
        "x-openbot-bot-id": botId,
        ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
      },
      options.executionScope,
      () => {
        throw new ComputerUnavailableError(
          "The computer requires execution ownership, and this deployment's scope is not usable: set both OPENBOT_COMPUTER_EXECUTION_TENANT_ID and OPENBOT_COMPUTER_EXECUTION_WORKSPACE_ID, or clear both.",
        );
      },
    );
    let response: Response;
    try {
      response = await doFetch(`${target}${path}`, {
        ...init,
        headers: injectTraceHeaders({
          ...headerRecord(init?.headers),
          ...scopedHeaders,
        }),
        signal: caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      /*
       * The caller's own abort is answered first, and says what the check above the fetch says.
       *
       * The signal is handed to fetch precisely so a Stop can land mid-flight, and a fetch aborted
       * that way rejects with an AbortError, which is neither a TimeoutError nor a computer that is
       * not running. Both of the other answers are statements about the infrastructure, and this
       * message is not only read by the model: the gateway writes it into the action's audit row,
       * and the type below is what keeps that row a stop rather than an outage.
       */
      if (caller?.aborted) {
        throw new ComputerStoppedError("The action was stopped.");
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        // Ambiguous: the request was sent, an answer never came — the write may have landed.
        throw new ComputerUnavailableError(
          "The assistant's computer did not respond in time.",
        );
      }
      /*
       * Only a failure that proves the connection was never established says
       * "not running" — the write budget refunds on that proof alone. A reset
       * or socket death with the request in flight (the write may have
       * committed) and any unrecognised transport failure keep the ambiguous
       * class instead, so the charge errs toward never letting a workspace
       * past what it was promised.
       */
      if (provablyNeverReached(error)) {
        throw new ComputerUnreachableError(
          "The assistant's computer is not running.",
        );
      }
      throw new ComputerUnavailableError(
        "The assistant's computer dropped the connection mid-flight.",
      );
    }
    return response;
  }

  async function call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<T> {
    const response = await request(
      baseUrl,
      botId,
      path,
      init,
      caller,
      timeoutMsOverride,
    );
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throwMappedError(response.status, body);
    }
    if (body === null) {
      // A 2xx whose body is not JSON (a proxy's HTML page, an empty body) is not an
      // answer: the typed callers would destructure null into a TypeError downstream.
      throw new ComputerUnavailableError(
        "The assistant's computer returned a response that could not be read.",
      );
    }
    return body as T;
  }

  async function download(
    baseUrl: string,
    botId: string,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload> {
    const response = await request(
      baseUrl,
      botId,
      path,
      { method: "GET" },
      caller,
      timeoutMs,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      throwMappedError(response.status, body);
    }

    const length = response.headers.get("content-length");
    const bytes =
      length !== null && /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (!response.body || !Number.isSafeInteger(bytes) || bytes < 0) {
      // Nothing else will ever read this body, so release it here rather than
      // leaving the whole download budget checked out of the pool. A cancel that
      // fails must not replace the refusal the caller is told about.
      await response.body?.cancel().catch(() => undefined);
      throw new ComputerUnavailableError(
        "The assistant's computer returned an invalid file download.",
      );
    }
    return { body: response.body, bytes };
  }

  function post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return call<T>(
      baseUrl,
      botId,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      caller,
      timeoutMs,
    );
  }

  async function navigate(
    baseUrl: string,
    botId: string,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult> {
    const verdict = checkNavigationTarget(url, {
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!verdict.allowed) {
      throw new NavigationRefusedError(verdict.reason);
    }
    return post<NavigateResult>(baseUrl, botId, "/navigate", {
      url: verdict.url,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  return { call, post, navigate, download };
}

/** Map agent-computer responses to errors that a caller can act on. */
function throwMappedError(
  status: number,
  body: Record<string, unknown> | null,
): never {
  const detail =
    typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  if (
    body?.controlRequestError === true &&
    (status === 400 || status === 404 || status === 409)
  )
    throw new HandoffRequestError(detail, status);
  if (status === 409) {
    // The computer says which kind of 409 this is. Absent, it is the ordinary one.
    if (body?.humanHasControl === true) {
      throw new HumanHasControlError(
        detail,
        typeof body.requestId === "string" ? body.requestId : undefined,
        body.handoff && typeof body.handoff === "object"
          ? (body.handoff as HandoffRequest)
          : undefined,
      );
    }
    throw new StaleSnapshotError(detail, body?.snapshotRequired === true);
  }
  if (status === 403) {
    throw new WorkspaceRefusedError(detail);
  }
  if (status === 400) {
    throw new WorkspaceRequestError(detail);
  }
  if (status === 404) {
    throw new WorkspaceNotFoundError(detail);
  }
  if (status === 413) {
    throw new WorkspaceTooLargeError(detail);
  }
  if (/waiting for locator|Timeout .* exceeded/i.test(detail)) {
    const ref = detail.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
    throw new ElementNotFoundError(
      `${ref ? `Element ${ref} is` : "That element is"} not on the page any more. Take a fresh snapshot and use the refs from it.`,
    );
  }
  throw new ComputerUnavailableError(detail);
}
