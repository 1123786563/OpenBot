/**
 * Typing a person's login into the Bot's page, on this side of the wire.
 *
 * The private sign-in form posts a username and password to the server, the server posts them here,
 * and this types them. The Bot is never involved: it does not pick the fields, it does not see the
 * values, and what comes back says only whether a form was submitted, whether a password field is
 * still showing, and whether the site went on to ask for a verification code.
 *
 * A verification code is never asked for up front. It comes after the password, and only when the
 * site, having accepted the password, shows a one-time-code field: `fillSignIn` reports that and
 * stops, the person is asked for the code the site just sent, and `fillSignInCode` types it into the
 * page that is still waiting for it.
 *
 * Three refusals, before anything is typed:
 *  - the page must be on the exact origin the person was asked to sign in to, so a login cannot be
 *    carried to a page that redirected somewhere else (or that the Bot navigated to afterwards);
 *  - there must be a login form on it;
 *  - a two-step login that moves to another origin between the username and password (an identity
 *    provider, say) is not followed: the person is asked to take over instead.
 *
 * Every failure is one of this module's own sentences. A Playwright error can quote the call it was
 * making, and this call's arguments are a password.
 */
import type { Locator, Page } from "playwright";
import { markElementSecret, SECRET_ATTRIBUTE } from "./secret-masking";

export type SignInFillInput = {
  origin: string;
  username?: string;
  password: string;
};

export type SignInFillResult = {
  submitted: boolean;
  passwordFieldVisible: boolean;
  /** The site accepted the password and is now showing a one-time-code field, on this origin. */
  codeRequested: boolean;
  url: string;
  error?: string;
};

export type SignInCodeInput = { origin: string; code: string };

export type SignInCodeResult = {
  submitted: boolean;
  /** Whether a code field is still showing after submitting: the plainest sign the code was refused. */
  codeFieldVisible: boolean;
  passwordFieldVisible: boolean;
  url: string;
  error?: string;
};

const LOGIN_ATTRIBUTE = "data-openbot-login";
const STEP_TIMEOUT_MS = 15_000;

/** The origin of a URL, or empty for one that has none (`about:blank`). */
export function originOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/** Parse the body the server sends, without ever putting a value in an error. */
export function parseSignInFill(body: unknown): SignInFillInput | string {
  if (!body || typeof body !== "object") return "A sign-in needs a JSON body.";
  const input = body as Record<string, unknown>;
  if (typeof input.origin !== "string" || !originOfUrl(input.origin))
    return "A sign-in names the website's origin.";
  if (typeof input.password !== "string" || !input.password)
    return "A sign-in needs a password.";
  if (input.username !== undefined && typeof input.username !== "string")
    return "The username must be text.";
  // A `code` is not read: one is only ever typed after the site asks for it, by `fillSignInCode`.
  // An older server that still sends one alongside the password is answered normally.
  return {
    origin: originOfUrl(input.origin),
    password: input.password,
    ...(input.username ? { username: input.username } : {}),
  };
}

/** Parse the verification-code body, the same way. */
export function parseSignInCode(body: unknown): SignInCodeInput | string {
  if (!body || typeof body !== "object") return "A sign-in needs a JSON body.";
  const input = body as Record<string, unknown>;
  if (typeof input.origin !== "string" || !originOfUrl(input.origin))
    return "A sign-in names the website's origin.";
  if (typeof input.code !== "string" || !input.code.trim())
    return "A verification code is required.";
  if (input.code.length > 64)
    return "A verification code is at most 64 characters.";
  return { origin: originOfUrl(input.origin), code: input.code.trim() };
}

/**
 * Find the login fields on the page and mark them for the locators below.
 *
 * Runs in the page. A password field is any visible `input[type=password]`; the username is the
 * visible text-like input before it in the same form, preferring one the site labels as a username or
 * email. With no password field, a lone username field is the first step of a two-step login.
 */
