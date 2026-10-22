# Recovery backend review: cp01-recovery

Role: independent reviewer; no source edits, no agents, no Git writes, no DB mutations. Write only `docs/plans/2026-10-19-plugin-package-marketplace/review-backend-cp01.md`.

Workspace: `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`.
Checkpoint: `checkpoints/cp01-recovery/manifest.json`, content SHA256 f778141a7954cd4683179e31593cc3e3f029cf20b833a8da3c3c7d044d77e43a, HEAD 9057aeebb69ebbbd2673378c17eec1dd830cfb17.

Read approved spec `docs/specs/2026-10-19-plugin-package-marketplace-design.md`, issues PKG01 and PKG02, ADR 0004/0006/0008, and AGENTS.md. User has authorized implementation, not commit/push/merge/production migration/deployment/issue closure. Earlier Task Briefs are subordinate to spec and cannot approve deviations. No PKG node is currently verified: prior PKG01 claim was withdrawn for missing real browser evidence and content-bound checkpoint.

Review backend source in checkpoint manifest, including full package source/contracts/schema/tests and changed assembly/admin-separation/migration/harness sections. Specifically reassess M1 locked canonical digest, M2 revision link filtering, M3 generator-preserved driven grouping/env, M4 lint, M5 real isolation/role/concurrency tests, M6 typed DB failures. Inspect actual junit/report files instead of trusting old counts. You may run pure tests or lint, but not DB suites that perform shared DDL.

Go beyond the old findings: compare spec §5-8 and current code. Do immutable artifacts/registration enforce same version across separate catalogue loads? Are release metadata and publish authority persisted as required? Does package install check connector catalogue identity, schema and scopes rather than just existence? Is trusted admin revalidated in every write, with spec lock order, receipt-first replay, expiry at lock time, and config digest revalidation? Does spec require production migration wiring absent in test-only DDL? Do plans and reads use the right DB authority? Do not silently accept deferred requirements just because an earlier brief defers them. Classify actual requirement conflict vs implementation defect.

Report two verdicts (Spec compliance and code quality). All valid critical/high/medium findings block verified, regardless of whether tests pass. Each finding: ID, severity, verified file:line evidence, observable failure, minimal in-scope fix, which test is missing. Separate future-ticket-owned behavior from PKG01/02 gaps. Report in <=1200 words. Bind report to checkpoint and check identity with `python3 docs/plans/2026-10-19-plugin-package-marketplace/checkpoint.py cp01-recovery --verify` before and after; if changed, report evidence invalidation instead of pass.
