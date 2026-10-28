import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { classifyAttachment } from "../../../shared/attachments";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/public";
import { sniffMimeType } from "../channels/attachment-mime";
import {
  OpenMuseConnectionRefusedError,
  type OpenMuseGoogleOAuth,
  OpenMuseVendorUnavailableError,
} from "../openmuse-connectors/google-oauth";
import {
  type OpenMuseMailClient,
  OpenMuseMailVendorError,
} from "../openmuse-mail/client";
import { mapAttachmentMetadata } from "../openmuse-mail/mail";
import { parsePageLimit } from "../paging";
import { OPENMUSE_MAX_FILE_BYTES, OPENMUSE_MAX_PDF_BYTES } from "./bytes";
import {
  type OpenMuseFileCursor,
  type OpenMuseFileDto,
  OpenMuseFileQuotaError,
  type OpenMuseFileStore,
  OpenMuseOwnerDisabledError,
} from "./store";

const log = getLogger("server");

/** Multipart framing overhead the body limit grants above the byte ceiling. */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

const PDF_MIME = "application/pdf";
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

/** Whether the bytes open with the PDF magic — the one truth both the upload
 * branch and the Gmail import apply to outvote a false type claim. */
function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_MAGIC.length &&
    PDF_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/** The DTO shape every file answer (upload, list, metadata) shares. */
function fileJson(file: OpenMuseFileDto) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    versionId: file.versionId,
    createdAt: file.createdAt.toISOString(),
  };
}

/**
 * `/api/mobile/openmuse-files`: upload one personal file and list your own.
 *
 * THE UPLOAD ENCODING IS MULTIPART (`multipart/form-data`, one `file` part)
 * and not raw-body-plus-headers: the file name travels in the part header
 * where browsers and Expo FormData both encode UTF-8 natively, so a CJK or
 * emoji filename needs no RFC 5987 handshake an `X-File-Name` header would.
 *
 * The client never chooses where bytes land: the byte path is derived from
 * server-minted ids in `store.ts`, per §5.
 */
