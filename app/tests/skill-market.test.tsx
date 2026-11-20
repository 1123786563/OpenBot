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
