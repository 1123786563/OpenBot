import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  applyFill,
  type PdfFillAdapter,
  PdfFillRefusalError,
  type PdfInspection,
  type TypedPdfFillValues,
  validateFill,
} from "../src/openmuse-documents/fill";
import {
  classifyPdfFields,
  createPdfFieldExtractor,
  type ExtractedPdfField,
  type PdfFieldExtractor,
  PdfRefusalError,
} from "../src/openmuse-documents/inspect";
import { createOpenMuseDocumentsRoutes } from "../src/openmuse-documents/routes";
import {
  deriveTransferPath,
  transferVersionToWorkspace,
  TRANSFER_LEDGER_PATH,
  type WorkspaceTransferFilesystem,
} from "../src/openmuse-documents/transfer";
import {
  type FileByteStore,
  OPENMUSE_MAX_PDF_BYTES,
} from "../src/openmuse-files/bytes";
import { createOpenMuseFilesRoutes } from "../src/openmuse-files/routes";
import {
  createOpenMuseFileStore,
  type OpenMuseFileRows,
  type OpenMuseFileStore,
  type StoredOpenMuseFile,
  type StoredOpenMuseFileVersion,
} from "../src/openmuse-files/store";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

let currentActor: AuthenticatedActor = actorOne;
let guardAdmits = true;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (!guardAdmits) {
    return context.json({ error: "Sign in first." }, 401);
  }
  context.set("actor", currentActor);
  await next();
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory row store: the same contract the openmuse-files tests fake. */
function fakeRows(): OpenMuseFileRows & {
  files: StoredOpenMuseFile[];
  versions: StoredOpenMuseFileVersion[];
} {
  const files: StoredOpenMuseFile[] = [];
  const versions: StoredOpenMuseFileVersion[] = [];
  const disabled = new Set<string>();
  return {
    files,
    versions,
    insertFile: async (file) => {
      files.push({ ...file });
    },
    findFileByIdempotencyKey: async (ownerUserId, key) =>
      files.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.idempotencyKey === key &&
          row.deletedAt === null,
      ) ?? null,
    findOwnedFile: async (ownerUserId, id) =>
      files.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    renameFile: async () => null,
    tombstoneFile: async (ownerUserId, id) => {
      const row = files.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null,
      );
      if (row === undefined) return false;
      row.deletedAt = new Date();
      return true;
    },
    insertVersion: async (version) => {
      versions.push({ ...version });
    },
    insertFileWithVersion: async (file, version) => {
      files.push({ ...file });
      versions.push({ ...version });
    },
    sumBytesByOwner: async (ownerUserId) =>
      files
        .filter((row) => row.ownerUserId === ownerUserId && !row.deletedAt)
        .reduce((total, row) => total + row.size, 0),
    latestVersion: async (fileId) =>
      versions.filter((row) => row.fileId === fileId).at(-1) ?? null,
    listByOwner: async () => [],
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    // No deletedAt filter: the deletion manifest (this seam's only consumer)
    // must see tombstoned files' versions too, like the drizzle rows.
    versionsByOwner: async (ownerUserId) =>
      versions.filter((version) => {
        const file = files.find((row) => row.id === version.fileId);
        return file?.ownerUserId === ownerUserId;
      }),
    // D06's purge seam — this suite never purges, so the fake needs none.
    hardDeleteFile: async () => {},
  };
}

/** In-memory byte store that counts writes and logs read keys. */
function fakeBytes(): FileByteStore & {
  writes: Map<string, number>;
  data: Map<string, Uint8Array>;
  gets: string[];
} {
  const writes = new Map<string, number>();
  const data = new Map<string, Uint8Array>();
  const gets: string[] = [];
  return {
    writes,
    data,
    gets,
    put: async (key, bytes) => {
      writes.set(key, (writes.get(key) ?? 0) + 1);
      data.set(key, bytes);
    },
    get: async (key) => {
      gets.push(key);
      return data.get(key) ?? null;
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

type Fixture = {
  store: OpenMuseFileStore;
  rows: ReturnType<typeof fakeRows>;
  bytes: ReturnType<typeof fakeBytes>;
  filesApp: Hono<{ Variables: AppVariables }>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(
  extract?: PdfFieldExtractor,
  transferWorkspace?: (
    actor: AuthenticatedActor,
  ) => Promise<WorkspaceTransferFilesystem | null>,
): Fixture {
  const rows = fakeRows();
  const bytes = fakeBytes();
  const store = createOpenMuseFileStore({ rows, byteStore: bytes });
  const filesApp = createOpenMuseFilesRoutes({ store, requireUser });
  const app = createOpenMuseDocumentsRoutes({
    store,
    requireUser,
    ...(extract ? { extract } : {}),
    ...(transferWorkspace ? { transferWorkspace } : {}),
  });
  return { store, rows, bytes, filesApp, app };
}

type UploadedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  versionId: string;
  createdAt: string;
};

/** Uploaded through the real files routes, so the row's provenance is the production one. */
async function upload(
  fixture: Fixture,
  bytes: Uint8Array,
  name = "form.pdf",
): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "application/pdf" }));
  const response = await fixture.filesApp.request("/", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as UploadedFile;
}

function inspect(fixture: Fixture, id: string): Promise<Response> {
  return fixture.app.request(`/${id}/inspect`, { method: "POST" });
}

