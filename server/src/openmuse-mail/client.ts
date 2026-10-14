import { getLogger } from "../../../shared/logger";

const log = getLogger("server");

/**
 * The Gmail vendor dial for OpenMuse Mail reads (M01/M03/M04, contracts §4), split the
 * way `plugins/openconnector-adapter.ts` and `openmuse-connectors/client.ts`
 * are split: {@link buildOpenMuseMailClient} is pure assembly over an
 * injectable dial, so every test below it is an object literal and no socket
 * is ever opened; {@link createOpenMuseMailClient} is the thin layer that
 * owns the real `fetch` and the base address.
 *
 * THE ACTION-CALL SEAM is the one the adapter already models
 * (`openconnector-adapter.ts` `actions.execute`): `POST /v1/actions/<actionId>`
 * with body `{ input }`, running in the owner's connection via the
 * `x-oo-connector-alias` header — the alias `openmuseAlias(userId, "gmail")`
 * minted in G01. THE ACTION IDS ARE PLACEHOLDERS: this repository pins no
 * gmail action ids, so `gmail.list` / `gmail.search` stand in as documented
 * names and the live ids are verified against the vendor's catalogue at O02
 * deployment.
 */
export type MailWireDial = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

/**
 * Placeholder action ids (see the module header): `gmail.list` for the plain
 * inbox read, `gmail.search` when the caller typed a query, `gmail.thread` for
 * one thread's messages, `gmail.attachment.get` / `gmail.attachment.bytes`
 * for one attachment's metadata and bytes (M04 — the ids and their input
 * shape `{threadId, messageId, attachmentId}` follow Gmail's own
 * messages.attachments surface; the live ids are O02's to verify). O02
 * verifies all five against the vendor's `listServiceActions("gmail")`
 * catalogue.
 */
/*
 * Overridable without a code change (round 6 H6), the family pattern
 * openmuse-calendar/client.ts already records: a catalogue mismatch at O02
 * is a deployment variable, not a re-release.
 */
export const GMAIL_LIST_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_LIST_ACTION_ID ?? "gmail.list";
export const GMAIL_SEARCH_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_SEARCH_ACTION_ID ?? "gmail.search";
export const GMAIL_THREAD_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_THREAD_ACTION_ID ?? "gmail.thread";
export const GMAIL_ATTACHMENT_GET_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_ATTACHMENT_GET_ACTION_ID ??
  "gmail.attachment.get";
export const GMAIL_ATTACHMENT_BYTES_ACTION_ID =
  process.env.OPENCONNECTOR_GMAIL_ATTACHMENT_BYTES_ACTION_ID ??
  "gmail.attachment.bytes";

/*
 * Boot-time O02 reminder: every id above is a placeholder this repository
 * pins by name alone, so the deployment signal listing them fires once when
 * the module loads — an operator checking the catalogue has the exact five
 * strings to verify against `listServiceActions("gmail")`, and a skipped O02
 * check leaves a trace rather than nothing.
 */
log.info(
  {
    type: "openmuse-mail-placeholder-action-ids",
    ids: [
      GMAIL_LIST_ACTION_ID,
      GMAIL_SEARCH_ACTION_ID,
      GMAIL_THREAD_ACTION_ID,
      GMAIL_ATTACHMENT_GET_ACTION_ID,
      GMAIL_ATTACHMENT_BYTES_ACTION_ID,
    ],
  },
  "openmuse-mail-placeholder-action-ids",
);

/**
 * The §4 attachment byte ceiling: 25 MiB, Gmail's own per-attachment limit.
 * Lives in this module (round 6 M30) so the decode-side guard and the
 * routes' post-decode re-check read ONE constant; routes.ts re-exports it.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** One message as the vendor's action answers it — mapped to the §4 DTO in mail.ts. */
export type GmailProviderMessage = Record<string, unknown>;

