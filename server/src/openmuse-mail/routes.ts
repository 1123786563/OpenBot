import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseOwnerDisabledError,
  OpenMuseVendorUnavailableError,
} from "../openmuse-connectors/google-oauth";
import type { OpenMuseMailClient } from "./client";
import { ATTACHMENT_MAX_BYTES, OpenMuseMailVendorError } from "./client";

export { ATTACHMENT_MAX_BYTES };
import {
  decodeMailCursor,
  encodeMailCursor,
  mapAttachmentMetadata,
  mapProviderMessage,
  mapThreadMessages,
  type OpenMuseMailAttachment,
  type OpenMuseMailMessage,
  sortNewestFirst,
} from "./mail";

const log = getLogger("server");

/** The §4 list defaults: 25 per page, at most 100. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/*
 * A vendor that needs more provider pages than this to fill one response page
 * is stalling, not paging: the stitch stops and answers what it has, with the
 * last page's truncation flag already on the answer and a cursor that resumes
 * the provider walk. ponytail: fixed cap is enough — a token-paging vendor
 * serving ≥1 new row per page reaches surplus within MAX_LIMIT pages.
 */
const MAX_PROVIDER_PAGES = 100;

/*
 * The stitch's total time budget: a slow-but-valid provider must not pin the
 * request for MAX_PROVIDER_PAGES × 30s of dial timeouts. Passing the budget
 * stops the walk exactly like the page cap — truncated on, cursor out — so
 * the client can resume rather than wait out a degraded vendor.
 */
const STITCH_BUDGET_MS = 60_000;

/*
 * ATTACHMENT_MAX_BYTES moved to ./client (round 6 M30) so the decode-side
 * guard and this route's post-decode re-check share one constant; the
 * re-export above keeps this module's import path working. The §4 semantics
 * are unchanged: 25 MiB is Gmail's own per-attachment limit — Gmail refuses
 * to attach anything larger and sends Drive links instead, so a metadata
 * size over the ceiling is a provider anomaly this deployment refuses (413,
 * the limit named) BEFORE any bytes dial, not a download it truncates
 * halfway. CHOICE RECORDED: metadata alone never 413s — the §4 acceptance
 * is that name/MIME/size are shown while bytes stay within the limit.
 */

/**
 * `/api/mobile/openmuse-mail` (M01/M03, contracts §4): the authenticated owner's
 * Gmail messages as the Mail DTO — newest `receivedAt` first then id
 * descending, `q` forwarded to the provider's search action, cursor an opaque
 * owner+connection-bound keyset — and one thread's messages at
 * `GET /threads/:threadId`, oldest first by provider time then id. The G01
 * guard runs FIRST: a disconnected account answers its stable 409 before any
 * vendor call is made.
 */
