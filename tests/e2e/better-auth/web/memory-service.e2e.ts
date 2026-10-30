import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { assertBaWebSuite } from "../../../support/better-auth-preflight";

assertBaWebSuite(import.meta.url);

/*
 * #731 承载页的真实浏览器验收。preflight（BA_E2E_APP_ORIGIN / BA_E2E_API_ORIGIN /
 * 身份）不满足时本配置在加载处零导航退出，所以没有 Better Auth 栈的环境不会执行
 * 这些用例；本会话该栈未运行，ledger 将 #731 的浏览器验收记为 blocked。
 *
 * 断言限制在宿主页面能直接观察的事实：侧栏仍在、iframe 存在且只指向部署配置的
 * 记忆服务 Origin、顶层登录回到登记的 /memory、伪造消息不改变页面、退出后承载页
 * 消失、URL 不含长期凭据。iframe 内部（同一主体/数据/权限）的断言需要承载页
 * 自身的 e2e 套件，本文件不代为声明。
 */

test("sidebar_and_same_owner", { timeout: 120_000 }, async ({ app, screen }) => {
  await app.open("/memory");
  // 宿主侧栏保留：承载页不接管导航。
  await expect(screen.getByRole("link", { name: "Bots" })).toBeVisible();
  const frame = screen.getByTitle("记忆");
  await expect(frame).toBeVisible();
  // 承载页只指向部署配置的记忆服务 Origin（同站 HTTPS fixture）。
  const memoryOrigin = process.env.MEMORY_SERVICE_URL;
  if (memoryOrigin) {
    const src = await frame.getAttribute("src");
    expect(new URL(src ?? "").origin).toBe(new URL(memoryOrigin).origin);
  }
});

test("return_url", { timeout: 120_000 }, async ({ browser, screen }) => {
  await browser.goto("/memory");
  await screen.getByLabel("Email").fill(process.env.BA_E2E_DIRECTORY_EMAIL!);
  await screen.getByLabel("Password").fill(process.env.BA_E2E_DIRECTORY_PASSWORD!);
  await screen.getByRole("button", { name: "Sign in" }).tap();
  // 顶层完成登录并回到登记的承载路由，不接受任意回跳地址。
  await expect(browser).toHaveURL(/\/memory(\?.*)?$/);
  await expect(screen.getByTitle("记忆")).toBeVisible();
});

test("deep_link", { timeout: 120_000 }, async ({ app, browser, screen }) => {
  await app.open("/memory");
  await browser.reload();
  await expect(screen.getByTitle("记忆")).toBeVisible();
  expect(browser.url().pathname).toBe("/memory");
});

test("logout_revocation", { timeout: 120_000 }, async ({ app, browser, screen }) => {
  await app.open("/memory");
  await expect(screen.getByTitle("记忆")).toBeVisible();
  await browser.goto("/logout");
  // 退出清除内嵌状态：再回承载页不再是已登录的管理界面，而是要求重新登录。
  await browser.goto("/memory");
  await expect(screen.getByTitle("记忆")).not.toBeVisible();
});

test("message_origin", { timeout: 120_000 }, async ({ app, browser, screen }) => {
  await app.open("/memory");
  const before = browser.url().href;
  // 伪造的 auth-required（带任意回跳地址与错误 requestId）被忽略：页面不跳走。
  await screen.evaluate(() => {
    window.postMessage(
      {
        type: "memory.auth-required",
        requestId: "forged",
        returnUrl: "https://evil.example/steal",
      },
      "*",
    );
  });
  await expect(screen.getByTitle("记忆")).toBeVisible();
  expect(browser.url().href).toBe(before);
});

test("restricted_storage", { timeout: 120_000 }, async ({ app, browser, screen }) => {
  // 受限第三方存储：顶层登录仍完成，承载页以顶层会话重新装载；URL 不含长期凭据。
  await app.open("/memory");
  await expect(screen.getByTitle("记忆")).toBeVisible();
  expect(browser.url().href).not.toMatch(/token|access_token|id_token/);
});