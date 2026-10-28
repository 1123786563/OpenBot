import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const officeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts/office",
);
const packageRelationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const notesSlideRelationshipType =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openbot-pptx-validator-"));
}

function writeNotesRelationship(
  root: string,
  slideName: string,
  target: string,
): void {
  const relsFile = join(root, "ppt/slides/_rels", `${slideName}.xml.rels`);
  mkdirSync(dirname(relsFile), { recursive: true });
  writeFileSync(
    relsFile,
    `<Relationships xmlns="${packageRelationshipsNamespace}"><Relationship Id="rId1" Type="${notesSlideRelationshipType}" Target="${target}"/></Relationships>`,
  );
}

function runPython(root: string, source: string) {
  return spawnSync(
    "python",
    [
      "-c",
      [
        "import sys",
        `sys.path.insert(0, ${JSON.stringify(officeDir)})`,
        "from validators import PPTXSchemaValidator",
        source,
      ].join("\n"),
      root,
    ],
    { encoding: "utf8" },
  );
}

describe("PPTX schema validator regressions", () => {
  test("surfaces logic errors raised after XML parsing", () => {
    const root = temporaryDirectory();
    const xmlFile = join(root, "ppt/presentation.xml");
    mkdirSync(dirname(xmlFile), { recursive: true });
    writeFileSync(
      xmlFile,
      '<presentation id="01234567-89ab-cdef-0123-456789abcdef"/>',
    );

    try {
      const result = runPython(
        root,
        [
          "class BrokenValidator(PPTXSchemaValidator):",
          "    def _looks_like_uuid(self, value):",
          "        raise RuntimeError('validator logic error')",
          "validator = BrokenValidator(sys.argv[1])",
          "try:",
          "    validator.validate_uuid_ids()",
          "except RuntimeError as error:",
          "    assert str(error) == 'validator logic error'",
          "else:",
          "    raise AssertionError('validator logic error was swallowed')",
        ].join("\n"),
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a file read failure as a validation error", () => {
    const root = temporaryDirectory();
    const xmlFile = join(root, "ppt/presentation.xml");
    mkdirSync(dirname(xmlFile), { recursive: true });
    writeFileSync(xmlFile, "<presentation/>");

    try {
      const result = runPython(
        root,
        [
          "validator = PPTXSchemaValidator(sys.argv[1])",
          "validator.xml_files[0].unlink()",
          "assert validator.validate_uuid_ids() is False",
        ].join("\n"),
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Error:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves each notes relationship from its slide part", () => {
    const root = temporaryDirectory();
    const packageNotes = join(root, "ppt/notesSlides/notesSlide1.xml");
    const slideNotes = join(root, "ppt/slides/notesSlides/notesSlide1.xml");
    mkdirSync(dirname(packageNotes), { recursive: true });
    mkdirSync(dirname(slideNotes), { recursive: true });
    writeFileSync(packageNotes, "<notes/>");
    writeFileSync(slideNotes, "<notes/>");
    writeNotesRelationship(root, "slide1", "../notesSlides/notesSlide1.xml");
    writeNotesRelationship(root, "slide2", "notesSlides/notesSlide1.xml");

    try {
      const result = runPython(
        root,
        "assert PPTXSchemaValidator(sys.argv[1]).validate_notes_slide_references() is True",
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects a shared notes target through equivalent relative paths", () => {
    const root = temporaryDirectory();
    const notesFile = join(root, "ppt/notesSlides/notesSlide1.xml");
    mkdirSync(dirname(notesFile), { recursive: true });
    writeFileSync(notesFile, "<notes/>");
    writeNotesRelationship(root, "slide1", "../notesSlides/notesSlide1.xml");
    writeNotesRelationship(
      root,
      "slide2",
      "../media/../notesSlides/notesSlide1.xml",
    );

    try {
      const result = runPython(
        root,
        "assert PPTXSchemaValidator(sys.argv[1]).validate_notes_slide_references() is False",
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