/** One action answer, envelope unwrapped: the messages, whether the vendor held some back, and its own resume token (M02: a non-null `nextToken` means more provider pages are held back; the request passes it back as `pageToken` to continue the walk). */
export type GmailProviderAnswer = {
  messages: GmailProviderMessage[];
  truncated: boolean;
  nextToken: string | null;
};

/** One thread as the vendor's action answers it — mapped to §4 DTOs in mail.ts. */
export type GmailProviderThread = {
  id: string;
  messages: GmailProviderMessage[];
};

/** One attachment's metadata as the vendor's action answers it — mapped to the §4 DTO in mail.ts. */
export type GmailProviderAttachment = Record<string, unknown>;

/**
 * One attachment's bytes as the vendor's action answers them: base64 inside
 * the JSON envelope (the action seam answers JSON, and Gmail itself serves
 * attachment data base64-encoded) plus an optional sha256 digest, carried on
 * the response as its ETag when the provider supplies one — CHOICE RECORDED:
 * absent digest means no ETag, never a digest this deployment computed
 * itself, so the header never claims a validation the provider did not make.
 */
export type GmailProviderAttachmentBytes = {
  bytes: Uint8Array;
  sha256: string | null;
};

export type OpenMuseMailClient = {
  /** The plain inbox read, in the owner's connection. */
  list(alias: string, pageToken?: string): Promise<GmailProviderAnswer>;
  /** The query read, when the caller typed one. */
  search(
    alias: string,
    query: string,
    pageToken?: string,
  ): Promise<GmailProviderAnswer>;
  /**
   * One thread's messages in the owner's connection; null when the vendor
   * answers not-found for that alias (missing and foreign are the same answer
   * under an alias-bound dial — the fake pins the signal as HTTP 404; O02
   * verifies the live one).
   */
  getThread(
    alias: string,
    threadId: string,
  ): Promise<GmailProviderThread | null>;
  /**
   * One attachment's metadata in the owner's connection; null when the vendor
   * answers not-found for that alias (a copied foreign id and a missing one
   * are the same answer under an alias-bound dial — the fake pins the signal
   * as HTTP 404; O02 verifies the live one).
   */
  getAttachment(
    alias: string,
    threadId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<GmailProviderAttachment | null>;
  /**
   * The same attachment's bytes, decoded off the vendor's base64 answer;
   * null on the vendor's not-found (an attachment that vanished between the
   * metadata dial and this one answers the same outward 404).
   */
  getAttachmentBytes(
    alias: string,
    threadId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<GmailProviderAttachmentBytes | null>;
};

/** A vendor failure, named so routes can answer 502 rather than 500. */
export class OpenMuseMailVendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMuseMailVendorError";
  }
}

function providerAnswerOf(body: unknown): GmailProviderAnswer {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  const messages = Array.isArray(record?.messages)
    ? (record?.messages as GmailProviderMessage[])
    : null;
  if (messages === null) {
    throw new OpenMuseMailVendorError(
      "The Gmail answer came back in a shape this deployment could not read.",
    );
  }
  return {
    messages,
    truncated: record?.truncated === true,
    nextToken:
      typeof record?.nextToken === "string" && record.nextToken !== ""
        ? record.nextToken
        : null,
  };
}

function providerThreadOf(body: unknown): GmailProviderThread {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (
    typeof record?.id !== "string" ||
    record.id === "" ||
    !Array.isArray(record?.messages)
  ) {
    throw new OpenMuseMailVendorError(
      "The Gmail thread came back in a shape this deployment could not read.",
    );
  }
  return {
    id: record.id,
    messages: record.messages as GmailProviderMessage[],
  };
}

function providerAttachmentOf(body: unknown): GmailProviderAttachment {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (typeof record?.id !== "string" || record.id === "") {
    throw new OpenMuseMailVendorError(
      "The Gmail attachment metadata came back in a shape this deployment could not read.",
    );
  }
  return record;
}

