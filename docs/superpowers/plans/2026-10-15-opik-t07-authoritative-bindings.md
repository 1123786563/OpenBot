# OpenBot issue #13 / DAG T07: authoritative observation bindings

> **For agentic workers:** Execute through Orca Superpowers SDD. The implementation and reviewer are separate Claude workers. The coordinator integrates only reviewed, validated checkpoint contents.

**Goal:** Persist OpenBot's authoritative ownership, scope, locator and durable state needed to correlate Opik data without copying business content into the local database.

**Architecture:** Extend the existing T06 trusted workbench scope. A binding is unique by scope plus stable run/attempt reference, commits idempotently, stores separate OTel and Opik identifiers and an opaque upstream locator reference, and carries deletion/expiry state. Current Bot authorization remains authoritative; Opik metadata cannot assign ownership.

**Sources:** Approved parent Spec A1/A5/A6/A11/A12; Issue #13 acceptance; T06 handoff and shared interface contract in `docs/plans/2026-10-14-opik-integration-plan.md`; issue snapshot and DAG; relevant ADRs 0002–0004; current schema journal at task dispatch time.

## Global Constraints

- Do not store raw prompts, outputs, tool arguments, credentials, account email, raw attachment URLs or tenant records in binding tables.
- Unknown enterprise scope rejects. Do not add an enterprise adapter, fake tenant, implicit header, or treat Opik project/workspace as authorization.
- A PostgreSQL integration test must use an explicitly isolated test DB; refuse to fall back to the application database.
- Database migrations are serialized: use the latest journal index at dispatch and do not overwrite another ticket's migration or snapshot.
- No commit, push, merge, publish or shared stash. Reviewer gets read-only files and a content-hash bound package.

## Review Focus

- Concurrent begin for the same scope/run/attempt creates exactly one binding and stable result.
- Same run ID under different scopes remains isolated by every unique key and query.
- Partial upstream success plus lost local acknowledgment can reconcile without duplicate binding.
- Bot ownership changes and deleted/system-owned resources follow current permission checks.
- Migration, schema export, journal and snapshot agree; rollback does not drop unrelated state.

## File ownership and interfaces

Owned files: `server/src/db/schema/ai-observability-bindings.ts`, `server/src/ai-observability/bindings.ts`, `server/src/db/schema/index.ts` (one export block only), `server/drizzle.config.ts` (one schema-list entry for the new schema; exclusive T07 ownership per coordinator R-06), one new migration and matching snapshot/journal entry using the latest index at dispatch, `server/tests/opik-bindings.test.ts`, `server/tests/opik-bindings.integration.test.ts`, `server/tests/support/opik-test-db.ts`, and the ticket checkpoint/report. Consume only T06 `ObservationScope` and the published Issue #13 handoff. Issue #13 is formally blocked only by #12; it does not consume T04/#10 `VerifiedOpikContract`, so do not introduce that as a new prerequisite or persist upstream-contract fields. Do not modify T06. Produce binding begin/reconcile/get APIs with database constraints as the idempotency authority. The concrete owned files and one migration are listed in the current Issue #4 DAG; coordinate any scope expansion before editing.

## Steps

- [ ] Inspect the current Drizzle schemas, migration journal/snapshot, test DB helper, and the integrated T06 contracts. Record the latest migration index and confirm no concurrent migration writer before editing.
- [ ] RED: Add unit and PostgreSQL integration cases for same-scope idempotency, cross-scope same-ID isolation, concurrent begin, retry after upstream success/local timeout, forbidden raw data fields, forged metadata, missing owner, and current ownership revocation. Confirm RED against the existing code.
- [ ] GREEN: Add only safe identity, status, locator and version references; enforce scope/run/attempt uniqueness and indexes in PostgreSQL. Make begin transactional and return the original binding for a replay.
- [ ] Implement reconciliation by authoritative local binding key and explicit upstream identifier; never use Opik metadata as an owner source.
- [ ] Add the schema path to the owned `server/drizzle.config.ts` schema list, then create migration and schema artifacts with the repository's migration generator/format; verify index, snapshot and journal are consistent and migration up/down is isolated.
- [ ] Run unit tests, test-database integration tests, migration journal tests, server typecheck and locked Biome on owned files. Missing test DB is a failure, not a skip.
- [ ] Save exact DB fixture setup/teardown, commands, result counts, exit codes, HEAD/diffs, full untracked files and SHA256 manifest. Send worker_done only after the data-leak and scope-isolation self-check.

## Failure handling

Stop if the reviewed T06 interface is not integrated and verified. Issue #13 has no formal dependency on #10/T04. If migration numbering has moved, recalculate before writing. Any needed shared contract edit requires an Orca question and coordinator ownership ruling before code changes.
