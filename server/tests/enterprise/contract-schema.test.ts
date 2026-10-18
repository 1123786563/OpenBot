import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { EnterpriseContractRegistry } from "../../src/enterprise/contracts";
import {
  OPERATION_ERROR_CODES,
  OPERATION_ERROR_HTTP_STATUS,
  OperationErrorEnvelopeSchema,
  OperationErrorSchema,
  publicOperationError,
} from "../../src/enterprise/runtime-errors";
import runtimeJsonSchema from "../../src/enterprise/runtime-v1.schema.json";
import {
  CheckpointDTOZ,
  ConversationDTOZ,
  canonicalizeBoundedJson,
  EventDTOZ,
  PublicRunInputSchema,
  PublicRuntimeInvocationSchema,
  RunDTOZ,
  RuntimeInvocationWireSchema,
  RuntimeV1JsonSchema,
  ToolPreparationWireSchema,
  ToolReceiptDTOZ,
  WireSchemaV1,
} from "../../src/enterprise/wire-schema";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const requiredRegistryNames = [
  "PlatformScope",
  "ScopeResolver",
  "ResourceReader",
  "StorageBackend",
  "ConversationService",
  "RunService",
  "EventService",
  "CheckpointService",
  "RecoveryService",
  "ToolService",
  "ConversationInput",
  "AppendMessageInput",
  "HistoryInput",
  "MessagePage",
  "MessageDTO",
  "StartRunInput",
  "CancelRunInput",
  "BudgetInput",
  "BudgetReservation",
  "RunStatus",
  "ToolPreparation",
  "ToolExecution",
  "PreparedTool",
  "ToolReceiptDTO",
  "ApprovalResolution",
  "ApprovalDTO",
  "EventProposal",
  "EventAck",
  "EventCursor",
  "EventPage",
  "EventDTO",
  "CheckpointProposal",
  "CheckpointAck",
  "CheckpointDTO",
  "ResumeInput",
  "PlatformRunnerDeps",
  "PlatformCopilotDeps",
  "PlatformRuntimeDeps",
  "PlatformRuntime",
  "HeadlessTurnInput",
  "HeadlessTurnResult",
  "MemorySourceReference",
  "DeletionReceipt",
  "LearningJobDTO",
  "SkillCandidateDTO",
  "CandidateReviewInput",
  "SkillVersionDTO",
  "SkillSelection",
  "SkillSnapshot",
  "LegacyArchive",
  "ImportOptions",
  "ImportReport",
  "CutoverInput",
  "CutoverReceipt",
  "ModelGateway",
  "RuntimeInvocation",
] as const;
type MissingRegistryName = Exclude<
  (typeof requiredRegistryNames)[number],
  keyof EnterpriseContractRegistry
>;
const registryNamesAreComplete: MissingRegistryName extends never
  ? true
  : never = true;

