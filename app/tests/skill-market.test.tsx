import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

test("searches the shared market and shows the selected version's instructions and eligibility", async () => {
  const skill = {
    slug: "summarize",
    namespace: "catalog",
    title: "Summarize",
    summary: "Summarize meeting notes",
    latestVersion: "2.0.0",
  };
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
  await view.findByRole("option", { name: "1.0.0" });
  fireEvent.change(view.getByRole("combobox", { name: "Published version" }), {
    target: { value: "1.0.0" },
  });
  expect(await view.findByText("Write three bullets.")).toBeTruthy();
  expect(
    view.getByText("https://registry.example · catalog/summarize"),
  ).toBeTruthy();
  expect(
    view.getByText(
      "A reviewer has not confirmed OpenBot compatibility for this package.",
    ),
  ).toBeTruthy();
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
  await owner.findByRole("combobox", { name: "Bot" });
  fireEvent.change(owner.getByRole("combobox", { name: "Bot" }), {
    target: { value: "managed" },
  });
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
  await view.findByRole("option", { name: "Managed Bot" });
  fireEvent.change(
    view.getByRole("combobox", { name: "Manage installed skills on" }),
    {
      target: { value: "managed" },
    },
  );
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
  await view.findByRole("option", { name: "Managed Bot" });
  fireEvent.change(
    view.getByRole("combobox", { name: "Manage installed skills on" }),
    {
      target: { value: "managed" },
    },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Change version of Summarize" }),
  );
  await view.findByRole("option", { name: "2.0.0" });
  const versions = view.getByRole("combobox", { name: "Published version" });
  fireEvent.change(versions, { target: { value: "2.0.0" } });
  fireEvent.click(await view.findByRole("button", { name: "Switch to 2.0.0" }));
  await view.findByText("Switched to 2.0.0.");
  await view.findByText("Installed version 2.0.0");
  fireEvent.change(versions, { target: { value: "1.0.0" } });
  fireEvent.click(await view.findByRole("button", { name: "Switch to 1.0.0" }));
  await view.findByText("Installed version 1.0.0");
  expect(changes).toEqual([
    { agentId: "managed", expectedVersionId: 3 },
    { agentId: "managed", expectedVersionId: 4 },
  ]);
});
