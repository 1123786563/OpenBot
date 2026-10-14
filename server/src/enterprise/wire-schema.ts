import { createHash } from "node:crypto";
import { z } from "zod";
import { WIRE_CONTRACT_NAMES } from "../../../shared/enterprise/contracts";

const Identifier = z.string().trim().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const StorageBackendSchema = z.enum(["intelligence", "platform"]);

export const PublicRuntimeInvocationSchema = z
  .object({
    thread_id: Identifier,
    input_text: z.string().max(200_000),
    attachment_refs: z.array(Identifier).max(100).default([]),
    idempotency_key: Identifier,
  })
  .strict();
export const PublicRunInputSchema = PublicRuntimeInvocationSchema;

export const ConversationDTOZ = z
  .object({
    conversation_id: Identifier,
    thread_id: Identifier,
    title: z.string().max(500).nullable(),
    storage_backend: StorageBackendSchema,
    created_at: Timestamp,
    updated_at: Timestamp,
    last_message_seq: z.number().int().nonnegative(),
  })
  .strict();

export const RunDTOZ = z
  .object({
    run_id: Identifier,
    thread_id: Identifier,
    status: z.enum([
      "queued",
      "running",
      "waiting_approval",
      "suspended",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    created_at: Timestamp,
    updated_at: Timestamp,
    finished_at: Timestamp.nullable().optional(),
    error_code: Identifier.optional(),
  })
  .strict();

const EventPayloadZ = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text_delta"), text: z.string().max(100_000) })
    .strict(),
  z
    .object({
      kind: z.literal("activity_snapshot"),
      activity: z
        .array(
          z
            .object({ type: Identifier, message: z.string().max(20_000) })
            .strict(),
        )
        .max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_call"),
      tool_call_id: Identifier,
      tool_name: Identifier,
      status: z.enum(["requested", "waiting_approval", "completed", "failed"]),
      result_text: z.string().max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attachment"),
      attachment_ref: Identifier,
      media_type: z.string().max(200).optional(),
      display_name: z.string().max(500).optional(),
    })
    .strict(),
]);

export const EventDTOZ = z
  .object({
    event_id: Identifier,
    run_id: Identifier,
    seq: z.number().int().positive(),
    event_type: z.enum([
      "text_delta",
      "activity_snapshot",
      "tool_call",
      "attachment",
    ]),
    occurred_at: Timestamp,
    payload: EventPayloadZ,
  })
  .strict()
  .refine((event) => event.event_type === event.payload.kind, {
    message: "event_type must match the public payload kind",
    path: ["payload", "kind"],
  });

export const CheckpointDTOZ = z
  .object({
    checkpoint_id: Identifier,
    run_id: Identifier,
    schema_version: z.number().int().positive(),
    content_digest: Digest,
    created_at: Timestamp,
    message_refs: z.array(Identifier).max(10_000).default([]),
    operation_refs: z.array(Identifier).max(10_000).default([]),
    pending_approval: z.boolean(),
  })
  .strict();

export const ToolReceiptDTOZ = z
  .object({
    operation_id: Identifier,
    execution_attempt_id: Identifier,
    status: z.enum([
      "not_submitted",
      "submitted",
      "succeeded",
      "failed",
      "unknown",
    ]),
    receipt_ref: Identifier.optional(),
    error_code: Identifier.optional(),
    reconciliation_required: z.boolean(),
  })
  .strict();

export const RuntimeInvocationWireSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: Identifier,
    principal_id: Identifier,
    actor_id: Identifier,
    initiator_kind: z.enum(["human", "schedule"]),
    run_id: Identifier,
    attempt_id: Identifier,
    turn_id: Identifier,
    thread_id: Identifier,
    expert_version: Identifier,
    input_digest: Digest,
    model_route_ref: Identifier,
    budget_reservation_id: Identifier,
    lease_id: Identifier,
    fencing_token: z.string().regex(/^[1-9][0-9]*$/),
    expires_at: Timestamp,
    delegation_ref: Identifier.optional(),
  })
  .strict()
  .refine(
    (invocation) =>
      invocation.initiator_kind !== "schedule" ||
      invocation.delegation_ref !== undefined,
    {
      message: "scheduled invocations require an explicit delegation_ref",
      path: ["delegation_ref"],
    },
  );

