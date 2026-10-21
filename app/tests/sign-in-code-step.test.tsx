import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "@/components/passwords/sign-in-form";
import i18n from "@/lib/i18n";
import { queryClient } from "@/query-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/*
 * The sign-in form's two steps, and the secrets they carry.
 *
 * The password is typed first and sent alone; only when the site, having taken the password, asks
 * for a verification code does the form ask for one — and then for the code alone. Whatever is sent
 * is cleared the moment the send settles, both from the fields and from the mutation cache TanStack
 * would otherwise keep: a code is good once, a failed attempt is retyped, and nothing typed here is
 * ever kept anywhere this component does not need it.
 *
 * The server is a stub that answers every request route with the request's current state; a test
 * moves `server` forward to play the site (accepted, refused the code, closed) and reads `calls` to
 * pin exactly what this form put on the wire. The form renders against the module's query-client
 * singleton — the same client its mutation factories close over, so a settled send actually
 * invalidates the query the form is reading — cleared before and after every test.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;
});
afterAll(async () => {
  await settleReactWork();
  void i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const REQUEST_ID = "request-code";
const SITE = "https://shop.example";
const CODE = "313131";
const RETRY_CODE = "747474";

/** The request as the form reads it, from the server state a test has set. */
let server: { status: string; outcome: string | null; method: string | null };

const request = () => ({
  id: REQUEST_ID,
  botId: "default",
  origin: SITE,
  reason: null,
  status: server.status,
  method: server.method,
  outcome: server.outcome,
  threadId: null,
  toolCallId: null,
  controlRequestId: null,
  createdAt: "2026-10-20T10:00:00Z",
  expiresAt: "2026-10-20T10:15:00Z",
  resolvedAt: null,
  passwordManager: false,
  savedLogins: [],
});

type Call = { path: string; method: string; body: unknown };

function serving() {
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (path.startsWith(`/api/sign-in-requests/${REQUEST_ID}`))
        return Response.json(request());
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    {
      preconnect: (globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch)
        .preconnect,
    },
  );
  return calls;
}

function renderForm() {
  const user = userEvent.setup({ document });
  const tree = render(
    <QueryClientProvider client={queryClient}>
      <SignInForm requestId={REQUEST_ID} />
    </QueryClientProvider>,
  );
  // Whether any mutation variable still holds a secret: the seam the secret hygiene of this file
  // is pinned on. (The cache may rightly hold non-secrets, e.g. the request id a cancel carries.)
  const leaks = (secret: string) =>
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        JSON.stringify(mutation.state.variables ?? "").includes(secret),
      );
  return { user, tree, leaks };
}

test("the first step asks for a login, never for a code", async () => {
  server = { status: "pending", outcome: null, method: null };
  serving();
  const { tree } = renderForm();
  await tree.findByLabelText("Password");
  // No code is asked before the site has taken the password; the site has not been touched yet.
  expect(tree.queryByLabelText(/Verification code/)).toBeNull();
  expect(tree.queryByLabelText("Username or email")).not.toBeNull();
});

test("the first submission sends the password alone", async () => {
  server = { status: "pending", outcome: null, method: null };
  const calls = serving();
  const { user, tree } = renderForm();
  await user.type(await tree.findByLabelText("Password"), "correct horse");
  // If an old build still draws a code field here, type one into it: the pin is that this form
  // sends the password and no code, whatever is on the screen.
  const code = tree.queryByLabelText(/Verification code/);
  if (code) await user.type(code, CODE);
  await user.click(tree.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path.endsWith("/submit"))).toHaveLength(
      1,
    ),
  );
  expect(calls.find((call) => call.path.endsWith("/submit"))?.body).toEqual({
    password: "correct horse",
    save: false,
  });
  // A failed attempt is retyped, never kept: the field empties with the send.
  await waitFor(() =>
    expect((tree.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    ),
  );
});

test("the code step asks for only the code", async () => {
  server = { status: "code_required", outcome: null, method: "typed" };
  serving();
  const { tree } = renderForm();
  expect(
    ((await tree.findByLabelText("Verification code")) as HTMLInputElement)
      .value,
  ).toBe("");
  // The password step is done; asking for it again would send it twice.
  expect(tree.queryByLabelText("Password")).toBeNull();
  expect(tree.queryByLabelText("Username or email")).toBeNull();
  // The step says why it is here: the site took the password and sent a code.
  await tree.findByText(/asked for one after your password/);
});

