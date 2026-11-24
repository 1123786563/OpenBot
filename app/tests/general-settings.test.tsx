import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameRow } from "@/components/settings/profile";
import { StandingInstructionsRow } from "@/components/settings/standing-instructions";
import { authKeys } from "@/lib/auth/queries";
import { settingsKeys } from "@/lib/settings/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * General's two free-text answers, drawn as the layout has every free text: a row that states the answer, and a dialog
 * that changes it.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let instructions = "";
let instructionsUnavailable = false;

beforeEach(() => {
  queryClient.clear();
  instructions = "";
  instructionsUnavailable = false;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input);
      if (path === "/api/settings/instructions")
        return instructionsUnavailable
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({ instructions });
      if (path === "/api/me")
        return Response.json({
          user: { id: "ada", email: "ada@example.com", name: "Ada" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "ada",
    email: "ada@example.com",
    name: "Ada",
    needsName: false,
  } as never);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router as never}>
        <NameRow />
        <StandingInstructionsRow />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

test("the name is a row that states it and opens a dialog to change it", async () => {
  const view = draw();
  const row = view.getByRole("button", { name: /^Name/ });
  expect(row.textContent).toContain("Ada");
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Ada");
  expect(
    within(dialog)
      .getByRole("button", { name: "Save name" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});

test("closing an edited setting asks whether to discard the draft", async () => {
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /^Name/ }));
  const dialog = await view.findByRole("dialog");
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Ada Lovelace");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const discard = await view.findByRole("alertdialog", {
    name: "Discard unsaved changes?",
  });
  await user.click(
    within(discard).getByRole("button", { name: "Keep editing" }),
  );
  expect(name instanceof HTMLInputElement && name.value).toBe("Ada Lovelace");
});

test("standing instructions are a row that says what they are, or that there are none yet", async () => {
  const view = draw();
  const row = await view.findByRole("button", {
    name: /Applies to every Bot in every conversation\. None yet\./,
  });
  await userEvent.setup({ document }).click(row);
  const dialog = await view.findByRole("dialog");
  expect(
    await within(dialog).findByRole("textbox", {
      name: "Standing instructions",
    }),
  ).toBeTruthy();
  cleanup();

  queryClient.clear();
  instructions = "Write in British English.";
  queryClient.setQueryData(settingsKeys.instructions(), instructions);
  const written = draw();
  expect(
    await written.findByRole("button", {
      name: /Applies to every Bot in every conversation\. Write in British English\./,
    }),
  ).toBeTruthy();
});

test("standing instructions recover from a failed read inside the editor", async () => {
  instructionsUnavailable = true;
  const view = draw();
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: /^Standing instructions/ }),
  );
  const dialog = within(await view.findByRole("dialog"));
  const retry = await dialog.findByRole("button", { name: "Retry" });
  expect(dialog.queryByRole("button", { name: "Save" })).toBeNull();

  instructions = "Use British English.";
  instructionsUnavailable = false;
  await user.click(retry);
  const field = await dialog.findByRole("textbox", {
    name: "Standing instructions",
  });
  expect(field instanceof HTMLTextAreaElement && field.value).toBe(
    instructions,
  );
});
