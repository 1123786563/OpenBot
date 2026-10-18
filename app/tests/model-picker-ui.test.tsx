import "./preload";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ModelPicker } from "@/components/settings/model-picker";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Model access → Workbench model picker (Bifrost 03.10, #232, AC09/AC19).
 *
 * The picker consumes exactly the display contract `GET /api/model-selection`
 * answers — the selectable refs with the price status the snapshot holds, and
 * the effective resolution with the layer it came from. What these tests pin:
 *
 * - the three source layers render by name, so a person can see where the
 *   current model came from (global default / Bot default / conversation);
 * - a selection that is no longer offerable is reported with its exact closed
 *   reason and a re-selection prompt — and is NEVER replaced: the stored ref
 *   stays on screen as the current selection, no other model is marked
 *   current, and the list does not quietly re-point at a substitute;
 * - prices render exactly as the snapshot classifies them: a `free` model
 *   reads Free, a `known` model reads Priced, and an unknown price never
 *   reads as free — not in the list, not on an excluded selection;
 * - the write goes out as {scope, ref} and nothing else, a refused write
 *   shows the server's refusal sentence and changes nothing on screen, and
 *   a failed load is an honest error rather than an invented selection.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const CHAT = { provider: "prefco", model: "pref-chat", capability: "chat" };
const MINI = {
  provider: "prefco",
  model: "pref-chat-mini",
  capability: "chat",
};
const OTHER = { provider: "prefco", model: "pref-vision", capability: "image" };

type Payload = {
  bot: { botId: string; displayName: string };
  selectable: { ref: typeof CHAT; priceStatus: string }[];
  effective: Record<string, unknown>;
};

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    bot: { botId: "openbot-workbench", displayName: "OpenBot Workbench" },
    selectable: [
      { ref: CHAT, priceStatus: "known" },
      { ref: MINI, priceStatus: "free" },
    ],
    effective: {
      status: "resolved",
      ref: CHAT,
      source: "bot",
      available: true,
    },
    ...overrides,
  };
}

let current: Payload;
let writes: unknown[];
/** What a PUT answers, when the test wants the server to refuse. */
let putAnswer: Record<string, unknown> | null;

