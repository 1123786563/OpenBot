# OpenObserve platform observability runbook

This runbook is for platform administrators operating an OpenBot deployment with a self-hosted OpenObserve query platform. OpenObserve is a derived query surface. PostgreSQL audit records, OpenBot Activity records, and Opik traces remain the canonical sources for their own domains.

The [external platform handoff](openobserve-platform-handoff.md) provides the Collector configuration and deployment acceptance procedure.

## Components

The deployment contains four separate responsibilities.

- OpenBot produces the allowlisted audit projection and structured service diagnostics.
- An OpenTelemetry Collector receives the audit projection and collects OpenBot server-side workload logs.
- OpenObserve stores two independent streams. The default names are `openbot_runtime` and `openbot_audit`.
- An infrastructure identity gateway or OpenObserve Enterprise SSO protects the query interface for platform administrators.

The Collector and OpenObserve are outside the OpenBot release lifecycle. OpenBot does not own their storage, backups, authentication proxy, or upgrades.

## Required deployment identity

Set the existing `DEPLOYMENT_ID` to a stable identifier for the OpenBot deployment. Use a different value for every deployment that shares an OpenObserve installation. Do not derive it from a public URL, workspace, person, or Bot.

Every runtime log and audit replica must carry this value. A query that spans multiple deployments must filter by `deployment_id` before inspecting event details.

## OpenBot configuration

Set `config.deploymentId` and an OTLP destination under `config.otel`. With `endpoint`, the API
appends `/v1/logs`. With `logsEndpoint`, the API uses that URL as written and gives it precedence.

```yaml
config:
  deploymentId: production-east
  otel:
    endpoint: https://otel-collector.example.internal:4318
    serviceName: openbot
    paused: false

# Example for a Collector in another namespace. Match the labels and port of your Collector.
networkPolicy:
  enabled: true
  extraEgress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: observability
          podSelector:
            matchLabels:
              app: otel-collector
      ports:
        - protocol: TCP
          port: 4318
```

Supply headers as comma-separated `key=value` pairs in `secrets.otelLogsHeaders` or
`secrets.otelHeaders`. To use a Secret managed outside the chart, set `secrets.existingSecret` and
provide the `otel-logs-headers` or `otel-headers` key. With External Secrets Operator, map those same
keys through `externalSecrets.data`. Leave the logs headers unset to use the generic headers.