export function createOpenMuseFilesRoutes(deps: {
  store: OpenMuseFileStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * T14: the Gmail import dial — openmuse-mail's client used read-only
   * (metadata + bytes) beside the G01 connection guard whose alias scopes
   * every vendor call to the owner's own mailbox. Optional because the
   * app.ts wiring is not this ticket's; absent mail leaves the import
   * answering 503 while every other route is unaffected.
   */
  mail?: {
    client: OpenMuseMailClient;
    service: Pick<OpenMuseGoogleOAuth, "requireConnection">;
  };
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    // A body limit's 413 is an answer to the client, not a fault: pass it
    // through instead of masking it as a retry-me 503 (same as mobile-bff).
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof OpenMuseOwnerDisabledError) {
      return context.json(
        { error: "This owner's files are unavailable." },
        403,
      );
    }
    if (error instanceof OpenMuseFileQuotaError) {
      // The per-owner aggregate cap, like the per-file ceilings: the caller
      // asked for more room than the quota grants, with a stable code.
      return context.json(
        {
          error: `That upload would pass this owner's ${error.capBytes}-byte Files quota. Delete some files first.`,
          code: error.code,
        },
        413,
      );
    }
    if (error instanceof OpenMuseConnectionRefusedError) {
      // §4: the consent guard refuses before any vendor call — stable 409.
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
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json({ error: "Supply a valid request." }, 400);
    }
    log.error(
      {
        type: "openmuse-files-route-error",
        error: error.name,
        context: { route: context.req.path },
      },
      "openmuse-files-route-error",
    );
    return context.json(
      { error: "Files are unavailable right now. Try again." },
      503,
    );
  });

  routes.post(
    "/",
    bodyLimit({
      maxSize: OPENMUSE_MAX_FILE_BYTES + MULTIPART_FRAMING_ALLOWANCE,
    }),
    async (context) => {
      const actor = context.var.actor;
      const form = await context.req.formData().catch(() => null);
      const part = form?.get("file") ?? null;
      if (!(part instanceof File)) {
        return context.json(
          { error: 'Supply the file as a "file" part.' },
          400,
        );
      }
      const name = z
        .string()
        .min(1, "The file needs a name.")
        .max(255)
        // The same rule the rename route enforces: a name is a label, never
        // a path, and an NUL would only fail at the row insert — after the
        // bytes had landed (a misleading 503 and an orphan blob).
        .refine(
          (value) => !/[\\/]/.test(value) && !value.includes("\0"),
          "The name may not contain path separators.",
        )
        .parse(part.name.trim());
      const bytes = new Uint8Array(await part.arrayBuffer());
      /*
       * The part's declared type is only a claim: the stored name is earned
       * from the bytes the same way channel attachments earn theirs
       * (`sniffMimeType`), which also covers the multipart round-trip losing
       * per-part Content-Type headers. A PDF additionally outvotes a false
       * non-PDF claim through its own magic bytes, so "%PDF-" always gets the
       * 10 MiB PDF ceiling rather than the general 20 MiB.
       */
      const sniffed = sniffMimeType(bytes, part.type);
      const isPdf = sniffed === PDF_MIME || hasPdfMagic(bytes);
      /*
       * Round 6 (M27): the magic outvote must also normalize what is STORED.
       * Admitting the bytes as a PDF while keeping the un-corroborated
       * sniffed name lands genuine PDFs (a generic claim sniffs to
       * octet-stream) as non-PDFs that documents' inspect/fill then refuse —
       * the same upload path that just admitted them — and lets a
       * "%PDF-"-prefixed polyglot claimed "text/html" bypass the classify
       * refusal below yet store the refused name. The Gmail import stores
       * PDF_MIME after its own magic check; this mirrors it.
       */
      const mimeType = isPdf ? PDF_MIME : sniffed;
      /*
       * The sniffed name must earn storage the same way channel attachments
       * earn it: `sniffMimeType` hands named formats like `text/html` and
       * `image/svg+xml` back BY NAME precisely so the caller can refuse them,
       * and this route serves the stored type back on its own origin — an
       * un-classified upload is a stored XSS. PDFs are this surface's own
       * format and pass on their magic.
       */
      const kind = classifyAttachment(mimeType);
      if (!isPdf && kind !== "image" && kind !== "text") {
        return context.json({ error: "That file type cannot be stored." }, 415);
      }
      const ceiling = isPdf ? OPENMUSE_MAX_PDF_BYTES : OPENMUSE_MAX_FILE_BYTES;
      if (bytes.byteLength > ceiling) {
        return context.json(
          {
            error: `That file is larger than the ${ceiling} byte limit for ${
              isPdf ? "a PDF" : "an upload"
            }.`,
          },
          413,
        );
      }
      const rawKey = context.req.header("Idempotency-Key")?.trim() ?? "";
      const idempotencyKey =
        rawKey === ""
          ? null
          : // The `upload:` prefix is the namespace fence: import keys are
            // deterministic `gmail:...` strings built from request bodies, so
            // an unprefixed client key of the same shape could pre-seed the
            // convergence lookup and hand the importer a squatted file.
            z.string().max(255).parse(`upload:${rawKey}`);
      const result = await deps.store.upload({
        ownerUserId: actor.id,
        name,
        mimeType,
        bytes,
        idempotencyKey,
      });
      return context.json(
        fileJson(result.file),
        result.deduplicated ? 200 : 201,
      );
    },
  );

  routes.get("/", async (context) => {
    const actor = context.var.actor;
    const parsedLimit = parsePageLimit(context.req.query("limit") ?? null, 100);
    if (!parsedLimit.ok) {
      return context.json({ error: parsedLimit.error }, 400);
    }
    const rawCursor = context.req.query("cursor") ?? null;
    let before: OpenMuseFileCursor | undefined;
    if (rawCursor !== null && rawCursor !== "") {
      const decoded = z
        .object({ createdAt: z.string().datetime(), id: z.string().min(1) })
        .safeParse(
          (() => {
            try {
              return JSON.parse(
                Buffer.from(rawCursor, "base64").toString("utf8"),
              ) as unknown;
            } catch {
              return null;
            }
          })(),
        );
      if (!decoded.success) {
        return context.json({ error: "That page cursor is not valid." }, 400);
      }
      before = {
        createdAt: new Date(decoded.data.createdAt),
        id: decoded.data.id,
      };
    }
    const limit = parsedLimit.limit ?? 25;
    const listed = await deps.store.list(actor.id, { limit, before });
    const page = listed.files;
    const nextCursor =
      page.length === limit
        ? Buffer.from(
            JSON.stringify({
              createdAt: page[page.length - 1]?.createdAt.toISOString(),
              id: page[page.length - 1]?.id,
            }),
          ).toString("base64")
        : undefined;
    return context.json({
      files: page.map(fileJson),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    });
  });

  /*
   * Owner-scoped metadata. A foreign or tombstoned id is a 404 rather than a
   * 403: existence itself is not disclosed (§5).
   */
  routes.get("/:id", async (context) => {
    const owned = await deps.store.getOwnedFile(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!owned) {
      return context.json({ error: "No such file." }, 404);
    }
    return context.json(fileJson(owned.file));
  });

  /*
   * The bytes, resolved only by the server-derived key: no query parameter
   * or header reaches the byte store (§5). The byte store's seam returns
   * whole buffers, not streams — the download is buffered at that seam today;
   * a streaming seam is a later perf ticket (bytes.ts stays untouched).
   */
  routes.get("/:id/content", async (context) => {
    const owned = await deps.store.getOwnedFile(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!owned) {
      return context.json({ error: "No such file." }, 404);
    }
    const bytes = await owned.read();
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": owned.file.mimeType,
        "Content-Length": String(bytes.byteLength),
        /*
         * The ETag names the bytes being returned, not the original upload's
         * hash: a fill appends versions, and the DTO's sha256 is pinned to
         * the original by §5 — the served version's hash rides the ETag so a
         * revalidation after a fill cannot short-circuit onto stale content.
         */
        ETag: `"sha256:${owned.versionSha256}"`,
        // Defense in depth beside the classify gate on upload: these bytes
        // are never a page, whatever a claim said.
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  /*
   * F03 rename: display metadata only. The name is a label, never a path —
   * no separator can smuggle one in, because the byte path stays derived from
   * server-minted ids (§5).
   */
  /*
   * The JSON routes carry their own small body limit: this sub-app is
   * mounted BEFORE the bff's family 8 KiB limit, so without one a
   * `req.json()` call buffers an unbounded body into memory before zod ever
   * refuses it — the same reasoning the tasks sub-app applies (64 KiB there).
   */
  routes.patch("/:id", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const { name } = z
      .object({
        name: z
          .string()
          .trim()
          .min(1, "The file needs a name.")
          .max(255)
          .refine(
            (value) => !/[\\/]/.test(value) && !value.includes("\0"),
            "The name may not contain path separators.",
          ),
      })
      .parse(await context.req.json());
    const renamed = await deps.store.rename(
      context.var.actor.id,
      context.req.param("id"),
      name,
    );
    if (!renamed) {
      return context.json({ error: "No such file." }, 404);
    }
    return context.json(fileJson(renamed));
  });

  /*
   * F03 delete: tombstone now. The blob survives for D06's physical purge;
   * every live read already refuses tombstoned rows (re-asserted in tests).
   */
  routes.delete("/:id", async (context) => {
    const tombstoned = await deps.store.tombstone(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!tombstoned) {
      return context.json({ error: "No such file." }, 404);
    }
    return context.body(null, 204);
  });

  /*
   * T14 (issue #71): import the owner's Gmail PDF attachment as one File.
   * The mail half is openmuse-mail's, used read-only: the metadata dial
   * gates on PDF + name, the bytes dial supplies what upload stores, and
   * the alias the G01 guard answers scopes both to the owner's own mailbox
   * (a foreign attachment and a missing one are the same 404 under an
   * alias-bound dial, by mail's design).
   *
   * PROVENANCE REPRESENTATION, recorded: the F01 schema carries no source
   * column, so the idempotency-key namespace IS the durable provenance —
   * `gmail:<threadId>:<messageId>:<attachmentId>:<importKey>` on the file
   * row names the message and thread the file came from, and no client
   * upload key can land in that namespace.
   *
   * RETRY-FETCH DECISION, recorded: the converged key is answered from the
   * store BEFORE the connection guard and any vendor dial, so a
   * same-importKey retry makes ZERO Gmail calls and converges even after
   * the account has since disconnected.
   */
  routes.post(
    "/import/gmail-attachment",
    // Same JSON-buffer reasoning as the rename route above.
    bodyLimit({ maxSize: 64 * 1024 }),
    async (context) => {
      const actor = context.var.actor;
      const { threadId, messageId, attachmentId, importKey } = z
        .object({
          threadId: z.string().min(1).max(255),
          messageId: z.string().min(1).max(255),
          attachmentId: z.string().min(1).max(255),
          importKey: z.string().min(1).max(255),
        })
        .parse(await context.req.json());
      if (deps.mail === undefined) {
        throw new OpenMuseVendorUnavailableError();
      }
      const idempotencyKey = `gmail:${threadId}:${messageId}:${attachmentId}:${importKey}`;
      const converged = await deps.store.findByIdempotencyKey(
        actor.id,
        idempotencyKey,
      );
      if (converged !== null) {
        return context.json(fileJson(converged), 200);
      }
      const connection = await deps.mail.service.requireConnection(
        actor.id,
        "gmail",
      );
      const record = await deps.mail.client.getAttachment(
        connection.alias,
        threadId,
        messageId,
        attachmentId,
      );
      if (record === null) {
        return context.json(
          { error: "That attachment does not exist in this account's mail." },
          404,
        );
      }
      const metadata = mapAttachmentMetadata(record);
      if (metadata.mimeType !== PDF_MIME) {
        return context.json(
          {
            error: `Only PDF attachments can be imported into Files; this one is ${
              metadata.mimeType === "" ? "of no known type" : metadata.mimeType
            }.`,
          },
          400,
        );
      }
      /*
       * §5's PDF ceiling, checked on the vendor's own size claim BEFORE the
       * bytes dial — the same ceiling an upload of the same PDF would meet,
       * so the import cannot smuggle a bigger PDF past the limit.
       */
      if (metadata.size > OPENMUSE_MAX_PDF_BYTES) {
        return context.json(
          {
            error: `That attachment is ${metadata.size} bytes, over the ${OPENMUSE_MAX_PDF_BYTES}-byte (10 MiB) limit for a PDF in Files.`,
          },
          413,
        );
      }
      const answer = await deps.mail.client.getAttachmentBytes(
        connection.alias,
        threadId,
        messageId,
        attachmentId,
      );
      if (answer === null) {
        // Vanished between the metadata dial and this one: the same 404.
        return context.json(
          { error: "That attachment does not exist in this account's mail." },
          404,
        );
      }
      /*
       * The recheck on REAL bytes: the metadata dial above saw only the
       * vendor's own size/mime claims (a sparse answer degrades size to 0 and
       * sails past the ceiling), so the bytes must clear the same two bars the
       * upload path clears — the ceiling and the PDF magic — before anything
       * is stored under PDF_MIME. Otherwise the import's "cannot smuggle a
       * bigger PDF past the limit" invariant is the vendor's word.
       */
      if (answer.bytes.byteLength > OPENMUSE_MAX_PDF_BYTES) {
        return context.json(
          {
            error: `That attachment is over the ${OPENMUSE_MAX_PDF_BYTES}-byte PDF limit.`,
          },
          413,
        );
      }
      if (!hasPdfMagic(answer.bytes)) {
        return context.json({ error: "That attachment is not a PDF." }, 400);
      }
      /*
       * A sparse vendor answer degrades name/mimeType to "" (mail's mapping
       * contract); an empty name would surface as a nameless File, so it
       * falls back to one derived from the attachment id. The name comes from
       * the SENDER, so it earns the same rule the rename route enforces
       * before anything is stored: separators and NUL stripped (a NUL fails
       * the row insert after the bytes landed), and the fallback sliced to
       * the same 255 the id itself can exceed.
       */
      const safeName = metadata.name
        .trim()
        .replace(/[\\/\0]/g, "")
        .slice(0, 255);
      const name = safeName || `gmail-${attachmentId}.pdf`.slice(0, 255);
      const result = await deps.store.upload({
        ownerUserId: actor.id,
        name,
        mimeType: PDF_MIME,
        bytes: answer.bytes,
        idempotencyKey,
      });
      return context.json(
        fileJson(result.file),
        result.deduplicated ? 200 : 201,
      );
    },
  );

  return routes;
}