const MAX_JSON_DEPTH = 32;
const MAX_CANONICAL_JSON_BYTES = 65_536;

export interface CanonicalJson {
  readonly canonicalJson: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: string;
}

export function canonicalizeBoundedJson(value: unknown): CanonicalJson {
  const ancestors = new WeakSet<object>();
  const normalize = (current: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH)
      throw new TypeError("JSON value exceeds maximum depth 32.");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new TypeError("JSON numbers must be finite.");
      return current;
    }
    if (typeof current !== "object")
      throw new TypeError("Value is not finite JSON.");
    if (ancestors.has(current))
      throw new TypeError("JSON value must not contain cycles.");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current).filter(
          (key) => key !== "length",
        );
        if (
          ownKeys.length !== current.length ||
          ownKeys.some(
            (key) => typeof key !== "string" || !/^0$|^[1-9][0-9]*$/.test(key),
          )
        ) {
          throw new TypeError(
            "JSON arrays must be dense and cannot have extra properties.",
          );
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        return current.map((item, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !("value" in descriptor))
            throw new TypeError(
              "JSON array entries must be enumerable data properties.",
            );
          return normalize(item, depth + 1);
        });
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("JSON objects must be plain objects.");
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string"))
        throw new TypeError("JSON objects cannot contain symbol keys.");
      const result: Record<string, unknown> = Object.create(null);
      for (const key of (keys as string[]).sort()) {
        if (Array.from(key).length > 200)
          throw new TypeError(
            "JSON object property names must be at most 200 characters.",
          );
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw new TypeError(
            "JSON object entries must be enumerable data properties.",
          );
        result[key] = normalize(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  };

  const normalized = normalize(value, 0);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    throw new TypeError("Tool arguments must be a JSON object.");
  }
  const canonicalJson = JSON.stringify(normalized);
  const canonicalBytes = new TextEncoder().encode(canonicalJson);
  if (canonicalBytes.byteLength > MAX_CANONICAL_JSON_BYTES) {
    throw new TypeError("Canonical tool arguments exceed 65536 UTF-8 bytes.");
  }
  const digest = `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}`;
  return { canonicalJson, canonicalBytes, digest };
}

const SafeJsonObjectZ = z.record(
  z.string().refine((key) => Array.from(key).length <= 200, {
    message: "property names must be at most 200 characters",
  }),
  z.unknown(),
);
const ToolTargetZ = z
  .object({
    kind: Identifier,
    id: Identifier,
  })
  .strict();

