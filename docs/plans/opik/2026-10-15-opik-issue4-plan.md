# Implementation Plan: Issue #4 Opik integration

## Global Constraints

- Approved Spec: `docs/specs/2026-10-14-opik-integration-design.md`; Issue snapshot: `archive/plans/issue-4-snapshot/`.
- Preserve existing tracing, credit ledger/settlement, enterprise runtime, and prompt behavior. No tenant tables, second user system, Opik ACL-as-business-auth, raw content, reasoning, attachments, Bifrost changes, push, merge, or release.
- All production edits are made in Orca Claude child worktrees. Coordinator integrates only after a separate Claude Spec/quality review and applicable validation.
- Every worker reports files, tests, content hashes, and commit or uncommitted checkpoint. A worker cannot approve its own code.

## Review Focus

Trusted scope and current ownership; redaction before every upstream/evaluation write; lifecycle truth under SSE/cancel/retry; disabled zero-impact; bounded async failure isolation; credit/admission/settlement; deletion/export revocation; ID mapping; no arbitrary Opik proxy; accessibility/i18n; real Opik evidence.

## Tasks

The executable task list is the DAG in `2026-10-15-opik-issue4-dag.md`. Dispatch in ready waves, using one self-contained brief per Task. Each brief names owned files after exploration, consumes only reviewed/integrated predecessor interfaces, produces tests and a report under `archive/plans/issue-4-ledger/`, and uses RED → GREEN → REFACTOR. Reviewers produce separate Spec-compliance and code-quality conclusions. Validators are read-only.

Wave 1: T01–T06. Wave 2: T07–T10 after their predecessor contracts. Wave 3: T11,T14,T16,T19,T22,T32,T34. Wave 4: T12,T13,T15,T17,T20,T23,T26,T28,T33. Wave 5: T18,T21,T24,T25,T27,T29,T30,T35. Wave 6: T31,T36. Wave 7: T37.

For every task: inspect the current worktree; implement only the task contract; run targeted tests; produce a Review Package covering all changed files (including untracked files); obtain independent Claude review; repair findings in a new Claude dispatch; validate again; then integrate and update the Ledger. Dependencies are released only after the integrated checkpoint is reviewed and verified.

## Verification and completion

Run repository typecheck/lint/build and targeted suites proportionate to changes. T37 must run the real self-hosted Opik acceptance for A1–A13, including collection/query/evaluation/ID mapping/deletion and host/container/dynamic-process smoke where supported. Finally run full-scope strongest available Claude review, then OCR with `--audience agent` over BASE→HEAD and workspace changes, repeating Claude repair/review and OCR for valid critical/high/medium findings.
