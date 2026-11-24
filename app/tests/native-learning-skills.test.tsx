import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NativeLearningSkills } from "@/components/settings/native-learning-skills";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

test("opens a published skill, shares it, and revokes the grant", async () => {
  const base = "/api/copilotkit/learning/skills";
  const summary = {
    id: "f36cfb73-a7c1-48c4-9c22-2af574d247f0",
    title: "Pack a shipment",
    botName: "Packing Bot",
    access: "owned",
  };
  const detail = `${base}/${summary.id}`;
  const email = "reader@example.test";
  let shared = false;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === base) return Response.json({ skills: [summary] });
      if (url === detail)
        return Response.json({
          ...summary,
          instructions: "Check the shipping label.",
          canShare: true,
          shares: shared ? [{ recipientId: "reader", email }] : [],
        });
      if (url === `${detail}/shares` && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ email });
        shared = true;
        return Response.json({ ok: true });
      }
      if (url === `${detail}/shares/reader` && init?.method === "DELETE") {
        shared = false;
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected request ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <NativeLearningSkills />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await view.findByRole("button", { name: "View Pack a shipment" }),
  );
  await view.findByText("Check the shipping label.");
  fireEvent.input(view.getByLabelText("Recipient email"), {
    target: { value: email },
  });
  const shareButton = view.getByRole("button", { name: "Share skill" });
  expect(shareButton.hasAttribute("disabled")).toBe(false);
  const form = shareButton.closest("form");
  if (!form) throw new Error("Expected a sharing form.");
  fireEvent.submit(form);
  const revoke = await view.findByRole("button", {
    name: `Revoke sharing with ${email}`,
  });
  fireEvent.click(revoke);
  await view.findByText("Share revoked.");
  expect(shared).toBe(false);
});

test("a withdrawn skill detail shows the denial and no sharing controls", async () => {
  const summary = {
    id: "c48f1b0f-5508-4a3b-982b-374073a7658d",
    title: "Shared procedure",
    botName: "Packing Bot",
    access: "shared",
  };
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      String(input).endsWith("/skills")
        ? Response.json({ skills: [summary] })
        : Response.json(
            { error: "Published skill not found." },
            { status: 404 },
          ),
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <NativeLearningSkills />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await view.findByRole("button", { name: "View Shared procedure" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Published skill not found.",
  );
  expect(view.queryByRole("button", { name: "Share skill" })).toBeNull();
});