/**
 * Fixture P-1 (contract §5): a text field `person.name` (max 40), a checkbox
 * `consent`, and a dropdown `region` — inspection lists all three.
 */
async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField("person.name");
  name.setMaxLength(40);
  name.addToPage(page, { x: 48, y: 700, width: 300, height: 24 });
  const consent = form.createCheckBox("consent");
  consent.addToPage(page, { x: 48, y: 650, width: 18, height: 18 });
  const region = form.createDropdown("region");
  region.addOptions(["North", "South"]);
  region.addToPage(page, { x: 48, y: 600, width: 200, height: 24 });
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  return doc.save();
}

/** The XFA marker the prior-art check refuses: any AcroForm XFA entry. */
async function xfaPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.getForm().acroForm.dict.set(PDFName.of("XFA"), doc.context.obj([]));
  return doc.save();
}

/**
 * A torn AcroForm: it loads clean and the XFA probe reads it as no form,
 * but its /Fields entry is not a field dict, so the walk throws pdf-lib's
 * native UnexpectedObjectTypeError — the extractor must refuse it as
 * malformed instead of letting the native error escape as a retry-me 503.
 */
async function tornAcroFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const context = doc.context;
  doc.catalog.set(
    PDFName.of("AcroForm"),
    context.obj({ Fields: context.obj([context.obj(42)]) }),
  );
  return doc.save();
}

describe("classifyPdfFields (pure seam)", () => {
  test("text and checkbox are supported with exact names, dropdown and friends are not", () => {
    const fields: ExtractedPdfField[] = [
      { kind: "text", name: "person.name", maxChars: 40 },
      { kind: "checkbox", name: "consent" },
      { kind: "dropdown", name: "region" },
      { kind: "radio", name: "channel" },
      { kind: "option-list", name: "topics" },
      { kind: "other", name: "sign-here" },
    ];
    expect(classifyPdfFields(fields)).toEqual({
      supported: [
        { name: "person.name", type: "text", maxChars: 40 },
        { name: "consent", type: "checkbox" },
      ],
      unsupported: [
        {
          fieldName: "region",
          reason: "Dropdown fields are not supported.",
        },
        {
          fieldName: "channel",
          reason: "Radio button fields are not supported.",
        },
        {
          fieldName: "topics",
          reason: "Option list fields are not supported.",
        },
        {
          fieldName: "sign-here",
          reason: "This field type is not supported.",
        },
      ],
    });
  });

  test("a text field without a max length answers no maxChars key", () => {
    const classified = classifyPdfFields([{ kind: "text", name: "notes" }]);
    expect(classified.supported).toEqual([{ name: "notes", type: "text" }]);
  });

  test("an empty field list inspects clean", () => {
    expect(classifyPdfFields([])).toEqual({ supported: [], unsupported: [] });
  });
});

describe("createPdfFieldExtractor (pdf-lib seam)", () => {
  test("extracts P-1's three fields with their kinds and the page count", async () => {
    const extracted = await createPdfFieldExtractor()(await samplePdf());
    expect(extracted).toEqual({
      pageCount: 1,
      fields: [
        { kind: "text", name: "person.name", maxChars: 40 },
        { kind: "checkbox", name: "consent" },
        { kind: "dropdown", name: "region" },
      ],
    });
  });

  test.each([
    ["not a pdf", new TextEncoder().encode("just some text")],
    ["empty", new Uint8Array(0)],
    [
      "a pdf whose objects do not parse",
      new TextEncoder().encode("%PDF-1.7\nbroken"),
    ],
  ])("%s refuses as pdf_malformed", async (_label, bytes) => {
    try {
      await createPdfFieldExtractor()(bytes);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfRefusalError);
      expect((error as PdfRefusalError).kind).toBe("pdf_malformed");
    }
  });

  test("an XFA form refuses as pdf_xfa", async () => {
    try {
      await createPdfFieldExtractor()(await xfaPdf());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfRefusalError);
      expect((error as PdfRefusalError).kind).toBe("pdf_xfa");
    }
  });

  test("an AcroForm that loads but breaks while walked refuses as pdf_malformed", async () => {
    try {
      await createPdfFieldExtractor()(await tornAcroFormPdf());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfRefusalError);
      expect((error as PdfRefusalError).kind).toBe("pdf_malformed");
    }
  });
});

