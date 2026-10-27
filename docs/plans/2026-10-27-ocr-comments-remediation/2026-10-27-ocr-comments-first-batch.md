# OCR Comments Remediation — Verified Safe Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four source-confirmed critical/high findings in PPTX cleanup and packing without changing the scan report or unrelated workspace edits.

**Architecture:** Keep the current Python script interfaces. Parse the presentation slide list as XML and fail before deletion when its reference metadata is unavailable; preserve SpreadsheetML text nodes during XML condensation and reject an explicitly supplied missing source file.

**Tech Stack:** Python 3, defusedxml, repository e2e test runner.

**Spec:** `ocr-comments.json` is an unverified input; implementation behavior is governed by the source and the PPTX skill instructions.

## Global Constraints

- Do not modify `ocr-comments.json`.
- Do not change public APIs, database structures, protocol behavior, or add dependencies.
- Preserve existing workspace changes; do not commit.
- Do not run a full-repository OCR scan.
- Add regression tests for confirmed bugs and run the smallest applicable checks.

## Review Focus

- Missing slide metadata must fail before any slide is deleted.
- A valid `sldIdLst` with an alternate XML prefix must preserve referenced slides.
- An intentionally empty valid `sldIdLst` must continue to remove all slide parts.
- Whitespace-only SpreadsheetML strings must survive packing.
- An explicitly supplied but missing `--original` path must fail visibly.
- A shared temporary directory must not supply a preseeded library to `LD_PRELOAD`.

---

### Task 1: Preserve slide and spreadsheet package data

**Files:**
- Modify: `server/src/craft/builtin-skills/pptx/scripts/clean.py`
- Modify: `server/src/craft/builtin-skills/pptx/scripts/office/pack.py`
- Test: `server/tests/craft-pptx-scripts.test.ts`

**Interfaces:** Keep `get_slides_in_sldidlst(Path) -> set[str]`, `remove_orphaned_slides(Path) -> list[str]`, `pack(...)`, and `_condense_xml(Path)` signatures unchanged.

- [ ] Add behavioral tests for missing presentation metadata, alternate XML namespace prefixes, a valid empty slide list, whitespace-only SpreadsheetML text, and a nonexistent explicitly supplied original file.
- [ ] Run `e2e run --config e2e.unit.config.ts --output .e2e/2026-10-27-ocrfix-1a68e8d2/pptx-red server/tests/craft-pptx-scripts.test.ts`; expect the four reported-defect cases to fail and the valid-empty-list case to pass.
- [ ] Parse `presentation.xml` with the existing defused XML parser, require its slide list and relationship metadata, and resolve slide IDs without a prefix-sensitive regex.
- [ ] Preserve SpreadsheetML text elements by local name and return an error when an explicit original path is not a file.
- [ ] Rerun the focused test file to verify all five cases pass.

No commit step: the user explicitly prohibited commits.

### Task 2: Isolate the LibreOffice preload shim

**Files:**
- Modify: `server/src/craft/builtin-skills/pptx/scripts/office/soffice.py`
- Test: `server/tests/craft-pptx-scripts.test.ts`

**Interfaces:** Keep `get_soffice_env()`, `run_soffice(...)`, and `_ensure_shim() -> Path` unchanged.

- [ ] Add a test that pre-seeds the shared temporary path and verifies `_ensure_shim()` returns a different library under a private directory.
- [ ] Run the focused e2e test and confirm the new test fails by reusing the preseeded library.
- [ ] Compile into a private per-process temporary directory and atomically publish the shim there.
- [ ] Rerun the focused e2e test and verify all six tests pass.
