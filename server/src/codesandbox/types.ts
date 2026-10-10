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
