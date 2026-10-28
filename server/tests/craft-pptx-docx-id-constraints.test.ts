import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const scriptDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts",
);
const officeDir = join(scriptDir, "office");

describe("DOCX paraId and durableId constraints", () => {
  test("reports malformed hex IDs and continues checking the XML file", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-docx-id-constraints-"));
    const xmlFile = join(root, "word/document.xml");
    mkdirSync(dirname(xmlFile), { recursive: true });
    writeFileSync(
      xmlFile,
      '<root xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"><p w14:paraId="ZZZZZZZZ" w16cid:durableId="GGGGGGGG"/><p w14:paraId="80000000"/></root>',
    );

    try {
      const result = spawnSync(
        "python",
        [
          "-c",
          "import sys; from validators.docx import DOCXSchemaValidator; valid = DOCXSchemaValidator(sys.argv[1]).validate_id_constraints(); sys.exit(0 if valid else 1)",
          root,
        ],
        { cwd: officeDir, encoding: "utf8" },
      );

      expect(result.error).toBe(undefined);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("paraId=ZZZZZZZZ");
      expect(result.stdout).toContain("durableId=GGGGGGGG");
      expect(result.stdout).toContain("paraId=80000000 >= 0x80000000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
