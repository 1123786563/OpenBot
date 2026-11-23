import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { SkillMarket } from "@/components/skills/skill-market";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function chooseOption(view: RenderResult, field: string, option: string) {
  const trigger = await view.findByRole("combobox", { name: field });
  fireEvent.click(trigger);
  const listbox = await waitFor(() => {
    const listbox = view
      .getAllByRole("listbox")
      .find((element) => element.id === trigger.getAttribute("aria-controls"));
    if (!listbox) throw new Error(`No options opened for ${field}`);
    return listbox;
  });
  fireEvent.click(await within(listbox).findByRole("option", { name: option }));
}

test("searches the shared market and shows the selected version's instructions and eligibility", async () => {
  const skill = {
    slug: "summarize",
    namespace: "catalog",
    title: "Summarize",
    summary: "Summarize meeting notes",
    latestVersion: "2.0.0",
  };
  const downloadPaths: string[] = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/skill-market") {
        const items = url.searchParams.get("q") === "notes" ? [skill] : [];
        return Response.json({ items, hasMore: false });
      }
      if (url.pathname === "/api/skill-market/install-targets") {
        return Response.json({ bots: [] });
      }
      if (url.pathname === "/api/skill-market/catalog/summarize") {
        return Response.json({ versions: ["2.0.0", "1.0.0"], hasMore: false });
      }
      if (url.pathname.endsWith("/download")) {
        downloadPaths.push(url.pathname);
        if (downloadPaths.length === 1) {
          return Response.json(
            { error: "This Bifrost package is incomplete." },
            { status: 502 },
          );
        }
        return new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { "Content-Type": "application/zip" },
        });
      }
      const version = url.pathname.split("/").at(-1);
      return Response.json({
        ...skill,
        source: "https://registry.example",
        version,
        instructions:
          version === "1.0.0" ? "Write three bullets." : "Summarize the notes.",
        installable: version === "2.0.0",
        reasons: [
          "A reviewer has not confirmed OpenBot compatibility for this package.",
        ],
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillMarket />
    </QueryClientProvider>,
  );

  fireEvent.input(
    view.getByRole("searchbox", { name: "Search shared skills" }),
    { target: { value: "notes" } },
  );
  fireEvent.submit(view.getByRole("form", { name: "Skill market" }));
  fireEvent.click(
    await view.findByRole("button", { name: "Preview Summarize" }),
  );
  await view.findByText("Summarize the notes.");
  await chooseOption(view, "Published version", "1.0.0");
  expect(await view.findByText("Write three bullets.")).toBeTruthy();
  expect(
    view.getByText("https://registry.example · catalog/summarize"),
  ).toBeTruthy();
  expect(
    view.getByText(
      "A reviewer has not confirmed OpenBot compatibility for this package.",
    ),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Download 1.0.0 ZIP" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "This Bifrost package is incomplete.",
  );
  const filenames: string[] = [];
  const save = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      filenames.push(this.download);
    },
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Download 1.0.0 ZIP" }));
    await waitFor(() => expect(filenames).toEqual(["summarize-1.0.0.zip"]));
    expect(view.queryByRole("alert")).toBeNull();
    expect(downloadPaths).toEqual([
      "/api/skill-market/catalog/summarize/versions/1.0.0/download",
      "/api/skill-market/catalog/summarize/versions/1.0.0/download",
    ]);
  } finally {
    save.mockRestore();
  }
});

