import "./preload";
import {
  afterEach,
  describe,
  expect,
  spyOn,
  test,
} from "../../tests/support/bun-test-compat";
import {
  onComputerActivity,
  onComputerActivityWithdrawn,
  reportComputerActivity,
  withdrawComputerActivity,
  type Activity,
  type Withdrawal,
} from "../src/lib/copilot/computer-activity";
import { callComputer } from "../src/lib/computers/call";

/**
 * Which computer calls open the screen, and which refusals close it again.
 *
 * The old call announced everything: a file read opened the live screen on whatever page was
 * already there, a pane for an action nobody could see. And when a policy said no, the pane stayed
 * up, pointing at a thing that never happened. These pin the two halves of that fix: only the
 * browser's display actions announce at all, and only an explicit refusal — 403, which says so
 * before the browser is touched — takes back the announcement it made.
 */

const realFetch: typeof globalThis.fetch =
  globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;

function serverAnswering(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Fresh bot per test: the epoch counter is module state, so tests must not share one. */
let botCounter = 0;
function bot(): string {
  botCounter += 1;
  return `announce-bot-${botCounter}`;
}

let activities: Activity[] = [];
let withdrawals: Withdrawal[] = [];
const stoppers: (() => void)[] = [];

function listen(): void {
  stoppers.push(
    onComputerActivity((activity) => {
      activities.push(activity);
    }),
  );
  stoppers.push(
    onComputerActivityWithdrawn((withdrawal) => {
      withdrawals.push(withdrawal);
    }),
  );
}

/** Just the restore half: the spy's call assertions live in the epoch expectations, not here. */
let dateSpy: { mockRestore(): void } | null = null;

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  activities = [];
  withdrawals = [];
  if (dateSpy) {
    dateSpy.mockRestore();
    dateSpy = null;
  }
  globalThis.fetch = realFetch;
});

describe("which computer calls announce the screen", () => {
  test("file and shell calls reach the computer, not the display, and announce nothing", async () => {
    serverAnswering(200, {});
    listen();

    for (const path of [
      "/files/list",
      "/files/read",
      "/files/write",
      "/files/download",
      "/exec",
    ]) {
      const outcome = await callComputer(bot(), path, {
        method: "POST",
        body: {},
      });
      expect(outcome.ok).toBe(true);
    }

    expect(activities).toEqual([]);
  });

  test("a path the display has never heard of does not open it on a guess", async () => {
    serverAnswering(200, {});
    listen();

    // A control negotiation and a page read are real endpoints that are not display actions; a
    // made-up one stands for whatever a later version adds. None of them may announce.
    for (const path of ["/control/secret", "/read", "/snapshot", "/hover"]) {
      await callComputer(bot(), path, { method: "POST", body: {} });
    }

    expect(activities).toEqual([]);
  });

  test("the browser display actions announce, before the call so the screen opens while it runs", async () => {
    serverAnswering(200, {});
    listen();

    const displayPaths = ["/navigate", "/click", "/type", "/key", "/scroll"];
    const calledBots: string[] = [];
    for (const path of displayPaths) {
      const botId = bot();
      calledBots.push(botId);
      await callComputer(botId, path, { method: "POST", body: {} });
    }

    expect(activities.map((activity) => activity.botId)).toEqual(calledBots);
    // Each call is its own claim on the screen, or a refusal could not name the pane its call
    // opened.
    const announcements = activities.map((activity) => activity.announcement);
    expect(new Set(announcements).size).toBe(displayPaths.length);
  });

  test("every announcement is its own, so a refusal can name the one it means", async () => {
    serverAnswering(200, {});
    listen();

    const botId = bot();
    const first = reportComputerActivity(botId);
    const second = reportComputerActivity(botId);

    expect(first).not.toBe(second);
    expect(activities.map((activity) => activity.announcement)).toEqual([
      first,
      second,
    ]);
  });
});

describe("the announcement's epoch", () => {
  test("actions in quick succession are one run", () => {
    listen();

    const botId = bot();
    reportComputerActivity(botId);
    reportComputerActivity(botId);

    expect(activities).toHaveLength(2);
    expect(activities[0]?.epoch).toBe(activities[1]?.epoch);
  });

  test("a different Bot is always a new run", () => {
    listen();

    reportComputerActivity(bot());
    reportComputerActivity(bot());

    expect(activities).toHaveLength(2);
    expect(activities[1]!.epoch).toBeGreaterThan(activities[0]!.epoch);
  });

  test("silence longer than ten seconds is a new run, which is a heuristic and nothing more", () => {
    listen();

    let now = Date.now();
    dateSpy = spyOn(Date, "now").mockImplementation(() => now);

    const botId = bot();
    reportComputerActivity(botId);
    now += 11_000;
    reportComputerActivity(botId);

    expect(activities).toHaveLength(2);
    expect(activities[1]!.epoch).toBeGreaterThan(activities[0]!.epoch);
  });
});

describe("taking an announcement back", () => {
  test("a 403 refusal withdraws the announcement its own call made", async () => {
    serverAnswering(403, { error: "Not allowed here." });
    listen();

    const botId = bot();
    await callComputer(botId, "/click", { method: "POST" });

    // The pane saw exactly one announcement, and the withdrawal names that one.
    expect(activities).toHaveLength(1);
    expect(withdrawals).toEqual([
      { botId, announcement: activities[0]?.announcement },
    ]);
  });

  test("a refusal of a call that never announced withdraws nothing", async () => {
    serverAnswering(403, { error: "Not allowed here." });
    listen();

    await callComputer(bot(), "/files/write", { method: "POST", body: {} });

    expect(withdrawals).toEqual([]);
  });

  test("the network failing does not claim the action never happened", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    listen();

    const outcome = await callComputer(bot(), "/click", { method: "POST" });

    expect(outcome.ok).toBe(false);
    // The pane opened for the attempt, and keeps it: nobody knows what the computer did.
    expect(activities).toHaveLength(1);
    expect(withdrawals).toEqual([]);
  });

  test("a 500 does not either: the computer got the call and may have acted", async () => {
    serverAnswering(500, { error: "The computer broke." });
    listen();

    await callComputer(bot(), "/click", { method: "POST" });

    expect(activities).toHaveLength(1);
    expect(withdrawals).toEqual([]);
  });

  test("an abort is a stopped run, not an undone action", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    listen();

    const outcome = await callComputer(bot(), "/navigate", {
      method: "POST",
    });

    expect(outcome.stopped).toBe(true);
    expect(activities).toHaveLength(1);
    expect(withdrawals).toEqual([]);
  });

  test("a success keeps the screen it opened", async () => {
    serverAnswering(200, {});
    listen();

    await callComputer(bot(), "/navigate", { method: "POST", body: {} });

    expect(activities).toHaveLength(1);
    expect(withdrawals).toEqual([]);
  });
});

describe("withdrawal delivery", () => {
  test("a withdrawal names its Bot, and a listener can stop listening", () => {
    const seen: Withdrawal[] = [];
    const stop = onComputerActivityWithdrawn((withdrawal) => {
      seen.push(withdrawal);
    });

    const botId = bot();
    withdrawComputerActivity(botId, 7);
    stop();
    withdrawComputerActivity(botId, 8);

    expect(seen).toEqual([{ botId, announcement: 7 }]);
  });
});
