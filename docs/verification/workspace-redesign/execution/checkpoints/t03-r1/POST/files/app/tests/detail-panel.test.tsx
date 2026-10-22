import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { ScheduledTaskEditor } from "@/components/craft/scheduled-task-editor";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Sidebar, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";

class Observer implements ResizeObserver {
  static targets = new Map<Element, Observer>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Observer.targets.set(target, this);
  }
  unobserve(target: Element) {
    Observer.targets.delete(target);
  }
  disconnect() {
    for (const [target, observer] of Observer.targets) {
      if (observer === this) Observer.targets.delete(target);
    }
  }
  resize(target: Element, width: number) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, 640),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}
let originalObserver: typeof ResizeObserver;
beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
});
afterEach(() => {
  cleanup();
  Observer.targets.clear();
});
afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();
});

async function resize(container: HTMLElement, width: number) {
  const target = container.firstElementChild;
  if (!target) throw new Error("Panel root missing");
  await act(async () => {
    Observer.targets.get(target)?.resize(target, width);
  });
}

test("narrow container overlays details without remounting the chat draft", async () => {
  let mounts = 0;
  function Chat() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <textarea aria-label="Draft" defaultValue="Keep this draft" />;
  }
  const view = render(
    <DetailPanel
      open
      title="Computer"
      onClose={() => {}}
      detail={<p>Browser preview</p>}
    >
      <Chat />
    </DetailPanel>,
  );
  await resize(view.container, 560);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  const draft = view.getByDisplayValue("Keep this draft");
  await resize(view.container, 1000);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(view.getByText("Browser preview")).toBeTruthy();
  expect(view.getByDisplayValue("Keep this draft")).toBe(draft);
  await resize(view.container, 560);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  expect(mounts).toBe(1);
});

test("closing narrow details invokes the owner and unmounts detail work", async () => {
  let closed = 0;
  const props = {
    title: "Computer",
    onClose: () => {
      closed += 1;
    },
    detail: <p>Browser preview</p>,
    children: <p>Chat</p>,
  };
  const view = render(<DetailPanel {...props} open />);
  await resize(view.container, 380);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(closed).toBe(1);
  view.rerender(<DetailPanel {...props} open={false} />);
  await waitFor(() => expect(view.queryByText("Browser preview")).toBeNull());
});

test("caller-owned detail draft value and dirty state survive a breakpoint round trip", async () => {
  let closes = 0;
  function DraftOwner() {
    const [value, setValue] = useState("unsaved");
    const [dirty, setDirty] = useState(false);
    return (
      <DetailPanel
        open
        onClose={() => {
          closes += 1;
        }}
        title="Editor"
        detailWidth={480}
        detail={
          <div data-dirty={dirty}>
            <textarea aria-label="Local draft" readOnly value={value} />
            <button
              onClick={() => {
                setValue("edited locally");
                setDirty(true);
              }}
              type="button"
            >
              Edit draft
            </button>
          </div>
        }
      >
        <p>Main content</p>
      </DetailPanel>
    );
  }
  const view = render(<DraftOwner />);
  await resize(view.container, 960);
  fireEvent.click(view.getByRole("button", { name: "Edit draft" }));
  expect(
    (view.getByRole("textbox", { name: "Local draft" }) as HTMLTextAreaElement)
      .value,
  ).toBe("edited locally");
  await resize(view.container, 959);
  expect(await view.findByRole("dialog", { name: "Editor" })).toBeTruthy();
  await resize(view.container, 960);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(
    (view.getByRole("textbox", { name: "Local draft" }) as HTMLTextAreaElement)
      .value,
  ).toBe("edited locally");
  expect(
    view.getByText(
      (_text, element) => element?.getAttribute("data-dirty") === "true",
    ),
  ).toBeTruthy();
  expect(closes).toBe(0);
});

