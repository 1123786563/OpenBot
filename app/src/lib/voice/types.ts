/** Normalized realtime controls shared by provider transports. Audio never goes through AG-UI. */
export type VoiceEvent = Record<string, unknown> & { type: string };

/**
 * The company/team selection a call is established under (MT082 / Issue #125): the pair rides the
 * call's own POST URL as query (the realtime socket the POST returns is a third-party origin and
 * never sees it). Structural twin of the tenant selection, kept local so the voice transports do
 * not import the tenancy module.
 */
export type VoiceStreamScope = {
  tenantId: string;
  workspaceId: string;
};

export interface VoiceConnection {
  stream: MediaStream;
  send(event: VoiceEvent): void;
  mute(muted: boolean): void;
  close(): void;
}

export type ConnectVoice = (options: {
  channelId: string;
  signal: AbortSignal;
  onEvent(event: VoiceEvent): void;
  onError(error: Error): void;
  onOutput(stream: MediaStream): void;
  /** The selection this call belongs to, or null/absent: personal context. */
  scope?: VoiceStreamScope | null;
}) => Promise<VoiceConnection>;
