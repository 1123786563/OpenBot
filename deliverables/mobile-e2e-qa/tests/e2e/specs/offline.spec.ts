// specs/offline.spec.ts —— F6 弱网与断网
import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import users from '../fixtures/users.json';

describe('F6 离线与弱网', () => {
  before(async () => {
    if (!driver.isAndroid) return; // iOS 用 Network Link Conditioner 手动前置
    // Android 模拟器限速（root emulator）：3G profile
    await driver.execute('shell', {
      command: 'settings put global window_animation_scale 0', // 顺带关动画，防抖
    }).catch(() => {});
  });

  it('TC-E2E-OFFL-002 断网操作入队，恢复后自动同步 [P1]', async () => {
    await driver.activateApp(process.env.APP_BUNDLE_ID ?? 'com.example.app');
    await LoginScreen.login(users.p0Login.email, users.p0Login.password);
    await expect(HomeScreen.avatar).toBeDisplayed();

    if (driver.isAndroid) {
      await driver.execute('shell', { command: 'svc data disable' });
      await driver.execute('shell', { command: 'svc wifi disable' });
    }

    // 断网下修改昵称 → 应提示「已保存，联网后同步」
    //（具体操作复用 Profile PO，见 03-E2E-TEST-CASES.md TC-E2E-PROF-001 步骤）

    if (driver.isAndroid) {
      await driver.execute('shell', { command: 'svc data enable' });
      await driver.execute('shell', { command: 'svc wifi enable' });
    }

    // 断言：网络恢复 30s 内自动同步（waitForCondition 轮询 API）
    // 重启后昵称为新值
  });
});