test("installs the previewed version only on a Bot the server offers to manage", async () => {
  const skill = {
    slug: "summarize",
    namespace: "catalog",
    title: "Summarize",
    summary: "Summarize notes",
    latestVersion: "1.0.0",
    version: "1.0.0",
    source: "https://registry.example",
    instructions: "Summarize in three bullets.",
    installable: true,
    command: "summarize",
    reasons: [],
  };
  const installs: unknown[] = [];
  let canManage = false;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      switch (pathname) {
        case "/api/skill-market":
          return Response.json({ items: [skill], hasMore: false });
        case "/api/skill-market/install-targets":
          return Response.json({
            bots: canManage ? [{ id: "managed", title: "Managed Bot" }] : [],
          });
        case "/api/skill-market/catalog/summarize":
          return Response.json({ versions: ["1.0.0"], hasMore: false });
        case "/api/skill-market/catalog/summarize/versions/1.0.0":
          return Response.json(skill);
        case "/api/skill-market/catalog/summarize/versions/1.0.0/install":
          expect(init?.method).toBe("POST");
          installs.push(JSON.parse(String(init?.body)));
          return Response.json(
            { command: "summarize", version: "1.0.0" },
            { status: 201 },
          );
        default:
          return new Response(null, { status: 404 });
      }
    },
    { preconnect: originalFetch.preconnect },
  );
  async function openPreview() {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <SkillMarket />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Preview Summarize" }),
    );
    return view;
  }

  const member = await openPreview();
  await member.findByText(
    "You don't manage any Bots that can install this skill.",
  );
  expect(member.queryByRole("button", { name: "Install on Bot" })).toBeNull();
  member.unmount();

  canManage = true;
  const owner = await openPreview();
  await chooseOption(owner, "Bot", "Managed Bot");
  fireEvent.click(owner.getByRole("button", { name: "Install on Bot" }));
  await owner.findByText("Installed 1.0.0. Use /summarize on Managed Bot.");
  expect(installs).toEqual([{ agentId: "managed" }]);
});

test("manages a Bot's saved installation even when the catalog is offline", async () => {
  const removals: unknown[] = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      switch (pathname) {
        case "/api/skill-market/install-targets":
          return Response.json({
            bots: [{ id: "managed", title: "Managed Bot" }],
          });
        case "/api/skill-market/bots/managed/installations":
          return Response.json({
            installations: removals.length
              ? []
              : [
                  {
                    command: "summarize",
                    namespace: "catalog",
                    slug: "summarize",
                    registry: "https://registry.example",
                    title: "Summarize",
                    version: "1.0.0",
                    versionId: 3,
                  },
                ],
          });
        case "/api/skill-market/bots/managed/installations/summarize":
          expect(init?.method).toBe("DELETE");
          removals.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        default:
          return new Response(null, { status: 502 });
      }
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillMarket />
    </QueryClientProvider>,
  );
  await chooseOption(view, "Manage installed skills on", "Managed Bot");
  await view.findByText("Installed version 1.0.0");
  fireEvent.click(view.getByRole("button", { name: "Uninstall Summarize" }));
  await view.findByText("This Bot has no installed market skills.");
  expect(removals).toEqual([{ expectedVersionId: 3 }]);
});

test("uses the published version picker to upgrade and roll back a single Bot", async () => {
  const snapshot = {
    command: "summarize",
    namespace: "catalog",
    slug: "summarize",
    registry: "https://registry.example",
    title: "Summarize",
    version: "1.0.0",
    versionId: 3,
  };
  const changes: unknown[] = [];
  const source = "/api/skill-market/catalog/summarize";
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      switch (pathname) {
        case "/api/skill-market":
          return Response.json({ items: [], hasMore: false });
        case "/api/skill-market/install-targets":
          return Response.json({
            bots: [{ id: "managed", title: "Managed Bot" }],
          });
        case "/api/skill-market/bots/managed/installations":
          return Response.json({ installations: [snapshot] });
        case source:
          return Response.json({
            versions: ["2.0.0", "1.0.0"],
            hasMore: false,
          });
        case `${source}/versions/1.0.0`:
        case `${source}/versions/2.0.0`:
          return Response.json({
            ...snapshot,
            version: pathname.endsWith("1.0.0") ? "1.0.0" : "2.0.0",
            source: snapshot.registry,
            installable: true,
            instructions: "Summarize the notes.",
          });
        case `${source}/versions/1.0.0/switch`:
        case `${source}/versions/2.0.0/switch`:
          expect(init?.method).toBe("POST");
          changes.push(JSON.parse(String(init?.body)));
          snapshot.version = pathname.includes("/1.0.0/") ? "1.0.0" : "2.0.0";
          snapshot.versionId = snapshot.version === "1.0.0" ? 3 : 4;
          return Response.json({
            command: snapshot.command,
            version: snapshot.version,
          });
        default:
          return new Response(null, { status: 404 });
      }
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillMarket />
    </QueryClientProvider>,
  );
  await chooseOption(view, "Manage installed skills on", "Managed Bot");
  fireEvent.click(
    await view.findByRole("button", { name: "Change version of Summarize" }),
  );
  await chooseOption(view, "Published version", "2.0.0");
  fireEvent.click(await view.findByRole("button", { name: "Switch to 2.0.0" }));
  await view.findByText("Switched to 2.0.0.");
  await view.findByText("Installed version 2.0.0");
  await chooseOption(view, "Published version", "1.0.0");
  fireEvent.click(await view.findByRole("button", { name: "Switch to 1.0.0" }));
  await view.findByText("Installed version 1.0.0");
  expect(changes).toEqual([
    { agentId: "managed", expectedVersionId: 3 },
    { agentId: "managed", expectedVersionId: 4 },
  ]);
});