describe("enterprise wire contract v1", () => {
  test("resolves_the_pinned_direct_ajv_dev_dependency_from_public_server_node_modules", async () => {
    const metadata = JSON.parse(
      await readFile(
        resolve(hereDir, "../../node_modules/ajv/package.json"),
        "utf8",
      ),
    ) as { name: string; version: string };
    expect(metadata).toMatchObject({ name: "ajv", version: "8.20.0" });
    const lockfile = await readFile(
      resolve(hereDir, "../../../bun.lock"),
      "utf8",
    );
    expect(lockfile).toContain("ajv@8.20.0");
    expect(lockfile).toContain(
      "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
    );
  });
  test("exports_the_complete_downstream_registry_contract", () => {
    expect(registryNamesAreComplete).toBe(true);
    expect(requiredRegistryNames).toHaveLength(56);
  });
  test("rejects_client_identity_and_unknown_wire_fields", () => {
    expect(
      PublicRuntimeInvocationSchema.safeParse({
        tenant_id: "forged",
        state: {},
      }).success,
    ).toBe(false);
    expect(
      PublicRunInputSchema.safeParse({ tenant_id: "forged", state: {} })
        .success,
    ).toBe(false);
    expect(
      PublicRunInputSchema.safeParse({
        thread_id: "thread-1",
        input_text: "hello",
        tenant_id: "forged",
      }).success,
    ).toBe(false);
  });

  test("accepts_valid_public_run_input_and_rejects_invalid_attachment_refs", () => {
    expect(
      PublicRunInputSchema.safeParse({
        thread_id: "thread-1",
        input_text: "hello",
        attachment_refs: ["artifact-1"],
        idempotency_key: "message-1",
      }).success,
    ).toBe(true);
    expect(
      PublicRunInputSchema.safeParse({
        thread_id: "thread-1",
        input_text: "hello",
        attachment_refs: [" "],
        idempotency_key: "message-1",
      }).success,
    ).toBe(false);
  });

  test("public_dtos_exclude_identity_capabilities_and_unknown_fields", () => {
    const safe = {
      conversation_id: "conversation-1",
      thread_id: "thread-1",
      title: "Support",
      storage_backend: "platform",
      created_at: "2026-10-09T00:00:00.000Z",
      updated_at: "2026-10-09T00:00:00.000Z",
      last_message_seq: 0,
    };
    expect(ConversationDTOZ.safeParse(safe).success).toBe(true);
    expect(
      ConversationDTOZ.safeParse({ ...safe, tenant_id: "internal" }).success,
    ).toBe(false);
    const validRun = {
      run_id: "run-1",
      thread_id: "thread-1",
      status: "running",
      created_at: "2026-10-09T00:00:00.000Z",
      updated_at: "2026-10-09T00:00:00.000Z",
    };
    expect(RunDTOZ.safeParse(validRun).success).toBe(true);
    expect(
      RunDTOZ.safeParse({
        ...validRun,
        fencing_token: "secret",
      }).success,
    ).toBe(false);
    const validEvent = {
      event_id: "event-1",
      run_id: "run-1",
      seq: 1,
      event_type: "text_delta",
      occurred_at: "2026-10-09T00:00:00.000Z",
      payload: { kind: "text_delta", text: "hi" },
    } as const;
    expect(EventDTOZ.safeParse(validEvent).success).toBe(true);
    expect(
      EventDTOZ.safeParse({
        ...validEvent,
        payload: { ...validEvent.payload, service_credential: "secret" },
      }).success,
    ).toBe(false);
    const validCheckpoint = {
      checkpoint_id: "checkpoint-1",
      run_id: "run-1",
      schema_version: 1,
      content_digest: `sha256:${"a".repeat(64)}`,
      created_at: "2026-10-09T00:00:00.000Z",
      message_refs: [],
      operation_refs: [],
      pending_approval: false,
    };
    expect(CheckpointDTOZ.safeParse(validCheckpoint).success).toBe(true);
    expect(
      CheckpointDTOZ.safeParse({
        ...validCheckpoint,
        invocation_capability: "secret",
      }).success,
    ).toBe(false);
    const validReceipt = {
      operation_id: "operation-1",
      execution_attempt_id: "attempt-1",
      status: "unknown",
      reconciliation_required: true,
    } as const;
    expect(ToolReceiptDTOZ.safeParse(validReceipt).success).toBe(true);
    expect(
      ToolReceiptDTOZ.safeParse({
        ...validReceipt,
        raw_args: { token: "secret" },
      }).success,
    ).toBe(false);
  });

  test("tool_arguments_are_finite_recursive_canonical_json_with_shared_digest_bytes", () => {
    const canonicalBytes = Buffer.from(
      '{"nested":{"a":["ok",null],"b":true},"z":1}',
      "utf8",
    );
    const digest = `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`;
    const base = {
      run_id: "run-1",
      attempt_id: "attempt-1",
      tool_call_id: "call-1",
      step_id: "step-1",
      installation_version: "tool-v1",
      target: { kind: "plugin", id: "plugin-1" },
      args_digest: digest,
      fencing_token: "1",
    };
    expect(
      ToolPreparationWireSchema.safeParse({
        ...base,
        args: { z: 1, nested: { b: true, a: ["ok", null] } },
      }).success,
    ).toBe(true);
    expect(
      ToolPreparationWireSchema.safeParse({
        ...base,
        args_digest: `sha256:${"0".repeat(64)}`,
        args: { z: 1, nested: { b: true, a: ["ok", null] } },
      }).success,
    ).toBe(false);
    const invalidArgs = (args: unknown) => {
      const parsed = ToolPreparationWireSchema.safeParse({ ...base, args });
      return (
        !parsed.success &&
        parsed.error.issues.some((issue) => issue.path[0] === "args")
      );
    };
    expect(invalidArgs({ value: undefined })).toBe(true);
    expect(invalidArgs({ value: () => "no" })).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(invalidArgs(cyclic)).toBe(true);
    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) deep = { child: deep };
    expect(invalidArgs(deep)).toBe(true);
    expect(
      ToolPreparationWireSchema.safeParse({
        ...base,
        args: { value: "x".repeat(65_530) },
      }).success,
    ).toBe(false);
    const maxDepth: unknown = Array.from({ length: 32 }).reduce<unknown>(
      (child) => ({ child }),
      "leaf",
    );
    expect(() => canonicalizeBoundedJson(maxDepth)).not.toThrow();
    const tooDeep: unknown = Array.from({ length: 33 }).reduce<unknown>(
      (child) => ({ child }),
      "leaf",
    );
    expect(() => canonicalizeBoundedJson(tooDeep)).toThrow(/maximum depth 32/);
    expect(() =>
      canonicalizeBoundedJson({ value: "x".repeat(65_530) }),
    ).toThrow(/65536 UTF-8 bytes/);
    expect(
      canonicalizeBoundedJson({ z: 1, a: { b: true } }).canonicalJson,
    ).toBe('{"a":{"b":true},"z":1}');
    expect(
      canonicalizeBoundedJson(JSON.parse('{"__proto__":{"x":1},"safe":true}'))
        .canonicalJson,
    ).toBe('{"__proto__":{"x":1},"safe":true}');
    expect(
      canonicalizeBoundedJson({ value: "é" }).canonicalBytes.byteLength,
    ).toBe(14);
  });

  test("nested_argument_key_limits_match_runtime_and_portable_schema", () => {
    const ajv = new Ajv2020({ strict: false });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) => Number.isFinite(Date.parse(value)),
    });
    const validate = ajv.compile(runtimeJsonSchema);
    const argsFor = (args: Record<string, unknown>) => {
      const canonical = canonicalizeBoundedJson(args);
      return {
        schema_version: 1,
        contract: "tool_preparation",
        payload: {
          run_id: "run-1",
          attempt_id: "attempt-1",
          tool_call_id: "call-1",
          step_id: "step-1",
          installation_version: "tool-v1",
          target: { kind: "plugin", id: "plugin-1" },
          args,
          args_digest: canonical.digest,
          fencing_token: "1",
        },
      };
    };
    const accepted = argsFor({ nested: { ["k".repeat(200)]: "ok" } });
    expect(ToolPreparationWireSchema.safeParse(accepted.payload).success).toBe(
      true,
    );
    expect(() =>
      canonicalizeBoundedJson({ nested: { ["k".repeat(200)]: "ok" } }),
    ).not.toThrow();
    expect(validate(accepted)).toBe(true);

    const rejected = {
      ...accepted,
      payload: {
        ...accepted.payload,
        args: { nested: { ["k".repeat(201)]: "ok" } },
      },
    };
    expect(ToolPreparationWireSchema.safeParse(rejected.payload).success).toBe(
      false,
    );
    expect(() =>
      canonicalizeBoundedJson({ nested: { ["k".repeat(201)]: "ok" } }),
    ).toThrow(/property names must be at most 200/);
    expect(validate(rejected)).toBe(false);

    const unicode200 = argsFor({ nested: { ["😀".repeat(200)]: "ok" } });
    expect(
      ToolPreparationWireSchema.safeParse(unicode200.payload).success,
    ).toBe(true);
    expect(() =>
      canonicalizeBoundedJson({ nested: { ["😀".repeat(200)]: "ok" } }),
    ).not.toThrow();
    expect(validate(unicode200)).toBe(true);
    const unicodeTop200 = argsFor({ ["😀".repeat(200)]: "ok" });
    expect(
      ToolPreparationWireSchema.safeParse(unicodeTop200.payload).success,
    ).toBe(true);
    expect(() =>
      canonicalizeBoundedJson({ ["😀".repeat(200)]: "ok" }),
    ).not.toThrow();
    expect(validate(unicodeTop200)).toBe(true);

    const unicode201 = {
      ...unicode200,
      payload: {
        ...unicode200.payload,
        args: { nested: { ["😀".repeat(201)]: "ok" } },
      },
    };
    expect(
      ToolPreparationWireSchema.safeParse(unicode201.payload).success,
    ).toBe(false);
    expect(() =>
      canonicalizeBoundedJson({ nested: { ["😀".repeat(201)]: "ok" } }),
    ).toThrow(/property names must be at most 200/);
    expect(validate(unicode201)).toBe(false);
    const unicodeTop201 = {
      ...unicode200,
      payload: { ...unicode200.payload, args: { ["😀".repeat(201)]: "ok" } },
    };
    expect(
      ToolPreparationWireSchema.safeParse(unicodeTop201.payload).success,
    ).toBe(false);
    expect(() => canonicalizeBoundedJson({ ["😀".repeat(201)]: "ok" })).toThrow(
      /property names must be at most 200/,
    );
    expect(validate(unicodeTop201)).toBe(false);
  });

  test("portable_json_schema_and_public_error_envelope_are_frozen", () => {
    expect(runtimeJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "WireSchemaV1",
    });
    expect(JSON.stringify(runtimeJsonSchema)).toBe(
      JSON.stringify(RuntimeV1JsonSchema),
    );
    const document = runtimeJsonSchema as unknown as {
      oneOf: Array<{
        properties: {
          contract: { const: string };
          payload: { properties: Record<string, Record<string, unknown>> };
        };
      }>;
      $defs: { CanonicalJsonValue: { anyOf: unknown[] } };
    };
    const toolPreparation = document.oneOf.find(
      (variant) => variant.properties.contract.const === "tool_preparation",
    );
    expect(toolPreparation?.properties.payload.properties.args).toMatchObject({
      "x-max-depth": 32,
      "x-max-canonical-utf8-bytes": 65_536,
      "x-args-digest": "sha256 of the exact canonical UTF-8 bytes",
    });
    expect(document.$defs.CanonicalJsonValue.anyOf).toHaveLength(6);
    expect(
      OperationErrorSchema.safeParse({
        code: "approval_required",
        message: "Approval is required.",
        request_id: "request-1",
      }).success,
    ).toBe(true);
    expect(
      OperationErrorEnvelopeSchema.safeParse({
        error: {
          code: "internal",
          message: "Request failed.",
          request_id: "request-1",
        },
      }).success,
    ).toBe(true);
    expect(
      OperationErrorEnvelopeSchema.safeParse({
        error: {
          code: "internal",
          message: "Request failed.",
          request_id: "request-1",
          stack: "secret",
        },
      }).success,
    ).toBe(false);
    expect(
      OperationErrorSchema.safeParse({
        code: "something_new",
        message: "Request failed.",
        request_id: "request-1",
      }).success,
    ).toBe(false);
    expect(OPERATION_ERROR_CODES).toEqual([
      "invalid_request",
      "unauthenticated",
      "forbidden",
      "not_found",
      "conflict",
      "gone",
      "rate_limited",
      "unsupported_version",
      "budget_exceeded",
      "approval_required",
      "reconciliation_required",
      "unavailable",
      "internal",
    ]);
    expect(OPERATION_ERROR_HTTP_STATUS.conflict).toBe(409);
    expect(publicOperationError("internal", "request-1")).toEqual({
      error: {
        code: "internal",
        message: "Request failed.",
        request_id: "request-1",
      },
    });
  });

  test("wire_schema_v1_is_strict_and_versioned", () => {
    expect(
      WireSchemaV1.safeParse({
        schema_version: 1,
        contract: "public_run_input",
        payload: {
          thread_id: "thread-1",
          input_text: "hello",
          idempotency_key: "message-1",
        },
      }).success,
    ).toBe(true);
    expect(
      WireSchemaV1.safeParse({ schema_version: 2, extra: true }).success,
    ).toBe(false);
  });

  test("runtime_invocation_is_strict_and_scheduled_work_requires_delegation", () => {
    const invocation = {
      schema_version: 1,
      tenant_id: "tenant-1",
      principal_id: "principal-1",
      actor_id: "actor-1",
      initiator_kind: "human",
      run_id: "run-1",
      attempt_id: "attempt-1",
      turn_id: "turn-1",
      thread_id: "thread-1",
      expert_version: "expert-v1",
      input_digest: `sha256:${"a".repeat(64)}`,
      model_route_ref: "model-route-1",
      budget_reservation_id: "budget-1",
      lease_id: "lease-1",
      fencing_token: "1",
      expires_at: "2026-10-09T00:00:00.000Z",
    };
    expect(RuntimeInvocationWireSchema.safeParse(invocation).success).toBe(
      true,
    );
    expect(
      RuntimeInvocationWireSchema.safeParse({ ...invocation, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      RuntimeInvocationWireSchema.safeParse({
        ...invocation,
        initiator_kind: "schedule",
      }).success,
    ).toBe(false);
    expect(
      RuntimeInvocationWireSchema.safeParse({
        ...invocation,
        initiator_kind: "schedule",
        delegation_ref: "delegation-1",
      }).success,
    ).toBe(true);
  });
});