describe("POST /:id/inspect", () => {
  test("lists P-1's supported and unsupported fields with the page count", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const response = await inspect(fixture, uploaded.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pageCount: 1,
      supported: [
        { name: "person.name", type: "text", maxChars: 40 },
        { name: "consent", type: "checkbox" },
      ],
      unsupported: [
        { fieldName: "region", reason: "Dropdown fields are not supported." },
      ],
    });
  });

  test("reads the bytes once through the server-derived key and never writes: the original is untouched", async () => {
    const fixture = fixtureFor();
    const bytes = await samplePdf();
    const uploaded = await upload(fixture, bytes);
    fixture.bytes.gets.length = 0;
    const writesBefore = fixture.bytes.writes.size;
    const response = await inspect(fixture, uploaded.id);
    expect(response.status).toBe(200);
    expect(fixture.bytes.gets).toEqual([
      `openmuse-files/user-1/${uploaded.id}/${uploaded.versionId}`,
    ]);
    expect(fixture.bytes.writes.size).toBe(writesBefore);
    expect(
      fixture.bytes.data.get(
        `openmuse-files/user-1/${uploaded.id}/${uploaded.versionId}`,
      ),
    ).toEqual(bytes);
    const content = await fixture.filesApp.request(`/${uploaded.id}/content`);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  });

  test("a foreign id answers 404, not 403", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    currentActor = actorTwo;
    try {
      expect((await inspect(fixture, uploaded.id)).status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
  });

  test("a missing id answers 404", async () => {
    const fixture = fixtureFor();
    expect((await inspect(fixture, "no-such-file")).status).toBe(404);
  });

  test("a non-PDF answers 400 without reading bytes", async () => {
    const fixture = fixtureFor();
    const form = new FormData();
    form.append(
      "file",
      new File([new TextEncoder().encode("notes")], "notes.txt", {
        type: "text/plain",
      }),
    );
    const uploaded = (await (
      await fixture.filesApp.request("/", { method: "POST", body: form })
    ).json()) as UploadedFile;
    const response = await inspect(fixture, uploaded.id);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "PDF",
    );
    expect(fixture.bytes.gets).toEqual([]);
  });

  test("a PDF over the 10 MiB ceiling re-asserts the F02 limit before bytes are read", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const row = fixture.rows.files.find((file) => file.id === uploaded.id);
    expect(row).toBeDefined();
    row!.size = 10 * 1024 * 1024 + 1;
    fixture.bytes.gets.length = 0;
    const response = await inspect(fixture, uploaded.id);
    expect(response.status).toBe(413);
    expect(fixture.bytes.gets).toEqual([]);
  });

  test.each([
    ["pdf_encrypted", 422, "Encrypted PDFs cannot be inspected."],
    ["pdf_xfa", 422, "XFA PDF forms cannot be inspected."],
    ["pdf_malformed", 400, "That file is not a readable PDF."],
  ])(
    "an extractor refusal %s answers %d with a distinct error",
    async (kind, expected, message) => {
      const fixture = fixtureFor(async () => {
        throw new PdfRefusalError(kind);
      });
      const uploaded = await upload(fixture, await samplePdf());
      const response = await inspect(fixture, uploaded.id);
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ error: message });
    },
  );

  test("a PDF over 500 pages refuses naming the page count; exactly 500 passes", async () => {
    const over = fixtureFor(async () => ({
      pageCount: 501,
      fields: [],
    }));
    const uploadedOver = await upload(over, await samplePdf());
    const refused = await inspect(over, uploadedOver.id);
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain("501");
    expect(body.error).toContain("500");

    const at = fixtureFor(async () => ({ pageCount: 500, fields: [] }));
    const uploadedAt = await upload(at, await samplePdf());
    const response = await inspect(at, uploadedAt.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pageCount: 500,
      supported: [],
      unsupported: [],
    });
  });

  test("a real XFA upload through the route refuses 422; garbage bytes refuse 400", async () => {
    const fixture = fixtureFor();
    const xfa = await upload(fixture, await xfaPdf(), "xfa.pdf");
    expect((await inspect(fixture, xfa.id)).status).toBe(422);
    const garbage = await upload(
      fixture,
      new TextEncoder().encode("%PDF-1.7\nbroken"),
      "garbage.pdf",
    );
    expect((await inspect(fixture, garbage.id)).status).toBe(400);
  });

  test("a torn AcroForm that breaks while walked answers 400, not a retry-me 503", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await tornAcroFormPdf());
    const response = await inspect(fixture, uploaded.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That file is not a readable PDF.",
    });
  });

  test("a disabled owner's inspect answers 403 (§9)", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    await fixture.store.disableOwner("user-1");
    expect((await inspect(fixture, uploaded.id)).status).toBe(403);
  });

  test("without a session the inspect answers 401", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    guardAdmits = false;
    try {
      expect((await inspect(fixture, uploaded.id)).status).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});

