# Mastra Migration OCR Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the valid high- and medium-impact findings from the complete 139-comment BASE..HEAD OCR review without changing accepted Mastra migration behavior or weakening per-Run governance.

**Architecture:** Keep product policy in the existing enterprise services and Mastra adapters, with PostgreSQL constraints/RLS as defense in depth. Repair work is serial and split by stable ownership boundaries: role/migration safety, schema invariants, Run governance, conversation contracts, attachment reconciliation, and Mastra lifecycle. Low-impact observations and conditional claims remain explicitly ruled or deferred in the ledger rather than being bundled into risky refactors.

**Spec:** `docs/specs/superpowers/2026-10-10-mastra-intelligence-migration-design.md`; inherited tenancy requirements: `docs/specs/superpowers/2026-10-09-enterprise-ai-platform-design.md`; full OCR: `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/ocr-r15-base-to-head-retry.txt`; complete adjudications: `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/adjudication-schema.md`, `adjudication-conversations.md`, `adjudication-runtime.md`, and `adjudication-mastra.md`; DAG: `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/ocr-repair-dag.md`.

## Global Constraints

- Preserve tenant, workspace, and principal scope on every Run, budget reservation, model capability, event, conversation, and storage operation.
- A Run has one cumulative model-token ceiling; every invocation supplies a positive explicit output-token bound; unknown dispatched usage remains conservatively charged and cannot be lowered through ordinary confirmation.
- Never expose provider credentials, Plan tokens, internal storage keys, or raw provider errors in public DTOs, logs, or events.
- Keep Mastra as the unified execution and Intelligence runtime; do not restore CopilotKit Intelligence or introduce tRPC-Agent-Go.
- Do not rewrite an applied migration; create forward migrations and repair generated metadata only when the committed chain proves it is wrong.
- Preserve the authorized ordered attachment input contract; do not silently sort or deduplicate caller input.
- RLS/operator changes require real PostgreSQL role and policy tests; do not add `FORCE ROW LEVEL SECURITY` without preserving maintenance visibility and culler behavior.
- Do not introduce an implicit model output-token default. Each caller must pass a positive `maxOutputTokens`.
- User decision pending for provider stream discriminator boundary: no implementation depending on that decision may start until resolved and R16 passes its independent gates.

## Review Focus

- Cross-workspace/principal IDs or idempotency keys presented within the same tenant must never read, confirm, release, or mutate another scope's budget or Run lease; exercise real DB policies and service predicates.
- Dispatched or ambiguously resolved model work must never transition from unknown to lower confirmed usage or become free through expiry/retry.
- Fresh and upgraded databases must apply role prerequisites, legacy-data backfills, constraints, and Drizzle snapshots in the documented deployment path.
- Same-key conversation retries, duplicate attachment IDs, storage outages, and reconciler candidate failures must return stable outcomes without losing or duplicating writes.
- Provisioning interruption, pool close failure, credential rotation, and compatibility-probe hangs must have bounded, recoverable behavior without leaking secrets.

---

## Source and disposition

The repair inventory is the four complete-slice adjudications of all 139 comments in the successful OCR report. Reviewed refs are BASE `fbdecc29cd786952c4b496abc68384b31a320b17` through HEAD `2054397cd9c4fb1b161086c9f991c15a11f6d4fe`; the OCR report SHA256 is `db55253296dc2c9424e9d633fe9624df01564de6e931ebb971e8cacf9d657706`. Current uncommitted model edits are the separate R16 stream-redaction repair and are not part of that immutable range.

The DAG covers valid high and medium findings and direct additional security observations from adjudication. Low style/refactor items, unsupported claims, and conditional issues without required evidence are recorded in the per-slice adjudication reports; they are not implementation tasks. Before each repair task starts, its implementer brief must enumerate the specific OCR IDs and rulings it owns, and the reviewer must assess only that bounded increment plus relevant invariants.

## DAG

All tasks are serial to prevent concurrent changes to shared schema, migration, and service contracts. `R16` is an external prerequisite: resolve the pending stream-boundary policy, then verify R16 CP and its full model review before any task that can alter the model boundary. HEAD stays at the recorded base commit; tasks use hash-bound uncommitted checkpoints, no commit/stash/reset.

