# Issue #6 coordinator ledger

- Recorded at: 2026-10-15T22:35+08:00 (Asia/Shanghai)
- Root issue: `1123786563/OpenBot#6`
- Orca Run: `run_2198fc839b7c`
- Coordinator worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/issue6-multitenancy-coordinator`
- BASE: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (`main`)
- Delivery policy: uncommitted checkpoints only; no commit, push, merge, production migration, deployment, multitenancy enablement, or release.
- Worker policy: supervised Orca workers, `--agent pi` only; no fallback agent.

## Baseline

The source checkout had pre-existing tracked and untracked changes before the coordinator worktree was created. They were not copied into this clean `main`-based execution worktree and remain untouched in the source checkout.

## Orca facts

- Orca app/runtime: ready, reachable, version `1.4.224`.
- Registered repository: `d6edf033-748a-4549-ae5a-e9efd34cef91`.
- Isolated worktree creation succeeded with `--setup skip`; no implementation worker has been dispatched yet.
- The installed worker-start help lists supported agent ids but does not list `pi`; Pi registration must be proven from a real worker-start receipt before any implementation dispatch.

## Issue ingestion facts

- Root status: open; label `ready-for-agent`; updated `2026-10-15T06:57:42Z`.
- Root comments read: 3.
- Direct formal sub-issues read: 21 (GitHub REST `sub_issues`, paginated).
- Direct children: 20 multitenancy group Epics `#187`–`#206`, plus billing/payment Epic `#368`.
- Recursive formal Ticket counts: 143 under `#187`–`#206`; 7 under `#368`; 150 total formal implementation tickets in the current tree.
- This differs from the user-provided known “20 Epics / 143 Tickets” because #368 is an additional direct Epic and is in scope under “all formal children”; it is recorded as a conflict requiring explicit DAG treatment.
- One GitHub REST request for `#204/sub_issues` failed with `TLS handshake timeout` during bulk ingestion. It is a missing page until retried successfully; no ticket under that Epic is treated as absent.
- Ticket bodies contain a standard “Blocked by” verification gate plus cross-group dependency tables. Contains edges are not execution dependencies.

## Sources and gaps

- GitHub REST API: root issue, paginated `sub_issues`, issue bodies, and issue comments.
- Local approved Spec: `docs/specs/2026-10-14-company-team-multitenancy-design.md`.
- Local ADRs required by the root: `docs/adr/0004-company-team-tenancy.md`, `docs/adr/0002-per-user-bot-model-access.md`, and `docs/adr/0003-bifrost-openbot-credit-admission.md`; all three are present in the clean checkout.
- `CONTEXT.md` exists. `docs/agents/domain.md` is referenced by AGENTS but missing.
- `docs/tickets/multitenancy/` and the 26-task plan were absent from `main` but were found on `remotes/origin/1123786563/company-team-multitenancy`; they were restored into this execution worktree and hash-checked. The restored mirror contains 143 MT ticket Markdown files and 15 plan files. The restored plan is historical/stale in two ways: it predates the newly discovered direct Epic #368 and it contains an old “submission authorization” statement that is superseded by the current user instruction (no commits of any kind). It is reference input, not authorization.

## Status

- Issue ingestion: `in_progress` (retry missing page; read all ticket bodies/comments and blocked-by links).
- DAG/plan: `pending`.
- Implementation: `not_started`.
- Pi worker dispatch: running: MT001/#44 `ctx_d3fe7c016e22`, MT002/#45 `ctx_00135101e84a`, MT103/#146 `ctx_e684a2a0bf27`. All three receipts have effective agent `pi`, dedicated child worktrees, and live terminal evidence. The workers use the effective Pi config reported by Orca (`model: null`, `effort: null`; terminal preview currently shows `glm-5.3 • medium`), so no strongest-model claim is made.
- Next ready wave is not yet released; dependent work waits for verified, independently reviewed, integrated checkpoints. #147/MT104 is blocked by #146 and #126.

## Current static-plan evidence

- Restored `planning-checks.json` reports the historical T01–T26 graph has unique tasks, existing dependency references, no cycles, 13 acceptance mappings, and 7 requirement mappings. Its own limits state that it is static planning evidence only and does not prove product tests, runtime isolation, independent review, OCR, or release readiness.
- The 143 local Ticket mirrors each retain the parent #6 link, but do not contain the complete cross-ticket dependency URLs; therefore the GitHub Ticket bodies, not the local mirror, remain authoritative for the current 150-node `depends_on` graph. The current graph is not marked complete until all 150 bodies and Blocked by links have been parsed and reconciled, including BP01–BP07.

## Pre-existing sibling worktree evidence

- During worker monitoring, Pi discovered separate Orca worktrees `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt001` and `i6-mt002` containing uncommitted MT001/MT002-looking files and an MT001 report. These are not the current Dispatch worktrees (`issue6-mt001`, `issue6-mt002`) and have not been accepted, reviewed, hashed, or integrated by this coordinator.
- They are treated as external candidate work only. No shared stash, implicit copy, or trust transfer is allowed; any reuse requires explicit checkpoint manifest, independent Pi review, and hash-verified transfer into this coordinator worktree.
