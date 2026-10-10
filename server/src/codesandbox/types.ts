/** Shapes shared by the sandbox client, gateway, and tool. No I/O lives here. */
export type SandboxUsage = { inputTokens: number; outputTokens: number };

export type SandboxSendMessageOptions = {
  modelId: string;
  timeoutMs?: number;
};

export type SandboxRunResult = {
  sessionId: string;
  text: string;
  usage?: SandboxUsage;
};

export type SandboxArtifact = {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
};

/**
 * The five product-facing families the live capture fixed (agent-sandbox docs/sse-samples.md):
 * the sandbox's native types map into these once, at the wrapper, and every consumer here
 * reads only the family. `unknown` is included so a future native type flows through the
 * pipeline as a typed non-event rather than killing the stream.
 */
export type TranslatedEventFamily =
  | "message_chunk"
  | "thought"
  | "tool_call"
  | "progress"
  | "prompt_response"
  | "other"
  | "unknown";

/** One forwarded stream event: the family label plus the raw opencode payload. */
export type TranslatedEvent = {
  family: TranslatedEventFamily;
  /** The sandbox's own event id, for tracing back into its stream. */
  eventId: string;
  payload: Record<string, unknown>;
};