| ID | Source findings / acceptance | Depends on | Owner / validator | Owned files | Interface produced | Verification | Status |
|---|---|---|---|---|---|---|---|
| R0 | R16-Q01: stream type is untrusted runtime data; reject malformed or credential-bearing discriminator before dispatch/output; cancel and mark unknown exactly once; no usage confirmation. | User decision received: fail closed | backend_implementer / backend_validator / reviewer | `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts` | Enforced stream-part boundary | model, integration, gateway suites; Biome; exact checkpoint review | running |
| R1 | OCR schema `0055` role prerequisite; role validation missing `rolreplication`; PUBLIC enterprise grants omitted; role SQL password visibility/partial bootstrap; ownership-check drift. Acceptance: documented executable deployment preflight; reject unsafe pre-existing capability/login roles; transactional, explicit setup privilege contract. | R0 | backend_implementer / backend_validator / reviewer | `server/ops/enterprise/roles.sql`, `server/src/enterprise/tenancy/connections.ts`, deployment docs/tests | Fail-closed runtime-role verifier and operator setup contract | role/database integration tests on supported PostgreSQL; migration setup test; static SQL checks | pending |
| R2 | OCR `0055→0056` snapshot link; zero Run ceiling default; native jsonb double serialization; reservation `confirmed_tokens <= token_limit`. Acceptance: forward-only migration and generated schema chain are coherent; any existing rows affected by new checks are measured and addressed before applying them. | R1 | backend_implementer / backend_validator / reviewer | next verified migration(s), `server/drizzle/meta/*`, `server/src/db/schema/enterprise-runs.ts`, `server/src/db/schema/mastra-message-intents.ts`, schema tests | Positive non-default Run ceiling and valid attachment_ids JSONB mapping | fresh DB + upgrade path; `drizzle-kit check`; direct invalid insert/update tests | pending |
| R3 | Runtime high: budget confirm/release and idempotency cross-scope; capability unknown→confirmed; Run currentAttempt/expireLease scope; budget ceiling key; configured maximum; gateway confirm fallback and stream timeout; preserve known/unknown accounting. Acceptance: every budget/lease mutation checks full scope; unknown is monotonic absent separate audited reconciliation. | R2 | backend_implementer / backend_validator / reviewer | `server/src/enterprise/models/budget.ts`, `server/src/enterprise/runs/model-capability.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/models/gateway.ts`, associated tests | Scoped reservation/lease operations and monotonic usage state machine | DB integration scope matrix; retries/unknown transitions; long synthetic stream; rejected confirm settlement; gateway suites | pending |
| R4 | Wire/conversation high/medium: mastra enum mismatch; scheduled delegation JSON Schema; pending-write/storage 503 mapping; legacy read-only typed response; duplicate attachment IDs; factory history lookup; retryable finalized read failures; tool role preservation. Acceptance: Zod, generated JSON Schema, service DTO, and HTTP responses agree. | R2 | backend_implementer / backend_validator / reviewer | `shared/enterprise/contracts.ts`, `shared/enterprise/wire-schema.ts`, `server/src/enterprise/conversations/{routes,service}.ts`, `server/src/mastra/conversations.ts`, tests | Correct Mastra storage/runtime wire contract and retry-safe errors | cross-validator Zod/schema vectors; HTTP integration; duplicate-id no-side-effect test; history role/backend tests | pending |
| R5 | Attachment/reconcile: attachment-leading intent index; per-candidate error isolation; lock-held external I/O bound; culler visibility/race and abandoned pending retention contract; workspace/resource delete semantics; stale attachment comments. Acceptance: indexed reservation probes, no FK race outage, retryable candidate isolation, retention/deletion policy documented and tested. | R2, R4 | backend_implementer / backend_validator / reviewer | `server/src/db/schema/mastra-message-intents.ts`, next migration, `server/src/channels/attachments.ts`, `server/src/scripts/cull-staged-attachments.ts`, conversation reconciler/service/tests | Safe attachment reservation/culling contract | populated PostgreSQL `EXPLAIN`; held-attachment concurrency test; candidate-throw isolation; populated workspace deletion test per selected policy | pending |
| R6 | Mastra lifecycle: stranded provisioning claims; plaintext password SQL; pool close rejection leaks map; stale rotation cache; broken factory history; legacy history full scan/cursor; compatibility probe metadata/timeout/evidence gaps. Acceptance: claims recover safely, secret absent from SQL text, pools close under partial failure, history path is bounded where contract allows, probe verifies observations. | R3, R4 | backend_implementer / backend_validator / reviewer | `server/src/mastra/{provisioning,tenant-storage,conversations,compatibility}.ts`, tests, operational recovery docs | Recoverable tenant storage lifecycle and reliable compatibility gate | interruption/recovery integration; query capture; partial close failure; rotation test; long history test; hung probe timeout test | pending |
| R7 | Remaining accepted operational/invariant findings: outbox publish diagnostics; tenant/outbox/budget lookup indexes; resource workspace deletion contract; culler maintenance role; IPv6 test URL; error cause preservation; final low-cost documentation needed for role/legacy exceptions. Acceptance: observability and access contract explicit, indexes justified by plans, no unsupported behavior changes. | R1, R2, R3, R5, R6 | backend_implementer / backend_validator / reviewer | exact files assigned after inventory reconciliation in R7 brief; never broad format/rewrite | Operationally diagnosable outbox and documented residual policies | outbox failure test; representative query plans; role visibility test; IPv6 unit test; full affected suites | pending |

