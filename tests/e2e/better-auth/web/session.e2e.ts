import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { assertBaWebSuite } from "../../../support/better-auth-preflight";

assertBaWebSuite(import.meta.url);

test("request_reset_receive_mail_set_password_then_sign_in", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
  const email =
    process.env.BA_E2E_RECOVERY_EMAIL ?? "t0514-recovery@openbot.test";
  const newPassword =
    process.env.BA_E2E_RECOVERY_NEW_PASSWORD ?? "t0514-recovered-password";
  await app.open("/forgot-password");
  await screen.getByLabel("Email").fill(email);
  await screen.getByRole("button", "Send reset link").tap();
  await expect(
    screen.getByText("If an account exists, an email is on its way."),
  ).toBeVisible();

  const mailpit = process.env.BA_E2E_MAILPIT_ORIGIN ?? "http://127.0.0.1:8025";
  let message: { ID: string } | undefined;
  for (let attempt = 0; attempt < 20 && !message; attempt += 1) {
    const response = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(email)}&limit=10`,
    );
    const body = (await response.json()) as {
      messages?: { ID: string; To?: unknown[] }[];
    };
    message = body.messages?.find((item) =>
      JSON.stringify(item.To).includes(email),
    );
    if (!message) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!message) throw new Error("Mailpit did not receive the recovery email.");
  const detail = (await (
    await fetch(`${mailpit}/api/v1/message/${message.ID}`)
  ).json()) as { Text?: string; HTML?: string };
  const mailBody = `${detail.Text ?? ""}\n${detail.HTML ?? ""}`;
  const resetUrl =
    /https?:\/\/[^\s"<>]+\/api\/auth\/reset-password\/[^\s"<>]+/.exec(
      mailBody,
    )?.[0];
  if (!resetUrl)
    throw new Error("The recovery email did not include its reset link.");
  const resetResponse = await fetch(resetUrl, { redirect: "manual" });
  const location = resetResponse.headers.get("location");
  if (!location)
    throw new Error("The reset callback did not return its local destination.");
  const destination = new URL(location, process.env.BA_E2E_API_ORIGIN);
  if (
    destination.origin !== new URL(process.env.BA_E2E_APP_ORIGIN!).origin ||
    destination.pathname !== "/reset-password"
  ) {
    throw new Error(
      "The reset callback did not return to the local reset page.",
    );
  }
  await browser.goto(destination.href);
  await screen.getByLabel("New password").fill(newPassword);
  await screen.getByRole("button", "Reset password").tap();
  await expect(
    screen.getByText(
      "Your password has been reset. Sign in with your new password.",
    ),
  ).toBeVisible();

  const login = await fetch(
    `${process.env.BA_E2E_API_ORIGIN}/api/auth/sign-in/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.BA_E2E_APP_ORIGIN!,
      },
      body: JSON.stringify({
        email,
        password: newPassword,
        callbackURL: process.env.BA_E2E_APP_ORIGIN,
      }),
    },
  );
  const newLogin = { ok: login.ok };
  expect(newLogin.ok).toBe(true);
});

test("consumed_or_external_return_token_is_refused", {
  timeout: 60_000,
}, async ({ app, browser, screen }) => {
  await app.open(
    "/reset-password?token=invalid&returnPath=https%3A%2F%2Fevil.example&next=%2F%2Fevil.example&callbackUrl=https%3A%2F%2Fevil.example",
  );
  const before = new URL(await browser.url()).origin;
  await screen.getByLabel("New password").fill("some-new-password-value");
  await screen.getByRole("button", "Reset password").tap();
  await expect(
    screen.getByText(
      "This link has expired or was already used. Request a new one.",
    ),
  ).toBeVisible();
  const after = new URL(await browser.url()).origin;
  const unsafeNavigationCount = before === after ? 0 : 1;
  expect(unsafeNavigationCount).toBe(0);
  const probe = await fetch(
    `${process.env.BA_E2E_API_ORIGIN}/api/auth/reset-password/invalid?callbackURL=${encodeURIComponent("https://evil.example")}`,
    { redirect: "manual" },
  );
  expect(probe.ok).toBe(false);
  expect(probe.headers.get("location")).toBe(null);
});