test("a wrong code is cleared, explained, and can be sent again", async () => {
  server = { status: "code_required", outcome: null, method: "typed" };
  const calls = serving();
  const { user, tree } = renderForm();
  await user.type(await tree.findByLabelText("Verification code"), CODE);
  // The site refuses the code and keeps asking.
  server = {
    status: "code_required",
    outcome: "That code did not work. The field is still on the page.",
    method: "typed",
  };
  await user.click(tree.getByRole("button", { name: "Finish signing in" }));
  await tree.findByText(/That code did not work/);
  const field = tree.getByLabelText("Verification code");
  expect((field as HTMLInputElement).value).toBe("");
  // An explicit second send: typed again, sent again, the code and nothing else.
  await user.type(field, RETRY_CODE);
  await user.click(tree.getByRole("button", { name: "Finish signing in" }));
  await waitFor(() =>
    expect(
      calls.filter((call) => call.path.endsWith("/code")).map((c) => c.body),
    ).toEqual([{ code: CODE }, { code: RETRY_CODE }]),
  );
});

test("a settled send leaves no secret in the mutation cache", async () => {
  server = { status: "pending", outcome: null, method: null };
  const calls = serving();
  const { user, tree, leaks } = renderForm();
  await user.type(await tree.findByLabelText("Password"), "correct horse");
  // The site took the password and sent a code.
  server = { status: "code_required", outcome: null, method: "typed" };
  await user.click(tree.getByRole("button", { name: "Sign in" }));
  await user.type(await tree.findByLabelText("Verification code"), CODE);
  // The site refuses the code and keeps asking.
  server = {
    status: "code_required",
    outcome: "That code did not work.",
    method: "typed",
  };
  await user.click(tree.getByRole("button", { name: "Finish signing in" }));
  await tree.findByText(/That code did not work/);
  // Both sends are settled now: the password and the code live nowhere TanStack keeps.
  await waitFor(() => {
    expect(leaks("correct horse")).toBe(false);
    expect(leaks(CODE)).toBe(false);
  });
  // And nothing this flow typed ever headed for the vault.
  expect(calls.some((call) => call.path.startsWith("/api/passwords"))).toBe(
    false,
  );
});

test("a filling request offers nothing to submit again", async () => {
  server = { status: "filling", outcome: null, method: "typed" };
  serving();
  const { tree } = renderForm();
  await tree.findByText(/being typed into/);
  expect(tree.container.querySelectorAll("button")).toHaveLength(0);
  expect(tree.queryByLabelText("Password")).toBeNull();
  expect(tree.queryByLabelText(/Verification code/)).toBeNull();
});

test("a closed request offers no controls", async () => {
  server = {
    status: "cancelled",
    outcome: "The person chose not to sign in.",
    method: null,
  };
  serving();
  const { tree } = renderForm();
  await tree.findByText("Closed");
  expect(tree.container.querySelectorAll("button")).toHaveLength(0);
});

test("declining clears what was typed", async () => {
  server = { status: "pending", outcome: null, method: null };
  const calls = serving();
  const { user, tree, leaks } = renderForm();
  await user.type(await tree.findByLabelText("Password"), "correct horse");
  await user.click(tree.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/cancel"))).toBe(true),
  );
  expect((tree.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  expect(
    (tree.getByLabelText("Username or email") as HTMLInputElement).value,
  ).toBe("");
  await waitFor(() => expect(leaks("correct horse")).toBe(false));
});

test("unmounting mid-send leaves no secret in the mutation cache", async () => {
  server = { status: "code_required", outcome: null, method: "typed" };
  serving();
  const { user, tree, leaks } = renderForm();
  await user.type(await tree.findByLabelText("Verification code"), CODE);
  server = { status: "signed_in", outcome: null, method: "typed" };
  await user.click(tree.getByRole("button", { name: "Finish signing in" }));
  // Gone before the send has even answered.
  tree.unmount();
  await waitFor(() => expect(leaks(CODE)).toBe(false));
});

test("the code step speaks both languages", async () => {
  await i18n.changeLanguage("en");
  expect(i18n.t("signInForm.codeTitle")).toBe("Enter the verification code");
  expect(i18n.t("signInForm.finishSignIn")).toBe("Finish signing in");
  expect(i18n.t("signInForm.workingDescription")).toBe(
    "Your login is being typed into the Bot's browser. This page continues on its own.",
  );
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("signInForm.codeTitle")).toBe("输入验证码");
  expect(i18n.t("signInForm.finishSignIn")).toBe("完成登录");
  expect(i18n.t("signInForm.workingDescription")).toBe(
    "你的登录信息正在被输入到 Bot 的浏览器中。此页面会自动继续。",
  );
  await i18n.changeLanguage("en");
});
