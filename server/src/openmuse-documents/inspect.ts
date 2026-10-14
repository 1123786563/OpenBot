import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";
import { OPENMUSE_MAX_PDF_BYTES } from "../openmuse-files/bytes";

/**
 * F05: what a PDF's form fields are, split into the kinds the fill flow can
 * write (text, checkbox) and the kinds it must report as unsupported
 * (dropdown, radio, option list, and anything else AcroForm grows). The
 * classification is pure over an extracted field list — the extraction seam
 * `PdfFieldExtractor` is injectable so tests classify plain data and refuse
 * typed errors without a PDF in sight, while the production extractor (pdf-lib,
 * the same library OpenMuse's worker inspects with) does the parsing.
 */

/** One field the extractor found, named exactly as the PDF names it. */
export type ExtractedPdfField =
  | { kind: "text"; name: string; maxChars?: number }
  | { kind: "checkbox"; name: string }
  | { kind: "dropdown"; name: string }
  | { kind: "radio"; name: string }
  | { kind: "option-list"; name: string }
  | { kind: "other"; name: string };

export type ExtractedPdf = {
  pageCount: number;
  fields: ExtractedPdfField[];
};

/** §5: encrypted, XFA and malformed refuse with distinct errors. */
export type PdfRefusalKind =
  | "pdf_malformed"
  | "pdf_encrypted"
  | "pdf_xfa"
  | "pdf_too_many_pages";

export class PdfRefusalError extends Error {
  readonly pageCount?: number;
  constructor(
    readonly kind: PdfRefusalKind,
    pageCount?: number,
  ) {
    super(pageCount === undefined ? kind : `${kind}: ${pageCount} pages`);
    this.name = "PdfRefusalError";
    this.pageCount = pageCount;
  }
}

/** The extraction seam: bytes in, page count and named fields out. */
export type PdfFieldExtractor = (bytes: Uint8Array) => Promise<ExtractedPdf>;

/** §5: the PDF page limit the extractor's count is held against. */
export const MAX_PDF_PAGES = 500;

/** What inspection answers: every field, on one side of the line or the other. */
export type PdfInspection = {
  pageCount: number;
  supported: Array<{
    name: string;
    type: "text" | "checkbox";
    maxChars?: number;
  }>;
  unsupported: Array<{ fieldName: string; reason: string }>;
};

const UNSUPPORTED_REASONS: Record<
  Exclude<ExtractedPdfField["kind"], "text" | "checkbox">,
  string
> = {
  dropdown: "Dropdown fields are not supported.",
  radio: "Radio button fields are not supported.",
  "option-list": "Option list fields are not supported.",
  other: "This field type is not supported.",
};

export function classifyPdfFields(
  fields: ExtractedPdfField[],
): Pick<PdfInspection, "supported" | "unsupported"> {
  const supported: PdfInspection["supported"] = [];
  const unsupported: PdfInspection["unsupported"] = [];
  for (const field of fields) {
    if (field.kind === "text") {
      supported.push({
        name: field.name,
        type: "text",
        ...(field.maxChars !== undefined ? { maxChars: field.maxChars } : {}),
      });
    } else if (field.kind === "checkbox") {
      supported.push({ name: field.name, type: "checkbox" });
    } else {
      unsupported.push({
        fieldName: field.name,
        reason: UNSUPPORTED_REASONS[field.kind],
      });
    }
  }
  return { supported, unsupported };
}

/**
 * The whole inspection over an extractor: hold the page count against §5's
 * limit (the refusal names the count), then classify.
 */
export async function inspectPdfDocument(
  bytes: Uint8Array,
  extract: PdfFieldExtractor,
): Promise<PdfInspection> {
  const extracted = await extract(bytes);
  if (extracted.pageCount > MAX_PDF_PAGES) {
    throw new PdfRefusalError("pdf_too_many_pages", extracted.pageCount);
  }
  return {
    pageCount: extracted.pageCount,
    ...classifyPdfFields(extracted.fields),
  };
}

/**
 * The guarded loader both document flows share (F05 inspect, F06 fill),
 * ported from OpenMuse's `packages/integrations/src/pdf.ts`: pdf-lib loads
 * with encryption refused and invalid objects fatal, the XFA marker is looked
 * up in the catalog's AcroForm, and everything the loader throws that is
 * neither becomes one malformed refusal — the routes give each kind its own
 * answer.
 */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  if (
    bytes.length === 0 ||
    bytes.length > OPENMUSE_MAX_PDF_BYTES ||
    Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0
  ) {
    throw new PdfRefusalError("pdf_malformed");
  }
  try {
    /*
     * The bytes are handed over without a defensive copy: they come from the
     * byte store's exclusive read, pdf-lib does not modify its input, and a
     * copy would double the 10 MiB ceiling's footprint on every check/fill.
     */
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (doc.isEncrypted) {
      throw new PdfRefusalError("pdf_encrypted");
    }
    if (
      doc.catalog
        .lookupMaybe(PDFName.of("AcroForm"), PDFDict)
        ?.has(PDFName.of("XFA"))
    ) {
      throw new PdfRefusalError("pdf_xfa");
    }
    return doc;
  } catch (error) {
    if (error instanceof PdfRefusalError) throw error;
    if (error instanceof Error && /encrypt/i.test(error.message)) {
      throw new PdfRefusalError("pdf_encrypted");
    }
    throw new PdfRefusalError("pdf_malformed");
  }
}

/**
 * The production extractor's doc half: page count and fields off an
 * ALREADY-LOADED document. Split from the loader (round 6 M26) so the fill
 * route can parse once — the extractor and the fill adapter share one
 * loadPdfDocument — while the bytes-shaped extractor below keeps the
 * standalone inspect path its own single parse.
 */
export function extractPdfDocument(doc: PDFDocument): Promise<ExtractedPdf> {
  try {
    return Promise.resolve({
      pageCount: doc.getPageCount(),
      fields: doc.getForm().getFields().map(extractedField),
    });
  } catch (error) {
    if (error instanceof PdfRefusalError) throw error;
    /*
     * The load guard covers PDFDocument.load only: a form that loads
     * clean but breaks while walked (a torn AcroForm whose /Fields entry
     * is not a field dict) throws pdf-lib's native errors, which must
     * not escape as a retry-me 503 — the document is the problem, so it
     * refuses malformed exactly like the fill adapter's own catch.
     */
    throw new PdfRefusalError("pdf_malformed");
  }
}

/**
 * The production extractor: load guarded, then answer the page count and the
 * fields as the extractor's callers classify them.
 */
export function createPdfFieldExtractor(): PdfFieldExtractor {
  return async (bytes) => extractPdfDocument(await loadPdfDocument(bytes));
}

function extractedField(field: PDFField): ExtractedPdfField {
  const name = field.getName();
  if (field instanceof PDFTextField) {
    const maxChars = field.getMaxLength();
    return {
      kind: "text",
      name,
      ...(maxChars !== undefined ? { maxChars } : {}),
    };
  }
  if (field instanceof PDFCheckBox) return { kind: "checkbox", name };
  if (field instanceof PDFRadioGroup) return { kind: "radio", name };
  if (field instanceof PDFDropdown) return { kind: "dropdown", name };
  if (field instanceof PDFOptionList) return { kind: "option-list", name };
  // Buttons and signatures are writable by nobody here: reported, not dropped.
  return { kind: "other", name };
}
