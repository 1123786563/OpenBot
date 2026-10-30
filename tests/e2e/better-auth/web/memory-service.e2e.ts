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
 * 记忆服务 Origin、登录走顶层记忆服务 /auth/login 并回到登记的 /memory、深链刷新
 * 保留页面、伪造消息不改变页面、退出后承载页消失。
 *
 * 票面的 restricted_storage（受限第三方存储下完成登录/退出）与 iframe 内部的
 * 同一主体/数据/权限，本文件没有可验证的夹具，因此不写用例、也不声明支持；
 * 这两项随 #731 记为 blocked。
 */

test("sidebar_and_same_owner", { timeout: 120_000 }, async ({ app, screen }) => {
  await app.open("/memory");
  // 宿主侧栏保留：承载页不接管导航。
  await expect(screen.getByRole("link", { name: "Bots" })).toBeVisible();
  const frame = screen.getByTitle("记忆");
  await expect(frame).toBeVisible();
  // 承载页只指向部署配置的记忆服务 Origin（同站 HTTPS fixture）；缺配置即配置错误。
  const memoryOrigin = process.env.MEMORY_SERVICE_URL;
  expect(memoryOrigin, "MEMORY_SERVICE_URL must be set for the embedded run").toBeTruthy();
  const src = await frame.getAttribute("src");
  expect(new URL(src ?? "").origin).toBe(new URL(memoryOrigin!).origin);
});

test("return_url", { timeout: 120_000 }, async ({ browser, screen }) => {
  // 已在 OpenBot 登录但从未登录记忆服务：承载页要求顶层登录。
  await browser.goto("/memory");
  // 顶层进入记忆服务登记的 /auth/login（不是消息里的任意地址），
  // 登录完成后由服务端配置的 returnUri 回到 /memory。
  await screen.getByTitle("记忆");
  await expect(browser).toHaveURL(/\/auth\/login/);
  await expect(browser).toHaveURL(/\/memory(\?.*)?$/, { timeout: 60_000 });
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
  // 记忆服务的退出清掉会话；再回承载页要求重新登录，且不恢复撤销的委托。
  await browser.goto(new URL("/auth/logout", process.env.MEMORY_SERVICE_URL!));
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
