import { z } from "zod";
import { APPROVAL_DECISIONS } from "../approvals/types";
import type { AuditTapEvent } from "../audit";
import { readAuditRun } from "./audit-run-proof";

export const AUDIT_SCHEMA_VERSION = 1;
export const RUNTIME_SCHEMA_VERSION = 1;

export type ProjectionStatus = "known" | "unknown" | "failed";
export type OpenBotScalar = string | number | boolean;

type OpenBotEnvelope<Version extends number> = {
  schema_version: Version;
  source: "openbot";
  deployment_id: string;
  projection_status: ProjectionStatus;
};

export type OpenBotAuditRecord = OpenBotEnvelope<
  typeof AUDIT_SCHEMA_VERSION
> & {
  stream: "openbot_audit";
  canonical_source: "postgresql.audit_events";
  data_class: "audit";
  audit_event_id: string;
  occurred_at: string;
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
  routine_run_id?: string;
  responsibility_run_id?: string;
  work_item_key?: string;
  facets: Record<string, OpenBotScalar>;
};

export type OpenBotRuntimeRecord = OpenBotEnvelope<
  typeof RUNTIME_SCHEMA_VERSION
> & {
  stream: "openbot_runtime";
  canonical_source: "openbot.stdout" | "openbot.stderr";
  data_class: "runtime";
  occurred_at: string;
  severity: "debug" | "info" | "warn" | "error";
  component: string;
  event_category: string;
  outcome: "succeeded" | "failed";
  error_category?: string;
};

const auditDiagnostics = {
  audit_projection_failed: "invalid_facet",
  audit_export_failed: "export_error",
  audit_export_configuration_invalid: "invalid_export_configuration",
  audit_export_deployment_invalid: "invalid_deployment_id",
  audit_export_paused: undefined,
} as const;

export function auditExportDiagnostic(
  deploymentId: string,
  category: keyof typeof auditDiagnostics,
): OpenBotRuntimeRecord {
  return {
    stream: "openbot_runtime",
    schema_version: RUNTIME_SCHEMA_VERSION,
    deployment_id: deploymentId,
    source: "openbot",
    canonical_source: "openbot.stdout",
    data_class: "runtime",
    projection_status: "known",
    occurred_at: new Date().toISOString(),
    severity: category === "audit_export_paused" ? "info" : "warn",
    component: "telemetry",
    event_category: category,
    outcome: category === "audit_export_paused" ? "succeeded" : "failed",
    error_category: auditDiagnostics[category],
  };
}

const boundedIdentifier = /^[A-Za-z0-9_:./-]{1,256}$/;
const facetId = z.string().regex(/^[A-Za-z0-9_:./-]{1,128}$/);
const effect = z.enum(["read", "write", "destructive"]);
const routineOutcome = z.enum(["succeeded", "failed", "skipped", "waiting"]);
const approvalOutcome = z.object({
  behaviour: z.enum(["allow", "ask", "hand_off", "deny"]),
  source: z.enum([
    "safety",
    "team_rule",
    "personal_rule",
    "auto_review",
    "default",
    "person_declined",
    "conversation",
    "task",
  ]),
  ruleId: z.guid().optional(),
});
const appKey = z.string().regex(/^[a-z0-9_-]{1,128}$/);
const appAccessEvents = new Set([
  "app_access.requested",
  "app_access.approved",
  "app_access.cancelled",
  "app_access.dismissed",
  "app_access.owner_granted",
  "app_access.owner_revoked",
]);
const computerFacets = { action: facetId, bot: facetId, tool: facetId };

/** Values that are safe to use as a queryable OpenBot identifier. */
export function identifierOf(value: unknown): string | undefined {
  return typeof value === "string" && boundedIdentifier.test(value)
    ? value
    : undefined;
}

const facetSchemasByEvent: Record<
  string,
  Record<string, z.ZodType<OpenBotScalar | null>>
