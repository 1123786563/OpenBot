// config/wdio.ios.sim.conf.ts —— iOS 模拟器
import { config, APP_PATH } from './shared.conf';

export const configIos = {
  ...config,
  capabilities: [{
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:deviceName': 'iPhone 15',
    'appium:platformVersion': '17.5',
    'appium:app': APP_PATH.iosSim,
    'appium:noReset': false,
    'appium:newCommandTimeout': 240,
    'appium:wdaLaunchTimeout': 120_000,          // WDA 启动慢，放宽
    'appium:usePrebuiltWDA': true,               // 复用预编译 WDA，提速明显
    'appium:showXcodeLog': false,
  }],
};