function providerAttachmentBytesOf(
  body: unknown,
): GmailProviderAttachmentBytes {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (typeof record?.data !== "string" || record.data === "") {
    throw new OpenMuseMailVendorError(
      "The Gmail attachment bytes came back in a shape this deployment could not read.",
    );
  }
  /*
   * Decode-side ceiling (round 6 M30): the routes' byteLength re-check runs
   * only AFTER this decode has buffered, and a sparse or lying provider
   * answer (size read as 0) bypasses the metadata pre-check entirely — so
   * the base64 length is refused here, before the replaceAll copy, the
   * Buffer decode and the Uint8Array copy each allocate a full-size twin.
   * The lying vendor becomes a clean vendor error, not an OOM.
   */
  const maxBase64Length = Math.ceil((ATTACHMENT_MAX_BYTES + 2) / 3) * 4;
  if (record.data.length > maxBase64Length) {
    throw new OpenMuseMailVendorError(
      "The Gmail attachment came back over this deployment's byte ceiling.",
    );
  }
  // Gmail-style base64url (- and _ for + and /) normalized before the decode,
  // so either alphabet the live vendor speaks decodes the same.
  const bytes = new Uint8Array(
    Buffer.from(
      record.data.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    ),
  );
  const sha256 =
    typeof record.sha256 === "string" && /^[0-9a-f]{64}$/i.test(record.sha256)
      ? record.sha256.toLowerCase()
      : null;
  return { bytes, sha256 };
}