function markLoginFields(attribute: string) {
  for (const node of document.querySelectorAll(`[${attribute}]`))
    node.removeAttribute(attribute);
  const visible = (element: Element) => {
    const input = element as HTMLInputElement;
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !input.disabled &&
      !input.readOnly
    );
  };
  const passwords = [
    ...document.querySelectorAll<HTMLInputElement>("input[type=password]"),
  ].filter(visible);
  const password =
    passwords.find((input) => /current-password/.test(input.autocomplete)) ??
    passwords[0];
  const scope: ParentNode = password?.form ?? document;
  const textLike = [
    ...scope.querySelectorAll<HTMLInputElement>("input"),
  ].filter(
    (input) =>
      ["text", "email", "tel", ""].includes(input.type) &&
      visible(input) &&
      (!password ||
        Boolean(
          input.compareDocumentPosition(password) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )),
  );
  const named = (input: HTMLInputElement) =>
    /username|email/.test(input.autocomplete) ||
    input.type === "email" ||
    /user|email|login|account|identifier/i.test(
      `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`,
    );
  const username =
    textLike.filter(named).at(-1) ?? (password ? textLike.at(-1) : undefined);
  if (username) username.setAttribute(attribute, "username");
  if (password) password.setAttribute(attribute, "password");
  return { username: Boolean(username), password: Boolean(password) };
}

/**
 * Find a one-time-code field. Runs in the page.
 *
 * The site's own `autocomplete="one-time-code"` first; otherwise a visible text-like field whose
 * name, id or label reads as a verification code. Any earlier mark is cleared, so a field that has
 * gone away is never typed into.
 *
 * The name fallback reads only fields whose subject is the code itself. A country, postal, promo
 * or voucher code is the site's own business datum, and a login page full of those must not read
 * as a code step; the exclusion therefore covers the business word directly followed by the code
 * word in the joined name/id/label, in any of the spellings sites use. It narrows only that
 * fallback: the site's own autocomplete stays authoritative whatever the field is called.
 */
function markCodeField(attribute: string) {
  for (const node of document.querySelectorAll(`[${attribute}="code"]`))
    node.removeAttribute(attribute);
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("input"),
  ].filter((input) => {
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !input.disabled &&
      !input.readOnly &&
      ["text", "tel", "number", "password", ""].includes(input.type)
    );
  });
  const businessCode =
    /(?:country|postal|post|promo|zip|area|dial|referral|voucher|coupon|discount)[\s_-]*code/i;
  const code =
    inputs.find((input) => /one-time-code/.test(input.autocomplete)) ??
    inputs.find((input) => {
      if (input.type === "password") return false;
      const described = `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`;
      return (
        /code|otp|totp|2fa|mfa|verif|passcode/i.test(described) &&
        !businessCode.test(described)
      );
    });
  if (code) code.setAttribute(attribute, "code");
  return Boolean(code);
}

/**
 * How a form is sent, decided in the page: its own submit button when it has one, the form itself
 * when it has none (a form with several fields and no button ignores Enter), and Enter otherwise.
 */
function markSubmit(
  field: Element,
  attribute: string,
): "button" | "form" | "key" {
  // An earlier step's submit mark goes first: a site that kept the login form in the document when
  // it moved on to a code step (an SPA hiding it, not navigating away) would otherwise leave two
  // marked buttons, and the click below would not know which one it was asked to press.
  for (const node of document.querySelectorAll(`[${attribute}="submit"]`))
    node.removeAttribute(attribute);
  const form = (field as HTMLInputElement).form;
  if (!form) return "key";
  const button = form.querySelector(
    "button:not([type=button]):not([type=reset]), input[type=submit]",
  );
  if (button) {
    button.setAttribute(attribute, "submit");
    return "button";
  }
  return "form";
}

