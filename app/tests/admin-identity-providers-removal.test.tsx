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
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { IdentityProvider } from "@/lib/identity-providers/queries";
import { queryClient } from "@/query-client";
import { Route as IdentityProvidersRoute } from "@/routes/_authed/admin/identity-providers";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin Identity providers, where an administrator removes the SAML or OIDC provider somebody's
 * company signs in through. The server is faked at the fetch boundary with the shapes the list, the
 * impact read and the removal route answer with, and every write is recorded, so "cancel sends
 * nothing" and "two presses send one request" are counted rather than assumed.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const PROVIDER: IdentityProvider = {
  providerId: "acme-okta",
  domain: "acme.com,acme-corp.com",
  issuer: "https://acme.okta.test",
  protocol: "saml",
  registeredBy: "admin",
};

type Impact = {
  losing: { total: number; emails: string[] };
  keeping: {
    total: number;
    accounts: {
      email: string;
      reason: "another-sign-in" | "emergency-admin";
    }[];
  };
  includesYou: boolean;
};

const IMPACT: Impact = {
  losing: { total: 2, emails: ["alice@acme.com", "bob@acme.com"] },
  keeping: {
    total: 1,
    accounts: [{ email: "carol@acme.com", reason: "emergency-admin" }],
  },
  includesYou: false,
};

let providers: IdentityProvider[];
let impact: Impact;
/** A status the impact read answers with instead of the impact. */
let impactStatus: number | null;
/** Whether the impact read fails with no sentence of its own, as a proxy's error page does. */
let impactSilent: boolean;
let impactReads: number;
/** A test that wants the dialog open while the impact is still being read holds it here. */
let impactGate: Promise<void> | null;
/** A status the provider list answers with instead of the providers. */
let listStatus: number | null;
/** How many removals answer 500 before the server starts accepting them. */
let failingDeletes: number;
/** Whether the next removal commits and then never answers. */
let loseDeleteResponse: boolean;
/** A test that wants to press again mid-submit holds the removal here. */
let inFlight: Promise<void> | null;
let writes: { method: string; path: string }[];

beforeEach(() => {
  providers = [{ ...PROVIDER }];
  impact = structuredClone(IMPACT);
  impactStatus = null;
  impactSilent = false;
  impactReads = 0;
  impactGate = null;
  listStatus = null;
  failingDeletes = 0;
  loseDeleteResponse = false;
  inFlight = null;
  writes = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status });
    if (method === "GET" && path.endsWith("/impact")) {
      impactReads += 1;
      if (impactGate) await impactGate;
      if (impactSilent) return new Response("Bad Gateway", { status: 502 });
      return impactStatus
        ? json(
            {
              error:
                impactStatus === 404
                  ? "There is no such provider."
                  : "The impact could not be read.",
            },
            impactStatus,
          )
        : json({ impact });
    }
    if (method === "GET" && path === "/api/admin/identity-providers") {
      return listStatus
        ? json({ error: "The providers could not be read." }, listStatus)
        : json({ providers });
    }
    if (method === "DELETE") {
      writes.push({ method, path });
      if (inFlight) await inFlight;
      if (failingDeletes > 0) {
        failingDeletes -= 1;
        return json({ error: "The server could not do that." }, 500);
      }
      const providerId = decodeURIComponent(path.split("/").at(-1) ?? "");
      providers = providers.filter(
        (provider) => provider.providerId !== providerId,
      );
      // What a dropped connection looks like: the write landed, its answer never arrived.
      if (loseDeleteResponse) {
        loseDeleteResponse = false;
        throw new TypeError("Failed to fetch");
      }
      return json({ removed: true });
    }
    return json({ error: "not served" }, 404);
  }) as unknown as typeof fetch;
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: IdentityProvidersRoute.options.component,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await view.findByRole("button", {
    name: `Remove identity provider ${PROVIDER.providerId}`,
  });
  return view;
}

async function open(view: Awaited<ReturnType<typeof draw>>) {
  const trigger = view.getByRole("button", {
    name: `Remove identity provider ${PROVIDER.providerId}`,
  });
  fireEvent.click(trigger);
  const dialog = await view.findByRole("alertdialog");
  return { trigger, dialog, in: within(dialog) };
}

test("the dialog states its scope and how to undo it, and names who loses their only way in and who keeps one", async () => {
  const view = await draw();
  // Not on every list read: only when a removal is being confirmed.
  expect(impactReads).toBe(0);
  const { dialog, in: inside } = await open(view);
  expect(impactReads).toBe(1);

  expect(dialog.textContent).toContain(`Remove ${PROVIDER.providerId}?`);
  // The scope and the recovery, and no guess from the email domain: the list below names the people.
  expect(dialog.textContent).toContain(
    "This removes SAML sign-in through acme-okta for the whole deployment. To restore it, register the provider again.",
  );
  expect(dialog.textContent).not.toContain(PROVIDER.domain);
  await inside.findByText("2 people lose their only way in.");
  expect(dialog.textContent).toContain("alice@acme.com");
  expect(dialog.textContent).toContain("bob@acme.com");
  expect(dialog.textContent).toContain("1 person keeps another way in.");
  expect(dialog.textContent).toContain("carol@acme.com");
  expect(dialog.textContent).toContain("Emergency admin");
  expect(writes).toEqual([]);
});

test("says including you when the admin asking loses their only way in", async () => {
  impact = { ...structuredClone(IMPACT), includesYou: true };
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in, including you.");
});

