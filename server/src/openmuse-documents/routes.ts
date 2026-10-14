import type { PDFDocument } from "pdf-lib";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLogger } from "../../../shared/logger";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { OPENMUSE_MAX_PDF_BYTES } from "../openmuse-files/bytes";
import {
  type OpenMuseFileStore,
  OpenMuseOwnerDisabledError,
} from "../openmuse-files/store";
import {
  applyFill,
  createPdfFillAdapter,
  type PdfFillAdapter,
  PdfFillRefusalError,
  type TypedPdfFillValues,
  validateFill,
} from "./fill";
import {
  createPdfFieldExtractor,
  extractPdfDocument,
  inspectPdfDocument,
  loadPdfDocument,
  type PdfFieldExtractor,
  PdfRefusalError,
  MAX_PDF_PAGES,
} from "./inspect";
import {
  transferVersionToWorkspace,
  type WorkspaceTransferFilesystem,
} from "./transfer";

const log = getLogger("server");

/**
 * The fill body's byte ceiling: values are bounded per field (§5's 10,000
 * characters), so a body past this is not a fill anyone meant — it is
 * refused by size before the JSON is parsed, not after an unbounded read.
 *
 * KNOWN MOUNT GAP (recorded): production mounts this sub-app AFTER the
 * mobile-bff family 8 KiB body limit (app.ts mounts /api/mobile first), so
 * a fill body over 8 KiB is answered by that family 413 before this ceiling
 * is reached — long two-field fills §5's per-field budget admits (~20 KiB)
 * do not fit through it. The mount must move in front of the family limit
 * (the way openMuseFiles and openMuseTasks are mounted inside the bff) for
 * this ceiling to be the one that stands; that wiring is app.ts's, recorded
 * as a dependency rather than changed here.
 */
const OPENMUSE_MAX_FILL_BODY_BYTES = 1_000_000;

/**
 * Each refusal kind's public answer. The message lives here, not at the
 * throw site, so the HTTP surface stays one place however the extractor is
 * swapped: malformed bytes are a bad request, a well-formed PDF this flow
 * cannot read (encrypted, XFA, over the page limit) is a refusal.
 */
function refusalAnswer(error: PdfRefusalError): {
  status: 400 | 422;
  error: string;
} {
  switch (error.kind) {
    case "pdf_malformed":
      return { status: 400, error: "That file is not a readable PDF." };
    case "pdf_encrypted":
      return { status: 422, error: "Encrypted PDFs cannot be inspected." };
    case "pdf_xfa":
      return { status: 422, error: "XFA PDF forms cannot be inspected." };
    case "pdf_too_many_pages":
      return {
        status: 422,
        error: `This PDF has ${error.pageCount} pages; the limit is ${MAX_PDF_PAGES}.`,
      };
  }
}

/**
 * Each fill refusal's public answer, mirroring `refusalAnswer`: the message
 * lives here, not at the throw site, so the HTTP surface stays one place.
 */
function fillRefusalAnswer(error: PdfFillRefusalError): string {
  switch (error.kind) {
    case "fill_unknown_field":
      return `Unknown field: ${error.fieldName}.`;
    case "fill_unsupported_field":
      return `Field ${error.fieldName} is not supported for filling.`;
    case "fill_wrong_type":
      return `Field ${error.fieldName} needs a ${error.detail} value.`;
    case "fill_text_too_long":
      return `Field ${error.fieldName} is too long; ${error.detail}.`;
  }
}

/**
 * `/api/mobile/openmuse-files/:id/inspect` (F05): which of a stored PDF's
 * form fields the fill flow supports. Read-only — the file's bytes are read
 * through the files store (the server-derived key never leaves it) and never
 * written, so the original stays exactly as uploaded; fill is F06's copy.
 */
