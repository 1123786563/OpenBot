import type { ThreadReader } from "./thread-routes";

export interface ThreadReaderAdapters {
  /** `absent` is a conclusive platform lookup miss; failures must reject. */
  readPlatform(threadId: string, actorId: string): Promise<"known" | "absent">;
  /** A legacy 404 is returned as `unknown`; other failures must reject. */
  readLegacy(threadId: string, actorId: string): Promise<"known" | "unknown">;
}

type LegacyThreadLookup = {
  getThread(params: { threadId: string; userId: string }): Promise<unknown>;
};

/** Resolve platform history first, then consult the legacy owner only after a
 * conclusive platform miss. The old Intelligence-only adapter remains accepted
 * for the current public route until authenticated platform route wiring lands. */
export function createThreadReader(
  adapters: ThreadReaderAdapters | LegacyThreadLookup,
): ThreadReader {
  if ("getThread" in adapters) {
    return async (threadId, userId) => {
      try {
        await adapters.getThread({ threadId, userId });
        return "known";
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 404)
          return "unknown";
        throw error;
      }
    };
  }
  return async (threadId, actorId) => {
    const platform = await adapters.readPlatform(threadId, actorId);
    if (platform === "known") return "known";
    if (platform !== "absent")
      throw new Error("PLATFORM_THREAD_LOOKUP_INVALID");
    const legacy = await adapters.readLegacy(threadId, actorId);
    if (legacy === "known" || legacy === "unknown") return legacy;
    throw new Error("LEGACY_THREAD_LOOKUP_INVALID");
  };
}
