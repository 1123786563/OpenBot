# Issue #4 Opik execution DAG

- Root: `1123786563/OpenBot#4`; formal containment: #7–#43 (37 children), verified from GitHub API `sub_issues` response captured 2026-10-15 UTC.
- Execution worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/opik-issue4-coordinator`.
- BASE: `bab7c0b9b481d6563fdacb99fddf8af21f08c729`.
- Source snapshot: `docs/plans/issue-4-snapshot/`; source is GitHub API via `gh api --paginate`, with the complete local archive preserved because one live refresh exceeded the shell observation window.
- `contains`: #4 → every #7–#43. This is aggregation, not an implementation dependency.
- `depends_on`: explicit `Blocked by` links extracted from each child body. No cycle was found; the only terminal aggregate is #43.

## Nodes

Each node owns the files named by its task brief; exact paths are confirmed by the implementer after code exploration and recorded in the Ledger. All implementation nodes use an Orca Claude child worktree, commit only if explicitly authorized by the coordinator, and require a separate Claude reviewer plus applicable validator before integration.

| id | source | acceptance / interface | depends_on | role | verify | status |
|---|---|---|---|---|---|---|
| T01 | #7 | backend observability module/router seam and documented naming | — | backend_implementer | module/unit tests | pending |
| T02 | #8 | UI observability route and isolated i18n namespace | — | frontend_implementer | route/i18n tests | pending |
| T03 | #9 | optional pinned Opik deployment manifest | — | implementer | compose/config smoke | pending |
| T04 | #10 | verified upstream contract manifest and smoke | — | implementer | real-contract smoke | pending |
| T05 | #11 | semantic redaction projection and safe-content policy | — | backend_implementer | canary/redaction tests | pending |
| T06 | #12 | trusted workbench scope seam; unknown enterprise scope rejects | — | backend_implementer | two-scope adapter tests | pending |
| T07 | #13 | authoritative observation binding schema/store | T06 | backend_implementer | migration/store tests | pending |
| T08 | #14 | Opik HTTP port/adapter with safe query/write boundary | T04,T05,T07 | backend_implementer | adapter contract tests | pending |
| T09 | #15 | disabled zero-impact config and health states | T08 | backend_implementer | disabled/enabled tests | pending |
| T10 | #16 | actual run lifecycle and basic capability semantics | T09 | backend_implementer | lifecycle/SSE/cancel tests | pending |
| T11 | #17 | creator authorized read API | T01,T07,T10 | backend_implementer | auth/query tests | pending |
| T12 | #18 | creator run list page | T02,T11 | frontend_implementer | component/browser tests | pending |
| T13 | #19 | creator run detail and availability states | T12 | frontend_implementer | component/browser tests | pending |
| T14 | #20 | built-in model call records | T05,T10 | backend_implementer | model telemetry tests | pending |
| T15 | #21 | tool proposal vs execution and retrieval records | T14 | backend_implementer | behavior tests | pending |
| T16 | #22 | LangGraph callback on governed OTel path | T14 | backend_implementer | runtime tests | pending |
| T17 | #23 | cross-service/dynamic propagation and ID mapping | T16 | backend_implementer | propagation/mapping tests | pending |
| T18 | #24 | detail step tree | T19,T21,T23 | frontend_implementer | detail integration tests | pending |
| T19 | #25 | immutable dataset/version schema | T07,T11 | backend_implementer | schema/version tests | pending |
| T20 | #26 | reviewed candidate case save API | T05,T19 | backend_implementer | authorization/content tests | pending |
| T21 | #27 | dataset review/save/version page | T02,T20 | frontend_implementer | UI tests | pending |
| T22 | #28 | frozen experiment schema and idempotent submit | T19 | backend_implementer | schema/idempotency tests | pending |
| T23 | #29 | isolated execution and production-write rejection | T10,T14,T22 | backend_implementer | isolation/tool refusal tests | pending |
| T24 | #30 | bounded durable evaluation jobs, reauth, cancellation/lease | T23 | backend_implementer | queue/lease tests | pending |
| T25 | #31 | evaluation credit/admission/reservation/settlement | T24 | backend_implementer | billing integration tests | pending |
| T26 | #32 | deterministic rule scorers | T22 | backend_implementer | scorer tests | pending |
| T27 | #33 | controlled model Judge scorer | T25,T26 | backend_implementer | budget/redaction tests | pending |
| T28 | #34 | experiment result query and failure classes | T26 | backend_implementer | query tests | pending |
| T29 | #35 | compatible experiment comparison API | T28 | backend_implementer | compatibility/regression tests | pending |
| T30 | #36 | experiment submit/results/cancel page | T21,T28 | frontend_implementer | UI integration tests | pending |
| T31 | #37 | comparison page | T29,T30 | frontend_implementer | UI integration tests | pending |
| T32 | #38 | authenticated collection/control-plane/private API protection | T09 | backend_implementer | auth bypass tests | pending |
| T33 | #39 | admin scoped summary and collection health | T11,T32 | backend_implementer | scope/health tests | pending |
| T34 | #40 | bounded async export and immediate revocation | T05,T11 | backend_implementer | queue/download tests | pending |
| T35 | #41 | retention and verified physical deletion | T19,T22,T34 | backend_implementer | live deletion evidence | pending |
| T36 | #42 | admin summary and creator export-status UI | T13,T33,T34 | frontend_implementer | UI tests | pending |
| T37 | #43 | full A1–A13 real self-hosted Opik evidence | T01..T36 plus T03,T04 | implementer/validator | live E2E evidence | pending |

## Integrity checks

- Formal child set: exactly `{7..43}`; all nodes above are unique and every dependency refers to an existing node.
- Explicit dependency graph is acyclic; topo waves begin with T01–T06, then T07/T08 as contracts settle, with later waves released only after integration and review.
- A1–A13 map to T03–T37; the full mapping and evidence paths are maintained in the Ledger. Parent aggregate requirements are not reimplemented outside child coverage.
- Unknowns: live Opik endpoint/credentials, exact upstream compatible versions, test ports, and current code ownership are environment facts to be resolved by T03/T04/T09 and recorded as blockers if unavailable. A skipped live check is never `verified`.
