/** Dependency-free public and internal wire data shapes. Runtime validators live in the server workspace. */
export const WIRE_SCHEMA_VERSION = 1 as const;
export const WIRE_CONTRACT_NAMES = [
  "public_run_input",
  "runtime_invocation",
  "tool_preparation",
  "tool_execution",
  "event_proposal",
  "checkpoint_proposal",
  "conversation",
  "run",
  "event",
  "checkpoint",
  "tool_receipt",
] as const;

export type StorageBackend = "intelligence" | "platform";

export interface PublicRunInput {
  thread_id: string;
  input_text: string;
  attachment_refs: string[];
  idempotency_key: string;
}

export interface ConversationDTO {
  conversation_id: string;
  thread_id: string;
  title: string | null;
  storage_backend: StorageBackend;
  created_at: string;
  updated_at: string;
  last_message_seq: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunDTO {
  run_id: string;
  thread_id: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  error_code?: string;
}

export type PublicEventPayload =
  | { kind: "text_delta"; text: string }
  | {
      kind: "activity_snapshot";
      activity: Array<{ type: string; message: string }>;
    }
  | {
      kind: "tool_call";
      tool_call_id: string;
      tool_name: string;
      status: "requested" | "waiting_approval" | "completed" | "failed";
      result_text?: string;
    }
  | {
      kind: "attachment";
      attachment_ref: string;
      media_type?: string;
      display_name?: string;
    };

export interface EventDTO {
  event_id: string;
  run_id: string;
  seq: number;
  event_type: PublicEventPayload["kind"];
  occurred_at: string;
  payload: PublicEventPayload;
}

export interface CheckpointDTO {
  checkpoint_id: string;
  run_id: string;
  schema_version: number;
  content_digest: string;
  created_at: string;
  message_refs: string[];
  operation_refs: string[];
  pending_approval: boolean;
}

export type ToolReceiptStatus =
  | "not_submitted"
  | "submitted"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ToolReceiptDTO {
  operation_id: string;
  execution_attempt_id: string;
  status: ToolReceiptStatus;
  receipt_ref?: string;
  error_code?: string;
  reconciliation_required: boolean;
}

export interface RuntimeInvocation {
  schema_version: 1;
  tenant_id: string;
  principal_id: string;
  actor_id: string;
  initiator_kind: "human" | "schedule";
  run_id: string;
  attempt_id: string;
  turn_id: string;
  thread_id: string;
  expert_version: string;
  input_digest: string;
  model_route_ref: string;
  budget_reservation_id: string;
  lease_id: string;
  fencing_token: string;
  expires_at: string;
  delegation_ref?: string;
}

export type WireContractName = (typeof WIRE_CONTRACT_NAMES)[number];
export type WireEnvelopeV1 = {
  schema_version: 1;
  contract: WireContractName;
  payload: unknown;
};
