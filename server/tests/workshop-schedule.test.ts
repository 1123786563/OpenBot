import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  compileAdvanced,
  compileDaily,
  compileInterval,
  draftForCreate,
  nextRunAt,
  parsePreapproval,
  WorkshopScheduleRefusedError,
} from "../src/workshop/schedule";

/**
 * The compiler's contract: three modes, one output dialect (five-field cron in the rrule
 * column), refused inputs that never reach the database, and a next-run derivation the
 * executor can lean on. Pure functions throughout — no store, no clock but the one handed in.
 */
const TZ = "Asia/Shanghai";

describe("the schedule compiler (B17)", () => {
  test("interval mode maps every-unit shapes to stepped fields", () => {
    expect(compileInterval({ every: 30, unit: "minutes" })).toBe("*/30 * * * *");
    expect(compileInterval({ every: 6, unit: "hours" })).toBe("0 */6 * * *");
    expect(compileInterval({ every: 2, unit: "days" })).toBe("0 0 */2 * *");
  });

  test("daily mode maps a wall clock, and weekday lists spell themselves", () => {
    expect(compileDaily({ time: "09:30" })).toBe("30 9 * * *");
    expect(compileDaily({ time: "09:30", days: ["mon", "tue", "wed", "thu", "fri"] })).toBe(
      "30 9 * * mon,tue,wed,thu,fri",
    );
    expect(compileDaily({ time: "8:05", days: ["sun", "sat"] })).toBe("5 8 * * sun,sat");
    // All seven days is every day: the field collapses to *.
    expect(
      compileDaily({ time: "07:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }),
    ).toBe("0 7 * * *");
  });

  test("advanced mode passes a legal five-field cron through, validated", () => {
    expect(compileAdvanced("15 9 * * mon-fri", TZ)).toBe("15 9 * * mon-fri");
  });

  test("illegal inputs are refused, each with a sentence", () => {
    expect(() => compileInterval({ every: 0, unit: "minutes" })).toThrow(WorkshopScheduleRefusedError);
    expect(() => compileInterval({ every: 3.7, unit: "hours" })).toThrow(WorkshopScheduleRefusedError);
    expect(() => compileDaily({ time: "25:00" })).toThrow(WorkshopScheduleRefusedError);
    expect(() => compileDaily({ time: "0900" })).toThrow(WorkshopScheduleRefusedError);
    expect(() => compileAdvanced("*/10 * * * * *", TZ)).toThrow(WorkshopScheduleRefusedError); // six fields
    expect(() => nextRunAt("* * * * *", TZ, Date.now())).toThrow(WorkshopScheduleRefusedError); // sub-minute is impossible anyway
    expect(() => nextRunAt("0 9 * * mon", "Not/AZone", Date.now())).toThrow(WorkshopScheduleRefusedError);
  });

  test("nextRunAt derives the next firing, strictly after the from moment", () => {
    // 08:00 UTC is 16:00 Shanghai: the same day's 09:30 already passed, so the next firing
    // is tomorrow's 09:30 Shanghai = 01:30 UTC on June 2nd.
    const from = new Date("2026-06-01T08:00:00Z").getTime();
    const next = nextRunAt("30 9 * * *", TZ, from);
    expect(next.toISOString()).toBe("2026-06-02T01:30:00.000Z");
    // Asked AT the firing moment: tomorrow's, not today's again.
    const again = nextRunAt("30 9 * * *", TZ, next.getTime());
    expect(again.getTime()).toBeGreaterThan(next.getTime());
  });

  test("the workshop floor is one minute, not routines' fifteen", () => {
    // Every two minutes is legal here (routines would refuse it)...
    expect(() => nextRunAt("*/2 * * * *", TZ, Date.now())).not.toThrow();
    // ...and nothing denser than a minute exists to refuse.
  });

  test("the preapproval shape is clamped, never trusted", () => {
    expect(parsePreapproval(undefined)).toEqual({ paths: [], tools: [], maxTurnsPerRun: 3 });
    expect(
      parsePreapproval({ paths: ["out/", "", 7], tools: ["python"], maxTurnsPerRun: 99 }),
    ).toEqual({ paths: ["out/"], tools: ["python"], maxTurnsPerRun: 20 });
    expect(parsePreapproval({ maxTurnsPerRun: 0 })).toMatchObject({ maxTurnsPerRun: 1 });
  });

  test("a draft compiles its mode and validates its recurrence before the store sees it", () => {
    const draft = draftForCreate({
      prompt: "  每天早晨跑一遍数据  ",
      mode: { kind: "daily", time: "09:00" },
      timezone: TZ,
      preapproval: { tools: ["python"] },
    });
    expect(draft.prompt).toBe("每天早晨跑一遍数据");
    expect(draft.rrule).toBe("0 9 * * *");
    expect(draft.status).toBe("enabled");
    expect(draft.preapproval).toEqual({ paths: [], tools: ["python"], maxTurnsPerRun: 3 });
    expect(() =>
      draftForCreate({ prompt: "", mode: { kind: "daily", time: "09:00" }, timezone: TZ }),
    ).toThrow(WorkshopScheduleRefusedError);
    expect(() =>
      draftForCreate({
        prompt: "x",
        mode: { kind: "advanced", cron: "not cron at all" },
        timezone: TZ,
      }),
    ).toThrow(WorkshopScheduleRefusedError);
  });
});