test("sidebar shell preserves preference on responsive changes and writes explicit toggles", async () => {
  window.localStorage.clear();
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const originalSetItem = Storage.prototype.setItem;
  const writes: Array<[string, string]> = [];
  Storage.prototype.setItem = function (key: string, value: string) {
    writes.push([key, value]);
    originalSetItem.call(this, key, value);
  };
  function State() {
    const sidebar = useSidebar();
    return (
      <>
        <output>
          {sidebar.isMobile
            ? `mobile:${sidebar.openMobile}`
            : sidebar.open
              ? "open"
              : "closed"}
        </output>
        <button onClick={() => sidebar.setOpen(false)} type="button">
          Collapse preference
        </button>
        <button onClick={sidebar.toggleSidebar} type="button">
          Toggle mobile
        </button>
      </>
    );
  }
  try {
    const view = render(
      <SidebarShell width="280px">
        <Sidebar collapsible="icon">
          <p>Navigation</p>
        </Sidebar>
        <State />
        <SidebarTrigger />
      </SidebarShell>,
    );
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /toggle sidebar/i }),
      ).toBeTruthy(),
    );
    const wrapper = view.container.querySelector<HTMLElement>(
      "[data-slot='sidebar-wrapper']",
    );
    expect(wrapper?.style.getPropertyValue("--sidebar-width-icon")).toBe(
      "64px",
    );
    expect(writes).toEqual([]);
    view.rerender(
      <SidebarShell width="280px" responsiveCompact>
        <Sidebar collapsible="icon">
          <p>Navigation</p>
        </Sidebar>
        <State />
        <SidebarTrigger />
      </SidebarShell>,
    );
    expect(writes).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    fireEvent.click(view.getByRole("button", { name: "Collapse preference" }));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toBe("collapsed");
  } finally {
    Storage.prototype.setItem = originalSetItem;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalWidth,
    });
  }
});

test("mobile sidebar toggle changes only the sheet state", async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 500,
  });
  const originalSetItem = Storage.prototype.setItem;
  const writes: string[] = [];
  Storage.prototype.setItem = function (key, value) {
    writes.push(key);
    originalSetItem.call(this, key, value);
  };
  function MobileState() {
    const sidebar = useSidebar();
    return (
      <>
        <output>{sidebar.open ? "desktop-open" : "desktop-closed"}</output>
        <output>{sidebar.openMobile ? "mobile-open" : "mobile-closed"}</output>
        <button onClick={sidebar.toggleSidebar} type="button">
          Toggle mobile
        </button>
      </>
    );
  }
  try {
    const view = render(
      <SidebarShell width="280px">
        <Sidebar collapsible="icon">
          <p>Navigation</p>
        </Sidebar>
        <MobileState />
      </SidebarShell>,
    );
    await waitFor(() => expect(view.getByText("mobile-closed")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Toggle mobile" }));
    expect(view.getByText("mobile-open")).toBeTruthy();
    expect(writes).toEqual([]);
  } finally {
    Storage.prototype.setItem = originalSetItem;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalWidth,
    });
  }
});

test("editing task does not publish pending empty form and seeds after a breakpoint remount", async () => {
  let resolveTask: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/runs")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    }
    return new Promise<Response>((resolve) => {
      resolveTask = resolve;
    });
  }) as typeof fetch;

  let routedDraft:
    | import("@/components/craft/scheduled-task-editor").ScheduledTaskDraft
    | undefined;
  let routedDirty = false;
  const onDraftChange = (draft: typeof routedDraft & {}, dirty: boolean) => {
    routedDraft = draft;
    routedDirty = dirty;
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Harness({ compact }: { compact: boolean }) {
    return (
      <QueryClientProvider client={queryClient}>
        <DetailPanel
          open
          title="Edit task"
          onClose={() => {}}
          detail={
            <ScheduledTaskEditor
              taskId="task-1"
              onDone={() => {}}
              draft={routedDraft}
              draftDirty={routedDirty}
              onDraftChange={onDraftChange}
            />
          }
        >
          <output>{compact ? "compact" : "wide"}</output>
        </DetailPanel>
      </QueryClientProvider>
    );
  }
  const view = render(<Harness compact={false} />);
  try {
    await waitFor(() => expect(view.getByRole("status")).toBeTruthy());
    expect(routedDraft).toBeUndefined();
    view.rerender(<Harness compact />);
    view.rerender(<Harness compact={false} />);
    await act(async () => {
      resolveTask?.(
        new Response(
          JSON.stringify({
            id: "task-1",
            name: "Loaded task",
            human_readable_schedule: "Every day",
            cron_expression: "0 9 * * *",
            editor_mode: "advanced",
            status: "active",
            next_run_at: null,
            last_run: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            prompt: "Loaded prompt",
            next_runs: [],
          }),
          { status: 200 },
        ),
      );
    });
    await waitFor(() =>
      expect(view.getByLabelText(/name/i)).toHaveProperty(
        "value",
        "Loaded task",
      ),
    );
    expect(routedDraft?.name).toBe("Loaded task");
    expect(routedDirty).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});
