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
import { CredentialsPage } from "@/components/manage/credentials-page";
import type { CredentialStatus } from "@/lib/credentials/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin Credentials, where an administrator revokes a key or token this deployment holds. The
 * server is faked at the fetch boundary with the shapes the list, the usage read and the revoke
 * route answer with, and every write is recorded.
 *
 * The confirmation said "Any apps or models using it may stop working" for every row, whatever its
 * type and whatever actually held it. It now names the kind and lists what the vault says holds the
 * credential, so a key nothing uses reads as such.
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

function credential(
  overrides: Partial<CredentialStatus> & { id: string },
): CredentialStatus {
  return {
    kind: "connector",
    provider: "notion",
    keyId: "workspace",
    metadata: {},
    revokedAt: null,
    ...overrides,
  };
}

type Usage = { features: string[]; bots: { id: string; name: string }[] };

let credentials: CredentialStatus[];
let usage: Record<string, Usage>;
/** A status the usage read answers with instead of the usage. */
let usageStatus: number | null;
/** A test that wants the dialog open while usage is still being read holds it here. */
let usageGate: Promise<void> | null;
let edition: "team" | "personal";
/** How many revokes answer 500 before the server starts accepting them. */
let failingRevokes: number;
/** Whether the next revoke commits and then never answers. */
let loseRevokeResponse: boolean;
/** A test that wants to press again mid-submit holds the revoke here. */
let inFlight: Promise<void> | null;
/** A status the credential list answers with on the re-read. */
let listStatus: number | null;
let writes: { method: string; path: string }[];

beforeEach(() => {
  credentials = [
    credential({ id: "cred-live", kind: "connector", provider: "notion" }),
    credential({
      id: "cred-model",
      kind: "model",
      provider: "openai",
      keyId: "max-tokens",
    }),
    credential({
      id: "cred-orphan",
      kind: "mcp_user_token",
      provider: "github",
      keyId: "alice",
    }),
  ];
  usage = {
    "cred-live": {
      features: ["Notion app"],
      bots: [
        { id: "bot-ada", name: "Ada" },
        { id: "bot-grace", name: "Grace" },
      ],
    },
    "cred-model": { features: ["Model access for every Bot"], bots: [] },
    "cred-orphan": { features: [], bots: [] },
  };
  usageStatus = null;
  usageGate = null;
  edition = "team";
  failingRevokes = 0;
  loseRevokeResponse = false;
  inFlight = null;
  listStatus = null;
  writes = [];
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition,
  });
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status });
    const usageMatch = path.match(/^\/api\/admin\/credentials\/(.+)\/usage$/);
    if (method === "GET" && usageMatch) {
      if (usageGate) await usageGate;
      if (usageStatus) {
        return json(
          {
            error:
              usageStatus === 404
                ? "Credential was not found."
                : "The usage could not be read.",
          },
          usageStatus,
        );
      }
      return json({ usage: usage[decodeURIComponent(usageMatch[1] ?? "")] });
    }
    if (method === "GET" && path === "/api/admin/credentials") {
      return listStatus
        ? json({ error: "The credentials could not be read." }, listStatus)
        : json({ credentials });
    }
    const revokeMatch = path.match(/^\/api\/admin\/credentials\/(.+)\/revoke$/);
    if (method === "POST" && revokeMatch) {
      writes.push({ method, path });
      if (inFlight) await inFlight;
      if (failingRevokes > 0) {
        failingRevokes -= 1;
        return json({ error: "The server could not do that." }, 500);
      }
      const id = decodeURIComponent(revokeMatch[1] ?? "");
      credentials = credentials.map((entry) =>
        entry.id === id
          ? { ...entry, revokedAt: "2026-11-25T18:00:00.000Z" }
          : entry,
      );
      // What a dropped connection looks like: the write landed, its answer never arrived.
      if (loseRevokeResponse) {
        loseRevokeResponse = false;
        throw new TypeError("Failed to fetch");
      }
      return json({
        credential: { id, revokedAt: "2026-11-25T18:00:00.000Z" },
      });
    }
    return json({ error: "not served" }, 404);
  }) as unknown as typeof fetch;
});

