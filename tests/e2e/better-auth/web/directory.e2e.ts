import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { assertBaWebSuite } from "../../../support/better-auth-preflight";

// 套件守卫（T04.12）：本文件只在 e2e.better-auth.config.ts（bun run test:ui:better-auth）下
// 运行；换任何配置或目标都在导入时失败，零网络。登记面见 tests/config/e2e-engine-suites.json。
assertBaWebSuite(import.meta.url);

// 本栈的 /sign 在只有唯一供应商时自动把未登录者交给该供应商（sign.tsx 的 autoEntered 契约），
// 所以未登录的落点是 IdP 的登录表单，而不是应用自己的按钮页——断言按真实契约写。

test("unauthenticated visitors are handed to the configured provider", {
  timeout: 90_000,
}, async ({ app, screen, browser }) => {
  await app.open("/");

  // 应用 → BA → 配置的供应商（Casdoor）authorize，登录表单停留等待输入。
  await expect(browser).toHaveURL(/\/login\/oauth\/authorize/, {
    timeout: 30_000,
  });
  await expect(screen.getByLabel("Username")).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByLabel("Password")).toBeVisible();
  await expect(screen.getByRole("button", "Sign In")).toBeVisible();
});

test("the directory identity signs in through the configured provider", {
  timeout: 120_000,
}, async ({ app, screen, browser }) => {
  const email = process.env.BA_E2E_DIRECTORY_EMAIL ?? "";
  const password = process.env.BA_E2E_DIRECTORY_PASSWORD ?? "";

  await app.open("/");
  await expect(screen.getByLabel("Username")).toBeVisible({
    timeout: 30_000,
  });

  // 供应商登录表单；与 preflight 同一身份（值不落日志）。
  await screen.getByLabel("Username").fill(email);
  await screen.getByLabel("Password").fill(password);
  await screen.getByRole("button", "Sign In").tap();

  // 回调之后回到 BA 应用：URL 回到 APP origin，且首次登录身份落在鉴权后的 onboarding 面
  // （未登录访问只会被送回 /sign，所以这里出现即证明会话已建立）。origin 按字面转义，只作前缀锚。
  const appOriginPattern = new RegExp(
    `^${(process.env.BA_E2E_APP_ORIGIN ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
  );
  await expect(browser).toHaveURL(appOriginPattern, { timeout: 60_000 });
  await expect(
    screen.getByRole("heading", { name: "Welcome to OpenBot" }),
  ).toBeVisible({ timeout: 30_000 });
});