### DAG validation

- IDs R0–R7 are unique; dependencies all exist; no self-edges.
- Topological order is `R0 → R1 → R2 → {R3,R4} → R5 → R6 → R7`; execution remains serial in that order.
- No source finding is duplicated across task acceptance. Cross-slice duplicates are assigned once: `0062 attachment_id` is R5; storage enum is R4; role replication/public grants are R1; Run/budget scope is R3; Plan credential/redaction is R0; Mastra provisioning/pool/history is R6.
- Conditional findings remain gated by task-specific evidence: actual PostgreSQL role behavior, attachment retention contract, deletion contract, credential rotation caller, and supported timeout policy. No migration cascade, force-RLS, or cost-release semantics are inferred from OCR alone.
- R0 is running under the user's fail-closed contract decision. R1–R7 remain pending; release each successor only after the preceding checkpoint is validated and independently reviewed.

## Task 1: Enforce the runtime stream boundary (R0)

**Depends on:** user answer to the open stream discriminator policy. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Consumes / produces:** consumes the selected API key and Plan token set and the provider's untrusted runtime stream; produces only primitive-string, credential-free protocol discriminators or a generic fail-closed result with cancellation and one unknown settlement.

- [ ] Add RED cases for object-valued `type`, selected-token primitive `type`, and a valid ordinary protocol type; assert invalid cases emit no part, cancel the reader, mark unknown once, never confirm, and expose no raw token.
- [ ] Run the focused test and record the expected failures against the frozen R16-Fix3 hashes.
- [ ] Apply the user-approved boundary rule before discriminator dispatch and before any usage settlement; keep public error generic.
- [ ] Run model, integration, model-gateway, and computer-gateway suites plus Biome and diff-check; record exact hashes.
- [ ] Independent validator and reviewer must both pass before R1 becomes ready.

## Task 2: Harden database role and migration deployment preconditions (R1)

**Depends on:** R0. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `server/ops/enterprise/roles.sql`, `server/src/enterprise/tenancy/connections.ts`, the deployment instructions named by the task brief, role tests.

**Consumes / produces:** consumes capability-role naming and runtime verification contract; produces a single auditable role safety predicate covering superuser, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION, protected ownership, enterprise relation/column grants to login and PUBLIC, and the explicit operator privilege required by `pg_authid` checks.

- [ ] Add PostgreSQL integration cases for an existing REPLICATION role and an enterprise relation granted to PUBLIC; both must be rejected before runtime use.
- [ ] Add bootstrap tests for missing capability roles and setup failure; establish the supported deployment identity and ensure a failed role setup cannot leave partial committed state.
- [ ] Align role creation and runtime checks, explicitly set `NOREPLICATION`, include PUBLIC only for enterprise object privileges, and keep ordinary `public` schema USAGE allowed.
- [ ] Run fresh deployment role setup, runtime capability verification, enterprise tenancy tests, and Biome; record SQL identity, command output, and hashes.
- [ ] Independent backend validation and review; do not alter legacy table RLS or FORCE RLS without a separate test-backed contract.

