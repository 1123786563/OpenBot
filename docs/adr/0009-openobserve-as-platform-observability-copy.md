# Use self-hosted OpenObserve as the platform observability copy

Platform administrators need one place to search OpenBot service operation and business audit activity. OpenBot already has several records with different owners. Server processes write runtime logs to stdout and stderr. PostgreSQL stores the append-only audit trail. Activity pages read product ledgers and audit data for user-facing workflows. The planned Opik service owns Agent tracing, feedback, and evaluations.

A query platform must not become a second product authority. It must also avoid receiving user content, credentials, or arbitrary payloads merely because an event happened to contain them.

## Decision

OpenBot deployments may connect to a separately operated, self-hosted OpenObserve installation. OpenObserve is a platform-administrator-only query surface for two derived data streams:

- **Service runtime logs** cover OpenBot API, worker, migration, retention, routine, and other server-side workload processes. They are retained for 30 days.
- **Audit replicas** cover a query-oriented projection of every PostgreSQL audit event. They are retained for 90 days.

The OpenBot Helm chart and deployment documentation configure the connection to an external OpenObserve or OpenTelemetry Collector endpoint. OpenBot does not bundle OpenObserve as a release subchart, own its storage, or manage its authentication proxy.

## Authority and boundaries

PostgreSQL `audit_events` remains the authoritative audit record. The `/api/admin/audit-events` route, `/admin/audit`, and the personal Activity audit surface continue to read the product audit contract. The Bot profile Activity surface continues to read its existing routine, responsibility, work-item, approval, and channel ledgers.

Opik remains the authority for Agent execution traces, feedback, and evaluations when that service is present. OpenObserve may carry `run_id` and related identifiers that help an administrator locate the same execution in Opik. OpenObserve does not create Agent traces, replace Activity, or replace PostgreSQL audit reads.

OpenObserve records identify their source and canonical source explicitly. A platform administrator can use OpenObserve to find an event and then return to the source system that owns its meaning.

## Collection and delivery

A deployment-level OpenTelemetry Collector is the recommended collection boundary.

- OpenBot sends the audit projection through the existing post-insert OTLP audit tap.
- The deployment collects stdout and stderr from OpenBot server-side workloads.
- The Collector routes service runtime logs and audit replicas to separate OpenObserve streams.

The OpenBot exporter is disabled when no endpoint is configured. Once configured, delivery is asynchronous and best effort. PostgreSQL audit insertion, Activity writes, Run execution, and model or tool calls do not wait for OpenObserve or the Collector. Collector outages and OpenObserve outages may lose derived copies after bounded retry capacity is exhausted. The failure is surfaced through service runtime logs and platform operational signals.

OpenBot sends no historical backfill by default. It sends only records created after the integration is enabled. Retried audit delivery may produce duplicates, so every audit replica carries the PostgreSQL audit event ID as its stable deduplication key.

## Data contract

The two streams use separate schemas, retention policies, and query views. OpenBot sends only an allowlisted projection.

A service runtime log contains the timestamp, severity, service, component, deployment, version, event category, outcome, error category, duration where available, optional run correlation, and a bounded technical diagnostic field. It does not contain user messages, prompts, tool arguments, tool results, file contents, request bodies, or credentials. Arbitrary raw `console` text is not an accepted data contract.

An audit replica contains common fields for the audit event ID, event time, event type, target, actor, initiator, surface, outcome, deployment, optional run correlation, schema version, and canonical source. It may include fixed event facets such as policy rule, app key, tool name, effect, reason code, and duration. It does not include arbitrary payload fields.

Run correlation is optional. When the execution context provides them, OpenBot may emit `run_id`, `parent_run_id`, `root_task_id`, `attempt_id`, and `thread_id`. Routine, responsibility, and work-item identifiers remain separate fields when those are the only available identifiers. OpenBot does not convert Activity display IDs, PostgreSQL audit UUIDs, and future Opik trace IDs into one synthetic identifier.

A new audit event type without a dedicated projection still emits the common fields with `projection_status=unknown`. Its unknown payload is dropped and the projection gap is observable. An unknown event is never silently omitted and never forwarded as arbitrary JSON.

## Access and retention

OpenObserve is accessed only by platform administrators. Authentication is supplied by the deployment's infrastructure, such as an OIDC-capable reverse proxy, identity gateway, or an OpenObserve Enterprise SSO integration. OpenBot application sessions are not exchanged for OpenObserve sessions, and OpenBot does not expose a global OpenObserve query proxy to workspace roles.

OpenObserve write credentials belong to the Collector or its external secret manager. Query credentials are separate. Service runtime logs use a 30-day retention policy, and audit replicas use a 90-day retention policy. These policies apply to the OpenObserve copies and do not alter PostgreSQL audit retention, Activity data, or Opik retention.

## Deployment scope and rollout

A single OpenObserve installation may receive copies from multiple OpenBot deployments. Every record carries the existing explicit `DEPLOYMENT_ID`, and platform queries must scope by deployment before inspecting events. A deployment may also operate its own OpenObserve instance.

The default logical stream names are `openbot_runtime` and `openbot_audit`. A deployment may choose different physical names, but its Collector and runbook must preserve the two-data-class distinction. Both streams begin at `schema_version=1` and evolve independently.

OpenObserve retention is independent of PostgreSQL audit retention. Removing an old PostgreSQL row does not immediately remove its derived copy. The runtime and audit streams enforce their own 30-day and 90-day policies.

The OpenObserve copy does not promise a global order or exactly-once delivery. Batching, retry, and multiple Collector instances may produce duplicates or small ordering differences. Queries use event time, stable event IDs, deployment identifiers, and source fields. PostgreSQL remains responsible for transaction order.

OpenBot emits only existing run correlation fields. It does not generate synthetic trace or span IDs and does not claim an Opik relationship until a real Opik integration supplies one.

The OpenBot administrator experience may expose one configured external OpenObserve URL. The link does not embed or proxy OpenObserve, does not add query syntax, and does not change Activity pages. A deployment without a Collector or OpenObserve remains a valid deployment state. Export is disabled until an endpoint is explicitly configured.

The implementation is delivered in two stages. OpenBot first owns the projection, structured diagnostics, schema version, OTLP configuration, deployment documentation, and automated privacy and failure tests. The deployment then owns the Collector, OpenObserve installation, authentication boundary, stream configuration, retention, credentials, backup, and upgrade operations.

The deployment procedure and source-of-truth table live in the [OpenObserve platform observability runbook](../openobserve-runbook.md).

## Verification

The integration is accepted only when all of the following hold:

- OpenObserve and the Collector can be unavailable without blocking ordinary business requests.
- A successful PostgreSQL audit insert remains present when derived delivery fails.
- Repeated delivery can be identified by `audit_event_id`.
- No user content, prompts, tool arguments, tool results, file content, authorization headers, tokens, passwords, or nested sensitive values reach the Collector input.
- API, worker, migration, retention, routine, and other included server-side workload logs reach the runtime stream with the fixed diagnostic contract.
- Audit events reach the audit stream with common fields and approved facets.
- Unknown audit events preserve common fields, drop unknown payload data, and produce a projection signal.
- The two streams enforce 30-day and 90-day retention independently.
- A platform administrator can follow a `run_id` from OpenObserve to the applicable OpenBot or Opik source when that source contains the same identifier.
- Activity pages, PostgreSQL audit reads, and Opik queries retain their existing behavior and authority.
- OpenBot exposes no global OpenObserve query API and stores no OpenObserve data in PostgreSQL.
- The implementation can be delivered in the two stages described above, with the OpenBot stage independently testable before a deployment enables the external platform.
