/**
 * OpenTelemetry export of the audit trail and of Bot actions, which is also the SIEM stream.
 *
 * Every row `createAuditStore` writes is emitted as an OTLP log record over HTTP, through the
 * official `@opentelemetry/sdk-logs` batch processor and `@opentelemetry/exporter-logs-otlp-http`.
 * The PostgreSQL row remains authoritative. The exported record is a bounded audit projection for
 * platform administration and carries no generic audit payload.
 *
 * Configured with the standard OpenTelemetry environment variables, read by the SDK itself:
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`. Nothing set means nothing is exported and
 * nothing is loaded. `OPENBOT_OTEL_EXPORT=off` turns it off with an endpoint still configured.
 *
 * Every record carries `openbot.surface`, the counterpart of Grok Bot's `cursor.surface=grok_bot`:
 * `bot` for something a Bot did (computer actions, tool calls, handoffs), `identity` for sign-in and
 * people, `control_plane` for everything an administrator or member configured.
 *
 * Never fatal. An unreachable collector drops records after the SDK's own retries, and the audit row
 * in PostgreSQL is still the record of truth.
 */
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import type { AuditTapEvent } from "../audit";
import {
  identifierOf,
  projectAuditEvent,
  type OpenBotAuditRecord,
  type OpenBotScalar,
} from "./observability-projection";

export type ExportedEvent = AuditTapEvent & {
  /** Overrides the surface derived from the event type. */
  surface?: string;
};

export type EventExporter = {
  emit: (event: ExportedEvent) => void;
  shutdown: () => Promise<void>;
};

const BOT_PREFIXES = [
  "computer.",
  "mcp.call",
  "mcp.tools",
  "agent.",
  "bot.declined",
  "component.function",
  "action.",
];
const IDENTITY_PREFIXES = [
  "session.",
  "person.",
  "identity_provider.",
  "scim.",
];

export function surfaceOf(eventType: string): string {
  if (BOT_PREFIXES.some((prefix) => eventType.startsWith(prefix))) return "bot";
  if (IDENTITY_PREFIXES.some((prefix) => eventType.startsWith(prefix)))
    return "identity";
  return "control_plane";
}

function severityOf(eventType: string): SeverityNumber {
  if (
    /(refused|rejected|failed|stalled|revoked|deprovisioned|break_glass)/.test(
      eventType,
    )
  ) {
    return SeverityNumber.WARN;
  }
  return SeverityNumber.INFO;
}

/** `key1=value1,key2=value2`, percent-decoded, as the OpenTelemetry specification defines it. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    headers[decodeURIComponent(pair.slice(0, index).trim())] =
      decodeURIComponent(pair.slice(index + 1).trim());
  }
  return headers;
}

export function otelConfigured(
  env: Record<string, string | undefined>,
): boolean {
  if (env.OPENBOT_OTEL_EXPORT?.trim().toLowerCase() === "off") return false;
  return Boolean(
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim(),
  );
}

function attributesOf(
  record: OpenBotAuditRecord,
  surface: string,
): Record<string, OpenBotScalar> {
  return {
    "openbot.stream": record.stream,
    "openbot.schema_version": record.schema_version,
    "openbot.source": record.source,
    "openbot.canonical_source": record.canonical_source,
    "openbot.data_class": record.data_class,
    "openbot.projection_status": record.projection_status,
    "openbot.deployment_id": record.deployment_id,
    "openbot.surface": surface,
    "openbot.event_type": record.event_type,
    "openbot.target_type": record.target_type,
    "openbot.initiator_kind": record.initiator_kind,
    ...(record.audit_event_id
      ? { "openbot.audit_event_id": record.audit_event_id }
      : {}),
    ...(record.occurred_at
      ? { "openbot.occurred_at": record.occurred_at }
      : {}),
    ...(record.target_id ? { "openbot.target_id": record.target_id } : {}),
    ...(record.actor_user_id
      ? { "openbot.actor_user_id": record.actor_user_id }
      : {}),
    ...(record.initiator_id
      ? { "openbot.initiator_id": record.initiator_id }
      : {}),
    ...(record.run_id ? { "openbot.run_id": record.run_id } : {}),
    ...(record.parent_run_id
      ? { "openbot.parent_run_id": record.parent_run_id }
      : {}),
    ...(record.root_task_id
      ? { "openbot.root_task_id": record.root_task_id }
      : {}),
    ...(record.attempt_id ? { "openbot.attempt_id": record.attempt_id } : {}),
    ...(record.thread_id ? { "openbot.thread_id": record.thread_id } : {}),
    ...Object.fromEntries(
      Object.entries(record.facets).map(([key, value]) => [
        `openbot.facet.${key}`,
        value,
      ]),
    ),
  };
}

export function createOtelEventExporter(
  env: Record<string, string | undefined> = process.env,
): EventExporter | undefined {
  if (!otelConfigured(env)) return undefined;
  const deploymentId = identifierOf(env.DEPLOYMENT_ID);
  if (!deploymentId) return undefined;

  /*
   * The endpoint and headers are read from `env` and passed explicitly, so the configuration this
   * function was given is the one used (the SDK on its own reads only `process.env`). Same rules as
   * the SDK: the logs endpoint is used as written, the generic one gets `/v1/logs` appended.
   */
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const url =
    logsEndpoint ||
    `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().replace(/\/$/, "")}/v1/logs`;
  const exporter = new OTLPLogExporter({
    url,
    headers: parseHeaders(
      env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    timeoutMillis: 10_000,
  });
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME?.trim() || "openbot",
      "openbot.deployment_id": deploymentId,
    }),
    processors: [new BatchLogRecordProcessor({ exporter })],
  });
  const logger = provider.getLogger("openbot.audit");

  return {
    emit(event) {
      try {
        const record = projectAuditEvent(event, deploymentId);
        const severity = severityOf(record.event_type);
        logger.emit({
          severityNumber:
            record.projection_status === "failed"
              ? SeverityNumber.WARN
              : severity,
          severityText:
            record.projection_status === "failed" ||
            severity === SeverityNumber.WARN
              ? "WARN"
              : "INFO",
          body: record.event_type,
          eventName: record.event_type,
          attributes: attributesOf(
            record,
            event.surface ?? surfaceOf(record.event_type),
          ),
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "otel-export-failed",
            eventType: event.eventType,
            error: String(error),
          }),
        );
      }
    },
    shutdown: () => provider.shutdown(),
  };
}
