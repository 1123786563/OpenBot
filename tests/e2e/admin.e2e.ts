import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// People：admin 是当前登录用户且是唯一用户，角色开关必须禁用（不能把自己降级）。
test("people keeps the signed-in admin switch disabled", {
  session: "admin",
}, async ({ app, screen }) => {
  await app.open("/admin/people");
  await expect(screen.getByRole("heading", "People")).toBeVisible();
  await expect(
    screen.getByRole("switch", /Administrator:/).first(),
  ).toBeDisabled();
});

// Audit：页面结构断言（六列表头），不依赖具体审计数据存在。
test("audit renders its table headers", { session: "admin" }, async ({
  app,
  screen,
}) => {
  await app.open("/admin/audit");
  await expect(screen.getByRole("heading", "Audit")).toBeVisible();
  await expect(screen.getByRole("columnheader")).toHaveText([
    "When",
    "What",
    "On",
    "Bot",
    "Started by",
    "Decision",
  ]);
});

// Credentials：创建一条测试凭据并撤销，验证行状态从 active 变 revoked、按钮禁用。
test("credentials can be added and revoked", { session: "admin" }, async ({
  app,
  screen,
  browser,
}) => {
  const stamp = Date.now();
  await app.open("/admin/credentials");
  await screen.getByRole("button", "Add credential").tap();

  const dialog = screen.getByRole("dialog");
  await dialog.getByLabel("Provider").fill(`e2e-provider-${stamp}`);
  await dialog.getByLabel("Key ID").fill(`e2e-key-${stamp}`);
  await dialog.getByLabel("Secret").fill("e2e-secret-value");
  await dialog.getByRole("button", "Save credential").tap();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // Item 行是普通 div（data-slot="item"），没有 listitem 角色；用稳定 data-slot + 文本定位。
  const row = browser.locator(
    `[data-slot="item"]:has-text("e2e-provider-${stamp}")`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("active");
  await row.getByRole("button", "Revoke").tap();
  await expect(row).toContainText("revoked", { timeout: 30_000 });
  await expect(row.getByRole("button", "Revoke")).toBeDisabled();
});

// Identity providers：本部署的 Google/Microsoft/Okta 走环境配置，页面只作说明。
test("identity providers explains environment-configured providers", {
  session: "admin",
}, async ({ app, screen }) => {
  await app.open("/admin/identity-providers");
  await expect(screen.getByRole("heading", "Identity providers")).toBeVisible();
  await expect(
    screen.getByText(
      "Google, Microsoft and Okta are configured in the environment instead and do not appear here.",
    ),
  ).toBeVisible();
});