async function draw() {
  const router = createRouter({
    routeTree: createRootRoute({ component: CredentialsPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await view.findByText("notion");
  return view;
}

async function open(view: Awaited<ReturnType<typeof draw>>, keyId: string) {
  fireEvent.click(
    view.getByRole("button", { name: `Revoke ${keyId} for notion` }),
  );
  const dialog = await view.findByRole("alertdialog");
  return { dialog, in: within(dialog) };
}

test("the revoke confirmation names the kind, and the Bots and features the vault says use it", async () => {
  const view = await draw();
  const { dialog, in: inside } = await open(view, "workspace");
  expect(dialog.textContent).toContain("Revoke workspace for notion?");
  expect(dialog.textContent).toContain(
    "This is a Connector credential for this deployment.",
  );
  await inside.findByText("Notion app");
  expect(dialog.textContent).toContain("Ada");
  expect(dialog.textContent).toContain("Grace");
  expect(writes).toEqual([]);
});

test("a model credential says it is the model access for every Bot", async () => {
  const view = await draw();
  fireEvent.click(
    view.getByRole("button", { name: "Revoke max-tokens for openai" }),
  );
  const dialog = await view.findByRole("alertdialog");
  expect(dialog.textContent).toContain(
    "This is a Model credential for this deployment.",
  );
  await within(dialog).findByText("Model access for every Bot");
});

test("the list row names the kind rather than the stored slug", async () => {
  const view = await draw();
  expect(view.getByText("Personal app token · alice · active")).toBeTruthy();
});

test("a credential nothing uses reads as used by nothing", async () => {
  usage["cred-live"] = { features: [], bots: [] };
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText(
    "Nothing in this deployment points at this credential.",
  );
});

test("the personal edition calls it a key and names what has it in its own words", async () => {
  edition = "personal";
  usage["cred-live"] = { features: [], bots: [] };
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition,
  });
  const view = await draw();
  const { dialog, in: inside } = await open(view, "workspace");
  expect(dialog.textContent).toContain("This is a Connector key.");
  await inside.findByText("Nothing in OpenBot points at this key.");
});

test("Revoke stays disabled until the usage read has answered", async () => {
  let release: () => void = () => {};
  usageGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  const revoke = inside.getByRole("button", { name: "Revoke credential" });
  expect(revoke.getAttribute("aria-disabled")).toBe("true");
  expect(writes).toEqual([]);
  release();
  await waitFor(() =>
    expect(revoke.getAttribute("aria-disabled")).not.toBe("true"),
  );
});

test("a failed usage read says so and retries in place", async () => {
  usageStatus = 500;
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  // The read retries once on its own before the error, and this one keeps failing.
  const retry = await inside.findByRole(
    "button",
    { name: "Retry preview" },
    { timeout: 3000 },
  );
  const revoke = inside.getByRole("button", { name: "Revoke credential" });
  expect(revoke.getAttribute("aria-disabled")).toBe("true");

  usageStatus = null;
  fireEvent.click(retry);
  await inside.findByText("Notion app");
  await waitFor(() =>
    expect(revoke.getAttribute("aria-disabled")).not.toBe("true"),
  );
  expect(writes).toEqual([]);
});
test("cancel sends nothing and gives focus back to the control that opened the confirmation", async () => {
  const view = await draw();
  const trigger = view.getByRole("button", {
    name: "Revoke workspace for notion",
  });
  trigger.focus();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");
  expect(document.activeElement).toBe(
    inside.getByRole("button", { name: "Cancel" }),
  );

  fireEvent.click(inside.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(writes).toEqual([]);
});

test("pressing Revoke three times during a submit sends one request", async () => {
  let release: () => void = () => {};
  inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");

  fireEvent.click(inside.getByRole("button", { name: "Revoke credential" }));
  const pending = await inside.findByRole("button", {
    name: "Revoking credential…",
  });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(writes).toHaveLength(1);
  fireEvent.click(pending);
  fireEvent.click(pending);
  expect(writes).toHaveLength(1);

  release();
  await view.findByText("workspace was revoked.");
  expect(writes).toHaveLength(1);
  // The revoked row keeps its Revoke button disabled, so focus lands on Add credential.
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: /Add credential/ }),
  );
});

test("a refusal keeps the confirmation with its preview, and Try again revokes it", async () => {
  failingRevokes = 1;
  const view = await draw();
  const { dialog, in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");

  fireEvent.click(inside.getByRole("button", { name: "Revoke credential" }));
  await inside.findByText(
    "Revocation could not be confirmed. Try again to check the credential’s status.",
  );
  expect(dialog.textContent).toContain("Revoke workspace for notion?");
  expect(dialog.textContent).toContain("Notion app");

  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await view.findByText("workspace was revoked.");
  expect(writes).toHaveLength(2);
});

test("a credential revoked under the dialog writes nothing and offers Close only", async () => {
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");
  credentials = credentials.map((entry) =>
    entry.id === "cred-live"
      ? { ...entry, revokedAt: "2026-11-25T17:00:00.000Z" }
      : entry,
  );

  fireEvent.click(inside.getByRole("button", { name: "Revoke credential" }));
  await inside.findByText(
    "This credential is missing or already revoked. Close this dialog and review the list.",
  );
  expect(
    inside.queryByRole("button", { name: "Revoke credential" }),
  ).toBeNull();
  fireEvent.click(inside.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
  expect(writes).toEqual([]);
});

test("a revoke whose answer was lost is retried without a second write", async () => {
  loseRevokeResponse = true;
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");

  fireEvent.click(inside.getByRole("button", { name: "Revoke credential" }));
  await inside.findByText(
    "Revocation could not be confirmed. Try again to check the credential’s status.",
  );
  fireEvent.click(inside.getByRole("button", { name: "Try again" }));
  await inside.findByText(
    "This credential is missing or already revoked. Close this dialog and review the list.",
  );
  expect(writes).toHaveLength(1);
});

test("losing permission on the re-read says so, and writes nothing", async () => {
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  await inside.findByText("Notion app");
  listStatus = 403;

  fireEvent.click(inside.getByRole("button", { name: "Revoke credential" }));
  await inside.findByText("You no longer have permission to make this change.");
  expect(
    inside.queryByRole("button", { name: "Revoke credential" }),
  ).toBeNull();
  expect(writes).toEqual([]);
});

test("a credential gone from the vault while the dialog is open says so, and keeps Revoke disabled", async () => {
  usageStatus = 404;
  const view = await draw();
  const { in: inside } = await open(view, "workspace");
  // The server's own sentence, since it knows why.
  await inside.findByText("Credential was not found.");
  expect(
    inside
      .getByRole("button", { name: "Revoke credential" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(writes).toEqual([]);
});
