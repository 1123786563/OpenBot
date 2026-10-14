import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

// 对应旧 browser.e2e.ts 的 Bot 全生命周期流程。创建向导是三步状态机，后续步骤都依赖
// 第一步创建出来的 agentId，所以整组用 serial 共享浏览器状态与模块级变量。
describe("bot lifecycle", {
  session: "admin",
  serial: true,
  timeout: 120_000,
}, () => {
  let agentId = "";
  let botName = "";

  test("creates a managed coworker", async ({ app, screen, browser }) => {
    botName = `E2E Lifecycle ${Date.now()}`;
    await app.open("/bots");
    await screen.getByRole("button", "New Bot").tap();
    await expect(screen.getByText("Step 1 of 3")).toBeVisible();

    await screen.getByLabel("Name").fill(botName);
    await screen.getByLabel("Title").fill("E2E Lifecycle Tester");
    await screen
      .getByLabel("Role")
      .fill("Created and deleted by the e2e suite.");
    await screen.getByRole("button", "Continue").tap();

    // 第二步可见性默认 Private，直接继续到运行方式。
    await expect(screen.getByText("Step 2 of 3")).toBeVisible();
    await screen.getByRole("button", "Continue").tap();
    await expect(screen.getByText("Step 3 of 3")).toBeVisible();

    // 本部署未配置 MANAGED_AGENT_AG_UI_URL，Built-in 不可选；Managed + 公网占位 endpoint。
    await screen.getByRole("radio", { name: /Managed/ }).check();
    await screen
      .getByLabel("Agent endpoint")
      .fill("https://agui.example.com/e2e-agent");
    await screen.getByRole("button", "Create coworker").tap();

    await expect(browser).toHaveURL(/localhost:3010\/bots\/[^/]+$/, {
      timeout: 30_000,
    });
    await expect(screen.getByRole("heading", botName)).toBeVisible();
    agentId = /\/bots\/([^/?#]+)/.exec(await browser.url())?.[1] ?? "";
    expect(agentId).not.toBe("");
  });

  test("pins the coworker", async ({ app, screen }) => {
    await app.open(`/bots/${agentId}`);
    const pinned = screen.getByRole("switch", "Pinned");
    await pinned.check();
    await expect(pinned).toBeChecked();
  });

  test("pauses and restores the coworker", async ({ app, screen }) => {
    await app.open(`/bots/${agentId}`);
    const active = screen.getByRole("switch", "Active");
    await expect(active).toBeChecked();

    await active.uncheck();
    await expect(active).toBeChecked({ checked: false });
    await expect(screen.getByText(/Paused\. No routine/)).toBeVisible();

    await active.check();
    await expect(active).toBeChecked();
    await expect(screen.getByText(/Runs its routines/)).toBeVisible();
  });

  test("hides the coworker and brings it back from the roster", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open(`/bots/${agentId}`);
    // 勾选成功后 onHidden 立刻跳转回 /bots，会替换掉控件本身；用 tap 触发、URL 断言结果。
    await screen.getByRole("switch", "Hidden").tap();

    // onHidden 会回到 /bots；隐藏区默认折叠，展开后才能再进详情页。
    await expect(browser).toHaveURL(/localhost:3010\/bots$/, {
      timeout: 30_000,
    });
    await screen.getByRole("button", "Show").tap();
    await screen.getByRole("link").filter({ hasText: botName }).tap();
    await expect(screen.getByRole("heading", botName)).toBeVisible();
  });

  test("deletes the coworker", async ({ app, screen, browser }) => {
    await app.open(`/bots/${agentId}`);
    await screen.getByRole("button", /^Delete For everyone/).tap();

    const dialog = screen.getByRole("dialog");
    await expect(dialog.getByText(`Delete ${botName}?`)).toBeVisible();
    await dialog.getByRole("button", "Delete").tap();

    await expect(browser).toHaveURL(/localhost:3010\/bots$/, {
      timeout: 30_000,
    });
    await expect(
      screen.getByRole("link").filter({ hasText: botName }),
    ).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});