## Task 3: Repair forward-only schema invariants and journal metadata (R2)

**Depends on:** R1. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** migration journal/metadata; `server/src/db/schema/enterprise-runs.ts`, `server/src/db/schema/mastra-message-intents.ts`; owned schema/migration tests.

**Consumes / produces:** consumes the verified current journal sequence and role precondition; produces a positive explicit Run ceiling with no DB default, correctly serialized `attachment_ids` JSONB, valid reservation totals, and an unbroken 0055→0056 snapshot chain.

- [ ] Add failing direct-SQL tests for omitted/zero Run ceiling, `confirmed_tokens > token_limit`, and a Bun insert whose `jsonb_typeof(attachment_ids)` must be `array`.
- [ ] Inspect production migration runner and current DB state; record exact next migration number, counts of legacy zero/invalid rows, and whether 0055 is already applied in supported deployments.
- [ ] Write a forward migration for constraints only after measuring affected legacy rows; do not rewrite historical SQL or claim invalid-row absence without querying a representative DB.
- [ ] Correct only the generated snapshot `prevId` link proven broken; regenerate metadata using the locked Drizzle tool and run `drizzle-kit check`.
- [ ] Run fresh-database and upgrade-path tests, direct constraint tests, affected integration suites, Biome, and diff-check; reviewer/validator gate exact hash.

## Task 4: Close cross-scope budget and lease paths (R3)

**Depends on:** R2. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `server/src/enterprise/models/budget.ts`, `server/src/enterprise/runs/model-capability.ts`, `server/src/enterprise/runs/store.ts`, `server/src/enterprise/models/gateway.ts`, corresponding tests.

**Consumes / produces:** consumes `PlatformScope={tenantId,workspaceId,principalId}`, the canonical `run-ceiling:<runId>` key, and capability status machine; produces scope-checked idempotency lookup/confirm/release/currentAttempt/expireLease and monotonic dispatched usage settlement.

- [ ] Add RED integration cases: same-tenant other workspace/principal cannot retrieve reservation by known idempotency key, confirm, release, or rotate lease; unknown→confirmed and custom Run ceiling keys fail.
- [ ] Add RED cases for configured maximum overflow, expired undispatched reservation handling, gateway confirm rejection→unknown once, and a healthy synthetic stream exceeding the old fixed timeout.
- [ ] Add tenant/workspace/principal predicates to reads and writes, centralize the Run ceiling key, restrict ordinary confirm to valid success states, and only reclaim proven undispatched `reserved` state.
- [ ] Separate connection/first-byte deadline from total stream policy using an explicit configured contract; preserve unknown/consumed charge after dispatch and never free confirmed spend on expiry.
- [ ] Run budget, capability, Run, model-gateway tests plus DB adversarial scope tests, Biome, and diff-check; independent validator/reviewer gates.

## Task 5: Align wire schemas and retry-safe conversation behavior (R4)

**Depends on:** R2. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `shared/enterprise/contracts.ts`, `server/src/enterprise/wire-schema.ts`, conversation routes/service, Mastra conversation factory and their tests.

**Consumes / produces:** consumes persisted `StorageBackend` and scheduled runtime invocation contract; produces Zod and generated JSON Schema acceptance parity, retryable typed write/storage failures, and Mastra history from the public factory.

- [ ] Add cross-validator tests proving `mastra` conversation DTO accepted by both schemas and a scheduled invocation without delegation rejected by both schemas.
- [ ] Add HTTP tests for same-key pending write and storage unavailable as safe 503; legacy append/read-only as a stable safe 4xx; duplicate attachment IDs rejected before any intent/sequence/attachment mutation.
- [ ] Inject sequence lookup into the public Mastra conversation factory and test nonempty finalized history with user/assistant/tool role behavior; storage read failure remains retryable and distinct from immutable metadata mismatch.
- [ ] Update Zod and portable JSON Schema together, split legacy read-only from unavailable Mastra history error codes, and add typed status mapping without exposing cause objects.
- [ ] Run shared schema vectors, conversation and route integration suites, Biome, and diff-check; independent validator/reviewer gates.

## Task 6: Make attachment reservation and reconciliation bounded (R5)

