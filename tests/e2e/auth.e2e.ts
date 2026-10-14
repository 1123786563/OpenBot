import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// 实测：点 Log out 后应用清掉自己的会话并回到 /sign，随后被送到 Casdoor 的 authorize
// 页面；Casdoor 的登录表单会停留（不会静默重登），所以最终断言落在 8000 端口的登录表单上。
test("signing out lands on the Casdoor sign-in form", {
  session: "admin-auth",
}, async ({ app, screen, browser }) => {
  await app.open("/");

  // 侧栏底部的用户菜单按钮里带着 admin 字样；点开是 Admin / Settings / Log out。
  const menu = screen.getByRole("button").filter({ hasText: /admin/i }).last();
  await menu.tap();
  await screen.getByRole("menuitem", "Log out").tap();

  await expect(browser).toHaveURL(/localhost:8000\/login\/oauth\/authorize/, {
    timeout: 30_000,
  });
  await expect(screen.getByLabel("Username")).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByLabel("Password")).toBeVisible();
});

// 会话丢失（等价于本地会话过期）：清空浏览器状态后重开应用，必须被送回 Casdoor 登录。
test("a cleared session redirects back to Casdoor", {
  session: "admin-auth",
  timeout: 60_000,
}, async ({ app, screen, browser }) => {
  await app.clearState();

  await expect(browser).toHaveURL(/localhost:8000\/login\/oauth\/authorize/, {
    timeout: 30_000,
  });
  await expect(screen.getByLabel("Username")).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByLabel("Password")).toBeVisible();
  await expect(screen.getByRole("button", "Sign In")).toBeVisible();
});
