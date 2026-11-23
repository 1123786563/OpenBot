import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { NameOrb, useNameStep } from "@/components/onboarding/name-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's name step. Its button is the frame's, so Back sits beside Get started as it does
 * beside Continue on every other step. Get started saves the name, then finishes: Saving… while it
 * saves, and All set, green with a check, while the orb plays its finish.
 */

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
beforeEach(() => {
  // Profile saves invalidate this singleton, which other onboarding tests populate.
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function client(needsName = true) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  query.setQueryData(authKeys.currentUser(), {
    id: "existing-user",
    email: "dev@openbot.local",
    name: needsName ? "dev@openbot.local" : "Sam",
    needsName,
    onboarding: { completedAt: null, step: 3 },
  });
  return query;
}

/** The name step after one plain step, in the real frame, with a finish the test controls. */
function NameOnboarding({
  finish,
}: {
  finish: (setFinished: (finished: boolean) => void) => Promise<void>;
}) {
  const [finished, setFinished] = useState(false);
  const name = useNameStep({
    finish: () => finish(setFinished),
    finished,
  });
  return (
    <OnboardingWizard
      initialStepId="name"
      steps={[
        {
          id: "welcome",
          title: "Welcome to OpenBot",
          intro: () => <StepIntro />,
        },
        name,
      ]}
    />
  );
}

function draw(
  finish: (setFinished: (finished: boolean) => void) => Promise<void>,
  needsName = true,
) {
  return render(
    <QueryClientProvider client={client(needsName)}>
      <NameOnboarding finish={finish} />
    </QueryClientProvider>,
  );
}

const primary = (view: ReturnType<typeof render>) =>
  view.container.querySelector(
    "[data-onboarding-primary]",
  ) as HTMLButtonElement;

function isDisabled(button: HTMLButtonElement) {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

test("it starts empty for a placeholder profile, and Get started waits for a name", () => {
  const view = draw(async () => {});

  expect(
    view.getByRole("heading", { name: "What should we call you?" }),
  ).toBeTruthy();
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  expect(primary(view).textContent).toBe("Get started");
  expect(isDisabled(primary(view))).toBe(true);
});

test("a disabled Get started ignores mouse and keyboard activation", async () => {
  let saves = 0;
  globalThis.fetch = Object.assign(
    async () => {
      saves += 1;
      return Response.json({ profile: { name: "Sam", needsName: false } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw(async () => {});
  const keyboard = userEvent.setup({ document });
  const button = primary(view);

  await keyboard.click(button);
  button.focus();
  await keyboard.keyboard("{Enter} ");
  expect(saves).toBe(0);
});

test("a saved name is kept when the step is revisited", () => {
  const view = draw(async () => {}, false);

  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
  expect(isDisabled(primary(view))).toBe(false);
});

test("Back sits beside Get started, before it, as on every other step", () => {
  const view = draw(async () => {});

  const back = view.container.querySelector('[data-onboarding-back="desktop"]');
  expect(back?.parentElement).toBe(primary(view).parentElement);
  expect(back?.className).toContain("lg:order-first");
  expect(primary(view).getAttribute("type")).toBe("submit");
});

test("Get started saves first, then finishes, and reads All set while the orb finishes", async () => {
  let release: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let saves = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return Response.json({
          user: { id: "existing-user", name: "Sam", needsName: false },
        });
      }
      saves += 1;
      return response;
    },
    {
      preconnect: originalFetch.preconnect,
    },
  );
  let finishes = 0;
  let endFinish: () => void = () => {};
  const view = draw(async (setFinished) => {
    finishes += 1;
    setFinished(true);
    await new Promise<void>((resolve) => {
      endFinish = resolve;
    });
  });

  await userEvent.setup({ document }).type(view.getByLabelText("Name"), "Sam");
  fireEvent.click(primary(view));
  await waitFor(() => expect(primary(view).textContent).toBe("Saving…"));
  const keyboard = userEvent.setup({ document });
  await keyboard.click(primary(view));
  primary(view).focus();
  await keyboard.keyboard("{Enter} ");
  expect(saves).toBe(1);
  expect(finishes).toBe(0);
  expect(isDisabled(primary(view))).toBe(true);

  release(Response.json({ profile: { name: "Sam", needsName: false } }));
  await waitFor(() => expect(primary(view).textContent).toBe("All set"));
  expect(isDisabled(primary(view))).toBe(false);
  expect(primary(view).querySelector("svg")).not.toBeNull();
  expect(finishes).toBe(1);

  // A press during the finish does nothing.
  fireEvent.click(primary(view));
  await settleReactWork();
  expect(finishes).toBe(1);
  expect(saves).toBe(1);
  endFinish();
});

test("a save that fails is said under the field, and the step stays", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Save failed" }, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  let finishes = 0;
  const view = draw(async () => {
    finishes += 1;
  }, false);

  await userEvent.setup({ document }).type(view.getByLabelText("Name"), "uel");
  fireEvent.click(primary(view));

  expect((await view.findByRole("alert")).textContent).toBe("Save failed");
  expect(finishes).toBe(0);
  expect(primary(view).textContent).toBe("Get started");
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Samuel",
  );
});

test("the orb is OpenBot's own, listening, and settles into done when onboarding ends", () => {
  const view = render(<NameOrb />);
  const orb = () =>
    view.container.querySelector<HTMLElement>("[data-orb]") as HTMLElement;
  expect(orb().getAttribute("data-orb")).toBe("openbot");
  expect(orb().getAttribute("data-state")).toBe("listening");
  expect(view.container.querySelector("[data-onboarding-finish]")).toBeNull();

  view.rerender(<NameOrb finished />);
  expect(orb().getAttribute("data-state")).toBe("done");
  expect(orb().closest("[data-onboarding-finish]")).not.toBeNull();
});
