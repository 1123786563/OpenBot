import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook } from "@testing-library/react";
import {
  reportComputerActivity,
  withdrawComputerActivity,
} from "../src/lib/copilot/computer-activity";
import { useAutoWatchScreen } from "../src/components/computer/use-auto-watch-screen";

/**
 * The live screen opening itself beside a conversation, and closing again when the call that
 * opened it turns out to have been refused.
 *
 * The pane belongs to the person first: it does not open over something they asked for, it does
 * not reopen while they watch, and a run they closed stays closed for the rest of that run. Only
 * the pane this hook opened may be closed by a withdrawal — a pane the person opened has no
 * announcement to be withdrawn against.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** Fresh bot per test: the epoch counter is module state, so tests must not share one. */
let botCounter = 0;
function bot(): string {
  botCounter += 1;
  return `watch-bot-${botCounter}`;
}

function renderAutoWatch(
  initial: { botId?: string; watching?: boolean; busy?: boolean } = {},
) {
  const calls = { open: 0, close: 0 };
  let current = {
    botId: initial.botId,
    watching: initial.watching ?? false,
    busy: initial.busy ?? false,
  };
  const view = renderHook(
    (props: { botId: string | undefined; watching: boolean; busy: boolean }) =>
      useAutoWatchScreen({
        botId: props.botId,
        watching: props.watching,
        busy: props.busy,
        open: () => {
          calls.open += 1;
        },
        close: () => {
          calls.close += 1;
        },
      }),
    { initialProps: current },
  );
  return {
    calls,
    result: view.result,
    update(next: { botId?: string; watching?: boolean; busy?: boolean }) {
      current = {
        botId: next.botId ?? current.botId,
        watching: next.watching ?? current.watching,
        busy: next.busy ?? current.busy,
      };
      view.rerender(current);
    },
    unmount: view.unmount,
  };
}

describe("which activity opens the pane", () => {
  test("the watched Bot's announcement opens the pane", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(1);
  });

  test("another Bot's announcement opens nothing", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    reportComputerActivity(bot());

    expect(watch.calls.open).toBe(0);
  });

  test("no Bot to watch, nothing to open", () => {
    const watch = renderAutoWatch({ botId: undefined });

    reportComputerActivity(bot());

    expect(watch.calls.open).toBe(0);
  });
});

describe("the person's pane comes first", () => {
  test("a pane the person is using is not taken over, though the run is still tracked", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId, busy: true });

    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(0);
  });

  test("a pane already showing the screen is not reopened", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId, watching: true });

    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(0);
  });

  test("a run the person closed stays closed for the rest of that run", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    reportComputerActivity(botId);
    expect(watch.calls.open).toBe(1);
    watch.result.current.dismiss();
    // A second announcement within the ten-second quiet gap is the same run.
    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(1);
  });

  test("the next run may open again", () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const botId = bot();
      const watch = renderAutoWatch({ botId });

      reportComputerActivity(botId);
      expect(watch.calls.open).toBe(1);
      watch.result.current.dismiss();
      now += 11_000;
      reportComputerActivity(botId);

      expect(watch.calls.open).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("opening one pane must clear the others' URL flags, which is the route's open callback", () => {
    // Asserted in the route by composition; here the hook only promises it calls `open` once per
    // run it opens, never repeatedly while the pane is up.
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    reportComputerActivity(botId);
    watch.update({ watching: true });
    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(1);
  });
});

describe("closing the pane again", () => {
  test("a withdrawal for the announcement this pane opened for closes it", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    const announcement = reportComputerActivity(botId);
    expect(watch.calls.open).toBe(1);
    withdrawComputerActivity(botId, announcement);

    expect(watch.calls.close).toBe(1);
  });

  test("a withdrawal for some other announcement leaves the pane alone", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    const announcement = reportComputerActivity(botId);
    withdrawComputerActivity(botId, announcement + 999);

    expect(watch.calls.close).toBe(0);

    withdrawComputerActivity(botId, announcement);
    expect(watch.calls.close).toBe(1);
  });

  test("another Bot's withdrawal closes nothing", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    const announcement = reportComputerActivity(botId);
    withdrawComputerActivity(bot(), announcement);

    expect(watch.calls.close).toBe(0);
  });

  test("a pane the person closed themselves is not closed twice by a late withdrawal", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    const announcement = reportComputerActivity(botId);
    watch.result.current.dismiss();
    withdrawComputerActivity(botId, announcement);

    expect(watch.calls.close).toBe(0);
  });
});

describe("changing scope", () => {
  test("after the hook follows a new Bot, the old Bot's announcements open nothing", () => {
    const first = bot();
    const second = bot();
    const watch = renderAutoWatch({ botId: first });

    watch.update({ botId: second });
    reportComputerActivity(first);
    expect(watch.calls.open).toBe(0);

    reportComputerActivity(second);
    expect(watch.calls.open).toBe(1);
  });

  test("the old Bot's late withdrawal closes nothing the new Bot has open", () => {
    const first = bot();
    const second = bot();
    const watch = renderAutoWatch({ botId: second });

    const staleAnnouncement = reportComputerActivity(first);
    const announcement = reportComputerActivity(second);
    expect(watch.calls.open).toBe(1);

    withdrawComputerActivity(first, staleAnnouncement);
    expect(watch.calls.close).toBe(0);

    withdrawComputerActivity(second, announcement);
    expect(watch.calls.close).toBe(1);
  });

  test("unmounting stops listening: a late announcement opens nothing", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    watch.unmount();
    reportComputerActivity(botId);

    expect(watch.calls.open).toBe(0);
  });

  test("unmounting stops withdrawal delivery too", () => {
    const botId = bot();
    const watch = renderAutoWatch({ botId });

    const announcement = reportComputerActivity(botId);
    watch.unmount();
    withdrawComputerActivity(botId, announcement);

    expect(watch.calls.close).toBe(0);
  });
});
