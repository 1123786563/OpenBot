// config/wdio.android.sim.conf.ts —— Android 模拟器
import { config, APP_PATH } from './shared.conf';

export const configAndroid = {
  ...config,
  capabilities: [{
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Pixel_7_API_34',
    'appium:app': APP_PATH.android,
    'appium:autoGrantPermissions': true,          // 权限专项用例运行时改为 false
    'appium:noReset': false,                      // 每次全新安装态
    'appium:newCommandTimeout': 240,
    'appium:uiautomator2ServerInstallTimeout': 60_000,
  }],
};
