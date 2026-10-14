import type { PDFDocument } from "pdf-lib";
import { type PdfInspection, PdfRefusalError } from "./inspect";

/**
 * F06: filling a PDF's supported form fields into a derived copy. Validation
 * is pure over an inspection (§5: an unknown name or a wrong type refuses
 * before anything is written); application goes through an injectable pdf
 * adapter whose production impl loads through the same guarded loader the
 * extractor uses. Fields stay live — no flattening — so the derived version
 * can be inspected and filled again.
 */

/** One value the type check let through: string for text, boolean for checkbox. */
export type TypedPdfFillValues = Record<string, string | boolean>;

/** §5: text values are strings up to 10,000 characters. */
export const MAX_FILL_TEXT_CHARS = 10_000;

export type PdfFillRefusalKind =
  | "fill_unknown_field"
  | "fill_unsupported_field"
  | "fill_wrong_type"
  | "fill_text_too_long";

export class PdfFillRefusalError extends Error {
  constructor(
    readonly kind: PdfFillRefusalKind,
    readonly fieldName: string,
    readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? `${kind}: ${fieldName}`
        : `${kind}: ${fieldName}: ${detail}`,
    );
    this.name = "PdfFillRefusalError";
  }
}

/**
 * Supported ∩ known ∩ type-checked: each requested name must be a supported
 * field (an unsupported one is named as such, an absent one is unknown), and
 * its value must match the field's type within §5's text limits. Everything
 * that passes comes back as the typed map the adapter applies.
 */
export function validateFill(
  inspection: PdfInspection,
  values: Record<string, unknown>,
): TypedPdfFillValues {
  const supported = new Map(
    inspection.supported.map((field) => [field.name, field]),
  );
  const unsupported = new Set(
    inspection.unsupported.map((field) => field.fieldName),
  );
  /*
   * Null prototype: an uploaded PDF's AcroForm field name is attacker-chosen
   * and can be "__proto__" — on a plain object that name hits the prototype
   * setter and the field is silently dropped from the fill. Same defense as
   * transfer.ts's ledger keys.
   */
  const typed = Object.create(null) as TypedPdfFillValues;
  for (const [name, value] of Object.entries(values)) {
    const field = supported.get(name);
    if (field === undefined) {
      if (unsupported.has(name)) {
        throw new PdfFillRefusalError("fill_unsupported_field", name);
      }
      throw new PdfFillRefusalError("fill_unknown_field", name);
    }
    if (field.type === "text") {
      if (typeof value !== "string") {
        throw new PdfFillRefusalError("fill_wrong_type", name, "string");
      }
      if (value.length > MAX_FILL_TEXT_CHARS) {
        throw new PdfFillRefusalError(
          "fill_text_too_long",
          name,
          `the limit is ${MAX_FILL_TEXT_CHARS} characters`,
        );
      }
      /*
       * PDF spec (ISO 32000-1, MaxLen): 0 means "no limit on length", not
       * "at most zero characters" — a field reporting 0 must not have its
       * every non-empty value refused.
       */
      if (
        field.maxChars !== undefined &&
        field.maxChars > 0 &&
        value.length > field.maxChars
      ) {
        throw new PdfFillRefusalError(
          "fill_text_too_long",
          name,
          `too long for a ${field.maxChars}-character field`,
        );
      }
      typed[name] = value;
    } else {
      if (typeof value !== "boolean") {
        throw new PdfFillRefusalError("fill_wrong_type", name, "boolean");
      }
      typed[name] = value;
    }
  }
  return typed;
}

/**
 * The application seam (round 6 M26): a document LOADER plus a typed map,
 * derived bytes out — loader-shaped, not bytes-shaped, so the fill parses
 * the PDF ONCE: the route hands the adapter the same memoized
 * loadPdfDocument the inspection ran on, instead of every adapter parsing
 * its own copy of the same ≤10 MiB bytes. An injected loader also lets a
 * test count parses.
 */
export type PdfFillAdapter = (
  load: () => Promise<PDFDocument>,
  supported: PdfInspection["supported"],
  values: TypedPdfFillValues,
) => Promise<Uint8Array>;

export async function applyFill(
  load: () => Promise<PDFDocument>,
  inspection: PdfInspection,
  values: TypedPdfFillValues,
  fill?: PdfFillAdapter,
): Promise<Uint8Array> {
  const adapter = fill ?? createPdfFillAdapter();
  return adapter(load, inspection.supported, values);
}

/**
 * The production adapter: load guarded like the extractor, then set each
 * typed value. The value's runtime type names the field kind — the typed map
 * already proved the pairing — and false unchecks, so a fill can clear a
 * checkbox as deliberately as it sets one.
 */
export function createPdfFillAdapter(): PdfFillAdapter {
  return async (load, _supported, values) => {
    const doc = await load();
    try {
      const form = doc.getForm();
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === "string") {
          form.getTextField(name).setText(value);
        } else if (value === true) {
          form.getCheckBox(name).check();
        } else {
          form.getCheckBox(name).uncheck();
        }
      }
      return await doc.save();
    } catch (error) {
      if (error instanceof PdfRefusalError) throw error;
      /*
       * The load guard covers PDFDocument.load only: a form that breaks when
       * walked (getFields on a torn AcroForm) or saved (pdf-lib's appearance
       * recalculation) throws pdf-lib's native errors, which must not surface
       * as a retry-me 503 — the document is the problem, so it refuses as
       * malformed like every other unreadable-for-this-flow PDF.
       */
      throw new PdfRefusalError("pdf_malformed");
    }
  };
}
