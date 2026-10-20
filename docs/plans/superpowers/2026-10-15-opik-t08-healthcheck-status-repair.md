# T08 Repair Plan — Health Check Status Classification

- Source: coordinator ruling R-10 from T09/#15 question, discovered against integrated T08 checkpoint.
- Facts: approved Opik Spec; T08 acceptance in Issue snapshot #14; current integrated T08 code and independent repair review; T09/#15 readiness requirements.
- Workspace: fresh Orca child worktree from integration branch; coordinator transfers exact verified T08 sources before editing.
- Commit policy: no commit; full uncommitted patch/report/manifest. No stash, push, merge, publish.
- Review focus: health endpoint rejects all status codes except manifest-verified 200, distinguishes 401 auth failure from other non-200 status without exposing body/credentials, respects bounded deadline, preserves OpikPort public result contract.
- Global constraints: Claude Orca worker only for production edits; separate read-only Claude review; preserve unrelated changes; no real Opik writes.

## Task 1 — Fix T08 OpikPort healthCheck status semantics
- Depends on: verified T08; discovered integration defect R-10.
- Role: Claude backend implementation worker. Validator: separate Claude Spec/quality reviewer.
- Owned files: server/src/ai-observability/opik-http.ts, server/tests/opik-port.test.ts.
- Consumes: verified manifest capability/status contract; existing bounded exchange/readBody result mapping.
- Produces: healthCheck maps verified HTTP 200 to healthy, 401 to OPIK_AUTHENTICATION_FAILED, other non-200 statuses through established statusFailure mapping; body is never echoed and call remains bounded. Confirm existing public failure type supports auth classification; if not, stop and ask coordinator before widening interface.
- Steps: verify transferred hashes; add failing 401/500 tests first; run RED with true exit status; minimally change healthCheck status handling under existing exchange deadline; add 200/401/500 assertions including zero body/credential leakage; refactor only if behavior-preserving; run focused T08 tests, T05/T06/T07 prerequisite tests, typecheck, Biome.
- Expected tests: 200 => healthy; 401 => authentication failure; 500 => upstream error/unavailable; response body marker and bearer secret absent from result; stalled body still times out.
- Failure handling: no public type widening without coordinator ruling; no modification to T09 files; incomplete validation remains explicit. Deliver patch, full changed file hashes, RED/GREEN and logs; no self-review.
