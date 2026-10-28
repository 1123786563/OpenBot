import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const officeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts/office",
);

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openbot-pptx-validate-cli-"));
}

function runValidate(args: string[]) {
  return spawnSync("python", ["-O", join(officeDir, "validate.py"), ...args], {
    encoding: "utf8",
  });
}

describe("Office validation CLI", () => {
  test("rejects invalid paths and extensions with Python optimization enabled", () => {
    const root = temporaryDirectory();
    const input = join(root, "input.docx");
    const missingOriginal = join(root, "missing.docx");
    const invalidOriginal = join(root, "original.txt");
    const original = join(root, "original.docx");
    const unsupportedInput = join(root, "input.txt");
    const nonDirectory = join(root, "not-a-directory");
    writeFileSync(input, "not a zip");
    writeFileSync(invalidOriginal, "not an Office document");
    writeFileSync(original, "not a zip");
    writeFileSync(unsupportedInput, "not an Office document");
    writeFileSync(nonDirectory, "not a directory");

    try {
      const cases = [
        {
          args: [join(root, "missing-input.docx")],
          error: "does not exist",
        },
        {
          args: [input, "--original", missingOriginal],
          error: "is not a file",
        },
        {
          args: [input, "--original", invalidOriginal],
          error: "must be a .docx, .pptx, or .xlsx file",
        },
        { args: [unsupportedInput], error: "Cannot determine file type" },
        {
          args: [nonDirectory, "--original", original],
          error: "not a directory or Office file",
        },
      ];

      for (const testCase of cases) {
        const result = runValidate(testCase.args);
        const output = result.stdout + result.stderr;
        expect(result.error).toBe(undefined);
        expect(result.status === 0).toBe(false);
        expect(output).toContain(testCase.error);
        expect(output).not.toContain("Traceback");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses auto-repair for packed Office files without changing the archive", () => {
    const root = temporaryDirectory();
    const archive = join(root, "input.docx");
    const createArchive = spawnSync(
      "python",
      [
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], 'w'); z.writestr('word/document.xml', '<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:p><w:r><w:t> padded </w:t></w:r></w:p></w:document>'); z.close()",
        archive,
      ],
      { encoding: "utf8" },
    );

    try {
      expect(
        createArchive.status,
        createArchive.stdout + createArchive.stderr,
      ).toBe(0);
      const before = readFileSync(archive).toString("base64");
      const result = runValidate([archive, "--auto-repair"]);
      const output = result.stdout + result.stderr;

      expect(result.error).toBe(undefined);
      expect(result.status === 0).toBe(false);
      expect(output).toContain("cannot auto-repair packed Office files");
      expect(output).not.toContain("Auto-repaired");
      expect(readFileSync(archive).toString("base64")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
