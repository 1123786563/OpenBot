// config/shared.conf.ts —— 公共配置：超时 / 报告 / hooks / retry
import type { WebdriverIOConfig } from '@wdio/types';

export const BUNDLE_ID = process.env.APP_BUNDLE_ID ?? 'com.example.app';
export const APP_PATH = {
  iosSim: process.env.IOS_APP_PATH ?? './apps/Debug.app',
  android: process.env.ANDROID_APK_PATH ?? './apps/debug.apk',
};

export const config: WebdriverIOConfig = {
  runner: 'local',
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },   // 移动端单条用例整体放宽
  specs: ['./tests/e2e/specs/**/*.spec.ts'],
  waitforTimeout: 10_000,                        // 元素显式等待默认 10s
  connectionRetryTimeout: 120_000,               // Appium 会话建立
  connectionRetryCount: 3,                       // 会话级重连
  retry: process.env.CI ? 1 : 0,                 // 失败重试仅 CI 开启（两连败才判真失败）
  reporters: [
    'spec',
    ['allure', {
      outputDir: './allure-results',
      disableWebdriverStepsReport: true,
      disableWebdriverScreenshotsReport: false,  // 截图自动收录
    }],
  ],
  afterTest: async (test, _ctx, { error }) => {
    if (error) {
      await browser.saveScreenshot(`./allure-results/FAIL-${Date.now()}-${test.title}.png`);
    }
  },
  afterSuite: async () => {
    // 套件级清理：调用 QA 环境重置接口，保证数据独立性
    await fetch(`${process.env.QA_API ?? 'https://qa-api.example.com'}/test-hooks/reset?scope=e2e`, {
      method: 'POST', headers: { 'X-Test-Key': process.env.QA_HOOK_KEY ?? '' },
    }).catch(() => { /* 清理失败不阻塞报告 */ });
  },
};
