import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  craftKeys,
  scopedCraftSandboxStatusQueryOptions,
} from "@/lib/craft/queries";
import type { CraftSandboxStatus } from "@/lib/craft/types";

/**
 * The sandbox status chip — the port of onyx's SandboxStatusIndicator, redrawn in this app's dot
 * idiom (a colored dot + label, pulse for the two states a person should watch move).
 *
 * Polling cadence follows onyx's reconciler: provisioning 2s, running 30s, settled states not at
 * all (the wake path refetches explicitly), and react-query retires the timer with the component
 * — an unmounted chip polls nothing. "restoring" is client-owned, exactly as in onyx: while the
 * session query is in flight over a sleeping sandbox, the wake (server-side wakeIfIdle behind
 * GET /sessions/:id) is what the person is waiting on.
 */

/** What the dot can show — the wire states plus the two the client derives. */
export type SandboxDisplayStatus = CraftSandboxStatus | "loading";

/** The i18n keys as literals — the typed `t` refuses a template-string key. */
const LABEL_KEYS = {
  provisioning: "sandbox.provisioning",
  running: "sandbox.running",
  sleeping: "sandbox.sleeping",
  restoring: "sandbox.restoring",
  terminated: "sandbox.terminated",
  failed: "sandbox.failed",
  loading: "sandbox.loading",
} as const;

const STATUS_CONFIG: Record<
  SandboxDisplayStatus,
  { dot: string; pulse: boolean }
> = {
  provisioning: { dot: "bg-amber-500", pulse: true },
  running: { dot: "bg-emerald-500", pulse: false },
  sleeping: { dot: "bg-blue-400", pulse: false },
  restoring: { dot: "bg-amber-500", pulse: true },
  terminated: { dot: "bg-red-500", pulse: false },
  failed: { dot: "bg-red-500", pulse: false },
  loading: { dot: "bg-muted-foreground/50", pulse: true },
};

export function SandboxStatusIndicator({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const status = useSandboxStatus(sessionId);
  const { dot, pulse } = STATUS_CONFIG[status];

  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
      title={t(LABEL_KEYS[status])}
      data-testid="craft-sandbox-status"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${dot}${pulse ? " animate-pulse" : ""}`}
      />
      {t(LABEL_KEYS[status])}
    </span>
  );
}

/** The chip's display status for one session: the poll's answer, with "restoring" overlaid. */
function useSandboxStatus(sessionId: string): SandboxDisplayStatus {
  const queryClient = useQueryClient();
  // The chip's poll is the scope's own answer (MT091 / Issue #134, AC1): the pair rides it.
  const scope = useScopedCache();
  const query = useQuery(
    scopedCraftSandboxStatusQueryOptions(queryClient, scope, sessionId),
  );
  const status = query.data?.status ?? null;
  // A session detail fetch over a sleeping sandbox is the wake in flight — watched at both
  // roots (one hook per root, both always called; a pending scope simply watches a key no
  // entry files under yet), because the scoped read and the wake's own detail read file under
  // the scope's prefix while the legacy assembly still writes the unscoped one.
  const prefix = scope.status === "open" ? scope.prefix : [];
  const unscopedFetching =
    useIsFetching({ queryKey: craftKeys.session(sessionId) }) > 0;
  const scopedFetching = useIsFetching({
    queryKey: [...prefix, ...craftKeys.session(sessionId)],
  }) > 0;
  const sessionFetching = unscopedFetching || scopedFetching;

  // onyx's reconciler, shrunk to its load-bearing line: when the sandbox first answers
  // running, the session detail is reloaded (workspace reconcile) — the chip's poll is the
  // only thing watching, so it is the one that reacts.
  const previous = useRef<CraftSandboxStatus | null>(null);
  useEffect(() => {
    if (previous.current === "provisioning" && status === "running") {
      void queryClient.invalidateQueries({
        queryKey: craftKeys.session(sessionId),
      });
      if (scope.status === "open") {
        void queryClient.invalidateQueries({
          queryKey: [...scope.prefix, ...craftKeys.session(sessionId)],
        });
      }
    }
    previous.current = status;
  }, [status, sessionId, queryClient, scope]);

  if (status === null) return "loading";
  if (status === "sleeping" && sessionFetching) return "restoring";
  return status;
}

/**
 * onyx's useWakeOnIntent, on this app's seams: an input focus over a sleeping (or terminated)
 * sandbox forces the session detail reload — GET /sessions/:id wakes it server-side
 * (wakeIfIdle: snapshot restore + idle→active) — and the chip follows via its own refetch.
 */
export function useWakeOnIntent(sessionId: string): () => void {
  const queryClient = useQueryClient();
  // The wake reads and refreshes at both roots (MT091): the chip's own poll files under the
  // scope's prefix, while the legacy assembly still writes the unscoped one.
  const scope = useScopedCache();
  return useCallback(() => {
    const keys: unknown[][] = [[...craftKeys.sandboxStatus(sessionId)]];
    if (scope.status === "open") {
      keys.push([...scope.prefix, ...craftKeys.sandboxStatus(sessionId)]);
    }
    const status = keys.some(
      (key) =>
        queryClient.getQueryData<{ status: CraftSandboxStatus | null }>(key)
          ?.status === "sleeping" ||
        queryClient.getQueryData<{ status: CraftSandboxStatus | null }>(key)
          ?.status === "terminated",
    );
    if (!status) return;
    void queryClient.invalidateQueries({
      queryKey: craftKeys.session(sessionId),
    });
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient, sessionId, scope]);
}