describe("validateFill (pure seam)", () => {
  /** P-1 as plain data: what validateFill reasons over, no PDF in sight. */
  const inspection: PdfInspection = {
    pageCount: 1,
    supported: [
      { name: "person.name", type: "text", maxChars: 40 },
      { name: "notes", type: "text" },
      { name: "consent", type: "checkbox" },
    ],
    unsupported: [
      { fieldName: "region", reason: "Dropdown fields are not supported." },
    ],
  };

  function refusalOf(act: () => unknown): PdfFillRefusalError {
    try {
      act();
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfFillRefusalError);
      return error as PdfFillRefusalError;
    }
  }

  test("the Ava/consent fixture passes as a typed map", () => {
    expect(
      validateFill(inspection, { "person.name": "Ava", consent: true }),
    ).toEqual({
      "person.name": "Ava",
      consent: true,
    });
    // "Up to 10,000 characters" includes exactly 10,000.
    expect(validateFill(inspection, { notes: "a".repeat(10_000) })).toEqual({
      notes: "a".repeat(10_000),
    });
  });

  test("an unknown field name refuses distinctly", () => {
    const refusal = refusalOf(() =>
      validateFill(inspection, { surname: "Ava" }),
    );
    expect(refusal.kind).toBe("fill_unknown_field");
    expect(refusal.fieldName).toBe("surname");
  });

  test("a boolean into a text field and a string into a checkbox refuse distinctly", () => {
    const intoText = refusalOf(() =>
      validateFill(inspection, { "person.name": true }),
    );
    expect(intoText.kind).toBe("fill_wrong_type");
    expect(intoText.fieldName).toBe("person.name");
    const intoCheckbox = refusalOf(() =>
      validateFill(inspection, { consent: "true" }),
    );
    expect(intoCheckbox.kind).toBe("fill_wrong_type");
    expect(intoCheckbox.fieldName).toBe("consent");
    expect(intoCheckbox.detail).not.toBe(intoText.detail);
  });

  test("over-long text refuses distinctly, at 10,000 and at the field's own cap", () => {
    const global = refusalOf(() =>
      validateFill(inspection, { notes: "a".repeat(10_001) }),
    );
    expect(global.kind).toBe("fill_text_too_long");
    expect(global.fieldName).toBe("notes");
    const fieldCap = refusalOf(() =>
      validateFill(inspection, { "person.name": "a".repeat(41) }),
    );
    expect(fieldCap.kind).toBe("fill_text_too_long");
    expect(fieldCap.fieldName).toBe("person.name");
  });

  test("an unsupported field refuses naming it", () => {
    const refusal = refusalOf(() =>
      validateFill(inspection, { region: "North" }),
    );
    expect(refusal.kind).toBe("fill_unsupported_field");
    expect(refusal.fieldName).toBe("region");
  });
});

describe("applyFill", () => {
  test("applies the typed map through the pdf adapter and returns its bytes", async () => {
    const inspection: PdfInspection = {
      pageCount: 1,
      supported: [
        { name: "person.name", type: "text" },
        { name: "consent", type: "checkbox" },
      ],
      unsupported: [],
    };
    const typed = validateFill(inspection, {
      "person.name": "Ava",
      consent: true,
    });
    const calls: Array<{
      supported: PdfInspection["supported"];
      values: TypedPdfFillValues;
    }> = [];
    const output = new TextEncoder().encode("filled-bytes");
    const fake: PdfFillAdapter = async (load, supported, values) => {
      await load();
      calls.push({ supported, values });
      return output;
    };
    /*
     * Round 6 (M26): the seam is loader-shaped — the adapter receives a
     * LOADER and calls it exactly once for the whole fill, never re-parsing
     * bytes it was handed.
     */
    const loads: number[] = [];
    const load = async () => {
      loads.push(1);
      return await PDFDocument.create();
    };
    expect(await applyFill(load, inspection, typed, fake)).toBe(output);
    expect(loads).toHaveLength(1);
    expect(calls).toEqual([
      { supported: inspection.supported, values: typed },
    ]);
  });
});

