import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import type { Browser, Page } from "playwright";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import {
  MASKED_VALUE,
  maskSensitiveValues,
  SECRET_ATTRIBUTE,
  sensitiveRefs,
} from "../src/secret-masking";
import {
  fillSignIn,
  fillSignInCode,
  originOfUrl,
  parseSignInCode,
  parseSignInFill,
} from "../src/sign-in";

/**
 * The computer's half of the private sign-in, against a real Chromium and a real login page served
 * on 127.0.0.1: the login is typed by this process, only on the origin it was meant for, and neither
 * the snapshot nor the answer ever shows the password back.
 *
 * A verification code is only ever typed after the site asks for one: the fill reports a visible
 * one-time-code field and stops, and the code is a second, separate submission to the page that is
 * still waiting.
 *
 * The browser half is asked for by name, like `follows-popup.test.ts`: it launches a real Chromium,
 * which the machine running the suite is not required to have, so Playwright is imported only then.
 * The suite runs on the e2e runner (`bun test` stopped being an entry when the suite moved onto the
 * e2e-compat layer, which Bun's `node:module` cannot load):
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bunx e2e run --config e2e.unit.config.ts agent-computer/tests/sign-in.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const PASSWORD = "hunter2-not-for-the-model";
const CODE = "918273-not-for-the-model";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** A second origin, for a site that moves its code step somewhere else entirely. */
let elsewhere: ReturnType<typeof Bun.serve>;
let origin = "";
let otherOrigin = "";

const page = (body: string) =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });

const codeForm = (action: string) => `<form method="post" action="${action}">
      <label>Code <input name="code" autocomplete="one-time-code"></label>
      <button>Verify</button></form>`;

/**
 * The port a test server actually took. Bun's own `serve` binds before it answers; the runner's
 * Bun-shaped stand-in binds asynchronously, so the port is polled for instead of assumed.
 */
async function boundPort(server: ReturnType<typeof Bun.serve>) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (server.port > 0) return server.port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the test server never took a port");
}

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login")
        return page(`<form method="post" action="/session">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/session" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD &&
          form.get("email") === "a@example.test"
          ? Response.redirect(`${origin}/home`, 303)
          : page(`<p>Wrong password</p><form method="post" action="/session">
              <input name="email" type="email"><input name="password" type="password"></form>`);
      }
      if (url.pathname === "/step-one")
        return page(`<form method="get" action="/step-two">
          <input name="username" autocomplete="username"><button>Next</button></form>`);
      if (url.pathname === "/step-two")
        return page(`<form method="post" action="/session">
          <input name="email" type="email" value="${url.searchParams.get("username") ?? ""}">
          <input name="password" type="password"></form>`);
      if (url.pathname === "/home") return page("<h1>Welcome back</h1>");
      // A login whose password is answered with a one-time-code page on this origin.
      if (url.pathname === "/login-2fa")
        return page(`<form method="post" action="/two-factor">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/two-factor" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD
          ? page(codeForm("/check-code"))
          : page(`<p>Wrong password</p><form method="post" action="/two-factor">
              <input name="email" type="email"><input name="password" type="password"></form>`);
      }
      // The code step itself: the right code finishes, a wrong one asks again, and one site answers
      // a code it does not like with the login page from the start.
      if (url.pathname === "/check-code" && request.method === "POST") {
        const form = await request.formData();
        if (form.get("code") === CODE)
          return Response.redirect(`${origin}/home`, 303);
        return page(`<p>Wrong code</p>${codeForm("/check-code")}`);
      }
      if (url.pathname === "/login-2fa-back")
        return page(`<form method="post" action="/two-factor-back">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/two-factor-back" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD
          ? page(codeForm("/check-code-back"))
          : page(`<p>Wrong password</p><form method="post" action="/two-factor-back">
              <input name="email" type="email"><input name="password" type="password"></form>`);
      }
      if (url.pathname === "/check-code-back" && request.method === "POST") {
        const form = await request.formData();
        return form.get("code") === CODE
          ? Response.redirect(`${origin}/home`, 303)
          : page(`<p>That code did not work. Sign in again.</p>
              <form method="post" action="/two-factor-back">
                <label>Email <input name="email" type="email"></label>
                <label>Password <input name="password" type="password"></label>
                <button>Sign in</button></form>`);
      }
      // A login page that already shows a code field next to the password, and wants none of it:
      // the password alone is accepted.
      if (url.pathname === "/login-with-code")
        return page(`<form method="post" action="/accept-password">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <label>Code <input name="code" autocomplete="one-time-code"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/accept-password" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD
          ? page("<h1>No code was needed</h1>")
          : new Response("denied", { status: 403 });
      }
      // The code field shows up only a moment after the password, the way a slow site draws one.
      if (url.pathname === "/login-late-code")
        return page(`<form method="post" action="/late-code">
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/late-code" && request.method === "POST") {
        const form = await request.formData();
        if (form.get("password") !== PASSWORD)
          return new Response("denied", { status: 403 });
        return page(`<p>Checking your sign-in…</p><script>
          setTimeout(() => {
            document.body.insertAdjacentHTML("beforeend",
              \`${codeForm("/check-code")}\`);
          }, 2500);
        </script>`);
      }
      // A site that moves the code step to another origin entirely.
      if (url.pathname === "/login-cross")
        return page(`<form method="post" action="${otherOrigin}/cross-code">
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${await boundPort(server)}`;
  elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/cross-code")
        return page(
          `<p>Verify it is really you</p>${codeForm("/cross-check")}`,
        );
      return new Response("not found", { status: 404 });
    },
  });
  otherOrigin = `http://127.0.0.1:${await boundPort(elsewhere)}`;
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  elsewhere?.stop(true);
});

