/**
 * OpenTelemetry export of the audit trail and of Bot actions, which is also the SIEM stream.
 *
 * Every row `createAuditStore` writes is emitted as an OTLP log record over HTTP, through the
 * official `@opentelemetry/sdk-logs` batch processor and `@opentelemetry/exporter-logs-otlp-http`.
 * The PostgreSQL row remains authoritative. The exported record is a bounded audit projection for
 * platform administration and carries no generic audit payload.
 *
 * The OpenBot audit exporter reads standard OpenTelemetry environment variables:
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * and `OTEL_SERVICE_NAME`. A valid `DEPLOYMENT_ID` scopes the copy.
 * `OPENBOT_OTEL_EXPORT=off` pauses the audit client with an endpoint still configured.
 *
 * Every record carries `openbot.surface`, the counterpart of Grok Bot's `cursor.surface=grok_bot`:
 * `bot` for something a Bot did (computer actions, tool calls, handoffs), `identity` for sign-in and
 * people, `control_plane` for everything an administrator or member configured.
 *
 * Never fatal. An unreachable collector drops records after the SDK's own retries, and the audit row
 * in PostgreSQL is still the record of truth.
 */
import { validateHeaderName, validateHeaderValue } from "node:http";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import type { AuditTapEvent } from "../audit";
import {
  auditExportDiagnostic,
  identifierOf,
  type OpenBotAuditRecord,
  type OpenBotScalar,
  projectAuditEvent,
} from "./observability-projection";

export type EventExporter = {
  emit: (event: AuditTapEvent) => void;
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

type ExportConfiguration =
  | { state: "unconfigured" | "paused" | "invalid" | "invalid_deployment" }
  | {
      state: "configured";
      url: string;
      deploymentId: string;
      headers: Record<string, string>;
    };

function exportConfiguration(
  env: Record<string, string | undefined>,
): ExportConfiguration {
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
  const generalEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (env.OPENBOT_OTEL_EXPORT?.trim().toLowerCase() === "off")
    return { state: "paused" };
  const endpoint = logsEndpoint || generalEndpoint;
  if (!endpoint) return { state: "unconfigured" };
  const deploymentId = identifierOf(env.DEPLOYMENT_ID);
  if (!deploymentId) return { state: "invalid_deployment" };
  const url = URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    return { state: "invalid" };
  }
  if (!logsEndpoint)
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/logs`;
  try {
    const headers = parseHeaders(
      env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
    );
    for (const [name, value] of Object.entries(headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
    return { state: "configured", url: url.href, deploymentId, headers };
  } catch {
    return { state: "invalid" };
  }
}

export function otelConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return exportConfiguration(env).state === "configured";
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
    "openbot.audit_event_id": record.audit_event_id,
    "openbot.occurred_at": record.occurred_at,
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
    ...(record.routine_run_id
      ? { "openbot.routine_run_id": record.routine_run_id }
      : {}),
    ...(record.responsibility_run_id
      ? { "openbot.responsibility_run_id": record.responsibility_run_id }
      : {}),
    ...(record.work_item_key
      ? { "openbot.work_item_key": record.work_item_key }
      : {}),
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
  auditRunProofKey?: string,
): EventExporter | undefined {
  const configuration = exportConfiguration(env);
  const service = identifierOf(env.OTEL_SERVICE_NAME?.trim()) ?? "openbot";
  function report(category: Parameters<typeof auditExportDiagnostic>[1]) {
    const deploymentId = identifierOf(env.DEPLOYMENT_ID) ?? "";
    console.info(
      JSON.stringify({
        ...auditExportDiagnostic(deploymentId, category),
        service,
      }),
    );
  }
  if (configuration.state !== "configured") {
    if (configuration.state === "paused") report("audit_export_paused");
    if (configuration.state === "invalid")
      report("audit_export_configuration_invalid");
    if (configuration.state === "invalid_deployment")
      report("audit_export_deployment_invalid");
    return;
  }

  const { deploymentId, url, headers } = configuration;
  let exporter: OTLPLogExporter;
  try {
    exporter = new OTLPLogExporter({ url, headers, timeoutMillis: 10_000 });
  } catch {
    report("audit_export_configuration_invalid");
    return;
  }
  let lastExportFailure = -Infinity;
  function reportExportFailure() {
    const now = performance.now();
    if (now - lastExportFailure < 60_000) return;
    lastExportFailure = now;
    report("audit_export_failed");
  }
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": service,
      "openbot.deployment_id": deploymentId,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: {
          export(records, callback) {
            exporter.export(records, (result) => {
              // The SDK reports final batch delivery through ExportResultCode (SUCCESS = 0).
              if (result.code !== 0) reportExportFailure();
              callback(result);
            });
          },
          forceFlush: () => exporter.forceFlush(),
          shutdown: () => exporter.shutdown(),
        },
      }),
    ],
  });
  const logger = provider.getLogger("openbot.audit");

  return {
    emit(event) {
      try {
        const record = projectAuditEvent(event, deploymentId, auditRunProofKey);
        if (!record) return;
        const failed = record.projection_status === "failed";
        if (failed) report("audit_projection_failed");
        const severity = failed
          ? SeverityNumber.WARN
          : severityOf(record.event_type);
        logger.emit({
          severityNumber: severity,
          severityText: severity === SeverityNumber.WARN ? "WARN" : "INFO",
          body: record.event_type,
          eventName: record.event_type,
          attributes: attributesOf(record, surfaceOf(record.event_type)),
        });
      } catch {
        reportExportFailure();
      }
    },
    shutdown: () => provider.shutdown(),
  };
}
