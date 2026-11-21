# OpenObserve integration implementation plan

This plan turns [ADR 0009](adr/0009-openobserve-as-platform-observability-copy.md) and the [platform runbook](openobserve-runbook.md) into an OpenBot-side implementation. It covers the OpenBot contract and verification. The Collector, OpenObserve installation, authentication boundary, storage, backup, and retention setup remain deployment work.

## Outcome

OpenBot can emit an allowlisted audit replica and structured service diagnostics to an external OTLP logs endpoint. The integration is disabled when no endpoint is configured, remains non-blocking when the endpoint is unavailable, and carries enough deployment and run correlation metadata for platform administrators to search the two OpenObserve streams.

The implementation must preserve these authorities.

- PostgreSQL `audit_events` remains the audit source of truth.
- Activity pages and their product ledgers remain the product activity source of truth.
- Opik remains the Agent trace source of truth when the future integration is present.
- OpenObserve receives derived query records only.

## Phase 1. Establish the projection contract

### Change surfaces

- `server/src/audit.ts`
- `server/src/telemetry/otel.ts`
- `server/src/telemetry/product.ts`
- `server/src/telemetry/product-boundaries.ts`
- New focused projection module under `server/src/telemetry/`
- Existing `server/tests/otel-export-scrubbing.test.ts`
- New projection unit tests under `server/tests/`

### Work

1. Extend the audit tap context with optional `parentRunId`, `rootTaskId`, and `attemptId` where the current run context can provide them. Keep every field optional and do not add guessed values.
2. Define two explicit output types for `openbot_runtime` and `openbot_audit` records.
3. Add common envelope fields for `deployment_id`, `schema_version`, `source`, `canonical_source`, `data_class`, and `projection_status`.
4. Replace the generic OTLP `payload.*` export with an audit projection. Keep only common audit fields and approved event facets.
5. Include `audit_event_id` from the persisted audit row. Use it as the stable duplicate-detection key.
6. Add `run_id`, `parent_run_id`, `root_task_id`, `attempt_id`, and `thread_id` only when the input validates as a bounded identifier.
7. Keep `routine_run_id`, `responsibility_run_id`, and `work_item_key` separate from Bot run identifiers.
8. Add `projection_status=unknown` for event types without a dedicated facet projection. Drop unknown payload fields.
9. Add `projection_status=failed` when a known projection cannot safely produce its facets. Keep public fields, drop all uncertain payload data, and emit a runtime diagnostic.
10. Require an explicit `DEPLOYMENT_ID` for the OpenObserve projection when export is enabled. Preserve existing fallback behavior for unrelated product features unless the implementation proves the global config contract should change separately.
11. Start both stream contracts at `schema_version=1` and keep the versions independent.

### Exit checks

- Pure projection tests cover every field and every dropped field.
- Existing audit writes and existing product telemetry tests remain green.
- The exporter sends no generic payload JSON.
- Missing deployment ID disables the external projection or fails the explicit export configuration check without blocking unrelated business behavior.

## Phase 2. Define structured runtime diagnostics

### Change surfaces

- New `server/src/telemetry/runtime-log.ts` or equivalent focused module
- `server/src/index.ts`
- `worker/src/index.ts`
- `server/scripts/migrate.ts`
- `server/scripts/fire-routines.ts`
- `server/scripts/cull-idle-computers.ts`
- `server/scripts/cull-staged-attachments.ts`
- `server/src/audit-retention.ts`
- High-value server modules that currently emit operational diagnostics
- New runtime projection tests under `server/tests/`

### Work

1. Define a structured diagnostic writer with fixed severity, component, event category, outcome, error category, duration, deployment, version, and optional run fields.
2. Bound technical diagnostic text. Do not accept request objects, exception objects, arbitrary payloads, user messages, prompts, tool arguments, tool results, file content, credentials, or authorization headers as diagnostic values.
3. Migrate entrypoint, worker, migration, retention, routine, and other high-value operational messages first.
4. Mark remaining unmigrated lines as `legacy_unstructured` at the collection boundary with a size limit and an explicit migration signal. Do not serialize arbitrary arguments into the line.
5. Keep local `.logs` behavior and normal stdout/stderr behavior working for deployments that do not enable export.
6. Do not add a new application dependency for a full logging framework in this phase.

### Exit checks

- Runtime records have the fixed envelope and route to the runtime stream.
- Sensitive-value fixtures cannot reach the Collector input through the structured writer.
- Legacy records are bounded and visibly marked for migration.
- Server and worker startup still work with no OTLP endpoint.