async function open(path: string): Promise<Page> {
  const tab = await browser.newPage();
  await tab.goto(`${origin}${path}`);
  return tab;
}

describe("parsing what the server sends", () => {
  test("refuses a body without an origin or password, and never quotes a value", () => {
    expect(parseSignInFill({ origin: "nope", password: PASSWORD })).toBe(
      "A sign-in names the website's origin.",
    );
    expect(parseSignInFill({ origin, password: "" })).toBe(
      "A sign-in needs a password.",
    );
    expect(
      parseSignInFill({ origin: `${origin}/login`, password: PASSWORD }),
    ).toEqual({
      origin,
      password: PASSWORD,
    });
    expect(originOfUrl("about:blank")).toBe("");
  });

  test("a code an old client sent along with the password is not read, and is no error", () => {
    const parsed = parseSignInFill({
      origin,
      password: PASSWORD,
      code: CODE,
    });
    expect(parsed).toEqual({ origin, password: PASSWORD });
  });
});

describe("parsing the verification code a person submits", () => {
  test("takes an origin and a trimmed code, and never quotes the value", () => {
    expect(parseSignInCode({ origin, code: `  ${CODE}  ` })).toEqual({
      origin,
      code: CODE,
    });
    expect(parseSignInCode({ origin: "nope", code: CODE })).toBe(
      "A sign-in names the website's origin.",
    );
    expect(parseSignInCode({ origin, code: "" })).toBe(
      "A verification code is required.",
    );
    expect(parseSignInCode({ origin, code: "   " })).toBe(
      "A verification code is required.",
    );
    expect(parseSignInCode({ origin, code: "9".repeat(65) })).toBe(
      "A verification code is at most 64 characters.",
    );
    expect(parseSignInCode("not an object")).toBe(
      "A sign-in needs a JSON body.",
    );
    // The boundary itself is allowed.
    expect(parseSignInCode({ origin, code: "9".repeat(64) })).toEqual({
      origin,
      code: "9".repeat(64),
    });
  });
});

describe.skipIf(!asked)("typing a login", () => {
  test("fills and submits a one-step form, and reports only the outcome", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      codeRequested: false,
      url: `${origin}/home`,
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await tab.close();
  });

  test("a rejected password leaves a password field showing, which is the failure signal", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "wrong-one",
    });
    expect(result.submitted).toBe(true);
    expect(result.passwordFieldVisible).toBe(true);
    await tab.close();
  });

  test("follows a two-step login on the same origin", async () => {
    const tab = await open("/step-one");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({
      submitted: true,
      passwordFieldVisible: false,
    });
    expect(result.url).toBe(`${origin}/home`);
    await tab.close();
  });

  test("types nothing when the page is on another origin", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin: "https://example.com",
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result.submitted).toBe(false);
    expect(result.error).toContain("not on https://example.com");
    expect(await tab.locator("input[type=password]").inputValue()).toBe("");
    await tab.close();
  });
});

describe.skipIf(!asked)("the code the site asks for after the password", () => {
  test("a visible one-time-code field is reported, and left for the person to fill", async () => {
    const tab = await open("/login-2fa");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      codeRequested: true,
      url: `${origin}/two-factor`,
    });
    // Nothing was typed into the field the site just drew.
    expect(
      await tab.locator("input[autocomplete=one-time-code]").inputValue(),
    ).toBe("");
    await tab.close();
  });

  test("a code field that shows up late is still caught, and never typed early", async () => {
    const tab = await open("/login-late-code");
    const result = await fillSignIn(tab, { origin, password: PASSWORD });
    expect(result.submitted).toBe(true);
    expect(result.codeRequested).toBe(true);
    expect(await tab.locator("input[autocomplete=one-time-code]").count()).toBe(
      1,
    );
    await tab.close();
  });

  test("a code field sitting next to the password is not filled at the first submit", async () => {
    const tab = await open("/login-with-code");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    // The password alone was submitted; the page moved on and is not asking for a code now.
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      codeRequested: false,
      url: `${origin}/accept-password`,
    });
    await tab.close();
  });

  test("no code field is no codeRequested", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "wrong-one",
    });
    expect(result.submitted).toBe(true);
    expect(result.codeRequested).toBe(false);
    expect(result.passwordFieldVisible).toBe(true);
    await tab.close();
  });

  test("a site that moved the code step to another origin is not followed", async () => {
    const tab = await open("/login-cross");
    const result = await fillSignIn(tab, { origin, password: PASSWORD });
    expect(result.submitted).toBe(true);
    // Not reported as a code being asked for here: the person takes over instead.
    expect(result.codeRequested).toBe(false);
    expect(result.error).toContain(`moved to ${otherOrigin}`);
    // The code field on that other origin was not typed into either.
    expect(
      await tab.locator("input[autocomplete=one-time-code]").inputValue(),
    ).toBe("");
    await tab.close();
  });
});

