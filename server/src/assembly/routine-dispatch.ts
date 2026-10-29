import { getLogger } from "@openbot/shared/logger";
import { withUsageOrigin } from "../usage-origin";

/** What the dispatch route needs from the runner it fires. */
export interface RoutineDispatchRunner {
  run: (
    routineRunId: string,
    firing?: { firingKey: string },
  ) => unknown;
}

/** The structured logger surface this helper writes through. */
export interface RoutineDispatchLog {
  warn: (fields: unknown, message: string) => void;
}

/**
 * Fire-and-forget the dispatched routine run behind the route's 202 (#706 M-3).
 * `run()` never throws by contract, so the swallow only exists for the day that
 * contract breaks — and when it does, the log line is the one diagnostic thread
 * (the same best-effort-but-not-silent discipline as routine-dispatch-audit-
 * write-failed above the same route).
 */
export function fireRoutineDispatch(
  runner: RoutineDispatchRunner,
  routineRunId: string,
  firing?: { firingKey: string },
  log: RoutineDispatchLog = getLogger("server"),
): void {
  void withUsageOrigin("api", () =>
    Promise.resolve(runner.run(routineRunId, firing)),
  ).catch((error) => {
    log.warn(
      { type: "routine-dispatch-run-failed", error: String(error) },
      "routine-dispatch-run-failed",
    );
  });
}
