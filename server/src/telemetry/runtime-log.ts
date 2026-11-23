import { version } from "../../../package.json";
import {
  identifierOf,
  type OpenBotRuntimeRecord,
  RUNTIME_SCHEMA_VERSION,
} from "./observability-projection";

type EventMetadata = {
  component: "api" | "worker" | "migration" | "retention" | "routines";
  operation:
    | "startup"
    | "apply"
    | "release_connection"
    | "sweep"
    | "purge"
    | "serve";
  legacy?: true;
  diagnostic?: string;
} & (
  | { severity: "info" | "warn"; outcome: "succeeded" }
  | {
      severity: "warn" | "error";
      outcome: "failed";
      error_category: string;
      diagnostic: string;
    }
);

const events = {
  intelligence_entitlement_waiting: {
    severity: "info",
    component: "api",
    operation: "startup",
    outcome: "succeeded",
    diagnostic:
      "Waiting for Intelligence to finish starting. OpenBot retries before reporting an entitlement failure.",
  },
  intelligence_entitlement_unreadable: {
    severity: "warn",
    component: "api",
    operation: "startup",
    outcome: "failed",
    error_category: "entitlement_read_error",
    legacy: true,
    diagnostic:
      "Could not read Intelligence entitlements. Check Intelligence availability and the deployment's INTELLIGENCE_API_KEY.",
  },
  intelligence_entitlement_not_ready: {
    severity: "warn",
    component: "api",
    operation: "startup",
    outcome: "failed",
    error_category: "entitlement_unavailable",
    legacy: true,
    diagnostic:
      "Intelligence did not confirm entitlement. Check the Intelligence deployment's licence and COPILOTKIT_LICENSE_TOKEN.",
  },
  intelligence_entitlement_expired: {
    severity: "warn",
    component: "api",
    operation: "startup",
    outcome: "failed",
    error_category: "entitlement_expired",
    legacy: true,
    diagnostic:
      "Intelligence's licence has expired. Renew it and replace COPILOTKIT_LICENSE_TOKEN on the Intelligence deployment.",
  },
  api_unhandled_rejection: {
    severity: "error",
    component: "api",
    operation: "serve",
    outcome: "failed",
    error_category: "unhandled_rejection",
    diagnostic:
      "The API caught an unhandled rejection and kept serving. Check upstream service availability and recent restarts.",
  },
  routine_queue_purged: {
    severity: "info",
    component: "routines",
    operation: "purge",
    outcome: "succeeded",
  },
  routine_queue_purge_failed: {
    severity: "warn",
    component: "routines",
    operation: "purge",
    outcome: "failed",
    error_category: "routine_queue_purge_error",
    diagnostic:
      "The worker could not purge old routine queue items. It will retry on the next purge tick.",
  },
  page_frame_retention_swept: {
    severity: "info",
    component: "retention",
    operation: "sweep",
    outcome: "succeeded",
  },
  page_frame_retention_failed: {
    severity: "error",
    component: "retention",
    operation: "sweep",
    outcome: "failed",
    error_category: "page_frame_retention_error",
    diagnostic:
      "Old turn screenshots could not be removed. The API is still serving.",
  },
  proactive_retention_swept: {
    severity: "info",
    component: "retention",
    operation: "sweep",
    outcome: "succeeded",
  },
  proactive_retention_failed: {
    severity: "error",
    component: "retention",
    operation: "sweep",
    outcome: "failed",
    error_category: "proactive_retention_error",
    diagnostic:
      "Old check-in runs and pings could not be removed. The API is still serving.",
  },
  single_user_mode_enabled: {
    severity: "warn",
    component: "api",
    operation: "startup",
    outcome: "succeeded",
    legacy: true,
    diagnostic:
      "No identity provider is configured. All requests have administrator access. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_*.",
  },
  api_listen_failed: {
    severity: "error",
    component: "api",
    operation: "startup",
    outcome: "failed",
    error_category: "http_bind_error",
    diagnostic:
      "The API could not bind its port. Check whether another process is listening on that port.",
  },
  api_listening: {
    severity: "info",
    component: "api",
    operation: "startup",
    outcome: "succeeded",
  },
  worker_started: {
    severity: "info",
    component: "worker",
    operation: "startup",
    outcome: "succeeded",
  },
  worker_configuration_failed: {
    severity: "error",
    component: "worker",
    operation: "startup",
    outcome: "failed",
    error_category: "invalid_worker_configuration",
    diagnostic:
      "Check DATABASE_URL, WORKER_SHARED_SECRET, and that SERVER_INTERNAL_URL is a valid HTTP(S) URL.",
  },
  migrations_applied: {
    severity: "info",
    component: "migration",
    operation: "apply",
    outcome: "succeeded",
  },
  migration_failed: {
    severity: "error",
    component: "migration",
    operation: "apply",
    outcome: "failed",
    error_category: "migration_error",
    diagnostic: "Database migrations did not complete.",
  },
  migration_connection_release_failed: {
    severity: "error",
    component: "migration",
    operation: "release_connection",
    outcome: "failed",
    error_category: "database_connection_error",
    diagnostic:
      "The migration runner could not release its database connection.",
  },
  audit_retention_swept: {
    severity: "info",
    component: "retention",
    operation: "sweep",
    outcome: "succeeded",
  },
  audit_retention_failed: {
    severity: "error",
    component: "retention",
    operation: "sweep",
    outcome: "failed",
    error_category: "audit_retention_error",
    diagnostic:
      "Audit retention did not complete. The audit trail remains intact.",
  },
  routine_sweep_completed: {
    severity: "info",
    component: "routines",
    operation: "sweep",
    outcome: "succeeded",
  },
  billed_conversation_recovery_failed: {
    severity: "warn",
    component: "worker",
    operation: "sweep",
    outcome: "failed",
    error_category: "billed_conversation_recovery_error",
    diagnostic:
      "The worker could not recover billed Conversation replies. It will retry on the next tick.",
  },
  bifrost_evidence_recovery_failed: {
    severity: "warn",
    component: "worker",
    operation: "sweep",
    outcome: "failed",
    error_category: "bifrost_evidence_recovery_error",
    diagnostic: "The worker could not recover Bifrost billing evidence.",
  },
  lago_usage_export_failed: {
    severity: "warn",
    component: "worker",
    operation: "sweep",
    outcome: "failed",
    error_category: "lago_usage_export_error",
    diagnostic:
      "Lago usage export could not proceed. Pending events remain durable.",
  },
  lago_usage_export_paused: {
    severity: "warn",
    component: "worker",
    operation: "sweep",
    outcome: "failed",
    error_category: "lago_usage_discrepancy",
    diagnostic: "Lago usage export paused a discrepant event for review.",
  },
  routine_sweep_failed: {
    severity: "warn",
    component: "routines",
    operation: "sweep",
    outcome: "failed",
    error_category: "routine_sweep_error",
    diagnostic: "Routine sweep did not complete.",
  },
} satisfies Record<string, EventMetadata>;