export const ToolPreparationWireSchema = z
  .object({
    run_id: Identifier,
    attempt_id: Identifier,
    tool_call_id: Identifier,
    step_id: Identifier,
    installation_version: Identifier,
    target: ToolTargetZ,
    args: SafeJsonObjectZ,
    args_digest: Digest,
    fencing_token: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict()
  .superRefine((preparation, context) => {
    try {
      const canonical = canonicalizeBoundedJson(preparation.args);
      if (canonical.digest !== preparation.args_digest) {
        context.addIssue({
          code: "custom",
          path: ["args_digest"],
          message: "args_digest must hash the canonical UTF-8 arguments.",
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["args"],
        message:
          error instanceof Error ? error.message : "Invalid JSON arguments.",
      });
    }
  });

export const ToolExecutionWireSchema = z
  .object({
    operation_id: Identifier,
    attempt_id: Identifier,
    args_digest: Digest,
    approval_ref: Identifier.optional(),
    fencing_token: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();

export const RunEventProposalWireSchema = z
  .object({
    run_id: Identifier,
    attempt_id: Identifier,
    source_event_id: Identifier,
    event_type: z.enum([
      "text_delta",
      "activity_snapshot",
      "tool_call",
      "attachment",
    ]),
    schema_version: z.literal(1),
    payload: EventPayloadZ,
  })
  .strict()
  .refine((event) => event.event_type === event.payload.kind, {
    message: "event_type must match payload kind",
    path: ["payload", "kind"],
  });

export const CheckpointProposalWireSchema = z
  .object({
    schema_version: z.literal(1),
    expert_version: Identifier,
    runtime_compatibility: Identifier,
    run_id: Identifier,
    attempt_id: Identifier,
    step_id: Identifier,
    message_refs: z.array(Identifier).max(10_000),
    completed_operation_refs: z.array(Identifier).max(10_000),
    pending_approval_ref: Identifier.nullable(),
    budget_reservation_id: Identifier,
    artifact_refs: z.array(Identifier).max(10_000),
    content_digest: Digest,
  })
  .strict();

export const WireSchemaV1 = z.discriminatedUnion("contract", [
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("public_run_input"),
      payload: PublicRunInputSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("runtime_invocation"),
      payload: RuntimeInvocationWireSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("tool_preparation"),
      payload: ToolPreparationWireSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("tool_execution"),
      payload: ToolExecutionWireSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("event_proposal"),
      payload: RunEventProposalWireSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("checkpoint_proposal"),
      payload: CheckpointProposalWireSchema,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("conversation"),
      payload: ConversationDTOZ,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("run"),
      payload: RunDTOZ,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("event"),
      payload: EventDTOZ,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("checkpoint"),
      payload: CheckpointDTOZ,
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      contract: z.literal("tool_receipt"),
      payload: ToolReceiptDTOZ,
    })
    .strict(),
]);

interface JsonSchemaNode {
  [key: string]: unknown;
}

interface RuntimeSchemaDocument extends JsonSchemaNode {
  $schema: string;
  $id: string;
  title: string;
  oneOf: JsonSchemaNode[];
  $defs?: Record<string, unknown>;
}

const generatedRuntimeV1JsonSchema = {
  ...(JSON.parse(
    JSON.stringify(
      z.toJSONSchema(WireSchemaV1, {
        target: "draft-2020-12",
        unrepresentable: "any",
      }),
    ),
  ) as RuntimeSchemaDocument),
  $id: "https://openbot.dev/schemas/enterprise/runtime-v1.schema.json",
  title: "WireSchemaV1",
};

function isSchemaObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableJsonSchema(schema: RuntimeSchemaDocument) {
  const preparation = schema.oneOf.find((variant) => {
    const properties = variant.properties;
    if (!isSchemaObject(properties) || !isSchemaObject(properties.contract)) {
      return false;
    }
    return properties.contract.const === "tool_preparation";
  });
  const preparationProperties = preparation?.properties;
  const payload = isSchemaObject(preparationProperties)
    ? preparationProperties.payload
    : undefined;
  const payloadProperties = isSchemaObject(payload)
    ? payload.properties
    : undefined;
  if (!isSchemaObject(payloadProperties) || !("args" in payloadProperties)) {
    throw new Error(
      "Generated schema is missing ToolPreparationWireSchema.args.",
    );
  }
  payloadProperties.args = {
    type: "object",
    propertyNames: { maxLength: 200 },
    additionalProperties: { $ref: "#/$defs/CanonicalJsonValue" },
    "x-max-depth": MAX_JSON_DEPTH,
    "x-max-canonical-utf8-bytes": MAX_CANONICAL_JSON_BYTES,
    "x-canonical-encoding": "UTF-8 JSON with recursively sorted object keys",
    "x-args-digest": "sha256 of the exact canonical UTF-8 bytes",
  };
  schema.$defs = {
    ...schema.$defs,
    CanonicalJsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/CanonicalJsonValue" } },
        {
          type: "object",
          propertyNames: { maxLength: 200 },
          additionalProperties: { $ref: "#/$defs/CanonicalJsonValue" },
        },
      ],
    },
  };
  return schema;
}

export const RuntimeV1JsonSchema = portableJsonSchema(
  generatedRuntimeV1JsonSchema,
) as typeof generatedRuntimeV1JsonSchema;

export type PublicRunInput = z.infer<typeof PublicRunInputSchema>;
export type ConversationDTO = z.infer<typeof ConversationDTOZ>;
export type RunDTO = z.infer<typeof RunDTOZ>;
export type EventDTO = z.infer<typeof EventDTOZ>;
export type CheckpointDTO = z.infer<typeof CheckpointDTOZ>;
export type ToolReceiptDTO = z.infer<typeof ToolReceiptDTOZ>;
export type RuntimeInvocation = z.infer<typeof RuntimeInvocationWireSchema>;
export type WireEnvelopeV1 = z.infer<typeof WireSchemaV1>;

export const WireSchemaV1Contracts = WIRE_CONTRACT_NAMES;
