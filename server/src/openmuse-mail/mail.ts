import type {
  GmailProviderAttachment,
  GmailProviderMessage,
  GmailProviderThread,
} from "./client";

/**
 * The §4 Mail read DTO — the only shape an OpenMuse Mail response ever
 * carries. Provider fields beyond these are dropped at the mapping, so no
 * vendor action shape can leak into the DTO.
 */
export type OpenMuseMailMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  receivedAt: string;
  unread: boolean;
  labels: string[];
  attachments: OpenMuseMailAttachment[];
};

/** The §4 attachment DTO (M04): the four metadata fields, nothing else crosses. */
export type OpenMuseMailAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

/**
 * Map one provider attachment record onto the §4 metadata DTO. The id is the
 * client's to guarantee (an unreadable shape never reaches here); the other
 * fields coerce the way a message's inline attachments always have — a
 * non-string name or mimeType reads as "", a non-number size as 0 — so a
 * sparse vendor answer degrades to visible empties, never a 500.
 */
export function mapAttachmentMetadata(
  row: GmailProviderAttachment,
): OpenMuseMailAttachment {
  return {
    id: typeof row.id === "string" ? row.id : "",
    name: readString(row.name),
    mimeType: readString(row.mimeType),
    size: typeof row.size === "number" ? row.size : 0,
  };
}

/**
 * Map one provider row onto the DTO, or null for a row with no id to keyset
 * on — a row that cannot even be named is dropped rather than guessed at.
 */
export function mapProviderMessage(
  row: GmailProviderMessage | null | undefined,
): OpenMuseMailMessage | null {
  /*
   * Round 6 (M29): the client's answer validation checks the messages key is
   * an array but not each element, so a sparse vendor page can hand this map
   * a null — `row.id` would throw and take the whole page down the routes'
   * generic 503. A row that is not even an object is dropped exactly like a
   * row with no id: never guessed at.
   */
  if (row === null || typeof row !== "object") return null;
  if (typeof row.id !== "string" || row.id === "") return null;
  const attachments: OpenMuseMailAttachment[] = Array.isArray(row.attachments)
    ? row.attachments.flatMap((attachment) =>
        attachment !== null &&
        typeof attachment === "object" &&
        typeof (attachment as Record<string, unknown>).id === "string"
          ? [mapAttachmentMetadata(attachment as Record<string, unknown>)]
          : [],
      )
    : [];
  return {
    id: row.id,
    threadId: readString(row.threadId),
    from: readString(row.from),
    to: Array.isArray(row.to)
      ? row.to.filter(
          (address): address is string => typeof address === "string",
        )
      : [],
    subject: readString(row.subject),
    bodyText: normalizeBody(row.bodyText, row.bodyHtml),
    receivedAt: new Date(receivedAtMs(row.receivedAt)).toISOString(),
    unread: row.unread === true,
    labels: Array.isArray(row.labels)
      ? row.labels.filter((label): label is string => typeof label === "string")
      : [],
    attachments,
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The §4 body: the provider's plain text when it carries one, otherwise a
 * naive tag-strip of an HTML-only body, line endings normalized to `\n`, and
 * an empty body stays `""` rather than null. CHOICE RECORDED: the HTML
 * fallback strips tags without rendering or fetching anything and decodes only
 * the five common entities — a faithful extractor can replace it later
 * without touching the contract.
 */
function normalizeBody(text: unknown, html: unknown): string {
  if (typeof text === "string" && text !== "") {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  }
  if (typeof html !== "string" || html === "") return "";
  return htmlToText(html);
}

function htmlToText(html: string): string {
  return (
    html
      // Source line breaks are rendered whitespace, not newlines: only <br>
      // and closing block tags break a line in the extracted text.
      .replace(/\r\n?/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim()
  );
}

/** Provider time as epoch ms: a Gmail-style ms number, or an ISO string. */
function receivedAtMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** The list sort: newest receivedAt first, then id descending (§4). */
export function sortNewestFirst(
  messages: OpenMuseMailMessage[],
): OpenMuseMailMessage[] {
  return [...messages].sort((left, right) => {
    const leftAt = Date.parse(left.receivedAt);
    const rightAt = Date.parse(right.receivedAt);
    if (leftAt !== rightAt) return rightAt - leftAt;
    if (right.id < left.id) return -1;
    if (right.id > left.id) return 1;
    return 0;
  });
}

/** The thread sort: oldest receivedAt first, then id ascending (§4). */
export function sortOldestFirst(
  messages: OpenMuseMailMessage[],
): OpenMuseMailMessage[] {
  return [...messages].sort((left, right) => {
    const leftAt = Date.parse(left.receivedAt);
    const rightAt = Date.parse(right.receivedAt);
    if (leftAt !== rightAt) return leftAt - rightAt;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

/**
 * Map one provider thread onto §4 DTOs, oldest first. DERIVATION RECORDED: a
 * row the vendor sends without its own id gets one derived from
 * (thread id, index) — stable for an unchanged payload, so a re-read of the
 * same thread names its rows the same; the live vendor is expected to carry
 * per-message ids and O02 checks that it does. A row missing its threadId
 * inherits the thread's.
 */
export function mapThreadMessages(
  thread: GmailProviderThread,
): OpenMuseMailMessage[] {
  return sortOldestFirst(
    thread.messages.flatMap((row, index) => {
      const mapped = mapProviderMessage({
        ...row,
        id:
          typeof row.id === "string" && row.id !== ""
            ? row.id
            : `${thread.id}-${index}`,
        threadId:
          typeof row.threadId === "string" && row.threadId !== ""
            ? row.threadId
            : thread.id,
      });
      return mapped === null ? [] : [mapped];
    }),
  );
}

/**
 * The opaque cursor: base64 of the owner+connection binding and the keyset
 * position. Opaque because it names a person's alias, and bound because a
 * cursor from another owner or another connection seat must refuse (400), not
 * silently continue somebody else's page. The providerToken (M02) is where
 * the next request must resume the provider's own page walk: the entry token
 * of the earliest fetched provider page still holding an unshipped row, so
 * resuming can never skip past one into a gap. The `query` binds the search
 * term the walk belongs to: a page cursor replayed against a different `q`
 * would thread one result set's token into another's walk.
 */
export function encodeMailCursor(cursor: {
  owner: string;
  alias: string;
  receivedAt: number;
  id: string;
  query?: string;
  providerToken?: string | null;
}): string {
  // base64url, the house alphabet for values that travel as a query
  // parameter (auth/signed-value.ts records the reason): standard base64's
  // `+` arrives as a space under form-urlencoded semantics and shifts the
  // payload past readability.
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMailCursor(value: string): {
  owner: string;
  alias: string;
  receivedAt: number;
  id: string;
  query: string | null;
  providerToken: string | null;
} | null {
  let parsed: unknown;
  try {
    // base64url decoding also accepts the standard alphabet, so cursors
    // minted before the switch still read.
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.owner !== "string" ||
    typeof record.alias !== "string" ||
    typeof record.receivedAt !== "number" ||
    typeof record.id !== "string"
  ) {
    return null;
  }
  return {
    owner: record.owner,
    alias: record.alias,
    receivedAt: record.receivedAt,
    id: record.id,
    // Lenient for a cursor minted before the binding existed: null reads as
    // the empty query, the walk every plain list cursor started.
    query: typeof record.query === "string" ? record.query : null,
    providerToken:
      typeof record.providerToken === "string" ? record.providerToken : null,
  };
}