async function submitFrom(page: Page, field: Locator) {
  const how = await field.evaluate(markSubmit, LOGIN_ATTRIBUTE);
  if (how === "button")
    await page
      .locator(`[${LOGIN_ATTRIBUTE}="submit"]`)
      .click({ timeout: STEP_TIMEOUT_MS });
  else if (how === "form")
    await field.evaluate((element) =>
      (element as HTMLInputElement).form?.requestSubmit(),
    );
  else await field.press("Enter", { timeout: STEP_TIMEOUT_MS });
}

async function settle(page: Page) {
  await page.waitForTimeout(800);
  await page
    .waitForLoadState("load", { timeout: STEP_TIMEOUT_MS })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
}

/** A password field still showing, other than a one-time-code field a site drew as one. */
async function passwordVisible(page: Page) {
  return (
    (await page
      .locator(`input[type=password]:visible:not([${LOGIN_ATTRIBUTE}="code"])`)
      .count()) > 0
  );
}

async function typeSecret(field: Locator, value: string) {
  await field.fill(value, { timeout: STEP_TIMEOUT_MS });
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE);
}

export async function fillSignIn(
  page: Page,
  input: SignInFillInput,
): Promise<SignInFillResult> {
  const answer = (error: string, submitted = false): SignInFillResult => ({
    submitted,
    passwordFieldVisible: false,
    codeRequested: false,
    url: page.url(),
    error,
  });
  if (originOfUrl(page.url()) !== input.origin)
    return answer(
      `The Bot's browser is not on ${input.origin}. Ask it to open that site's sign-in page and try again.`,
    );
  try {
    let found = await page.evaluate(markLoginFields, LOGIN_ATTRIBUTE);
    if (!found.password && !found.username)
      return answer("There is no sign-in form on the page the Bot has open.");
    const usernameField = page.locator(`[${LOGIN_ATTRIBUTE}="username"]`);
    if (found.username && input.username)
      await usernameField.fill(input.username, { timeout: STEP_TIMEOUT_MS });
    if (!found.password) {
      // Two steps: username first, then the site shows the password field.
      if (!input.username)
        return answer(
          "This site asks for a username first. Enter one and try again.",
        );
      await submitFrom(page, usernameField);
      await page
        .locator("input[type=password]:visible")
        .first()
        .waitFor({ timeout: STEP_TIMEOUT_MS })
        .catch(() => undefined);
      if (originOfUrl(page.url()) !== input.origin)
        return answer(
          `The sign-in moved to ${originOfUrl(page.url()) || "another page"}. Take over the browser to finish signing in there.`,
          true,
        );
      found = await page.evaluate(markLoginFields, LOGIN_ATTRIBUTE);
      if (!found.password)
        return answer(
          "The site did not ask for a password after the username.",
          true,
        );
    }
    const passwordField = page.locator(`[${LOGIN_ATTRIBUTE}="password"]`);
    await typeSecret(passwordField, input.password);
    await submitFrom(page, passwordField);
    await settle(page);
    // A password field still showing is a refused login; the server says so. Only past that is a
    // code field the site asking for a second step. The code field is looked for first, so one a
    // site draws as a password input is not mistaken for the login's own, and is then given a
    // moment to appear. Both readings are taken again once it has: the re-render the wait exists
    // for can bring the password field back as easily as bring a code field in, and a refusal
    // judged from the transition state's silence would tell the server the login went through.
    let codeRequested = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
    let refused = await passwordVisible(page);
    if (!codeRequested && !refused) {
      await page.waitForTimeout(2_000);
      codeRequested = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
      refused = await passwordVisible(page);
    }
    if (codeRequested && originOfUrl(page.url()) !== input.origin)
      return answer(
        `The sign-in moved to ${originOfUrl(page.url()) || "another page"} to ask for a verification code. Take over the browser to finish signing in there.`,
        true,
      );
    // A password field on another origin is that page's, not this login's refusal — an identity
    // provider asking for the password again, say. The person takes over there, the same way they
    // do for a code step that moved: the server is never told this login was refused.
    if (refused && originOfUrl(page.url()) !== input.origin)
      return answer(
        `The sign-in moved to ${originOfUrl(page.url()) || "another page"}. Take over the browser to finish signing in there.`,
        true,
      );
    // On this origin, a password field still showing is the refusal, however code-like the page
    // also looks: the login's own form never went away, so the site has not moved on to a code
    // step — not even when it draws a real one-time-code field beside the unchanged login form.
    // Read after the origin checks above, so a page that moved elsewhere keeps its take-over
    // answer rather than this origin's reading of the login form.
    if (refused) codeRequested = false;
    return {
      submitted: true,
      passwordFieldVisible: refused,
      codeRequested,
      url: page.url(),
    };
  } catch {
    return answer("The login could not be typed into the page.");
  }
}

