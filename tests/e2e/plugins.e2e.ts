import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

// 旧脚本里 “Connected 含 Hacker News / 17TRACK” 的断言已过期（mcp_servers=0）。现在用内置
// Routines 插件走完整的启用 → 授权 → 收回 → 禁用流程：无外部依赖，清理后可重复运行。
describe("routines plugin grants", {
  session: "admin",
  serial: true,
  timeout: 120_000,
}, () => {
  test("enables the plugin and grants a tool to the first bot", async ({
    app,
    screen,
    browser,
  }) => {
    await app.open("/admin/plugins/routines");

    const enable = screen.getByRole(
      "switch",
      /Enable Routines for this deployment/,
    );
    await expect(enable).toBeVisible({ timeout: 30_000 });
    if (!(await enable.isChecked())) {
      await enable.check();
    }
    await expect(enable).toBeChecked();

    // 工具列表来自内置 transport，应稳定列出动作；全部未授权时显示 No Bots。
    await expect(screen.getByRole("button", "Grant tools…")).toBeVisible({
      timeout: 30_000,
    });
    await expect(screen.getByText("No Bots").first()).toBeVisible();

    await screen.getByRole("button", "Grant tools…").tap();
    const dialog = screen.getByRole("dialog");
    // 弹窗先列多个 Bots 再列工具；Bots 取第一个，工具用读取区的 Select all 全选。
    await dialog.getByRole("checkbox").first().check();
    await dialog.getByRole("button", "Select all").first().tap();
    await dialog.getByRole("button", "Grant").tap();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const listRoutines = browser.locator(
      'a[href="/admin/plugins/routines/tools/list_routines"]',
    );
    await expect(listRoutines).toContainText(/1 of \d+ Bots reads/, {
      timeout: 30_000,
    });
  });

  test("revokes every tool from the bot page", async ({ screen, browser }) => {
    // By Bot 区的行链接带 /bots/ 路径；工具行是 /tools/，用 href 前缀区分。
    const botRow = browser
      .locator('a[href^="/admin/plugins/routines/bots/"]')
      .first();
    await botRow.tap();
    await expect(browser).toHaveURL(
      /\/admin\/plugins\/routines\/bots\/[^/]+$/,
      {
        timeout: 30_000,
      },
    );

    // 该页每个工具一个开关；逐个关掉，等待状态落库再处理下一个。
    const switches = screen.getByRole("switch");
    await expect(switches.first()).toBeVisible({ timeout: 30_000 });
    const total = await switches.count();
    for (let index = 0; index < total; index++) {
      const toolSwitch = switches.nth(index);
      if (await toolSwitch.isChecked()) {
        await toolSwitch.uncheck();
      }
      await expect(toolSwitch).toBeChecked({ checked: false });
    }
  });

  test("shows No Bots again and disables the plugin", async ({
    app,
    screen,
  }) => {
    await app.open("/admin/plugins/routines");
    await expect(screen.getByText("No Bots").first()).toBeVisible({
      timeout: 30_000,
    });

    const enable = screen.getByRole(
      "switch",
      /Enable Routines for this deployment/,
    );
    await enable.uncheck();
    await expect(enable).toBeChecked({ checked: false });
  });
});