export function createOpenMuseMailRoutes(deps: {
  /** Absent when the vendor base URL could not be built — reads answer 503. */
  client?: OpenMuseMailClient;
  /** G01's requireConnection seam, borrowed whole — gmail consent or the 409 refusal. */
  service: Pick<OpenMuseGoogleOAuth, "requireConnection">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * The §9 disabled-owner marker. Optional because the mail surface has no
   * store of its own to carry it; the wiring seam is recorded for the ticket
   * that mounts the real marker (absent = nobody disabled).
   */
  ownerDisabled?: (userId: string) => Promise<boolean>;
}): Hono<{ Variables: AppVariables }> {
  const client = () => {
    if (!deps.client) throw new OpenMuseVendorUnavailableError();
    return deps.client;
  };
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      // §9: the disabled marker is consulted before anything else, so a
      // disabled owner's reads stop without a vendor call.
      return context.json({ error: "This owner's mail is unavailable." }, 403);
    }
    if (error instanceof OpenMuseConnectionRefusedError) {
      // §4: a provider call without that provider's consent stops here, 409,
      // with a code the client can key on rather than a sentence to parse.
      return context.json(
        { error: error.message, code: "connection_required" },
        error.status,
      );
    }
    if (error instanceof OpenMuseVendorUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (error instanceof OpenMuseMailVendorError) {
      return context.json({ error: error.message }, 502);
    }
    return context.json(
      { error: "Mail is unavailable right now. Try again." },
      503,
    );
  });

  routes.get("/", async (context) => {
    context.header("Cache-Control", "no-store");
    const actor = context.var.actor;
    // §9: the disabled marker is consulted before anything else (the same
    // gate the thread and attachment routes stand), so a disabled owner's
    // list and search stop without a vendor call.
    if (
      deps.ownerDisabled !== undefined &&
      (await deps.ownerDisabled(actor.id))
    ) {
      throw new OpenMuseOwnerDisabledError(actor.id);
    }
    const limit = parseLimit(context.req.query("limit"));
    if (limit === null) {
      return context.json(
        { error: "limit must be a whole number between 1 and 100." },
        400,
      );
    }
    const query = context.req.query("q")?.trim() ?? "";
    // The guard BEFORE the dial: disconnected means the vendor is never asked.
    const connection = await deps.service.requireConnection(actor.id, "gmail");
    const rawCursor = context.req.query("cursor");
    let cursor = null as {
      receivedAt: number;
      id: string;
      providerToken: string | null;
    } | null;
    if (rawCursor !== undefined && rawCursor !== "") {
      const decoded = decodeMailCursor(rawCursor);
      if (
        decoded === null ||
        decoded.owner !== context.var.actor.id ||
        decoded.alias !== connection.alias ||
        (decoded.query ?? "") !== query
      ) {
        return context.json(
          { error: "That cursor does not belong to this account." },
          400,
        );
      }
      cursor = {
        receivedAt: decoded.receivedAt,
        id: decoded.id,
        providerToken: decoded.providerToken,
      };
    }

    /*
     * M02: the provider pages by its own token. The stitch keeps dialing
     * while the page is not yet full-plus-surplus and the provider holds
     * more, because a later provider page can hold a row that sorts BEFORE
     * the last row shipped here — stopping early would strand it behind the
     * keyset forever. Every fetched page is remembered with its entry token:
     * the outbound cursor must resume the provider walk at the EARLIEST page
     * still holding an unshipped row, since resuming later drops that row
     * into a gap (and resuming earlier only re-reads what the keyset skips).
     */
    const read = (pageToken: string | null) =>
      query === ""
        ? client().list(connection.alias, pageToken ?? undefined)
        : client().search(connection.alias, query, pageToken ?? undefined);
    const pages: Array<{ entryToken: string | null; ids: Set<string> }> = [];
    const byId = new Map<string, OpenMuseMailMessage>();
    let remainingCount = 0;
    let truncated = false;
    let nextToken = cursor?.providerToken ?? null;
    let pageFetches = 0;
    const seenTokens = new Set<string>();
    const stitchStartedAt = Date.now();
    let stoppedShort = false;
    let stitchTimedOut = false;
    while (pageFetches < MAX_PROVIDER_PAGES) {
      if (Date.now() - stitchStartedAt > STITCH_BUDGET_MS) {
        stitchTimedOut = true;
        break;
      }
      if (nextToken !== null) {
        // A repeating token is a vendor loop, not a page: an honest cut, not
        // a silent "complete".
        if (seenTokens.has(nextToken)) {
          stoppedShort = true;
          break;
        }
        seenTokens.add(nextToken);
      }
      const entryToken = nextToken;
      const answer = await read(entryToken);
      pageFetches += 1;
      // Accumulated across stitched pages: any page the vendor held back on
      // keeps the flag on, even if a later page exhausts the walk.
      truncated = truncated || answer.truncated;
      const fetched = { entryToken, ids: new Set<string>() };
      pages.push(fetched);
      for (const row of answer.messages) {
        const message = mapProviderMessage(row);
        // Deduped across provider pages: a row re-served at a page boundary
        // must not reach the page twice.
        if (message === null || byId.has(message.id)) continue;
        byId.set(message.id, message);
        fetched.ids.add(message.id);
        if (cursor === null || comesAfter(message, cursor)) remainingCount += 1;
      }
      nextToken = answer.nextToken;
      if (nextToken === null || remainingCount > limit) break;
    }
    const sorted = sortNewestFirst([...byId.values()]);
    // The keyset: only messages strictly after the cursor's position.
    const remaining =
      cursor === null
        ? sorted
        : sorted.filter((message) => comesAfter(message, cursor));
    const page = remaining.slice(0, limit);
    const last = page.at(-1);
    const hasSurplus = remaining.length > limit;
    let resumeToken = nextToken;
    if (hasSurplus) {
      const unshipped = new Set(
        remaining.slice(limit).map((message) => message.id),
      );
      resumeToken =
        pages.find((fetched) =>
          [...fetched.ids].some((id) => unshipped.has(id)),
        )?.entryToken ?? null;
    }
    const capped =
      (nextToken !== null && pageFetches >= MAX_PROVIDER_PAGES) ||
      stitchTimedOut;
    return context.json({
      messages: page,
      // An involuntary stop — a repeating token, the page cap or the time
      // budget — must not pose as a clean end of list, even when this page
      // itself is empty (an empty capped page has no `last` and so no cursor,
      // but the truncation signal stays honest).
      truncated: truncated || stoppedShort || capped,
      ...(last !== undefined && (hasSurplus || capped)
        ? {
            nextCursor: encodeMailCursor({
              owner: context.var.actor.id,
              alias: connection.alias,
              receivedAt: Date.parse(last.receivedAt),
              id: last.id,
              query,
              providerToken: resumeToken,
            }),
          }
        : {}),
    });
  });

  routes.get("/threads/:threadId", async (context) => {
    context.header("Cache-Control", "no-store");
    const actor = context.var.actor;
    if (
      deps.ownerDisabled !== undefined &&
      (await deps.ownerDisabled(actor.id))
    ) {
      throw new OpenMuseOwnerDisabledError(actor.id);
    }
    // The guard BEFORE the dial: disconnected means the vendor is never asked.
    const connection = await deps.service.requireConnection(actor.id, "gmail");
    const threadId = context.req.param("threadId");
    const thread = await client().getThread(connection.alias, threadId);
    if (thread === null) {
      /*
       * Foreign and missing are indistinguishable at the vendor boundary BY
       * DESIGN — an alias-bound dial only ever sees that alias's mailbox — so
       * both answer the same outward 404; the internal log names the thread
       * and the alias that asked, which is the reason an operator can act on.
       */
      log.warn(
        {
          type: "openmuse-mail-thread-not-found",
          threadId,
          alias: connection.alias,
        },
        "openmuse-mail-thread-not-found",
      );
      return context.json(
        { error: "That thread does not exist in this account's mail." },
        404,
      );
    }
    return context.json(mapThreadMessages(thread));
  });

  /*
   * M04's shared prologue: the §9 disabled marker and the G01 consent guard
   * (403/409, never reaching the vendor), then the ONE metadata dial both
   * attachment endpoints need. Foreign, missing, and vendor-refused are
   * indistinguishable under the alias-bound dial BY DESIGN, so all answer the
   * same outward 404 — the internal log names the ids and the alias that
   * asked, which is the reason an operator can act on.
   */
  const attachmentNotFound = (
    context: Context<{ Variables: AppVariables }>,
    names: {
      threadId: string;
      messageId: string;
      attachmentId: string;
      alias: string;
    },
  ): Response => {
    log.warn(
      { type: "openmuse-mail-attachment-not-found", ...names },
      "openmuse-mail-attachment-not-found",
    );
    return context.json(
      { error: "That attachment does not exist in this account's mail." },
      404,
    );
  };

  const attachmentScope = async (
    context: Context<{ Variables: AppVariables }>,
  ): Promise<
    | { refused: Response }
    | {
        refused: null;
        alias: string;
        threadId: string;
        messageId: string;
        attachmentId: string;
        metadata: OpenMuseMailAttachment;
      }
  > => {
    const actor = context.var.actor;
    if (
      deps.ownerDisabled !== undefined &&
      (await deps.ownerDisabled(actor.id))
    ) {
      throw new OpenMuseOwnerDisabledError(actor.id);
    }
    const connection = await deps.service.requireConnection(actor.id, "gmail");
    const { threadId, messageId, attachmentId } = context.req.param();
    const record = await client().getAttachment(
      connection.alias,
      threadId,
      messageId,
      attachmentId,
    );
    if (record === null) {
      return {
        refused: attachmentNotFound(context, {
          threadId,
          messageId,
          attachmentId,
          alias: connection.alias,
        }),
      };
    }
    return {
      refused: null,
      alias: connection.alias,
      threadId,
      messageId,
      attachmentId,
      metadata: mapAttachmentMetadata(record),
    };
  };

  routes.get(
    "/threads/:threadId/messages/:messageId/attachments/:attachmentId",
    async (context) => {
      context.header("Cache-Control", "no-store");
      const scope = await attachmentScope(context);
      if (scope.refused !== null) return scope.refused;
      return context.json(scope.metadata);
    },
  );

  routes.get(
    "/threads/:threadId/messages/:messageId/attachments/:attachmentId/content",
    async (context) => {
      context.header("Cache-Control", "no-store");
      const scope = await attachmentScope(context);
      if (scope.refused !== null) return scope.refused;
      if (scope.metadata.size > ATTACHMENT_MAX_BYTES) {
        return context.json(
          {
            error: `That attachment is ${scope.metadata.size} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte (25 MiB) limit this deployment serves.`,
          },
          413,
        );
      }
      const answer = await client().getAttachmentBytes(
        scope.alias,
        scope.threadId,
        scope.messageId,
        scope.attachmentId,
      );
      if (answer === null) {
        // Vanished between the metadata dial and this one: the same 404.
        return attachmentNotFound(context, scope);
      }
      // The metadata pre-check can be understated (a sparse or lying provider
      // answer): the payload actually received is re-checked against the same
      // ceiling before it is served, so the limit is a property of the bytes,
      // not of the metadata dial.
      if (answer.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
        return context.json(
          {
            error: `That attachment is ${answer.bytes.byteLength} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte (25 MiB) limit this deployment serves.`,
          },
          413,
        );
      }
      // ETag only when the provider supplied a digest (see client.ts); the
      // response is built whole from the answer, so a failure above answers
      // JSON and never a half-streamed body. This toolchain's BodyInit takes
      // the buffer itself, not a view over one.
      const body = answer.bytes.buffer.slice(
        answer.bytes.byteOffset,
        answer.bytes.byteOffset + answer.bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type":
            scope.metadata.mimeType !== ""
              ? scope.metadata.mimeType
              : "application/octet-stream",
          // Mail attachments are attacker-controlled content: the download
          // is an attachment with nosniff (the channels-surface pair), so a
          // renderable declared type can never execute in the reader.
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": String(answer.bytes.byteLength),
          "Cache-Control": "no-store",
          ...(answer.sha256 !== null ? { ETag: `"${answer.sha256}"` } : {}),
        },
      });
    },
  );

  return routes;
}

/** Strict: a typo is a 400, never a silently coerced page. Above the ceiling clamps. */
function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < 1 || !Number.isSafeInteger(parsed)) return null;
  return Math.min(parsed, MAX_LIMIT);
}

/** Whether a message sorts strictly after the cursor position (both descending). */
function comesAfter(
  message: OpenMuseMailMessage,
  cursor: { receivedAt: number; id: string },
): boolean {
  const at = Date.parse(message.receivedAt);
  if (at !== cursor.receivedAt) return at < cursor.receivedAt;
  return message.id < cursor.id;
}