describe("the mount-order contract (round 6 H5/M4)", () => {
  test("a fill body past the mobile-bff family 8 KiB reaches the fill route's own ceiling, not the family 413", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    // The composition app.ts now ships: the documents sub-app mounted FIRST,
    // the family-wide 8 KiB limit mounted after it (the bff). Hono composes
    // in registration order, and the documents handlers are terminal, so the
    // family limit never answers a fill first.
    const composed = new Hono<{ Variables: AppVariables }>();
    composed.route("/api/mobile/openmuse-files", fixture.app);
    composed.use("/api/mobile/*", bodyLimit({ maxSize: 8_192 }));
    // ~12 KiB of values: past the family limit, far under the fill's 1 MB.
    const longValue = "x".repeat(12 * 1024);
    const response = await composed.request(
      `/api/mobile/openmuse-files/${uploaded.id}/fill`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { "person.name": longValue } }),
      },
    );
    // NOT the family's bare 413: the fill route itself answered — here as a
    // 422 field-too-long (pdf-lib's own 40-char MaxLen on P-1's field), the
    // point being the body reached the route's own validation at all.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("person.name");
  });

  test("a transfer body past 64 KiB is refused by the transfer route's own local limit (M24)", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const response = await fixture.app.request(`/${uploaded.id}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId: uploaded.versionId,
        transferKey: "y".repeat(70 * 1024),
      }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
  });
});

describe("POST /:id/fill", () => {
  function fillWith(
    fixture: Fixture,
    id: string,
    values: unknown,
  ): Promise<Response> {
    return fixture.app.request(`/${id}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
  }

  const avaValues = { "person.name": "Ava", consent: true };

  test("fills P-1 into a derived version; the original's bytes and sha256 stay unchanged", async () => {
    const fixture = fixtureFor();
    const source = await samplePdf();
    const uploaded = await upload(fixture, source);
    const originalPath = `openmuse-files/user-1/${uploaded.id}/${uploaded.versionId}`;
    fixture.bytes.gets.length = 0;

    const response = await fillWith(fixture, uploaded.id, avaValues);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      versionId: string;
      parentVersionId: string;
      sha256: string;
      size: number;
      values: Record<string, string | boolean>;
    };
    expect(body.parentVersionId).toBe(uploaded.versionId);
    expect(body.values).toEqual(avaValues);
    expect(body.size).toBeGreaterThan(0);

    // The derived version row records parent and values.
    const derived = fixture.rows.versions.at(-1);
    expect(derived?.fileId).toBe(uploaded.id);
    expect(derived?.versionId).toBe(body.versionId);
    expect(derived?.parentVersionId).toBe(uploaded.versionId);
    expect(derived?.values).toEqual(avaValues);

    // Written ONCE, under the server-derived key for the new version; the
    // original's key was never re-put.
    expect(derived?.bytePath).toBe(
      `openmuse-files/user-1/${uploaded.id}/${body.versionId}`,
    );
    expect(fixture.bytes.writes.get(derived!.bytePath)).toBe(1);
    expect(fixture.bytes.writes.get(originalPath)).toBe(1);
    expect(body.sha256).toBe(
      sha256(fixture.bytes.data.get(derived!.bytePath)!),
    );

    // The original's stored bytes are untouched and still hash to their sha256.
    const originalBytes = fixture.bytes.data.get(originalPath);
    expect(originalBytes).toEqual(source);
    expect(sha256(originalBytes!)).toBe(uploaded.sha256);

    // Semantic field check (fixture P-1): the copy carries Ava and consent,
    // the dropdown stays unfilled, the original stays blank.
    const derivedDoc = await PDFDocument.load(
      fixture.bytes.data.get(derived!.bytePath)!,
    );
    expect(derivedDoc.getForm().getTextField("person.name").getText()).toBe(
      "Ava",
    );
    expect(derivedDoc.getForm().getCheckBox("consent").isChecked()).toBe(true);
    expect(derivedDoc.getForm().getDropdown("region").getSelected()).toEqual(
      [],
    );
    const originalDoc = await PDFDocument.load(originalBytes!);
    // pdf-lib answers undefined for a text field that was never set — blank.
    expect(originalDoc.getForm().getTextField("person.name").getText()).toBe(
      undefined,
    );
    expect(originalDoc.getForm().getCheckBox("consent").isChecked()).toBe(
      false,
    );
  });

  test("an empty values object is no fill: 400 before any load or version row", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const response = await fillWith(fixture, uploaded.id, {});
    expect(response.status).toBe(400);
    // No derived version: an empty fill would only re-save the parent.
    expect(fixture.rows.versions).toHaveLength(1);
  });

  test("a field literally named __proto__ fills as an ordinary field, never a prototype write", async () => {
    const fixture = fixtureFor();
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const field = form.createTextField("__proto__");
    field.addToPage(page, { x: 48, y: 700, width: 300, height: 24 });
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
    const uploaded = await upload(fixture, await doc.save());
    // The JSON round-trip keeps "__proto__" an own property; a plain
    // object's inherited setter would silently drop the fill instead.
    const response = await fillWith(
      fixture,
      uploaded.id,
      JSON.parse('{"__proto__":"boom"}'),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      values: Record<string, string | boolean>;
    };
    const protoKey = "__proto__";
    expect(Object.hasOwn(body.values, protoKey)).toBe(true);
    expect(body.values[protoKey]).toBe("boom");
    expect(({} as { boom?: string }).boom).toBeUndefined();
  });

  test("the served bytes' own length answers 413 when a fill-derived latest outgrew the row's stale size", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    /*
     * appendVersion never touches the file row's size, so the metadata a
     * guard would read still names the small original while the latest
     * version's bytes are over the ceiling — the truth has to come from
     * the bytes, or this file would answer a misleading 400 forever.
     */
    const appended = await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.id,
      bytes: new Uint8Array(OPENMUSE_MAX_PDF_BYTES + 1),
      parentVersionId: uploaded.versionId,
      values: {},
    });
    expect(appended).not.toBe("stale-parent");
    const inspect = await fixture.app.request(`/${uploaded.id}/inspect`, {
      method: "POST",
    });
    expect(inspect.status).toBe(413);
    const fill = await fillWith(fixture, uploaded.id, {
      "person.name": "Ava",
    });
    expect(fill.status).toBe(413);
  });

  test("invalid input refuses with no version row and no byte write (counts)", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    expect(fixture.rows.versions.length).toBe(1);
    const writesBefore = [...fixture.bytes.writes.values()].reduce(
      (a, b) => a + b,
      0,
    );

    const unknown = await fillWith(fixture, uploaded.id, { surname: "Ava" });
    expect(unknown.status).toBe(422);
    const wrongType = await fillWith(fixture, uploaded.id, { consent: "true" });
    expect(wrongType.status).toBe(422);
    expect(((await unknown.json()) as { error: string }).error).not.toBe(
      ((await wrongType.json()) as { error: string }).error,
    );

    expect(fixture.rows.versions.length).toBe(1);
    const writesAfter = [...fixture.bytes.writes.values()].reduce(
      (a, b) => a + b,
      0,
    );
    expect(writesAfter).toBe(writesBefore);
  });

  test("a foreign id answers 404, not 403", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    currentActor = actorTwo;
    try {
      expect((await fillWith(fixture, uploaded.id, avaValues)).status).toBe(
        404,
      );
    } finally {
      currentActor = actorOne;
    }
  });

  test("a tombstoned file answers 404", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    await fixture.store.tombstone("user-1", uploaded.id);
    expect((await fillWith(fixture, uploaded.id, avaValues)).status).toBe(404);
  });

  test("a disabled owner's fill answers 403 (§9)", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    await fixture.store.disableOwner("user-1");
    expect((await fillWith(fixture, uploaded.id, avaValues)).status).toBe(403);
  });

  test("filling the same source and values twice records equal semantic values", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    expect((await fillWith(fixture, uploaded.id, avaValues)).status).toBe(201);
    expect((await fillWith(fixture, uploaded.id, avaValues)).status).toBe(201);
    const versions = fixture.rows.versions;
    expect(versions).toHaveLength(3);
    // §5 determinism is semantic: recorded values equal. Byte equality is
    // deliberately NOT asserted.
    expect(versions.at(-1)?.values).toEqual(versions.at(-2)?.values);
    expect(versions.at(-1)?.versionId).not.toBe(versions.at(-2)?.versionId);
    // Each derived version's parent is the version current when it filled.
    expect(versions.at(-2)?.parentVersionId).toBe(uploaded.versionId);
    expect(versions.at(-1)?.parentVersionId).toBe(versions.at(-2)?.versionId);
  });
});

