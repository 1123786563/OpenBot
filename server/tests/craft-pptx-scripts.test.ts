import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const scriptDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts",
);

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openbot-pptx-scripts-"));
}

function runPython(script: string, args: string[]) {
  return spawnSync("python", [join(scriptDir, script), ...args], {
    encoding: "utf8",
  });
}

describe("PPTX package scripts preserve source data", () => {
  test("clean.py refuses to remove slides without presentation metadata", () => {
    const root = temporaryDirectory();
    const slide = join(root, "ppt/slides/slide1.xml");
    mkdirSync(dirname(slide), { recursive: true });
    writeFileSync(slide, "<slide />");

    try {
      const result = runPython("clean.py", [root]);

      expect(result.error).toBe(undefined);
      expect(existsSync(slide)).toBe(true);
      expect(result.status === 0).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clean.py keeps slides referenced with an alternate XML prefix", () => {
    const root = temporaryDirectory();
    const presentationDir = join(root, "ppt");
    const relsDir = join(presentationDir, "_rels");
    const slidesDir = join(presentationDir, "slides");
    const slide = join(slidesDir, "slide1.xml");
    mkdirSync(relsDir, { recursive: true });
    mkdirSync(slidesDir, { recursive: true });
    writeFileSync(
      join(presentationDir, "presentation.xml"),
      '<x:presentation xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sldIdLst><x:sldId id="256" r:id="rId1"/></x:sldIdLst></x:presentation>',
    );
    writeFileSync(
      join(relsDir, "presentation.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    );
    writeFileSync(slide, "<slide />");

    try {
      const result = runPython("clean.py", [root]);

      expect(result.error).toBe(undefined);
      expect(result.status).toBe(0);
      expect(existsSync(slide)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clean.py validates package XML before deleting any files", () => {
    const root = temporaryDirectory();
    const presentationDir = join(root, "ppt");
    const relsDir = join(presentationDir, "_rels");
    const slidesDir = join(presentationDir, "slides");
    const slideRelsDir = join(slidesDir, "_rels");
    const trashDir = join(root, "[trash]");
    const orphanedSlide = join(slidesDir, "slide2.xml");
    const trashFile = join(trashDir, "keep.txt");
    mkdirSync(relsDir, { recursive: true });
    mkdirSync(slideRelsDir, { recursive: true });
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(
      join(presentationDir, "presentation.xml"),
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    );
    writeFileSync(
      join(relsDir, "presentation.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    );
    writeFileSync(join(slidesDir, "slide1.xml"), "<slide />");
    writeFileSync(orphanedSlide, "<slide />");
    writeFileSync(join(slideRelsDir, "slide1.xml.rels"), "<Relationships>");
    writeFileSync(trashFile, "keep");

    try {
      const result = runPython("clean.py", [root]);

      expect(result.error).toBe(undefined);
      expect(result.status === 0).toBe(false);
      expect(existsSync(orphanedSlide)).toBe(true);
      expect(existsSync(trashFile)).toBe(true);
      expect(result.stderr).toContain("invalid package XML");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clean.py still removes slides when a valid slide list is empty", () => {
    const root = temporaryDirectory();
    const presentationDir = join(root, "ppt");
    const relsDir = join(presentationDir, "_rels");
    const slidesDir = join(presentationDir, "slides");
    const slide = join(slidesDir, "slide1.xml");
    mkdirSync(relsDir, { recursive: true });
    mkdirSync(slidesDir, { recursive: true });
    writeFileSync(
      join(presentationDir, "presentation.xml"),
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
    );
    writeFileSync(
      join(relsDir, "presentation.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    );
    writeFileSync(slide, "<slide />");

    try {
      const result = runPython("clean.py", [root]);

      expect(result.error).toBe(undefined);
      expect(result.status).toBe(0);
      expect(existsSync(slide)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clean.py preserves resources referenced by non-slide parts", () => {
    const root = temporaryDirectory();
    const presentationDir = join(root, "ppt");
    const presentationRelsDir = join(presentationDir, "_rels");
    const slidesDir = join(presentationDir, "slides");
    const slidesRelsDir = join(slidesDir, "_rels");
    const notesRelsDir = join(presentationDir, "notesSlides/_rels");
    const diagramsRelsDir = join(presentationDir, "diagrams/_rels");
    const embeddingDir = join(presentationDir, "embeddings");
    const drawing = join(presentationDir, "diagrams/drawing1.xml");
    const drawingRels = join(diagramsRelsDir, "drawing1.xml.rels");
    const embedding = join(embeddingDir, "oleObject1.bin");
    mkdirSync(presentationRelsDir, { recursive: true });
    mkdirSync(slidesRelsDir, { recursive: true });
    mkdirSync(notesRelsDir, { recursive: true });
    mkdirSync(diagramsRelsDir, { recursive: true });
    mkdirSync(embeddingDir, { recursive: true });
    writeFileSync(
      join(presentationDir, "presentation.xml"),
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    );
    writeFileSync(
      join(presentationRelsDir, "presentation.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    );
    writeFileSync(
      join(root, "[Content_Types].xml"),
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    );
    writeFileSync(join(slidesDir, "slide1.xml"), "<slide />");
    writeFileSync(
      join(slidesRelsDir, "slide1.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    );
    writeFileSync(
      join(presentationDir, "notesSlides/notesSlide1.xml"),
      "<notes />",
    );
    writeFileSync(
      join(notesRelsDir, "notesSlide1.xml.rels"),
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="drawing" Target="../diagrams/drawing1.xml"/></Relationships>',
    );
    writeFileSync(drawing, "<drawing />");
    writeFileSync(
      drawingRels,
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="oleObject" Target="../embeddings/oleObject1.bin"/></Relationships>',
    );
    writeFileSync(embedding, "embedded object");

    try {
      const result = runPython("clean.py", [root]);

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(drawingRels)).toBe(true);
      expect(existsSync(drawing)).toBe(true);
      expect(existsSync(embedding)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pack.py rejects an explicitly supplied original file that is missing", () => {
    const root = temporaryDirectory();
    const input = join(root, "input");
    const output = join(root, "output.pptx");
    mkdirSync(input);

    try {
      const result = runPython("office/pack.py", [
        input,
        output,
        "--original",
        join(root, "missing.pptx"),
      ]);

      expect(result.error).toBe(undefined);
      expect(result.status === 0).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(result.stdout + result.stderr).toContain("Original file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pack.py preserves whitespace-only SpreadsheetML text", () => {
    const root = temporaryDirectory();
    const input = join(root, "input");
    const spreadsheetDir = join(input, "xl");
    const output = join(root, "output.xlsx");
    mkdirSync(spreadsheetDir, { recursive: true });
    writeFileSync(
      join(input, "[Content_Types].xml"),
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    );
    writeFileSync(
      join(spreadsheetDir, "sharedStrings.xml"),
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t> </t></si></sst>',
    );

    try {
      const packed = runPython("office/pack.py", [input, output]);
      expect(packed.error).toBe(undefined);
      expect(packed.status, packed.stdout + packed.stderr).toBe(0);

      const inspected = spawnSync(
        "python",
        [
          "-c",
          "import sys, zipfile, xml.etree.ElementTree as ET; z=zipfile.ZipFile(sys.argv[1]); t=ET.fromstring(z.read('xl/sharedStrings.xml')).find('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'); assert t is not None and t.text == ' ', repr(None if t is None else t.text)",
          output,
        ],
        { encoding: "utf8" },
      );

      expect(inspected.error).toBe(undefined);
      expect(inspected.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pack.py returns XML processing failures through its result contract", () => {
    const root = temporaryDirectory();
    const input = join(root, "input");
    const output = join(root, "output.pptx");
    mkdirSync(input);
    writeFileSync(join(input, "[Content_Types].xml"), "<Types>");
    const checkResult = spawnSync(
      "python",
      [
        "-c",
        [
          "import sys",
          "sys.path.insert(0, sys.argv[3])",
          "from pack import pack",
          "result = pack(sys.argv[1], sys.argv[2], validate=False)",
          "assert result[0] is None and result[1].startswith('Error:'), repr(result)",
        ].join("\n"),
        input,
        output,
        join(scriptDir, "office"),
      ],
      { encoding: "utf8" },
    );

    try {
      expect(checkResult.error).toBe(undefined);
      expect(checkResult.status, checkResult.stdout + checkResult.stderr).toBe(
        0,
      );
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pack.py succeeds when the output path contains the word Error", () => {
    const root = temporaryDirectory();
    const input = join(root, "input");
    const output = join(root, "ErrorFix.pptx");
    mkdirSync(input);
    writeFileSync(
      join(input, "[Content_Types].xml"),
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    );

    try {
      const result = runPython("office/pack.py", [input, output]);

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(output)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pack.py rejects invalid validate values instead of disabling validation", () => {
    const root = temporaryDirectory();
    const input = join(root, "input");
    const output = join(root, "output.pptx");
    mkdirSync(input);
    writeFileSync(
      join(input, "[Content_Types].xml"),
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    );

    try {
      const result = runPython("office/pack.py", [
        input,
        output,
        "--validate",
        "yes",
      ]);

      expect(result.error).toBe(undefined);
      expect(result.status === 0).toBe(false);
      expect(existsSync(output)).toBe(false);
      expect(result.stderr).toContain("true|false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("soffice shim does not reuse a library preseeded in the shared temp directory", () => {
    const scriptPath = join(scriptDir, "office/soffice.py");
    const securityCheck = [
      "import importlib.util, pathlib, shutil, subprocess, sys, tempfile",
      "root = pathlib.Path(tempfile.mkdtemp())",
      "tempfile.tempdir = str(root)",
      "preseeded = root / 'lo_socket_shim.so'",
      "preseeded.write_text('untrusted')",
      "subprocess.run = lambda args, **kwargs: pathlib.Path(args[args.index('-o') + 1]).write_bytes(b'compiled')",
      "spec = importlib.util.spec_from_file_location('soffice', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "try:",
      "    shim = module._ensure_shim()",
      "    assert shim != preseeded, 'reused the preseeded shared-library path'",
      "    assert preseeded.read_text() == 'untrusted'",
      "    assert shim.parent.stat().st_mode & 0o077 == 0, 'shim directory is not private'",
      "finally:",
      "    module._SHIM_TEMP_DIR.cleanup()",
      "    shutil.rmtree(root, ignore_errors=True)",
    ].join("\n");
    const result = spawnSync("python", ["-c", securityCheck, scriptPath], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status).toBe(0);
  });

  test("soffice shim compile errors include gcc stderr and clean temporary files", () => {
    const scriptPath = join(scriptDir, "office/soffice.py");
    const failureCheck = [
      "import importlib.util, pathlib, subprocess, sys",
      "spec = importlib.util.spec_from_file_location('soffice', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "def fail_compile(args, **kwargs):",
      "    raise subprocess.CalledProcessError(1, args, stderr=b'compiler diagnostic')",
      "module.subprocess.run = fail_compile",
      "try:",
      "    module._ensure_shim()",
      "except RuntimeError as error:",
      "    assert 'compiler diagnostic' in str(error), str(error)",
      "else:",
      "    raise AssertionError('failed gcc invocation was accepted')",
      "assert not list(module._SHIM_DIR.glob('*.c'))",
      "assert not list(module._SHIM_DIR.glob('*.so'))",
      "module._SHIM_TEMP_DIR.cleanup()",
    ].join("\n");
    const result = spawnSync("python", ["-c", failureCheck, scriptPath], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
