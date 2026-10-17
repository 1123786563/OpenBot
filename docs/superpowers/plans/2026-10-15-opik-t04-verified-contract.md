# OpenBot issue #10 / DAG T04: verified self hosted Opik contract

> **For agentic workers:** Execute this task through Orca Superpowers SDD. The implementation and reviewer must be separate Claude workers. Coordinator integrates only reviewed checkpoint contents.

**Goal:** Prove the pinned Opik server and SDK contracts against a real self hosted instance and emit a versioned manifest consumed by later adapters.

**Architecture:** Treat the T03 deployment manifest as candidate input. The executable contract owns one isolated Opik stack and one isolated synthetic project, sends safe canary records through OTLP, reads them back, exercises dataset/experiment APIs and physical deletion, and produces evidence only when each assertion passes.

**Sources:** Approved parent Spec A1/A4/A11/A13; Issue #10 acceptance; T03 handoff and `VerifiedOpikContract` interface in `docs/plans/2026-10-14-opik-integration-plan.md`; DAG and issue snapshot; T03 reviewed checkpoint and R03 repair package after integration.

## Global Constraints

- Do not use production Opik, application DB, real users, secrets or raw attachments. Use synthetic canaries and the Task's isolated Compose project/volume.
- Pin service and SDK versions; no `latest`. Test manifest values against actual service response and image digest.
- A missing Docker/runtime/Opik instance, a skipped operation, or a fixture-only assertion fails the real contract gate. It cannot emit a verified manifest.
- Do not expose credentials in output, fixtures or logs. Redact target credentials before writing any evidence.
- No commit, push, merge, publish or shared stash. Report exact checkpoint hashes.

## Review Focus

- Every claimed method is exercised against the running service, including queries and deletion.
- ID mapping is explicit; do not assume OTel trace ID equals Opik ID.
- Parent/child relation and a second attempt are queried from Opik.
- After physical delete, querying the exact records/dataset/experiment returns absence.
- A safe canary and a forbidden-secret canary prove neither payload nor diagnostics retain unsafe data.

## File ownership and interfaces

Create only `server/scripts/opik-contract.ts`, `server/tests/opik-contract.test.ts`, `server/tests/support/opik-contract-fixtures.ts`, `docs/opik-contract.md`, and `docs/plans/evidence/2026-10-15-issue4/opik-contract/` evidence files. Consume T03's `docker/compose/opik.yml`, `docker/opik/versions.json`, and T05's approved projection API; do not modify them. Produce `VerifiedOpikContract` with exact service tag/digest, SDK semver, upstream revision, request/response evidence, OTLP parent/child mapping, dataset/experiment behavior, deletion proof, content limit and timestamp. Any interface change needs a coordinator decision before code changes.

## Steps

- [ ] RED: Write deterministic validator tests that reject an absent service digest, unknown SDK version, empty fixture list, identity-assumed mapping, unverified physical deletion, target without explicit isolated project, or any secret canary in serialized evidence. Confirm the intended failures.
- [ ] GREEN: Implement an executable contract runner that requires an explicit isolated base URL and disposable project, uses finite timeouts, emits sanitized request/response fixtures, writes to an evidence directory, and returns nonzero unless all checks pass.
- [ ] Start the pinned stack from T03 using unique Compose project name, host ports and volume. Prove actual container image digests. Never collide with another Opik instance.
- [ ] Send synthetic OTel trace with parent/child spans, query it through supported API, map both OTel and Opik IDs. Create dataset, immutable sample version and experiment; query each; delete them and the trace through supported API, then query again to prove physical absence.
- [ ] Verify supported body limit with boundary-sized safe synthetic content. Scan actual request/response fixtures and diagnostics for private key, credential, account and attachment canaries.
- [ ] RED/GREEN/REFACTOR test the parser against saved sanitized responses, but label fixtures as parser tests only. Run live contract command separately and preserve full output/exit code. No test skip may turn the live command green.
- [ ] Run `bun test server/tests/opik-contract.test.ts`, locked Biome on owned files, server typecheck, then the explicit real-instance contract command. Report each separately.
- [ ] Capture HEAD, staged/unstaged diff, untracked file contents, SHA256 list and final manifest hash. Send worker_done only after final self-check.

## Failure handling

If a required upstream capability is unavailable or service startup fails, retain the evidence and report failed/blocked with exact error. Do not fabricate the manifest or change the pinned service outside scope. Stop before changing shared contracts; request coordinator direction via Orca.

## Coordinator handoff (2026-10-15)

A dedicated isolated Compose project `opik-issue4-validation` is already running on this host with synthetic random datastore credentials kept at `/tmp/opik-issue4-validation.env`; all containers are healthy and `http://127.0.0.1:5174/api/health-check` returned HTTP 200. This project has no production data and is reserved exclusively for T04's synthetic contract probes and later coordinator acceptance. T04 must use a unique synthetic Opik project within this instance, avoid touching unrelated records, and physically delete only its own fixtures. Do not start a second Opik stack (Docker's memory limit is 7.8 GiB and the running stack uses ~2.4 GiB). The coordinator will not run competing Opik API probes while T04 is active.