/**
 * The workspace half of the transfer fake (F09): an in-memory filesystem the
 * injected seam sees. `failNextWrite` simulates a torn write — a few bytes
 * land, then the connection dies — so the cleanup path has a partial file to
 * be caught leaving.
 */
type FakeWorkspace = WorkspaceTransferFilesystem & {
  files: Map<string, Uint8Array>;
  writes: Map<string, number>;
  removals: string[];
  failNextWrite: string | null;
};

function fakeWorkspace(): FakeWorkspace {
  const files = new Map<string, Uint8Array>();
  const writes = new Map<string, number>();
  const removals: string[] = [];
  const workspace: FakeWorkspace = {
    files,
    writes,
    removals,
    failNextWrite: null,
    list: async (path) =>
      [...files.keys()].filter((name) => name.startsWith(`${path}/`)),
    read: async (path) => {
      const stored = files.get(path);
      return stored === undefined ? null : new TextDecoder().decode(stored);
    },
    write: async (path, bytes) => {
      writes.set(path, (writes.get(path) ?? 0) + 1);
      if (workspace.failNextWrite === path) {
        workspace.failNextWrite = null;
        files.set(path, bytes.slice(0, 5));
        throw new Error("connection reset mid-write");
      }
      files.set(path, bytes);
    },
    remove: async (path) => {
      removals.push(path);
      files.delete(path);
    },
  };
  return workspace;
}

describe("deriveTransferPath (pure seam)", () => {
  test("derives openmuse-transfer/<fileId>/<versionId>-<n>.pdf, skipping taken names", () => {
    const taken = new Set<string>([
      "openmuse-transfer/f-1/v-1-1.pdf",
      "openmuse-transfer/f-1/v-1-2.pdf",
    ]);
    expect(deriveTransferPath("f-1", "v-1", taken)).toBe(
      "openmuse-transfer/f-1/v-1-3.pdf",
    );
    expect(deriveTransferPath("f-1", "v-2", taken)).toBe(
      "openmuse-transfer/f-1/v-2-1.pdf",
    );
  });
});