describe.skipIf(!asked)(
  "typing the code into the page that asked for it",
  () => {
    test("the right code finishes the sign-in, and the answer never shows the code", async () => {
      const tab = await open("/login-2fa");
      const fill = await fillSignIn(tab, {
        origin,
        username: "a@example.test",
        password: PASSWORD,
      });
      expect(fill.codeRequested).toBe(true);
      const result = await fillSignInCode(tab, { origin, code: CODE });
      expect(result).toEqual({
        submitted: true,
        codeFieldVisible: false,
        passwordFieldVisible: false,
        url: `${origin}/home`,
      });
      expect(JSON.stringify(result)).not.toContain(CODE);
      await tab.close();
    });

    test("a wrong code leaves the code field showing, which is the retry signal", async () => {
      const tab = await open("/login-2fa");
      await fillSignIn(tab, {
        origin,
        username: "a@example.test",
        password: PASSWORD,
      });
      const result = await fillSignInCode(tab, {
        origin,
        code: "000000-wrong",
      });
      expect(result).toEqual({
        submitted: true,
        codeFieldVisible: true,
        passwordFieldVisible: false,
        url: `${origin}/check-code`,
      });
      await tab.close();
    });

    test("a site that answers a code with the login page says the password is wanted again", async () => {
      const tab = await open("/login-2fa-back");
      const fill = await fillSignIn(tab, {
        origin,
        username: "a@example.test",
        password: PASSWORD,
      });
      expect(fill.codeRequested).toBe(true);
      const result = await fillSignInCode(tab, {
        origin,
        code: "000000-wrong",
      });
      expect(result.submitted).toBe(true);
      expect(result.codeFieldVisible).toBe(false);
      expect(result.passwordFieldVisible).toBe(true);
      expect(result.url).toBe(`${origin}/check-code-back`);
      await tab.close();
    });

    test("with no code field on the page any more, nothing is typed", async () => {
      const tab = await open("/home");
      const result = await fillSignInCode(tab, { origin, code: CODE });
      expect(result.submitted).toBe(false);
      expect(result.error).toContain(
        "not asking for a verification code any more",
      );
      await tab.close();
    });

    test("a page that has moved off the origin refuses the code, wherever it went", async () => {
      const tab = await open("/login-2fa");
      await fillSignIn(tab, {
        origin,
        username: "a@example.test",
        password: PASSWORD,
      });
      // The Bot navigated away after the fill: the code must not follow it.
      await tab.goto("about:blank");
      const result = await fillSignInCode(tab, { origin, code: CODE });
      expect(result.submitted).toBe(false);
      expect(result.error).toContain(`not on ${origin}`);
      // Same refusal when the page sits on another real origin.
      await tab.goto(`${otherOrigin}/cross-code`);
      const moved = await fillSignInCode(tab, { origin, code: CODE });
      expect(moved.submitted).toBe(false);
      expect(moved.error).toContain(`not on ${origin}`);
      expect(
        await tab.locator("input[autocomplete=one-time-code]").inputValue(),
      ).toBe("");
      await tab.close();
    });
  },
);

describe.skipIf(!asked)("secrets typed into the page are not read back", () => {
  test("the aria snapshot shows a password's value, and the masked snapshot does not", async () => {
    const tab = await browser.newPage();
    await tab.setContent(`<form>
      <input aria-label="User" value="alice">
      <input aria-label="Password" type="password" value="${PASSWORD}">
      <input aria-label="API token" id="token" value="tok_live_abc123">
    </form>`);
    // Mark the token field the way a supplied secret is marked.
    await tab
      .locator("#token")
      .evaluate(
        (element, attribute) => element.setAttribute(attribute, "true"),
        SECRET_ATTRIBUTE,
      );
    const yaml = await tab.ariaSnapshot({ mode: "ai" });
    // The leak this guards against, confirmed rather than assumed.
    expect(yaml).toContain(PASSWORD);
    const { elements } = parseAriaSnapshot(yaml);
    const masked = maskSensitiveValues(
      elements,
      await sensitiveRefs(tab, elements),
    );
    const text = JSON.stringify(masked);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("tok_live_abc123");
    expect(text).toContain("alice");
    expect(
      masked.filter((element) => element.value === MASKED_VALUE),
    ).toHaveLength(2);
    await tab.close();
  });
});