type Measurements = {
  port?: number;
  duration_ms?: number;
  deleted?: number;
  retention_days?: number;
  offered?: number;
  considered?: number;
  fired?: number;
  skipped?: number;
  purged?: number;
  deleted_runs?: number;
  deleted_pings?: number;
  http_status?: number;
  wait_window_ms?: number;
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function writeRuntimeLog(
  event: keyof typeof events,
  fields?: Measurements,
): void {
  if (typeof event !== "string" || !Object.hasOwn(events, event)) return;
  const entry: EventMetadata = events[event];
  const { legacy, diagnostic, ...metadata } = entry;
  const stderr = metadata.severity !== "info";
  const status = nonNegativeNumber(fields?.http_status);
  const record: OpenBotRuntimeRecord &
    Omit<EventMetadata, "legacy" | "diagnostic"> &
    Measurements & {
      service: string;
      version: string;
      legacy_event?: keyof typeof events;
      diagnostic?: string;
    } = {
    stream: "openbot_runtime",
    schema_version: RUNTIME_SCHEMA_VERSION,
    deployment_id:
      identifierOf(process.env.DEPLOYMENT_ID?.trim()) ?? "unconfigured",
    source: "openbot",
    canonical_source: stderr ? "openbot.stderr" : "openbot.stdout",
    data_class: "runtime",
    projection_status: legacy ? "unknown" : "known",
    occurred_at: new Date().toISOString(),
    service: identifierOf(process.env.OTEL_SERVICE_NAME?.trim()) ?? "openbot",
    version,
    event_category: legacy ? "legacy_unstructured" : event,
    legacy_event: legacy ? event : undefined,
    ...metadata,
    port: nonNegativeNumber(fields?.port),
    duration_ms: nonNegativeNumber(fields?.duration_ms),
    deleted: nonNegativeNumber(fields?.deleted),
    retention_days: nonNegativeNumber(fields?.retention_days),
    offered: nonNegativeNumber(fields?.offered),
    considered: nonNegativeNumber(fields?.considered),
    fired: nonNegativeNumber(fields?.fired),
    skipped: nonNegativeNumber(fields?.skipped),
    purged: nonNegativeNumber(fields?.purged),
    deleted_runs: nonNegativeNumber(fields?.deleted_runs),
    deleted_pings: nonNegativeNumber(fields?.deleted_pings),
    http_status:
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined,
    wait_window_ms: nonNegativeNumber(fields?.wait_window_ms),
    // Catalogue diagnostics use ASCII, so the character limit is also a byte limit.
    diagnostic: diagnostic?.slice(0, 160),
  };
  const line = JSON.stringify(record);
  if (metadata.severity === "error") console.error(line);
  else if (metadata.severity === "warn") console.warn(line);
  else console.info(line);
}
