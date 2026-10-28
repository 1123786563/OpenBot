import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

const scriptDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/craft/builtin-skills/pptx/scripts",
);

test("thumbnail generation reports visible slides without rendered images", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-pptx-thumbnail-"));
  const check = [
    "import sys",
    "from pathlib import Path",
    "from PIL import Image",
    "sys.path.insert(0, sys.argv[1])",
    "from thumbnail import build_slide_list",
    "root = Path(sys.argv[2])",
    "image = root / 'slide-1.jpg'",
    "Image.new('RGB', (8, 8)).save(image)",
    "slides = build_slide_list([{'name': 'slide1.xml', 'hidden': False}, {'name': 'slide2.xml', 'hidden': False}], [image], root)",
    "assert len(slides) == 1, slides",
  ].join("\n");

  try {
    const result = spawnSync("python", ["-c", check, scriptDir, root], {
      encoding: "utf8",
    });

    expect(result.error).toBe(undefined);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("slide2.xml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
