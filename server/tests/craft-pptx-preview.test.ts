import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";

const previewScript = fileURLToPath(
  new URL(
    "../src/craft/builtin-skills/pptx/scripts/preview.py",
    import.meta.url,
  ),
);

const bootstrap = [
  "import importlib.util, pathlib, sys",
  "script_path = pathlib.Path(sys.argv[1])",
  "spec = importlib.util.spec_from_file_location('preview', script_path)",
  "preview = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(preview)",
].join("\n");

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openbot-pptx-preview-"));
}

function runPython(root: string, body: string) {
  return spawnSync(
    "python",
    ["-c", `${bootstrap}\n${body}`, previewScript, root],
    {
      encoding: "utf8",
    },
  );
}

describe("PPTX preview cache", () => {
  test("reuses slides only for the same source path and bytes, regardless of mtime", () => {
    const root = temporaryDirectory();

    try {
      const result = runPython(
        root,
        [
          "import io, os",
          "from contextlib import redirect_stdout",
          "from pathlib import Path",
          "from types import SimpleNamespace",
          "root = Path(sys.argv[2])",
          "first = root / 'first.pptx'",
          "second = root / 'second.pptx'",
          "cache = root / 'cache'",
          "first.write_bytes(b'first source')",
          "second.write_bytes(b'second source')",
          "os.utime(first, (100, 100))",
          "os.utime(second, (100, 100))",
          "rendered = []",
          "def run_soffice(args, **kwargs):",
          "    source = Path(args[-1])",
          "    output = Path(args[args.index('--outdir') + 1]) / f'{source.stem}.pdf'",
          "    output.write_bytes(source.read_bytes())",
          "    return SimpleNamespace(returncode=0)",
          "def render(args, **kwargs):",
          "    pdf = Path(args[-2])",
          "    rendered.append(pdf.read_bytes())",
          "    Path(args[-1]).with_name('slide-1.jpg').write_bytes(pdf.read_bytes())",
          "    return SimpleNamespace(returncode=0)",
          "preview.run_soffice = run_soffice",
          "preview.subprocess.run = render",
          "def invoke(source):",
          "    preview.sys.argv = [str(script_path), str(source), str(cache)]",
          "    output = io.StringIO()",
          "    with redirect_stdout(output): preview.main()",
          "    return output.getvalue().splitlines()",
          "first_output = invoke(first)",
          "second_output = invoke(second)",
          "second.write_bytes(b'changed source')",
          "os.utime(second, (100, 100))",
          "third_output = invoke(second)",
          "fourth_output = invoke(second)",
          "assert [first_output[0], second_output[0], third_output[0], fourth_output[0]] == ['GENERATED', 'GENERATED', 'GENERATED', 'CACHED'], (first_output, second_output, third_output, fourth_output)",
          "assert rendered == [b'first source', b'second source', b'changed source'], rendered",
        ].join("\n"),
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not cache partial slides left by a failed pdftoppm run", () => {
    const root = temporaryDirectory();

    try {
      const result = runPython(
        root,
        [
          "import io, os",
          "from contextlib import redirect_stderr, redirect_stdout",
          "from pathlib import Path",
          "from types import SimpleNamespace",
          "root = Path(sys.argv[2])",
          "source = root / 'deck.pptx'",
          "cache = root / 'cache'",
          "source.write_bytes(b'deck')",
          "os.utime(source, (100, 100))",
          "attempts = 0",
          "def run_soffice(args, **kwargs):",
          "    output = Path(args[args.index('--outdir') + 1]) / 'deck.pdf'",
          "    output.write_bytes(b'deck pdf')",
          "    return SimpleNamespace(returncode=0)",
          "def render(args, **kwargs):",
          "    global attempts",
          "    attempts += 1",
          "    prefix = Path(args[-1])",
          "    prefix.with_name('slide-1.jpg').write_bytes(b'partial' if attempts == 1 else b'complete')",
          "    if attempts == 1: return SimpleNamespace(returncode=1)",
          "    prefix.with_name('slide-2.jpg').write_bytes(b'complete')",
          "    return SimpleNamespace(returncode=0)",
          "preview.run_soffice = run_soffice",
          "preview.subprocess.run = render",
          "def invoke():",
          "    preview.sys.argv = [str(script_path), str(source), str(cache)]",
          "    output, error = io.StringIO(), io.StringIO()",
          "    try:",
          "        with redirect_stdout(output), redirect_stderr(error): preview.main()",
          "    except SystemExit as exit_error:",
          "        return exit_error.code, output.getvalue().splitlines(), error.getvalue()",
          "    return 0, output.getvalue().splitlines(), error.getvalue()",
          "first = invoke()",
          "second = invoke()",
          "assert first[0] == 1 and 'CONVERSION_ERROR' in first[2], first",
          "assert second[0] == 0 and second[1][0] == 'GENERATED', second",
          "assert len(second[1][1:]) == 2 and attempts == 2, (second, attempts)",
        ].join("\n"),
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("converts the PDF for this PPTX and preserves unrelated PDFs", () => {
    const root = temporaryDirectory();

    try {
      const result = runPython(
        root,
        [
          "import io",
          "from contextlib import redirect_stdout",
          "from pathlib import Path",
          "from types import SimpleNamespace",
          "root = Path(sys.argv[2])",
          "source = root / 'deck.pptx'",
          "cache = root / 'cache'",
          "cache.mkdir()",
          "source.write_bytes(b'deck')",
          "unrelated = cache / '00-unrelated.pdf'",
          "unrelated.write_bytes(b'unrelated pdf')",
          "rendered = []",
          "def run_soffice(args, **kwargs):",
          "    output = Path(args[args.index('--outdir') + 1]) / 'deck.pdf'",
          "    output.write_bytes(b'current deck pdf')",
          "    return SimpleNamespace(returncode=0)",
          "def render(args, **kwargs):",
          "    rendered.append((Path(args[-2]).name, Path(args[-2]).read_bytes()))",
          "    Path(args[-1]).with_name('slide-1.jpg').write_bytes(b'slide')",
          "    return SimpleNamespace(returncode=0)",
          "preview.run_soffice = run_soffice",
          "preview.subprocess.run = render",
          "preview.sys.argv = [str(script_path), str(source), str(cache)]",
          "output = io.StringIO()",
          "with redirect_stdout(output): preview.main()",
          "assert output.getvalue().splitlines()[0] == 'GENERATED', output.getvalue()",
          "assert rendered == [('deck.pdf', b'current deck pdf')], rendered",
          "assert unrelated.read_bytes() == b'unrelated pdf', 'unrelated PDF was removed or changed'",
        ].join("\n"),
      );

      expect(result.error).toBe(undefined);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
