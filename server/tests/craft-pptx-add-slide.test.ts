import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts/add_slide.py",
);

test("add_slide.py reuses the relationship ID for an existing slide target", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-pptx-add-slide-"));
  const slidesDir = join(root, "ppt/slides");
  const presentationRelsPath = join(root, "ppt/_rels/presentation.xml.rels");
  mkdirSync(slidesDir, { recursive: true });
  mkdirSync(dirname(presentationRelsPath), { recursive: true });
  writeFileSync(join(slidesDir, "slide1.xml"), "<slide />");
  writeFileSync(
    presentationRelsPath,
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
      '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      "</Relationships>",
  );
  writeFileSync(join(root, "[Content_Types].xml"), "<Types></Types>");
  writeFileSync(
    join(root, "ppt/presentation.xml"),
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId3"/></p:sldIdLst></p:presentation>',
  );

  try {
    const result = spawnSync("python", [scriptPath, root, "slide1.xml"], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('r:id="rId3"');
    expect(readFileSync(presentationRelsPath, "utf8")).toContain(
      'Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
