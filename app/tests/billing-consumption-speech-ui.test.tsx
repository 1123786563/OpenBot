import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ConsumptionTable } from "@/components/billing/consumption-table";
import type { CreditConsumptionEntry } from "@/lib/billing/credits";
import i18n from "@/lib/i18n";
/*
 * The runner comes straight from bun:test — the door the sibling realtime-usage-ui suite
 * uses, because the e2e-compat runner cannot collect app suites in this worktree. No
 * module stubs are needed: ConsumptionTable renders no dialog and talks to no network
 * (the entries arrive as props), so the harness is happy-dom, i18n and nothing else.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  void i18n.changeLanguage("en");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const baseEntry: CreditConsumptionEntry = {
  id: "row",
  title: "settle speech provider/model",
  requestId: null,
  credits: 1.4,
  applied: 1.4,
  model: "tts",
  client: null,
  botId: null,
  botName: null,
  timestamp: "2026-10-15T10:00:00.000Z",
};

function renderTable(entries: CreditConsumptionEntry[]) {
  return render(
    <ConsumptionTable
      entries={entries}
      pagination={{
        totalCount: entries.length,
        totalPages: 1,
        currentPage: 1,
        nextPage: null,
      }}
      range="7d"
      onRangeChange={() => {}}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
}

/*
 * 13.2's AC4: the user's consumption detail shows the speech line's characters, seconds
 * and tier — distinguishable from every other capability's row, said in the reader's own
 * language. A row whose settlement wrote no speech line looks exactly as it always has.
 */
test("语音行显示字符、时长与档位，无明细的行保持原样", async () => {
  /* zh-CN is this test's language; the assertions are written against it. */
  await i18n.changeLanguage("zh-CN");
  const speechTiered: CreditConsumptionEntry = {
    ...baseEntry,
    id: "row-tiered",
    lineDetail: {
      capability: "speech",
      speech: {
        inputCharacters: 100,
        voiceTier: "alloy",
        cappedSeconds: 60,
        actualSeconds: "25",
      },
    },
  };
  const speechUntiered: CreditConsumptionEntry = {
    ...baseEntry,
    id: "row-untiered",
    lineDetail: {
      capability: "speech",
      speech: {
        inputCharacters: 80,
        voiceTier: null,
        cappedSeconds: 60,
        actualSeconds: "12.5",
      },
    },
  };
  const plain: CreditConsumptionEntry = { ...baseEntry, id: "row-plain" };
  const view = renderTable([speechTiered, speechUntiered, plain]);

  expect(view.getByText(/语音 100 字符 · 25 秒 · alloy/)).toBeTruthy();
  expect(view.getByText(/语音 80 字符 · 12\.5 秒/)).toBeTruthy();
  expect(view.queryByText(/语音 80 字符 · 12\.5 秒 · /)).toBeNull();
  // No raw key path and no second speech line on the plain row.
  expect(view.container.textContent).not.toContain("{{");
  expect(view.queryAllByText(/语音 /)).toHaveLength(2);
});