function serving(initial: Payload) {
  current = initial;
  writes = [];
  putAnswer = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/model-selection") {
      return Response.json(current);
    }
    if (method === "PUT" && url === "/api/model-selection/preference") {
      writes.push(JSON.parse(String(init?.body)));
      if (putAnswer) return Response.json(putAnswer);
      return Response.json({
        ok: true,
        record: {
          userId: "picker-person",
          scope: "global",
          botId: "",
          conversationId: "",
          ref: CHAT,
          updatedAt: "2026-10-17T00:00:00.000Z",
        },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("the picker lists the selectable models with the price label the snapshot reports, and an unset state says so", async () => {
  serving(payload({ effective: { status: "unset" } }));
  const view = draw(<ModelPicker />);

  const chatRow = (await view.findByText("pref-chat")).closest(
    '[data-slot="item"]',
  );
  const miniRow = view
    .getByText("pref-chat-mini")
    .closest('[data-slot="item"]');
  expect(chatRow?.textContent).toContain("Priced");
  expect(chatRow?.textContent).not.toContain("Free");
  expect(miniRow?.textContent).toContain("Free");

  // Nothing is selected: the honest sentence, not an invented default.
  expect(view.getByText(/No model selected/)).toBeTruthy();
  expect(view.queryByText(/Current/)).toBeNull();
});

test("the effective selection names the layer it came from, for each of the three layers", async () => {
  const sources: [string, RegExp][] = [
    ["global", /Your global default/],
    ["bot", /Workbench Bot default/],
    ["conversation", /This conversation/],
  ];
  for (const [source, label] of sources) {
    serving(
      payload({
        effective: { status: "resolved", ref: CHAT, source, available: true },
      }),
    );
    const view = draw(<ModelPicker />);
    await view.findByText("pref-chat");
    expect(view.getByText(label)).toBeTruthy();
    // The loop renders one picker per layer; clear the document between
    // iterations so the next getByText answers this view, not the last one's.
    cleanup();
  }
});

test("an unavailable selection shows its exact reason and a re-selection prompt — the stored model stays, nothing is substituted", async () => {
  serving(
    payload({
      selectable: [{ ref: MINI, priceStatus: "known" }],
      effective: {
        status: "resolved",
        ref: CHAT,
        source: "conversation",
        available: false,
        unavailableReasonCode: "model_not_open",
      },
    }),
  );
  const view = draw(<ModelPicker />);

  // The error names the exact closed reason and asks for a re-selection.
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("not open");
  expect(alert.textContent).toMatch(/[Pp]ick|choose|select/i);

  // The stored model is still the current selection, provider and all — the
  // verdict rides the stored ref, it never swaps in another model.
  const effectiveCard = view.getByText(/Current/).closest('[data-slot="item"]');
  expect(effectiveCard?.textContent).toContain("pref-chat");
  expect(effectiveCard?.textContent).toContain("prefco");
  expect(effectiveCard?.textContent).toContain("conversation");
  expect(effectiveCard?.textContent).not.toContain("pref-chat-mini");

  // And no offered model is marked current: the substitute is not pre-chosen.
  const miniRow = view
    .getByText("pref-chat-mini")
    .closest('[data-slot="item"]');
  expect(miniRow?.textContent).not.toContain("Current");
});

test("a delisted model reports model_not_in_catalog with its own sentence", async () => {
  serving(
    payload({
      selectable: [{ ref: MINI, priceStatus: "known" }],
      effective: {
        status: "resolved",
        ref: CHAT,
        source: "global",
        available: false,
        unavailableReasonCode: "model_not_in_catalog",
      },
    }),
  );
  const view = draw(<ModelPicker />);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toMatch(
    /removed from the catalog|not in the catalog/i,
  );
  // The delisted ref still reads as the current selection.
  expect(alert.textContent).toContain("pref-chat");
});

test("an unknown price never reads as free — not in the list, not on the excluded selection", async () => {
  // A selectable entry annotated `unknown` (a concurrent catalog change) renders
  // its unknown status, never the free label.
  serving(
    payload({
      selectable: [{ ref: OTHER, priceStatus: "unknown" }],
      effective: { status: "unset" },
    }),
  );
  const view = draw(<ModelPicker />);
  const otherRow = (await view.findByText("pref-vision")).closest(
    '[data-slot="item"]',
  );
  expect(otherRow?.textContent).toContain("Price unknown");
  expect(otherRow?.textContent).not.toContain("Free");
  cleanup();

  // And a selection excluded for an unknown price says exactly that.
  serving(
    payload({
      selectable: [{ ref: MINI, priceStatus: "known" }],
      effective: {
        status: "resolved",
        ref: CHAT,
        source: "bot",
        available: false,
        unavailableReasonCode: "model_price_unknown",
      },
    }),
  );
  const second = draw(<ModelPicker />);
  const alert = await second.findByRole("alert");
  expect(alert.textContent).toMatch(/price is unknown/i);
  expect(alert.textContent).not.toContain("Free");
});

test("choosing a model writes {scope, ref} and shows the server's new truth with its layer", async () => {
  serving(payload({ effective: { status: "unset" } }));
  // The server flips its answer once the write lands.
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/model-selection") {
      return Response.json(
        writes.length > 0
          ? payload({
              effective: {
                status: "resolved",
                ref: CHAT,
                source: "global",
                available: true,
              },
            })
          : current,
      );
    }
    if (method === "PUT" && url === "/api/model-selection/preference") {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, record: {} });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch;

  const view = draw(<ModelPicker />);
  const chatRow = (await view.findByText("pref-chat")).closest(
    '[data-slot="item"]',
  );
  expect(chatRow).toBeTruthy();
  fireEvent.click(
    within(chatRow as HTMLElement).getByRole("button", {
      name: /Set as global default/,
    }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  // The write carries exactly the scope and the ref — no user, no client-side truth.
  expect(writes[0]).toEqual({ scope: "global", ref: CHAT });

  // After the server answers, the read comes back and the screen shows the
  // new selection with the layer it now comes from.
  await view.findByText(/Your global default/);
});

test("a refused write shows the server's refusal and changes nothing on screen", async () => {
  serving(payload({ effective: { status: "unset" } }));
  putAnswer = {
    ok: false,
    reasonCode: "model_preference_ref_not_selectable",
    detail: "model_price_unknown",
  };
  const view = draw(<ModelPicker />);

  const chatRow = (await view.findByText("pref-chat")).closest(
    '[data-slot="item"]',
  );
  fireEvent.click(
    within(chatRow as HTMLElement).getByRole("button", {
      name: /Set as global default/,
    }),
  );

  await waitFor(() => expect(writes).toHaveLength(1));
  const alerts = await view.findAllByRole("alert");
  // The refusal is said out loud, with its detail reason.
  expect(
    alerts.some((node) =>
      /not selectable|not saved/i.test(node.textContent ?? ""),
    ),
  ).toBe(true);
  expect(
    alerts.some((node) => /price is unknown/i.test(node.textContent ?? "")),
  ).toBe(true);

  // And the screen still says nothing is selected — a refusal changed nothing.
  expect(view.getByText(/No model selected/)).toBeTruthy();
  expect(view.queryByText(/Current/)).toBeNull();
});

test("a failed load is an honest error, not an invented list or selection", async () => {
  global.fetch = (async () =>
    Response.json(
      {
        error: "Model selection is not available.",
        code: "model_selection_unavailable",
      },
      { status: 503 },
    )) as unknown as typeof fetch;
  const view = draw(<ModelPicker />);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Model selection is not available.");
  expect(view.queryByText("pref-chat")).toBeNull();
  expect(view.queryByText(/No model selected/)).toBeNull();
});