describe("POST /:id/transfer", () => {
  function transferWith(
    fixture: Fixture,
    id: string,
    body: unknown,
  ): Promise<Response> {
    return fixture.app.request(`/${id}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function uploadedFixture(): Promise<{
    fixture: Fixture;
    workspace: FakeWorkspace;
    uploaded: UploadedFile;
    source: Uint8Array;
  }> {
    const workspace = fakeWorkspace();
    const fixture = fixtureFor(undefined, async () => workspace);
    const source = await samplePdf();
    const uploaded = await upload(fixture, source);
    return { fixture, workspace, uploaded, source };
  }

  test("transfers the current version under a server-derived path; a client destination is ignored", async () => {
    const { fixture, workspace, uploaded, source } = await uploadedFixture();
    const response = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
      destination: "/etc/cron.d/evil.pdf",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(
      `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-1.pdf`,
    );
    // Written once, with the exact version bytes, at the derived path only.
    expect(workspace.writes.get(body.path)).toBe(1);
    expect(workspace.files.get(body.path)).toEqual(source);
    expect(workspace.files.has("/etc/cron.d/evil.pdf")).toBe(false);
    // The idempotency ledger rides the workspace beside the artifact.
    expect(workspace.writes.get(TRANSFER_LEDGER_PATH)).toBe(1);
  });

  test("a same-name existing artifact gets a distinct generated path; the original is untouched", async () => {
    const { fixture, workspace, uploaded } = await uploadedFixture();
    const first = `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-1.pdf`;
    const existing = new TextEncoder().encode("bot-written original");
    workspace.files.set(first, existing);
    const response = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe(
      `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-2.pdf`,
    );
    expect(workspace.files.get(first)).toEqual(existing);
  });

  test("retrying the same transferKey returns the same artifact without re-writing", async () => {
    const { fixture, workspace, uploaded } = await uploadedFixture();
    const first = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
    });
    expect(first.status).toBe(201);
    const retry = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as { path: string }).toEqual(
      (await first.json()) as { path: string },
    );
    const artifact = `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-1.pdf`;
    expect(workspace.writes.get(artifact)).toBe(1);
    expect(workspace.writes.get(TRANSFER_LEDGER_PATH)).toBe(1);
  });

  test("a different transferKey may create a new artifact", async () => {
    const { fixture, workspace, uploaded } = await uploadedFixture();
    expect(
      (
        await transferWith(fixture, uploaded.id, {
          versionId: uploaded.versionId,
          transferKey: "t1",
        })
      ).status,
    ).toBe(201);
    const second = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t2",
    });
    expect(second.status).toBe(201);
    const body = (await second.json()) as { path: string };
    expect(body.path).toBe(
      `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-2.pdf`,
    );
    // Both artifacts stand side by side — a new key never replaces one.
    expect(workspace.files.has(body.path)).toBe(true);
    expect(
      workspace.files.has(
        `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-1.pdf`,
      ),
    ).toBe(true);
  });

  test("a mid-write failure is never complete; the partial artifact is removed", async () => {
    const { fixture, workspace, uploaded } = await uploadedFixture();
    const artifact = `openmuse-transfer/${uploaded.id}/${uploaded.versionId}-1.pdf`;
    workspace.failNextWrite = artifact;
    const response = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
    });
    expect(response.status).toBe(503);
    expect(workspace.removals).toContain(artifact);
    expect(workspace.files.has(artifact)).toBe(false);
  });

  test("a non-PDF file answers 400", async () => {
    const workspace = fakeWorkspace();
    const fixture = fixtureFor(undefined, async () => workspace);
    const form = new FormData();
    form.append(
      "file",
      new File([new TextEncoder().encode("notes")], "notes.txt", {
        type: "text/plain",
      }),
    );
    const uploadResponse = await fixture.filesApp.request("/", {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(201);
    const uploaded = (await uploadResponse.json()) as UploadedFile;
    expect(
      (
        await transferWith(fixture, uploaded.id, {
          versionId: uploaded.versionId,
          transferKey: "t1",
        })
      ).status,
    ).toBe(400);
  });

  test("a stale versionId answers 409", async () => {
    const { fixture, uploaded } = await uploadedFixture();
    expect(
      (
        await transferWith(fixture, uploaded.id, {
          versionId: "not-the-current-version",
          transferKey: "t1",
        })
      ).status,
    ).toBe(409);
  });

  test("an unwired workspace seam answers 503, never a fake path", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const response = await transferWith(fixture, uploaded.id, {
      versionId: uploaded.versionId,
      transferKey: "t1",
    });
    expect(response.status).toBe(503);
  });

  test("a foreign id answers 404, not 403", async () => {
    const { fixture, uploaded } = await uploadedFixture();
    currentActor = actorTwo;
    try {
      expect(
        (
          await transferWith(fixture, uploaded.id, {
            versionId: uploaded.versionId,
            transferKey: "t1",
          })
        ).status,
      ).toBe(404);
    } finally {
      currentActor = actorOne;
    }
  });

  test("a tombstoned file answers 404", async () => {
    const { fixture, uploaded } = await uploadedFixture();
    await fixture.store.tombstone("user-1", uploaded.id);
    expect(
      (
        await transferWith(fixture, uploaded.id, {
          versionId: uploaded.versionId,
          transferKey: "t1",
        })
      ).status,
    ).toBe(404);
  });

  test("a disabled owner's transfer answers 403 (§9)", async () => {
    const { fixture, uploaded } = await uploadedFixture();
    await fixture.store.disableOwner("user-1");
    expect(
      (
        await transferWith(fixture, uploaded.id, {
          versionId: uploaded.versionId,
          transferKey: "t1",
        })
      ).status,
    ).toBe(403);
  });
});

/**
 * Round 3 repair findings, pinned.
 */
describe("fill concurrency (round 3)", () => {
  test("a parent that is no longer latest answers 409, not a silent fork", async () => {
    const rows = fakeRows();
    const bytes = fakeBytes();
    const store = createOpenMuseFileStore({ rows, byteStore: bytes });
    const filesApp = createOpenMuseFilesRoutes({ store, requireUser });
    const form = new FormData();
    const pdf = await samplePdf();
    form.append(
      "file",
      new File([pdf], "race.pdf", { type: "application/pdf" }),
    );
    const uploaded = await (
      await filesApp.request("/", { method: "POST", body: form })
    ).json();

    const staleStore = {
      ...store,
      appendVersion: async () => "stale-parent" as const,
    } as unknown as typeof store;
    const racing = createOpenMuseDocumentsRoutes({
      store: staleStore,
      requireUser,
    });
    const response = await racing.request(`/${uploaded.id}/fill`, {
      method: "POST",
      body: JSON.stringify({ values: { "person.name": "Ada" } }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "newer version",
    );
    // The losing fill wrote nothing: no bytes, no version row.
    expect(rows.versions).toHaveLength(1);
    expect([...bytes.writes.keys()]).toHaveLength(1);
  });

  test("the store itself refuses a parent that is no longer the latest version", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const filled = await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.id,
      bytes: new TextEncoder().encode("v2"),
      parentVersionId: uploaded.versionId,
      values: {},
    });
    expect(filled).not.toBe("stale-parent");
    const stale = await fixture.store.appendVersion({
      ownerUserId: "user-1",
      fileId: uploaded.id,
      bytes: new TextEncoder().encode("fork"),
      parentVersionId: uploaded.versionId,
      values: {},
    });
    expect(stale).toBe("stale-parent");
    // The forked write never landed: bytes and version rows are unchanged.
    expect(fixture.rows.versions).toHaveLength(2);
  });
});

describe("maxChars 0 means unlimited (round 3)", () => {
  test("a text field reporting MaxLen 0 accepts non-empty text", () => {
    const inspection: PdfInspection = {
      pageCount: 1,
      supported: [
        { name: "notes", type: "text", maxChars: 0 },
        { name: "capped", type: "text", maxChars: 5 },
      ],
      unsupported: [],
    };
    const typed = validateFill(inspection, {
      notes: "any length at all",
      capped: "abc",
    });
    expect(typed).toEqual({ notes: "any length at all", capped: "abc" });
    expect(() => validateFill(inspection, { capped: "abcdef" })).toThrow(
      /too long/,
    );
  });
});

describe("transferKey prototype safety (round 3)", () => {
  test("a transferKey of __proto__ replays instead of re-writing forever", async () => {
    const workspace = fakeWorkspace();
    const bytes = new TextEncoder().encode("%PDF- round three");
    const input = {
      filesystem: workspace,
      fileId: "f-1",
      versionId: "v-1",
      transferKey: "__proto__",
      bytes,
    };
    const first = await transferVersionToWorkspace(input);
    expect(first.kind).toBe("transferred");
    const second = await transferVersionToWorkspace(input);
    expect(second).toEqual({ kind: "replayed", path: first.path });
    // One artifact write plus the ledger writes — not one write per retry.
    const artifactWrites = [...workspace.writes.entries()].filter(
      ([path]) => path !== TRANSFER_LEDGER_PATH,
    );
    expect(artifactWrites).toHaveLength(1);
  });
});

describe("ledger bounds and shape (round 3)", () => {
  test("a corrupt ledger entry is dropped, not trusted", async () => {
    const workspace = fakeWorkspace();
    workspace.files.set(
      TRANSFER_LEDGER_PATH,
      new TextEncoder().encode(
        JSON.stringify({
          good: {
            fileId: "f-1",
            versionId: "v-0",
            path: "openmuse-transfer/f-1/v-0-1.pdf",
            status: "complete",
            at: "2026-10-13T00:00:00.000Z",
          },
          bad: { fileId: 7, path: [], status: "weird" },
        }),
      ),
    );
    const outcome = await transferVersionToWorkspace({
      filesystem: workspace,
      fileId: "f-1",
      versionId: "v-1",
      transferKey: "k",
      bytes: new TextEncoder().encode("%PDF-"),
    });
    expect(outcome.kind).toBe("transferred");
    // The good entry's path stayed taken; the corrupt one poisoned nothing.
    const ledger = JSON.parse(
      new TextDecoder().decode(
        workspace.files.get(TRANSFER_LEDGER_PATH) ?? new Uint8Array(),
      ),
    ) as Record<string, { status: string }>;
    expect(ledger.good).toBeDefined();
    expect(ledger.bad).toBeUndefined();
    expect(ledger.k.status).toBe("complete");
  });

  test("a ledger past the eviction threshold sheds failed and oldest entries", async () => {
    const workspace = fakeWorkspace();
    // ~600 KiB of failed entries: without eviction the next ledger write
    // would blow the workspace's 1,000,000-byte cap and every future
    // transfer would fail forever.
    const seeded: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index++) {
      seeded[`old-${index}`] = {
        fileId: "f-1",
        versionId: "v-0",
        path: `openmuse-transfer/f-1/v-0-${index}.pdf`,
        status: "failed",
        at: "2026-10-01T00:00:00.000Z",
      };
    }
    workspace.files.set(
      TRANSFER_LEDGER_PATH,
      new TextEncoder().encode(JSON.stringify(seeded)),
    );
    const outcome = await transferVersionToWorkspace({
      filesystem: workspace,
      fileId: "f-1",
      versionId: "v-1",
      transferKey: "fresh",
      bytes: new TextEncoder().encode("%PDF-"),
    });
    expect(outcome.kind).toBe("transferred");
    const ledger = JSON.parse(
      new TextDecoder().decode(
        workspace.files.get(TRANSFER_LEDGER_PATH) ?? new Uint8Array(),
      ),
    ) as Record<string, { status: string }>;
    expect(ledger.fresh.status).toBe("complete");
    const survived = Object.keys(ledger).filter((key) =>
      key.startsWith("old-"),
    );
    expect(survived.length).toBeLessThan(5_000);
    // The shed ledger must also fit the seam's SMALLEST cap — the
    // workspace text read truncates at 64,000 bytes, and a truncated
    // ledger parse degrades to empty (wiping every replay record).
    expect(
      workspace.files.get(TRANSFER_LEDGER_PATH)?.byteLength ?? 0,
    ).toBeLessThan(64_000);
    expect(
      workspace.files.get(TRANSFER_LEDGER_PATH)?.byteLength ?? 0,
    ).toBeLessThan(1_000_000);
  });
});

describe("request body ceiling (round 3)", () => {
  test("an oversized JSON body answers 413, not an unbounded parse", async () => {
    const fixture = fixtureFor();
    const uploaded = await upload(fixture, await samplePdf());
    const response = await fixture.app.request(`/${uploaded.id}/fill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        values: { "person.name": "x".repeat(3_000_000) },
      }),
    });
    expect(response.status).toBe(413);
  });
});
