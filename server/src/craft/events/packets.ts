/**
 * Craft packet types for streaming agent responses — the Onyx-specific extensions layered on
 * the sandbox-event schema in ./types.
 *
 * All packets ride SSE as `event: message` records with a `type` field distinguishing them, a
 * snake_case body (wire parity with onyx's pydantic model_dump), and a `timestamp` (ISO UTC)
 * stamped at construction. The two packets whose flows are out of the first phase
 * (ApprovalRequested, ConnectAppRequest) keep their types so the union and the SSE serializer
 * are already shaped for them.
 */
import { type SandboxEvent, SSEKeepalive } from "./types";

export type BasePacket = {
  timestamp: string;
};

export type ErrorPacket = BasePacket & {
  readonly packetKind: "error";
  type: "error";
  message: string;
};

export type ApprovalRequestedPacket = BasePacket & {
  readonly packetKind: "approval_requested";
  type: "approval_requested";
  approval_id: string;
  session_id: string;
};

export type SubagentStartedPacket = BasePacket & {
  readonly packetKind: "subagent_started";
  type: "subagent_started";
  subagent_session_id: string;
  parent_session_id: string;
};

export type ConnectAppRequestPacket = BasePacket & {
  readonly packetKind: "connect_app_request";
  type: "connect_app_request";
  request_id: string;
  external_app_id: number;
  reason: string | null;
};

export type ContextUsagePacket = BasePacket & {
  readonly packetKind: "context_usage";
  type: "context_usage";
  used_tokens: number;
  cost: number | null;
};

export type CompactionPacket = BasePacket & {
  readonly packetKind: "compaction";
  type: "compaction";
  summary: string | null;
};

export type BuildPacket =
  | ErrorPacket
  | ApprovalRequestedPacket
  | SubagentStartedPacket
  | ConnectAppRequestPacket
  | ContextUsagePacket
  | CompactionPacket;

const nowIso = () => new Date().toISOString();

export function errorPacket(message: string): ErrorPacket {
  return { packetKind: "error", type: "error", message, timestamp: nowIso() };
}

export function subagentStartedPacket(
  subagentSessionId: string,
  parentSessionId: string,
): SubagentStartedPacket {
  return {
    packetKind: "subagent_started",
    type: "subagent_started",
    subagent_session_id: subagentSessionId,
    parent_session_id: parentSessionId,
    timestamp: nowIso(),
  };
}

export function contextUsagePacket(
  usedTokens: number,
  cost: number | null,
): ContextUsagePacket {
  return {
    packetKind: "context_usage",
    type: "context_usage",
    used_tokens: usedTokens,
    cost,
    timestamp: nowIso(),
  };
}

export function compactionPacket(summary: string | null): CompactionPacket {
  return {
    packetKind: "compaction",
    type: "compaction",
    summary,
    timestamp: nowIso(),
  };
}

/** Everything one opencode turn can yield: ACP events plus the custom packets above. */
export type TurnStreamItem = SandboxEvent | BuildPacket;

export function isBuildPacket(item: unknown): item is BuildPacket {
  return (
    item !== null &&
    typeof item === "object" &&
    "packetKind" in item &&
    !(item instanceof SSEKeepalive)
  );
}
