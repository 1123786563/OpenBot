# OCR remediation — verified safe batch

> **Goal:** Fix source-confirmed OCR findings that can be corrected without changing public contracts, persistence rules, or unrelated workspace state.

## Scope

- Leave `ocr-comments.json` unchanged and do not run a full-repository OCR scan.
- Preserve existing user changes and make no commit.
- Add focused regressions for destructive cleanup, XML packing, CLI validation, and the LibreOffice shim.
- Defer findings that need a product, migration, or compatibility decision; record every report entry in the run ruling ledger.

## Completed source fixes

1. `server/src/craft/builtin-skills/pptx/scripts/clean.py`: report entries 150, 151, 152 — fail before deletion when reference XML is absent or invalid, parse slide IDs by namespace, and pre-validate every `.rels` file plus the presentation and content-type XML before cleanup.
2. `server/src/craft/builtin-skills/pptx/scripts/office/pack.py`: entries 121 (explicit missing source path only), 122, 123, 124, 125 — preserve optional CLI behavior when no source is provided; reject a missing explicitly supplied source; preserve default-namespace text; return XML processing errors; classify CLI errors by the error prefix; reject invalid boolean values.
3. `server/src/craft/builtin-skills/pptx/scripts/office/soffice.py`: entry 128 — put the preload library in a private temporary directory and atomically publish compiled output.
4. `server/src/bot-services/auth.ts`: entry 1926 (partial) — return only typed credential failures as 401 and rethrow infrastructure errors. The `Retry-After` value remains fixed at the production default; custom limiter windows need an API-compatible design.

## Verification

- Focused regression file: `server/tests/craft-pptx-scripts.test.ts` through the repository e2e runner.
- Preserve red/green evidence and skipped collection notices in `.archive/runs/2026-10-27-ocrfix-1a68e8d2/verification/`.
- Perform a final scoped diff and report-integrity check; no commit.

## Deferred decisions

- Entry 704 (critical): migration 0134 backfills append-only price snapshots and omits detail columns for `unknown`; changing the migration requires approval for a one-transaction derived-column backfill exception.
- Entry 705 (medium): strengthen DB checks to compare missing-dimension details with `dims`; this changes persisted write rules.
- Entry 924 (critical): the schedule sweep hands off to an orchestrator with a refusing gateway; an effective fix needs a server-owned execution handoff.
- Entry 937 (critical): staging rollback cannot construct the source through the current CLI state gate; requires a deliberate rollback-path adjustment and regression coverage.
- Entry 121 (high): an explicit nonexistent `--original` is now rejected; whether validation should also require `--original` when omitted remains a product behavior decision.
- Entry 129 (high): the shim's intentional `_exit(0)` behavior can hide conversion failures; the correct status contract needs investigation.
- Entry 153 (high): relationship retention across non-slide parts needs a representative Office package fixture before changing cleanup behavior.
- Entry 1926 (high, partial): infrastructure errors now reach the server error handler; the report's custom-window `Retry-After` mismatch remains and changing the limiter/error contract needs a compatible design.
