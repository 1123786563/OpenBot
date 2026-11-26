import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/** Typed observer fixture: tests drive browser intersection reports, never fake DOM rendering. */
class ResultObserver implements IntersectionObserver {
  static readonly observers = new Set<ResultObserver>();
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    ResultObserver.observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    ResultObserver.observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(target: Element, visible: boolean, area = visible ? 10 : 0) {
    this.callback(
      [
        {
          target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: new DOMRect(0, 0, area, area),
          rootBounds: null,
          time: performance.now(),
        },
      ],
      this,
    );
  }
}

let originalObserver: typeof IntersectionObserver;
const originalFetch = globalThis.fetch;
let requests: {
  kind: string;
  threadId: string;
  messageId: string;
  surface: string;
}[] = [];
let status = 204;
let requestResponse: (() => Promise<Response>) | undefined;
let sequence = 0;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = ResultObserver;
});
beforeEach(() => {
  requests = [];
  status = 204;
  requestResponse = undefined;
  visibility("visible");
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/telemetry/product-events") {
        requests.push(JSON.parse(String(init?.body)));
        return requestResponse
          ? requestResponse()
          : new Response(null, { status });
      }
      return Response.json({
        version: "fixture",
        agents: {},
        mode: "sse",
        telemetryDisabled: true,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  ResultObserver.observers.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
function intersect(visible = true, area = visible ? 10 : 0) {
  for (const observer of ResultObserver.observers) {
    for (const target of observer.targets) observer.fire(target, visible, area);
  }
}
function fixture() {
  const id = `result-${++sequence}`;
  const threadId = `thread-${sequence}`;
  const messages: Message[] = [
    { id: "person", role: "user", content: "Show the result" },
    { id, role: "assistant", content: "This is the completed answer." },
  ];
  return { id, threadId, messages };
}
function channel(initiallyRunning = false) {
  const data = fixture();
  const element = (busy = initiallyRunning, messages = data.messages) => (
    <ChatTranscript busy={busy} messages={messages} threadId={data.threadId} />
  );
  const view = render(element());
  expect(view.container.textContent).toContain("This is the completed answer.");
  return { ...data, view, element };
}
async function flush() {
  await act(async () => {});
}

test("a rendered channel answer records only after it intersects the visible document", async () => {
  const { id, threadId } = channel();
  expect(requests).toHaveLength(0);
  intersect(false);
  await flush();
  expect(requests).toHaveLength(0);
  intersect();
  await flush();
  expect(requests).toEqual([
    { kind: "result_viewed", threadId, messageId: id, surface: "web" },
  ]);
});

test("a background delivery records no view until the person returns to the visible answer", async () => {
  visibility("hidden");
  channel();
  intersect();
  await flush();
  expect(requests).toHaveLength(0);
  visibility("visible");
  await flush();
  expect(requests).toHaveLength(1);
});

test("one mounted answer sends once; remounts keep the same observed identifiers", async () => {
  let finish: (response: Response) => void = () => {
    throw new Error("No pending request");
  };
  requestResponse = () =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    });
  const { view, element } = channel();
  intersect();
  for (let i = 0; i < 5; i++) {
    view.rerender(element());
    intersect();
  }
  expect(requests).toHaveLength(1);
  finish(new Response(null, { status: 204 }));
  await flush();
  view.unmount();
  requestResponse = undefined;
  render(element());
  intersect();
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("streaming text waits until the final answer is settled", async () => {
  const data = fixture();
  const view = render(
    <ChatTranscript busy messages={data.messages} threadId={data.threadId} />,
  );
  intersect();
  await flush();
  expect(requests).toHaveLength(0);
  view.rerender(
    <ChatTranscript messages={data.messages} threadId={data.threadId} />,
  );
  intersect();
  await flush();
  expect(requests).toHaveLength(1);
});

test("a failed telemetry POST remains best effort without automatic retries", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  status = 503;
  const { view, element } = channel();
  intersect();
  await flush();
  for (let i = 0; i < 5; i++) {
    view.rerender(element());
    intersect();
  }
  expect(requests).toHaveLength(1);
  await act(async () => {
    await Bun.sleep(1100);
  });
  expect(requests).toHaveLength(1);
  expect(warn.mock.calls).toEqual([
    ["Result telemetry was not accepted.", 503],
  ]);
  warn.mockRestore();
});

test("a transcript without a thread ID never invents result linkage", async () => {
  const { messages } = fixture();
  render(<ChatTranscript messages={messages} />);
  intersect();
  await flush();
  expect(requests).toHaveLength(0);
});

test("earlier prose in the current turn waits for the run to finish too", async () => {
  const data = fixture();
  const messages: Message[] = [
    ...data.messages,
    {
      id: `${data.id}-final`,
      role: "assistant",
      content: "A second part of the answer.",
    },
  ];
  const view = render(
    <ChatTranscript busy messages={messages} threadId={data.threadId} />,
  );
  intersect();
  await flush();
  expect(requests).toHaveLength(0);
  view.rerender(
    <ChatTranscript messages={messages} threadId={data.threadId} />,
  );
  intersect();
  await flush();
  expect(requests).toHaveLength(2);
});

test("results wait for completion and then observe the final run rerender", async () => {
  const { view, element } = channel(true);
  intersect();
  await flush();
  expect(requests).toHaveLength(0);
  view.rerender(element(false));
  intersect();
  await flush();
  expect(requests).toHaveLength(1);
});

test("previous results remain observable while a new human turn is running", async () => {
  const { view, element, messages, id } = channel(true);
  view.rerender(
    element(true, [
      ...messages,
      { id: "next-human", role: "user", content: "Another question" },
      { id: "next-answer", role: "assistant", content: "Still working" },
    ]),
  );
  intersect();
  await flush();
  expect(requests.map((event) => event.messageId)).toEqual([id]);
});

test("an edge-touching or zero-area body is not an actually visible result", async () => {
  channel();
  intersect(true, 0);
  await flush();
  expect(requests).toHaveLength(0);
  intersect();
  await flush();
  expect(requests).toHaveLength(1);
});

test("one mounted answer remains deduplicated when a continuation toggles readiness", async () => {
  const { view, element } = channel();
  intersect();
  await flush();
  view.rerender(element(true));
  view.rerender(element(false));
  intersect();
  await flush();
  expect(requests).toHaveLength(1);
});