For Compose and host startup, set `DEPLOYMENT_ID`, `OTEL_SERVICE_NAME`, and one of
`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. Inject
`OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_LOGS_HEADERS` into the API process from your
deployment's secret store. Compose and `scripts/start.sh` also accept the settings from the root
`.env`. Keep files that contain credentials private. For Compose, use an endpoint reachable from
the API container.

Set `config.otel.paused: true` in Helm or `OPENBOT_OTEL_EXPORT=off` in the deployment environment
to pause OTLP audit export. Audit export is also off when neither endpoint is configured. PostgreSQL
audit writes continue during a pause. When export resumes, it sends new records. To pause delivery
of runtime logs to OpenObserve, pause the Collector's runtime pipeline.

## Collector contract

The Collector must provide two pipelines.

### Runtime pipeline

Collect stdout and stderr from OpenBot API, worker, migration, retention, routine, and other included server-side workloads. Normalize records into the runtime schema and route them to `openbot_runtime`. Drop raw request bodies, user messages, prompts, tool arguments, tool results, file contents, credentials, authorization headers, and arbitrary serialized objects.

A legacy line that cannot yet be migrated to a structured event is marked `legacy_unstructured`, bounded, and treated as a migration signal. It is not permission to forward arbitrary objects or unbounded text.

### Audit pipeline

Receive OTLP audit records after their PostgreSQL insert succeeds. Route them to `openbot_audit`. Keep the stable `audit_event_id` and the required `deployment_id`. Preserve common audit fields and approved facets only. Unknown event types keep common fields with `projection_status=unknown` and drop unknown payload data.

The Collector may retry and batch records. Queries must tolerate duplicates and small ordering differences. `audit_event_id` is the deduplication key.

## Stream policies

Configure the streams independently.

| Stream | Contents | Retention | Canonical source |
| --- | --- | --- | --- |
| `openbot_runtime` | OpenBot server-side diagnostic records | 30 days | The producing service and deployment runtime |
| `openbot_audit` | Allowlisted audit event projections | 90 days | PostgreSQL `audit_events` |

Use a stream schema with an explicit `schema_version`. Both default streams begin with `schema_version=1`. Additions must remain backward compatible. A meaning change or removal requires a new schema version and a documented compatibility window.

PostgreSQL retention is independent of the `openbot_audit` retention. A PostgreSQL sweep does not trigger an immediate OpenObserve delete.

## Access

Protect the OpenObserve query UI with an infrastructure OIDC gateway or OpenObserve Enterprise SSO. Map only the platform administrator group to the query role. Keep ingestion credentials separate from query credentials. OpenBot application sessions are not accepted as OpenObserve sessions.

One configured external OpenObserve URL may be linked from the platform administrator audit area and deployment documentation. The link carries no query syntax, must not embed the OpenObserve UI, and must not proxy query results through OpenBot.

## Failure handling

A healthy OpenBot deployment continues operating when the Collector or OpenObserve is down. PostgreSQL audit inserts, Activity writes, Bot runs, model calls, and tool calls do not wait for the derived copy.

Expect the following signals.

- `otel-export-failed` or equivalent runtime events when OpenBot cannot hand records to the configured endpoint
- Collector receive or export errors
- OpenObserve stream write failures
- A gap in the affected stream after the bounded retry capacity is exhausted

Do not treat a missing OpenObserve record as proof that the business action did not happen. Check PostgreSQL audit, Activity, or Opik according to the source-of-truth table.

## Run correlation

Use `run_id` first when it is present. Add `parent_run_id`, `root_task_id`, `attempt_id`, and `thread_id` when the execution context provides them. Keep `routine_run_id`, `responsibility_run_id`, and `work_item_key` as separate fields when they are the only available identifiers.

Do not generate synthetic `trace_id` or `span_id` values. Do not convert an Activity display ID or PostgreSQL audit UUID into a Run ID.

## Rollout checklist

1. Deploy or select the external OpenObserve instance and Collector.
2. Configure OIDC access for the platform administrator group.
3. Create `openbot_runtime` with 30-day retention.
4. Create `openbot_audit` with 90-day retention.
5. Set a unique `DEPLOYMENT_ID`.
6. Configure OTLP endpoint and ingestion headers through Secrets.
7. Verify runtime records and audit replicas in separate streams.
8. Verify `audit_event_id`, `deployment_id`, and available run correlation fields.
9. Stop the Collector and confirm business requests, PostgreSQL audit writes, Activity, and runs continue.
10. Restore the Collector and verify new records arrive without historical backfill.
11. Run the privacy fixtures and confirm no content or credentials reach the Collector input.
12. Record the OpenObserve URL and source-of-truth links in the deployment handoff.

## Source-of-truth table

| Question | Source |
| --- | --- |
| What business action was recorded? | PostgreSQL `audit_events` and `/admin/audit` |
| What did a Bot or routine show in the product? | Activity and its underlying product ledgers |
| What happened in an Agent execution or model call? | Opik, when the integration is present |
| What did the OpenBot service report while operating? | `openbot_runtime` |
| Where can related operational records be searched? | OpenObserve |

## Implementation handoff

OpenBot implementation comes first. It adds the allowlisted audit projection, structured diagnostics, optional run correlation, independent schema versions, explicit deployment identity, external URL configuration, and automated privacy and failure tests.

Deployment implementation follows. It supplies the Collector, `openbot_runtime`, `openbot_audit`, authentication boundary, retention policies, ingestion credentials, backup, and upgrade procedure.

The OpenBot phase is complete only when its tests prove that the external platform is optional, business execution is non-blocking, and the canonical sources retain their existing behavior.