**Depends on:** R2 and R4. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `server/src/db/schema/mastra-message-intents.ts`, new forward migration, `server/src/channels/attachments.ts`, `server/scripts/cull-staged-attachments.ts`, reconciler/service and integration tests.

**Consumes / produces:** consumes the shared ordered lock-key and pending-intent contract; produces indexed attachment reservation probes, isolated candidate reconciliation, and documented retention/deletion semantics.

- [ ] Add a populated-table plan test showing attachment withdrawal and FK probes use an `attachment_id`-leading index.
- [ ] Add RED tests where one reconciler candidate throws and a later candidate still reaches its safe terminal outcome; held attachment withdrawal and cull race must never delete referenced bytes or fail with avoidable 23503.
- [ ] Measure/define storage operations that occur under DB locks and prove a stalled external read cannot hold correctness locks unbounded; preserve atomic append/finalize ordering.
- [ ] Before coding retention or workspace delete behavior, use the existing approved contract and actual call sites to decide quarantine/expiry and deletion policy; if neither specifies it, preserve NO ACTION, record parked ruling, and do not invent cascade/TTL behavior.
- [ ] Run Postgres integration with maintenance identity and RLS, concurrency tests, representative `EXPLAIN`, attachment/conversation suites, Biome, and diff-check; independent validator/reviewer gates.

## Task 7: Repair Mastra storage and provisioning lifecycle (R6)

**Depends on:** R3 and R4. **Roles:** backend_implementer → backend_validator → reviewer.

**Files:** `server/src/mastra/{provisioning,tenant-storage,conversations,compatibility}.ts`, `shared/runtime-compatibility.ts`, focused tests/docs.

**Consumes / produces:** consumes tenant claim token, storage key/role-version and conversation repository contracts; produces recoverable provisioning, safe credential DDL, complete pool cleanup, explicit rotation fencing, and bounded compatibility evidence.

- [ ] Add RED tests for interruption after claim and after credential write; rejected pool close with all other pools still cleared; stale roleVersion rotation; absent Mastra history factory; long legacy history; compatibility bridge hang and missing package metadata.
- [ ] Implement claim recovery using an operator-safe token/artifact procedure or fenced reclaim without exposing credentials; capture DDL and assert generated cleartext password is absent.
- [ ] Make close aggregate failures while always clearing/closing all entries; define rotation swap/drain behavior without deleting active pools.
- [ ] Bound compatibility probe operations, close once in `finally`, and distinguish literal planned/static metadata from observed adapter events; add the module to targeted typecheck.
- [ ] Run lifecycle/provisioning/conversation/compatibility tests and affected typecheck, Biome, diff-check; independent validator/reviewer gates.

## Task 8: Close residual accepted operational findings (R7)

**Depends on:** R1–R6. **Roles:** backend_implementer → backend_validator → reviewer. Exact owned file set is frozen in R7 brief after rechecking current state; no broad refactor.

- [ ] Add safe outbox publish failure diagnostics keyed by event ID/type/attempt and never log payloads or credentials; test retry remains possible.
- [ ] Add only indexes supported by measured query plans: tenant/run budget reservation, tenant/pending/created outbox selection, relevant run FK lookups. Preserve existing useful indexes and compare representative plans.
- [ ] Fix the IPv6 loopback URL host normalization and preserve safe underlying causes in capability/test DB diagnostics.
- [ ] Record accepted low-risk policies: legacy table grants without RLS, offline identity operator boundary, maintenance visibility, resource/workspace delete semantics, and deferred pending-intent expiry if evidence is insufficient.
- [ ] Run complete affected server tests, typecheck, Biome, migration checks and diff-check; independent validator/reviewer gates.

## Final acceptance

- R0–R7 are verified with hash-bound implementation checkpoints, targeted validation, and independent Spec compliance + code quality review.
- Each of the 139 OCR comments and additional security observations has a valid/invalid/conditional ruling in the four adjudications; every valid high/medium item is fixed or has an explicit evidence-backed parked policy.
- All code-level tests, affected typechecks/lint/build, fresh and upgrade migration tests pass at the exact reviewed checkpoint.
- Full OCR covers original BASE through final HEAD plus all owned workspace edits; no valid critical/high/medium finding remains.
- Final workspace contains only authorized Mastra migration and OCR-repair deliverables; no commit, stash, reset, push, merge, or release is performed.
