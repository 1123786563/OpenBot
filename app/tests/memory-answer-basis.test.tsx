import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryAnswerBasisSection } from "@/components/memory/answer-basis";
import { storeSelection } from "@/lib/enterprise/tenant/selection";
import { answerMemoryBasisOf } from "@/lib/hindsight/answer-basis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/**
 * The chat answer's own basis (FIX-W14, FR3-1 of #387): the id set an answer actually used,
 * carried on the answer, rendered under it, and expandable through the same evidence seam the
 * settings surface expands — re-decided against current authorization at expansion time.
 *
 * The three behaviors the fix brief pins: an answer with a basis renders the control; the
 * control opens the expansion (the ids it sends are exactly the answer's); an answer with no
 * ids renders nothing. The fetches ride the scope the screen holds (MT089's family, FR2-1),
 * so a stored company/team selection seeds the serving like every other memory test.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** What the evidence seam answers per id (#387): available in full, or unavailable, nothing else. */
let evidence: Record<string, Record<string, unknown>>;
/** Every request the surface made, with the headers it rode — the selection pair's evidence. */
let seen: { method: string; url: string; headers: Record<string, string> }[];
/** Every POST body, for asserting exactly which ids the expansion asked for. */
let posts: { url: string; body: unknown }[];

function serving() {
  seen = [];
  posts = [];
  window.localStorage.clear();
  storeSelection("user-1", { tenantId: "t1", workspaceId: "w1" });
  evidence = {
    p1: {
      state: "available",
      kind: "preference",
      id: "p1",
      content: "I prefer written summaries.",
      provenance: "You told a Bot",
      markedGenericAt: "2026-10-20T10:00:00Z",
      effectiveFrom: "2026-10-20T10:00:00Z",
      effectiveUntil: null,
      supersededBy: null,
      supersededTimeUnknown: false,
      correctedAt: null,
      actions: ["correct", "forget"],
    },
    // The revocation already landed: the seam answers unavailable, with no content to infer.
    s1: { state: "unavailable", id: "s1" },
    j1: {
      state: "available",
      kind: "derived_judgment",
      id: "j1",
      content: "Prefers written summaries over calls.",
      provenance: "Derived from your memories",
      scope: { kind: "general" },
      reviewState: "confirmed",
      reviewedAt: "2026-10-25T10:00:00Z",
      evidence: [],
      actions: ["forget"],
    },
  };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ method, url, headers });
    if (method !== "GET") posts.push({ url, body });
    if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
    if (url === "/api/hindsight/evidence") {
      return Response.json({
        evidence: body.ids.map(
          (id: string) => evidence[id] ?? { state: "unavailable", id },
        ),
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
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

/** One answer's carried set: a preference, a dead source-bound fact, and a judgment. */
const carried = [
  { id: "p1", kind: "general-preference" },
  { id: "s1", kind: "source-bound" },
  { id: "j1", kind: "derived-judgment" },
] as const;

test("an answer renders the control for the set it carried", async () => {
  serving();
  const view = draw(<MemoryAnswerBasisSection basis={carried} />);
  // The label names what the set is; the button is the one way in.
  expect(await view.findByText("Memories this answer used")).toBeTruthy();
  expect(view.getByRole("button", { name: "Show basis" })).toBeTruthy();
  // Nothing expands on its own: no evidence read before the person asks.
  expect(seen.filter((call) => call.url === "/api/hindsight/evidence")).toEqual(
    [],
  );
});

test("expanding sends exactly the answer's own ids on the scoped contract", async () => {
  serving();
  const view = draw(<MemoryAnswerBasisSection basis={carried} />);
  fireEvent.click(view.getByRole("button", { name: "Show basis" }));
  // The expansion asks for the ids the answer carried — the answer's own set, in order.
  await waitFor(() =>
    expect(posts).toContainEqual({
      url: "/api/hindsight/evidence",
      body: { ids: ["p1", "s1", "j1"] },
    }),
  );
  const call = seen.find((call) => call.url === "/api/hindsight/evidence");
  expect(call?.headers["x-openbot-tenant"]).toBe("t1");
  expect(call?.headers["x-openbot-workspace"]).toBe("w1");
  // The dialog expands what the person may see NOW: the living preference, the
  // judgment, and the dead source-bound fact as unavailable — never content.
  expect(await view.findByText("I prefer written summaries.")).toBeTruthy();
  expect(
    await view.findByText("Prefers written summaries over calls."),
  ).toBeTruthy();
  expect(await view.findByText("Unavailable")).toBeTruthy();
  expect(view.queryByText(/Shared a doc titled/)).toBeNull();
});

test("an answer with no ids renders no basis", async () => {
  serving();
  const view = draw(<MemoryAnswerBasisSection basis={[]} />);
  await settleReactWork();
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("button", { name: "Show basis" })).toBeNull();
});

describe("the wire reader", () => {
  const message = (metadata: unknown) =>
    ({ id: "a1", role: "assistant", content: "hi", metadata }) as never;

  test("reads the set the server stamped, kind-checked", () => {
    expect(
      answerMemoryBasisOf(
        message({
          openbot: {
            personalMemoryBasis: [
              { id: "p1", kind: "general-preference" },
              { id: "j1", kind: "derived-judgment" },
            ],
          },
        }),
      ),
    ).toEqual([
      { id: "p1", kind: "general-preference" },
      { id: "j1", kind: "derived-judgment" },
    ]);
  });

  test("refuses what it cannot vouch for, rather than drawing part of a basis", () => {
    expect(answerMemoryBasisOf(message(undefined))).toBeNull();
    expect(answerMemoryBasisOf(message({}))).toBeNull();
    expect(
      answerMemoryBasisOf(message({ openbot: { personalMemoryBasis: [] } })),
    ).toBeNull();
    // A kind this app does not know, a hole, a non-array — all null, never partial.
    expect(
      answerMemoryBasisOf(
        message({
          openbot: { personalMemoryBasis: [{ id: "p1", kind: "new" }] },
        }),
      ),
    ).toBeNull();
    expect(
      answerMemoryBasisOf(
        message({ openbot: { personalMemoryBasis: [null] } }),
      ),
    ).toBeNull();
    expect(
      answerMemoryBasisOf(message({ openbot: { personalMemoryBasis: "p1" } })),
    ).toBeNull();
  });
});
