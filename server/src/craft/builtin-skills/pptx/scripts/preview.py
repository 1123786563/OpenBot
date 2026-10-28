"""Generate slide preview images from a PowerPoint file.

Converts PPTX -> PDF -> JPEG slides with caching. If cached slides
already exist and are up-to-date, returns them without reconverting.

Output protocol (stdout):
    Line 1: status — one of CACHED, GENERATED, ERROR_NOT_FOUND, ERROR_NO_PDF
    Lines 2+: sorted absolute paths to slide-*.jpg files

A soffice/pdftoppm failure additionally notes "CONVERSION_ERROR" on stderr
and exits 1 (stdout then carries no status line).

Usage:
    python preview.py /path/to/file.pptx /path/to/cache_dir
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Allow importing office.soffice from the scripts directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

from office.soffice import run_soffice

CONVERSION_DPI = 150


def _find_slides(directory: Path) -> list[str]:
    """Find slide-*.jpg files in directory, sorted by page number."""
    # Numeric suffixes only: a stray "slide-notes.jpg" must not crash the sort.
    slides = [
        p
        for p in directory.glob("slide-*.jpg")
        if re.fullmatch(r"slide-\d+", p.stem)
    ]
    slides.sort(key=lambda p: int(p.stem.split("-", 1)[1]))
    return [str(s.resolve()) for s in slides]


def _source_fingerprint(pptx_path: Path) -> dict[str, str]:
    content_hash = hashlib.sha256()
    with pptx_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            content_hash.update(chunk)

    source_id = hashlib.sha256(os.fsencode(pptx_path.resolve())).hexdigest()
    return {"source": source_id, "content": content_hash.hexdigest()}


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <pptx_path> <cache_dir>", file=sys.stderr)
        sys.exit(1)

    pptx_path = Path(sys.argv[1])
    cache_dir = Path(sys.argv[2])

    if not pptx_path.is_file():
        print("ERROR_NOT_FOUND")
        return

    cache_manifest = cache_dir / ".preview-cache.json"
    source_fingerprint = _source_fingerprint(pptx_path)
    cached_slides = _find_slides(cache_dir)
    try:
        cached_manifest = json.loads(cache_manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        cached_manifest = None

    expected_manifest = {
        **source_fingerprint,
        "slides": [Path(slide).name for slide in cached_slides],
    }
    if cached_slides and cached_manifest == expected_manifest:
        print("CACHED")
        for slide in cached_slides:
            print(slide)
        return

    cache_manifest.unlink(missing_ok=True)
    for slide in cached_slides:
        os.remove(slide)

    cache_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".preview-", dir=cache_dir) as conversion_dir:
        result = run_soffice(
            [
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                conversion_dir,
                str(pptx_path),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print("CONVERSION_ERROR", file=sys.stderr)
            sys.exit(1)

        pdf_file = Path(conversion_dir) / f"{pptx_path.stem}.pdf"
        if not pdf_file.is_file():
            print("ERROR_NO_PDF")
            return

        result = subprocess.run(
            [
                "pdftoppm",
                "-jpeg",
                "-r",
                str(CONVERSION_DPI),
                str(pdf_file),
                str(cache_dir / "slide"),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print("CONVERSION_ERROR", file=sys.stderr)
            sys.exit(1)

    slides = _find_slides(cache_dir)
    if slides:
        cache_manifest.write_text(
            json.dumps(
                {
                    **source_fingerprint,
                    "slides": [Path(slide).name for slide in slides],
                }
            ),
            encoding="utf-8",
        )
    print("GENERATED")
    for slide in slides:
        print(slide)


if __name__ == "__main__":
    main()
