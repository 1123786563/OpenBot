import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const officeScripts = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts/office",
);
const documentXml =
  '<!DOCTYPE w:document [<!ENTITY author "Alice">]>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p><w:ins w:author="&author;" w:id="1"/></w:p></w:body></w:document>';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openbot-redlines-xml-security-"));
}

describe("simplify_redlines rejects XML entities in user documents", () => {
  test("get_tracked_change_authors rejects entities in unpacked document.xml", () => {
    const root = temporaryDirectory();
    const xml = join(root, "document.xml");
    writeFileSync(xml, documentXml);

    try {
      const result = spawnSync(
        "python",
        [
          "-c",
          [
            "import sys",
            "from pathlib import Path",
            "sys.path.insert(0, sys.argv[2])",
            "from helpers.simplify_redlines import get_tracked_change_authors",
            "authors = get_tracked_change_authors(Path(sys.argv[1]))",
            "assert authors == {}, repr(authors)",
          ].join("\n"),
          xml,
          officeScripts,
        ],
        { encoding: "utf8" },
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("_get_authors_from_docx rejects entities in zipped document.xml", () => {
    const root = temporaryDirectory();
    const xml = join(root, "document.xml");
    const docx = join(root, "input.docx");
    writeFileSync(xml, documentXml);

    try {
      const result = spawnSync(
        "python",
        [
          "-c",
          [
            "import sys, zipfile",
            "from pathlib import Path",
            "sys.path.insert(0, sys.argv[3])",
            "from helpers.simplify_redlines import _get_authors_from_docx",
            "with zipfile.ZipFile(sys.argv[2], 'w') as archive:",
            "    archive.write(sys.argv[1], 'word/document.xml')",
            "authors = _get_authors_from_docx(Path(sys.argv[2]))",
            "assert authors == {}, repr(authors)",
          ].join("\n"),
          xml,
          docx,
          officeScripts,
        ],
        { encoding: "utf8" },
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