/**
 * Type the verification code a site asked for into the page that is waiting for it.
 *
 * Only after `fillSignIn` reported `codeRequested`, and with the same refusals: the page must still
 * be on the origin the person was asked to sign in to, and must still be showing a code field.
 */
export async function fillSignInCode(
  page: Page,
  input: SignInCodeInput,
): Promise<SignInCodeResult> {
  const answer = (error: string, submitted = false): SignInCodeResult => ({
    submitted,
    codeFieldVisible: false,
    passwordFieldVisible: false,
    url: page.url(),
    error,
  });
  if (originOfUrl(page.url()) !== input.origin)
    return answer(
      `The Bot's browser is not on ${input.origin} any more. Take over the browser to finish signing in.`,
    );
  try {
    if (!(await page.evaluate(markCodeField, LOGIN_ATTRIBUTE)))
      return answer("The site is not asking for a verification code any more.");
    const codeField = page.locator(`[${LOGIN_ATTRIBUTE}="code"]`);
    await typeSecret(codeField, input.code);
    await submitFrom(page, codeField);
    await settle(page);
    let codeVisible = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
    let backToLogin = await passwordVisible(page);
    if (
      (codeVisible && originOfUrl(page.url()) === input.origin) ||
      !backToLogin
    ) {
      // A slow site may not have rendered its verdict yet — whether that verdict is the code page
      // going away or the login page coming back — so give it the same grace fillSignIn gives a
      // transition state, and take both readings again once it has. A success pays the wait too:
      // the same 2 seconds fillSignIn spends on every ordinary signed-in landing.
      await page.waitForTimeout(2_000);
      codeVisible = await page.evaluate(markCodeField, LOGIN_ATTRIBUTE);
      backToLogin = await passwordVisible(page);
    }
    // A password field on another origin is that page's, not this login back at its beginning — an
    // identity provider asking for the password again, say. The person takes over there, the same
    // way they do when the sign-in first moved: the server is never told the password is wanted
    // again, which would reopen a request the retry could not follow.
    if (backToLogin && originOfUrl(page.url()) !== input.origin)
      return answer(
        `The sign-in moved to ${originOfUrl(page.url()) || "another page"}. Take over the browser to finish signing in there.`,
        true,
      );
    // A code field on another origin is that page's, not this login waiting to hear its code was
    // right — a chained identity provider asking for another verification code, say. The person
    // takes over there, like the password above: the server is never told the code step is over,
    // which the empty verdict would otherwise have it read as the sign-in having gone through.
    if (codeVisible && originOfUrl(page.url()) !== input.origin)
      return answer(
        `The sign-in moved to ${originOfUrl(page.url()) || "another page"} to ask for another verification code. Take over the browser to finish signing in there.`,
        true,
      );
    // Only this origin's own code field is reported as the login still asking: what a page that
    // moved elsewhere draws is its own, and has been handed back above.
    const codeFieldVisible =
      codeVisible && originOfUrl(page.url()) === input.origin;
    return {
      submitted: true,
      codeFieldVisible,
      passwordFieldVisible: backToLogin,
      url: page.url(),
    };
  } catch {
    return answer("The verification code could not be typed into the page.");
  }
}