export function buildOpenMuseMailClient(deps: {
  dial: MailWireDial;
}): OpenMuseMailClient {
  const dialAction = async (
    actionId: string,
    alias: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number | null; body: unknown }> => {
    let wire: Awaited<ReturnType<MailWireDial>>;
    try {
      wire = await deps.dial(`/v1/actions/${encodeURIComponent(actionId)}`, {
        method: "POST",
        headers: { "x-oo-connector-alias": alias },
        body: { input },
      });
    } catch (error) {
      /*
       * Round 6 (M28): the dial's own transport failures (connection
       * refused, the 30s timeout the dial seam carries) used to escape as
       * raw TypeErrors — the routes' generic 503, indistinguishable from an
       * unconfigured OPENCONNECTOR_URL, and invisible to the
       * openmuse-mail-vendor-failed monitor a JSON failure already logs.
       * Classified here like every other vendor failure: 502, named, logged.
       */
      log.warn(
        {
          type: "openmuse-mail-vendor-failed",
          actionId,
          status: null,
          transport: true,
          error: error instanceof Error ? error.message : String(error),
        },
        "openmuse-mail-vendor-failed",
      );
      throw new OpenMuseMailVendorError(
        `The Gmail service could not be reached (${
          error instanceof Error
            ? error.message
            : "an unknown transport failure"
        }).`,
      );
    }
    let body: unknown;
    try {
      body = await wire.json();
    } catch {
      throw new OpenMuseMailVendorError(
        "The Gmail service answered with something this deployment could not read as JSON.",
      );
    }
    return { ok: wire.ok, status: wire.status ?? null, body };
  };

  const vendorFailure = (
    actionId: string,
    status: number | null,
    body: unknown,
  ): OpenMuseMailVendorError => {
    const record =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : null;
    const vendorMessage =
      typeof record?.message === "string" && record.message !== ""
        ? record.message
        : null;
    log.warn(
      { type: "openmuse-mail-vendor-failed", actionId, status },
      "openmuse-mail-vendor-failed",
    );
    return new OpenMuseMailVendorError(
      vendorMessage ??
        `The Gmail service answered this deployment's request with a failure (${status ?? "an unreadable status"}).`,
    );
  };

  /*
   * THE RUNTIME FACE ANSWERS `{ data: ... }` — the same envelope the adapter's
   * `answerOf` unwraps; unwrapped here once so the mapping layer never sees it.
   */
  const unwrapEnvelope = (body: unknown): unknown =>
    body !== null && typeof body === "object" && "data" in body
      ? (body as Record<string, unknown>).data
      : body;

  const call = async (
    actionId: string,
    alias: string,
    input: Record<string, unknown>,
  ): Promise<GmailProviderAnswer> => {
    const wire = await dialAction(actionId, alias, input);
    if (!wire.ok) throw vendorFailure(actionId, wire.status, wire.body);
    return providerAnswerOf(unwrapEnvelope(wire.body));
  };

  return {
    list: (alias, pageToken) =>
      call(
        GMAIL_LIST_ACTION_ID,
        alias,
        pageToken === undefined ? {} : { pageToken },
      ),
    search: (alias, query, pageToken) =>
      call(
        GMAIL_SEARCH_ACTION_ID,
        alias,
        pageToken === undefined ? { query } : { query, pageToken },
      ),
    getThread: async (alias, threadId) => {
      const wire = await dialAction(GMAIL_THREAD_ACTION_ID, alias, {
        threadId,
      });
      if (!wire.ok) {
        if (wire.status === 404) return null;
        throw vendorFailure(GMAIL_THREAD_ACTION_ID, wire.status, wire.body);
      }
      return providerThreadOf(unwrapEnvelope(wire.body));
    },
    getAttachment: async (alias, threadId, messageId, attachmentId) => {
      const wire = await dialAction(GMAIL_ATTACHMENT_GET_ACTION_ID, alias, {
        threadId,
        messageId,
        attachmentId,
      });
      if (!wire.ok) {
        if (wire.status === 404) return null;
        throw vendorFailure(
          GMAIL_ATTACHMENT_GET_ACTION_ID,
          wire.status,
          wire.body,
        );
      }
      return providerAttachmentOf(unwrapEnvelope(wire.body));
    },
    getAttachmentBytes: async (alias, threadId, messageId, attachmentId) => {
      const wire = await dialAction(GMAIL_ATTACHMENT_BYTES_ACTION_ID, alias, {
        threadId,
        messageId,
        attachmentId,
      });
      if (!wire.ok) {
        if (wire.status === 404) return null;
        throw vendorFailure(
          GMAIL_ATTACHMENT_BYTES_ACTION_ID,
          wire.status,
          wire.body,
        );
      }
      return providerAttachmentBytesOf(unwrapEnvelope(wire.body));
    },
  };
}

/**
 * The transport layer: the real `fetch`, the DEPLOYER's OpenConnector address,
 * `redirect: "manual"` so no in-path redirect can move a request to a second
 * host — validated at construction for the adapter's reasons, so a mis-set
 * variable surfaces at boot. Exported since R02: the reviewed action executor
 * dials the SAME deployment OpenConnector through the same construction path
 * rather than a second one of its own.
 */
export function createOpenMuseMailDial(config: { url: string }): MailWireDial {
  let base: URL;
  try {
    base = new URL(config.url);
  } catch {
    throw new Error(
      "OPENCONNECTOR_URL does not parse as a URL this deployment can dial.",
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(
      "OPENCONNECTOR_URL resolved to a scheme this deployment refuses to dial; only http and https are allowed.",
    );
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error(
      "OPENCONNECTOR_URL carries user info, which would embed a credential in every URL string derived from it.",
    );
  }
  return (path, init) =>
    fetch(new URL(path, base), {
      method: init.method,
      redirect: "manual",
      // The house rule (billing/lago.ts): a hung provider must not hang us —
      // the list route stitches up to MAX_PROVIDER_PAGES dials through this
      // seam, so one unbounded wait would pin the whole request.
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...init.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(init.body),
    });
}

export function createOpenMuseMailClient(config: {
  url: string;
}): OpenMuseMailClient {
  return buildOpenMuseMailClient({ dial: createOpenMuseMailDial(config) });
}
