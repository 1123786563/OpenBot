import { expect, test } from "bun:test";
import type { AuditTapEvent } from "../src/audit";
import {
  type OpenBotAuditRecord,
  projectAuditEvent,
} from "../src/telemetry/observability-projection";

const auditEvent: AuditTapEvent = {
  id: "3967be97-04d1-4ffa-a6aa-d71af0b78f18",
  createdAt: new Date("2026-11-20T06:00:00.000Z"),
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: "bot-1",
  actorUserId: "person-1",
  initiatorKind: "agent",
  initiatorId: "bot-1",
  payload: {},
};

const commonFields = {
  stream: "openbot_audit",
  schema_version: 1,
  deployment_id: "staging-1",
  source: "openbot",
  canonical_source: "postgresql.audit_events",
  data_class: "audit",
  audit_event_id: "3967be97-04d1-4ffa-a6aa-d71af0b78f18",
  occurred_at: "2026-11-20T06:00:00.000Z",
  event_type: "computer.action_allowed",
  target_type: "computer",
  target_id: "bot-1",
  actor_user_id: "person-1",
  initiator_kind: "agent",
  initiator_id: "bot-1",
} satisfies Omit<OpenBotAuditRecord, "projection_status" | "facets">;

test.each(["future.event", "constructor", "__proto__"])(
  "unknown event %s preserves the audit envelope and drops the whole payload",
  (eventType) => {
    expect(
      projectAuditEvent(
        {
          ...auditEvent,
          eventType,
          payload: { action: "computer_run_command", content: "private" },
        },
        "staging-1",
      ),
    ).toEqual({
      ...commonFields,
      event_type: eventType,
      projection_status: "unknown",
      facets: {},
    });
  },
);

test("approved computer facets and validated run lineage are the only extras", () => {
  expect(
    projectAuditEvent(
      {
        ...auditEvent,
        runId: "run/1",
        parentRunId: "run:0",
        rootTaskId: "task.1",
        attemptId: "attempt-1",
        threadId: "thread_1",
        payload: {
          action: "computer_run_command",
          bot: "bot-1",
          command: "private shell command",
          token: "private-token",
          password: "private-password",
          authorization: "private-auth",
          prompt: "private-prompt",
          content: "private-content",
          tool_arguments: { path: "private-path" },
          tool_result: ["private-result"],
          detail: "private-message",
          nested: [{ prompt: "private-nested" }],
          run_id: "forged-run",
          routine_run_id: "routine-1",
          responsibility_run_id: "responsibility-1",
          work_item_key: "item-1",
        },
      },
      "staging-1",
    ),
  ).toEqual({
    ...commonFields,
    projection_status: "known",
    run_id: "run/1",
    parent_run_id: "run:0",
    root_task_id: "task.1",
    attempt_id: "attempt-1",
    thread_id: "thread_1",
    facets: { action: "computer_run_command", bot: "bot-1" },
  });
});

test.each([
  [
    "routines.run_requested",
    "routine_run_id",
    { runId: "routine-run-1" },
    "routine-run-1",
  ],
  [
    "responsibility.triggered",
    "responsibility_run_id",
    { runIds: ["responsibility-run-1"] },
    "responsibility-run-1",
  ],
])("projects %s with its own run identifier", (eventType, key, payload, id) => {
  const projected = projectAuditEvent(
    { ...auditEvent, eventType, payload },
    "staging-1",
  );
  expect(projected).toHaveProperty(key, id);
  expect(projected).not.toHaveProperty("run_id");
});

test("a responsibility trigger with multiple runs has no single correlated run", () => {
  const projected = projectAuditEvent(
    {
      ...auditEvent,
      eventType: "responsibility.triggered",
      payload: { runIds: ["run-1", "run-2"] },
    },
    "staging-1",
  );
  expect(projected).not.toHaveProperty("responsibility_run_id");
  expect(projected).not.toHaveProperty("run_id");
});

test("an invalid allowlisted decision drops every facet and preserves safe common fields", () => {
  expect(
    projectAuditEvent(
      {
        ...auditEvent,
        eventType: "approval.person_decided",
        runId: "",
        parentRunId: "private text",
        rootTaskId: "x".repeat(257),
        attemptId: "attempt\n1",
        threadId: "线程",
        payload: { decision: "private-token-shaped-content", effect: "read" },
      },
      "staging-1",
    ),
  ).toEqual({
    ...commonFields,
    event_type: "approval.person_decided",
    projection_status: "failed",
    facets: {},
  });
});

test("a structured value in an approved facet fails without exposing earlier facets", () => {
  expect(
    projectAuditEvent(
      {
        ...auditEvent,
        payload: { action: "computer_run_command", bot: { token: "private" } },
      },
      "staging-1",
    ),
  ).toEqual({
    ...commonFields,
    projection_status: "failed",
    facets: {},
  });
});

test("no replica is made without the persisted row identity, event time, and deployment scope", () => {
  expect(
    projectAuditEvent({ ...auditEvent, id: undefined }, "staging-1"),
  ).toBeUndefined();
  expect(
    projectAuditEvent({ ...auditEvent, createdAt: new Date(NaN) }, "staging-1"),
  ).toBeUndefined();
  expect(projectAuditEvent(auditEvent, "")).toBeUndefined();
  expect(projectAuditEvent(auditEvent, "invalid deployment")).toBeUndefined();
});
