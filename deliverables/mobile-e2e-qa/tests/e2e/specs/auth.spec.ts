// specs/auth.spec.ts —— F1 登录模块（对应 03-E2E-TEST-CASES.md）
import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import users from '../fixtures/users.json';

const BUNDLE_ID = process.env.APP_BUNDLE_ID ?? 'com.example.app';

describe('F1 登录模块', () => {
  beforeEach(async () => {
    await driver.terminateApp(BUNDLE_ID);   // 保证冷启动态
    await driver.activateApp(BUNDLE_ID);
  });

  it('TC-E2E-AUTH-001 有效账号密码登录成功 [P0]', async () => {
    await LoginScreen.login(users.p0Login.email, users.p0Login.password);
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10_000 });  // 显式等待，非 sleep
    await HomeScreen.tabMine.click();
    await expect(HomeScreen.mineNickname).toHaveText('E2E测试用户01');
  });

  it('TC-E2E-AUTH-002 错误密码被拒且提示不泄露信息 [P0]', async () => {
    await LoginScreen.login(users.p0Login.email, 'WrongPass!000');
    await expect(LoginScreen.errorToast).toBeDisplayed({ timeout: 8_000 });
    await expect(LoginScreen.errorToast).toHaveText('账号或密码错误');  // 不得提示"密码错误"
  });

  it('TC-E2E-AUTH-003 验证码错误5次触发限流 [P0]', async () => {
    for (let i = 1; i <= 5; i++) {
      await LoginScreen.login(users.p0Login.email, `11111${i}`);
      await expect(LoginScreen.errorToast).toBeDisplayed();
    }
    // 第6次：服务端应直接拒绝
    await LoginScreen.login(users.p0Login.email, '000000');
    await expect(LoginScreen.rateLimitToast).toBeDisplayed({ timeout: 8_000 });
  });
});
