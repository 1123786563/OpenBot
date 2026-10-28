import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

const officeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts/office",
);

test("redlining validation rejects untracked edits without author revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-pptx-redlining-"));
  const fixture = [
    "import sys, zipfile",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from validators.redlining import RedliningValidator",
    "root = Path(sys.argv[2])",
    "modified_file = root / 'modified/word/document.xml'",
    "modified_file.parent.mkdir(parents=True)",
    "modified_file.write_text('<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>edited</w:t></w:r></w:p></w:body></w:document>')",
    "with zipfile.ZipFile(root / 'original.docx', 'w') as package:",
    "    package.writestr('word/document.xml', '<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>original</w:t></w:r></w:p></w:body></w:document>')",
    "validator = RedliningValidator(root / 'modified', root / 'original.docx')",
    "assert validator.validate() is False",
  ].join("\n");

  try {
    const result = spawnSync("python", ["-c", fixture, officeDir, root], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redlining validation rejects entities in modified and original documents", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-pptx-redlining-xml-"));
  const fixture = [
    "import io, sys, zipfile",
    "from contextlib import redirect_stdout",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from validators.redlining import RedliningValidator",
    "root = Path(sys.argv[2])",
    "ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'",
    "def document(text): return f'<w:document xmlns:w=\"{ns}\"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>'",
    "hostile = '<!DOCTYPE w:document [<!ENTITY marker \"expanded\">]>' + document('&marker;')",
    "def check(name, modified_xml, original_xml):",
    "    unpacked = root / name / 'modified'",
    "    modified_file = unpacked / 'word/document.xml'",
    "    modified_file.parent.mkdir(parents=True)",
    "    modified_file.write_text(modified_xml)",
    "    original_docx = root / name / 'original.docx'",
    "    with zipfile.ZipFile(original_docx, 'w') as package: package.writestr('word/document.xml', original_xml)",
    "    output = io.StringIO()",
    "    with redirect_stdout(output): result = RedliningValidator(unpacked, original_docx).validate()",
    "    assert result is False, output.getvalue()",
    "    assert 'EntitiesForbidden' in output.getvalue(), output.getvalue()",
    "check('modified-xml', hostile, document('original'))",
    "check('original-xml', document('modified'), hostile)",
  ].join("\n");

  try {
    const result = spawnSync("python", ["-c", fixture, officeDir, root], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