> = {
  "approval.evaluated": { effect, tool: facetId },
  "approval.person_decided": {
    decision: z.enum(APPROVAL_DECISIONS),
    effect,
    tool: facetId,
  },
  ...Object.fromEntries([...appAccessEvents].map((event) => [event, {}])),
  "channel.routed": {
    fallback: z.boolean(),
    viaMention: z.boolean(),
    viaNameMatch: z.boolean(),
  },
  "configuration.changed": { scope: facetId, setting: facetId },
  "computer.action_allowed": computerFacets,
  "computer.action_refused": computerFacets,
  "computer.sign_in_failed": computerFacets,
  "computer.sign_in_requested": computerFacets,
  "mcp.connection_verified": {
    action: facetId.nullable(),
    kind: facetId,
    verified: z.boolean(),
  },
  "responsibility.triggered": {},
  "routines.run_requested": { source: z.literal("manual") },
  "routine.completed": { routine: facetId, outcome: routineOutcome },
  "routine.failed": { routine: facetId, outcome: routineOutcome },
  "routine.started": { routine: facetId },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectAuditEvent(
  event: AuditTapEvent,
  deploymentId: string,
  auditRunProofKey?: string,
): OpenBotAuditRecord | undefined {
  const auditEventId = identifierOf(event.id);
  if (
    !auditEventId ||
    !identifierOf(deploymentId) ||
    !event.createdAt ||
    !Number.isFinite(event.createdAt.getTime())
  )
    return;

  const targetId = identifierOf(event.targetId);
  const actorUserId = identifierOf(event.actorUserId);
  const initiatorId = identifierOf(event.initiatorId);
  const sourceRun = event.approvalRun ?? {
    runId: event.runId,
    threadId: event.threadId,
  };
  const lineage =
    auditRunProofKey &&
    event.actorUserId &&
    sourceRun.runId !== undefined &&
    sourceRun.threadId !== undefined
      ? readAuditRun(
          event.runLineageProof,
          { runId: sourceRun.runId, threadId: sourceRun.threadId },
          event.actorUserId,
          auditRunProofKey,
        )
      : undefined;
  const runId = identifierOf(sourceRun.runId);
  const parentRunId = identifierOf(lineage?.parentRunId);
  const rootTaskId = identifierOf(lineage?.rootTaskId);
  const attemptId = identifierOf(lineage?.attemptId);
  const threadId = identifierOf(sourceRun.threadId);
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const routineRunId =
    event.eventType === "routines.run_requested"
      ? identifierOf(payload?.runId)
      : undefined;
  const responsibilityRuns = payload?.runIds;
  const responsibilityRunId =
    event.eventType === "responsibility.triggered" &&
    Array.isArray(responsibilityRuns) &&
    responsibilityRuns.length === 1
      ? identifierOf(responsibilityRuns[0])
      : undefined;
  const workItemKey = identifierOf(event.workItemKey);
  const common = {
    stream: "openbot_audit",
    schema_version: AUDIT_SCHEMA_VERSION,
    source: "openbot",
    deployment_id: deploymentId,
    canonical_source: "postgresql.audit_events",
    data_class: "audit",
    audit_event_id: auditEventId,
    occurred_at: event.createdAt.toISOString(),
    event_type: identifierOf(event.eventType) ?? "unknown",
    target_type: identifierOf(event.targetType) ?? "unknown",
    initiator_kind: identifierOf(event.initiatorKind) ?? "unknown",
    ...(targetId ? { target_id: targetId } : {}),
    ...(actorUserId ? { actor_user_id: actorUserId } : {}),
    ...(initiatorId ? { initiator_id: initiatorId } : {}),
    ...(runId ? { run_id: runId } : {}),
    ...(parentRunId ? { parent_run_id: parentRunId } : {}),
    ...(rootTaskId ? { root_task_id: rootTaskId } : {}),
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(routineRunId ? { routine_run_id: routineRunId } : {}),
    ...(responsibilityRunId
      ? { responsibility_run_id: responsibilityRunId }
      : {}),
    ...(workItemKey ? { work_item_key: workItemKey } : {}),
  } satisfies Omit<OpenBotAuditRecord, "projection_status" | "facets">;

  if (!Object.hasOwn(facetSchemasByEvent, event.eventType)) {
    return { ...common, projection_status: "unknown", facets: {} };
  }

  if (!payload) {
    return { ...common, projection_status: "failed", facets: {} };
  }

  const facets: Record<string, OpenBotScalar> = {};
  for (const [key, schema] of Object.entries(
    facetSchemasByEvent[event.eventType],
  )) {
    if (!Object.hasOwn(payload, key)) continue;
    const result = schema.safeParse(payload[key]);
    if (!result.success) {
      return { ...common, projection_status: "failed", facets: {} };
    }
    if (result.data !== null) facets[key] = result.data;
  }

  if (
    event.eventType === "approval.evaluated" &&
    Object.hasOwn(payload, "outcome")
  ) {
    const outcome = approvalOutcome.safeParse(payload.outcome);
    if (!outcome.success)
      return { ...common, projection_status: "failed", facets: {} };
    facets.outcome = outcome.data.behaviour;
    facets.reason_code = outcome.data.source;
    if (outcome.data.ruleId) facets.policy_rule_id = outcome.data.ruleId;
  }
  // These producers persist a resolved catalogue, broker or stored app key.
  if (appAccessEvents.has(event.eventType) && Object.hasOwn(payload, "app")) {
    const app = appKey.safeParse(payload.app);
    if (!app.success)
      return { ...common, projection_status: "failed", facets: {} };
    facets.app_key = app.data;
  }
  return { ...common, projection_status: "known", facets };
}
