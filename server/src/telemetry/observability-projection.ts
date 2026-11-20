import type { AuditTapEvent } from "../audit";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;

export type ProjectionStatus = "known" | "unknown" | "failed";
export type OpenBotScalar = string | number | boolean;

type OpenBotEnvelope = {
  schema_version: typeof OBSERVABILITY_SCHEMA_VERSION;
  source: "openbot";
  deployment_id: string;
  projection_status: ProjectionStatus;
};

export type OpenBotAuditRecord = OpenBotEnvelope & {
  stream: "openbot_audit";
  canonical_source: "postgresql.audit_events";
  data_class: "audit";
  audit_event_id?: string;
  occurred_at?: string;
  event_type: string;
  target_type: string;
  target_id?: string;
  actor_user_id?: string;
  initiator_kind: string;
  initiator_id?: string;
  run_id?: string;
  parent_run_id?: string;
  root_task_id?: string;
  attempt_id?: string;
  thread_id?: string;
  facets: Record<string, OpenBotScalar>;
};

export type OpenBotRuntimeRecord = OpenBotEnvelope & {
  stream: "openbot_runtime";
  canonical_source: "openbot.stdout";
  data_class: "runtime";
  occurred_at?: string;
  severity: "debug" | "info" | "warn" | "error";
  component: string;
  message?: string;
  run_id?: string;
  parent_run_id?: string;
  root_task_id?: string;
  attempt_id?: string;
  thread_id?: string;
  facets: Record<string, OpenBotScalar>;
};

const boundedIdentifier = /^[A-Za-z0-9_:.\/-]{1,256}$/;
const boundedFacet = /^[A-Za-z0-9_:.\/-]{1,128}$/;

/** Values that are safe to use as a queryable OpenBot identifier. */
export function identifierOf(value: unknown): string | undefined {
  return typeof value === "string" && boundedIdentifier.test(value)
    ? value
    : undefined;
}

const facetKeysByEvent: Record<string, readonly string[]> = {
  "approval.evaluated": ["decision", "effect"],
  "approval.person_decided": ["decision", "effect"],
  "channel.routed": ["mechanism", "outcome"],
  "configuration.changed": ["scope", "setting"],
  "computer.action_allowed": ["action", "bot", "tool"],
  "computer.action_refused": ["action", "bot", "tool"],
  "computer.sign_in_failed": ["action", "bot", "tool"],
  "computer.sign_in_requested": ["action", "bot", "tool"],
  "mcp.connection_verified": ["action", "kind", "verified"],
  "routine.completed": ["routine", "outcome"],
  "routine.failed": ["routine", "outcome"],
  "routine.started": ["routine"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarOf(value: unknown): OpenBotScalar | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && boundedFacet.test(value)) return value;
  return undefined;
}

function commonFields(
  event: AuditTapEvent,
  deploymentId: string,
): Omit<OpenBotAuditRecord, "projection_status" | "facets"> {
  return {
    stream: "openbot_audit",
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    source: "openbot",
    deployment_id: deploymentId,
    canonical_source: "postgresql.audit_events",
    data_class: "audit",
    ...(identifierOf(event.id) ? { audit_event_id: event.id } : {}),
    ...(event.createdAt ? { occurred_at: event.createdAt.toISOString() } : {}),
    event_type: identifierOf(event.eventType) ?? "unknown",
    target_type: identifierOf(event.targetType) ?? "unknown",
    ...(identifierOf(event.targetId) ? { target_id: event.targetId } : {}),
    ...(identifierOf(event.actorUserId)
      ? { actor_user_id: event.actorUserId }
      : {}),
    initiator_kind: identifierOf(event.initiatorKind) ?? "unknown",
    ...(identifierOf(event.initiatorId)
      ? { initiator_id: event.initiatorId }
      : {}),
    ...(identifierOf(event.runId) ? { run_id: event.runId } : {}),
    ...(identifierOf(event.parentRunId)
      ? { parent_run_id: event.parentRunId }
      : {}),
    ...(identifierOf(event.rootTaskId)
      ? { root_task_id: event.rootTaskId }
      : {}),
    ...(identifierOf(event.attemptId) ? { attempt_id: event.attemptId } : {}),
    ...(identifierOf(event.threadId) ? { thread_id: event.threadId } : {}),
  };
}

export function projectAuditEvent(
  event: AuditTapEvent,
  deploymentId: string,
): OpenBotAuditRecord {
  const common = commonFields(event, deploymentId);
  const keys = facetKeysByEvent[event.eventType];
  if (!keys) {
    return { ...common, projection_status: "unknown", facets: {} };
  }

  if (!isRecord(event.payload)) {
    return { ...common, projection_status: "failed", facets: {} };
  }

  const facets: Record<string, OpenBotScalar> = {};
  for (const key of keys) {
    if (!Object.hasOwn(event.payload, key)) continue;
    const value = scalarOf(event.payload[key]);
    if (value === undefined) {
      return { ...common, projection_status: "failed", facets: {} };
    }
    facets[key] = value;
  }

  return { ...common, projection_status: "known", facets };
}
