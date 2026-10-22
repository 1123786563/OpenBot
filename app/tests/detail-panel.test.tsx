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
import { CraftTaskEditorPresenter } from "@/components/craft/scheduled-task-editor";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const target = [...Observer.targets.keys()].find((element) =>
    container.contains(element),
  );
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

test("sidebar shell restores all preferences through compact mode and public toggle", async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  const originalSetItem = Storage.prototype.setItem;
  const writes: Array<[string, string]> = [];
  Storage.prototype.setItem = function (key: string, value: string) {
    writes.push([key, value]);
    originalSetItem.call(this, key, value);
  };
  function State() {
    const sidebar = useSidebar();
    return <output>{sidebar.open ? "open" : "closed"}</output>;
  }
  try {
    for (const scenario of [
      { stored: null, initial: "open", next: "collapsed" },
      { stored: "expanded", initial: "open", next: "collapsed" },
      { stored: "collapsed", initial: "closed", next: "expanded" },
    ] as const) {
      window.localStorage.clear();
      if (scenario.stored)
        window.localStorage.setItem("openbot-sidebar", scenario.stored);
      writes.length = 0;
      const view = render(
        <SidebarShell width="280px">
          <Sidebar collapsible="icon">
            <p>Navigation</p>
          </Sidebar>
          <State />
          <SidebarTrigger />
        </SidebarShell>,
      );
      expect(view.getByRole("status").textContent).toBe(scenario.initial);
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
      expect(view.getByRole("status").textContent).toBe("closed");
      expect(writes).toEqual([]);
      view.rerender(
        <SidebarShell width="280px">
          <Sidebar collapsible="icon">
            <p>Navigation</p>
          </Sidebar>
          <State />
          <SidebarTrigger />
        </SidebarShell>,
      );
      expect(view.getByRole("status").textContent).toBe(scenario.initial);
      expect(writes).toEqual([]);
      fireEvent.click(view.getByRole("button", { name: /toggle sidebar/i }));
      expect(view.getByRole("status").textContent).toBe(
        scenario.next === "expanded" ? "open" : "closed",
      );
      expect(writes).toEqual([["openbot-sidebar", scenario.next]]);
      view.unmount();
    }
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

test("controlled dialog opened by its owner restores focus to the invoking control", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Add credential
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Credential</DialogTitle>
            <DialogClose>Close</DialogClose>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  const view = render(<Harness />);
  const trigger = view.getByRole("button", { name: "Add credential" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await view.findByRole("dialog", { name: "Credential" });
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  const close = dialog.querySelector<HTMLButtonElement>('[slot="close"]');
  if (!close) throw new Error("Dialog close control missing");
  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(dialog).toBeTruthy();
});

test("nested controlled dialog restores focus to a trigger inside its parent dialog", async () => {
  function Harness() {
    const [innerOpen, setInnerOpen] = useState(false);
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Outer dialog</DialogTitle>
          <button type="button" onClick={() => setInnerOpen(true)}>
            Open nested dialog
          </button>
          <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
            <DialogContent>
              <DialogTitle>Inner dialog</DialogTitle>
              <DialogClose>Close inner</DialogClose>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    );
  }
  const view = render(<Harness />);
  const trigger = view.getByRole("button", { name: "Open nested dialog" });
  trigger.focus();
  fireEvent.click(trigger);
  const inner = await view.findByRole("dialog", { name: "Inner dialog" });
  // Happy DOM does not run React Aria's nested-overlay focus scope; focus the rendered modal
  // surface to exercise the same focusin/restore path after the overlay opens.
  if (!inner.contains(document.activeElement)) inner.focus();
  expect(inner.contains(document.activeElement)).toBe(true);
  const close = inner.querySelector<HTMLButtonElement>('[slot="close"]');
  if (!close) throw new Error("Inner dialog close control missing");
  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(view.getByRole("dialog", { name: "Outer dialog" })).toBeTruthy();
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

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Harness({ compact }: { compact: boolean }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CraftTaskEditorPresenter
          active
          create={false}
          taskId="task-1"
          onClose={() => {}}
        >
          <output>{compact ? "compact" : "wide"}</output>
        </CraftTaskEditorPresenter>
      </QueryClientProvider>
    );
  }
  const view = render(<Harness compact={false} />);
  try {
    const loading = await view.findByText("Loading scheduled tasks…");
    expect(loading.getAttribute("role")).toBe("status");
    await resize(view.container, 880);
    expect(view.queryByRole("dialog", { name: "Details" })).toBeNull();
    await resize(view.container, 879);
    expect(await view.findByRole("dialog", { name: "Details" })).toBeTruthy();
    await resize(view.container, 880);
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Details" })).toBeNull(),
    );
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
    expect(
      view.getByText(
        (_text, element) => element?.getAttribute("data-dirty") === "false",
      ),
    ).toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("failed task detail load shows an error instead of an empty editable form", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
    })) as unknown as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CraftTaskEditorPresenter
        active
        create={false}
        taskId="task-error"
        onClose={() => {}}
      >
        <output>wide</output>
      </CraftTaskEditorPresenter>
    </QueryClientProvider>,
  );
  try {
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toBe("The scheduled tasks could not be loaded.");
    expect(view.queryByLabelText("Name")).toBeNull();
    expect(view.queryByRole("button", { name: "Save task" })).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("production task presenter retains dirty A across resize and isolates B", async () => {
  const originalFetch = globalThis.fetch;
  const updates: Array<{ path: string; body: Record<string, unknown> }> = [];
  const task = (id: string) => ({
    id,
    name: `Task ${id}`,
    human_readable_schedule: "Every day",
    cron_expression: "0 9 * * *",
    editor_mode: "advanced",
    status: "active",
    next_run_at: null,
    last_run: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    prompt: `Prompt ${id}`,
    next_runs: [],
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "PUT") {
      updates.push({
        path,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(task("B")), { status: 200 });
    }
    if (path.endsWith("/runs"))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    const id = path.endsWith("/B") ? "B" : "A";
    return new Response(JSON.stringify(task(id)), { status: 200 });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Harness({ taskId }: { taskId: string }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CraftTaskEditorPresenter
          active
          create={false}
          taskId={taskId}
          onClose={() => {}}
        >
          <p>Task list</p>
        </CraftTaskEditorPresenter>
      </QueryClientProvider>
    );
  }
  const view = render(<Harness taskId="A" />);
  try {
    await waitFor(() =>
      expect(view.getByLabelText(/name/i)).toHaveProperty("value", "Task A"),
    );
    const nameInput = view.getByLabelText(/name/i) as HTMLInputElement;
    const reactPropsKey = Object.keys(nameInput).find((key) =>
      key.startsWith("__reactProps$"),
    );
    const reactProps = reactPropsKey
      ? (
          nameInput as unknown as Record<
            string,
            { onChange?: (event: unknown) => void }
          >
        )[reactPropsKey]
      : undefined;
    await act(async () => {
      reactProps?.onChange?.({ target: { value: "A dirty value" } });
    });
    await waitFor(() =>
      expect(
        view.getByText(
          (_text, element) => element?.getAttribute("data-dirty") === "true",
        ),
      ).toBeTruthy(),
    );
    expect((view.getByLabelText(/name/i) as HTMLInputElement).value).toBe(
      "A dirty value",
    );
    await resize(view.container, 880);
    expect(view.queryByRole("dialog", { name: "Details" })).toBeNull();
    await resize(view.container, 879);
    expect(await view.findByRole("dialog", { name: "Details" })).toBeTruthy();
    await resize(view.container, 880);
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Details" })).toBeNull(),
    );
    expect((view.getByLabelText(/name/i) as HTMLInputElement).value).toBe(
      "A dirty value",
    );
    expect(view.container.querySelector('[data-dirty="true"]')).toBeTruthy();

    view.rerender(<Harness taskId="B" />);
    await waitFor(() =>
      expect(view.getByLabelText(/name/i)).toHaveProperty("value", "Task B"),
    );
    expect((view.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe(
      "Prompt B",
    );
    expect((view.getByLabelText(/name/i) as HTMLInputElement).value).not.toBe(
      "A dirty value",
    );
    fireEvent.click(view.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.path).toContain("/B");
    expect(updates[0]?.body.name).toBe("Task B");
    expect(updates[0]?.body.prompt).toBe("Prompt B");
  } finally {
    globalThis.fetch = originalFetch;
    queryClient.clear();
  }
});

test("Craft task DetailPanel host grows after the fixed session roster", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <div className="flex w-[920px]">
        <aside className="w-64 shrink-0">Session roster</aside>
        <CraftTaskEditorPresenter active create onClose={() => {}}>
          <p>Task list</p>
        </CraftTaskEditorPresenter>
      </div>
    </QueryClientProvider>,
  );
  try {
    const host = view.container.firstElementChild?.lastElementChild;
    expect(host).toBeTruthy();
    expect(host?.classList.contains("flex-1")).toBe(true);
    expect(host?.classList.contains("min-w-0")).toBe(true);
  } finally {
    view.unmount();
    queryClient.clear();
  }
});
