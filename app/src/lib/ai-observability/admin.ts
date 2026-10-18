import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/*
 * The admin summary's data module (#42). The wire contract lives in
 * shared/ai-observability-admin.ts, the browser's typed view of the T33 projection.
 *
 * A refusal from this endpoint is an answer, not a failure: 401/403/404 is the manage gate
 * or the scope seam refusing to widen (the same refusal a stranger's probe hears), anything
 * else — transport error, 500, a 200 whose body lost its key fields — is the store failing
 * to answer, which is an explicit error state and never a silently empty Bot list (the
 * T33-rev3 listBots minor, page side).
 *
 * The time filter travels as the preset the person chose, not as computed timestamps: the
 * window is resolved from the clock at fetch time, so a cached key never carries a stale
 * "now" and the chips stay in charge of when a refetch happens.
 */

export type {
  AdminBotSummary,
  AdminCapability,
  AdminExportJobState,
  AdminReadinessReason,
  AdminRunState,
  AdminSummaryResult,
} from "../../../../shared/ai-observability-admin";

import type { AdminSummaryResult } from "../../../../shared/ai-observability-admin";

/** Each time filter's label and span; "all" asks for the open window. */
export const ADMIN_TIME_WINDOWS = [
  { id: "all", labelKey: "filter.timeAll", ms: null },
  { id: "day", labelKey: "filter.timeDay", ms: 86_400_000 },
  { id: "week", labelKey: "filter.timeWeek", ms: 604_800_000 },
  { id: "month", labelKey: "filter.timeMonth", ms: 2_592_000_000 },
] as const;

export type AdminTimeWindowId = (typeof ADMIN_TIME_WINDOWS)[number]["id"];

export const observationAdminKeys = {
  all: ["ai-observability-admin"] as const,
  summary: (window: AdminTimeWindowId) =>
    ["ai-observability-admin", "summary", window] as const,
};

/** What the screen is allowed to conclude: the summary, or the fault that explains it. */
export type ObservationAdminSummaryScreen =
  | { view: "summary"; result: AdminSummaryResult }
  | { view: "fault"; fault: "forbidden" | "unavailable" };

/*
 * Runtime shape defense on the success body, the runs chain's discipline: key fields
 * missing means the store failed to answer — the unavailable fault, never an undefined
 * page. The readiness reason is checked against the closed vocabulary because the page
 * renders a sentence per reason; a reason this build has never heard of is not rendered as
 * a guess but treated as a body this page cannot read.
 */
const READINESS_REASONS = [
  "disabled",
  "unconfigured",
  "capability_missing",
  "authentication_failure",
  "unreachable",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumberRecord(value: unknown, keys: readonly string[] = []): boolean {
  if (!isRecord(value)) return false;
  /*
   * OCR round 2 (R2-05): "every value that exists is a number" let `{}` through, and
   * the page's first read of a missing key (`byState.failed`) crashed
   * formatNumber's toLocaleString on undefined. The keys the page's own sentences
   * read must exist and be numbers; every other value stays claimed as a number,
   * which is what every read of it does with it.
   */
  for (const key of keys) {
    if (typeof value[key] !== "number") return false;
  }
  return Object.values(value).every((v) => typeof v === "number");
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAdminSummaryBody(body: unknown): body is AdminSummaryResult {
  if (!isRecord(body)) return false;
  const collection = body.collection;
  if (!isRecord(collection) || !isRecord(collection.readiness)) return false;
  if (typeof collection.readiness.ready !== "boolean") return false;
  const reason = collection.readiness.reason;
  if (
    reason !== null &&
    !(
      typeof reason === "string" &&
      (READINESS_REASONS as readonly string[]).includes(reason)
    )
  ) {
    return false;
  }
  const dropped = collection.dropped;
  if (
    !isRecord(dropped) ||
    typeof dropped.queueFull !== "number" ||
    typeof dropped.notReady !== "number"
  ) {
    return false;
  }
  if (!Array.isArray(body.bots)) return false;
  /*
   * OCR round 1 medium: a per-bot guard that stopped at `botId` and `runs.total` let a
   * row that lost `exports` (or any nested count the row renders) through to a
   * TypeError in AdminBotRow — exactly the silently-broken page this module promises
   * never to answer with. The checks below cover the fields the row reads; a record
   * this build has never heard a state of (byState keys) is claimed as all-numbers,
   * which is what every read of it does with it.
   */
  for (const bot of body.bots) {
    if (!isRecord(bot) || typeof bot.botId !== "string") return false;
    const runs = bot.runs;
    if (!isRecord(runs) || typeof runs.total !== "number") return false;
    // The runs row's sentences read the failed count ("2 failed"); the exports row's
    // read its four work states (the in-flight sum and both terminal counts).
    if (!isNumberRecord(runs.byState, ["failed"])) return false;
    if (typeof runs.pendingSync !== "number") return false;
    if (!isNullableNumber(runs.unboundUpstream)) return false;
    // R2-46's flag is a fact the row renders (R2fix F-1): the guard claims it
    // so a row that lost it is a non-answer, never an undefined guess.
    if (typeof runs.upstreamTruncated !== "boolean") return false;
    if (runs.usage !== null) {
      if (
        !isRecord(runs.usage) ||
        typeof runs.usage.providerReported !== "number" ||
        typeof runs.usage.unavailable !== "number"
      ) {
        return false;
      }
    }
    if (
      !isRecord(bot.experiments) ||
      typeof bot.experiments.draft !== "number" ||
      typeof bot.experiments.frozen !== "number"
    ) {
      return false;
    }
    const exports = bot.exports;
    if (
      !isRecord(exports) ||
      !isNumberRecord(exports.byState, [
        "queued",
        "running",
        "completed",
        "failed",
      ])
    ) {
      return false;
    }
    if (!isNullableString(exports.lastFailedErrorCode)) return false;
    if (
      !isRecord(bot.collection) ||
      !isNullableString(bot.collection.lastCollectedAt)
    ) {
      return false;
    }
  }
  return typeof body.botsTruncated === "boolean";
}

export function observationAdminSummaryQueryOptions(window: AdminTimeWindowId) {
  return queryOptions({
    queryKey: observationAdminKeys.summary(window),
    queryFn: async (): Promise<ObservationAdminSummaryScreen> => {
      const search = new URLSearchParams();
      const span =
        ADMIN_TIME_WINDOWS.find((preset) => preset.id === window)?.ms ?? null;
      if (span !== null) {
        const now = Date.now();
        search.set("timeFrom", new Date(now - span).toISOString());
        search.set("timeTo", new Date(now).toISOString());
      }
      const response = await tryClient(
        `/api/ai-observability/admin/summary?${search}`,
      );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        /*
         * 404 is the manage gate refusing to name a Bot this caller cannot manage — the
         * same refusal a stranger's probe hears. 401 means the session ended; the _authed
         * guard handles the redirect on the next navigation.
         */
        return { view: "fault", fault: "forbidden" };
      }
      if (!response.ok) {
        return { view: "fault", fault: "unavailable" };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      if (!isAdminSummaryBody(body)) {
        return { view: "fault", fault: "unavailable" };
      }
      return { view: "summary", result: body };
    },
    /*
     * Spec A6 (permission changes show up without a reload): this page has no
     * poll, and the app-wide QueryClient turns focus refetch off — without
     * this opt-in a role narrowed while the admin stays on the page keeps its
     * wider answer until the next navigation. The tab returning to the
     * foreground re-asks, and the next answer is the refusal.
     */
    refetchOnWindowFocus: true,
  });
}