## Phase 3. Make export configuration and deployment integration explicit

### Change surfaces

- `server/src/config.ts`
- `server/src/admin/controls.ts`
- `server/src/admin/routes.ts`
- `server/src/telemetry/otel.ts`
- `charts/openbot/values.yaml`
- `charts/openbot/templates/_helpers.tpl`
- `charts/openbot/README.md`
- `docs/configuration.md`
- `.env.example`
- `docs/openobserve-runbook.md`

### Work

1. Preserve endpoint-based opt-in and `OPENBOT_OTEL_EXPORT=off` pause behavior.
2. Add a single deployment-level external OpenObserve URL setting for the administrator navigation entry. Keep it separate from the OTLP ingestion endpoint.
3. Pass `DEPLOYMENT_ID` into the export projection explicitly.
4. Document the two stream names, independent schema versions, required headers, and expected Collector boundary.
5. Keep ingestion credentials in Helm Secrets or external Secret references. Do not expose them through the application API or admin UI.
6. Add the external link to the administrator audit area only if the existing admin route has a safe deployment-configured URL. Do not change Activity pages or add a global query API.
7. Leave Compose without a bundled OpenObserve service. Document environment-based endpoint configuration only.
8. Keep the Helm chart responsible for OpenBot configuration and network egress, not OpenObserve storage or authentication.

### Exit checks

- Helm renders endpoint, headers, service name, deployment ID, pause switch, and external URL correctly.
- Compose and host startup remain valid with the feature absent.
- The admin status surface distinguishes unconfigured export from configured-but-unavailable export.
- No user-facing role receives a query capability.

## Phase 4. Verify non-blocking delivery and privacy

### Test surfaces

- `server/tests/otel-export-scrubbing.test.ts`
- New `server/tests/observability-projection.test.ts`
- New `server/tests/observability-failure.test.ts`
- Existing `server/tests/audit.test.ts`
- Existing audit integration suites
- Helm template tests or render checks used by the repository
- Documentation and configuration checks

### Required cases

1. No endpoint returns no exporter and business code still runs.
2. `OPENBOT_OTEL_EXPORT=off` pauses export without changing audit writes.
3. Missing `DEPLOYMENT_ID` cannot create an unscoped external record.
4. PostgreSQL insert success is preserved when exporter delivery throws.
5. Exporter shutdown and retry failure remain non-blocking.
6. Duplicate delivery carries the same `audit_event_id`.
7. Unknown audit event types preserve common fields and drop unknown payload data.
8. Known projection failure preserves safe common fields and marks the failure.
9. Nested values named `token`, `password`, `authorization`, `prompt`, `content`, `tool_arguments`, and `tool_result` never reach the outgoing event.
10. Values containing user content under non-sensitive keys are excluded by the allowlist.
11. Runtime diagnostics reject or drop arbitrary request, response, exception, and credential objects.
12. Run correlation fields appear only when present and valid.
13. Activity, PostgreSQL audit reads, and existing product telemetry retain their current behavior.
14. Two deployment IDs remain distinguishable in the emitted records.
15. Runtime and audit records carry independent schema versions and data classes.

## Phase 5. Deployment handoff

The deployment team owns the external platform steps.

1. Deploy an OpenTelemetry Collector and configure the two pipelines.
2. Create `openbot_runtime` with 30-day retention.
3. Create `openbot_audit` with 90-day retention.
4. Configure OIDC access or Enterprise SSO for the platform administrator group.
5. Store ingestion credentials in the Collector Secret or external Secret manager.
6. Configure the Collector and OpenObserve URL in the OpenBot deployment.
7. Validate stream writes, retention, duplicate handling, and the source-of-truth links.
8. Stop the Collector and verify business continuity.
9. Record the OpenObserve URL and the deployment ID in the deployment handoff.

## Verification commands

The implementation should finish with the repository's normal checks.

```sh
bun run --filter server typecheck
bun test server/tests/otel-export-scrubbing.test.ts server/tests/observability-projection.test.ts server/tests/observability-failure.test.ts
bun run lint
bun run format:check
```

Run the broader server audit suites when the projection changes touch `server/src/audit.ts` or the audit tap contract.

## Rollback

Disable the OTLP endpoint or set `OPENBOT_OTEL_EXPORT=off`. This stops derived export while PostgreSQL audit, Activity, Bot runs, and product behavior continue. Reverting the projection code must not require a database migration because the design does not add audit columns or move authority into OpenObserve.