export function createOpenMuseDocumentsRoutes(deps: {
  store: OpenMuseFileStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Extraction seam: production pdf-lib; tests inject field lists and refusals. */
  extract?: PdfFieldExtractor;
  /** Fill seam: production pdf-lib; tests inject a recording adapter. */
  fill?: PdfFillAdapter;
  /**
   * Workspace seam (F09): the owner's private Bot's workspace, resolved per
   * request — index.ts owns the production binding to the computer gateway's
   * writeFile (see transfer.ts's seam citation for why it speaks bytes).
   * Tests inject a recording fake; an unwired deployment answers 503.
   */
  transferWorkspace?: (
    actor: AuthenticatedActor,
  ) => Promise<WorkspaceTransferFilesystem | null>;
}): Hono<{ Variables: AppVariables }> {
  const defaultExtract = createPdfFieldExtractor();
  const extract: PdfFieldExtractor = deps.extract ?? defaultExtract;
  const fillAdapter: PdfFillAdapter = deps.fill ?? createPdfFillAdapter();
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      return context.json(
        { error: "This owner's files are unavailable." },
        403,
      );
    }
    log.error(
      {
        type: "openmuse-documents-route-error",
        // The whole error, not just its class name: this fallback log is the
        // only scene of an unexpected failure, and a name alone cannot be
        // debugged from.
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: { route: context.req.path },
      },
      "openmuse-documents-route-error",
    );
    return context.json(
      { error: "Documents are unavailable right now. Try again." },
      503,
    );
  });

  routes.post("/:id/inspect", async (context) => {
    /*
     * Owner-scoped like every files answer: a foreign or tombstoned id is a
     * 404, because existence itself is not disclosed (§5).
     */
    const owned = await deps.store.getOwnedFile(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!owned) {
      return context.json({ error: "No such file." }, 404);
    }
    if (owned.file.mimeType !== "application/pdf") {
      return context.json({ error: "Only PDFs can be inspected." }, 400);
    }
    if (owned.file.size > OPENMUSE_MAX_PDF_BYTES) {
      return context.json(
        {
          error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
        },
        413,
      );
    }
    const bytes = await owned.read();
    /*
     * The truth the bytes carry, not the metadata's stale size: appendVersion
     * never touches the file row's size, so a fill-derived latest can be
     * larger than the original the row still names. Without this the 400 of
     * loadPdfDocument's own guard would answer where a 413 belongs, and the
     * over-limit latest could never be told apart from an unreadable PDF.
     */
    if (bytes.byteLength > OPENMUSE_MAX_PDF_BYTES) {
      return context.json(
        {
          error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
        },
        413,
      );
    }
    try {
      return context.json(await inspectPdfDocument(bytes, extract), 200);
    } catch (error) {
      if (error instanceof PdfRefusalError) {
        const answer = refusalAnswer(error);
        return context.json({ error: answer.error }, answer.status);
      }
      throw error;
    }
  });

  /*
   * `/api/mobile/openmuse-files/:id/fill` (F06): write a NEW version with
   * the requested field values. The owner-scoped read and the PDF guards
   * mirror inspect; validation refuses before any write (§5), so an unknown
   * name or a wrong type leaves neither a version row nor a byte write, and
   * the original's bytes are only ever read.
   */
  routes.post(
    "/:id/fill",
    bodyLimit({
      maxSize: OPENMUSE_MAX_FILL_BODY_BYTES,
      onError: (context) =>
        context.json(
          {
            error: `The fill body is larger than the ${OPENMUSE_MAX_FILL_BODY_BYTES} byte limit.`,
          },
          413,
        ),
    }),
    async (context) => {
      const owned = await deps.store.getOwnedFile(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!owned) {
        return context.json({ error: "No such file." }, 404);
      }
      if (owned.file.mimeType !== "application/pdf") {
        return context.json({ error: "Only PDFs can be filled." }, 400);
      }
      if (owned.file.size > OPENMUSE_MAX_PDF_BYTES) {
        return context.json(
          {
            error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
          },
          413,
        );
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json(
          { error: "The fill needs a JSON body with values." },
          400,
        );
      }
      const values = (body as { values?: unknown } | null)?.values;
      if (
        typeof values !== "object" ||
        values === null ||
        Array.isArray(values) ||
        /*
         * An empty values object is not a fill: it would load and re-save the
         * PDF (pdf-lib recalculates field appearances) just to append a
         * version equivalent to its parent — noise, plus a wider window for
         * the stale-parent 409 below.
         */
        Object.keys(values).length === 0
      ) {
        return context.json({ error: "The fill needs a values object." }, 400);
      }
      const bytes = await owned.read();
      // The served bytes' own length, not the row's stale original size
      // (see the inspect route's guard).
      if (bytes.byteLength > OPENMUSE_MAX_PDF_BYTES) {
        return context.json(
          {
            error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
          },
          413,
        );
      }
      let filled: Uint8Array;
      let typed: TypedPdfFillValues;
      try {
        /*
         * Round 6 (M26): ONE parse for the whole fill. The memoized loader
         * hands the same PDFDocument to the inspection and to the fill
         * adapter — the production path used to parse the same ≤10 MiB
         * bytes twice (extractor once, adapter once), doubling the heaviest
         * authenticated endpoint's CPU. Tests injecting `extract` still run
         * their plain-data fakes; the loader is only ever called when the
         * production extractor is the one inspecting.
         */
        let parsed: PDFDocument | undefined;
        const loadOnce = async () => {
          parsed ??= await loadPdfDocument(bytes);
          return parsed;
        };
        const extractor: PdfFieldExtractor =
          extract === defaultExtract
            ? async () => extractPdfDocument(await loadOnce())
            : extract;
        const inspection = await inspectPdfDocument(bytes, extractor);
        typed = validateFill(inspection, values as Record<string, unknown>);
        const load = parsed !== undefined ? loadOnce : () => loadPdfDocument(bytes);
        filled = await applyFill(load, inspection, typed, fillAdapter);
      } catch (error) {
        if (error instanceof PdfFillRefusalError) {
          return context.json({ error: fillRefusalAnswer(error) }, 422);
        }
        if (error instanceof PdfRefusalError) {
          const answer = refusalAnswer(error);
          return context.json({ error: answer.error }, answer.status);
        }
        throw error;
      }
      // The append side of the same ceiling: a fill that swells the derived
      // version past the limit must refuse here, not land a latest version
      // no later flow can open.
      if (filled.byteLength > OPENMUSE_MAX_PDF_BYTES) {
        return context.json(
          {
            error: `The filled PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
          },
          413,
        );
      }
      const version = await deps.store.appendVersion({
        ownerUserId: context.var.actor.id,
        fileId: owned.file.id,
        bytes: filled,
        parentVersionId: owned.file.versionId,
        values: typed,
      });
      if (version === "stale-parent") {
        /*
         * The append lost the race: another fill landed between this route's
         * read and its append. Round 6 (M23) closed the fork this answer
         * always claimed to prevent: parent_version_id is persisted with a
         * partial unique index on (file_id, parent_version_id), so two fills
         * overlapping in flight — both past the read-side check — cannot
         * BOTH land; the loser fails at the insert and lands here. The
         * sequential case a single client can produce is unchanged.
         */
        return context.json(
          { error: "A newer version exists; reload the file and fill again." },
          409,
        );
      }
      if (!version) {
        return context.json({ error: "No such file." }, 404);
      }
      return context.json(
        {
          versionId: version.versionId,
          parentVersionId: version.parentVersionId,
          sha256: version.sha256,
          size: filled.byteLength,
          values: typed,
        },
        201,
      );
    },
  );

  /*
   * `/api/mobile/openmuse-files/:id/transfer` (F09): copy one PDF version
   * into the private Bot's workspace. The destination is server-derived
   * (transfer.ts); any client destination field is ignored by never being
   * read. Scope v1: only the file's CURRENT version transfers — the store
   * reads no historical version's bytes — so a stale versionId answers 409
   * (§6's stale pattern) rather than a silent fallback to latest.
   */
  routes.post(
    "/:id/transfer",
    // Round 6 (M24): the only route of the three without a local limit. It
    // was "covered" by the mobile-bff family's 8 KiB by accident of the old
    // mount order — the same gap the fill fix (M4/H5) closes — and without a
    // limit of its own, an authenticated caller could post an unbounded JSON
    // body into req.json(). Tasks-grade: the body is one id and one ≤200-char
    // key; 64 KiB is generous.
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json({ error: "The transfer body is too large." }, 413),
    }),
    async (context) => {
    /*
     * Owner-scoped like every files answer: a foreign or tombstoned id is a
     * 404, because existence itself is not disclosed (§5); a §9-disabled
     * owner's store read throws to onError's 403.
     */
    const owned = await deps.store.getOwnedFile(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!owned) {
      return context.json({ error: "No such file." }, 404);
    }
    if (owned.file.mimeType !== "application/pdf") {
      return context.json({ error: "Only PDFs can be transferred." }, 400);
    }
    if (owned.file.size > OPENMUSE_MAX_PDF_BYTES) {
      return context.json(
        {
          error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
        },
        413,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error:
            "The transfer needs a JSON body with versionId and transferKey.",
        },
        400,
      );
    }
    const { versionId, transferKey } = (body ?? {}) as {
      versionId?: unknown;
      transferKey?: unknown;
    };
    if (
      typeof versionId !== "string" ||
      !versionId.trim() ||
      typeof transferKey !== "string" ||
      !transferKey.trim() ||
      transferKey.length > 200
    ) {
      return context.json(
        { error: "The transfer needs a versionId and a transferKey." },
        400,
      );
    }
    if (versionId !== owned.file.versionId) {
      return context.json(
        { error: "Only the file's current version can be transferred." },
        409,
      );
    }
    const filesystem = deps.transferWorkspace
      ? await deps.transferWorkspace(context.var.actor)
      : null;
    if (!filesystem) {
      return context.json(
        { error: "Transfers are not available on this deployment yet." },
        503,
      );
    }
    const transferBytes = await owned.read();
    // The served bytes' own length, not the row's stale original size (see
    // the inspect route's guard).
    if (transferBytes.byteLength > OPENMUSE_MAX_PDF_BYTES) {
      return context.json(
        {
          error: `That PDF is larger than the ${OPENMUSE_MAX_PDF_BYTES} byte limit.`,
        },
        413,
      );
    }
    const outcome = await transferVersionToWorkspace({
      filesystem,
      fileId: owned.file.id,
      versionId,
      transferKey,
      bytes: transferBytes,
    });
    if (outcome.kind === "failed") {
      return context.json(
        { error: "The transfer did not complete. Try again." },
        503,
      );
    }
    return context.json(
      { path: outcome.path },
      outcome.kind === "transferred" ? 201 : 200,
    );
  });

  return routes;
}
