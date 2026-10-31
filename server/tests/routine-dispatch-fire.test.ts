/*
 * #706 M-3: the routine dispatch route answers 202 and fires the run in the
 * background. `run()` never throws by contract, so the swallow behind the 202
 * exists only for the day that contract breaks — and when it does, the log
 * line it now writes is the one diagnostic thread. The behavior is tested on
 * the extracted helper (http.ts itself imports `hono/bun` and cannot load in
 * a Node test process — ADR 0008); the route's use of the helper is pinned
 * here from source, next to the behavior it guarantees.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  fireRoutineDispatch,
  type RoutineDispatchLog,
} from "../src/assembly/routine-dispatch";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
const HTTP_SOURCE = existsSync(join(hereDir, "../src/assembly/http.ts"))
  ? readFileSync(join(hereDir, "../src/assembly/http.ts"), "utf8")
  : "";

/** Captures warn calls the way the structured logger prints them. */
function captureLog(): { log: RoutineDispatchLog; warns: unknown[][] } {
  const warns: unknown[][] = [];
  return {
    log: { warn: (...args: unknown[]) => void warns.push(args) },
    warns,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("routine dispatch fire-and-forget (#706 M-3)", () => {
  test("a run() rejection behind the 202 is logged, not silent, and not an unhandled rejection", async () => {
    const { log, warns } = captureLog();
    const runner = {
      run: () => {
        throw new Error("run() contract broken");
      },
    };

    fireRoutineDispatch(runner, "run_1", undefined, log);
    await tick();

    expect(warns.length).toBe(1);
    const [fields, message] = warns[0] as [
      { type: string; error: string },
      string,
    ];
    expect(fields.type).toBe("routine-dispatch-run-failed");
    expect(fields.error).toContain("run() contract broken");
    expect(message).toBe("routine-dispatch-run-failed");
  });

  test("an async run() rejection is caught the same way", async () => {
    const { log, warns } = captureLog();
    const runner = {
      run: () => Promise.reject(new Error("async contract broken")),
    };

    fireRoutineDispatch(runner, "run_2", { firingKey: "offer-1" }, log);
    await tick();

    expect(warns.length).toBe(1);
    expect((warns[0] as [{ error: string }])[0].error).toContain(
      "async contract broken",
    );
  });

  test("a run that settles normally logs nothing", async () => {
    const { log, warns } = captureLog();
    const runner = { run: () => Promise.resolve({ done: true }) };

    fireRoutineDispatch(runner, "run_3", undefined, log);
    await tick();

    expect(warns).toEqual([]);
  });

  test("the dispatch route uses the helper instead of a silent .catch(() => {})", () => {
    expect(HTTP_SOURCE).toContain("fireRoutineDispatch(");
    expect(HTTP_SOURCE).not.toContain(".catch(() => {})");
  });
});
