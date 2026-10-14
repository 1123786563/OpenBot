import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// 旧 billing 页面已不存在：现在是 Enterprise controls + Plans & credits + Bills。
// 页面标题在 PageShell 上恒渲染，账单/额度数据为空或 Lago 不可用时不影响断言。
test("enterprise controls page renders", { session: "admin" }, async ({
  app,
  screen,
}) => {
  await app.open("/admin/enterprise");
  await expect(
    screen.getByRole("heading", "Enterprise controls"),
  ).toBeVisible();
});

test("usage page renders plans and credits", { session: "admin" }, async ({
  app,
  screen,
}) => {
  await app.open("/settings/usage");
  await expect(screen.getByRole("heading", "Plans & credits")).toBeVisible();
});

test("invoices page renders", { session: "admin" }, async ({ app, screen }) => {
  await app.open("/settings/invoices");
  await expect(screen.getByRole("heading", "Bills")).toBeVisible();
});
