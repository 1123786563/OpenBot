// specs/env.smoke.spec.ts —— 环境验证冒烟（ENV-SMOKE）
// 目的：验证 Appium → UiAutomator2 → Android 模拟器 → WebdriverIO 全链路可用
// 用系统 Settings 应用，不依赖被测 app 安装包
import { expect } from '@wdio/globals';

describe('ENV-SMOKE 环境验证冒烟（Android 模拟器）', () => {
  it('ENV-SMOKE-001 Appium 会话建立且平台能力正确', async () => {
    const caps = driver.capabilities as Record<string, any>;
    expect(caps.platformName).toBe('Android');
    expect(String(caps.automationName ?? '').toLowerCase()).toBe('uiautomator2');
    console.log(`    [info] device: ${caps.deviceName} / udid: ${caps.udid ?? 'n/a'} / API: ${caps.platformVersion ?? caps.apiLevel ?? 'n/a'}`);
  });

  it('ENV-SMOKE-002 启动系统设置应用并可定位元素', async () => {
    await driver.startActivity('com.android.settings', '.Settings');
    // 等待应用真正到前台
    await browser.waitUntil(async () =>
      (await driver.getCurrentPackage()) === 'com.android.settings', { timeout: 15_000 });

    // uiautomator 定位：包名范围内任意 TextView（设置首页必有文字项）
    const firstText = $('android=new UiSelector().packageName("com.android.settings").className("android.widget.TextView").instance(0)');
    await firstText.waitForDisplayed({ timeout: 15_000 });
    const label = await firstText.getText();
    console.log(`    [info] Settings 首个可见项: "${label}"`);
    expect(label.trim().length).toBeGreaterThan(0);
  });

  it('ENV-SMOKE-003 设备信息与截图能力正常', async () => {
    const { width, height } = await driver.getWindowSize();
    console.log(`    [info] screen: ${width}x${height}`);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    await browser.saveScreenshot('./allure-results/ENV-SMOKE-settings.png');
    const time = await driver.getDeviceTime();
    console.log(`    [info] device time: ${time}`);
    expect(String(time).length).toBeGreaterThan(0);
  });
});
