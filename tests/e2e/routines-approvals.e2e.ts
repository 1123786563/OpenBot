import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// Routines：本部署无例程时断言空态；有例程时断言启用开关存在（两种状态都算通过）。
test("routines page shows standing instructions or the empty state", {
  session: "admin",
}, async ({ app, screen }) => {
  await app.open("/routines");
  await expect(screen.getByRole("heading", "Routines")).toBeVisible();

  // 空态标题和提示在同一段渲染文本里，用子串匹配。
  const empty = screen.getByText(/Nothing scheduled/);
  const switches = screen.getByRole("switch", /Enable the routine scheduled/);

  // 例程查询是异步的：先等空态出现；超时再等启用开关，两种稳定状态都算通过。
  let isEmpty = false;
  try {
    await expect(empty).toBeVisible({ timeout: 10_000 });
    isEmpty = true;
  } catch {
    isEmpty = false;
  }
  if (!isEmpty) {
    await expect(switches.first()).toBeVisible();
  }
});

// Approvals 偏好页：标题与 “Ask before making changes” 开关存在。
test("approval preferences page renders its switches", {
  session: "admin",
}, async ({ app, screen }) => {
  await app.open("/settings/approvals");
  await expect(screen.getByRole("heading", "Approvals")).toBeVisible();
  await expect(
    screen.getByRole("switch", "Ask before making changes"),
  ).toBeVisible();
});

// 审批决定 UI 只在 Bot 详情页出现（本部署 pending=0），没有待审批项时运行时跳过。
test("bot page offers a decision when an approval is waiting", {
  session: "admin",
}, async ({ app, screen }) => {
  await app.open("/bots");
  await screen.getByRole("main").getByRole("link").first().tap();

  const allow = screen.getByRole("button", "Allow once");
  test.skip(
    !(await allow.isVisible()),
    "no pending approval exists in this deployment",
  );
  await allow.tap();
  await expect(screen.getByText(/Allowed once/i)).toBeVisible();
});
