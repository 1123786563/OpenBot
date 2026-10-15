# T2 Expert Catalog Negative Transaction Assertion Fix2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the forged-scope and malformed-reference tests prove each rejected call opens no transaction.

**Architecture:** Capture the fake database transaction count immediately before each rejected public catalog call, then compare it afterward. This is a test-only evidence correction to the approved Expert catalog Task 1.

**Tech Stack:** TypeScript, Bun test.

**Spec:** Approved design and Expert catalog prerequisite plan; Fix1 independent review `.superpowers/sdd/2026-10-13-mastra-t2-expert-version-prerequisite/reports/fix1-reviewer-report.md`.

## Global Constraints

- Existing dirty worktree; no stage/commit/stash/reset/rebase/merge/push/PR/publish/worktree deletion.
- No database service access or operation. Preserve all production, schema, migration, journal and other user files.
- Own only `server/tests/enterprise/expert-version-catalog.test.ts` plus Fix2 report/checkpoint files. Existing source hash `aaab8d84226459c5fd1a7edaaa8b09452cbf3eafedd1fe23eb42920b28e6d322` is protected.

## Review Focus

The final negative-path test must show two separate zero transaction deltas after the preceding valid cross-tenant lookup, while preserving all prior assertions and the exact verified fake.

## Task 1: Correct per-call transaction assertions

**Depends on:** Fix1 frozen test hash `d1e0a81e3cdbdaaf87e7e1cc851a71ae185ed3944cf904ea593a2119adf2fbc6`. **Owner:** mechanical_worker. **Validator:** backend_validator. **Reviewer:** reviewer. **Consumes:** public catalog test fixture. **Produces:** precise zero-transaction assertions for each rejection. **Commit strategy:** uncommitted checkpoint.

- [ ] Confirm HEAD, test baseline hash, complete before/protected manifest and Fix1 review finding.
- [ ] In only the final negative-path test, save `transactionCount` just before forged `putOrGet`; assert it is unchanged immediately after. Save a fresh count before malformed `resolve`; assert it is unchanged immediately after. Keep the preceding valid cross-tenant lookup and all error assertions. Do not change setup, production or any other test.
- [ ] Run `bun test server/tests/enterprise/expert-version-catalog.test.ts` (expect 13 pass), scoped Biome and `git diff --check`; compare protected hashes.
- [ ] Freeze exact test-only patch and hashes in Fix2 implementer report; independent backend validation and reviewer give same-checkpoint verdicts. This is a test-only correction, so do not manufacture a production RED or claim PostgreSQL behavior.

**Acceptance:** Both rejected calls individually have zero transaction delta; no production change; same focused suite passes. Isolated PostgreSQL/RLS gates remain unverified.