test("an administrator can disable and restore an installed version while the catalog is offline", async () => {
  const version = {
    source: "https://registry.example",
    slug: "summarize",
    namespace: "catalog",
    version: "1.0.0",
    registrySkillId: 2,
    versionId: 3,
  };
  const changes: unknown[] = [];
  let reason: string | null = null;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname !== "/api/skill-market/version-disablements") {
        return new Response(null, { status: 502 });
      }
      if (!init?.method)
        return Response.json({ versions: [{ ...version, reason }] });
      const { reason: requestedReason, ...identity } = JSON.parse(
        String(init.body),
      );
      changes.push([init.method, identity]);
      reason = init.method === "PUT" ? requestedReason : null;
      return new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillMarket isAdmin />
    </QueryClientProvider>,
  );
  await view.findByText("Couldn't load the skill market.");
  const input = await view.findByRole("textbox", { name: "Disable reason" });
  fireEvent.input(input, { target: { value: "Review in progress" } });
  const form = input.closest("form");
  if (!form) throw new Error("Disable form missing");
  fireEvent.submit(form);
  await view.findByText("Review in progress");
  fireEvent.click(view.getByRole("button", { name: "Re-enable version" }));
  await view.findByRole("button", { name: "Disable version" });
  expect(changes).toEqual([
    ["PUT", version],
    ["DELETE", version],
  ]);
});

test("lets only the administrator resolve a command conflict and retry a taken name", async () => {
  const skill = {
    slug: "summarize",
    namespace: "catalog",
    title: "Summarize",
    latestVersion: "1.0.0",
  };
  let admin = false;
  let command: string | undefined;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      switch (pathname) {
        case "/api/skill-market":
          return Response.json({ items: [skill], hasMore: false });
        case "/api/skill-market/catalog/summarize":
          return Response.json({ versions: ["1.0.0"], hasMore: false });
        case "/api/skill-market/catalog/summarize/versions/1.0.0":
          return Response.json({
            ...skill,
            version: "1.0.0",
            source: "https://registry.example",
            instructions: "Summarize in three bullets.",
            installable: command !== undefined,
            canAssignCommand: admin && command === undefined,
            command,
            reasons: command
              ? []
              : ["An administrator must assign an unused command."],
          });
        case "/api/skill-market/catalog/summarize/command": {
          expect(init?.method).toBe("POST");
          const body = JSON.parse(String(init?.body));
          if (body.command === "taken") {
            return Response.json(
              { error: "That slash command is already in use." },
              { status: 409 },
            );
          }
          expect(body).toEqual({ command: "market-notes" });
          command = body.command;
          return Response.json({ command }, { status: 201 });
        }
        case "/api/skill-market/install-targets":
          return Response.json({
            bots: [{ id: "managed", title: "Managed Bot" }],
          });
        default:
          return new Response(null, { status: 404 });
      }
    },
    { preconnect: originalFetch.preconnect },
  );

  async function openPreview() {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <SkillMarket />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Preview Summarize" }),
    );
    await view.findByText("An administrator must assign an unused command.");
    return view;
  }

  const member = await openPreview();
  expect(member.queryByRole("button", { name: "Assign command" })).toBeNull();
  expect(member.queryByRole("button", { name: "Install on Bot" })).toBeNull();
  member.unmount();

  admin = true;
  const view = await openPreview();
  const input = view.getByRole("textbox", { name: "New slash command" });
  fireEvent.input(input, { target: { value: "taken" } });
  fireEvent.click(view.getByRole("button", { name: "Assign command" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "That slash command is already in use.",
  );
  fireEvent.input(input, { target: { value: "market-notes" } });
  fireEvent.click(view.getByRole("button", { name: "Assign command" }));
  await view.findByRole("button", { name: "Install on Bot" });
  expect(view.getByText("/market-notes")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Assign command" })).toBeNull();
});
