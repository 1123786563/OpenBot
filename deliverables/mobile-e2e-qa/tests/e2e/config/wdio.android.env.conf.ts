// config/wdio.android.env.conf.ts —— 环境验证冒烟配置
// 连接已手动启动的 Appium（端口 4724），用系统 Settings 应用验证全链路，无需被测 app
import type { WebdriverIOConfig } from "@wdio/types";

export const config: WebdriverIOConfig = {
  runner: "local",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  specs: ["./specs/env.smoke.spec.ts"],
  hostname: "127.0.0.1",
  port: Number(process.env.APPIUM_PORT ?? 4724),
  waitforTimeout: 8_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 2,
  retry: 0,
  reporters: ["spec", ["allure", { outputDir: "./allure-results" }]],
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "emulator-5554",
      // 环境冒烟：不安装被测 app，直接用系统 Settings
      "appium:appPackage": "com.android.settings",
      "appium:appActivity": ".Settings",
      "appium:noReset": true,
      "appium:newCommandTimeout": 120,
      "appium:adbExecTimeout": 30_000,
      "appium:uiautomator2ServerInstallTimeout": 60_000,
    },
  ],
  afterTest: async (test, _ctx, { error }) => {
    if (error) {
      await browser
        .saveScreenshot(`./allure-results/FAIL-${Date.now()}-${test.title}.png`)
        .catch(() => {});
    }
  },
};