test("says nobody has signed in when the provider affects nobody", async () => {
  impact = {
    losing: { total: 0, emails: [] },
    keeping: { total: 0, accounts: [] },
    includesYou: false,
  };
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("Nobody has signed in through this provider yet.");
});

test("Remove stays disabled until the impact has been read", async () => {
  let release: () => void = () => {};
  impactGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await draw();
  const { in: inside } = await open(view);
  const remove = inside.getByRole("button", { name: "Remove provider" });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(writes).toEqual([]);

  release();
  await waitFor(() =>
    expect(remove.getAttribute("aria-disabled")).not.toBe("true"),
  );
});

test("a failed impact read says so and retries in place", async () => {
  impactStatus = 500;
  const view = await draw();
  const { in: inside } = await open(view);
  // The read retries once on its own before the error, and this one keeps failing.
  const retry = await inside.findByRole(
    "button",
    { name: "Retry preview" },
    { timeout: 3000 },
  );
  const remove = inside.getByRole("button", { name: "Remove provider" });
  expect(remove.getAttribute("aria-disabled")).toBe("true");

  impactStatus = null;
  fireEvent.click(retry);
  await inside.findByText("2 people lose their only way in.");
  await waitFor(() =>
    expect(remove.getAttribute("aria-disabled")).not.toBe("true"),
  );
  expect(writes).toEqual([]);
});
/*
 * A failure that carried no sentence of its own. The read's fallback is what reaches the screen, so
 * it is the page's one sentence for this failure, not a second wording of it.
 */
test("an impact read that failed with no sentence of its own says so once", async () => {
  impactSilent = true;
  const view = await draw();
  const { in: inside } = await open(view);
  // The read retries once on its own before the error, and this one keeps failing.
  await inside.findByText(
    "Couldn’t check who can still sign in.",
    {},
    {
      timeout: 3000,
    },
  );
  expect(
    inside.queryByText("Could not check who signs in with this provider"),
  ).toBeNull();
  expect(writes).toEqual([]);
});

test("cancel sends nothing and gives focus back to the control that opened the confirmation", async () => {
  const view = await draw();
  const trigger = view.getByRole("button", {
    name: `Remove identity provider ${PROVIDER.providerId}`,
  });
  trigger.focus();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");
  // The first thing in the confirmation, so a keyboard does not start on the destructive control.
  expect(document.activeElement).toBe(
    inside.getByRole("button", { name: "Cancel" }),
  );

  fireEvent.click(inside.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(writes).toEqual([]);
});

test("pressing Remove three times during a submit sends one request", async () => {
  let release: () => void = () => {};
  inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");

  fireEvent.click(inside.getByRole("button", { name: "Remove provider" }));
  const pending = await inside.findByRole("button", {
    name: "Removing provider…",
  });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(writes).toHaveLength(1);
  // A second and a third press land while the first is in flight.
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(writes).toHaveLength(1);

  release();
  await view.findByText("acme-okta was removed.");
  expect(writes).toHaveLength(1);
});

test("a refusal keeps the confirmation with its preview, and Try again removes it", async () => {
  failingDeletes = 1;
  const view = await draw();
  const { dialog, in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");

  fireEvent.click(inside.getByRole("button", { name: "Remove provider" }));
  await inside.findByText(
    "Removal could not be confirmed. Try again to check whether the provider is still registered.",
  );
  // The administrator is still deciding about the same provider.
  expect(dialog.textContent).toContain(`Remove ${PROVIDER.providerId}?`);
  expect(dialog.textContent).toContain("alice@acme.com");

  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await view.findByText("acme-okta was removed.");
  expect(writes).toHaveLength(2);
});

test("a provider whose setup changed under the dialog writes nothing and offers Close only", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");
  providers = [{ ...PROVIDER, domain: "changed.test" }];

  fireEvent.click(inside.getByRole("button", { name: "Remove provider" }));
  await inside.findByText(
    "This provider was removed or its setup changed. Close this dialog and review the list.",
  );
  expect(inside.queryByRole("button", { name: "Remove provider" })).toBeNull();
  fireEvent.click(inside.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("a removal whose answer was lost is retried without a second write", async () => {
  loseDeleteResponse = true;
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");

  fireEvent.click(inside.getByRole("button", { name: "Remove provider" }));
  await inside.findByText(
    "Removal could not be confirmed. Try again to check whether the provider is still registered.",
  );
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await inside.findByText(
    "This provider was removed or its setup changed. Close this dialog and review the list.",
  );
  expect(writes).toHaveLength(1);
});

test("losing permission on the re-read says so, and writes nothing", async () => {
  const view = await draw();
  const { in: inside } = await open(view);
  await inside.findByText("2 people lose their only way in.");
  listStatus = 403;

  fireEvent.click(inside.getByRole("button", { name: "Remove provider" }));
  await inside.findByText("You no longer have permission to make this change.");
  expect(inside.queryByRole("button", { name: "Remove provider" })).toBeNull();
  expect(writes).toEqual([]);
});

test("a provider removed while the dialog is open says so, and keeps Remove disabled", async () => {
  impactStatus = 404;
  const view = await draw();
  const { in: inside } = await open(view);
  // The server's own sentence, since it knows why.
  await inside.findByText("There is no such provider.");
  expect(
    inside
      .getByRole("button", { name: "Remove provider" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(writes).toEqual([]);
});
