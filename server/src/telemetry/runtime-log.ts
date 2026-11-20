import { version } from "../../../package.json";
import {
  identifierOf,
  type OpenBotRuntimeRecord,
  RUNTIME_SCHEMA_VERSION,
} from "./observability-projection";

type EventMetadata = {
  component: "api" | "worker" | "migration" | "retention" | "routines";
  operation: "startup" | "apply" | "release_connection" | "sweep";
} & (
  | { severity: "info"; outcome: "succeeded" }
  | {
      severity: "warn" | "error";
      outcome: "failed";
      error_category: string;
      diagnostic: string;
    }
);

const events = {
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
  const metadata = events[event];
  const stderr = metadata.severity !== "info";
  const record: OpenBotRuntimeRecord &
    EventMetadata &
    Measurements & {
      service: string;
      version: string;
    } = {
    stream: "openbot_runtime",
    schema_version: RUNTIME_SCHEMA_VERSION,
    deployment_id:
      identifierOf(process.env.DEPLOYMENT_ID?.trim()) ?? "unconfigured",
    source: "openbot",
    canonical_source: stderr ? "openbot.stderr" : "openbot.stdout",
    data_class: "runtime",
    projection_status: "known",
    occurred_at: new Date().toISOString(),
    service: identifierOf(process.env.OTEL_SERVICE_NAME?.trim()) ?? "openbot",
    version,
    event_category: event,
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
    ...("diagnostic" in metadata
      ? { diagnostic: metadata.diagnostic.slice(0, 160) }
      : {}),
  };
  const line = JSON.stringify(record);
  if (metadata.severity === "error") console.error(line);
  else if (metadata.severity === "warn") console.warn(line);
  else console.info(line);
}
