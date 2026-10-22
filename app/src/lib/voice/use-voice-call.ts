import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useStreamScope } from "@/lib/enterprise/tenant/stream-scope";
import { queryClient } from "@/query-client";
import { saveVoiceSession } from "./archive";
import { connectVoice, voiceSupported } from "./connection";
import { voiceCallOwner } from "./outbox";
import { VoiceSession } from "./session";

export function useVoiceCall(options: {
  channelId: string;
  disabled: boolean;
  askAgent(request: string, signal: AbortSignal): Promise<string>;
  context(): string | Promise<string>;
  anchorMessageId(): string | null;
}) {
  const callbacks = useRef(options);
  const ownerId = useRef(voiceCallOwner());
  callbacks.current = options;
  /*
   * A call belongs to the scope it was placed under (MT082 / Issue #125): the session reads the
   * pair at start time through this ref, and the effect below ends a live call when the
   * selection moves — voice is a live stream like any other, and a company's call does not
   * continue into the next company's screen.
   */
  const streamScope = useStreamScope();
  const streamScopeRef = useRef(streamScope);
  streamScopeRef.current = streamScope;
  const { data } = useQuery(deploymentCapabilitiesQueryOptions(), queryClient);
  const [session] = useState(
    () =>
      new VoiceSession({
        channelId: options.channelId,
        connect: connectVoice,
        askAgent: (request, signal) =>
          callbacks.current.askAgent(request, signal),
        context: () => callbacks.current.context(),
        anchorMessageId: () => callbacks.current.anchorMessageId(),
        scope: () => {
          const scopeNow = streamScopeRef.current;
          return scopeNow.status === "open" ? scopeNow.selection : null;
        },
        onEnd: (call) => saveVoiceSession(call, ownerId.current),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    if (options.disabled || !data?.voice) session.end();
    window.addEventListener("pagehide", session.end);
    return () => {
      window.removeEventListener("pagehide", session.end);
      session.end();
    };
  }, [options.disabled, data?.voice, session]);
  // The switch's half of the binding: end a live call the moment the selection (or the cache
  // generation any switch advances) moves. The first run establishes the baseline, it ends
  // nothing.
  const streamScopeKey =
    streamScope.status === "open" ? streamScope.key : "pending";
  const seenScopeKey = useRef(streamScopeKey);
  useEffect(() => {
    if (seenScopeKey.current === streamScopeKey) return;
    seenScopeKey.current = streamScopeKey;
    session.end();
  }, [streamScopeKey, session]);
  const active = state.phase === "connecting" || state.phase === "connected";
  return {
    session,
    state,
    minimized,
    setMinimized,
    active,
    available: data?.voice === true,
    supported: voiceSupported(),
    open() {
      setMinimized(false);
      if (!active) void session.start();
    },
  };
}
